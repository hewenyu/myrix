/**
 * `myrix-binding-lease` —— Cell 侧**有限时长绑定租约**（真实 Cordis function plugin）。
 *
 * 解决的问题：`@myrix/principals` 的 `lookup/require` 路径要求外部安装一个
 * **同步**活性判定（`setLiveness`），未安装时一切工具调用 fail-closed。但
 * `myrix-runtime-driver` 刻意不安装它（它没有权威绑定数据）。于是
 * "谁能在不破坏同步约束的前提下回答'此刻这个主体还是不是 active 成员'"需要
 * 一个独立的、可被装配的插件，这就是本插件。
 *
 * ## 权威数据从哪来
 *
 * `GET {origin}{path}`（默认 `/internal/v1/cells/{cellId}/bindings`），
 * `Authorization: Bearer <Cell 服务 token>`。token **只来自 Config**（部署 Secret
 * 注入）；本插件不生成身份、不落盘、不缓存正文。响应形状：
 *
 * ```json
 * { "cellId": "cell-1", "tenantId": "t_acme",
 *   "bindings": [ { "sid": "…", "tid": "…", "sub": "…", "wid": "…", "preset": "…", "rev": 3 } ] }
 * ```
 *
 * 服务端（Lead 负责的 BFF 端点）只返回当前租户 active、成员 active、作品未删除
 * 且同 owner、绑定 creating/active 且 cellId 匹配的行，不含业务正文。
 *
 * ## 租约语义（为什么这不是"永久授权"）
 *
 * - 有效期从**本次请求开始**的单调时刻算起（`ttlMs`，默认 10s，上限 30s），
 *   因此下载慢会直接吃掉有效期，而不是把过期时刻往后推。
 * - 周期刷新（`refreshMs`，默认 3s，必须 < ttlMs/2）在成功后**原子替换**缓存。
 * - 任何失败（HTTP 非 200、重定向、响应过大、非法 JSON/字段、跨 cell/租户、
 *   重复 sid、超时、abort）都**立即清空**缓存，于是随后的同步判定一律 false。
 * - 过期本身也返回 false（`lookup` 先比 TTL 再比字段）。
 *
 * 六字段（`sid/tid/sub/wid/preset/rev`）**全部**参与比较：只比 `sid`+`rev` 会
 * 把"同一会话换了所有者/换了作品/换了 preset"当成同一个主体放行。
 *
 * ## 创建竞态（Lead 必须知道的装配点）
 *
 * 新绑定写入控制面数据库后马上 `driver create`，而周期快照还没包含它。
 * 正确做法是**在真正 awaited 的 hook 里先刷新一次**，而不是放宽准入。
 * 本插件导出服务 `ctx.bindingLease`：
 *
 * ```ts
 * await ctx.bindingLease.refresh()          // 永不抛出；失败即清空缓存
 * ```
 *
 * 并且默认自己挂在 `agent/created` 上 —— 那是 DSH 的 **serial** 事件，在
 * `prepared.publish()` 里被 `await`，即"setup commit 之后、
 * `ctx.agents.create()` resolve 之前"执行（vendor
 * `packages/core/agent-loop/src/index.ts` 的 `setupAndPublish` →
 * `initializeAgent` → `prepared.publish`；`packages/core/agent/src/index.ts`
 * 的 `announce()` 用 `ctx.serial(...)`）。Lead 若在自己的适配里再调一次
 * `refresh()` 也是安全的（合并 + 幂等）。
 *
 * @module @myrix/binding-lease
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PrincipalRegistry } from '@myrix/principals'
import { resolveConfig, redact, type Config, type ResolvedConfig } from './config'
import { fetchSnapshot, type Fetcher } from './fetch'
import { LeaseCache, MAX_POLICY_TTL_MS, parseSnapshot } from './snapshot'
import type { BindingLease, LeaseRefreshOutcome, LeaseState, PolicyInstallReport, SnapshotRejection } from './types'

export {
  BindingLeaseConfigError,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_REFRESH_MS,
  DEFAULT_TTL_MS,
  MAX_REQUEST_TIMEOUT_MS,
  MAX_RESPONSE_BYTES_CAP,
  MAX_TTL_MS,
  normalizeOrigin,
  redact,
  renderPath,
  resolveConfig,
} from './config'
export type { Config, ResolvedConfig } from './config'
export { fetchSnapshot } from './fetch'
export type { FetchFailure, FetchOptions, FetchResult, Fetcher } from './fetch'
export { LeaseCache, MAX_POLICY_TTL_MS, parsePolicy, parseSnapshot, toWireSnapshot } from './snapshot'
export type { ParsedSnapshot, ParseFailure, ParseResult } from './snapshot'
export type {
  BindingLease,
  BindingPolicy,
  BindingRow,
  BindingSnapshot,
  LeaseRefreshOutcome,
  LeaseState,
  PolicyInstallReport,
  SnapshotRejection,
} from './types'

export const name = 'myrix-binding-lease'

/** 策略快照服务名；与 `@myrix/policy-enforcer` 的导出常量逐字一致。 */
export const POLICY_SNAPSHOT_SERVICE = 'myrixPolicySnapshots'

