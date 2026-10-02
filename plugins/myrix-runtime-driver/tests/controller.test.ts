/**
 * 控制器测试：用真密钥、真凭证、真 ES256 验签。
 *
 * 每个用例都在验证一条安全属性（凭证绑定、幂等、撤权顺序、排空证明），
 * 而不是实现细节。DSH 侧用 `fake-dsh.ts` 的行为替身，缺口在文件末尾列明。
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  createGrantSigner,
  createGrantVerifier,
  generateTestKeyPair,
  sha256Hex,
} from '@myrix/grant'
import type { GrantOperation } from '@myrix/grant'
import { PrincipalRegistry } from '@myrix/principals'
import { CommandError, SessionController } from '../src/controller'
import type { ControllerHost } from '../src/controller'
import { createFakeRuntime, type FakeDisk, type FakeRuntime } from './fake-dsh'

const NOW = 1_790_000_000
const CELL = 'cell-u_1'
const TENANT = 't_acme'
const BOOT = 'boot-test-0001'
const ISSUER = 'myrix-control-plane'

const key = generateTestKeyPair('kid-2026-09')

interface Harness {
  readonly runtime: FakeRuntime
  readonly controller: SessionController
  readonly signer: ReturnType<typeof createGrantSigner>
  readonly registry: PrincipalRegistry
  /** 让控制器认为会话已撤权。 */
  readonly revokeSid: (sid: string, rev?: number) => void
  /** 关闭身份活性（模拟"无法证明仍然有效"）。 */
  readonly setLiveness: (alive: boolean | undefined) => void
  /** 发出一个合法命令。 */
  readonly sendCommand: (input: {
    op: GrantOperation
    sid: string
    commandId: string
    body?: Record<string, unknown>
    sub?: string
    rev?: number
    rawBodyOverride?: string
  }) => Promise<{ status: string; commandId: string; bootId: string; note?: string }>
}

function harness(options: { disk?: FakeDisk } = {}): Harness {
  const runtime = createFakeRuntime(options.disk)
  const registry = new PrincipalRegistry(new Context())
  registry.setLiveness(() => true)
  // 把行为替身的 bindPrincipal 接到**真实**的身份表上：
  // 这样"setup 内绑定身份"这条路径是被真的走通的，而不是被替换掉的。
  const baseBind = runtime.ports.bindPrincipal
  runtime.ports.bindPrincipal = (agent, principal) => {
    const unbind = registry.bind(agent as unknown as Agent, principal)
    const traceUnbind = baseBind(agent, principal)
    return () => {
      traceUnbind()
      unbind()
    }
  }

  let clockSeconds = NOW
  const signer = createGrantSigner({
    privateKey: key.privateKey,
    kid: 'kid-2026-09',
    issuer: ISSUER,
    clock: () => clockSeconds,
  })
  const verifier = createGrantVerifier({
    audience: CELL,
    tenantId: TENANT,
    bootId: BOOT,
    startedAt: NOW - 100,
    issuer: ISSUER,
    keys: [key.jwk],
    clock: () => clockSeconds,
  })

  const host: ControllerHost = {
    lookupPrincipal(agent) {
      const result = registry.lookup(agent as unknown as Agent | undefined)
      return result.ok
        ? { ok: true, principal: result.principal }
        : { ok: false, reason: result.reason, detail: result.detail }
    },
    lookupPrincipalBySession(sid) {
      const result = registry.lookupBySession(sid)
      return result.ok
        ? { ok: true, principal: result.principal }
        : { ok: false, reason: result.reason, detail: result.detail }
    },
    revoke(request) {
      const outcome = registry.revoke(request)
      return { accepted: outcome.accepted, reason: outcome.reason }
    },
    isRevoked(sid) {
      return registry.isRevoked(sid)
    },
    highWaterRev(sid) {
      return registry.highWaterRev(sid)
    },
  }

  const controller = new SessionController(runtime.ports, host, verifier, BOOT)

  const sendCommand: Harness['sendCommand'] = async (input) => {
    const body = JSON.stringify({
      op: input.op,
      sid: input.sid,
      commandId: input.commandId,
      ...(input.body ?? {}),
    })
    const raw = Buffer.from(input.rawBodyOverride ?? body, 'utf8')
    const token = signer.issue({
      aud: CELL,
      boot: BOOT,
      tid: TENANT,
      sid: input.sid,
      sub: input.sub ?? 'u_1',
      wid: 'w_1',
      preset: 'novel-chapter',
      rev: input.rev ?? 3,
      op: input.op,
      cmd: input.commandId,
      rawBody: raw,
    })
    return controller.command(raw, sha256Hex(raw), token.token)
  }

  return {
    runtime,
    controller,
    signer,
    registry,
    revokeSid: (sid, rev = 1) => {
      registry.revoke({ sid, rev, reason: 'test revoke' })
    },
    setLiveness: (alive) => {
      if (alive === undefined) registry.setLiveness(undefined)
      else registry.setLiveness(() => alive)
    },
    sendCommand,
  }
}

