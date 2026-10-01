import { describe, expect, it } from "vitest";
import type { PolicyRequest, PolicyRule, SubjectContext } from "@myrix/contracts";
import {
  RoleStore,
  decide,
  evaluateCondition,
  globMatches,
  mergeObligations,
  type EvalContext,
} from "../src/index";

function subject(overrides: Partial<SubjectContext> = {}): SubjectContext {
  return {
    principalId: "u_1001",
    tenantId: "acme",
    groups: ["dept:engineering"],
    department: "engineering",
    attributes: { level: 3, remote: true },
    ...overrides,
  };
}

function request(overrides: Partial<PolicyRequest> = {}): PolicyRequest {
  return {
    subject: subject(),
    action: "tool:bash",
    resource: { type: "tool", id: "bash" },
    context: { riskScore: 10 },
    ...overrides,
  };
}

const ctx: EvalContext = {
  subject: subject(),
  resource: { type: "tool", id: "bash" },
  action: "tool:bash",
  context: { riskScore: 10 },
};

describe("globMatches", () => {
  it("支持段内与跨段通配", () => {
    expect(globMatches("tool:*", "tool:bash")).toBe(true);
    expect(globMatches("tool:*", "tool:fs:write")).toBe(true);
    expect(globMatches("*", "anything:at:all")).toBe(true);
    expect(globMatches("kb:finance-*", "kb:finance-2024")).toBe(true);
    expect(globMatches("kb:finance-*", "kb:hr-2024")).toBe(false);
  });
});

describe("evaluateCondition", () => {
  it("支持 eq / in / contains / 数值比较", () => {
    expect(evaluateCondition({ attr: "subject.department", op: "eq", value: "engineering" }, ctx)).toBe(true);
    expect(evaluateCondition({ attr: "subject.groups", op: "in", value: ["dept:risk"] }, ctx)).toBe(false);
    expect(evaluateCondition({ attr: "subject.attributes.level", op: "gte", value: 3 }, ctx)).toBe(true);
    expect(evaluateCondition({ attr: "subject.groups", op: "contains", value: "dept:engineering" }, ctx)).toBe(true);
  });

  it("支持 all / any / none 组合", () => {
    const expr = {
      all: [{ attr: "subject.department", op: "eq" as const, value: "engineering" }],
      none: [{ attr: "context.riskScore", op: "gt" as const, value: 50 }],
    };
    expect(evaluateCondition(expr, ctx)).toBe(true);
    expect(evaluateCondition(expr, { ...ctx, context: { riskScore: 90 } })).toBe(false);
  });

  it("字段缺失按不成立处理，非法正则不抛错", () => {
    expect(evaluateCondition({ attr: "subject.attributes.missing", op: "exists" }, ctx)).toBe(false);
    expect(evaluateCondition({ attr: "subject.department", op: "matches", value: "([a-z" }, ctx)).toBe(false);
  });
});