/**
 * 策略快照服务的最小结构面。
 *
 * 刻意用结构类型 + `ctx.get` 而不是模块增强/直接 import：策略桥是**可选**的
 * 装配（`requirePolicy`），租约插件不应该在类型上硬依赖执行点插件，也不应该
 * 假设两者被打进同一个 bundle（esbuild 会各自复制一份模块状态）。
 */
interface PolicySinkPort {
  installOrClear(
    grant: { readonly rev: number; readonly tid: string; readonly tools: readonly string[] },
    bounds: { readonly remainingMs: number },
  ): { readonly installed: boolean; readonly reason?: string }
  clear(reason?: string): void
}

/**
 * 只声明真正用到的服务。`principals` 缺失时插件不激活 —— 与
 * `myrix-policy-enforcer` 一样，宁可"插件不在"，也不要"插件在但没接上"。
 *
 * `myrixPolicySnapshots` 不放进无条件依赖：显式 lease-only PoC 不需要它。
 * 启用 `requirePolicy` 时，公开 apply 用 ctx.inject 创建依赖该服务的子 fiber；
 * 服务未出现时不安装租约，消失时卸载租约，重挂时重新激活，不依赖 profile 行顺序。
 * applyWithIo 保留同步缺服务校验，防止测试/装配调用方绕过这个生命周期边界。
 */
export const inject = ['principals']

/** 供 `ctx.bindingLease` 使用的进程内服务名。 */
export const BINDING_LEASE_SERVICE = 'bindingLease'

declare module '@deepseek-ai/cordis' {
  interface Context {
    bindingLease: BindingLease
  }
}

/** 可注入的 I/O 与时钟；生产环境使用默认实现，测试用它做确定性驱动。 */
export interface LeaseIo {
  /** 单调时钟（毫秒）。默认 `performance.now()`：不受系统时间回拨影响。 */
  readonly now: () => number
  /** 快照下载器。默认全局 `fetch`。 */
  readonly fetch: Fetcher
  /** 一次性定时器；返回取消函数。 */
  readonly setTimer: (callback: () => void, delayMs: number) => () => void
  /** 周期定时器；返回取消函数。 */
  readonly setInterval: (callback: () => void, delayMs: number) => () => void
}

/** 默认 I/O：单调时钟 + 全局 fetch + 不阻止进程退出的定时器。 */
export function defaultLeaseIo(): LeaseIo {
  return {
    now: () => performance.now(),
    fetch: (input, init) => fetch(input, init),
    setTimer: (callback, delayMs) => {
      const handle = setTimeout(callback, delayMs)
      // 租约心跳不应该让进程因为"还挂着一个定时器"而无法退出。
      ;(handle as { unref?: () => void }).unref?.()
      return () => clearTimeout(handle)
    },
    setInterval: (callback, delayMs) => {
      const handle = setInterval(callback, delayMs)
      ;(handle as { unref?: () => void }).unref?.()
      return () => clearInterval(handle)
    },
  }
}

