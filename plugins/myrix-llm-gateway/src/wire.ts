/**
 * OpenAI **Responses** 线协议转换：请求编码、SSE 解析、chunk 翻译、usage 映射。
 *
 * 这里是本插件唯一懂 OpenAI 协议的地方；它**不**做任何身份判断，也不读
 * `principals`（见 `adapter.ts`）。协议是 `POST /v1/responses`（**不是**
 * `chat/completions`），并且**永远**是无状态的完整历史：
 *
 * 1. **不丢内容**：图片/文件块不会被悄悄降级成文本或直接丢弃。本适配器是
 *    纯文本路由，遇到它们直接以 `UNSUPPORTED_CONTENT` 失败（DSH 已按
 *    `inputModalities: ['text']` 把它们投影成占位文本，所以正常链路只看到文本）。
 * 2. **不猜 usage**：上游没有给 `usage` 就不产生 usage chunk；DSH 的
 *    `token-meter` 与网关的结算都只认真实计量。
 * 3. **无状态**：从不发送 `previous_response_id` / `conversation` / `background`，
 *    `store` 恒为 `false`；每轮都把完整历史重新编码进 `input`。
 * 4. **终态显式**：只有 `response.completed`（status=completed）才算成功；
 *    `incomplete`/`failed`/`error`/EOF 都有明确的失败分类，绝不把「流断了」
 *    当成「正常结束」。
 * 5. **错误不泄密**：所有经手上游文本的错误信息都会先做令牌遮蔽。
 *
 * @module @myrix/llm-gateway/wire
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  FinishReason,
  RequestMessage,
  StreamChunk,
  TokenUsage,
  ToolCallId,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { ResolvedGatewayConfig } from './config.ts'

// ---------------------------------------------------------------------------
// 错误分类与遮蔽
// ---------------------------------------------------------------------------

/** 网关/上游拒绝时可能夹带令牌；任何外发文本都先过这一层。 */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret.length < 8) continue
    out = out.split(secret).join('[REDACTED]')
  }
  return out
}

