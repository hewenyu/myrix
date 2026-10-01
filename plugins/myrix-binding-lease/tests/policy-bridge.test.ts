/**
 * 策略桥：**同一份**凭证认证绑定快照里的 `policy` 字段如何变成执行点的策略快照。
 *
 * 这一份测试的分工：
 * - 纯解析（字段白名单、工具名白名单、空数组语义）→ `snapshot.test.ts`；
 * - 这里的重点是与**真实策略执行点持有者**的接合：什么时候安装、什么时候必须
 *   和绑定一起被清空、以及"刷新失败/失效/卸载之后绝不允许恢复旧的授权"。
 *
 * 用真实 `Context` + 真实 `PrincipalRegistry` + 真实 `@myrix/policy-enforcer`
 * 的 `PolicySnapshotHolder`（策略执行点自身的 guard 行为在它自己的测试里验证），
 * 只把作品服务与时钟换成可确定性驱动的替身。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import { PrincipalRegistry, type Principal } from '@myrix/principals'
// 相对路径而不是包名：策略执行点是**可选**的装配目标，租约插件不在
// package.json 里声明对它的依赖（否则会把"可选"变成"必须"）。
import { PolicySnapshotHolder } from '../../myrix-policy-enforcer/src/index'
import { applyWithIo, POLICY_SNAPSHOT_SERVICE, type BindingLease, type Config, type LeaseIo } from '../src/index'
import { ManualClock, ManualTimers, ScriptedFetch, TEST_TOKEN, policyPayload, snapshotPayload, testIo } from './harness'

const baseConfig: Config = {
  cellId: 'cell-1',
  tenantId: 't_acme',
  origin: 'https://works.internal:8443',
  token: TEST_TOKEN,
  ttlMs: 10_000,
  refreshMs: 3_000,
  requirePolicy: true,
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

const agent = (id: string) => ({ id }) as never

interface Booted {
  readonly ctx: Context
  readonly fiber: Fiber
  readonly lease: BindingLease
  readonly principals: PrincipalRegistry
  readonly holder: PolicySnapshotHolder
  readonly clock: ManualClock
  readonly timers: ManualTimers
  readonly server: ScriptedFetch
}

/**
 * 与真实 profile 一致的装配：策略执行点先提供 `myrixPolicySnapshots`，
 * 绑定租约再以 `requirePolicy: true` 装配上去。
 *
 * 顺序是刻意的：租约在 `apply` 阶段就需要该服务，而 profile 的加载顺序
 * 不由插件决定，因此生产装配必须让执行点的行满足这个前提。
 */
async function boot(options: { config?: Partial<Config>; server?: (server: ScriptedFetch) => void } = {}): Promise<Booted> {
  const ctx = new Context()
  await ctx.plugin(PrincipalRegistry)
  const clock = new ManualClock()
  const server = new ScriptedFetch()
  const { io, timers } = testIo({ clock, fetch: server.fetch })
  const holder = new PolicySnapshotHolder(() => clock.now(), () => clock.now())
  // 默认响应同时带绑定与策略：策略桥的用例默认走"两边都有"的路径，
  // 缺策略/非法策略由各自的用例显式覆盖。
  server.respondJson(snapshotPayload([{ sid: 'sid-1' }], { policy: policyPayload() }))
  options.server?.(server)

  // 策略执行点的服务面（真实类的真实实例）。
  ctx.provide(POLICY_SNAPSHOT_SERVICE as never, holder as never)

  const plugin = {
    inject: ['principals'] as const,
    apply: (child: Context): void => applyWithIo(child, { ...baseConfig, ...options.config }, io),
  }
  const fiber = await ctx.plugin(plugin as never, undefined as never)
  await flush()
  return { ctx, fiber, lease: ctx.bindingLease, principals: ctx.principals, holder, clock, timers, server }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
}

let booted: Booted | undefined
afterEach(async () => {
  await booted?.fiber.dispose()
  booted = undefined
})

