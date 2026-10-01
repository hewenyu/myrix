import { describe, expect, it, vi } from "vitest";
import { NovelStoreClient } from "../src/client";
import { NOVEL_TOOLS, PRESET_TOOLS, parseToolArguments, toolParameters } from "../src/protocol";
const sid = "10000000-0000-4000-8000-000000000001";
const options = { origin: "http://works.internal:8081", credential: "cell-test-credential", timeoutMs: 1000, maxResponseBytes: 2048 };
describe("novel tool boundary", () => {
  it("rejects identity/work/url injection and invalid versions before network", async () => {
    const fetcher = vi.fn();
    const client = new NovelStoreClient({ ...options, fetch: fetcher });
    for (const field of ["tenantId", "userId", "workId", "sessionId", "url", "credential"]) {
      await expect(client.call({ sessionId: sid, revision: 1 }, "get_outline", { [field]: sid }, new AbortController().signal)).rejects.toThrow("不允许");
    }
    for (const expectedVersion of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", undefined]) {
      expect(() => parseToolArguments("update_outline", { text: "正文", expectedVersion })).toThrow("版本号");
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("carries only authoritative session/revision and service credentials", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ result: { text: "大纲", version: 2 } })));
    const client = new NovelStoreClient({ ...options, fetch: fetcher });
    await expect(client.call({ sessionId: sid, revision: 4 }, "get_outline", {}, new AbortController().signal)).resolves.toBe('{"text":"大纲","version":2}');
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://works.internal:8081/internal/v1/sessions/${sid}/tools/get_outline`);
    expect(init.redirect).toBe("error");
    expect(init.headers).toMatchObject({ authorization: `Bearer ${options.credential}`, "x-myrix-revision": "4" });
    expect(init.body).toBe("{}");
  });
  it("preserves CAS conflict for the model rather than claiming saved", async () => {
    const client = new NovelStoreClient({ ...options, fetch: vi.fn(async () => new Response('{"result":{"status":"conflict","version":3}}', { status: 409 })) });
    expect(JSON.parse(await client.call({ sessionId: sid, revision: 1 }, "update_outline", { text: "draft", expectedVersion: 1 }, new AbortController().signal))).toEqual({ status: "conflict", version: 3 });
  });
  it("denies unavailable or revoked requests and never exposes upstream secret text", async () => {
    for (const status of [401, 403, 500]) {
      const client = new NovelStoreClient({ ...options, fetch: vi.fn(async () => new Response("secret database URL", { status })) });
      await expect(client.call({ sessionId: sid, revision: 1 }, "get_outline", {}, new AbortController().signal)).rejects.not.toThrow("secret");
    }
  });
  it("caps response size and rejects unsafe configured origins", async () => {
    for (const origin of ["file:///etc/passwd", "https://token@works", "http://works/path", "https://works/?secret=x"]) expect(() => new NovelStoreClient({ ...options, origin })).toThrow();
    const client = new NovelStoreClient({ ...options, fetch: vi.fn(async () => new Response("a".repeat(2050))) });
    await expect(client.call({ sessionId: sid, revision: 1 }, "get_outline", {}, new AbortController().signal)).rejects.toThrow("上限");
  });
  it("advertises exactly six strict tools with preset-specific allowlists", () => {
    expect(NOVEL_TOOLS).toHaveLength(6);
    expect(PRESET_TOOLS["novel-outline"]).not.toContain("save_chapter_draft");
    for (const tool of NOVEL_TOOLS) expect(toolParameters(tool)).toMatchObject({ type: "object", additionalProperties: false });
  });
});
