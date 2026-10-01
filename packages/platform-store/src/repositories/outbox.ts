import { randomId, sha256Hex } from "../util";
import type { PlatformStore, StoreTx } from "../store";
import { errors } from "../errors";
import type { OutboxStatus } from "../domain";
import { insertAuditEvent } from "./audit";

/**
 * 事务性 outbox：业务事实与"要通知外部世界"的记录在同一个事务里落库。
 *
 * 为什么不是"事务提交后发 HTTP"：进程在提交与发送之间崩溃，事件会永久丢失，
 * cell 永远不知道该撤权。outbox 把"已提交"与"待投递"变成同一件事。
 *
 * 判定：全部是**系统操作**（投递循环 / 内部事务），需要 `outbox.*` 能力。
 * `insertOutboxMessage` 是事务内工具函数（供绑定/撤权路径复用），
 * 它不是对外入口，因此不单独做能力检查。
 */

export interface OutboxRecord {
  id: string;
  tenantId: string;
  topic: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  lockedBy: string | null;
  leaseExpiresAt: string | null;
  deliveredAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface EnqueueOutboxInput {
  topic: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
}

/** 在已有事务里入队；dedupe_key 冲突视为"同一事实已入队"，静默返回 false */
export async function insertOutboxMessage(tx: StoreTx, input: EnqueueOutboxInput): Promise<boolean> {
  const row = await tx.trx
    .insertInto("outbox_messages")
    .values({
      tenant_id: tx.tenantId,
      id: randomId(),
      topic: input.topic,
      dedupe_key: input.dedupeKey,
      payload: input.payload,
    })
    .onConflict((oc) => oc.columns(["tenant_id", "dedupe_key"]).doNothing())
    .returning(["id"])
    .executeTakeFirst();
  return row !== undefined;
}

export interface ClaimOutboxInput {
  /** 投递者标识（进程名 + 随机后缀），写进 locked_by 便于排查 */
  workerId: string;
  limit?: number;
  /** 租约时长；过期后可被其他投递者回收（投递失败或进程崩溃） */
  leaseMs?: number;
  topics?: readonly string[];
}

export interface OutboxClaim {
  record: OutboxRecord;
  /** 租约到期时间；投递成功后调用 settle 或 fail */
  leaseExpiresAt: string;
}

export class OutboxRepository {
  constructor(private readonly store: PlatformStore) {}

  /** 入队（独立事务版本）。系统操作：需要 `outbox.enqueue`。 */
  async enqueue(tenantId: string, input: EnqueueOutboxInput): Promise<boolean> {
    this.store.requireService("outbox.enqueue", "outbox.enqueue");
    return this.store.withTenant({ tenantId }, async (tx) => insertOutboxMessage(tx, input));
  }

  /**
   * 领取一批待投递消息。系统操作：需要 `outbox.claim`。
   *
   * `FOR UPDATE SKIP LOCKED` 保证多个投递者不会拿到同一行；顺手回收
   * "租约已过期"的 inflight 行（投递者崩溃的情况），保证不丢消息。
   */
  async claim(tenantId: string, input: ClaimOutboxInput): Promise<OutboxClaim[]> {
    this.store.requireService("outbox.claim", "outbox.claim");
    const limit = clampLimit(input.limit ?? 20);
    const leaseMs = input.leaseMs ?? 60_000;

    return this.store.withTenant({ tenantId }, async (tx) => {
      // 先回收过期租约，让它们重新可领取
      await tx.trx
        .updateTable("outbox_messages")
        .set({ status: "pending", locked_at: null, locked_by: null, lease_expires_at: null })
        .where("status", "=", "inflight")
        .where("lease_expires_at", "<", new Date())
        .execute();

      let query = tx.trx
        .selectFrom("outbox_messages")
        .selectAll()
        .where("status", "=", "pending")
        .where("available_at", "<=", new Date())
        .orderBy("available_at", "asc")
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .limit(limit)
        .forUpdate()
        .skipLocked();

      if (input.topics && input.topics.length > 0) {
        query = query.where("topic", "in", [...input.topics]);
      }

      const rows = await query.execute();
      if (rows.length === 0) return [];

      const leaseExpiresAt = new Date(this.store.now().getTime() + leaseMs);
      const ids = rows.map((row) => row.id);
      const updated = await tx.trx
        .updateTable("outbox_messages")
        .set({
          status: "inflight",
          locked_at: new Date(),
          locked_by: input.workerId,
          lease_expires_at: leaseExpiresAt,
        })
        .where("id", "in", ids)
        .returningAll()
        .execute();

      return updated.map((row) => ({
        record: toOutboxRecord(row),
        leaseExpiresAt: leaseExpiresAt.toISOString(),
      }));
    });
  }

