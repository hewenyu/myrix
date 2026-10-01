/**
 * 下载层的测试：不跟随重定向、有界响应体、abort、失败信息不泄露正文与 token。
 *
 * `ScriptedFetch` 真的实现 `AbortSignal` 与流式读取，所以这里测到的是行为，
 * 不是调用参数。
 */
import { describe, expect, it } from 'vitest'
import { fetchSnapshot } from '../src/index'
import { ScriptedFetch, TEST_TOKEN, hangingResponse } from './harness'

const url = 'https://works.internal:8443/internal/v1/cells/cell-1/bindings'

function options(scripted: ScriptedFetch, overrides: Partial<Parameters<typeof fetchSnapshot>[0]> = {}) {
  return {
    url,
    token: TEST_TOKEN,
    maxResponseBytes: 1_024,
    signal: new AbortController().signal,
    fetch: scripted.fetch,
    ...overrides,
  }
}

describe('fetchSnapshot 请求形状', () => {
  it('只发 accept/authorization，且不跟随重定向', async () => {
    const scripted = new ScriptedFetch()
    scripted.respondJson({ cellId: 'cell-1', tenantId: 't', bindings: [] })
    await fetchSnapshot(options(scripted))
    const request = scripted.requests[0]
    expect(request?.url).toBe(url)
    expect(request?.redirect).toBe('manual')
    expect(request?.headers).toEqual({
      accept: 'application/json',
      authorization: `Bearer ${TEST_TOKEN}`,
    })
  })
})

describe('fetchSnapshot 拒绝面', () => {
  it('拒绝 3xx（不把 Bearer 带去别的 origin）', async () => {
    const scripted = new ScriptedFetch()
    scripted.respond(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }))
    const result = await fetchSnapshot(options(scripted))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.rejection).toBe('redirect')
  })

  it('非 200 只报状态码，绝不回显上游正文', async () => {
    const scripted = new ScriptedFetch()
    scripted.respond(() => new Response('internal db url postgres://secret', { status: 500 }))
    const result = await fetchSnapshot(options(scripted))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.rejection).toBe('http-status')
      expect(result.failure.detail).toBe('作品服务返回 HTTP 500')
      expect(result.failure.detail).not.toContain('postgres')
    }
  })

  it('content-length 预检超限即拒绝', async () => {
    const scripted = new ScriptedFetch()
    scripted.respond(() => new Response('{}', { status: 200, headers: { 'content-length': '999999' } }))
    const result = await fetchSnapshot(options(scripted))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.rejection).toBe('too-large')
  })

  it('流式读取超限立刻中止，不把整个响应读进内存', async () => {
    const scripted = new ScriptedFetch()
    let pulled = 0
    scripted.respond(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 1
              controller.enqueue(new Uint8Array(512))
              // 永不 close：没有上限就会一直读下去。
            },
          }),
          { status: 200 },
        ),
    )
    const result = await fetchSnapshot(options(scripted, { maxResponseBytes: 2_048 }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.rejection).toBe('too-large')
    // 读到超过上限就该停：不该出现"读到几十次"。
    expect(pulled).toBeLessThan(12)
  })

  it('读取预算内的响应原样返回字节', async () => {
    const scripted = new ScriptedFetch()
    scripted.respondJson({ cellId: 'cell-1', tenantId: 't', bindings: [] })
    const result = await fetchSnapshot(options(scripted))
    expect(result.ok).toBe(true)
    if (result.ok) expect(new TextDecoder().decode(result.body)).toContain('cellId')
  })

  it('abort 收敛成 aborted，不抛出', async () => {
    const scripted = new ScriptedFetch()
    const controller = new AbortController()
    scripted.respond((_request, signal) => hangingResponse(signal))
    const pending = fetchSnapshot(options(scripted, { signal: controller.signal }))
    controller.abort(new Error('scope unloaded'))
    const result = await pending
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.rejection).toBe('aborted')
  })

  it('网络异常收敛成 network，且不含 URL/token', async () => {
    const scripted = new ScriptedFetch()
    scripted.respond(() => {
      throw new TypeError(`fetch failed for ${url}`)
    })
    const result = await fetchSnapshot(options(scripted))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.rejection).toBe('network')
      expect(result.failure.detail).toBe('请求失败：TypeError')
      expect(result.failure.detail).not.toContain(TEST_TOKEN)
    }
  })
})
