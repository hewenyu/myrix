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

/**
 * 条件求值结果。`malformed` 表示条件树里存在无法解释的节点：未知 op/key、value 类型不符、
 * 分组内混入 undefined、超深或自引用结构等。畸形一律不成立，且绝不会被 `neq` / `notIn` /
 * `none` 的取反语义变成 allow。
 */
export interface ConditionEvaluation {
  matched: boolean;
  malformed: boolean;
  reason: string;
}

/** 契约承认的运算符；其余一律畸形（fail-closed） */
const CONDITION_OPERATORS: ReadonlySet<string> = new Set([
  "eq",
  "neq",
  "in",
  "notIn",
  "contains",
  "startsWith",
  "gt",
  "gte",
  "lt",
  "lte",
  "exists",
  "matches",
]);

/** 分组节点允许的键 */
const GROUP_KEYS: ReadonlySet<string> = new Set(["all", "any", "none"]);

/** 叶子节点允许的键：混入 all/any/none 或自定义键都不能被静默忽略 */
const LEAF_KEYS: ReadonlySet<string> = new Set(["attr", "op", "value"]);

/** 条件树最大嵌套深度：超深/自引用结构判畸形，而不是把求值器拖进栈溢出 */
const MAX_CONDITION_DEPTH = 32;

function equals(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (actual === null || actual === undefined || expected === null || expected === undefined) {
    return false;
  }
  if (typeof actual !== typeof expected) return String(actual) === String(expected);
  return false;
}

function compare(actual: unknown, expected: unknown): number | undefined {
  // 只允许数字/字符串参与比较：布尔与数组经 Number() 会被强制转换（Number(true)=1、
  // Number([])=0），那等于让畸形 value 伪造出确定结论，必须排除。
  const comparable = (value: unknown): value is number | string =>
    typeof value === "number" || typeof value === "string";
  if (!comparable(actual) || !comparable(expected)) return undefined;
  const left = typeof actual === "number" ? actual : Number(actual);
  const right = typeof expected === "number" ? expected : Number(expected);
  if (Number.isFinite(left) && Number.isFinite(right)) return left - right;
  if (typeof actual === "string" && typeof expected === "string") return actual.localeCompare(expected);
  return undefined;
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function valueLabel(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "<无法序列化>";
  }
}

function matched(): ConditionEvaluation {
  return { matched: true, malformed: false, reason: "条件成立" };
}

function notMatched(reason: string): ConditionEvaluation {
  return { matched: false, malformed: false, reason };
}

function malformed(reason: string): ConditionEvaluation {
  return { matched: false, malformed: true, reason: `畸形条件（${reason}），按不成立处理` };
}

/** JSON 标量：字符串 / 有限数字 / 布尔 / null。空字符串是合法标量，是否有意义由运算符决定 */
function isJsonScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/** 非空且元素全为 JSON 标量的数组（`in` / `notIn` / `contains` 的集合写法） */
function isScalarList(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0 && value.every(isJsonScalar);
}

/**
 * 叶子条件的结构 + value 类型校验。
 *
 * 关键点：
 * - 在读取 actual **之前**完成，所以属性缺失也无法让非法 value 逃过畸形检测；
 * - `eq` / `neq` 允许任意 JSON 标量（含空字符串：空串相等是合法语义，不能一刀切判畸形）；
 * - `startsWith` / `contains` / `matches` 期望非空字符串，`contains` 额外接受非空标量数组；
 * - `gt` / `gte` / `lt` / `lte` 只接受字符串或有限数字，布尔/数组不再被 String()/Number() 兜底；
 * - `in` / `notIn` 兼容历史的"单标量或数组"两种写法，但拒绝 object / undefined / 空数组；
 * - `matches` 在这里就真正编译正则：非法正则（如 `"(["`）是畸形条件，而不是"不匹配"。
 */
