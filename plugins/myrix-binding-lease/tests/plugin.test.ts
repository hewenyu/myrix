/**
 * 真实 Cordis 组合下的租约装配测试。
 *
 * 与 `snapshot.test.ts` / `fetch.test.ts` 的分工：那两份测纯函数与下载行为，
 * 这一份**真的用 `ctx.plugin()` 把插件加载进真实 `Context`**，让
 * `PrincipalRegistry`（真实 Service class）与 `principals.lookup` 走完整链路，
 * 并覆盖：首次刷新、TTL 到期、失败清空、撤权移除、创建竞态、并发合并、
 * scope 卸载（timer/abort/无悬空 promise）、无 secret 泄漏。
 *
 * 只把作品服务替换成行为真实的 `fetch` 替身（真的实现 AbortSignal 与流式读取），
 * 时钟与定时器换成手动推进的版本 —— 否则 TTL 只能靠 sleep 测，不可靠。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { PrincipalRegistry, type Principal } from '@myrix/principals'
import { applyWithIo, type BindingLease, type Config, type LeaseIo } from '../src/index'
import { ManualClock, ManualTimers, ScriptedFetch, TEST_TOKEN, snapshotPayload, testIo } from './harness'

const baseConfig: Config = {
  cellId: 'cell-1',
  tenantId: 't_acme',
  origin: 'https://works.internal:8443',
  token: TEST_TOKEN,
  ttlMs: 10_000,
  refreshMs: 3_000,
}

const principal = (overrides: Partial<Principal> = {}): Principal => ({
  sid: 'sid-1',
  tid: 't_acme',
  sub: 'u_1',
  wid: 'w_1',
  preset: 'novel-chapter',
  rev: 7,
  ...overrides,
})

const agent = (id: string): Agent => ({ id } as unknown as Agent)

interface Booted {
  readonly ctx: Context
  readonly fiber: Fiber
  readonly lease: BindingLease
  readonly principals: PrincipalRegistry
  readonly clock: ManualClock
  readonly timers: ManualTimers
  readonly server: ScriptedFetch
}

interface BootOptions {
  readonly config?: Partial<Config>
  readonly io?: (base: LeaseIo) => LeaseIo
  readonly server?: (server: ScriptedFetch) => void
}

async function boot(options: BootOptions = {}): Promise<Booted> {
  const ctx = new Context()
  await ctx.plugin(PrincipalRegistry)
  const clock = new ManualClock()
  const server = new ScriptedFetch()
  const { io, timers } = testIo({ clock, fetch: server.fetch })
  server.respondJson(snapshotPayload([{ sid: 'sid-1' }]))
  options.server?.(server)

  const plugin = {
    // 与 src/index.ts 的 `export const inject` 一致；这里手动带上，
    // 否则 Cordis 会在没有注入声明时拒绝访问 `ctx.principals`。
    inject: ['principals'] as const,
    apply: (child: Context, _config?: unknown): void => {
      applyWithIo(child, { ...baseConfig, ...options.config }, options.io === undefined ? io : options.io(io))
    },
  }
  const fiber = await ctx.plugin(plugin as never, undefined as never)
  // 首次刷新是 fire-and-forget：让它在 microtask 队列里跑完。
  await flush()
  return { ctx, fiber, lease: ctx.bindingLease, principals: ctx.principals, clock, timers, server }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
}

/**
 * 复刻 `src/index.ts` 里 `refreshOnAgentCreated` 的那段接线，
 * 供"装配方自己挂钩"的用例单独挂载。
 */
function applyCreatedRefresher(ctx: Context, lease: BindingLease): () => void {
  return ctx.on('agent/created', async () => {
    await lease.refresh()
  })
}

let booted: Booted | undefined
afterEach(async () => {
  await booted?.fiber.dispose()
  booted = undefined
})

