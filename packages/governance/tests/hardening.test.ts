/**
 * 治理加固回归测试（对应当前审查发现的问题）：
 *
 * 1. `decide` / `ruleMatches` 对 `resource:{}`、`subject:{}` 这类缺字段请求可被通用 allow 绕过；
 * 2. `mergeObligations` 遇到未知 sandbox mode 时 rank 为 undefined，合并结果与输入顺序相关；
 * 3. 条件缺 `value` 时 `eq` 的 `undefined === undefined`、`startsWith`/`contains` 的 `String()` 兜底会放行；
 * 4. 非法 `matches` 正则此前被 `catch` 成普通 notMatched，挂在 deny 上会被通用 allow 绕过；
 * 5. `in`/`notIn`/`contains`/比较运算缺 op-specific value 类型校验，布尔/数组/对象经强制转换伪造结论；
 * 6. 叶子混入 all/any/none 或未知键、分组内混入 undefined、循环/过深表达式被静默忽略或栈溢出；
 * 7. `RoleStore.get/list` 返回内部对象可被外部改写，`list(tenantId)` 同名全局角色重复出现；
 * 8. `RoleStore.resolve` 不校验角色租户，同 id 角色跨租户互相覆盖。
 *
 * 每个反例都同时保留一条现有成功路径，防止"加固"把正常判定一起打死。
 */
