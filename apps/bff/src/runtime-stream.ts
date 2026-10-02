/**
 * Driver SSE 帧 → 公开 `SessionStreamEvent` 的**白名单投影**。
 *
 * 这是"哪些内容可以离开平台"的唯一判定点。公开契约见 `@myrix/contracts`：
 * `{ type: user|assistant|delta|tool|status|error|turn-end, seq?, text?, status?, toolName?, commandId? }`。
 *
 * 依据 driver 的**实际**帧格式（`plugins/myrix-runtime-driver/src/http.ts` 的
 * `encodeSseFrame`）：`data:` 是 `StreamEvent.data`（**不是**整个信封），`id:` 才是 `seq`。
 * 因此这里的输入已经是"解包后的 data"，而不是 `{seq,type,data,time}`。
 *
 * 允许公开（其余一律不投影）：
 *
 * | driver event | data 形状 | 投影 |
 * |---|---|---|
 * | `user/message` | `UserMessage`（`data.content` 与 `data.id`） | `{type:'user', seq, text, commandId?}` |
 * | `assistant/message` | `{message: AssistantMessage,…}`（`data.message.content`） | `{type:'assistant', seq, text}` |
 * | `myrix/assistant-stream` | `start`；`chunk` 且 `chunk.type==='text-delta'`；`end.outcome.kind==='abandoned'` | `{type:'status',status:'stream-start'}` / `{type:'delta',text}` / `{type:'status',status:'stream-abandoned'}` |
 * | `myrix/truncated` | `{sid, from, availableFrom}` | `{type:'status',status:'replay-required'}` |
 * | `tool/call` | `{name, callId, arguments}` | `{type:'tool', seq, toolName, commandId:callId}` |
 * | `turn/end` | `{turn, reason:{kind}}` | 只有 `kind==='completed'` 才是 `{type:'turn-end', seq}`；其余一律是失败/中断终态（见下） |
 *
 * ## `turn/end` 的**严格**终态投影（fail-closed）
 *
 * 事故背景与完整决策见 `docs/adr/0031-output-budget-and-turn-outcomes.md`；这里只记契约：
 *
 *   * `completed` → `{type:'turn-end', seq}`，**唯一**的成功终态；
 *   * `error` → `{type:'error', seq, text}`，固定文案（识别规则见 {@link turnFailureText}）；
 *   * `max-tokens` → `{type:'error', seq, text}`，固定"达到输出上限"文案。DSH 的
 *     `TurnEndReasonMap` 用 `max-tokens` 表示"至少一步触顶"，它不是 `completed`；
 *   * `aborted` / `interrupted` / `forked` → `{type:'status', seq, status:'interrupted'}`（语义不变）；
 *   * `blocked`（DSH 的 pre-step 拒绝）→ `{type:'error', seq, text}`，固定拦截文案；
 *   * **缺失 / 未知 kind → `{type:'error', seq, text}`**：既不假装成功，也不静默丢弃。
 *
 * 安全不变量：`text` 只可能是本文件的固定常量。识别只做**精确相等**（无 `includes`/前缀/正则），
 * 因此 `reason.error` 的 `name` / `message` / 原始 `code`，以及任何前缀/后缀/夹带密钥的拼接，
 * 都不会进入浏览器。
 *
 * `myrix/assistant-stream` 的三种 frame 对应 DSH 的 `AssistantStreamFrame`
 * （`vendor/deepseek-harness/packages/core/agent/src/runtime-types.ts`）：
 *   * `start` → `stream-start`：前端 reducer 据此清掉上一条未落定的 delta；
 *   * `chunk` 只投影 `text-delta`（`reasoning-delta` / `tool-call-delta` / `block-*` /
 *     `usage` / `finish` 一律跳过，推理内容与工具原始 arguments 不外泄）；
 *   * `end`：
 *       - `outcome.kind === 'abandoned'` → `stream-abandoned`。这是**重试/取消后本轮
 *         的流被丢弃**的明确信号，前端据此清掉未提交 delta；
 *       - `outcome.kind === 'committed'` → **不投影**。落定正文已经由随后/先到的持久
 *         `assistant/message`（或 `assistant/attempt`）事件承载；BFF **绝不**自己合成
 *         `assistant.final`，否则会把"没有持久事件确认"的内容当成已保存回复。
 *
 * 明确**不投影**（这是公开 `seq` 可以合法跳跃的原因）：
 *   * `request/header`、`system/message`、`developer/message`：prompt 与工具 schema；
 *   * `assistant/message.stream` 里的 reasoning、`assistant/attempt`：推理内容；
 *   * `assistant/message.data.stream` 里的 reasoning-delta（只读 `data.message.content` 的 text 块）；
 *   * `tool/result`：结果正文与 `error.reason`（工具结果与上游原因不进浏览器）；
 *   * `*` 条目的内部/上游错误：只给固定文案，绝不透传 `LlmError` 的名称与消息；
 *   * `myrix/ready`、`myrix/subscribed`：纯驱动控制帧，对浏览器无意义。
 *
 * 两条硬规则：
 *   1. 持久事件必须带 `seq`；**没有 seq 的白名单持久事件直接丢弃** —— 否则浏览器会把它
 *      当瞬态帧，重连后丢消息。
 *   2. 控制帧（`myrix/*`）一律**不带** `seq`：`myrix/truncated` 携带的 `seq` 是
 *      "可用起点"，把它当水位回传会让客户端跳过那条事件。
 *
 * `user/message` 的 `data.id` 是 DSH 侧那条用户消息的 id，driver 写入时**等于**
 * 平台 `commandId`（`plugins/myrix-runtime-driver/src/controller.ts`：`messageId`
 * 必须省略或等于 `commandId`，且 `createUserMessage(text, messageId)` 用它作为
 * `MessageId`）。浏览器 `POST /messages` 的 202 回执只给出 `commandId`，本机因此
 * 先用 `commandId` 标记"已入队、等待服务端确认"的占位；持久 `user/message` 到达时
 * 必须能把两者对上，否则同一条用户消息会同时以 pending 与持久两种形态出现。
 *
 * 这里只把它映射到**已有的公开字段** `commandId`（不新增 payload 字段、不暴露
 * `message.source` / `role` 等其余内部形状），并且只接受 UUID 形状且长度有界
 * 的值：既避免把任意内部字符串当成公开标识，也避免用正文做"不可靠去重"。
 */
