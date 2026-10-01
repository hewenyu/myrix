import { randomId, sha256Hex } from "../util";
import { sql } from "kysely";
import { errors } from "../errors";
import type { PlatformStore, StoreTx } from "../store";
import type { PlatformAction } from "../authz";
import { sessionStatusForGovernance, type CommandOp, type CommandStatus } from "../domain";
import { authorizeTx } from "./internal";
import { insertAuditEvent, insertDenyEvent } from "./audit";

/**
 * Postgres 持久命令队列。
 *
 * 判定路径（严格区分，绝不把系统操作当成成员 allow）：
 *   * `enqueue` 由服务端可信生产者调用（需要 `command.enqueue` 能力），
 *     并且**仍然**走 governance 的会话动作判定（send/resume/cancel/subscribe 都是
 *     所有者动作，必须带当前状态 + 当前 rev + 调用方 expectedRev）；
 *   * `claim` / `claimAny` / `settle` / `release` / `requeueDead` 是投递循环的系统操作，
 *     需要 `command.claim` / `command.settle` 能力，**不**经过成员判定表；
 *   * `getCommand` / `listCommands` 在能力之外**强制按 actor 过滤**，
 *     读别人的命令一律 not_found。
 *
 * 设计要点（tech-design-v1 §4.7 与 first-version.md 验收项）：
 *
 *   1. 唯一键：主键 (tenant_id, id=commandId)。同一 commandId 重复入队不产生第二行；
 *      **正文哈希不同则整体拒绝**（duplicate_request）。
 *
 *   2. 每会话 FIFO：claim(sessionId) 只取该绑定下**最早的一条** queued 命令。
 *      前一条没 settle 完，后一条不会被取走 —— 串行投递天然保序。
 *
 *   3. 唯一投递者：`myrix_try_lock_session(bindingId)`（事务级 advisory lock，非阻塞）。
 *
 *   4. 超时不丢命令：投递失败只调 `release`（attempts+1、指数退避、回到 queued）。
 *      行永远留在表里，直到被 settle 成 succeeded/failed，或 attempts 耗尽进入 dead。
 *
 *   5. 跨会话并发：claimAny 用 `FOR UPDATE SKIP LOCKED` 批量取不同会话的命令。
 */

export interface CommandRecord {
  tenantId: string;
  id: string;
  bindingId: string;
  workId: string;
  actorUserId: string;
  op: CommandOp;
  bodyHash: string;
  body: Record<string, unknown>;
  grantRevision: number;
  status: CommandStatus;
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  lockedBy: string | null;
  leaseExpiresAt: string | null;
  settledAt: string | null;
  receipt: Record<string, unknown> | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueCommandInput {
  /** 客户端提供的幂等键；BFF 透传，浏览器不能借此指定 actor */
  commandId: string;
  bindingId: string;
  op: CommandOp;
  /** 请求体原文；服务端自己算哈希，不信任客户端传来的哈希 */
  body: Record<string, unknown>;
  /** 可选：客户端声明的哈希，仅用于"同一 commandId 换了正文"的快速检测 */
  declaredBodyHash?: string;
  /** 调用方（BFF）从会话读取的当前 rev；必须与库中一致 */
  expectedRevision: number;
  grantRevision?: number;
  maxAttempts?: number;
}

export interface EnqueueCommandResult {
  command: CommandRecord;
  /** true = 这次真的入队了；false = 幂等命中已有命令 */
  created: boolean;
}

export interface ClaimCommandsInput {
  workerId: string;
  limit?: number;
  leaseMs?: number;
  bindingId?: string;
  ops?: readonly CommandOp[];
}

export const COMMAND_OPS: readonly CommandOp[] = ["create", "resume", "send", "cancel", "subscribe"];

/**
 * 命令 op → governance 动作。所有 op 都是"已有会话上的动作"（除 create，
 * 它在 `SessionsRepository.create` 里以 `sessions:create` 判定），
 * 因此都需要 status + 当前 rev + expectedRevision。
 */
const OP_ACTION: Record<CommandOp, PlatformAction> = {
  create: "sessions:create",
  resume: "sessions:resume",
  send: "sessions:send",
  cancel: "sessions:cancel",
  subscribe: "sessions:subscribe",
};

export class CommandsRepository {
  constructor(private readonly store: PlatformStore) {}

