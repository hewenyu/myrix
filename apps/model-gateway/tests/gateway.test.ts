import { describe, expect, it } from "vitest";
import { createAuthorizer, MemoryAuthorizerStore } from "../src/authorize";
import { DEFAULT_LIMITS, type GatewayConfig } from "../src/config";
import { ModelGateway } from "../src/gateway";
import { MemoryLedger } from "../src/ledger";
import { parseResponseRequest } from "../src/protocol";
import { computeReservation, DEFAULT_BYTES_PER_TOKEN } from "../src/usage";
import type { GatewayAuditRecord } from "../src/gateway";
import { collect, FakeUpstream, hangingSseResponse, jsonResponse, responseBody, sse, sseResponse } from "./fakes";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const OTHER_USER = "33333333-3333-4333-8333-333333333333";
const SESSION = "sess-abc";
const TOKEN = "cell-token-0123456789abcdef";
const REV = 7;

function baseConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    host: "127.0.0.1",
    port: 8790,
    upstream: { url: "https://upstream.invalid/v1/responses", model: "deepseek-chat", apiKey: "sk-test-upstream" },
    modelAllowlist: ["deepseek-chat", "deepseek-reasoner"],
    limits: { ...DEFAULT_LIMITS, revokePollMs: 20 },
    credentialSource: "port",
    envCredentials: {},
    ...overrides,
  };
}

function harness(options: {
  handler: ConstructorParameters<typeof FakeUpstream>[0]["handler"];
  configured?: boolean;
  memberStatus?: "active" | "disabled";
  sessionStatus?: string;
  sessionOverrides?: { cellId?: string; ownerUserId?: string; tenantId?: string };
  ledger?: MemoryLedger;
}) {
  const upstream = new FakeUpstream({
    handler: options.handler,
    ...(options.configured === undefined ? {} : { configured: options.configured }),
  });
  const store = new MemoryAuthorizerStore({
    credentials: { [TOKEN]: { tenantId: TENANT, cellId: "cell-1" } },
    sessions: [{
      sessionId: SESSION,
      tenantId: options.sessionOverrides?.tenantId ?? TENANT,
      ownerUserId: options.sessionOverrides?.ownerUserId ?? USER,
      cellId: options.sessionOverrides?.cellId ?? "cell-1",
      status: options.sessionStatus ?? "active",
      revision: REV,
    }],
    members: [{ tenantId: TENANT, userId: USER, status: options.memberStatus ?? "active", role: "member" }],
  });
  const ledger = options.ledger ?? new MemoryLedger({ policy: { userTokens: 1_000_000, tenantTokens: 5_000_000, sessionTokens: 100_000 } });
  const audit: GatewayAuditRecord[] = [];
  const gateway = new ModelGateway({
    config: baseConfig(),
    authorizer: createAuthorizer(store),
    ledger,
    upstream,
    audit: { record: (entry) => void audit.push(entry) },
  });
  return { gateway, upstream, ledger, audit, store };
}

