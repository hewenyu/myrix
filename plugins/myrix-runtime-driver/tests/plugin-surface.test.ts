/**
 * 插件装配面（surface）测试。
 *
 * 这些断言锁的是 DSH 的插件契约本身，而不是业务行为：
 * - function plugin 必须**具名导出** `name`/`inject`/`apply` 且**没有 default export**
 *   （混用会让 Loader 丢掉命名空间，见 DSH `packages/AGENTS.md`）。
 * - `apply` 必须是真实可调用的函数（不是 shim、不是 stub）。
 * - 配置缺失时必须**抛错拒绝启动**，而不是构造出一个"空校验器"的驱动器。
 */
import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { generateTestKeyPair } from '@myrix/grant'
import * as driver from '../src/index'
import * as enforcer from '../../myrix-policy-enforcer/src/index'
import * as principals from '../../myrix-principals/src/index'

/** 一枚真实 P-256 公钥：`keys` 为空会先被拒绝，掩盖 provider/model 的检查。 */
const realKeys = [generateTestKeyPair('kid-surface').jwk]

describe('myrix-runtime-driver 的导出形状', () => {
  it('具名导出 name/inject/apply，没有 default export', () => {
    expect(driver.name).toBe('myrix-runtime-driver')
    expect(driver.apply).toBeTypeOf('function')
    expect('default' in driver).toBe(false)
  })

  it('inject 覆盖驱动真正依赖的服务（含硬依赖的 sessionPersistence）', () => {
    expect([...driver.inject].sort()).toEqual(
      ['agentPresets', 'agents', 'principals', 'sessionPersistence', 'sessions', 'webServer'].sort(),
    )
    // bindingLease 是可选适配器：不在 inject 里，缺失不阻止激活。
    expect([...driver.inject]).not.toContain('bindingLease')
  })

  it('apply 是真实实现（不是被换成 stub）', () => {
    // 源码长度不足以证明什么，但至少能挡住"apply 是空函数"的装配错误。
    expect(driver.apply.toString().length).toBeGreaterThan(200)
  })
})

describe('myrix-principals 的服务类形状', () => {
  it('default export 是 Service 子类，且提供 principals 服务', async () => {
    expect(typeof principals.default).toBe('function')
    expect(Object.getPrototypeOf(principals.default)).toBe(Service)
    const ctx = new Context()
    await ctx.plugin(principals.default)
    expect(ctx.principals).toBeDefined()
    expect(ctx.principals.require).toBeTypeOf('function')
  })

  it('注册了服务但重复注册会被拒绝（服务名唯一）', async () => {
    const ctx = new Context()
    await ctx.plugin(principals.default)
    expect(() => new principals.default(ctx)).toThrow(/already|registered|Error/)
  })
})

describe('myrix-policy-enforcer 的导出形状', () => {
  it('具名导出 name/inject/apply，没有 default export', () => {
    expect(enforcer.name).toBe('myrix-policy-enforcer')
    expect(enforcer.apply).toBeTypeOf('function')
    expect('default' in enforcer).toBe(false)
  })

  it('inject 只有 tools 与 principals', () => {
    expect([...enforcer.inject].sort()).toEqual(['principals', 'tools'])
  })

  it('allowlist 常量恰好 6 个小说工具', () => {
    expect(enforcer.NOVEL_TOOL_ALLOWLIST).toHaveLength(6)
  })
})

describe('配置 fail-closed', () => {
  const baseConfig = {
    cellId: 'cell-1',
    tenantId: 't',
    issuer: 'myrix-control-plane',
    keys: [],
  }

  it('公钥集合为空时拒绝启动', () => {
    const ctx = new Context()
    // 直接调用导出的 apply，绕过 Loader 的 config 校验。
    expect(() => (driver.apply as unknown as (c: Context, cfg: unknown) => void)(ctx, baseConfig)).toThrow(/keys/)
  })

  it('缺 cellId 时拒绝启动', () => {
    const ctx = new Context()
    expect(() =>
      (driver.apply as unknown as (c: Context, cfg: unknown) => void)(ctx, { ...baseConfig, cellId: '' }),
    ).toThrow(/cellId/)
  })

  it('缺 tenantId 时拒绝启动', () => {
    const ctx = new Context()
    expect(() =>
      (driver.apply as unknown as (c: Context, cfg: unknown) => void)(ctx, { ...baseConfig, tenantId: '' }),
    ).toThrow(/tenantId/)
  })

  it('缺 issuer 时拒绝启动', () => {
    const ctx = new Context()
    expect(() =>
      (driver.apply as unknown as (c: Context, cfg: unknown) => void)(ctx, { ...baseConfig, issuer: '' }),
    ).toThrow(/issuer/)
  })

  it('缺 defaultProvider 时拒绝启动（否则每个会话在第一次模型请求才失败）', () => {
    const ctx = new Context()
    expect(() =>
      (driver.apply as unknown as (c: Context, cfg: unknown) => void)(ctx, {
        ...baseConfig,
        keys: realKeys,
        defaultModel: 'myrix-chat',
      }),
    ).toThrow(/defaultProvider/)
  })

  it('缺 defaultModel 时拒绝启动', () => {
    const ctx = new Context()
    expect(() =>
      (driver.apply as unknown as (c: Context, cfg: unknown) => void)(ctx, {
        ...baseConfig,
        keys: realKeys,
        defaultProvider: 'myrix-gateway',
      }),
    ).toThrow(/defaultModel/)
  })

  it('provider/model 两者都为空字符串时拒绝启动', () => {
    const ctx = new Context()
    expect(() =>
      (driver.apply as unknown as (c: Context, cfg: unknown) => void)(ctx, {
        ...baseConfig,
        keys: realKeys,
        defaultProvider: '',
        defaultModel: '',
      }),
    ).toThrow(/defaultProvider/)
  })

  it('Config 类型上 provider/model 是必填字段（不是可选）', () => {
    // 编译期断言：provider/model 在 Config 里是 `string` 而不是 `string | undefined`。
    type ProviderType = driver.Config['defaultProvider']
    type ModelType = driver.Config['defaultModel']
    const complete: driver.Config = {
      cellId: 'cell-1',
      tenantId: 't',
      issuer: 'myrix-control-plane',
      keys: realKeys,
      defaultProvider: 'myrix-gateway',
      defaultModel: 'myrix-chat',
    }
    // 若某个字段变成可选，`Required<Config>` 的赋值会因为缺字段而编译失败。
    const required: Required<Pick<driver.Config, 'defaultProvider' | 'defaultModel'>> = complete
    const provider: ProviderType = required.defaultProvider
    const model: ModelType = required.defaultModel
    expect(provider).toBe('myrix-gateway')
    expect(model).toBe('myrix-chat')
  })
})