  /**
   * 入队（独立事务版本）。必须带调用方持有的 expectedRevision。
   * 需要 `command.enqueue` 能力：这是服务端可信调用路径，浏览器不可直接调用。
   */
  async enqueue(
    tenantId: string,
    actorUserId: string,
    input: EnqueueCommandInput,
  ): Promise<EnqueueCommandResult> {
    this.store.requireService("command.enqueue", "commands.enqueue");
    return this.store.withTenant({ tenantId, actorUserId }, async (tx) =>
      enqueueCommandInTx(this.store, tx, actorUserId, input),
    );
  }
}

/**
 * 事务内入队。绑定与命令必须同事务时（`SessionsRepository.create`），
 * 调用方在 `withTenant` 回调里直接用这个函数。
 */
export async function enqueueCommandInTx(
  store: PlatformStore,
  tx: StoreTx,
  actorUserId: string,
  input: EnqueueCommandInput,
): Promise<EnqueueCommandResult> {
  if (!COMMAND_OPS.includes(input.op)) {
    throw errors.invalidInput(`op 必须是 ${COMMAND_OPS.join(" / ")} 之一，收到 ${String(input.op)}`);
  }
  if (!input.commandId) throw errors.invalidInput("commandId 不能为空");
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw errors.invalidInput(
      `expectedRevision（会话 rev）必须是 >= 0 的整数，收到 ${String(input.expectedRevision)}`,
    );
  }

  const bodyHash = declaredHashOf(input);
  const binding = await tx.trx
    .selectFrom("session_bindings")
    .select(["id", "owner_user_id", "work_id", "status", "revoked_revision"])
    .where("id", "=", input.bindingId)
    .executeTakeFirst();
  if (!binding) throw errors.notFound("binding-not-found: 会话绑定不存在");

  if (binding.status === "revoked") {
    await insertDenyEvent(tx, {
      actorUserId,
      actorKind: "user",
      action: OP_ACTION[input.op],
      resource: `session_binding:${binding.id}`,
      reason: "binding-revoked: 绑定已撤权，拒绝入队新命令",
      sessionId: binding.id,
      workId: binding.work_id,
    });
    throw errors.revoked("binding-revoked: 绑定已撤权，拒绝入队新命令");
  }

  // 只有所有者能向自己的会话发命令（单一所有者，D11）
  if (binding.owner_user_id !== actorUserId) {
    await insertDenyEvent(tx, {
      actorUserId,
      actorKind: "user",
      action: OP_ACTION[input.op],
      resource: `session_binding:${binding.id}`,
      reason: `not-owner: 命令发起者 ${actorUserId} 不是会话所有者 ${binding.owner_user_id}`,
      sessionId: binding.id,
      workId: binding.work_id,
    });
    throw errors.forbidden("not-owner: 只有会话所有者能向该会话发命令");
  }

  // 调用方持有的 rev 必须与库中一致：撤权与"刚提交的命令"之间的竞态在这里被挡住
  if (binding.revoked_revision !== input.expectedRevision) {
    await insertDenyEvent(tx, {
      actorUserId,
      actorKind: "user",
      action: OP_ACTION[input.op],
      resource: `session_binding:${binding.id}`,
      reason: `revision-mismatch: 调用方 expectedRev=${input.expectedRevision}，库中 rev=${binding.revoked_revision}`,
      sessionId: binding.id,
      workId: binding.work_id,
    });
    throw errors.versionConflict(
      `revision-mismatch: 会话 rev 已变化（期望 ${input.expectedRevision}，当前 ${binding.revoked_revision}），拒绝入队`,
      { currentVersion: binding.revoked_revision },
    );
  }

  const status = sessionStatusForGovernance(binding.status);
  if (status === null) {
    throw errors.forbidden(`unknown-session-status: 会话状态 ${binding.status} 不可用于判定，按拒绝处理`);
  }

  if (input.op === "create") {
    // `create` 命令只在"绑定刚创建"的窗口里合法：它的授权对象是**目标作品**，
    // 由 SessionsRepository.create 在同一事务里用 sessions:create 判定（作品所有者）。
    // 这里不再做第二次成员判定（governance 的 sessions:create 不接受 binding 上的 status），
    // 只做状态事实校验：只有 creating 的绑定能收到 create 命令。
    if (binding.status !== "creating") {
      throw errors.conflict(
        `create-command-invalid-state: 绑定状态为 ${binding.status}，只有 creating 状态可入队 create 命令`,
        { bindingId: binding.id, status: binding.status },
      );
    }
  } else {
    await authorizeTx(store, tx, {
      actorUserId,
      action: OP_ACTION[input.op],
      resource: {
        kind: "command",
        tenantId: tx.tenantId,
        ownerUserId: binding.owner_user_id,
        status,
        revision: binding.revoked_revision,
      },
      expectedRevision: input.expectedRevision,
    });
  }

