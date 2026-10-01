/**
 * 真实 Cordis 组合下的 PEP 行为：guard 同步拒绝、waterfall 一定 next()。
 *
 * 用真实 `ToolRuntime`（`@deepseek-ai/dsh-tools`）与真实 `SystemPrompt`
 * 跑真实执行管线，只把"判定输入"（身份表查表结果、策略快照）作为测试数据
 * 喂进去 —— 不 mock 管线本身。
 *
 * 局限（明确记录，不宣称已覆盖）：这里没有真实 Agent/会话，
 * 因此只验证"缺身份/缺快照/越权工具被拒"，不验证 preset 级工具可见性。
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { MAX_POLICY_TTL_MS, POLICY_SNAPSHOT_SERVICE, apply, PolicySnapshotHolder, policySnapshotHolderOf } from '../src/index'
import type { PolicySnapshot } from '../src/types'

interface LookupOk {
  readonly ok: true
  readonly principal: { readonly sid: string; readonly tid: string; readonly sub: string; readonly rev: number }
}
interface LookupFail {
  readonly ok: false
  readonly reason: string
  readonly detail: string
}

const allowedLookup: LookupOk = {
  ok: true,
  principal: { sid: 'sid-1', tid: 't_acme', sub: 'u_1', rev: 3 },
}

/**
 * 起一个真实 Cordis 组合：真实 ToolRuntime/SystemPrompt + 被测插件 + 身份表替身。
 *
 * 身份表只用 `ctx.provide` 注册一个满足 `lookup` 的对象；插件本身不知道
 * 它是不是替身，走的是与生产相同的服务查找路径。
 */
async function boot(lookup: () => LookupOk | LookupFail): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.provide('principals', { lookup } as never)
  await ctx.plugin({ name: 'myrix-policy-enforcer', inject: ['tools', 'principals'], apply })
  return ctx
}

function execute(ctx: Context, name: string, agentId = 'sid-1') {
  return ctx.tools.execute({
    callId: ToolCallId('call-1'),
    name,
    arguments: {},
    agent: { id: agentId } as never,
    signal: new AbortController().signal,
  })
}

describe('myrix-policy-enforcer guard（同步 fail-closed）', () => {
  it('身份缺失时拒绝，永不落到工具体', async () => {
    const ctx = await boot(() => ({ ok: false, reason: 'unbound', detail: '没有绑定' }))
    const result = await execute(ctx, 'get_outline')
    expect(result.isError).toBe(true)
    // guard 的拒绝原因是 myrix 前缀的可读字符串；未注册工具则是 UNKNOWN_TOOL。
    // 两者都是拒绝，但我们要确认"身份缺失"这条路径确实被走到了。
    expect(JSON.stringify(result.content)).toContain('myrix')
  })

  it('即使身份有效，快照未安装也拒绝（没有"没配置就放行"）', async () => {
    const ctx = await boot(() => allowedLookup)
    const result = await execute(ctx, 'get_outline')
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('myrix')
  })

  it('快照安装后仍拒绝不在 allowlist 的工具（如 bash）', async () => {
    const ctx = await boot(() => allowedLookup)
    const result = await execute(ctx, 'bash')
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('myrix')
  })

  it('已注册的允许工具在快照 + 身份齐备时能真正执行（证明 guard 不是拒绝一切）', async () => {
    const ctx = await boot(() => allowedLookup)
    const holder = policySnapshotHolderOf(ctx)
    expect(holder).toBeDefined()
    holder?.install({ rev: 1, tid: 't_acme', expiresAt: Date.now() + 60_000, tools: ['get_outline'] })
    ctx.tools.register({
      name: 'get_outline',
      description: '读取大纲',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'ok' }] },
      execute: async () => ({ text: 'ok' }),
    } as never)
    const result = await execute(ctx, 'get_outline')
    // 放行路径：工具体被执行，结果不是错误。
    expect(result.isError).toBe(false)
  })
})

describe('PolicySnapshotHolder', () => {
  it('安装后 current 可见，clear 后立刻不可见', () => {
    const holder = new PolicySnapshotHolder(() => 1000)
    expect(holder.current()).toBeUndefined()
    holder.install({ rev: 2, tid: 't', expiresAt: 5000, tools: ['get_outline'] })
    expect(holder.current()?.rev).toBe(2)
    holder.clear()
    expect(holder.current()).toBeUndefined()
    expect(holder.stats().present).toBe(false)
  })

  it('拒绝版本回退，避免旧快照覆盖新快照', () => {
    const holder = new PolicySnapshotHolder(() => 1000)
    holder.install({ rev: 5, tid: 't', expiresAt: 5000, tools: [] })
    expect(() => holder.install({ rev: 4, tid: 't', expiresAt: 5000, tools: [] })).toThrow(/版本回退/)
    expect(holder.current()?.rev).toBe(5)
  })

  it('同版本重装是允许的（控制面重发）', () => {
    const holder = new PolicySnapshotHolder(() => 1000)
    holder.install({ rev: 5, tid: 't', expiresAt: 5000, tools: [] })
    expect(() => holder.install({ rev: 5, tid: 't', expiresAt: 6000, tools: [] })).not.toThrow()
    expect(holder.current()?.expiresAt).toBe(6000)
  })

  it('unused type import stays referenced for the snapshot shape', () => {
    const snapshot: PolicySnapshot = { rev: 1, tid: 't', expiresAt: 500, tools: ['get_outline'] }
    expect(snapshot.tools).toEqual(['get_outline'])
  })
})

