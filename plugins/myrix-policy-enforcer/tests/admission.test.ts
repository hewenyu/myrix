/**
 * PEP 判定内核的穷举测试：每个拒绝分支都必须能说清"为什么拒"。
 */
import { describe, expect, it } from 'vitest'
import { NOVEL_TOOL_ALLOWLIST, admitTool, assertPolicySnapshot } from '../src/admission'
import type { AdmissionInput, PolicySnapshot } from '../src/types'

const NOW = 1_790_000_000_000

function input(overrides: Partial<AdmissionInput> = {}): AdmissionInput {
  return {
    principal: { ok: true, principal: { sid: 'sid-1', tid: 't_acme', sub: 'u_1', rev: 3 } },
    toolName: 'save_chapter_draft',
    allowedTools: NOVEL_TOOL_ALLOWLIST,
    snapshot: { rev: 5, tid: 't_acme', expiresAt: NOW + 60_000, tools: [...NOVEL_TOOL_ALLOWLIST] },
    now: NOW,
    ...overrides,
  }
}

describe('allowlist 的形状', () => {
  it('恰好是 6 个小说工具，且不含任何泛能力工具', () => {
    expect(NOVEL_TOOL_ALLOWLIST).toHaveLength(6)
    expect([...NOVEL_TOOL_ALLOWLIST].sort()).toEqual([
      'get_chapter',
      'get_outline',
      'save_chapter_draft',
      'search_bible',
      'update_bible_entry',
      'update_outline',
    ])
    const forbidden = ['bash', 'shell', 'fs', 'read_file', 'write_file', 'web_fetch', 'web_search',
      'run_code', 'job', 'jobs', 'goal', 'goals', 'subagent', 'workflow', 'terminal']
    for (const name of forbidden) expect(NOVEL_TOOL_ALLOWLIST).not.toContain(name)
  })
})

describe('admitTool 放行路径', () => {
  it('身份有效 + 在交集内 → 放行', () => {
    expect(admitTool(input())).toEqual({ allow: true })
  })
})