  // 幂等：先查同 commandId
  const existing = await tx.trx
    .selectFrom("commands")
    .selectAll()
    .where("id", "=", input.commandId)
    .executeTakeFirst();
  if (existing) {
    if (existing.actor_user_id !== actorUserId) {
      throw errors.duplicateRequest(
        "command-owner-mismatch: 同一 commandId 已被其他调用者使用，拒绝复用",
        { commandId: input.commandId },
      );
    }
    if (existing.binding_id !== binding.id || existing.op !== input.op) {
      throw errors.duplicateRequest(
        "command-target-mismatch: 同一 commandId 已绑定其他会话或操作，拒绝复用",
        { commandId: input.commandId },
      );
    }
    if (existing.body_hash !== bodyHash) {
      await insertDenyEvent(tx, {
        actorUserId,
        actorKind: "user",
        action: OP_ACTION[input.op],
        resource: `command:${input.commandId}`,
        reason: `body-hash-mismatch: 同一 commandId 的正文哈希不一致（已有 ${existing.body_hash.slice(0, 12)}，本次 ${bodyHash.slice(0, 12)}）`,
        sessionId: existing.binding_id,
        workId: existing.work_id,
      });
      throw errors.duplicateRequest(
        "body-hash-mismatch: 同一 commandId 已存在且正文哈希不同，拒绝以该 commandId 提交其他内容",
        { commandId: input.commandId, status: existing.status },
      );
    }
    return { command: toCommandRecord(existing), created: false };
  }

  const row = await tx.trx
    .insertInto("commands")
    .values({
      tenant_id: tx.tenantId,
      id: input.commandId,
      binding_id: binding.id,
      work_id: binding.work_id,
      actor_user_id: actorUserId,
      op: input.op,
      body_hash: bodyHash,
      body: input.body,
      grant_revision: input.grantRevision ?? binding.revoked_revision,
      ...(input.maxAttempts ? { max_attempts: input.maxAttempts } : {}),
    })
    .onConflict((oc) => oc.columns(["tenant_id", "id"]).doNothing())
    .returningAll()
    .executeTakeFirst();

  if (!row) {
    // 并发插入撞了唯一键：重新读出来，仍按"已存在"处理
    const raced = await tx.trx
      .selectFrom("commands")
      .selectAll()
      .where("id", "=", input.commandId)
      .executeTakeFirstOrThrow();
    if (raced.actor_user_id !== actorUserId || raced.binding_id !== binding.id || raced.op !== input.op || raced.body_hash !== bodyHash) {
      throw errors.duplicateRequest("command-identity-mismatch: 并发写入的同一 commandId 主体、会话、操作或正文不同，拒绝复用");
    }
    return { command: toCommandRecord(raced), created: false };
  }

  await insertAuditEvent(tx, {
    actorUserId,
    actorKind: "user",
    category: "data-write",
    action: OP_ACTION[input.op],
    resource: `command:${row.id}`,
    effect: "allow",
    reason: `命令已持久入队：op=${row.op}，binding=${row.binding_id}（platform queued 仅表示 DB 持久入队）`,
    sessionId: row.binding_id,
    workId: row.work_id,
  });

  return { command: toCommandRecord(row), created: true };
}

/**
 * 按会话 FIFO 领取一条命令（投递循环）。系统操作：需要 `command.claim`。
 */
