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
  MAX_INTERNAL_HTTP_ORIGINS,
  MAX_TTL_MS,
  normalizeInternalHttpOrigin,
  normalizeOrigin,
  redact,
  renderPath,
  resolveConfig,
  resolveInternalHttpOrigins,
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

describe('同机内部 HTTP 声明（ADR 0030）', () => {
  it('默认空列表：非回环明文仍然拒绝，回环与 HTTPS 照常', () => {
    expect(resolveInternalHttpOrigins(undefined)).toEqual([])
    expect(() => normalizeOrigin('http://bff:8791')).toThrow(/回环/)
    expect(normalizeOrigin('http://127.0.0.1:8081')).toBe('http://127.0.0.1:8081')
    expect(normalizeOrigin('https://works.internal:8443')).toBe('https://works.internal:8443')
  })

  it('声明后只放行精确匹配的 origin：端口不匹配、公网域名、IP 全部仍拒绝', () => {
    const allowed = resolveInternalHttpOrigins(['http://bff:8791', 'http://gateway:8790'])
    expect(allowed).toEqual(['http://bff:8791', 'http://gateway:8790'])
    expect(normalizeOrigin('http://bff:8791', allowed)).toBe('http://bff:8791')
    expect(normalizeOrigin('http://gateway:8790', allowed)).toBe('http://gateway:8790')
    // 精确匹配：声明了 8791 不等于放行 8792 / 无端口 / 其它主机。
    expect(() => normalizeOrigin('http://bff:8792', allowed)).toThrow(/回环/)
    expect(() => normalizeOrigin('http://bff', allowed)).toThrow(/回环/)
    expect(() => normalizeOrigin('http://evil.example:8791', allowed)).toThrow(/回环/)
    expect(() => normalizeOrigin('http://10.0.0.7:8791', allowed)).toThrow(/回环/)
    // 大写的规范写法会被 `new URL` 折成小写 origin，与声明一致才放行。
    expect(normalizeOrigin('http://BFF:8791', allowed)).toBe('http://bff:8791')
  })

  it('拒绝通配符、路径、查询、凭据、非 HTTP 协议与多标签域名', () => {
    const invalid = [
      'http://*:8791',
      'http://*.bff:8791',
      'http://bff:8791/path',
      'http://bff:8791/',
      'http://bff:8791?x=1',
      'http://bff:8791#frag',
      'http://user:secret@bff:8791',
      'https://bff:8791',
      'ftp://bff:8791',
      'http://8.8.8.8:8791',
      'http://bff.example:8791',
      'http://[::1]:8791',
      'not-a-url',
      '',
    ]
    for (const origin of invalid) {
      expect(() => normalizeInternalHttpOrigin(origin), `rejected ${origin}`).toThrow(BindingLeaseConfigError)
    }
  })

  it('声明本身不是字符串数组、超长或含非法项都拒绝，且不回显原始值', () => {
    expect(() => resolveInternalHttpOrigins('http://bff:8791')).toThrow(/字符串数组/)
    expect(() => resolveInternalHttpOrigins([null])).toThrow(BindingLeaseConfigError)
    expect(() => resolveInternalHttpOrigins(Array.from({ length: MAX_INTERNAL_HTTP_ORIGINS + 1 }, () => 'http://bff:8791')))
      .toThrow(/最多/)
    // 非法项即使与本次 origin 无关也必须在启动时失败，而不是被忽略。
    expect(() => resolveConfig({ ...base, internalHttpOrigins: ['http://bff:8791', 'http://*:1'] }))
      .toThrow(BindingLeaseConfigError)
    try {
      resolveInternalHttpOrigins(['http://user:secret@bff:8791'])
      expect.unreachable('内嵌凭据必须被拒')
    } catch (error) {
      expect(String(error)).not.toContain('secret')
    }
  })

  it('声明去重并保持顺序；resolveConfig 把它带进解析结果', () => {
    const cfg = resolveConfig({
      ...base,
      origin: 'http://bff:8791',
      internalHttpOrigins: ['http://bff:8791', 'http://gateway:8790', 'http://bff:8791'],
    })
    expect(cfg.origin).toBe('http://bff:8791')
    expect(cfg.internalHttpOrigins).toEqual(['http://bff:8791', 'http://gateway:8790'])
    // 默认（未声明）时解析结果仍是空数组，而不是 undefined。
    expect(resolveConfig(base).internalHttpOrigins).toEqual([])
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
