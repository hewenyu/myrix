/**
 * 会话控制器：driver 的全部编排逻辑，**通过端口注入 DSH**。
 *
 * 这样拆分的理由是硬性的：
 * - 编排里的每条规则（setup 内绑定身份、await preset、commit 同步校验 rev、
 *   followup 的 messageId = commandId、flush 后才回执、撤权顺序）都是安全属性，
 *   必须能在没有真实 DSH 进程的情况下被测试穷举。
 * - 真实插件（`src/index.ts`）只负责把 `ctx`/`ctx.agents`/`ctx.sessions` 等
 *   映射成这里的端口。端口与真实 API 的对应关系记录在实现文档里，并由
 *   `tests/plugin-surface.test.ts` 对真实类型做编译期核对。
 *
 * @module @myrix/runtime-driver/controller
 */
import type { GrantClaims, GrantVerifier } from '@myrix/grant'
import { GrantError } from '@myrix/grant'
import type { Principal } from '@myrix/principals'
import { AdmissionGate, GateClosedError } from './gate'
import { EMPTY_BODY_SHA256 } from './http'
import { ReceiptStore, type ReceiptRecord } from './receipts'
import type { CommandReceipt, CommandRequest } from './types'

// ---- DSH 端口：只声明真正用到的成员 ----

/** 一条持久会话事件（结构上是 `@deepseek-ai/dsh-session` 的 `SessionEvent`）。 */
export interface SessionEventPort {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

/** 一条用户消息（结构上是 `@deepseek-ai/dsh-llm` 的 `UserMessage`）。 */
export interface UserMessagePort {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly unknown[]
  readonly source: { readonly kind: 'user' }
}

/** 一个活跃会话（结构上是 `@deepseek-ai/dsh-session` 的 `Session`）。 */
export interface SessionPort {
  readonly id: string
  readonly header: { readonly agentPreset?: string | undefined }
  snapshotEvents(): readonly SessionEventPort[]
}

/** 取消原因；与 DSH 的 `AgentCancelCause` 闭合联合一致。 */
export type CancelCausePort =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }
  | { readonly kind: 'hook'; readonly reason: string }
  | { readonly kind: 'disposed' }

/** 一个活跃 Agent（结构上是 `@deepseek-ai/dsh-agent` 的 `Agent` 运行时面）。 */
export interface AgentPort {
  readonly id: string
  readonly session: SessionPort
  readonly inbox: { readonly nextTurn: readonly unknown[]; readonly nextStep: readonly unknown[] }
  /**
   * 模型轮次的同步状态（结构上是 DSH 的 `Agent.status`）。
   *
   * 空闲证明必须**同步**读它：`whenIdle()` 是异步等待，用它来回答一个只读查询
   * 会把查询变成阻塞。缺失时按"无法证明空闲"处理（fail-closed）。
   */
  readonly status?: 'idle' | 'running'
  followup(message: UserMessagePort): void
  cancel(cause: CancelCausePort): void
  whenIdle(): Promise<void>
}

/** Agent 句柄（结构上是 DSH 的 `AgentHandle`）。 */
export interface AgentHandlePort {
  readonly agent: AgentPort
  dispose(): Promise<void>
}

/** setup 的提交点；由 DSH 在"发布前"同步调用。 */
export interface SetupCommitPort {
  commit(): void
}

/** setup 回调：在未发布的 Agent scope 里做注册与身份绑定。 */
export type AgentSetupPort = (agentCtx: unknown, agent: AgentPort) => SetupCommitPort | Promise<SetupCommitPort | void> | void

/** 权威持久日志里的一条用户消息；由 `sessionPersistence` 读出，不是内存回执。 */
export interface PersistedUserMessagePort {
  /** `messageId`；`op=send` 时等于 `commandId`。 */
  readonly id: string
  /** 同一 `id` 的所有文本块拼接结果；用于与本次请求的 `text` 逐字比较。 */
  readonly text: string
  /** 事件在日志里的序号（诊断用）。 */
  readonly seq: number
}

/** 磁盘上某个会话的元数据；用于 create/resume 的身份核对。 */
export interface PersistedSessionPort {
  readonly sid: string
  /** 磁盘 header 的 preset；缺失表示该会话创建时没有声明 preset。 */
  readonly agentPreset?: string
}

/**
 * driver 依赖的全部 DSH 能力。
 *
 * `refreshIdentity` 与持久化读取都是**可选**的：没有它们时驱动退回到更保守的
 * 行为（打开前不刷新、只在内存回执表里查重），绝不退回到"默认放行"。
 */
export interface RuntimePorts {
  /** `ctx.agents.create`。 */
  create(options: {
    readonly sessionId: string
    readonly meta: { readonly agentPreset: string }
    readonly setup: AgentSetupPort
  }): Promise<AgentHandlePort>
  /** `ctx.agents.resume`。 */
  resume(options: {
    readonly resumeSessionId: string
    readonly setup: AgentSetupPort
  }): Promise<AgentHandlePort>
  /** `ctx.sessions.flush`；返回是否至少有一个持久化监听者参与。 */
  flush(session: SessionPort): Promise<boolean>
  /** `ctx.agentPresets.mount`；返回绑定的 preset id，供交叉核对。 */
  mountPreset(agentCtx: unknown, presetId: string): Promise<string>
  /** `ctx.principals.bind`；返回解绑函数（应放进 `agentCtx.effect`）。 */
  bindPrincipal(agent: AgentPort, principal: Principal): () => void
  /** 读取"当前 preset 绑定"（`ctx.agentPresets.composedPreset(agentCtx)`）。 */
  composedPreset(agentCtx: unknown): string | undefined
  /** 构造用户消息；由插件用 `freezeMessage`/`MessageId` 实现。 */
  createUserMessage(text: string, messageId: string): UserMessagePort
  /** 单调时钟（毫秒）。 */
  now(): number
  /**
   * 打开会话**之前**的一次身份刷新（可选）。
   *
   * 创建竞态：控制面刚写入绑定、周期快照还没有包含它。放宽容入判定是错的，
   * 正确做法是在真正 awaited 的 hook 里重新拉一次。实现由 `myrix-binding-lease`
   * 提供（`ctx.bindingLease.refresh()`），驱动只调用、不解释结果：
   * 刷新失败即抛出，打开随之中止 —— "无法证明仍然有效"就是拒绝。
   */
  refreshIdentity?(principal: Principal): Promise<void>
  /**
   * 读取磁盘上的会话元数据（可选）；来自 `ctx.sessionPersistence.stat`。
   *
   * 两个用途：`create` 重试遇到磁盘已有会话时必须走 `resume`，绝不覆盖；
   * `resume` 而磁盘不存在时明确失败，而不是让 DSH 抛一个底层错误。
   */
  persistedSession?(sid: string): Promise<PersistedSessionPort | undefined>
  /**
   * 读取磁盘上会话的权威用户消息（可选）；来自
   * `sessionPersistence.open(sid,'read')` + `read(0)`。
   *
   * `send` 真正落盘前用它做对账：进程重启后内存回执表为空，但日志里可能
   * 已经有这条消息。没有这个端口时驱动**不**声称幂等（内存表查不到就执行），
   * 因此生产装配必须提供它。
   */
  persistedUserMessages?(sid: string): Promise<readonly PersistedUserMessagePort[]>
}

