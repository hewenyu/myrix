/**
 * 判定演示：打印几个典型场景的两级判定结果（RBAC → ABAC → 义务）。
 * 用法：pnpm demo:decide
 */
import { GovernanceStore } from "@myrix/control-plane";

const store = new GovernanceStore();

const scenarios: { principalId: string; action: string; resource: { type: string; id: string }; context?: Record<string, unknown>; note: string }[] = [
  { principalId: "u_1001", action: "tool:bash", resource: { type: "tool", id: "bash" }, context: { riskScore: 10, hour: 14 }, note: "研发用 shell 改代码" },
  { principalId: "u_1002", action: "tool:bash", resource: { type: "tool", id: "bash" }, note: "财务用 shell（角色未授权）" },
  { principalId: "u_1001", action: "kb:search", resource: { type: "kb", id: "finance-2026" }, note: "研发查财务知识库" },
  { principalId: "u_1002", action: "kb:search", resource: { type: "kb", id: "finance-2026" }, note: "财务查财务知识库" },
  { principalId: "u_1003", action: "tool:computer-use", resource: { type: "tool", id: "computer-use" }, note: "管理员用桌面自动化" },
  { principalId: "u_1001", action: "tool:deploy", resource: { type: "env", id: "prod-cn" }, context: { hour: 22 }, note: "非工作时段发布生产（ABAC 时间条件）" },
];

for (const scenario of scenarios) {
  const envelope = store.decide({
    principalId: scenario.principalId,
    action: scenario.action,
    resource: scenario.resource,
    ...(scenario.context === undefined ? {} : { context: scenario.context }),
  });
  const obligations = envelope.decision.obligations.map((obligation) => obligation.kind).join(",") || "-";
  console.log(
    [
      scenario.principalId.padEnd(7),
      scenario.action.padEnd(20),
      envelope.decision.effect === "allow" ? "ALLOW" : "DENY ",
      envelope.source.padEnd(5),
      ("义务:" + obligations).padEnd(38),
      scenario.note,
    ].join(" | "),
  );
}

console.log("");
console.log("功能裁剪示例（u_1001）：");
const entitlement = store.entitlements("u_1001");
for (const decision of entitlement?.decisions ?? []) {
  console.log("  " + (decision.enabled ? "[x]" : "[ ]") + " " + decision.pluginId.padEnd(26) + decision.reason);
}
