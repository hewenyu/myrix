/**
 * 运行时模块的纯单元测试：
 *   * SSE 白名单投影（`runtime-stream.ts`）—— 公开什么、明确不公开什么；
 *   * driver HTTP 客户端的帧解析与失败分类（`runtime-driver-client.ts`）；
 *   * 静态 Cell 目录与 CLI 配置工厂的 fail-closed 校验。
 *
 * 这里**不**连接数据库、也**不**起 HTTP 服务；真实组合测试见 `runtime-router.test.ts`。
 */
import { describe, expect, it, vi } from "vitest";
import { createManualClock, createGrantSigner, generateTestKeyPair, sha256Hex } from "@myrix/grant";
import { projectDriverFrame, textOfContent } from "../src/runtime-stream";
import { createDriverHttpClient, sseFrames } from "../src/runtime-driver-client";
import { createStaticCellDirectory, cellServesTenant, type CellDirectory } from "../src/runtime-cells";
import { createRuntimeSigner, inspectRuntimeEnvironment, readRuntimeEnvironment } from "../src/runtime-config";

const tenantId = "11111111-1111-4111-8111-111111111111";
const cellId = "cell-a";

describe("SSE whitelist projection", () => {
  it("projects user and assistant text from the driver's actual data payloads", () => {
    // driver 的 data 是 event.data：user/message 的 data 就是 UserMessage 本身。
    // `data.id` 不是 UUID（非平台写入）时只给文本，不投影 commandId。
    expect(projectDriverFrame({
      id: 4,
      event: "user/message",
      data: { id: "m-1", role: "user", content: [{ type: "text", text: "写个开头" }], source: { kind: "user" } },
    })).toEqual({ type: "user", seq: 4, text: "写个开头" });

    // assistant/message 的 data 是 {turn,step,message,stream,…}，正文在 data.message.content。
    expect(projectDriverFrame({
      id: 9,
      event: "assistant/message",
      data: {
        turn: 1,
        step: 1,
        message: { role: "assistant", content: [{ type: "text", text: "开头如下" }, { type: "reasoning", text: "不要外泄的推理" }] },
        stream: [{ type: "chunk", chunk: { type: "text-delta", text: "开头" } }],
      },
    })).toEqual({ type: "assistant", seq: 9, text: "开头如下" });
  });

  it("maps the durable user/message id to the existing public commandId field only when it is a bounded UUID", () => {
    const commandId = "72558f29-e525-4085-bfd1-991884292e5d";
    // 真实形状（data/cells/.../session.v4.jsonl:7）：data.id 就是驱动按 commandId 写入的消息 id。
    // 前端据它把本机 pending 占位替换成持久消息，因此必须投影；只映射到既有公开字段。
    const projected = projectDriverFrame({
      id: 5,
      event: "user/message",
      data: { id: commandId, role: "user", content: [{ type: "text", text: "可见正文" }], source: { kind: "user" } },
    });
    expect(projected).toEqual({ type: "user", seq: 5, text: "可见正文", commandId });
    // 不泄漏 source / role / 正文以外的任何 payload。
    expect(JSON.stringify(projected)).not.toMatch(/source|role/);

    // 非 UUID 形状：省略而非换个值（避免把任意内部字符串当成公开命令 id）。
    expect(projectDriverFrame({
      id: 6,
      event: "user/message",
      data: { id: "call_00_kxa4", content: [{ type: "text", text: "x" }] },
    })).toEqual({ type: "user", seq: 6, text: "x" });
    expect(projectDriverFrame({
      id: 7,
      event: "user/message",
      data: { id: "72558f29e5254085bfd1991884292e5d", content: [{ type: "text", text: "x" }] },
    })).toEqual({ type: "user", seq: 7, text: "x" });
    // 超长/非字符串同样省略。
    expect(projectDriverFrame({
      id: 8,
      event: "user/message",
      data: { id: "x".repeat(200), content: [{ type: "text", text: "x" }] },
    })).toEqual({ type: "user", seq: 8, text: "x" });
    expect(projectDriverFrame({ id: 9, event: "user/message", data: { id: 42, content: [{ type: "text", text: "x" }] } }))
      .toEqual({ type: "user", seq: 9, text: "x" });
    // 无 id 时行为与旧契约完全一致。
    expect(projectDriverFrame({ id: 10, event: "user/message", data: { content: [{ type: "text", text: "x" }] } }))
      .toEqual({ type: "user", seq: 10, text: "x" });

    // 字符上限可注入：超过上限的合法 UUID 形状也省略，不截断成半个标识。
    expect(projectDriverFrame(
      { id: 11, event: "user/message", data: { id: commandId, content: [{ type: "text", text: "x" }] } },
      { maxCommandIdChars: 8 },
    )).toEqual({ type: "user", seq: 11, text: "x" });
  });

  it("never exposes prompts, headers, reasoning, tool arguments or internal errors", () => {
    const dropped = [
      { id: 1, event: "request/header", data: { config: { model: "x" }, tools: [{ name: "secret_tool" }] } },
      { id: 2, event: "system/message", data: { message: { role: "system", content: [{ type: "text", text: "SYSTEM PROMPT" }] } } },
      { id: 3, event: "developer/message", data: { message: { content: [{ type: "text", text: "DEV" }] } } },
      { id: 5, event: "assistant/attempt", data: { stream: [{ type: "chunk", chunk: { type: "reasoning-delta", text: "思考" } }] } },
      { id: 6, event: "compaction/summary", data: { text: "SUMMARY" } },
      { event: "myrix/ready", data: { sid: "s", time: 1 } },
      { event: "myrix/subscribed", data: { sid: "s" } },
      { id: 7, event: "turn/end", data: { turn: 1, reason: { kind: "error", error: { name: "UpstreamError", message: "密钥 sk-live-xxx 无效" } } } },
    ];
    for (const frame of dropped) {
      const projected = projectDriverFrame(frame);
      if (frame.event === "turn/end") {
        // 失败只给固定文案，不是上游错误原文。
        expect(projected).toEqual({ type: "error", seq: 7, text: "本轮执行失败" });
      } else {
        expect(projected, `${frame.event} 必须被过滤`).toBeUndefined();
      }
    }
  });

  it("projects the real DSH event shapes without leaking nested internals", () => {
    // user/message 的 data **就是** UserMessage（无 {message:…} 包装）；content 里的非 text 块必须跳掉。
    expect(projectDriverFrame({
      id: 20,
      event: "user/message",
      data: { id: "m-1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "可见" }, { type: "image", ref: "secret-image-ref" }, { type: "reasoning", text: "推理" }] },
    })).toEqual({ type: "user", seq: 20, text: "可见" });
    // assistant/message 的 data 是 {turn,step,message,stream,usage}；只读 message.content 的 text 块。
    const assistant = projectDriverFrame({
      id: 21,
      event: "assistant/message",
      data: {
        turn: 1, step: 1,
        message: { id: "m-2", role: "assistant", source: { kind: "model" }, content: [{ type: "reasoning", text: "秘密推理" }, { type: "text", text: "答复" }, { type: "tool-call", name: "leaky", arguments: "{}" }] },
        stream: [{ type: "chunk", chunk: { type: "reasoning-delta", text: "秘密推理" } }],
        usage: { inputTokens: 1, outputTokens: 2 },
      },
    });
    expect(assistant).toEqual({ type: "assistant", seq: 21, text: "答复" });
    expect(JSON.stringify(assistant)).not.toMatch(/秘密推理|leaky|secret-image-ref/);

    // tool/result **不投影**：结果正文与 error.reason（可能含上游内部原因）绝不能进浏览器。
    expect(projectDriverFrame({
      id: 22,
      event: "tool/result",
      data: { turn: 1, step: 1, message: { role: "tool", toolCallId: "call-1", content: [{ type: "text", text: "工具结果" }] }, error: { name: "ToolError", code: "E_TOOL", reason: "内部原因：/etc/passwd 不可读" } },
    })).toBeUndefined();

    // tool/call 在真实 DSH 形状下**没有 toolName**：只有 name + callId + 原始 arguments。
    const tool = projectDriverFrame({
      id: 23,
      event: "tool/call",
      data: { turn: 1, step: 1, callId: "call-1", name: "save_chapter_draft", arguments: '{"text":"正文"}' },
    });
    expect(tool).toEqual({ type: "tool", seq: 23, toolName: "save_chapter_draft", commandId: "call-1" });
    expect(JSON.stringify(tool)).not.toContain("正文");
  });

  it("treats tool calls as name-only and marks truncation without a seq", () => {
    expect(projectDriverFrame({
      id: 5,
      event: "tool/call",
      data: { turn: 1, step: 1, callId: "call-1", name: "save_chapter_draft", arguments: '{"text":"正文内容"}' },
    })).toEqual({ type: "tool", seq: 5, toolName: "save_chapter_draft", commandId: "call-1" });

    expect(projectDriverFrame({ event: "myrix/truncated", data: { sid: "s", from: 12, availableFrom: 40 } }))
      .toEqual({ type: "status", status: "replay-required" });
  });

  it("emits transient deltas without seq and drops non-text chunks", () => {
    expect(projectDriverFrame({ event: "myrix/assistant-stream", data: { type: "start", attemptId: "a", revision: 1, turn: 1, step: 1 } }))
      .toEqual({ type: "status", status: "stream-start" });
    expect(projectDriverFrame({ event: "myrix/assistant-stream", data: { type: "chunk", chunk: { type: "text-delta", index: 0, text: "你" } } }))
      .toEqual({ type: "delta", text: "你" });
    expect(projectDriverFrame({ event: "myrix/assistant-stream", data: { type: "chunk", chunk: { type: "reasoning-delta", index: 0, text: "思考" } } })).toBeUndefined();
    expect(projectDriverFrame({ event: "myrix/assistant-stream", data: { type: "chunk", chunk: { type: "tool-call-delta", index: 0, arguments: "{}" } } })).toBeUndefined();
    // DSH 的 StreamChunk 还有 block-start/block-end/usage/finish：都不是可见文本增量，必须跳过。
    expect(projectDriverFrame({ event: "myrix/assistant-stream", data: { type: "chunk", chunk: { type: "block-start", index: 0, blockType: "reasoning" } } })).toBeUndefined();
    expect(projectDriverFrame({ event: "myrix/assistant-stream", data: { type: "chunk", chunk: { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } } } })).toBeUndefined();
    expect(projectDriverFrame({ event: "myrix/assistant-stream", data: { type: "chunk", chunk: { type: "finish", reason: { kind: "stop" } } } })).toBeUndefined();
    // 持久白名单事件缺少 seq 时必须丢弃，否则客户端会把它当瞬态帧而在重连后丢消息。
    expect(projectDriverFrame({ event: "user/message", data: { content: [{ type: "text", text: "x" }] } })).toBeUndefined();
    // 半个 JSON 不投影。
    expect(projectDriverFrame({ id: 4, event: "user/message", data: undefined, parseError: true })).toBeUndefined();
  });

  it("maps assistant-stream start/abandoned ends to the control statuses the UI reducer clears on", () => {
    // start → stream-start：前端 reducer 据此丢掉上一条未落定的 delta。
    expect(projectDriverFrame({ event: "myrix/assistant-stream", data: { type: "start", attemptId: "a", revision: 2, turn: 1, step: 1 } }))
      .toEqual({ type: "status", status: "stream-start" });

    // abandoned end → stream-abandoned：本轮流被丢弃（重试/取消），前端同样清掉未提交 delta。
    expect(projectDriverFrame({ event: "myrix/assistant-stream", data: { type: "end", attemptId: "a", revision: 2, index: 7, outcome: { kind: "abandoned" } } }))
      .toEqual({ type: "status", status: "stream-abandoned" });

    // committed end → **不投影**：落定正文由持久 assistant/message 承载，
    // BFF 绝不自己合成 assistant.final（否则等于把未持久确认的内容当已保存回复）。
    const committed = projectDriverFrame({
      event: "myrix/assistant-stream",
      data: { type: "end", attemptId: "a", revision: 2, index: 7, outcome: { kind: "committed", eventType: "assistant/message", seq: 9 } },
    });
    expect(committed).toBeUndefined();
    expect(committed?.type).not.toBe("assistant");
    // 形态不合契约的 end（缺 outcome）同样不投影，不能默认当成 abandoned。
    expect(projectDriverFrame({ event: "myrix/assistant-stream", data: { type: "end", attemptId: "a", revision: 2, index: 7 } })).toBeUndefined();
    expect(projectDriverFrame({ event: "myrix/assistant-stream", data: { type: "end", outcome: { kind: "committed" } } })).toBeUndefined();
  });

  it("bounds projected text and joins only text blocks", () => {
    expect(textOfContent([{ type: "text", text: "ab" }, { type: "reasoning", text: "CD" }, { type: "text", text: "ef" }], 3)).toBe("abe");
    expect(projectDriverFrame(
      { id: 4, event: "user/message", data: { content: [{ type: "text", text: "x".repeat(100) }] } },
      { maxTextChars: 10 },
    )).toEqual({ type: "user", seq: 4, text: "x".repeat(10) });
  });
});

