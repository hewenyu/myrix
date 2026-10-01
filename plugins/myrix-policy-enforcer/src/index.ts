/**
 * `myrix-policy-enforcer` —— DSH 侧的策略执行点（PEP）。
 *
 * 与旧 `dsh-plugin-governance` 的关键差别（platform-plan-v2 §9）：
 *
 * - **guard 是同步的**：`ctx.tools.guard()` 只接受同步函数，本插件读的是
 *   进程内快照，绝不在 guard 里发网络请求。
 * - **guard 是兜底而非唯一**：它挡的是"绕过 pre-execute 的直接调用"，因此
 *   缺身份、缺快照、缺 allowlist 全部拒绝，不给任何"本 guard 不表态"的默许。
 * - **waterfall 一定调用 next()**：`tools/pre-execute` 是 waterfall，
 *   不调用 `next()` 就等于否决整条链。本插件只做拒绝或放行，从不吞掉链。
 * - **不保存策略**：快照由外部生产者安装（`@myrix/binding-lease` 用**同一份**
 *   凭证认证绑定快照里的策略字段安装），本插件只读、只校验、只翻译成拒绝。
 *
 * ## 生产者（R16）
 *
 * 本插件把持有者作为真实 Cordis 服务 `ctx.myrixPolicySnapshots` 暴露出去；
 * 唯一生产者是绑定租约插件。持有者**不是**模块级单例，因此 esbuild 打包后
 * 插件间共享的是同一条服务查找路径，而不是"各自复制一份 WeakMap"。
 *
 * @module @myrix/policy-enforcer
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { PrincipalRegistry } from '@myrix/principals'
import { NOVEL_TOOL_ALLOWLIST, admitTool } from './admission'
import type {
  PolicyGrant,
  PolicyInstallOutcome,
  PolicySnapshot,
  PolicySnapshotBounds,
  PolicySnapshotSink,
  PolicySnapshotSource,
} from './types'

export { NOVEL_TOOL_ALLOWLIST, admitTool, assertPolicySnapshot } from './admission'
export type {
  AdmissionInput,
  PolicyGrant,
  PolicyInstallOutcome,
  PolicySnapshot,
  PolicySnapshotBounds,
  PolicySnapshotSink,
  PolicySnapshotSource,
  ToolAdmission,
} from './types'

export const name = 'myrix-policy-enforcer'
/** 只声明真正用到的服务；`principals` 缺失时插件不激活（而不是降级放行）。 */
export const inject = ['tools', 'principals']

/** 诊断原因的最大长度，与准入内核的上游字符串截断保持一致。 */
const MAX_REASON = 240

/** 供 `ctx.myrixPolicySnapshots` 使用的进程内服务名（生产者与消费者唯一的汇合点）。 */
export const POLICY_SNAPSHOT_SERVICE = 'myrixPolicySnapshots'

/**
 * 策略快照允许的最长剩余时长（毫秒）。
 *
 * 与绑定租约的 `MAX_TTL_MS` 逐字一致：任何一条授权路径都不允许把策略信任
 * 超过 30 秒，也不允许生产者用"服务端说 10 分钟"绕过这个上限。
 */
export const MAX_POLICY_TTL_MS = 30_000

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 策略快照持有者；由 `myrix-policy-enforcer` 提供。 */
    myrixPolicySnapshots: PolicySnapshotHolder
  }
}

/** 插件配置：全部字段显式，没有"省略即放行"的默认值。 */
export interface Config {
  /**
   * 允许模型看到的工具名（静态 allowlist）。
   *
   * 省略时使用 `NOVEL_TOOL_ALLOWLIST`（恰好 6 个小说工具）。**不允许为空数组**：
   * 空 allowlist 表示"没有允许项"，此时任何工具调用都会被拒绝 —— 这是刻意的，
   * 因为"配置漏了"与"禁止一切"在安全上应当同向。
   */
  allowedTools?: readonly string[]
}