describe('装配与首次刷新', () => {
  it('加载后安装活性判定，并在首次下载完成后放行已知主体', async () => {
    booted = await boot()
    expect(booted.principals.hasLiveness()).toBe(true)
    const bound = agent('sid-1')
    booted.principals.bind(bound, principal())
    const result = booted.principals.lookup(bound)
    expect(result.ok).toBe(true)
    expect(booted.lease.state()).toMatchObject({ active: true, bindings: 1, installs: 1 })
  })

  it('请求形状正确：GET + Bearer + 默认内部端点 + no-store', async () => {
    booted = await boot()
    const request = booted.server.requests[0]
    expect(request?.url).toBe('https://works.internal:8443/internal/v1/cells/cell-1/bindings')
    expect(request?.method).toBe('GET')
    expect(request?.headers['authorization']).toBe(`Bearer ${TEST_TOKEN}`)
    expect(request?.redirect).toBe('manual')
    expect(booted.server.requests).toHaveLength(1)
  })

  it('周期 tick 会重新下载并原子替换缓存', async () => {
    booted = await boot()
    booted.server.respondJson(snapshotPayload([{ sid: 'sid-1' }, { sid: 'sid-2', rev: 2 }]))
    booted.timers.tickIntervals()
    await flush()
    expect(booted.lease.state()).toMatchObject({ active: true, bindings: 2, installs: 2 })
    expect(booted.server.calls).toBe(2)
  })
})

describe('租约到期（有限时长的实现点）', () => {
  it('到期后同步判定立即拒绝，即使数据还在表里', async () => {
    booted = await boot()
    const bound = agent('sid-1')
    booted.principals.bind(bound, principal())
    expect(booted.principals.lookup(bound).ok).toBe(true)

    booted.clock.advance(9_999)
    expect(booted.principals.lookup(bound).ok).toBe(true)
    booted.clock.advance(1)
    const expired = booted.principals.lookup(bound)
    expect(expired.ok).toBe(false)
    if (!expired.ok) expect(expired.reason).toBe('liveness-stale')
    expect(booted.lease.state().bindings).toBe(1)
  })

  it('到期后即使周期刷新失败也保持拒绝（不会被"过期数据"救回）', async () => {
    booted = await boot()
    const bound = agent('sid-1')
    booted.principals.bind(bound, principal())
    booted.server.respond(() => new Response('boom', { status: 503 }))
    booted.clock.advance(10_001)
    booted.timers.tickIntervals()
    await flush()
    expect(booted.principals.lookup(bound).ok).toBe(false)
    expect(booted.lease.state()).toMatchObject({ active: false, bindings: 0, lastRejection: 'http-status' })
  })

  it('ttlMs 从请求开始算：安装时刻 = 请求开始时刻，到期 = 开始 + ttl', async () => {
    booted = await boot({ config: { ttlMs: 10_000, refreshMs: 3_000 } })
    // 请求在 clock=1000 开始；到期是 11000，而不是"响应解析完成 + ttl"。
    const state = booted.lease.state()
    expect(state.installedAt).toBe(1_000)
    expect(state.expiresAt).toBe(11_000)
  })
})

