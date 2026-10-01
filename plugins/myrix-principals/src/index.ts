/**
 * `ctx.principals` —— Cell 侧的 Agent → 授权主体 绑定表。
 *
 * 设计约束（来自 platform-plan-v2 §3.4 与 tech-design-v1 §4.2）：
 *
 * 1. **不做成"每个 Agent 一个同名服务"**：Cordis 的进程级服务名会互相冲突，
 *    所以身份查表只能是一个进程内单例服务 + 一张表。
 * 2. **绑定不引入第二个权威源**：表里只存"本次进程内、由控制面凭证派生"的主体，
 *    权威记录永远在控制面数据库。表中的值不能用来证明任何权限，只能用来
 *    在**已经通过凭证校验**之后回答"这个 Agent 代表谁"。
 * 3. **主键用 WeakMap<Agent, Principal>**：Agent 的 scope 被撤销时，绑定随之消失；
 *    另外提供按 `sid` 的反查表，供撤权与模型归因使用，并在 Agent 离开注册表时清理，
 *    避免"撤权后表还在"。
 * 4. **活性由外部提供**：绑定只能证明"曾经是谁"，不能证明"此刻还是不是成员"。
 *    因此 guard 与业务工具走 `require*` 路径：没有安装活性提供者 → 拒绝；
 *    提供者返回 false/undefined/抛错 → 拒绝。默认拒绝，没有例外。
 * 5. **撤权单调**：同一会话的撤权版本只能前进；更旧的撤权通知被忽略而不是回退状态。
 *    已撤权的会话**永远不能再次绑定**，即便控制面之后又签发了新凭证。
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  Principal,
  PrincipalLiveness,
  PrincipalLookup,
  PrincipalLookupDenial,
  RevocationState,
  RevokeOutcome,
} from './types'

export type {
  Principal,
  PrincipalLiveness,
  PrincipalLookup,
  PrincipalLookupDenial,
  RevocationState,
  RevokeOutcome,
} from './types'

/** 一次撤权通知（已由 driver 校验过控制面签名与单调性之后才交给本表）。 */
export interface RevokeRequest {
  /** 目标会话。 */
  readonly sid: string
  /** 撤权版本；必须非负。同一会话内单调递增。 */
  readonly rev: number
  /** 可读原因，直接进拒绝信息与审计，不携带凭证材料。 */
  readonly reason: string
}

/** 身份缺失/失效时抛出；`reason` 与 `detail` 可安全外发（不含凭证与正文）。 */
export class PrincipalDeniedError extends Error {
  constructor(
    readonly reason: PrincipalLookupDenial,
    readonly detail: string,
  ) {
    super(`myrix: 会话没有有效身份（${reason}）：${detail}`)
    this.name = 'PrincipalDeniedError'
  }
}

interface SidEntry {
  readonly principal: Principal
  /** 弱引用 Agent：绑定本身靠 WeakMap 随 scope 回收，这里只是反查索引。 */
  readonly agent: WeakRef<Agent>
}

/** 进程内单例服务名；与本包 README 和 driver 的 `inject` 保持一致。 */
export const PRINCIPALS_SERVICE = 'principals'

declare module '@deepseek-ai/cordis' {
  interface Context {
    principals: PrincipalRegistry
  }
}

/**
 * Agent → 主体 的绑定表；只读查询，不持有策略。
 *
 * 一切"能否执行"的判定都不在这里：本表只回答身份问题，授权在控制面
 * （`packages/governance`）与作品服务侧完成。guard 用本表做"缺身份即拒"。
 */
export class PrincipalRegistry extends Service<never> {
  /** 主绑定：Agent 对象 → 主体。Agent scope 结束时条目自然不可达。 */
  private readonly byAgent = new WeakMap<Agent, Principal>()
  /** 反查索引：sid → 主体 + Agent 弱引用（撤权、模型归因、诊断用）。 */
  private readonly bySid = new Map<string, SidEntry>()
  /** 已撤权会话的高水位；条目一旦写入不会被删除。 */
  private readonly revocations = new Map<string, RevocationState>()
  /**
   * 外部提供的活性判定；未安装时 `require*` 一律拒绝。
   *
   * 刻意装在一个对象里而不是直接做字段：Cordis 会把服务实例包成可调用代理，
   * 实例上的**函数**字段读回来是另一个被追踪的包装对象，`===` 不再成立；
   * 对象字段则是同一引用。disposer 的幂等比对依赖这个引用身份。
   */
  private readonly livenessBox: { current: PrincipalLiveness | undefined } = { current: undefined }
  /** 绑定次数与拒绝次数，供运维观察（不含任何身份内容）。 */
  private bound = 0
  private denied = 0