import type { SessionStreamEvent } from "@myrix/contracts";

export interface ProjectionOptions {
  /** 单条投影文本的字符上限（防止一次把 MB 级正文推给浏览器）。 */
  maxTextChars?: number;
  /** 工具名字符上限。 */
  maxToolNameChars?: number;
  /** 公开 `commandId` 的字符上限。 */
  maxCommandIdChars?: number;
}

const DEFAULT_MAX_TEXT_CHARS = 200_000;
const DEFAULT_MAX_TOOL_NAME_CHARS = 128;

/** 必须带 `seq` 的持久事件（否则丢弃）。 */
const DURABLE_EVENTS: ReadonlySet<string> = new Set([
  "user/message",
  "assistant/message",
  "tool/call",
  "turn/end",
]);

// ---------------------------------------------------------------------------
// turn/end 终态文案与识别（全部是**固定常量**，绝不透传上游/插件的原文）
// ---------------------------------------------------------------------------

/** 通用失败：任何没有更具体证据的失败终态都用它。 */
export const TURN_FAILED_TEXT = "本轮执行失败";

/** 达到输出上限的固定文案：说明输出被截断、可能不完整、可重试，不含任何上游原文。 */
export const TURN_OUTPUT_LIMIT_TEXT = "本轮输出达到模型输出上限，回复可能不完整；请重试，或让管理员调高输出上限";

/**
 * `plugins/myrix-llm-gateway/src/wire.ts` 的 `mapResponsesTerminal` 逐字构造的
 * "上游响应未完成"原文；只有 `code === 'INVALID_RESPONSE'` **且** message 完全相等才识别。
 * `reason=max_output_tokens` 与线上的 `reason=length`（024c74c9）是同一形态的等价原因。
 *
 * 用精确集合而非子串/前缀：只有整串逐字命中才证明它来自已知安全构造方，任何
 * 前缀/后缀/夹带（密钥、prompt）都会落回通用文案，原文因此永不外泄。
 */
const RECOGNIZED_OUTPUT_LIMIT_MESSAGES: ReadonlySet<string> = new Set([
  "myrix-llm-gateway: 上游响应未完成（status=incomplete, reason=length）",
  "myrix-llm-gateway: 上游响应未完成（status=incomplete, reason=max_output_tokens）",
]);

/**
 * 其它已知、源码契约清晰的失败 code → 固定分类文案。只按 `code` 精确相等命中，
 * 输出永远是表里的常量（不回显 code 本身）；未列出的 code（含同码但 message 不是
 * 已知安全文本的 `INVALID_RESPONSE`）一律兜底为通用文案（fail-closed，不做猜测）。
 */
