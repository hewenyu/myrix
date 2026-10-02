import type { Obligation, PolicyDecision, PolicyRequest, PolicyRule } from "@myrix/contracts";
import { evaluateConditionDetailed } from "./condition";
import { matchesAny } from "./glob";
import { mergeObligations } from "./obligations";

export interface DecideOptions {
  policyRevision?: string;
  /**
   * 判定时刻，由调用方注入（ISO8601 字符串或 Date）。
   *
   * 纯函数禁止读系统时钟：审计要能复放同一次判定，测试也要能固定时间。
   * 因此这里是**必填**项；忘了注入会在编译期被 tsc 拦住，而不是在运行期偷偷取当前时间。
   */
  now: string | Date;
  /**
   * 无规则命中时的效果。首版**只允许** "deny"（fail-closed），且这不是可配置开关。
   *
   * 曾经存在的 `"allow"` 默认放行已被删除：AGENTS.md 硬性规则 1 要求所有放行路径显式，
   * 而"策略为空就放行"会让一次策略下发失败等价于全面放开。类型收窄到 `"deny"`，
   * 仍传 `defaultEffect: "allow"` 的调用方会在编译期报错，而不是运行期静默放行。
   */
  defaultEffect?: "deny";
}

/**
 * 判定结论的细分原因。
 *
 * 前两个是本次加固新增的 fail-closed 分支，刻意**不**并入契约里的
 * `DecisionReasonKind`（那是公开审计契约，改动会波及控制面与 PEP），
 * 而是通过 {@link decideExplained} 暴露；`decide` 返回的 `matched` 仍落在原契约内：
 * - `invalid-request` → `matched: "default-deny"`（请求本身不可判定）
 * - `malformed-policy` → `matched: "explicit-deny"`（畸形的 deny 规则必须显式生效，而不是静默失效）
 */
export type DecideReasonKind =
  | "invalid-request"
  | "malformed-policy"
  | "explicit-deny"
  | "explicit-allow"
  | "default-deny";

export interface DecideExplanation {
  decision: PolicyDecision;
  reasonKind: DecideReasonKind;
  /** 可读结论：以「允许：」或「拒绝：」开头，说明是哪条路径得出的结论 */
  reason: string;
  matchedRules: string[];
  /** 因结构性畸形而被 fail-closed 处理的规则 id（顺序无关） */
  malformedRules: string[];
  /** 逐条规则/条件的求值解释，便于审计与排障 */
  details: string[];
}

