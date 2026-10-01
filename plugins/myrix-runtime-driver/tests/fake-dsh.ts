/**
 * driver 的测试替身：一个**行为真实**的最小 DSH 端口实现。
 *
 * 它不是 mock 框架的产物，而是把 `AgentPort`/`SessionPort`/`RuntimePorts`
 * 的契约逐条实现出来（含 setup 提交顺序、flush 计数、inbox 形状），
 * 这样控制器里"先 bind 再 mount 再 commit"这类顺序错误会被真的测出来。
 *
 * **持久化模型**：`session.append` 只写内存缓冲，`flush` 成功才把内存事件
 * 落到 `disk`。这与真实 DSH 的契约一致（"append 是 best-effort，flush 才是
 * 持久性屏障"），因此 `failFlush` 之后 `persistedSession` 看不到会话 —— 这正是
 * "回执必须晚于 flush"的可测含义。
 *
 * **重启模型**：`disk` 可以在多个 `createFakeRuntime()` 之间共享。用同一个 disk
 * 新建一个 runtime，就等于"进程重启、内存全丢、只有磁盘会话还在"。
 * 这不是真的 kill -9（没有真实 JSONL、没有未刷盘的 torn tail），见文件末尾缺口。
 *
 * 与真实 DSH 的差异只在**范围**，不在语义：
 * - 没有真实模型调用（`followup` 只记录消息与 inbox splice）。
 * - 没有真实 JSONL 文件（disk 是内存 Map），因此不覆盖 torn tail 与并发写。
 * 真实组合的验证在 `tests/poc`（另属他人）与 P1/P2 里完成。
 */
import type {
  AgentHandlePort,
  AgentPort,
  AgentSetupPort,
  CancelCausePort,
  RuntimePorts,
  SessionEventPort,
  SessionPort,
  SetupCommitPort,
  UserMessagePort,
} from '../src/controller'

/** setup 执行期间的一次调用记录；用于断言顺序。 */
export interface SetupTrace {
  readonly sid: string
  readonly op: string
  readonly mounted: string[]
  readonly bound: string[]
  /** 关键步骤的到达顺序（`bind` / `mount` / `commit`）。 */
  readonly order: string[]
  committed: number
}

export interface FakeSession extends SessionPort {
  readonly events: SessionEventPort[]
  append(type: string, data: unknown): SessionEventPort
}

export interface FakeAgent extends AgentPort {
  readonly cancels: CancelCausePort[]
  readonly followups: UserMessagePort[]
  idle: boolean
  status: 'idle' | 'running'
  /** 模拟"轮次消费了 inbox"：清空两个待处理列表。 */
  consumeInbox(): void
}

/** 记录一次 flush 调用，便于断言"回执在 flush 之后"。 */
export interface FlushRecord {
  readonly sid: string
  readonly at: number
}

/** 一份可跨 runtime 复用的"磁盘"；代表 `$DSH_HOME/sessions`。 */
export interface FakeDisk {
  /** sid → 已落盘事件。 */
  readonly sessions: Map<string, SessionEventPort[]>
  /** sid → 已落盘的 header preset。 */
  readonly preset: Map<string, string | undefined>
}

/** 新建一份空磁盘。 */
export function createFakeDisk(): FakeDisk {
  return { sessions: new Map(), preset: new Map() }
}

/** 可编程的端口实现。 */
export interface FakeRuntime {
  ports: RuntimePorts
  /** 每一次 setup 的执行轨迹。 */
  readonly setups: SetupTrace[]
  readonly flushes: FlushRecord[]
  /** 已创建的会话 by sid。 */
  readonly sessions: Map<string, FakeSession>
  /** 已创建/恢复的 Agent by sid。 */
  readonly agents: Map<string, FakeAgent>
  /** dispose 次数 by sid。 */
  readonly disposed: Map<string, number>
  /** `refreshIdentity` 的调用次数与参数（只记录 sid，够断言刷新发生过）。 */
  readonly refreshes: string[]
  /** 让 `flush` 返回 false（模拟没有持久化监听者）。 */
  failFlush: boolean
  /** 让 `flush` 抛错。 */
  throwFlush: boolean
  /** 让 `mountPreset` 返回一个不同的 id（模拟 preset 未生效）。 */
  mountAs: string | undefined
  /** 让 `mountPreset` 抛错（模拟新 preset 加载失败）。 */
  failMount: string | undefined
  /**
   * `mountPreset` **入口处**的回调；用来断言"挂载时主体已经绑定"。
   * 新 preset（如 myrix-novel）在加载期就 require principal，绑定晚于挂载
   * 会让它直接失败 —— 这个钩子把那条约束变成可测断言。
   */
  mountProbe: ((sid: string) => void) | undefined
  /** 让 `create`/`resume` 抛错。 */
  failOpen: string | undefined
  /** 让 `refreshIdentity` 抛错。 */
  failRefresh: string | undefined
  /** 单调假时钟（毫秒）。 */
  clock: number
  /** 预置的磁盘 header preset（resume 用；会被磁盘真实值覆盖）。 */
  headerPreset: string | undefined
  /** 共享磁盘；不传则本 runtime 独占一份。 */
  readonly disk: FakeDisk
}