export async function claimSessionCommand(
  store: PlatformStore,
  tenantId: string,
  input: { bindingId: string; workerId: string; leaseMs?: number },
): Promise<{ command: CommandRecord | null; reason: "claimed" | "busy" | "empty" | "revoked" }> {
  store.requireService("command.claim", "commands.claimSession");
  const leaseMs = input.leaseMs ?? 60_000;

  return store.withTenant({ tenantId }, async (tx) => {
    // 先确认绑定状态：撤权的会话不允许再投递任何命令
    const binding = await tx.trx
      .selectFrom("session_bindings")
      .select(["id", "status"])
      .where("id", "=", input.bindingId)
      .executeTakeFirst();
    if (!binding) throw errors.notFound("binding-not-found: 会话绑定不存在");
    if (binding.status === "revoked") return { command: null, reason: "revoked" as const };

    // 同一会话同一时间只有一个投递者；拿不到就退出，不排队占连接
    const locked = await sql<{ locked: boolean }>`
      select myrix_try_lock_session(${input.bindingId}::uuid) as locked
    `.execute(tx.trx);
    if (locked.rows[0]?.locked !== true) {
      return { command: null, reason: "busy" as const };
    }

    // 回收"投递者崩溃"留下的过期在途命令，让它们重新可领取
    await tx.trx
      .updateTable("commands")
      .set({ status: "queued", locked_at: null, locked_by: null, lease_expires_at: null })
      .where("binding_id", "=", input.bindingId)
      .where("status", "=", "inflight")
      .where("lease_expires_at", "<", new Date())
      .execute();

    // FIFO 串行：该会话只要还有 inflight（含刚被回收的过期行之外的活跃行），
    // 就不能取下一条。没有这一条，同一会话能同时有多条在途命令，
    // "每会话 FIFO" 只是排序而不是保序。
    const inflight = await tx.trx
      .selectFrom("commands")
      .select(["id"])
      .where("binding_id", "=", input.bindingId)
      .where("status", "=", "inflight")
      .limit(1)
      .executeTakeFirst();
    if (inflight) return { command: null, reason: "empty" as const };

    // FIFO：只取该会话最早的一条 queued；前一条没 settle 就不会有第二条被取走
    const next = await tx.trx
      .selectFrom("commands")
      .select(["id"])
      .where("binding_id", "=", input.bindingId)
      .where("status", "=", "queued")
      .where("available_at", "<=", new Date())
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .limit(1)
      .executeTakeFirst();
    if (!next) return { command: null, reason: "empty" as const };

    const leaseExpiresAt = new Date(store.now().getTime() + leaseMs);
    const claimed = await tx.trx
      .updateTable("commands")
      .set({
        status: "inflight",
        attempts: sql<number>`attempts + 1`,
        locked_at: new Date(),
        locked_by: input.workerId,
        lease_expires_at: leaseExpiresAt,
      })
      .where("id", "=", next.id)
      .where("status", "=", "queued")
      .returningAll()
      .executeTakeFirst();
    if (!claimed) return { command: null, reason: "busy" as const };

    return { command: toCommandRecord(claimed), reason: "claimed" as const };
  });
}

/**
 * 跨会话批量领取：不同会话可以并行投递，所以用 SKIP LOCKED 一次取多条。
 * 系统操作：需要 `command.claim`。
 */
export async function claimAnyCommands(
  store: PlatformStore,
  tenantId: string,
  input: ClaimCommandsInput,
): Promise<CommandRecord[]> {
  store.requireService("command.claim", "commands.claimAny");
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 10)));
  const leaseMs = input.leaseMs ?? 60_000;

  return store.withTenant({ tenantId }, async (tx) => {
    await tx.trx
      .updateTable("commands")
      .set({ status: "queued", locked_at: null, locked_by: null, lease_expires_at: null })
      .where("status", "=", "inflight")
      .where("lease_expires_at", "<", new Date())
      .execute();

    const opFilter =
      input.ops && input.ops.length > 0 ? sql`and c.op = any(${sql.val([...input.ops])}::text[])` : sql``;
    const bindingFilter = input.bindingId ? sql`and c.binding_id = ${input.bindingId}::uuid` : sql``;
    const lockClause = input.bindingId ? sql`and myrix_try_lock_session(c.binding_id)` : sql``;

    const candidates = await sql<{ id: string }>`
      select c.id
      from commands c
      join session_bindings b on b.tenant_id = c.tenant_id and b.id = c.binding_id
      where c.status = 'queued'
        and c.available_at <= now()
        and b.status <> 'revoked'
        -- 每会话串行：该会话还有 inflight 行时，绝不取下一条（保序而不是排序）
        and not exists (
          select 1 from commands i
          where i.tenant_id = c.tenant_id and i.binding_id = c.binding_id and i.status = 'inflight'
        )
        ${bindingFilter}
        ${opFilter}
        ${lockClause}
      order by c.available_at asc, c.created_at asc, c.id asc
      limit ${sql.val(limit)}
      for update of c skip locked
    `.execute(tx.trx);

    const ids = candidates.rows.map((row) => row.id);
    if (ids.length === 0) return [];

    const leaseExpiresAt = new Date(store.now().getTime() + leaseMs);
    const rows = await tx.trx
      .updateTable("commands")
      .set({
        status: "inflight",
        attempts: sql<number>`attempts + 1`,
        locked_at: new Date(),
        locked_by: input.workerId,
        lease_expires_at: leaseExpiresAt,
      })
      .where("id", "in", ids)
      .returningAll()
      .execute();
    return rows.map(toCommandRecord);
  });
}