/**
 * 进程内的策略快照持有者（`ctx.myrixPolicySnapshots` 的值）。
 *
 * 状态只有三样：一份被替换的快照、一个**永不回退**的版本高水位、一个可注入的时钟。
 * 高水位在 `clear()` 之后依然保留 —— 否则"先失败清空、再灌一份旧快照"就能把
 * 已撤销的授权重新装回来。
 *
 * 到期用**两个**时限取先到者：墙钟 `expiresAt`（与应用/服务端同源，便于诊断）
 * 与单调截止时刻。单调时钟只增不减，因此系统时间回拨不能延长授权。
 */
export class PolicySnapshotHolder implements PolicySnapshotSource, PolicySnapshotSink {
  private snapshot: PolicySnapshot | undefined
  private installedAt = 0
  private updates = 0
  private clears = 0
  /** 已接受的最大 rev；`clear()` 不会重置它。 */
  private highWaterRev = -1
  /** 最近一次安装的 rev；`clear()` 之后仍然可读，供运维判断"被撤销的是哪一版"。 */
  private lastRev: number | null = null
  /** 单调时基下的绝对到期时刻；与墙钟 `expiresAt` 取先到者。 */
  private monoDeadlineMs: number | null = null
  private lastReason: string | null = null

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly monoNow: () => number = () => performance.now(),
  ) {}

  /**
   * 安装（或替换）一份**已经带绝对到期时刻**的快照。
   *
   * 保留这条入口是为了兼容直接持有快照的调用方与测试；生产路径走
   * {@link installOrClear}（带单调时限上界）。
   *
   * @param next - 快照；`expiresAt` 是 Unix 毫秒。
   * @throws 当版本回退时（与旧行为一致：安装方必须显式知道自己在装旧快照）。
   */
  install(next: PolicySnapshot): void {
    const current = this.snapshot
    if (current !== undefined && next.rev < current.rev) {
      throw new Error(`myrix: 策略快照版本回退（${current.rev} → ${next.rev}），拒绝安装`)
    }
    if (next.rev < this.highWaterRev) {
      throw new Error(`myrix: 策略快照版本低于已接受高水位（${this.highWaterRev} → ${next.rev}），拒绝安装`)
    }
    const remaining = next.expiresAt - this.now()
    this.installChecked(
      { rev: next.rev, tid: next.tid, tools: Object.freeze([...next.tools]) },
      Number.isFinite(remaining) && remaining > 0 ? remaining : 0,
    )
  }

  /**
   * 生产者入口：校验 → 单调版本检查 → 一次性替换；任何失败都**清空**并返回原因。
   *
   * 永不抛出：生产者（租约刷新）需要的是"失败即无策略"，而不是让一次
   * 策略问题冒泡成刷新异常。到期时刻由本持有者从 `bounds.remainingMs`
   * 用自己的两个时钟算出（见 `PolicyGrant` 的说明）。
   *
   * @param grant - 生产者的策略内容（版本、租户、工具集合）。
   * @param bounds - 本次授权的剩余时长上界。
   * @returns 安装结果；`installed:false` 时快照已被清空。
   */
  installOrClear(grant: PolicyGrant, bounds: PolicySnapshotBounds): PolicyInstallOutcome {
    const remainingMs = bounds?.remainingMs
    if (typeof remainingMs !== 'number' || !Number.isFinite(remainingMs) || remainingMs <= 0) {
      this.clear('剩余时长非法，拒绝安装')
      return { installed: false, reason: `myrix: 策略剩余时长非法（${String(remainingMs)}），拒绝安装` }
    }
    if (grant === null || typeof grant !== 'object') {
      this.clear('策略内容非法')
      return { installed: false, reason: 'myrix: 策略内容不是对象' }
    }
    if (!Number.isSafeInteger(grant.rev) || grant.rev < 0) {
      this.clear('策略版本非法')
      return { installed: false, reason: 'myrix: 策略版本不是非负安全整数' }
    }
    if (typeof grant.tid !== 'string' || grant.tid.length === 0) {
      this.clear('策略租户非法')
      return { installed: false, reason: 'myrix: 策略缺少租户' }
    }
    if (!Array.isArray(grant.tools) || grant.tools.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
      this.clear('策略工具集合非法')
      return { installed: false, reason: 'myrix: 策略工具集合必须是字符串数组' }
    }
    if (grant.rev < this.highWaterRev) {
      // 版本回退（含"已清空后重放旧快照"）：清空 + 拒绝，保留高水位。
      this.clear(`策略版本回退（高水位 ${this.highWaterRev}）`)
      return { installed: false, reason: `myrix: 策略快照版本低于已接受高水位（${this.highWaterRev} → ${grant.rev}），拒绝` }
    }
    return { installed: true, ...this.installChecked(grant, Math.min(remainingMs, MAX_POLICY_TTL_MS)) }
  }

  /** 撤销快照（撤权、drain、失联、卸载时使用）。之后一切工具调用都被拒绝。 */
  clear(reason?: string): void {
    this.snapshot = undefined
    this.installedAt = this.now()
    this.clears += 1
    this.lastReason = reason ?? null
  }

  /** 当前仍有效的快照；已过期（墙钟或单调）返回 undefined。 */
  current(): PolicySnapshot | undefined {
    const snapshot = this.snapshot
    if (snapshot === undefined) return undefined
    if (!Number.isFinite(snapshot.expiresAt) || this.now() >= snapshot.expiresAt) return undefined
    if (this.monoDeadlineMs !== null && this.monoNow() >= this.monoDeadlineMs) return undefined
    return snapshot
  }

  /**
   * 单调截止时刻（诊断用）。
   *
   * 单独暴露是为了让"墙钟被回拨但单调到期已过"这一条能被测试直接断言。
   */
  monoDeadline(): number | null {
    return this.monoDeadlineMs
  }

  /**
   * 诊断：不含任何身份内容。
   *
   * `lastReason` 是**本模块自己生成的**固定文案（"租约刷新失败：http-status" 这类），
   * 仍按 240 字符截断，防止将来有人把上游字符串塞进来。
   */
  stats(): {
    present: boolean
    rev: number | null
    installedAt: number
    updates: number
    clears: number
    highWaterRev: number
    lastReason: string | null
  } {
    const reason = this.lastReason
    return {
      present: this.current() !== undefined,
      rev: this.snapshot?.rev ?? this.lastRev,
      installedAt: this.installedAt,
      updates: this.updates,
      clears: this.clears,
      highWaterRev: this.highWaterRev,
      lastReason: reason === null || reason.length <= MAX_REASON ? reason : `${reason.slice(0, MAX_REASON)}…`,
    }
  }

  /** 一次性替换：墙钟与单调两个时限同时写入（都用本持有者的时钟）。 */
  private installChecked(grant: PolicyGrant, remainingMs: number): { rev: number; expiresAt: number } {
    this.snapshot = Object.freeze({
      rev: grant.rev,
      tid: grant.tid,
      expiresAt: this.now() + remainingMs,
      tools: Object.freeze([...grant.tools]) as readonly string[],
    })
    this.monoDeadlineMs = this.monoNow() + remainingMs
    this.installedAt = this.now()
    this.updates += 1
    this.highWaterRev = Math.max(this.highWaterRev, grant.rev)
    this.lastRev = grant.rev
    this.lastReason = null
    return { rev: grant.rev, expiresAt: this.snapshot.expiresAt }
  }
}