const SID = 'sid-1'

describe('命令准入：凭证绑定', () => {
  it('缺 Bearer 直接拒绝（401）', async () => {
    const h = harness()
    const raw = Buffer.from(JSON.stringify({ op: 'create', sid: SID, commandId: 'c1' }), 'utf8')
    await expect(h.controller.command(raw, sha256Hex(raw), undefined)).rejects.toMatchObject({
      status: 401,
      code: 'grant_missing',
    })
  })

  it('请求体被换掉（bh 不符）时拒绝', async () => {
    const h = harness()
    const signed = JSON.stringify({ op: 'create', sid: SID, commandId: 'c1' })
    const raw = Buffer.from(signed, 'utf8')
    const token = h.signer.issue({
      aud: CELL, boot: BOOT, tid: TENANT, sid: SID, sub: 'u_1', wid: 'w_1',
      preset: 'novel-chapter', rev: 3, op: 'create', cmd: 'c1', rawBody: raw,
    })
    // 攻击者换了正文但沿用旧凭证。
    const tampered = Buffer.from(JSON.stringify({ op: 'create', sid: SID, commandId: 'c1', text: '注入' }), 'utf8')
    await expect(h.controller.command(tampered, sha256Hex(tampered), token.token)).rejects.toMatchObject({
      status: 403,
      code: 'grant/body-hash-mismatch',
    })
  })

  it('两枚不同命令的凭证不能互换（cmd 不符）', async () => {
    const h = harness()
    const raw = Buffer.from(JSON.stringify({ op: 'create', sid: SID, commandId: 'c2' }), 'utf8')
    const token = h.signer.issue({
      aud: CELL, boot: BOOT, tid: TENANT, sid: SID, sub: 'u_1', wid: 'w_1',
      preset: 'novel-chapter', rev: 3, op: 'create', cmd: 'c1', rawBody: raw,
    })
    await expect(h.controller.command(raw, sha256Hex(raw), token.token)).rejects.toMatchObject({
      code: 'grant/operation-mismatch',
    })
  })

  it('同一枚凭证不能用两次（jti 一次性）', async () => {
    const h = harness()
    const raw = Buffer.from(JSON.stringify({ op: 'create', sid: SID, commandId: 'c1' }), 'utf8')
    const token = h.signer.issue({
      aud: CELL, boot: BOOT, tid: TENANT, sid: SID, sub: 'u_1', wid: 'w_1',
      preset: 'novel-chapter', rev: 3, op: 'create', cmd: 'c1', rawBody: raw,
    })
    await h.controller.command(raw, sha256Hex(raw), token.token)
    await expect(h.controller.command(raw, sha256Hex(raw), token.token)).rejects.toMatchObject({
      code: 'grant/replayed',
    })
  })

  it('未知 op 在解析阶段就被拒绝', async () => {
    const h = harness()
    const raw = Buffer.from(JSON.stringify({ op: 'drain', sid: SID, commandId: 'c1' }), 'utf8')
    await expect(h.controller.command(raw, sha256Hex(raw), 'x.y.z')).rejects.toMatchObject({
      status: 400,
      code: 'unsupported_operation',
    })
  })
})