export interface SettleCommandInput {
  commandId: string;
  workerId: string;
  receipt: Record<string, unknown>;
  /** accepted / duplicate 都是成功；其他业务回执由调用方决定 */
  status?: "succeeded" | "failed";
}

/** 结算：succeeded 带 receipt；failed 表示 cell 明确拒绝（不是超时）。系统操作。 */
export async function settleCommand(
  store: PlatformStore,
  tenantId: string,
  input: SettleCommandInput,
): Promise<CommandRecord> {
  store.requireService("command.settle", "commands.settle");
  return store.withTenant({ tenantId }, async (tx) => {
    const status = input.status ?? "succeeded";
    const row = await tx.trx
      .updateTable("commands")
      .set({
        status,
        receipt: input.receipt,
        settled_at: new Date(),
        locked_at: null,
        locked_by: null,
        lease_expires_at: null,
        last_error: status === "failed" ? jsonError(input.receipt) : null,
      })
      .where("id", "=", input.commandId)
      .where("locked_by", "=", input.workerId)
      .where("status", "=", "inflight")
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      throw errors.conflict(
        "command-not-owned: 该命令不由当前 worker 持有（可能租约已过期被回收），请重新领取",
        { commandId: input.commandId },
      );
    }
    return toCommandRecord(row);
  });
}

/**
 * 投递失败/超时：**不结算**，只释放锁并退避重试。系统操作。
 */
export async function releaseCommand(
  store: PlatformStore,
  tenantId: string,
  input: { commandId: string; workerId: string; error: string },
): Promise<{ retrying: boolean; attempts: number }> {
  store.requireService("command.settle", "commands.release");
  return store.withTenant({ tenantId }, async (tx) => {
    const current = await tx.trx
      .selectFrom("commands")
      .select(["attempts", "max_attempts", "binding_id", "work_id", "actor_user_id"])
      .where("id", "=", input.commandId)
      .where("locked_by", "=", input.workerId)
      .where("status", "=", "inflight")
      .executeTakeFirst();
    if (!current) {
      throw errors.conflict("command-not-owned: 该命令不由当前 worker 持有", {
        commandId: input.commandId,
      });
    }

    const exhausted = current.attempts >= current.max_attempts;
    const backoffMs = Math.min(2 ** current.attempts * 500, 5 * 60 * 1000);

    await tx.trx
      .updateTable("commands")
      .set({
        status: exhausted ? "dead" : "queued",
        locked_at: null,
        locked_by: null,
        lease_expires_at: null,
        available_at: new Date(store.now().getTime() + backoffMs),
        last_error: input.error.slice(0, 2000),
        ...(exhausted ? { settled_at: new Date() } : {}),
      })
      .where("id", "=", input.commandId)
      .execute();

    await insertAuditEvent(tx, {
      // 审计的 actor 是命令发起人（不是投递者）：归因必须指向人，而不是服务进程
      actorUserId: current.actor_user_id,
      actorKind: "service",
      category: "data-write",
      action: "command.release",
      resource: `command:${input.commandId}`,
      effect: exhausted ? "deny" : "allow",
      reason: exhausted
        ? `重试次数耗尽（attempts=${current.attempts}/${current.max_attempts}），命令进入 dead，需人工 requeue：${input.error.slice(0, 200)}`
        : `投递失败，保持持久队列并退避重试（attempts=${current.attempts}/${current.max_attempts}）：${input.error.slice(0, 200)}`,
      sessionId: current.binding_id,
      workId: current.work_id,
    });

    return { retrying: !exhausted, attempts: current.attempts };
  });
}