/**
 * 安装 PEP。真实 Cordis function plugin：具名导出、无 default export。
 *
 * 拒绝路径的返回值是给模型看的字符串；它**只包含工具名与拒绝类别**，
 * 不含凭证、正文或原始上游数据。
 */
export function apply(ctx: Context, config: Config = {}): void {
  applyWithHolder(ctx, config, new PolicySnapshotHolder())
}

/**
 * 与 {@link apply} 相同的装配，但允许注入持有者（测试用的确定性时钟）。
 *
 * 安全语义完全一致：持有者仍然是**同一份**被 `ctx.provide` 出去的服务。
 */
export function applyWithHolder(ctx: Context, config: Config, holder: PolicySnapshotHolder): void {
  const allowedTools = resolveAllowlist(config.allowedTools)
  const principals = ctx.principals as PrincipalRegistry

  // 真实 Cordis 服务（不是模块级单例）：生产者与消费者通过服务查找汇合，
  // 因此 esbuild 把插件各自打成一个 bundle 也不会各自持有半份状态。
  ctx.provide(POLICY_SNAPSHOT_SERVICE, holder)
  // 兼容退路索引：老调用方（PoC 探针）在服务查找不可用时仍能拿到同一个持有者。
  __registerSnapshotHolder(ctx, holder)

  ctx.logger?.info('myrix-policy-enforcer 已挂载', {
    allowedTools: allowedTools.length,
    service: 'principals',
    policyService: POLICY_SNAPSHOT_SERVICE,
  })

  const admit = (exec: Readonly<ToolExecution>) =>
    admitTool({
      principal: principals.lookup(exec.agent),
      toolName: exec.name,
      allowedTools,
      snapshot: holder.current(),
      now: Date.now(),
    })

  // ---- 兜底：同步 guard（单调，只能收紧） ----
  ctx.effect(
    () => ctx.tools.guard((exec: Readonly<ToolExecution>): string | undefined => {
      const admission = admit(exec)
      return admission.allow ? undefined : admission.reason
    }),
    'myrix-policy-enforcer: tools.guard',
  )

  // ---- 前置：waterfall，一定 next() ----
  ctx.on('tools/pre-execute', async (exec, next) => {
    const admission = admit(exec)
    if (admission.allow) return await next()
    return { kind: 'deny', reason: admission.reason }
  })

  // 卸载本插件时一并撤销策略：持有者的生命周期不超过提供它的 fiber。
  ctx.effect(() => () => {
    holder.clear('policy-enforcer 卸载')
    if (snapshotHolders.get(ctx) === holder) snapshotHolders.delete(ctx)
    if (snapshotHolders.get(ctx.root) === holder) snapshotHolders.delete(ctx.root)
  })
}