/** 一次命令处理的失败；`status` 是建议的 HTTP 状态码。 */
export class CommandError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly stage?: string,
  ) {
    super(message)
    this.name = 'CommandError'
  }
}

/** 撤权通知（已由驱动在 HTTP 层校验过签名与 mono 版本）。 */
export interface RevokeNotice {
  readonly sid: string
  readonly rev: number
  readonly reason: string
}

/** 撤权处理结果。 */
export interface RevokeResult {
  readonly accepted: boolean
  readonly disposed: boolean
  readonly reason: string
}

/** drain 结果：`drained=true` 即"空闲证明"。 */
export interface DrainResult {
  readonly drained: boolean
  readonly activeSessions: number
  readonly waitedMs: number
  readonly reason?: string
  /** `drained=false` 时的稳定机器可读拒绝码（与 cell-manager 同一套）。 */
  readonly rejectionCode?: string
  /** 每个活跃会话的 `whenIdle` 与 inbox 检查是否都通过。 */
  readonly noActiveTurns: boolean
  /** 准入闸门与每会话 inbox 是否都空。 */
  readonly inboxEmpty: boolean
  /** 每个活跃会话是否都成功 `flush`。 */
  readonly flushed: boolean
}

/** 空闲证明的拒绝码；与 cell-manager `internal/driver` 的常量逐字一致。 */
export const IdleRejection = Object.freeze({
  /** 还有 agent 轮次在跑。 */
  ActiveTurns: 'ActiveTurns',
  /** 还有排队/在途命令或未消费的 inbox 消息。 */
  InboxNotEmpty: 'InboxNotEmpty',
  /** 会话缓冲没有证明已落盘。 */
  NotFlushed: 'NotFlushed',
} as const)

export type IdleRejectionCode = (typeof IdleRejection)[keyof typeof IdleRejection]

/**
 * 只读空闲证明：`POST /v1/admin/idle` 的事实来源。
 *
 * 与 `DrainResult` 的关键区别是它**不改变任何状态**：不关准入、不 seal、
 * 不 cancel。cell-manager 先用它判断"现在缩容安不安全"，只在决定缩容时才
 * 调用 drain 关门。
 */
export interface IdleProofResult {
  readonly noActiveTurns: boolean
  readonly inboxEmpty: boolean
  readonly flushed: boolean
  /** 最后一次接受命令的时刻（Unix 毫秒）。 */
  readonly lastCommandAt: number
  /** 产生本证明的时刻（Unix 毫秒）。 */
  readonly observedAt: number
  readonly reason?: string
  readonly rejectionCode?: IdleRejectionCode
}

/** 控制器依赖的宿主能力（身份表 + 撤权查询）。 */
export interface ControllerHost {
  /** 严格身份查询（含活性）；返回失败原因。 */
  lookupPrincipal(agent: AgentPort | undefined): { readonly ok: true; readonly principal: Principal } | { readonly ok: false; readonly reason: string; readonly detail: string }
  /** 严格反查。 */
  lookupPrincipalBySession(sid: string): { readonly ok: true; readonly principal: Principal } | { readonly ok: false; readonly reason: string; readonly detail: string }
  /** 撤权：单调接受并让绑定立即失效。 */
  revoke(request: { readonly sid: string; readonly rev: number; readonly reason: string }): { readonly accepted: boolean; readonly reason: string }
  /** 会话是否已撤权。 */
  isRevoked(sid: string): boolean
  /** 会话的撤权高水位。 */
  highWaterRev(sid: string): number
}

/** 已打开会话的记录。 */
interface LiveEntry {
  readonly handle: AgentHandlePort
  readonly principal: Principal
}

/** 与凭证逐项核对的六个身份字段；顺序固定，便于诊断信息稳定。 */
const PRINCIPAL_FIELDS = ['sid', 'tid', 'sub', 'wid', 'preset', 'rev'] as const

/**
 * 会话控制器。
 *
 * 不持有任何策略判定：`op` 是否允许由凭证的 `op` claim 表达，由控制面签发；
 * 本控制器只保证"凭证说了什么"与"实际做了什么"逐项一致。
 */
export class SessionController {
  private readonly live = new Map<string, LiveEntry>()
  private readonly gate = new AdmissionGate()
  private readonly receipts = new ReceiptStore()
  /** 会话级锁之外的"打开中"占位，防止同一 sid 并发 create/resume。 */
  private readonly opening = new Map<string, Promise<void>>()
  /** 最后一次接受命令的时刻（Unix 毫秒）；空闲证明的静默计时起点。 */
  private lastCommandAt: number

  constructor(
    private readonly ports: RuntimePorts,
    private readonly host: ControllerHost,
    private readonly verifier: GrantVerifier,
    private readonly bootId: string,
  ) {
    // 启动即"自此刻起没有接受过命令"：用启动时刻而不是 0，否则
    // `observedAt - lastCommandAt` 会算出几十年，把"从未接受命令"伪装成
    // 早就过了静默期。
    this.lastCommandAt = ports.now()
  }

  /** 进程内的会话记录数（诊断用）。 */
  get liveCount(): number {
    return this.live.size
  }

  /** 闸门是否仍在接受新命令。 */
  get accepting(): boolean {
    return this.gate.accepting
  }

  /**
   * 内部诊断用：读取一条回执记录（**未经授权**，仅进程内诊断使用）。
   *
   * 刻意是 `private`：HTTP 边界绝不能通过它回答 `GET /v1/commands/:id`，
   * 否则回执表就变成一个可被外部枚举的侧信道（越权读他人会话的存在性）。
   * 路由唯一的读取入口是 {@link authorizeReceipt}。
   */
  private receiptOf(commandId: string): CommandReceipt | undefined {
    const record = this.receipts.get(commandId)
    return record === undefined ? undefined : { status: 'accepted', commandId: record.commandId, bootId: record.bootId }
  }

