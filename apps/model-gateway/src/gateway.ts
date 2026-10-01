/**
 * 模型网关核心编排（与 HTTP 传输解耦，便于单测直接驱动）。
 *
 * 一次 `/v1/responses` 的固定顺序：
 *   1. 协议校验（Responses 字段白名单、input 上限、输出 token 上限、无状态 store:false）→ 400
 *   2. 模型 allowlist → 403
 *   3. 服务端凭据 + 会话绑定 + rev + 成员 + authorizePlatform → 401/403
 *   4. 上游是否配置（缺密钥）→ 503（此时**还没有预占**，不消耗额度）
 *   5. 额度预占（租户/用户/会话三层 + 并发）→ 429
 *   6. 调上游（唯一的上游 URL/模型/密钥来自部署配置，完整 `/responses` URL）
 *   7. 结算：真实 usage → settled；拿不到 usage / 断流 / 撤销 → unknown（保守保留预占）
 *
 * 协议真实性（不做任何 chat/completions 转换或回退）：
 * * 上游只收 Responses JSON；SSE 逐事件转发 `response.*` 事件；
 * * **没有终态事件就不算成功**：`response.completed` 才是成功，
 *   `response.incomplete` / `response.failed` 是已知失败，流提前断开是截断；
 * * 上游 `error` 事件**不原样转发**（可能含上游内部信息），换成网关自己的固定文案。
 *
 * requestId 幂等：同一个 requestId 的第二次预占会被账本识别为 replay，
 * 网关直接返回 409，绝不重复调用上游、绝不重复计费。
 */
import { createModelAllowlist, type ModelAllowlist } from "./known";
import { bearerToken } from "./util";
import {
  GatewayError,
  clientAborted,
  forbidden,
  notConfigured,
  quotaExceeded,
  upstreamFailed,
} from "./errors";
import { combineSignals, readResponseBody, type UpstreamClient } from "./upstream";
import {
  computeReservation,
  normalizeUsage,
  DEFAULT_BYTES_PER_TOKEN,
  type TokenUsage,
} from "./usage";
import {
  SseFramingError,
  isTerminalEvent,
  parseResponseRequest,
  parseSse,
  streamErrorEvent,
  toUpstreamBody,
  RESPONSE_SUCCESS_EVENT,
  type ParsedResponseRequest,
  type RequestValidationLimits,
} from "./protocol";
import type { Authorizer, AuthorizedRequest } from "./ports";
import type { GatewayConfig } from "./config";
import type { ConsumptionOutcome, LedgerPort } from "./ledger";

/** 只含计量元数据的审计记录：**不含请求正文、不含密钥**。 */
export interface GatewayAuditRecord {
  requestId: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  cellId: string;
  requestedModel: string;
  upstreamModel: string;
  stream: boolean;
  status: number;
  outcome: ConsumptionOutcome | "rejected";
  reservedTokens: number;
  consumedTokens: number;
  promptTokens?: number;
  completionTokens?: number;
  /** 审计：命中缓存的输入 token（已含在 promptTokens 内） */
  cachedTokens?: number;
  /** 审计：推理 token（已含在 completionTokens 内） */
  reasoningTokens?: number;
  latencyMs: number;
  reason?: string;
}

export interface AuditSink {
  record(entry: GatewayAuditRecord): void | Promise<void>;
}

export interface GatewayDependencies {
  config: GatewayConfig;
  authorizer: Authorizer;
  ledger: LedgerPort;
  upstream: UpstreamClient;
  allowlist?: ModelAllowlist;
  audit?: AuditSink;
  /** 注入时钟便于测试（毫秒） */
  now?: () => number;
}

export interface ResponseGatewayInput {
  /** 原始 Authorization 头（服务端 cell 凭据） */
  authorization: unknown;
  /** 会话归因头；缺失即拒绝 */
  sessionId: unknown;
  /** 撤权版本头；缺失即拒绝 */
  revision: unknown;
  requestId: string;
  body: unknown;
  /** 客户端断开信号；路由层在 socket close 时 abort */
  clientSignal: AbortSignal;
}

