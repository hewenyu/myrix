import { describe, expect, it } from "vitest";
import { KnowledgeGatewayClient } from "../src/gateway-client";

describe("KnowledgeGatewayClient", () => {
  it("逐调用透传主体身份头，并携带数据面令牌", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new KnowledgeGatewayClient({
      baseUrl: "http://control-plane:8787/",
      token: "agent-token",
      principal: { principalId: "u_1001", tenantId: "acme", sessionId: "s_9" },
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ chunks: [{ id: "d1", baseId: "kb-handbook", text: "年假 10 天", score: 0.9 }] }), {
          status: 200,
        });
      }) as typeof fetch,
    });

    const chunks = await client.search({ text: "年假", topK: 3 });
    expect(chunks).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://control-plane:8787/api/v1/knowledge/search");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["x-myrix-principal"]).toBe("u_1001");
    expect(headers["x-myrix-tenant"]).toBe("acme");
    expect(headers["x-myrix-session"]).toBe("s_9");
    expect(headers["authorization"]).toBe("Bearer agent-token");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ principalId: "u_1001", text: "年假", topK: 3 });
  });

  it("网关报错时抛出可诊断的错误", async () => {
    const client = new KnowledgeGatewayClient({
      baseUrl: "http://control-plane:8787",
      token: "agent-token",
      principal: { principalId: "u_1", tenantId: "acme" },
      fetchImpl: (async () => new Response("nope", { status: 503 })) as typeof fetch,
    });
    await expect(client.listBases()).rejects.toThrow("知识库网关返回 503");
  });
});
