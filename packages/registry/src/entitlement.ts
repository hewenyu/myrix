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
  /**
   * 判定时刻。必填，且必须是纯函数：本模块不读系统时钟，
   * 过期授权与 profile 的 generatedAt 都取自这里，保证结果可复放。
   */
  now: () => Date;
}

/** 只有 active 主体才参与授权计算；其余状态（含未知值）一律全量禁用 */
function principalDisabledReason(status: Principal["status"]): string | undefined {
  if (status === "active") return undefined;
  if (status === "disabled") return "主体已被禁用（status=disabled），全部功能按拒绝处理";
  return "主体状态未知（status=" + JSON.stringify(status) + "），按 fail-closed 全部拒绝";
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
 *   principal.status 门禁 → baseline（租户默认）→ 授权叠加 → 策略 deny 覆盖
 *   → 依赖闭合 → 冲突收敛 → 冲突后再次依赖闭合
 * 每一步都写入 decisions.reason，管理后台据此回答
 * "这个功能为什么没给这个人开"。
 *
 * 时钟：`now` 由调用方注入，本函数不读系统时钟。
 */
export function computeEntitlement(input: EntitlementInput): EntitlementSet {
  const now = input.now();
  const principalBlock = principalDisabledReason(input.principal.status);
  const baseline = new Set(input.baselineEnabled ?? []);
  const denied = new Set(input.deniedPluginIds ?? []);
  const decisions = new Map<string, { enabled: boolean; reason: string }>();

  for (const plugin of input.catalog.list()) {
    // 主体状态门禁优先于一切：非 active（含未知值）不参与基线、授权与平台能力
    if (principalBlock !== undefined) {
      decisions.set(plugin.id, { enabled: false, reason: principalBlock });
      continue;
    }

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
  let enabledIds = new Set(resolution.ordered.map((plugin) => plugin.id));

  for (const item of [...resolution.missingRequirements, ...resolution.cascadedRequirements]) {
    const previous = decisions.get(item.pluginId);
    decisions.set(item.pluginId, {
      enabled: false,
      reason: "缺少依赖能力：" + item.missing.join(", ") + (previous ? "（原状态：" + previous.reason + "）" : ""),
    });
  }

  // 冲突收敛：保留"风险更低"的一方；风险相同则按 id 字典序，保证结果确定
  const removedByConflict = new Set<string>();
  for (const conflict of resolution.conflicts) {
    const left = input.catalog.get(conflict.left);
    const right = input.catalog.get(conflict.right);
    if (!left || !right || !enabledIds.has(left.id) || !enabledIds.has(right.id)) continue;
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
    removedByConflict.add(loser.id);
    decisions.set(loser.id, { enabled: false, reason: "与 " + winner.id + " 互斥，已保留风险更低者" });
  }

  // 冲突裁剪后再次依赖闭合：败者可能正是其他插件 requires 的 provider。
  // 若不重新收敛，消费者（乃至孙级）会继续引用已被禁用的 provider，
  // 渲染出的 profile 就会包含一个"引用了不存在的能力"的插件。
  // 只做移除、不新增提供者，也不会把败者加回来；无冲突裁剪时保持原结果不变。
  if (removedByConflict.size > 0) {
    const reconverged = input.catalog.resolve([...enabledIds], input.platformCapabilities ?? []);
    enabledIds = new Set(reconverged.ordered.map((plugin) => plugin.id));
    for (const item of [...reconverged.missingRequirements, ...reconverged.cascadedRequirements]) {
      if (removedByConflict.has(item.pluginId)) continue;
      const previous = decisions.get(item.pluginId);
      decisions.set(item.pluginId, {
        enabled: false,
        reason:
          "依赖的插件在冲突收敛中被禁用，缺少依赖能力：" +
          item.missing.join(", ") +
          (previous ? "（原状态：" + previous.reason + "）" : ""),
      });
    }
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
