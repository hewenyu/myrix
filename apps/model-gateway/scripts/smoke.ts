#!/usr/bin/env tsx
/**
 * 端到端冒烟：本机起一个**真实 HTTP** 假上游 + 真实 Fastify 网关，用真实 fetch 打通
 * `/v1/responses` 的流式与非流式路径（OpenAI Responses，无 chat/completions 回退）。
 *
 *   tsx apps/model-gateway/scripts/smoke.ts
 *
 * 目的：验证"配置 → HTTP 边界 → 鉴权 → 预占 → 真实网络调用 → Responses SSE 转发 → 结算"
 * 整条链路，而不只是模块级单测。假上游只在本脚本进程内存在，不是生产降级路径。
 */
import { createServer } from "node:http";
import { createAuthorizer } from "../src/authorize";
import { resolveGatewayConfig } from "../src/config";
import { createGatewayRuntime } from "../src/factory";
import { MemoryLedger } from "../src/ledger";
import { MemoryAuthorizerStore } from "../src/authorize";
import { createModelGatewayServer } from "../src/server";

const TOKEN = "smoke-cell-token-0123456789ab";
const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const SESSION = "smoke-session";
const REV = 4;
const RESPONSE_ID = "resp_smoke";

const event = (name: string, payload: unknown): string => `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;

function fakeUpstream(): Promise<{ url: string; close: () => Promise<void>; calls: unknown[]; hungUpstreams: boolean[] }> {
  const calls: unknown[] = [];
  const hungUpstreams: boolean[] = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += String(chunk);
    });
    request.on("end", () => {
      const body = JSON.parse(raw) as { stream?: boolean; model?: string; instructions?: string; input?: Array<{ content?: unknown }> };
      calls.push({ model: body.model, auth: request.headers.authorization, body });
      if (body.instructions === "hang") {
        // 慢上游：用于验证客户端断开时网关是否真的取消了上游连接。
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(event("response.created", { type: "response.created", response: { id: RESPONSE_ID, status: "in_progress" } }));
        response.write(event("response.output_text.delta", { type: "response.output_text.delta", delta: "慢" }));
        request.on("close", () => {
          hungUpstreams.push(true);
        });
        return;
      }
      if (body.stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(event("response.created", { type: "response.created", response: { id: RESPONSE_ID, status: "in_progress" } }));
        response.write(event("response.output_text.delta", { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "你" }));
        response.write(event("response.output_text.delta", { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "好" }));
        response.write(event("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "你好" }] } }));
        response.write(event("response.completed", { type: "response.completed", response: { id: RESPONSE_ID, status: "completed", usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 } } }));
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: RESPONSE_ID,
        object: "response",
        status: "completed",
        model: body.model,
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "很久以前" }] }],
        usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15 },
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("无法获取假上游端口");
      resolve({
        url: `http://127.0.0.1:${address.port}/v1/responses`,
        calls,
        hungUpstreams,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const upstream = await fakeUpstream();
process.env.MYRIX_GATEWAY_UPSTREAM_URL = upstream.url;
process.env.MYRIX_GATEWAY_UPSTREAM_MODEL = "deepseek-chat";
process.env.MYRIX_GATEWAY_UPSTREAM_API_KEY = "sk-smoke-key";
process.env.MYRIX_GATEWAY_MODEL_ALLOWLIST = "deepseek-chat";
process.env.MYRIX_GATEWAY_REVOKE_POLL_MS = "200";

const config = resolveGatewayConfig(process.env);
const store = new MemoryAuthorizerStore({
  credentials: { [TOKEN]: { tenantId: TENANT, cellId: "cell-smoke" } },
  sessions: [{ sessionId: SESSION, tenantId: TENANT, ownerUserId: USER, cellId: "cell-smoke", status: "active", revision: REV }],
  members: [{ tenantId: TENANT, userId: USER, status: "active", role: "member" }],
});
const ledger = new MemoryLedger();
const runtime = createGatewayRuntime({ config, authorizer: createAuthorizer(store), ledger });
const server = await createModelGatewayServer({ gateway: runtime.gateway, bodyLimitBytes: config.limits.maxBodyBytes });
const base = await server.listen({ port: 0, host: "127.0.0.1" });

const headers = {
  authorization: `Bearer ${TOKEN}`,
  "x-myrix-session": SESSION,
  "x-myrix-revision": String(REV),
  "content-type": "application/json",
  // 故意伪造归因/诊断头：必须被忽略。
  "x-myrix-tenant": "attacker",
  "x-myrix-user": "attacker-user",
  "x-myrix-purpose": "compaction",
};
const responses = { model: "deepseek-chat", input: [{ role: "user", content: [{ type: "input_text", text: "写一段小说" }] }] };

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

