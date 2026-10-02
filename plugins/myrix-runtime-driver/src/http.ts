/**
 * HTTP 边界的最小实现：原始正文读取（带硬上限与摘要）、JSON 解析、
 * 统一错误响应、以及 SSE 写入。
 *
 * 只依赖 `node:http`，不引入 Web 框架：driver 的端点数量固定且语义很窄，
 * 少一层依赖就少一处默认值需要审计。
 *
 * 安全要点：
 * - **rawBody 是凭证绑定的一部分**：`bh` claim 必须对"实际收到的字节"计算。
 *   任何"先解析再重新序列化"的做法都会让绑定失效，所以这里先取原始字节，
 *   再在同一次读取中算摘要，之后才解析 JSON。
 * - **正文大小先于解析限制**：超限直接 413，不把超大 body 读进内存。
 * - **错误响应不含敏感信息**：只给 `{error, reason, code?, stage?}`，
 *   绝不回显 token、正文或上游原始错误对象。
 *
 * @module @myrix/runtime-driver/http
 */
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ErrorResponse } from './types'

/** 正文硬上限：命令正文是用户消息，1 MiB 足够；超限即拒绝。 */
export const MAX_BODY_BYTES = 1024 * 1024

/** 读取正文失败的原因；每个原因对应一个稳定的 HTTP 状态码。 */
export type BodyFailure =
  | { readonly kind: 'too-large'; readonly limit: number; readonly seen: number }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'read-error'; readonly detail: string }

export type BodyResult =
  | { readonly ok: true; readonly raw: Buffer; readonly sha256: string }
  | { readonly ok: false; readonly failure: BodyFailure }

/** 计算小写十六进制 SHA-256；与 `@myrix/grant` 的 `bh` claim 同一算法。 */
export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * 空正文字节的 SHA-256（小写十六进制）。
 *
 * GET 端点（事件流、命令回执）没有请求体，凭证因此绑定这个**确定的**摘要；
 * 签发侧与校验侧必须使用同一个常量，而不是各算各的。
 */
export const EMPTY_BODY_SHA256 = sha256Hex(Buffer.alloc(0))

/**
 * 读取请求正文并计算摘要。
 *
 * 超限时**立即停止累积**并停止读取（`req.destroy()` 由调用方决定），
 * 避免攻击者用超大 body 打满内存。
 */
export async function readRawBody(
  req: IncomingMessage,
  limit: number = MAX_BODY_BYTES,
): Promise<BodyResult> {
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      size += buf.byteLength
      if (size > limit) {
        return { ok: false, failure: { kind: 'too-large', limit, seen: size } }
      }
      chunks.push(buf)
    }
  } catch (error) {
    if (req.aborted === true) return { ok: false, failure: { kind: 'aborted' } }
    return {
      ok: false,
      failure: { kind: 'read-error', detail: error instanceof Error ? error.name : 'unknown' },
    }
  }
  const raw = Buffer.concat(chunks)
  return { ok: true, raw, sha256: sha256Hex(raw) }
}

/** 解析结果：只接受 JSON 对象，数组/标量一律拒绝。 */
export type JsonObjectResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string }

/** 把正文解析成 JSON 对象；不合法时给出可读且不含正文的原因。 */
export function parseJsonObject(raw: Buffer): JsonObjectResult {
  if (raw.byteLength === 0) return { ok: false, reason: '请求体为空' }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    return { ok: false, reason: '请求体不是合法 UTF-8' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: '请求体不是合法 JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: '请求体必须是 JSON 对象' }
  }
  return { ok: true, value: parsed as Record<string, unknown> }
}

/** 统一的 JSON 响应；`no-store` 是默认，避免任何凭证/回执被中间层缓存。 */
export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent || res.writableEnded) return
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 发送错误响应；`{error, reason}` 是平台统一约定。 */
export function sendError(
  res: ServerResponse,
  status: number,
  error: string,
  reason: string,
  extra: { code?: string; stage?: string } = {},
): void {
  const payload: ErrorResponse = { error, reason, ...extra }
  sendJson(res, status, payload)
}

/** 读取单个请求头；重复头按第一个处理，避免"拼接后再解析"的歧义。 */
export function readHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  if (value === undefined) return undefined
  return Array.isArray(value) ? value[0] : value
}

/** 解析 URL 的路径与查询串；解析失败返回 undefined（调用方答 400）。 */
export function parseRequestUrl(req: IncomingMessage): { path: string; url: URL } | undefined {
  try {
    const url = new URL(req.url ?? '/', 'http://cell.invalid')
    return { path: url.pathname, url }
  } catch {
    return undefined
  }
}

// ---- SSE ----

/** 一个 SSE 订阅端；`write` 在订阅者已关闭时必须安全返回 false。 */
export interface SseSink {
  /** 写入一个已编码的事件帧；返回 false 表示连接已不可写。 */
  write(frame: string): boolean
  /** 关闭连接；幂等。 */
  close(): void
  /** 连接是否仍然可写。 */
  readonly open: boolean
}