/**
 * 租约运行时。
 *
 * 单独成类有实际理由：`apply()` 的职责只是"接线 + 注册 effect"，
 * 而全部安全属性（合并并发、失败清空、过期拒绝、卸载时 abort）都必须在
 * 没有 Cordis 进程的情况下可被穷举测试。
 */
export class BindingLeaseRuntime implements BindingLease {
  private readonly cache = new LeaseCache()
  /** 当前在途下载的取消句柄；卸载时全部 abort。 */
  private readonly inFlightAborts = new Set<AbortController>()
  /** 正在进行的下载。 */
  private current: Promise<LeaseRefreshOutcome> | undefined
  /**
   * 排在 `current` 之后的一次下载。
   *
   * 为什么需要它：在途请求**可能开始于我的绑定提交之前**，把它合并给我
   * 就等于用一份看不到我的快照冒充"已经刷新过"。因此在我到达时已有在途请求
   * 的情况下，我等到一次**开始于我到达之后**的下载；而与我同时到达的调用方
   * 共享那一次 —— 并发被压到最多两个在途请求，且调用方越多不会线性放大。
   */
  private queued: Promise<LeaseRefreshOutcome> | undefined
  private cancelInterval: (() => void) | undefined
  private uninstallLiveness: (() => void) | undefined
  private stopped = false
  private refreshTicks = 0
  /**
   * 缓存世代：每次清空/失效/卸载都 +1。
   *
   * 一次刷新可能在"请求已发出"之后才遇到 `invalidate()`/`dispose()`；如果它
   * 还去安装策略，就会把一次已撤销的授权重新装回来。因此安装前必须比对
   * **发起时**的世代，不一致就不安装、不恢复。
   */
  private generation = 0

  constructor(
    private readonly principals: PrincipalRegistry,
    private readonly cfg: ResolvedConfig,
    private readonly io: LeaseIo = defaultLeaseIo(),
    /**
     * 策略桥目标（`ctx.myrixPolicySnapshots`）。
     *
     * 未启用策略桥时为 undefined；启用时一定非空（装配阶段已检查）。
     */
    private readonly policy: PolicySinkPort | undefined = undefined,
  ) {}

  /**
   * 安装活性判定、启动周期刷新、踢出首次刷新。
   *
   * **同步完成**（首次刷新是 fire-and-forget 且已捕获），因此可以在
   * `apply()` 里直接调用而不会让插件加载变成异步。
   */
  start(): void {
    if (this.stopped) throw new Error('myrix-binding-lease: 运行时已停止，不能重新启动')
    // 先装判定：即便首次下载还没回来，语义也是"有租约判定但当前无有效租约"
    // （liveness-stale），而不是 liveness-unavailable。两者都拒绝，但前者
    // 的诊断信息更贴近事实。
    this.uninstallLiveness = this.principals.setLiveness((principal) => this.cache.lookup(principal, this.io.now()))
    this.cancelInterval = this.io.setInterval(() => {
      this.refreshTicks += 1
      // 周期刷新失败不是致命的：缓存已经被清空，判定会拒绝；下一轮再试。
      void this.refresh().catch(() => undefined)
    }, this.cfg.refreshMs)
    void this.refresh().catch(() => undefined)
  }

  /**
   * 立即刷新一次。**永不抛出**。
   *
   * 刷新失败的正确表现是"随后的一切身份使用被拒"，而不是让调用方
   * （driver setup 适配 / `agent/created` 监听器）因为一次网络抖动而失败 ——
   * 那会把一个租约问题放大成"会话打不开"。想区分的话读返回值的 `installed`。
   */
  refresh(): Promise<LeaseRefreshOutcome> {
    if (this.stopped) return Promise.resolve(this.fail('aborted', '租约运行时已停止', 0))
    if (this.current === undefined) return this.launch()
    if (this.queued !== undefined) return this.queued
    const queued = this.current.then(
      () => {
        if (this.queued === queued) this.queued = undefined
        return this.stopped ? this.fail('aborted', '租约运行时已停止', 0) : this.launch()
      },
      () => {
        if (this.queued === queued) this.queued = undefined
        return this.stopped ? this.fail('aborted', '租约运行时已停止', 0) : this.launch()
      },
    )
    this.queued = queued
    return queued
  }

