/**
 * 有界、无重定向的快照下载。
 *
 * 这里的每一条限制都对应一个具体攻击/故障面：
 *
 * - `redirect: 'manual'` + 显式 3xx 拒绝：**不跟随重定向**。跟随即意味着
 *   作品服务的响应可以把 Bearer token 带去另一个 origin。
 * - `content-length` 预检 + 流式字节上限：不允许对端用一个无限响应把
 *   Cell 的内存吃干；超限立刻 `cancel()` 请求体。
 * - 只发 `accept` / `authorization` 两个头，不 `credentials: 'include'`，
 *   不带 cookie，不发 referer。
 * - 超时与 scope 卸载都走 `AbortSignal`，卸载时在途请求必须被取消，
 *   不留悬空 promise。
 * - 错误信息只包含状态码/阶段，**绝不包含响应正文**（正文可能含别的租户数据。
 *
 * @module @myrix/binding-lease/fetch
 */

import type { SnapshotRejection } from './types'

/** 单次下载的失败。 */
export interface FetchFailure {
  readonly rejection: SnapshotRejection
  readonly detail: string
}

export type FetchResult = { readonly ok: true; readonly body: Uint8Array } | { readonly ok: false; readonly failure: FetchFailure }

/** 注入点：默认真实 `fetch`；测试里换成行为真实的替身。 */
export type Fetcher = typeof fetch

export interface FetchOptions {
  readonly url: string
  readonly token: string
  readonly maxResponseBytes: number
  readonly signal: AbortSignal
  readonly fetch: Fetcher
}

function statusDetail(status: number): string {
  // 只回状态码：上游正文可能包含其他租户的数据或凭据片段。
  return `作品服务返回 HTTP ${status}`
}

/**
 * 读取有界响应体。
 *
 * 返回 `Uint8Array`；超限返回失败并取消流。
 */
async function readBounded(response: Response, maxBytes: number): Promise<{ ok: true; body: Uint8Array } | { ok: false; failure: FetchFailure }> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const parsed = Number(declared)
    if (Number.isSafeInteger(parsed) && parsed > maxBytes) {
      await response.body?.cancel().catch(() => undefined)
      return { ok: false, failure: { rejection: 'too-large', detail: `响应声明 ${parsed} 字节，超过上限` } }
    }
  }
  if (response.body === null) {
    return { ok: true, body: new Uint8Array(0) }
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined)
        return { ok: false, failure: { rejection: 'too-large', detail: '响应超过上限' } }
      }
      chunks.push(part.value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ok: true, body }
}

/**
 * 下载一次快照。
 *
 * 不抛异常：所有失败都收敛成 `FetchFailure`，让调用方只有一条失败路径
 * （清空缓存）。
 */
export async function fetchSnapshot(options: FetchOptions): Promise<FetchResult> {
  let response: Response
  try {
    response = await options.fetch(options.url, {
      method: 'GET',
      // 明确不跟随重定向：跟随意昧着 token 可能被带到别的 origin。
      redirect: 'manual',
      cache: 'no-store',
      signal: options.signal,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${options.token}`,
      },
    })
  } catch (error) {
    if (options.signal.aborted) {
      return { ok: false, failure: { rejection: 'aborted', detail: '请求已取消' } }
    }
    // 只保留异常类型名：底层错误可能带 URL（含 token 的话不会，但保持习惯）。
    return { ok: false, failure: { rejection: 'network', detail: `请求失败：${error instanceof Error ? error.name : 'unknown'}` } }
  }

  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined)
    return { ok: false, failure: { rejection: 'redirect', detail: '作品服务返回重定向，拒绝跟随' } }
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined)
    return { ok: false, failure: { rejection: 'http-status', detail: statusDetail(response.status) } }
  }

  try {
    return await readBounded(response, options.maxResponseBytes)
  } catch (error) {
    if (options.signal.aborted) {
      return { ok: false, failure: { rejection: 'aborted', detail: '请求已取消' } }
    }
    return { ok: false, failure: { rejection: 'network', detail: `读取响应失败：${error instanceof Error ? error.name : 'unknown'}` } }
  }
}
