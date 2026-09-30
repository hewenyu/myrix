import type { SubjectContext } from "./principal";

export type Effect = "allow" | "deny";

export type ConditionOperator =
  | "eq"
  | "neq"
  | "in"
  | "notIn"
  | "contains"
  | "startsWith"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "exists"
  | "matches";

export interface Condition {
  /** 点号属性路径，例如 "subject.department" / "resource.attributes.level" */
  attr: string;
  op: ConditionOperator;
  value?: unknown;
}

export interface ConditionGroup {
  all?: ConditionExpr[];
  any?: ConditionExpr[];
  none?: ConditionExpr[];
}

export type ConditionExpr = Condition | ConditionGroup;

/**
 * 义务（Obligation）：策略不只是 allow/deny，还要下发"以什么方式执行"。
 * 这是 Myrix 与 DSH 权限解耦的关键：企业策略不修改 DSH 的判定逻辑，
 * 而是把治理结论翻译成 DSH 原生的 sandbox mode / approval policy 配置项。
 */
export type Obligation =
  | { kind: "sandbox"; mode: "read-only" | "workspace-write" | "danger-full-access" }
  | { kind: "approval"; required: boolean; reason?: string }
  | { kind: "rateLimit"; key: string; perMinute: number }
  | { kind: "audit"; level: "full" | "metadata" }
  | { kind: "knowledgeScope"; baseIds: string[] }
  | { kind: "modelScope"; models: string[] }
  | { kind: "custom"; name: string; params: Record<string, unknown> };

export interface PolicyRule {
  id: string;
  description?: string;
  effect: Effect;
  /** 租户隔离：缺省表示全局规则 */
  tenantId?: string;
  /** 动作通配，例如 "tool:bash" / "kb.search" / "plugin:*" */
  actions: string[];
  /** 资源通配，例如 "tool:*" / "kb:finance-*" / "session:*" */
  resources: string[];
  condition?: ConditionExpr;
  obligations?: Obligation[];
}

export interface PolicySet {
  revision: string;
  rules: PolicyRule[];
}

export interface PolicyResource {
  type: string;
  id: string;
  tenantId?: string;
  attributes?: Record<string, unknown>;
}

export interface PolicyRequest {
  subject: SubjectContext;
  action: string;
  resource: PolicyResource;
  /** 运行时上下文：时间、IP、风险分、模型、工具参数摘要等 */
  context?: Record<string, unknown>;
}

export type DecisionReasonKind = "explicit-deny" | "explicit-allow" | "default-deny";

export interface PolicyDecision {
  effect: Effect;
  matched: DecisionReasonKind;
  /** 命中的规则 id，便于审计与解释 */
  matchedRules: string[];
  obligations: Obligation[];
  policyRevision: string;
  evaluatedAt: string;
}
