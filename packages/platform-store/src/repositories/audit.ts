import { randomId } from "../util";
import { sql } from "kysely";
import type { PlatformStore, StoreTx } from "../store";
import type { AuditCategory } from "../domain";
import { authorizeTx } from "./internal";

/**
 * 运营审计（第一版定位：谁、何时、哪个会话、做了什么；不是合规级不可抵赖审计）。
 *
 * 判定与写入路径分开：
 *   * `insertAuditEvent` / `insertDenyEvent` 是**事务内工具函数**：与业务事实同一个事务，
 *     要么都成功要么都不存在。它们不是对外入口，不单独做能力检查
 *     （调用它们的前提是已经通过了各自路径的判定）。
 *   * `AuditRepository.write` 是独立事务的系统写入，需要 `audit.write` 能力。
 *   * `AuditRepository.list` 是成员请求，走 governance 的 `audit:list`（admin / auditor）。
 *
 * 只追加：SQL 触发器拒绝 UPDATE/DELETE，且应用角色没有 UPDATE 权限。
 *
 * **不泄漏**：审计的 `detail` 与 `reason` 都不允许携带作品正文/章节文本。
 * `sanitizeDetail` 会拒绝 `text`/`body`/`content`/`document` 这类内容字段，
 * 并对字符串做长度截断；HTTP 边界的错误也只带 `code + reason`（见 errors.ts）。
 */

export interface AuditEventInput {
  /** 人类发起人的 userId；服务/运维事件没有具体人时传 null */
  actorUserId: string | null;
  actorKind: "user" | "service" | "agent";
  category: AuditCategory;
  action: string;
  resource: string;
  effect: "allow" | "deny";
  reason: string;
  sessionId?: string | null;
  workId?: string | null;
  matchedRules?: string[];
  obligations?: unknown[];
  detail?: Record<string, unknown>;
  traceId?: string | null;
  /** 事件发生时间；省略则用数据库 now() */
  occurredAt?: Date;
}

export interface AuditEventRecord {
  id: string;
  seq: string;
  occurredAt: string;
  recordedAt: string;
  actorUserId: string | null;
  actorKind: "user" | "service" | "agent";
  sessionId: string | null;
  workId: string | null;
  category: AuditCategory;
  action: string;
  resource: string;
  effect: "allow" | "deny";
  reason: string;
  matchedRules: string[];
  obligations: unknown[];
  detail: Record<string, unknown>;
  traceId: string | null;
}

/** 绝不允许进入审计的内容字段名：这里只记"发生了什么"，不记创作正文 */
const FORBIDDEN_DETAIL_KEYS: ReadonlySet<string> = new Set([
  "text",
  "body",
  "content",
  "document",
  "chaptertext",
  "chapter_text",
  "prompt",
  "completion",
]);

const MAX_DETAIL_STRING = 500;
const MAX_DETAIL_KEYS = 50;

/**
 * 把 detail 收窄成"只能放元数据"的形状：
 *   * 拒绝内容字段（正文/文档/提示词）；
 *   * 字符串截断到 500 字符；
 *   * 只保留一层（嵌套对象转成 JSON 字符串并截断），避免把整棵内容树带进来。
 */
export function sanitizeDetail(detail: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!detail) return {};
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail).slice(0, MAX_DETAIL_KEYS)) {
    if (FORBIDDEN_DETAIL_KEYS.has(key.toLowerCase())) continue;
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      output[key] = value;
      continue;
    }
    if (typeof value === "string") {
      output[key] = value.length > MAX_DETAIL_STRING ? `${value.slice(0, MAX_DETAIL_STRING)}…` : value;
      continue;
    }
    if (Array.isArray(value) && value.every((item) => typeof item === "string" || typeof item === "number")) {
      output[key] = value.slice(0, 20);
      continue;
    }
    if (typeof value === "object") {
      const json = JSON.stringify(value) ?? "";
      output[key] = json.length > MAX_DETAIL_STRING ? `${json.slice(0, MAX_DETAIL_STRING)}…` : json;
      continue;
    }
    // 其余类型（函数/Symbol 等）直接丢弃
  }
  return output;
}

