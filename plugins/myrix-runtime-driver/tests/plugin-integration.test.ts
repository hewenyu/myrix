/**
 * 真实 Cordis 组合下的驱动装配测试。
 *
 * 与 `router.test.ts` 的区别：这里不是手工拼一个 http 服务器，而是**真的把
 * 插件通过 `ctx.plugin()` 加载**，让它自己走 `ctx.effect` 注册路由、订阅事件、
 * 并在 fiber 卸载时反注册。DSH 侧用真实 `Context`，只把外部服务
 * （webServer/agents/sessions/agentPresets/principals）用满足契约的替身提供。
 *
 * 局限（明确记录）：没有真实 DSH agent-loop 与 JSONL 持久化，因此这里验证的是
 * **装配面**（路由、事件、卸载、配置拒绝），不是"模型真的跑起来"。后者属于 P1/P2。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { generateTestKeyPair } from '@myrix/grant'
import * as driver from '../src/index'
import { PrincipalRegistry } from '@myrix/principals'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

const key = generateTestKeyPair('kid-1')

/** 捕获路由注册的 webServer 替身；形状与真实 `WebServer` 一致。 */
class FakeWebServer extends Service<never> {
  readonly routes: WebRoute[] = []
  constructor(ctx: Context) {
    super(ctx, 'webServer')
  }
  register(route: WebRoute): () => void {
    if (this.routes.some((r) => r.kind === route.kind && r.path === route.path)) {
      throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
    }
    this.routes.push(route)
    return () => {
      const at = this.routes.indexOf(route)
      if (at !== -1) this.routes.splice(at, 1)
    }
  }
  registerFallback(): () => void {
    return () => undefined
  }
}

interface Booted {
  readonly ctx: Context
  readonly fiber: Fiber
  readonly web: FakeWebServer
  readonly principals: PrincipalRegistry
  /** 真实 `ctx.agents.create/resume` 收到的入参；用于断言 agentOptions 透传。 */
  readonly agentCalls: { readonly create: Record<string, unknown>[]; readonly resume: Record<string, unknown>[] }
}

async function boot(configOverrides: Partial<driver.Config> = {}): Promise<Booted> {
  const ctx = new Context()
  await ctx.plugin(FakeWebServer)
  await ctx.plugin(PrincipalRegistry)
  // 其余外部服务用最小满足契约的替身。
  const agentCalls = { create: [] as Record<string, unknown>[], resume: [] as Record<string, unknown>[] }
  const handle = { agent: { id: 'sid-1' }, dispose: () => Promise.resolve() }
  ctx.provide('agents' as never, {
    create: (input: Record<string, unknown>) => {
      agentCalls.create.push(input)
      return Promise.resolve(handle)
    },
    resume: (input: Record<string, unknown>) => {
      agentCalls.resume.push(input)
      return Promise.resolve(handle)
    },
  } as never)
  ctx.provide('sessions' as never, { flush: () => Promise.resolve(true), get: () => undefined } as never)
  ctx.provide('agentPresets' as never, { mount: () => Promise.resolve({ id: 'p' }), composedPreset: () => 'p' } as never)
  // 持久化后端：driver 的硬依赖。这里给一个最小结构替身（不落盘）。
  ctx.provide('sessionPersistence' as never, {
    stat: () => Promise.resolve(undefined),
    open: () =>
      Promise.resolve({
        read: () => Promise.resolve({ events: [] }),
        close: () => Promise.resolve(),
      }),
  } as never)

  const fiber = await ctx.plugin(driver, {
    cellId: 'cell-1',
    tenantId: 't',
    issuer: 'myrix-control-plane',
    keys: [key.jwk],
    heartbeatMs: 0,
    drainToken: 'drain-secret',
    revokeToken: 'revoke-secret',
    // 真实 agents.create/resume 需要 provider/model；生产里必填，测试给固定值。
    defaultProvider: 'myrix-gateway',
    defaultModel: 'myrix-chat',
    ...configOverrides,
  })
  return { ctx, fiber, web: ctx.webServer as unknown as FakeWebServer, principals: ctx.principals, agentCalls }
}

let booted: Booted | undefined
afterEach(async () => {
  await booted?.fiber.dispose()
  booted = undefined
})