/** SSE 写入端的可配置上界；默认 1 MiB。 */
export interface SseSinkOptions {
  /**
   * 允许在 `ServerResponse` 里积压的最大字节数。
   *
   * 超过它说明对端读得比我们写得慢。继续 `res.write` 只会让 Node 的缓冲
   * 无限增长（一个不读的客户端就能吃光进程内存），因此**主动断开**，
   * 由客户端带 `Last-Event-ID` 重连补发。绝不用"丢掉最终事件却回执成功"
   * 的方式掩盖背压。
   */
  readonly maxBufferedBytes?: number
  /** 初始 `retry:` 建议值（毫秒）。 */
  readonly retryMs?: number
}

/** 默认的 SSE 背压上界：1 MiB。 */
export const DEFAULT_SSE_MAX_BUFFERED_BYTES = 1024 * 1024

/**
 * 把 `ServerResponse` 包装成 SSE sink。
 *
 * 关闭时用 `end()` 而不是 `destroy()`：让客户端看到一个干净的流结束。
 * 心跳注释帧（`:hb`）由调用方按需发送，用来穿透中间层空闲超时。
 *
 * **背压**：每次写入前检查 `res.writableLength`；超过 `maxBufferedBytes`
 * 就 `destroy()` 并返回 false，让中枢关掉这个订阅。断开而不是丢帧，
 * 是因为静默丢帧会让客户端以为"这一段没有事件"，而 seq 已经跳过去了。
 */
export function sseSink(res: ServerResponse, options: SseSinkOptions = {}): SseSink {
  const retryMs = options.retryMs ?? 3000
  const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_SSE_MAX_BUFFERED_BYTES
  let open = true
  const onClose = (): void => {
    open = false
  }
  res.on('close', onClose)
  if (!res.headersSent) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      // 明确禁止缓冲：本服务的 SSE 是逐事件投递的，被中间层合并会破坏 seq 语义。
      'x-accel-buffering': 'no',
    })
  }
  // `retry` 让浏览器原生 EventSource 按我们的节奏重连。
  res.write(`retry: ${String(retryMs)}\n\n`)
  return {
    get open() {
      return open && !res.writableEnded
    },
    write(frame: string): boolean {
      if (!open || res.writableEnded) return false
      // 写入**之前**看水位：等 `write` 返回 false 时数据已经进了缓冲。
      if (res.writableLength > maxBufferedBytes) {
        open = false
        res.removeListener('close', onClose)
        try {
          // destroy 而不是 end：半截帧会让客户端把它当成一条完整事件；
          // 直接中断连接，客户端只能靠 Last-Event-ID 重放，不产生假 seq。
          res.destroy()
        } catch {
          // 对端已经断开；这里无需再报告。
        }
        return false
      }
      try {
        res.write(frame)
        return true
      } catch {
        open = false
        return false
      }
    },
    close(): void {
      if (!open && res.writableEnded) return
      open = false
      res.removeListener('close', onClose)
      if (!res.writableEnded) {
        try {
          res.end()
        } catch {
          // 连接已经由对端断开；这里无需再报告。
        }
      }
    },
  }
}

/** `Last-Event-ID` 的解析结论：合法水位，或一个必须答 400 的原因。 */
export type LastEventIdResult =
  | { readonly ok: true; readonly value: number | undefined }
  | { readonly ok: false; readonly reason: string }

/**
 * 严格解析 `Last-Event-ID`。
 *
 * 非数字/负数/小数一律**报 400**，而不是"当成没带"从当前水位开始：
 * 后者会让一次笔误或代理改写静默变成"客户端以为自己在续传、实际丢了中间所有事件"。
 * 头部缺失或为空字符串是合法的"未声明"。
 */
export function parseLastEventId(raw: string | undefined): LastEventIdResult {
  if (raw === undefined || raw.length === 0) return { ok: true, value: undefined }
  if (!/^\d+$/.test(raw)) {
    return { ok: false, reason: 'Last-Event-ID 必须是非负十进制整数' }
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) {
    return { ok: false, reason: 'Last-Event-ID 超出安全整数范围' }
  }
  return { ok: true, value }
}

/** 编码一个 SSE 帧：持久事件带 `id:`（= seq），瞬态帧不带 `id`。 */
export function encodeSseFrame(event: {
  readonly seq?: number | undefined
  readonly type: string
  readonly data: unknown
}): string {
  const lines: string[] = []
  if (typeof event.seq === 'number') lines.push(`id: ${String(event.seq)}`)
  lines.push(`event: ${event.type}`)
  // JSON.stringify 不会产出裸换行，因此单行 data 是安全的；
  // 仍然显式 replace 一次，防止将来有人把值改成多行字符串。
  const payload = JSON.stringify(event.data ?? null).replace(/\n/g, '\\n')
  lines.push(`data: ${payload}`)
  return `${lines.join('\n')}\n\n`
}

/** 编码一个 SSE 帧：持久事件带 `id:`（= seq），瞬态帧不带 `id`。 */