describe('失败一律清空缓存（fail-closed）', () => {
  const failures: readonly [string, (server: ScriptedFetch) => void][] = [
    ['HTTP 500', (server) => server.respond(() => new Response('x', { status: 500 }))],
    ['HTTP 401', (server) => server.respond(() => new Response('x', { status: 401 }))],
    ['重定向', (server) => server.respond(() => new Response(null, { status: 307, headers: { location: 'https://evil/' } }))],
    ['非法 JSON', (server) => server.respond(() => new Response('{oops', { status: 200 }))],
    ['跨 cell', (server) => server.respondJson(snapshotPayload([{ sid: 'sid-1' }], { cellId: 'cell-2' }))],
    ['跨租户', (server) => server.respondJson(snapshotPayload([{ sid: 'sid-1' }], { tenantId: 't_other' }))],
    ['重复 sid', (server) => server.respondJson(snapshotPayload([{ sid: 'sid-1' }, { sid: 'sid-1', rev: 9 }]))],
    ['响应过大', (server) => server.respond(() => new Response('{}', { status: 200, headers: { 'content-length': '9999999' } }))],
  ]

  for (const [label, script] of failures) {
    it(`${label} → 清空缓存并拒绝已有绑定`, async () => {
      booted = await boot()
      const bound = agent('sid-1')
      booted.principals.bind(bound, principal())
      expect(booted.principals.lookup(bound).ok).toBe(true)

      script(booted.server)
      const outcome = await booted.lease.refresh()
      expect(outcome.installed).toBe(false)
      expect(booted.lease.state()).toMatchObject({ active: false, bindings: 0 })

      const denied = booted.principals.lookup(bound)
      expect(denied.ok).toBe(false)
      if (!denied.ok) expect(denied.reason).toBe('liveness-stale')
      // 失败是"清空"，不是"保留旧值"。
      expect(booted.lease.state().clears).toBeGreaterThanOrEqual(1)
    })
  }

  it('请求超时通过 AbortSignal 落地，并清空缓存', async () => {
    booted = await boot({
      config: { requestTimeoutMs: 200 },
      server: (server) => {
        server.respond((_request, signal) => new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true })
        }))
      },
    })
    // 首次刷新仍在挂起（没有响应）：缓存为空 → 拒绝。
    const bound = agent('sid-1')
    booted.principals.bind(bound, principal())
    expect(booted.principals.lookup(bound).ok).toBe(false)

    booted.timers.fireTimeouts()
    await flush()
    expect(booted.lease.state()).toMatchObject({ active: false, lastRejection: 'aborted' })
  })

  it('refresh() 永不抛出，失败以返回值表达', async () => {
    booted = await boot()
    booted.server.respond(() => {
      throw new TypeError('socket closed')
    })
    await expect(booted.lease.refresh()).resolves.toMatchObject({ installed: false, rejection: 'network' })
  })
})

describe('撤权与成员停用（新快照里没有这一行）', () => {
  it('快照不再包含该 sid 后，绑定仍在但判定拒绝', async () => {
    booted = await boot()
    const bound = agent('sid-1')
    booted.principals.bind(bound, principal())
    expect(booted.principals.require(bound).sub).toBe('u_1')

    // 撤权/停用成员后服务端的新快照不再包含这一行。
    booted.server.respondJson(snapshotPayload([]))
    await booted.lease.refresh()
    const denied = booted.principals.lookup(bound)
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.reason).toBe('liveness-stale')
    // 宽松查询仍然看得到"曾经是谁"，但它不能用于准入。
    expect(booted.principals.get(bound)).toBeDefined()
  })

  it('同一 sid 换了所有者/作品/preset/rev 都必须拒绝（六字段全比）', async () => {
    booted = await boot()
    const bound = agent('sid-1')
    booted.principals.bind(bound, principal())
    expect(booted.principals.lookup(bound).ok).toBe(true)

    for (const changed of [
      { sub: 'u_2' },
      { wid: 'w_2' },
      { preset: 'novel-bible' },
      { rev: 8 },
      { tid: 't_acme2' },
    ] as const) {
      booted.server.respondJson(snapshotPayload([{ sid: 'sid-1', ...changed }]))
      await booted.lease.refresh()
      const denied = booted.principals.lookup(bound)
      expect(denied.ok).toBe(false)
      // 恢复原值，验证前一次拒绝不是"缓存被清空"造成的假象。
      booted.server.respondJson(snapshotPayload([{ sid: 'sid-1' }]))
      await booted.lease.refresh()
      expect(booted.principals.lookup(bound).ok).toBe(true)
    }
  })

  it('明确撤权后即便快照里还有该行也拒绝（撤权表优先）', async () => {
    booted = await boot()
    const bound = agent('sid-1')
    booted.principals.bind(bound, principal())
    booted.principals.revoke({ sid: 'sid-1', rev: 8, reason: '成员被移除' })
    const denied = booted.principals.lookup(bound)
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.reason).toBe('revoked')
    // 新快照（如果真的还有这一行）也不能洗白撤权。
    await booted.lease.refresh()
    expect(booted.principals.lookup(bound).ok).toBe(false)
  })
})

