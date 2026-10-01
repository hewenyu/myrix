/**
 * 额度账本端口 + 内存实现。
 *
 * 语义（对应需求"每租户/用户 quota 预占和真实 usage 结算"）：
 * * `reserve` 在**一个事务里串行化**：检查租户/用户/会话三层额度，写预占行。
 *   额度不足 → 返回 `{ ok: false }`，调用方必须 429，且**不消耗上游额度**。
 * * `settle` 用真实 usage **完整**结算：预占量只是一次防超卖的**闸门**，不是计费上限。
 *   真实用量小于预占 → 差额退回；真实用量**大于**预占（输入估算偏保守或上游实际更贵）
 *   → 全额计入已消费，`refundedTokens = 0`，绝不把真实用量截断成预占量
 *   （旧实现 `min(预占, 真实)` 会把超出部分白送，且让后续窗口统计偏低）。
 *   超出部分在**下一次**预占时由窗口统计体现：该用户/会话/租户随后被 429，直到滚动窗口滑出。
 * * `unknown` 表示拿不到 usage（断流、上游 5xx、客户端取消且没有末块）：
 *   按需求"保守保留预占"——预占转为已消费，不退款、不猜测用量。
 * * `release` 只用于"请求根本没发到上游"的情形（上游未配置、客户端立刻断开）。
 * * 幂等：`requestId` 唯一；重复 reserve/settle 返回既有结果，不重复扣减。
 *
 * 账本表**不存聊天正文、不存密钥**：只有计量数字、模型名、状态与关联 id。
 */
import { GatewayError, quotaExceeded } from "./errors";

/** 预占被额度/并发闸门拒绝的结果。与 ReservationReceipt(`ok:true`) 构成可收窄联合。 */
export interface FenceResult {
  ok: false;
  code: "tenant_quota" | "user_quota" | "concurrency" | "session_quota";
  reason: string;
}

export interface LedgerClock {
  /** 毫秒 */
  nowMs(): number;
}

export const systemLedgerClock: LedgerClock = { nowMs: () => Date.now() };

export interface QuotaPolicy {
  /** 租户滚动窗口（毫秒） */
  tenantWindowMs: number;
  /** 用户滚动窗口（毫秒） */
  userWindowMs: number;
  /** 会话滚动窗口（毫秒） */
  sessionWindowMs: number;
  /** 单租户窗口内 token 上限 */
  tenantTokens: number;
  /** 单用户窗口内 token 上限 */
  userTokens: number;
  /** 单会话窗口内 token 上限（含预占） */
  sessionTokens: number;
  /** 单租户并行未结算请求上限 */
  tenantConcurrency: number;
  /** 单用户并行未结算请求上限 */
  userConcurrency: number;
}

export const DEFAULT_QUOTA_POLICY: QuotaPolicy = {
  tenantWindowMs: 60 * 60 * 1000,
  userWindowMs: 60 * 60 * 1000,
  sessionWindowMs: 60 * 60 * 1000,
  tenantTokens: 5_000_000,
  userTokens: 1_000_000,
  sessionTokens: 200_000,
  tenantConcurrency: 64,
  userConcurrency: 8,
};

export interface ReserveInput {
  requestId: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  cellId: string;
  model: string;
  reservedTokens: number;
}

export interface ReservationReceipt {
  /** 判别字段：true = 预占成功。与 FenceResult.ok=false 构成可收窄的联合类型。 */
  ok: true;
  requestId: string;
  reservedTokens: number;
  createdAtMs: number;
  /** 幂等重放标记：true 表示这次没有新建预占 */
  replayed: boolean;
}

export type ConsumptionOutcome = "settled" | "unknown" | "released";

export interface ConsumptionInput {
  requestId: string;
  /** RLS 上下文；必须与预占时一致，账本据此设置事务租户 */
  tenantId: string;
  consumption: ConsumptionOutcome;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** 仅用于审计：上游状态码，不含响应体 */
  upstreamStatus?: number;
  latencyMs?: number;
}

export interface ConsumptionResult {
  requestId: string;
  outcome: ConsumptionOutcome;
  consumedTokens: number;
  refundedTokens: number;
  replayed: boolean;
}

export interface LedgerPort {
  reserve(input: ReserveInput): Promise<ReservationReceipt>;
  /** 额度不足/并发超限时返回 `ok:false` 的判定结果（调用方转 429），不抛错。 */
  tryReserve(input: ReserveInput): Promise<ReservationReceipt | FenceResult>;
  consume(input: ConsumptionInput): Promise<ConsumptionResult>;
  /** 释放预占（仅在请求确实未到达上游时使用） */
  release(requestId: string, tenantId: string, reason: string): Promise<ConsumptionResult>;
  usageSnapshot(): Promise<{ entries: number; reservedTokens: number; consumedTokens: number }>;
}

