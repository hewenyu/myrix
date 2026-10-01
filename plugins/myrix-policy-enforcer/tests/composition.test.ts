/**
 * 真实 Cordis 组合：策略执行点与绑定租约**分属两个 fiber / 两个子上下文**，
 * 仍然共享同一份策略快照。
 *
 * 这是 R16 的核心装配断言。执行点与租约各自被 `ctx.plugin()` 加载，各自拿到
 * 自己的子上下文；如果快照靠"模块级单例"或"WeakMap 只登记自己的 ctx"传递，
 * 那么 esbuild 把两个插件分别打包后就会出现"租约装了、执行点看不到"的
 * 静默全拒 —— 本用例锁死这条路径。
 *
 * 只把作品服务与时钟换成替身；工具管线（`ToolRuntime`）、身份表
 * （`PrincipalRegistry`）与两个插件都是真实实现。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { PrincipalRegistry, type Principal } from '@myrix/principals'
import * as enforcer from '../src/index'
import { applyWithIo, type Config as LeaseConfig } from '../../myrix-binding-lease/src/index'
import { ManualClock, ScriptedFetch, TEST_TOKEN, policyPayload, snapshotPayload, testIo } from '../../myrix-binding-lease/tests/harness'

const leaseConfig: LeaseConfig = {
  cellId: 'cell-1',
  tenantId: 't_acme',
  origin: 'https://works.internal:8443',
  token: TEST_TOKEN,
  ttlMs: 10_000,
  refreshMs: 3_000,
  requirePolicy: true,
}

const principal: Principal = { sid: 'sid-1', tid: 't_acme', sub: 'u_1', wid: 'w_1', preset: 'novel-chapter', rev: 7 }
const agent = { id: 'sid-1' }

/** 真实身份表绑定：`bind` 要求 `agent.id === principal.sid`。 */
function bindAgent(ctx: Context): void {
  ctx.principals.bind(agent as never, principal)
}

interface Booted {
  readonly ctx: Context
  readonly enforcerFiber: Fiber
  readonly leaseFiber: Fiber
  readonly clock: ManualClock
  readonly server: ScriptedFetch
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

/**
 * 装配：工具管线 → 身份表 → 策略执行点 → 绑定租约。
 *
 * 每次 `ctx.plugin()` 都是独立 fiber，插件内部看到的 `ctx` 是各自的子上下文 ——
 * 这正是"服务查找而不是模块单例"必须成立的地方。
 */
async function boot(): Promise<Booted> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(PrincipalRegistry)
  const clock = new ManualClock()
  const server = new ScriptedFetch()
  const { io } = testIo({ clock, fetch: server.fetch })
  server.respondJson(snapshotPayload([{ sid: 'sid-1' }], { policy: policyPayload() }))

  const enforcerFiber = await ctx.plugin({
    name: 'myrix-policy-enforcer',
    inject: ['tools', 'principals'],
    apply: enforcer.apply,
  } as never, undefined as never)

  const leaseFiber = await ctx.plugin({
    name: 'myrix-binding-lease',
    inject: ['principals'],
    apply: (child: Context): void => applyWithIo(child, leaseConfig, io),
  } as never, undefined as never)
  await flush()
  return { ctx, enforcerFiber, leaseFiber, clock, server }
}

function execute(ctx: Context, name: string) {
  return ctx.tools.execute({
    callId: ToolCallId('call-1'),
    name,
    arguments: {},
    agent: agent as never,
    signal: new AbortController().signal,
  })
}

let booted: Booted | undefined
afterEach(async () => {
  await booted?.leaseFiber.dispose()
  await booted?.enforcerFiber.dispose()
  booted = undefined
})

describe('执行点与租约跨 fiber 共享同一份策略快照', () => {
  it('两个 fiber 看到的是同一个服务实例', async () => {
    booted = await boot()
    bindAgent(booted.ctx)
    const fromRoot = booted.ctx.get(enforcer.POLICY_SNAPSHOT_SERVICE)
    expect(fromRoot).toBeDefined()
    // 租约插件与执行点插件各自在子上下文里，但服务查找解析到同一个对象。
    expect(booted.ctx.principals.hasLiveness()).toBe(true)
    expect(enforcer.policySnapshotHolderOf(booted.ctx)).toBe(fromRoot)
    expect(fromRoot?.current()).toMatchObject({ rev: 1, tid: 't_acme' })
  })

  it('租约安装策略后，真实工具管线放行白名单内的工具', async () => {
    booted = await boot()
    bindAgent(booted.ctx)
    booted.ctx.tools.register({
      name: 'get_outline',
      description: '读取大纲',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'ok' }] },
      execute: async () => ({ text: 'ok' }),
    } as never)
    const result = await execute(booted.ctx, 'get_outline')
    expect(result.isError).toBe(false)
  })

  it('策略快照未安装时（租约未成功）同样的工具被拒 —— 证明放行不是"默认"', async () => {
    booted = await boot()
    bindAgent(booted.ctx)
    booted.ctx.tools.register({
      name: 'get_outline',
      description: '读取大纲',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'ok' }] },
      execute: async () => ({ text: 'ok' }),
    } as never)
    // 让租约刷新失败：绑定与策略一起清空。
    booted.server.respond(() => new Response('down', { status: 503 }))
    expect((await booted.ctx.bindingLease.refresh()).installed).toBe(false)
    const result = await execute(booted.ctx, 'get_outline')
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('myrix')
  })

  it('策略只收窄到服务端下发的子集：允许集之外的六个工具之一仍被拒', async () => {
    booted = await boot()
    // 服务端只允许 get_outline。
    bindAgent(booted.ctx)
    booted.server.respondJson(snapshotPayload([{ sid: 'sid-1' }], { policy: policyPayload({ tools: ['get_outline'], rev: 2 }) }))
    expect((await booted.ctx.bindingLease.refresh()).installed).toBe(true)
    booted.ctx.tools.register({
      name: 'save_chapter_draft',
      description: '保存草稿',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'ok' }] },
      execute: async () => ({ text: 'ok' }),
    } as never)
    const denied = await execute(booted.ctx, 'save_chapter_draft')
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('未被当前策略快照允许')
  })

  it('租约的 agent/created 刷新（真正被 await 的事件）之后策略立即可用', async () => {
    booted = await boot()
    booted.server.respondJson(snapshotPayload([{ sid: 'sid-1' }], { policy: policyPayload({ rev: 3, tools: ['get_outline'] }) }))
    await booted.ctx.serial('agent/created', { agent: agent as never, source: 'startup' })
    expect(enforcer.policySnapshotHolderOf(booted.ctx)?.current()).toMatchObject({ rev: 3, tools: ['get_outline'] })
  })

  it('执行点卸载后策略服务与策略一起消失（不会留下无执行点的持有者）', async () => {
    booted = await boot()
    const holder = booted.ctx.get(enforcer.POLICY_SNAPSHOT_SERVICE)
    expect(holder?.current()).toBeDefined()
    await booted.enforcerFiber.dispose()
    expect(holder?.current()).toBeUndefined()
    expect(booted.ctx.get(enforcer.POLICY_SNAPSHOT_SERVICE)).toBeUndefined()
  })
})
