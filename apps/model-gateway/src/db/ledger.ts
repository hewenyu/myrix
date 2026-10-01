/**
 * Postgres 账本（Kysely，schema `myrix_gateway`）。
 *
 * 并发与一致性：
 * * 预占在**一个事务**里：先 `pg_advisory_xact_lock` 三个（租户/用户/会话）键，
 *   再统计窗口内已占用（pending 记预占量、已结算记真实消费量），最后插入。
 *   同一租户/用户/会话的并发预占因此严格串行，不会超卖；
 *   事务提交即释放锁，不需要额外的清理任务。
 * * 结算用 `select ... for update` 锁住该 requestId 的行，保证"只结算一次"；
 *   已结算的行重复调用返回既有结果（幂等），不会二次扣减。
 *   真实 usage **完整**写入 `consumed_tokens`（可以大于 `reserved_tokens`：预占是闸门，
 *   不是计费上限）；超出预占的部分在后续 reserve 的窗口统计里生效 → 后续被 429。
 * * 每事务设置 `myrix_gateway.tenant_id`，FORCE RLS 因此对应用角色生效；
 *   即使 SQL 写错漏了 tenant_id，也读不到别的租户（fail-closed）。
 */
import { sql, type Kysely, type Transaction } from "kysely";
import { GatewayError, quotaExceeded } from "../errors";
import {
  DEFAULT_QUOTA_POLICY,
  type ConsumptionInput,
  type ConsumptionOutcome,
  type ConsumptionResult,
  type FenceResult,
  type LedgerPort,
  type QuotaPolicy,
  type ReserveInput,
  type ReservationReceipt,
} from "../ledger";
import type { GatewayDatabase } from "./schema";

export interface PostgresLedgerOptions {
  policy?: Partial<QuotaPolicy>;
  /** 预占事务里额外要做的事（例如写网关审计 outbox），与预占同事务 */
  afterReserve?: (tx: Transaction<GatewayDatabase>, input: ReserveInput) => Promise<void>;
}

interface WindowRow {
  tenant_tokens: number | string | null;
  user_tokens: number | string | null;
  session_tokens: number | string | null;
  tenant_pending: number | string | null;
  user_pending: number | string | null;
}

