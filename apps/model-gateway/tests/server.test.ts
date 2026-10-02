import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createAuthorizer, MemoryAuthorizerStore } from "../src/authorize";
import { DEFAULT_LIMITS, type GatewayConfig } from "../src/config";
import { ModelGateway } from "../src/gateway";
import { MemoryLedger } from "../src/ledger";
import { createModelGatewayServer } from "../src/server";
import { FakeUpstream, hangingSseResponse, jsonResponse, responseBody, sse, sseResponse } from "./fakes";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const SESSION = "sess-http";
const TOKEN = "cell-token-fedcba9876543210";
const REV = 3;

const servers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function setup(options: { handler: ConstructorParameters<typeof FakeUpstream>[0]["handler"]; configured?: boolean; bodyLimitBytes?: number; upstreamTimeoutMs?: number }) {
  const upstream = new FakeUpstream({ handler: options.handler, ...(options.configured === undefined ? {} : { configured: options.configured }) });
  const store = new MemoryAuthorizerStore({
    credentials: { [TOKEN]: { tenantId: TENANT, cellId: "cell-http" } },
    sessions: [{ sessionId: SESSION, tenantId: TENANT, ownerUserId: USER, cellId: "cell-http", status: "active", revision: REV }],
    members: [{ tenantId: TENANT, userId: USER, status: "active", role: "member" }],
  });
  const config: GatewayConfig = {
    host: "127.0.0.1",
    port: 0,
    upstream: { url: "https://upstream.invalid/v1/responses", model: "deepseek-chat", apiKey: "sk-test" },
    modelAllowlist: ["deepseek-chat"],
    limits: { ...DEFAULT_LIMITS, revokePollMs: 50, upstreamTimeoutMs: options.upstreamTimeoutMs ?? DEFAULT_LIMITS.upstreamTimeoutMs },
    credentialSource: "port",
    envCredentials: {},
  };
  const gateway = new ModelGateway({ config, authorizer: createAuthorizer(store), ledger: new MemoryLedger(), upstream });
  const server = await createModelGatewayServer({
    gateway,
    bodyLimitBytes: options.bodyLimitBytes ?? config.limits.maxBodyBytes,
  });
  servers.push(server);
  return { server, upstream };
}

const headers = { authorization: `Bearer ${TOKEN}`, "x-myrix-session": SESSION, "x-myrix-revision": String(REV), "content-type": "application/json" };
const responses = { model: "deepseek-chat", input: [{ role: "user", content: [{ type: "input_text", text: "写一段小说" }] }] };

