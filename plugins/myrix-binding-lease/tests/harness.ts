/**
 * 测试替身：**确定性单调时钟**与**行为真实的 fetch**。
 *
 * 这里不做"mock 框架式"的打桩：`fetch` 替身必须真的实现
 * `AbortSignal`、`redirect: 'manual'` 与流式读取，否则"超时清空缓存"
 * 这类安全属性根本没被验证。
 */
import type { Fetcher } from '../src/index'
import type { LeaseIo } from '../src/index'

/** 手动推进的单调时钟（毫秒）。 */
export class ManualClock {
  private current: number
  constructor(start = 1_000) {
    this.current = start
  }
  now(): number {
    return this.current
  }
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new Error('advance 必须是非负有限值')
    this.current += ms
  }
}

/** 一次被记录的请求。 */
export interface RecordedRequest {
  readonly url: string
  readonly headers: Record<string, string>
  readonly redirect: string | undefined
  readonly method: string | undefined
}

/** 可编程的 fetch 替身。 */
export class ScriptedFetch {
  readonly requests: RecordedRequest[] = []
  private handler: (request: RecordedRequest, signal: AbortSignal) => Promise<Response> = async () =>
    new Response('{}', { status: 500 })

  /** 安装响应处理器。 */
  respond(handler: (request: RecordedRequest, signal: AbortSignal) => Promise<Response> | Response): void {
    this.handler = async (request, signal) => handler(request, signal)
  }

  /** 用一个成功快照响应所有请求。 */
  respondJson(payload: unknown, init: ResponseInit = {}): void {
    this.respond(() => new Response(JSON.stringify(payload), { status: 200, ...init }))
  }

  get calls(): number {
    return this.requests.length
  }

  readonly fetch: Fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value
    }
    const request: RecordedRequest = {
      url,
      headers,
      redirect: init?.redirect,
      method: init?.method,
    }
    this.requests.push(request)
    const signal = init?.signal ?? undefined
    if (signal === undefined) throw new Error('测试替身要求调用方必须传 AbortSignal')
    if (signal.aborted) throw signal.reason ?? new Error('aborted')
    return await this.handler(request, signal)
  }) as unknown as Fetcher
}

/** 一个在 abort 前永不 settle 的响应（用于超时/卸载测试）。 */
export function hangingResponse(signal: AbortSignal): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true })
  })
}

/** 记录所有被创建与取消的定时器，便于断言"卸载后没有残留 timer"。 */
export class ManualTimers {
  private nextId = 1
  private readonly active = new Map<number, { readonly callback: () => void; readonly delay: number; readonly repeating: boolean }>()

  readonly setTimer = (callback: () => void, delayMs: number): (() => void) => {
    const id = this.nextId++
    this.active.set(id, { callback, delay: delayMs, repeating: false })
    return () => this.active.delete(id)
  }

  readonly setInterval = (callback: () => void, delayMs: number): (() => void) => {
    const id = this.nextId++
    this.active.set(id, { callback, delay: delayMs, repeating: true })
    return () => this.active.delete(id)
  }

  /** 当前仍登记的定时器数量。 */
  get size(): number {
    return this.active.size
  }

  /** 触发所有 repeating 定时器（模拟一次周期 tick）。 */
  tickIntervals(): void {
    for (const entry of [...this.active.values()]) {
      if (entry.repeating) entry.callback()
    }
  }

  /** 触发所有一次性定时器（模拟超时）。 */
  fireTimeouts(): void {
    for (const [id, entry] of [...this.active.entries()]) {
      if (entry.repeating) continue
      this.active.delete(id)
      entry.callback()
    }
  }
}

/** 组装一套测试 IO。 */
export function testIo(options: {
  clock: ManualClock
  fetch: Fetcher
  timers?: ManualTimers
}): { io: LeaseIo; timers: ManualTimers } {
  const timers = options.timers ?? new ManualTimers()
  return {
    timers,
    io: {
      now: () => options.clock.now(),
      fetch: options.fetch,
      setTimer: timers.setTimer,
      setInterval: timers.setInterval,
    },
  }
}

/** 生成一个合法快照响应体。 */
export function snapshotPayload(
  rows: readonly {
    sid: string
    tid?: string
    sub?: string
    wid?: string
    preset?: string
    rev?: number
  }[],
  overrides: { cellId?: string; tenantId?: string; policy?: unknown } = {},
): Record<string, unknown> {
  return {
    cellId: overrides.cellId ?? 'cell-1',
    tenantId: overrides.tenantId ?? 't_acme',
    bindings: rows.map((row) => ({
      sid: row.sid,
      tid: row.tid ?? 't_acme',
      sub: row.sub ?? 'u_1',
      wid: row.wid ?? 'w_1',
      preset: row.preset ?? 'novel-chapter',
      rev: row.rev ?? 7,
    })),
    ...(overrides.policy === undefined ? {} : { policy: overrides.policy }),
  }
}

/** 生成一个合法的策略字段（六个小说工具名之内）。 */
export function policyPayload(
  overrides: { rev?: number; tools?: readonly string[]; ttlMs?: number } = {},
): Record<string, unknown> {
  return {
    rev: overrides.rev ?? 1,
    tools: overrides.tools ?? ['get_outline', 'save_chapter_draft'],
    ttlMs: overrides.ttlMs ?? 8_000,
  }
}

/** 32+ 字符的假 token（不来自任何真实部署）。 */
export const TEST_TOKEN = 'cell-test-token-0123456789abcdefghijklmn'