  constructor(ctx: Context) {
    super(ctx, PRINCIPALS_SERVICE)
    // Agent 离开注册表（dispose / scope 回卷）时立刻清掉反查索引。
    // 这是 best-effort 的卫生措施：真正的安全边界是 WeakMap + 撤权表，
    // 不依赖这个事件一定送达。
    ctx.on('agent/disposed', ({ agent }) => {
      this.dropSidEntry(agent.id as unknown as string, agent)
    })
  }

  // ---- 绑定 ----

  /**
   * 在 Agent 的 setup 阶段绑定主体，返回解绑函数（放进 `agentCtx.effect`）。
   *
   * 已撤权或已被其他主体占用的会话拒绝绑定：`resume` 重新绑定不能"洗白"撤权，
   * 也不能让第二个所有者接管同一会话。
   *
   * @throws 当 sid 已撤权，或已绑定到不同 sub 的 Agent。
   */
  bind(agent: Agent, principal: Principal): () => void {
    const sid = principal.sid
    const revoked = this.revocations.get(sid)
    if (revoked !== undefined) {
      this.denied += 1
      throw new PrincipalDeniedError('revoked', `会话 ${sid} 已撤权（rev=${revoked.rev}）：${revoked.reason}`)
    }
    if (agent.id !== sid) {
      this.denied += 1
      throw new PrincipalDeniedError(
        'unbound',
        `Agent id(${String(agent.id)}) 与凭证 sid(${sid}) 不一致，拒绝绑定`,
      )
    }
    const existing = this.bySid.get(sid)
    if (existing !== undefined && existing.principal.sub !== principal.sub) {
      this.denied += 1
      throw new PrincipalDeniedError('unbound', `会话 ${sid} 已属于其他主体，拒绝更换所有者`)
    }
    this.byAgent.set(agent, principal)
    this.bySid.set(sid, { principal, agent: new WeakRef(agent) })
    this.bound += 1
    return () => {
      this.byAgent.delete(agent)
      this.dropSidEntry(sid, agent)
    }
  }

  // ---- 活性 ----

  /**
   * 安装绑定/成员活性的外部判定（effect-scoped：返回 disposer）。
   *
   * 传入 `undefined` 会卸载判定，之后 `require*` 一律拒绝 —— 这允许
   * driver 在撤权、drain、或控制面心跳中断时把"无法证明仍然有效"变成拒绝。
   */
  setLiveness(provide: PrincipalLiveness | undefined): () => void {
    this.livenessBox.current = provide
    return () => {
      if (this.livenessBox.current === provide) this.livenessBox.current = undefined
    }
  }

  /** 当前是否安装了活性判定（诊断用；不暴露判定内容）。 */
  hasLiveness(): boolean {
    return this.livenessBox.current !== undefined
  }

  // ---- 查询 ----

  /** 宽松查询：只看绑定与撤权，不查活性。业务工具不要用它做准入。 */
  get(agent?: Agent): Principal | undefined {
    if (agent === undefined) return undefined
    const principal = this.byAgent.get(agent)
    if (principal === undefined) return undefined
    return this.revocations.has(principal.sid) ? undefined : principal
  }

  /** 宽松反查：按会话取主体，不查活性。 */
  bySession(sid?: string): Principal | undefined {
    if (sid === undefined) return undefined
    const entry = this.bySid.get(sid)
    if (entry === undefined) return undefined
    if (this.revocations.has(sid)) return undefined
    return entry.principal
  }

  /** 带原因的严格查询（含活性）；guard 与业务工具的唯一准入路径。 */
  lookup(agent?: Agent): PrincipalLookup {
    if (agent === undefined) return this.deny('no-agent', '调用没有关联 Agent')
    const principal = this.byAgent.get(agent)
    if (principal === undefined) return this.deny('unbound', '该 Agent 没有绑定授权主体')
    return this.admit(principal)
  }

  /** 带原因的严格反查（含活性）；模型适配器等按会话归因时使用。 */
  lookupBySession(sid?: string): PrincipalLookup {
    if (sid === undefined) return this.deny('no-agent', '请求没有携带会话标识')
    const entry = this.bySid.get(sid)
    if (entry === undefined) return this.deny('unbound', `会话 ${sid} 没有绑定授权主体`)
    return this.admit(entry.principal)
  }