describe("decide", () => {
  const NOW = new Date("2026-09-30T12:00:00.000Z");
  const rules: PolicyRule[] = [
    {
      id: "allow-bash-workspace",
      effect: "allow",
      actions: ["tool:bash"],
      resources: ["tool:*"],
      obligations: [
        { kind: "sandbox", mode: "workspace-write" },
        { kind: "audit", level: "metadata" },
      ],
    },
    {
      id: "deny-high-risk",
      effect: "deny",
      actions: ["tool:*"],
      resources: ["tool:*"],
      condition: { attr: "context.riskScore", op: "gt", value: 50 },
    },
  ];

  it("deny 优先于 allow", () => {
    const allowed = decide(request(), rules, { policyRevision: "r1", now: NOW });
    expect(allowed.effect).toBe("allow");
    expect(allowed.matched).toBe("explicit-allow");
    expect(allowed.policyRevision).toBe("r1");

    const denied = decide(request({ context: { riskScore: 80 } }), rules, { now: NOW });
    expect(denied.effect).toBe("deny");
    expect(denied.matched).toBe("explicit-deny");
    expect(denied.matchedRules).toEqual(["deny-high-risk"]);
  });

  it("无规则命中时默认拒绝（fail-closed）", () => {
    const decision = decide(request({ action: "tool:unknown" }), rules, { now: NOW });
    expect(decision.effect).toBe("deny");
    expect(decision.matched).toBe("default-deny");
  });

  it("时钟由调用方注入：evaluatedAt 取注入值，不读系统时钟", () => {
    const before = new Date().toISOString();
    const decision = decide(request(), rules, { now: "2020-01-02T03:04:05.000Z" });
    expect(decision.evaluatedAt).toBe("2020-01-02T03:04:05.000Z");
    // 注入的时刻明显早于当前时间，证明没有回退到 Date.now()
    expect(decision.evaluatedAt < before).toBe(true);

    const asDate = decide(request(), rules, { now: new Date("2021-05-06T07:08:09.000Z") });
    expect(asDate.evaluatedAt).toBe("2021-05-06T07:08:09.000Z");
  });

  it("defaultEffect 只接受 deny：allow 在类型层就被拒绝", () => {
    const decision = decide(request({ action: "tool:unknown" }), rules, {
      now: NOW,
      defaultEffect: "deny",
    });
    expect(decision.effect).toBe("deny");
    expect(decision.matched).toBe("default-deny");

    // @ts-expect-error 首版禁止"默认放行"：defaultEffect 的类型已收窄为 "deny"
    expect(() => decide(request(), rules, { now: NOW, defaultEffect: "allow" })).not.toThrow();
  });

  it("租户隔离：别的租户的规则不参与判定", () => {
    const tenantRule: PolicyRule = {
      id: "other-tenant-allow",
      tenantId: "other",
      effect: "allow",
      actions: ["*"],
      resources: ["*"],
    };
    expect(decide(request(), [tenantRule], { now: NOW }).effect).toBe("deny");
  });
});

describe("mergeObligations", () => {
  it("沙箱取最严格、审批取并集、范围取交集", () => {
    const merged = mergeObligations([
      { kind: "sandbox", mode: "danger-full-access" },
      { kind: "sandbox", mode: "read-only" },
      { kind: "approval", required: false },
      { kind: "approval", required: true, reason: "生产数据" },
      { kind: "knowledgeScope", baseIds: ["kb-a", "kb-b"] },
      { kind: "knowledgeScope", baseIds: ["kb-b", "kb-c"] },
      { kind: "rateLimit", key: "llm", perMinute: 60 },
      { kind: "rateLimit", key: "llm", perMinute: 10 },
    ]);
    expect(merged).toContainEqual({ kind: "sandbox", mode: "read-only" });
    expect(merged).toContainEqual({ kind: "approval", required: true, reason: "生产数据" });
    expect(merged).toContainEqual({ kind: "knowledgeScope", baseIds: ["kb-b"] });
    expect(merged).toContainEqual({ kind: "rateLimit", key: "llm", perMinute: 10 });
  });
});

describe("RoleStore", () => {
  it("展开继承链并暴露缺失角色", () => {
    const store = new RoleStore();
    store.upsert({ id: "employee", name: "员工", permissions: ["plugin:web", "kb:read"], inherits: [] });
    store.upsert({ id: "engineer", name: "研发", permissions: ["tool:bash"], inherits: ["employee"] });
    const resolved = store.resolve("u_1001", "acme", [
      { principalId: "u_1001", roleId: "engineer", tenantId: "acme" },
      { principalId: "u_1001", roleId: "ghost", tenantId: "acme" },
      { principalId: "u_1001", roleId: "engineer", tenantId: "other-tenant" },
    ]);
    expect(resolved.roles).toEqual(["engineer", "employee"]);
    expect(resolved.permissions).toEqual(["kb:read", "plugin:web", "tool:bash"]);
    expect(resolved.unresolvedRoles).toEqual(["ghost"]);
  });
});