import { describe, expect, it } from "vitest";
import type {
  ConditionExpr,
  PolicyRequest,
  PolicyRule,
  Role,
  SubjectContext,
} from "@myrix/contracts";
import {
  RoleStore,
  decide,
  decideExplained,
  evaluateCondition,
  evaluateConditionDetailed,
  mergeObligations,
  ruleMatches,
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

const NOW = new Date("2026-10-01T00:00:00.000Z");

/** 策略里出现畸形条件（绕过类型）时的构造辅助 */
function rawCondition(expr: unknown): ConditionExpr {
  return expr as ConditionExpr;
}

describe("decide：请求合法性（resource/action 非空、default-deny 可读原因）", () => {
  const broadAllow: PolicyRule = {
    id: "allow-everything",
    effect: "allow",
    actions: ["*"],
    resources: ["*"],
  };
  const resourceDeny: PolicyRule = {
    id: "deny-bash",
    effect: "deny",
    actions: ["tool:bash"],
    resources: ["tool:bash"],
  };

  it("resource 缺字段（{}）时通用 allow 不能绕过资源 deny", () => {
    // 反例：历史实现把 resourceKey 拼成 "undefined:undefined"，通用 resources:["*"] 会命中并放行
    const malformed = request({ resource: {} as PolicyRequest["resource"] });
    const explained = decideExplained(malformed, [broadAllow, resourceDeny], { now: NOW });
    expect(explained.decision.effect).toBe("deny");
    expect(explained.reasonKind).toBe("invalid-request");
    expect(explained.decision.matched).toBe("default-deny");
    expect(explained.decision.matchedRules).toEqual([]);
    expect(explained.reason.startsWith("拒绝：")).toBe(true);
    expect(explained.reason).toContain("resource.type");
  });

  it("resource.type / resource.id 为空串或缺席一律 deny", () => {
    for (const resource of [
      { type: "tool" },
      { id: "bash" },
      { type: "", id: "bash" },
      { type: "tool", id: "" },
      { type: "   ", id: "bash" },
    ]) {
      const explained = decideExplained(
        request({ resource: resource as PolicyRequest["resource"] }),
        [broadAllow],
        { now: NOW },
      );
      expect(explained.decision.effect).toBe("deny");
      expect(explained.reasonKind).toBe("invalid-request");
      expect(explained.reason).toContain("拒绝：");
    }
  });

  it("action 为空串/缺省/非字符串一律 deny，且不匹配 actions:[\"*\"]", () => {
    for (const action of ["", "   ", undefined, 42, null]) {
      const explained = decideExplained(
        request({ action: action as unknown as string }),
        [broadAllow],
        { now: NOW },
      );
      expect(explained.decision.effect).toBe("deny");
      expect(explained.reasonKind).toBe("invalid-request");
      expect(explained.reason).toContain("action");
    }
  });

  it("缺少 subject 或缺整个 resource 时 deny", () => {
    const noSubject = decideExplained(
      request({ subject: undefined as unknown as SubjectContext }),
      [broadAllow],
      { now: NOW },
    );
    expect(noSubject.decision.effect).toBe("deny");
    expect(noSubject.reasonKind).toBe("invalid-request");

    const noResource = decideExplained(
      request({ resource: undefined as unknown as PolicyRequest["resource"] }),
      [broadAllow],
      { now: NOW },
    );
    expect(noResource.decision.effect).toBe("deny");
    expect(noResource.reasonKind).toBe("invalid-request");
  });

  it("空主体 / 缺 principalId / 缺 tenantId 时通用 allow 不能放行", () => {
    // 反例：历史实现只要求 subject 是对象，`subject:{}` 会命中 resources:["*"] 的通用 allow
    const brokenSubjects: [string, unknown][] = [
      ["空对象", {}],
      ["缺 principalId", { tenantId: "acme" }],
      ["缺 tenantId", { principalId: "u_1001" }],
      ["principalId 为空串", { principalId: "", tenantId: "acme" }],
      ["tenantId 为空白", { principalId: "u_1001", tenantId: "   " }],
      ["groups 非数组", { principalId: "u_1001", tenantId: "acme", groups: "dept:eng" }],
      ["attributes 非对象", { principalId: "u_1001", tenantId: "acme", attributes: [] }],
    ];
    for (const [label, subjectOverride] of brokenSubjects) {
      const explained = decideExplained(
        request({ subject: subjectOverride as SubjectContext }),
        [broadAllow],
        { now: NOW },
      );
      expect(explained.decision.effect, label).toBe("deny");
      expect(explained.reasonKind, label).toBe("invalid-request");
      expect(explained.reason, label).toContain("subject");
    }
  });

  it("ruleMatches 同样走请求校验：空主体即使规则通配也不命中", () => {
    expect(ruleMatches(broadAllow, request())).toBe(true);
    expect(ruleMatches(broadAllow, request({ subject: {} as SubjectContext }))).toBe(false);
    expect(ruleMatches(broadAllow, request({ action: "" }))).toBe(false);
    expect(ruleMatches(broadAllow, request({ resource: {} as PolicyRequest["resource"] }))).toBe(false);
  });

  it("成功路径：业务属性 status 不具有身份开关的隐式语义", () => {
    for (const status of ["active", "draft", "disabled", 42]) {
      const withStatus = request({ subject: subject({ attributes: { level: 3, status } }) });
      expect(decideExplained(withStatus, [broadAllow], { now: NOW }).decision.effect).toBe("allow");
      expect(ruleMatches(broadAllow, withStatus)).toBe(true);
    }
  });

  it("成功路径：合法 action + resource 仍按显式规则放行/拒绝", () => {
    const allowed = decideExplained(request(), [broadAllow], { now: NOW });
    expect(allowed.decision.effect).toBe("allow");
    expect(allowed.reasonKind).toBe("explicit-allow");
    expect(allowed.reason).toContain("allow-everything");

    const denied = decide(request(), [broadAllow, resourceDeny], { now: NOW });
    expect(denied.effect).toBe("deny");
    expect(denied.matched).toBe("explicit-deny");

    const nothing = decideExplained(
      request({ action: "tool:unknown", resource: { type: "tool", id: "unknown" } }),
      [resourceDeny],
      { now: NOW },
    );
    expect(nothing.decision.effect).toBe("deny");
    expect(nothing.reasonKind).toBe("default-deny");
    expect(nothing.reason).toContain("fail-closed");
  });
});

describe("decide：畸形 deny 规则不得静默失效", () => {
  const allow: PolicyRule = {
    id: "allow-bash",
    effect: "allow",
    actions: ["tool:bash"],
    resources: ["tool:*"],
  };
  /** 作用域命中、条件畸形 → 必须走 deny（malformed-policy），而不是落到 allow */
  const malformedDeny = (condition: unknown): PolicyRule => ({
    id: "deny-malformed",
    effect: "deny",
    actions: ["tool:bash"],
    resources: ["tool:*"],
    condition: rawCondition(condition),
  });

  const cases: [string, unknown][] = [
    ["eq 缺 value", { attr: "subject.department", op: "eq" }],
    ["startsWith 缺 value", { attr: "subject.department", op: "startsWith" }],
    ["contains 缺 value", { attr: "subject.department", op: "contains" }],
    ["neq 缺 value", { attr: "subject.department", op: "neq" }],
    ["notIn 缺 value", { attr: "subject.department", op: "notIn" }],
    ["未知运算符", { attr: "subject.department", op: "approximatelyEquals", value: "x" }],
    ["空分组", {}],
    ["未知分组键", { all: [{ attr: "subject.department", op: "eq", value: "engineering" }], sometimes: [] }],
    ["非数组分组", { all: "engineering" }],
    ["非对象条件", "engineering"],
    ["none 内嵌畸形叶子", { none: [{ attr: "subject.department", op: "eq" }] }],
    ["分组内混入 undefined 叶子", { any: [undefined] }],
    ["startsWith 非空要求（空串）", { attr: "subject.department", op: "startsWith", value: "" }],
    ["startsWith value 是数组", { attr: "subject.department", op: "startsWith", value: ["eng"] }],
    ["contains value 是数字", { attr: "subject.department", op: "contains", value: 1 }],
    ["matches value 非字符串", { attr: "subject.department", op: "matches", value: 1 }],
    ["matches 正则非法", { attr: "subject.department", op: "matches", value: "([a-z" }],
    ["gt value 是布尔", { attr: "subject.attributes.level", op: "gt", value: true }],
    ["in value 是对象", { attr: "subject.department", op: "in", value: { a: 1 } }],
    ["叶子混入分组键", { attr: "subject.department", op: "eq", value: "engineering", all: [] }],
    ["叶子混入未知键", { attr: "subject.department", op: "eq", value: "engineering", sometimes: true }],
  ];

  for (const [label, condition] of cases) {
    it(`${label}：仍然 deny，并给出可读原因`, () => {
      const explained = decideExplained(request(), [allow, malformedDeny(condition)], { now: NOW });
      expect(explained.decision.effect).toBe("deny");
      expect(explained.reasonKind).toBe("malformed-policy");
      expect(explained.decision.matched).toBe("explicit-deny");
      expect(explained.decision.matchedRules).toContain("deny-malformed");
      expect(explained.malformedRules).toEqual(["deny-malformed"]);
      expect(explained.reason.startsWith("拒绝：")).toBe(true);
      expect(explained.reason).toContain("畸形");
    });
  }

  it("畸形 allow 规则不会放行（fail-closed 落到 default-deny）", () => {
    const brokenAllow: PolicyRule = {
      id: "allow-broken",
      effect: "allow",
      actions: ["tool:bash"],
      resources: ["tool:*"],
      condition: rawCondition({ attr: "subject.department", op: "startsWith" }),
    };
    const explained = decideExplained(request(), [brokenAllow], { now: NOW });
    expect(explained.decision.effect).toBe("deny");
    expect(explained.reasonKind).toBe("default-deny");
  });

  it("作用域本就不命中的畸形 deny 不会误伤（规则不适用则该条规则无关）", () => {
    const offScope: PolicyRule = {
      id: "deny-other-action",
      effect: "deny",
      actions: ["tool:other"],
      resources: ["tool:*"],
      condition: rawCondition({ attr: "subject.department", op: "eq" }),
    };
    const explained = decideExplained(request(), [allow, offScope], { now: NOW });
    expect(explained.decision.effect).toBe("allow");
    expect(explained.reasonKind).toBe("explicit-allow");
    expect(explained.malformedRules).toEqual([]);
  });

  it("成功路径：良构 deny 条件照常命中，良构 allow 条件照常放行", () => {
    const goodDeny: PolicyRule = {
      id: "deny-engineering",
      effect: "deny",
      actions: ["tool:bash"],
      resources: ["tool:*"],
      condition: { attr: "subject.department", op: "eq", value: "engineering" },
    };
    const good = decideExplained(request(), [allow, goodDeny], { now: NOW });
    expect(good.decision.effect).toBe("deny");
    expect(good.reasonKind).toBe("explicit-deny");
    expect(good.reason).toContain("deny-engineering");

    const noMatch = decideExplained(
      request({ subject: subject({ department: "finance" }) }),
      [allow, goodDeny],
      { now: NOW },
    );
    expect(noMatch.decision.effect).toBe("allow");
    expect(noMatch.reasonKind).toBe("explicit-allow");
  });

  it("effect 畸形（非 allow/deny）的规则按 deny 意图处理，不静默失效", () => {
    const brokenEffect = {
      id: "deny-broken-effect",
      effect: "DENY",
      actions: ["tool:bash"],
      resources: ["tool:*"],
    } as unknown as PolicyRule;
    const explained = decideExplained(request(), [allow, brokenEffect], { now: NOW });
    expect(explained.decision.effect).toBe("deny");
    expect(explained.reasonKind).toBe("malformed-policy");
    expect(explained.decision.matchedRules).toContain("deny-broken-effect");
    expect(explained.reason).toContain("effect");
  });

  it("tenantId 畸形的 deny 规则 fail-closed；畸形 allow 规则只不匹配、不误伤", () => {
    const brokenTenantDeny = {
      id: "deny-broken-tenant",
      effect: "deny",
      tenantId: "",
      actions: ["tool:bash"],
      resources: ["tool:*"],
    } as unknown as PolicyRule;
    const denied = decideExplained(request(), [allow, brokenTenantDeny], { now: NOW });
    expect(denied.decision.effect).toBe("deny");
    expect(denied.reasonKind).toBe("malformed-policy");

    const brokenTenantAllow = {
      id: "allow-broken-tenant",
      effect: "allow",
      tenantId: "",
      actions: ["tool:bash"],
      resources: ["tool:*"],
    } as unknown as PolicyRule;
    const fallthrough = decideExplained(request(), [brokenTenantAllow], { now: NOW });
    expect(fallthrough.decision.effect).toBe("deny");
    expect(fallthrough.reasonKind).toBe("default-deny");
  });

  it("actions / resources 非数组（畸形作用域）的 deny 规则 fail-closed", () => {
    const brokenActions = {
      id: "deny-broken-actions",
      effect: "deny",
      actions: "tool:bash",
      resources: ["tool:*"],
    } as unknown as PolicyRule;
    const viaActions = decideExplained(request(), [allow, brokenActions], { now: NOW });
    expect(viaActions.decision.effect).toBe("deny");
    expect(viaActions.reasonKind).toBe("malformed-policy");
    expect(viaActions.reason).toContain("actions");

    const brokenResources = {
      id: "deny-broken-resources",
      effect: "deny",
      actions: ["tool:bash"],
      resources: { "*": true },
    } as unknown as PolicyRule;
    const viaResources = decideExplained(request(), [allow, brokenResources], { now: NOW });
    expect(viaResources.decision.effect).toBe("deny");
    expect(viaResources.reasonKind).toBe("malformed-policy");
    expect(viaResources.reason).toContain("resources");
  });

  it("畸形规则不得让判定抛错（obligations 非数组按空处理）", () => {
    const brokenObligations = {
      id: "deny-broken-obligations",
      effect: "deny",
      actions: ["tool:bash"],
      resources: ["tool:*"],
      obligations: "audit:full",
    } as unknown as PolicyRule;
    expect(() => decideExplained(request(), [allow, brokenObligations], { now: NOW })).not.toThrow();
    const explained = decideExplained(request(), [allow, brokenObligations], { now: NOW });
    expect(explained.decision.effect).toBe("deny");
    expect(explained.decision.obligations).toEqual([]);
  });

  it("details 暴露每条规则的求值原因，便于审计", () => {
    const offScopeRule: PolicyRule = {
      id: "deny-other-action",
      effect: "deny",
      actions: ["tool:other"],
      resources: ["tool:*"],
    };
    const explained = decideExplained(request(), [allow, offScopeRule], { now: NOW });
    expect(explained.decision.effect).toBe("allow");
    expect(explained.details.some((line) => line.includes("allow-bash"))).toBe(true);
    expect(explained.details.some((line) => line.includes("deny-other-action"))).toBe(true);
    expect(explained.details.some((line) => line.includes("不含") || line.includes("匹配不到"))).toBe(true);
  });
});

describe("evaluateCondition：缺 value / 畸形条件不隐式放行（含 not 嵌套整树校验）", () => {
  it("缺 value 的 eq / startsWith / contains 不再匹配（历史实现会命中）", () => {
    expect(evaluateCondition(rawCondition({ attr: "subject.department", op: "eq" }), ctx)).toBe(false);
    expect(evaluateCondition(rawCondition({ attr: "subject.department", op: "startsWith" }), ctx)).toBe(false);
    expect(evaluateCondition(rawCondition({ attr: "subject.department", op: "contains" }), ctx)).toBe(false);
    expect(evaluateCondition(rawCondition({ attr: "subject.department", op: "matches" }), ctx)).toBe(false);
  });

  it("取反运算符在缺 value / 属性缺失时不得隐式成立", () => {
    expect(evaluateCondition(rawCondition({ attr: "subject.department", op: "neq" }), ctx)).toBe(false);
    expect(evaluateCondition(rawCondition({ attr: "subject.department", op: "notIn" }), ctx)).toBe(false);
    // 属性缺失时 neq / notIn 不再因 undefined 而"通过"
    expect(evaluateCondition({ attr: "subject.attributes.missing", op: "neq", value: "x" }, ctx)).toBe(false);
    expect(evaluateCondition({ attr: "subject.attributes.missing", op: "notIn", value: ["x"] }, ctx)).toBe(false);
  });

  it("none 分组内的畸形叶子不得被取反成 allow", () => {
    const expr = rawCondition({ none: [{ attr: "subject.department", op: "eq" }] });
    expect(evaluateCondition(expr, ctx)).toBe(false);
  });

  it("any 分组里混入畸形叶子时整棵条件树 fail-closed（即使另一分支成立）", () => {
    const expr = rawCondition({
      any: [
        { attr: "subject.department", op: "eq" },
        { attr: "subject.department", op: "eq", value: "engineering" },
      ],
    });
    expect(evaluateCondition(expr, ctx)).toBe(false);
  });

  it("all 分组中后置的畸形叶子也会被发现（不做漏检短路）", () => {
    const expr = rawCondition({
      all: [
        { attr: "subject.department", op: "eq", value: "engineering" },
        { attr: "subject.department", op: "eq" },
      ],
    });
    expect(evaluateCondition(expr, ctx)).toBe(false);
  });

  it("嵌套分组里的畸形叶子同样 fail-closed", () => {
    const expr = rawCondition({
      any: [{ all: [{ attr: "subject.department", op: "eq" }] }],
    });
    expect(evaluateCondition(expr, ctx)).toBe(false);
  });

  it("空分组 / 未知键 / 非对象 / 未知运算符一律不成立", () => {
    expect(evaluateCondition(rawCondition({}), ctx)).toBe(false);
    expect(evaluateCondition(rawCondition({ all: "x" }), ctx)).toBe(false);
    expect(evaluateCondition(rawCondition("x"), ctx)).toBe(false);
    expect(evaluateCondition(rawCondition({ attr: "subject.department", op: "approximately" }), ctx)).toBe(false);
    expect(evaluateCondition(rawCondition({ attr: "subject.department", op: "ne" }), ctx)).toBe(false);
  });

  it("空字符串标量对 eq/neq/in 仍合法（不能一刀切判畸形）", () => {
    const emptyAttr: EvalContext = { ...ctx, context: { note: "" } };
    expect(evaluateCondition({ attr: "context.note", op: "eq", value: "" }, emptyAttr)).toBe(true);
    expect(evaluateCondition({ attr: "context.note", op: "neq", value: "x" }, emptyAttr)).toBe(true);
    expect(evaluateCondition({ attr: "context.note", op: "in", value: [""] }, emptyAttr)).toBe(true);
    // 非空属性与空串期望值仍是不匹配，而不是畸形命中
    expect(evaluateCondition({ attr: "subject.department", op: "eq", value: "" }, ctx)).toBe(false);
  });

  it("startsWith/contains/matches 的空串或非法 value 是畸形，不是不匹配", () => {
    expect(evaluateConditionDetailed(rawCondition({ attr: "subject.department", op: "startsWith", value: "" }), ctx).malformed).toBe(true);
    expect(evaluateConditionDetailed(rawCondition({ attr: "subject.department", op: "contains", value: "" }), ctx).malformed).toBe(true);
    expect(evaluateConditionDetailed(rawCondition({ attr: "subject.department", op: "matches", value: "" }), ctx).malformed).toBe(true);
    // 非法正则必须在读取 actual 之前就被判畸形，即使属性缺失也逃不掉
    const regex = evaluateConditionDetailed(rawCondition({ attr: "subject.attributes.missing", op: "matches", value: "([a-z" }), ctx);
    expect(regex.malformed).toBe(true);
    expect(regex.reason).toContain("正则");
    // 未锚定的非空正则照常可用
    expect(evaluateCondition({ attr: "subject.department", op: "matches", value: "gin" }, ctx)).toBe(true);
  });

  it("op-specific value 类型不符一律畸形", () => {
    const invalid: [string, unknown][] = [
      ["startsWith 数组", { attr: "subject.department", op: "startsWith", value: ["eng"] }],
      ["contains 数字", { attr: "subject.department", op: "contains", value: 1 }],
      ["contains 空数组", { attr: "subject.department", op: "contains", value: [] }],
      ["matches 数字", { attr: "subject.department", op: "matches", value: 1 }],
      ["gt 布尔", { attr: "subject.attributes.level", op: "gt", value: true }],
      ["gte 数组", { attr: "subject.attributes.level", op: "gte", value: [3] }],
      ["gt NaN", { attr: "subject.attributes.level", op: "gt", value: Number.NaN }],
      ["in 对象", { attr: "subject.department", op: "in", value: { a: 1 } }],
      ["notIn 空数组", { attr: "subject.department", op: "notIn", value: [] }],
      ["eq 数组", { attr: "subject.department", op: "eq", value: ["engineering"] }],
      ["eq 对象", { attr: "subject.department", op: "eq", value: { name: "engineering" } }],
    ];
    for (const [label, condition] of invalid) {
      expect(evaluateConditionDetailed(rawCondition(condition), ctx).malformed, label).toBe(true);
      expect(evaluateCondition(rawCondition(condition), ctx), label).toBe(false);
    }
  });

  it("in/notIn 保留历史标量写法，标量数组语义不变", () => {
    expect(evaluateCondition({ attr: "subject.department", op: "in", value: "engineering" }, ctx)).toBe(true);
    expect(evaluateCondition({ attr: "subject.department", op: "in", value: ["engineering", "finance"] }, ctx)).toBe(true);
    expect(evaluateCondition({ attr: "subject.department", op: "notIn", value: "finance" }, ctx)).toBe(true);
    expect(evaluateCondition({ attr: "subject.groups", op: "contains", value: ["dept:engineering"] }, ctx)).toBe(true);
    // actual 是字符串而 value 是数组：类型自相矛盾，按畸形而不是普通不匹配
    const mismatch = evaluateConditionDetailed(
      rawCondition({ attr: "subject.department", op: "contains", value: ["engineering"] }),
      ctx,
    );
    expect(mismatch.malformed).toBe(true);
    expect(mismatch.matched).toBe(false);
  });

  it("分组内混入 undefined / null 是畸形，不能被当成无约束", () => {
    expect(evaluateConditionDetailed(rawCondition({ any: [undefined] }), ctx).malformed).toBe(true);
    expect(evaluateConditionDetailed(rawCondition({ all: [undefined] }), ctx).malformed).toBe(true);
    expect(evaluateConditionDetailed(rawCondition({ none: [undefined] }), ctx).malformed).toBe(true);
    expect(evaluateCondition(rawCondition({ any: [undefined] }), ctx)).toBe(false);
    // 只有根表达式省略才是"无约束"
    expect(evaluateConditionDetailed(undefined, ctx)).toEqual({ matched: true, malformed: false, reason: "条件成立" });
  });

  it("嵌套过深或循环引用的条件树返回畸形，而不是栈溢出", () => {
    let deep: ConditionExpr = { attr: "subject.department", op: "eq", value: "engineering" };
    for (let index = 0; index < 200; index += 1) deep = { all: [deep] };
    expect(() => evaluateCondition(rawCondition(deep), ctx)).not.toThrow();
    expect(evaluateConditionDetailed(rawCondition(deep), ctx).malformed).toBe(true);

    const cyclic: Record<string, unknown> = {};
    cyclic.all = [cyclic];
    const result = evaluateConditionDetailed(rawCondition(cyclic), ctx);
    expect(result.malformed).toBe(true);
    expect(result.matched).toBe(false);
  });

  it("无法比较的 gt/gte/lt/lte 不再用魔法兜底值伪造结论", () => {
    expect(evaluateCondition({ attr: "subject.attributes.missing", op: "gt", value: 1 }, ctx)).toBe(false);
    expect(evaluateCondition({ attr: "subject.attributes.missing", op: "gte", value: 1 }, ctx)).toBe(false);
    expect(evaluateCondition({ attr: "subject.attributes.missing", op: "lt", value: 1 }, ctx)).toBe(false);
    expect(evaluateCondition({ attr: "subject.attributes.missing", op: "lte", value: 1 }, ctx)).toBe(false);
    expect(evaluateCondition(rawCondition({ attr: "subject.attributes.remote", op: "gt" }), ctx)).toBe(false);
  });

  it("成功路径：良构条件照常生效，exists 只看存在性", () => {
    expect(evaluateCondition({ attr: "subject.department", op: "eq", value: "engineering" }, ctx)).toBe(true);
    expect(evaluateCondition({ attr: "subject.department", op: "neq", value: "finance" }, ctx)).toBe(true);
    expect(evaluateCondition({ attr: "subject.department", op: "startsWith", value: "eng" }, ctx)).toBe(true);
    expect(evaluateCondition({ attr: "subject.department", op: "matches", value: "^eng" }, ctx)).toBe(true);
    expect(evaluateCondition({ attr: "subject.groups", op: "contains", value: "dept:engineering" }, ctx)).toBe(true);
    expect(evaluateCondition({ attr: "subject.groups", op: "notIn", value: ["dept:finance"] }, ctx)).toBe(true);
    expect(evaluateCondition({ attr: "subject.attributes.level", op: "gte", value: 3 }, ctx)).toBe(true);
    expect(evaluateCondition({ attr: "subject.attributes.level", op: "lte", value: 3 }, ctx)).toBe(true);
    expect(evaluateCondition({ attr: "subject.attributes.level", op: "lt", value: 4 }, ctx)).toBe(true);
    expect(evaluateCondition({ attr: "subject.attributes.missing", op: "exists" }, ctx)).toBe(false);
    expect(evaluateCondition({ attr: "subject.department", op: "exists" }, ctx)).toBe(true);
    expect(evaluateCondition(undefined, ctx)).toBe(true);
    expect(evaluateCondition({ all: [] }, ctx)).toBe(true);
    expect(evaluateCondition(rawCondition({ all: [] }), ctx)).toBe(true);
    expect(
      evaluateCondition(
        {
          all: [{ attr: "subject.department", op: "eq", value: "engineering" }],
          none: [{ attr: "context.riskScore", op: "gt", value: 50 }],
        },
        ctx,
      ),
    ).toBe(true);
  });
});

describe("mergeObligations：sandbox 顺序无关且未知档位归一 read-only", () => {
  type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
  /** 未知/畸形档位：用 unknown 构造，模拟策略下发被写坏 */
  const unknownMode = (mode: string) =>
    ({ kind: "sandbox", mode } as unknown as { kind: "sandbox"; mode: SandboxMode });

  function mergedMode(modes: string[]): string {
    const merged = mergeObligations(modes.map(unknownMode));
    const sandbox = merged.find((item) => item.kind === "sandbox");
    if (!sandbox || sandbox.kind !== "sandbox") throw new Error("缺少 sandbox 义务");
    return sandbox.mode;
  }

  it("未知档位无论出现在哪个位置都归一为 read-only", () => {
    expect(mergedMode(["unknown-mode", "danger-full-access"])).toBe("read-only");
    expect(mergedMode(["danger-full-access", "unknown-mode"])).toBe("read-only");
    expect(mergedMode(["workspace-write", "unknown-mode"])).toBe("read-only");
    expect(mergedMode(["unknown-mode", "workspace-write"])).toBe("read-only");
    expect(mergedMode(["read-only", "unknown-mode"])).toBe("read-only");
    expect(mergedMode(["unknown-mode"])).toBe("read-only");
  });

  it("已知档位之间的合并与输入顺序无关", () => {
    expect(mergedMode(["danger-full-access", "workspace-write"])).toBe("workspace-write");
    expect(mergedMode(["workspace-write", "danger-full-access"])).toBe("workspace-write");
    expect(mergedMode(["read-only", "danger-full-access"])).toBe("read-only");
    expect(mergedMode(["danger-full-access", "read-only"])).toBe("read-only");
    expect(mergedMode(["read-only", "workspace-write", "danger-full-access"])).toBe("read-only");
    expect(mergedMode(["danger-full-access", "workspace-write", "read-only"])).toBe("read-only");
  });

  it("成功路径：其余义务合并规则不受影响", () => {
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

describe("RoleStore：跨租户隔离与同名角色不互相覆盖", () => {
  function store(): RoleStore {
    const roles = new RoleStore();
    // 同一 id "engineer" 在两个租户下有不同权限（历史实现会后者覆盖前者）
    roles.upsert({ id: "engineer", tenantId: "acme", name: "acme 研发", permissions: ["tool:bash"], inherits: [] });
    roles.upsert({
      id: "engineer",
      tenantId: "globex",
      name: "globex 研发",
      permissions: ["tool:bash:globex-only"],
      inherits: [],
    });
    roles.upsert({ id: "global-auditor", name: "全局审计", permissions: ["audit:read"], inherits: ["engineer"] });
    roles.upsert({ id: "acme-only", tenantId: "acme", name: "acme 专有", permissions: ["acme:only"], inherits: [] });
    return roles;
  }

  const acmeBinding = { principalId: "u_1", roleId: "engineer", tenantId: "acme" };

  it("字面租户 * 不会覆盖全局角色分区", () => {
    const roles = new RoleStore();
    roles.upsert({ id: "reader", name: "global", permissions: ["read"], inherits: [] });
    roles.upsert({ id: "reader", tenantId: "*", name: "literal-star", permissions: ["star:only"], inherits: [] });
    expect(roles.get("reader")?.permissions).toEqual(["read"]);
    expect(roles.get("reader", "*")?.permissions).toEqual(["star:only"]);
    expect(roles.resolve("u", "acme", [{ principalId: "u", roleId: "reader", tenantId: "acme" }]).permissions).toEqual(["read"]);
    expect(roles.resolve("u", "*", [{ principalId: "u", roleId: "reader", tenantId: "*" }]).permissions).toEqual(["star:only"]);
  });

  it("角色权限与继承只能是字符串，不存入外部可变对象", () => {
    const roles = new RoleStore();
    for (const patch of [{ permissions: [{}] }, { inherits: [null] }, { permissions: [" "] }]) {
      expect(() => roles.upsert({ id: "bad", name: "bad", permissions: [], inherits: [], ...patch } as Role)).toThrow(/字符串数组/);
    }
  });

  it("同 id 角色按租户隔离，解析到本租户定义", () => {
    const roles = store();
    const acme = roles.resolve("u_1", "acme", [acmeBinding]);
    expect(acme.roles).toEqual(["engineer"]);
    expect(acme.permissions).toEqual(["tool:bash"]);
    expect(acme.unresolvedRoles).toEqual([]);

    const globex = roles.resolve("u_1", "globex", [{ ...acmeBinding, tenantId: "globex" }]);
    expect(globex.roles).toEqual(["engineer"]);
    expect(globex.permissions).toEqual(["tool:bash:globex-only"]);
    expect(globex.unresolvedRoles).toEqual([]);
  });

  it("引用只存在于别的租户的角色 → 未解析（fail-closed，不借用他人权限）", () => {
    const roles = store();
    const resolved = roles.resolve("u_1", "globex", [{ principalId: "u_1", roleId: "acme-only", tenantId: "globex" }]);
    expect(resolved.roles).toEqual([]);
    expect(resolved.permissions).toEqual([]);
    expect(resolved.unresolvedRoles).toEqual(["acme-only"]);
  });

  it("全局角色（无 tenantId）对所有租户可见，且被本租户同名角色遮蔽", () => {
    const roles = store();
    const viaGlobal = roles.resolve("u_1", "acme", [{ principalId: "u_1", roleId: "global-auditor", tenantId: "acme" }]);
    // 全局角色可见；其 inherits 指向的 "engineer" 解析为本租户 acme 的定义
    expect(viaGlobal.roles).toEqual(["global-auditor", "engineer"]);
    expect(viaGlobal.permissions).toEqual(["audit:read", "tool:bash"]);

    roles.upsert({ id: "global-auditor", tenantId: "acme", name: "acme 审计", permissions: ["acme:audit"], inherits: [] });
    const shadowed = roles.resolve("u_1", "acme", [{ principalId: "u_1", roleId: "global-auditor", tenantId: "acme" }]);
    expect(shadowed.permissions).toEqual(["acme:audit"]);
  });

  it("get / list 按租户分区，跨租户不可见", () => {
    const roles = store();
    expect(roles.get("engineer", "acme")?.name).toBe("acme 研发");
    expect(roles.get("engineer", "globex")?.name).toBe("globex 研发");
    expect(roles.get("engineer")).toBeUndefined(); // 无 tenantId 只解析全局角色
    expect(roles.get("global-auditor", "acme")?.name).toBe("全局审计");
    expect(roles.get("acme-only", "globex")).toBeUndefined();

    const acmeList = roles.list("acme").map((role) => role.id).sort();
    expect(acmeList).toEqual(["acme-only", "engineer", "global-auditor"]);
    const globexList = roles.list("globex").map((role) => role.id).sort();
    expect(globexList).toEqual(["engineer", "global-auditor"]);
    expect(roles.list().length).toBe(4);
  });

  it("租户标识缺失时 fail-closed：不解析任何角色", () => {
    const roles = store();
    const resolved = roles.resolve("u_1", "", [acmeBinding]);
    expect(resolved.roles).toEqual([]);
    expect(resolved.permissions).toEqual([]);
    expect(resolved.unresolvedRoles).toEqual([]);
  });

  it("畸形角色写入被拒绝（id / tenantId 必须是非空白字符串）", () => {
    const roles = store();
    expect(() => roles.upsert({ id: "", name: "坏角色", permissions: [], inherits: [] })).toThrow(/id/);
    expect(() => roles.upsert({ id: "   ", name: "空白 id", permissions: [], inherits: [] })).toThrow(/id/);
    expect(() =>
      roles.upsert({ id: "bad", tenantId: "", name: "坏租户", permissions: [], inherits: [] }),
    ).toThrow(/tenantId/);
    expect(() =>
      roles.upsert({ id: "bad2", tenantId: "  ", name: "空白租户", permissions: [], inherits: [] }),
    ).toThrow(/tenantId/);
  });

  it("get / list 返回副本：改返回值不会改动目录内的角色", () => {
    const roles = store();
    const fetched = roles.get("engineer", "acme");
    expect(fetched).toBeDefined();
    fetched!.tenantId = "globex";
    fetched!.permissions.push("tool:rm-rf");

    const listed = roles.list("acme").find((role) => role.id === "engineer");
    expect(listed?.tenantId).toBe("acme");
    expect(listed?.permissions).toEqual(["tool:bash"]);

    const resolved = roles.resolve("u_1", "acme", [acmeBinding]);
    expect(resolved.permissions).toEqual(["tool:bash"]);
  });

  it("upsert 存储副本：外部改原对象不影响目录，租户角色覆盖全局", () => {
    const roles = new RoleStore();
    const role: Role = { id: "shared", name: "全局共享", permissions: ["global:read"], inherits: [] };
    roles.upsert(role);
    role.tenantId = "acme";
    role.permissions.push("global:write");
    // 写入时是全局角色，之后改外部对象不应把它变成 acme 角色
    expect(roles.get("shared", "globex")?.permissions).toEqual(["global:read"]);

    roles.upsert({ id: "shared", tenantId: "acme", name: "acme 共享", permissions: ["acme:read"], inherits: [] });
    const listed = roles.list("acme");
    expect(listed.filter((item) => item.id === "shared").length).toBe(1);
    expect(listed.find((item) => item.id === "shared")?.name).toBe("acme 共享");
    // 其他租户仍只看到全局定义
    expect(roles.list("globex").find((item) => item.id === "shared")?.name).toBe("全局共享");
  });

  it("成功路径：绑定租户隔离、通配绑定、缺失角色与循环继承仍按原语义工作", () => {
    const roles = new RoleStore();
    roles.upsert({ id: "employee", name: "员工", permissions: ["plugin:web", "kb:read"], inherits: [] });
    roles.upsert({ id: "engineer", name: "研发", permissions: ["tool:bash"], inherits: ["employee"] });
    roles.upsert({ id: "loop-a", tenantId: "acme", name: "环 a", permissions: ["a"], inherits: ["loop-b"] });
    roles.upsert({ id: "loop-b", tenantId: "acme", name: "环 b", permissions: ["b"], inherits: ["loop-a"] });

    const resolved = roles.resolve("u_1001", "acme", [
      { principalId: "u_1001", roleId: "engineer", tenantId: "acme" },
      { principalId: "u_1001", roleId: "ghost", tenantId: "acme" },
      { principalId: "u_1001", roleId: "engineer", tenantId: "other-tenant" },
      { principalId: "u_1001", roleId: "global-role", tenantId: "*" },
    ]);
    expect(resolved.roles).toEqual(["engineer", "employee"]);
    expect(resolved.permissions).toEqual(["kb:read", "plugin:web", "tool:bash"]);
    expect(resolved.unresolvedRoles).toEqual(["ghost", "global-role"]);

    const cyclic = roles.resolve("u_1001", "acme", [{ principalId: "u_1001", roleId: "loop-a", tenantId: "acme" }]);
    expect(cyclic.roles).toEqual(["loop-a", "loop-b"]);
    expect(cyclic.permissions).toEqual(["a", "b"]);
  });
});