const toNumber = (value: number | string | null | undefined): number => {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

function fence(code: "tenant_quota" | "user_quota" | "concurrency" | "session_quota", reason: string): FenceResult {
  return { ok: false, code, reason };
}

/**
 * 结算金额：settled 按**真实 usage 完整计入**（可以超过预占：预占只是防超卖闸门，
 * 不是计费上限），unknown 保守等于预占，released 为 0。
 *
 * 为什么不再 `min(预占, 真实)`：截断会让超额用量白送，并让窗口统计偏低，
 * 使后续请求继续放行。现在超额部分计入 `consumed_tokens`，reserve 的窗口统计
 * （已结算按 consumed_tokens 计）因此在下一轮把用户/会话/租户挡在 429。
 */
export function settleAmounts(
  reservedTokens: number,
  input: Pick<ConsumptionInput, "consumption" | "totalTokens" | "promptTokens" | "completionTokens">,
): { consumption: ConsumptionOutcome; consumed: number; refunded: number } {
  if (input.consumption === "released") return { consumption: "released", consumed: 0, refunded: reservedTokens };
  if (input.consumption === "unknown") return { consumption: "unknown", consumed: reservedTokens, refunded: 0 };
  const { totalTokens, promptTokens, completionTokens } = input;
  if (totalTokens === undefined || promptTokens === undefined || completionTokens === undefined) {
    throw new GatewayError(500, "invalid_usage", "settled 结算必须给出真实 usage 三个字段", "upstream_error");
  }
  const consumed = Math.max(0, totalTokens);
  return { consumption: "settled", consumed, refunded: Math.max(0, reservedTokens - consumed) };
}

export function createPostgresLedger(db: Kysely<GatewayDatabase>, options: PostgresLedgerOptions = {}): LedgerPort {
  const policy: QuotaPolicy = { ...DEFAULT_QUOTA_POLICY, ...options.policy };

  /** 账本操作都在设置了租户上下文的独立事务里执行（RLS fail-closed）。 */
  async function withTenant<T>(tenantId: string, fn: (tx: Transaction<GatewayDatabase>) => Promise<T>): Promise<T> {
    if (typeof tenantId !== "string" || tenantId.length === 0) {
      throw new GatewayError(500, "missing_tenant_context", "账本操作缺少租户上下文", "upstream_error");
    }
    return db.transaction().execute(async (tx) => {
      await sql`select set_config('myrix_gateway.tenant_id', ${tenantId}, true)`.execute(tx);
      return fn(tx);
    });
  }

  async function tryReserve(input: ReserveInput): Promise<ReservationReceipt | FenceResult> {
    if (!Number.isSafeInteger(input.reservedTokens) || input.reservedTokens <= 0) {
      throw new GatewayError(500, "invalid_reservation", "预占 token 数必须是正整数", "upstream_error");
    }
    return withTenant(input.tenantId, async (tx) => {
      // 1) 事务级 advisory lock：同一租户/用户/会话的预占严格串行（并发控制）。
      await sql`select pg_advisory_xact_lock(hashtextextended(${`myrix:quota:tenant:${input.tenantId}`}, 0))`.execute(tx);
      await sql`select pg_advisory_xact_lock(hashtextextended(${`myrix:quota:user:${input.tenantId}:${input.userId}`}, 0))`.execute(tx);
      await sql`select pg_advisory_xact_lock(hashtextextended(${`myrix:quota:session:${input.tenantId}:${input.sessionId}`}, 0))`.execute(tx);

      // 2) 幂等：同一 requestId 已存在则直接返回既有预占（不重复扣减）。
      const existing = await tx
        .selectFrom("myrix_gateway.quota_reservations")
        .select(["request_id", "reserved_tokens", "created_at"])
        .where("request_id", "=", input.requestId)
        .executeTakeFirst();
      if (existing) {
        return {
          ok: true,
          requestId: existing.request_id,
          reservedTokens: existing.reserved_tokens,
          createdAtMs: existing.created_at.getTime(),
          replayed: true,
        };
      }

      // 3) 统计窗口内已占用量（pending 记预占、已结算记真实消费）。
      const row = await sql<WindowRow>`
        select
          coalesce(sum(case when created_at > now() - (${policy.tenantWindowMs} || ' milliseconds')::interval
            then case when outcome = 'pending' then reserved_tokens else consumed_tokens end else 0 end), 0) as tenant_tokens,
          coalesce(sum(case when user_id = ${input.userId}::uuid
              and created_at > now() - (${policy.userWindowMs} || ' milliseconds')::interval
            then case when outcome = 'pending' then reserved_tokens else consumed_tokens end else 0 end), 0) as user_tokens,
          coalesce(sum(case when session_id = ${input.sessionId}
              and created_at > now() - (${policy.sessionWindowMs} || ' milliseconds')::interval
            then case when outcome = 'pending' then reserved_tokens else consumed_tokens end else 0 end), 0) as session_tokens,
          coalesce(sum(case when outcome = 'pending' then 1 else 0 end), 0) as tenant_pending,
          coalesce(sum(case when outcome = 'pending' and user_id = ${input.userId}::uuid then 1 else 0 end), 0) as user_pending
        from myrix_gateway.quota_reservations
        where tenant_id = ${input.tenantId}::uuid
      `.execute(tx);

      const stats = row.rows[0];
      const tenantTokens = toNumber(stats?.tenant_tokens);
      const userTokens = toNumber(stats?.user_tokens);
      const sessionTokens = toNumber(stats?.session_tokens);
      const tenantPending = toNumber(stats?.tenant_pending);
      const userPending = toNumber(stats?.user_pending);

      if (tenantPending >= policy.tenantConcurrency) {
        return fence("concurrency", `租户 ${input.tenantId} 并行模型调用已达上限 ${policy.tenantConcurrency}`);
      }
      if (userPending >= policy.userConcurrency) {
        return fence("concurrency", `用户 ${input.userId} 并行模型调用已达上限 ${policy.userConcurrency}`);
      }
      if (tenantTokens + input.reservedTokens > policy.tenantTokens) {
        return fence("tenant_quota", `租户窗口内额度不足：已占用 ${tenantTokens}，本次需预占 ${input.reservedTokens}，上限 ${policy.tenantTokens}`);
      }
      if (userTokens + input.reservedTokens > policy.userTokens) {
        return fence("user_quota", `用户窗口内额度不足：已占用 ${userTokens}，本次需预占 ${input.reservedTokens}，上限 ${policy.userTokens}`);
      }
      if (sessionTokens + input.reservedTokens > policy.sessionTokens) {
        return fence("session_quota", `会话窗口内额度不足：已占用 ${sessionTokens}，本次需预占 ${input.reservedTokens}，上限 ${policy.sessionTokens}`);
      }

      const inserted = await tx
        .insertInto("myrix_gateway.quota_reservations")
        .values({
          tenant_id: input.tenantId,
          request_id: input.requestId,
          user_id: input.userId,
          session_id: input.sessionId,
          cell_id: input.cellId,
          model: input.model,
          reserved_tokens: input.reservedTokens,
          consumed_tokens: 0,
          outcome: "pending",
          prompt_tokens: null,
          completion_tokens: null,
          total_tokens: null,
          upstream_status: null,
          latency_ms: null,
          settled_at: null,
        })
        .returning(["request_id", "reserved_tokens", "created_at"])
        .executeTakeFirst();

      if (!inserted) {
        // 并发竞争：另一事务已插入同一 requestId → 按 replay 返回，不重复扣减。
        const again = await tx
          .selectFrom("myrix_gateway.quota_reservations")
          .select(["request_id", "reserved_tokens", "created_at"])
          .where("request_id", "=", input.requestId)
          .executeTakeFirstOrThrow();
        return { ok: true, requestId: again.request_id, reservedTokens: again.reserved_tokens, createdAtMs: again.created_at.getTime(), replayed: true };
      }

      if (options.afterReserve) await options.afterReserve(tx, input);
      return {
        ok: true,
        requestId: inserted.request_id,
        reservedTokens: inserted.reserved_tokens,
        createdAtMs: inserted.created_at.getTime(),
        replayed: false,
      };
    });
  }

  async function consume(input: ConsumptionInput): Promise<ConsumptionResult> {
    return withTenant(input.tenantId, async (tx) => {
      const row = await tx
        .selectFrom("myrix_gateway.quota_reservations")
        .select(["request_id", "reserved_tokens", "consumed_tokens", "outcome"])
        .where("request_id", "=", input.requestId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) {
        throw new GatewayError(500, "unknown_reservation", `没有 requestId=${input.requestId} 的预占记录，拒绝结算`, "upstream_error");
      }
      if (row.outcome !== "pending") {
        return {
          requestId: row.request_id,
          outcome: row.outcome,
          consumedTokens: row.consumed_tokens,
          refundedTokens: 0,
          replayed: true,
        };
      }

      const amount = settleAmounts(row.reserved_tokens, input);
      await tx
        .updateTable("myrix_gateway.quota_reservations")
        .set({
          outcome: amount.consumption,
          consumed_tokens: amount.consumed,
          settled_at: new Date(),
          prompt_tokens: input.promptTokens ?? null,
          completion_tokens: input.completionTokens ?? null,
          total_tokens: input.totalTokens ?? null,
          upstream_status: input.upstreamStatus ?? null,
          latency_ms: input.latencyMs ?? null,
        })
        .where("request_id", "=", input.requestId)
        .where("outcome", "=", "pending")
        .execute();

      return { requestId: row.request_id, outcome: amount.consumption, consumedTokens: amount.consumed, refundedTokens: amount.refunded, replayed: false };
    });
  }

  return {
    tryReserve,
    reserve: async (input: ReserveInput): Promise<ReservationReceipt> => {
      const result = await tryReserve(input);
      if (!result.ok) throw quotaExceeded(result.reason);
      return result;
    },
    consume,
    release: (requestId: string, tenantId: string, _reason: string): Promise<ConsumptionResult> =>
      consume({ requestId, tenantId, consumption: "released" }),
    usageSnapshot: async (): Promise<{ entries: number; reservedTokens: number; consumedTokens: number }> => {
      // 运维探针：没有租户上下文时 FORCE RLS 让统计为 0（fail-closed）；按租户统计请走 withTenant。
      const row = await sql<{ entries: number | string; reserved: number | string; consumed: number | string }>`
        select count(*) as entries,
               coalesce(sum(case when outcome = 'pending' then reserved_tokens else 0 end), 0) as reserved,
               coalesce(sum(consumed_tokens), 0) as consumed
        from myrix_gateway.quota_reservations
      `.execute(db);
      const stats = row.rows[0];
      return {
        entries: toNumber(stats?.entries),
        reservedTokens: toNumber(stats?.reserved),
        consumedTokens: toNumber(stats?.consumed),
      };
    },
  };
}

/** 按租户统计用量（运维/后台用；RLS 生效，只看到该租户）。 */
export async function usageForTenant(
  db: Kysely<GatewayDatabase>,
  tenantId: string,
): Promise<{ entries: number; reservedTokens: number; consumedTokens: number }> {
  return db.transaction().execute(async (tx) => {
    await sql`select set_config('myrix_gateway.tenant_id', ${tenantId}, true)`.execute(tx);
    const row = await sql<{ entries: number | string; reserved: number | string; consumed: number | string }>`
      select count(*) as entries,
             coalesce(sum(case when outcome = 'pending' then reserved_tokens else 0 end), 0) as reserved,
             coalesce(sum(consumed_tokens), 0) as consumed
      from myrix_gateway.quota_reservations
    `.execute(tx);
    const stats = row.rows[0];
    return {
      entries: toNumber(stats?.entries),
      reservedTokens: toNumber(stats?.reserved),
      consumedTokens: toNumber(stats?.consumed),
    };
  });
}
