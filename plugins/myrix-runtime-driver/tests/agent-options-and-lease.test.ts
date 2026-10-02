/**
 * 两个"很窄但阻塞可用性/安全"的接缝测试：
 *
 * 1. **provider/model 来源**：真实 `ctx.agents.create/resume` 必须收到
 *    `agentOptions`。pinned vendor 的 agent loop 在没有
 *    `AgentOptions.provider` + `AgentOptions.model`、且没有 `agent/request`
 *    waterfall 时直接抛错（`agent "…" has no provider/model`），而驱动的会话
 *    是按凭证动态创建的，没有声明式 Agent 可以承载这对值。
 *
 * 2. **租约刷新的失败判定**：`bindingLease.refresh()` **永不抛出**，失败以
 *    `{installed:false, rejection, detail}` 表达。只看"没有抛错"会把一次
 *    刷新失败当成成功放行，因此必须显式检查 `installed === true`。
 *
 * 这里直接测真实 `createPorts` 的映射（用满足契约的 `ctx` 替身），
 * 而不是透过控制器 —— 断言的就是"真实插件端口传了什么"。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { __createPorts, type DriverAgentOptions } from '../src/index'
import type { AgentSetupPort } from '../src/controller'

const AGENT_OPTIONS: DriverAgentOptions = { provider: 'myrix-gateway', model: 'myrix-chat' }

interface Captured {
  readonly create: Record<string, unknown>[]
  readonly resume: Record<string, unknown>[]
  readonly leaseCalls: number
}

/** 构造一个只满足 `createPorts` 所需成员的最小 ctx 替身。 */
function fakeCtx(
  options: {
    lease?: unknown
    createResult?: unknown
    resumeResult?: unknown
  } = {},
): { ctx: Context; captured: Captured } {
  const captured: Captured = { create: [], resume: [], leaseCalls: 0 }
  const handle = { agent: { id: 'sid-1' }, dispose: () => Promise.resolve() }
  const ctx = {
    agents: {
      create(input: Record<string, unknown>) {
        captured.create.push(input)
        return Promise.resolve(options.createResult ?? handle)
      },
      resume(input: Record<string, unknown>) {
        captured.resume.push(input)
        return Promise.resolve(options.resumeResult ?? handle)
      },
    },
    get(name: string) {
      if (name !== 'bindingLease') return undefined
      const lease = options.lease
      if (lease === undefined) return undefined
      return lease
    },
  }
  return { ctx: ctx as unknown as Context, captured }
}

const noopSetup: AgentSetupPort = () => undefined

describe('provider/model 必须真正传给 agents.create/resume', () => {
  it('create 带 agentOptions.provider/model（否则 agent loop 直接拒绝发起请求）', async () => {
    const { ctx, captured } = fakeCtx()
    const ports = __createPorts(ctx, AGENT_OPTIONS)
    await ports.create({ sessionId: 'sid-1', meta: { agentPreset: 'myrix-novel' }, setup: noopSetup })
    expect(captured.create).toHaveLength(1)
    expect(captured.create[0]).toMatchObject({
      sessionId: 'sid-1',
      meta: { agentPreset: 'myrix-novel' },
      agentOptions: { provider: 'myrix-gateway', model: 'myrix-chat' },
    })
  })

  it('resume 同样带 agentOptions（恢复的会话也要能发请求）', async () => {
    const { ctx, captured } = fakeCtx()
    const ports = __createPorts(ctx, AGENT_OPTIONS)
    await ports.resume({ resumeSessionId: 'sid-1', setup: noopSetup })
    expect(captured.resume).toHaveLength(1)
    expect(captured.resume[0]).toMatchObject({
      resumeSessionId: 'sid-1',
      agentOptions: { provider: 'myrix-gateway', model: 'myrix-chat' },
    })
  })

  it('provider/model 不是硬编码：Config 传什么就用什么', async () => {
    const { ctx, captured } = fakeCtx()
    const ports = __createPorts(ctx, { provider: 'other-route', model: 'other-model' })
    await ports.create({ sessionId: 'sid-1', meta: { agentPreset: 'p' }, setup: noopSetup })
    expect(captured.create[0]).toMatchObject({ agentOptions: { provider: 'other-route', model: 'other-model' } })
  })

  it('setup 原样透传（不能因为加了 agentOptions 就丢掉 setup）', async () => {
    const { ctx, captured } = fakeCtx()
    const ports = __createPorts(ctx, AGENT_OPTIONS)
    const setup = vi.fn()
    await ports.create({ sessionId: 'sid-1', meta: { agentPreset: 'p' }, setup })
    expect(captured.create[0]?.['setup']).toBe(setup)
  })
})

describe('refreshIdentity：bindingLease.refresh() 永不抛出，必须检查 installed', () => {
  it('installed:true → 正常返回（刷新真的安装了新快照）', async () => {
    const refresh = vi.fn(() => Promise.resolve({ installed: true, bindings: 3 }))
    const { ctx } = fakeCtx({ lease: { refresh } })
    const ports = __createPorts(ctx, AGENT_OPTIONS)
    await expect(ports.refreshIdentity?.({ sid: 'sid-1', tid: 't', sub: 'u', wid: 'w', preset: 'p', rev: 1 })).resolves.toBeUndefined()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('installed:false → 抛出固定非秘密错误（不能把刷新失败当成功）', async () => {
    const refresh = vi.fn(() =>
      Promise.resolve({ installed: false, rejection: 'stale', detail: 'SECRET upstream body sk-live-abc' }),
    )
    const { ctx } = fakeCtx({ lease: { refresh } })
    const ports = __createPorts(ctx, AGENT_OPTIONS)
    const error = await ports
      .refreshIdentity?.({ sid: 'sid-1', tid: 't', sub: 'u', wid: 'w', preset: 'p', rev: 1 })
      .then(() => undefined)
      .catch((caught: unknown) => caught as Error)
    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toContain('installed')
    // 固定错误：不回显上游 detail（可能含响应正文/秘密）。
    expect(error?.message).not.toContain('SECRET')
    expect(error?.message).not.toContain('sk-live-abc')
  })

  it('refresh 返回 undefined/null（旧适配器不返回 outcome）→ 拒绝', async () => {
    for (const value of [undefined, null, {}, { installed: 'true' }]) {
      const { ctx, captured } = fakeCtx({ lease: { refresh: () => Promise.resolve(value) } })
      const ports = __createPorts(ctx, AGENT_OPTIONS)
      await expect(
        ports.refreshIdentity?.({ sid: 'sid-1', tid: 't', sub: 'u', wid: 'w', preset: 'p', rev: 1 }),
      ).rejects.toThrow(/installed/)
      expect(captured.leaseCalls).toBe(0)
    }
  })

  it('没有 bindingLease 时照常返回（可选加固，不是新依赖）', async () => {
    const { ctx } = fakeCtx()
    const ports = __createPorts(ctx, AGENT_OPTIONS)
    await expect(ports.refreshIdentity?.({ sid: 'sid-1', tid: 't', sub: 'u', wid: 'w', preset: 'p', rev: 1 })).resolves.toBeUndefined()
  })

  it('refresh 抛错仍然向上传播（不是被吞掉后当成成功）', async () => {
    const { ctx } = fakeCtx({ lease: { refresh: () => Promise.reject(new Error('lease io down')) } })
    const ports = __createPorts(ctx, AGENT_OPTIONS)
    await expect(
      ports.refreshIdentity?.({ sid: 'sid-1', tid: 't', sub: 'u', wid: 'w', preset: 'p', rev: 1 }),
    ).rejects.toThrow()
  })
})