  /**
   * 授权并读取一条命令回执（`GET /v1/commands/:id` 的**唯一**入口）。
   *
   * GET 没有请求正文，因此凭证绑定的是一个**确定的空正文摘要**，`cmd` 由
   * {@link receiptCommandId} 派生：`receipt-${commandId}`。这不是"放宽校验"，
   * 而是给"读回执"这个动作单独定义一枚可被一次性消费、且逐项绑定的凭证 ——
   * 签发侧（控制面/BFF）必须用同一份协议签一枚 `op=subscribe`、`bh=sha256("")`
   * 的新凭证，而不是复用 POST 命令的那一枚（它已经被消费过，重放必被拒）。
   *
   * 顺序（任何一步失败都拒绝）：
   * 1. `verifyAndConsume`：签名 / 时效 / boot / op / cmd / bh / jti 一次性；
   * 2. 撤权与 rev 高水位；
   * 3. 身份活性（`lookupPrincipalBySession`）与**六字段**逐项一致；
   * 4. 只有 `record.sid === claims.sid` 才返回回执；未知回执或**别的 sid**
   *    一律 404 `no_receipt` —— 不能泄露"其他会话存在这条回执"。
   *
   * @throws {CommandError} 凭证不合格（403/401）、身份失效（403）或无回执（404）。
   */
  authorizeReceipt(bearer: string | undefined, commandId: string): CommandReceipt {
    if (bearer === undefined || bearer.length === 0) {
      throw new CommandError(401, 'grant_missing', '缺少 Authorization 头')
    }
    let claims: GrantClaims
    try {
      claims = this.verifier.verifyAndConsume(bearer, {
        op: 'subscribe',
        cmd: receiptCommandId(commandId),
        bh: EMPTY_BODY_SHA256,
      })
    } catch (error) {
      throw this.grantFailure(error)
    }

    const revoked = this.revocationVerdict(claims)
    if (revoked !== undefined) throw revoked
    const identity = this.host.lookupPrincipalBySession(claims.sid)
    if (!identity.ok) {
      throw new CommandError(403, 'identity_invalid', `身份不可用：${identity.reason}`, 'binding')
    }
    const mismatch = principalMismatch(identity.principal, claims)
    if (mismatch !== undefined) {
      throw new CommandError(403, 'identity_mismatch', `回执身份与凭证不一致：${mismatch}`, 'binding')
    }

    const record = this.receipts.get(commandId)
    // 未知回执与"属于别的 sid 的回执"返回同一个 404：存在性不可被探测。
    if (record === undefined || record.sid !== claims.sid) {
      throw new CommandError(
        404,
        'no_receipt',
        `本进程（bootId=${this.bootId}）没有该命令的回执；回执不跨重启保留，请回读权威会话日志对账`,
        'receipt',
      )
    }
    return { status: 'accepted', commandId: record.commandId, bootId: record.bootId }
  }

  /**
   * 校验一条事件流订阅凭证（`op=subscribe`）。
   *
   * 事件流是**读**操作，但仍然要凭证：否则任何能连上端口的人都能读到
   * 别人的会话内容。绑定与命令一致：`op`/`cmd`/`bh` 逐项核对，
   * 再加上 `sid` 与身份表的活性检查。
   *
   * @throws {CommandError} 凭证不合格、sid 不符、或身份已失效。
   */
  authorizeSubscribe(bearer: string, sid: string, bodyHash: string): GrantClaims {
    let claims: GrantClaims
    try {
      claims = this.verifier.verifyAndConsume(bearer, { op: 'subscribe', cmd: subscribeCommandId(sid), bh: bodyHash })
    } catch (error) {
      throw this.grantFailure(error)
    }
    if (claims.sid !== sid) {
      throw new CommandError(403, 'binding_mismatch', '凭证 sid 与事件流路径不一致', 'binding')
    }
    const revoked = this.revocationVerdict(claims)
    if (revoked !== undefined) throw revoked
    const identity = this.host.lookupPrincipalBySession(sid)
    if (!identity.ok) {
      throw new CommandError(403, 'identity_invalid', `身份不可用：${identity.reason}`, 'binding')
    }
    const mismatch = principalMismatch(identity.principal, claims)
    if (mismatch !== undefined) {
      throw new CommandError(403, 'identity_mismatch', `事件流身份与凭证不一致：${mismatch}`, 'binding')
    }
    return claims
  }

  /**
   * 持续流的逐帧准入检查：撤权或身份失效立刻返回 false，让中枢关闭连接。
   *
   * 这是"每请求/持续 stream 撤权检查"的落点 —— 撤权不能等到下一次重连才生效。
   * 只看会话级状态：逐帧路径上没有凭证，也就没有 rev 可比。
   */
  streamAdmitted(sid: string): boolean {
    if (this.host.isRevoked(sid)) return false
    return this.host.lookupPrincipalBySession(sid).ok
  }

  /** 某会话是否有活跃 Agent 或未结算命令（drain / ready 判定用）。 */
  hasActivity(sid: string): boolean {
    return this.live.has(sid) || this.gate.hasPending(sid) || this.opening.has(sid)
  }

  /**
   * 处理一条命令：校验凭证 → 取会话锁 → 幂等判定 → 执行 → 记录回执。
   *
   * `rawBody` 必须是**实际收到的原始字节**：`bh` 绑定依赖它。
   */
  async command(rawBody: Buffer, bodyHash: string, bearer: string | undefined): Promise<CommandReceipt> {
    if (bearer === undefined || bearer.length === 0) {
      throw new CommandError(401, 'grant_missing', '缺少 Authorization 头')
    }
    const request = this.parseCommandRequest(rawBody)

    let claims: GrantClaims
    try {
      claims = this.verifier.verifyAndConsume(bearer, {
        op: request.op,
        cmd: this.commandIdOf(request),
        bh: bodyHash,
      })
    } catch (error) {
      throw this.grantFailure(error)
    }

    const commandId = claims.cmd
    if (claims.sid !== request.sid) {
      // 理论上 verifier 已保证 cmd/bh/op 绑定；sid 与 body 的交叉核对在这里补上。
      throw new CommandError(403, 'binding_mismatch', '凭证 sid 与请求体不一致', 'binding')
    }

    // 消息 id 必须就是 commandId：允许调用方自带另一个 id，等于让它绕开
    // "按 commandId 回读权威日志"的对账（见 `send`）。
    if (request.messageId !== undefined && request.messageId !== commandId) {
      throw new CommandError(400, 'malformed_body', 'messageId 必须省略或等于 commandId', 'parse')
    }

    // 凭证本身通过 ≠ 命令可以执行：撤权是独立的一层。
    const revoked = this.revocationVerdict(claims)
    if (revoked !== undefined) throw revoked

    const candidate: ReceiptRecord = {
      commandId,
      op: claims.op,
      sid: claims.sid,
      bh: claims.bh,
      bootId: this.bootId,
      at: this.ports.now(),
    }

    try {
      const receipt = await this.gate.run(claims.sid, async () => {
        // 幂等判定必须在锁内：两条并发的重试只有一条真正执行。
        const verdict = this.receipts.classify(candidate)
        if (verdict !== undefined) {
          if (verdict.kind === 'conflict') {
            throw new CommandError(409, 'command_id_conflict', verdict.reason)
          }
          return verdict.receipt
        }

        switch (claims.op) {
          case 'create':
          case 'resume':
            await this.ensureOpen(claims)
            break
          case 'send': {
            // 消息投递的同步失败由 `send` 翻译成 CommandError 向上传播；
            // 回执只在真正成功后才记录，绝不吞掉错误假装已投递。
            await this.send(claims, request)
            break
          }
          case 'cancel': {
            const entry = this.requireOwned(claims)
            // `user` 原因：这是用户显式取消，不是撤权或销毁。
            entry.handle.agent.cancel({ kind: 'user' })
            break
          }
          case 'subscribe':
            // subscribe 只授权事件流，不产生写命令；走到这里说明路由用错了端点。
            throw new CommandError(400, 'unsupported_operation', 'subscribe 是事件流操作，不是命令操作')
          default:
            // 默认拒绝：未知 op 绝不放行。
            throw new CommandError(400, 'unsupported_operation', '不支持的操作')
        }

        return this.receipts.put(candidate)
      })
      // 只有真正结算成功的命令才推进静默计时；失败的命令不算"接受过"。
      this.lastCommandAt = this.ports.now()
      return receipt
    } catch (error) {
      if (error instanceof GateClosedError) {
        throw new CommandError(503, 'not_accepting', error.message, 'admission')
      }
      throw error
    }
  }

