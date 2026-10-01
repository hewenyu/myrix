/**
 * 路由与 HTTP 边界的测试：端点形状、admin 认证（不允许匿名）、
 * 原始正文摘要绑定、SSE 准入。
 *
 * 这里用一个最小的 `node:http` 服务器把路由真的跑起来，验证"线上行为"
 * 而不是"函数返回值"。不引入测试框架的 HTTP 替身。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createGrantSigner, createGrantVerifier, generateTestKeyPair, sha256Hex } from '@myrix/grant'
import type { GrantOperation } from '@myrix/grant'
import { SessionController, type ControllerHost } from '../src/controller'
import { EventHub } from '../src/events'
import { createRouter, DRIVER_ENDPOINTS } from '../src/router'
import { createFakeRuntime } from './fake-dsh'

function principalFor(sid: string): {
  sid: string
  tid: string
  sub: string
  wid: string
  preset: string
  rev: number
} {
  return { sid, tid: 't', sub: 'u_1', wid: 'w_1', preset: 'p', rev: 1 }
}

function fakeHost(options: { principals?: (sid: string) => ReturnType<typeof principalFor> | undefined } = {}) {
  const revoked = new Set<string>()
  const resolve = (sid: string) => {
    const principal = options.principals === undefined ? principalFor(sid) : options.principals(sid)
    return principal === undefined
      ? ({ ok: false, reason: 'not-bound', detail: `sid ${sid} 未绑定` } as const)
      : ({ ok: true, principal } as const)
  }
  const host: ControllerHost = {
    lookupPrincipal: (agent) => resolve(String((agent as { id?: unknown } | undefined)?.id ?? 'sid-1')),
    lookupPrincipalBySession: (sid) => resolve(sid),
    revoke: (request) => {
      if (revoked.has(request.sid) && request.rev <= 1) return { accepted: false, reason: 'stale' }
      revoked.add(request.sid)
      return { accepted: true, reason: 'accepted' }
    },
    isRevoked: (sid) => revoked.has(sid),
    highWaterRev: () => (revoked.size > 0 ? 1 : 0),
  }
  return { host, revoked }
}

const NOW = 1_790_000_000
const key = generateTestKeyPair('kid-1')

interface Running {
  readonly url: string
  readonly close: () => Promise<void>
  readonly controller: SessionController
  readonly hub: EventHub
  readonly revoked: Set<string>
  readonly runtime: ReturnType<typeof createFakeRuntime>
}

async function start(
  options: {
    drainToken?: string
    revokeToken?: string
    maxBodyBytes?: number
    sseMaxBufferedBytes?: number
    generation?: number
  } = {},
): Promise<Running> {
  const runtime = createFakeRuntime()
  const { host, revoked } = fakeHost()
  const verifier = createGrantVerifier({
    audience: 'cell-1',
    tenantId: 't',
    bootId: 'boot-1',
    startedAt: NOW - 100,
    issuer: 'myrix-control-plane',
    keys: [key.jwk],
    clock: () => NOW,
  })
  const controller = new SessionController(runtime.ports, host, verifier, 'boot-1')
  const hub = new EventHub()
  const router = createRouter(controller, hub, {
    tenantId: 't',
    bootId: 'boot-1',
    heartbeatMs: 0,
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
    ...(options.sseMaxBufferedBytes === undefined ? {} : { sseMaxBufferedBytes: options.sseMaxBufferedBytes }),
    ...(options.generation === undefined ? {} : { generation: options.generation }),
    ...(options.drainToken === undefined ? {} : { drainAuth: { kind: 'bearer' as const, token: options.drainToken } }),
    ...(options.revokeToken === undefined ? {} : { revokeAuth: { kind: 'bearer' as const, token: options.revokeToken } }),
  })
  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname
      for (const route of router.routes) {
        const matches =
          route.kind === 'exact' ? path === route.path : path === route.path || path.startsWith(`${route.path}/`)
        if (matches) {
          await route.handler(req, res)
          return
        }
      }
      res.writeHead(404)
      res.end()
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${String(port)}`,
    controller,
    hub,
    revoked,
    runtime,
    close: async () => {
      router.dispose()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

let running: Running | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

function issueCreate(body: string, commandId = 'c1', sid = 'sid-1') {
  const signer = createGrantSigner({ privateKey: key.privateKey, kid: 'kid-1', issuer: 'myrix-control-plane', clock: () => NOW })
  return signer.issue({
    aud: 'cell-1', boot: 'boot-1', tid: 't', sid, sub: 'u_1', wid: 'w_1',
    preset: 'p', rev: 1, op: 'create', cmd: commandId, rawBody: body,
  }).token
}

/** 签一枚指定 op 的凭证；正文摘要按实际字节算。 */
function issueFor(op: 'create' | 'resume' | 'send' | 'cancel', body: string, commandId: string) {
  const signer = createGrantSigner({ privateKey: key.privateKey, kid: 'kid-1', issuer: 'myrix-control-plane', clock: () => NOW })
  return signer.issue({
    aud: 'cell-1', boot: 'boot-1', tid: 't', sid: 'sid-1', sub: 'u_1', wid: 'w_1',
    preset: 'p', rev: 1, op, cmd: commandId, rawBody: body,
  }).token
}

