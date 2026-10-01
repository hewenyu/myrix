/**
 * 快照解析与六字段等值判定的测试。
 *
 * 这一层是"身份被认成另一个身份"的最后一道：解析必须拒绝一切不符合线协议
 * 的响应，判定必须逐字段比较。
 */
import { describe, expect, it } from 'vitest'
import type { Principal } from '@myrix/principals'
import { LeaseCache, parsePolicy, parseSnapshot, toWireSnapshot } from '../src/index'
import { policyPayload, snapshotPayload } from './harness'

const expected = { cellId: 'cell-1', tenantId: 't_acme' }
const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))

function parse(value: unknown) {
  return parseSnapshot(encode(value), expected)
}

function principal(overrides: Partial<Principal> = {}): Principal {
  return { sid: 'sid-1', tid: 't_acme', sub: 'u_1', wid: 'w_1', preset: 'novel-chapter', rev: 7, ...overrides }
}

describe('parseSnapshot 拒绝面', () => {
  it('接受合法快照并保留六字段', () => {
    const result = parse(snapshotPayload([{ sid: 'sid-1' }]))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.snapshot.rows).toEqual([principal()])
  })

  it('拒绝非 JSON / 非 UTF-8 / 非对象', () => {
    expect(parseSnapshot(new Uint8Array([0xff, 0xfe, 0xfd]), expected).ok).toBe(false)
    expect(parseSnapshot(new TextEncoder().encode('not json'), expected).ok).toBe(false)
    expect(parse(42).ok).toBe(false)
    expect(parse([]).ok).toBe(false)
  })

  it('拒绝跨 cell 与跨租户的快照', () => {
    const wrongCell = parse(snapshotPayload([{ sid: 's' }], { cellId: 'cell-2' }))
    expect(wrongCell.ok).toBe(false)
    if (!wrongCell.ok) expect(wrongCell.failure.rejection).toBe('wrong-cell')

    const wrongTenant = parse(snapshotPayload([{ sid: 's' }], { tenantId: 't_other' }))
    expect(wrongTenant.ok).toBe(false)
    if (!wrongTenant.ok) expect(wrongTenant.failure.rejection).toBe('wrong-tenant')
  })

  it('拒绝行级 tid 与快照租户不一致', () => {
    const result = parse(snapshotPayload([{ sid: 's', tid: 't_other' }]))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.rejection).toBe('wrong-tenant')
  })

  it('拒绝重复 sid（两份矛盾记录无法判断真假）', () => {
    const result = parse(snapshotPayload([{ sid: 'dup' }, { sid: 'dup', rev: 9 }]))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.rejection).toBe('duplicate-sid')
  })

  it('拒绝畸形行与未知字段（wire 漂移必须显式暴露）', () => {
    const malformed = [
      { bindings: [{ sid: 's' }] },
      { bindings: [{ sid: 's', tid: 't_acme', sub: 'u', wid: 'w', preset: 'p', rev: -1 }] },
      { bindings: [{ sid: 's', tid: 't_acme', sub: 'u', wid: 'w', preset: 'p', rev: 1.5 }] },
      { bindings: [{ sid: '', tid: 't_acme', sub: 'u', wid: 'w', preset: 'p', rev: 1 }] },
      { bindings: [{ sid: 's', tid: 't_acme', sub: 'u', wid: 'w', preset: 'p', rev: 1, body: '正文' }] },
      { bindings: [null] },
      { bindings: 'nope' },
    ]
    for (const payload of malformed) {
      const result = parse({ cellId: 'cell-1', tenantId: 't_acme', ...payload })
      expect(result.ok).toBe(false)
    }
  })

  it('拒绝超过 10,000 行的快照', () => {
    const rows = Array.from({ length: 10_001 }, (_, index) => ({ sid: `s-${index}` }))
    const result = parse(snapshotPayload(rows))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.rejection).toBe('too-large')
  })

  it('接受恰好 10,000 行', () => {
    const rows = Array.from({ length: 10_000 }, (_, index) => ({ sid: `s-${index}` }))
    expect(parse(snapshotPayload(rows)).ok).toBe(true)
  })
})