export function createFakeRuntime(disk: FakeDisk = createFakeDisk()): FakeRuntime {
  const sessions = new Map<string, FakeSession>()
  const agents = new Map<string, FakeAgent>()
  const setups: SetupTrace[] = []
  const flushes: FlushRecord[] = []
  const disposed = new Map<string, number>()
  const refreshes: string[] = []
  const runtime: FakeRuntime = {
    ports: undefined as unknown as RuntimePorts,
    setups,
    flushes,
    sessions,
    agents,
    disposed,
    refreshes,
    failFlush: false,
    throwFlush: false,
    mountAs: undefined,
    failMount: undefined,
    mountProbe: undefined,
    failOpen: undefined,
    failRefresh: undefined,
    clock: 1_790_000_000_000,
    headerPreset: undefined,
    disk,
  }

  function makeSession(sid: string): FakeSession {
    // resume 时从磁盘恢复既有事件；create 时是空的。
    const events: SessionEventPort[] = [...(disk.sessions.get(sid) ?? [])]
    let seq = events.length
    const session: FakeSession = {
      id: sid,
      get header() {
        const preset = disk.preset.get(sid) ?? runtime.headerPreset
        return preset === undefined ? {} : { agentPreset: preset }
      },
      events,
      append(type, data) {
        const event: SessionEventPort = { type, seq: seq++, time: runtime.clock, data }
        events.push(event)
        return event
      },
      snapshotEvents() {
        return [...events]
      },
    }
    return session
  }

  /** 执行 setup：由控制器决定 bind/mount 顺序；commit 在"发布前"触发。 */
  async function runSetup(
    sid: string,
    op: string,
    setup: AgentSetupPort,
    agent: FakeAgent,
  ): Promise<SetupCommitPort | void> {
    const trace: SetupTrace = { sid, op, mounted: [], bound: [], order: [], committed: 0 }
    setups.push(trace)
    const ctxCleanups: Array<() => void> = []
    const agentCtx = {
      effect(body: () => () => void, _label?: string) {
        // 注册清理函数；scope 回卷（这里用 setup 抛错/dispose 模拟）时执行。
        const unbind = body()
        ctxCleanups.push(unbind)
      },
      /** 模拟未发布 Agent scope 的回卷：执行所有注册的 cleanup。 */
      rollback() {
        for (const cleanup of ctxCleanups.splice(0)) cleanup()
      },
    }
    cleanup.set(sid, () => {
      for (const cleanup of ctxCleanups.splice(0)) cleanup()
    })
    try {
      const commit = await setup(agentCtx, agent)
      if (commit !== undefined) {
        trace.order.push('commit')
        commit.commit()
        trace.committed += 1
      }
      return commit ?? undefined
    } catch (error) {
      // DSH 在 setup 抛错后回卷未发布的 scope —— 包括 mount 失败。
      for (const cleanup of ctxCleanups.splice(0)) cleanup()
      throw error
    }
  }

  const cleanup = new Map<string, () => void>()

  function makeAgent(sid: string, session: FakeSession): FakeAgent {
    const cancels: CancelCausePort[] = []
    const followups: UserMessagePort[] = []
    const agent: FakeAgent = {
      id: sid,
      session,
      inbox: { nextTurn: followups, nextStep: [] },
      cancels,
      followups,
      idle: true,
      status: 'idle',
      followup(message) {
        followups.push(message)
        // 真实 DSH 先记 inbox splice，轮次进入时才落 `user/message`。
        // 这里两者都追加：对账只看 `user/message`，inbox 用于"未消费"判定。
        session.append('agent/inbox/spliced', {
          target: 'next-turn',
          start: followups.length - 1,
          inserted: [
            { id: message.id, role: 'user', content: [...message.content], source: { kind: 'user' } },
          ],
        })
        session.append('user/message', {
          id: message.id,
          role: 'user',
          content: message.content,
          source: message.source,
        })
      },
      cancel(cause) {
        cancels.push(cause)
      },
      async whenIdle() {
        // 由测试控制 idle；默认立即空闲。
        if (!agent.idle) await new Promise<void>((resolve) => setImmediate(resolve))
      },
      consumeInbox() {
        followups.length = 0
        ;(agent.inbox.nextStep as unknown[]).length = 0
      },
    }
    return agent
  }

  const ports: RuntimePorts = {
    async create(options) {
      if (runtime.failOpen !== undefined) throw new Error(runtime.failOpen)
      const sid = options.sessionId
      // create 必须写入 header，否则"磁盘已有该会话"这条事实不存在。
      disk.preset.set(sid, options.meta.agentPreset)
      const session = makeSession(sid)
      sessions.set(sid, session)
      const agent = makeAgent(sid, session)
      agents.set(sid, agent)
      await runSetup(sid, 'create', options.setup, agent)
      return {
        agent,
        async dispose() {
          disposed.set(sid, (disposed.get(sid) ?? 0) + 1)
          agents.delete(sid)
          const unbind = cleanup.get(sid)
          if (unbind !== undefined) {
            unbind()
            cleanup.delete(sid)
          }
        },
      } satisfies AgentHandlePort
    },
    async resume(options) {
      if (runtime.failOpen !== undefined) throw new Error(runtime.failOpen)
      const sid = options.resumeSessionId
      if (!disk.sessions.has(sid) && !runtime.sessions.has(sid)) {
        // 真实 DSH 在持久化里找不到会话时抛错；驱动应在此之前就给出稳定错误。
        throw new Error(`session "${sid}" not found in persistence`)
      }
      const session = makeSession(sid)
      sessions.set(sid, session)
      const agent = makeAgent(sid, session)
      agents.set(sid, agent)
      await runSetup(sid, 'resume', options.setup, agent)
      return {
        agent,
        async dispose() {
          disposed.set(sid, (disposed.get(sid) ?? 0) + 1)
          agents.delete(sid)
          const unbind = cleanup.get(sid)
          if (unbind !== undefined) {
            unbind()
            cleanup.delete(sid)
          }
        },
      } satisfies AgentHandlePort
    },
    async flush(session) {
      if (runtime.throwFlush) throw new Error('flush backend down')
      flushes.push({ sid: String(session.id), at: runtime.clock })
      if (runtime.failFlush) return false
      // 持久性屏障：把内存事件落到"磁盘"，此后别的 runtime（重启）能看到。
      disk.sessions.set(String(session.id), session.snapshotEvents().map((event) => ({ ...event })))
      return true
    },
    async mountPreset(agentCtx, presetId) {
      const trace = setups[setups.length - 1]
      // 入口探针：新 preset 在加载期就会 require principal。
      runtime.mountProbe?.(trace?.sid ?? '')
      if (runtime.failMount !== undefined) throw new Error(runtime.failMount)
      trace?.order.push('mount')
      trace?.mounted.push(presetId)
      void agentCtx
      return runtime.mountAs ?? presetId
    },
    bindPrincipal(agent, principal) {
      const trace = setups[setups.length - 1]
      trace?.order.push('bind')
      trace?.bound.push(principal.sid)
      void agent
      return () => {
        const at = trace?.bound.indexOf(principal.sid) ?? -1
        if (at >= 0) trace?.bound.splice(at, 1)
      }
    },
    composedPreset(agentCtx) {
      void agentCtx
      const trace = setups[setups.length - 1]
      return trace?.mounted[0]
    },
    createUserMessage(text, messageId): UserMessagePort {
      return { id: messageId, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
    },
    now() {
      return runtime.clock
    },
    async refreshIdentity(principal) {
      refreshes.push(principal.sid)
      if (runtime.failRefresh !== undefined) throw new Error(runtime.failRefresh)
    },
    async persistedSession(sid) {
      const events = disk.sessions.get(sid)
      if (events === undefined) return undefined
      const preset = disk.preset.get(sid)
      return { sid, ...(preset === undefined ? {} : { agentPreset: preset }) }
    },
    async persistedUserMessages(sid) {
      const events = disk.sessions.get(sid) ?? []
      const messages: { id: string; text: string; seq: number }[] = []
      for (const event of events) {
        if (event.type !== 'user/message') continue
        const data = event.data as { readonly id?: unknown; readonly content?: unknown } | null
        if (data === null || typeof data !== 'object' || typeof data.id !== 'string') continue
        messages.push({ id: data.id, text: textOf(data.content), seq: event.seq })
      }
      return messages
    },
  }
  runtime.ports = ports
  return runtime
}

/** 把消息内容拼成可比对的一段文本；与 `src/index.ts` 的 `textOf` 同语义。 */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const record = block as { readonly type?: unknown; readonly text?: unknown }
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('\n')
}