  /**
   * 在**本进程**的活跃会话日志里查这条命令是否已经写入。
   *
   * 覆盖 `flush` 失败后的同进程重试：`followup` 已经把消息追加进内存日志
   * （`user/message`，或还没进入轮次时的 `agent/inbox/spliced`），此时回执
   * 没有记录，重试不能再追加第二遍。
   *
   * @returns 找到时给出与本次请求的比对结论；找不到返回 undefined。
   */
  reconcileLive(
    session: SessionPort,
    commandId: string,
    text: string,
  ): { readonly verdict: 'retry' } | { readonly verdict: 'conflict'; readonly reason: string } | undefined {
    for (const event of session.snapshotEvents()) {
      const found = matchUserMessage(event, commandId)
      if (found === undefined) continue
      if (found.text !== text) {
        return {
          verdict: 'conflict',
          reason: `commandId ${commandId} 已写入本进程会话日志，但正文不同：拒绝把它当作同一条命令`,
        }
      }
      return { verdict: 'retry' }
    }
    return undefined
  }

  /**
   * 崩溃恢复对账：同一 `commandId` 是否已经作为用户消息落在会话日志里。
   *
   * 这是 tech-design-v1 风险 R3 的落点：进程重启后内存回执表为空，
   * 但**持久会话日志里已经有这条消息**。只依赖内存 map 会把一次已执行的重试
   * 当成新命令再执行一遍，因此这里回读日志。
   *
   * @returns 找到时的 seq；找不到返回 undefined。
   */
  reconcileFromHistory(session: SessionPort, commandId: string): number | undefined {
    for (const event of session.snapshotEvents()) {
      if (event.type !== 'user/message') continue
      const data = event.data as { readonly id?: unknown } | null
      if (data === null || typeof data !== 'object') continue
      if (data.id === commandId) return event.seq
    }
    return undefined
  }

  /**
   * 崩溃恢复对账（权威源版本）：从**持久会话日志**里读这条命令是否已经落盘。
   *
   * 与 `reconcileFromHistory` 的差别是它不依赖进程内 `Session` 对象：
   * 重启后 DSH 还没有 resume 这个会话，内存里没有 `Session`，但 JSONL 里有。
   *
   * @returns 找到时给出与本次请求的比对结论；找不到或没有端口时返回 undefined。
   */
  async reconcilePersisted(
    sid: string,
    commandId: string,
    text: string,
  ): Promise<{ readonly verdict: 'retry' } | { readonly verdict: 'conflict'; readonly reason: string } | undefined> {
    const persisted = await this.readPersistedMessages(sid)
    if (persisted === undefined) return undefined
    const match = persisted.find((message) => message.id === commandId)
    if (match === undefined) return undefined
    if (match.text !== text) {
      return {
        verdict: 'conflict',
        reason: `commandId ${commandId} 已在会话日志里存在，但正文不同：拒绝把它当作同一条命令`,
      }
    }
    return { verdict: 'retry' }
  }

  /**
   * 排空：关闭准入 → 等在途命令结算 → 逐会话 idle + inbox 空 + flush。
   *
   * 返回 `drained: true` 是给 Cell 管理器的**空闲证明**：此后不会再接受命令，
   * 也不存在未持久化的缓冲。任何一步失败都返回 `drained: false` 与可读原因，
   * 让管理器重试而不是把副本数设为 0。
   */
  async drain(): Promise<DrainResult> {
    const startedAt = this.ports.now()
    await this.gate.closeAndWait()
    this.gate.seal()

    let active = 0
    for (const [sid, entry] of [...this.live]) {
      active += 1
      try {
        await entry.handle.agent.whenIdle()
      } catch (error) {
        return {
          drained: false,
          activeSessions: active,
          waitedMs: this.ports.now() - startedAt,
          reason: `会话 ${sid} 等待空闲失败：${error instanceof Error ? error.name : 'unknown'}`,
          rejectionCode: IdleRejection.ActiveTurns,
          noActiveTurns: false,
          inboxEmpty: false,
          flushed: false,
        }
      }
      const pending = entry.handle.agent.inbox.nextTurn.length + entry.handle.agent.inbox.nextStep.length
      if (pending > 0) {
        return {
          drained: false,
          activeSessions: active,
          waitedMs: this.ports.now() - startedAt,
          reason: `会话 ${sid} 的 inbox 仍有 ${String(pending)} 条未处理消息`,
          rejectionCode: IdleRejection.InboxNotEmpty,
          noActiveTurns: true,
          inboxEmpty: false,
          flushed: false,
        }
      }
      try {
        const flushed = await this.ports.flush(entry.handle.agent.session)
        if (!flushed) {
          return {
            drained: false,
            activeSessions: active,
            waitedMs: this.ports.now() - startedAt,
            reason: `会话 ${sid} 没有持久化监听者参与 flush，无法证明已落盘`,
            rejectionCode: IdleRejection.NotFlushed,
            noActiveTurns: true,
            inboxEmpty: true,
            flushed: false,
          }
        }
      } catch (error) {
        return {
          drained: false,
          activeSessions: active,
          waitedMs: this.ports.now() - startedAt,
          reason: `会话 ${sid} flush 失败：${error instanceof Error ? error.name : 'unknown'}`,
          rejectionCode: IdleRejection.NotFlushed,
          noActiveTurns: true,
          inboxEmpty: true,
          flushed: false,
        }
      }
    }

    return {
      drained: true,
      activeSessions: 0,
      waitedMs: this.ports.now() - startedAt,
      noActiveTurns: true,
      inboxEmpty: true,
      flushed: true,
    }
  }

