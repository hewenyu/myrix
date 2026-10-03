/**
 * BFF 会话恢复：`open-proof` + 有界 `resume` 入队。
 *
 * 复现的真实故障（Lead 实际重启整个 `pnpm dev` 后，会话 e632d2b7-… 订阅 502
 * `stream_unavailable`，driver 403）：
 *   * BFF 侧 binding 仍是 `active`，但 cell 进程已经换了 `bootId`；
 *   * driver 的 `controller.live` 与 `principals` 表在重启后是**空的**；
 *   * 于是 `send` 命中 `controller.send` 的 `requireOwned` → 409 `session_not_open`，
 *     `events` 命中 `authorizeSubscribe` 的 `host.lookupPrincipalBySession` → 403 `identity_invalid`；
 *   * 旧 BFF 把两者都当"不可重试的明确拒绝"，于是被永久 `fail`（消息丢）或 502（流不可用）。
 *
 * 恢复的前提是**证明会话在当前 boot 里已经打开**。本模块只用两件既有事实：
 *
 *   1. `commands.receipt.bootId`：最近一条**成功**的 `create`/`resume` 回执里
 *      driver 自报的 bootId（`DriverCommandReceipt.bootId`）；
 *   2. `GET /v1/ready` 当前的 `bootId`。
 *
 * 二者相等 ⇒ 该绑定在当前 boot 里被证明打开过；不等 ⇒ 需要重新 `resume`。
 * 读取结论是三态，调用方必须按态分支（见 `SessionOpenProof`）：
 *
 *   * `open` / `mismatch`：读到了可用回执；
 *   * `unknown`：**没有**可用回执（老数据、绑定由测试/运维直接插入）。调用方**不得**
 *     据此声称已打开，也**不**据此生成恢复命令 —— 真正权威的准入仍然是 driver 自己的
 *     `principals`/`live` 检查，BFF 在拿到 `session_not_open` / `identity_invalid`
 *     之后走**反应式**恢复（见 runtime-router 的 `deliver` / `events`）；
 *   * `unavailable`：**读取本身失败**（数据库不可用等）。这不是"没有回执"，调用方必须
 *     fail-closed —— 不投递、不订阅、不生成 resume，把请求当作暂时不可用释放重试。
 *     绝不把读取失败伪装成 `unknown` 再继续放行。
 *
 * 幂等键（`commands.id` 是 **uuid**，不能拼字符串）：
 *
 *   `sha256("myrix:runtime:resume:<tid>:<sid>:<rev>:<bootId>:<attempt>")` 的 UUID 形态。
 *
 *   * 同一 boot、同一 rev、同一 attempt 的并发请求算出**同一个** uuid，
 *     `enqueue` 的 `on conflict do nothing` 把它们合并成一行；
 *   * 换 boot 一定算出**不同**的 uuid，绝不跨 boot 复用一枚已被消费的 commandId
 *     （复用会让 driver 的幂等回执把新 resume 当成旧的 duplicate，恢复永不发生）；
 *   * `attempt` 由**枚举**得到：先按确定性公式算出本 boot/rev 的全部候选 uuid
 *     （最多 `maxAttemptsPerBoot` 枚），再用一次 `id in (...)` 精确查询它们的使用状况，
 *     取第一个空闲的。**不按 created_at 全表拉历史**：那样历史超过上限后会把当前 boot
 *     已经用掉的 id 截掉，导致反复 enqueue 同一枚已 accepted 的 id 并永远 pending。
 *   * 每 boot 上限同时是候选枚举长度与硬校验：`maxAttemptsPerBoot` 必须落在
 *     `1..MAX_RESUME_ATTEMPTS_LIMIT`，非法值直接抛错，绝不静默裁剪。
 *
 * 恢复命令的正文与投递正文**同形**（`{op,sid,commandId}`，见 `wireBodyOf` 的 resume
 * 分支），所以 `commands.body_hash` 仍然就是实际发送字节的摘要；boot/attempt 只出现在
 * 确定性 uuid 与审计里，不额外扩 driver 的线契约。
 *
 * 安全边界（刻意不做的事）：
 *   * 不放宽 driver 授权、不隐式 create、不信任磁盘 header 身份；
 *   * 不绕过 BFF 直接向 driver 发 resume：恢复命令走**同一套** `commands.enqueue`
 *     （governance 的 `sessions:resume` + 成员/租户/rev 校验 + 审计）与普通投递循环；
 *   * 撤权、成员停用、rev 变化、非所有者一律拒绝恢复（enqueue 在它自己的事务里重取
 *     权威事实，调用方读到的旧事实不能替代它）。
 *
 * 写入边界：除同事务审计的已登记迁移例外外，使用 `@myrix/platform-store` 公开契约与 `runtime-log`，
 * 不新增表/迁移，也不改 driver 或授权实现。
 */