export type GatewayResponse =
  | { kind: "json"; status: number; body: unknown }
  | { kind: "sse"; status: number; headers: Record<string, string>; stream: AsyncIterable<string> }
  | { kind: "error"; status: number; body: { error: { message: string; type: string; code: string } } };

export const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

const MAX_UPSTREAM_ERROR_BYTES = 64 * 1024;
const MAX_NON_STREAM_BYTES = 8 * 1024 * 1024;

function jsonError(error: GatewayError): GatewayResponse {
  return { kind: "error", status: error.statusCode, body: error.toWire() };
}

function parseRevision(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isSafeInteger(raw) && raw >= 0 ? raw : undefined;
  if (typeof raw === "string" && /^[0-9]{1,10}$/.test(raw)) return Number(raw);
  return undefined;
}

function validationLimits(config: GatewayConfig): RequestValidationLimits {
  return {
    maxOutputTokens: config.limits.maxOutputTokens,
    defaultMaxOutputTokens: config.limits.defaultMaxOutputTokens,
    maxInputItems: config.limits.maxInputItems,
    maxInputChars: config.limits.maxInputChars,
  };
}

export class ModelGateway {
  readonly #deps: GatewayDependencies;
  readonly #allowlist: ModelAllowlist;
  readonly #now: () => number;

  constructor(deps: GatewayDependencies) {
    this.#deps = deps;
    this.#allowlist = deps.allowlist ?? createModelAllowlist(deps.config.modelAllowlist);
    this.#now = deps.now ?? (() => Date.now());
  }

  get allowlist(): ModelAllowlist {
    return this.#allowlist;
  }

  /** 健康探针：只报告配置是否就绪，不泄露密钥。 */
  readiness(): { ready: boolean; upstreamConfigured: boolean; models: readonly string[]; reason?: string } {
    const missing = this.#deps.upstream.describeMissing();
    return {
      ready: missing === undefined,
      upstreamConfigured: this.#deps.upstream.configured,
      models: this.#allowlist.entries,
      ...(missing === undefined ? {} : { reason: missing }),
    };
  }

  async handleResponse(input: ResponseGatewayInput): Promise<GatewayResponse> {
    const startedAt = this.#now();
    try {
      return await this.#handle(input, startedAt);
    } catch (error) {
      if (error instanceof GatewayError) return jsonError(error);
      throw error;
    }
  }

  async #handle(input: ResponseGatewayInput, startedAt: number): Promise<GatewayResponse> {
    const { config } = this.#deps;
    const limits = validationLimits(config);

    const parsed = parseResponseRequest(input.body, limits);
    const requestedModel = this.#allowlist.require(parsed.model);