const RECOGNIZED_FAILURE_CODE_TEXTS: ReadonlyMap<string, string> = new Map([
  ["TRANSPORT", "模型上游连接中断，本轮未完成"],
  ["TIMEOUT", "模型上游长时间没有响应，本轮已中止"],
  ["UNSUPPORTED_CONTENT", "模型返回了网关无法表达的内容，本轮未完成"],
]);

/**
 * `blocked` 的固定文案：DSH 的某个 pre-step 钩子拒绝了这一轮
 * （`vendor/deepseek-harness/packages/core/agent-loop/src/agent.ts`：`turnEnds = { kind: 'blocked' }`）。
 * 它不是 `completed`，也不是"原因未知"；由于 rejection 可能发生在已有 step **之后**，
 * 文案只说"未完成"，不断言"未执行"。
 */
const TURN_BLOCKED_TEXT = "本轮被运行时策略拦截，未完成；请检查会话策略或联系管理员";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * 从 `ContentBlock[]` 里只取 `type:'text'` 的块并拼接。
 *
 * reasoning / image / file / tool-call 块一律跳过：推理内容与附件引用不是公开文本，
 * 工具调用的原始 arguments 也不进浏览器（只给工具名）。
 * 超过上限时截断而不是抛错：截断的文本配合 `turn/end` 的最终消息足以让 UI 自洽。
 */
export function textOfContent(content: unknown, maxChars: number): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  let total = 0;
  for (const block of content) {
    const record = asRecord(block);
    if (record === undefined || record["type"] !== "text") continue;
    const text = record["text"];
    if (typeof text !== "string") continue;
    const remaining = maxChars - total;
    if (remaining <= 0) break;
    parts.push(text.length > remaining ? text.slice(0, remaining) : text);
    total += text.length;
  }
  return parts.join("");
}

function bounded(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * 平台命令 id 的形状：与 HTTP 边界（`apps/bff/src/server.ts` 的 `uuid` schema）一致。
 *
 * 只放行这个形状而不是"任意非空字符串"：公开字段 `commandId` 在契约里就是
 * `POST /sessions/:id/messages` 的幂等键，前端用它把本机 pending 占位与持久事件
 * 对上；接受任意内部 id 会把 driver 的其它标识（例如 callId）也放进同一个字段。
 */
const COMMAND_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 单条投影命令 id 的字符上限（UUID 是 36；留出余量给未来形状，仍远小于任何正文）。 */
const DEFAULT_MAX_COMMAND_ID_CHARS = 128;

/**
 * 从 `user/message` 的 `data.id` 取公开 `commandId`。
 *
 * 形状或长度不合规一律**省略该字段**（而不是投影成别的值）：前端于是退化为
 * "没有可匹配的 commandId"，只会多显示一条本机占位，绝不把不认识的内部字符串公开。
 */
function publicCommandId(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars) return undefined;
  return COMMAND_ID_PATTERN.test(value) ? value : undefined;
}

function durable(event: string, seq: number | undefined): number | undefined {
  if (seq === undefined) return undefined;
  return DURABLE_EVENTS.has(event) ? seq : seq;
}

/**
 * `turn/end` 的失败文案：只输出本文件的**固定常量**，绝不回显 `reason` 中的任何字符。
 *
 * 识别顺序（全部精确相等）：`INVALID_RESPONSE` 且 message 命中
 * {@link RECOGNIZED_OUTPUT_LIMIT_MESSAGES} → 输出上限文案；`code` 命中
 * {@link RECOGNIZED_FAILURE_CODE_TEXTS} → 分类固定文案；其余 → {@link TURN_FAILED_TEXT}。
 */
function turnFailureText(reason: Record<string, unknown> | undefined): string {
  const error = asRecord(reason?.["error"]);
  if (error === undefined) return TURN_FAILED_TEXT;
  const code = error["code"];
  const message = error["message"];
  // 已知的"上游响应未完成"：code 与 message 必须同时精确命中（见常量表注释）。
  if (code === "INVALID_RESPONSE" && typeof message === "string" && RECOGNIZED_OUTPUT_LIMIT_MESSAGES.has(message)) {
    return TURN_OUTPUT_LIMIT_TEXT;
  }
  if (typeof code === "string") {
    const known = RECOGNIZED_FAILURE_CODE_TEXTS.get(code);
    if (known !== undefined) return known;
  }
  return TURN_FAILED_TEXT;
}

