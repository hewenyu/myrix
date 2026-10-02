/**
 * 真实 RuntimeRouter：会话路由 + 持久队列投递循环 + 撤权 outbox 重试。
 *
 * 与 `docs/plan/tech-design-v1.md` §4.5/§4.7 的对应关系：
 *
 *   `createSession`   绑定 + create 命令**同一事务**（`SessionsRepository.create`），
 *                     返回 `status: creating`；真正的激活发生在 create 命令拿到
 *                     driver 回执之后（`creating → active`），不在这里假装成功。
 *   `send` / `cancel` 命令持久入队（`commands`），HTTP 返回 202 只表示"平台已持久接收"；
 *                     实际投递由后台 claim/lease/FIFO 循环完成。
 *   `revoke`          数据库优先：绑定置 revoked + rev 递增 + 同事务写 outbox；
 *                     通知 cell 失败不影响撤权结论，由 outbox 退避重试直到投递成功或 dead。
 *   `events`          先授权再解析，然后按 driver 的实际 SSE 帧做**白名单投影**，
 *                     流上持续复核当前 binding/member/work，并响应 AbortSignal。
 *
 * 安全属性（每条都在测试里被显式断言）：
 *
 *   1. **不采纳前端角色**：所有判定都用数据库里的当前 member 行 + 当前 binding rev，
 *      经 `authorizePlatform` 得出结论；`PlatformIdentity.role` 只用于展示，从不参与准入。
 *   2. **当前态复核**：租户 active、成员 active、作品 active 且属主一致、绑定未撤权、
 *      rev 与调用方持有的一致；任何一项不成立即拒绝（fail-closed）。
 *   3. **正文绑定**：投递时把**即将发送的字节**交给签发方算 `bh`，再原样发送同一个 Buffer；
 *      绝不"签一次、序列化一次"。
 *   4. **不模拟成功**：连接失败/超时/非 2xx/正文不合契约都进入持久队列的退避重试或明确失败，
 *      不存在"网络不通也回 accepted"的路径。
 *   5. **有界解析**：driver 响应体、SSE 单帧、投影出的文本长度都有硬上限。
 *
 * 写入边界：本文件只读 `@myrix/*` 与 `apps/bff/src/ports.ts` 的公开契约，
 * 不修改 platform-store / grant / DSH。
 */
import type { NovelPreset, NovelSession, PlatformIdentity, QueuedCommand, SessionStreamEvent } from "@myrix/contracts";
import type { GrantSigner } from "@myrix/grant";
import {
  claimSessionCommand,
  OutboxRepository,
  PlatformStore,
  PlatformStoreError,
  SessionsRepository,
  type CommandRecord,
  type ServiceCapability,
  type SessionBindingRecord,
} from "@myrix/platform-store";
import { CommandsRepository } from "../../../packages/platform-store/src/repositories/commands";
import { insertAuditEvent } from "../../../packages/platform-store/src/repositories/audit";
import { sql } from "kysely";
import { authorizePlatform, type PlatformAuthorization } from "@myrix/governance";
import { ApiFailure, type RuntimeRouter } from "./ports";
import { silentRuntimeLogger, type RuntimeLogger } from "./runtime-log";
import { cellServesTenant, type CellDirectory, type CellEndpoint } from "./runtime-cells";
import type { DriverFailure, DriverHttpClient, DriverSseFrame } from "./runtime-driver-client";
import { projectDriverFrame, type ProjectionOptions } from "./runtime-stream";
import {
  isRecoverableDriverCode,
  RuntimeSessionRecovery,
  type ResumeRequestOutcome,
} from "./runtime-recovery";

/** 订阅凭证的 `cmd` 派生：与 driver 侧 `subscribeCommandId` 逐字一致。 */
export function subscribeCommandId(sessionId: string): string {
  return `subscribe-${sessionId}`;
}

/**
 * 查回执凭证的 `cmd` 派生：与 driver 侧逐字一致。
 *
 * 查回执是**读**操作，没有业务正文，因此不能复用投递那枚凭证（它的 `jti` 已被
 * POST 消费、`bh` 绑定的是投递正文）。这里为每次查询签发一枚**全新的短凭证**：
 * `op='subscribe'`（读语义、不新增 grantOp）、`cmd=receipt-<commandId>`、
 * `bh=sha256(空正文)`；其余 principal/boot 字段与当次投递完全一致。
 */
export function receiptCommandId(commandId: string): string {
  return `receipt-${commandId}`;
}


/** 命令 op → governance 动作（与 platform-store 的 OP_ACTION 同源，显式重述以便本地判定）。 */
const ACTION_FOR_OP = {
  create: "sessions:create",
  resume: "sessions:resume",
  send: "sessions:send",
  cancel: "sessions:cancel",
  subscribe: "sessions:subscribe",
} as const;

/**
 * 运行时装配必须显式授予的系统能力。缺任何一个，构造期直接抛错 ——
 * 不让"看起来能跑但永远投不出去"的路由进入部署。
 */
export const RUNTIME_SERVICE_CAPABILITIES: readonly ServiceCapability[] = Object.freeze([
  "command.enqueue",
  "command.claim",
  "command.settle",
  "command.read",
  "session.activate",
  "outbox.enqueue",
  "outbox.claim",
  "outbox.settle",
]);

/** 交付上下文：投递一条命令所需的全部当前事实。 */
export interface DeliveryFacts {
  binding: {
    tenantId: string;
    id: string;
    ownerUserId: string;
    workId: string;
    preset: string;
    status: string;
    revokedRevision: number;
    cellId: string | null;
  };
  member: { status: string; role: string } | undefined;
  work: { ownerUserId: string; status: string } | undefined;
  tenantStatus: string | undefined;
}

export interface RuntimeValidators {
  /** 读当前事实（真实实现走 Postgres + RLS；测试可注入假实现）。 */
  currentFacts?(input: { tenantId: string; sessionId: string }): Promise<DeliveryFacts | undefined>;
}

export interface RuntimeRouterDependencies {
  store: PlatformStore;
  signer: GrantSigner;
  directory: CellDirectory;
  driver: DriverHttpClient;
  /** 注入时钟（毫秒精度；用于日志与测试推进）。 */
  clock?: () => Date;
  logger?: RuntimeLogger;
  /** 投递者标识；写进 commands.locked_by / outbox_messages.locked_by，便于排查。 */
  workerId?: string;
  /** claim 租约（毫秒）。 */
  leaseMs?: number;
  /** 单轮 claimAny 的批量上限。 */
  claimBatch?: number;
  /** SSE 流上复核当前授权状态的间隔（毫秒）。 */
  revalidateMs?: number;
  /** 需要轮询的租户；缺省时用 `directory.tenants()`。 */
  tenantIds?: readonly string[] | (() => Promise<readonly string[]>);
  /** 绑定创建时的策略版本字符串（审计用）；缺省 `inline`。 */
  policyRevision?: (actor: { tenantId: string; userId: string }, workId: string) => Promise<string>;
  validators?: RuntimeValidators;
  /** 生成 commandId（create 的 create 命令）；缺省 crypto.randomUUID。 */
  newCommandId?: () => string;
  /** 投影上限与白名单开关。 */
  projection?: ProjectionOptions;
  /** 关闭 outbox 投递循环（默认开启）。 */
  outboxEnabled?: boolean;
  /**
   * 会话恢复策略。
   *
   * `recovery` 缺省开启：投递前用 `commands.receipt.bootId` 与当前 `/v1/ready.bootId`
   * 证明"当前 boot 里这个会话已打开"；未证明时不直接投递/订阅，而是先把一条
   * `resume` 命令按确定性 uuid 持久入队（走同一套 governance + 审计），
   * 由正常投递循环发送。详见 `runtime-recovery.ts` 与 ADR-0028。
   */
  recovery?: { enabled?: boolean; maxAttemptsPerBoot?: number };
}

/** 投递循环的运行控制面（测试与装配使用）。 */
export interface RuntimeDispatcher {
  /** 单轮：认领并投递一批命令。返回本轮统计。 */
  dispatchOnce(): Promise<{ claimed: number; settled: number; released: number; failed: number }>;
  /** 单轮：投递待发 outbox（撤权通知）。 */
  dispatchOutboxOnce(): Promise<{ claimed: number; delivered: number; retried: number }>;
  /** 启动后台循环（幂等）。 */
  start(): void;
  /** 停止后台循环并等待在途一轮结束。 */
  stop(): Promise<void>;
  /** 立刻唤醒（入队后调用，避免等下一个轮询周期）。 */
  wake(): void;
  readonly running: boolean;
}

export interface RuntimeRuntime extends RuntimeRouter {
  readonly dispatcher: RuntimeDispatcher;
  /** 当前 workerId（测试断言用）。 */
  readonly workerId: string;
}

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_CLAIM_BATCH = 10;
const DEFAULT_REVALIDATE_MS = 5_000;
const DEFAULT_POLL_MS = 1_000;
const MAX_RECEIPT_BYTES = 4_096;