/** 签一枚 `op=subscribe` 的凭证；事件流的正文摘要是空串。 */
function issueSubscribe(sid = 'sid-1') {
  const signer = createGrantSigner({ privateKey: key.privateKey, kid: 'kid-1', issuer: 'myrix-control-plane', clock: () => NOW })
  return signer.issue({
    aud: 'cell-1', boot: 'boot-1', tid: 't', sid, sub: 'u_1', wid: 'w_1',
    preset: 'p', rev: 1, op: 'subscribe', cmd: `subscribe-${sid}`, rawBody: '',
  }).token
}

describe('端点清单', () => {
  it('是技术方案 §3.2 的 6 个端点 + cell-manager 需要的只读空闲证明', () => {
    expect(DRIVER_ENDPOINTS.map((e) => `${e.method} ${e.path}`)).toEqual([
      'POST /v1/commands',
      'GET /v1/commands/:commandId',
      'GET /v1/sessions/:sid/events',
      'POST /v1/admin/drain',
      'POST /v1/admin/idle',
      'POST /v1/admin/revoke',
      'GET /v1/ready',
    ])
  })
})

describe('POST /v1/commands', () => {
  it('合法命令返回 accepted 回执', async () => {
    running = await start()
    const body = JSON.stringify({ op: 'create', sid: 'sid-1', commandId: 'c1' })
    const res = await fetch(`${running.url}/v1/commands`, {
      method: 'POST',
      headers: { authorization: `Bearer ${issueCreate(body)}` },
      body,
    })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ status: 'accepted', commandId: 'c1', bootId: 'boot-1' })
  })

  it('GET 方法被拒绝（405）', async () => {
    running = await start()
    const res = await fetch(`${running.url}/v1/commands`)
    expect(res.status).toBe(405)
  })

  it('缺凭证返回 401，且不回显任何 token 内容', async () => {
    running = await start()
    const res = await fetch(`${running.url}/v1/commands`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
    const payload = (await res.json()) as { error: string; reason: string }
    expect(payload.error).toBe('grant_missing')
    expect(JSON.stringify(payload)).not.toContain('Bearer')
  })

  it('正文超过上限返回 413', async () => {
    // 配置一个很小的上限，避免测试真的传几 MB（行为与生产上限一致）。
    running = await start({ maxBodyBytes: 64 })
    const huge = JSON.stringify({ op: 'create', sid: 'sid-1', commandId: 'c1', text: 'x'.repeat(4096) })
    const res = await fetch(`${running.url}/v1/commands`, {
      method: 'POST',
      headers: { authorization: `Bearer ${issueCreate(huge)}` },
      body: huge,
    })
    expect(res.status).toBe(413)
  })

  it('非法 JSON 返回 400', async () => {
    running = await start()
    const res = await fetch(`${running.url}/v1/commands`, {
      method: 'POST',
      headers: { authorization: `Bearer ${issueCreate('not json')}` },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })

  it('正文被换掉时返回 403 且不含 token', async () => {
    running = await start()
    const signed = JSON.stringify({ op: 'create', sid: 'sid-1', commandId: 'c1' })
    const tampered = JSON.stringify({ op: 'create', sid: 'sid-1', commandId: 'c1', text: 'x' })
    const res = await fetch(`${running.url}/v1/commands`, {
      method: 'POST',
      headers: { authorization: `Bearer ${issueCreate(signed)}` },
      body: tampered,
    })
    expect(res.status).toBe(403)
    const text = await res.text()
    expect(text).toContain('grant/body-hash-mismatch')
    expect(text).not.toContain('.')
  })
})

describe('GET /v1/commands/:id（必须真的验签，不能只 parse Bearer）', () => {
  /** 签一枚回执凭证：op=subscribe、cmd=receipt-<id>、bh=sha256("")。 */
  function issueReceipt(commandId: string, sid = 'sid-1', op: GrantOperation = 'subscribe', cmd?: string) {
    const signer = createGrantSigner({ privateKey: key.privateKey, kid: 'kid-1', issuer: 'myrix-control-plane', clock: () => NOW })
    return signer.issue({
      aud: 'cell-1', boot: 'boot-1', tid: 't', sid, sub: 'u_1', wid: 'w_1',
      preset: 'p', rev: 1, op, cmd: cmd ?? `receipt-${commandId}`, rawBody: Buffer.alloc(0),
    }).token
  }

  /** 发一条 create 命令，返回其 commandId。 */
  async function createCommand(url: string, commandId = 'c1', sid = 'sid-1'): Promise<void> {
    const body = JSON.stringify({ op: 'create', sid, commandId })
    const res = await fetch(`${url}/v1/commands`, {
      method: 'POST',
      headers: { authorization: `Bearer ${issueCreate(body, commandId, sid)}` },
      body,
    })
    expect(res.status).toBe(200)
  }

  it('原 POST 的凭证被消费后，用**新签的**回执凭证可以查到回执', async () => {
    running = await start()
    await createCommand(running.url)
    // POST 用过的那枚凭证已经被一次性消费；GET 必须换一枚新凭证。
    const res = await fetch(`${running.url}/v1/commands/c1`, {
      headers: { authorization: `Bearer ${issueReceipt('c1')}` },
    })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ status: 'accepted', commandId: 'c1', bootId: 'boot-1' })
  })

  it('重放同一枚 GET 凭证 → 403 grant/replayed（jti 一次性）', async () => {
    running = await start()
    await createCommand(running.url)
    const token = issueReceipt('c1')
    const first = await fetch(`${running.url}/v1/commands/c1`, { headers: { authorization: `Bearer ${token}` } })
    expect(first.status).toBe(200)
    const second = await fetch(`${running.url}/v1/commands/c1`, { headers: { authorization: `Bearer ${token}` } })
    expect(second.status).toBe(403)
    await expect(second.json()).resolves.toMatchObject({ code: 'grant/replayed' })
  })

  it('cmd 指向别的命令 → 403（换 id 不生效）', async () => {
    running = await start()
    await createCommand(running.url)
    const res = await fetch(`${running.url}/v1/commands/c1`, {
      // 凭证是为 c2 签的：`cmd` 与路径不一致。
      headers: { authorization: `Bearer ${issueReceipt('c2')}` },
    })
    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({ code: 'grant/operation-mismatch' })
  })

  it('bh 不是空正文摘要 → 403', async () => {
    running = await start()
    await createCommand(running.url)
    const signer = createGrantSigner({ privateKey: key.privateKey, kid: 'kid-1', issuer: 'myrix-control-plane', clock: () => NOW })
    const token = signer.issue({
      aud: 'cell-1', boot: 'boot-1', tid: 't', sid: 'sid-1', sub: 'u_1', wid: 'w_1',
      preset: 'p', rev: 1, op: 'subscribe', cmd: 'receipt-c1', rawBody: 'not-empty',
    }).token
    const res = await fetch(`${running.url}/v1/commands/c1`, { headers: { authorization: `Bearer ${token}` } })
    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({ code: 'grant/body-hash-mismatch' })
  })

  it('伪造/乱写的 Bearer → 403，不是 404（不能拿状态码探测存在性）', async () => {
    running = await start()
    await createCommand(running.url)
    const res = await fetch(`${running.url}/v1/commands/c1`, { headers: { authorization: 'Bearer whatever' } })
    expect(res.status).toBe(403)
  })

  it('别人的凭证查不到我的回执 → 404 no_receipt（不泄露其他 sid 的回执存在性）', async () => {
    running = await start()
    await createCommand(running.url, 'c1', 'sid-1')
    // sid-2 的身份在表里是活的，但回执属于 sid-1。
    const res = await fetch(`${running.url}/v1/commands/c1`, {
      headers: { authorization: `Bearer ${issueReceipt('c1', 'sid-2')}` },
    })
    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toMatchObject({ code: 'no_receipt' })
  })

  it('未知回执 → 404 no_receipt', async () => {
    running = await start()
    const res = await fetch(`${running.url}/v1/commands/unknown`, {
      headers: { authorization: `Bearer ${issueReceipt('unknown')}` },
    })
    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toMatchObject({ code: 'no_receipt' })
  })

  it('op 不是 subscribe（复用 create 凭证）→ 403', async () => {
    running = await start()
    await createCommand(running.url)
    const res = await fetch(`${running.url}/v1/commands/c1`, {
      headers: { authorization: `Bearer ${issueReceipt('c1', 'sid-1', 'create')}` },
    })
    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({ code: 'grant/operation-mismatch' })
  })

  it('撤权后回执查询被拒 → 403 session_revoked', async () => {
    running = await start()
    await createCommand(running.url)
    running.revoked.add('sid-1')
    const res = await fetch(`${running.url}/v1/commands/c1`, {
      headers: { authorization: `Bearer ${issueReceipt('c1')}` },
    })
    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({ code: 'session_revoked' })
  })

  it('缺凭证时返回 401（回执表不能被匿名枚举）', async () => {
    running = await start()
    const res = await fetch(`${running.url}/v1/commands/c1`)
    expect(res.status).toBe(401)
  })

  it('畸形百分号编码 → 400，不抛未处理异常', async () => {
    running = await start()
    const res = await fetch(`${running.url}/v1/commands/%E0%A4%A`, {
      headers: { authorization: `Bearer ${issueReceipt('x')}` },
    })
    expect(res.status).toBe(400)
  })
})