import { createHash } from "node:crypto";
import { CommandsRepository, PlatformStoreError, type PlatformStore } from "@myrix/platform-store";
import { insertAuditEvent } from "../../../packages/platform-store/src/repositories/audit";
import type { RuntimeLogger } from "./runtime-log";

/** 每个 boot、每个绑定 rev 最多生成多少次恢复命令；超过后不再新增。 */
export const MAX_RESUME_ATTEMPTS_PER_BOOT = 5;

/**
 * `maxAttemptsPerBoot` 的硬上限。
 *
 * 为什么必须显式设限而不是"直接用调用方给的值"：候选 attempt 是**枚举**出来的
 * （最多这么多枚确定性 uuid，一次性放进 `id in (...)` 精确查询）。没有上限就等于
 * 让一次配置失误把任意长的 IN 列表发进数据库。非法值一律在构造期抛错，绝不静默裁剪。
 */
export const MAX_RESUME_ATTEMPTS_LIMIT = 100;

/**
 * driver 明确表示"会话在当前进程里没有打开"的机器可读错误码。
 *
 * 只有这两个码可以触发**反应式**恢复：
 *   * `session_not_open`（409）：活跃 Agent 不在，且消息也还没落盘；
 *   * `identity_invalid`（403）：`principals` 里没有该会话的主体（重启后订阅就会命中）。
 *
 * 其余 403（`not_owner` / `identity_mismatch` / `rev_stale` / `session_revoked` /
 * `grant/*`）都是**身份或撤权**结论，绝不当作可恢复：把任意 403 当成可恢复
 * 等于"用一次 resume 去试探授权"，正是首版要避免的越权路径。
 */
export const RECOVERABLE_DRIVER_CODES: readonly string[] = Object.freeze(["session_not_open", "identity_invalid"]);

export function isRecoverableDriverCode(code: string | undefined): boolean {
  return code !== undefined && RECOVERABLE_DRIVER_CODES.includes(code);
}

/**
 * 恢复命令的确定性 UUID（RFC 4122 v5 形态）。
 *
 * 输入必须同时含 `bootId` 与 `attempt`：前者保证"换 boot 是新命令"，
 * 后者保证"同一 boot 下的第 N 次恢复也是新命令"。缺任何一个都会退化成
 * "跨 boot 复用一枚已 accepted 的 commandId"，恢复会静默失效。
 */
