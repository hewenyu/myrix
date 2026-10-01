/**
 * OpenAI **Responses** 协议子集：请求校验、规范化、上游请求体构造、SSE 帧解析。
 *
 * 设计取舍：
 * * 网关**只讲 Responses**：`/v1/responses` 入、上游完整 `/responses` URL 出。
 *   仓库硬性规则禁止 `chat/completions`（AGENTS.md 6），因此这里**没有**任何
 *   chat 字段别名、隐式转换或失败回退；旧路径在 HTTP 层就是 404。
 * * **无状态**：`store` 只能是 `false`（缺省也按 false 处理），向上游恒发
 *   `store: false`。`previous_response_id` / `conversation` / `background` 这类
 *   "把状态留在上游"的字段一律 400 —— 网关转发的是完整历史，不依赖上游保存的会话。
 * * **只转发明确列在白名单里的字段**。未知顶层字段一律 400（fail-closed），
 *   避免客户端夹带我们没治理过的参数（例如绕过输出上限的供应商私有字段）。
 * * **身份/客户端令牌覆盖字段一律拒绝**：`user`、`metadata`、`safety_identifier`、
 *   `prompt_cache_key` 都可能被用来把用量归到别的租户/主体上。归因只来自
 *   Authorization 凭据 + 数据库绑定行（见 ports.ts）。
 */
import { invalidRequest } from "./errors";

/** Responses 输入消息允许的角色（`tool` 角色由 `function_call_output` 项表达）。 */
export const RESPONSE_ROLES = ["system", "developer", "user", "assistant"] as const;
export type ResponseRole = (typeof RESPONSE_ROLES)[number];

/** 文本内容块。只支持文本：`input_text`（用户/系统侧）与 `output_text`（assistant 历史）。 */
export const TEXT_PART_TYPES = ["input_text", "output_text"] as const;
export type TextPartType = (typeof TEXT_PART_TYPES)[number];

export interface TextContentPart {
  type: TextPartType;
  text: string;
}

export interface ResponseMessageItem {
  type: "message";
  role: ResponseRole;
  content: TextContentPart[];
}

export interface ResponseFunctionCallItem {
  type: "function_call";
  call_id: string;
  name: string;
  /** Responses 线协议里 arguments 是 JSON 字符串（不是对象） */
  arguments: string;
  id?: string;
}

export interface ResponseFunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export type ResponseInputItem = ResponseMessageItem | ResponseFunctionCallItem | ResponseFunctionCallOutputItem;

export interface ResponseToolDefinition {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export type ResponseToolChoice = "none" | "auto" | "required" | { type: "function"; name: string };

export interface ParsedResponseRequest {
  model: string;
  input: ResponseInputItem[];
  stream: boolean;
  /** 本次输出预算（已校验不超过部署硬上限），向上游恒发 `max_output_tokens` */
  maxOutputTokens: number;
  instructions?: string;
  tools?: ResponseToolDefinition[];
  toolChoice?: ResponseToolChoice;
}

export interface RequestValidationLimits {
  /** 输出 token 硬上限；请求值超过即拒绝（不静默放大） */
  maxOutputTokens: number;
  /** 请求未指定输出上限时的默认值 */
  defaultMaxOutputTokens: number;
  /** 输入项（message / function_call / function_call_output）数量上限 */
  maxInputItems: number;
  /** 单个文本块 / instructions / 工具参数的长度上限（字符） */
  maxInputChars: number;
}

const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  "model",
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "max_output_tokens",
  "stream",
  "store",
]);

/**
 * 显式拒绝的字段：它们要么把状态留在上游、要么能覆盖归因/缓存主体。
 * 单独列出来是为了给出**可读原因**（AGENTS.md 3），而不是只回一句"未知字段"。
 */