  /** 清空缓存并中断在途下载；不卸载活性判定。 */
  invalidate(reason: string): void {
    this.generation += 1
    this.cache.clear(null, this.io.now())
    this.policy?.clear(`租约失效：${reason}`)
    // 在途响应可能看不到这次撤销，因此在它返回前就取消掉；随后一切身份使用被拒。
    for (const abort of this.inFlightAborts) {
      abort.abort(new Error(`myrix-binding-lease: invalidated (${reason})`))
    }
    this.inFlightAborts.clear()
  }

  state(): LeaseState {
    const state = this.cache.state(this.io.now())
    return {
      active: state.active,
      bindings: state.bindings,
      expiresAt: state.expiresAt,
      installedAt: state.installedAt,
      installs: state.installs,
      clears: state.clears,
      lastRejection: state.lastRejection,
    }
  }

  /** 周期刷新已执行的次数（诊断 / 测试断言用）。 */
  get ticks(): number {
    return this.refreshTicks
  }

  /**
   * 卸载：停 timer → abort 在途请求 → 等在途 promise 收敛 → 卸载活性判定。
   *
   * 顺序是刻意的：先停 timer 保证不会再有新请求，再 abort 保证已有的不会继续
   * 挂着，最后卸载判定 —— 卸载之后 `principals.hasLiveness()` 为 false，
   * `lookup` 回到 `liveness-unavailable`。
   */
  async dispose(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.generation += 1
    this.cancelInterval?.()
    this.cancelInterval = undefined
    const pending = [this.current, this.queued].filter(
      (entry): entry is Promise<LeaseRefreshOutcome> => entry !== undefined,
    )
    for (const abort of this.inFlightAborts) {
      abort.abort(new Error('myrix-binding-lease: runtime disposed'))
    }
    this.inFlightAborts.clear()
    if (pending.length > 0) {
      // 已捕获：abort 会让下载以失败收敛，这里只是等它彻底结束，不留悬空 promise。
      await Promise.allSettled(pending)
    }
    this.cache.clear(null, this.io.now())
    // 绑定与策略必须一起消失：卸载后残留的策略等于"没有活性判定的永久授权"。
    this.policy?.clear('租约运行时已卸载')
    this.uninstallLiveness?.()
    this.uninstallLiveness = undefined
  }

  // ---- 内部 ----

  /** 启动一次新的下载并登记为在途请求。 */
  private launch(): Promise<LeaseRefreshOutcome> {
    const startedAt = this.io.now()
    const generation = this.generation
    const abort = new AbortController()
    this.inFlightAborts.add(abort)
    const cancelTimeout = this.io.setTimer(() => {
      abort.abort(new Error('myrix-binding-lease: snapshot request timed out'))
    }, this.cfg.requestTimeoutMs)
    const pending = this.run(startedAt, generation, abort.signal).finally(() => {
      cancelTimeout()
      this.inFlightAborts.delete(abort)
      if (this.current === pending) this.current = undefined
    })
    this.current = pending
    return pending
  }

