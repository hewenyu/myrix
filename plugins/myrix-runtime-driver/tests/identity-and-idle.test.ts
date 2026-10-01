/**
 * 闭环补强的负例测试：commit 同步严校验、打开前身份刷新、权威对账、
 * 只读空闲证明。
 *
 * 这些用例存在的理由：它们是"看起来能跑"与"真的拒绝"之间的差别。
 * 每一条都断言一个**不被放行**的具体路径，而不是断言实现细节。
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createGrantSigner, createGrantVerifier, generateTestKeyPair, sha256Hex } from '@myrix/grant'
import type { GrantOperation } from '@myrix/grant'
import { PrincipalRegistry } from '@myrix/principals'
import type { Principal } from '@myrix/principals'
import { SessionController, type ControllerHost } from '../src/controller'
import { createFakeRuntime, type FakeDisk } from './fake-dsh'

const NOW = 1_790_000_000
const CELL = 'cell-u_1'
const TENANT = 't_acme'
const BOOT = 'boot-test-0001'
const ISSUER = 'myrix-control-plane'
const SID = 'sid-1'

const key = generateTestKeyPair('kid-2026-09')

interface Harness {
  readonly runtime: ReturnType<typeof createFakeRuntime>
  readonly controller: SessionController
  readonly registry: PrincipalRegistry
  readonly host: ControllerHost
  readonly setLiveness: (alive: boolean | undefined) => void
  readonly revokeSid: (sid: string, rev?: number) => void
  readonly send: (input: {
    op: GrantOperation
    sid?: string
    commandId: string
    body?: Record<string, unknown>
    sub?: string
    rev?: number
    preset?: string
    wid?: string
    tid?: string
  }) => Promise<{ status: string; commandId: string; bootId: string; note?: string }>
}

function harness(options: { disk?: FakeDisk } = {}): Harness {
  const runtime = createFakeRuntime(options.disk)
  const registry = new PrincipalRegistry(new Context())
  registry.setLiveness(() => true)
  const baseBind = runtime.ports.bindPrincipal
  runtime.ports.bindPrincipal = (agent, principal) => {
    const unbind = registry.bind(agent as unknown as Agent, principal)
    const traceUnbind = baseBind(agent, principal)
    return () => {
      traceUnbind()
      unbind()
    }
  }

  const signer = createGrantSigner({
    privateKey: key.privateKey,
    kid: 'kid-2026-09',
    issuer: ISSUER,
    clock: () => NOW,
  })
  const verifier = createGrantVerifier({
    audience: CELL,
    tenantId: TENANT,
    bootId: BOOT,
    startedAt: NOW - 100,
    issuer: ISSUER,
    keys: [key.jwk],
    clock: () => NOW,
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
    isRevoked: (sid) => registry.isRevoked(sid),
    highWaterRev: (sid) => registry.highWaterRev(sid),
  }

  const controller = new SessionController(runtime.ports, host, verifier, BOOT)

  const send: Harness['send'] = async (input) => {
    const sid = input.sid ?? SID
    const body = JSON.stringify({
      op: input.op,
      sid,
      commandId: input.commandId,
      ...(input.body ?? {}),
    })
    const raw = Buffer.from(body, 'utf8')
    const token = signer.issue({
      aud: CELL,
      boot: BOOT,
      tid: input.tid ?? TENANT,
      sid,
      sub: input.sub ?? 'u_1',
      wid: input.wid ?? 'w_1',
      preset: input.preset ?? 'novel-chapter',
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
    registry,
    host,
    setLiveness: (alive) => {
      registry.setLiveness(alive === undefined ? undefined : () => alive)
    },
    revokeSid: (sid, rev = 1) => {
      registry.revoke({ sid, rev, reason: 'test revoke' })
    },
    send,
  }
}

describe('commit 的同步严校验（发布前唯一校验点）', () => {
  it('绑定表里的主体与凭证六字段不一致时拒绝发布', async () => {
    const h = harness()
    // 模拟"绑定表被写入了另一个主体/作品"：bindPrincipal 落到表的是一份被篡改的 principal。
    const baseBind = h.runtime.ports.bindPrincipal
    h.runtime.ports.bindPrincipal = (agent, principal) => {
      const tampered: Principal = { ...principal, wid: 'w-other' }
      const unbind = baseBind(agent, tampered)
      return unbind
    }
    await expect(h.send({ op: 'create', commandId: 'c1' })).rejects.toMatchObject({
      code: 'identity_mismatch',
      stage: 'commit',
    })
    expect(h.controller.liveCount).toBe(0)
  })

  it('活性不可用时 commit 拒绝（不是"先发布再说"）', async () => {
    const h = harness()
    h.setLiveness(undefined)
    await expect(h.send({ op: 'create', commandId: 'c1' })).rejects.toMatchObject({
      code: 'identity_invalid',
      stage: 'commit',
    })
    expect(h.controller.liveCount).toBe(0)
  })

  it('撤权高水位超过凭证 rev 时不放行（即便 isRevoked 尚未置位）', async () => {
    const h = harness()
    // 刻意构造"高水位已前进但 isRevoked 说 false"的宿主：这正是 rev 校验存在的理由。
    const host: ControllerHost = {
      ...h.host,
      isRevoked: () => false,
      highWaterRev: () => 9,
    }
    const controller = new SessionController(h.runtime.ports, host, verifierFor(), BOOT)
    const raw = Buffer.from(JSON.stringify({ op: 'create', sid: SID, commandId: 'c1' }), 'utf8')
    const token = signerFor().issue({
      aud: CELL, boot: BOOT, tid: TENANT, sid: SID, sub: 'u_1', wid: 'w_1',
      preset: 'novel-chapter', rev: 3, op: 'create', cmd: 'c1', rawBody: raw,
    })
    await expect(controller.command(raw, sha256Hex(raw), token.token)).rejects.toMatchObject({
      code: 'rev_stale',
    })
  })
})

describe('打开前的身份刷新（创建竞态）', () => {
  it('刷新失败时打开随之中止（不发明宽松默认）', async () => {
    const h = harness()
    h.runtime.failRefresh = 'lease snapshot down'
    await expect(h.send({ op: 'create', commandId: 'c1' })).rejects.toMatchObject({
      status: 503,
      code: 'identity_refresh_failed',
    })
    expect(h.runtime.setups).toHaveLength(0)
    expect(h.controller.liveCount).toBe(0)
  })

  it('刷新发生在 setup 之前，且复用路径不会重复刷新', async () => {
    const h = harness()
    await h.send({ op: 'create', commandId: 'c1' })
    await h.send({ op: 'resume', commandId: 'c2' })
    expect(h.runtime.refreshes).toEqual([SID])
    expect(h.runtime.setups).toHaveLength(1)
  })

  it('没有绑定租约端口时也能打开（刷新是可选的加固，不是新依赖）', async () => {
    const h = harness()
    delete (h.runtime.ports as { refreshIdentity?: unknown }).refreshIdentity
    await h.send({ op: 'create', commandId: 'c1' })
    expect(h.controller.liveCount).toBe(1)
  })
})

describe('send 的权威对账（同进程 flush 失败后的重试）', () => {
  it('flush 失败后同 commandId 重试不再 append 第二遍', async () => {
    const h = harness()
    await h.send({ op: 'create', commandId: 'c1' })
    h.runtime.failFlush = true
    await expect(h.send({ op: 'send', commandId: 'c2', body: { text: 'hello' } })).rejects.toMatchObject({
      code: 'not_persisted',
    })
    h.runtime.failFlush = false
    const receipt = await h.send({ op: 'send', commandId: 'c2', body: { text: 'hello' } })
    expect(receipt.status).toBe('accepted')
    const events = h.runtime.sessions.get(SID)?.events ?? []
    expect(events.filter((e) => e.type === 'user/message')).toHaveLength(1)
  })

  it('flush 失败后重试换正文 → 409（内存日志里的记录也要比对文本）', async () => {
    const h = harness()
    await h.send({ op: 'create', commandId: 'c1' })
    h.runtime.failFlush = true
    await expect(h.send({ op: 'send', commandId: 'c2', body: { text: 'hello' } })).rejects.toMatchObject({
      code: 'not_persisted',
    })
    h.runtime.failFlush = false
    await expect(
      h.send({ op: 'send', commandId: 'c2', body: { text: 'different' } }),
    ).rejects.toMatchObject({ status: 409, code: 'command_id_conflict' })
  })

  it('重启后 send 能直接对账，不要求会话已打开', async () => {
    const h = harness()
    await h.send({ op: 'create', commandId: 'c1' })
    await h.send({ op: 'send', commandId: 'c2', body: { text: 'hello' } })
    const restarted = harness({ disk: h.runtime.disk })
    const receipt = await restarted.send({ op: 'send', commandId: 'c2', body: { text: 'hello' } })
    expect(receipt.status).toBe('accepted')
    // 重启后的进程没有活跃会话；对账完全靠磁盘。
    expect(restarted.controller.liveCount).toBe(0)
  })

  it('无法读取权威日志时拒绝执行，而不是"查不到就当新命令"', async () => {
    const h = harness()
    await h.send({ op: 'create', commandId: 'c1' })
    h.runtime.ports.persistedUserMessages = () => Promise.reject(new Error('disk unavailable'))
    await expect(h.send({ op: 'send', commandId: 'c2', body: { text: 'hi' } })).rejects.toMatchObject({
      code: 'persistence_unavailable',
    })
  })
})

describe('只读空闲证明的取值表', () => {
  it('没有活跃会话时三个条件全真', async () => {
    const h = harness()
    const proof = await h.controller.idleProof()
    expect(proof).toMatchObject({ noActiveTurns: true, inboxEmpty: true, flushed: true })
    expect(proof.rejectionCode).toBeUndefined()
  })

  it('轮次在跑 → ActiveTurns，且不 flush 冒充成功', async () => {
    const h = harness()
    await h.send({ op: 'create', commandId: 'c1' })
    h.runtime.agents.get(SID)!.status = 'running'
    const proof = await h.controller.idleProof()
    expect(proof).toMatchObject({ noActiveTurns: false, flushed: false, rejectionCode: 'ActiveTurns' })
  })

  it('inbox 未消费 → InboxNotEmpty', async () => {
    const h = harness()
    await h.send({ op: 'create', commandId: 'c1' })
    const agent = h.runtime.agents.get(SID)!
    ;(agent.inbox.nextTurn as unknown[]).push({ id: 'pending' })
    const proof = await h.controller.idleProof()
    expect(proof).toMatchObject({ noActiveTurns: true, inboxEmpty: false, rejectionCode: 'InboxNotEmpty' })
  })

  it('flush 没有监听者 → NotFlushed', async () => {
    const h = harness()
    await h.send({ op: 'create', commandId: 'c1' })
    h.runtime.failFlush = true
    const proof = await h.controller.idleProof()
    expect(proof).toMatchObject({ noActiveTurns: true, inboxEmpty: true, flushed: false, rejectionCode: 'NotFlushed' })
  })

  it('查询前后准入状态不变（只读）', async () => {
    const h = harness()
    await h.send({ op: 'create', commandId: 'c1' })
    expect(h.controller.accepting).toBe(true)
    await h.controller.idleProof()
    expect(h.controller.accepting).toBe(true)
    // 查询之后仍然可以继续发命令。
    await h.send({ op: 'send', commandId: 'c2', body: { text: 'hi' } })
  })
})

// ---- 独立构造器：用于替换 host 的用例 ----

function signerFor() {
  return createGrantSigner({
    privateKey: key.privateKey,
    kid: 'kid-2026-09',
    issuer: ISSUER,
    clock: () => NOW,
  })
}

function verifierFor() {
  return createGrantVerifier({
    audience: CELL,
    tenantId: TENANT,
    bootId: BOOT,
    startedAt: NOW - 100,
    issuer: ISSUER,
    keys: [key.jwk],
    clock: () => NOW,
  })
}
