/**
 * 额度预占与用量规范化（OpenAI **Responses** 口径）。
 *
 * 原则（对应需求"预占保守、结算据实、未知不猜"）：
 * 1. 预占必须**覆盖**输入的真实规模。网关没有上游 tokenizer，因此**不声称精确换算**：
 *    按 UTF-8 字节数取保守系数（默认 3 字节/token），并把输入项结构字段
 *    （role / function_call 的 name+call_id+arguments / function_call_output 的 output）
 *    与 instructions/tools/tool_choice 的 JSON 成本一并计入。
 * 2. 预占超过输入硬上限时**明确拒绝**（400 `input_too_large`），**绝不静默截断**。
 * 3. 结算只认上游返回的真实 usage，且**完整计入**；真实用量可以超过预占。
 *    Responses 的 `input_tokens`/`output_tokens` 直接映射到既有的
 *    prompt/completion 账本字段；`total_tokens` 取"上游声明值"与"两项之和"的较大者。
 * 4. 拿不到 usage 就是"未知"，调用方必须保守保留预占（见 ledger.ts 的 settle 语义）。
 *    缓存命中 (`input_tokens_details.cached_tokens`) 与推理 token
 *    (`output_tokens_details.reasoning_tokens`) **已在 input/output 之内**，
 *    只作审计元数据记录，**不**从计费总量里扣除（否则等于少计）。
 */
import { GatewayError } from "./errors";
import type {
  ParsedResponseRequest,
  RequestValidationLimits,
  ResponseFunctionCallItem,
  ResponseInputItem,
  ResponseToolDefinition,
} from "./protocol";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 审计用：输入里命中缓存的 token 数（已含在 promptTokens 内，不参与扣减） */
  cachedTokens?: number;
  /** 审计用：输出里的推理 token 数（已含在 completionTokens 内，不参与扣减） */
  reasoningTokens?: number;
}

/**
 * 保守系数：每个 token 至少记这么多个 UTF-8 字节。
 * 3 的依据（不声称精确，只作预占下界）：
 * * 英文约 3.5–4 字节/token，3 字节/token ≈ 1.1–1.3× 真实值；
 * * 中文 UTF-8 为 3 字节/字、约 0.6 token/字 ⇒ 3 字节/token ≈ 1.7× 真实值。
 * 因此取 3 在两种主要文字下都不低于常见真实用量；预占多占的部分在结算时退回。
 */
export const DEFAULT_BYTES_PER_TOKEN = 3;

/** 每个输入项的结构开销（字节，粗略常量，只用于预占）。 */
const ITEM_STRUCTURAL_BYTES = 16;
/** 每个文本内容块的结构开销（字节）。 */
const TEXT_PART_STRUCTURAL_BYTES = 8;

const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

/** JSON 成本；无法序列化时返回 undefined（调用方必须按"不可计量"fail-closed 处理）。 */
function jsonBytes(value: unknown): number | undefined {
  if (value === undefined) return 0;
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? undefined : utf8Bytes(encoded);
  } catch {
    return undefined;
  }
}

function itemBytes(item: ResponseInputItem): number {
  let total = ITEM_STRUCTURAL_BYTES;
  if (item.type === "message") {
    total += utf8Bytes(item.role);
    for (const part of item.content) total += TEXT_PART_STRUCTURAL_BYTES + utf8Bytes(part.type) + utf8Bytes(part.text);
    return total;
  }
  if (item.type === "function_call") {
    return total + utf8Bytes(item.name) + utf8Bytes(item.call_id) + utf8Bytes(item.arguments) + utf8Bytes(item.id ?? "");
  }
  return total + utf8Bytes(item.call_id) + utf8Bytes(item.output);
}

function inputBytes(items: readonly ResponseInputItem[]): number {
  let total = 0;
  for (const item of items) total += itemBytes(item);
  return total;
}

export interface PromptCostOptions {
  /** 每个 token 记多少 UTF-8 字节；默认 {@link DEFAULT_BYTES_PER_TOKEN}（3）。 */
  bytesPerToken?: number;
}

/** 输入项本身的保守估算（只用于预占；结算永远用上游真实 usage）。 */
export function estimatePromptTokens(items: readonly ResponseInputItem[], options: PromptCostOptions = {}): number {
  const bytesPerToken = Math.max(1, options.bytesPerToken ?? DEFAULT_BYTES_PER_TOKEN);
  return Math.max(1, Math.ceil(inputBytes(items) / bytesPerToken));
}