function validate(condition: Condition): string | undefined {
  if (condition === null || typeof condition !== "object" || Array.isArray(condition)) {
    return "条件不是对象";
  }
  for (const key of Object.keys(condition)) {
    if (!LEAF_KEYS.has(key)) return `叶子条件包含未知键 ${key}`;
  }
  if (typeof condition.attr !== "string" || condition.attr.trim().length === 0) {
    return "缺少 attr（或为空白）";
  }
  const op: unknown = condition.op;
  if (typeof op !== "string" || !CONDITION_OPERATORS.has(op)) {
    return `未知运算符 ${valueLabel(op)}`;
  }
  if (op === "exists") return undefined; // exists 只看存在性，不需要 value

  const value = condition.value;
  if (value === undefined) return `运算符 ${op} 缺少 value`;
  switch (op) {
    case "eq":
    case "neq":
      return isJsonScalar(value) ? undefined : `运算符 ${op} 的 value 必须是 JSON 标量`;
    case "in":
    case "notIn":
      return isJsonScalar(value) || isScalarList(value)
        ? undefined
        : `运算符 ${op} 的 value 必须是非空标量数组或单个标量`;
    case "contains":
      return (typeof value === "string" && value.length > 0) || isScalarList(value)
        ? undefined
        : "运算符 contains 的 value 必须是非空字符串或非空标量数组";
    case "startsWith":
      return typeof value === "string" && value.length > 0
        ? undefined
        : "运算符 startsWith 的 value 必须是非空字符串";
    case "matches": {
      if (typeof value !== "string" || value.length === 0) {
        return "运算符 matches 的 value 必须是非空字符串";
      }
      try {
        new RegExp(value);
      } catch {
        return `运算符 matches 的 value 不是合法正则 ${valueLabel(value)}`;
      }
      return undefined;
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
        ? undefined
        : `运算符 ${op} 的 value 必须是字符串或有限数字`;
    default:
      return `未知运算符 ${valueLabel(op)}`;
  }
}

/** 分组节点的结构校验：至少一个数组字段，且不得含未知键 */
function validateGroup(group: Record<string, unknown>): string | undefined {
  for (const key of Object.keys(group)) {
    if (!GROUP_KEYS.has(key)) return `条件分组包含未知键 ${key}`;
  }
  const keys = ["all", "any", "none"] as const;
  if (!keys.some((key) => group[key] !== undefined)) {
    return "条件分组为空：all/any/none 均未定义";
  }
  for (const key of keys) {
    const value = group[key];
    if (value === undefined) continue;
    if (!Array.isArray(value)) return `条件分组的 ${key} 不是数组`;
  }
  return undefined;
}

/**
 * 求值单个叶子条件。以上所有校验都在读取 actual 之前完成，因此畸形条件不会因为
 * "属性恰好缺失"而退化成普通的 notMatched。
 */
export function evaluateSingle(condition: Condition, ctx: EvalContext): ConditionEvaluation {
  const invalid = validate(condition);
  if (invalid !== undefined) return malformed(invalid);

  const direct = getPath(ctx, condition.attr);
  const actual = direct === undefined ? getPath(ctx.subject, condition.attr) : direct;
  const expected = condition.value;

  if (actual === undefined || actual === null) {
    // 属性缺失时正向运算符不成立；取反运算符同样不成立，避免 `undefined !== x` 直接命中。
    // 已知缺口（本轮不修，勿当成已修）：这也意味着 `neq` / `notIn` 的 **deny** 在属性缺失时
    // 不会触发 —— 删掉属性仍可能让该 deny 失效。本轮不引入"属性必填 / required"语义。
    if (condition.op === "exists") return notMatched(`属性 ${condition.attr} 不存在`);
    return notMatched(`属性 ${condition.attr} 缺失，运算符 ${condition.op} 无法成立`);
  }

  switch (condition.op) {
    case "eq":
      return equals(actual, expected) ? matched() : notMatched(`属性 ${condition.attr} 不等于期望值`);
    case "neq":
      return equals(actual, expected) ? notMatched(`属性 ${condition.attr} 等于期望值`) : matched();
    case "in": {
      // 对称语义：属性是数组时表示"任一元素命中"，期望值是数组时表示"取值在集合内"
      const candidates = Array.isArray(expected) ? expected : [expected];
      const actuals = Array.isArray(actual) ? actual : [actual];
      return actuals.some((item) => candidates.some((candidate) => equals(item, candidate)))
        ? matched()
        : notMatched(`属性 ${condition.attr} 不在期望集合内`);
    }
    case "notIn": {
      const candidates = Array.isArray(expected) ? expected : [expected];
      const actuals = Array.isArray(actual) ? actual : [actual];
      return !actuals.some((item) => candidates.some((candidate) => equals(item, candidate)))
        ? matched()
        : notMatched(`属性 ${condition.attr} 落在禁止集合内`);
    }
    case "contains": {
      if (typeof actual === "string") {
        // 字符串属性只支持"子串包含"：标量数组期望值对字符串无意义，按畸形处理而非静默不匹配
        if (typeof expected !== "string") {
          return malformed(`属性 ${condition.attr} 是字符串，contains 的 value 必须是字符串`);
        }
        return actual.includes(expected)
          ? matched()
          : notMatched(`属性 ${condition.attr} 不包含期望子串`);
      }
      if (Array.isArray(actual)) {
        const candidates = Array.isArray(expected) ? expected : [expected];
        return actual.some((item) => candidates.some((candidate) => equals(item, candidate)))
          ? matched()
          : notMatched(`属性 ${condition.attr} 数组不含期望元素`);
      }
      return notMatched(`属性 ${condition.attr} 类型为 ${typeName(actual)}，不支持 contains`);
    }
    case "startsWith":
      // validate 已保证 expected 是非空字符串
      return typeof actual === "string" && actual.startsWith(expected as string)
        ? matched()
        : notMatched(`属性 ${condition.attr} 不以期望前缀开头`);
    case "gt": {
      const result = compare(actual, expected);
      return result !== undefined && result > 0 ? matched() : notMatched(`属性 ${condition.attr} 不满足 gt`);
    }
    case "gte": {
      const result = compare(actual, expected);
      return result !== undefined && result >= 0 ? matched() : notMatched(`属性 ${condition.attr} 不满足 gte`);
    }
    case "lt": {
      const result = compare(actual, expected);
      return result !== undefined && result < 0 ? matched() : notMatched(`属性 ${condition.attr} 不满足 lt`);
    }
    case "lte": {
      const result = compare(actual, expected);
      return result !== undefined && result <= 0 ? matched() : notMatched(`属性 ${condition.attr} 不满足 lte`);
    }
    case "exists":
      return matched();
    case "matches":
      // validate 已保证 expected 可编译，这里不再吞异常，非法正则在 validate 阶段就是畸形
      if (typeof actual !== "string") return notMatched(`属性 ${condition.attr} 不是字符串，无法匹配正则`);
      return new RegExp(expected as string).test(actual)
        ? matched()
        : notMatched(`属性 ${condition.attr} 不匹配正则`);
    default:
      return malformed(`未知运算符 ${valueLabel(condition.op)}`);
  }
}

function isCondition(expr: ConditionExpr): expr is Condition {
  return typeof (expr as Condition).attr === "string";
}

/**
 * 递归求值条件表达式。语义（fail-closed）：
 * - 只有**根**表达式的 `undefined` 表示"没有条件"，视为无约束；分组内的 undefined/null
 *   是缺失节点，按畸形处理（否则 `any:[undefined]` 会匹配一切）；
 * - 空分组、未知键、非数组字段、非对象节点、非法叶子、超深/自引用都判畸形 → 整棵树不成立；
 * - `all` 全部成立；`any` 任一成立；`none` 任一成立即 false；
 * - 子节点全部求值、不做会漏检畸形分支的短路。
 */
export function evaluateConditionDetailed(
  expr: ConditionExpr | undefined,
  ctx: EvalContext,
  path = "condition",
  depth = 0,
): ConditionEvaluation {
  if (depth > MAX_CONDITION_DEPTH) {
    return malformed(`${path} 超过最大嵌套深度 ${MAX_CONDITION_DEPTH}（可能是循环引用）`);
  }
  if (expr === undefined) {
    return depth === 0 ? matched() : malformed(`${path} 是 undefined：分组内缺失节点不是"无约束"`);
  }
  if (expr === null || typeof expr !== "object" || Array.isArray(expr)) {
    return malformed(`${path} 不是条件对象`);
  }

  if (isCondition(expr)) {
    const result = evaluateSingle(expr, ctx);
    return result.malformed ? malformed(`${path}: ${result.reason}`) : result;
  }

  const group = expr as Record<string, unknown>;
  const groupInvalid = validateGroup(group);
  if (groupInvalid !== undefined) return malformed(`${path}（${groupInvalid}）`);

  const all = group.all as ConditionExpr[] | undefined;
  const any = group.any as ConditionExpr[] | undefined;
  const none = group.none as ConditionExpr[] | undefined;

  // 先完整求值所有子节点：收集可读原因，并确保任何畸形节点都会被看到
  // （不能因为 all 前半段短路而漏掉后半段，也不能让 none 里的畸形叶子被"取反"成放行）。
  const allResults = all?.map((item, index) => evaluateConditionDetailed(item, ctx, `${path}.all[${index}]`, depth + 1));
  const anyResults = any?.map((item, index) => evaluateConditionDetailed(item, ctx, `${path}.any[${index}]`, depth + 1));
  const noneResults = none?.map((item, index) => evaluateConditionDetailed(item, ctx, `${path}.none[${index}]`, depth + 1));

  const malformedReason = findMalformed([allResults, anyResults, noneResults]);
  if (malformedReason !== undefined) return malformed(`${path}: ${malformedReason}`);

  const allFailures = (allResults ?? []).filter((result) => !result.matched);
  if (allFailures.length > 0) {
    return notMatched(`${path}.all 存在不成立的子条件（${allFailures[0]!.reason}）`);
  }

  if (anyResults !== undefined && !anyResults.some((result) => result.matched)) {
    const reasons = anyResults.map((result) => result.reason).join("；");
    return notMatched(`${path}.any 无一成立（${reasons}）`);
  }

  const noneHits = (noneResults ?? []).filter((result) => result.matched);
  if (noneHits.length > 0) {
    return notMatched(`${path}.none 中有子条件成立，该分组要求全部不成立`);
  }

  return matched();
}

function findMalformed(
  groups: readonly (readonly ConditionEvaluation[] | undefined)[],
): string | undefined {
  for (const group of groups) {
    if (group === undefined) continue;
    for (const result of group) {
      if (result.malformed) return result.reason;
    }
  }
  return undefined;
}

/** 递归求值条件表达式；根 undefined 视为无约束，其余畸形一律不成立 */
export function evaluateCondition(expr: ConditionExpr | undefined, ctx: EvalContext): boolean {
  return evaluateConditionDetailed(expr, ctx).matched;
}

/** 供判定结果解释使用：返回整棵条件树失败/成功原因的外层可读描述 */
export function describeConditionEvaluation(
  expr: ConditionExpr | undefined,
  ctx: EvalContext,
  path = "condition",
): string {
  return evaluateConditionDetailed(expr, ctx, path).reason;
}