describe('create/resume：setup 内的身份绑定', () => {
  it('setup 里**先绑定身份、再 mount preset**，最后执行 commit', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    const trace = h.runtime.setups[0]
    // 顺序是安全属性：新 preset（myrix-novel）在加载期就 require principal，
    // 先 mount 会让它读不到主体。
    expect(trace?.order).toEqual(['bind', 'mount', 'commit'])
    expect(trace?.mounted).toEqual(['novel-chapter'])
    expect(trace?.bound).toEqual([SID])
    expect(trace?.committed).toBe(1)
    // 绑定确实进了身份表。
    expect(h.registry.bySession(SID)?.sub).toBe('u_1')
  })

  it('mount 期间主体已经可被读到（新 preset require principal 的负例）', async () => {
    const h = harness()
    const seen: (string | undefined)[] = []
    // 模拟 preset 加载期同步 require principal。
    h.runtime.mountProbe = (sid) => {
      seen.push(h.registry.bySession(sid)?.sub)
    }
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    expect(seen).toEqual(['u_1'])
  })

  it('mount 失败时绑定被同步解除，不留下"绑了身份但没挂上 preset"的半成品', async () => {
    const h = harness()
    h.runtime.failMount = 'preset 加载失败'
    await expect(h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })).rejects.toMatchObject({
      code: 'open_failed',
    })
    expect(h.runtime.setups[0]?.bound).toEqual([])
    expect(h.registry.bySession(SID)).toBeUndefined()
    expect(h.controller.liveCount).toBe(0)
  })

  it('preset 未真正挂载时拒绝，且不留下 live 会话', async () => {
    const h = harness()
    h.runtime.mountAs = 'other-preset'
    await expect(h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })).rejects.toMatchObject({
      code: 'preset_not_mounted',
    })
    expect(h.controller.liveCount).toBe(0)
    // setup 抛错时 create 根本没有返回句柄：DSH 自己负责回滚未发布的 Agent
    // （agent-loop 的 initializeAgent 会在 setup 失败后 dispose）。
    // 控制器这侧要保证的是"没有登记 live"。
    expect(h.runtime.setups[0]?.mounted).toEqual(['novel-chapter'])
  })

  it('create 之后 flush 成功才登记为 live（回执晚于持久化）', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    expect(h.runtime.flushes.map((f) => f.sid)).toContain(SID)
    expect(h.controller.liveCount).toBe(1)
  })

  it('flush 没有监听者时拒绝打开并销毁 Agent', async () => {
    const h = harness()
    h.runtime.failFlush = true
    await expect(h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })).rejects.toMatchObject({
      code: 'not_persisted',
    })
    expect(h.controller.liveCount).toBe(0)
    expect(h.runtime.disposed.get(SID)).toBe(1)
  })

  it('resume 时磁盘 preset 与凭证不一致被拒（P2 负例）', async () => {
    const h = harness()
    // 先用 create+flush 把 preset 写进磁盘，再模拟重启后 resume。
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c0' })
    const restarted = harness({ disk: h.runtime.disk })
    restarted.runtime.disk.preset.set(SID, 'novel-bible')
    await expect(restarted.sendCommand({ op: 'resume', sid: SID, commandId: 'c1' })).rejects.toMatchObject({
      status: 409,
      code: 'preset_mismatch',
    })
    expect(restarted.controller.liveCount).toBe(0)
  })

  it('resume 时磁盘 preset 一致则正常恢复（重启后走真实 resume 路径）', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c0' })
    const restarted = harness({ disk: h.runtime.disk })
    await restarted.sendCommand({ op: 'resume', sid: SID, commandId: 'c1' })
    expect(restarted.controller.liveCount).toBe(1)
    expect(restarted.runtime.setups[0]?.op).toBe('resume')
  })

  it('resume 一个磁盘上不存在的会话被明确拒绝（不是底层异常）', async () => {
    const h = harness()
    await expect(h.sendCommand({ op: 'resume', sid: SID, commandId: 'c1' })).rejects.toMatchObject({
      status: 409,
      code: 'session_not_found',
    })
    expect(h.controller.liveCount).toBe(0)
  })

  it('create 重试遇到磁盘已有会话时改走 resume，不覆盖（同 commandId 之外的新命令）', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c0' })
    const restarted = harness({ disk: h.runtime.disk })
    // 新的 commandId + op=create，但磁盘已有该会话：必须走 resume 而不是 create。
    await restarted.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    expect(restarted.runtime.setups[0]?.op).toBe('resume')
  })

  it('create 失败时错误被翻译成不含原始异常细节之外的稳定码', async () => {
    const h = harness()
    h.runtime.failOpen = 'backend down'
    await expect(h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })).rejects.toMatchObject({
      code: 'open_failed',
    })
  })

  it('会话已打开时，其他用户用自己的合法凭证 resume/create 也会被拒（复用路径要查所有者）', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1', sub: 'u_1' })
    await expect(
      h.sendCommand({ op: 'resume', sid: SID, commandId: 'c2', sub: 'u_2' }),
    ).rejects.toMatchObject({ code: 'not_owner' })
    // 也没有因此重开一个新 Agent。
    expect(h.runtime.setups).toHaveLength(1)
  })

  it('所有者重复 resume 是幂等的（复用同一 Agent）', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    await h.sendCommand({ op: 'resume', sid: SID, commandId: 'c2' })
    expect(h.runtime.setups).toHaveLength(1)
    expect(h.controller.liveCount).toBe(1)
  })

  it('已撤权会话在打开前就被拒绝', async () => {
    const h = harness()
    h.revokeSid(SID, 5)
    await expect(h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })).rejects.toMatchObject({
      code: 'session_revoked',
    })
    expect(h.runtime.setups).toHaveLength(0)
  })
})