/**
 * 读取某个 Context 上的策略快照持有者。
 *
 * 优先返回真实 Cordis 服务（`ctx.myrixPolicySnapshots`），WeakMap 只是
 * 兼容退路：老调用方（PoC 探针、直接 import 的测试）拿到的仍是同一个对象。
 */
export function policySnapshotHolderOf(ctx: Context): PolicySnapshotHolder | undefined {
  const service = ctx.get(POLICY_SNAPSHOT_SERVICE)
  if (service !== undefined) return service
  return snapshotHolders.get(ctx) ?? snapshotHolders.get(ctx.root)
}

/** 兼容退路索引：仅当服务查找不可用（例如没有 provide 的替身 ctx）时使用。 */
const snapshotHolders = new WeakMap<object, PolicySnapshotHolder>()

/** 测试/装配辅助：把持有者登记进兼容索引（服务仍由 `applyWithHolder` 提供）。 */
export function __registerSnapshotHolder(ctx: Context, holder: PolicySnapshotHolder): void {
  snapshotHolders.set(ctx, holder)
  snapshotHolders.set(ctx.root, holder)
}

function resolveAllowlist(configured: readonly string[] | undefined): readonly string[] {
  if (configured === undefined) return NOVEL_TOOL_ALLOWLIST
  const cleaned = configured.filter((entry) => typeof entry === 'string' && entry.length > 0)
  // 显式传入空/全非法 allowlist 时保留"空"语义（拒绝一切），而不是悄悄回落到默认值 ——
  // 回落会让一个配置错误变成一次静默放行。
  return Object.freeze([...new Set(cleaned)])
}