/** 只截取有限长度的可读片段；上游正文可能很大，也不该整段进错误信息。 */
export function snippet(text: string, max = 300): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`
}

/**
 * 从 OpenAI 兼容**嵌套**错误体里取出 `error.code/type/message`，并丢掉其余字段。
 * HTTP 错误路径（`{ "error": { ... } }`）用它。
 * @param body - 已解析的响应体（未知形状）。
 * @returns 可读的错误字段；无法解析时为空对象。
 */
export function upstreamErrorFields(body: unknown): { code?: string; message?: string; type?: string } {
  if (typeof body !== 'object' || body === null) return {}
  const error = (body as { error?: unknown }).error
  if (typeof error !== 'object' || error === null) return {}
  const fields = error as { message?: unknown; code?: unknown; type?: unknown }
  return {
    ...typeof fields.code === 'string' ? { code: fields.code } : {},
    ...typeof fields.type === 'string' ? { type: fields.type } : {},
    ...typeof fields.message === 'string' ? { message: fields.message } : {},
  }
}

/**
 * 从 Responses 流内错误事件里取出 `code`/`message`。
 *
 * Responses 的 `error` 事件是**扁平**的（`{type:'error', code, message}`），
 * 而 `response.failed` 把错误放在 `response.error` 下；两种形状都要认。
 * @param body - 已解析的事件 JSON。
 * @returns 可读的错误字段；无法解析时为空对象。
 */
export function responsesErrorFields(body: unknown): { code?: string; message?: string } {
  if (typeof body !== 'object' || body === null) return {}
  const source = body as Record<string, unknown>
  const nested = upstreamErrorFields(source)
  const candidate = typeof source.error === 'object' && source.error !== null
    ? source.error as Record<string, unknown>
    : source
  const code = typeof candidate.code === 'string' ? candidate.code : nested.code
  const message = typeof candidate.message === 'string' ? candidate.message : nested.message
  return {
    ...code === undefined ? {} : { code },
    ...message === undefined ? {} : { message },
  }
}

/**
 * 上游流内错误码 → DSH 失败分类。
 *
 * 撤权是**认证**问题（不可重试），额度与限速的重试语义不同，不能合并。
 * @param code - 上游错误码（大小写不敏感）。
 * @returns DSH 稳定失败码。
 */
export function classifyUpstreamCode(code: string | undefined): string {
  const normalized = (code ?? '').toLowerCase()
  if (normalized.includes('session_revoked')
    || normalized.includes('not_authorized')
    || normalized.includes('unauthorized')
    || normalized.includes('authentication')
    || normalized.includes('invalid_api_key')) return 'AUTH'
  if (normalized.includes('insufficient_quota') || normalized.includes('quota')) return 'QUOTA'
  if (normalized.includes('rate_limit') || normalized.includes('rate_limited')) return 'RATE_LIMIT'
  if (normalized.includes('content_filter') || normalized.includes('content_policy')) return 'CONTENT_FILTER'
  if (normalized.includes('timeout') || normalized.includes('timed_out')) return 'TIMEOUT'
  return 'SERVER'
}

/**
 * 把 HTTP 状态码映射成 DSH 的失败分类。
 *
 * 429 只有在错误文本明确是"额度耗尽"时才算 `QUOTA`；单纯的速率限制是
 * `RATE_LIMIT`（可重试）。两者的重试语义不同，不能合并。
 * @param status - 上游 HTTP 状态码。
 * @param message - 已遮蔽的上游错误文本。
 * @returns DSH 稳定失败码。
 */
export function classifyStatus(status: number, message: string): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) {
    return /\binsufficient[\s_-]+(?:quota|balance|credits?)\b|\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i.test(message)
      ? 'QUOTA'
      : 'RATE_LIMIT'
  }
  if (status === 400 || status === 404 || status === 405 || status === 413 || status === 422) return 'INVALID_REQUEST'
  if (status === 408 || status === 504) return 'TIMEOUT'
  if (status >= 500) return 'SERVER'
  return 'UNKNOWN'
}

/** 构造一个带稳定码与可序列化 failure 的 LLM 错误（DSH 会据此分类重试）。 */
export function gatewayFailure(message: string, code: string, status?: number): LlmError {
  return new LlmError(message, code, status === undefined ? undefined : { status })
}

// ---------------------------------------------------------------------------
// 请求编码（OpenAI Responses）
// ---------------------------------------------------------------------------

/** Responses 消息里的文本部件；用户/系统/开发者用 `input_text`，助手用 `output_text`。 */
export interface ResponsesTextPart {
  type: 'input_text' | 'output_text'
  text: string
}

/** 一条角色消息（`input` 数组元素，省略 `type` 即为 message）。 */
export interface ResponsesMessageItem {
  role: 'system' | 'developer' | 'user' | 'assistant'
  content: ResponsesTextPart[]
}

/** 模型请求的一次函数调用（历史回放）。 */
export interface ResponsesFunctionCallItem {
  type: 'function_call'
  /** 与 `function_call_output` 关联的调用 id（DSH 的 `ToolCallId`）。 */
  call_id: string
  name: string
  /** 原始 JSON 字符串，不做解析/重排。 */
  arguments: string
}

/** 一次函数调用结果（历史回放）。 */
export interface ResponsesFunctionCallOutputItem {
  type: 'function_call_output'
  call_id: string
  output: string
}

/** `input` 数组元素。 */
export type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem

/** Responses 的 function 工具声明（**扁平**，没有嵌套的 `function`）。 */
export interface ResponsesTool {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
  strict?: boolean
}

/** 发给模型网关的 Responses 请求体（字段白名单）。 */
export interface ResponsesRequest {
  model: string
  input: ResponsesInputItem[]
  instructions?: string
  tools?: ResponsesTool[]
  max_output_tokens?: number
  stream: boolean
  /** 恒为 `false`：Cell 侧不留服务端状态，也不做 `previous_response_id` 续接。 */
  store: false
}

/** 解析转发给网关的上游模型名（别名优先，未列出的同名转发）。 */
export function upstreamModelName(cfg: ResolvedGatewayConfig, model: string): string {
  return cfg.modelAliases[model] ?? model
}

/** 把文本块拼成一段文本。 */
function textOf(blocks: readonly ContentBlock[]): string {
  let text = ''
  for (const block of blocks) {
    if (block.type === 'text') text += block.text
  }
  return text
}

/** 本适配器是纯文本路由：任何非文本块都显式失败，绝不静默丢内容。 */
function assertTextOnly(blocks: readonly ContentBlock[], where: string): void {
  for (const block of blocks) {
    if (block.type === 'text') continue
    throw new LlmError(
      `myrix-llm-gateway: ${where} 含有 ${block.type} 内容，本适配器只支持纯文本模型调用`
      + '（模型网关不接受图片/音频输入；DSH 会把文本模型的图片投影成占位文本）',
      'UNSUPPORTED_CONTENT',
    )
  }
}

/**
 * 开发者消息在 DSH 里承载工具增删；本适配器始终发送完整工具表，
 * 因此只保留其中的**文本指令**，忽略 `tool-addition`/`tool-removal` 记录。
 */
function developerText(blocks: readonly ContentBlock[]): string | undefined {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.length > 0) parts.push(block.text)
    } else if (block.type !== 'tool-addition' && block.type !== 'tool-removal') {
      throw new LlmError(
        `myrix-llm-gateway: developer 消息含有不支持的 ${block.type} 内容`,
        'UNSUPPORTED_CONTENT',
      )
    }
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

/** 一条角色消息 → 一个或多个 `input` 元素。 */
function encodeMessage(message: RequestMessage): ResponsesInputItem[] {
  switch (message.role) {
    case 'system': {
      assertTextOnly(message.content, 'system 消息')
      const text = textOf(message.content)
      return text.length === 0
        ? []
        : [{ role: 'system', content: [{ type: 'input_text', text }] }]
    }
    case 'developer': {
      const text = developerText(message.content)
      // 角色的指令语义被保留（developer 仍是 developer），不是被折进 system/instructions。
      return text === undefined ? [] : [{ role: 'developer', content: [{ type: 'input_text', text }] }]
    }
    case 'user': {
      assertTextOnly(message.content, 'user 消息')
      const text = textOf(message.content)
      return text.length === 0
        ? []
        : [{ role: 'user', content: [{ type: 'input_text', text }] }]
    }
    case 'assistant': {
      const callBlocks = message.content.filter(block => block.type === 'tool-call')
      // 推理块**不回放**：无状态 Responses 需要 reasoning item 的 `encrypted_content`
      // 与 item id 才能续接，而本适配器刻意不保存服务端/客户端推理状态。
      assertTextOnly(
        message.content.filter(block => block.type !== 'tool-call' && block.type !== 'reasoning'),
        'assistant 消息',
      )
      const items: ResponsesInputItem[] = []
      const text = textOf(message.content)
      if (text.length > 0) {
        items.push({ role: 'assistant', content: [{ type: 'output_text', text }] })
      }
      for (const block of callBlocks) {
        if (block.type !== 'tool-call') continue
        items.push({
          type: 'function_call',
          call_id: String(block.id),
          name: block.name,
          arguments: block.arguments,
        })
      }
      return items
    }
    case 'tool': {
      assertTextOnly(message.content, 'tool 结果')
      return [{
        type: 'function_call_output',
        call_id: String(message.toolCallId),
        output: textOf(message.content),
      }]
    }
    default:
      // `MessageRoleMap` 是闭合的；走到这里说明 DSH 加了新角色而本插件未跟进。
      throw new LlmError('myrix-llm-gateway: 不支持的消息角色', 'UNSUPPORTED_CONTENT')
  }
}

/** 入参：DSH 请求里可转换的字段（归属由 `adapter.ts` 提供，不在这里）。 */
export interface EncodeInput {
  readonly messages: readonly RequestMessage[]
  /** 一次性调用的系统提示；映射到 Responses 的顶层 `instructions`。 */
  readonly system?: string
  readonly tools?: readonly ToolSchema[]
  readonly maxTokens?: number
  readonly stream: boolean
}

/**
 * 编码一次 Responses 请求。
 *
 * 注意两个**协议事实**（与旧 chat/completions 适配器的差异）：
 * * Responses 没有 `stop` 字段，`temperature` 也不在本适配器的白名单里；
 *   两者都不发送（调用方设置不会改变线协议）。
 * * 工具声明是**扁平**的 `{type:'function',name,description,parameters,strict?}`。
 *
 * @param cfg - 已解析的插件配置。
 * @param model - 转发给网关的模型名（已做别名）。
 * @param input - DSH 请求的可转换字段。
 * @returns Responses 请求体。
 * @throws 当没有任何可发送内容、或含非文本内容时。
 */
export function encodeRequest(cfg: ResolvedGatewayConfig, model: string, input: EncodeInput): ResponsesRequest {
  const items: ResponsesInputItem[] = []
  for (const message of input.messages) {
    for (const item of encodeMessage(message)) items.push(item)
  }
  if (items.length === 0) {
    throw new LlmError('myrix-llm-gateway: 请求没有任何可发送的消息', 'INVALID_REQUEST')
  }

  const maxTokens = input.maxTokens ?? cfg.defaultMaxTokens
  const instructions = input.system === undefined || input.system.length === 0 ? undefined : input.system
  return {
    model,
    input: items,
    ...instructions === undefined ? {} : { instructions },
    ...input.tools === undefined || input.tools.length === 0 ? {} : {
      tools: input.tools.map((tool): ResponsesTool => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        ...cfg.toolStrict === true ? { strict: true } : {},
      })),
    },
    ...maxTokens === undefined ? {} : { max_output_tokens: maxTokens },
    stream: input.stream,
    store: false,
  }
}

// ---------------------------------------------------------------------------
// SSE 解析
// ---------------------------------------------------------------------------

/** 一条已解码的 SSE 事件。 */
export interface SseEvent {
  readonly event?: string
  readonly data?: string
}

/** 解析 SSE 字节流；容忍 CRLF 与不完整的尾块。 */
export async function* parseSse(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true })
    let boundary = findBoundary(buffer)
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary.index)
      buffer = buffer.slice(boundary.index + boundary.length)
      const event = parseBlock(block)
      if (event !== undefined) yield event
      boundary = findBoundary(buffer)
    }
  }
  buffer += decoder.decode()
  const tail = parseBlock(buffer)
  if (tail !== undefined) yield tail
}

/** 有界读取选项：字节上限 + 空闲看门狗。 */
export interface BoundedReadOptions {
  /** 响应体字节上限；超过即以 `TRANSPORT` 失败并取消读取。 */
  readonly maxBytes: number
  /** 两次读到数据之间的最长间隔（毫秒）；`<= 0` 关闭看门狗。 */
  readonly idleTimeoutMs: number
}

/**
 * 有界读取一个 HTTP 响应体。
 *
 * 三个边界都在这里，且**任何**提前退出都会 `reader.cancel()`，让上游 socket
 * 立即关闭而不是留在后台：
 * 1. **字节上限**：累计超过 `maxBytes` 立即失败（不无限缓冲）；
 * 2. **空闲看门狗**：`read()` 与超时竞速，超时产生 `TIMEOUT`；
 * 3. **取消/断开**：消费方提前 `return()`（abort、协议错误、字节超限）时在
 *    `finally` 里取消 reader。
 * @param body - 上游响应体。
 * @param options - 字节上限与空闲超时。
 * @returns 原始字节块。
 * @throws `TIMEOUT`（空闲）或 `TRANSPORT`（字节超限）。
 */
export async function* readBounded(
  body: ReadableStream<Uint8Array>,
  options: BoundedReadOptions,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  let bytes = 0
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let idleReject: ((error: LlmError) => void) | undefined
  let idle: Promise<never> | undefined
  const clearIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = undefined
    idleReject = undefined
    idle = undefined
  }
  const armIdle = (): void => {
    if (options.idleTimeoutMs <= 0) return
    clearIdle()
    idle = new Promise<never>((_resolve, reject) => {
      idleReject = reject
    })
    // 竞速可能已经由 read() 结算，这个 rejection 不能逃逸成 unhandled。
    idle.catch(() => { /* 由下面的 race 负责 */ })
    idleTimer = setTimeout(() => {
      idleReject?.(gatewayFailure(
        `myrix-llm-gateway: 模型网关在 ${String(options.idleTimeoutMs)}ms 内没有发送任何流数据`,
        'TIMEOUT',
      ))
    }, options.idleTimeoutMs)
  }
  try {
    armIdle()
    while (true) {
      const read = reader.read()
      const result = idle === undefined ? await read : await Promise.race([read, idle])
      if (result.done === true) break
      armIdle()
      bytes += result.value.byteLength
      if (bytes > options.maxBytes) {
        throw gatewayFailure(
          'myrix-llm-gateway: 上游响应体超过配置的字节上限，已中止读取',
          'TRANSPORT',
        )
      }
      yield result.value
    }
  } finally {
    clearIdle()
    try {
      await reader.cancel()
    } catch (_alreadyClosedOrBroken) {
      // reader 已经因断流/错误关闭；取消失败不改变已经决定的结果。
    }
    reader.releaseLock()
  }
}

/**
 * 有界读取 SSE 事件流（字节上限 + 空闲看门狗 + 取消）。
 * @param body - 上游响应体。
 * @param options - 字节上限与空闲超时。
 * @returns 已解码的 SSE 事件。
 */
export function parseSseBounded(
  body: ReadableStream<Uint8Array>,
  options: BoundedReadOptions,
): AsyncGenerator<SseEvent> {
  return parseSse(readBounded(body, options))
}

function findBoundary(buffer: string): { index: number; length: number } | -1 {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf === -1 && crlf === -1) return -1
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 }
  return { index: lf, length: 2 }
}

function parseBlock(block: string): SseEvent | undefined {
  const trimmed = block.trim()
  if (trimmed.length === 0) return undefined
  let event: string | undefined
  const dataLines: string[] = []
  for (const rawLine of trimmed.split(/\r?\n/)) {
    if (rawLine.startsWith(':')) continue
    const separator = rawLine.indexOf(':')
    const field = separator === -1 ? rawLine : rawLine.slice(0, separator)
    const value = separator === -1 ? '' : rawLine.slice(separator + 1).replace(/^ /, '')
    if (field === 'event') event = value
    else if (field === 'data') dataLines.push(value)
  }
  if (event === undefined && dataLines.length === 0) return undefined
  return {
    ...event === undefined ? {} : { event },
    ...dataLines.length === 0 ? {} : { data: dataLines.join('\n') },
  }
}

// ---------------------------------------------------------------------------
// usage 与终态映射
// ---------------------------------------------------------------------------

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function nested(value: unknown, outer: string, inner: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  const container = (value as Record<string, unknown>)[outer]
  if (typeof container !== 'object' || container === null) return undefined
  return (container as Record<string, unknown>)[inner]
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** `output_index` 一类的非负安全整数；其他值（含 `null`/字符串）一律当作缺失。 */
function asIndex(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * 把 Responses `usage` 映射成 DSH 的 {@link TokenUsage}。
 *
 * DSH 的口径是**互斥计数**：`inputTokens` 只算未命中缓存的输入，缓存命中
 * 单独放在 `cacheReadTokens`。Responses 的 `input_tokens` 是含缓存的合计，
 * 因此这里减掉 `input_tokens_details.cached_tokens`（以及可选的
 * `cache_write_tokens`）；`output_tokens` 是输出合计，`reasoning_tokens`
 * 是其明细，单独上报而不是从 output 里减掉（DSH 的 reasoning 是子集口径）。
 * @param raw - 上游 `usage` 字段。
 * @returns 规范化用量；`input_tokens`/`output_tokens` 缺失或非法时返回
 *   `undefined`（= 用量未知，不猜）。
 */
export function mapUsage(raw: unknown): TokenUsage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const source = raw as Record<string, unknown>
  const input = count(source.input_tokens)
  const output = count(source.output_tokens)
  if (input === undefined || output === undefined) return undefined
  const total = count(source.total_tokens)
  const cached = count(nested(raw, 'input_tokens_details', 'cached_tokens'))
  const cacheWrite = count(nested(raw, 'input_tokens_details', 'cache_write_tokens'))
  const reasoning = count(nested(raw, 'output_tokens_details', 'reasoning_tokens'))
  return {
    inputTokens: Math.max(0, input - (cached ?? 0) - (cacheWrite ?? 0)),
    outputTokens: output,
    ...total === undefined ? {} : { totalTokens: total },
    ...cached === undefined || cached === 0 ? {} : { cacheReadTokens: cached },
    ...cacheWrite === undefined || cacheWrite === 0 ? {} : { cacheWriteTokens: cacheWrite },
    ...reasoning === undefined || reasoning === 0 ? {} : { reasoningTokens: reasoning },
  }
}

/** Responses 终态 `status` + `incomplete_details.reason` → DSH 终态。 */
export interface ResponsesTerminal {
  readonly status?: string
  readonly incompleteReason?: string
}

/**
 * 把 Responses 终态映射成 DSH 的 {@link FinishReason}。
 *
 * 只有 `completed` 是成功；`incomplete` 只有 `max_output_tokens` 映射成
 * `max-tokens`，其余原因一律是显式失败（不假装正常结束）。
 * @param terminal - 终态 status 与 incomplete 原因。
 * @param hasToolCalls - 本次响应是否产出了工具调用（决定 `stop` 还是 `tool-calls`）。
 * @returns DSH 终态。
 */
export function mapResponsesTerminal(terminal: ResponsesTerminal, hasToolCalls: boolean): FinishReason {
  switch (terminal.status) {
    case 'completed':
      return hasToolCalls ? { kind: 'tool-calls' } : { kind: 'stop' }
    case 'incomplete':
      if (terminal.incompleteReason === 'max_output_tokens') return { kind: 'max-tokens' }
      return {
        kind: 'error',
        failure: {
          message: 'myrix-llm-gateway: 上游响应未完成（status=incomplete'
            + `${terminal.incompleteReason === undefined ? '' : `, reason=${terminal.incompleteReason}`}）`,
          code: 'INVALID_RESPONSE',
        },
      }
    case undefined:
      return {
        kind: 'error',
        failure: { message: 'myrix-llm-gateway: 上游终态响应没有 status', code: 'INVALID_RESPONSE' },
      }
    default:
      return {
        kind: 'error',
        failure: {
          message: `myrix-llm-gateway: 上游响应以 status=${terminal.status} 结束`,
          code: 'INVALID_RESPONSE',
        },
      }
  }
}

// ---------------------------------------------------------------------------
// 流式 chunk 翻译（Responses SSE）
// ---------------------------------------------------------------------------

type SlotKind = 'text' | 'reasoning' | 'tool-call'

/** 一个正在累积的输出块。 */
interface Slot {
  readonly kind: SlotKind
  readonly index: number
  /** Responses 的 item id（`msg_*`/`fc_*`/`rs_*`），用于交叉校验。 */
  itemId?: string
  /** 函数调用的 `call_id`（= DSH 的 `ToolCallId`）。 */
  callId?: string
  name?: string
  /** 已经**发出去**的文本（text/reasoning）。 */
  text: string
  /** 已经**发出去**的参数文本（tool-call）。 */
  streamedArgs: string
  /** 从 delta 累积的参数文本（没有权威载荷时用于收尾）。 */
  bufferedArgs: string
  /** 最近一次权威参数载荷（`function_call_arguments.done` / `output_item.done`）。 */
  authoritativeArgs?: string
  closed: boolean
}

/** 计算「权威载荷」相对「已发出内容」的增量；不是前缀时返回 undefined（宁可不发也不重复）。 */
function suffixOf(streamed: string, authoritative: string): string | undefined {
  if (!authoritative.startsWith(streamed)) return undefined
  const suffix = authoritative.slice(streamed.length)
  return suffix.length === 0 ? undefined : suffix
}

/**
 * 把 Responses SSE 事件序列翻译成 DSH 的 {@link StreamChunk}。
 *
 * 三条协议约束决定了这里的形状：
 *
 * 1. **块索引按首次出现顺序分配**（0,1,2,…）。相关性以事件的
 *    `output_index` 为准（缺失时退回 `item_id`），并用两处 id 交叉校验，
 *    因此两个并发的 `function_call` 分片不会串台。
 * 2. **`usage` 必须早于终态 `finish`**，且只发一次；`block-end` 也必须早于
 *    `finish`。终态事件（`response.completed`/`incomplete`/`failed`/`error`）
 *    到达时统一收尾。
 * 3. **重复载荷不重复发**：`function_call_arguments.done` 与
 *    `output_item.done` 会重复完整参数/文本，这里只在它**严格延长**已发出内容时
 *    补发差额；权威的完整值只通过一次 `block-end` 给出。
 *
 * 这个类是**有状态且单次使用**的：一个上游响应一个实例。
 */
export class StreamTranslator {
  private readonly byKey = new Map<string, Slot>()
  private readonly byItemId = new Map<string, Slot>()
  private nextIndex = 0
  private terminalSeen = false
  private usageEmitted = false

  /**
   * 翻译一个上游 SSE 事件。
   * @param raw - 已解析的事件 JSON。
   * @param eventName - SSE `event:` 字段（`data` 里没有 `type` 时用它）。
   * @returns 有序的 DSH chunk（可能为空）。
   * @throws `INVALID_RESPONSE` 当事件不是对象、协议字段矛盾、或出现无法表达的输出类型时。
   */
  push(raw: unknown, eventName?: string): StreamChunk[] {
    const event = asRecord(raw)
    if (event === undefined) {
      throw gatewayFailure('myrix-llm-gateway: 上游流返回了非对象的事件', 'INVALID_RESPONSE')
    }
    // 终态之后一律忽略：DSH 不允许 finish 之后还有 chunk。
    if (this.terminalSeen) return []
    const type = asString(event.type) ?? eventName
    if (type === undefined) {
      throw gatewayFailure('myrix-llm-gateway: 上游流事件既没有 type 也没有 SSE event 名', 'INVALID_RESPONSE')
    }

    switch (type) {
      case 'response.output_item.added':
        return this.onItemAdded(event)
      case 'response.output_text.delta':
      case 'response.refusal.delta':
        return this.onTextDelta(event, type)
      case 'response.output_text.done':
      case 'response.refusal.done':
        return this.onTextDone(event, type)
      case 'response.function_call_arguments.delta':
        return this.onArgumentsDelta(event)
      case 'response.function_call_arguments.done':
        return this.onArgumentsDone(event)
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        return this.onReasoningDelta(event)
      case 'response.reasoning_summary_part.done':
        return this.onReasoningPartDone(event)
      case 'response.output_item.done':
        return this.onItemDone(event)
      case 'response.completed':
      case 'response.incomplete':
        return this.onTerminal(event)
      case 'response.failed':
        return this.onFailed(event)
      case 'error':
        return this.onErrorEvent(event)
      default:
        // Responses 有大量信息性事件（created/in_progress/content_part.*/annotation.* …）：
        // 它们不携带用户可见内容，忽略是安全的。
        return []
    }
  }

  /**
   * 上游流结束（收到 `[DONE]` 或 EOF）。
   * @returns 未收尾的 `block-end`；若从未收到终态事件，追加一个 `TRANSPORT` 失败
   *   finish（"流断了"绝不等于"正常结束"）。
   */
  finishStream(): StreamChunk[] {
    if (this.terminalSeen) return []
    const out = [...this.closeBlocks()]
    out.push({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: 'myrix-llm-gateway: 上游流在给出终态响应事件（response.completed）之前结束',
          code: 'TRANSPORT',
        },
      },
    })
    this.terminalSeen = true
    return out
  }

  /** 是否已经发出终态 finish（诊断用）。 */
  get finished(): boolean {
    return this.terminalSeen
  }

  // -- 事件处理 ------------------------------------------------------------

  private onItemAdded(event: Record<string, unknown>): StreamChunk[] {
    const item = asRecord(event.item)
    if (item === undefined) {
      throw gatewayFailure('myrix-llm-gateway: response.output_item.added 缺少 item 对象', 'INVALID_RESPONSE')
    }
    const kind = asString(item.type)
    const out: StreamChunk[] = []
    switch (kind) {
      case 'message': {
        const { start } = this.ensureSlot('text', event, asString(item.id))
        if (start !== undefined) out.push(start)
        return out
      }
      case 'reasoning': {
        const { start } = this.ensureSlot('reasoning', event, asString(item.id))
        if (start !== undefined) out.push(start)
        return out
      }
      case 'function_call': {
        const callId = asString(item.call_id)
        if (callId === undefined || callId.length === 0) {
          throw gatewayFailure('myrix-llm-gateway: function_call 项缺少 call_id', 'INVALID_RESPONSE')
        }
        const name = asString(item.name)
        if (name === undefined || name.length === 0) {
          throw gatewayFailure('myrix-llm-gateway: function_call 项缺少 name', 'INVALID_RESPONSE')
        }
        const args = asString(item.arguments) ?? ''
        const { slot, start } = this.ensureSlot('tool-call', event, asString(item.id))
        slot.callId = callId
        slot.name = name
        if (start !== undefined) out.push(start)
        if (args.length > 0) {
          slot.streamedArgs += args
          slot.bufferedArgs += args
          out.push(this.toolCallDelta(slot, args))
        }
        return out
      }
      default:
        throw gatewayFailure(
          `myrix-llm-gateway: 上游返回了本适配器无法表达的输出类型 "${kind ?? 'unknown'}"`,
          'UNSUPPORTED_CONTENT',
        )
    }
  }

  /**
   * 文本与拒答增量都映射成 `text-delta`。
   *
   * Responses 把"模型安全拒答"放在 `response.refusal.delta` 上；DSH 的
   * `ContentBlockMap` 没有 refusal 块类型，且拒答文本对用户是**可见内容**
   * （不是错误），因此按可见文本呈现，而不是丢弃或升级成失败。
   */
  private onTextDelta(event: Record<string, unknown>, _type: string): StreamChunk[] {
    const delta = asString(event.delta)
    if (delta === undefined || delta.length === 0) return []
    const slot = this.ensureSlot('text', event, asString(event.item_id)).slot
    slot.text += delta
    return [{ type: 'text-delta', index: slot.index, text: delta }]
  }

  private onTextDone(event: Record<string, unknown>, type: string): StreamChunk[] {
    const authoritative = asString(type === 'response.refusal.done' ? event.refusal : event.text)
    if (authoritative === undefined || authoritative.length === 0) return []
    const slot = this.ensureSlot('text', event, asString(event.item_id)).slot
    const suffix = suffixOf(slot.text, authoritative)
    slot.text = authoritative.startsWith(slot.text) || slot.text.length === 0 ? authoritative : slot.text
    if (suffix === undefined) return []
    return [{ type: 'text-delta', index: slot.index, text: suffix }]
  }

  private onReasoningDelta(event: Record<string, unknown>): StreamChunk[] {
    const delta = asString(event.delta)
    if (delta === undefined || delta.length === 0) return []
    const slot = this.ensureSlot('reasoning', event, asString(event.item_id)).slot
    slot.text += delta
    return [{ type: 'reasoning-delta', index: slot.index, text: delta }]
  }

  private onReasoningPartDone(event: Record<string, unknown>): StreamChunk[] {
    // 摘要分片之间的分隔符：只在已经开过 reasoning 块时补一个空行。
    const slot = this.findSlot(event, asString(event.item_id))
    if (slot === undefined || slot.kind !== 'reasoning') return []
    slot.text += '\n\n'
    return [{ type: 'reasoning-delta', index: slot.index, text: '\n\n' }]
  }

  private onArgumentsDelta(event: Record<string, unknown>): StreamChunk[] {
    const delta = asString(event.delta)
    if (delta === undefined || delta.length === 0) return []
    const slot = this.ensureSlot('tool-call', event, asString(event.item_id)).slot
    slot.bufferedArgs += delta
    if (slot.callId === undefined || slot.callId.length === 0) return []
    slot.streamedArgs += delta
    return [this.toolCallDelta(slot, delta)]
  }

  private onArgumentsDone(event: Record<string, unknown>): StreamChunk[] {
    const authoritative = asString(event.arguments)
    if (authoritative === undefined) return []
    const slot = this.ensureSlot('tool-call', event, asString(event.item_id)).slot
    slot.authoritativeArgs = authoritative
    return this.streamAuthoritativeArgs(slot, authoritative)
  }

  private onItemDone(event: Record<string, unknown>): StreamChunk[] {
    const item = asRecord(event.item)
    if (item === undefined) {
      throw gatewayFailure('myrix-llm-gateway: response.output_item.done 缺少 item 对象', 'INVALID_RESPONSE')
    }
    const kind = asString(item.type)
    const out: StreamChunk[] = []
    switch (kind) {
      case 'message': {
        const slot = this.ensureSlot('text', event, asString(item.id)).slot
        const authoritative = this.messageText(item)
        if (authoritative.length > 0) {
          const suffix = suffixOf(slot.text, authoritative)
          if (suffix !== undefined) out.push({ type: 'text-delta', index: slot.index, text: suffix })
          slot.text = authoritative
        }
        out.push(this.closeSlot(slot))
        return out
      }
      case 'reasoning': {
        const slot = this.ensureSlot('reasoning', event, asString(item.id)).slot
        const authoritative = this.reasoningText(item)
        if (authoritative.length > 0) {
          const suffix = suffixOf(slot.text, authoritative)
          if (suffix !== undefined) out.push({ type: 'reasoning-delta', index: slot.index, text: suffix })
          slot.text = authoritative
        }
        out.push(this.closeSlot(slot))
        return out
      }
      case 'function_call': {
        const slot = this.ensureSlot('tool-call', event, asString(item.id)).slot
        const callId = asString(item.call_id)
        const name = asString(item.name)
        if (callId !== undefined && callId.length > 0) slot.callId = callId
        if (name !== undefined && name.length > 0) slot.name = name
        if (slot.callId === undefined || slot.name === undefined) {
          throw gatewayFailure('myrix-llm-gateway: function_call 收尾时缺少 call_id 或 name', 'INVALID_RESPONSE')
        }
        const authoritative = asString(item.arguments) ?? slot.authoritativeArgs ?? slot.bufferedArgs
        slot.authoritativeArgs = authoritative
        out.push(...this.streamAuthoritativeArgs(slot, authoritative))
        out.push(this.closeSlot(slot))
        return out
      }
      default:
        throw gatewayFailure(
          `myrix-llm-gateway: 上游返回了本适配器无法表达的输出类型 "${kind ?? 'unknown'}"`,
          'UNSUPPORTED_CONTENT',
        )
    }
  }

  private onTerminal(event: Record<string, unknown>): StreamChunk[] {
    const response = asRecord(event.response)
    if (response === undefined) {
      throw gatewayFailure('myrix-llm-gateway: 终态事件缺少 response 对象', 'INVALID_RESPONSE')
    }
    const incomplete = asRecord(response.incomplete_details)
    const terminal: ResponsesTerminal = {
      status: asString(response.status),
      ...asString(incomplete?.reason) === undefined ? {} : { incompleteReason: asString(incomplete?.reason)! },
    }
    const out = [...this.closeBlocks()]
    const usage = mapUsage(response.usage)
    if (usage !== undefined) out.push(...this.emitUsage(usage))
    out.push({
      type: 'finish',
      reason: mapResponsesTerminal(terminal, this.hasToolCalls()),
    })
    this.terminalSeen = true
    return out
  }

  private onFailed(event: Record<string, unknown>): StreamChunk[] {
    const response = asRecord(event.response) ?? {}
    const fields = responsesErrorFields({ error: response.error })
    const detail = fields.code === undefined ? '' : `（code=${fields.code}）`
    const out = [...this.closeBlocks()]
    out.push({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: 'myrix-llm-gateway: 上游响应失败'
            + `${detail}：${snippet(fields.message ?? '未给出原因')}`,
          code: classifyUpstreamCode(fields.code),
        },
      },
    })
    this.terminalSeen = true
    return out
  }

  private onErrorEvent(event: Record<string, unknown>): StreamChunk[] {
    const fields = responsesErrorFields(event)
    const detail = fields.code === undefined ? '' : `（code=${fields.code}）`
    const out = [...this.closeBlocks()]
    out.push({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: 'myrix-llm-gateway: 模型网关在流中报错'
            + `${detail}：${snippet(fields.message ?? '未给出原因')}`,
          code: classifyUpstreamCode(fields.code),
        },
      },
    })
    this.terminalSeen = true
    return out
  }

  // -- 槽位管理 ------------------------------------------------------------

  /** 从事件里取相关性主键：优先 `output_index`，退回 `item_id`。 */
  private keyOf(event: Record<string, unknown>, itemId: string | undefined): { key: string; itemId?: string } {
    const outputIndex = asIndex(event.output_index)
    if (outputIndex !== undefined) {
      return { key: `o:${String(outputIndex)}`, ...itemId === undefined ? {} : { itemId } }
    }
    if (itemId !== undefined && itemId.length > 0) return { key: `i:${itemId}`, itemId }
    throw gatewayFailure(
      'myrix-llm-gateway: 上游流事件既没有 output_index 也没有 item_id，无法把内容对应到输出块',
      'INVALID_RESPONSE',
    )
  }
  private findSlot(event: Record<string, unknown>, itemId: string | undefined): Slot | undefined {
    const outputIndex = asIndex(event.output_index)
    if (outputIndex !== undefined) {
      const slot = this.byKey.get(`o:${String(outputIndex)}`)
      if (slot !== undefined) {
        this.assertItemId(slot, itemId)
        return slot
      }
    }
    if (itemId !== undefined && itemId.length > 0) {
      const slot = this.byItemId.get(itemId)
      if (slot !== undefined) return slot
    }
    return undefined
  }

  private ensureSlot(
    kind: SlotKind,
    event: Record<string, unknown>,
    itemId: string | undefined,
  ): { slot: Slot; start?: StreamChunk } {
    const { key } = this.keyOf(event, itemId)
    const existing = this.findSlot(event, itemId) ?? this.byKey.get(key)
    if (existing !== undefined) {
      if (existing.kind !== kind) {
        throw gatewayFailure(
          `myrix-llm-gateway: 同一个输出索引上出现了冲突的内容类型（${existing.kind} vs ${kind}）`,
          'INVALID_RESPONSE',
        )
      }
      this.assertItemId(existing, itemId)
      if (existing.closed) {
        throw gatewayFailure('myrix-llm-gateway: 上游在关闭输出块之后又发送了该块的内容', 'INVALID_RESPONSE')
      }
      return { slot: existing }
    }
    const slot: Slot = {
      kind,
      index: this.nextIndex,
      text: '',
      streamedArgs: '',
      bufferedArgs: '',
      closed: false,
      ...itemId === undefined ? {} : { itemId },
    }
    this.nextIndex += 1
    this.byKey.set(key, slot)
    if (itemId !== undefined && itemId.length > 0) this.byItemId.set(itemId, slot)
    const blockType = kind === 'tool-call' ? 'tool-call' as const : kind
    return {
      slot,
      start: { type: 'block-start', index: slot.index, blockType },
    }
  }

  /** 同一输出块的 item id 必须在所有事件里一致；不一致说明上游串了流。 */
  private assertItemId(slot: Slot, itemId: string | undefined): void {
    if (itemId === undefined || itemId.length === 0) return
    if (slot.itemId === undefined) {
      slot.itemId = itemId
      this.byItemId.set(itemId, slot)
      return
    }
    if (slot.itemId !== itemId) {
      throw gatewayFailure(
        'myrix-llm-gateway: 同一个输出索引上出现了不同的 item id，上游流已被破坏',
        'INVALID_RESPONSE',
      )
    }
  }

  private messageText(item: Record<string, unknown>): string {
    if (!Array.isArray(item.content)) return ''
    let text = ''
    for (const entry of item.content) {
      const part = asRecord(entry)
      if (part === undefined) continue
      const partType = asString(part.type)
      if (partType === 'output_text') text += asString(part.text) ?? ''
      else if (partType === 'refusal') text += asString(part.refusal) ?? ''
      else if (partType === 'input_text') text += asString(part.text) ?? ''
      else {
        throw gatewayFailure(
          `myrix-llm-gateway: 助手消息含有本适配器无法表达的内容部件 "${partType ?? 'unknown'}"`,
          'UNSUPPORTED_CONTENT',
        )
      }
    }
    return text
  }

  private reasoningText(item: Record<string, unknown>): string {
    const parts: string[] = []
    if (Array.isArray(item.summary)) {
      for (const entry of item.summary) {
        const part = asRecord(entry)
        if (part !== undefined && asString(part.text) !== undefined) parts.push(asString(part.text)!)
      }
    }
    if (Array.isArray(item.content)) {
      for (const entry of item.content) {
        const part = asRecord(entry)
        if (part !== undefined && asString(part.text) !== undefined) parts.push(asString(part.text)!)
      }
    }
    return parts.join('\n\n')
  }

  private streamAuthoritativeArgs(slot: Slot, authoritative: string): StreamChunk[] {
    if (slot.callId === undefined || slot.callId.length === 0) return []
    const suffix = suffixOf(slot.streamedArgs, authoritative)
    if (suffix === undefined) return []
    slot.streamedArgs = authoritative
    return [this.toolCallDelta(slot, suffix)]
  }

  private toolCallDelta(slot: Slot, argumentsDelta: string): StreamChunk {
    return {
      type: 'tool-call-delta',
      index: slot.index,
      id: (slot.callId ?? '') as ToolCallId,
      ...slot.name === undefined ? {} : { name: slot.name },
      argumentsDelta,
    }
  }

  private hasToolCalls(): boolean {
    for (const slot of this.byKey.values()) {
      if (slot.kind === 'tool-call') return true
    }
    return false
  }

  /** 每个已开启的块只关一次；`finish` 之前必须关完。 */
  private closeBlocks(): StreamChunk[] {
    const slots = [...this.byKey.values()]
      .filter(slot => !slot.closed)
      .sort((left, right) => left.index - right.index)
    return slots.map(slot => this.closeSlot(slot))
  }

  private closeSlot(slot: Slot): StreamChunk {
    slot.closed = true
    return { type: 'block-end', index: slot.index, block: this.blockOf(slot) }
  }

  private blockOf(slot: Slot): ContentBlock {
    switch (slot.kind) {
      case 'text': return { type: 'text', text: slot.text }
      case 'reasoning': return { type: 'reasoning', text: slot.text }
      case 'tool-call': {
        if (slot.callId === undefined || slot.callId.length === 0 || slot.name === undefined) {
          throw gatewayFailure('myrix-llm-gateway: 工具调用缺少 call_id 或 name，无法形成完整块', 'INVALID_RESPONSE')
        }
        return {
          type: 'tool-call',
          id: slot.callId as ToolCallId,
          name: slot.name,
          arguments: slot.authoritativeArgs ?? slot.bufferedArgs,
        }
      }
    }
  }

  private emitUsage(usage: TokenUsage): StreamChunk[] {
    if (this.usageEmitted) return []
    this.usageEmitted = true
    return [{ type: 'usage', usage }]
  }
}

// ---------------------------------------------------------------------------
// 非流式响应翻译
// ---------------------------------------------------------------------------

/**
 * 把一个非流式 Responses 响应（`output` 数组）转成等价的 chunk 序列。
 *
 * 产物与流式路径完全一致，因此调用方（agent loop / compaction）无需区别对待。
 * @param raw - 已解析的响应体（`{status, output, usage}`）。
 * @returns 完整 chunk 序列（含 usage 与 finish）。
 * @throws `INVALID_RESPONSE` 当响应体缺少 `output` 数组时。
 */
export function responsesToChunks(raw: unknown): StreamChunk[] {
  const body = asRecord(raw)
  if (body === undefined) throw gatewayFailure('myrix-llm-gateway: 上游返回了非对象响应体', 'INVALID_RESPONSE')
  if (!Array.isArray(body.output)) {
    throw gatewayFailure('myrix-llm-gateway: 上游 Responses 响应没有 output 数组', 'INVALID_RESPONSE')
  }
  const out: StreamChunk[] = []
  let index = 0
  let toolCalls = 0
  const pushText = (kind: 'text' | 'reasoning', text: string): void => {
    if (text.length === 0) return
    out.push({ type: 'block-start', index, blockType: kind })
    out.push(kind === 'text'
      ? { type: 'text-delta', index, text }
      : { type: 'reasoning-delta', index, text })
    out.push({ type: 'block-end', index, block: { type: kind, text } })
    index += 1
  }
  for (const entry of body.output) {
    const item = asRecord(entry)
    if (item === undefined) continue
    switch (asString(item.type)) {
      case 'message': {
        pushText('text', textOfResponsesMessage(item))
        break
      }
      case 'reasoning': {
        pushText('reasoning', textOfReasoningItem(item))
        break
      }
      case 'function_call': {
        const callId = asString(item.call_id)
        const name = asString(item.name)
        if (callId === undefined || callId.length === 0 || name === undefined || name.length === 0) {
          throw gatewayFailure('myrix-llm-gateway: 非流式响应里的 function_call 缺少 call_id 或 name', 'INVALID_RESPONSE')
        }
        const args = asString(item.arguments) ?? ''
        out.push({ type: 'block-start', index, blockType: 'tool-call' })
        if (args.length > 0) {
          out.push({ type: 'tool-call-delta', index, id: callId as ToolCallId, name, argumentsDelta: args })
        }
        out.push({ type: 'block-end', index, block: { type: 'tool-call', id: callId as ToolCallId, name, arguments: args } })
        index += 1
        toolCalls += 1
        break
      }
      default:
        throw gatewayFailure(
          `myrix-llm-gateway: 非流式响应含有本适配器无法表达的输出类型 "${asString(item.type) ?? 'unknown'}"`,
          'UNSUPPORTED_CONTENT',
        )
    }
  }
  const usage = mapUsage(body.usage)
  if (usage !== undefined) out.push({ type: 'usage', usage })
  const incomplete = asRecord(body.incomplete_details)
  out.push({
    type: 'finish',
    reason: mapResponsesTerminal({
      status: asString(body.status),
      ...asString(incomplete?.reason) === undefined ? {} : { incompleteReason: asString(incomplete?.reason)! },
    }, toolCalls > 0),
  })
  return out
}

function textOfResponsesMessage(item: Record<string, unknown>): string {
  if (!Array.isArray(item.content)) return ''
  let text = ''
  for (const entry of item.content) {
    const part = asRecord(entry)
    if (part === undefined) continue
    const partType = asString(part.type)
    if (partType === 'output_text' || partType === 'input_text') text += asString(part.text) ?? ''
    else if (partType === 'refusal') text += asString(part.refusal) ?? ''
    else {
      throw gatewayFailure(
        `myrix-llm-gateway: 助手消息含有本适配器无法表达的内容部件 "${partType ?? 'unknown'}"`,
        'UNSUPPORTED_CONTENT',
      )
    }
  }
  return text
}

function textOfReasoningItem(item: Record<string, unknown>): string {
  const parts: string[] = []
  for (const field of ['summary', 'content'] as const) {
    if (!Array.isArray(item[field])) continue
    for (const entry of item[field]) {
      const part = asRecord(entry)
      const text = part === undefined ? undefined : asString(part.text)
      if (text !== undefined) parts.push(text)
    }
  }
  return parts.join('\n\n')
}

/** 从上游响应头取 `x-request-id`（诊断用）。 */
export function requestIdOf(headers: Headers): string | undefined {
  const value = headers.get('x-request-id')
  return value !== null && value.length > 0 && value.length <= 128 ? value : undefined
}

/**
 * 对将要交给 DSH 的 chunk 做最后一道遮蔽。
 *
 * 流内错误事件是**由翻译器直接产出 chunk**（而不是抛出）的，因此它不经过
 * `adapter.normalizeThrow` 的令牌遮蔽；一个被攻陷或有 bug 的上游可能把 cell
 * 令牌回显在错误正文里。这里只改写 `finish` 的失败文本，**不**触碰模型正文
 * （正文改写会静默改变模型输出）。
 * @param chunk - 待发出的 chunk。
 * @param secrets - 需要遮蔽的秘密（长度 < 8 的忽略）。
 * @returns 原 chunk，或失败文本被遮蔽后的副本。
 */
export function sanitizeChunk(chunk: StreamChunk, secrets: readonly string[]): StreamChunk {
  if (chunk.type !== 'finish' || chunk.reason.kind !== 'error') return chunk
  const message = chunk.reason.failure.message
  const redactedMessage = redact(message, secrets)
  if (redactedMessage === message) return chunk
  return {
    ...chunk,
    reason: { kind: 'error', failure: { ...chunk.reason.failure, message: redactedMessage } },
  }
}