describe('send：messageId = commandId 与 flush 语义', () => {
  it('send 把 commandId 作为 messageId 写进持久日志', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    await h.sendCommand({ op: 'send', sid: SID, commandId: 'c2', body: { text: '写一个开头' } })
    const events = h.runtime.sessions.get(SID)?.events ?? []
    const userEvent = events.find((e) => e.type === 'user/message')
    expect(userEvent).toBeDefined()
    expect((userEvent!.data as { id?: string }).id).toBe('c2')
  })

  it('messageId 与 commandId 不同时一律 400（不让 caller 躲过对账）', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    await expect(
      h.sendCommand({ op: 'send', sid: SID, commandId: 'c2', body: { text: 'hi', messageId: 'm-explicit' } }),
    ).rejects.toMatchObject({ status: 400, code: 'malformed_body' })
    // 也没有写进日志。
    const events = h.runtime.sessions.get(SID)?.events ?? []
    expect(events.filter((e) => e.type === 'user/message')).toHaveLength(0)
  })

  it('messageId 显式等于 commandId 时接受', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    await h.sendCommand({ op: 'send', sid: SID, commandId: 'c2', body: { text: 'hi', messageId: 'c2' } })
    const events = h.runtime.sessions.get(SID)?.events ?? []
    const userEvent = events.find((e) => e.type === 'user/message')
    expect(userEvent).toBeDefined()
    expect((userEvent!.data as { id?: string }).id).toBe('c2')
  })

  it('未打开的会话上 send 被拒绝（不会隐式创建）', async () => {
    const h = harness()
    await expect(
      h.sendCommand({ op: 'send', sid: SID, commandId: 'c1', body: { text: 'hi' } }),
    ).rejects.toMatchObject({ code: 'session_not_open' })
  })

  it('send 缺少正文被拒绝', async () => {
    const h = harness()
    const raw = Buffer.from(JSON.stringify({ op: 'send', sid: SID, commandId: 'c1' }), 'utf8')
    const token = h.signer.issue({
      aud: CELL, boot: BOOT, tid: TENANT, sid: SID, sub: 'u_1', wid: 'w_1',
      preset: 'novel-chapter', rev: 3, op: 'send', cmd: 'c1', rawBody: raw,
    })
    await expect(h.controller.command(raw, sha256Hex(raw), token.token)).rejects.toMatchObject({
      code: 'malformed_body',
    })
  })

  it('flush 失败时 send 返回错误而不是假装 accepted', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    h.runtime.failFlush = true
    await expect(
      h.sendCommand({ op: 'send', sid: SID, commandId: 'c2', body: { text: 'hi' } }),
    ).rejects.toMatchObject({ code: 'not_persisted' })
  })

  it('所有者不符时拒绝（同一租户其他用户也不行）', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    await expect(
      h.sendCommand({ op: 'send', sid: SID, commandId: 'c2', body: { text: 'hi' }, sub: 'u_2' }),
    ).rejects.toMatchObject({ code: 'not_owner' })
  })

  it('身份活性失效后 send 被拒绝', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    h.setLiveness(false)
    await expect(
      h.sendCommand({ op: 'send', sid: SID, commandId: 'c2', body: { text: 'hi' } }),
    ).rejects.toMatchObject({ code: 'identity_invalid' })
  })
})