const DENIED_FIELDS: ReadonlyMap<string, string> = new Map([
  ["previous_response_id", "网关无状态转发完整历史，不接受 previous_response_id（不依赖上游保存的会话）"],
  ["conversation", "网关不接受 conversation：会话状态必须由 Cell 以完整 input 表达"],
  ["background", "网关不接受 background 异步响应：一次请求必须同步返回并可结算"],
  ["user", "网关不接受 user 字段：主体归因只来自 cell 凭据与数据库绑定行"],
  ["metadata", "网关不接受 metadata：它可能被用来夹带身份/归因覆盖"],
  ["safety_identifier", "网关不接受 safety_identifier：它可能被用来覆盖主体身份"],
  ["prompt_cache_key", "网关不接受 prompt_cache_key：缓存主体归因不由客户端指定"],
]);

const MODEL_PATTERN = /^[A-Za-z0-9._:/-]{1,200}$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const CALL_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,256}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integerField(source: Record<string, unknown>, name: string, min: number, max: number): number | undefined {
  const value = source[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw invalidRequest(`字段 ${name} 必须是整数`);
  }
  if (value < min || value > max) throw invalidRequest(`字段 ${name} 必须在 [${min}, ${max}] 之间`);
  return value;
}

function booleanField(source: Record<string, unknown>, name: string): boolean | undefined {
  const value = source[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw invalidRequest(`字段 ${name} 必须是布尔值`);
  return value;
}

function normalizeTextParts(raw: unknown, where: string, maxChars: number): TextContentPart[] {
  const parts = typeof raw === "string" ? [{ type: "input_text", text: raw }] : raw;
  if (!Array.isArray(parts)) {
    throw invalidRequest(`${where}.content 必须是字符串或内容块数组（首版只支持文本输入）`);
  }
  if (parts.length === 0 || parts.length > 64) throw invalidRequest(`${where}.content 数组长度必须在 1..64`);
  const normalized: TextContentPart[] = [];
  for (const [index, part] of parts.entries()) {
    if (!isPlainObject(part)) throw invalidRequest(`${where}.content[${index}] 必须是对象`);
    const type = part.type;
    if (typeof type !== "string" || !(TEXT_PART_TYPES as readonly string[]).includes(type)) {
      throw invalidRequest(`${where}.content[${index}].type 必须是 ${TEXT_PART_TYPES.join("/")}（首版不支持图片/音频/文件输入）`);
    }
    if (typeof part.text !== "string") throw invalidRequest(`${where}.content[${index}].text 必须是字符串`);
    if (part.text.length > maxChars) throw invalidRequest(`${where}.content[${index}].text 超过 ${maxChars} 字符上限`);
    normalized.push({ type: type as TextPartType, text: part.text });
  }
  return normalized;
}

function normalizeInputItem(raw: unknown, index: number, limits: RequestValidationLimits): ResponseInputItem {
  const where = `input[${index}]`;
  if (!isPlainObject(raw)) throw invalidRequest(`${where} 必须是对象`);
  const type = raw.type ?? (raw.role === undefined ? undefined : "message");

  if (type === "message") {
    const role = raw.role;
    if (typeof role !== "string" || !(RESPONSE_ROLES as readonly string[]).includes(role)) {
      throw invalidRequest(`${where}.role 必须是 ${RESPONSE_ROLES.join("/")} 之一`);
    }
    if (raw.content === undefined || raw.content === null) throw invalidRequest(`${where} (role=${role}) 必须提供 content`);
    return { type: "message", role: role as ResponseRole, content: normalizeTextParts(raw.content, where, limits.maxInputChars) };
  }

  if (type === "function_call") {
    const callId = raw.call_id;
    if (typeof callId !== "string" || !CALL_ID_PATTERN.test(callId)) {
      throw invalidRequest(`${where}.call_id 必须是 1..256 的标识符字符串`);
    }
    const name = raw.name;
    if (typeof name !== "string" || !TOOL_NAME_PATTERN.test(name)) {
      throw invalidRequest(`${where}.name 必须是合法工具名（字母数字与 . _ : -，≤64）`);
    }
    const args = raw.arguments ?? "";
    if (typeof args !== "string") throw invalidRequest(`${where}.arguments 必须是 JSON 字符串`);
    if (args.length > limits.maxInputChars) throw invalidRequest(`${where}.arguments 超过 ${limits.maxInputChars} 字符上限`);
    const item: ResponseFunctionCallItem = { type: "function_call", call_id: callId, name, arguments: args };
    if (raw.id !== undefined) {
      if (typeof raw.id !== "string" || !CALL_ID_PATTERN.test(raw.id)) throw invalidRequest(`${where}.id 非法`);
      item.id = raw.id;
    }
    return item;
  }

  if (type === "function_call_output") {
    const callId = raw.call_id;
    if (typeof callId !== "string" || !CALL_ID_PATTERN.test(callId)) {
      throw invalidRequest(`${where}.call_id 必须是 1..256 的标识符字符串`);
    }
    const output = raw.output;
    if (typeof output !== "string") {
      throw invalidRequest(`${where}.output 必须是字符串（对象/数组输出请由 Cell 先序列化）`);
    }
    if (output.length > limits.maxInputChars) throw invalidRequest(`${where}.output 超过 ${limits.maxInputChars} 字符上限`);
    return { type: "function_call_output", call_id: callId, output };
  }

  throw invalidRequest(`${where}.type 必须是 message / function_call / function_call_output 之一`);
}

function normalizeTools(raw: unknown, limits: RequestValidationLimits): ResponseToolDefinition[] {
  if (!Array.isArray(raw)) throw invalidRequest("tools 必须是数组");
  if (raw.length > 128) throw invalidRequest("tools 数量超过上限 128");
  const tools: ResponseToolDefinition[] = [];
  for (const [index, tool] of raw.entries()) {
    const where = `tools[${index}]`;
    if (!isPlainObject(tool)) throw invalidRequest(`${where} 必须是对象`);
    if (tool.type !== "function") throw invalidRequest(`${where}.type 必须是 "function"（首版不做内建工具/远程 MCP）`);
    if (typeof tool.name !== "string" || !TOOL_NAME_PATTERN.test(tool.name)) {
      throw invalidRequest(`${where}.name 必须是合法工具名（字母数字与 . _ : -，≤64）`);
    }
    const definition: ResponseToolDefinition = { type: "function", name: tool.name };
    if (tool.description !== undefined) {
      if (typeof tool.description !== "string" || tool.description.length > limits.maxInputChars) {
        throw invalidRequest(`${where}.description 必须是不超过 ${limits.maxInputChars} 字符的字符串`);
      }
      definition.description = tool.description;
    }
    if (tool.parameters !== undefined) {
      if (!isPlainObject(tool.parameters)) throw invalidRequest(`${where}.parameters 必须是 JSON Schema 对象`);
      definition.parameters = tool.parameters;
    }
    if (tool.strict !== undefined) {
      if (typeof tool.strict !== "boolean") throw invalidRequest(`${where}.strict 必须是布尔值`);
      definition.strict = tool.strict;
    }
    tools.push(definition);
  }
  return tools;
}

function normalizeToolChoice(raw: unknown): ResponseToolChoice {
  if (typeof raw === "string") {
    if (raw !== "none" && raw !== "auto" && raw !== "required") {
      throw invalidRequest('tool_choice 字符串只能是 "none" / "auto" / "required"');
    }
    return raw;
  }
  if (isPlainObject(raw)) {
    if (raw.type !== "function" || typeof raw.name !== "string" || !TOOL_NAME_PATTERN.test(raw.name)) {
      throw invalidRequest('tool_choice 对象只支持 { type: "function", name }');
    }
    return { type: "function", name: raw.name };
  }
  throw invalidRequest("tool_choice 必须是字符串或对象");
}

/**
 * 校验并规范化一次 Responses 请求；任何不合规都抛 400（不猜测、不补齐）。
 * 返回值只含**已治理**的字段，用于预占估算与上游转发。
 */
export function parseResponseRequest(raw: unknown, limits: RequestValidationLimits): ParsedResponseRequest {
  if (!isPlainObject(raw)) throw invalidRequest("请求体必须是 JSON 对象");

  for (const key of Object.keys(raw)) {
    const denied = DENIED_FIELDS.get(key);
    if (denied !== undefined) throw invalidRequest(`字段 ${key} 不被网关接受：${denied}`);
    if (!ALLOWED_FIELDS.has(key)) {
      throw invalidRequest(`字段 ${key} 不在网关允许转发的字段白名单内（防止夹带未治理参数）`);
    }
  }

  const model = raw.model;
  if (typeof model !== "string" || !MODEL_PATTERN.test(model)) {
    throw invalidRequest("model 必须是非空字符串（只允许字母数字与 . _ : / -）");
  }

  const inputRaw = raw.input;
  if (!Array.isArray(inputRaw) || inputRaw.length === 0) {
    throw invalidRequest("input 必须是非空数组（完整历史由 Cell 提供，网关无状态）");
  }
  if (inputRaw.length > limits.maxInputItems) throw invalidRequest(`input 项数超过上限 ${limits.maxInputItems}`);
  const input = inputRaw.map((item, index) => normalizeInputItem(item, index, limits));

  const stream = booleanField(raw, "stream") ?? false;

  // 无状态：store 只能是 false；缺省也按 false 处理并向上游恒发 store:false。
  const store = booleanField(raw, "store");
  if (store === true) throw invalidRequest("网关是无状态转发：store 只能为 false（不接受 true）");

  const requestedOutput = integerField(raw, "max_output_tokens", 1, Number.MAX_SAFE_INTEGER);
  if (requestedOutput !== undefined && requestedOutput > limits.maxOutputTokens) {
    throw invalidRequest(`输出 token 上限 ${requestedOutput} 超过网关硬上限 ${limits.maxOutputTokens}`);
  }

  const parsed: ParsedResponseRequest = {
    model,
    input,
    stream,
    maxOutputTokens: requestedOutput ?? limits.defaultMaxOutputTokens,
  };

  if (raw.instructions !== undefined && raw.instructions !== null) {
    if (typeof raw.instructions !== "string") throw invalidRequest("instructions 必须是字符串");
    if (raw.instructions.length > limits.maxInputChars) throw invalidRequest(`instructions 超过 ${limits.maxInputChars} 字符上限`);
    parsed.instructions = raw.instructions;
  }
  if (raw.tools !== undefined && raw.tools !== null) parsed.tools = normalizeTools(raw.tools, limits);
  if (raw.tool_choice !== undefined && raw.tool_choice !== null) parsed.toolChoice = normalizeToolChoice(raw.tool_choice);
  return parsed;
}

/**
 * 构造转发给上游的 Responses 请求体。
 * `model` 恒为部署配置里的上游模型（客户端请求的 model 只用于 allowlist 校验）；
 * 恒发 `store: false`，并且 `max_output_tokens` 一定带上（预占必须覆盖输出预算）。
 */
export function toUpstreamBody(parsed: ParsedResponseRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: parsed.model,
    input: parsed.input,
    stream: parsed.stream,
    store: false,
    max_output_tokens: parsed.maxOutputTokens,
  };
  if (parsed.instructions !== undefined) body.instructions = parsed.instructions;
  if (parsed.tools !== undefined) body.tools = parsed.tools;
  if (parsed.toolChoice !== undefined) body.tool_choice = parsed.toolChoice;
  return body;
}

