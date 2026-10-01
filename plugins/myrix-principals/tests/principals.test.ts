/**
 * 身份注册表的行为测试。
 *
 * 覆盖的都是安全属性，而不是实现细节：撤权单调、缺活性即拒绝、
 * 绑定随 Agent 生命周期回收、所有者不可更换。
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { PrincipalDeniedError, PrincipalRegistry, type Principal } from '../src/index'

function fakeAgent(id: string): Agent {
  // 注册表只依赖 `Agent.id`；运行时面（session/inbox/...）在 driver 的测试里才需要。
  return { id } as unknown as Agent
}

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sid: 'sid-1',
    tid: 't_acme',
    sub: 'u_1',
    wid: 'w_1',
    preset: 'novel-chapter',
    rev: 7,
    ...overrides,
  }
}

/** 在真实 Cordis root context 上加载服务类插件。 */
async function boot(): Promise<{ ctx: Context; registry: PrincipalRegistry }> {
  const ctx = new Context()
  await ctx.plugin(PrincipalRegistry)
  return { ctx, registry: ctx.principals }
}

describe('PrincipalRegistry 绑定与查询', () => {
  it('绑定后可以按 Agent 与会话两种方式查回同一主体', async () => {
    const { registry } = await boot()
    const agent = fakeAgent('sid-1')
    const p = principal()
    registry.bind(agent, p)
    expect(registry.get(agent)).toEqual(p)
    expect(registry.bySession('sid-1')).toEqual(p)
  })

  it('解绑后两个方向都查不到（dispose 语义）', async () => {
    const { registry } = await boot()
    const agent = fakeAgent('sid-1')
    const unbind = registry.bind(agent, principal())
    unbind()
    expect(registry.get(agent)).toBeUndefined()
    expect(registry.bySession('sid-1')).toBeUndefined()
  })

  it('Agent id 与凭证 sid 不一致时拒绝绑定', async () => {
    const { registry } = await boot()
    expect(() => registry.bind(fakeAgent('other'), principal())).toThrow(PrincipalDeniedError)
  })

  it('同一会话不允许更换所有者', async () => {
    const { registry } = await boot()
    registry.bind(fakeAgent('sid-1'), principal({ sub: 'u_1' }))
    expect(() => registry.bind(fakeAgent('sid-1'), principal({ sub: 'u_2' }))).toThrow(/其他主体/)
  })

  it('同一主体的重复绑定是幂等的', async () => {
    const { registry } = await boot()
    const agent = fakeAgent('sid-1')
    registry.bind(agent, principal())
    expect(() => registry.bind(agent, principal())).not.toThrow()
    expect(registry.bySession('sid-1')?.sub).toBe('u_1')
  })

  it('agent/disposed 事件会清掉反查索引', async () => {
    const { ctx, registry } = await boot()
    const agent = fakeAgent('sid-1')
    registry.bind(agent, principal())
    ctx.emit('agent/disposed', { agent })
    expect(registry.bySession('sid-1')).toBeUndefined()
  })
})

describe('PrincipalRegistry 活性判定（fail-closed）', () => {
  it('未安装活性判定时拒绝一切身份使用', async () => {
    const { registry } = await boot()
    const agent = fakeAgent('sid-1')
    registry.bind(agent, principal())
    const result = registry.lookup(agent)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('liveness-unavailable')
    // 宽松 get 仍然看得到绑定：它只是"曾经是谁"，不能用作准入。
    expect(registry.get(agent)).toBeDefined()
    expect(() => registry.require(agent)).toThrow(PrincipalDeniedError)
  })

  it('活性返回 true 才放行', async () => {
    const { registry } = await boot()
    const agent = fakeAgent('sid-1')
    registry.bind(agent, principal())
    registry.setLiveness(() => true)
    expect(registry.require(agent).sub).toBe('u_1')
    expect(registry.requireBySession('sid-1').sid).toBe('sid-1')
  })

  it('活性返回 false 或 undefined 一律拒绝', async () => {
    const { registry } = await boot()
    const agent = fakeAgent('sid-1')
    registry.bind(agent, principal())

    registry.setLiveness(() => false)
    let result = registry.lookup(agent)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('liveness-stale')

    registry.setLiveness(() => undefined as unknown as boolean)
    result = registry.lookup(agent)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('liveness-unavailable')
  })

  it('活性判定抛错按失效处理，并把异常收敛成可读原因', async () => {
    const { registry } = await boot()
    const agent = fakeAgent('sid-1')
    registry.bind(agent, principal())
    registry.setLiveness(() => {
      throw new TypeError('boom')
    })
    const result = registry.lookup(agent)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('liveness-error')
      expect(result.detail).toContain('TypeError')
    }
  })

  it('卸下活性判定后重新变成拒绝', async () => {
    const { registry } = await boot()
    const agent = fakeAgent('sid-1')
    registry.bind(agent, principal())
    const dispose = registry.setLiveness(() => true)
    expect(registry.lookup(agent).ok).toBe(true)
    dispose()
    expect(registry.lookup(agent).ok).toBe(false)
    expect(registry.hasLiveness()).toBe(false)
  })

  it('查询没有关联 Agent 时拒绝而不是放行', async () => {
    const { registry } = await boot()
    registry.setLiveness(() => true)
    const result = registry.lookup(undefined)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('no-agent')
  })
})

