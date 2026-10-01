import { describe, expect, it } from "vitest";
import { combineSignals, createDeepSeekUpstream, readResponseBody } from "../src/upstream";
import { GatewayError } from "../src/errors";

const url = "https://upstream.invalid/v1/responses";

describe("上游客户端：Responses 转发与密钥保护", () => {
  it("只发网关构造的出站头与 Responses 正文，不转发任何客户端头", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const upstream = createDeepSeekUpstream({
      url, model: "deepseek-chat", apiKey: "sk-secret",
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        seen = { url: String(input), init: init ?? {} };
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    await upstream.send({ body: { model: "deepseek-chat", input: [], store: false }, signal: new AbortController().signal, requestId: "req-1" });
    expect(seen?.url).toBe(url);
    const headers = seen?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-secret");
    expect(Object.keys(headers).sort()).toEqual(["accept", "authorization", "content-type", "user-agent", "x-myrix-request-id"]);
    expect(seen?.init.redirect).toBe("error");
  });

  it("拒绝跟随重定向（redirect:error），绝不把上游密钥带到别的 origin", async () => {
    const upstream = createDeepSeekUpstream({
      url, model: "deepseek-chat", apiKey: "sk-secret",
      // 模拟严格实现：redirect:"error" 时直接抛错。
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.redirect !== "error") throw new Error("测试替身要求 redirect:error");
        throw Object.assign(new Error("unexpected redirect"), { name: "TypeError" });
      }) as typeof fetch,
    });
    await expect(upstream.send({ body: {}, signal: new AbortController().signal, requestId: "req-2" }))
      .rejects.toMatchObject({ statusCode: 502, code: "upstream_error" });
  });

  it("即使实现返回 3xx 也不读取它（双保险）", async () => {
    const upstream = createDeepSeekUpstream({
      url, model: "deepseek-chat", apiKey: "sk-secret",
      fetchImpl: (async () => new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } })) as typeof fetch,
    });
    const error = await upstream.send({ body: {}, signal: new AbortController().signal, requestId: "req-3" }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).reason).toMatch(/重定向/);
    expect((error as GatewayError).reason).not.toContain("evil.example");
  });

  it("连接失败只给固定文案，不回显上游异常 message（可能含 URL/主机）", async () => {
    const upstream = createDeepSeekUpstream({
      url, model: "deepseek-chat", apiKey: "sk-secret",
      fetchImpl: (async () => { throw new Error(`connect ECONNREFUSED ${url}`); }) as typeof fetch,
    });
    const error = await upstream.send({ body: {}, signal: new AbortController().signal, requestId: "req-4" }).catch((thrown: unknown) => thrown);
    expect((error as GatewayError).reason).not.toContain("upstream.invalid");
    expect((error as GatewayError).reason).toMatch(/无法连接上游模型/);
  });

  it("缺密钥时 configured=false 且调用被拒（503），不发任何请求", async () => {
    let called = false;
    const upstream = createDeepSeekUpstream({
      url, model: "deepseek-chat",
      fetchImpl: (async () => { called = true; return new Response("{}"); }) as typeof fetch,
    });
    expect(upstream.configured).toBe(false);
    expect(upstream.describeMissing()).toMatch(/未配置上游密钥/);
    await expect(upstream.send({ body: {}, signal: new AbortController().signal, requestId: "req-5" })).rejects.toMatchObject({ statusCode: 503 });
    expect(called).toBe(false);
  });

  it("abort 时透传取消错误而不是包装成 502", async () => {
    const controller = new AbortController();
    const upstream = createDeepSeekUpstream({
      url, model: "deepseek-chat", apiKey: "sk-secret",
      fetchImpl: (async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); }) as typeof fetch,
    });
    controller.abort();
    await expect(upstream.send({ body: {}, signal: controller.signal, requestId: "req-6" })).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("上游响应体读取：提前退出必须 cancel", () => {
  it("正常读完只 releaseLock", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("hello")); controller.close(); },
      cancel() { cancelled = true; },
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of readResponseBody(body)) chunks.push(chunk);
    expect(new TextDecoder().decode(chunks[0])).toBe("hello");
    expect(cancelled).toBe(false);
  });

  it("调用方提前 break → cancel 上游流（不让它继续往没人读的流里写）", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode("a")); controller.enqueue(encoder.encode("b")); },
      cancel() { cancelled = true; },
    });
    for await (const chunk of readResponseBody(body)) {
      expect(chunk.byteLength).toBeGreaterThan(0);
      break;
    }
    expect(cancelled).toBe(true);
  });
});

describe("combineSignals", () => {
  it("任一信号 abort 即合并信号 abort，并正确 dispose", () => {
    const a = new AbortController();
    const b = new AbortController();
    const merged = combineSignals([a.signal, b.signal]);
    expect(merged.signal.aborted).toBe(false);
    b.abort(new Error("revoked"));
    expect(merged.signal.aborted).toBe(true);
    expect((merged.signal.reason as Error).message).toBe("revoked");
    merged.dispose();
    // dispose 后新 abort 不再影响（监听器已摘除）。
    expect(merged.signal.aborted).toBe(true);
  });

  it("已经 aborted 的输入信号立刻传导", () => {
    const a = new AbortController();
    a.abort(new Error("already"));
    const merged = combineSignals([a.signal, new AbortController().signal]);
    expect(merged.signal.aborted).toBe(true);
    merged.dispose();
  });
});