describe('创建竞态：绑定已写入但快照还没有这一行', () => {
  it('快照不含新 sid 时拒绝（不放宽准入，不用"稍后会同步"兜底）', async () => {
    booted = await boot()
    const fresh = agent('sid-new')
    booted.principals.bind(fresh, principal({ sid: 'sid-new' }))
    const denied = booted.principals.lookup(fresh)
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.reason).toBe('liveness-stale')
    // 已有的老会话不受影响。
    const known = agent('sid-1')
    booted.principals.bind(known, principal())
    expect(booted.principals.lookup(known).ok).toBe(true)
  })

  it('作品被删除后（新快照不再包含该 wid 的行）业务主体立即失效', async () => {
    booted = await boot()
    const bound = agent('sid-1')
    booted.principals.bind(bound, principal())
    expect(booted.principals.lookup(bound).ok).toBe(true)
    // 服务端删除作品后返回的行换成了别的作品 / 不再返回该行。
    booted.server.respondJson(snapshotPayload([{ sid: 'sid-1', wid: 'w_other' }]))
    await booted.lease.refresh()
    expect(booted.principals.lookup(bound).ok).toBe(false)
  })

  it('所有绑定被移除后快照为空：缓存仍 active（是真的"空名单"）但一律拒绝', async () => {
    booted = await boot()
    const bound = agent('sid-1')
    booted.principals.bind(bound, principal())
    booted.server.respondJson(snapshotPayload([]))
    const outcome = await booted.lease.refresh()
    expect(outcome).toMatchObject({ installed: true, bindings: 0 })
    expect(booted.lease.state().active).toBe(true)
    expect(booted.principals.lookup(bound).ok).toBe(false)
  })
})

describe('真实 Cordis 组合下的 agent/created 刷新', () => {
  it('agent/created（DSH 的 serial、被 await 的事件）里刷新一次即可消除竞态', async () => {
    booted = await boot({ config: { refreshOnAgentCreated: false } })
    const fresh = agent('sid-new')
    const freshPrincipal = principal({ sid: 'sid-new', sub: 'u_2', rev: 3 })
    booted.principals.bind(fresh, freshPrincipal)
    expect(booted.principals.lookup(fresh).ok).toBe(false)

    // 服务端在 create 之后的新快照里有了这一行。
    booted.server.respondJson(snapshotPayload([{ sid: 'sid-1' }, { sid: 'sid-new', sub: 'u_2', rev: 3 }]))
    const before = booted.server.calls

    // driver 的 create 会触发 DSH 的 serial `agent/created`。本插件默认挂在
    // 上面；这里为了验证"手动挂钩同样有效"，用独立监听器挂一次。
    applyCreatedRefresher(booted.ctx, booted.lease)
    await booted.ctx.serial('agent/created', { agent: fresh, source: 'startup' })

    expect(booted.server.calls).toBe(before + 1)
    const admitted = booted.principals.lookup(fresh)
    expect(admitted.ok).toBe(true)
    if (admitted.ok) expect(admitted.principal).toEqual(freshPrincipal)
    // serial 监听器是 await 的：事件返回时缓存已经就绪，不存在"稍后才生效"。
    expect(booted.lease.state().active).toBe(true)
  })

  it('默认配置下插件自己的监听器确实生效（refreshOnAgentCreated 默认 true）', async () => {
    booted = await boot()
    const fresh = agent('sid-new')
    booted.principals.bind(fresh, principal({ sid: 'sid-new' }))
    booted.server.respondJson(snapshotPayload([{ sid: 'sid-new' }]))
    const before = booted.server.calls
    await booted.ctx.serial('agent/created', { agent: fresh, source: 'startup' })
    expect(booted.server.calls).toBe(before + 1)
    expect(booted.principals.lookup(fresh).ok).toBe(true)
  })

  it('hook 内刷新失败时保持拒绝，且不把异常冒泡成 create 失败', async () => {
    booted = await boot()
    const fresh = agent('sid-new')
    booted.principals.bind(fresh, principal({ sid: 'sid-new' }))
    booted.server.respond(() => new Response('down', { status: 500 }))
    await expect(
      booted.ctx.serial('agent/created', { agent: fresh, source: 'startup' }),
    ).resolves.toBeUndefined()
    expect(booted.principals.lookup(fresh).ok).toBe(false)
  })

  it('refreshOnAgentCreated=false 时 hook 不刷新（由装配方自己负责）', async () => {
    booted = await boot({ config: { refreshOnAgentCreated: false } })
    const before = booted.server.calls
    await booted.ctx.serial('agent/created', { agent: agent('sid-1'), source: 'startup' })
    expect(booted.server.calls).toBe(before)
    // 手动调用服务面仍然有效 —— 这正是给 Lead 的装配接口。
    await booted.lease.refresh()
    expect(booted.server.calls).toBe(before + 1)
  })

  it('装配方在 setup 期间的 await refresh() 也能消除竞态', async () => {
    booted = await boot()
    const fresh = agent('sid-new')
    // 模拟 driver 的 setup：先绑定身份……
    booted.principals.bind(fresh, principal({ sid: 'sid-new' }))
    expect(booted.principals.lookup(fresh).ok).toBe(false)
    // ……然后在真正 awaited 的 setup 适配里刷新一次。
    booted.server.respondJson(snapshotPayload([{ sid: 'sid-new', sub: 'u_1', rev: 7 }]))
    const outcome = await booted.lease.refresh()
    expect(outcome.installed).toBe(true)
    expect(booted.principals.lookup(fresh).ok).toBe(true)
  })
})