describe('错误保密：不回显插件/上游异常文本', () => {
  it('open_failed 的 reason 不含上游异常原文（可能含 prompt/secrets）', async () => {
    running = await start()
    running.runtime.failOpen = 'SECRET prompt text: sk-live-abc123'
    const body = JSON.stringify({ op: 'create', sid: 'sid-1', commandId: 'c1' })
    const res = await fetch(`${running.url}/v1/commands`, {
      method: 'POST',
      headers: { authorization: `Bearer ${issueCreate(body)}` },
      body,
    })
    expect(res.status).toBe(502)
    const text = await res.text()
    expect(text).toContain('open_failed')
    expect(text).not.toContain('SECRET')
    expect(text).not.toContain('sk-live-abc123')
  })

  it('followup_failed 的 reason 不含上游异常原文', async () => {
    running = await start()
    const create = JSON.stringify({ op: 'create', sid: 'sid-1', commandId: 'c1' })
    await fetch(`${running.url}/v1/commands`, {
      method: 'POST',
      headers: { authorization: `Bearer ${issueCreate(create)}` },
      body: create,
    })
    const agent = running.runtime.agents.get('sid-1')!
    agent.followup = () => {
      throw new Error('SECRET delivery detail')
    }
    const send = JSON.stringify({ op: 'send', sid: 'sid-1', commandId: 'c2', text: 'hi' })
    const res = await fetch(`${running.url}/v1/commands`, {
      method: 'POST',
      headers: { authorization: `Bearer ${issueFor('send', send, 'c2')}` },
      body: send,
    })
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).toContain('followup_failed')
    expect(text).not.toContain('SECRET')
    expect(text).not.toContain('delivery detail')
  })
})