    const token = bearerToken(input.authorization);
    const outcome = await this.#deps.authorizer.authorize({
      token: token ?? "",
      sessionId: typeof input.sessionId === "string" ? input.sessionId : "",
      claimedRevision: parseRevision(input.revision),
    });
    if (outcome.effect === "deny") {
      this.#audit({
        requestId: input.requestId, tenantId: "<unknown>", userId: "<unknown>", sessionId: String(input.sessionId ?? ""),
        cellId: "<unknown>", requestedModel, upstreamModel: config.upstream.model, stream: parsed.stream,
        status: outcome.statusCode, outcome: "rejected", reservedTokens: 0, consumedTokens: 0,
        latencyMs: this.#now() - startedAt, reason: outcome.reason,
      });
      return jsonError(
        outcome.statusCode === 401
          ? new GatewayError(401, outcome.code, outcome.reason, "authentication_error")
          : new GatewayError(outcome.statusCode, outcome.code, outcome.reason, "permission_error"),
      );
    }
    const principal = outcome.principal;

    // 缺密钥 → 503，且发生在预占之前：不消耗任何额度，也不存在模拟降级。
    const missing = this.#deps.upstream.describeMissing();
    if (missing !== undefined) throw notConfigured(missing);

    // 预占 = 输入保守估算（UTF-8 字节/token，含 input 项与 tools JSON 成本）+ 输出预算。
    // 绝不截断：估算超过输入硬上限 → 400 `input_too_large`（computeReservation 内抛）。
    const reservedTokens = computeReservation(parsed, limits, {
      bytesPerToken: DEFAULT_BYTES_PER_TOKEN,
      maxInputTokens: Math.max(1, Math.ceil(config.limits.maxBodyBytes / DEFAULT_BYTES_PER_TOKEN)),
    });

    const reservation = await this.#deps.ledger.tryReserve({
      requestId: input.requestId,
      tenantId: principal.tenantId,
      userId: principal.userId,
      sessionId: principal.sessionId,
      cellId: principal.cellId,
      model: requestedModel,
      reservedTokens,
    });
    if (reservation.ok === false) {
      this.#audit({
        requestId: input.requestId, tenantId: principal.tenantId, userId: principal.userId, sessionId: principal.sessionId,
        cellId: principal.cellId, requestedModel, upstreamModel: config.upstream.model, stream: parsed.stream,
        status: 429, outcome: "rejected", reservedTokens, consumedTokens: 0,
        latencyMs: this.#now() - startedAt, reason: reservation.reason,
      });
      throw quotaExceeded(reservation.reason);
    }
    if (reservation.replayed) {
      // 幂等：同一 requestId 已在使用。拒绝而不是复用，避免两个上游调用共享一次计费。
      throw new GatewayError(
        409,
        "request_id_reused",
        `requestId=${input.requestId} 已被使用；网关不重放模型响应，请换一个 requestId`,
        "invalid_request_error",
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("myrix: gateway timeout")), config.limits.upstreamTimeoutMs);
    const merged = combineSignals([input.clientSignal, controller.signal]);
    const state: UpstreamState = { upstreamStarted: false, revoked: false, settled: false };
    // 流式响应在请求处理函数返回之后才真正传输，因此合并信号必须活到流结束；
    // 只有非流式路径在这里同步清理。否则 abort 不会传到上游连接（会继续烧额度）。
    let disposeBeforeReturn = true;
    const cleanup = (): void => {
      clearTimeout(timeout);
      merged.dispose();
    };

    try {
      const response = await this.#deps.upstream.send({
        body: toUpstreamBody({ ...parsed, model: config.upstream.model }),
        signal: merged.signal,
        requestId: input.requestId,
      });
      state.upstreamStarted = true;

      if (!response.ok) {
        const upstreamText = await readLimitedText(response);
        await this.#settleFailure(input, principal, requestedModel, parsed, response.status, upstreamText.text, startedAt, state);
      }

      if (parsed.stream) {
        disposeBeforeReturn = false;
        return {
          kind: "sse",
          status: 200,
          headers: { ...SSE_HEADERS },
          stream: this.#streamResponse({ response, input, principal, requestedModel, parsed, state, controller, startedAt, cleanup }),
        };
      }
      return await this.#jsonResponse({ response, input, principal, requestedModel, parsed, startedAt, state });
    } catch (error) {
      // 请求发出后失败（含超时/撤权/连接中断）：无法知道上游是否已产生用量 → 保守保留预占。
      // 唯一释放预占的情形是"客户端在请求到达上游前就断开"。
      const consumption: ConsumptionOutcome = !state.upstreamStarted && input.clientSignal.aborted ? "released" : "unknown";
      // #settleFailure / #jsonResponse 已经结算过的路径不再重复结算（它们的错误在这里继续抛）。
      if (!state.settled) {
        try {
          await this.#deps.ledger.consume({
            requestId: input.requestId,
            tenantId: principal.tenantId,
            consumption,
            latencyMs: this.#now() - startedAt,
          });
        } catch {
          // 兜底结算失败不能掩盖上游的真实错误；账本行保持 pending，由运维对账处理。
        }
      }
      this.#audit({
        requestId: input.requestId, tenantId: principal.tenantId, userId: principal.userId, sessionId: principal.sessionId,
        cellId: principal.cellId, requestedModel, upstreamModel: config.upstream.model, stream: parsed.stream,
        status: state.upstreamStarted ? 502 : 499, outcome: consumption,
        reservedTokens, consumedTokens: consumption === "unknown" ? reservedTokens : 0,
        latencyMs: this.#now() - startedAt,
        reason: error instanceof GatewayError ? error.reason : "上游调用失败",
      });
      if (error instanceof GatewayError) throw error;
      if (input.clientSignal.aborted) throw clientAborted();
      if (state.revoked) throw forbidden("会话权限已失效，已中止上游请求");
      throw upstreamFailed(502, "上游模型调用失败");
    } finally {
      if (disposeBeforeReturn) cleanup();
    }
  }

  /** 上游 4xx（非 429）表示请求被拒绝、未产生生成 → 释放预占；429/5xx 保守保留。 */
  async #settleFailure(
    input: ResponseGatewayInput,
    principal: AuthorizedRequest,
    requestedModel: string,
    parsed: ParsedResponseRequest,
    status: number,
    upstreamText: string,
    startedAt: number,
    state: UpstreamState,
  ): Promise<never> {
    const consumption: ConsumptionOutcome = status === 429 || status >= 500 ? "unknown" : "released";
    const result = await this.#deps.ledger.consume({
      requestId: input.requestId,
      tenantId: principal.tenantId,
      consumption,
      upstreamStatus: status,
      latencyMs: this.#now() - startedAt,
    });
    state.settled = true;
    this.#audit({
      requestId: input.requestId, tenantId: principal.tenantId, userId: principal.userId, sessionId: principal.sessionId,
      cellId: principal.cellId, requestedModel, upstreamModel: this.#deps.config.upstream.model, stream: parsed.stream,
      status, outcome: result.outcome, reservedTokens: result.consumedTokens + result.refundedTokens,
      consumedTokens: result.consumedTokens, latencyMs: this.#now() - startedAt,
      reason: `上游返回 ${status}`,
    });
    if (status === 429) throw new GatewayError(429, "upstream_rate_limited", "上游模型限流，请稍后重试", "rate_limit_error");
    if (status >= 500) throw upstreamFailed(502, `上游模型不可用（HTTP ${status}）`);
    // 上游 4xx：客户端请求本身有问题，透传状态但不透传上游正文（可能含供应商内部信息）。
    void upstreamText;
    throw new GatewayError(status >= 400 ? status : 502, "upstream_rejected", "上游模型拒绝了该请求（请求参数或模型不被上游接受）", "invalid_request_error");
  }

  /**
   * 非流式 Responses 响应。
   *
   * **不以 HTTP 200 推断成功**：只有响应体 `status: "completed"` 才算成功结束；
   * `incomplete` / `failed` 是已知失败（仍可能产生真实 usage），缺 status 则是协议异常。
   */
  async #jsonResponse(ctx: {
    response: Response;
    input: ResponseGatewayInput;
    principal: AuthorizedRequest;
    requestedModel: string;
    parsed: ParsedResponseRequest;
    startedAt: number;
    state: UpstreamState;
  }): Promise<GatewayResponse> {
    const read = await readLimitedText(ctx.response, MAX_NON_STREAM_BYTES, true);
    if (read.truncated) {
      const result = await this.#deps.ledger.consume({
        requestId: ctx.input.requestId, tenantId: ctx.principal.tenantId, consumption: "unknown",
        upstreamStatus: ctx.response.status, latencyMs: this.#now() - ctx.startedAt,
      });
      ctx.state.settled = true;
      this.#audit({
        requestId: ctx.input.requestId, tenantId: ctx.principal.tenantId, userId: ctx.principal.userId, sessionId: ctx.principal.sessionId,
        cellId: ctx.principal.cellId, requestedModel: ctx.requestedModel, upstreamModel: this.#deps.config.upstream.model, stream: false,
        status: 502, outcome: result.outcome,
        reservedTokens: result.consumedTokens + result.refundedTokens, consumedTokens: result.consumedTokens,
        latencyMs: this.#now() - ctx.startedAt, reason: "上游响应超过网关读取上限，保守保留预占",
      });
      throw upstreamFailed(502, "上游返回的响应过大，网关拒绝读取");
    }
    let body: unknown;
    try {
      body = JSON.parse(read.text);
    } catch {
      const result = await this.#deps.ledger.consume({
        requestId: ctx.input.requestId, tenantId: ctx.principal.tenantId, consumption: "unknown",
        upstreamStatus: ctx.response.status, latencyMs: this.#now() - ctx.startedAt,
      });
      ctx.state.settled = true;
      this.#audit({
        requestId: ctx.input.requestId, tenantId: ctx.principal.tenantId, userId: ctx.principal.userId, sessionId: ctx.principal.sessionId,
        cellId: ctx.principal.cellId, requestedModel: ctx.requestedModel, upstreamModel: this.#deps.config.upstream.model, stream: false,
        status: 502, outcome: result.outcome,
        reservedTokens: result.consumedTokens + result.refundedTokens, consumedTokens: result.consumedTokens,
        latencyMs: this.#now() - ctx.startedAt,
        reason: "上游返回了非 JSON 响应，保守保留预占",
      });
      throw upstreamFailed(502, "上游返回了无法解析的响应");
    }

    const usage = normalizeUsage((body as { usage?: unknown })?.usage);
    const status = (body as { status?: unknown })?.status;
    const terminal = typeof status === "string" && (status === "completed" || status === "incomplete" || status === "failed");
    // 有终态且拿到真实 usage → 据实结算（含 incomplete/failed：那份用量确实产生了）；
    // 否则（缺 status / 缺 usage）保守保留预占。
    const outcome: ConsumptionOutcome = terminal && usage !== undefined ? "settled" : "unknown";
    const result = await this.#deps.ledger.consume({
      requestId: ctx.input.requestId,
      tenantId: ctx.principal.tenantId,
      consumption: outcome,
      ...(usage === undefined ? {} : { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, totalTokens: usage.totalTokens }),
      upstreamStatus: ctx.response.status,
      latencyMs: this.#now() - ctx.startedAt,
    });
    ctx.state.settled = true;
    this.#audit({
      requestId: ctx.input.requestId, tenantId: ctx.principal.tenantId, userId: ctx.principal.userId, sessionId: ctx.principal.sessionId,
      cellId: ctx.principal.cellId, requestedModel: ctx.requestedModel, upstreamModel: this.#deps.config.upstream.model, stream: false,
      status: ctx.response.status, outcome: result.outcome, reservedTokens: result.consumedTokens + result.refundedTokens,
      consumedTokens: result.consumedTokens, ...usageAudit(usage),
      latencyMs: this.#now() - ctx.startedAt,
      ...(outcome === "unknown"
        ? { reason: terminal ? "上游未返回可用 usage，保守保留预占" : "上游响应缺少终态 status，不以 200 推断成功，保守保留预占" }
        : status === "completed" ? {} : { reason: `上游响应终态为 ${String(status)}` }),
    });

    if (!terminal) {
      throw upstreamFailed(502, "上游 Responses 响应缺少终态 status；网关不以 HTTP 200 推断成功");
    }
    if (status === "failed") {
      // 失败不是成功：即使上游给了 200，也按错误返回，绝不把 failed 透传成"成功响应"。
      throw upstreamFailed(502, "上游 Responses 返回 failed；网关不把失败当成功");
    }
    return { kind: "json", status: 200, body };
  }

  /** 流式：转发 Responses SSE 事件，轮询撤权，按终态与真实 usage 结算。 */
  async *#streamResponse(ctx: {
    response: Response;
    input: ResponseGatewayInput;
    principal: AuthorizedRequest;
    requestedModel: string;
    parsed: ParsedResponseRequest;
    state: UpstreamState;
    controller: AbortController;
    startedAt: number;
    cleanup: () => void;
  }): AsyncGenerator<string> {
    const { input, principal, parsed, state, controller, response } = ctx;
    let usage: TokenUsage | undefined;
    /** 只有 response.completed 才算成功结束 */
    let succeeded = false;
    /** 收到任何终态事件（completed/incomplete/failed）即为"已结束" */
    let terminalSeen = false;
    let terminalNote: string | undefined;
    let protocolError = false;
    let providerError = false;
    let polling = false;

    const poll = setInterval(() => {
      if (polling) return;
      polling = true;
      void this.#deps.authorizer
        .isStillAuthorized(principal)
        .then((ok) => {
          if (!ok) {
            state.revoked = true;
            controller.abort(new Error("myrix: authorization revoked"));
          }
        })
        .catch(() => {
          // 轮询失败按"权限已失效"处理（fail-closed）
          state.revoked = true;
          controller.abort(new Error("myrix: authorization check failed"));
        })
        .finally(() => {
          polling = false;
        });
    }, this.#deps.config.limits.revokePollMs);
    if (typeof poll.unref === "function") poll.unref();

    try {
      // 上游连接被 abort 时 read() 会抛错；这里捕获后仍要给出终止原因事件。
      try {
        for await (const event of parseSse(readResponseBody(response.body), { maxEventBytes: this.#deps.config.limits.maxSseEventBytes })) {
          if (event.data === undefined) continue;
          let payload: unknown;
          try {
            payload = JSON.parse(event.data);
          } catch {
            protocolError = true;
            controller.abort(new Error("myrix: malformed upstream event"));
            yield streamErrorEvent("upstream_protocol_error", "上游返回了无法解析的流式事件，已中止并保守保留额度预占");
            break;
          }
          const name = event.event ?? (payload as { type?: unknown })?.type;
          const eventName = typeof name === "string" ? name : "";
          if (eventName === "error") {
            // 上游 error 事件可能含上游内部信息；不原样转发，换成固定文案。
            providerError = true;
            controller.abort(new Error("myrix: upstream error event"));
            yield streamErrorEvent("upstream_error", "上游返回了错误事件，已中止并保守保留额度预占");
            break;
          }
          const eventUsage = normalizeUsage((payload as { response?: { usage?: unknown } })?.response?.usage ?? (payload as { usage?: unknown })?.usage);
          if (eventUsage) usage = eventUsage;
          if (eventName === RESPONSE_SUCCESS_EVENT) {
            succeeded = true;
            terminalSeen = true;
          } else if (isTerminalEvent(eventName)) {
            terminalSeen = true;
            terminalNote = (payload as { response?: { status?: unknown } })?.response?.status === "incomplete"
              ? "上游响应不完整（incomplete）"
              : "上游响应失败（failed）";
          }
          yield formatEvent(eventName, event.data);
        }
      } catch (error) {
        if (error instanceof SseFramingError) {
          protocolError = true;
          controller.abort(new Error("myrix: upstream event too large"));
          yield streamErrorEvent("upstream_protocol_error", "上游单个流式事件超过网关上限，已中止并保守保留额度预占");
        }
        // 其他情况：上游读取被中断（撤权 / 超时 / 客户端断开 / 连接错误），原因在下面统一判定。
      }

      if (state.revoked) {
        yield streamErrorEvent("session_revoked", "会话权限已撤销，已中止上游模型调用");
      } else if (protocolError || providerError) {
        // 上面已经发过具体错误，不再重复
      } else if (input.clientSignal.aborted) {
        yield streamErrorEvent("client_aborted", "客户端断开连接，已中止上游模型调用");
      } else if (controller.signal.aborted) {
        yield streamErrorEvent("upstream_timeout", "上游模型响应超时，已中止并保守保留额度预占");
      } else if (!terminalSeen) {
        // 关键回归：流在没有 response.completed 的情况下断开 = 截断，绝不当成功。
        yield streamErrorEvent("upstream_truncated", "上游流在终态事件之前断开，按未知用量保守保留额度预占");
      } else if (!succeeded) {
        yield streamErrorEvent("upstream_incomplete", `${terminalNote ?? "上游响应未完成"}；按已返回的真实用量结算`);
      }
    } finally {
      clearInterval(poll);
      ctx.cleanup();
      // 只有"收到终态事件 + 真实 usage + 未被撤销/超时/中断"才按真实用量精算入账。
      // 注意：`response.incomplete` / `response.failed` 同样是**已知终态且带真实 usage**，
      // 那些 token 确实产生了，因此据实入账（与"已知真实值不截断"一致）；
      // 而**没有**终态事件就断开是截断/未知，一律保守保留预占。
      const cleanFinish = terminalSeen && usage !== undefined && !state.revoked && !protocolError && !providerError &&
        !controller.signal.aborted && !input.clientSignal.aborted;
      const consumption: ConsumptionOutcome = cleanFinish
        ? "settled"
        : state.upstreamStarted
          ? "unknown"
          : "released";
      const result = await this.#deps.ledger.consume({
        requestId: input.requestId,
        tenantId: principal.tenantId,
        consumption,
        ...(usage === undefined ? {} : { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, totalTokens: usage.totalTokens }),
        upstreamStatus: response.status,
        latencyMs: this.#now() - ctx.startedAt,
      });
      this.#audit({
        requestId: input.requestId, tenantId: principal.tenantId, userId: principal.userId, sessionId: principal.sessionId,
        cellId: principal.cellId, requestedModel: ctx.requestedModel, upstreamModel: this.#deps.config.upstream.model,
        stream: true, status: response.status, outcome: result.outcome,
        reservedTokens: result.consumedTokens + result.refundedTokens, consumedTokens: result.consumedTokens,
        ...usageAudit(usage),
        latencyMs: this.#now() - ctx.startedAt,
        ...(consumption === "settled"
          ? succeeded ? {} : { reason: terminalNote ?? "上游响应未完成" }
          : { reason: state.revoked ? "会话撤权中止" : controller.signal.aborted ? "上游超时中止" : "用量未知，保守保留预占" }),
      });
    }
  }

  #audit(entry: GatewayAuditRecord): void {
    const sink = this.#deps.audit;
    if (!sink) return;
    try {
      const result = sink.record(entry);
      if (result instanceof Promise) result.catch(() => undefined);
    } catch {
      // 审计失败不能影响模型调用本身
    }
  }
}