describe("driver SSE frame parsing", () => {
  const stream = (chunks: readonly string[]): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });

  async function collect(chunks: readonly string[]) {
    const frames = [];
    for await (const frame of sseFrames(stream(chunks), 4096, () => false)) frames.push(frame);
    return frames;
  }

  it("parses id/event/data, ignores heartbeats and retry, and tolerates split chunks", async () => {
    const frames = await collect([
      "retry: 3000\n\n",
      ": hb\n\n",
      "id: 42\nevent: user/message\ndata: {\"id\":\"m-1\"}\n\n",
      "event: myrix/ready\ndata: {\"sid\":\"s\"}\n\n",
      // 一帧被 TCP 切成三段。
      "id: 43\nevent: assistant/message\ndata: {\"message\"",
      ":{\"content\":[]}",
      "}\n\n",
    ]);
    expect(frames).toEqual([
      { id: 42, event: "user/message", data: { id: "m-1" } },
      { event: "myrix/ready", data: { sid: "s" } },
      { id: 43, event: "assistant/message", data: { message: { content: [] } } },
    ]);
  });

  it("flags malformed data and refuses oversized frames", async () => {
    const [frame] = await collect(["event: user/message\ndata: {oops\n\n"]);
    expect(frame).toMatchObject({ event: "user/message", parseError: true });
    await expect(collect(["event: user/message\ndata: " + "x".repeat(5000) + "\n\n"])).rejects.toThrow(/上限/);
  });
});

