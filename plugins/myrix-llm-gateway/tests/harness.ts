/**
 * 测试装配：在**真实 Cordis** 上加载 `PrincipalRegistry`，并用真实 `LlmRuntime`
 * 驱动 `GatewayAdapter`（而不是直接调用适配器方法）。
 *
 * 这样做是有意的：归因只发生在 `LlmRuntime` 填好 `options.sessionId` 之后，
 * 直接调 `adapter.stream()` 会漏掉 `llm/stream` waterfall、失败归一化与
 * `prepareCall` 的分帧。测试必须走真实链路。
 *
 * @module @myrix/llm-gateway/tests/harness
 */
import { Context } from '@deepseek-ai/cordis'
import {
  LlmRuntime,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { PrincipalRegistry, type Principal } from '@myrix/principals'
import type { Config } from '../src/types.ts'
import { resolveConfig, type ResolvedGatewayConfig } from '../src/config.ts'
import { GatewayAdapter } from '../src/adapter.ts'

/** 会话 id 与 owner 的简单制造，避免测试里出现魔法字符串。 */
export function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sid: 'sid-1',
    tid: 't_acme',
    sub: 'u_1',
    wid: 'w_1',
    preset: 'novel-chapter',
    rev: 7,
    ...overrides,
  }
}

/** PrincipalRegistry 只读 `Agent.id`；这里给出最小替身。 */
export function fakeAgent(id: string): Agent {
  return { id } as unknown as Agent
}

/** 测试装配结果。 */
export interface Harness {
  readonly ctx: Context
  readonly principals: PrincipalRegistry
  readonly adapter: GatewayAdapter
  readonly config: ResolvedGatewayConfig
  /** 已到达适配器的诊断记录。 */
  readonly records: import('../src/types.ts').GatewayRequestRecord[]
  /** 撤销适配器注册并等 Cordis 走完 effect 清理。 */
  dispose(): Promise<void>
}

/** 测试装配参数：`config` 的字段直接作为插件配置传给真实的 `resolveConfig`。 */
export type HarnessOptions = Partial<Config> & { readonly baseURL: string } & {
  /** 活动令牌；默认 `'cell-token-0123456789'`。`''` 用于断言缺令牌时启动失败。 */
  readonly token?: string
  /** 注入的时钟，默认固定值，便于断言延迟。 */
  readonly now?: () => number
}

/**
 * 在真实 Cordis 上装配 `principals` + adapter。
 * @param options - 配置覆盖；`baseURL` 是**网关 origin**（适配器自己追加 `/responses`）。
 * @returns 可直接驱动 `ctx.llm.stream()` 的测试装配。
 */
export async function bootHarness(options: HarnessOptions): Promise<Harness> {
  const ctx = new Context()
  // 真实的 `LlmRuntime` 与 `PrincipalRegistry`：归因只在 `LlmRuntime` 填好
  // `options.sessionId` 之后才发生，直接调适配器会漏掉这条链路。
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(PrincipalRegistry)
  const records: import('../src/types.ts').GatewayRequestRecord[] = []
  const token = options.token ?? 'cell-token-0123456789'
  const { token: _token, now: _now, ...pluginConfig } = options
  // 默认值排在前面，调用方给什么就覆盖什么（含显式的 `undefined`，
  // 这样"缺 contextWindow 必须启动失败"这类反向用例才表达得出来）。
  const config = resolveConfig(
    {
      models: ['myrix-chat'],
      contextWindow: 100_000,
      // 单测里默认关掉空闲看门狗：只有专门验证它的用例才开，
      // 否则"上游暂停一下"会被看门狗抢走，断言就指错了失败原因。
      streamIdleTimeoutMs: 0,
      ...pluginConfig,
      cellToken: token,
      onRequest: (record) => { records.push(record) },
    },
    () => token,
  )
  const adapter = new GatewayAdapter({
    principals: ctx.principals,
    config,
    cellToken: () => token,
    now: options.now ?? (() => 0),
  })
  const disposeRegistration = ctx.llm.registerAdapter([...config.providers], adapter)
  return {
    ctx,
    principals: ctx.principals,
    adapter,
    config,
    records,
    dispose: async () => {
      await disposeRegistration()
      await ctx.fiber.dispose()
    },
  }
}

/** 一条普通用户消息。 */
export function userMessage(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/**
 * 一次模型调用请求。
 * @param sessionId - 归因用的会话 id；`undefined` 表示故意不带归因。
 */
export function request(options: {
  readonly sessionId?: string
  readonly provider?: string
  readonly model?: string
  readonly text?: string
  readonly purpose?: GenerateOptions['purpose']
  readonly signal?: AbortSignal
  readonly tools?: GenerateOptions['tools']
  readonly reasoningEffort?: GenerateOptions['reasoningEffort']
}): GenerateOptions {
  return {
    provider: options.provider ?? 'myrix-gateway',
    model: options.model ?? 'myrix-chat',
    messages: [userMessage(options.text ?? '你好')],
    ...options.sessionId === undefined ? {} : { sessionId: options.sessionId as never },
    ...options.purpose === undefined ? {} : { purpose: options.purpose },
    ...options.signal === undefined ? {} : { signal: options.signal },
    ...options.tools === undefined ? {} : { tools: options.tools },
    ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
  }
}

/** 收完整个 chunk 流（`LlmRuntime.stream` 已把适配器异常归一成终态 finish）。 */
export async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** 从 chunk 序列里取终态 finish（没有则抛，避免"静默通过"）。 */
export function finishOf(chunks: readonly StreamChunk[]): Extract<StreamChunk, { type: 'finish' }> {
  const finish = chunks.find((chunk): chunk is Extract<StreamChunk, { type: 'finish' }> => chunk.type === 'finish')
  if (finish === undefined) throw new Error(`流里没有 finish：${JSON.stringify(chunks)}`)
  return finish
}

/** 把 chunk 序列拼成"文本 + 工具调用"的可读快照，便于断言。 */
export function snapshot(chunks: readonly StreamChunk[]): {
  text: string
  reasoning: string
  toolCalls: { id: string; name: string; arguments: string }[]
  usage?: import('@deepseek-ai/dsh-llm').TokenUsage
  finish: string
  failureCode?: string
} {
  let text = ''
  let reasoning = ''
  const toolCalls: { id: string; name: string; arguments: string }[] = []
  let usage: import('@deepseek-ai/dsh-llm').TokenUsage | undefined
  let finish = 'none'
  let failureCode: string | undefined
  for (const chunk of chunks) {
    switch (chunk.type) {
      case 'text-delta': text += chunk.text; break
      case 'reasoning-delta': reasoning += chunk.text; break
      case 'tool-call-delta': {
        const existing = toolCalls.find(call => call.id === String(chunk.id))
        if (existing === undefined) toolCalls.push({ id: String(chunk.id), name: chunk.name ?? '', arguments: chunk.argumentsDelta })
        else existing.arguments += chunk.argumentsDelta
        break
      }
      case 'usage': usage = chunk.usage; break
      case 'finish': {
        finish = chunk.reason.kind
        failureCode = 'failure' in chunk.reason ? chunk.reason.failure.code : undefined
        break
      }
      default: break
    }
  }
  return {
    text,
    reasoning,
    toolCalls,
    ...usage === undefined ? {} : { usage },
    finish,
    ...failureCode === undefined ? {} : { failureCode },
  }
}