describe('幂等：jti 与 commandId 分离', () => {
  it('同一 commandId 重试返回 duplicate，且不重复执行', async () => {
    const h = harness()
    const first = await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    expect(first.status).toBe('accepted')
    const second = await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    expect(second.status).toBe('duplicate')
    // 只执行过一次 setup。
    expect(h.runtime.setups).toHaveLength(1)
  })

  it('同一 commandId 换了 sid → 冲突（409）', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    await expect(h.sendCommand({ op: 'create', sid: 'sid-other', commandId: 'c1' })).rejects.toMatchObject({
      code: 'command_id_conflict',
    })
  })

  it('同一 commandId 换了正文 → 冲突（409）', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    await h.sendCommand({ op: 'send', sid: SID, commandId: 'c2', body: { text: 'hello' } })
    await expect(
      h.sendCommand({ op: 'send', sid: SID, commandId: 'c2', body: { text: 'different' } }),
    ).rejects.toMatchObject({ code: 'command_id_conflict' })
  })

  it('同一 commandId 换了 op → 冲突（409）', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    await expect(h.sendCommand({ op: 'resume', sid: SID, commandId: 'c1' })).rejects.toMatchObject({
      code: 'command_id_conflict',
    })
  })

  it('重启后同 commandId 的 send 重试不再重复 append（真实对账，不靠内存表）', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    await h.sendCommand({ op: 'send', sid: SID, commandId: 'c2', body: { text: 'hello' } })
    // 重启：新 runtime、内存回执表为空，只有共享磁盘还在。
    const restarted = harness({ disk: h.runtime.disk })
    const receipt = await restarted.sendCommand({ op: 'send', sid: SID, commandId: 'c2', body: { text: 'hello' } })
    // 磁盘上仍然只有一条 c2。
    const persisted = h.runtime.disk.sessions.get(SID) ?? []
    expect(persisted.filter((e) => e.type === 'user/message' && (e.data as { id?: string }).id === 'c2')).toHaveLength(1)
    expect(receipt.status).toBe('accepted')
  })

  it('会话活跃时，非所有者重试已存在的 commandId 被拒（不能靠对账抢认命令）', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1', sub: 'u_1' })
    // 第一次投递 flush 失败：消息已进内存日志，但没有回执。
    h.runtime.failFlush = true
    let flushError: unknown
    try {
      await h.sendCommand({ op: 'send', sid: SID, commandId: 'c2', body: { text: 'hello' }, sub: 'u_1' })
    } catch (error) {
      flushError = error
    }
    expect((flushError as { code?: string }).code).toBe('not_persisted')
    // u_2 用同 sid 的凭证重试 c2：对账本会命中内存日志，但所有者检查必须先拦下。
    await expect(
      h.sendCommand({ op: 'send', sid: SID, commandId: 'c2', body: { text: 'hello' }, sub: 'u_2' }),
    ).rejects.toMatchObject({ code: 'not_owner' })
  })

  it('重启后同 commandId 换了正文 → 409（记录存在但文本不同）', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    await h.sendCommand({ op: 'send', sid: SID, commandId: 'c2', body: { text: 'hello' } })
    const restarted = harness({ disk: h.runtime.disk })
    await expect(
      restarted.sendCommand({ op: 'send', sid: SID, commandId: 'c2', body: { text: 'different' } }),
    ).rejects.toMatchObject({ status: 409, code: 'command_id_conflict' })
    // 没有追加第二条。
    const persisted = h.runtime.disk.sessions.get(SID) ?? []
    expect(persisted.filter((e) => e.type === 'user/message')).toHaveLength(1)
  })

  it('reconcileFromHistory 能在崩溃后从持久日志认出已执行的 commandId（R3）', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    await h.sendCommand({ op: 'send', sid: SID, commandId: 'c2', body: { text: 'hello' } })
    const session = h.runtime.sessions.get(SID)
    expect(session).toBeDefined()
    // 模拟"内存回执表已丢"：直接查日志。
    expect(h.controller.reconcileFromHistory(session!, 'c2')).toBeTypeOf('number')
    expect(h.controller.reconcileFromHistory(session!, 'never-sent')).toBeUndefined()
  })
})

describe('cancel', () => {
  it('cancel 以 user 原因中止活跃轮次', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    await h.sendCommand({ op: 'cancel', sid: SID, commandId: 'c2' })
    expect(h.runtime.agents.get(SID)?.cancels).toEqual([{ kind: 'user' }])
  })

  it('未打开的会话上 cancel 被拒绝', async () => {
    const h = harness()
    await expect(h.sendCommand({ op: 'cancel', sid: SID, commandId: 'c1' })).rejects.toMatchObject({
      code: 'session_not_open',
    })
  })
})