function toApi(error: unknown): never {
  if (error instanceof ApiFailure) throw error;
  if (error instanceof PlatformStoreError) throw new ApiFailure(error.httpStatus, error.code, error.reason);
  throw error;
}

function toNovelSession(binding: SessionBindingRecord): NovelSession {
  return {
    id: binding.id,
    workId: binding.workId,
    preset: binding.preset as NovelPreset,
    status: binding.status === "closed" ? "revoked" : binding.status,
    createdAt: binding.createdAt,
  };
}

function boundedReceipt(value: Record<string, unknown>): Record<string, unknown> {
  const encoded = JSON.stringify(value);
  if (encoded.length > MAX_RECEIPT_BYTES) {
    return { status: typeof value["status"] === "string" ? value["status"] : "unknown", note: "回执过大已截断" };
  }
  return value;
}

/**
 * 投递用的 wire 正文。
 *
 * 这是**唯一**构造 driver 请求体的地方：同一 `CommandRecord` 每次都重建出字节完全相同的
 * 正文，因此重试时 `bh` 稳定、driver 侧的 `commandId` 幂等判定也稳定。
 * 字段顺序固定（不依赖调用方传参顺序）。
 */
export function wireBodyOf(command: {
  op: string;
  bindingId: string;
  id: string;
  body: Record<string, unknown>;
}): Record<string, unknown> {
  const head: Record<string, unknown> = { op: command.op, sid: command.bindingId, commandId: command.id };
  switch (command.op) {
    case "send": {
      const text = command.body["text"];
      if (typeof text === "string") head["text"] = text;
      return head;
    }
    case "cancel":
    case "resume":
      return head;
    case "create": {
      const preset = command.body["preset"];
      const workId = command.body["workId"];
      if (typeof preset === "string") head["preset"] = preset;
      if (typeof workId === "string") head["workId"] = workId;
      return head;
    }
    default:
      return head;
  }
}

/** 入队时的正文：与投递正文同形，保证 `commands.body_hash` 就是实际发送字节的摘要。 */
export function enqueueBodyOf(input: { op: string; sessionId: string; commandId: string; text?: string }): Record<string, unknown> {
  const head: Record<string, unknown> = { op: input.op, sid: input.sessionId, commandId: input.commandId };
  if (input.text !== undefined) head["text"] = input.text;
  return head;
}

/**
 * 哪些命令允许触发**会话恢复**（预检 + 反应式两条路径的唯一判据）。
 *
 * 只有承载类命令 `send` / `cancel`：它们的前提是"该会话**本该已经打开**"，
 * driver 报 `session_not_open` / `identity_invalid` 才是与前提矛盾的、值得恢复的窗口。
 *
 * `create` / `resume` **自己就是"打开会话"的动作**，绝不参与恢复：
 *   * 预检：它们不需要 `open-proof`，也不该因为 boot 不匹配而入队一条新的 resume；
 *   * 反应式：driver 对它们的拒绝若被当成"没打开"，会让 `deliver` 把**这一条**
 *     create/resume 反复让路重投（`deferForRecovery` 把 `attempts` 退回到 0）。
 *
 * 这里要说清**真实生产**里 create/resume 的失败形状，不能写成"命令无限增长"：
 *   * 恢复请求本身要先读 binding，而 create 尚未完成时 binding 仍是 `creating`
 *     （见 `createSession`），`requestResume` 以 `binding-not-active` 判 `denied`，
 *     **不会**入队任何 resume；`denied` 只让**同一条** create 走 60s 长退避，
 *     每轮退还一次认领预算 —— 命令数恒为 1，但 create 被**无限期延后**
 *     （"production create forever creating"），且该退避不消耗 `attempts`。
 *   * 对一条已经在投递中的 resume（binding 已 active）：driver 报可恢复码时，
 *     `requestResume` 会先 `listResumes` 看到**它自己**仍处于 `queued|inflight`，
 *     因而返回 `pending`，同样只让**同一条** resume 让路；这是同一条命令的自循环，
 *     不是新命令的增长。
 *
 * 所以本判据消掉的是"用恢复去重试 create/resume 自己"这条**无限延后/预算退还**的
 * 自我循环；它既不新增 resume，也不放宽任何身份/授权结论。禁止在这里或调用处
 * 写"入队无界的新 resume"之类与生产不符的断言。
 *
 * create/resume 的 driver 拒绝必须走**有界失败分类**（`failureToOutcome`）：
 * 可重试（5xx/429/网络）→ 退避且真实消耗 `attempts`，不可重试（4xx 明确拒绝）→
 * `failed`，由 `attempts`/`max_attempts` 兜底。
 *
 * 这是**收窄**判定：`create`/`resume` 的任何身份/授权结论都不因此放宽，
 * 只是不再把它们当成"可恢复的承载投递"。
 */
export function isRecoveryCarryingOp(op: string): boolean {
  return op === "send" || op === "cancel";
}