  private async run(startedAt: number, generation: number, signal: AbortSignal): Promise<LeaseRefreshOutcome> {
    const result = await fetchSnapshot({
      url: this.cfg.url,
      token: this.cfg.token,
      maxResponseBytes: this.cfg.maxResponseBytes,
      signal,
      fetch: this.io.fetch,
    })
    const elapsedMs = this.io.now() - startedAt

    if (!result.ok) return this.fail(result.failure.rejection, result.failure.detail, elapsedMs)
    const parsed = parseSnapshot(result.body, { cellId: this.cfg.cellId, tenantId: this.cfg.tenantId })
    if (!parsed.ok) return this.fail(parsed.failure.rejection, parsed.failure.detail, elapsedMs)
    if (this.stopped) {
      // 卸载竞态：解析完成时插件已经走了，不安装、不恢复活性、不恢复策略。
      return this.fail('aborted', '租约运行时已停止', elapsedMs)
    }
    if (generation !== this.generation) {
      // 请求发出后发生过 invalidate()/dispose()：这次响应可能看不到那次撤销，
      // 因此既不安装绑定，也不安装策略。
      return this.fail('aborted', '租约已在响应到达前失效', elapsedMs)
    }

    // 策略先行校验：启用策略桥时，"策略不可用"必须让整次刷新失败（installed:false），
    // 而不是只丢策略、留下一个看起来正常的绑定租约（那会让 driver 的
    // refreshIdentity() 误以为一切就绪，错误推迟到第一次工具调用才暴露）。
    let policyReport: PolicyInstallReport | undefined
    if (this.cfg.requirePolicy) {
      const policy = parsed.snapshot.policy
      if (policy === undefined) {
        return this.fail('policy-missing', '策略桥已启用但快照未下发策略', elapsedMs)
      }
      // 剩余时长取三者最小：服务端下发的策略 ttl、本次绑定租约剩余、30 秒硬上限；
      // 全部从**请求开始**算，因此下载慢会直接吃掉授权而不是把到期时刻往后推。
      const grantedMs = Math.min(policy.ttlMs, this.cfg.ttlMs, MAX_POLICY_TTL_MS)
      const remainingMs = Math.min(grantedMs - elapsedMs, this.livenessRemainingMs(startedAt))
      if (remainingMs <= 0) return this.fail('policy-stale', '策略剩余时长为 0', elapsedMs)
      const sink = this.policy
      if (sink === undefined) {
        // 装配阶段已经拒绝过缺失的服务；这里是纵深防御，同样 fail-closed。
        return this.fail('policy-unavailable', '未提供策略快照服务', elapsedMs)
      }
      // 只交出"内容 + 还剩多久"：到期时刻由持有者用自己的墙钟与单调时钟算出，
      // 避免把本插件的单调时基当成 Unix 毫秒传给另一个插件。
      const outcome = sink.installOrClear(
        { rev: policy.rev, tid: this.cfg.tenantId, tools: policy.tools },
        { remainingMs },
      )
      if (outcome.installed !== true) {
        return this.fail('policy-stale', outcome.reason ?? '策略安装被拒', elapsedMs)
      }
      policyReport = { installed: true, rev: policy.rev }
    }

    // 安装即"原子替换"：一次性换掉 Map 与到期时刻。
    this.cache.install(parsed.snapshot.rows, startedAt, this.cfg.ttlMs)
    return {
      installed: true,
      bindings: parsed.snapshot.rows.length,
      elapsedMs,
      expiresAt: startedAt + this.cfg.ttlMs,
      ...(policyReport === undefined ? {} : { policy: policyReport }),
    }
  }

  /** 绑定租约在本轮刷新下剩余的毫秒数；与策略剩余时长取先到者。 */
  private livenessRemainingMs(startedAt: number): number {
    return startedAt + this.cfg.ttlMs - this.io.now()
  }

  /**
   * 统一的失败路径：**同时**清空绑定缓存与策略，然后返回可读结果。
   *
   * 绑定与策略是一个整体：留下其中一个都会造成"活性为真但策略是上一版"或
   * "策略为真但活性查不到"的半授权状态。
   */
  private fail(rejection: SnapshotRejection, detail: string, elapsedMs: number): LeaseRefreshOutcome {
    const now = this.io.now()
    this.generation += 1
    this.cache.clear(rejection, now)
    this.policy?.clear(`租约刷新失败：${rejection}`)
    return {
      installed: false,
      bindings: 0,
      elapsedMs,
      expiresAt: null,
      rejection,
      detail: redact(detail, this.cfg.token),
    }
  }
}

/**
 * 安装插件（Cordis Loader 入口）。
 *
 * 启动即失败（fail-closed）：配置缺失/越界、origin 不是 HTTPS 且不是显式回环，
 * 都在这里抛错，让 profile 加载失败而不是"带着空缺的租约运行"。
 */