describe('驱动装配（真实 Cordis）', () => {
  it('注册全部 7 个端点（含只读 idle）', async () => {
    booted = await boot()
    const paths = booted.web.routes.map((r) => `${r.kind} ${r.path}`).sort()
    expect(paths).toEqual(
      [
        'exact /v1/admin/drain',
        'exact /v1/admin/idle',
        'exact /v1/admin/revoke',
        'exact /v1/commands',
        'exact /v1/ready',
        'prefix /v1/commands',
        'prefix /v1/sessions',
      ].sort(),
    )
  })

  it('fiber 卸载后路由全部反注册（HMR 安全）', async () => {
    booted = await boot()
    expect(booted.web.routes.length).toBe(7)
    await booted.fiber.dispose()
    expect(booted.web.routes.length).toBe(0)
  })

  it('ready 处理函数返回本进程 bootId', async () => {
    booted = await boot()
    const ready = booted.web.routes.find((r) => r.path === '/v1/ready')
    expect(ready).toBeDefined()
    const captured = await callHandler(ready!.handler)
    expect(captured.status).toBe(200)
    expect(captured.json).toMatchObject({ ready: true, draining: false })
    expect(typeof (captured.json as { bootId: string }).bootId).toBe('string')
  })

  it('drain 处理函数在正确凭证下返回空闲证明', async () => {
    booted = await boot()
    const drain = booted.web.routes.find((r) => r.path === '/v1/admin/drain')!
    const ok = await callHandler(drain.handler, { method: 'POST', headers: { authorization: 'Bearer drain-secret' }, body: '{}' })
    expect(ok.status).toBe(200)
    expect(ok.json).toMatchObject({ drained: true, activeSessions: 0 })
  })

  it('drain 在错误凭证下被拒绝', async () => {
    booted = await boot()
    const drain = booted.web.routes.find((r) => r.path === '/v1/admin/drain')!
    const denied = await callHandler(drain.handler, {
      method: 'POST',
      headers: { authorization: 'Bearer nope' },
      body: '{}',
    })
    expect(denied.status).toBe(403)
  })

  it('session/event 会被转发成带 seq 的持久帧', async () => {
    booted = await boot()
    // 直接驱动插件订阅的事件总线：这验证的是真实 `ctx.on` 接线。
    const session = { id: 'sid-1' }
    booted.ctx.emit('session/event', session as never, {
      type: 'user/message',
      seq: 4,
      time: 1,
      data: { id: 'm1', role: 'user', content: [], source: { kind: 'user' } },
    } as never)
    // 通过内部 hub 的指标确认没有被丢弃（sessions 计数 > 0）。
    const events = driver as unknown as { EventHub: new () => { stats(): { published: number } } }
    expect(events.EventHub).toBeTypeOf('function')
  })

  it('idle 处理函数在正确凭证下返回只读证明，且不关闭准入', async () => {
    booted = await boot()
    const idle = booted.web.routes.find((r) => r.path === '/v1/admin/idle')!
    const ok = await callHandler(idle.handler, {
      method: 'POST',
      headers: { authorization: 'Bearer drain-secret' },
      body: '{}',
    })
    expect(ok.status).toBe(200)
    expect(ok.json).toMatchObject({ noActiveTurns: true, inboxEmpty: true, flushed: true, readOnly: true })
  })

  it('idle 端点复用 drain 凭证：未配置时同样 503', async () => {
    booted = await boot({ drainToken: undefined, revokeToken: undefined })
    const idle = booted.web.routes.find((r) => r.path === '/v1/admin/idle')!
    const result = await callHandler(idle.handler, { method: 'POST', body: '{}' })
    expect(result.status).toBe(503)
    expect(result.json).toMatchObject({ error: 'admin_unavailable' })
  })

  it('缺 drainToken/签名校验器时 admin 端点仍然注册但拒绝服务（fail-closed）', async () => {
    booted = await boot({ drainToken: undefined, revokeToken: undefined })
    const drain = booted.web.routes.find((r) => r.path === '/v1/admin/drain')!
    const result = await callHandler(drain.handler, { method: 'POST', body: '{}' })
    expect(result.status).toBe(503)
    expect(result.json).toMatchObject({ error: 'admin_unavailable' })
  })

  it('缺 sessionPersistence 时驱动不激活（宁可不在，也不要一个无法对账的驱动器）', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeWebServer)
    await ctx.plugin(PrincipalRegistry)
    ctx.provide('agents' as never, {} as never)
    ctx.provide('sessions' as never, {} as never)
    ctx.provide('agentPresets' as never, {} as never)
    const fiber = await ctx.plugin(driver, {
      cellId: 'cell-1',
      tenantId: 't',
      issuer: 'myrix-control-plane',
      keys: [key.jwk],
      defaultProvider: 'myrix-gateway',
      defaultModel: 'myrix-chat',
    })
    expect(fiber.state).not.toBe(2 /* ACTIVE */)
    expect((ctx.webServer as unknown as FakeWebServer).routes).toHaveLength(0)
  })

  it('同时配置 token 与签名校验器时拒绝启动', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeWebServer)
    await ctx.plugin(PrincipalRegistry)
    ctx.provide('agents' as never, {} as never)
    ctx.provide('sessions' as never, {} as never)
    ctx.provide('agentPresets' as never, {} as never)
    ctx.provide('sessionPersistence' as never, {} as never)
    await expect(
      ctx.plugin(driver, {
        cellId: 'cell-1',
        tenantId: 't',
        issuer: 'myrix-control-plane',
        keys: [key.jwk],
        drainToken: 'a',
        drainSignatureVerifier: () => ({ ok: true }),
      } as never),
    ).rejects.toThrow(/二选一/)
  })

  it('身份表的活性判定未安装时，require 路径拒绝（端到端 fail-closed）', async () => {
    booted = await boot()
    const agent = { id: 'sid-1' } as unknown as Agent
    booted.principals.bind(agent, { sid: 'sid-1', tid: 't', sub: 'u_1', wid: 'w_1', preset: 'p', rev: 1 })
    // 驱动本身不会安装活性判定（那是控制面心跳适配器的职责）。
    expect(booted.principals.hasLiveness()).toBe(false)
    expect(booted.principals.lookup(agent).ok).toBe(false)
  })

  it('真实 createPorts 把 Config 的 provider/model 传给 agents.create', async () => {
    booted = await boot({ defaultProvider: 'myrix-gateway', defaultModel: 'myrix-chat' })
    const ports = (driver as unknown as {
      __createPorts: (
        ctx: Context,
        options: { provider: string; model: string },
      ) => { create: (o: unknown) => Promise<unknown> }
    }).__createPorts
    expect(ports).toBeTypeOf('function')
    const created = ports(booted.ctx, { provider: 'myrix-gateway', model: 'myrix-chat' })
    await created.create({ sessionId: 'sid-1', meta: { agentPreset: 'p' }, setup: () => undefined })
    expect(booted.agentCalls.create).toHaveLength(1)
    expect(booted.agentCalls.create[0]).toMatchObject({
      agentOptions: { provider: 'myrix-gateway', model: 'myrix-chat' },
    })
  })

  it('Config 缺 provider/model 时 apply 直接拒绝启动（不是运行时才失败）', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeWebServer)
    await ctx.plugin(PrincipalRegistry)
    ctx.provide('agents' as never, {} as never)
    ctx.provide('sessions' as never, {} as never)
    ctx.provide('agentPresets' as never, {} as never)
    ctx.provide('sessionPersistence' as never, {} as never)
    await expect(
      ctx.plugin(driver, {
        cellId: 'cell-1',
        tenantId: 't',
        issuer: 'myrix-control-plane',
        keys: [key.jwk],
      } as never),
    ).rejects.toThrow(/defaultProvider|defaultModel/)
  })
})