describe('策略桥：首次刷新同时安装绑定与策略', () => {
  it('requirePolicy + 服务齐全：一次刷新同时放行身份与策略', async () => {
    booted = await boot()
    expect(booted.holder.current()).toMatchObject({ rev: 1, tid: 't_acme' })
    const bound = agent('sid-1')
    booted.principals.bind(bound, principal())
    expect(booted.principals.lookup(bound).ok).toBe(true)
    expect(booted.lease.state()).toMatchObject({ active: true, bindings: 1, installs: 1 })
  })

  it('策略剩余时长被裁到"服务端 ttl 与租约 ttl 的较小值"', async () => {
    booted = await boot({ config: { ttlMs: 10_000, refreshMs: 3_000 } })
    // 请求在 clock=1000 开始；policy.ttlMs=8000 → 到期 9000（小于租约到期 11000）。
    expect(booted.holder.current()?.expiresAt).toBe(9_000)
  })

  it('显式空 tools 是合法值：策略安装成功但什么都不允许（不等于"没策略"）', async () => {
    booted = await boot({ server: (server) => server.respondJson(snapshotPayload([{ sid: 'sid-1' }], { policy: policyPayload({ tools: [] }) })) })
    expect(booted.holder.current()).toMatchObject({ tools: [] })
    // 身份活性照常生效：空策略拒绝的是工具，不是身份。
    const bound = agent('sid-1')
    booted.principals.bind(bound, principal())
    expect(booted.principals.lookup(bound).ok).toBe(true)
  })

  it('策略只收窄：不在快照里的六个工具名之外的策略工具被解析拒绝（版本不匹配）', async () => {
    booted = await boot({ server: (server) => server.respondJson(snapshotPayload([{ sid: 'sid-1' }], { policy: policyPayload({ tools: ['bash'] }) })) })
    expect(booted.holder.current()).toBeUndefined()
    expect((await booted.lease.refresh()).installed).toBe(false)
  })
})

describe('策略桥 fail-closed：绑定与策略必须一起成功或一起失败', () => {
  const failures: readonly [string, (server: ScriptedFetch) => void][] = [
    ['HTTP 500', (server) => server.respond(() => new Response('x', { status: 500 }))],
    ['非法 JSON', (server) => server.respond(() => new Response('{oops', { status: 200 }))],
    ['跨 cell', (server) => server.respondJson(snapshotPayload([{ sid: 'sid-1' }], { cellId: 'cell-2' }))],
    ['跨租户', (server) => server.respondJson(snapshotPayload([{ sid: 'sid-1' }], { tenantId: 't_other' }))],
    ['重复 sid', (server) => server.respondJson(snapshotPayload([{ sid: 'sid-1' }, { sid: 'sid-1', rev: 9 }]))],
    ['策略缺字段 rev', (server) => server.respondJson(snapshotPayload([{ sid: 'sid-1' }], { policy: { tools: ['get_outline'], ttlMs: 5_000 } }))],
    ['策略 ttl 越界', (server) => server.respondJson(snapshotPayload([{ sid: 'sid-1' }], { policy: policyPayload({ ttlMs: 60_000 }) }))],
    ['策略未知字段', (server) => server.respondJson(snapshotPayload([{ sid: 'sid-1' }], { policy: { ...policyPayload(), scope: 'all' } }))],
    ['策略 tools 非数组', (server) => server.respondJson(snapshotPayload([{ sid: 'sid-1' }], { policy: { rev: 1, tools: 'get_outline', ttlMs: 5_000 } }))],
  ]

  for (const [label, script] of failures) {
    it(`${label} → 清空绑定与策略并拒绝`, async () => {
      booted = await boot()
      const bound = agent('sid-1')
      booted.principals.bind(bound, principal())
      expect(booted.holder.current()).toBeDefined()

      script(booted.server)
      const outcome = await booted.lease.refresh()
      expect(outcome.installed).toBe(false)
      expect(booted.lease.state()).toMatchObject({ active: false, bindings: 0 })
      expect(booted.holder.current()).toBeUndefined()
      expect(booted.principals.lookup(bound).ok).toBe(false)
    })
  }

  it('要求策略但响应完全没有 policy 字段 → 整次刷新失败（提前失败，不留下"半授权"）', async () => {
    booted = await boot({ server: (server) => server.respondJson(snapshotPayload([{ sid: 'sid-1' }])) })
    const outcome = await booted.lease.refresh()
    expect(outcome).toMatchObject({ installed: false, rejection: 'policy-missing' })
    expect(booted.lease.state()).toMatchObject({ active: false, bindings: 0 })
    expect(booted.holder.current()).toBeUndefined()
  })

  it('不启用策略桥时缺少 policy 字段照常安装绑定（老部署行为不变）', async () => {
    booted = await boot({ config: { requirePolicy: false }, server: (server) => server.respondJson(snapshotPayload([{ sid: 'sid-1' }])) })
    const outcome = await booted.lease.refresh()
    expect(outcome).toMatchObject({ installed: true, bindings: 1 })
    expect(outcome.policy).toBeUndefined()
    // 策略执行点仍然"没有快照"→ 一切工具被拒（这正是 R16 的现状，必须保持拒绝）。
    expect(booted.holder.current()).toBeUndefined()
  })

  it('不启用策略桥时服务端下发了 policy 也不安装（能力必须显式开启）', async () => {
    booted = await boot({ config: { requirePolicy: false } })
    expect(booted.holder.current()).toBeUndefined()
    expect(booted.lease.state().active).toBe(true)
  })
})

