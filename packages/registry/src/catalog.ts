import type { PluginDescriptor } from "@myrix/contracts";

export interface CatalogResolution {
  /** 依赖闭合后的有序插件列表 */
  ordered: PluginDescriptor[];
  /** 缺少依赖能力的插件（不会被启用） */
  missingRequirements: { pluginId: string; missing: string[] }[];
  /** 互斥冲突对 */
  conflicts: { left: string; right: string }[];
  /**
   * 因依赖的 provider 被禁用而连锁禁用的插件（消费者/孙级）。
   * 只记录由连锁导致的再次收敛，首次依赖检查的结果仍在 missingRequirements 里。
   */
  cascadedRequirements: { pluginId: string; missing: string[] }[];
}

/**
 * 插件目录：平台"功能裁剪"的唯一事实来源。
 * 目录条目既可以是 DSH 的 bundle/plugin，也可以是 tool / skill / mcp-server，
 * 管理后台把它们统一呈现为"可选功能"。
 */
export class PluginCatalog {
  private readonly plugins = new Map<string, PluginDescriptor>();

  register(descriptor: PluginDescriptor): void {
    this.plugins.set(descriptor.id, descriptor);
  }

  registerAll(descriptors: readonly PluginDescriptor[]): void {
    for (const descriptor of descriptors) this.register(descriptor);
  }

  get(id: string): PluginDescriptor | undefined {
    return this.plugins.get(id);
  }

  list(): PluginDescriptor[] {
    return [...this.plugins.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  /**
   * 依赖闭合：只有 requires 被"已启用插件提供的能力"或"平台能力"满足时才保留。
   * 迭代到不动点，因此 A 依赖 B、B 依赖 C 的链条会被整体判定。
   *
   * `resolve` 的输入是"候选集合"，冲突收敛发生在调用方；因此这里额外返回
   * `cascadedRequirements`，让调用方在裁掉冲突败者后能再跑一次闭合，
   * 避免消费者继续引用已经被禁用的 provider。
   */
  resolve(
    requestedIds: readonly string[],
    platformCapabilities: readonly string[] = [],
  ): CatalogResolution {
    const requested = new Set(requestedIds);
    const enabled = new Set<string>();
    for (const id of requested) {
      if (this.plugins.has(id)) enabled.add(id);
    }

    const conflicts: { left: string; right: string }[] = [];
    for (const plugin of this.list()) {
      if (!enabled.has(plugin.id)) continue;
      for (const other of plugin.conflictsWith) {
        if (enabled.has(other)) conflicts.push({ left: plugin.id, right: other });
      }
    }

    const { missingRequirements, cascadedRequirements } = this.closeDependencies(
      enabled,
      platformCapabilities,
    );

    return {
      ordered: this.list().filter((plugin) => enabled.has(plugin.id)),
      missingRequirements,
      conflicts,
      cascadedRequirements,
    };
  }

  /**
   * 依赖闭合到不动点（会就地修改 enabled）：
   * 第一轮被裁掉的记入 missingRequirements；由这些裁剪间接引发的后续裁剪
   * 记入 cascadedRequirements，便于调用方区分"自己缺能力"和"被上游拖累"。
   */
  private closeDependencies(
    enabled: Set<string>,
    platformCapabilities: readonly string[],
  ): Pick<CatalogResolution, "missingRequirements" | "cascadedRequirements"> {
    const missingRequirements: { pluginId: string; missing: string[] }[] = [];
    const cascadedRequirements: { pluginId: string; missing: string[] }[] = [];
    let changed = true;
    let round = 0;
    while (changed) {
      changed = false;
      const provided = new Set<string>(platformCapabilities);
      for (const id of enabled) {
        for (const capability of this.plugins.get(id)?.provides ?? []) provided.add(capability);
      }
      for (const id of [...enabled]) {
        const plugin = this.plugins.get(id);
        if (!plugin) continue;
        const missing = plugin.requires.filter((requirement) => !provided.has(requirement));
        if (missing.length > 0) {
          enabled.delete(id);
          (round === 0 ? missingRequirements : cascadedRequirements).push({ pluginId: id, missing });
          changed = true;
        }
      }
      round += 1;
    }
    return { missingRequirements, cascadedRequirements };
  }
}