  /**
   * 只读空闲证明（`POST /v1/admin/idle`）。
   *
   * 与 `drain()` 的差别是它**不关闭准入、不 seal、不 cancel、不等待**：
   * 这是给 Cell 管理器"现在能不能缩容"的一次查询，不是缩容动作本身。
   * 因此：
   *
   * - 用同步的 `Agent.status` 回答"有没有轮次在跑"，绝不 `await whenIdle()`
   *   —— 那会把一次只读查询变成阻塞，还会把仍在跑的长轮次当成"已经空闲"。
   * - `flush` 仍然会真的调用：只有"已落盘"是可以被证明的，不能靠内存状态猜。
   * - 任一条件不满足都带精确拒绝码返回，不做"看起来差不多"的放行。
   */
  async idleProof(): Promise<IdleProofResult> {
    const observedAt = this.ports.now()
    const activeTurns: string[] = []
    const busyInbox: string[] = []

    for (const [sid, entry] of this.live) {
      // 缺失 status（旧端口/替身）按"无法证明"处理，不假定 idle。
      if (entry.handle.agent.status !== 'idle') activeTurns.push(sid)
      const pending = entry.handle.agent.inbox.nextTurn.length + entry.handle.agent.inbox.nextStep.length
      if (pending > 0) busyInbox.push(sid)
    }

    if (activeTurns.length > 0 || this.gate.inflightCount > 0) {
      return {
        noActiveTurns: false,
        inboxEmpty: busyInbox.length === 0,
        flushed: false,
        lastCommandAt: this.lastCommandAt,
        observedAt,
        rejectionCode: IdleRejection.ActiveTurns,
        reason:
          activeTurns.length > 0
            ? `会话 ${activeTurns.join(',')} 仍有模型轮次在跑`
            : `还有 ${String(this.gate.inflightCount)} 条命令在途`,
      }
    }
    if (busyInbox.length > 0 || this.gate.activeSessions > 0) {
      return {
        noActiveTurns: true,
        inboxEmpty: false,
        flushed: false,
        lastCommandAt: this.lastCommandAt,
        observedAt,
        rejectionCode: IdleRejection.InboxNotEmpty,
        reason:
          busyInbox.length > 0
            ? `会话 ${busyInbox.join(',')} 的 inbox 仍有未处理消息`
            : `还有 ${String(this.gate.activeSessions)} 个会话有在途命令`,
      }
    }

    // 逐个会话真 flush：`flushed: true` 必须是被证明的，不能只是"没在跑"。
    for (const [sid, entry] of this.live) {
      try {
        const flushed = await this.ports.flush(entry.handle.agent.session)
        if (!flushed) {
          return {
            noActiveTurns: true,
            inboxEmpty: true,
            flushed: false,
            lastCommandAt: this.lastCommandAt,
            observedAt,
            rejectionCode: IdleRejection.NotFlushed,
            reason: `会话 ${sid} 没有持久化监听者参与 flush，无法证明已落盘`,
          }
        }
      } catch (error) {
        return {
          noActiveTurns: true,
          inboxEmpty: true,
          flushed: false,
          lastCommandAt: this.lastCommandAt,
          observedAt,
          rejectionCode: IdleRejection.NotFlushed,
          reason: `会话 ${sid} flush 失败：${error instanceof Error ? error.name : 'unknown'}`,
        }
      }
    }

    return {
      noActiveTurns: true,
      inboxEmpty: true,
      flushed: true,
      lastCommandAt: this.lastCommandAt,
      observedAt,
    }
  }

  /**
   * 撤权：**先让身份失效，再取消，再 dispose**（tech-design-v1 §2 A8）。
   *
   * 顺序是安全属性：
   * - 身份先失效 → guard 与模型适配器立刻拒绝，不给在途工具"最后一次机会"。
   * - 再 cancel → 正在跑的轮次被中止。
   * - 最后 dispose → 注销 Agent；空闲 Agent 上 cancel 什么都不做，只有 dispose 有效。
   */
  async revoke(notice: RevokeNotice): Promise<RevokeResult> {
    const accepted = this.host.revoke({ sid: notice.sid, rev: notice.rev, reason: notice.reason })
    if (!accepted.accepted) {
      // 乱序/重放的旧通知：状态不回退，也不重复销毁。
      return { accepted: false, disposed: false, reason: accepted.reason }
    }

    const entry = this.live.get(notice.sid)
    if (entry === undefined) {
      return { accepted: true, disposed: false, reason: '已记录撤权；该会话当前不活跃' }
    }
    this.live.delete(notice.sid)
    entry.handle.agent.cancel({ kind: 'disposed' })
    try {
      await entry.handle.dispose()
    } catch (error) {
      return {
        accepted: true,
        disposed: false,
        reason: `撤权已记录，但销毁 Agent 失败：${error instanceof Error ? error.name : 'unknown'}`,
      }
    }
    return { accepted: true, disposed: true, reason: '已撤权并销毁 Agent' }
  }

  /** 进程卸载：关闭准入、销毁所有 Agent（幂等，失败也继续）。 */
  async shutdown(): Promise<void> {
    const closing = this.gate.closeAndWait()
    const entries = [...this.live.values()]
    this.live.clear()
    // 逐个 dispose 并吞掉错误：一个坏 Agent 不能阻止其他 Agent 被清理。
    await Promise.all(
      entries.map(async (entry) => {
        entry.handle.agent.cancel({ kind: 'disposed' })
        try {
          await entry.handle.dispose()
        } catch {
          // 卸载路径不报告；Errors 已经在上层日志里。
        }
      }),
    )
    await closing.catch(() => undefined)
  }

  // ---- 内部 ----

  /**
   * 同步撤权判定：撤权状态与**版本是否已前进**。
   *
   * `isRevoked` 只回答"有没有被撤权过"，不足以覆盖"凭证 rev 落后于已接受的
   * 撤权高水位但撤权表恰好在别的 sid 上"这类情形。这里把两件事一起查，
   * 并把结论统一翻译成 `session_revoked`。
   */
  private revocationVerdict(claims: GrantClaims): CommandError | undefined {
    if (this.host.isRevoked(claims.sid)) {
      return new CommandError(403, 'session_revoked', '会话已撤权', 'binding')
    }
    const highWater = this.host.highWaterRev(claims.sid)
    if (highWater > claims.rev) {
      // 撤权高水位已经超过凭证的 rev：这枚凭证签发于撤权之前。
      return new CommandError(
        403,
        'rev_stale',
        `凭证 rev(${String(claims.rev)}) 落后于撤权高水位(${String(highWater)})`,
        'binding',
      )
    }
    return undefined
  }

