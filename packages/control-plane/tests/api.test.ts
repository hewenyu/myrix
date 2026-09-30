import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createControlPlane } from "../src/server";
import { GovernanceStore } from "../src/store";

const TOKEN = "test-token";
let server: Server;
let baseUrl = "";

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(baseUrl + path, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + TOKEN,
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : undefined };
}

beforeAll(async () => {
  const store = new GovernanceStore();
  const controlPlane = createControlPlane({ store, adminToken: TOKEN });
  server = controlPlane.server;
  const started = await controlPlane.listen(0);
  baseUrl = started.url;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("控制面 HTTP API", () => {
  it("健康检查免鉴权，/api 需要令牌", async () => {
    const health = await fetch(baseUrl + "/healthz");
    expect(health.status).toBe(200);

    const unauthorized = await fetch(baseUrl + "/api/v1/principals");
    expect(unauthorized.status).toBe(401);

    const authorized = await api("/api/v1/principals");
    expect(authorized.status).toBe(200);
    expect(authorized.body.items.map((item: { id: string }) => item.id)).toContain("u_1001");
  });

  it("研发使用 bash：策略放行并下发 workspace-write 义务", async () => {
    const { status, body } = await api("/api/v1/decisions", {
      method: "POST",
      body: JSON.stringify({
        principalId: "u_1001",
        action: "tool:bash",
        resource: { type: "tool", id: "bash" },
        context: { riskScore: 10 },
      }),
    });
    expect(status).toBe(200);
    expect(body.decision.effect).toBe("allow");
    expect(body.decision.obligations).toContainEqual({ kind: "sandbox", mode: "workspace-write" });
  });

  it("财务使用 bash：RBAC 权限点未覆盖，直接拒绝", async () => {
    const { body } = await api("/api/v1/decisions", {
      method: "POST",
      body: JSON.stringify({ principalId: "u_1002", action: "tool:bash", resource: { type: "tool", id: "bash" } }),
    });
    expect(body.decision.effect).toBe("deny");
    expect(body.source).toBe("rbac");
  });

  it("财务知识库：非财务组被 deny 覆盖，财务组放行并限定范围", async () => {
    const engineer = await api("/api/v1/decisions", {
      method: "POST",
      body: JSON.stringify({ principalId: "u_1001", action: "kb:search", resource: { type: "kb", id: "finance-2026" } }),
    });
    expect(engineer.body.decision.effect).toBe("deny");

    const finance = await api("/api/v1/decisions", {
      method: "POST",
      body: JSON.stringify({ principalId: "u_1002", action: "kb:search", resource: { type: "kb", id: "finance-2026" } }),
    });
    expect(finance.body.decision.effect).toBe("allow");
    expect(finance.body.decision.obligations).toContainEqual({
      kind: "knowledgeScope",
      baseIds: ["kb-finance", "kb-handbook"],
    });
  });

  it("管理员使用高风险工具：放行但要求审批", async () => {
    const { body } = await api("/api/v1/decisions", {
      method: "POST",
      body: JSON.stringify({ principalId: "u_1003", action: "tool:computer-use", resource: { type: "tool", id: "computer-use" } }),
    });
    expect(body.decision.effect).toBe("allow");
    expect(body.decision.obligations).toContainEqual({
      kind: "approval",
      required: true,
      reason: "高风险工具：需管理员审批",
    });
  });

  it("功能裁剪：缺依赖能力的高风险插件被裁掉，知识库插件按角色授权开启", async () => {
    const { body } = await api("/api/v1/principals/u_1001/entitlements");
    expect(body.enabled).toContain("myrix-plugin-knowledge");
    expect(body.enabled).not.toContain("tool-computer-use");
    // tool-browser-use 由 demo 种子授权给 u_1001，但缺少 browser-runtime 能力 → 依赖闭合阶段被裁剪
    expect(body.enabled).not.toContain("tool-browser-use");
    expect(body.decisions.find((item: { pluginId: string }) => item.pluginId === "tool-browser-use").reason).toContain(
      "缺少依赖能力",
    );

    const profile = await api("/api/v1/principals/u_1001/profile");
    expect(profile.body.yaml).toContain('principal: "u_1001"');
    expect(profile.body.spec.enabled.length).toBeGreaterThan(0);
  });

  it("知识库检索按主体可见性收窄", async () => {
    const engineer = await api("/api/v1/knowledge/search", {
      method: "POST",
      body: JSON.stringify({ principalId: "u_1001", text: "", topK: 10 }),
    });
    const baseIds = new Set(engineer.body.chunks.map((chunk: { baseId: string }) => chunk.baseId));
    expect(baseIds.has("kb-finance")).toBe(false);
    expect(baseIds.has("kb-handbook")).toBe(true);

    const finance = await api("/api/v1/knowledge/search", {
      method: "POST",
      body: JSON.stringify({ principalId: "u_1002", text: "营收", topK: 10 }),
    });
    expect(finance.body.chunks.map((chunk: { baseId: string }) => chunk.baseId)).toContain("kb-finance");
  });

  it("管理写操作产生审计事件", async () => {
    const created = await api("/api/v1/admin/grants", {
      method: "POST",
      body: JSON.stringify({
        pluginId: "tool-computer-use",
        tenantId: "acme",
        grantee: "u_1002",
        grantedBy: "admin:test",
      }),
    });
    expect(created.status).toBe(201);

    const audit = await api("/api/v1/audit?limit=20");
    expect(audit.body.items.some((event: { category: string }) => event.category === "admin-change")).toBe(true);
    expect(audit.body.items.some((event: { category: string }) => event.category === "policy-decision")).toBe(true);
  });

  it("网关契约端点声明了模型与审计的边界", async () => {
    const { body } = await api("/api/v1/gateway/contract");
    expect(body.auditJoinKeys).toContain("traceId");
    expect(body.responsibilities.join(" ")).toContain("模型白名单");
  });
});