/**
 * 整次请求的输入估算：输入项 + instructions + tools/tool_choice 的 JSON 成本。
 * 出现不可计量的字段时返回 `Infinity`（调用方必须拒绝，而不是按 0 计）。
 */
export function estimateRequestTokens(request: ParsedResponseRequest, options: PromptCostOptions = {}): number {
  const bytesPerToken = Math.max(1, options.bytesPerToken ?? DEFAULT_BYTES_PER_TOKEN);
  let bytes = inputBytes(request.input);
  if (request.instructions !== undefined) bytes += ITEM_STRUCTURAL_BYTES + utf8Bytes(request.instructions);
  for (const value of [request.tools as readonly ResponseToolDefinition[] | undefined, request.toolChoice]) {
    if (value === undefined) continue;
    const cost = jsonBytes(value);
    if (cost === undefined) return Number.POSITIVE_INFINITY;
    bytes += cost;
  }
  return Math.max(1, Math.ceil(bytes / bytesPerToken));
}

/** 本次请求的输出预算（已由 protocol 校验不超过硬上限）。 */
export function outputBudget(request: ParsedResponseRequest, limits: RequestValidationLimits): number {
  return Math.min(request.maxOutputTokens ?? limits.defaultMaxOutputTokens, limits.maxOutputTokens);
}

export interface ReservationPolicy {
  /** 每个 token 记多少 UTF-8 字节（默认 3；必须 ≥1）。只影响预占，不影响结算。 */
  bytesPerToken: number;
  /**
   * 输入预占硬上限。超过即 400 `input_too_large`，**不截断**。
   */
  maxInputTokens: number;
}

/**
 * 预占量 = 输入保守估算 + 输出预算，**不封顶截断**。
 * 估算超过 `maxInputTokens`（或字段不可计量）→ 抛 400 `input_too_large`。
 */
export function computeReservation(
  request: ParsedResponseRequest,
  limits: RequestValidationLimits,
  policy: ReservationPolicy,
): number {
  const estimated = estimateRequestTokens(request, { bytesPerToken: policy.bytesPerToken });
  if (!Number.isFinite(estimated) || estimated > policy.maxInputTokens) {
    throw new GatewayError(
      400,
      "input_too_large",
      Number.isFinite(estimated)
        ? `输入估算 ${estimated} token 超过网关输入上限 ${policy.maxInputTokens}（按 UTF-8 字节数保守估算，不代表精确 tokenizer 结果）；请拆分请求或提高 MYRIX_GATEWAY_MAX_BODY_BYTES`
        : "请求中存在无法计量成本的字段（tools/tool_choice 无法序列化），拒绝预占",
      "invalid_request_error",
    );
  }
  return Math.max(1, estimated + outputBudget(request, limits));
}

/**
 * 规范化 Responses 的 `usage` 块：
 *
 * ```json
 * { "input_tokens": 12, "output_tokens": 34, "total_tokens": 46,
 *   "input_tokens_details": { "cached_tokens": 8 },
 *   "output_tokens_details": { "reasoning_tokens": 5 } }
 * ```
 *
 * `input_tokens` / `output_tokens` 必须是非负安全整数，否则视为**未知**（返回 undefined），
 * 调用方按"保守保留预占"处理。`total_tokens` 取声明值与 `input+output` 的较大者：
 * 上游偶发把 total 报小时仍按完整真实用量入账。细节字段只作审计，不参与扣减。
 */
export function normalizeUsage(raw: unknown): TokenUsage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const source = raw as Record<string, unknown>;
  const prompt = tokenCount(source.input_tokens);
  const completion = tokenCount(source.output_tokens);
  if (prompt === undefined || completion === undefined) return undefined;
  const declared = tokenCount(source.total_tokens);
  const usage: TokenUsage = { promptTokens: prompt, completionTokens: completion, totalTokens: Math.max(declared ?? 0, prompt + completion) };
  const cached = detailCount(source.input_tokens_details, "cached_tokens");
  if (cached !== undefined) usage.cachedTokens = cached;
  const reasoning = detailCount(source.output_tokens_details, "reasoning_tokens");
  if (reasoning !== undefined) usage.reasoningTokens = reasoning;
  return usage;
}

function detailCount(raw: unknown, field: string): number | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  return tokenCount((raw as Record<string, unknown>)[field]);
}

function tokenCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
  return value;
}

/** `function_call` 项里 arguments 是否为合法 JSON 字符串（仅用于诊断/审计，不阻止转发）。 */
export function isJsonArguments(item: ResponseFunctionCallItem): boolean {
  try {
    JSON.parse(item.arguments);
    return true;
  } catch {
    return false;
  }
}
