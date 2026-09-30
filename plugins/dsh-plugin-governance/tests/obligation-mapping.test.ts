import { describe, expect, it } from "vitest";
import type { PolicyDecision } from "@myrix/contracts";
import { defaultPresetMapping, presetForMode, toPreExecuteResult, toToolGate } from "../src/obligation-mapping";

function decision(overrides: Partial<PolicyDecision>): PolicyDecision {
  return {
    effect: "allow",
    matched: "explicit-allow",
    matchedRules: ["r1"],
    obligations: [],
    policyRevision: "r1",
    evaluatedAt: "2026-09-30T00:00:00.000Z",
    ...overrides,
  };
}

describe("toToolGate", () => {
  it("deny 直接阻断", () => {
    const gate = toToolGate(decision({ effect: "deny", matched: "explicit-deny", matchedRules: ["deny-danger"] }));
    expect(gate.kind).toBe("deny");
    expect(toPreExecuteResult(gate)).toEqual({ type: "deny", reason: "Myrix 策略 deny：deny-danger" });
  });

  it("带审批义务的 allow 转成 ask", () => {
    const gate = toToolGate(
      decision({ obligations: [{ kind: "approval", required: true, reason: "高风险工具" }] }),
    );
    expect(gate.kind).toBe("ask");
    expect(toPreExecuteResult(gate)).toEqual({ type: "ask", reason: "Myrix 策略 allow：r1" });
  });

  it("沙箱义务被翻译成 preset 名", () => {
    const gate = toToolGate(decision({ obligations: [{ kind: "sandbox", mode: "workspace-write" }] }));
    expect(gate.kind).toBe("allow");
    expect(gate.kind === "allow" && gate.sandboxMode).toBe("workspace-write");
    expect(presetForMode("workspace-write")).toBe("workspace-write");
    expect(presetForMode("read-only", { ...defaultPresetMapping(), "read-only": "myrix-readonly" })).toBe("myrix-readonly");
  });

  it("默认拒绝没有规则命中时也保持 fail-closed", () => {
    const gate = toToolGate(decision({ effect: "deny", matched: "default-deny", matchedRules: [] }));
    expect(gate.kind).toBe("deny");
    expect(gate.reason).toContain("fail-closed");
  });
});
