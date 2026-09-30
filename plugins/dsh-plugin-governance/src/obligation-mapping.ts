import type { Obligation, PolicyDecision } from "@myrix/contracts";
import type { PreExecuteResult } from "@myrix/dsh-shim";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/**
 * 治理结论 → DSH 执行方式的翻译结果。
 * allow 不代表"无约束"：沙箱模式、审批要求、配额与范围都会随之下发。
 */
export type ToolGate =
  | {
      kind: "allow";
      sandboxMode?: SandboxMode;
      approvalRequired: boolean;
      obligations: Obligation[];
      reason: string;
    }
  | { kind: "deny"; reason: string }
  | { kind: "ask"; reason: string };

export function toToolGate(decision: PolicyDecision): ToolGate {
  const reason =
    decision.matchedRules.length > 0
      ? "Myrix 策略 " + decision.effect + "：" + decision.matchedRules.join(", ")
      : "Myrix 策略默认拒绝（fail-closed）";

  if (decision.effect === "deny") return { kind: "deny", reason };

  const sandbox = decision.obligations.find(
    (obligation): obligation is Extract<Obligation, { kind: "sandbox" }> => obligation.kind === "sandbox",
  );
  const approval = decision.obligations.find(
    (obligation): obligation is Extract<Obligation, { kind: "approval" }> => obligation.kind === "approval",
  );
  const gate: ToolGate = {
    kind: approval?.required === true ? "ask" : "allow",
    approvalRequired: approval?.required === true,
    obligations: [...decision.obligations],
    reason,
  };
  if (sandbox === undefined || gate.kind !== "allow") return gate;
  return { ...gate, sandboxMode: sandbox.mode };
}

/** 把翻译结果映射为 tools/pre-execute 的返回类型 */
export function toPreExecuteResult(gate: ToolGate): PreExecuteResult {
  switch (gate.kind) {
    case "deny":
      return { type: "deny", reason: gate.reason };
    case "ask":
      return { type: "ask", reason: gate.reason };
    default:
      return { type: "allow" };
  }
}

/**
 * 沙箱模式 → DSH permission preset 名称。
 * DSH base 自带 workspace-write / danger-full-access 两个 preset
 * （packages/bundle/base/cordis.patch.yml:250-262），read-only 需部署方在
 * permission-presets.presets 中补充；映射可通过配置覆盖。
 */
export function defaultPresetMapping(): Record<SandboxMode, string> {
  return {
    "read-only": "read-only",
    "workspace-write": "workspace-write",
    "danger-full-access": "danger-full-access",
  };
}

export function presetForMode(
  mode: SandboxMode,
  mapping: Record<SandboxMode, string> = defaultPresetMapping(),
): string {
  return mapping[mode];
}
