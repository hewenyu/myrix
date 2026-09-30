import type { EntitlementSet } from "@myrix/contracts";
import type { PluginCatalog } from "./catalog";

export interface ProfileSpec {
  profile: string;
  principalId: string;
  tenantId: string;
  policyRevision: string;
  generatedAt: string;
  enabled: { id: string; source?: string }[];
  disabled: { id: string; reason: string }[];
}

/**
 * 由授权结果生成 DSH profile 的中间表示。
 * 落盘格式（cordis.patch.yml / bundle 清单）在 docs/integration/dsh-seams.md
 * 与 DSH 的真实 schema 对齐后由 renderer 负责，这里保持与 DSH 版本解耦。
 */
export function buildProfileSpec(
  entitlement: EntitlementSet,
  catalog: PluginCatalog,
  options: { profile: string; policyRevision: string; now?: () => Date },
): ProfileSpec {
  const reasonOf = new Map(entitlement.decisions.map((decision) => [decision.pluginId, decision.reason]));
  return {
    profile: options.profile,
    principalId: entitlement.principalId,
    tenantId: entitlement.tenantId,
    policyRevision: options.policyRevision,
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    enabled: entitlement.enabled.map((id) => {
      const plugin = catalog.get(id);
      return plugin?.source === undefined ? { id } : { id, source: plugin.source };
    }),
    disabled: entitlement.disabled.map((id) => ({ id, reason: reasonOf.get(id) ?? "未评估" })),
  };
}

function quote(value: string): string {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/** 手写 YAML 子集序列化器：只覆盖本文件的结构，避免引入 YAML 依赖与注入风险 */
export function renderProfilePatch(spec: ProfileSpec): string {
  const lines: string[] = [
    "# 本文件由 Myrix 控制面生成，请勿手工修改。",
    "# principal: " + spec.principalId + "  tenant: " + spec.tenantId,
    "# policyRevision: " + spec.policyRevision + "  generatedAt: " + spec.generatedAt,
    "profile: " + quote(spec.profile),
    "principal: " + quote(spec.principalId),
    "tenant: " + quote(spec.tenantId),
    "policyRevision: " + quote(spec.policyRevision),
    "enabled:",
  ];
  for (const item of spec.enabled) {
    lines.push("  - id: " + quote(item.id));
    if (item.source !== undefined) lines.push("    source: " + quote(item.source));
  }
  lines.push("disabled:");
  for (const item of spec.disabled) {
    lines.push("  - id: " + quote(item.id));
    lines.push("    reason: " + quote(item.reason));
  }
  return lines.join("\n") + "\n";
}
