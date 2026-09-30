import type {
  EntitlementGrant,
  EntitlementSet,
  PluginDescriptor,
  Principal,
} from "@myrix/contracts";
import type { PluginCatalog } from "./catalog";

export interface EntitlementInput {
  principal: Principal;
  catalog: PluginCatalog;
  /** 租户级基线：默认启用的插件 id */
  baselineEnabled?: string[];
  grants: readonly EntitlementGrant[];
  /** 主体已解析出的角色/组，用于匹配 grantee（"role:xxx" / "group:xxx"） */
  roleIds?: string[];
  /** 策略引擎的显式拒绝（deny-overrides，优先级最高） */
  deniedPluginIds?: string[];
  /** 平台自身提供的能力，例如 "llm" / "workspace" / "audit" */
  platformCapabilities?: string[];
  now?: () => Date;
}

function grantMatches(grant: EntitlementGrant, input: EntitlementInput): boolean {
  if (grant.tenantId !== input.principal.tenantId && grant.tenantId !== "*") return false;
  const grantees = new Set<string>([
    input.principal.id,
    "tenant:" + input.principal.tenantId,
    ...(input.principal.groups ?? []).map((group) => "group:" + group),
    ...(input.roleIds ?? []).map((role) => "role:" + role),
  ]);
  return grantees.has(grant.grantee);
}

/**
 * 计算某主体最终"能看到/能用"的功能集合。
 *
 * 计算顺序即治理语义：
 *   baseline（租户默认）→ 授权叠加 → 策略 deny 覆盖 → 依赖闭合 → 冲突收敛
 * 每一步都写入 decisions.reason，管理后台据此回答
 * "这个功能为什么没给这个人开"。
 */
export function computeEntitlement(input: EntitlementInput): EntitlementSet {
  const now = input.now?.() ?? new Date();
  const baseline = new Set(input.baselineEnabled ?? []);
  const denied = new Set(input.deniedPluginIds ?? []);
  const decisions = new Map<string, { enabled: boolean; reason: string }>();

  for (const plugin of input.catalog.list()) {
    let enabled = baseline.has(plugin.id) || plugin.defaultEnabled;
    let reason = enabled ? "租户基线默认启用" : "默认关闭";

    const matched = input.grants.filter(
      (grant) => grant.pluginId === plugin.id && grantMatches(grant, input),
    );
    const effective = matched.filter(
      (grant) => grant.expiresAt === undefined || new Date(grant.expiresAt).getTime() > now.getTime(),
    );
    if (effective.length > 0) {
      enabled = true;
      reason = "已授权：" + effective.map((grant) => grant.grantedBy).join(", ");
    } else if (matched.length > 0 && !enabled) {
      reason = "授权已过期";
    }

    if (denied.has(plugin.id)) {
      enabled = false;
      reason = "策略显式拒绝（deny 优先）";
    }

    decisions.set(plugin.id, { enabled, reason });
  }

  const requested = [...decisions.entries()].filter(([, value]) => value.enabled).map(([id]) => id);
  const resolution = input.catalog.resolve(requested, input.platformCapabilities ?? []);
  const enabledIds = new Set(resolution.ordered.map((plugin) => plugin.id));

  for (const item of resolution.missingRequirements) {
    const previous = decisions.get(item.pluginId);
    decisions.set(item.pluginId, {
      enabled: false,
      reason: "缺少依赖能力：" + item.missing.join(", ") + (previous ? "（原状态：" + previous.reason + "）" : ""),
    });
  }

  // 冲突收敛：保留"风险更低"的一方；风险相同则按 id 字典序，保证结果确定
  for (const conflict of resolution.conflicts) {
    const left = input.catalog.get(conflict.left);
    const right = input.catalog.get(conflict.right);
    if (!left || !right) continue;
    const riskRank: Record<PluginDescriptor["risk"], number> = { low: 0, medium: 1, high: 2 };
    const loser =
      riskRank[left.risk] > riskRank[right.risk]
        ? left
        : riskRank[right.risk] > riskRank[left.risk]
          ? right
          : left.id.localeCompare(right.id) > 0
            ? left
            : right;
    const winner = loser.id === left.id ? right : left;
    enabledIds.delete(loser.id);
    decisions.set(loser.id, { enabled: false, reason: "与 " + winner.id + " 互斥，已保留风险更低者" });
  }

  const enabled = [...enabledIds].sort();
  const disabled = input.catalog
    .list()
    .map((plugin) => plugin.id)
    .filter((id) => !enabledIds.has(id))
    .sort();

  return {
    principalId: input.principal.id,
    tenantId: input.principal.tenantId,
    enabled,
    disabled,
    decisions: input.catalog
      .list()
      .map((plugin) => ({
        pluginId: plugin.id,
        enabled: enabledIds.has(plugin.id),
        reason: decisions.get(plugin.id)?.reason ?? "未评估",
      })),
    cordisRowIds: input.catalog
      .list()
      .filter((plugin) => enabledIds.has(plugin.id) && plugin.cordisRowId !== undefined)
      .map((plugin) => plugin.cordisRowId as string),
  };
}