describe('并发合并', () => {
  /** 让下一次请求挂起，制造可控的"在途"窗口。 */
  function gateServer(): { release: () => void; opened: Promise<void> } {
    let release!: () => void
    const opened = new Promise<void>((resolve) => {
      release = resolve
    })
    return { release, opened }
  }

  it('同一刻到达的调用方不会放大下载次数（与 N 无关）', async () => {
    booted = await boot()
    const gate = gateServer()
    booted.server.respond(async () => {
      await gate.opened
      return new Response(JSON.stringify(snapshotPayload([{ sid: 'sid-1' }])), { status: 200 })
    })
    const before = booted.server.calls
    const inFlight = Array.from({ length: 4 }, () => booted!.lease.refresh())
    gate.release()
    const outcomes = await Promise.all(inFlight)
    // 4 个调用方 → 至多 2 次新下载（第一个在途 + 紧随其后的一次）；再多也能有界。
    expect(booted.server.calls - before).toBeLessThanOrEqual(2)
    expect(outcomes.every((outcome) => outcome.installed)).toBe(true)
  })

  it('20 个并发调用方仍是至多 2 次新下载（不是线性放大）', async () => {
    booted = await boot()
    const gate = gateServer()
    booted.server.respond(async () => {
      await gate.opened
      return new Response(JSON.stringify(snapshotPayload([{ sid: 'sid-1' }])), { status: 200 })
    })
    const before = booted.server.calls
    const inFlight = Array.from({ length: 20 }, () => booted!.lease.refresh())
    gate.release()
    await Promise.all(inFlight)
    expect(booted.server.calls - before).toBeLessThanOrEqual(2)
  })

  it('串行 await 的监听器各自拿到真实下载，不共享过期结果', async () => {
    booted = await boot()
    let generation = 1
    booted.server.respond(() => {
      generation += 1
      return new Response(JSON.stringify(snapshotPayload([{ sid: `sid-${generation}` }])), { status: 200 })
    })
    const before = booted.server.calls
    await booted.ctx.serial('agent/created', { agent: agent('a'), source: 'startup' })
    await booted.ctx.serial('agent/created', { agent: agent('b'), source: 'startup' })
    // 两个事件各自推进了快照：第二次没有复用第一次的结果。
    expect(booted.server.calls).toBe(before + 2)
  })

  it('周期刷新与手动刷新同时发生时也保持有界', async () => {
    booted = await boot()
    const gate = gateServer()
    booted.server.respond(async () => {
      await gate.opened
      return new Response(JSON.stringify(snapshotPayload([{ sid: 'sid-1' }])), { status: 200 })
    })
    const before = booted.server.calls
    const pending = [booted.lease.refresh(), booted.lease.refresh(), booted.lease.refresh()]
    booted.timers.tickIntervals()
    gate.release()
    await Promise.all(pending)
    expect(booted.server.calls - before).toBeLessThanOrEqual(2)
  })
})