/** 在已有事务里写审计（业务写路径专用，保证原子） */
export async function insertAuditEvent(tx: StoreTx, input: AuditEventInput): Promise<string> {
  if (input.reason.trim().length === 0) {
    // 没有原因字符串的审计等于没有审计；宁可让业务事务失败
    throw new Error("myrix: 审计事件必须带非空 reason");
  }
  const id = randomId();
  await tx.trx
    .insertInto("audit_events")
    .values({
      tenant_id: tx.tenantId,
      id,
      ...(input.occurredAt ? { occurred_at: input.occurredAt } : {}),
      actor_user_id: input.actorUserId,
      actor_kind: input.actorKind,
      session_id: input.sessionId ?? null,
      work_id: input.workId ?? null,
      category: input.category,
      action: input.action,
      resource: input.resource,
      effect: input.effect,
      reason: input.reason.slice(0, 2000),
      matched_rules: input.matchedRules ?? [],
      // jsonb 数组必须显式序列化：pg 驱动会把 JS 数组转成 Postgres 数组字面量
      // （`{}` 对 jsonb 来说是一个**对象**，会撞 audit_obligations_array 约束）。
      obligations: sql`${JSON.stringify(input.obligations ?? [])}::jsonb`,
      detail: sanitizeDetail(input.detail),
      trace_id: input.traceId ?? null,
    })
    .execute();
  return id;
}

/** 记录一次拒绝（deny 也要留痕，否则"为什么被拒"无从追溯） */
export async function insertDenyEvent(
  tx: StoreTx,
  input: Omit<AuditEventInput, "effect" | "category"> & { category?: AuditCategory },
): Promise<string> {
  return insertAuditEvent(tx, { ...input, effect: "deny", category: input.category ?? "policy-decision" });
}

export interface ListAuditInput {
  limit?: number;
  sinceSeq?: string;
  sessionId?: string;
  actorUserId?: string;
  category?: AuditCategory;
}

export class AuditRepository {
  constructor(private readonly store: PlatformStore) {}

  /**
   * 独立事务写审计。系统操作：需要 `audit.write`。
   * 业务事务内的审计请用 `insertAuditEvent`，不要走这里。
   */
  async write(tenantId: string, input: AuditEventInput): Promise<string> {
    this.store.requireService("audit.write", "audit.write");
    return this.store.withTenant({ tenantId }, async (tx) => insertAuditEvent(tx, input));
  }

  /**
   * 查询审计。成员请求：governance 的 `audit:list` 只对 admin / auditor 放行；
   * 普通成员与未知身份一律拒绝（默认 deny）。
   */
  async list(tenantId: string, actorUserId: string, input: ListAuditInput = {}): Promise<AuditEventRecord[]> {
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 100)));
    return this.store.withTenant({ tenantId, actorUserId }, async (tx) => {
      await authorizeTx(this.store, tx, {
        actorUserId,
        action: "audit:list",
        resource: { kind: "audit", tenantId },
      });
      let query = tx.trx.selectFrom("audit_events").selectAll();
      if (input.sessionId) query = query.where("session_id", "=", input.sessionId);
      if (input.actorUserId) query = query.where("actor_user_id", "=", input.actorUserId);
      if (input.category) query = query.where("category", "=", input.category);
      if (input.sinceSeq) query = query.where("seq", ">", input.sinceSeq);
      const rows = await query.orderBy("seq", "desc").limit(limit).execute();
      return rows.map((row) => ({
        id: row.id,
        seq: String(row.seq),
        occurredAt: row.occurred_at.toISOString(),
        recordedAt: row.recorded_at.toISOString(),
        actorUserId: row.actor_user_id,
        actorKind: row.actor_kind,
        sessionId: row.session_id,
        workId: row.work_id,
        category: row.category,
        action: row.action,
        resource: row.resource,
        effect: row.effect,
        reason: row.reason,
        matchedRules: row.matched_rules,
        obligations: row.obligations as unknown[],
        detail: row.detail as Record<string, unknown>,
        traceId: row.trace_id,
      }));
    });
  }
}