/**
 * 读取回执（tech-design-v1 §3.2 GET /v1/commands/:id）。
 * 系统能力之外**强制 actor 过滤**：不是自己的命令一律 not_found。
 */
export async function getCommand(
  store: PlatformStore,
  tenantId: string,
  actorUserId: string,
  commandId: string,
): Promise<CommandRecord> {
  store.requireService("command.read", "commands.get");
  return store.withTenant({ tenantId, actorUserId }, async (tx) => {
    const row = await tx.trx
      .selectFrom("commands")
      .selectAll()
      .where("id", "=", commandId)
      .where("actor_user_id", "=", actorUserId)
      .executeTakeFirst();
    if (!row) throw errors.notFound("command-not-found: 命令不存在");
    return toCommandRecord(row);
  });
}

/** 按会话列出**本人**的命令（FIFO 顺序），用于对账与调试。 */
export async function listCommands(
  store: PlatformStore,
  tenantId: string,
  actorUserId: string,
  bindingId: string,
  limit = 100,
): Promise<CommandRecord[]> {
  store.requireService("command.read", "commands.list");
  const bounded = Math.max(1, Math.min(500, Math.floor(limit)));
  return store.withTenant({ tenantId, actorUserId }, async (tx) => {
    const rows = await tx.trx
      .selectFrom("commands")
      .selectAll()
      .where("binding_id", "=", bindingId)
      .where("actor_user_id", "=", actorUserId)
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .limit(bounded)
      .execute();
    return rows.map(toCommandRecord);
  });
}

/** 运维：把 dead 命令重新入队（人工确认后）。系统操作。 */
export async function requeueDeadCommand(
  store: PlatformStore,
  tenantId: string,
  commandId: string,
): Promise<CommandRecord> {
  store.requireService("command.settle", "commands.requeueDead");
  return store.withTenant({ tenantId }, async (tx) => {
    const row = await tx.trx
      .updateTable("commands")
      .set({
        status: "queued",
        attempts: 0,
        available_at: new Date(store.now().getTime()),
        settled_at: null,
        last_error: null,
        locked_at: null,
        locked_by: null,
        lease_expires_at: null,
      })
      .where("id", "=", commandId)
      .where("status", "=", "dead")
      .returningAll()
      .executeTakeFirst();
    if (!row) throw errors.notFound("command-not-dead: 命令不存在或不是 dead 状态");
    return toCommandRecord(row);
  });
}

/** 判定用的哈希：始终由服务端从 body 计算 */
export function computeBodyHash(body: Record<string, unknown>): string {
  return sha256Hex(JSON.stringify(body));
}

function declaredHashOf(input: EnqueueCommandInput): string {
  const computed = computeBodyHash(input.body);
  if (input.declaredBodyHash && input.declaredBodyHash !== computed) {
    throw errors.invalidInput(
      "body-hash-mismatch: 客户端声明的 bodyHash 与服务端计算结果不一致，拒绝入队",
      { declared: input.declaredBodyHash.slice(0, 12), computed: computed.slice(0, 12) },
    );
  }
  return computed;
}

function jsonError(receipt: Record<string, unknown>): string {
  const reason = receipt["reason"];
  return typeof reason === "string" ? reason.slice(0, 2000) : "命令被拒绝（无原因字符串）";
}

function toCommandRecord(row: {
  tenant_id: string;
  id: string;
  binding_id: string;
  work_id: string;
  actor_user_id: string;
  op: CommandOp;
  body_hash: string;
  body: Record<string, unknown>;
  grant_revision: number;
  status: CommandStatus;
  attempts: number;
  max_attempts: number;
  available_at: Date;
  locked_by: string | null;
  lease_expires_at: Date | null;
  settled_at: Date | null;
  receipt: Record<string, unknown> | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}): CommandRecord {
  return {
    tenantId: row.tenant_id,
    id: row.id,
    bindingId: row.binding_id,
    workId: row.work_id,
    actorUserId: row.actor_user_id,
    op: row.op,
    bodyHash: row.body_hash,
    body: row.body,
    grantRevision: row.grant_revision,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at.toISOString(),
    lockedBy: row.locked_by,
    leaseExpiresAt: row.lease_expires_at ? row.lease_expires_at.toISOString() : null,
    settledAt: row.settled_at ? row.settled_at.toISOString() : null,
    receipt: row.receipt,
    lastError: row.last_error,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export { randomId as newCommandId };