// 1) 非流式
const jsonResponse = await fetch(`${base}/v1/responses`, { method: "POST", headers, body: JSON.stringify(responses) });
const jsonBody = (await jsonResponse.json()) as { status?: string; output?: Array<{ content: Array<{ text: string }> }> };
check("非流式 200 + Responses 正文", jsonResponse.status === 200 && jsonBody.status === "completed" && jsonBody.output?.[0]?.content[0]?.text === "很久以前", `status=${jsonResponse.status}`);

// 2) 流式
const streamResponse = await fetch(`${base}/v1/responses`, {
  method: "POST",
  headers: { ...headers, "x-request-id": "smoke-stream-0001" },
  body: JSON.stringify({ ...responses, stream: true }),
});
const streamText = await streamResponse.text();
check("流式 200 + text/event-stream", streamResponse.status === 200 && (streamResponse.headers.get("content-type") ?? "").includes("text/event-stream"));
check("Responses 事件透传", streamText.includes("event: response.output_text.delta") && streamText.includes("event: response.completed") && streamText.includes("你") && streamText.includes("好"));
check("上游只收到 Responses 形状（无 messages/stream_options）", JSON.stringify(upstream.calls[1]).includes("\"input\"") && !JSON.stringify(upstream.calls[1]).includes("\"messages\""));

// 3) 旧协议必须 404（禁止 chat/completions，无兼容回退）
const legacy = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: "hi" }] }) });
check("旧 chat/completions → 404（无兼容回退）", legacy.status === 404, `status=${legacy.status}`);

// 4) 缺密钥 → 503（真实请求路径，不降级）
const noKeyRuntime = createGatewayRuntime({
  config: resolveGatewayConfig({ ...process.env, MYRIX_GATEWAY_UPSTREAM_API_KEY: "" }),
  authorizer: createAuthorizer(store),
  ledger: new MemoryLedger(),
});
const noKeyServer = await createModelGatewayServer({ gateway: noKeyRuntime.gateway, bodyLimitBytes: config.limits.maxBodyBytes });
const noKeyBase = await noKeyServer.listen({ port: 0, host: "127.0.0.1" });
const noKey = await fetch(`${noKeyBase}/v1/responses`, { method: "POST", headers, body: JSON.stringify(responses) });
check("缺密钥 503 model_not_configured", noKey.status === 503 && ((await noKey.json()) as { error: { code: string } }).error.code === "model_not_configured");

// 5) 正常会话可调用（对照组）
const forged = await fetch(`${base}/v1/responses`, { method: "POST", headers, body: JSON.stringify(responses) });
check("正常会话可调用（对照组）", forged.status === 200);

// 6) 结算：真实 usage 生效
const record = ledger.inspect("smoke-stream-0001");
check("流式按真实 Responses usage 结算", record?.outcome === "settled" && record.consumedTokens === 9, `outcome=${record?.outcome} consumed=${record?.consumedTokens}`);
check("上游只被真实 HTTP 请求触达（3 次成功调用）", upstream.calls.length === 3, `calls=${upstream.calls.length}`);
check("上游收到的是部署配置里的密钥与模型", JSON.stringify(upstream.calls[0]).includes("sk-smoke-key") && JSON.stringify(upstream.calls[0]).includes("deepseek-chat"));

// 7) 客户端读流途中断开 → 网关必须 abort 上游连接（否则继续烧额度）
const controller = new AbortController();
const hangResponse = await fetch(`${base}/v1/responses`, {
  method: "POST",
  headers: { ...headers, "x-request-id": "smoke-hang-0001" },
  body: JSON.stringify({ ...responses, stream: true, instructions: "hang" }),
  signal: controller.signal,
});
check("慢上游已开始返回", hangResponse.status === 200);
const reader = hangResponse.body?.getReader();
await reader?.read();
controller.abort();
await new Promise((resolve) => setTimeout(resolve, 300));
check("客户端断开后上游连接被取消", upstream.hungUpstreams.length === 1, `hung=${upstream.hungUpstreams.length}`);
check("断开的那次按未知用量保守保留预占", ledger.inspect("smoke-hang-0001")?.outcome === "unknown", `outcome=${ledger.inspect("smoke-hang-0001")?.outcome}`);

await noKeyServer.close();
await server.close();
await upstream.close();

if (failures.length > 0) {
  console.error(`\n冒烟失败：${failures.join("、")}`);
  process.exit(1);
}
console.log("\n冒烟通过：真实 HTTP 链路（Responses 流式 / 非流式 / 旧协议 404 / 缺密钥 503 / 真实 usage 结算）全部符合预期。");
