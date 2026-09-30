import type { PolicyDecision, PolicyRequest, PolicyRule } from "@myrix/contracts";
import { evaluateCondition } from "./condition";
import { matchesAny } from "./glob";
import { mergeObligations } from "./obligations";

export interface DecideOptions {
  policyRevision?: string;
  /** 缺省为 deny（fail-closed）；显式设为 allow 才会在无规则命中时放行 */
  defaultEffect?: "allow" | "deny";
  now?: () => Date;
}

export function ruleMatches(rule: PolicyRule, request: PolicyRequest): boolean {
  if (rule.tenantId !== undefined && rule.tenantId !== request.subject.tenantId) return false;
  if (!matchesAny(rule.actions, request.action)) return false;
  const resourceKey = request.resource.type + ":" + request.resource.id;
  if (!matchesAny(rule.resources, resourceKey)) return false;
  return evaluateCondition(rule.condition, {
    subject: request.subject,
    resource: request.resource,
    action: request.action,
    context: request.context ?? {},
  });
}

/**
 * 判定算法：deny-overrides + fail-closed。
 *
 * 1) 命中任意 deny 规则 → deny，并带上"收紧类"义务
 * 2) 否则命中任意 allow 规则 → allow，并合并义务
 * 3) 都没命中 → 默认 deny
 *
 * 不引入 priority 数字排序：企业策略最常见的事故来源就是优先级算错。
 * deny 永远赢，语义简单、可解释、可审计；要放宽就删掉那条 deny。
 */
export function decide(
  request: PolicyRequest,
  rules: readonly PolicyRule[],
  options: DecideOptions = {},
): PolicyDecision {
  const eligible = rules.filter((rule) => ruleMatches(rule, request));
  const denies = eligible.filter((rule) => rule.effect === "deny");
  const allows = eligible.filter((rule) => rule.effect === "allow");
  const policyRevision = options.policyRevision ?? "inline";
  const evaluatedAt = (options.now?.() ?? new Date()).toISOString();

  if (denies.length > 0) {
    return {
      effect: "deny",
      matched: "explicit-deny",
      matchedRules: denies.map((rule) => rule.id),
      obligations: mergeObligations(denies.flatMap((rule) => rule.obligations ?? [])),
      policyRevision,
      evaluatedAt,
    };
  }

  if (allows.length > 0) {
    return {
      effect: "allow",
      matched: "explicit-allow",
      matchedRules: allows.map((rule) => rule.id),
      obligations: mergeObligations(allows.flatMap((rule) => rule.obligations ?? [])),
      policyRevision,
      evaluatedAt,
    };
  }

  return {
    effect: options.defaultEffect === "allow" ? "allow" : "deny",
    matched: "default-deny",
    matchedRules: [],
    obligations: [],
    policyRevision,
    evaluatedAt,
  };
}