describe('admitTool 拒绝路径（逐条）', () => {
  it('工具名为空 → 拒绝', () => {
    const result = admitTool(input({ toolName: '' }))
    expect(result.allow).toBe(false)
  })

  it('身份缺失 → 拒绝（guard 的兜底职责）', () => {
    const result = admitTool(input({ principal: { ok: false, reason: 'unbound', detail: '该 Agent 没有绑定授权主体' } }))
    expect(result.allow).toBe(false)
    if (!result.allow) expect(result.reason).toContain('没有有效身份')
  })

  it('身份已撤权 → 拒绝', () => {
    const result = admitTool(input({ principal: { ok: false, reason: 'revoked', detail: '会话已撤权' } }))
    expect(result.allow).toBe(false)
    if (!result.allow) expect(result.reason).toContain('revoked')
  })

  it('允许列表未安装（undefined） → 拒绝，不能当作"不限制"', () => {
    const result = admitTool(input({ allowedTools: undefined as unknown as readonly string[] }))
    expect(result.allow).toBe(false)
    if (!result.allow) expect(result.reason).toContain('未安装工具 allowlist')
  })

  it('允许列表为空数组 → 同样拒绝', () => {
    const result = admitTool(input({ allowedTools: [] }))
    expect(result.allow).toBe(false)
  })

  it('工具不在静态 allowlist → 拒绝', () => {
    const result = admitTool(input({ toolName: 'bash' }))
    expect(result.allow).toBe(false)
    if (!result.allow) expect(result.reason).toContain('不在授权 allowlist')
  })

  it('策略快照缺失 → 拒绝', () => {
    const result = admitTool(input({ snapshot: undefined }))
    expect(result.allow).toBe(false)
    if (!result.allow) expect(result.reason).toContain('没有可用的策略快照')
  })

  it('策略快照刚好到期（半开区间） → 拒绝', () => {
    const snapshot: PolicySnapshot = { rev: 5, tid: 't_acme', expiresAt: NOW, tools: ['save_chapter_draft'] }
    const result = admitTool(input({ snapshot }))
    expect(result.allow).toBe(false)
    if (!result.allow) expect(result.reason).toContain('已过期')
  })

  it('策略快照过期 1ms 前仍有效', () => {
    const snapshot: PolicySnapshot = { rev: 5, tid: 't_acme', expiresAt: NOW + 1, tools: ['save_chapter_draft'] }
    expect(admitTool(input({ snapshot, now: NOW })).allow).toBe(true)
  })

  it('策略快照非法 expiresAt（NaN） → 拒绝', () => {
    const snapshot = { rev: 5, tid: 't_acme', expiresAt: Number.NaN, tools: ['save_chapter_draft'] }
    expect(admitTool(input({ snapshot })).allow).toBe(false)
  })

  it('策略快照租户与主体租户不一致 → 拒绝', () => {
    const snapshot: PolicySnapshot = { rev: 5, tid: 't_other', expiresAt: NOW + 1000, tools: ['save_chapter_draft'] }
    const result = admitTool(input({ snapshot }))
    expect(result.allow).toBe(false)
    if (!result.allow) expect(result.reason).toContain('租户与本会话不一致')
  })

  it('快照只能收窄：不在快照里的工具仍被拒（即便在静态 allowlist 内）', () => {
    const snapshot: PolicySnapshot = { rev: 5, tid: 't_acme', expiresAt: NOW + 1000, tools: ['get_outline'] }
    const result = admitTool(input({ toolName: 'save_chapter_draft', snapshot }))
    expect(result.allow).toBe(false)
    if (!result.allow) expect(result.reason).toContain('未被当前策略快照允许')
  })

  it('快照不能放宽静态 allowlist：快照里有 bash 也仍然拒绝', () => {
    const snapshot: PolicySnapshot = { rev: 5, tid: 't_acme', expiresAt: NOW + 1000, tools: ['bash'] }
    const result = admitTool(input({ toolName: 'bash', snapshot }))
    expect(result.allow).toBe(false)
    if (!result.allow) expect(result.reason).toContain('不在授权 allowlist')
  })

  it('拒绝原因被截断，不会把上游字符串原样放大', () => {
    const long = 'x'.repeat(1000)
    const result = admitTool(input({ principal: { ok: false, reason: 'unbound', detail: long } }))
    expect(result.allow).toBe(false)
    if (!result.allow) expect(result.reason.length).toBeLessThanOrEqual(241)
  })
})

describe('assertPolicySnapshot 形状校验', () => {
  it('接受合法快照', () => {
    const snapshot = assertPolicySnapshot({ rev: 1, tid: 't', expiresAt: 1, tools: ['a'] })
    expect(snapshot.tools).toEqual(['a'])
  })

  it('拒绝非法快照（逐项）', () => {
    expect(() => assertPolicySnapshot(null)).toThrow()
    expect(() => assertPolicySnapshot({ tid: 't', expiresAt: 1, tools: [] })).toThrow(/rev/)
    expect(() => assertPolicySnapshot({ rev: -1, tid: 't', expiresAt: 1, tools: [] })).toThrow(/rev/)
    expect(() => assertPolicySnapshot({ rev: 1, expiresAt: 1, tools: [] })).toThrow(/tid/)
    expect(() => assertPolicySnapshot({ rev: 1, tid: 't', tools: [] })).toThrow(/expiresAt/)
    expect(() => assertPolicySnapshot({ rev: 1, tid: 't', expiresAt: 1, tools: [1] })).toThrow(/tools/)
  })

  it('快照的 tools 被冻结，安装后不可被就地篡改', () => {
    const snapshot = assertPolicySnapshot({ rev: 1, tid: 't', expiresAt: 1, tools: ['a'] })
    expect(Object.isFrozen(snapshot.tools)).toBe(true)
  })
})
