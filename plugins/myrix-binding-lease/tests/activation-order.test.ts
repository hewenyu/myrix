import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { PrincipalRegistry } from '@myrix/principals'
import * as lease from '../src/index'
import * as enforcer from '../../myrix-policy-enforcer/src/index'
import { TEST_TOKEN, policyPayload, snapshotPayload } from './harness'

const config: lease.Config = {
  cellId: 'cell-1', tenantId: 't_acme', origin: 'https://works.internal:8443',
  token: TEST_TOKEN, ttlMs: 10_000, refreshMs: 3_000, requirePolicy: true,
}
const fibers: Fiber[] = []
afterEach(async () => {
  try { for (const fiber of fibers.splice(0).reverse()) await fiber.dispose() }
  finally { vi.unstubAllGlobals() }
})

async function base() {
  const ctx = new Context()
  fibers.push(await ctx.plugin(SystemPrompt))
  fibers.push(await ctx.plugin(ToolRuntime))
  fibers.push(await ctx.plugin(PrincipalRegistry))
  const fetch = vi.fn(async () => new Response(JSON.stringify(snapshotPayload([{ sid: 'sid-1' }], { policy: policyPayload() })), {
    status: 200, headers: { 'content-type': 'application/json' },
  }))
  vi.stubGlobal('fetch', fetch)
  return { ctx, fetch }
}

async function assertInstalled(ctx: Context) {
  await vi.waitFor(() => expect(ctx.get('bindingLease')).toBeDefined())
  expect((await ctx.bindingLease.refresh()).installed).toBe(true)
  expect(ctx.principals.hasLiveness()).toBe(true)
  expect(enforcer.policySnapshotHolderOf(ctx)?.current()).toMatchObject({ rev: 1, tid: 't_acme' })
}

describe('public plugin entry uses a real Cordis policy dependency', () => {
  it('consumer may load first, remains fail-closed and activates when the producer arrives', async () => {
    const { ctx, fetch } = await base()
    fibers.push(await ctx.plugin(lease, config))
    expect(ctx.get('bindingLease')).toBeUndefined()
    expect(ctx.principals.hasLiveness()).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
    fibers.push(await ctx.plugin(enforcer))
    await assertInstalled(ctx)
  })

  it('provider loss disposes the consumer and clears liveness; a new provider reactivates it', async () => {
    const { ctx } = await base()
    const provider = await ctx.plugin(enforcer)
    fibers.push(provider, await ctx.plugin(lease, config))
    await assertInstalled(ctx)
    const previousLease = ctx.bindingLease
    await provider.dispose()
    await vi.waitFor(() => expect(ctx.get('bindingLease')).toBeUndefined())
    expect(ctx.principals.hasLiveness()).toBe(false)
    expect((await previousLease.refresh()).installed).toBe(false)
    fibers.push(await ctx.plugin(enforcer))
    await assertInstalled(ctx)
    expect(ctx.bindingLease).not.toBe(previousLease)
  })

  it('concurrent loader activation does not depend on profile row order', async () => {
    const { ctx } = await base()
    fibers.push(...await Promise.all([ctx.plugin(lease, config), ctx.plugin(enforcer)]))
    await assertInstalled(ctx)
  })

  it('explicit legacy lease-only scope does not require the policy provider', async () => {
    const { ctx } = await base()
    fibers.push(await ctx.plugin(lease, { ...config, requirePolicy: false }))
    expect((await ctx.bindingLease.refresh()).installed).toBe(true)
    expect(ctx.get(enforcer.POLICY_SNAPSHOT_SERVICE)).toBeUndefined()
  })
})