// ---------------------------------------------------------------------------
// SSE 帧解析（有界）
// ---------------------------------------------------------------------------

export interface SseEvent {
  event?: string;
  data?: string;
}

/** 单个 SSE 事件过大即中止：这是有界帧解析，不把上游当可信无限缓冲。 */
export class SseFramingError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "SseFramingError";
  }
}

export interface SseParseOptions {
  /** 单个事件（含 data 行）允许的最大字节数；默认 1 MiB */
  maxEventBytes?: number;
}

export const DEFAULT_MAX_SSE_EVENT_BYTES = 1024 * 1024;

/**
 * 解析上游 SSE 字节流。宽容处理 CRLF、多行 data 与不完整尾块；
 * 单个事件超过 `maxEventBytes` 抛 {@link SseFramingError}（调用方按协议错误处理）。
 */
export async function* parseSse(chunks: AsyncIterable<Uint8Array>, options: SseParseOptions = {}): AsyncGenerator<SseEvent> {
  const maxEventBytes = Math.max(1, options.maxEventBytes ?? DEFAULT_MAX_SSE_EVENT_BYTES);
  const decoder = new TextDecoder();
  let buffer = "";
  let pendingBytes = 0;
  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = findBoundary(buffer);
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      pendingBytes = 0;
      // 完整块也要检查：单个超大事件不允许被 JSON.parse（有界解析，不信任无限缓冲）。
      if (Buffer.byteLength(block, "utf8") > maxEventBytes) {
        throw new SseFramingError(`上游单个 SSE 事件超过 ${maxEventBytes} 字节上限`);
      }
      const event = parseBlock(block);
      if (event) yield event;
      boundary = findBoundary(buffer);
    }
    pendingBytes += Buffer.byteLength(buffer, "utf8");
    if (pendingBytes > maxEventBytes) {
      throw new SseFramingError(`上游单个 SSE 事件超过 ${maxEventBytes} 字节上限`);
    }
  }
  buffer += decoder.decode();
  const tail = parseBlock(buffer);
  if (tail) yield tail;
}

