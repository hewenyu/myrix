/**
 * 显式的 fake HTTP 模型网关，只用于测试。协议是 OpenAI **Responses**
 * （`POST /v1/responses`，SSE 事件 + 非流式 `output` 数组）。
 *
 * **它不是伪 LLM**：真实链路上没有任何"模拟模型"分支 —— 这是测试进程里另起的
 * 一个 loopback HTTP 服务，替身只替"上游网关"这一个外部对端，从而让适配器被
 * 真实 socket、真实 SSE、真实 abort 语义检验。生产代码永远不会引用本文件。
 *
 * @module @myrix/llm-gateway/tests/fake-gateway
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** 一次到达 fake 网关的请求，按需记录可断言的事实。 */
export interface RecordedRequest {
  readonly method: string
  /** 请求路径（应为 `/v1/responses`）。 */
  readonly url: string
  readonly headers: Record<string, string | undefined>
  /** 原始正文。 */
  readonly raw: string
  /** 解析后的 JSON 正文；不是 JSON 时为 undefined。 */
  readonly body: Record<string, unknown> | undefined
  /** 客户端在响应结束前断开（abort 测试用）。 */
  readonly aborted: () => boolean
}

/** 处理器上下文。 */
export interface HandlerContext {
  readonly request: RecordedRequest
  readonly response: ServerResponse
  /** 调用序号（从 0 开始），便于脚本化多次调用。 */
  readonly index: number
}

export type GatewayHandler = (context: HandlerContext) => void | Promise<void>

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/** 一个 loopback 上的可脚本化 Responses 端点。 */
export class FakeGateway {
  /** 按到达顺序记录的全部请求。 */
  readonly requests: RecordedRequest[] = []
  private readonly abortFlags: boolean[] = []
  private readonly server: Server
  private endpoint = ''

  private constructor(server: Server) {
    this.server = server
  }

  /** 已监听的 Responses URL（`http://127.0.0.1:<port>/v1/responses`）。 */
  get url(): string {
    if (this.endpoint.length === 0) throw new Error('fake gateway 尚未监听')
    return this.endpoint
  }

  /** 网关 origin（适配器 `baseURL` 应传这个，它自己追加 `/responses`）。 */
  get origin(): string {
    if (this.endpoint.length === 0) throw new Error('fake gateway 尚未监听')
    return this.endpoint.replace(/\/responses$/, '')
  }

  /**
   * 起一个 fake 网关。
   * @param handler - 每个请求的响应脚本。
   * @returns 已监听 loopback 的实例。
   */
  static async start(handler: GatewayHandler): Promise<FakeGateway> {
    const gateway = new FakeGateway(createServer((request, response) => {
      void (async () => {
        const raw = await readBody(request)
        let parsed: unknown
        try {
          parsed = raw.length === 0 ? undefined : JSON.parse(raw)
        } catch (_nonJsonBody) {
          parsed = undefined
        }
        const index = gateway.requests.length
        const record: RecordedRequest = {
          method: request.method ?? '',
          url: request.url ?? '',
          headers: request.headers as Record<string, string | undefined>,
          raw,
          body: typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined,
          aborted: () => gateway.abortFlags[index] === true,
        }
        gateway.abortFlags[index] = false
        gateway.requests.push(record)
        request.on('aborted', () => { gateway.abortFlags[index] = true })
        response.on('close', () => {
          if (!response.writableEnded) gateway.abortFlags[index] = true
        })
        await handler({ request: record, response, index })
      })().catch((error: unknown) => {
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
        if (!response.writableEnded) {
          response.end(JSON.stringify({ error: { message: String(error), type: 'fake_gateway_error', code: 'fake' } }))
        }
      })
    }))
    await new Promise<void>((resolve) => { gateway.server.listen(0, '127.0.0.1', resolve) })
    const address = gateway.server.address() as AddressInfo
    gateway.endpoint = `http://127.0.0.1:${String(address.port)}/v1/responses`
    return gateway
  }

  /** 停止服务并等待所有连接关闭。 */
  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.closeAllConnections()
      this.server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
  }
}

/** 写一个 SSE 响应；每个元素是一整段 `data: ...\n\n`（或 `event:` + `data:`）。 */
export function sse(
  response: ServerResponse,
  chunks: readonly string[],
  init: { status?: number; delayMs?: number } = {},
): void {
  response.writeHead(init.status ?? 200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  void (async () => {
    for (const chunk of chunks) {
      if (init.delayMs !== undefined) await new Promise(resolve => setTimeout(resolve, init.delayMs))
      if (response.writableEnded || response.destroyed) return
      response.write(chunk)
    }
    if (!response.writableEnded && !response.destroyed) response.end()
  })()
}

/** 一个已经开启但永不结束的 SSE 响应（abort / 空闲看门狗测试用）。 */
export function sseHanging(response: ServerResponse, firstChunks: readonly string[] = []): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const chunk of firstChunks) response.write(chunk)
}