export function apply(ctx: Context, config: Config): void {
  // Validate immediately, but let Cordis order the policy producer/consumer.
  // Profile row order is not an activation dependency. This child is also
  // disposed (clearing liveness) whenever the required policy service vanishes.
  const cfg = resolveConfig(config)
  if (cfg.requirePolicy) {
    ctx.inject([POLICY_SNAPSHOT_SERVICE], dependent => {
      applyWithIo(dependent, config, defaultLeaseIo())
    })
    return
  }
  applyWithIo(ctx, config, defaultLeaseIo())
}

/**
 * 与 {@link apply} 相同的装配，但允许注入时钟 / fetch / 定时器。
 *
 * 存在的唯一理由是让**真实 Cordis 组合测试**可以确定性驱动租约（TTL 推进、
 * 请求不返回、卸载时 abort），而不必真的去连作品服务。它不改变任何安全语义：
 * 生产路径永远是 {@link apply} + {@link defaultLeaseIo}。
 */
export function applyWithIo(ctx: Context, config: Config, io: LeaseIo): void {
  const cfg = resolveConfig(config)
  const principals = ctx.principals as PrincipalRegistry
  // 策略桥目标：用 `ctx.get` 而不是模块增强，因为服务名是结构契约而不是编译期
  // 依赖（两个插件各自演进，也可能各自被打进不同 bundle）。
  const sink = ctx.get(POLICY_SNAPSHOT_SERVICE) as unknown as PolicySinkPort | undefined
  if (cfg.requirePolicy && sink === undefined) {
    // 启动即失败：启用策略桥却没有策略执行点，等于"装配了一半的授权"。
    throw new Error('myrix-binding-lease: requirePolicy 已启用但缺少 myrixPolicySnapshots 服务（策略执行点未挂载）')
  }
  const runtime = new BindingLeaseRuntime(principals, cfg, io, cfg.requirePolicy ? sink : undefined)

  // 服务面：Lead 在 driver 的 setup 适配里
  // `await ctx.bindingLease.refresh()`，用一次真实下载消除创建竞态。
  ctx.provide(BINDING_LEASE_SERVICE, runtime)

  ctx.effect(
    () => {
      runtime.start()
      return () => runtime.dispose()
    },
    'myrix-binding-lease: liveness lease',
  )

  if (cfg.refreshOnAgentCreated) {
    // **真正被 await 的 hook**：`agent/created` 是 serial 事件
    // （vendor packages/core/agent/src/runtime-types.ts:261），由
    // AgentRegistry.announce() 用 `await this.ctx.serial(...)` 派发
    // （packages/core/agent/src/index.ts:550），announce() 又在
    // PreparedAgent.publish() 内部被 await
    // （packages/core/agent-loop/src/index.ts:624）；publish() 位于
    // `ctx.agents.create()/resume()` resolve **之前**：setupAndPublish 在 :776
    // 先跑 setup commit，:778 才 publish。因此这里 `await refresh()` 会在
    // "新建 Agent 已注册但调用方还没拿到 handle"的窗口内完成一次真实下载。
    //
    // 竞态残留（诚实记录）：driver 在 `setup` 回调**内部**就
    // `principals.bind(...)`，而 setup 在 `agent/created` **之前**执行
    // （:775）。若绑定后立刻有同步工具调用（本插件与 driver 的代码里没有这种
    // 路径），仍会看到清空后的缓存并被拒。默认拒绝是正确方向。
    ctx.on('agent/created', async () => {
      await runtime.refresh()
    })
  }

  ctx.logger?.info('myrix-binding-lease 已挂载', {
    cellId: cfg.cellId,
    tenantId: cfg.tenantId,
    // 只报 origin：token 与完整 URL 都不进日志。
    origin: cfg.origin,
    ttlMs: cfg.ttlMs,
    refreshMs: cfg.refreshMs,
    requestTimeoutMs: cfg.requestTimeoutMs,
    refreshOnAgentCreated: cfg.refreshOnAgentCreated,
    requirePolicy: cfg.requirePolicy,
  })
}
