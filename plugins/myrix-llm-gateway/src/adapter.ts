/**
 * `GatewayAdapter` —— 实现 DSH 的 `LlmAdapter`，把一次模型调用变成一次
 * 经**强制归因**的模型网关 **OpenAI Responses** 请求。
 *
 * 安全模型（与 tech-design-v1 §4.4 对齐）：
 *
 * 1. **归因只来自进程内的权威身份表**：`options.sessionId` →
 *    `principals.requireBySession(...)`。请求里的任何模型参数（消息正文、
 *    工具参数）都**不可能**改变会话、租户或 rev。
 *    没有 `sessionId`、未绑定、已撤权、活性不可用 → 立刻抛错，一个字节都不发。
 *    这个检查在**每一次**主调用与压缩辅助调用之前都会执行。
 * 2. **每次请求都重新解析**：不缓存 Principal，也不缓存 `rev`；
 *    这样撤权在同一进程内立刻生效（下次调用即拒绝）。
 * 3. **不旁路**：没有"直连上游"的配置开关，没有"网关不可用时降级"的分支，
 *    也**没有 chat/completions 回退**；协议固定为 `POST <origin>/responses`。
 * 4. **上游密钥不进 Cell**：本适配器只持有 cell 服务令牌；上游密钥只存在于
 *    模型网关进程里。
 * 5. **重定向一律拒绝**：`fetch` 用 `redirect: 'error'`，避免把带 cell 令牌的
 *    请求（或其中的归因头）转发到另一个 origin。
 *
 * `stream()` 是 DSH 唯一要求实现的方法；其余 override 只补充模型元数据
 * （`dsh-compaction-basic` 需要 `context.contextWindow`）。
 *
 * @module @myrix/llm-gateway/adapter
 */

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { PrincipalRegistry } from '@myrix/principals'
import type { ResolvedGatewayConfig } from './config.ts'
import type { GatewayCellTokenResolver, GatewayRequestRecord } from './types.ts'
import {
  StreamTranslator,
  classifyStatus,
  encodeRequest,
  gatewayFailure,
  parseSseBounded,
  redact,
  requestIdOf,
  responsesToChunks,
  sanitizeChunk,
  snippet,
  upstreamErrorFields,
  upstreamModelName,
} from './wire.ts'

/** 适配器构造参数。 */
export interface GatewayAdapterOptions {
  /** 权威身份表：`requireBySession` 是唯一的归因入口。 */
  readonly principals: PrincipalRegistry
  /** 已解析的插件配置。 */
  readonly config: ResolvedGatewayConfig
  /** cell 服务令牌解析器；每次请求调用一次（令牌可轮转）。 */
  readonly cellToken: GatewayCellTokenResolver
  /** 测试/联调用注入的 fetch；生产使用全局 `fetch`。 */
  readonly fetchImpl?: typeof fetch
  /** 注入时钟（诊断延迟用）；默认 `Date.now`。 */
  readonly now?: () => number
}

/** 一次调用解析出的、冻结的归因事实。 */
interface Attribution {
  readonly provider: string
  readonly model: string
  readonly upstreamModel: string
  readonly sessionId: string
  readonly tenantId: string
  readonly revision: string
  readonly purpose: string
}

/**
 * 网关适配器。
 *
 * 每一次 `stream()` 都独立完成"归因 → 取令牌 → 发请求 → 翻译"，
 * 不跨请求复用任何会话状态。
 */
export class GatewayAdapter extends LlmAdapter {
  private readonly principals: PrincipalRegistry
  private readonly config: ResolvedGatewayConfig
  private readonly cellToken: GatewayCellTokenResolver
  private readonly fetchImpl: typeof fetch | undefined
  private readonly now: () => number

  constructor(options: GatewayAdapterOptions) {
    super()
    this.principals = options.principals
    this.config = options.config
    this.cellToken = options.cellToken
    this.fetchImpl = options.fetchImpl
    this.now = options.now ?? (() => Date.now())
  }

