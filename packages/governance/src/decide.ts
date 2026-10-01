import type { PolicyDecision, PolicyRequest, PolicyRule } from "@myrix/contracts";
import { evaluateCondition } from "./condition";
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

/** now 既接受 Date 也接受 ISO8601 字符串，统一成 ISO8601 UTC 输出 */
function toIsoString(now: string | Date): string {
  return typeof now === "string" ? now : now.toISOString();
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
  options: DecideOptions,
): PolicyDecision {
  const eligible = rules.filter((rule) => ruleMatches(rule, request));
  const denies = eligible.filter((rule) => rule.effect === "deny");
  const allows = eligible.filter((rule) => rule.effect === "allow");
  const policyRevision = options.policyRevision ?? "inline";
  const evaluatedAt = toIsoString(options.now);

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
    effect: "deny",
    matched: "default-deny",
    matchedRules: [],
    obligations: [],
    policyRevision,
    evaluatedAt,
  };
}