function findBoundary(buffer: string): { index: number; length: number } | -1 {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return -1;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function parseBlock(block: string): SseEvent | undefined {
  const trimmed = block.trim();
  if (trimmed.length === 0) return undefined;
  const event: SseEvent = {};
  const dataLines: string[] = [];
  for (const rawLine of trimmed.split(/\r?\n/)) {
    if (rawLine.startsWith(":")) continue;
    const separator = rawLine.indexOf(":");
    const field = separator === -1 ? rawLine : rawLine.slice(0, separator);
    const value = separator === -1 ? "" : rawLine.slice(separator + 1).replace(/^ /, "");
    if (field === "event") event.event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (dataLines.length > 0) event.data = dataLines.join("\n");
  return event.event === undefined && event.data === undefined ? undefined : event;
}

export function formatSseData(data: string): string {
  return `data: ${data}\n\n`;
}

export function formatSseEvent(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`;
}

// ---------------------------------------------------------------------------
// Responses 终止语义
// ---------------------------------------------------------------------------

/** 流式：只有这些事件携带最终 `response` 与 usage，代表本次生成结束。 */
export const RESPONSE_TERMINAL_EVENTS: ReadonlySet<string> = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
]);

/** 只有 `completed` 才算成功结束；`incomplete` / `failed` 是**已知的失败**，不能当成功。 */
export const RESPONSE_SUCCESS_EVENT = "response.completed";

/** 非流式响应体里的终止状态。 */
export const RESPONSE_TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "incomplete", "failed"]);

export function isTerminalEvent(event: string): boolean {
  return RESPONSE_TERMINAL_EVENTS.has(event);
}

/** 非流式响应体是否有终止状态；没有终止状态的 200 不能推断为成功。 */
export function hasTerminalStatus(body: unknown): boolean {
  if (!isPlainObject(body)) return false;
  const status = body.status;
  return typeof status === "string" && RESPONSE_TERMINAL_STATUSES.has(status);
}

export function isSuccessStatus(body: unknown): boolean {
  return isPlainObject(body) && body.status === "completed";
}

/**
 * 网关自己产生的流内错误事件（Responses 线上就是 `event: error`）。
 * 文案固定、不含上游正文/URL/密钥：上游错误原文一律不回显。
 */
export function streamErrorEvent(code: string, message: string): string {
  return formatSseEvent("error", JSON.stringify({ type: "error", code, message }));
}