const request = (body: unknown, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${TOKEN}`,
  sessionId: SESSION,
  revision: String(REV),
  requestId: "req-00000001",
  body,
  clientSignal: new AbortController().signal,
  ...extra,
});

const responses = { model: "deepseek-chat", input: [{ role: "user", content: [{ type: "input_text", text: "写一段小说" }] }] };

describe("模型网关：鉴权与归因", () => {
  it("缺上游密钥 → 503，且不发生任何预占（禁止模拟降级）", async () => {
    const h = harness({ handler: () => jsonResponse({}), configured: false });
    const response = await h.gateway.handleResponse(request(responses));
    expect(response.kind).toBe("error");
    if (response.kind !== "error") throw new Error("unreachable");
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("model_not_configured");
    expect(h.ledger.inspect("req-00000001")).toBeUndefined();
    expect(h.upstream.calls).toHaveLength(0);
  });

  it("忽略请求里的 tenant/user 归因头，主体只来自凭据绑定 + 数据库绑定行", async () => {
    const h = harness({ handler: () => jsonResponse(responseBody({ inputTokens: 3, outputTokens: 4 })) });
    const response = await h.gateway.handleResponse(request(responses, {
      tenantId: "attacker-tenant",
      userId: OTHER_USER,
    }));
    expect(response.kind).toBe("json");
    const record = h.ledger.inspect("req-00000001");
    expect(record?.tenantId).toBe(TENANT);
    expect(record?.userId).toBe(USER);
  });

  it("伪造 sessionId（不属于该 cell）被拒绝", async () => {
    const h = harness({ handler: () => jsonResponse({}), sessionOverrides: { cellId: "cell-2" } });
    const response = await h.gateway.handleResponse(request(responses));
    expect(response.kind).toBe("error");
    if (response.kind !== "error") throw new Error("unreachable");
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("wrong_cell");
    expect(h.upstream.calls).toHaveLength(0);
  });

  it("撤权版本不匹配（旧 rev）被拒绝", async () => {
    const h = harness({ handler: () => jsonResponse({}) });
    const response = await h.gateway.handleResponse(request(responses, { revision: String(REV - 1) }));
    expect(response.kind).toBe("error");
    if (response.kind !== "error") throw new Error("unreachable");
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("not_authorized");
  });

  it("缺少 rev 头 → 400（fail-closed，不猜最新版）", async () => {
    const h = harness({ handler: () => jsonResponse({}) });
    const response = await h.gateway.handleResponse(request(responses, { revision: "" }));
    expect(response.kind).toBe("error");
    if (response.kind !== "error") throw new Error("unreachable");
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("missing_revision");
  });

  it("未知 cell 凭据 → 401", async () => {
    const h = harness({ handler: () => jsonResponse({}) });
    const response = await h.gateway.handleResponse(request(responses, { authorization: "Bearer unknown-token-12345678" }));
    expect(response.kind).toBe("error");
    if (response.kind !== "error") throw new Error("unreachable");
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("unknown_cell_credential");
  });

  it("成员被停用 → 403", async () => {
    const h = harness({ handler: () => jsonResponse({}), memberStatus: "disabled" });
    const response = await h.gateway.handleResponse(request(responses));
    expect(response.kind).toBe("error");
    if (response.kind !== "error") throw new Error("unreachable");
    expect(response.status).toBe(403);
  });

  it("会话已撤销 → 403，且不再调用上游", async () => {
    const h = harness({ handler: () => jsonResponse({}), sessionStatus: "revoked" });
    const response = await h.gateway.handleResponse(request(responses));
    expect(response.kind).toBe("error");
    expect(h.upstream.calls).toHaveLength(0);
  });

  it("模型不在 allowlist → 403，且不预占、不调上游", async () => {
    const h = harness({ handler: () => jsonResponse({}) });
    const response = await h.gateway.handleResponse(request({ ...responses, model: "gpt-4" }));
    expect(response.kind).toBe("error");
    if (response.kind !== "error") throw new Error("unreachable");
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("model_not_allowed");
    expect(h.ledger.inspect("req-00000001")).toBeUndefined();
    expect(h.upstream.calls).toHaveLength(0);
  });

  it("上游地址与模型由部署配置决定，客户端无法覆盖", async () => {
    const h = harness({ handler: () => jsonResponse(responseBody({ inputTokens: 1, outputTokens: 1 })) });
    await h.gateway.handleResponse(request({ ...responses, model: "deepseek-reasoner" }));
    // 客户端请求的是 allowlist 内另一个名字，但发往上游的模型名永远是部署配置的那个。
    expect(h.upstream.calls[0]?.body.model).toBe("deepseek-chat");
    expect(h.upstream.calls[0]?.body).not.toHaveProperty("upstream_url");
    // 上游只收 Responses 形状：没有 messages，恒发 store:false。
    expect(h.upstream.calls[0]?.body).not.toHaveProperty("messages");
    expect(h.upstream.calls[0]?.body.store).toBe(false);
  });
});

describe("模型网关：额度预占与结算", () => {
  it("非流式按真实 Responses usage 结算并退回多占的预占", async () => {
    const h = harness({ handler: () => jsonResponse(responseBody({ inputTokens: 10, outputTokens: 20 })) });
    const response = await h.gateway.handleResponse(request(responses));
    expect(response.kind).toBe("json");
    const record = h.ledger.inspect("req-00000001");
    expect(record?.outcome).toBe("settled");
    expect(record?.consumedTokens).toBe(30);
    expect(record?.reservedTokens).toBeGreaterThan(30);
  });

  it("cached+reasoning 元数据完整入账且不扣减计费总量", async () => {
    const h = harness({ handler: () => jsonResponse(responseBody({ inputTokens: 100, outputTokens: 40, cachedTokens: 64, reasoningTokens: 15 })) });
    const response = await h.gateway.handleResponse(request(responses));
    expect(response.kind).toBe("json");
    const record = h.ledger.inspect("req-00000001");
    expect(record?.consumedTokens).toBe(140);
    expect(h.audit[0]?.promptTokens).toBe(100);
    expect(h.audit[0]?.cachedTokens).toBe(64);
    expect(h.audit[0]?.reasoningTokens).toBe(15);
  });

  it("上游没给 usage → 保守保留全部预占（unknown，不退款）", async () => {
    const body = responseBody();
    delete (body as { usage?: unknown }).usage;
    const h = harness({ handler: () => jsonResponse(body) });
    await h.gateway.handleResponse(request(responses));
    const record = h.ledger.inspect("req-00000001");
    expect(record?.outcome).toBe("unknown");
    expect(record?.consumedTokens).toBe(record?.reservedTokens);
  });

  it("上游 200 但没有终态 status → 不以成功推断，unknown 且返回错误", async () => {
    const h = harness({ handler: () => jsonResponse({ id: "resp_x", object: "response", output: [] }) });
    const response = await h.gateway.handleResponse(request(responses));
    expect(response.kind).toBe("error");
    if (response.kind !== "error") throw new Error("unreachable");
    expect(response.status).toBe(502);
    expect(h.ledger.inspect("req-00000001")?.outcome).toBe("unknown");
  });

  it("上游终态 failed → 返回错误（不把 failed 当成功），但已产生的 usage 据实入账", async () => {
    const h = harness({ handler: () => jsonResponse(responseBody({ status: "failed", inputTokens: 9, outputTokens: 1 })) });
    const response = await h.gateway.handleResponse(request(responses));
    expect(response.kind).toBe("error");
    if (response.kind !== "error") throw new Error("unreachable");
    expect(response.status).toBe(502);
    expect(h.ledger.inspect("req-00000001")?.outcome).toBe("settled");
    expect(h.ledger.inspect("req-00000001")?.consumedTokens).toBe(10);
  });

  it("上游 5xx → unknown（保守保留）；上游 4xx → released（未产生生成，退款）", async () => {
    const failing = harness({ handler: () => jsonResponse({ error: { message: "boom" } }, 500) });
    await failing.gateway.handleResponse(request(responses)).catch(() => undefined);
    expect(failing.ledger.inspect("req-00000001")?.outcome).toBe("unknown");

    const rejected = harness({ handler: () => jsonResponse({ error: { message: "bad param" } }, 400) });
    const response = await rejected.gateway.handleResponse(request(responses));
    expect(response.kind).toBe("error");
    if (response.kind !== "error") throw new Error("unreachable");
    expect(response.status).toBe(400);
    expect(rejected.ledger.inspect("req-00000001")?.outcome).toBe("released");
    expect(rejected.ledger.inspect("req-00000001")?.consumedTokens).toBe(0);
  });

  it("上游 4xx 不回显上游正文（防供应商内部信息外泄）", async () => {
    const h = harness({ handler: () => jsonResponse({ error: { message: "sk-upstream-internal-secret-detail" } }, 400) });
    const response = await h.gateway.handleResponse(request(responses));
    if (response.kind !== "error") throw new Error("expected error");
    expect(JSON.stringify(response.body)).not.toContain("sk-upstream-internal-secret-detail");
    expect(response.body.error.code).toBe("upstream_rejected");
  });

  it("额度不足 → 429 且不调用上游（不消耗上游额度）", async () => {
    const ledger = new MemoryLedger({ policy: { userTokens: 10, tenantTokens: 10, sessionTokens: 10 } });
    const h = harness({ handler: () => jsonResponse({}), ledger });
    const response = await h.gateway.handleResponse(request(responses));
    expect(response.kind).toBe("error");
    if (response.kind !== "error") throw new Error("unreachable");
    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe("insufficient_quota");
    expect(h.upstream.calls).toHaveLength(0);
  });

  it("并发闸门串行生效：前一次预占未结算时，同一用户第二次并行调用被拒", async () => {
    const ledger = new MemoryLedger({ policy: { userConcurrency: 1, userTokens: 1_000_000, tenantTokens: 1_000_000, sessionTokens: 1_000_000 } });
    const first = await ledger.tryReserve({ requestId: "req-aaaaaaaa", tenantId: TENANT, userId: USER, sessionId: SESSION, cellId: "cell-1", model: "deepseek-chat", reservedTokens: 100 });
    expect(first.ok).toBe(true);
    const second = await ledger.tryReserve({ requestId: "req-bbbbbbbb", tenantId: TENANT, userId: USER, sessionId: SESSION, cellId: "cell-1", model: "deepseek-chat", reservedTokens: 100 });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.code).toBe("concurrency");
  });

  it("requestId 幂等：重复使用同一 requestId 返回 409，不重复调用上游", async () => {
    const h = harness({ handler: () => jsonResponse(responseBody({ inputTokens: 1, outputTokens: 1 })) });
    await h.gateway.handleResponse(request(responses));
    const again = await h.gateway.handleResponse(request(responses));
    expect(again.kind).toBe("error");
    if (again.kind !== "error") throw new Error("unreachable");
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("request_id_reused");
    expect(h.upstream.calls).toHaveLength(1);
    const snapshot = await h.ledger.usageSnapshot();
    expect(snapshot.entries).toBe(1);
    expect(snapshot.consumedTokens).toBe(2);
  });

  it("结算幂等：重复结算不二次扣减", async () => {
    const ledger = new MemoryLedger();
    await ledger.tryReserve({ requestId: "req-cccccccc", tenantId: TENANT, userId: USER, sessionId: SESSION, cellId: "cell-1", model: "deepseek-chat", reservedTokens: 100 });
    const first = await ledger.consume({ requestId: "req-cccccccc", tenantId: TENANT, consumption: "settled", promptTokens: 10, completionTokens: 20, totalTokens: 30 });
    const second = await ledger.consume({ requestId: "req-cccccccc", tenantId: TENANT, consumption: "settled", promptTokens: 10, completionTokens: 20, totalTokens: 30 });
    expect(first.consumedTokens).toBe(30);
    expect(second.replayed).toBe(true);
    expect(second.consumedTokens).toBe(30);
    const snapshot = await ledger.usageSnapshot();
    expect(snapshot.consumedTokens).toBe(30);
  });

  it("跨租户复用 requestId 被拒绝", async () => {
    const ledger = new MemoryLedger();
    await ledger.tryReserve({ requestId: "req-dddddddd", tenantId: TENANT, userId: USER, sessionId: SESSION, cellId: "cell-1", model: "deepseek-chat", reservedTokens: 100 });
    await expect(
      ledger.consume({ requestId: "req-dddddddd", tenantId: "99999999-9999-4999-8999-999999999999", consumption: "released" }),
    ).rejects.toThrow(/不属于该租户/);
  });
});

describe("模型网关：Responses 流式协议", () => {
  it("转发 response.* 事件并只在 response.completed 后按真实 usage 结算", async () => {
    const h = harness({
      handler: () => sseResponse([
        sse.created(),
        sse.outputItemAdded({ type: "message", role: "assistant", content: [] }),
        sse.textDelta("你好"),
        sse.textDelta("，世界"),
        sse.outputItemDone({ type: "message", role: "assistant", content: [{ type: "output_text", text: "你好，世界" }] }),
        sse.completed({ input_tokens: 12, output_tokens: 34, total_tokens: 46 }),
      ]),
    });
    const response = await h.gateway.handleResponse(request({ ...responses, stream: true }));
    expect(response.kind).toBe("sse");
    if (response.kind !== "sse") throw new Error("unreachable");
    const joined = (await collect(response.stream)).join("");
    expect(joined).toContain("event: response.created");
    expect(joined).toContain("event: response.output_text.delta");
    expect(joined).toContain("event: response.completed");
    expect(joined).toContain("你好");
    const record = h.ledger.inspect("req-00000001");
    expect(record?.outcome).toBe("settled");
    expect(record?.consumedTokens).toBe(46);
  });

  it("流式工具调用：function_call delta/done 原样转发", async () => {
    const h = harness({
      handler: () => sseResponse([
        sse.created(),
        sse.outputItemAdded({ type: "function_call", call_id: "call_1", name: "write_chapter", arguments: "" }),
        sse.functionCallArgumentsDelta("{\"title\":"),
        sse.functionCallArgumentsDelta("\"x\"}"),
        sse.functionCallArgumentsDone("{\"title\":\"x\"}"),
        sse.outputItemDone({ type: "function_call", id: "resp_fake_item", call_id: "call_1", name: "write_chapter", arguments: "{\"title\":\"x\"}" }),
        sse.completed({ input_tokens: 20, output_tokens: 9, total_tokens: 29 }),
      ]),
    });
    const response = await h.gateway.handleResponse(request({ ...responses, stream: true }));
    if (response.kind !== "sse") throw new Error("expected sse");
    const joined = (await collect(response.stream)).join("");
    expect(joined).toContain("event: response.function_call_arguments.delta");
    expect(joined).toContain("event: response.function_call_arguments.done");
    expect(joined).toContain("write_chapter");
    expect(joined).toContain("\"call_id\":\"call_1\"");
    expect(h.ledger.inspect("req-00000001")?.consumedTokens).toBe(29);
  });

  it("流中断（没有 response.completed）→ unknown 并回写 error 事件（绝不推断成功）", async () => {
    const h = harness({ handler: () => sseResponse([sse.created(), sse.textDelta("半句")]) });
    const response = await h.gateway.handleResponse(request({ ...responses, stream: true }));
    if (response.kind !== "sse") throw new Error("expected sse");
    const joined = (await collect(response.stream)).join("");
    expect(joined).toContain("event: error");
    expect(joined).toContain("upstream_truncated");
    expect(h.ledger.inspect("req-00000001")?.outcome).toBe("unknown");
    expect(h.ledger.inspect("req-00000001")?.consumedTokens).toBe(h.ledger.inspect("req-00000001")?.reservedTokens);
  });

  it("response.incomplete → 转发终态但按错误提示，并据实结算已知 usage", async () => {
    const h = harness({ handler: () => sseResponse([sse.created(), sse.textDelta("半句话"), sse.incomplete({ input_tokens: 12, output_tokens: 8, total_tokens: 20 })]) });
    const response = await h.gateway.handleResponse(request({ ...responses, stream: true }));
    if (response.kind !== "sse") throw new Error("expected sse");
    const joined = (await collect(response.stream)).join("");
    expect(joined).toContain("event: response.incomplete");
    expect(joined).toContain("upstream_incomplete");
    expect(joined).not.toContain("upstream_truncated");
    expect(h.ledger.inspect("req-00000001")?.outcome).toBe("settled");
    expect(h.ledger.inspect("req-00000001")?.consumedTokens).toBe(20);
  });

  it("上游 error 事件不原样转发（上游原文不外泄），保守保留预占", async () => {
    const h = harness({ handler: () => sseResponse([sse.created(), sse.providerError("internal stack: sk-secret", "server_error")]) });
    const response = await h.gateway.handleResponse(request({ ...responses, stream: true }));
    if (response.kind !== "sse") throw new Error("expected sse");
    const joined = (await collect(response.stream)).join("");
    expect(joined).toContain("upstream_error");
    expect(joined).not.toContain("sk-secret");
    expect(joined).not.toContain("internal stack");
    expect(h.ledger.inspect("req-00000001")?.outcome).toBe("unknown");
  });

  it("流中途出现不可解析的数据块 → 中止上游并保守保留预占", async () => {
    const h = harness({ handler: () => sseResponse([sse.created(), sse.textDelta("ok"), "event: response.output_text.delta\ndata: {not json}\n\n"]) });
    const response = await h.gateway.handleResponse(request({ ...responses, stream: true }));
    if (response.kind !== "sse") throw new Error("expected sse");
    const joined = (await collect(response.stream)).join("");
    expect(joined).toContain("upstream_protocol_error");
    expect(h.upstream.calls[0]?.aborted).toBe(true);
    expect(h.ledger.inspect("req-00000001")?.outcome).toBe("unknown");
  });

  it("流式也携带 cached/reasoning 元数据（结算按 input+output 全额）", async () => {
    const h = harness({
      handler: () => sseResponse([
        sse.created(),
        sse.textDelta("hi"),
        sse.completed({ input_tokens: 50, output_tokens: 10, total_tokens: 60, input_tokens_details: { cached_tokens: 32 }, output_tokens_details: { reasoning_tokens: 4 } }),
      ]),
    });
    const response = await h.gateway.handleResponse(request({ ...responses, stream: true }));
    if (response.kind !== "sse") throw new Error("expected sse");
    await collect(response.stream);
    expect(h.ledger.inspect("req-00000001")?.consumedTokens).toBe(60);
    expect(h.audit[0]?.cachedTokens).toBe(32);
    expect(h.audit[0]?.reasoningTokens).toBe(4);
  });
});

describe("模型网关：撤权与取消", () => {
  it("流式期间轮询发现撤权 → 中止上游、回写 session_revoked、保守保留预占", async () => {
    let upstreamAborted = () => false;
    const h = harness({
      handler: (input) => {
        const hanging = hangingSseResponse([sse.created(), sse.textDelta("开始")], input.signal);
        upstreamAborted = hanging.upstreamAborted;
        return hanging.response;
      },
    });
    const response = await h.gateway.handleResponse(request({ ...responses, stream: true }));
    if (response.kind !== "sse") throw new Error("expected sse");
    const received: string[] = [];
    const iterator = response.stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (!first.done) received.push(first.value);

    // 撤权发生在流传输中途；轮询（revokePollMs=20）必须发现并中止上游。
    h.store.revokeSession(SESSION);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(h.upstream.calls[0]?.aborted).toBe(true);
    expect(upstreamAborted()).toBe(true);

    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      received.push(next.value);
    }
    expect(received.join("")).toContain("session_revoked");
    expect(h.ledger.inspect("req-00000001")?.outcome).toBe("unknown");
  });

  it("客户端断开 → abort 上游，请求尚未发出时释放预占", async () => {
    const controller = new AbortController();
    const h = harness({ handler: () => jsonResponse({}) });
    controller.abort(new Error("client closed"));
    const response = await h.gateway.handleResponse({ ...request(responses), clientSignal: controller.signal });
    expect(response.kind).toBe("error");
    if (response.kind !== "error") throw new Error("unreachable");
    expect(response.status).toBe(499);
    expect(h.ledger.inspect("req-00000001")?.outcome).toBe("released");
  });
});

describe("模型网关：中文与工具成本、据实结算", () => {
  const hanzi = (count: number) => "中".repeat(count);
  const policy = { bytesPerToken: DEFAULT_BYTES_PER_TOKEN, maxInputTokens: Math.ceil(DEFAULT_LIMITS.maxBodyBytes / DEFAULT_BYTES_PER_TOKEN) };

  it("大中文 prompt：预占按字节完整计算，真实 usage 超额也完整入账", async () => {
    const content = hanzi(40_000);
    const body = { model: "deepseek-chat", input: [{ role: "user", content }] };
    const parsed = parseResponseRequest(body, DEFAULT_LIMITS);
    const expectedReservation = computeReservation(parsed, DEFAULT_LIMITS, policy);
    expect(expectedReservation).toBeGreaterThan(32_768);

    const h = harness({
      handler: () => jsonResponse(responseBody({ inputTokens: 90_000, outputTokens: 30_000 })),
    });
    const response = await h.gateway.handleResponse(request(body, { requestId: "req-cjk-overflow" }));
    expect(response.kind).toBe("json");

    const record = h.ledger.inspect("req-cjk-overflow");
    expect(record?.reservedTokens).toBe(expectedReservation);
    expect(record?.outcome).toBe("settled");
    expect(record?.consumedTokens).toBe(120_000);
    expect(record?.consumedTokens).toBeGreaterThan(record?.reservedTokens ?? 0);
    expect(h.audit[0]?.consumedTokens).toBe(120_000);
  });

  it("超额结算真的收紧后续额度：同一会话的下一次预占被 429", async () => {
    const content = hanzi(40_000);
    const body = { model: "deepseek-chat", input: [{ role: "user", content }] };
    const h = harness({
      handler: () => jsonResponse(responseBody({ inputTokens: 90_000, outputTokens: 30_000 })),
    });
    const first = await h.gateway.handleResponse(request(body, { requestId: "req-cjk-first" }));
    expect(first.kind).toBe("json");
    expect(h.ledger.inspect("req-cjk-first")?.consumedTokens).toBe(120_000);

    const second = await h.gateway.handleResponse(request(body, { requestId: "req-cjk-second" }));
    expect(second.kind).toBe("error");
    if (second.kind !== "error") throw new Error("unreachable");
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe("insufficient_quota");
    expect(second.body.error.message).toContain("120000");
    expect(h.ledger.inspect("req-cjk-second")).toBeUndefined();
    expect(h.upstream.calls).toHaveLength(1);
    expect(h.audit.at(-1)?.status).toBe(429);
  });

  it("tools 的 JSON 成本计入预占", async () => {
    const tools = Array.from({ length: 60 }, (_, index) => ({
      type: "function",
      name: `novel_tool_${index}`,
      description: "写小说工具描述".repeat(20),
      parameters: { type: "object", properties: { body: { type: "string" } } },
    }));
    const body = { model: "deepseek-chat", input: [{ role: "user", content: "写小说" }], tools, tool_choice: "auto" };
    const h = harness({
      handler: () => jsonResponse(responseBody({ inputTokens: 8_000, outputTokens: 100 })),
    });
    await h.gateway.handleResponse(request(body, { requestId: "req-tools-cost" }));
    const record = h.ledger.inspect("req-tools-cost");
    const expected = computeReservation(parseResponseRequest(body, DEFAULT_LIMITS), DEFAULT_LIMITS, policy);
    expect(record?.reservedTokens).toBe(expected);
    expect(record?.reservedTokens).toBeGreaterThan(5_000);
    expect(record?.consumedTokens).toBe(8_100);
  });

  it("断流（unknown）仍按完整预占保守保留，不因估算变大而少扣", async () => {
    const content = hanzi(40_000);
    const h = harness({ handler: () => sseResponse([sse.created(), sse.textDelta("半句")]) });
    const response = await h.gateway.handleResponse(request({ model: "deepseek-chat", input: [{ role: "user", content }], stream: true }, { requestId: "req-cjk-unknown" }));
    if (response.kind !== "sse") throw new Error("expected sse");
    const joined = (await collect(response.stream)).join("");
    expect(joined).toContain("upstream_truncated");
    const record = h.ledger.inspect("req-cjk-unknown");
    expect(record?.outcome).toBe("unknown");
    expect(record?.consumedTokens).toBe(record?.reservedTokens);
    expect(record?.consumedTokens).toBeGreaterThan(32_768);
  });
});

describe("模型网关：账本与审计不存正文与密钥", () => {
  it("审计记录只含计量元数据", async () => {
    const h = harness({ handler: () => jsonResponse(responseBody({ inputTokens: 1, outputTokens: 1 })) });
    await h.gateway.handleResponse(request({ ...responses, input: [{ role: "user", content: "绝密正文-不要落库" }] }));
    const serialized = JSON.stringify(h.audit);
    expect(serialized).not.toContain("绝密正文");
    expect(serialized).not.toContain("sk-test-upstream");
    expect(h.audit[0]?.promptTokens).toBe(1);
  });
});