  /** 投递成功。系统操作：需要 `outbox.settle`。 */
  async settle(tenantId: string, messageId: string, workerId: string): Promise<void> {
    this.store.requireService("outbox.settle", "outbox.settle");
    await this.store.withTenant({ tenantId }, async (tx) => {
      const row = await tx.trx
        .updateTable("outbox_messages")
        .set({
          status: "delivered",
          delivered_at: new Date(),
          locked_at: null,
          locked_by: null,
          lease_expires_at: null,
          last_error: null,
        })
        .where("id", "=", messageId)
        .where("locked_by", "=", workerId)
        .where("status", "=", "inflight")
        .returning(["id"])
        .executeTakeFirst();
      if (!row) {
        throw errors.conflict("outbox-not-owned: 该消息不由当前投递者持有或已结算");
      }
    });
  }

  /**
   * 投递失败：回到 pending 并指数退避；attempts 超过 max_attempts 才 dead。
   * 系统操作：需要 `outbox.settle`。
   */
  async fail(
    tenantId: string,
    messageId: string,
    workerId: string,
    error: string,
  ): Promise<{ retrying: boolean; attempts: number }> {
    this.store.requireService("outbox.settle", "outbox.fail");
    return this.store.withTenant({ tenantId }, async (tx) => {
      const current = await tx.trx
        .selectFrom("outbox_messages")
        .select(["attempts", "max_attempts"])
        .where("id", "=", messageId)
        .where("locked_by", "=", workerId)
        .where("status", "=", "inflight")
        .executeTakeFirst();
      if (!current) {
        throw errors.conflict("outbox-not-owned: 该消息不由当前投递者持有或已结算");
      }
      const attempts = current.attempts + 1;
      const exhausted = attempts >= current.max_attempts;
      const backoffMs = Math.min(2 ** attempts * 1000, 15 * 60 * 1000);

      await tx.trx
        .updateTable("outbox_messages")
        .set({
          status: exhausted ? "dead" : "pending",
          attempts,
          locked_at: null,
          locked_by: null,
          lease_expires_at: null,
          available_at: new Date(this.store.now().getTime() + backoffMs),
          last_error: error.slice(0, 2000),
        })
        .where("id", "=", messageId)
        .execute();
      return { retrying: !exhausted, attempts };
    });
  }

  /** 运维视图。系统操作：需要 `outbox.claim`。 */
  async listPending(tenantId: string, limit = 50): Promise<OutboxRecord[]> {
    this.store.requireService("outbox.claim", "outbox.listPending");
    return this.store.withTenant({ tenantId }, async (tx) => {
      const rows = await tx.trx
        .selectFrom("outbox_messages")
        .selectAll()
        .where("status", "in", ["pending", "inflight", "dead"])
        .orderBy("created_at", "asc")
        .limit(clampLimit(limit))
        .execute();
      return rows.map(toOutboxRecord);
    });
  }

  /** 运维：把 dead 消息重新激活（人工确认根因之后）。系统操作。 */
  async requeueDead(tenantId: string, messageId: string): Promise<void> {
    this.store.requireService("outbox.settle", "outbox.requeueDead");
    await this.store.withTenant({ tenantId }, async (tx) => {
      const row = await tx.trx
        .updateTable("outbox_messages")
        .set({ status: "pending", attempts: 0, available_at: new Date(this.store.now().getTime()), last_error: null })
        .where("id", "=", messageId)
        .where("status", "=", "dead")
        .returning(["id"])
        .executeTakeFirst();
      if (!row) throw errors.notFound("outbox-not-dead: 消息不存在或不是 dead 状态");
      await insertAuditEvent(tx, {
        actorUserId: null,
        actorKind: "service",
        category: "admin-change",
        action: "outbox.requeue",
        resource: `outbox:${messageId}`,
        effect: "allow",
        reason: "运维把 dead outbox 消息重新激活（系统操作 outbox.settle）",
      });
    });
  }
}

/** 用内容哈希做去重键，避免调用方拼错字符串导致重复投递 */
export function dedupeKeyFor(topic: string, businessKey: string, revision: number | string): string {
  return `${topic}:${businessKey}:${revision}`;
}

export function payloadDigest(payload: Record<string, unknown>): string {
  return sha256Hex(JSON.stringify(payload)).slice(0, 16);
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 20;
  return Math.max(1, Math.min(200, Math.floor(limit)));
}

function toOutboxRecord(row: {
  id: string;
  tenant_id: string;
  topic: string;
  dedupe_key: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  max_attempts: number;
  available_at: Date;
  locked_by: string | null;
  lease_expires_at: Date | null;
  delivered_at: Date | null;
  last_error: string | null;
  created_at: Date;
}): OutboxRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    topic: row.topic,
    dedupeKey: row.dedupe_key,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at.toISOString(),
    lockedBy: row.locked_by,
    leaseExpiresAt: row.lease_expires_at ? row.lease_expires_at.toISOString() : null,
    deliveredAt: row.delivered_at ? row.delivered_at.toISOString() : null,
    lastError: row.last_error,
    createdAt: row.created_at.toISOString(),
  };
}