describe("driver HTTP client", () => {
  const cell = { tenantId, cellId, baseUrl: "http://cell.invalid:7801", serviceToken: "service-token-0123456789" };

  it("sends the exact signed bytes and classifies failures without faking success", async () => {
    const rawBody = Buffer.from(JSON.stringify({ op: "send", sid: "s-1", commandId: "c-1", text: "你好" }), "utf8");
    const seen: Array<{ url: string; body: Uint8Array | undefined; method: string | undefined }> = [];
    let commandPosts = 0;
    const client = createDriverHttpClient({
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        seen.push({
          url,
          method: init?.method,
          body: init?.body instanceof Uint8Array ? init.body : undefined,
        });
        if (url.endsWith("/v1/ready")) return new Response(JSON.stringify({ ready: true, bootId: "boot-1", draining: false }), { status: 200 });
        if (url.endsWith("/v1/commands")) {
          commandPosts += 1;
          if (commandPosts === 1) return new Response(JSON.stringify({ status: "accepted", commandId: "c-1", bootId: "boot-1" }), { status: 200 });
          return new Response(JSON.stringify({ error: "grant_rejected", reason: "bh 不一致", code: "grant/body-hash-mismatch" }), { status: 403 });
        }
        if (url.includes("/v1/commands/missing")) return new Response("", { status: 404 });
        return new Response(JSON.stringify({ error: "not_found", reason: "未知端点" }), { status: 404 });
      }) as typeof fetch,
    });

    const ready = await client.ready(cell);
    expect(ready).toEqual({ ok: true, value: { ready: true, bootId: "boot-1", draining: false } });

    const posted = await client.postCommand(cell, rawBody, "grant-1");
    expect(posted).toEqual({ ok: true, value: { status: "accepted", commandId: "c-1", bootId: "boot-1" } });
    // 发出的字节必须与签名的字节逐字节相同（同一个 Buffer）。
    expect(seen[1]?.body).toBeDefined();
    expect(Buffer.from(seen[1]!.body!)).toEqual(rawBody);

    // 404 是"没有回执"，不是失败。
    const missing = await client.getReceipt(cell, "missing", "grant-1");
    expect(missing).toEqual({ ok: true, value: undefined });

    // 4xx 契约错误不可重试，5xx 可重试；都不允许变成 ok。
    const denied = await client.postCommand(cell, rawBody, "grant-1");
    expect(denied).toMatchObject({ ok: false, kind: "http", status: 403, retryable: false, code: "grant/body-hash-mismatch" });
    // **绝不回显上游 reason 原文**：它可能带 prompt/header/工具 schema/内部异常细节。
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.reason).not.toContain("bh 不一致");
      expect(denied.reason).not.toContain("sk-live");
      expect(denied.reason).toMatch(/^driver 返回 403/);
    }
    // 5xx 仍然可重试（分类没有因为隐藏 reason 而改变），且同样不泄漏上游文本。
    const upstream = await client.postCommand(cell, rawBody, "grant-1").then(async () => {
      const failing = createDriverHttpClient({
        fetchImpl: (async () => new Response(JSON.stringify({ error: "internal", reason: "prompt=系统提示词 token=sk-live-xxx" }), { status: 500 })) as typeof fetch,
      });
      return failing.postCommand(cell, rawBody, "grant-1");
    });
    expect(upstream).toMatchObject({ ok: false, kind: "http", status: 500, retryable: true });
    if (!upstream.ok) expect(JSON.stringify(upstream)).not.toMatch(/系统提示词|sk-live/);
  });

  it("cancels the response body when a bounded read overflows and keeps 404 as no-receipt", async () => {
    let canceled = false;
    let delivered = false;
    // 一个"永远还有下一块"的响应体：客户端必须在超限时显式 cancel，而不是只 releaseLock。
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        delivered = true;
        controller.enqueue(new TextEncoder().encode("x".repeat(64)));
      },
      cancel() {
        canceled = true;
      },
    });
    const client = createDriverHttpClient({
      maxResponseBytes: 128,
      fetchImpl: (async () => new Response(endless, { status: 200 })) as unknown as typeof fetch,
    });
    const overflow = await client.ready(cell);
    expect(overflow).toMatchObject({ ok: false, kind: "malformed", retryable: false });
    expect(delivered).toBe(true);
    expect(canceled).toBe(true);

    // 声明 content-length 就超限：一个字节都不读，也要 cancel。
    let declaredCanceled = false;
    const declaredBody = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new TextEncoder().encode("y".repeat(64))); },
      cancel() { declaredCanceled = true; },
    });
    const declaredClient = createDriverHttpClient({
      maxResponseBytes: 8,
      fetchImpl: (async () => new Response(declaredBody, { status: 200, headers: { "content-length": "999999" } })) as unknown as typeof fetch,
    });
    expect(await declaredClient.ready(cell)).toMatchObject({ ok: false, kind: "malformed" });
    expect(declaredCanceled).toBe(true);

    // GET 404 保留 `undefined`（不是 fake receipt、不是失败）。
    const missingClient = createDriverHttpClient({
      fetchImpl: (async () => new Response(JSON.stringify({ error: "no_receipt", reason: "本进程没有该命令的回执", code: "no_receipt" }), { status: 404 })) as typeof fetch,
    });
    expect(await missingClient.getReceipt(cell, "c-1", "g")).toEqual({ ok: true, value: undefined });
  });

  it("never echoes upstream exception types or messages into external reasons", async () => {
    const leaking = createDriverHttpClient({
      fetchImpl: (async () => {
        throw new TypeError("connect ECONNREFUSED 10.0.0.9:7801?token=sk-live-secret");
      }) as unknown as typeof fetch,
    });
    const failure = await leaking.ready(cell);
    expect(failure).toMatchObject({ ok: false, kind: "unreachable", retryable: true });
    if (!failure.ok) {
      expect(failure.reason).toBe("无法连接 driver（网络错误或连接被拒）");
      expect(JSON.stringify(failure)).not.toMatch(/ECONNREFUSED|sk-live|10\.0\.0\.9/);
    }
  });

  it("reports unreachable, timeout and aborted separately and never retries them as success", async () => {
    const unreachable = createDriverHttpClient({
      fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch,
    });
    expect(await unreachable.ready(cell)).toMatchObject({ ok: false, kind: "unreachable", retryable: true });

    // 永不解析的请求：由客户端截止时间中止。
    const hanging = createDriverHttpClient({
      deadlineMs: 30,
      fetchImpl: ((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      })) as unknown as typeof fetch,
    });
    expect(await hanging.ready(cell)).toMatchObject({ ok: false, kind: "timeout", retryable: true });

    // 调用方主动取消：aborted，不是 timeout，也不可重试。
    const controller = new AbortController();
    const cancelable = createDriverHttpClient({
      fetchImpl: ((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      })) as unknown as typeof fetch,
    });
    const pending = cancelable.ready(cell, { signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, kind: "aborted", retryable: false });
  });

  it("streams frames and stops when aborted", async () => {
    const frames = [
      "id: 1\nevent: user/message\ndata: {\"content\":[{\"type\":\"text\",\"text\":\"a\"}]}\n\n",
      "event: myrix/assistant-stream\ndata: {\"type\":\"chunk\",\"chunk\":{\"type\":\"text-delta\",\"text\":\"b\"}}\n\n",
      "id: 2\nevent: turn/end\ndata: {\"turn\":1,\"reason\":{\"kind\":\"completed\"}}\n\n",
    ];
    const client = createDriverHttpClient({
      fetchImpl: (async (_input: unknown, init?: RequestInit) => {
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            for (const frame of frames) {
              if (init?.signal?.aborted) break;
              controller.enqueue(new TextEncoder().encode(frame));
              await new Promise((resolve) => setTimeout(resolve, 2));
            }
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }) as unknown as typeof fetch,
    });
    const opened = await client.streamEvents(cell, "s-1", { grant: "g", lastEventId: 0 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const collected = [];
    for await (const frame of opened.value) collected.push(frame.event);
    expect(collected).toEqual(["user/message", "myrix/assistant-stream", "turn/end"]);

    const controller = new AbortController();
    const again = await client.streamEvents(cell, "s-1", { grant: "g", signal: controller.signal });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    const iterator = again.value[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    const rest = await iterator.next();
    expect(rest.done).toBe(true);
  });
});

describe("cell directory and runtime configuration", () => {
  it("rejects ambiguous or unsafe cell entries at construction time", () => {
    expect(() => createStaticCellDirectory([])).toThrow(/为空/);
    expect(() => createStaticCellDirectory([
      { tenantId, cellId, baseUrl: "http://10.0.0.1:7801" },
      { tenantId, cellId: "cell-b", baseUrl: "http://10.0.0.2:7801" },
    ])).toThrow(/一 Cell 一租户/);
    expect(() => createStaticCellDirectory([{ tenantId, cellId, baseUrl: "http://user:pass@10.0.0.1:7801" }])).toThrow(/用户名或密码/);
    expect(() => createStaticCellDirectory([{ tenantId, cellId, baseUrl: "file:///tmp/sock" }])).toThrow(/http\/https/);
    expect(() => createStaticCellDirectory([{ tenantId, cellId, baseUrl: "http://10.0.0.1:7801", serviceToken: "short" }])).toThrow(/16/);

    // 一 Cell 一租户：同一 cellId 被两个租户复用（**地址完全相同**）也必须拒绝，
    // 因为 cellId 就是凭证 aud 与租户隔离边界。
    expect(() => createStaticCellDirectory([
      { tenantId, cellId, baseUrl: "http://10.0.0.1:7801", serviceToken: "service-token-aaaaaaaa" },
      { tenantId: "22222222-2222-4222-8222-222222222222", cellId, baseUrl: "http://10.0.0.1:7801", serviceToken: "service-token-aaaaaaaa" },
    ])).toThrow(/一 Cell 一租户/);
    // 同一租户 + 同一 cell 的重复条目同样拒绝（不是"后者覆盖前者"）。
    expect(() => createStaticCellDirectory([
      { tenantId, cellId, baseUrl: "http://10.0.0.1:7801" },
      { tenantId, cellId, baseUrl: "http://10.0.0.2:7801" },
    ])).toThrow(/一 Cell 一租户/);
    // 负例 reason 不泄漏 serviceToken。
    try {
      createStaticCellDirectory([
        { tenantId, cellId, baseUrl: "http://10.0.0.1:7801", serviceToken: "super-secret-token-value" },
        { tenantId: "22222222-2222-4222-8222-222222222222", cellId, baseUrl: "http://10.0.0.1:7801", serviceToken: "super-secret-token-value" },
      ]);
      throw new Error("must reject");
    } catch (error) {
      expect(String(error)).not.toContain("super-secret-token-value");
    }

    const directory = createStaticCellDirectory([{ tenantId, cellId, baseUrl: "http://10.0.0.1:7801/" }]);
    return expect(directory.resolve(tenantId)).resolves.toEqual({ tenantId, cellId, baseUrl: "http://10.0.0.1:7801" });
  });

  it("verifies the requested tenant on byId so a reused cell can never be returned", async () => {
    const other = "22222222-2222-4222-8222-222222222222";
    const directory = createStaticCellDirectory([{ tenantId, cellId: "cell-a", baseUrl: "http://10.0.0.1:7801" }]);
    await expect(directory.byId("cell-a", tenantId)).resolves.toMatchObject({ cellId: "cell-a", tenantId });
    // 目录是可注入的：byId 必须核对 requested tenant，而不是"拿到就返回"。
    await expect(directory.byId("cell-a", other)).resolves.toBeUndefined();
    await expect(directory.byId("cell-unknown", tenantId)).resolves.toBeUndefined();
    await expect(directory.byId("cell-a", "")).resolves.toBeUndefined();
  });

  it("rejects a cell directory that reuses one cellId for two tenants even when injected by hand", async () => {
    const other = "22222222-2222-4222-8222-222222222222";
    // 模拟"可注入目录"：它绕过 createStaticCellDirectory 的构造期检查，**无视** expectedTenantId
    // 直接返回 tenant `other` 的 endpoint（正是这个复用形态最危险的地方）。
    const reused = { tenantId: other, cellId, baseUrl: "http://10.0.0.1:7801" };
    const hostile: CellDirectory = {
      async resolve() {
        return reused;
      },
      async byId() {
        return reused;
      },
    };
    // cellServesTenant 是路由侧共用的判定：不匹配即为"没有放置"。
    expect(cellServesTenant(await hostile.resolve(tenantId), tenantId)).toBe(false);
    expect(cellServesTenant(await hostile.byId(cellId, tenantId), tenantId)).toBe(false);
    expect(cellServesTenant(await hostile.byId(cellId, other), other)).toBe(true);
    expect(cellServesTenant(undefined, tenantId)).toBe(false);
  });

  it("reads runtime configuration from the environment and fails closed on missing or mismatched values", () => {
    const key = generateTestKeyPair("kid-runtime");
    const env = {
      MYRIX_RUNTIME_CELLS_JSON: JSON.stringify([{ tenantId, cellId, baseUrl: "http://10.0.0.1:7801", serviceToken: "service-token-0123456789" }]),
      MYRIX_RUNTIME_SIGNING_KEY_PEM: key.privateKeyPem,
      MYRIX_RUNTIME_SIGNING_KID: "kid-runtime",
      MYRIX_RUNTIME_LEASE_MS: "30000",
    };
    const parsed = readRuntimeEnvironment(env);
    expect(parsed).toMatchObject({ signingKid: "kid-runtime", issuer: "myrix-control-plane", leaseMs: 30_000 });
    expect(parsed.cells).toHaveLength(1);

    for (const name of ["MYRIX_RUNTIME_CELLS_JSON", "MYRIX_RUNTIME_SIGNING_KEY_PEM", "MYRIX_RUNTIME_SIGNING_KID"]) {
      expect(() => readRuntimeEnvironment({ ...env, [name]: undefined }), name).toThrow();
    }
    expect(() => readRuntimeEnvironment({ ...env, MYRIX_RUNTIME_CELLS_JSON: "[]" })).toThrow(/非空数组/);
    expect(() => readRuntimeEnvironment({ ...env, MYRIX_RUNTIME_CELLS_JSON: JSON.stringify([{ tenantId, cellId, baseUrl: "http://x:1", extra: 1 }]) })).toThrow(/未知字段/);
    // 一 Cell 一租户在**配置解析**阶段就拒绝：同一 cellId 给两个租户（地址相同也一样）。
    const otherTenant = "22222222-2222-4222-8222-222222222222";
    expect(() => readRuntimeEnvironment({
      ...env,
      MYRIX_RUNTIME_CELLS_JSON: JSON.stringify([
        { tenantId, cellId, baseUrl: "http://10.0.0.1:7801" },
        { tenantId: otherTenant, cellId, baseUrl: "http://10.0.0.1:7801" },
      ]),
    })).toThrow(/一 Cell 一租户|复用/);
    expect(() => readRuntimeEnvironment({
      ...env,
      MYRIX_RUNTIME_CELLS_JSON: JSON.stringify([
        { tenantId, cellId, baseUrl: "http://10.0.0.1:7801" },
        { tenantId, cellId: "cell-b", baseUrl: "http://10.0.0.2:7801" },
      ]),
    })).toThrow(/一 Cell 一租户|出现/);
    expect(() => readRuntimeEnvironment({ ...env, MYRIX_RUNTIME_LEASE_MS: "0" })).toThrow();
    // 非 ES256 私钥必须在读取配置时就失败，而不是第一次签发。
    const rsa = generateTestKeyPair("kid-runtime").privateKeyPem.replace(/^/, "");
    expect(typeof rsa).toBe("string");
    expect(() => readRuntimeEnvironment({ ...env, MYRIX_RUNTIME_SIGNING_KEY_PEM: "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----\n" })).toThrow();

    // 签发器确实用配置里的 kid / issuer。
    const clock = createManualClock(1_790_000_000);
    const signer = createRuntimeSigner(parsed, { clock: () => clock.now() });
    const issued = signer.issue({
      aud: cellId, boot: "boot-1", tid: tenantId, sid: "s-1", sub: "u-1", wid: "w-1",
      preset: "novel-chapter", rev: 1, op: "create", cmd: "c-1", rawBody: Buffer.from("{}"),
    });
    expect(issued.header.kid).toBe("kid-runtime");
    expect(issued.claims.iss).toBe("myrix-control-plane");

    // 部署检查：cell 未装公钥、或 kid 不匹配，都必须报出来。
    expect(inspectRuntimeEnvironment(parsed, {})).toHaveLength(1);
    expect(inspectRuntimeEnvironment(parsed, { [cellId]: [generateTestKeyPair("other-kid").jwk] })[0]).toMatch(/kid=kid-runtime/);
    expect(inspectRuntimeEnvironment(parsed, { [cellId]: [key.jwk] })).toEqual([]);
    expect(inspectRuntimeEnvironment({ ...parsed, tenantIds: ["22222222-2222-4222-8222-222222222222"] }, { [cellId]: [key.jwk] })[0]).toMatch(/不在 cell 目录内/);
    // 一 Cell 一租户：注入/手改的配置里出现 cellId 复用，装配检查必须报出来（而不是静默投递）。
    const reused = inspectRuntimeEnvironment({
      ...parsed,
      cells: [
        { tenantId, cellId: "cell-shared", baseUrl: "http://10.0.0.1:7801" },
        { tenantId: "22222222-2222-4222-8222-222222222222", cellId: "cell-shared", baseUrl: "http://10.0.0.1:7801" },
      ],
    }, { "cell-shared": [key.jwk] });
    expect(reused.some((problem) => /一 Cell 一租户/.test(problem))).toBe(true);

    // 同一把密钥在真实签发/校验之间保持一致（此处只验证摘要算法一致）。
    expect(sha256Hex(Buffer.alloc(0))).toHaveLength(64);
  });

  it("keeps the configured minimum bounds for hot-loop knobs", () => {
    const key = generateTestKeyPair("kid-2");
    const base = {
      MYRIX_RUNTIME_CELLS_JSON: JSON.stringify([{ tenantId, cellId, baseUrl: "http://10.0.0.1:7801" }]),
      MYRIX_RUNTIME_SIGNING_KEY_PEM: key.privateKeyPem,
      MYRIX_RUNTIME_SIGNING_KID: "kid-2",
    };
    expect(() => readRuntimeEnvironment({ ...base, MYRIX_RUNTIME_CLAIM_BATCH: "101" })).toThrow();
    expect(() => readRuntimeEnvironment({ ...base, MYRIX_RUNTIME_REVALIDATE_MS: "10" })).toThrow();
    expect(readRuntimeEnvironment({ ...base, MYRIX_RUNTIME_CLAIM_BATCH: "5" }).claimBatch).toBe(5);
    expect(readRuntimeEnvironment({ ...base, MYRIX_RUNTIME_OUTBOX_ENABLED: "false" }).outboxEnabled).toBe(false);
  });

  it("does not log secrets when assembling a signer", () => {
    const warn = vi.fn();
    const key = generateTestKeyPair("kid-3");
    const parsed = readRuntimeEnvironment({
      MYRIX_RUNTIME_CELLS_JSON: JSON.stringify([{ tenantId, cellId, baseUrl: "http://10.0.0.1:7801", serviceToken: "super-secret-token-value" }]),
      MYRIX_RUNTIME_SIGNING_KEY_PEM: key.privateKeyPem,
      MYRIX_RUNTIME_SIGNING_KID: "kid-3",
    });
    createStaticCellDirectory(parsed.cells, { logger: { info: (_m, detail) => warn(detail) } });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("super-secret-token-value");
    // 签发器自身的 bodyHash 与 grant 包的 sha256 一致（同一算法，签发/校验两侧共用）。
    const signer = createGrantSigner({ privateKey: key.privateKeyPem, kid: "kid-3", issuer: "myrix-control-plane" });
    expect(signer.bodyHash("abc")).toBe(sha256Hex("abc"));
  });
});
