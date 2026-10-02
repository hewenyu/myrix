/**
 * `/v1/responses` 流式路径的**背压**回归测试（真实 HTTP 连接 + 真实 TCP socket）。
 *
 * 为什么必须用真实连接：缺陷只在 socket 缓冲真的写满时出现 —— `raw.write()` 返回
 * `false` 而旧实现忽略它，于是网关继续全速消费上游、Node 写缓冲无限增长（一个不读
 * 响应的客户端就能吃光进程内存）。`server.inject()` 是内存内的假连接，永远不会让
 * `write()` 返回 false，因此复现不了。
 *
 * 这里用 `net.connect` 直接建 TCP 连接：读到响应头后**暂停读取**（不再 resume），
 * 内核接收窗口关闭 → 服务端发送缓冲写满 → `write()` 返回 false。
 *
 * 覆盖：
 *   1. 慢消费者：上游分片被拉取的数量**有界**（暂停后不再增长），证明网关在等 drain
 *      而不是无视背压把整个上游流抽干；
 *   2. 连接保持时**不**因背压中止上游（只暂停消费，不误判成断线）；
 *   3. 消费者最终断开：立即中止上游、取消上游 reader，并且**不继续消费**；
 *   4. 结算语义不变：请求已经到达上游 + 客户端断开 → `unknown`（保守保留预占），
 *      不是 `settled`，也不是 `released`；
 *   5. **背压期间发生 gateway 内部上游超时**（真实定时器，不是手动 abort server signal）：
 *      写循环必须被唤醒、iterator `finally` 结算、响应 `end()`，不再永久挂死；
 *   6. 每个连接收尾后 `'drain'`/`'close'`/`'error'` 监听器总量不随请求数增长（无泄漏）。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { getEventListeners } from "node:events";
import type { ServerResponse } from "node:http";
import net from "node:net";
import { createAuthorizer, MemoryAuthorizerStore } from "../src/authorize";
import { DEFAULT_LIMITS, type GatewayConfig } from "../src/config";
import { ModelGateway, type GatewayAuditRecord } from "../src/gateway";
import { MemoryLedger } from "../src/ledger";
import { createModelGatewayServer } from "../src/server";
import { FakeUpstream } from "./fakes";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const SESSION = "sess-backpressure";
const TOKEN = "cell-token-backpressure-01";
const REV = 3;
const REQUEST_ID = "bp-regression-0001";

/** 每个上游 SSE 事件约 64 KiB：足以在一两次 write 之内触发背压。 */
const DELTA_BYTES = 64 * 1024;
/** 上游最多提供 512 个分片（约 32 MiB）。旧实现会把它全部抽干。 */
const MAX_UPSTREAM_CHUNKS = 512;
/** 背压生效时，暂停读取后允许被拉取的分片数上界（远小于总片数）。 */
const MAX_PULLED_CHUNKS = 64;

const servers: FastifyInstance[] = [];
const sockets: net.Socket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询等待条件成立；超时返回 false（由调用方断言，避免测试永久挂住）。 */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(20);
  }
  return predicate();
}

/**
 * 一个"分片可以无限供给（有上限）"的上游 SSE 响应：
 * `pull` 计数器证明调用方到底消费了多少上游，`cancel` 证明连接真的被释放。
 */
function countingUpstream(): {
  handler: () => Response;
  pulled: () => number;
  cancelled: () => boolean;
} {
  let pulled = 0;
  let cancelled = false;
  const encoder = new TextEncoder();
  const frame = (index: number): string => {
    const delta = "x".repeat(DELTA_BYTES);
    return `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", sequence_number: index, output_index: 0, item_id: "item", content_index: 0, delta })}\n\n`;
  };
  return {
    pulled: () => pulled,
    cancelled: () => cancelled,
    handler: () => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          // 注意：这里**不 close**。真实上游在生成期间保持打开，网关必须能中止它。
          if (pulled >= MAX_UPSTREAM_CHUNKS) return;
          pulled += 1;
          controller.enqueue(encoder.encode(frame(pulled)));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  };
}

