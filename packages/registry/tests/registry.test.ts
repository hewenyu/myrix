import { describe, expect, it } from "vitest";
import type { EntitlementGrant, PluginDescriptor, Principal } from "@myrix/contracts";
import {
  PluginCatalog,
  buildProfileSpec,
  computeEntitlement,
  renderDshProfile,
  renderProfilePatch,
} from "../src/index";

const plugin = (overrides: Partial<PluginDescriptor> & Pick<PluginDescriptor, "id">): PluginDescriptor => ({
  kind: "dsh-plugin",
  displayName: overrides.id,
  description: "",
  risk: "low",
  requires: [],
  provides: [],
  conflictsWith: [],
  defaultEnabled: false,
  ...overrides,
});

const principal: Principal = {
  id: "u_1001",
  kind: "user",
  tenantId: "acme",
  displayName: "张三",
  department: "engineering",
  groups: ["dept:engineering"],
  attributes: {},
  status: "active",
};

function catalog(): PluginCatalog {
  const instance = new PluginCatalog();
  instance.registerAll([
    plugin({ id: "dsh-base", kind: "dsh-bundle", defaultEnabled: true, provides: ["llm", "workspace"], source: "@deepseek-ai/dsh-base@0.2.0-rc.2", cordisRowId: "base" }),
    plugin({ id: "dsh-web-app", kind: "dsh-bundle", defaultEnabled: true, requires: ["llm"], provides: ["web"], source: "@deepseek-ai/dsh-web-app@0.2.0-rc.2", cordisRowId: "web-app" }),
    plugin({ id: "tool-computer-use", kind: "tool", risk: "high", requires: ["computer-use"], source: "@deepseek-ai/dsh-computer-use@0.2.0-rc.2", cordisRowId: "computer-use" }),
    plugin({ id: "mcp-knowledge", kind: "mcp-server", requires: ["mcp"], source: "@myrix/dsh-plugin-knowledge", cordisRowId: "knowledge-mcp" }),
    plugin({ id: "plugin-mcp", kind: "dsh-plugin", defaultEnabled: true, provides: ["mcp"], source: "@deepseek-ai/dsh-mcp-client@0.2.0-rc.2", cordisRowId: "mcp" }),
  ]);
  return instance;
}

describe("computeEntitlement", () => {
  it("基线 + 授权叠加，且缺少依赖能力时被裁剪并给出原因", () => {
    const grants: EntitlementGrant[] = [
      { pluginId: "tool-computer-use", tenantId: "acme", grantee: "u_1001", grantedBy: "admin", grantedAt: "2026-01-01T00:00:00Z" },
      { pluginId: "mcp-knowledge", tenantId: "acme", grantee: "role:engineer", grantedBy: "admin", grantedAt: "2026-01-01T00:00:00Z" },
    ];
    const set = computeEntitlement({
      principal,
      catalog: catalog(),
      grants,
      roleIds: ["engineer"],
      platformCapabilities: ["llm", "workspace", "file", "shell"],
    });
    expect(set.enabled).toEqual(["dsh-base", "dsh-web-app", "mcp-knowledge", "plugin-mcp"]);
    const decision = set.decisions.find((item) => item.pluginId === "tool-computer-use");
    expect(decision?.enabled).toBe(false);
    expect(decision?.reason).toContain("缺少依赖能力");
  });

  it("策略显式拒绝覆盖授权", () => {
    const set = computeEntitlement({
      principal,
      catalog: catalog(),
      grants: [],
      deniedPluginIds: ["dsh-web-app"],
      platformCapabilities: ["llm"],
    });
    expect(set.enabled).not.toContain("dsh-web-app");
    expect(set.decisions.find((item) => item.pluginId === "dsh-web-app")?.reason).toContain("deny");
  });

  it("过期授权不生效", () => {
    const set = computeEntitlement({
      principal,
      catalog: catalog(),
      grants: [
        {
          pluginId: "tool-computer-use",
          tenantId: "acme",
          grantee: "u_1001",
          grantedBy: "admin",
          grantedAt: "2025-01-01T00:00:00Z",
          expiresAt: "2025-06-01T00:00:00Z",
        },
      ],
      platformCapabilities: ["computer-use"],
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    expect(set.enabled).not.toContain("tool-computer-use");
  });
});

describe("renderProfilePatch", () => {
  it("生成可审计的 profile 补丁文本", () => {
    const set = computeEntitlement({
      principal,
      catalog: catalog(),
      grants: [],
      platformCapabilities: ["llm", "workspace"],
    });
    const spec = buildProfileSpec(set, catalog(), { profile: "enterprise", policyRevision: "r42" });
    const text = renderProfilePatch(spec);
    expect(text).toContain('profile: "enterprise"');
    expect(text).toContain('policyRevision: "r42"');
    expect(text).toContain('  - id: "dsh-base"');
    expect(text).toContain('    source: "@deepseek-ai/dsh-base@0.2.0-rc.2"');
  });
});

describe("renderDshProfile", () => {
  it("被裁剪的行生成 disabled，启用的 bundle 进入 dsh.profile.bundles", () => {
    const instance = catalog();
    const set = computeEntitlement({
      principal,
      catalog: instance,
      grants: [],
      platformCapabilities: ["llm", "workspace"],
    });
    const spec = buildProfileSpec(set, instance, { profile: "enterprise", policyRevision: "r1" });
    const artifacts = renderDshProfile(spec, instance, {
      rowConfig: { "plugin-mcp": "toolCallTimeoutMs: 30000\nmaxInstructionBytes: 4096" },
    });
    // 未授权的高风险插件：关闭对应的 cordis 行
    expect(artifacts.cordisPatch).toContain("- id: computer-use\n  disabled: true");
    expect(artifacts.cordisPatch).toContain("- id: knowledge-mcp\n  disabled: true");
    // 已启用的插件：insert 行 + 部署环境提供的 config
    expect(artifacts.cordisPatch).toContain("    - id: mcp");
    expect(artifacts.cordisPatch).toContain("        toolCallTimeoutMs: 30000");
    // bundle 只出现在 package.json 的 bundles 里，不重复 insert
    expect(artifacts.cordisPatch).not.toContain("    - id: base");
    const pkg = JSON.parse(artifacts.packageJson);
    expect(pkg.dsh.profile.bundles).toEqual([
      "@deepseek-ai/dsh-base@0.2.0-rc.2",
      "@deepseek-ai/dsh-web-app@0.2.0-rc.2",
    ]);
    expect(artifacts.manifest).toContain('"policyRevision": "r1"');
  });
});