describe('GET /v1/ready', () => {
  it('未排空时 200 并带 bootId 与 draining:false', async () => {
    running = await start()
    const res = await fetch(`${running.url}/v1/ready`)
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ ready: true, bootId: 'boot-1', draining: false })
  })

  it('排空后返回 503 且 ready:false', async () => {
    running = await start()
    await running.controller.drain()
    const res = await fetch(`${running.url}/v1/ready`)
    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toMatchObject({ ready: false, draining: true })
  })
})

describe('POST /v1/admin/drain', () => {
  it('未配置认证时端点不可用（503），不允许匿名排空', async () => {
    running = await start()
    const res = await fetch(`${running.url}/v1/admin/drain`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toMatchObject({ error: 'admin_unavailable' })
  })

  it('配置认证后，错误凭证被拒绝（403）', async () => {
    running = await start({ drainToken: 'secret-token' })
    const res = await fetch(`${running.url}/v1/admin/drain`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong' },
      body: '{}',
    })
    expect(res.status).toBe(403)
  })

  it('正确凭证下完成排空并返回空闲证明', async () => {
    running = await start({ drainToken: 'secret-token' })
    const res = await fetch(`${running.url}/v1/admin/drain`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret-token' },
      body: '{}',
    })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ drained: true, bootId: 'boot-1', activeSessions: 0 })
  })

  it('drain 成功时给出 noActiveTurns/inboxEmpty/flushed 与 readOnly', async () => {
    running = await start({ drainToken: 'secret-token', generation: 3 })
    const res = await fetch(`${running.url}/v1/admin/drain`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret-token' },
      body: '{}',
    })
    await expect(res.json()).resolves.toMatchObject({
      drained: true,
      readOnly: true,
      noActiveTurns: true,
      inboxEmpty: true,
      flushed: true,
      generation: 3,
    })
  })

  it('drain 被拒时带精确 rejectionCode，而不是笼统的 ack', async () => {
    running = await start({ drainToken: 'secret-token' })
    const body = JSON.stringify({ op: 'create', sid: 'sid-1', commandId: 'c1' })
    await fetch(`${running.url}/v1/commands`, {
      method: 'POST',
      headers: { authorization: `Bearer ${issueCreate(body)}` },
      body,
    })
    const agent = running.runtime.agents.get('sid-1')!
    // 未消费的 inbox：拒绝码必须是 InboxNotEmpty。
    ;(agent.inbox.nextTurn as unknown[]).push({ id: 'pending' })
    const res = await fetch(`${running.url}/v1/admin/drain`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret-token' },
      body: '{}',
    })
    // 200 + drained:false：拒绝码必须能被 Go 客户端读到，否则只会报 DriverUnavailable。
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      drained: false,
      rejectionCode: 'InboxNotEmpty',
      inboxEmpty: false,
    })
  })

  it('排空后 ready 变成 503', async () => {
    running = await start({ drainToken: 'secret-token' })
    await fetch(`${running.url}/v1/admin/drain`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret-token' },
      body: '{}',
    })
    const res = await fetch(`${running.url}/v1/ready`)
    expect(res.status).toBe(503)
  })
})