  /** 严格查询，失败抛 `PrincipalDeniedError`。 */
  require(agent?: Agent): Principal {
    const result = this.lookup(agent)
    if (!result.ok) throw new PrincipalDeniedError(result.reason, result.detail)
    return result.principal
  }

  /** 严格反查，失败抛 `PrincipalDeniedError`。 */
  requireBySession(sid?: string): Principal {
    const result = this.lookupBySession(sid)
    if (!result.ok) throw new PrincipalDeniedError(result.reason, result.detail)
    return result.principal
  }

  // ---- 撤权 ----

  /**
   * 接受一条撤权通知：先看单调性，再让绑定立刻失效。
   *
   * 语义与 tech-design-v1 §4.1 的 `revoke` 对齐：这里只做"身份失效"这一步
   * （同步、纯内存），cancel/dispose/关流由 driver 负责，顺序由 driver 保证。
   */
  revoke(request: RevokeRequest): RevokeOutcome {
    const { sid } = request
    if (!Number.isSafeInteger(request.rev) || request.rev < 0) {
      return { accepted: false, reason: 'rev 必须是非负安全整数', highWaterRev: this.highWaterRev(sid) }
    }
    if (sid.length === 0) {
      return { accepted: false, reason: 'sid 为空', highWaterRev: 0 }
    }
    const current = this.revocations.get(sid)
    if (current !== undefined && request.rev <= current.rev) {
      // 乱序或重放的旧通知：不回退状态，也不再重复通知调用方。
      return { accepted: false, reason: `撤权版本不递增（当前 ${current.rev}）`, highWaterRev: current.rev }
    }
    this.revocations.set(sid, {
      rev: request.rev,
      revoked: true,
      reason: request.reason.length > 0 ? request.reason : 'revoked',
    })
    this.dropSidEntry(sid, undefined)
    return { accepted: true, reason: 'accepted', highWaterRev: request.rev }
  }

  /** 会话的撤权状态；未撤权返回 undefined。 */
  revocationOf(sid: string): RevocationState | undefined {
    return this.revocations.get(sid)
  }

  /** 会话是否已撤权。 */
  isRevoked(sid: string): boolean {
    return this.revocations.has(sid)
  }

  /** 已接受的最大撤权版本；没有记录时返回 0。 */
  highWaterRev(sid: string): number {
    return this.revocations.get(sid)?.rev ?? 0
  }

  /** 诊断指标：只含计数，不含身份。 */
  stats(): { bound: number; live: number; revoked: number; denied: number; liveness: boolean } {
    return {
      bound: this.bound,
      live: this.bySid.size,
      revoked: this.revocations.size,
      denied: this.denied,
      liveness: this.livenessBox.current !== undefined,
    }
  }

  // ---- 内部 ----

  private admit(principal: Principal): PrincipalLookup {
    const revoked = this.revocations.get(principal.sid)
    if (revoked !== undefined) {
      return this.deny('revoked', `会话 ${principal.sid} 已撤权（rev=${revoked.rev}）：${revoked.reason}`)
    }
    const liveness = this.livenessBox.current
    if (liveness === undefined) {
      // fail-closed：没有活性判定就不能证明"此刻仍是成员"。
      return this.deny('liveness-unavailable', '未安装绑定/成员活性判定，拒绝一切身份使用')
    }
    let alive: boolean | undefined
    try {
      alive = liveness(principal)
    } catch (error) {
      return this.deny('liveness-error', `活性判定抛错：${error instanceof Error ? error.name : 'unknown'}`)
    }
    if (alive !== true) {
      // `undefined`/`false`/非 true 一律视为失效，不做"默认有效"的兜底。
      return this.deny(alive === undefined ? 'liveness-unavailable' : 'liveness-stale', '主体活性已失效')
    }
    return { ok: true, principal }
  }

  private deny(reason: PrincipalLookupDenial, detail: string): PrincipalLookup {
    this.denied += 1
    return { ok: false, reason, detail }
  }

  /** 仅当索引仍指向同一个 Agent 时删除，避免旧 Agent 的 dispose 误删新绑定。 */
  private dropSidEntry(sid: string, agent: Agent | undefined): void {
    const entry = this.bySid.get(sid)
    if (entry === undefined) return
    if (agent !== undefined && entry.agent.deref() !== agent) return
    this.bySid.delete(sid)
  }
}

export default PrincipalRegistry