async function setup(options: { upstreamTimeoutMs?: number; revokePollMs?: number } = {}): Promise<{
  server: FastifyInstance;
  upstream: FakeUpstream;
  pulled: () => number;
  cancelled: () => boolean;
  ledger: MemoryLedger;
  audit: GatewayAuditRecord[];
  port: number;
}> {
  const counting = countingUpstream();
  const upstream = new FakeUpstream({ handler: counting.handler });
  const ledger = new MemoryLedger();
  const store = new MemoryAuthorizerStore({
    credentials: { [TOKEN]: { tenantId: TENANT, cellId: "cell-bp" } },
    sessions: [{ sessionId: SESSION, tenantId: TENANT, ownerUserId: USER, cellId: "cell-bp", status: "active", revision: REV }],
    members: [{ tenantId: TENANT, userId: USER, status: "active", role: "member" }],
  });
  const config: GatewayConfig = {
    host: "127.0.0.1",
    port: 0,
    upstream: { url: "https://upstream.invalid/v1/responses", model: "deepseek-chat", apiKey: "sk-test" },
    modelAllowlist: ["deepseek-chat"],
    limits: {
      ...DEFAULT_LIMITS,
      revokePollMs: options.revokePollMs ?? 50,
      upstreamTimeoutMs: options.upstreamTimeoutMs ?? 3_000,
    },
    credentialSource: "port",
    envCredentials: {},
  };
  const audit: GatewayAuditRecord[] = [];
  const gateway = new ModelGateway({ config, authorizer: createAuthorizer(store), ledger, upstream, audit: { record: (entry) => void audit.push(entry) } });
  const server = await createModelGatewayServer({ gateway, bodyLimitBytes: config.limits.maxBodyBytes });
  servers.push(server);
  const address = await server.listen({ port: 0, host: "127.0.0.1" });
  const port = Number(new URL(address).port);
  return { server, upstream, pulled: counting.pulled, cancelled: counting.cancelled, ledger, audit, port };
}

/** 上游"正在生成"的替身：只有 signal abort 才会让这个在途调用结束。 */
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const abort = (): void => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * 发出流式请求；读到响应头后暂停读取（制造背压）。
 *
 * `awaitHeader: false` 用于"响应头还没回来就断线"的用例 —— 此时不能等 `'data'`
 * （要等 502/超时才来），必须在 `'connect'` 后按调用方的时序挂断。
 */
async function openSlowConsumer(port: number, options: { awaitHeader?: boolean } = {}): Promise<{ socket: net.Socket; header: string }> {
  const payload = JSON.stringify({
    model: "deepseek-chat",
    stream: true,
    input: [{ role: "user", content: [{ type: "input_text", text: "写一段小说" }] }],
  });
  const request =
    `POST /v1/responses HTTP/1.1\r\n` +
    `host: 127.0.0.1:${String(port)}\r\n` +
    `authorization: Bearer ${TOKEN}\r\n` +
    `x-myrix-session: ${SESSION}\r\n` +
    `x-myrix-revision: ${String(REV)}\r\n` +
    `x-request-id: ${REQUEST_ID}\r\n` +
    `content-type: application/json\r\n` +
    `content-length: ${String(Buffer.byteLength(payload))}\r\n` +
    `connection: keep-alive\r\n\r\n${payload}`;

  const socket = net.connect({ port, host: "127.0.0.1" });
  sockets.push(socket);
  socket.setNoDelay(true);

  if (options.awaitHeader === false) {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.write(request);
        resolve();
      });
    });
    return { socket, header: "" };
  }

  const header = await new Promise<string>((resolve, reject) => {
    let buffered = "";
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString("latin1");
      const end = buffered.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.off("data", onData);
      // 立刻暂停：不再读，让服务端发送缓冲写满。
      socket.pause();
      resolve(buffered.slice(0, end));
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.once("connect", () => socket.write(request));
  });
  return { socket, header };
}

