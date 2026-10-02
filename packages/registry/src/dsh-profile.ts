import type { PluginCatalog } from "./catalog";
import type { ProfileSpec } from "./profile";

export interface DshProfileOptions {
  /** pluginId → 预渲染的 YAML config 片段（不含缩进基准），由调用方按部署环境提供 */
  rowConfig?: Record<string, string>;
  profileName?: string;
}

export interface DshProfileArtifacts {
  /** profile 的 cordis.patch.yml（真实 DSH patch 语法：按 id 覆盖 / disabled / insert） */
  cordisPatch: string;
  /** profile 的 package.json（dsh.profile.bundles 声明在本 profile 里堆叠的 bundle） */
  packageJson: string;
  /** 中间表示，便于审计"为什么这个人有这些功能" */
  manifest: string;
}

function quote(value: string): string {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function indentBlock(block: string, spaces: number): string[] {
  const prefix = " ".repeat(spaces);
  return block
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => prefix + line);
}

/**
 * 把授权结果渲染成 DSH 真正需要的 profile 产物。
 *
 * 关键取舍：**默认用"关行"而不是"不插入"**。
 * - 被裁剪的 in-box 行用 `- id: <row>\n  disabled: true` 关闭：profile 层可覆盖基础 bundle，
 *   行为可预测，也便于审计；
 * - 平台插件（myrix-*）用 insert 行挂载，config 由部署环境提供；
 * - 高风险功能若要"连代码都不加载"，应把它从 bundle 依赖里摘掉（packageJson 的 bundles 只列启用的 bundle）。
 *
 * 依据：DSH patch 语法与层序见 docs/integration/dsh-seams.md（原始证据 docs/research/dsh-seams-raw.md）。
 */
export function renderDshProfile(
  spec: ProfileSpec,
  catalog: PluginCatalog,
  options: DshProfileOptions = {},
): DshProfileArtifacts {
  const enabled = new Set(spec.enabled.map((item) => item.id));
  const lines: string[] = [
    "# 由 Myrix 控制面生成，请勿手工修改。",
    "# principal: " + spec.principalId + "  tenant: " + spec.tenantId,
    "# policyRevision: " + spec.policyRevision + "  generatedAt: " + spec.generatedAt,
  ];

  for (const plugin of catalog.list()) {
    if (enabled.has(plugin.id) || plugin.cordisRowId === undefined) continue;
    lines.push("- id: " + plugin.cordisRowId);
    lines.push("  disabled: true");
  }

  const inserts: string[] = [];
  for (const plugin of catalog.list()) {
    // bundle 通过 package.json 的 dsh.profile.bundles 声明，不再单独 insert 同一行
    if (plugin.kind === "dsh-bundle") continue;
    if (!enabled.has(plugin.id) || plugin.cordisRowId === undefined || plugin.source === undefined) continue;
    inserts.push("    - id: " + plugin.cordisRowId);
    inserts.push("      name: " + quote(plugin.source));
    const config = options.rowConfig?.[plugin.id];
    if (config !== undefined) {
      inserts.push("      config:");
      inserts.push(...indentBlock(config, 8));
    }
  }
  if (inserts.length > 0) {
    lines.push("- insert:");
    lines.push(...inserts);
  }

  const bundles = catalog
    .list()
    .filter((plugin) => plugin.kind === "dsh-bundle" && enabled.has(plugin.id) && plugin.source !== undefined)
    .map((plugin) => plugin.source as string);

  const packageJson = JSON.stringify(
    {
      name: "dsh-profile-" + (options.profileName ?? spec.profile),
      private: true,
      type: "module",
      dependencies: {},
      dsh: {
        profile: {
          bundles,
        },
      },
    },
    null,
    2,
  );

  return {
    cordisPatch: lines.join("\n") + "\n",
    packageJson: packageJson + "\n",
    manifest: JSON.stringify(spec, null, 2) + "\n",
  };
}