/** now 既接受 Date 也接受 ISO8601 字符串，统一成 ISO8601 UTC 输出 */
function toIsoString(now: string | Date): string {
  return typeof now === "string" ? now : now.toISOString();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** 字符串数组校验（通配符列表、subject.groups 共用）；空数组合法但匹配不到任何值 */
function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * 主体上下文的最小有效性校验。
 *
 * `request.subject = {}` 这类空主体曾能通过校验：`resources:["*"]` 的通用 allow 会命中，
 * 于是"谁都不是"被静默放行。因此要求可定位到具体主体与租户：
 * - `principalId` / `tenantId` 必须是非空字符串（空串会让"无主体"看起来像某个租户）；
 * - `groups` / `attributes` 若提供则类型必须正确（策略大量引用这两者）；
 * 身份是否 active 由调用方认证/授权边界检查；SubjectContext 没有 status 契约，
 * PDP 不赋予任意业务属性 attributes.status 隐式语义。
 */
function subjectValidationError(subject: unknown): string | undefined {
  if (subject === null || typeof subject !== "object" || Array.isArray(subject)) {
    return "缺少 subject（判定主体）";
  }
  const candidate = subject as Record<string, unknown>;
  if (!isNonEmptyString(candidate.principalId)) {
    return "subject.principalId 必须是非空字符串（空主体不能参与判定）";
  }
  if (!isNonEmptyString(candidate.tenantId)) {
    return "subject.tenantId 必须是非空字符串（缺失会让主体越出本租户范围）";
  }
  if (candidate.groups !== undefined && !isStringList(candidate.groups)) {
    return "subject.groups 必须是字符串数组";
  }
  if (candidate.attributes !== undefined) {
    const attributes = candidate.attributes;
    if (attributes === null || typeof attributes !== "object" || Array.isArray(attributes)) {
      return "subject.attributes 必须是对象";
    }
  }
  return undefined;
}

type FieldOutcome =
  | { kind: "match" }
  | { kind: "no-match"; reason: string }
  | { kind: "malformed"; reason: string };

interface RuleEvaluation {
  ruleId: string;
  /** 规则声明的效果；effect 畸形时归为 "deny"（fail-closed） */
  effect: "allow" | "deny";
  /** 规则完整命中（所有字段良构且条件成立） */
  matched: boolean;
  /**
   * 规则作用域本可能命中，但因字段/条件结构畸形而无法判定。
   * 对 deny 意图的规则，这意味着必须 fail-closed 拒绝，而不是静默忽略。
   */
  failClosed: boolean;
  reason: string;
  obligations: readonly Obligation[];
}

const FIELD_MATCH: FieldOutcome = { kind: "match" };

function evaluatePatternField(value: unknown, target: string, label: string): FieldOutcome {
  if (!isStringList(value)) {
    return { kind: "malformed", reason: `${label} 不是字符串数组` };
  }
  if (value.length === 0) {
    return { kind: "no-match", reason: `${label} 为空列表，匹配不到任何值` };
  }
  return matchesAny(value, target) ? FIELD_MATCH : { kind: "no-match", reason: `${label} 不含 ${target}` };
}

/**
 * 求值单条规则，并给出可读原因。
 *
 * 判定顺序：租户 → 动作 → 资源 → 效果 → 条件。任一步是**确定的**不匹配，
 * 该规则就不适用（即使后面的字段畸形也不升级为 deny，避免一条写错作用域的
 * deny 规则把全租户流量全部打死）；但如果前面的字段缺失/结构畸形，导致无法
 * 排除它本该命中，则记为 `failClosed`，由 `decide` 对 deny 意图做 fail-closed。
 *
 * effect 畸形（不是 "allow"/"deny"）同样按 deny 意图处理：不能因为效果字段写错
 * 就把一条本该拒绝的规则静默丢掉。
 */
function evaluateRule(rule: PolicyRule, request: PolicyRequest): RuleEvaluation {
  if (rule === null || typeof rule !== "object") {
    return {
      ruleId: "<malformed-rule>",
      effect: "deny",
      matched: false,
      failClosed: true,
      reason: "规则不是对象，无法判定作用域，按 fail-closed 处理",
      obligations: [],
    };
  }

  const ruleId = typeof rule.id === "string" && rule.id.length > 0 ? rule.id : "<missing-id>";
  const obligations = Array.isArray(rule.obligations) ? rule.obligations : [];
  const effectDeclared: unknown = rule.effect;
  const declaredEffect: "allow" | "deny" = effectDeclared === "allow" ? "allow" : "deny";

  if (rule.tenantId !== undefined) {
    if (typeof rule.tenantId !== "string" || rule.tenantId.length === 0) {
      // 无法确定租户作用域：若规则本意是 deny，则 fail-closed 拒绝；
      // 若本意是 allow，则只能不匹配（畸形 allow 绝不能伪造放行，也绝不能反过来误伤成 deny）
      return {
        ruleId,
        effect: declaredEffect,
        matched: false,
        failClosed: declaredEffect === "deny",
        reason: `tenantId 非法（${JSON.stringify(rule.tenantId)}），无法确定租户作用域，按 fail-closed 处理`,
        obligations,
      };
    }
    if (rule.tenantId !== request.subject.tenantId) {
      return { ruleId, effect: declaredEffect, matched: false, failClosed: false, reason: "租户不匹配，规则不适用", obligations };
    }
  }

  const actionOutcome = evaluatePatternField(rule.actions, request.action, "actions");
  if (actionOutcome.kind === "no-match") {
    return { ruleId, effect: declaredEffect, matched: false, failClosed: false, reason: actionOutcome.reason, obligations };
  }

  const resourceKey = request.resource.type + ":" + request.resource.id;
  const resourceOutcome = evaluatePatternField(rule.resources, resourceKey, "resources");
  if (resourceOutcome.kind === "no-match") {
    return { ruleId, effect: declaredEffect, matched: false, failClosed: false, reason: resourceOutcome.reason, obligations };
  }

  if (effectDeclared !== "allow" && effectDeclared !== "deny") {
    return {
      ruleId,
      effect: "deny",
      matched: false,
      failClosed: true,
      reason: `effect 非法（${JSON.stringify(effectDeclared)}），无法判断放行/拒绝意图，按 deny 处理`,
      obligations,
    };
  }

  const scopeMalformed =
    actionOutcome.kind === "malformed"
      ? actionOutcome.reason
      : resourceOutcome.kind === "malformed"
        ? resourceOutcome.reason
        : undefined;
  if (scopeMalformed !== undefined) {
    return {
      ruleId,
      effect: declaredEffect,
      matched: false,
      failClosed: true,
      reason: `作用域字段畸形（${scopeMalformed}），无法排除该规则本应命中，按 fail-closed 处理`,
      obligations,
    };
  }

  const condition = evaluateConditionDetailed(rule.condition, {
    subject: request.subject,
    resource: request.resource,
    action: request.action,
    context: request.context ?? {},
  });
  if (condition.matched) {
    return { ruleId, effect: declaredEffect, matched: true, failClosed: false, reason: "规则命中", obligations };
  }
  if (condition.malformed) {
    return {
      ruleId,
      effect: declaredEffect,
      matched: false,
      failClosed: true,
      reason: `条件畸形（${condition.reason}），按 fail-closed 处理`,
      obligations,
    };
  }
  return { ruleId, effect: declaredEffect, matched: false, failClosed: false, reason: condition.reason, obligations };
}

/**
 * 规则是否命中。非法请求、畸形条件/作用域一律返回 false（不产生隐式放行）。
 *
 * 与 `decide` 一致地先校验请求：否则单独调用它的 PEP 会用 `subject:{}` 之类的空请求
 * 命中通用规则。需要区分"确定不命中"与"fail-closed 拒绝"时用 {@link decideExplained}。
 */
export function ruleMatches(rule: PolicyRule, request: PolicyRequest): boolean {
  if (requestValidationError(request) !== undefined) return false;
  return evaluateRule(rule, request).matched;
}

/**
 * 请求合法性校验：主体、动作、资源都必须可定位。
 *
 * 之所以要这么严：`resources:["*"]` / `actions:["*"]` 的通用规则只为"确定的请求"服务，
 * 一旦请求本身缺字段（例如 `resource:{}` 拼出 `"undefined:undefined"`、`subject:{}` 空主体），
 * 通用 allow 就会绕过针对具体资源的 deny。非法请求直接 deny，不进入任何策略匹配。
 */
function requestValidationError(request: PolicyRequest): string | undefined {
  if (request === null || typeof request !== "object") return "请求不是对象";
  const subjectError = subjectValidationError(request.subject);
  if (subjectError !== undefined) return subjectError;
  if (!isNonEmptyString(request.action)) {
    return "action 必须是显式非空字符串（空串/空白/缺失会让通配符命中不可预期，按非法请求处理）";
  }
  const resource = request.resource;
  if (resource === null || typeof resource !== "object") {
    return "缺少 resource（目标资源）";
  }
  if (!isNonEmptyString(resource.type)) return "resource.type 必须是非空字符串";
  if (!isNonEmptyString(resource.id)) return "resource.id 必须是非空字符串";
  return undefined;
}

function describeRuleEvaluation(evaluation: RuleEvaluation): string {
  return `规则 ${evaluation.ruleId}（${evaluation.effect}）：${evaluation.reason}`;
}

/**
 * 判定算法：deny-overrides + fail-closed，并给出可读原因。
 *
 * 1) 请求非法（action/resource 缺失、空串或空白）→ 立即 deny（`invalid-request`），
 *    不进入任何策略匹配 —— 否则 `resources: ["*"]` 的通用 allow 会绕过资源 deny
 * 2) 命中任意 deny 规则 → deny，并带上"收紧类"义务
 * 3) deny 规则作用域可能命中但字段/条件结构畸形 → deny（`malformed-policy`），
 *    绝不让写坏的 deny 规则静默失效、把决定权交给 allow
 * 4) 否则命中任意 allow 规则 → allow，并合并义务
 * 5) 都没命中 → 默认 deny
 *
 * 不引入 priority 数字排序：企业策略最常见的事故来源就是优先级算错。
 * deny 永远赢，语义简单、可解释、可审计；要放宽就删掉那条 deny。
 */
export function decideExplained(
  request: PolicyRequest,
  rules: readonly PolicyRule[],
  options: DecideOptions,
): DecideExplanation {
  const policyRevision = options.policyRevision ?? "inline";
  const evaluatedAt = toIsoString(options.now);

  const invalid = requestValidationError(request);
  if (invalid !== undefined) {
    return {
      decision: {
        effect: "deny",
        matched: "default-deny",
        matchedRules: [],
        obligations: [],
        policyRevision,
        evaluatedAt,
      },
      reasonKind: "invalid-request",
      reason: `拒绝：非法判定请求 —— ${invalid}；按 fail-closed 拒绝，不做任何策略匹配`,
      matchedRules: [],
      malformedRules: [],
      details: [],
    };
  }

  const evaluations = rules.map((rule) => evaluateRule(rule, request));
  const details = evaluations.map(describeRuleEvaluation);

  // deny 意图 = 显式 effect:"deny"，或 effect 畸形被归为 deny 的规则
  const denies = evaluations.filter(
    (evaluation) => evaluation.effect === "deny" && (evaluation.matched || evaluation.failClosed),
  );
  if (denies.length > 0) {
    const malformedRules = denies.filter((evaluation) => evaluation.failClosed).map((evaluation) => evaluation.ruleId);
    const matchedRules = denies.map((evaluation) => evaluation.ruleId);
    const reasonKind: DecideReasonKind = malformedRules.length > 0 ? "malformed-policy" : "explicit-deny";
    const reason =
      reasonKind === "malformed-policy"
        ? `拒绝：命中畸形 deny 规则 ${malformedRules.join(", ")}（作用域命中但条件/字段结构非法），按 fail-closed 拒绝`
        : `拒绝：命中显式 deny 规则 ${matchedRules.join(", ")}`;
    return {
      decision: {
        effect: "deny",
        matched: "explicit-deny",
        matchedRules,
        obligations: mergeObligations(denies.flatMap((evaluation) => [...evaluation.obligations])),
        policyRevision,
        evaluatedAt,
      },
      reasonKind,
      reason,
      matchedRules,
      malformedRules,
      details,
    };
  }

  const allows = evaluations.filter((evaluation) => evaluation.effect === "allow" && evaluation.matched);
  if (allows.length > 0) {
    const matchedRules = allows.map((evaluation) => evaluation.ruleId);
    return {
      decision: {
        effect: "allow",
        matched: "explicit-allow",
        matchedRules,
        obligations: mergeObligations(allows.flatMap((evaluation) => [...evaluation.obligations])),
        policyRevision,
        evaluatedAt,
      },
      reasonKind: "explicit-allow",
      reason: `允许：命中显式 allow 规则 ${matchedRules.join(", ")}`,
      matchedRules,
      malformedRules: [],
      details,
    };
  }

  return {
    decision: {
      effect: "deny",
      matched: "default-deny",
      matchedRules: [],
      obligations: [],
      policyRevision,
      evaluatedAt,
    },
    reasonKind: "default-deny",
    reason: "拒绝：没有任何 deny/allow 规则命中，按 fail-closed 默认拒绝",
    matchedRules: [],
    malformedRules: [],
    details,
  };
}

/** 判定入口：返回契约内的 `PolicyDecision`；可读原因见 {@link decideExplained} */
export function decide(
  request: PolicyRequest,
  rules: readonly PolicyRule[],
  options: DecideOptions,
): PolicyDecision {
  return decideExplained(request, rules, options).decision;
}