  /**
   * commit 的同步严校验（无 I/O）。
   *
   * 这是能被 DSH 在"发布前"调用的唯一校验点，因此要把所有能同步回答的问题
   * 一次问完，而不是只查撤权：
   * 1. 撤权 / 版本前进；
   * 2. 绑定仍在（`lookupPrincipal` 含活性：未安装活性判定即拒绝）；
   * 3. 六字段（sid/tid/sub/wid/preset/rev）与凭证逐项一致 —— 绑定表里的值
   *    必须就是这枚凭证声明的那一份，不接受"同 sid 换了主体/preset"。
   *
   * `agent` 用于 `lookupPrincipal`；任何一步失败都返回一个 `CommandError`。
   */
  private commitVerdict(claims: GrantClaims, agent: AgentPort): CommandError | undefined {
    const revoked = this.revocationVerdict(claims)
    if (revoked !== undefined) return revoked

    const bound = this.host.lookupPrincipal(agent)
    if (!bound.ok) {
      return new CommandError(403, 'identity_invalid', `发布前身份校验失败：${bound.reason}`, 'commit')
    }
    const mismatch = principalMismatch(bound.principal, claims)
    if (mismatch !== undefined) {
      return new CommandError(403, 'identity_mismatch', `发布前绑定与凭证不一致：${mismatch}`, 'commit')
    }
    // 活性必须在 commit 时仍然可证明；`lookupPrincipal` 已含这一步，
    // 这里再确认一次它的结论没有被"只查绑定"的宽松实现绕过。
    const current = this.host.lookupPrincipalBySession(claims.sid)
    if (!current.ok) {
      return new CommandError(403, 'identity_invalid', `发布前会话身份校验失败：${current.reason}`, 'commit')
    }
    const sessionMismatch = principalMismatch(current.principal, claims)
    if (sessionMismatch !== undefined) {
      return new CommandError(403, 'identity_mismatch', `发布前会话绑定与凭证不一致：${sessionMismatch}`, 'commit')
    }
    return undefined
  }

  /** 读取磁盘会话元数据；端口缺失或读取失败都当作"未观察到"，不当作"不存在"。 */
  private async readPersistedSession(sid: string): Promise<PersistedSessionPort | undefined> {
    if (this.ports.persistedSession === undefined) return undefined
    try {
      return await this.ports.persistedSession(sid)
    } catch (error) {
      throw new CommandError(
        503,
        'persistence_unavailable',
        `无法读取持久化状态：${error instanceof Error ? error.name : 'unknown'}`,
        'persist',
      )
    }
  }

  /** 读取磁盘上的权威用户消息；端口缺失时返回 undefined（调用方不得据此声称幂等）。 */
  private async readPersistedMessages(sid: string): Promise<readonly PersistedUserMessagePort[] | undefined> {
    if (this.ports.persistedUserMessages === undefined) return undefined
    try {
      return await this.ports.persistedUserMessages(sid)
    } catch (error) {
      // 无法对账 ⇒ 拒绝执行，而不是"查不到就当新命令"再追加一遍。
      throw new CommandError(
        503,
        'persistence_unavailable',
        `无法读取权威会话日志：${error instanceof Error ? error.name : 'unknown'}`,
        'persist',
      )
    }
  }