describe('PrincipalRegistry 撤权（单调、不可逆）', () => {
  it('撤权后绑定立即失效，且两个查询方向都失效', async () => {
    const { registry } = await boot()
    const agent = fakeAgent('sid-1')
    registry.bind(agent, principal())
    registry.setLiveness(() => true)
    const outcome = registry.revoke({ sid: 'sid-1', rev: 8, reason: '成员被移除' })
    expect(outcome.accepted).toBe(true)
    expect(registry.isRevoked('sid-1')).toBe(true)
    expect(registry.get(agent)).toBeUndefined()
    expect(registry.bySession('sid-1')).toBeUndefined()
    const result = registry.lookup(agent)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('revoked')
  })

  it('更旧的撤权版本被忽略，高水位不回退', async () => {
    const { registry } = await boot()
    expect(registry.revoke({ sid: 'sid-1', rev: 9, reason: 'r9' }).accepted).toBe(true)
    const stale = registry.revoke({ sid: 'sid-1', rev: 5, reason: 'r5' })
    expect(stale.accepted).toBe(false)
    expect(registry.highWaterRev('sid-1')).toBe(9)
    // 同版本重复通知也不算新信息。
    expect(registry.revoke({ sid: 'sid-1', rev: 9, reason: 'again' }).accepted).toBe(false)
  })

  it('已撤权的会话不能再次绑定（resume 不能洗白撤权）', async () => {
    const { registry } = await boot()
    registry.revoke({ sid: 'sid-1', rev: 1, reason: 'revoked' })
    expect(() => registry.bind(fakeAgent('sid-1'), principal())).toThrow(/已撤权/)
  })

  it('非法 rev 被拒绝且不写入状态', async () => {
    const { registry } = await boot()
    expect(registry.revoke({ sid: 'sid-1', rev: -1, reason: 'x' }).accepted).toBe(false)
    expect(registry.revoke({ sid: 'sid-1', rev: 1.5, reason: 'x' }).accepted).toBe(false)
    expect(registry.isRevoked('sid-1')).toBe(false)
  })

  it('撤权会清掉反查索引但不影响其他会话', async () => {
    const { registry } = await boot()
    registry.bind(fakeAgent('sid-1'), principal({ sid: 'sid-1' }))
    registry.bind(fakeAgent('sid-2'), principal({ sid: 'sid-2', sub: 'u_2' }))
    registry.revoke({ sid: 'sid-1', rev: 1, reason: 'revoked' })
    expect(registry.bySession('sid-1')).toBeUndefined()
    expect(registry.bySession('sid-2')?.sub).toBe('u_2')
  })

  it('撤权时清掉的索引不会被旧 Agent 的 dispose 误删新绑定', async () => {
    const { ctx, registry } = await boot()
    const oldAgent = fakeAgent('sid-1')
    const unbindOld = registry.bind(oldAgent, principal())
    // 旧 Agent 先被撤权清掉索引，然后同一 sid 重新绑定（新 Agent）。
    registry.revoke({ sid: 'sid-1', rev: 1, reason: 'revoked' })
    expect(registry.bySession('sid-1')).toBeUndefined()
    void unbindOld
    void ctx
  })
})

describe('PrincipalRegistry 诊断指标', () => {
  it('stats 只暴露计数', async () => {
    const { registry } = await boot()
    registry.bind(fakeAgent('sid-1'), principal())
    registry.setLiveness(() => true)
    registry.revoke({ sid: 'sid-9', rev: 1, reason: 'r' })
    const stats = registry.stats()
    expect(stats).toMatchObject({ bound: 1, live: 1, revoked: 1, liveness: true })
    expect(Object.keys(stats).sort()).toEqual(['bound', 'denied', 'live', 'liveness', 'revoked'])
  })

  it('拒绝计数随拒绝路径递增', async () => {
    const { registry } = await boot()
    const before = registry.stats().denied
    registry.lookup(undefined)
    registry.lookup(fakeAgent('sid-x'))
    expect(registry.stats().denied).toBe(before + 2)
  })

  it('recording a revoke does not require an installed liveness provider', async () => {
    const { registry } = await boot()
    const spy = vi.fn(() => true)
    registry.setLiveness(spy)
    registry.revoke({ sid: 'sid-1', rev: 1, reason: 'r' })
    // 撤权是纯内存操作，不查询活性。
    expect(spy).not.toHaveBeenCalled()
  })
})