describe('POST /v1/admin/idle（只读空闲证明）', () => {
  it('未配置认证时端点不可用（503），不允许匿名', async () => {
    running = await start()
    const res = await fetch(`${running.url}/v1/admin/idle`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toMatchObject({ error: 'admin_unavailable' })
  })

  it('错误凭证被拒绝（403）', async () => {
    running = await start({ drainToken: 'secret-token' })
    const res = await fetch(`${running.url}/v1/admin/idle`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong' },
      body: '{}',
    })
    expect(res.status).toBe(403)
  })

  it('空闲时返回 cell-manager 契约要求的全部字段', async () => {
    running = await start({ drainToken: 'secret-token', generation: 7 })
    const res = await fetch(`${running.url}/v1/admin/idle`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret-token' },
      body: '{}',
    })
    expect(res.status).toBe(200)
    const proof = (await res.json()) as Record<string, unknown>
    expect(proof).toMatchObject({
      bootId: 'boot-1',
      noActiveTurns: true,
      inboxEmpty: true,
      flushed: true,
      readOnly: true,
      generation: 7,
    })
    expect(typeof proof['proofId']).toBe('string')
    // 时间戳是 RFC3339，可被 Go 端 time.Time 解析。
    expect(new Date(String(proof['observedAt'])).toString()).not.toBe('Invalid Date')
    expect(new Date(String(proof['lastCommandAt'])).toString()).not.toBe('Invalid Date')
  })

  it('不配置 generation 时响应里没有该字段（不猜值）', async () => {
    running = await start({ drainToken: 'secret-token' })
    const res = await fetch(`${running.url}/v1/admin/idle`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret-token' },
      body: '{}',
    })
    const proof = (await res.json()) as Record<string, unknown>
    expect('generation' in proof).toBe(false)
  })

  it('查询空闲证明**不关闭准入**：紧接着的命令仍然被接受', async () => {
    running = await start({ drainToken: 'secret-token' })
    const idle = await fetch(`${running.url}/v1/admin/idle`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret-token' },
      body: '{}',
    })
    expect(idle.status).toBe(200)
    expect(running.controller.accepting).toBe(true)
    // ready 仍然是 200（没有被 idle 查询变成 draining）。
    const ready = await fetch(`${running.url}/v1/ready`)
    expect(ready.status).toBe(200)
  })

  it('有命令在途时带精确拒绝码返回（不伪造 ack）', async () => {
    running = await start({ drainToken: 'secret-token' })
    const body = JSON.stringify({ op: 'create', sid: 'sid-1', commandId: 'c1' })
    await fetch(`${running.url}/v1/commands`, {
      method: 'POST',
      headers: { authorization: `Bearer ${issueCreate(body)}` },
      body,
    })
    // 模拟"轮次还在跑"：直接改替身 agent 的同步 status。
    const agent = running.runtime.agents.get('sid-1')
    expect(agent).toBeDefined()
    agent!.status = 'running'
    const res = await fetch(`${running.url}/v1/admin/idle`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret-token' },
      body: '{}',
    })
    // 200 + 真实字段：非 2xx 会让 cell-manager 的客户端把"忙"误判成"驱动不可达"。
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      noActiveTurns: false,
      flushed: false,
      rejectionCode: 'ActiveTurns',
      readOnly: true,
    })
    // 查询没有把 cell 关掉。
    expect(running.controller.accepting).toBe(true)
  })
})