export function recoveryCommandId(input: {
  tenantId: string;
  sessionId: string;
  revision: number;
  bootId: string;
  attempt: number;
}): string {
  const digest = createHash("sha256")
    .update(
      `myrix:runtime:resume:${input.tenantId}:${input.sessionId}:${String(input.revision)}:${input.bootId}:${String(input.attempt)}`,
    )
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** resume 命令的入队正文；与 `wireBodyOf` 的 resume 分支**逐字节同形**。 */
export function resumeBodyOf(input: { sessionId: string; commandId: string }): Record<string, unknown> {
  return { op: "resume", sid: input.sessionId, commandId: input.commandId };
}

/**
 * `open-proof` 的结论。
 *
 * `state` 是唯一的判据：
 *   * `open`：读到成功回执，且它的 bootId 就是当前 boot；
 *   * `mismatch`：读到成功回执，但 bootId 不是当前 boot（正向的"需要重开"证据）；
 *   * `unknown`：没有可用回执 —— 不能据此声称打开，也不能据此触发恢复；
 *   * `unavailable`：读取失败 —— fail-closed，调用方必须阻止投递/订阅并重试。
 *
 * 刻意**不**再暴露 `known`/`open` 这种二值投影：`known=false` 同时覆盖 `unknown`
 * 与 `unavailable` 两种后果完全不同的情形，正是旧实现在读取失败时静默放行的根因。
 */
export interface SessionOpenProof {
  state: SessionOpenState;
  /** 回执里的 bootId（仅 `open`/`mismatch` 有值；诊断用）。 */
  bootId?: string;
  /** 产生该回执的命令 id（诊断用）。 */
  commandId?: string;
}

export type SessionOpenState = "open" | "mismatch" | "unknown" | "unavailable";

export type ResumeRequestStatus = "enqueued" | "pending" | "exhausted" | "denied" | "unavailable";

export interface ResumeRequestOutcome {
  status: ResumeRequestStatus;
  /** 已存在或新入队的 resume commandId。 */
  commandId?: string;
  /** 本次恢复所用的尝试序号（0 起）。 */
  attempt?: number;
  /** 可读结论，进日志/审计。 */
  reason: string;
}

export interface RuntimeSessionRecoveryOptions {
  store: PlatformStore;
  logger?: RuntimeLogger;
  /** 每 boot 最多生成多少枚恢复命令；缺省 {@link MAX_RESUME_ATTEMPTS_PER_BOOT}。 */
  maxAttemptsPerBoot?: number;
}

interface ResumeRow {
  id: string;
  status: string;
}

/**
 * `readBinding` 的三态结果。
 *
 * 关键区分：`not-found`（库中确实没有该绑定）与 `unavailable`（**读取失败**）后果不同。
 * 前者是明确的 deny，后者必须 fail-closed 地变成"暂时不可用" —— 绝不把数据库故障
 * 伪装成"绑定不存在/被拒"，那会把一次短暂故障写成一条不可撤销的授权结论。
 */
type BindingLookup =
  | { kind: "found"; ownerUserId: string; status: string; revokedRevision: number }
  | { kind: "not-found" }
  | { kind: "unavailable" };

/**
 * 会话恢复的存储侧实现。
 *
 * 只做三件事：读 `open-proof`、按确定性 uuid 入队 resume、把恢复决策写进审计。
 * 所有准入判定都留给 `commands.enqueue`（governance）与 driver。
 */
export class RuntimeSessionRecovery {
  private readonly store: PlatformStore;
  private readonly logger: RuntimeLogger | undefined;
  private readonly maxAttemptsPerBoot: number;
  private readonly commands: CommandsRepository;

  constructor(options: RuntimeSessionRecoveryOptions) {
    this.store = options.store;
    this.logger = options.logger;
    this.maxAttemptsPerBoot = options.maxAttemptsPerBoot ?? MAX_RESUME_ATTEMPTS_PER_BOOT;
    // 非法上限**直接抛错**，绝不静默裁剪：候选 attempt 是枚举出来的，
    // 一个超大的值会把任意长的 IN 列表发进数据库；0/负数/小数更是没有意义。
    if (
      !Number.isSafeInteger(this.maxAttemptsPerBoot) ||
      this.maxAttemptsPerBoot <= 0 ||
      this.maxAttemptsPerBoot > MAX_RESUME_ATTEMPTS_LIMIT
    ) {
      throw new Error(
        `myrix-bff runtime: maxAttemptsPerBoot 必须是 1..${String(MAX_RESUME_ATTEMPTS_LIMIT)} 的整数，收到 ${String(options.maxAttemptsPerBoot)}`,
      );
    }
    this.commands = new CommandsRepository(this.store);
  }

  /**
   * 会话是否在当前 boot 里被证明打开。
   *
   * **读取失败返回 `state:"unavailable"`**（fail-closed）：调用方必须阻止投递/订阅并
   * 退避重试，而不是把"数据库暂时读不了"当成"没有回执"继续把请求交给 driver。
   * 缺少历史回执（老数据、绑定由测试/运维直接插入）才是 `state:"unknown"` —— 那种
   * 情况下 driver 的 `principals` / `live` 才是权威，BFF 不做推断。
   */
  async openProof(tenantId: string, sessionId: string, bootId: string): Promise<SessionOpenProof> {
    try {
      return await this.store.withTenant({ tenantId }, async (tx) => {
        const row = await tx.trx
          .selectFrom("commands")
          .select(["id", "receipt"])
          .where("binding_id", "=", sessionId)
          .where("op", "in", ["create", "resume"])
          .where("status", "=", "succeeded")
          .orderBy("settled_at", "desc")
          .orderBy("created_at", "desc")
          .limit(1)
          .executeTakeFirst();
        if (!row) return { state: "unknown" as const };
        const receipt = row.receipt as Record<string, unknown> | null;
        const receiptBoot = receipt === null ? undefined : receipt["bootId"];
        if (typeof receiptBoot !== "string" || receiptBoot.length === 0) {
          return { state: "unknown" as const };
        }
        const open = receiptBoot === bootId;
        return {
          state: open ? ("open" as const) : ("mismatch" as const),
          bootId: receiptBoot,
          commandId: row.id,
        };
      });
    } catch (error) {
      this.logger?.warn?.("myrix-bff runtime: 读取 open-proof 失败，按暂时不可用处理（fail-closed）", {
        sessionId,
        code: error instanceof PlatformStoreError ? error.code : "unknown",
      });
      return { state: "unavailable" };
    }
  }

  /**
   * 请求一次恢复（幂等、有界）。
   *
   * 顺序：
   *   1. 读当前 binding（owner / status / rev）——必须存在于本租户上下文；
   *      读取失败 ⇒ `unavailable`（fail-closed），绝不伪装成 `denied`；
   *   2. 已有 `queued|inflight` 的 resume ⇒ 直接复用（多请求/多副本合并）；
   *   3. 枚举本 boot/rev 的全部确定性候选 id，用一次精确 `id in (...)` 查询使用状况，
   *      取第一个空闲 attempt；撞上 `maxAttemptsPerBoot` ⇒ `exhausted`，不再新增；
   *   4. 用确定性 uuid 入队；`commands.enqueue` 在它自己的事务里重取权威成员/作品/
   *      rev 并做 governance 判定，撤权/停用/非所有者一律失败（映射成 `denied`）；
   *   5. 写一条 `session.recovery_requested` 审计（含 bootId 与 attempt，便于对账）。
   */
  async requestResume(input: {
    tenantId: string;
    sessionId: string;
    bootId: string;
    reason: string;
    /** 触发本次恢复的 open-proof 结论（反应式恢复传 driver 码的说明）。仅进审计。 */
    openProof?: SessionOpenState | "driver-reported";
  }): Promise<ResumeRequestOutcome> {
    const binding = await this.readBinding(input.tenantId, input.sessionId);
    if (binding.kind === "unavailable") {
      this.logger?.warn?.("myrix-bff runtime: 读取绑定失败，恢复按暂时不可用处理", { sessionId: input.sessionId });
      return { status: "unavailable", reason: "binding-read-failed: 读取会话绑定失败，暂时无法判断是否可恢复" };
    }
    if (binding.kind === "not-found") return { status: "denied", reason: "binding-not-found: 会话绑定不存在" };
    if (binding.status === "revoked") {
      await this.audit(input, {
        effect: "deny",
        status: "denied",
        reason: "binding-revoked: 会话已撤权，拒绝恢复",
      });
      return { status: "denied", reason: "binding-revoked: 会话已撤权，拒绝恢复" };
    }
    if (binding.status !== "active") {
      return { status: "denied", reason: `binding-not-active: 绑定状态为 ${binding.status}，不接受恢复` };
    }
    // 归档**不**参与恢复判定：归档只整理历史，不停止任务、不撤权。为订阅事件流或
    // 投递已入队命令而需要的 resume 必须照常进行，否则"归档后还能看完整历史"无法成立。

    const existing = await this.listResumes(input.tenantId, input.sessionId, binding.revokedRevision, input.bootId).catch(
      (error: unknown) => {
        // 恢复读取故障（例如候选查询时数据库不可用）：必须是 `unavailable`，
        // **不是** `unknown`（没有回执）或 `denied`（明确的授权结论）。
        // 只记机器可读 code，绝不回显 SQL/绑定细节等私密原因。
        this.logger?.warn?.("myrix-bff runtime: 读取恢复使用状况失败，按暂时不可用处理", {
          sessionId: input.sessionId,
          code: error instanceof PlatformStoreError ? error.code : "unknown",
        });
        return null;
      },
    );
    if (existing === null) {
      return { status: "unavailable", reason: "resume-read-failed: 读取恢复使用状况失败，暂时无法判断是否可恢复" };
    }
    if (existing.pending !== undefined) {
      return { status: "pending", commandId: existing.pending.id, reason: "已有一条待投递的 resume，合并为同一次恢复" };
    }

    const attempt = this.firstFreeAttempt(existing.used, {
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      revision: binding.revokedRevision,
      bootId: input.bootId,
    });
    if (attempt >= this.maxAttemptsPerBoot) {
      await this.audit(input, {
        effect: "deny",
        attempt,
        status: "exhausted",
        reason: `recovery-attempts-exhausted: boot ${input.bootId} 已生成 ${String(attempt)} 枚 resume（上限 ${String(this.maxAttemptsPerBoot)}），不再新增`,
      });
      return {
        status: "exhausted",
        attempt,
        reason: `本 boot 的恢复尝试已达上限（${String(this.maxAttemptsPerBoot)}）`,
      };
    }

    const commandId = recoveryCommandId({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      revision: binding.revokedRevision,
      bootId: input.bootId,
      attempt,
    });
    try {
      const result = await this.commands.enqueue(input.tenantId, binding.ownerUserId, {
        commandId,
        bindingId: input.sessionId,
        op: "resume",
        body: resumeBodyOf({ sessionId: input.sessionId, commandId }),
        expectedRevision: binding.revokedRevision,
      });
      const status: ResumeRequestStatus = result.created ? "enqueued" : "pending";
      await this.audit(input, {
        effect: "allow",
        commandId: result.command.id,
        attempt,
        status,
        reason: `${input.reason}；未证明在当前 boot 打开，已按 ${status} 生成 resume（boot=${input.bootId} attempt=${String(attempt)}）`,
      });
      this.logger?.info?.("myrix-bff runtime: 已生成会话恢复命令", {
        sessionId: input.sessionId,
        commandId: result.command.id,
        bootId: input.bootId,
        attempt,
        status,
      });
      return { status, commandId: result.command.id, attempt, reason: `resume ${status}` };
    } catch (error) {
      const code = error instanceof PlatformStoreError ? error.code : "unknown";
      const denied =
        error instanceof PlatformStoreError &&
        (code === "forbidden" || code === "revoked" || code === "version_conflict" || code === "not_found");
      await this.audit(input, {
        effect: "deny",
        commandId,
        attempt,
        status: denied ? "denied" : "unavailable",
        reason: `resume 入队被拒（${code}）：${error instanceof PlatformStoreError ? error.reason.slice(0, 200) : "unknown"}`,
      });
      this.logger?.warn?.("myrix-bff runtime: resume 入队失败", { sessionId: input.sessionId, code });
      return { status: denied ? "denied" : "unavailable", commandId, attempt, reason: `resume 入队失败（${code}）` };
    }
  }

  /**
   * 从候选里取第一个"本 boot/rev 尚未用过"的 attempt。
   *
   * `used` 只可能包含候选 id 里的元素（由 `listResumes` 的精确查询保证），因此这里的
   * `has` 判定是精确的、不依赖任何历史行数上限。
   */
  private firstFreeAttempt(
    used: ReadonlySet<string>,
    seed: { tenantId: string; sessionId: string; revision: number; bootId: string },
  ): number {
    for (let attempt = 0; attempt < this.maxAttemptsPerBoot; attempt += 1) {
      if (!used.has(recoveryCommandId({ ...seed, attempt }))) return attempt;
    }
    return this.maxAttemptsPerBoot;
  }

  private async readBinding(tenantId: string, sessionId: string): Promise<BindingLookup> {
    try {
      return await this.store.withTenant({ tenantId }, async (tx) => {
        const row = await tx.trx
          .selectFrom("session_bindings")
          .select(["owner_user_id", "status", "revoked_revision"])
          .where("id", "=", sessionId)
          .executeTakeFirst();
        return row === undefined
          ? { kind: "not-found" as const }
          : {
              kind: "found" as const,
              ownerUserId: row.owner_user_id,
              status: row.status,
              revokedRevision: row.revoked_revision,
            };
      });
    } catch (error) {
      this.logger?.warn?.("myrix-bff runtime: 读取绑定失败，恢复按暂时不可用处理", {
        sessionId,
        code: error instanceof PlatformStoreError ? error.code : "unknown",
      });
      return { kind: "unavailable" };
    }
  }

  /**
   * 恢复相关的使用状况查询：**一次 SQL、同一快照**，有界但绝不截掉有关记录。
   *
   * 为什么必须是**单条** SQL（修复的真实并发缺陷）：
   *
   *   `PlatformStore.withTenant` 用的是 READ COMMITTED。旧实现把"待投递 resume"
   *   与"本 boot 候选使用状况"拆成两条独立 SELECT，同一事务里两条语句各自取
   *   **不同的快照**：第一条（pending）执行时还看不到别的事务刚入队的 candidate0，
   *   第二条（used）执行时却已经看到了 —— 于是本请求既没合并到 pending，又把
   *   candidate0 当成"已用过"，错误地分配 candidate1。两个并发请求便各自生成
   *   一条不同的 resume（attempt0 / attempt1），本该合并的恢复变成两条。
   *
   * 现在两条判据在**同一条** SELECT 里求值，因此看到的是同一个 MVCC 快照：
   * 要么看见 candidate0（待投递 → 合并），要么看不见（当时确实没有 → 分配 attempt0
   * 并靠 `enqueue` 的 `on conflict do nothing` 与并发写者幂等合并）。绝不出现
   * "pending 看不见、used 看见了"的撕裂快照。
   *
   * 查询形状与界：
   *
   *   `id in (本 boot/rev 的全部确定性候选 uuid，最多 maxAttemptsPerBoot 枚)`
   *   `OR status in (queued, inflight)`，按 `created_at,id` 排序，`limit maxAttemptsPerBoot+1`。
   *
   * 有界且不漏的证明：
   *
   *   * 候选行数 C ≤ `maxAttemptsPerBoot = M`（候选是枚举出来的 M 枚 uuid）；
   *   * 若匹配行总数 ≤ M+1：没有截断，全部返回 → `used` 完整，pending 若存在也必然可见；
   *   * 若匹配行总数 > M+1：返回按顺序的前 M+1 行。窗口内候选行至多 C ≤ M 行，
   *     因此窗口里**至少有一行非候选**；而查询只匹配"候选 或 queued/inflight"，
   *     所以那一行必是 pending —— 直接合并即可，`used` 是否被截断不影响结论。
   *   * 无 pending 时匹配行恰好只有候选行（≤ M < M+1），因此不可能截断，
   *     `used` 一定完整，绝不会漏掉当前 boot 已用掉的 attempt。
   *
   * 刻意**不**按 `created_at asc LIMIT 200` 拉历史：顺序截断在历史超过上限后会把
   * 当前 boot 刚用掉的 id 截掉（旧 id 排前面先被返回），于是 `attempt` 永远算出 0、
   * 反复 enqueue 同一枚已被 driver `accepted` 的 commandId —— 幂等命中让状态停在
   * pending，恢复永远不发生。也刻意不把整个历史拉回内存比对。
   */
  private async listResumes(
    tenantId: string,
    sessionId: string,
    revision: number,
    bootId: string,
  ): Promise<{ pending: ResumeRow | undefined; used: ReadonlySet<string> }> {
    const candidates = Array.from({ length: this.maxAttemptsPerBoot }, (_unused, attempt) =>
      recoveryCommandId({ tenantId, sessionId, revision, bootId, attempt }),
    );
    return this.store.withTenant({ tenantId }, async (tx) => {
      // 两条判据必须在同一条语句里：任何拆分都会让它们落在不同快照上（见上方注释）。
      const rows = await tx.trx
        .selectFrom("commands")
        .select(["id", "status"])
        .where("binding_id", "=", sessionId)
        .where("op", "=", "resume")
        .where((eb) => eb.or([eb("id", "in", candidates), eb("status", "in", ["queued", "inflight"])]))
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .limit(this.maxAttemptsPerBoot + 1)
        .execute();
      const candidateIds = new Set(candidates);
      const used = new Set<string>();
      let pending: ResumeRow | undefined;
      for (const row of rows) {
        // `used` 只收候选 id（由 `id in (...)` 保证）；pending 取顺序上第一条 queued/inflight。
        if (candidateIds.has(row.id)) used.add(row.id);
        if (pending === undefined && (row.status === "queued" || row.status === "inflight")) {
          pending = { id: row.id, status: row.status };
        }
      }
      return { pending, used };
    });
  }

  private async audit(
    input: { tenantId: string; sessionId: string; bootId: string; reason: string; openProof?: SessionOpenState | "driver-reported" },
    decision: { effect: "allow" | "deny"; commandId?: string; attempt?: number; status: ResumeRequestStatus; reason: string },
  ): Promise<void> {
    try {
      await this.store.withTenant({ tenantId: input.tenantId }, async (tx) => {
        const binding = await tx.trx
          .selectFrom("session_bindings")
          .select(["owner_user_id", "work_id"])
          .where("id", "=", input.sessionId)
          .executeTakeFirst();
        await insertAuditEvent(tx, {
          actorUserId: binding?.owner_user_id ?? null,
          actorKind: "service",
          category: "data-write",
          action: "session.recovery_requested",
          resource:
            decision.commandId === undefined ? `session_binding:${input.sessionId}` : `command:${decision.commandId}`,
          effect: decision.effect,
          reason: decision.reason.slice(0, 2000),
          sessionId: input.sessionId,
          detail: {
            bootId: input.bootId,
            attempt: decision.attempt ?? null,
            resumeStatus: decision.status,
            openProof: input.openProof ?? "mismatch-or-unknown",
          },
          ...(binding?.work_id === undefined ? {} : { workId: binding.work_id }),
        });
      });
    } catch (error) {
      // 审计失败不能把"已入队的恢复"升级成失败；但也绝不能静默：这里只记服务端日志。
      this.logger?.warn?.("myrix-bff runtime: 写恢复审计失败", {
        sessionId: input.sessionId,
        code: error instanceof PlatformStoreError ? error.code : "unknown",
      });
    }
  }
}