describe("HTTP 边界（OpenAI Responses）", () => {
  it.each([
    ["event: response.output_text.delta\ndata: not-json\n\n", "upstream_protocol_error"],
    ["event: error\ndata: {\"message\":\"private upstream secret\"}\n\n", "upstream_error"],
  ])("内部中止仍向正常读者发送脱敏错误帧：%s", async (frame, code) => {
    const { server, upstream } = await setup({ handler: () => sseResponse([frame]) });
    const response = await server.inject({ method: "POST", url: "/v1/responses", headers, payload: { ...responses, stream: true } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: error");
    expect(response.body).toContain(code);
    expect(response.body).not.toContain("private upstream secret");
    expect(upstream.calls[0]?.aborted).toBe(true);
  });

  it("上游超时后正常读者仍收到终态错误，而不是静默断流", async () => {
    const { server } = await setup({
      upstreamTimeoutMs: 30,
      handler: ({ signal }) => hangingSseResponse([sse.created()], signal).response,
    });
    const response = await server.inject({ method: "POST", url: "/v1/responses", headers, payload: { ...responses, stream: true } });
    expect(response.body).toContain("upstream_timeout");
  });

  it("缺上游密钥 → 503 且响应体是 OpenAI 错误形状", async () => {
    const { server } = await setup({ handler: () => jsonResponse({}), configured: false });
    const response = await server.inject({ method: "POST", url: "/v1/responses", headers, payload: responses });
    expect(response.statusCode).toBe(503);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("model_not_configured");
  });

  it("非流式成功返回上游 Responses JSON", async () => {
    const { server } = await setup({ handler: () => jsonResponse(responseBody({ text: "很久以前" })) });
    const response = await server.inject({ method: "POST", url: "/v1/responses", headers, payload: responses });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ status: string; output: Array<{ content: Array<{ text: string }> }> }>();
    expect(body.status).toBe("completed");
    expect(body.output[0]?.content[0]?.text).toBe("很久以前");
  });

  it("流式返回 text/event-stream 并逐事件输出；正常读完不会误判成客户端断线", async () => {
    const { server, upstream } = await setup({
      handler: () => sseResponse([sse.created(), sse.textDelta("你"), sse.textDelta("好"), sse.completed({ input_tokens: 2, output_tokens: 3, total_tokens: 5 })]),
    });
    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: { ...responses, stream: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("event: response.completed");
    expect(response.body).toContain("event: response.output_text.delta");
    // 关键回归：请求体读完/响应正常结束时不能 abort 上游（曾因监听 request 'close' 误伤）。
    expect(upstream.calls[0]?.aborted).toBe(false);
    expect(response.body).not.toContain("client_aborted");
  });

  it("请求体超过上限 → 413", async () => {
    const { server } = await setup({ handler: () => jsonResponse({}), bodyLimitBytes: 512 });
    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: { ...responses, input: [{ role: "user", content: "x".repeat(2000) }] },
    });
    expect(response.statusCode).toBe(413);
  });

  it("请求未通过鉴权（缺 rev）→ 400，且不触达上游", async () => {
    const { server, upstream } = await setup({ handler: () => jsonResponse({}) });
    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${TOKEN}`, "x-myrix-session": SESSION, "content-type": "application/json" },
      payload: responses,
    });
    expect(response.statusCode).toBe(400);
    expect(upstream.calls).toHaveLength(0);
  });

  it("请求头里的 tenant/user 归因被忽略", async () => {
    const { server, upstream } = await setup({
      handler: () => jsonResponse(responseBody({ inputTokens: 1, outputTokens: 1 })),
    });
    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { ...headers, "x-myrix-tenant": "attacker", "x-myrix-user": "attacker-user", "x-myrix-purpose": "compaction" },
      payload: responses,
    });
    expect(response.statusCode).toBe(200);
    expect(upstream.calls).toHaveLength(1);
    expect(Object.keys(upstream.calls[0]?.body ?? {})).not.toContain("x-myrix-tenant");
  });

  it("/readyz 报告配置状态但不泄露密钥；/v1/models 只列 allowlist", async () => {
    const { server } = await setup({ handler: () => jsonResponse({}), configured: false });
    const ready = await server.inject({ method: "GET", url: "/readyz" });
    expect(ready.statusCode).toBe(503);
    expect(ready.body).not.toContain("sk-");
    const models = await server.inject({ method: "GET", url: "/v1/models" });
    expect(models.json<{ data: Array<{ id: string }> }>().data.map((item) => item.id)).toEqual(["deepseek-chat"]);
  });
});

describe("HTTP 边界：旧协议必须 404（禁止 chat/completions，无兼容回退）", () => {
  it("POST /v1/chat/completions → 404，且不触达上游、不产生预占", async () => {
    const { server, upstream } = await setup({ handler: () => jsonResponse(responseBody()) });
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers,
      payload: { model: "deepseek-chat", messages: [{ role: "user", content: "写一段小说" }] },
    });
    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("not_found");
    expect(body.error.message).toContain("/v1/responses");
    expect(upstream.calls).toHaveLength(0);
  });

  it("旧协议的其它变体与旧字段也都是 404（没有隐式转换）", async () => {
    const { server, upstream } = await setup({ handler: () => jsonResponse(responseBody()) });
    for (const url of ["/v1/chat/completions", "/v1/completions", "/chat/completions", "/v1/responses/legacy"]) {
      const response = await server.inject({ method: "POST", url, headers, payload: responses });
      expect(response.statusCode, url).toBe(404);
    }
    expect(upstream.calls).toHaveLength(0);
  });

  it("把 Responses 请求发到旧路径也是 404：不存在内部改写", async () => {
    const { server, upstream } = await setup({ handler: () => jsonResponse(responseBody()) });
    const response = await server.inject({ method: "POST", url: "/v1/chat/completions", headers, payload: responses });
    expect(response.statusCode).toBe(404);
    expect(upstream.calls).toHaveLength(0);
  });

  it("旧协议字段（messages/max_tokens）走新路径 → 400，绝不静默改用 chat 形状", async () => {
    const { server, upstream } = await setup({ handler: () => jsonResponse(responseBody()) });
    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: { model: "deepseek-chat", messages: [{ role: "user", content: "hi" }], max_tokens: 10 },
    });
    expect(response.statusCode).toBe(400);
    expect(upstream.calls).toHaveLength(0);
  });
});
