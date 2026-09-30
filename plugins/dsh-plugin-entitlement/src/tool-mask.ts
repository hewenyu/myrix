import type { ToolMask } from "@myrix/dsh-shim";

/** 插件 → 它提供的工具名。由控制面在渲染 profile 时下发，避免在 DSH 侧硬编码。 */
export interface ToolOwnership {
  pluginId: string;
  tools: string[];
}

/**
 * 由授权结果生成工具可见性掩码。
 *
 * 语义：deny 优先于 allow；DSH 侧多次 restrict 取交集，所以这里只做"加法到掩码"的翻译。
 * 若没有任何归属信息，返回 undefined —— 宁可不施加掩码，也不要因为空 allow 列表把工具全禁掉。
 */
export function toToolMask(
  enabledPluginIds: readonly string[],
  owners: readonly ToolOwnership[],
): ToolMask | undefined {
  if (owners.length === 0) return undefined;
  const enabled = new Set(enabledPluginIds);
  const allow = new Set<string>();
  const deny = new Set<string>();
  for (const owner of owners) {
    for (const tool of owner.tools) {
      if (enabled.has(owner.pluginId)) allow.add(tool);
      else deny.add(tool);
    }
  }
  for (const tool of deny) allow.delete(tool);
  return { allow: [...allow].sort(), deny: [...deny].sort() };
}

/** 掩码差异：管理后台"下发变更"后可用于审计与前端提示 */
export function diffMask(
  previous: ToolMask | undefined,
  next: ToolMask | undefined,
): { added: string[]; removed: string[] } {
  const before = new Set(previous?.allow ?? []);
  const after = new Set(next?.allow ?? []);
  return {
    added: [...after].filter((tool) => !before.has(tool)).sort(),
    removed: [...before].filter((tool) => !after.has(tool)).sort(),
  };
}
