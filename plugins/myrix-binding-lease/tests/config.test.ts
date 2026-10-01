/**
 * 配置与解析的 fail-closed 测试。
 *
 * 这些用例锁的是**部署事故面**：明文内网地址、过短 token、过长的 TTL、
 * 追不上过期的 refresh 间隔、把路径写成外站、把 token 拼进日志。
 */
import { describe, expect, it } from 'vitest'
import {
  BindingLeaseConfigError,
  DEFAULT_REFRESH_MS,
  DEFAULT_TTL_MS,
  MAX_TTL_MS,
  normalizeOrigin,
  redact,
  renderPath,
  resolveConfig,
} from '../src/index'
import { TEST_TOKEN } from './harness'

const base = {
  cellId: 'cell-1',
  tenantId: 't_acme',
  origin: 'https://works.internal:8443',
  token: TEST_TOKEN,
}

describe('origin 校验', () => {
  it('接受 HTTPS 与显式回环 HTTP', () => {
    expect(normalizeOrigin('https://works.internal:8443')).toBe('https://works.internal:8443')
    expect(normalizeOrigin('http://127.0.0.1:8081')).toBe('http://127.0.0.1:8081')
    expect(normalizeOrigin('http://localhost:8081')).toBe('http://localhost:8081')
    expect(normalizeOrigin('http://[::1]:8081')).toBe('http://[::1]:8081')
  })

  it('拒绝明文非回环地址（内网也必须 HTTPS）', () => {
    expect(() => normalizeOrigin('http://works.internal:8081')).toThrow(BindingLeaseConfigError)
    expect(() => normalizeOrigin('http://10.0.0.7:8081')).toThrow(/回环/)
  })

  it('拒绝内嵌凭据、路径、查询串与其它协议', () => {
    for (const origin of [
      'https://user:pass@works.internal',
      'https://works.internal/prefix',
      'https://works.internal/?x=1',
      'https://works.internal/#frag',
      'file:///etc/passwd',
      'ws://works.internal',
    ]) {
      expect(() => normalizeOrigin(origin)).toThrow(BindingLeaseConfigError)
    }
  })
})

describe('路径模板', () => {
  it('默认路径渲染为规范端点', () => {
    const cfg = resolveConfig(base)
    expect(cfg.url).toBe('https://works.internal:8443/internal/v1/cells/cell-1/bindings')
  })

  it('占位符必须存在，且路径不得带查询串或 ..', () => {
    expect(() => renderPath('/internal/v1/cells/bindings', 'cell-1')).toThrow(/\{cellId\}/)
    expect(() => renderPath('/internal/v1/cells/{cellId}/bindings?x=1', 'cell-1')).toThrow(/查询串/)
    expect(() => renderPath('/internal/v1/cells/{cellId}/../../admin', 'cell-1')).toThrow(/\.\./)
    expect(() => renderPath('internal/v1/cells/{cellId}/bindings', 'cell-1')).toThrow(/以 \/ 开头/)
  })

  it('cellId 会做 URL 编码，不会拼出额外路径段', () => {
    const cfg = resolveConfig({ ...base, cellId: 'cell/../evil' })
    // 编码后不再包含可供路径穿越的 "/"。
    expect(cfg.url).not.toContain('/../')
    expect(cfg.url).toContain('cell%2F..%2Fevil')
  })
})

describe('配置边界（fail-closed）', () => {
  it('默认值：10s TTL、3s 刷新、默认超时、1 MiB 上限', () => {
    const cfg = resolveConfig(base)
    expect(cfg.ttlMs).toBe(DEFAULT_TTL_MS)
    expect(cfg.refreshMs).toBe(DEFAULT_REFRESH_MS)
    expect(cfg.requestTimeoutMs).toBe(DEFAULT_REFRESH_MS)
    expect(cfg.maxResponseBytes).toBe(1_048_576)
    expect(cfg.refreshOnAgentCreated).toBe(true)
  })

  it('ttlMs 超过 30s 或刷新间隔追不上过期都拒绝启动', () => {
    expect(() => resolveConfig({ ...base, ttlMs: MAX_TTL_MS + 1 })).toThrow(/ttlMs/)
    expect(() => resolveConfig({ ...base, ttlMs: 10_000, refreshMs: 5_000 })).toThrow(/refreshMs/)
    expect(() => resolveConfig({ ...base, ttlMs: 10_000, refreshMs: 5_001 })).toThrow(/refreshMs/)
    expect(() => resolveConfig({ ...base, ttlMs: 10_000, refreshMs: 4_999 })).not.toThrow()
  })

  it('缺少 cellId/tenantId/origin/token 一律拒绝，且不泄露 token', () => {
    for (const field of ['cellId', 'tenantId', 'origin', 'token'] as const) {
      const broken: Record<string, unknown> = { ...base }
      delete broken[field]
      expect(() => resolveConfig(broken as never)).toThrow(BindingLeaseConfigError)
    }
    try {
      resolveConfig({ ...base, token: 'short' })
      expect.unreachable('过短 token 必须被拒')
    } catch (error) {
      expect(String(error)).not.toContain('short')
    }
  })

  it('redact 抹掉 token，纵深防御日志泄漏', () => {
    expect(redact(`authorization: Bearer ${TEST_TOKEN} failed`, TEST_TOKEN)).toBe(
      'authorization: Bearer [redacted] failed',
    )
  })

  it('refreshOnAgentCreated 只接受布尔值', () => {
    expect(() => resolveConfig({ ...base, refreshOnAgentCreated: 'yes' as never })).toThrow(/布尔值/)
  })
})
