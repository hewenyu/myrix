import { describe, expect, it } from "vitest";
import { PolicyClient } from "../src/policy-client";

const decisionPayload = {
  decision: {
    effect: "allow",
    matched: "explicit-allow",
    matchedRules: ["r1"],
    obligations: [],
    policyRevision: "r1",
    evaluatedAt: "2026-09-30T00:00:00.000Z",
  },
};

describe("PolicyClient", () => {
  it("携带 Bearer 令牌调用判定接口，并缓存结果", async () => {
    let calls = 0;
    let seenAuth = "";
    const client = new PolicyClient({
      baseUrl: "http://control-plane:8787/",
      token: "agent-token",
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        calls += 1;
        seenAuth = String((init?.headers as Record<string, string> | undefined)?.["authorization"] ?? "");
        return new Response(JSON.stringify(decisionPayload), { status: 200 });
      }) as typeof fetch,
      now: () => 1000,
    });
    const first = await client.decide({ principalId: "u_1", action: "tool:bash", resource: { type: "tool", id: "bash" } });
    const second = await client.decide({ principalId: "u_1", action: "tool:bash", resource: { type: "tool", id: "bash" } });
    expect(first.effect).toBe("allow");
    expect(second.effect).toBe("allow");
    expect(calls).toBe(1);
    expect(seenAuth).toBe("Bearer agent-token");
  });

  it.each([undefined, false, true])("治理平面不可用时始终拒绝，旧 failClosed=%s 不能开启后门", async (failClosed) => {
    const client = new PolicyClient({
      baseUrl: "http://control-plane:8787",
      token: "agent-token",
      failClosed,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
    });
    const decision = await client.decide({ principalId: "u_1", action: "tool:bash", resource: { type: "tool", id: "bash" } });
    expect(decision.effect).toBe("deny");
    expect(decision.policyRevision).toBe("unavailable");
  });
});