  /** 展示名：部署里这个名字会出现在模型选择器与会话 header 上。 */
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Myrix Model Gateway' }
  }

  /** 目录：只列出部署显式允许的模型，且带确切上下文容量。 */
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([...this.config.models].map(model => ({
      provider,
      id: model,
      name: model,
      inputModalities: ['text'] as const,
    })))
  }

  /** 精确模型信息：`context` 是 `dsh-compaction-basic` 的硬依赖。 */
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve(this.modelInfo(provider, model))
  }

  private modelInfo(provider: string, model: string): LlmResolvedModelInfo {
    this.assertModelAllowed(model)
    const contextWindow = this.config.contextWindows.get(model)
    if (contextWindow === undefined) {
      // 启动时已为 models 里每个模型填了容量；这里只可能是 isModelAllowed 放行的
      // 额外模型，或配置在运行期被换掉。宁可失败，也不猜一个容量。
      throw new LlmError(
        `myrix-llm-gateway: 模型 "${model}" 没有配置 contextWindow，无法给出上下文容量`,
        'INVALID_CONFIG',
      )
    }
    return {
      provider,
      id: model,
      name: model,
      inputModalities: ['text'],
      context: { contextWindow },
      ...this.config.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: this.config.defaultMaxTokens },
    }
  }

  /** 只有部署允许清单内的模型可以调用；未列出的一律拒绝（不做前缀通配）。 */
  private assertModelAllowed(model: string): void {
    const allowed = this.config.isModelAllowed?.(model) ?? this.config.models.has(model)
    if (!allowed) {
      throw new LlmError(
        `myrix-llm-gateway: 模型 "${model}" 不在本 cell 允许的模型清单内`,
        'MODEL_NOT_ALLOWED',
      )
    }
  }

  /**
   * 解析一次调用的归因事实。
   *
   * 这是**唯一**的会话来源；它不看 `options` 的任何其他字段，也不看请求头。
   * @param options - DSH 组装好的请求。
   * @returns 冻结的归因事实。
   * @throws `PrincipalDeniedError`（缺 sessionId/未绑定/撤权/活性失效）。
   */
  private attribute(options: GenerateOptions): Attribution {
    // `requireBySession` 内部包含：绑定存在性、撤权高水位、外部活性判定。
    // 失败即抛错，错误信息不含凭证材料。
    const principal = this.principals.requireBySession(
      options.sessionId === undefined ? undefined : String(options.sessionId),
    )
    this.assertModelAllowed(options.model)
    return Object.freeze({
      provider: options.provider,
      model: options.model,
      upstreamModel: upstreamModelName(this.config, options.model),
      sessionId: principal.sid,
      tenantId: principal.tid,
      revision: String(principal.rev),
      purpose: options.purpose ?? '',
    })
  }

  private headers(attribution: Attribution, token: string): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      [this.config.sessionHeader]: attribution.sessionId,
      [this.config.revisionHeader]: attribution.revision,
      [this.config.tenantHeader]: attribution.tenantId,
      ...attribution.purpose.length === 0 ? {} : { [this.config.purposeHeader]: attribution.purpose },
    }
  }

  /** `fetch` 的取用点：注入优先，便于单测与 smoke。 */
  private fetchFn(): typeof fetch {
    const impl = this.fetchImpl ?? globalThis.fetch
    if (typeof impl !== 'function') throw new Error('myrix-llm-gateway: 运行环境没有 fetch')
    return impl
  }

  /**
   * 给本次调用叠加**整次请求**超时；调用方 abort 通过 `AbortSignal.any` 合并。
   *
   * 流式的**空闲**看门狗不在这里：它在 {@link readBounded} 的逐次读取上，
   * 因为"整次请求超时"与"上游半天不说话"是两种不同故障。
   * @param caller - DSH 提供的取消信号。
   * @returns 组合信号与清理函数。
   */
  private signalFor(caller: AbortSignal | undefined): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(gatewayFailure(
        `myrix-llm-gateway: 模型网关在 ${String(this.config.requestTimeoutMs)}ms 内没有完成响应`,
        'TIMEOUT',
      ))
    }, this.config.requestTimeoutMs)
    const signals = caller === undefined ? [controller.signal] : [controller.signal, caller]
    return {
      signal: AbortSignal.any(signals),
      dispose: () => { clearTimeout(timer) },
    }
  }

  /**
   * 流式执行一次模型调用。
   *
   * 顺序固定：**先归因、再取令牌、最后才可能发出网络请求**。
   * 任何一步失败都不会产生网络流量，也不会退出到"无归因调用"。
   * @param options - DSH 组装好的请求。
   * @returns DSH chunk 流。
   */
  async * stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const attribution = this.attribute(options)
    const token = this.cellToken()
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw gatewayFailure(
        'myrix-llm-gateway: cell 服务令牌在当前请求时不可用（不在错误信息里回显令牌）',
        'MISSING_CREDENTIAL',
      )
    }
    const body = encodeRequest(this.config, attribution.upstreamModel, {
      messages: options.messages,
      ...options.system === undefined ? {} : { system: options.system },
      ...options.tools === undefined ? {} : { tools: options.tools },
      ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
      stream: true,
    })

    const started = this.now()
    const { signal, dispose } = this.signalFor(options.signal)
    let status = 0
    let requestId: string | undefined
    try {
      const response = await this.send(body, attribution, token, signal)
      status = response.status
      requestId = requestIdOf(response.headers)
      if (!response.ok) throw await this.responseFailure(response, token)
      if (response.body === null) {
        throw gatewayFailure('myrix-llm-gateway: 模型网关返回了空响应体', 'TRANSPORT', status)
      }
      // 与 DSH 自身的适配器一样：`next()` 在 try 内、`yield` 在 try 外，
      // 这样消费方恢复生成器时抛出的错误不会被我们的归一化吞掉。
      const iterator = this.translateStream(response.body)[Symbol.asyncIterator]()
      let exhausted = false
      try {
        while (true) {
          let item: IteratorResult<StreamChunk>
          try {
            item = await iterator.next()
          } catch (error: unknown) {
            throw this.normalizeThrow(error, options.signal, token)
          }
          if (item.done === true) {
            exhausted = true
            return
          }
          // 流内错误事件由翻译器产出 chunk（不是抛出），因此这里补一道令牌遮蔽：
          // 上游把 cell 令牌回显在错误正文里时，绝不能让它离开本进程。
          yield sanitizeChunk(item.value, [token])
        }
      } finally {
        if (!exhausted) await iterator.return?.(undefined)
      }
    } catch (error: unknown) {
      throw this.normalizeThrow(error, options.signal, token)
    } finally {
      dispose()
      this.record(attribution, status, requestId, started, true)
    }
  }

  /** 发送一次请求；网络层失败也在这里归一化。 */
  private async send(
    body: unknown,
    attribution: Attribution,
    token: string,
    signal: AbortSignal,
  ): Promise<Response> {
    try {
      return await this.fetchFn()(this.config.endpoint, {
        method: 'POST',
        headers: this.headers(attribution, token),
        body: JSON.stringify(body),
        signal,
        // 带 cell 令牌与归因头的请求**绝不**跟随重定向：换一个 origin 就等于
        // 把凭据交给不属于本网关的端点。
        redirect: 'error',
      })
    } catch (error: unknown) {
      throw this.normalizeThrow(error, signal, token)
    }
  }

  /**
   * 流式翻译：Responses SSE → DSH chunk。
   *
   * 无论正常 `response.completed`、`[DONE]`、上游 EOF 还是中途断开，收尾都由
   * {@link StreamTranslator.finishStream} 统一处理；取消与协议错误则抛出，
   * 交给 DSH 归一化成终态 finish。
   */
  private async * translateStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<StreamChunk> {
    const translator = new StreamTranslator()
    for await (const event of parseSseBounded(stream, {
      maxBytes: this.config.maxResponseBytes,
      idleTimeoutMs: this.config.streamIdleTimeoutMs,
    })) {
      const data = event.data
      if (data === undefined) continue
      if (data === '[DONE]') break
      if (data.length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(data)
      } catch (_malformedSseJson) {
        // 网关保证 data 行是 JSON（错误也走 `{"type":"error",...}`）；不是 JSON 就是协议破坏。
        throw gatewayFailure('myrix-llm-gateway: 上游流返回了不是 JSON 的 data 行', 'INVALID_RESPONSE')
      }
      for (const chunk of translator.push(parsed, event.event)) yield chunk
    }
    for (const chunk of translator.finishStream()) yield chunk
  }

  /** 非流式路径（配置 `stream: false` 的部署/冒烟用）；与流式产出等价的 chunk 序列。 */
  async * streamOnce(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const attribution = this.attribute(options)
    const token = this.cellToken()
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw gatewayFailure('myrix-llm-gateway: cell 服务令牌在当前请求时不可用', 'MISSING_CREDENTIAL')
    }
    const body = encodeRequest(this.config, attribution.upstreamModel, {
      messages: options.messages,
      ...options.system === undefined ? {} : { system: options.system },
      ...options.tools === undefined ? {} : { tools: options.tools },
      ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
      stream: false,
    })
    const started = this.now()
    const { signal, dispose } = this.signalFor(options.signal)
    let status = 0
    let requestId: string | undefined
    try {
      const response = await this.send(body, attribution, token, signal)
      status = response.status
      requestId = requestIdOf(response.headers)
      if (!response.ok) throw await this.responseFailure(response, token)
      for (const chunk of responsesToChunks(await this.readJson(response))) {
        yield sanitizeChunk(chunk, [token])
      }
    } catch (error: unknown) {
      throw this.normalizeThrow(error, options.signal, token)
    } finally {
      dispose()
      this.record(attribution, status, requestId, started, false)
    }
  }

  /** 有界读取非流式响应体；超过上限按传输失败。 */
  private async readJson(response: Response): Promise<unknown> {
    const declared = Number(response.headers.get('content-length') ?? '')
    if (Number.isSafeInteger(declared) && declared > this.config.maxResponseBytes) {
      throw gatewayFailure('myrix-llm-gateway: 上游非流式响应体超过配置上限', 'TRANSPORT', response.status)
    }
    if (response.body === null) {
      throw gatewayFailure('myrix-llm-gateway: 上游非流式响应没有响应体', 'TRANSPORT', response.status)
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let raw = ''
    let bytes = 0
    try {
      while (true) {
        const result = await reader.read()
        if (result.done === true) break
        bytes += result.value.byteLength
        if (bytes > this.config.maxResponseBytes) {
          throw gatewayFailure('myrix-llm-gateway: 上游非流式响应体超过配置上限', 'TRANSPORT', response.status)
        }
        raw += decoder.decode(result.value, { stream: true })
      }
      raw += decoder.decode()
    } finally {
      try {
        await reader.cancel()
      } catch (_alreadyClosedOrBroken) {
        // 已关闭；取消失败不改变结果。
      }
      reader.releaseLock()
    }
    try {
      return JSON.parse(raw)
    } catch (_malformedResponseJson) {
      throw gatewayFailure('myrix-llm-gateway: 上游非流式响应体不是合法 JSON', 'INVALID_RESPONSE', response.status)
    }
  }

  /** 把网关的 HTTP 错误变成带稳定码的 LLM 错误；**不**回显令牌或上游正文。 */
  private async responseFailure(response: Response, token: string): Promise<LlmError> {
    let payload: unknown
    let raw = ''
    try {
      raw = await response.text()
      payload = raw.length === 0 ? undefined : JSON.parse(raw)
    } catch (_unreadableErrorBody) {
      // `response.text()` 失败（连接已断）时保留空正文，下面走状态码分类。
      raw = ''
      payload = undefined
    }
    const fields = upstreamErrorFields(payload)
    const message = redact(fields.message ?? snippet(raw) ?? `HTTP ${String(response.status)}`, [token])
    const code = classifyStatus(response.status, message)
    const detail = fields.code === undefined ? '' : `（code=${fields.code}）`
    return gatewayFailure(
      `myrix-llm-gateway: 模型网关拒绝了这次调用（HTTP ${String(response.status)}）${detail}：${snippet(message)}`,
      code,
      response.status,
    )
  }

  /** 统一失败归一化：调用方取消 → `ABORTED`（DSH 会翻成 aborted finish）。 */
  private normalizeThrow(error: unknown, caller: AbortSignal | undefined, token: string): unknown {
    if (error instanceof LlmError) {
      // 令牌绝不出现在外发文本里，即使某个上游把它回显了。
      if (error.message.includes(token)) {
        return new LlmError(redact(error.message, [token]), error.code, { cause: error })
      }
      return error
    }
    if (caller?.aborted === true) {
      return gatewayFailure('myrix-llm-gateway: 调用方取消了模型请求', 'ABORTED', undefined)
    }
    if (error instanceof Error && error.name === 'AbortError') {
      return gatewayFailure('myrix-llm-gateway: 模型请求被中止（超时或取消）', 'TIMEOUT')
    }
    const reason = error instanceof Error ? error.message : String(error)
    return gatewayFailure(
      `myrix-llm-gateway: 无法完成模型网关调用（${snippet(redact(reason, [token]))}）`,
      'TRANSPORT',
    )
  }

  /** 诊断回调；任何回调抛错都不影响请求结果。 */
  private record(
    attribution: Attribution,
    status: number,
    requestId: string | undefined,
    started: number,
    stream: boolean,
  ): void {
    const sink = this.config.onRequest
    if (sink === undefined) return
    const entry: GatewayRequestRecord = {
      provider: attribution.provider,
      model: attribution.model,
      upstreamModel: attribution.upstreamModel,
      sessionId: attribution.sessionId,
      revision: Number(attribution.revision),
      tenantId: attribution.tenantId,
      ...attribution.purpose.length === 0
        ? {}
        : { purpose: attribution.purpose as 'compaction' | 'session-title' },
      stream,
      status,
      ...requestId === undefined ? {} : { requestId },
      latencyMs: Math.max(0, this.now() - started),
    }
    try {
      sink(entry)
    } catch (_diagnosticSinkFailure) {
      // 诊断是旁路：它的失败不能改变模型调用的结果。
    }
  }
}