describe('撤权：先失效身份，再 cancel，再 dispose', () => {
  it('撤权后身份立即失效、收到 disposed cancel、Agent 被销毁', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    const result = await h.controller.revoke({ sid: SID, rev: 9, reason: '成员被移除' })
    expect(result).toEqual({ accepted: true, disposed: true, reason: '已撤权并销毁 Agent' })
    expect(h.registry.isRevoked(SID)).toBe(true)
    expect(h.registry.bySession(SID)).toBeUndefined()
    expect(h.runtime.agents.has(SID)).toBe(false)
    expect(h.runtime.disposed.get(SID)).toBe(1)
    expect(h.controller.liveCount).toBe(0)
  })

  it('撤权不在活跃列表里的会话也算接受（记录撤权即可）', async () => {
    const h = harness()
    const result = await h.controller.revoke({ sid: 'sid-cold', rev: 3, reason: 'revoked' })
    expect(result.accepted).toBe(true)
    expect(result.disposed).toBe(false)
    expect(h.registry.isRevoked('sid-cold')).toBe(true)
  })

  it('旧 rev 的撤权通知被忽略（单调）', async () => {
    const h = harness()
    await h.controller.revoke({ sid: SID, rev: 9, reason: 'r9' })
    const stale = await h.controller.revoke({ sid: SID, rev: 3, reason: 'r3' })
    expect(stale.accepted).toBe(false)
    expect(stale.disposed).toBe(false)
    expect(h.registry.highWaterRev(SID)).toBe(9)
  })

  it('撤权后同会话的新命令被拒绝', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    await h.controller.revoke({ sid: SID, rev: 2, reason: 'revoked' })
    await expect(
      h.sendCommand({ op: 'send', sid: SID, commandId: 'c2', body: { text: 'hi' } }),
    ).rejects.toMatchObject({ code: 'session_revoked' })
  })
})

describe('排空：空闲证明', () => {
  it('没有活跃会话时立即返回 drained', async () => {
    const h = harness()
    const result = await h.controller.drain()
    expect(result.drained).toBe(true)
    expect(result.activeSessions).toBe(0)
  })

  it('对活跃会话等待 idle + inbox 空 + flush 后才 drained', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    const before = h.runtime.flushes.length
    const result = await h.controller.drain()
    expect(result.drained).toBe(true)
    expect(h.runtime.flushes.length).toBeGreaterThan(before)
  })

  it('inbox 非空时不返回 drained（不给假证明）', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    const agent = h.runtime.agents.get(SID)
    expect(agent).toBeDefined()
    // 手工塞一条未处理消息，模拟"还有工作没消费"。
    ;(agent!.inbox.nextTurn as unknown[]).push({ id: 'pending' })
    const result = await h.controller.drain()
    expect(result.drained).toBe(false)
    expect(result.reason).toContain('inbox')
  })

  it('flush 失败时不返回 drained', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    h.runtime.throwFlush = true
    const result = await h.controller.drain()
    expect(result.drained).toBe(false)
    expect(result.reason).toContain('flush')
  })

  it('drain 之后再来的命令被拒绝（准入已关闭）', async () => {
    const h = harness()
    await h.controller.drain()
    await expect(h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })).rejects.toMatchObject({
      status: 503,
      code: 'not_accepting',
    })
    expect(h.controller.accepting).toBe(false)
  })

  it('drain 幂等：重复调用返回同一结果且不再报错', async () => {
    const h = harness()
    const first = await h.controller.drain()
    const second = await h.controller.drain()
    expect(first.drained).toBe(true)
    expect(second.drained).toBe(true)
  })
})