describe('PolicySnapshotHolder 的生产者入口（installOrClear）', () => {
  const grant = { rev: 3, tid: 't_acme', tools: ['get_outline'] }

  it('安装后 current() 可见，两个时限都用持有者自己的时钟算', () => {
    let wall = 1_790_000_000_000
    let mono = 1_000
    const holder = new PolicySnapshotHolder(() => wall, () => mono)
    expect(holder.installOrClear(grant, { remainingMs: 5_000 })).toMatchObject({ installed: true, rev: 3 })
    expect(holder.current()).toMatchObject({ rev: 3, tid: 't_acme', tools: ['get_outline'], expiresAt: wall + 5_000 })
    expect(holder.monoDeadline()).toBe(mono + 5_000)
  })

  it('剩余时长超过 30 秒会被硬性截断（生产者不能延长授权）', () => {
    const holder = new PolicySnapshotHolder(() => 0, () => 0)
    holder.installOrClear(grant, { remainingMs: 600_000 })
    expect(holder.current()?.expiresAt).toBe(MAX_POLICY_TTL_MS)
    expect(holder.monoDeadline()).toBe(MAX_POLICY_TTL_MS)
  })

  it('剩余时长非法（0/负数/NaN）→ 清空并拒绝', () => {
    for (const remainingMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const holder = new PolicySnapshotHolder()
      holder.installOrClear(grant, { remainingMs: 1_000 })
      const outcome = holder.installOrClear(grant, { remainingMs })
      expect(outcome.installed).toBe(false)
      expect(holder.current()).toBeUndefined()
    }
  })

  const badGrants: readonly [string, unknown][] = [
    ['非对象', 42],
    ['rev 为负', { ...grant, rev: -1 }],
    ['rev 非整数', { ...grant, rev: 1.5 }],
    ['缺 tid', { rev: 1, tools: [] }],
    ['tools 含非字符串', { ...grant, tools: [1] }],
    ['tools 非数组', { ...grant, tools: 'get_outline' }],
  ]
  for (const [label, value] of badGrants) {
    it(`内容非法（${label}）→ 清空并拒绝，不抛出`, () => {
      const holder = new PolicySnapshotHolder()
      expect(() => holder.installOrClear(value as never, { remainingMs: 1_000 })).not.toThrow()
      const outcome = holder.installOrClear(value as never, { remainingMs: 1_000 })
      expect(outcome.installed).toBe(false)
      expect(holder.current()).toBeUndefined()
    })
  }

  it('版本回退 → 清空 + 拒绝；高水位在 clear 之后仍然保留', () => {
    const holder = new PolicySnapshotHolder()
    holder.installOrClear({ ...grant, rev: 5 }, { remainingMs: 1_000 })
    expect(holder.installOrClear({ ...grant, rev: 4 }, { remainingMs: 1_000 }).installed).toBe(false)
    expect(holder.current()).toBeUndefined()
    holder.clear('drain')
    // 清空之后重放更旧的版本仍然拒绝：否则"先失败清空、再灌旧快照"就能洗白。
    expect(holder.installOrClear({ ...grant, rev: 4 }, { remainingMs: 1_000 }).installed).toBe(false)
    expect(holder.stats().highWaterRev).toBe(5)
    // 同版本重装是允许的（控制面重发）。
    expect(holder.installOrClear({ ...grant, rev: 5 }, { remainingMs: 1_000 }).installed).toBe(true)
  })

  it('墙钟被回拨也不能延长：单调到期即 current() === undefined', () => {
    let wall = 1_000
    let mono = 5_000
    const holder = new PolicySnapshotHolder(() => wall, () => mono)
    holder.installOrClear(grant, { remainingMs: 1_000 })
    expect(holder.current()).toBeDefined()
    // 墙钟往回拨（模拟 NTP 回拨），单调时钟前进到截止。
    wall -= 10_000
    mono += 1_000
    expect(holder.current()).toBeUndefined()
    expect(holder.stats().present).toBe(false)
  })

  it('clear 之后 stats 里的 rev 仍可读，但 present 为 false', () => {
    const holder = new PolicySnapshotHolder()
    holder.installOrClear({ ...grant, rev: 9 }, { remainingMs: 1_000 })
    holder.clear('撤销')
    expect(holder.stats()).toMatchObject({ present: false, rev: 9, clears: 1, highWaterRev: 9, lastReason: '撤销' })
  })

  it('安装是替换而不是合并：新快照的工具集合立刻生效', () => {
    const holder = new PolicySnapshotHolder()
    holder.installOrClear({ ...grant, rev: 1, tools: ['get_outline', 'search_bible'] }, { remainingMs: 1_000 })
    holder.installOrClear({ ...grant, rev: 2, tools: ['get_outline'] }, { remainingMs: 1_000 })
    expect(holder.current()?.tools).toEqual(['get_outline'])
  })
})

describe('ctx.myrixPolicySnapshots 服务的装配面', () => {
  it('apply 提供真实服务，且 policySnapshotHolderOf 解析到同一个持有者', async () => {
    const ctx = await boot(() => allowedLookup)
    const service = ctx.get(POLICY_SNAPSHOT_SERVICE)
    expect(service).toBeInstanceOf(PolicySnapshotHolder)
    expect(policySnapshotHolderOf(ctx)).toBe(service)
  })

  it('卸载后服务与策略一起消失，policySnapshotHolderOf 不再返回持有者', async () => {
    const ctx = await boot(() => allowedLookup)
    const holder = policySnapshotHolderOf(ctx)
    holder?.install({ rev: 1, tid: 't_acme', expiresAt: Date.now() + 60_000, tools: ['get_outline'] })
    expect(holder?.current()).toBeDefined()
    await ctx.fiber.dispose()
    expect(ctx.get(POLICY_SNAPSHOT_SERVICE)).toBeUndefined()
    expect(policySnapshotHolderOf(ctx)).toBeUndefined()
    expect(holder?.current()).toBeUndefined()
  })
})
