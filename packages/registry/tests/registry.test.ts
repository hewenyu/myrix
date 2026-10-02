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

/** 固定时刻：registry 不读系统时钟，所有断言都必须钉在这一刻 */
const FIXED_ISO = "2026-01-01T00:00:00.000Z";
const NOW = (): Date => new Date(FIXED_ISO);

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
      now: NOW,
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
      now: NOW,
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

  it("过期边界：expiresAt 等于 now 视为已过期，晚 1ms 视为有效", () => {
    const grantAt = (expiresAt: string): EntitlementGrant[] => [
      {
        pluginId: "tool-computer-use",
        tenantId: "acme",
        grantee: "u_1001",
        grantedBy: "admin",
        grantedAt: "2025-01-01T00:00:00Z",
        expiresAt,
      },
    ];
    const base = {
      principal,
      catalog: catalog(),
      platformCapabilities: ["computer-use"],
      now: () => new Date(FIXED_ISO),
    };

    const atBoundary = computeEntitlement({ ...base, grants: grantAt(FIXED_ISO) });
    expect(atBoundary.enabled).not.toContain("tool-computer-use");
    expect(atBoundary.decisions.find((item) => item.pluginId === "tool-computer-use")?.reason).toBe(
      "授权已过期",
    );

    const justValid = computeEntitlement({ ...base, grants: grantAt("2026-01-01T00:00:00.001Z") });
    expect(justValid.enabled).toContain("tool-computer-use");
  });

  it("主体非 active 时全部功能被禁用，并给出可读原因", () => {
    const disabled: Principal = { ...principal, status: "disabled" };
    const set = computeEntitlement({
      principal: disabled,
      catalog: catalog(),
      grants: [
        {
          pluginId: "tool-computer-use",
          tenantId: "acme",
          grantee: "u_1001",
          grantedBy: "admin",
          grantedAt: "2025-01-01T00:00:00Z",
        },
      ],
      // 即使平台能力齐备、显式授权存在，也不得放行
      platformCapabilities: ["llm", "workspace", "computer-use"],
      now: NOW,
    });

    expect(set.enabled).toEqual([]);
    expect(set.disabled).toEqual([
      "dsh-base",
      "dsh-web-app",
      "mcp-knowledge",
      "plugin-mcp",
      "tool-computer-use",
    ]);
    expect(set.cordisRowIds).toEqual([]);
    for (const decision of set.decisions) {
      expect(decision.enabled).toBe(false);
      expect(decision.reason).toContain("status=disabled");
    }
  });

  it("未知主体状态按 fail-closed 全量拒绝", () => {
    const unknown = { ...principal, status: "suspended" } as unknown as Principal;
    const set = computeEntitlement({
      principal: unknown,
      catalog: catalog(),
      grants: [],
      platformCapabilities: ["llm", "workspace"],
      now: NOW,
    });

    expect(set.enabled).toEqual([]);
    for (const decision of set.decisions) {
      expect(decision.reason).toContain("suspended");
      expect(decision.reason).toContain("fail-closed");
    }
  });

  it("冲突裁掉 provider 后，consumer 与孙级一并禁用且原因可读", () => {
    const instance = new PluginCatalog();
    instance.registerAll([
      // 唯一提供 "cap" 的一方风险更高，冲突收敛必然裁掉它；
      // 其对手不提供 "cap"，因此消费者与孙级都无法再满足依赖。
      plugin({
        id: "zz-provider",
        risk: "high",
        provides: ["cap"],
        defaultEnabled: true,
        conflictsWith: ["aa-rival"],
      }),
      plugin({
        id: "aa-rival",
        risk: "low",
        provides: ["other"],
        defaultEnabled: true,
        conflictsWith: ["zz-provider"],
      }),
      plugin({ id: "consumer", requires: ["cap"], provides: ["consumer-cap"], defaultEnabled: true }),
      plugin({ id: "grandchild", requires: ["consumer-cap"], defaultEnabled: true }),
    ]);

    const set = computeEntitlement({
      principal,
      catalog: instance,
      grants: [],
      now: NOW,
    });

    expect(set.enabled).toEqual(["aa-rival"]);
    const reasonOf = (id: string) => set.decisions.find((item) => item.pluginId === id)?.reason ?? "";
    expect(reasonOf("zz-provider")).toContain("保留风险更低者");
    expect(reasonOf("consumer")).toContain("冲突收敛中被禁用");
    expect(reasonOf("consumer")).toContain("cap");
    expect(reasonOf("grandchild")).toContain("冲突收敛中被禁用");
    expect(reasonOf("grandchild")).toContain("consumer-cap");
  });

  it("无冲突时不触发二次收敛：原有依赖原因保持原样", () => {
    const set = computeEntitlement({
      principal,
      catalog: catalog(),
      grants: [
        // 已授权但能力缺失，第一轮就被裁掉——不应被改写成"冲突收敛"原因
        { pluginId: "tool-computer-use", tenantId: "acme", grantee: "u_1001", grantedBy: "admin", grantedAt: "2025-01-01T00:00:00Z" },
      ],
      platformCapabilities: ["llm", "workspace"],
      now: NOW,
    });
    const reason = set.decisions.find((item) => item.pluginId === "tool-computer-use")?.reason ?? "";
    expect(reason).toContain("缺少依赖能力");
    expect(reason).not.toContain("冲突收敛");
  });

  it("依赖闭包每层均保留缺失原因，已裁掉的冲突对手不再误删可用插件", () => {
    const instance = new PluginCatalog();
    instance.registerAll([
      plugin({ id: "provider", defaultEnabled: true, requires: ["missing"], provides: ["cap"], conflictsWith: ["viable"] }),
      plugin({ id: "consumer", defaultEnabled: true, requires: ["cap"], provides: ["child-cap"] }),
      plugin({ id: "grandchild", defaultEnabled: true, requires: ["child-cap"] }),
      plugin({ id: "viable", defaultEnabled: true, risk: "high" }),
    ]);
    const set = computeEntitlement({ principal, catalog: instance, grants: [], now: NOW });
    expect(set.enabled).toEqual(["viable"]);
    for (const id of ["provider", "consumer", "grandchild"]) {
      const decision = set.decisions.find(item => item.pluginId === id);
      expect(decision?.enabled).toBe(false);
      expect(decision?.reason).toContain("缺少依赖能力");
    }
  });

  it("固定 now 下重复计算结果稳定，且不被系统时钟影响", () => {
    const input = {
      principal,
      catalog: catalog(),
      grants: [
        {
          pluginId: "mcp-knowledge",
          tenantId: "acme",
          grantee: "u_1001",
          grantedBy: "admin",
          grantedAt: "2025-01-01T00:00:00Z",
          expiresAt: "2030-01-01T00:00:00Z",
        },
      ],
      platformCapabilities: ["llm", "workspace", "mcp"],
      now: NOW,
    };
    const first = computeEntitlement(input);
    const second = computeEntitlement(input);
    expect(second).toEqual(first);
    expect(second.enabled).toEqual(["dsh-base", "dsh-web-app", "mcp-knowledge", "plugin-mcp"]);

    const spec = buildProfileSpec(first, input.catalog, {
      profile: "enterprise",
      policyRevision: "r7",
      now: NOW,
    });
    expect(spec.generatedAt).toBe(FIXED_ISO);
    expect(buildProfileSpec(first, input.catalog, { profile: "enterprise", policyRevision: "r7", now: NOW })).toEqual(spec);
  });
});

describe("renderProfilePatch", () => {
  it("生成可审计的 profile 补丁文本", () => {
    const set = computeEntitlement({
      principal,
      catalog: catalog(),
      grants: [],
      platformCapabilities: ["llm", "workspace"],
      now: NOW,
    });
    const spec = buildProfileSpec(set, catalog(), { profile: "enterprise", policyRevision: "r42", now: NOW });
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
      now: NOW,
    });
    const spec = buildProfileSpec(set, instance, { profile: "enterprise", policyRevision: "r1", now: NOW });
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