describe('每会话串行锁', () => {
  it('同一会话的命令按到达顺序执行（前一条 settle 后才跑下一条）', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    const order: string[] = []
    const sessions = h.runtime.sessions.get(SID)!
    // 通过连续 send 观察日志顺序：第二条必然排在第一条之后。
    await Promise.all([
      h.sendCommand({ op: 'send', sid: SID, commandId: 'c2', body: { text: 'A' } }),
      h.sendCommand({ op: 'send', sid: SID, commandId: 'c3', body: { text: 'B' } }),
    ])
    for (const event of sessions.events) {
      if (event.type !== 'user/message') continue
      order.push((event.data as { id: string }).id)
    }
    expect(order).toEqual(['c2', 'c3'])
  })

  it('不同会话之间可以并行，互不阻塞', async () => {
    const h = harness()
    const results = await Promise.all([
      h.sendCommand({ op: 'create', sid: 'sid-a', commandId: 'ca' }),
      h.sendCommand({ op: 'create', sid: 'sid-b', commandId: 'cb' }),
    ])
    expect(results.map((r) => r.status)).toEqual(['accepted', 'accepted'])
    expect(h.controller.liveCount).toBe(2)
  })
})

describe('shutdown', () => {
  it('卸载会销毁全部活跃 Agent，并关闭准入', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: 'sid-a', commandId: 'ca' })
    await h.sendCommand({ op: 'create', sid: 'sid-b', commandId: 'cb' })
    await h.controller.shutdown()
    expect(h.controller.liveCount).toBe(0)
    expect(h.runtime.disposed.get('sid-a')).toBe(1)
    expect(h.runtime.disposed.get('sid-b')).toBe(1)
    expect(h.controller.accepting).toBe(false)
  })

  it('shutdown 幂等：重复调用不抛错', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: 'sid-a', commandId: 'ca' })
    await expect(h.controller.shutdown()).resolves.toBeUndefined()
    await expect(h.controller.shutdown()).resolves.toBeUndefined()
    expect(h.runtime.disposed.get('sid-a')).toBe(1)
  })
})

describe('错误对象形状', () => {
  it('CommandError 携带 status/code/stage，且 message 不含凭证', async () => {
    const h = harness()
    try {
      await h.sendCommand({ op: 'send', sid: SID, commandId: 'c1', body: { text: 'hi' } })
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(CommandError)
      const typed = error as CommandError
      expect(typed.status).toBe(409)
      expect(typed.code).toBe('session_not_open')
      expect(typed.message).not.toContain('eyJ')
    }
  })
})

/**
 * `authorizeReceipt`：`GET /v1/commands/:id` 的唯一授权入口。
 *
 * 这些负例存在的理由：GET 曾经只做 Bearer 语法解析，等于任何拿得到消息 id
 * 的人都能读他人会话的回执。现在的协议要求控制面为这次读取单独签一枚
 * `op=subscribe` / `cmd=receipt-<id>` / `bh=sha256("")` 的新凭证。
 */