interface UpstreamState {
  upstreamStarted: boolean;
  revoked: boolean;
  /** 是否已经写过结算（避免 catch 分支对同一次调用二次结算） */
  settled: boolean;
}

function usageAudit(usage: TokenUsage | undefined): Pick<GatewayAuditRecord, "promptTokens" | "completionTokens" | "cachedTokens" | "reasoningTokens"> {
  if (usage === undefined) return {};
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    ...(usage.cachedTokens === undefined ? {} : { cachedTokens: usage.cachedTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
  };
}

/** 转发上游事件：有事件名就带上 `event:` 行（Responses SSE 恒有），否则只发 data。 */
function formatEvent(name: string, data: string): string {
  return name.length === 0 ? `data: ${data}\n\n` : `event: ${name}\ndata: ${data}\n\n`;
}

/**
 * 有界读取：超过 `limit` 时**取消** reader（不让上游继续往没人读的流里写）。
 * `truncated` 为 true 表示确实超限被截断，调用方必须 fail-closed。
 */
async function readLimitedText(response: Response, limit = MAX_UPSTREAM_ERROR_BYTES, reportTruncation = false): Promise<{ text: string; truncated: boolean }> {
  const body = response.body;
  if (!body) return { text: "", truncated: false };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > limit) {
        text += decoder.decode(value.subarray(0, Math.max(0, limit - (size - value.byteLength))), { stream: true });
        truncated = true;
        await reader.cancel();
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
  const result = { text: text + decoder.decode(), truncated: reportTruncation && truncated };
  return result;
}