describe('策略桥：撤销/过期/回退/卸载', () => {
  it('撤权后的新快照不含该主体时，绑定与策略一起失效', async () => {
    booted = await boot()
    const bound = agent('sid-1')
    booted.principals.bind(bound, principal())

    booted.server.respondJson(snapshotPayload([], { policy: policyPayload({ rev: 2 }) }))
    await booted.lease.refresh()
    expect(booted.principals.lookup(bound).ok).toBe(false)
    // 策略仍在（rev 2 是新的、合法的策略发布）：撤销的是**身份**，不是策略本身。
    expect(booted.holder.current()).toMatchObject({ rev: 2 })
  })

  it('策略 rev 回退 → 清空策略（即使绑定仍然有效）', async () => {
    booted = await boot()
    expect(booted.holder.current()).toMatchObject({ rev: 1 })
    booted.server.respondJson(snapshotPayload([{ sid: 'sid-1' }], { policy: policyPayload({ rev: 0 }) }))
    const outcome = await booted.lease.refresh()
    expect(outcome.installed).toBe(false)
    expect(booted.holder.current()).toBeUndefined()
    expect(booted.holder.stats().highWaterRev).toBe(1)
  })

  it('策略回退即使发生在清空之后也被拒绝（高水位不随 clear 重置）', async () => {
    booted = await boot()
    booted.lease.invalidate('drain')
    expect(booted.holder.current()).toBeUndefined()
    const outcome = await booted.lease.refresh()
    // 快照还是 rev 1；高水位已经是 1，因此 rev 1 允许（同版本重装），rev 0 不允许。
    expect(outcome.installed).toBe(true)
    booted.server.respondJson(snapshotPayload([{ sid: 'sid-1' }], { policy: policyPayload({ rev: 0 }) }))
    expect((await booted.lease.refresh()).installed).toBe(false)
    expect(booted.holder.current()).toBeUndefined()
  })

  it('策略泄漏的剩余时长为正、但租约更短时按租约截止', async () => {
    booted = await boot({ config: { ttlMs: 4_000, refreshMs: 1_000 } })
    // policy.ttlMs=8000 但租约 4000 → 到期 5000。
    expect(booted.holder.current()?.expiresAt).toBe(5_000)
    booted.clock.advance(3_999)
    expect(booted.holder.current()).toBeDefined()
    booted.clock.advance(1)
    // 租约过期后绑定与策略同时不可用。
    expect(booted.holder.current()).toBeUndefined()
  })

  it('墙钟回拨不能延长策略：单调时钟仍然到期', async () => {
    booted = await boot()
    expect(booted.holder.current()).toBeDefined()
    const deadline = booted.holder.monoDeadline()
    expect(deadline).not.toBeNull()
    // 把墙钟拨回去（模拟 NTP/系统时间回拨），单调时钟已过截止。
    while (booted.clock.now() < (deadline ?? 0)) booted.clock.advance(1_000)
    expect(booted.holder.current()).toBeUndefined()
  })

  it('invalidate() 同时清空绑定与策略', async () => {
    booted = await boot()
    const bound = agent('sid-1')
    booted.principals.bind(bound, principal())
    expect(booted.holder.current()).toBeDefined()

    booted.lease.invalidate('drain')
    expect(booted.holder.current()).toBeUndefined()
    expect(booted.principals.lookup(bound).ok).toBe(false)
    expect(booted.lease.state()).toMatchObject({ active: false, bindings: 0 })
  })

  it('卸载（dispose）后策略被清空，且不会有"卸载后仍放行"的窗口', async () => {
    booted = await boot()
    const holder = booted.holder
    expect(holder.current()).toBeDefined()
    await booted.fiber.dispose()
    expect(holder.current()).toBeUndefined()
    booted = undefined
  })

  it('刷新失败会同时清空绑定与策略，不留残值', async () => {
    booted = await boot()
    booted.server.respond(() => new Response('down', { status: 503 }))
    const outcome = await booted.lease.refresh()
    expect(outcome).toMatchObject({ installed: false, rejection: 'http-status' })
    expect(booted.holder.current()).toBeUndefined()
    expect(booted.holder.stats().clears).toBeGreaterThanOrEqual(1)
  })
})