export interface ReservationRecord {
  requestId: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  cellId: string;
  model: string;
  reservedTokens: number;
  consumedTokens: number;
  outcome: ConsumptionOutcome | "pending";
  createdAtMs: number;
  settledAtMs?: number;
  upstreamStatus?: number;
  latencyMs?: number;
}

interface WindowLimits {
  tenantWindowMs: number;
  userWindowMs: number;
  sessionWindowMs: number;
  tenantTokens: number;
  userTokens: number;
  sessionTokens: number;
  tenantConcurrency: number;
  userConcurrency: number;
}

export interface MemoryLedgerOptions {
  policy?: Partial<QuotaPolicy>;
  clock?: LedgerClock;
  /** 测试可注入：在 reserve 临界区里插桩，验证串行化 */
  onReserveEnter?: (requestId: string) => void;
}

/**
 * 单进程内存账本。用于单测与本地开发；生产用 Postgres 实现
 * （`createPostgresLedger`，schema `myrix_gateway`，FORCE RLS + 行锁串行化）。
 *
 * 串行化：所有读改写都在 `#exclusive` 的 Promise 链上排队，
 * 与 Postgres 版的 `SELECT ... FOR UPDATE` 语义一致。
 */
export class MemoryLedger implements LedgerPort {
  readonly #records = new Map<string, ReservationRecord>();
  readonly #limits: WindowLimits;
  readonly #clock: LedgerClock;
  readonly #onReserveEnter: ((requestId: string) => void) | undefined;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: MemoryLedgerOptions = {}) {
    const policy = { ...DEFAULT_QUOTA_POLICY, ...options.policy };
    this.#limits = policy;
    this.#clock = options.clock ?? systemLedgerClock;
    this.#onReserveEnter = options.onReserveEnter;
  }

  /** 把 fn 排在串行链上执行；链上的异常不会污染后续排队。 */
  #exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.#tail.then(fn, fn);
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async reserve(input: ReserveInput): Promise<ReservationReceipt> {
    const result = await this.tryReserve(input);
    if (!result.ok) throw quotaExceeded(result.reason);
    return result;
  }

  async tryReserve(input: ReserveInput): Promise<ReservationReceipt | FenceResult> {
    if (!Number.isSafeInteger(input.reservedTokens) || input.reservedTokens <= 0) {
      throw new GatewayError(500, "invalid_reservation", "预占 token 数必须是正整数", "upstream_error");
    }
    return this.#exclusive(() => {
      this.#onReserveEnter?.(input.requestId);
      const existing = this.#records.get(input.requestId);
      if (existing) {
        return { ok: true, requestId: input.requestId, reservedTokens: existing.reservedTokens, createdAtMs: existing.createdAtMs, replayed: true };
      }
      const now = this.#clock.nowMs();
      const fence = this.#fence(input, now);
      if (fence) return fence;
      this.#records.set(input.requestId, {
        requestId: input.requestId,
        tenantId: input.tenantId,
        userId: input.userId,
        sessionId: input.sessionId,
        cellId: input.cellId,
        model: input.model,
        reservedTokens: input.reservedTokens,
        consumedTokens: 0,
        outcome: "pending",
        createdAtMs: now,
      });
      return { ok: true, requestId: input.requestId, reservedTokens: input.reservedTokens, createdAtMs: now, replayed: false };
    });
  }

  async consume(input: ConsumptionInput): Promise<ConsumptionResult> {
    return this.#exclusive(() => this.#consumeLocked(input));
  }

  async release(requestId: string, tenantId: string, _reason: string): Promise<ConsumptionResult> {
    return this.#exclusive(() => this.#consumeLocked({ requestId, tenantId, consumption: "released" }));
  }

  async usageSnapshot(): Promise<{ entries: number; reservedTokens: number; consumedTokens: number }> {
    return this.#exclusive(() => {
      let reservedTokens = 0;
      let consumedTokens = 0;
      for (const record of this.#records.values()) {
        consumedTokens += record.consumedTokens;
        if (record.outcome === "pending") reservedTokens += record.reservedTokens;
      }
      return { entries: this.#records.size, reservedTokens, consumedTokens };
    });
  }

  /** 测试与运维探针使用；返回副本，外部修改不影响账本。 */
  inspect(requestId: string): ReservationRecord | undefined {
    const record = this.#records.get(requestId);
    return record ? { ...record } : undefined;
  }

  /** 计算窗口内已占用量（含 pending 预占）。串行链内部调用。 */
  #fence(input: ReserveInput, now: number): FenceResult | undefined {
    let tenantTokens = 0;
    let userTokens = 0;
    let sessionTokens = 0;
    let tenantConcurrency = 0;
    let userConcurrency = 0;
    for (const record of this.#records.values()) {
      const ageMs = now - record.createdAtMs;
      const pending = record.outcome === "pending";
      // pending 记预占量，已结算记真实消费量；两者都占用窗口额度。
      const billable = pending ? record.reservedTokens : record.consumedTokens;

      if (record.tenantId === input.tenantId) {
        if (pending) tenantConcurrency += 1;
        if (ageMs < this.#limits.tenantWindowMs) tenantTokens += billable;
      }
      if (record.userId === input.userId) {
        if (pending) userConcurrency += 1;
        if (ageMs < this.#limits.userWindowMs) userTokens += billable;
      }
      if (record.sessionId === input.sessionId && ageMs < this.#limits.sessionWindowMs) sessionTokens += billable;
    }

    if (tenantConcurrency >= this.#limits.tenantConcurrency) {
      return { ok: false, code: "concurrency", reason: `租户 ${input.tenantId} 并行模型调用已达上限 ${this.#limits.tenantConcurrency}，请等前一次调用结算后再试` };
    }
    if (userConcurrency >= this.#limits.userConcurrency) {
      return { ok: false, code: "concurrency", reason: `用户 ${input.userId} 并行模型调用已达上限 ${this.#limits.userConcurrency}` };
    }
    if (tenantTokens + input.reservedTokens > this.#limits.tenantTokens) {
      return { ok: false, code: "tenant_quota", reason: `租户窗口内额度不足：已占用 ${tenantTokens}，本次需预占 ${input.reservedTokens}，上限 ${this.#limits.tenantTokens}` };
    }
    if (userTokens + input.reservedTokens > this.#limits.userTokens) {
      return { ok: false, code: "user_quota", reason: `用户窗口内额度不足：已占用 ${userTokens}，本次需预占 ${input.reservedTokens}，上限 ${this.#limits.userTokens}` };
    }
    if (sessionTokens + input.reservedTokens > this.#limits.sessionTokens) {
      return { ok: false, code: "session_quota", reason: `会话窗口内额度不足：已占用 ${sessionTokens}，本次需预占 ${input.reservedTokens}，上限 ${this.#limits.sessionTokens}` };
    }
    return undefined;
  }

  #consumeLocked(input: ConsumptionInput): ConsumptionResult {
    const record = this.#records.get(input.requestId);
    if (!record) {
      throw new GatewayError(500, "unknown_reservation", `没有 requestId=${input.requestId} 的预占记录，拒绝结算`, "upstream_error");
    }
    if (record.tenantId !== input.tenantId) {
      // 幂等键跨租户复用：拒绝（否则 A 租户的 requestId 能影响 B 租户账本）
      throw new GatewayError(403, "cross_tenant_request_id", "预占记录不属于该租户，拒绝结算", "permission_error");
    }
    if (record.outcome !== "pending") {
      return {
        requestId: record.requestId,
        outcome: record.outcome,
        consumedTokens: record.consumedTokens,
        refundedTokens: 0,
        replayed: true,
      };
    }
    const now = this.#clock.nowMs();
    record.settledAtMs = now;
    if (input.upstreamStatus !== undefined) record.upstreamStatus = input.upstreamStatus;
    if (input.latencyMs !== undefined) record.latencyMs = input.latencyMs;

    if (input.consumption === "released") {
      record.outcome = "released";
      record.consumedTokens = 0;
      return { requestId: record.requestId, outcome: "released", consumedTokens: 0, refundedTokens: record.reservedTokens, replayed: false };
    }

    if (input.consumption === "unknown") {
      // 保守保留预占：按预占量计入已消费，不退款。
      record.outcome = "unknown";
      record.consumedTokens = record.reservedTokens;
      return { requestId: record.requestId, outcome: "unknown", consumedTokens: record.consumedTokens, refundedTokens: 0, replayed: false };
    }

    const total = input.totalTokens;
    const prompt = input.promptTokens;
    const completion = input.completionTokens;
    if (total === undefined || prompt === undefined || completion === undefined) {
      throw new GatewayError(500, "invalid_usage", "settled 结算必须给出真实 usage 三个字段", "upstream_error");
    }
    // 真实用量完整入账：可以超过预占（预占只是防超卖闸门，不是计费上限）。
    // 超出部分使该窗口的已占用量变高，后续预占会被 #fence 拒绝，直到窗口滑出。
    const charged = Math.max(0, total);
    record.outcome = "settled";
    record.consumedTokens = charged;
    return {
      requestId: record.requestId,
      outcome: "settled",
      consumedTokens: charged,
      refundedTokens: Math.max(0, record.reservedTokens - charged),
      replayed: false,
    };
  }
}