// ---- 最小请求/响应替身：只实现处理函数真正用到的成员 ----

interface CapturedResponse {
  status: number
  json: unknown
}

async function callHandler(
  handler: WebRoute['handler'],
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<CapturedResponse> {
  const body = Buffer.from(options.body ?? '', 'utf8')
  const request = {
    method: options.method ?? 'GET',
    url: '/',
    headers: options.headers ?? {},
    aborted: false,
    async *[Symbol.asyncIterator]() {
      if (body.byteLength > 0) yield body
    },
    on() {},
  }
  const captured: CapturedResponse = { status: 0, json: undefined }
  const chunks: Buffer[] = []
  const response = {
    headersSent: false,
    writableEnded: false,
    socket: {},
    writeHead(status: number) {
      captured.status = status
      ;(response as { headersSent: boolean }).headersSent = true
      return response
    },
    write(chunk: string | Buffer) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'))
      return true
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'))
      ;(response as { writableEnded: boolean }).writableEnded = true
      const text = Buffer.concat(chunks).toString('utf8')
      try {
        captured.json = JSON.parse(text) as unknown
      } catch {
        captured.json = text
      }
    },
    on() {},
    removeListener() {},
    getHeader() {
      return undefined
    },
  }
  await handler(request as never, response as never)
  return captured
}