describe('POST /v1/admin/revoke', () => {
  it('未配置认证时端点不可用（503）', async () => {
    running = await start()
    const res = await fetch(`${running.url}/v1/admin/revoke`, { method: 'POST', body: '{"sid":"s","rev":1}' })
    expect(res.status).toBe(503)
  })

  it('正确凭证下撤权成功', async () => {
    running = await start({ revokeToken: 'revoke-token' })
    const res = await fetch(`${running.url}/v1/admin/revoke`, {
      method: 'POST',
      headers: { authorization: 'Bearer revoke-token' },
      body: JSON.stringify({ sid: 'sid-1', rev: 5, reason: '成员被移除' }),
    })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ accepted: true, sid: 'sid-1' })
    expect(running.revoked.has('sid-1')).toBe(true)
  })

  it('缺 sid 或 rev 非法时返回 400', async () => {
    running = await start({ revokeToken: 'revoke-token' })
    for (const body of ['{}', '{"sid":"s"}', '{"sid":"s","rev":-1}', '{"sid":"s","rev":1.5}']) {
      const res = await fetch(`${running.url}/v1/admin/revoke`, {
        method: 'POST',
        headers: { authorization: 'Bearer revoke-token' },
        body,
      })
      expect(res.status).toBe(400)
    }
  })

  it('签名信封模式：校验通过才放行，且校验器拿到的是原始字节', async () => {
    const { host } = fakeHost()
    const runtime = createFakeRuntime()
    const verifier = createGrantVerifier({
      audience: 'cell-1', tenantId: 't', bootId: 'boot-1', startedAt: NOW - 100,
      issuer: 'myrix-control-plane', keys: [key.jwk], clock: () => NOW,
    })
    const controller = new SessionController(runtime.ports, host, verifier, 'boot-1')
    const hub = new EventHub()
    const seen: { hash: string; header: string | undefined }[] = []
    const router = createRouter(controller, hub, {
      tenantId: 't',
      bootId: 'boot-1',
      heartbeatMs: 0,
      revokeAuth: {
        kind: 'verifier',
        header: 'x-myrix-sig',
        verify: (raw, header) => {
          seen.push({ hash: sha256Hex(raw), header })
          return header === 'good' ? { ok: true } : { ok: false, reason: 'bad signature' }
        },
      },
    })
    const server: Server = createServer((req, res) => {
      void (async () => {
        const path = new URL(req.url ?? '/', 'http://x').pathname
        for (const route of router.routes) {
          const matches =
            route.kind === 'exact' ? path === route.path : path === route.path || path.startsWith(`${route.path}/`)
          if (matches) {
            await route.handler(req, res)
            return
          }
        }
        res.writeHead(404)
        res.end()
      })()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const url = `http://127.0.0.1:${String(port)}`
    try {
      const body = JSON.stringify({ sid: 'sid-1', rev: 1, reason: 'r' })
      const denied = await fetch(`${url}/v1/admin/revoke`, {
        method: 'POST',
        headers: { 'x-myrix-sig': 'bad' },
        body,
      })
      expect(denied.status).toBe(403)
      const allowed = await fetch(`${url}/v1/admin/revoke`, {
        method: 'POST',
        headers: { 'x-myrix-sig': 'good' },
        body,
      })
      expect(allowed.status).toBe(200)
      // 校验器收到的是**实际字节**的摘要，而不是重新序列化的结果。
      expect(seen[1]?.hash).toBe(sha256Hex(Buffer.from(body, 'utf8')))
      expect(seen[1]?.header).toBe('good')
    } finally {
      router.dispose()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe('GET /v1/sessions/:sid/events', () => {
  it('缺凭证时返回 401（事件流不能匿名读）', async () => {
    running = await start()
    const res = await fetch(`${running.url}/v1/sessions/sid-1/events`)
    expect(res.status).toBe(401)
  })

  it('未知路径返回 404', async () => {
    running = await start()
    const res = await fetch(`${running.url}/v1/sessions/sid-1/nope`, {
      headers: { authorization: 'Bearer x' },
    })
    expect(res.status).toBe(404)
  })

  it('非法 Last-Event-ID 返回 400，而不是被当成"初始订阅"', async () => {
    running = await start()
    const res = await fetch(`${running.url}/v1/sessions/sid-1/events`, {
      headers: { authorization: `Bearer ${issueSubscribe()}`, 'last-event-id': 'not-a-number' },
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({
      error: 'malformed_request',
      code: 'malformed_last_event_id',
    })
  })

  it('op 不是 subscribe 的凭证被拒绝', async () => {
    running = await start()
    const signer = createGrantSigner({ privateKey: key.privateKey, kid: 'kid-1', issuer: 'myrix-control-plane', clock: () => NOW })
    const token = signer.issue({
      aud: 'cell-1', boot: 'boot-1', tid: 't', sid: 'sid-1', sub: 'u_1', wid: 'w_1',
      preset: 'p', rev: 1, op: 'create', cmd: 'subscribe-sid-1', rawBody: '',
    })
    const res = await fetch(`${running.url}/v1/sessions/sid-1/events`, {
      headers: { authorization: `Bearer ${token.token}` },
    })
    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({ code: 'grant/operation-mismatch' })
  })
})