export function createRuntimeRouter(deps: RuntimeRouterDependencies): RuntimeRuntime {
  const store = deps.store;
  const logger = deps.logger ?? silentRuntimeLogger;
  const clock = deps.clock ?? (() => new Date());
  const workerId = deps.workerId ?? `bff-runtime-${Math.random().toString(36).slice(2, 10)}`;
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const claimBatch = deps.claimBatch ?? DEFAULT_CLAIM_BATCH;
  const revalidateMs = deps.revalidateMs ?? DEFAULT_REVALIDATE_MS;
  const outboxEnabled = deps.outboxEnabled !== false;
  const recoveryEnabled = deps.recovery?.enabled !== false;
  const sessions = new SessionsRepository(store);
  const commands = new CommandsRepository(store);
  const outbox = new OutboxRepository(store);
  const recovery = new RuntimeSessionRecovery({
    store,
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    ...(deps.recovery?.maxAttemptsPerBoot === undefined
      ? {}
      : { maxAttemptsPerBoot: deps.recovery.maxAttemptsPerBoot }),
  });

  // 装配期检查：能力缺失是部署错误，必须在启动时暴露，而不是第一条命令投递时才失败。
  const missing = RUNTIME_SERVICE_CAPABILITIES.filter((capability) => !store.hasService(capability));
  if (missing.length > 0) {
    throw new Error(
      `myrix-bff runtime: PlatformStore 未授予运行时所需系统能力（${missing.join(", ")}）；` +
        "投递循环不能在没有 command.*/outbox.* 能力时运行",
    );
  }
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error("myrix-bff runtime: leaseMs 必须是正整数");
  if (!Number.isSafeInteger(claimBatch) || claimBatch <= 0 || claimBatch > 100) {
    throw new Error("myrix-bff runtime: claimBatch 必须在 1..100");
  }

  const tenantSource = async (): Promise<readonly string[]> => {
    const source = deps.tenantIds;
    if (source === undefined) return (await deps.directory.tenants?.()) ?? [];
    return typeof source === "function" ? await source() : source;
  };

  // ---- 当前事实（真实实现：一条租户事务读完 binding/member/work/tenant） ----

  async function readFacts(tenantId: string, sessionId: string): Promise<DeliveryFacts | undefined> {
    if (deps.validators?.currentFacts) return deps.validators.currentFacts({ tenantId, sessionId });
    return store.withTenant({ tenantId }, async (tx) => {
      const row = await tx.trx
        .selectFrom("session_bindings")
        .select(["id", "tenant_id", "owner_user_id", "work_id", "preset", "status", "revoked_revision", "cell_id"])
        .where("id", "=", sessionId)
        .executeTakeFirst();
      if (!row) return undefined;
      const member = await tx.trx
        .selectFrom("members")
        .select(["status", "role"])
        .where("user_id", "=", row.owner_user_id)
        .executeTakeFirst();
      const work = await tx.trx
        .selectFrom("works")
        .select(["owner_user_id", "status"])
        .where("id", "=", row.work_id)
        .executeTakeFirst();
      const tenant = await tx.trx.selectFrom("tenants").select(["status"]).where("id", "=", tenantId).executeTakeFirst();
      return {
        binding: {
          tenantId: row.tenant_id,
          id: row.id,
          ownerUserId: row.owner_user_id,
          workId: row.work_id,
          preset: row.preset,
          status: row.status,
          revokedRevision: row.revoked_revision,
          cellId: row.cell_id,
        },
        member: member ? { status: member.status, role: member.role } : undefined,
        work: work ? { ownerUserId: work.owner_user_id, status: work.status } : undefined,
        tenantStatus: tenant?.status,
      };
    });
  }

  /**
   * 对一条命令投递前的准入判定：当前成员 + 当前租户 + 作品属主 + 绑定 rev，
   * 全部交给 `authorizePlatform`（不采纳任何调用方声明的角色）。
   */
  function authorizeDelivery(
    facts: DeliveryFacts,
    command: { actorUserId: string; op: keyof typeof ACTION_FOR_OP },
  ): PlatformAuthorization {
    const binding = facts.binding;
    const action = ACTION_FOR_OP[command.op];
    const base = {
      actor: { tenantId: binding.tenantId, userId: command.actorUserId },
      action,
      resource: {
        tenantId: binding.tenantId,
        ownerUserId: binding.ownerUserId,
        status: binding.status,
        revision: binding.revokedRevision,
      },
      expectedRevision: binding.revokedRevision,
    };
    const decision: PlatformAuthorization = command.op === "create"
      // `create` 的判定对象是**目标作品**（governance 不接受 binding 上的 status）；
      // 这里显式重述，避免"看起来像会话动作"地传错字段。
      ? authorizePlatform({
          actor: base.actor,
          member: facts.member
            ? { tenantId: binding.tenantId, userId: command.actorUserId, status: facts.member.status as never, role: facts.member.role as never }
            : undefined,
          action: "sessions:create",
          resource: { tenantId: binding.tenantId, ownerUserId: binding.ownerUserId },
        })
      : authorizePlatform({
          actor: base.actor,
          member: facts.member
            ? { tenantId: binding.tenantId, userId: command.actorUserId, status: facts.member.status as never, role: facts.member.role as never }
            : undefined,
          action,
          resource: base.resource,
          expectedRevision: base.expectedRevision,
        });
    if (decision.effect !== "allow") return decision;
    // 事实层的失败条件（governance 看不到租户 / 作品 / 绑定状态之外的东西）：
    if (facts.tenantStatus !== "active") return { effect: "deny", reason: `拒绝：租户状态为 ${String(facts.tenantStatus)}，只有 active 租户可投递` };
    if (!facts.work || facts.work.status !== "active") return { effect: "deny", reason: `拒绝：目标作品不存在或状态为 ${String(facts.work?.status)}` };
    if (facts.work.ownerUserId !== binding.ownerUserId) return { effect: "deny", reason: "拒绝：作品属主与绑定所有者不一致" };
    if (facts.member === undefined) return { effect: "deny", reason: "拒绝：找不到当前成员记录" };
    return decision;
  }

  // ---- 投递 ----

  interface DeliveryOutcome {
    kind: "settled" | "released" | "failed";
    reason: string;
  }

  function issueGrantFor(input: {
    cell: CellEndpoint;
    bootId: string;
    facts: DeliveryFacts;
    op: keyof typeof ACTION_FOR_OP;
    commandId: string;
    rawBody: Buffer;
  }) {
    return deps.signer.issue({
      aud: input.cell.cellId,
      boot: input.bootId,
      tid: input.facts.binding.tenantId,
      sid: input.facts.binding.id,
      sub: input.facts.binding.ownerUserId,
      wid: input.facts.binding.workId,
      preset: input.facts.binding.preset,
      rev: input.facts.binding.revokedRevision,
      op: input.op,
      cmd: input.commandId,
      rawBody: input.rawBody,
    });
  }

  /**
   * 为"查回执"签发一枚**全新**凭证（绝不复用 POST 那枚）。
   *
   * 为什么必须是新凭证：POST 的凭证 `jti` 已经被消费（一次性），复用它在 driver 侧
   * 就是**重放**；而且它的 `bh` 绑定的是投递正文，而 GET 没有正文 —— 用同一枚凭证
   * 去查回执，driver 既无法验证"空 GET"的 `bh`，也无法把它与 POST 区分开。
   *
   * 冻结契约（与 Lead/driver 侧逐字一致）：
   *   * `op='subscribe'`（读操作，不新增 grantOp）；
   *   * `cmd=receipt-<commandId>`（与 `subscribeCommandId` 同族的派生函数）；
   *   * `bh=sha256(空 Buffer)`（GET 没有正文）；
   *   * 其余六个绑定字段（aud/boot/tid/sid/sub/wid/preset/rev）与当次 principal/boot 完全相同；
   *   * 每调用一次就是新 `jti`（签发方内部生成）。
   *
   * 路径仍是 `GET /v1/commands/:commandId`，不变。
   */
  function issueReceiptGrant(input: { cell: CellEndpoint; bootId: string; facts: DeliveryFacts; commandId: string }) {
    return issueGrantFor({
      cell: input.cell,
      bootId: input.bootId,
      facts: input.facts,
      op: "subscribe",
      commandId: receiptCommandId(input.commandId),
      rawBody: Buffer.alloc(0),
    });
  }

  async function settleFailed(command: CommandRecord, reason: string, receipt: Record<string, unknown>): Promise<void> {
    await settleQuietly(command, "failed", receipt);
    await store
      .withTenant({ tenantId: command.tenantId }, async (tx) => {
        await insertAuditEvent(tx, {
          actorUserId: command.actorUserId,
          actorKind: "service",
          category: "data-write",
          action: "command.failed",
          resource: `command:${command.id}`,
          effect: "deny",
          reason: reason.slice(0, 400),
          sessionId: command.bindingId,
          workId: command.workId,
        });
      })
      .catch(() => undefined);
  }

  async function settleQuietly(command: CommandRecord, status: "succeeded" | "failed", receipt: Record<string, unknown>): Promise<void> {
    try {
      const { settleCommand } = await import("@myrix/platform-store");
      await settleCommand(store, command.tenantId, {
        commandId: command.id,
        workerId,
        receipt: boundedReceipt(receipt),
        status,
      });
    } catch (error) {
      // 租约可能已经过期并被其他 worker 回收；这时不能把 settle 失败升级成投递失败。
      logger.warn?.("myrix-bff runtime: 结算命令失败（可能租约已过期）", {
        commandId: command.id,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  /** 投递失败/超时：保持持久队列并退避重试。返回结果供本轮统计。 */
  async function release(command: CommandRecord, reason: string): Promise<DeliveryOutcome> {
    const { releaseCommand } = await import("@myrix/platform-store");
    try {
      const outcome = await releaseCommand(store, command.tenantId, { commandId: command.id, workerId, error: reason });
      logger.warn?.("myrix-bff runtime: 命令投递失败，保持持久队列并退避重试", {
        commandId: command.id,
        attempts: outcome.attempts,
        retrying: outcome.retrying,
      });
    } catch (error) {
      logger.warn?.("myrix-bff runtime: 释放命令失败", {
        commandId: command.id,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
    return { kind: "released", reason };
  }

  /** 永久失败（driver 明确拒绝、正文不合契约）：不重试，写 failed + 审计。 */
  async function fail(command: CommandRecord, reason: string, receipt: Record<string, unknown>): Promise<DeliveryOutcome> {
    await settleFailed(command, reason, receipt);
    return { kind: "failed", reason };
  }

  function failureToOutcome(command: CommandRecord, failure: DriverFailure): Promise<DeliveryOutcome> {
    const detail = `${failure.kind}${failure.status === undefined ? "" : `/${String(failure.status)}`}${failure.code === undefined ? "" : ` (${failure.code})`}: ${failure.reason}`;
    if (failure.retryable) {
      return release(command, detail);
    }
    return fail(command, `driver 明确拒绝投递（不可重试）：${detail}`, {
      status: "failed",
      commandId: command.id,
      error: failure.code ?? failure.kind,
      reason: failure.reason.slice(0, 300),
    });
  }

  /** 恢复等待的固定延后（毫秒）；必须大于一轮投递的典型耗时，让 resume 先被领取。 */
  const RECOVERY_DEFER_MS = 1_000;

  /**
   * 恢复被**明确拒绝/耗尽**时的有界长退避（毫秒）。
   *
   * `denied` / `exhausted` 是终止结论：不能新增 resume，也不能继续用旧授权 POST。
   * 但也不能把等待中的消息判 `failed`。保持 `queued` 并推到未来这么长的一段时间，
   * 既避免每个轮询周期都重新尝试（忙转），又能让 boot 变化/运维介入后自然恢复投递。
   */
  const RECOVERY_TERMINAL_DEFER_MS = 60_000;

  /**
   * 让一条**已被认领**的命令为恢复让路：清锁 + 延后 available_at + 退还这次认领。
   *
   * 为什么必须让路：`claimSessionCommand` 只取 `available_at <= now` 且按 `created_at`
   * FIFO。原命令的 `created_at` 一定早于刚入队的 resume，若它保持 available，
   * 下一个候选永远是它自己 —— 恢复命令排在后面永远不会被领取（自己持有 inflight
   * 等排在后面的 resume = 死锁）。
   *
   * 为什么**退还** attempts：等待恢复不是一次投递失败，消耗投递预算会在 cell
   * 重启稍慢时把还值得投递的消息推成 dead。恢复循环本身由
   * `maxAttemptsPerBoot`（每 boot 的 resume 枚数）限死，不靠 attempts 兜底。
   *
   * 这个更新刻意留在本文件（与 `candidateSessions`、`readFacts` 同层）：
   * 它只是"把刚才这次 claim 原样撤回"，不新增仓储 API、不改队列语义。
   */
  async function deferForRecovery(command: CommandRecord, reason: string, delayMs = RECOVERY_DEFER_MS): Promise<DeliveryOutcome> {
    try {
      await store.withTenant({ tenantId: command.tenantId }, async (tx) => {
        const row = await tx.trx
          .updateTable("commands")
          .set({
            status: "queued",
            locked_at: null,
            locked_by: null,
            lease_expires_at: null,
            // 时间源必须与**认领查询**一致：`candidateSessions` / `claimSessionCommand`
            // 比较的是 `new Date()`（即数据库/进程墙钟），不是注入的逻辑时钟。
            // 用 `clock()` 会在逻辑时钟被固定/回拨时算出"已过期"，让路立即失效。
            available_at: new Date(Date.now() + delayMs),
            attempts: sql<number>`greatest(attempts - 1, 0)`,
            last_error: reason.slice(0, 2000),
          })
          .where("id", "=", command.id)
          .where("locked_by", "=", workerId)
          .where("status", "=", "inflight")
          .returning(["id"])
          .executeTakeFirst();
        if (!row) {
          // 租约已过期被别的 worker 回收：什么都不做，绝不能覆盖别人的状态。
          logger.warn?.("myrix-bff runtime: 恢复前让路失败（租约已失效）", { commandId: command.id });
          return;
        }
        await insertAuditEvent(tx, {
          actorUserId: command.actorUserId,
          actorKind: "service",
          category: "data-write",
          action: "command.deferred",
          resource: `command:${command.id}`,
          effect: "allow",
          reason: reason.slice(0, 2000),
          sessionId: command.bindingId,
          workId: command.workId,
        });
      });
    } catch (error) {
      logger.warn?.("myrix-bff runtime: 恢复前让路异常", {
        commandId: command.id,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
    return { kind: "released", reason };
  }

  /**
   * 为一条命令/一次订阅请求会话恢复（恢复关闭时返回 `undefined`）。
   *
   * 调用方按 `ResumeRequestOutcome.status` 分支：
   *   * `enqueued` / `pending`：恢复已入队或已有待投递的 resume → 命令让路 / 订阅 503 `session_reopening`；
   *   * `unavailable`：恢复路径暂时不可用（数据库/入队/读取失败）→ 命令退避重试，订阅 503 `stream_unavailable`；
   *   * `denied` / `exhausted`：恢复被明确拒绝或已达上限（**终止态**）→
   *      命令保持持久队列退避（绝不判永久失败），订阅答 403 `session_recovery_denied`
   *      / 409 `session_recovery_exhausted`，绝不冒充"正在恢复"。
   */
  async function requestRecovery(input: {
    tenantId: string;
    sessionId: string;
    bootId: string;
    reason: string;
    openProof?: "mismatch" | "driver-reported";
  }): Promise<ResumeRequestOutcome | undefined> {
    if (!recoveryEnabled) return undefined;
    try {
      const outcome = await recovery.requestResume({
        ...input,
        ...(input.openProof === undefined ? {} : { openProof: input.openProof }),
      });
      if (outcome.status === "enqueued" || outcome.status === "pending") dispatcher.wake();
      return outcome;
    } catch (error) {
      // 恢复读取/入队路径的**未预期**异常（例如 `listResumes` 的数据库读取失败在
      // `requestResume` 的 try 之外抛出）：必须映射成 `unavailable`，让调用方
      // fail-closed 退避，而**不是**让异常冒泡到投递外层兜底 `release`（那会消耗
      // 真实投递预算、可能在 max_attempts 很小时把消息推成 dead）。
      // 绝不把数据库故障冒充成 `unknown`/`denied`。
      logger.warn?.("myrix-bff runtime: 恢复请求异常，按暂时不可用处理（fail-closed）", {
        sessionId: input.sessionId,
        code: error instanceof PlatformStoreError ? error.code : "unknown",
      });
      return { status: "unavailable", reason: "recovery-request-failed: 恢复路径暂时不可用" };
    }
  }

  /**
   * 把一次恢复请求的结论翻译成订阅端点的 HTTP 失败，**状态码与恢复语义一一对应**。
   *
   * 诚实性要求（ADR-0028 §7）：`denied` / `exhausted` 是**终止态**，绝不能再冒充成
   * 503 `session_reopening`（那会让客户端以为"正在恢复、继续重连"，实际永远不会成功）。
   *
   *   * `undefined`（恢复关闭）/ `enqueued` / `pending` → 503 `session_reopening`（恢复中）；
   *   * `unavailable`                                   → 503 `stream_unavailable`（暂时不可用，可重试）；
   *   * `denied`                                        → 403 `session_recovery_denied`（固定脱敏 reason）；
   *   * `exhausted`                                     → 409 `session_recovery_exhausted`（固定脱敏 reason）。
   *
   * 终端分支只回显**固定文案**：内部 `reason`（可能含 binding 状态、SQL 细节等）只进
   * 审计与日志，绝不越过 HTTP 边界。
   */
  function recoveryApiFailure(requested: ResumeRequestOutcome | undefined, reopeningReason: string): ApiFailure {
    if (requested === undefined || requested.status === "enqueued" || requested.status === "pending") {
      return new ApiFailure(503, "session_reopening", reopeningReason);
    }
    if (requested.status === "unavailable") {
      return new ApiFailure(503, "stream_unavailable", "恢复路径暂时不可用，请稍后重试");
    }
    logger.warn?.("myrix-bff runtime: 会话恢复未入队，返回终止态", {
      recovery: requested.status,
    });
    if (requested.status === "denied") {
      return new ApiFailure(403, "session_recovery_denied", "会话恢复被拒绝，无法在当前身份下重新打开");
    }
    return new ApiFailure(409, "session_recovery_exhausted", "会话恢复尝试已达上限，无法自动重新打开");
  }

  /**
   * 投递一条**已被当前 worker 认领**的命令。
   *
   * 步骤与失败分类：
   *   1. 读当前事实 → 撤权/成员停用/作品删除/rev 变化一律拒绝（永久失败）。
   *   2. 解析 cell（缺 placement → 退避重试，provisioning 期间是暂时的）。
   *   3. `GET /v1/ready` 取 bootId（不 ready → 退避重试）。
   *   4. 健康检查通过后才签发凭证（`rev` = 当前库中的 rev）。
   *   5. POST；超时先查回执（不盲目重发），其余按可重试性分流。
   */
  async function deliver(command: CommandRecord): Promise<DeliveryOutcome> {
    const facts = await readFacts(command.tenantId, command.bindingId);
    if (!facts) {
      return fail(command, "binding-not-found: 命令关联的会话绑定不存在", { status: "failed", commandId: command.id, error: "binding-not-found" });
    }
    if (facts.binding.ownerUserId !== command.actorUserId) {
      return fail(command, "not-owner: 命令发起者不是会话所有者", { status: "failed", commandId: command.id, error: "not-owner" });
    }
    if (facts.binding.status === "revoked") {
      return fail(command, "binding-revoked: 会话已撤权，不再投递该命令", { status: "failed", commandId: command.id, error: "binding-revoked", rev: facts.binding.revokedRevision });
    }
    const decision = authorizeDelivery(facts, { actorUserId: command.actorUserId, op: command.op });
    if (decision.effect !== "allow") {
      return fail(command, `授权拒绝：${decision.reason}`, { status: "failed", commandId: command.id, error: "forbidden", reason: decision.reason.slice(0, 300) });
    }
    if (command.op === "create" && facts.binding.status !== "creating") {
      // 已经 active 的会话重复收到 create（例如人工 requeue）：不再重开，直接按回执结算。
      await settleQuietly(command, "succeeded", { status: "accepted", commandId: command.id, note: "绑定已激活，create 不再重复执行" });
      return { kind: "settled", reason: "binding-already-active" };
    }
    if (command.op === "send" && typeof command.body["text"] !== "string") {
      return fail(command, "malformed-command: send 命令缺少 text", { status: "failed", commandId: command.id, error: "malformed-command" });
    }
    if (command.op !== "create" && facts.binding.status !== "active") {
      return release(command, `binding-not-active: 绑定状态为 ${facts.binding.status}，等待 create 完成后再投递`);
    }

    const cell = await resolveCell(facts.binding.tenantId, facts.binding.cellId);
    if (!cell) {
      return release(command, "cell-unplaced: 该租户没有可用的 cell placement");
    }

    const ready = await deps.driver.ready(cell);
    if (!ready.ok) {
      return failureToOutcome(command, ready);
    }
    if (!ready.value.ready) {
      return release(command, `cell-not-ready: driver 未就绪（${ready.value.reason ?? "无原因"}）`);
    }

    // 重启后 driver 的 `live`/`principals` 是空的：binding 仍是 active，但会话在**当前
    // boot** 里没有被打开过。承载类命令（send/cancel）不能直接发（driver 会 409
    // session_not_open 并被旧代码永久 fail 掉消息），也不能在 BFF 里开侧门直接 resume。
    // 正确做法：先把一条 resume 持久入队（同一套 governance + 审计 + 投递循环），
    // 本条命令让路延后 —— resume 的 created_at 更晚，只有让路才能让它先被领取。
    //
    // 只在**证明了一次正向的 boot 不匹配**时才提前恢复（`state === "mismatch"`）。
    // `unknown`（没有成功回执）时不做任何推断，直接把命令交给 driver 权威判定，
    // 由反应式恢复兜底 —— 否则"没有回执"会被误当成"没打开"，把正常会话也拦下来。
    // `unavailable`（读取失败）必须 fail-closed：不投递、不生成 resume，释放重试。
    // create/resume 自身绝不递归 preflight（见 `isRecoveryCarryingOp`）。
    if (recoveryEnabled && isRecoveryCarryingOp(command.op)) {
      const proof = await recovery.openProof(command.tenantId, command.bindingId, ready.value.bootId);
      if (proof.state === "unavailable") {
        // 读取失败必须 fail-closed：不投递、不生成 resume。按"等待恢复"让路，
        // **不消耗真实投递预算**（通用 `release` 会在 attempts 撞上限时把命令标 dead）。
        return deferForRecovery(command, "recovery-unavailable: 读取会话打开证明失败，暂时无法安全投递");
      }
      if (proof.state === "mismatch") {
        const requested = await requestRecovery({
          tenantId: command.tenantId,
          sessionId: command.bindingId,
          bootId: ready.value.bootId,
          reason: `open-proof-boot-mismatch: 最近成功回执属于 boot ${proof.bootId ?? "未知"}，当前 boot ${ready.value.bootId}`,
          openProof: "mismatch",
        });
        if (requested?.status === "enqueued" || requested?.status === "pending") {
          return deferForRecovery(
            command,
            `session-reopening: 已请求恢复（${requested.commandId ?? "未知命令"}），本条命令延后重试`,
          );
        }
        if (requested?.status === "unavailable" || requested === undefined) {
          // 恢复路径暂时不可用（数据库/入队/读取失败）：保持队列退避，绝不把消息标 failed。
          // 让路（不是通用 `release`）：等待恢复不是一次投递失败，不能消耗真实投递预算
          // —— `releaseCommand` 在 attempts 撞上 max_attempts 时会把命令标 `dead`。
          return deferForRecovery(command, `recovery-unavailable: ${requested?.reason ?? "恢复路径暂时不可用"}`);
        }
        // 已证明 boot 不匹配，denied/exhausted 也绝不能落穿到 POST。
        // 保留原消息并退还认领预算；长退避等待授权修复或下一次 boot。
        return deferForRecovery(
          command,
          `recovery-${requested.status}: ${requested.reason}；保持持久队列，不判永久失败`,
          RECOVERY_TERMINAL_DEFER_MS,
        );
      }
    }

    const body = wireBodyOf(command);
    const rawBody = Buffer.from(JSON.stringify(body), "utf8");
    const grant = await issueGrantFor({
      cell,
      bootId: ready.value.bootId,
      facts,
      op: command.op,
      commandId: command.id,
      rawBody,
    });
    if (command.op === "create" && facts.binding.cellId !== cell.cellId) {
      // 目录指向的 cell 与绑定记录里的 cell 不一致：不允许"投到别处再改记录"。
      return release(command, `cell-mismatch: 绑定 cell=${String(facts.binding.cellId)}，目录解析为 ${cell.cellId}`);
    }

    const posted = await deps.driver.postCommand(cell, rawBody, grant.token);
    if (posted.ok) {
      if (command.op === "create" || command.op === "resume") {
        await activate(facts.binding.tenantId, facts.binding.id, cell.cellId);
      }
      await settleQuietly(command, "succeeded", {
        status: posted.value.status,
        commandId: posted.value.commandId,
        bootId: posted.value.bootId,
        ...(posted.value.note === undefined ? {} : { note: posted.value.note }),
      });
      return { kind: "settled", reason: posted.value.status };
    }

    if (posted.kind === "timeout" || posted.kind === "unreachable") {
      // 结果未知：先查回执，绝不盲目重发（重复投递会把同一 commandId 重放成第二次 followup）。
      // 查回执必须用**新的** receipt grant：POST 那枚的 jti 已被消费、bh 绑定的是 POST 正文，
      // 复用它既是被消费过的 jti 重放，也无法验证这次空正文 GET。
      const receiptGrant = issueReceiptGrant({
        cell,
        bootId: ready.value.bootId,
        facts,
        commandId: command.id,
      });
      const receipt = await deps.driver.getReceipt(cell, command.id, receiptGrant.token);
      if (receipt.ok && receipt.value !== undefined) {
        if (command.op === "create" || command.op === "resume") {
          await activate(facts.binding.tenantId, facts.binding.id, cell.cellId);
        }
        await settleQuietly(command, "succeeded", {
          status: receipt.value.status,
          commandId: receipt.value.commandId,
          bootId: receipt.value.bootId,
          note: "超时后查到回执，按已投递结算",
        });
        return { kind: "settled", reason: "receipt-recovered" };
      }
      if (!receipt.ok) {
        logger.warn?.("myrix-bff runtime: 查询回执失败，保持队列退避", { commandId: command.id, kind: receipt.kind });
      }
    }

    // 反应式恢复：driver 明确回答"会话在当前进程里没有打开"（`session_not_open`）或
    // "身份表里没有这个会话"（`identity_invalid`）。这是 open-proof 无法覆盖的窗口
    // （同一 boot 下 Agent 被释放、绑定在本进程创建前的事实被清空等），必须有有界恢复
    // 路径，否则消息会被永久 fail。
    //
    // **只对承载类命令（send/cancel）生效**（`isRecoveryCarryingOp`）：create/resume
    // 本身就是"打开会话"的动作，driver 对它们的拒绝是对**这一次打开**的结论。
    // 若把它们当可恢复，`deliver` 会把**同一条**命令反复让路（`attempts` 退回 0）：
    // 生产里 create 时 binding 仍是 creating，`requestResume` 判 `binding-not-active`
    // 并返回 `denied`（零新 resume），于是同一条 create 被无限期 60s 长退避 ——
    // 命令数恒为 1，但永远不结算。它们必须走下面的有界失败分类
    // （可重试退避 / 明确拒绝 failed）。
    //
    // 严格限定在这两个机器可读码：其余 403（not_owner / identity_mismatch / rev_stale /
    // session_revoked / grant/*）是身份或撤权结论，绝不当作可恢复。
    if (isRecoveryCarryingOp(command.op) && isRecoverableDriverCode(posted.code)) {
      const requested = recoveryEnabled
        ? await requestRecovery({
            tenantId: command.tenantId,
            sessionId: command.bindingId,
            bootId: ready.value.bootId,
            reason: `driver-not-open: ${String(posted.code)}（${String(posted.status ?? "无状态码")}）`,
            openProof: "driver-reported",
          })
        : undefined;
      if (requested?.status === "enqueued" || requested?.status === "pending") {
        return deferForRecovery(
          command,
          `session-reopening: driver 报 ${String(posted.code)}，已请求恢复（${requested.commandId ?? "未知命令"}），本条命令延后重试`,
        );
      }
      if (requested?.status === "unavailable") {
        // 恢复路径暂时不可用（数据库/入队失败）：保持队列退避，绝不把消息标 failed。
        // 让路而不是通用 `release`：等待恢复不是一次投递失败，不消耗真实投递预算。
        return deferForRecovery(command, `recovery-unavailable: ${requested.reason}`);
      }
      if (requested !== undefined) {
        // exhausted / denied：恢复被明确拒绝或已达上限。不能无限新增恢复命令，
        // 也不能把"等待恢复"的消息永久标 failed —— 保持持久队列 + 有界长退避，
        // 不消耗真实投递预算，等运维处理或 boot 变化后再投递。
        return deferForRecovery(
          command,
          `recovery-${requested.status}: ${requested.reason}；保持持久队列，不判永久失败`,
          RECOVERY_TERMINAL_DEFER_MS,
        );
      }
    }
    return failureToOutcome(command, posted);
  }

  /**
   * 解析命令应投递到哪个 cell。
   *
   * **一 Cell 一租户**在这里也要成立：目录是可注入的，所以无论走 `byId` 还是
   * `resolve`，拿到的 endpoint 都必须服务 `tenantId`；否则一律当作"没有放置"
   * 让调用方 fail-closed，绝不把 A 租户的命令投到 B 租户的 cell 上。
   */
  async function resolveCell(tenantId: string, cellId: string | null): Promise<CellEndpoint | undefined> {
    if (cellId !== null) {
      const byId = await deps.directory.byId(cellId, tenantId);
      if (cellServesTenant(byId, tenantId)) return byId;
    }
    const resolved = await deps.directory.resolve(tenantId);
    return cellServesTenant(resolved, tenantId) ? resolved : undefined;
  }

  /** creating → active（cell 回执后的激活）。失败只记日志：命令本身已经成功投递。 */
  async function activate(tenantId: string, sessionId: string, cellId: string): Promise<void> {
    try {
      await sessions.markActive(tenantId, sessionId, cellId);
      logger.info?.("myrix-bff runtime: 会话已激活", { sessionId, cellId });
    } catch (error) {
      logger.warn?.("myrix-bff runtime: 会话激活失败（命令已投递，等待重试）", {
        sessionId,
        code: error instanceof PlatformStoreError ? error.code : "unknown",
      });
    }
  }

  // ---- outbox：撤权通知 driver ----

  async function dispatchOutboxOnce(): Promise<{ claimed: number; delivered: number; retried: number }> {
    let claimed = 0;
    let delivered = 0;
    let retried = 0;
    for (const tenantId of await tenantSource()) {
      const batch = await outbox.claim(tenantId, { workerId, limit: claimBatch, leaseMs, topics: ["session.revoke"] });
      claimed += batch.length;
      for (const claim of batch) {
        const payload = claim.record.payload;
        const sid = typeof payload["sessionId"] === "string" ? payload["sessionId"] : undefined;
        const rev = typeof payload["revokedRevision"] === "number" ? payload["revokedRevision"] : undefined;
        const reason = typeof payload["reason"] === "string" ? payload["reason"] : "session revoked";
        const cellId = typeof payload["cellId"] === "string" ? payload["cellId"] : undefined;
        if (sid === undefined || rev === undefined) {
          // 载荷不合契约：不重试（重试一万次也一样），直接 dead 并留下原因。
          await outbox.fail(tenantId, claim.record.id, workerId, "malformed-outbox-payload: 缺少 sessionId/revokedRevision").catch(() => undefined);
          retried += 1;
          continue;
        }
        // 撤权通知同样受"一 Cell 一租户"约束：按 cellId 取到的 endpoint 必须服务本租户，
        // 否则退回按租户解析；两者都不匹配时判为无法解析（outbox 退避/失败，不误投）。
        const cell = await resolveCell(tenantId, cellId ?? null);
        if (cell === undefined) {
          await outbox.fail(tenantId, claim.record.id, workerId, "cell-unplaced: 无法解析 cell 地址").catch(() => undefined);
          retried += 1;
          continue;
        }
        const result = await deps.driver.revoke(cell, { sid, rev, reason });
        if (result.ok) {
          await outbox.settle(tenantId, claim.record.id, workerId).catch((error: unknown) => {
            logger.warn?.("myrix-bff runtime: outbox 结算失败（租约可能已过期）", {
              outboxId: claim.record.id,
              error: error instanceof Error ? error.name : "unknown",
            });
          });
          delivered += 1;
          continue;
        }
        retried += 1;
        await outbox
          .fail(tenantId, claim.record.id, workerId, `revoke 投递失败（${result.kind}）：${result.reason}`.slice(0, 2_000))
          .catch(() => undefined);
      }
    }
    return { claimed, delivered, retried };
  }

  // ---- 投递循环 ----

  /**
   * 本轮有活可干的会话（每会话一条）。
   *
   * 为什么不直接用 `claimAnyCommands`：它的候选查询用 `not exists(inflight)` 做"每会话串行"，
   * 但批量 claim 的 update 发生在检查之后，同一个会话里的两条 queued 命令会**一起**被认领，
   * 「每会话 FIFO」就退化成"排序"了。这里先按会话聚合（只取每个会话最早的一条），
   * 再用仓储自己的 `claimSessionCommand` 认领：它在事务内检查 inflight、按 created_at FIFO、
   * 并拿事务级 advisory lock 保证"同一会话同一时间只有一个投递者"。
   */
  async function candidateSessions(tenantId: string, limit: number): Promise<string[]> {
    return store.withTenant({ tenantId }, async (tx) => {
      const rows = await tx.trx
        .selectFrom("commands as c")
        .innerJoin("session_bindings as b", (join) =>
          join.onRef("b.tenant_id", "=", "c.tenant_id").onRef("b.id", "=", "c.binding_id"),
        )
        .select([
          "c.binding_id as bindingId",
          sql<Date>`min(c.available_at)`.as("dueAt"),
          sql<Date>`min(c.created_at)`.as("createdAt"),
        ])
        .where("c.status", "=", "queued")
        .where("c.available_at", "<=", new Date())
        .where("c.op", "in", ["create", "resume", "send", "cancel"])
        // 只有 **active** 绑定是投递候选。
        //   * revoked：撤权后连"写一条 failed"都不需要，命令留给审计/运维；
        //     撤销的事实已经由 binding 与 outbox 表达，投递不会再发生。
        //   * creating：只有它的 create 命令需要投递（`deliver` 里对它单独放行），
        //     其余承载类命令在绑定激活前一律不投递。
        // 这里刻意不把 creating 排除，否则 create 命令自己也会没有候选。
        .where("b.status", "in", ["active", "creating"])
        .where(
          sql<boolean>`not exists (
            select 1 from commands i
            where i.tenant_id = c.tenant_id and i.binding_id = c.binding_id and i.status = 'inflight'
          )`,
        )
        .groupBy("c.binding_id")
        .orderBy("dueAt", "asc")
        .orderBy("createdAt", "asc")
        .limit(limit)
        .execute();
      return rows.map((row) => row.bindingId);
    });
  }

  async function dispatchOnce(): Promise<{ claimed: number; settled: number; released: number; failed: number }> {
    let claimed = 0;
    let settled = 0;
    let released = 0;
    let failed = 0;
    for (const tenantId of await tenantSource()) {
      let bindingIds: string[];
      try {
        bindingIds = await candidateSessions(tenantId, claimBatch);
      } catch (error) {
        logger.warn?.("myrix-bff runtime: 查询待投递会话失败", {
          tenantId,
          code: error instanceof PlatformStoreError ? error.code : "unknown",
        });
        continue;
      }
      for (const bindingId of bindingIds) {
        let command: CommandRecord | null;
        try {
          const outcome = await claimSessionCommand(store, tenantId, { bindingId, workerId, leaseMs });
          command = outcome.reason === "claimed" ? outcome.command : null;
          if (outcome.reason === "revoked" || outcome.reason === "busy") continue;
        } catch (error) {
          logger.warn?.("myrix-bff runtime: 认领命令失败", {
            tenantId,
            code: error instanceof PlatformStoreError ? error.code : "unknown",
          });
          continue;
        }
        if (command === null) continue;
        claimed += 1;
        let outcome: DeliveryOutcome;
        try {
          outcome = await deliver(command);
        } catch (error) {
          // 投递过程中的未预期异常：保持队列（release），不能吞掉也不能误判为成功。
          outcome = await release(command, `deliver-failed: ${error instanceof Error ? error.name : "unknown"}`);
        }
        if (outcome.kind === "settled") settled += 1;
        else if (outcome.kind === "released") released += 1;
        else failed += 1;
      }
    }
    return { claimed, settled, released, failed };
  }

  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let woken = false;
  /** stop() 之后不再开始新一轮；在途的一轮由 stop() 等待。 */
  let stopping = false;

  async function loop(): Promise<void> {
    const stats = await dispatchOnce();
    if (outboxEnabled) await dispatchOutboxOnce();
    if (stats.claimed > 0) {
      logger.info?.("myrix-bff runtime: 投递循环完成一轮", { ...stats, workerId, at: clock().toISOString() });
    }
  }

  /**
   * 跑一轮，并把这一轮登记为 `inFlight` 供 `stop()` 等待。
   *
   * 刻意不在 `tick` 里再排下一次定时器：定时由 `schedule()` 统一负责，
   * 否则 `wake()` 与 `tick()` 会各自插一个定时器，出现并行两轮（同一 worker 重复认领竞争）。
   */
  async function runRound(): Promise<void> {
    const round = (async () => {
      try {
        await loop();
      } catch (error) {
        logger.error?.("myrix-bff runtime: 投递循环异常", { error: error instanceof Error ? error.name : "unknown" });
      }
    })();
    inFlight = round;
    try {
      await round;
    } finally {
      if (inFlight === round) inFlight = undefined;
    }
  }

  /** 在 `delayMs` 之后跑下一轮；`wake()` 可以把它提前到 0ms。 */
  function schedule(delayMs: number): void {
    if (stopping) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void runRound().then(() => {
        if (stopping) return;
        // 这一轮期间被 wake() 过：立刻再跑一轮，否则退回固定轮询间隔。
        schedule(woken ? 0 : DEFAULT_POLL_MS);
        woken = false;
      });
    }, delayMs);
    timer.unref?.();
  }

  const dispatcher: RuntimeDispatcher = {
    dispatchOnce,
    dispatchOutboxOnce,
    get running() {
      return running;
    },
    start(): void {
      if (running) return;
      running = true;
      stopping = false;
      woken = false;
      schedule(0);
      logger.info?.("myrix-bff runtime: 投递循环已启动", { workerId, outboxEnabled });
    },
    async stop(): Promise<void> {
      stopping = true;
      running = false;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      // 等在途那一轮真正结束：不允许"已停止"之后还有投递在跑。
      if (inFlight !== undefined) await inFlight.catch(() => undefined);
      logger.info?.("myrix-bff runtime: 投递循环已停止", { workerId });
    },
    wake(): void {
      if (!running) return;
      woken = true;
      // 当前没有排定的定时器 = 一轮正在跑；它结束后会看到 woken 并立刻续跑。
      if (timer !== undefined) schedule(0);
    },
  };

  // ---- RuntimeRouter 端口 ----

  async function requireCell(tenantId: string): Promise<CellEndpoint> {
    const cell = await deps.directory.resolve(tenantId);
    // `cell.tenantId !== tenantId` 同样拒绝：可注入的目录可能返回别人的 endpoint，
    // 而 cellId 就是凭证 aud 与租户边界。
    if (!cellServesTenant(cell, tenantId)) {
      throw new ApiFailure(503, "cell_unplaced", "该租户当前没有可用的运行时 Cell，无法创建会话");
    }
    return cell;
  }

  /** 读一条**属于调用者**的绑定；不是所有者一律 not_found（不泄漏存在性）。 */
  async function loadOwnedBinding(actor: { tenantId: string; userId: string }, sessionId: string): Promise<SessionBindingRecord> {
    const facts = await readFacts(actor.tenantId, sessionId);
    if (!facts || facts.binding.ownerUserId !== actor.userId) {
      throw new ApiFailure(404, "not_found", "会话不存在");
    }
    return {
      tenantId: facts.binding.tenantId,
      id: facts.binding.id,
      ownerUserId: facts.binding.ownerUserId,
      workId: facts.binding.workId,
      preset: facts.binding.preset as NovelPreset,
      policyRevision: "inline",
      cellId: facts.binding.cellId,
      status: facts.binding.status as SessionBindingRecord["status"],
      revokedRevision: facts.binding.revokedRevision,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      revokedAt: null,
    };
  }

  async function enqueue(
    actor: { tenantId: string; userId: string },
    sessionId: string,
    op: "send" | "cancel",
    input: { commandId: string; text?: string },
  ): Promise<QueuedCommand> {
    const binding = await loadOwnedBinding(actor, sessionId);
    const body = enqueueBodyOf({ op, sessionId, commandId: input.commandId, ...(input.text === undefined ? {} : { text: input.text }) });
    try {
      const result = await commands.enqueue(actor.tenantId, actor.userId, {
        commandId: input.commandId,
        bindingId: sessionId,
        op,
        body,
        expectedRevision: binding.revokedRevision,
      });
      const existing = result.command;
      if (!result.created && (existing.status === "failed" || existing.status === "dead")) {
        // 同一条命令之前已经被明确拒绝：返回 409 而不是继续假装"排队中"。
        throw new ApiFailure(409, "command_failed", `该命令此前已被拒绝：${existing.lastError ?? "无原因"}`);
      }
      dispatcher.wake();
      return { commandId: existing.id, status: "queued" };
    } catch (error) {
      return toApi(error);
    }
  }

  async function loadGrantInput(actor: { tenantId: string; userId: string }, sessionId: string) {
    const facts = await readFacts(actor.tenantId, sessionId);
    if (!facts || facts.binding.ownerUserId !== actor.userId) {
      throw new ApiFailure(404, "not_found", "会话不存在");
    }
    if (facts.binding.status === "revoked") throw new ApiFailure(410, "revoked", "会话已撤权");
    if (facts.binding.status !== "active") throw new ApiFailure(409, "session_not_active", "会话尚未激活，请稍后重试");
    if (facts.tenantStatus !== "active") throw new ApiFailure(403, "forbidden", "租户已停用");
    if (!facts.member || facts.member.status !== "active") throw new ApiFailure(403, "forbidden", "当前成员已停用");
    if (!facts.work || facts.work.status !== "active" || facts.work.ownerUserId !== facts.binding.ownerUserId) {
      throw new ApiFailure(403, "forbidden", "目标作品已停止或不属于会话所有者");
    }
    const decision = authorizePlatform({
      actor: { tenantId: facts.binding.tenantId, userId: actor.userId },
      member: { tenantId: facts.binding.tenantId, userId: actor.userId, status: facts.member.status as never, role: facts.member.role as never },
      action: "sessions:subscribe",
      resource: { tenantId: facts.binding.tenantId, ownerUserId: facts.binding.ownerUserId, status: facts.binding.status, revision: facts.binding.revokedRevision },
      expectedRevision: facts.binding.revokedRevision,
    });
    if (decision.effect !== "allow") throw new ApiFailure(403, "forbidden", decision.reason);
    const cell = await resolveCell(facts.binding.tenantId, facts.binding.cellId);
    if (!cell) throw new ApiFailure(503, "cell_unplaced", "该会话所在的 Cell 当前不可解析，无法订阅事件");
    return { facts, cell };
  }

  return {
    workerId,
    dispatcher,

    async createSession(actor: PlatformIdentity, workId: string, preset: NovelPreset): Promise<NovelSession> {
      // actor.role 刻意不参与任何判定：绑定创建走 store 内的 governance 判定 + 作品属主事实校验。
      const cell = await requireCell(actor.tenantId);
      try {
        const policyRevision = deps.policyRevision
          ? await deps.policyRevision({ tenantId: actor.tenantId, userId: actor.userId }, workId)
          : "inline";
        const binding = await sessions.create(actor.tenantId, actor.userId, {
          workId,
          preset,
          cellId: cell.cellId,
          policyRevision,
          ...(deps.newCommandId ? { commandId: deps.newCommandId() } : {}),
        });
        // 绑定与 create 命令已经同事务落库；投递是后台的事，这里不假装已激活。
        dispatcher.wake();
        logger.info?.("myrix-bff runtime: 会话绑定已创建，create 命令已入队", { sessionId: binding.id, cellId: cell.cellId });
        return toNovelSession(binding);
      } catch (error) {
        return toApi(error);
      }
    },

    async send(actor: PlatformIdentity, sessionId: string, input: { commandId: string; text: string }): Promise<QueuedCommand> {
      if (typeof input.text !== "string" || input.text.trim().length === 0) {
        throw new ApiFailure(400, "invalid_input", "消息正文不能为空");
      }
      return enqueue({ tenantId: actor.tenantId, userId: actor.userId }, sessionId, "send", input);
    },

    async cancel(actor: PlatformIdentity, sessionId: string, commandId: string): Promise<QueuedCommand> {
      return enqueue({ tenantId: actor.tenantId, userId: actor.userId }, sessionId, "cancel", { commandId });
    },

    async revoke(actor: PlatformIdentity, sessionId: string): Promise<void> {
      try {
        const binding = await loadOwnedBinding({ tenantId: actor.tenantId, userId: actor.userId }, sessionId);
        // 数据库优先：撤权 + rev 递增 + outbox 通知在**同一事务**里完成；
        // 通知 cell 失败只会让 outbox 退避重试，绝不回滚"已撤权"这个结论。
        await sessions.revoke(actor.tenantId, actor.userId, sessionId, binding.revokedRevision, "用户主动结束会话");
        dispatcher.wake();
        logger.info?.("myrix-bff runtime: 会话已撤权（数据库优先）", { sessionId });
      } catch (error) {
        return toApi(error);
      }
    },

    async events(
      actor: PlatformIdentity,
      sessionId: string,
      after: number,
      signal: AbortSignal,
    ): Promise<AsyncIterable<SessionStreamEvent>> {
      if (!Number.isSafeInteger(after) || after < 0) throw new ApiFailure(400, "invalid_cursor", "事件续传游标无效");
      const { facts, cell } = await loadGrantInput({ tenantId: actor.tenantId, userId: actor.userId }, sessionId);
      // **0 必须原样转发**，不能折叠成 undefined。
      //
      // driver 的契约里这两个值语义不同（`plugins/myrix-runtime-driver/src/events.ts`
      // 的 `collectHistory`）：
      //   * `undefined`/缺头 = "未声明水位" → live-only：只回一条 `myrix/subscribed`
      //     当前水位标记，**不补发任何历史**；
      //   * `0` = "我什么都没见过" → 补发全部 `seq > 0` 的持久事件。
      //
      // BFF 的 HTTP 边界默认 cursor 就是 `0`（`server.ts`：`last-event-id` 缺省 `"0"`），
      // 因为浏览器刷新/首屏必须拿到已提交的历史。把它折叠成 undefined 会让
      // "轮次已提交、随后才首次订阅"的会话历史整段消失（用户消息丢失、页面空白），
      // 而流本身看起来完全正常（只有一条被白名单丢弃的控制帧）。
      const lastEventId = after;

      const ready = await deps.driver.ready(cell);
      if (!ready.ok) throw new ApiFailure(503, "cell_unavailable", `Cell 未就绪：${ready.reason}`);
      if (!ready.value.ready) throw new ApiFailure(503, "cell_not_ready", `Cell 未就绪：${ready.value.reason ?? "未知原因"}`);
      const bootId = ready.value.bootId;

      // 重启后的订阅：binding 仍 active，但 driver 的 `principals` 表是空的，
      // `authorizeSubscribe` 会 403 identity_invalid。绝不能"先把 subscribe 发出去再吃 403"
      // —— 那会变成一条看起来正常、实际什么都没有的流。这里先用 open-proof 判断：
      // 未证明打开时不发订阅，先把 resume 持久入队并答 503 `session_reopening`，
      // 前端默认流重连（`EventSource` + 指数退避）会带着同一个 `Last-Event-ID` 重试。
      //
      // 与命令路径同样只处理**正向的 boot 不匹配**（`state === "mismatch"`）：
      // `unknown` 时不做推断，直接发订阅，由 driver 权威判定；
      // 万一真的被 403 `identity_invalid`，下面的反应式分支仍然会把它救回来。
      //
      // **诚实终止态**（绝不把"恢复已被拒绝/已达上限"冒充成 `session_reopening`）：
      //   * `enqueued` / `pending`        → 503 `session_reopening`（真的在恢复中）；
      //   * `unavailable`                 → 503 `stream_unavailable`（暂时不可用，可重试）；
      //   * `denied`                      → 403 `session_recovery_denied`（明确拒绝，不可重试）；
      //   * `exhausted`                   → 409 `session_recovery_exhausted`（已达上限，不可重试）。
      // 两条终止态都只给**固定的脱敏 reason**，绝不回显内部 raw 错误或 reason 文本。
      if (recoveryEnabled) {
        const proof = await recovery.openProof(facts.binding.tenantId, sessionId, bootId);
        // 读取失败：不订阅、不生成 resume，明确答"暂时不可用"（fail-closed）。
        if (proof.state === "unavailable") {
          throw new ApiFailure(503, "stream_unavailable", "会话打开状态暂时无法确认，请稍后重试");
        }
        if (proof.state === "mismatch") {
          const requested = await requestRecovery({
            tenantId: facts.binding.tenantId,
            sessionId,
            bootId,
            reason: `open-proof-boot-mismatch: 最近成功回执属于 boot ${proof.bootId ?? "未知"}，当前 boot ${bootId}`,
            openProof: "mismatch",
          });
          throw recoveryApiFailure(requested, `会话正在 ${bootId} 上重新打开，请稍后重连事件流`);
        }
      }

      // 订阅凭证：op=subscribe、cmd=`subscribe-<sid>`、bh=空正文摘要（与 driver 逐字一致）。
      const grant = deps.signer.issue({
        aud: cell.cellId,
        boot: bootId,
        tid: facts.binding.tenantId,
        sid: sessionId,
        sub: facts.binding.ownerUserId,
        wid: facts.binding.workId,
        preset: facts.binding.preset,
        rev: facts.binding.revokedRevision,
        op: "subscribe",
        cmd: subscribeCommandId(sessionId),
        rawBody: Buffer.alloc(0),
      });
      const streaming = await deps.driver.streamEvents(cell, sessionId, {
        grant: grant.token,
        signal,
        // 恒为数字（含 0）：driver 的 `Last-Event-ID: 0` 就是"从头补发"。
        lastEventId,
      });
      if (!streaming.ok) {
        // 反应式恢复的第二道：open-proof 说"本 boot 打开过"，但 driver 仍然回答
        // `identity_invalid`（同一 boot 下 Agent 被释放 / 被别的路径清空）——
        // 这正是"纯 boot 证明不涵盖同 boot 下 Agent 被释放"的那条边界。
        // 只有这一个码按可恢复处理；其余 403（not_owner/identity_mismatch/rev_stale/
        // session_revoked/grant/*）仍是明确拒绝，绝不当成可恢复。
        if (recoveryEnabled && streaming.code === "identity_invalid") {
          const requested = await requestRecovery({
            tenantId: facts.binding.tenantId,
            sessionId,
            bootId,
            reason: `driver-identity-invalid: 订阅被拒（${streaming.reason}）`,
            openProof: "driver-reported",
          });
          throw recoveryApiFailure(requested, "会话身份在当前进程不可用，已请求重新打开，请稍后重连事件流");
        }
        throw new ApiFailure(streaming.retryable ? 503 : 502, "stream_unavailable", `事件流不可用：${streaming.reason}`);
      }

      const expectedRevision = facts.binding.revokedRevision;
      const limitText = deps.projection?.maxTextChars;
      return projectStream(streaming.value, {
        sessionId,
        tenantId: facts.binding.tenantId,
        expectedRevision,
        signal,
        revalidateMs,
        now: () => clock().getTime(),
        revalidate: async () => {
          const current = await readFacts(facts.binding.tenantId, sessionId);
          if (!current) return "会话绑定已不存在";
          if (current.binding.status !== "active") return `会话状态变为 ${current.binding.status}`;
          if (current.binding.revokedRevision !== expectedRevision) return "会话撤权版本已变化";
          if (current.tenantStatus !== "active") return "租户已停用";
          if (!current.member || current.member.status !== "active") return "成员已停用";
          if (!current.work || current.work.status !== "active" || current.work.ownerUserId !== current.binding.ownerUserId) {
            return "目标作品已停止或已转移";
          }
          return undefined;
        },
        ...(limitText === undefined ? {} : { maxTextChars: limitText }),
      });
    },
  };
}

/**
 * 把 driver 的事件流投影成公开 SSE 事件。
 *
 * 有界与安全：
 *   * 逐帧白名单（见 `runtime-stream.ts`）：白名单外的事件**不投影**，于是公开 seq 合法跳跃。
 *   * **持续**复核：既在每一帧到达时检查，也由独立的定时器按 `revalidateMs` 检查，
 *     因此"会话已经空闲、不再产生任何事件"时撤权/成员停用同样会立刻结束这条流，
 *     而不是等到下一次重连。复核不通过时给一条**不带 seq** 的 status 帧再结束。
 *   * `AbortSignal` 一 abort 立刻停止读取并取消上游。
 *   * 上游解析抛错（单帧超限）只终止事件流，不把异常内容带给客户端。
 *
 * 实现上用"下一帧 vs 复核定时器"的竞速，而不是在一个 `for await` 里判断时间：
 * 事件稀疏的会话如果不竞速，就永远等不到复核时点。
 */
export async function* projectStream(
  frames: AsyncIterable<DriverSseFrame>,
  options: {
    sessionId: string;
    tenantId: string;
    expectedRevision: number;
    signal: AbortSignal;
    revalidateMs: number;
    /** 复核节奏用的时钟（毫秒）；注入以便测试推进时间。 */
    now: () => number;
    revalidate: () => Promise<string | undefined>;
    maxTextChars?: number;
    /** 复核定时器的等待实现；测试可注入假定时器。 */
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  },
): AsyncGenerator<SessionStreamEvent> {
  const projection: ProjectionOptions = options.maxTextChars === undefined ? {} : { maxTextChars: options.maxTextChars };
  const sleep = options.sleep ?? defaultSleep;
  const iterator = frames[Symbol.asyncIterator]();
  let pending: Promise<IteratorResult<DriverSseFrame>> | undefined;

  try {
    for (;;) {
      if (options.signal.aborted) return;
      pending ??= iterator.next();
      const wakeup = sleep(options.revalidateMs, options.signal).then(() => "revalidate" as const);
      const settled = await Promise.race([
        pending.then((result) => ({ kind: "frame" as const, result })),
        wakeup.then((kind) => ({ kind })),
      ]);

      if (settled.kind === "revalidate") {
        if (options.signal.aborted) return;
        const violation = await options.revalidate();
        if (violation !== undefined) {
          yield { type: "status", status: `session-ended: ${violation}` };
          return;
        }
        continue;
      }

      pending = undefined;
      if (settled.result.done === true) return;
      const projected = projectDriverFrame(settled.result.value, projection);
      if (projected !== undefined) yield projected;
    }
  } catch {
    // 上游断开或单帧超限：结束流。客户端按 Last-Event-ID 续传持久事件。
    if (!options.signal.aborted) yield { type: "status", status: "stream-interrupted" };
    return;
  } finally {
    // 立刻停止计数并在后台等已发出的 next()：不 await，避免 finally 里的死等。
    void iterator.return?.(undefined as never).catch(() => undefined);
  }
}

/** 可被 abort 打断的等待；定时器 unref，不阻止进程退出。 */
function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