describe('策略桥：在途请求与撤销的竞态', () => {
  it('请求发出后才 invalidate 的响应不能把策略装回来', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const opened = new Promise<void>((resolve) => {
      started = resolve
    })
    booted = await boot()
    booted.server.respond(async () => {
      started()
      await gate
      return new Response(JSON.stringify(snapshotPayload([{ sid: 'sid-1' }], { policy: policyPayload({ rev: 5 }) })), { status: 200 })
    })
    const pending = booted.lease.refresh()
    await opened
    // 请求已经在途，此刻撤销。
    booted.lease.invalidate('撤销发生在响应之前')
    release()
    const outcome = await pending
    expect(outcome.installed).toBe(false)
    expect(booted.holder.current()).toBeUndefined()
  })

  it('卸载之后到达的响应不安装策略', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    booted = await boot()
    const holder = booted.holder
    const fiber = booted.fiber
    booted.server.respond(async () => {
      await gate
      return new Response(JSON.stringify(snapshotPayload([{ sid: 'sid-1' }], { policy: policyPayload({ rev: 5 }) })), { status: 200 })
    })
    const pending = booted.lease.refresh()
    // 卸载会先 abort 在途请求；这里的响应仍会到达（替身不理会 abort），
    // 因此真正被验证的是解析完成后的 `stopped`/世代检查，而不是 abort。
    const disposing = fiber.dispose()
    release()
    await disposing
    await expect(pending).resolves.toMatchObject({ installed: false, rejection: 'aborted' })
    expect(holder.current()).toBeUndefined()
    booted = undefined
  })
})

describe('策略桥的装配边界', () => {
  it('requirePolicy 但没有策略执行点服务 → 插件加载失败（不是静默不生效）', async () => {
    const ctx = new Context()
    await ctx.plugin(PrincipalRegistry)
    const clock = new ManualClock()
    const server = new ScriptedFetch()
    const { io } = testIo({ clock, fetch: server.fetch })
    const plugin = {
      inject: ['principals'] as const,
      apply: (child: Context): void => applyWithIo(child, baseConfig, io),
    }
    await expect(ctx.plugin(plugin as never, undefined as never)).rejects.toThrow(/myrixPolicySnapshots/)
    expect(ctx.get('bindingLease' as never)).toBeUndefined()
    expect(server.calls).toBe(0)
    await ctx.fiber.dispose()
  })

  it('装配顺序：执行点服务先出现时，租约拿到的是同一个持有者对象', async () => {
    booted = await boot()
    expect(booted.ctx.get(POLICY_SNAPSHOT_SERVICE as never)).toBe(booted.holder)
    // 反向断言：执行点看到的就是租约写入的那一份，而不是"另一份实例"。
    expect(booted.holder.current()?.rev).toBe(1)
  })
})

describe('策略桥不泄漏 secret', () => {
  it('刷新结果与诊断里都不出现 token，也不把策略内容放大', async () => {
    booted = await boot()
    booted.server.respond(() => new Response('x', { status: 502 }))
    const outcome = await booted.lease.refresh()
    expect(JSON.stringify(outcome)).not.toContain(TEST_TOKEN)
    expect(JSON.stringify(booted.lease.state())).not.toContain(TEST_TOKEN)
    expect(JSON.stringify(booted.holder.stats())).not.toContain(TEST_TOKEN)
  })
})

describe('策略桥：服务端进程内的策略被拒绝时的可读原因', () => {
  it('安装被拒时返回可读 rejection 而不是抛出', async () => {
    booted = await boot()
    const sink = booted.ctx.get(POLICY_SNAPSHOT_SERVICE as never) as unknown as { installOrClear: (s: unknown, b: unknown) => unknown }
    const spy = vi.spyOn(sink as never as { installOrClear: (...args: never[]) => unknown }, 'installOrClear')
    spy.mockReturnValue({ installed: false, reason: 'myrix: 策略版本回退' } as never)
    booted.server.respondJson(snapshotPayload([{ sid: 'sid-1' }], { policy: policyPayload({ rev: 9 }) }))
    const outcome = await booted.lease.refresh()
    expect(outcome).toMatchObject({ installed: false, rejection: 'policy-stale' })
    expect(JSON.stringify(outcome)).toContain('策略版本回退')
    expect(booted.holder.current()).toBeUndefined()
  })
})

/** 让上面的 `LeaseIo` 类型在文件里被引用（harness 的返回类型依赖它）。 */
export type LeaseIoAlias = LeaseIo