describe("模型网关 SSE 背压（真实 HTTP）", () => {
  it(
    "慢消费者：上游消费量有界（等 drain），断开后立即中止上游并取消 reader",
    async () => {
      const { upstream, pulled, cancelled, ledger, port } = await setup();
      const { socket, header } = await openSlowConsumer(port);

      expect(header).toContain("200");
      expect(header.toLowerCase()).toContain("text/event-stream");

      // 等背压真正生效：先给一小段写入时间，再取两次采样。
      await sleep(250);
      const firstSample = pulled();
      await sleep(400);
      const secondSample = pulled();

      // 关键回归：暂停读取之后，上游**不再被继续消费**（旧实现会一路抽干到 512 片）。
      expect(firstSample).toBeGreaterThan(0);
      expect(secondSample).toBe(firstSample);
      expect(secondSample).toBeLessThanOrEqual(MAX_PULLED_CHUNKS);
      expect(cancelled()).toBe(false);
      expect(upstream.calls[0]?.aborted).toBe(false);

      // 消费者真的断开 → 立即中止上游、取消上游 reader，结算按既有语义。
      socket.destroy();
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && !(cancelled() && upstream.calls[0]?.aborted === true)) await sleep(20);
      expect(upstream.calls[0]?.aborted).toBe(true);
      expect(cancelled()).toBe(true);

      // 结算语义不变：请求已到达上游 + 客户端断开 → unknown（保守保留预占）。
      const settleDeadline = Date.now() + 2_000;
      while (Date.now() < settleDeadline && ledger.inspect(REQUEST_ID)?.outcome === "pending") await sleep(20);
      expect(ledger.inspect(REQUEST_ID)?.outcome).toBe("unknown");

      // 继续观察已结束连接，账本不会被迟到的清理重复结算成别的结果。
      await sleep(1_000);
      expect(ledger.inspect(REQUEST_ID)?.outcome).toBe("unknown");
    },
    15_000,
  );

  it(
    "背压期间 gateway 内部上游超时（真实定时器）→ 唤醒写循环、结算、end()，不再永久挂死",
    async () => {
      // 内部 timeout 用**真实定时器**触发（不是手动 abort server 的 client controller）：
      // 这是 issue 的核心缺口 —— 旧实现里 writer 只监听 server 侧的 client controller，
      // gateway 内部 timeout/撤权只向内传播，唤不醒等 drain 的写循环。
      const { server, upstream, pulled, cancelled, ledger, audit, port } = await setup({
        upstreamTimeoutMs: 400,
        revokePollMs: 60_000,
      });
      const captured: ServerResponse[] = [];
      server.server.on("request", (_request, response) => captured.push(response));

      const { socket } = await openSlowConsumer(port);
      await sleep(250);

      // 先确认背压真的生效：上游已被拉到一定量后停住，且此时没有任何中止。
      const beforeTimeout = pulled();
      expect(beforeTimeout).toBeGreaterThan(0);
      expect(upstream.calls[0]?.aborted).toBe(false);
      expect(cancelled()).toBe(false);

      // 关键回归：timeout 必须唤醒 writer → 写循环 break → iterator finally 结算。
      // 旧实现下账本会永远停在 pending（实测复现）。
      const settled = await waitFor(() => ledger.inspect(REQUEST_ID)?.outcome !== "pending", 4_000);
      expect(settled, "内部超时后账本必须结算，而不是永远 pending").toBe(true);
      expect(ledger.inspect(REQUEST_ID)?.outcome).toBe("unknown");
      expect(upstream.calls[0]?.aborted).toBe(true);
      expect(cancelled()).toBe(true);

      // 写循环被唤醒并收尾：响应真的 end()（旧实现这里永远为 false，连接挂死）。
      const ended = await waitFor(() => captured[0]?.writableEnded === true, 2_000);
      expect(ended, "内部超时后响应必须 end()，不能永久挂起").toBe(true);

      // 结算原因是"上游超时中止"：连接一直保持，不是客户端断线。
      const record = audit.at(-1);
      expect(record?.outcome).toBe("unknown");
      expect(record?.reason).toContain("上游超时");
      expect(record?.reason).not.toContain("客户端");

      // 超时之后不再继续消费上游。
      const after = pulled();
      await sleep(200);
      expect(pulled()).toBe(after);

      socket.destroy();
    },
    15_000,
  );

  it(
    "客户端在 handleResponse 等待上游响应头期间断开 → 立刻取消上游（不等流开始写）",
    async () => {
      // 上游先"思考"一段时间才返回响应头；客户端在等待期间就挂断。替身按真实 fetch
      // 语义建模：signal abort 时**在途请求立即以 AbortError 拒绝**（否则测试替身会
      // 一直 return 一个已经没人要的 Response，根本观察不到取消）。
      //
      // 请求侧 'aborted' 只在请求体没读完时触发，正文已读完后不会再触发；旧实现要等
      // handleResponse 返回才挂响应侧 'close'，会漏掉这次断线（流继续拉、额度继续烧）。
      const upstream = new FakeUpstream({        handler: (input) =>
          // 上游"还在生成"：只有 signal abort 才会让这个在途调用结束，等价于真实
          // fetch 在 abort 时让在途请求以 AbortError 拒绝。若客户端断线没能传导，
          // 测试自己的 15s 超时会让回归失败（不会把进程挂死）。
          untilAborted(input.signal),
      });
      const ledger = new MemoryLedger();
      const store = new MemoryAuthorizerStore({
        credentials: { [TOKEN]: { tenantId: TENANT, cellId: "cell-bp" } },
        sessions: [{ sessionId: SESSION, tenantId: TENANT, ownerUserId: USER, cellId: "cell-bp", status: "active", revision: REV }],
        members: [{ tenantId: TENANT, userId: USER, status: "active", role: "member" }],
      });
      const config: GatewayConfig = {
        host: "127.0.0.1",
        port: 0,
        upstream: { url: "https://upstream.invalid/v1/responses", model: "deepseek-chat", apiKey: "sk-test" },
        modelAllowlist: ["deepseek-chat"],
        limits: { ...DEFAULT_LIMITS, revokePollMs: 60_000, upstreamTimeoutMs: 30_000 },
        credentialSource: "port",
        envCredentials: {},
      };
      const gateway = new ModelGateway({ config, authorizer: createAuthorizer(store), ledger, upstream });
      const server = await createModelGatewayServer({ gateway, bodyLimitBytes: config.limits.maxBodyBytes });
      servers.push(server);
      const address = await server.listen({ port: 0, host: "127.0.0.1" });
      const port = Number(new URL(address).port);

      // 客户端在响应头回来之前就挂断（不等 'data'，否则就等成了 502/超时）。
      const { socket } = await openSlowConsumer(port, { awaitHeader: false });
      expect(await waitFor(() => upstream.calls.length === 1, 1_000)).toBe(true);
      socket.destroy();
      const abortedUpstream = await waitFor(() => upstream.calls[0]?.aborted === true, 2_000);
      expect(abortedUpstream, "handleResponse 等待期间的客户端断线必须取消上游").toBe(true);
      const settled = await waitFor(() => ledger.inspect(REQUEST_ID)?.outcome !== "pending", 3_000);
      expect(settled).toBe(true);
      // 客户端还没到达上游就被取消 → 释放预占（既有语义，见 gateway 的 upstreamStarted 分支）。
      expect(ledger.inspect(REQUEST_ID)?.outcome).toBe("released");
    },
    15_000,
  );

  it(
    "读取慢但连接保持：不会因为背压而中止上游（只暂停消费）",
    async () => {
      const { upstream, pulled, cancelled, port } = await setup();
      const { socket } = await openSlowConsumer(port);
      await sleep(400);

      // 连接还在，上游既没被中止也没被取消；只是被背压挡住不再拉取。
      expect(upstream.calls[0]?.aborted).toBe(false);
      expect(cancelled()).toBe(false);
      const sample = pulled();
      await sleep(200);
      expect(pulled()).toBe(sample);

      socket.destroy();
      await sleep(100);
    },
    15_000,
  );

  it(
    "每个连接的事件监听器在收尾后摘掉（不随请求数泄漏）",
    async () => {
      const { server, port } = await setup();
      // 记录每个请求的 ServerResponse，收尾后检查其上的 drain/close/error 监听器。
      // 用 node:http 的 'request' 事件（listen 之后仍可挂）而不是 Fastify addHook。
      const captured: Array<import("node:http").ServerResponse> = [];
      server.server.on("request", (_request, response) => {
        captured.push(response);
      });

      const listenerTotal = (): number =>
        captured.reduce(
          (sum, raw) =>
            sum +
            getEventListeners(raw, "drain").length +
            getEventListeners(raw, "close").length +
            getEventListeners(raw, "error").length,
          0,
        );

      const runSlowRequest = async (): Promise<void> => {
        const { socket } = await openSlowConsumer(port);
        await sleep(150);
        socket.destroy();
        await sleep(150);
      };

      await runSlowRequest();
      const baseline = listenerTotal();
      await runSlowRequest();
      await runSlowRequest();

      // 三次请求之后监听器总量不增长：每次收尾都摘掉了自己的 drain/close/error。
      expect(listenerTotal()).toBe(baseline);
      expect(captured.length).toBe(3);
    },
    15_000,
  );
});
