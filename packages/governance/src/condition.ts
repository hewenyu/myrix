import type { Condition, ConditionExpr, SubjectContext } from "@myrix/contracts";
import { getPath } from "./attr";

export interface EvalResource {
  type: string;
  id: string;
  tenantId?: string;
  attributes?: Record<string, unknown>;
}

/** 策略求值上下文：策略里的 subject / resource / context / action 都从这里取值 */
export interface EvalContext {
  subject: SubjectContext;
  resource: EvalResource;
  action: string;
  context: Record<string, unknown>;
}

function equals(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (actual === null || actual === undefined || expected === null || expected === undefined) {
    return false;
  }
  if (typeof actual !== typeof expected) return String(actual) === String(expected);
  return false;
}

function compare(actual: unknown, expected: unknown): number | undefined {
  const left = typeof actual === "number" ? actual : Number(actual);
  const right = typeof expected === "number" ? expected : Number(expected);
  if (Number.isFinite(left) && Number.isFinite(right)) return left - right;
  if (typeof actual === "string" && typeof expected === "string") return actual.localeCompare(expected);
  return undefined;
}

function evaluateSingle(condition: Condition, ctx: EvalContext): boolean {
  const direct = getPath(ctx, condition.attr);
  const actual = direct === undefined ? getPath(ctx.subject, condition.attr) : direct;
  const expected = condition.value;
  switch (condition.op) {
    case "eq":
      return equals(actual, expected);
    case "neq":
      return !equals(actual, expected);
    case "in": {
      // 对称语义：属性是数组时表示"任一元素命中"，期望值是数组时表示"取值在集合内"
      const candidates = Array.isArray(expected) ? expected : [expected];
      const actuals = Array.isArray(actual) ? actual : [actual];
      return actuals.some((item) => candidates.some((candidate) => equals(item, candidate)));
    }
    case "notIn": {
      const candidates = Array.isArray(expected) ? expected : [expected];
      const actuals = Array.isArray(actual) ? actual : [actual];
      if (actual === undefined || actual === null) return true;
      return !actuals.some((item) => candidates.some((candidate) => equals(item, candidate)));
    }
    case "contains": {
      if (typeof actual === "string") return actual.includes(String(expected ?? ""));
      if (Array.isArray(actual)) return actual.some((item) => equals(item, expected));
      return false;
    }
    case "startsWith":
      return typeof actual === "string" && actual.startsWith(String(expected ?? ""));
    case "gt":
      return (compare(actual, expected) ?? 0) > 0;
    case "gte":
      return (compare(actual, expected) ?? -1) >= 0;
    case "lt":
      return (compare(actual, expected) ?? 0) < 0;
    case "lte":
      return (compare(actual, expected) ?? 1) <= 0;
    case "exists":
      return actual !== undefined && actual !== null;
    case "matches": {
      if (typeof actual !== "string") return false;
      try {
        return new RegExp(String(expected ?? "")).test(actual);
      } catch {
        return false; // 防御：非法正则视为不匹配，而不是中断判定
      }
    }
    default:
      return false;
  }
}

function isCondition(expr: ConditionExpr): expr is Condition {
  return typeof (expr as Condition).attr === "string";
}

/**
 * 递归求值条件表达式。字段缺失视为条件不成立；空分组视为无约束。
 */
export function evaluateCondition(expr: ConditionExpr | undefined, ctx: EvalContext): boolean {
  if (expr === undefined) return true;
  if (isCondition(expr)) return evaluateSingle(expr, ctx);
  const groups = expr as { all?: ConditionExpr[]; any?: ConditionExpr[]; none?: ConditionExpr[] };
  if (groups.all && !groups.all.every((item) => evaluateCondition(item, ctx))) return false;
  if (groups.any && !groups.any.some((item) => evaluateCondition(item, ctx))) return false;
  if (groups.none && groups.none.some((item) => evaluateCondition(item, ctx))) return false;
  return true;
}