/** 写一个 JSON 响应。 */
export function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

/** 一个 SSE `data:` 帧。 */
export function frame(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

/** 一个带 SSE `event:` 名、`data` 里没有 `type` 的帧（验证两种形状都认）。 */
export function namedFrame(name: string, data: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
}

// ---------------------------------------------------------------------------
// Responses 事件构造器
// ---------------------------------------------------------------------------

/** `response.created`：信息性事件，适配器必须安全忽略。 */
export function created(id = 'resp_fake'): string {
  return frame({ type: 'response.created', response: { id, status: 'in_progress', output: [] } })
}

/** `response.output_item.added`：开启一个输出块。 */
export function itemAdded(outputIndex: number, item: Record<string, unknown>): string {
  return frame({ type: 'response.output_item.added', output_index: outputIndex, item })
}

/** `response.output_text.delta`。 */
export function textDelta(outputIndex: number, delta: string, itemId = 'msg_fake'): string {
  return frame({
    type: 'response.output_text.delta',
    item_id: itemId,
    output_index: outputIndex,
    content_index: 0,
    delta,
    logprobs: [],
  })
}

/** `response.output_text.done`（携带完整文本，适配器不得重复发出）。 */
export function textDone(outputIndex: number, text: string, itemId = 'msg_fake'): string {
  return frame({
    type: 'response.output_text.done',
    item_id: itemId,
    output_index: outputIndex,
    content_index: 0,
    text,
    logprobs: [],
  })
}

/** `response.function_call_arguments.delta`。 */
export function argsDelta(outputIndex: number, delta: string, itemId = 'fc_fake'): string {
  return frame({
    type: 'response.function_call_arguments.delta',
    item_id: itemId,
    output_index: outputIndex,
    delta,
  })
}

/** `response.function_call_arguments.done`（携带完整参数，适配器不得重复发出）。 */
export function argsDone(outputIndex: number, args: string, itemId = 'fc_fake'): string {
  return frame({
    type: 'response.function_call_arguments.done',
    item_id: itemId,
    output_index: outputIndex,
    arguments: args,
  })
}

/** `response.output_item.done`。 */
export function itemDone(outputIndex: number, item: Record<string, unknown>): string {
  return frame({ type: 'response.output_item.done', output_index: outputIndex, item })
}

/** `response.reasoning_summary_text.delta`。 */
export function reasoningDelta(outputIndex: number, delta: string, itemId = 'rs_fake'): string {
  return frame({
    type: 'response.reasoning_summary_text.delta',
    item_id: itemId,
    output_index: outputIndex,
    summary_index: 0,
    delta,
  })
}

/** `response.completed`：唯一代表成功的终态事件。 */
export function completed(options: {
  readonly usage?: Record<string, unknown>
  readonly output?: readonly Record<string, unknown>[]
  readonly id?: string
} = {}): string {
  return frame({
    type: 'response.completed',
    response: {
      id: options.id ?? 'resp_fake',
      object: 'response',
      status: 'completed',
      output: options.output ?? [],
      usage: options.usage,
    },
  })
}

/** `response.incomplete`（如达到 max_output_tokens）。 */
export function incomplete(reason: string, usage?: Record<string, unknown>): string {
  return frame({
    type: 'response.incomplete',
    response: { id: 'resp_fake', status: 'incomplete', incomplete_details: { reason }, output: [], usage },
  })
}

/** `response.failed`（错误在 `response.error` 下）。 */
export function failed(error: { code?: string; message: string }): string {
  return frame({ type: 'response.failed', response: { id: 'resp_fake', status: 'failed', error } })
}

/** 流内扁平 `error` 事件（Responses 的形状）。 */
export function errorEvent(error: { code: string; message: string }): string {
  return frame({ type: 'error', code: error.code, message: error.message })
}

/** 一条完整的 assistant 文本消息 item（`output_item.done` 用）。 */
export function messageItem(text: string, itemId = 'msg_fake'): Record<string, unknown> {
  return {
    id: itemId,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', annotations: [], logprobs: [], text }],
  }
}

/** 一条 function_call item。 */
export function functionCallItem(options: {
  readonly callId: string
  readonly name: string
  readonly arguments: string
  readonly itemId?: string
}): Record<string, unknown> {
  return {
    id: options.itemId ?? 'fc_fake',
    type: 'function_call',
    status: 'completed',
    call_id: options.callId,
    name: options.name,
    arguments: options.arguments,
  }
}

/** SSE 终止符。 */
export const DONE = 'data: [DONE]\n\n'