  private parseCommandRequest(rawBody: Buffer): CommandRequest & { readonly commandId: string } {
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody))
    } catch {
      throw new CommandError(400, 'malformed_body', '请求体不是合法 JSON 对象')
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CommandError(400, 'malformed_body', '请求体必须是 JSON 对象')
    }
    const record = parsed as Record<string, unknown>
    const op = record['op']
    if (op !== 'create' && op !== 'resume' && op !== 'send' && op !== 'cancel' && op !== 'subscribe') {
      throw new CommandError(400, 'unsupported_operation', 'op 不在允许的集合内')
    }
    const sid = record['sid']
    if (typeof sid !== 'string' || sid.length === 0) {
      throw new CommandError(400, 'malformed_body', '缺少 sid')
    }
    const commandId = record['commandId']
    if (typeof commandId !== 'string' || commandId.length === 0) {
      throw new CommandError(400, 'malformed_body', '缺少 commandId')
    }
    const text = record['text']
    if (op === 'send' && (typeof text !== 'string' || text.length === 0)) {
      throw new CommandError(400, 'malformed_body', 'send 必须带非空 text')
    }
    const messageId = record['messageId']
    if (messageId !== undefined && (typeof messageId !== 'string' || messageId.length === 0)) {
      throw new CommandError(400, 'malformed_body', 'messageId 必须是非空字符串')
    }
    if (typeof messageId === 'string' && messageId !== commandId) {
      // 在解析阶段就拒绝：调用方不能自带一个不同的 messageId 来绕开对账。
      throw new CommandError(400, 'malformed_body', 'messageId 必须省略或等于 commandId', 'parse')
    }
    return {
      op,
      sid,
      commandId,
      ...(typeof text === 'string' ? { text } : {}),
      ...(typeof messageId === 'string' ? { messageId } : {}),
    }
  }

  private commandIdOf(request: CommandRequest & { readonly commandId: string }): string {
    return request.commandId
  }

  /** 把 `GrantError` 翻译成不含敏感信息的 HTTP 错误。 */
  private grantFailure(error: unknown): CommandError {
    if (error instanceof GrantError) {
      const status = error.code === 'grant/expired' || error.code === 'grant/too-old' ? 401 : 403
      return new CommandError(status, error.code, error.reason, error.stage)
    }
    return new CommandError(403, 'grant_rejected', '凭证校验失败')
  }

  /**
   * 打开（或复用）一个会话；同一 sid 的并发打开被合并。
   *
   * 复用路径同样要核对所有者：否则同一租户里的另一个用户可以用**自己的**
   * 合法凭证对已打开的会话发 create/resume，拿到 accepted 却不碰任何归属检查。
   */
  private async ensureOpen(claims: GrantClaims): Promise<void> {
    if (this.live.has(claims.sid)) {
      this.requireOwned(claims)
      return
    }
    const inFlight = this.opening.get(claims.sid)
    if (inFlight !== undefined) {
      await inFlight
      // 并发打开完成后，新来的这条请求仍要证明自己就是所有者。
      this.requireOwned(claims)
      return
    }
    const opening = this.open(claims)
    this.opening.set(claims.sid, opening)
    try {
      await opening
    } finally {
      this.opening.delete(claims.sid)
    }
  }

  /**
   * 创建/恢复一个 Agent。
   *
   * 关键顺序（tech-design-v1 §4.1，pinned vendor API 已核对：
   * `agentPresets.mount(ctx, id)` 是 async，而 `principals.bind(agent, p)` 必须
   * 在 preset 组合**能读到主体**之前完成 —— 新 preset 里的工具/提示词注册
   * 会在 mount 期间 require principal）：
   *
   * 1. setup 内：resume 核对磁盘 header preset → **先** `principals.bind`
   *    （并把解绑放进 `agentCtx.effect`）→ **再** `await presets.mount`。
   * 2. mount 失败时绑定必须随 scope 一起解除：用 `agentCtx.effect` 注册的
   *    cleanup 在 scope 回卷时执行，因此失败不会留下一个"绑了身份但没挂上
   *    preset"的半成品。
   * 3. setup 之后：再查一次撤权（覆盖"发布期间到达的撤权"）→ `flush` 成功
   *    才登记为 live；任何一步失败都 dispose。
   */
  private async open(claims: GrantClaims): Promise<void> {
    const principal: Principal = {
      sid: claims.sid,
      tid: claims.tid,
      sub: claims.sub,
      wid: claims.wid,
      preset: claims.preset,
      rev: claims.rev,
    }
    const revoked = this.revocationVerdict(claims)
    if (revoked !== undefined) throw revoked

    // 打开前的一次身份刷新：创建竞态下周期快照可能还没包含新绑定。
    // 刷新失败即中止打开 —— 正确的解法是"重新拉一次"，不是放宽准入。
    if (this.ports.refreshIdentity !== undefined) {
      try {
        await this.ports.refreshIdentity(principal)
      } catch (error) {
        throw new CommandError(
          503,
          'identity_refresh_failed',
          `打开会话前无法刷新身份：${error instanceof Error ? error.name : 'unknown'}`,
          'binding',
        )
      }
    }

    // create 的重试必须服从磁盘事实：磁盘已有这个会话就必须走 resume，
    // 绝不能用 create 覆盖一份已存在的持久日志（DSH 自己会拒绝，但我们要给出
    // 稳定、可对账的错误/路径，而不是把底层异常泄漏出去）。
    const persisted = await this.readPersistedSession(claims.sid)
    let op: 'create' | 'resume' = claims.op === 'resume' ? 'resume' : 'create'
    if (claims.op === 'resume' && persisted === undefined) {
      throw new CommandError(409, 'session_not_found', 'resume：磁盘上没有该会话', 'setup')
    }
    if (claims.op === 'create' && persisted !== undefined) {
      // 磁盘已有：走 resume 并核对 meta，而不是覆盖。
      op = 'resume'
    }

    const setup: AgentSetupPort = async (agentCtx, agent) => {
      if (op === 'resume') {
        const header = agent.session.header.agentPreset ?? persisted?.agentPreset
        if (header !== undefined && header !== claims.preset) {
          // resume 必须与磁盘上的 preset 绑定一致；不一致说明凭证与事实不符。
          throw new CommandError(
            409,
            'preset_mismatch',
            `resume：磁盘 preset(${header}) 与凭证 preset(${claims.preset}) 不一致`,
            'setup',
          )
        }
      }
      // 先绑定身份，再挂 preset：preset 的工具/提示词注册在读主体时必须能读到它。
      const unbind = this.ports.bindPrincipal(agent, principal)
      // 绑定必须随 Agent scope 回收，**包括 mount 失败的回卷路径**。
      registerSetupCleanup(agentCtx, unbind)
      let mounted: string
      try {
        mounted = await this.ports.mountPreset(agentCtx, claims.preset)
      } catch (error) {
        // scope 回卷由 DSH 负责（setup 抛错 ⇒ 未发布的 Agent 被 dispose），
        // 这里额外同步解绑一次，保证"失败即刻失效"，不依赖回卷时机。
        unbind()
        throw error
      }
      if (mounted !== claims.preset) {
        unbind()
        throw new CommandError(
          500,
          'preset_not_mounted',
          `preset 挂载结果(${mounted})与请求(${claims.preset})不一致`,
          'setup',
        )
      }
      const composed = this.ports.composedPreset(agentCtx)
      if (composed !== undefined && composed !== claims.preset) {
        unbind()
        throw new CommandError(500, 'preset_not_mounted', 'preset 绑定未生效', 'setup')
      }
      return {
        commit: () => {
          // 同步、无 I/O：这里是能被 DSH 在发布前调用的唯一校验点。
          // 逐项严校验：撤权、绑定仍在、六字段与凭证一致、活性可用、版本未前进。
          const failure = this.commitVerdict(claims, agent)
          if (failure !== undefined) throw failure
        },
      }
    }

    let handle: AgentHandlePort
    try {
      handle =
        op === 'create'
          ? await this.ports.create({
              sessionId: claims.sid,
              meta: { agentPreset: claims.preset },
              setup,
            })
          : await this.ports.resume({ resumeSessionId: claims.sid, setup })
    } catch (error) {
      if (error instanceof CommandError) throw error
      throw new CommandError(502, 'open_failed', '打开会话失败', 'open')
    }

    try {
      // 覆盖"发布期间到达的撤权"。
      const afterPublish = this.revocationVerdict(claims)
      if (afterPublish !== undefined) throw afterPublish
      const flushed = await this.ports.flush(handle.agent.session)
      if (!flushed) {
        throw new CommandError(503, 'not_persisted', '持久化未就绪：flush 没有监听者参与', 'persist')
      }
      this.live.set(claims.sid, { handle, principal })
    } catch (error) {
      await handle.dispose().catch(() => undefined)
      if (error instanceof CommandError) throw error
      throw new CommandError(500, 'open_failed', '会话登记失败', 'open')
    }
  }

  /**
   * 发送一条消息。
   *
   * `messageId = commandId` 是刻意选择：崩溃后用**权威日志**对账，而不是只依赖
   * 进程内的回执表。回执在 `flush` 之后才返回，因此 `accepted` 的含义是
   * "已持久接收"。
   *
   * 顺序是安全属性，且**对账发生在 `requireOwned` 之前**：
   *
   * 1. 先回读**本进程会话日志**与**磁盘持久日志**。找到同一条 `commandId`：
   *    - 正文一致 ⇒ 这是重试，绝不追加第二遍（重启后内存回执表为空时尤其关键）；
   *    - 正文不同 ⇒ 409，不把它当成"同一条命令的另一个版本"。
   * 2. 只有日志里确实没有，才要求会话已打开（身份/所有者/活性）并真正投递。
   *
   * 没有把"对账"放在所有者检查之后，是因为重启后的重试根本没有活跃 Agent；
   * 先要求打开会话会让重启对账永远走不到，退化成"再 append 一次"。
   */
  private async send(claims: GrantClaims, request: CommandRequest): Promise<void> {
    const text = request.text ?? ''
    const messageId = claims.cmd
    // `messageId !== commandId` 已在 `command()` 拒绝；这里再断一次，防止
    // 未来有人从别的入口调用 `send`。
    if (request.messageId !== undefined && request.messageId !== messageId) {
      throw new CommandError(400, 'malformed_body', 'messageId 必须省略或等于 commandId', 'parse')
    }

    // 1) 权威对账。会话在本进程活跃时**先**做完整所有者核对，避免非所有者
    //    用同 sid 的凭证探测日志内容或"抢认"一条已存在的命令；重启后没有活跃
    //    Agent，此时只能靠磁盘对账（凭证本身已由控制面按单一所有者签发）。
    const live = this.live.get(claims.sid)
    if (live !== undefined) this.requireOwned(claims)
    const persisted = await this.reconcilePersisted(claims.sid, messageId, text)
    const inMemory =
      live === undefined ? undefined : this.reconcileLive(live.handle.agent.session, messageId, text)
    const reconciled = persisted ?? inMemory
    if (reconciled !== undefined) {
      if (reconciled.verdict === 'conflict') {
        throw new CommandError(409, 'command_id_conflict', reconciled.reason)
      }
      // 已经落盘/已提交：不重复 append。若会话仍在活跃，再 flush 一次以保持
      // "accepted = 已持久"的语义（flush 幂等）；重启后没有活跃会话时，
      // 磁盘上的记录本身就是持久证据。
      if (live !== undefined) {
        const flushed = await this.ports.flush(live.handle.agent.session)
        if (!flushed) {
          throw new CommandError(503, 'not_persisted', '未持久化：flush 没有监听者参与', 'persist')
        }
      }
      return
    }

    // 2) 真正的新消息：必须已经打开且身份仍然有效（重启路径在这里得到
    //    `session_not_open`，而不是被隐式创建）。
    const entry = live ?? this.requireOwned(claims)
    const message = this.ports.createUserMessage(text, messageId)
    // 火忘调用的错误不能变成 unhandled rejection：先捕获，再按需抛出。
    try {
      entry.handle.agent.followup(message)
    } catch {
      throw new CommandError(500, 'followup_failed', '消息投递失败', 'deliver')
    }
    const flushed = await this.ports.flush(entry.handle.agent.session)
    if (!flushed) {
      throw new CommandError(503, 'not_persisted', '未持久化：flush 没有监听者参与', 'persist')
    }
  }

  /** 取会话的活跃记录并核对所有者；任何不一致都拒绝。 */
  private requireOwned(claims: GrantClaims): LiveEntry {
    const revoked = this.revocationVerdict(claims)
    if (revoked !== undefined) throw revoked
    const entry = this.live.get(claims.sid)
    if (entry === undefined) {
      throw new CommandError(409, 'session_not_open', '会话尚未打开：请先 create/resume', 'binding')
    }
    // 所有者必须与凭证一致；不做"同租户即可"的放宽。
    if (entry.principal.sub !== claims.sub) {
      throw new CommandError(403, 'not_owner', '凭证主体不是该会话的所有者', 'binding')
    }
    const current = this.host.lookupPrincipal(entry.handle.agent)
    if (!current.ok) {
      throw new CommandError(403, 'identity_invalid', `身份已失效：${current.reason}`, 'binding')
    }
    // 六字段逐项一致：只比 sub 会把"同一所有者换了作品/preset/版本"当成同一身份。
    const mismatch = principalMismatch(current.principal, claims)
    if (mismatch !== undefined) {
      throw new CommandError(403, 'identity_mismatch', `会话绑定与凭证不一致：${mismatch}`, 'binding')
    }
    return entry
  }
}