/**
 * 投影一帧。
 *
 * @returns 需要发给浏览器的事件；`undefined` = 该帧不在白名单内（合法跳过）。
 */
export function projectDriverFrame(
  frame: { id?: number; event: string; data: unknown; parseError?: boolean },
  options: ProjectionOptions = {},
): SessionStreamEvent | undefined {
  // JSON 解析失败的帧一律不投影：宁可少一条，也不把半个 JSON 当业务事件。
  if (frame.parseError === true) return undefined;
  const maxText = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
  const maxToolName = options.maxToolNameChars ?? DEFAULT_MAX_TOOL_NAME_CHARS;
  const maxCommandId = options.maxCommandIdChars ?? DEFAULT_MAX_COMMAND_ID_CHARS;
  const data = asRecord(frame.data) ?? undefined;
  const seq = frame.id;

  switch (frame.event) {
    case "user/message": {
      if (seq === undefined || data === undefined) return undefined;
      // `data.id` 就是平台 commandId（见文件头的映射说明）：只投影成既有公开字段，
      // 形状/长度不合规时省略，让前端退化为"无 commandId 可匹配"而不是暴露内部字符串。
      const commandId = publicCommandId(data["id"], maxCommandId);
      return {
        type: "user",
        seq,
        text: textOfContent(data["content"], maxText),
        ...(commandId === undefined ? {} : { commandId }),
      };
    }

    case "assistant/message": {
      if (seq === undefined || data === undefined) return undefined;
      const message = asRecord(data["message"]);
      if (message === undefined) return undefined;
      return { type: "assistant", seq, text: textOfContent(message["content"], maxText) };
    }

    case "tool/call": {
      if (seq === undefined || data === undefined) return undefined;
      const name = data["name"];
      const callId = data["callId"];
      if (typeof name !== "string") return undefined;
      return {
        type: "tool",
        seq,
        toolName: bounded(name, maxToolName),
        ...(typeof callId === "string" ? { commandId: bounded(callId, 128) } : {}),
      };
    }

    case "turn/end": {
      if (seq === undefined) return undefined;
      const reason = asRecord(data?.["reason"]);
      const kind = reason?.["kind"];
      // **只有** `completed` 是成功终态：未知/缺失 kind 不得推断为完成（fail-closed）。
      if (kind === "completed") return { type: "turn-end", seq };
      // 中断语义原样保留（被取消 / 崩溃后被补写 / fork 边界收口）。
      if (kind === "aborted" || kind === "interrupted" || kind === "forked") {
        return { type: "status", seq, status: "interrupted" };
      }
      // 已知但非完成的运行时 kind（证据见常量注释）：固定文案，仍然是失败终态。
      if (kind === "blocked") return { type: "error", seq, text: TURN_BLOCKED_TEXT };
      if (kind === "max-tokens") return { type: "error", seq, text: TURN_OUTPUT_LIMIT_TEXT };
      // 其余（`error` 显式失败、未知/缺失 kind）同样 fail-closed 成固定文案的 error。
      return { type: "error", seq, text: turnFailureText(reason) };
    }

    case "myrix/assistant-stream": {
      // 瞬态帧：没有 seq，不可当作持久事件（断线不补）。
      if (data === undefined) return undefined;
      const kind = data["type"];
      if (kind === "start") return { type: "status", status: "stream-start" };
      if (kind === "end") {
        // 只有"这条流被丢弃"才明确告知前端清掉未提交 delta。
        // `committed` 的落定正文由持久 assistant/message 承载，这里**不**合成 assistant.final。
        const outcome = asRecord(data["outcome"]);
        return outcome?.["kind"] === "abandoned" ? { type: "status", status: "stream-abandoned" } : undefined;
      }
      if (kind !== "chunk") return undefined;
      const chunk = asRecord(data["chunk"]);
      if (chunk === undefined) return undefined;
      // 只投影可见文本增量；reasoning-delta / tool-call-delta / block-* / usage / finish 一律跳过。
      if (chunk["type"] !== "text-delta") return undefined;
      const text = chunk["text"];
      if (typeof text !== "string" || text.length === 0) return undefined;
      return { type: "delta", text: bounded(text, maxText) };
    }

    case "myrix/truncated": {
      // 缓冲已丢：显式告知不连续。不带 seq（否则客户端会跳过 availableFrom 那条事件）。
      return { type: "status", status: "replay-required" };
    }

    default:
      return undefined;
  }
}

export { durable };