describe('回执读取授权（authorizeReceipt）', () => {
  /** 签一枚回执凭证。 */
  function issueReceipt(
    h: Harness,
    commandId: string,
    overrides: {
      sid?: string
      op?: GrantOperation
      cmd?: string
      rawBody?: Buffer | string
      rev?: number
      sub?: string
    } = {},
  ): string {
    return h.signer.issue({
      aud: CELL,
      boot: BOOT,
      tid: TENANT,
      sid: overrides.sid ?? SID,
      sub: overrides.sub ?? 'u_1',
      wid: 'w_1',
      preset: 'novel-chapter',
      rev: overrides.rev ?? 3,
      op: overrides.op ?? 'subscribe',
      cmd: overrides.cmd ?? `receipt-${commandId}`,
      rawBody: overrides.rawBody ?? Buffer.alloc(0),
    }).token
  }

  it('POST 的凭证被消费后，新签的回执凭证可以读到回执', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    const receipt = h.controller.authorizeReceipt(issueReceipt(h, 'c1'), 'c1')
    expect(receipt).toMatchObject({ status: 'accepted', commandId: 'c1', bootId: BOOT })
  })

  it('同一枚回执凭证重放 → 403 grant/replayed', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    const token = issueReceipt(h, 'c1')
    expect(h.controller.authorizeReceipt(token, 'c1').commandId).toBe('c1')
    expect(() => h.controller.authorizeReceipt(token, 'c1')).toThrowError(
      expect.objectContaining({ code: 'grant/replayed' }),
    )
  })

  it('cmd 与路径不一致 → 403', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    expect(() => h.controller.authorizeReceipt(issueReceipt(h, 'c2'), 'c1')).toThrowError(
      expect.objectContaining({ status: 403, code: 'grant/operation-mismatch' }),
    )
  })

  it('bh 不是空正文摘要（复用带正文的凭证）→ 403', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    expect(() => h.controller.authorizeReceipt(issueReceipt(h, 'c1', { rawBody: 'x' }), 'c1')).toThrowError(
      expect.objectContaining({ status: 403, code: 'grant/body-hash-mismatch' }),
    )
  })

  it('op 不是 subscribe（复用 create 凭证）→ 403', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    expect(() => h.controller.authorizeReceipt(issueReceipt(h, 'c1', { op: 'create' }), 'c1')).toThrowError(
      expect.objectContaining({ status: 403, code: 'grant/operation-mismatch' }),
    )
  })

  it('缺凭证 → 401 grant_missing', () => {
    const h = harness()
    expect(() => h.controller.authorizeReceipt(undefined, 'c1')).toThrowError(
      expect.objectContaining({ status: 401, code: 'grant_missing' }),
    )
  })

  it('未知回执 → 404 no_receipt（会话本身已绑定）', async () => {
    const h = harness()
    // 先打开会话，让身份可用；再查一个不存在的 commandId。
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    expect(() => h.controller.authorizeReceipt(issueReceipt(h, 'nope'), 'nope')).toThrowError(
      expect.objectContaining({ status: 404, code: 'no_receipt' }),
    )
  })

  it('别人的凭证读我的回执 → 404 no_receipt（存在性不可探测）', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    // sid-b 也是活着的绑定，但它不是这条回执的所有者。
    await h.sendCommand({ op: 'create', sid: 'sid-b', commandId: 'cb' })
    expect(() => h.controller.authorizeReceipt(issueReceipt(h, 'c1', { sid: 'sid-b' }), 'c1')).toThrowError(
      expect.objectContaining({ status: 404, code: 'no_receipt' }),
    )
  })

  it('身份不可用（凭证 sid 未绑定）→ 403 identity_invalid，而不是 404', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    // 'sid-x' 从未绑定：无法证明身份 ⇒ 拒绝，且不回答回执是否存在。
    expect(() => h.controller.authorizeReceipt(issueReceipt(h, 'c1', { sid: 'sid-x' }), 'c1')).toThrowError(
      expect.objectContaining({ status: 403, code: 'identity_invalid' }),
    )
  })

  it('六字段不一致（rev 前进）→ 403 identity_mismatch', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    // 凭证 rev=4 与绑定表里的 rev=3 不一致。
    expect(() => h.controller.authorizeReceipt(issueReceipt(h, 'c1', { rev: 4 }), 'c1')).toThrowError(
      expect.objectContaining({ status: 403, code: 'identity_mismatch' }),
    )
  })

  it('撤权后 → 403 session_revoked', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    h.revokeSid(SID, 5)
    expect(() => h.controller.authorizeReceipt(issueReceipt(h, 'c1', { rev: 5 }), 'c1')).toThrowError(
      expect.objectContaining({ status: 403, code: 'session_revoked' }),
    )
  })

  it('活性不可用 → 403 identity_invalid（无法证明仍然有效就是拒绝）', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'c1' })
    h.setLiveness(false)
    expect(() => h.controller.authorizeReceipt(issueReceipt(h, 'c1'), 'c1')).toThrowError(
      expect.objectContaining({ status: 403, code: 'identity_invalid' }),
    )
  })

  it('回执属于另一个已绑定 sid 时一律 404（不能拿 200/403 区分存在性）', async () => {
    const h = harness()
    await h.sendCommand({ op: 'create', sid: 'sid-a', commandId: 'ca' })
    await h.sendCommand({ op: 'create', sid: SID, commandId: 'cb' })
    // 同一 commandId 但凭证 sid 是 SID：不能返回 sid-a 的回执。
    expect(() => h.controller.authorizeReceipt(issueReceipt(h, 'ca'), 'ca')).toThrowError(
      expect.objectContaining({ status: 404, code: 'no_receipt' }),
    )
  })
})

/**
 * 明确记录的缺口（不宣称已覆盖）：
 * - 没有真实 DSH 进程：`ctx.agents.create` 的发布/回滚语义由 fake 端口近似。
 * - 没有真实 JSONL 持久化与崩溃重放：`reconcileFromHistory` 只验证"能从日志里读出来"。
 * - 真实组合（白名单 bundle + loader + 真模型替身）由 P1/P2 与 tests/poc 覆盖。
 */