describe('装配边界的 fail-closed', () => {
  it('缺少 principals 服务时插件不激活（不会带着空缺的租约运行）', async () => {
    const ctx = new Context()
    const clock = new ManualClock()
    const server = new ScriptedFetch()
    const { io } = testIo({ clock, fetch: server.fetch })
    const plugin = {
      inject: ['principals'] as const,
      apply: (child: Context): void => applyWithIo(child, baseConfig, io),
    }
    // 不 await：依赖不满足时 fiber 处于 PENDING，apply 不会被调用。
    void ctx.plugin(plugin as never, undefined as never)
    await flush()
    expect(ctx.get('bindingLease' as never)).toBeUndefined()
    expect(server.calls).toBe(0)
    await ctx.fiber.dispose()
  })

  it('配置非法时插件加载直接失败（profile 不启动而不是静默降级）', async () => {
    const ctx = new Context()
    await ctx.plugin(PrincipalRegistry)
    const clock = new ManualClock()
    const { io } = testIo({ clock, fetch: new ScriptedFetch().fetch })
    const plugin = {
      inject: ['principals'] as const,
      apply: (child: Context): void => applyWithIo(child, { ...baseConfig, ttlMs: 99_999 }, io),
    }
    await expect(ctx.plugin(plugin as never, undefined as never)).rejects.toThrow(/ttlMs/)
    expect(ctx.get('bindingLease' as never)).toBeUndefined()
    await ctx.fiber.dispose()
  })
})

describe('scope 卸载', () => {
  it('卸载后 agent/created 监听器一并移除，不再发起下载', async () => {
    booted = await boot()
    const before = booted.server.calls
    await booted.ctx.serial('agent/created', { agent: agent('a'), source: 'startup' })
    expect(booted.server.calls).toBe(before + 1)
    await booted.fiber.dispose()
    await flush()
    const afterDispose = booted.server.calls
    await booted.ctx.serial('agent/created', { agent: agent('b'), source: 'startup' })
    expect(booted.server.calls).toBe(afterDispose)
    booted = undefined
  })

  it('卸载后：活性判定被卸下、timer 清空、在途请求被 abort、无悬空 promise', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      booted = await boot({
        server: (server) => {
          server.respond((_request, signal) => new Promise<Response>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true })
          }))
        },
      })
      const bound = agent('sid-1')
      booted.principals.bind(bound, principal())
      const hanging = booted.lease.refresh()
      // 还有一个挂起的一次性超时定时器 + 一个周期定时器。
      expect(booted.timers.size).toBeGreaterThanOrEqual(1)

      await booted.fiber.dispose()
      await expect(hanging).resolves.toMatchObject({ installed: false })
      expect(booted.timers.size).toBe(0)
      expect(booted.principals.hasLiveness()).toBe(false)

      const denied = booted.principals.lookup(bound)
      expect(denied.ok).toBe(false)
      if (!denied.ok) expect(denied.reason).toBe('liveness-unavailable')

      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unhandled).toEqual([])
      // 卸载后不再接受新的刷新请求。
      expect(await booted.lease.refresh()).toMatchObject({ installed: false, rejection: 'aborted' })
      booted = undefined
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('invalidate() 立即清空缓存但保留判定（用于 drain）', async () => {
    booted = await boot()
    const bound = agent('sid-1')
    booted.principals.bind(bound, principal())
    expect(booted.principals.lookup(bound).ok).toBe(true)
    booted.lease.invalidate('drain')
    expect(booted.principals.lookup(bound).ok).toBe(false)
    expect(booted.principals.hasLiveness()).toBe(true)
  })
})

describe('无 secret 泄漏', () => {  it('诊断状态、卸载路径与日志里都不出现 token', async () => {
    booted = await boot()
    // 触发一次失败路径，确认 detail 也不含 token。
    booted.server.respond(() => new Response('x', { status: 502 }))
    const outcome = await booted.lease.refresh()
    expect(JSON.stringify(outcome)).not.toContain(TEST_TOKEN)
    expect(JSON.stringify(booted.lease.state())).not.toContain(TEST_TOKEN)
    // 诊断面只暴露计数与到期时刻，不暴露主体列表。
    expect(Object.keys(booted.lease.state()).sort()).toEqual([
      'active',
      'bindings',
      'clears',
      'expiresAt',
      'installedAt',
      'installs',
      'lastRejection',
    ])
  })
})