describe('可选的 policy 字段（向后兼容 + 六个工具名收窄）', () => {
  it('没有 policy 字段时解析成功且 policy 为 undefined（老服务端）', () => {
    const result = parse(snapshotPayload([{ sid: 'sid-1' }]))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.snapshot.policy).toBeUndefined()
  })

  it('合法 policy 被解析、冻结工具数组并去重', () => {
    const result = parse(snapshotPayload([{ sid: 'sid-1' }], { policy: policyPayload({ tools: ['get_outline', 'get_outline', 'search_bible'] }) }))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.snapshot.policy).toMatchObject({ rev: 1, tools: ['get_outline', 'search_bible'], ttlMs: 8_000 })
      expect(Object.isFrozen(result.snapshot.policy?.tools)).toBe(true)
    }
  })

  it('显式空 tools 是合法值（= 什么都不允许），不等于"没有策略"', () => {
    const result = parse(snapshotPayload([{ sid: 'sid-1' }], { policy: policyPayload({ tools: [] }) }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.snapshot.policy?.tools).toEqual([])
  })

  const badPolicies: readonly [string, unknown][] = [
    ['非对象', 'all'],
    ['未知字段', { ...policyPayload(), scope: 'tenant' }],
    ['rev 为负', policyPayload({ rev: -1 })],
    ['rev 非整数', { rev: 1.5, tools: [], ttlMs: 1_000 }],
    ['ttlMs 为 0', policyPayload({ ttlMs: 0 })],
    ['ttlMs 超过 30 秒', policyPayload({ ttlMs: 30_001 })],
    ['tools 非数组', { rev: 1, tools: 'get_outline', ttlMs: 1_000 }],
    ['tools 含空串', policyPayload({ tools: [''] })],
    ['tools 含非六个已知工具', policyPayload({ tools: ['bash'] })],
  ]
  for (const [label, policy] of badPolicies) {
    it(`${label} → malformed-policy 且整份快照被拒`, () => {
      const result = parse(snapshotPayload([{ sid: 'sid-1' }], { policy }))
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.failure.rejection).toBe('malformed-policy')
    })
  }

  it('顶层未知字段也被拒（wire 漂移显式失败）', () => {
    const payload = { ...snapshotPayload([{ sid: 'sid-1' }]), extra: 1 }
    const result = parse(payload)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.rejection).toBe('malformed-json')
  })

  it('parsePolicy 直接调用的形状校验', () => {
    expect(parsePolicy(undefined)).toEqual({ ok: true, policy: undefined })
    const ok = parsePolicy(policyPayload({ rev: 7 }))
    expect(ok).toMatchObject({ ok: true, policy: { rev: 7 } })
  })

  it('toWireSnapshot 保留可选 policy，且六字段仍然逐字不变', () => {
    const parsed = parse(snapshotPayload([{ sid: 'sid-1' }], { policy: policyPayload({ rev: 4 }) }))
    if (!parsed.ok) throw new Error('应当解析成功')
    const wire = toWireSnapshot(parsed.snapshot, expected)
    expect(wire).toMatchObject({ cellId: 'cell-1', tenantId: 't_acme', policy: { rev: 4 } })
    expect(wire.bindings).toEqual([principal()])
    expect(Object.keys(wire.bindings[0]!).sort()).toEqual(['preset', 'rev', 'sid', 'sub', 'tid', 'wid'])
  })
})

describe('LeaseCache：先 TTL 再六字段全等', () => {
  it('无快照一律 false', () => {
    const cache = new LeaseCache()
    expect(cache.lookup(principal(), 0)).toBe(false)
    expect(cache.active(0)).toBe(false)
  })

  it('六字段逐一不等都必须拒绝，不能只看 sid/rev', () => {
    const cache = new LeaseCache()
    cache.install([principal()], 100, 1_000)
    expect(cache.lookup(principal(), 200)).toBe(true)
    for (const field of ['tid', 'sub', 'wid', 'preset', 'rev'] as const) {
      const mutated = field === 'rev' ? principal({ rev: 8 }) : principal({ [field]: 'x' } as Partial<Principal>)
      expect(cache.lookup(mutated, 200)).toBe(false)
    }
    // sid 不同（快照里没有这一行）也必须拒绝。
    expect(cache.lookup(principal({ sid: 'sid-2' }), 200)).toBe(false)
  })

  it('过期发生在到期瞬间（半开区间），且过期后行还在表里但判定为 false', () => {
    const cache = new LeaseCache()
    cache.install([principal()], 100, 1_000)
    expect(cache.lookup(principal(), 1_099)).toBe(true)
    expect(cache.lookup(principal(), 1_100)).toBe(false)
    expect(cache.active(1_100)).toBe(false)
    // 行没被删：这是"租约失效"而不是"数据被篡改"，诊断上要能区分。
    expect(cache.size()).toBe(1)
  })

  it('租约时长从请求开始算：下载耗时直接吃掉有效期', () => {
    const cache = new LeaseCache()
    // 请求在 t=100 开始，安装发生在 t=1_500（下载用了 1400ms），TTL=1000：
    // 到期时刻是 100+1000=1100，而不是 1500+1000。
    cache.install([principal()], 100, 1_000)
    expect(cache.state(1_050).expiresAt).toBe(1_100)
    expect(cache.lookup(principal(), 1_050)).toBe(true)
    expect(cache.lookup(principal(), 1_100)).toBe(false)
  })

  it('clear 后判定立即 false，并记录清除次数与原因', () => {
    const cache = new LeaseCache()
    cache.install([principal()], 0, 1_000)
    cache.clear('http-status', 10)
    expect(cache.lookup(principal(), 10)).toBe(false)
    expect(cache.state(10)).toMatchObject({ active: false, bindings: 0, clears: 1, lastRejection: 'http-status' })
  })

  it('安装是替换而不是合并：新快照里没有的行立即失效', () => {
    const cache = new LeaseCache()
    cache.install([principal({ sid: 'a' }), principal({ sid: 'b' })], 0, 1_000)
    expect(cache.lookup(principal({ sid: 'b' }), 1)).toBe(true)
    cache.install([principal({ sid: 'a' })], 10, 1_000)
    expect(cache.lookup(principal({ sid: 'b' }), 11)).toBe(false)
    expect(cache.size()).toBe(1)
  })
})