/**
 * 逐项比较绑定主体与凭证声明，返回第一个不一致的可读描述。
 *
 * 六个字段全部参与：`sid`/`tid`/`sub`/`wid`/`preset`/`rev`。只比其中一部分
 * 会漏掉"换了作品""换了 preset""版本回退"这几类语义不同但 sid 相同的请求。
 */
function principalMismatch(principal: Principal, claims: GrantClaims): string | undefined {
  const actual: Record<(typeof PRINCIPAL_FIELDS)[number], string | number> = {
    sid: principal.sid,
    tid: principal.tid,
    sub: principal.sub,
    wid: principal.wid,
    preset: principal.preset,
    rev: principal.rev,
  }
  const expected: Record<(typeof PRINCIPAL_FIELDS)[number], string | number> = {
    sid: claims.sid,
    tid: claims.tid,
    sub: claims.sub,
    wid: claims.wid,
    preset: claims.preset,
    rev: claims.rev,
  }
  for (const field of PRINCIPAL_FIELDS) {
    if (actual[field] !== expected[field]) {
      return `${field}(绑定=${String(actual[field])} ≠ 凭证=${String(expected[field])})`
    }
  }
  return undefined
}

/**
 * 事件流订阅凭证的 `cmd` claim 派生规则。
 *
 * 事件流没有业务 commandId，但凭证必须绑定一个确定值；用 `sub:<sid>`
 * 让"同一个会话的订阅凭证"可被显式重放拒绝（jti 一次性），同时不与任何
 * 业务命令的 commandId 冲突。签发侧（控制面）使用同一函数。
 */
export function subscribeCommandId(sid: string): string {
  return `subscribe-${sid}`
}

/**
 * 命令回执凭证的 `cmd` claim 派生规则（`GET /v1/commands/:id`）。
 *
 * 回执读取没有请求正文，因此凭证绑定 `bh = sha256("")`；`cmd` 用
 * `receipt-${commandId}` 把"读哪一条回执"钉死在凭证里，并且与业务命令的
 * `commandId`（以及事件流的 `subscribe-<sid>`）不重合：一枚回执凭证只对
 * 自己那一条回执有效，换 id 即 `cmd` 不符。
 *
 * 签发侧（控制面/BFF）必须使用同一函数、同一空正文摘要。
 */
export function receiptCommandId(commandId: string): string {
  return `receipt-${commandId}`
}

/**
 * 从一条会话事件里抽出"这条命令是否已经落进会话日志"。
 *
 * 认两种事件：
 * - `user/message`：模型真正看到的那条消息，带完整 content；
 * - `agent/inbox/spliced`：消息已入 inbox 但还没被轮次消费（崩溃在中间时），
 *   只能从 `inserted[].content` 里读出正文。
 *
 * 不认其他事件：别的类型里出现的 id 不是"用户消息已持久"的证据。
 *
 * @returns 命中时给出 id 与可比对文本；不是这个 id 时返回 undefined。
 */
function matchUserMessage(
  event: SessionEventPort,
  commandId: string,
): { readonly text: string } | undefined {
  if (event.type === 'user/message') {
    const data = event.data as { readonly id?: unknown; readonly content?: unknown } | null
    if (data === null || typeof data !== 'object' || data.id !== commandId) return undefined
    return { text: textOfContent(data.content) }
  }
  if (event.type === 'agent/inbox/spliced') {
    const data = event.data as { readonly inserted?: unknown } | null
    if (data === null || typeof data !== 'object' || !Array.isArray(data.inserted)) return undefined
    for (const message of data.inserted) {
      if (message === null || typeof message !== 'object') continue
      const record = message as { readonly id?: unknown; readonly content?: unknown }
      if (record.id !== commandId) continue
      return { text: textOfContent(record.content) }
    }
  }
  return undefined
}

/** 把消息内容拼成可比对的一段文本；非文本块（图片等）不参与比较。 */
function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const record = block as { readonly type?: unknown; readonly text?: unknown }
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('\n')
}

/**
 * 把解绑函数注册进 setup 的 Agent scope。
 *
 * DSH 的 setup 收到的是 `Context`（有 `effect`）；这里只做结构性调用，
 * 拿不到 `effect` 时退化为"不注册清理" —— 安全性不受影响，因为
 * `PrincipalRegistry` 的主键是 `WeakMap<Agent, …>`，scope 消失后绑定自然不可达。
 */
function registerSetupCleanup(agentCtx: unknown, unbind: () => void): void {
  if (agentCtx === null || typeof agentCtx !== 'object') return
  const effect = (agentCtx as { effect?: unknown }).effect
  if (typeof effect !== 'function') return
  try {
    ;(effect as (body: () => () => void, label?: string) => unknown).call(agentCtx, () => unbind, 'myrix: principals.bind')
  } catch {
    // 注册失败不影响正确性：WeakMap 主键已经保证生命周期。
  }
}
