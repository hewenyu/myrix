/**
 * `@myrix/binding-lease` 的公开契约。
 *
 * 本插件是**同步活性判定**（`ctx.principals.setLiveness`）在 Cell 侧的唯一生产者：
 * 它把作品服务 `GET /internal/v1/cells/:cellId/bindings` 返回的授权快照，
 * 变成一份**有限时长、失败即清空**的进程内租约。
 *
 * 三条不可协商的边界（AGENTS.md 硬性规则 1 + ADR-0019）：
 *
 * 1. 快照里的 `{sid,tid,sub,wid,preset,rev}` 是六个字段的**完整等值比较**依据；
 *    少比任何一个字段都等于把一个身份当成另一个身份放行。
 * 2. 没有有效租约 = 拒绝。未启动、下载失败、请求超时、响应非法、
 *    租约过期、scope 卸载，全部都只能让 `principals.require*` 抛
 *    `liveness-unavailable` / `liveness-stale`，不存在"上次还好所以放行"。
 * 3. 本模块**不生成任何本地身份**、不持久化 token、不缓存业务正文。
 *    Cell 服务 token 只在 Config 里出现一次，之后仅作为请求头发送。
 *
 * @module @myrix/binding-lease/types
 */

import type { Principal } from '@myrix/principals'

export type { Principal }

/**
 * 作品服务返回的单行绑定（线协议字段名 `sid/tid/sub/wid/preset/rev`）。
 *
 * 与 `Principal` 结构一致是刻意的：`Principal` 就是由凭证 claim 派生、
 * 用于运行时认人的同一组字段，租约比较必须逐字段对齐，不能各自漂移。
 */
export interface BindingRow {
  /** 会话 id（= Agent id）。 */
  readonly sid: string
  /** 租户 id。 */
  readonly tid: string
  /** 所有者用户 id。 */
  readonly sub: string
  /** 作品 id。 */
  readonly wid: string
  /** preset id。 */
  readonly preset: string
  /** 撤权版本（非负整数）。 */
  readonly rev: number
}

/**
 * 服务端随**同一份**绑定快照下发的策略（可选字段）。
 *
 * 为什么放在绑定快照里而不是另开一个端点：策略的权威性来自同一张数据库表上的
 * 同一次租户作用域查询与同一个 Cell 凭据，多一个端点只会多一个"策略与绑定
 * 不同步"的窗口。老服务端不返回该字段，老客户端忽略它（向后兼容）。
 *
 * `rev` 是**部署控制的策略版本**，不是绑定的撤权版本：一次绑定撤权不应被
 * 当成一次策略发布，反之亦然。
 */
export interface BindingPolicy {
  /** 策略版本；同版本重装允许，回退一律拒绝（含清空之后）。 */
  readonly rev: number
  /** 本 Cell 允许的工具名；由服务端与六个小说工具名取交集后下发。 */
  readonly tools: readonly string[]
  /** 服务端授予的有效时长（毫秒）；客户端再裁到租约剩余与 30 秒硬上限。 */
  readonly ttlMs: number
}

/** `GET /internal/v1/cells/:cellId/bindings` 的成功响应体（不含业务正文）。 */
export interface BindingSnapshot {
  /** 路径与凭据里的 cell id；必须与本 cell 的配置一致。 */
  readonly cellId: string
  /** 凭据解析出的租户 id；必须与本 cell 的配置一致。 */
  readonly tenantId: string
  readonly bindings: readonly BindingRow[]
  /**
   * 可选策略；缺省表示服务端没有下发策略（此时绑定租约照常生效，
   * 但策略执行点仍会因为"没有策略快照"而拒绝一切工具调用）。
   */
  readonly policy?: BindingPolicy
}

/** 快照被拒绝的原因；全部进入可读日志与诊断，不含 token 与正文。 */
export type SnapshotRejection =
  | 'http-status'
  | 'redirect'
  | 'too-large'
  | 'malformed-json'
  | 'wrong-cell'
  | 'wrong-tenant'
  | 'duplicate-sid'
  | 'malformed-row'
  | 'malformed-policy'
  | 'policy-missing'
  | 'policy-unavailable'
  | 'policy-stale'
  | 'aborted'
  | 'network'

/** 一次刷新里策略安装的结果（诊断用；不含工具清单以外的内容）。 */
export interface PolicyInstallReport {
  /** 策略是否随本次刷新一起安装成功。 */
  readonly installed: boolean
  /** 安装成功时的策略版本；否则 null。 */
  readonly rev: number | null
}

/** 一次租约安装尝试的结果；`installed: true` 才表示缓存被替换。 */
export interface LeaseRefreshOutcome {
  /** 是否成功安装新租约。false 时缓存已被显式清空。 */
  readonly installed: boolean
  /** 快照里的绑定行数；失败时为 0。 */
  readonly bindings: number
  /** 开始请求到解析完成的耗时（单调时钟毫秒）。 */
  readonly elapsedMs: number
  /** 租约到期时刻（单调时钟毫秒）；失败时为 null。 */
  readonly expiresAt: number | null
  /** 失败原因；成功时为 undefined。 */
  readonly rejection?: SnapshotRejection
  /** 可读细节；不含响应正文、token、作品内容。成功时为 undefined。 */
  readonly detail?: string
  /**
   * 策略安装结果。
   *
   * - 启用策略桥（`requirePolicy`）时，`installed:true` 必然伴随
   *   `policy.installed === true`；否则整个刷新是 `installed:false`。
   * - 未启用策略桥时该字段为 undefined（老消费者直接忽略）。
   */
  readonly policy?: PolicyInstallReport
}

/** 当前生效的租约（诊断用；不暴露任何主体列表）。 */
export interface LeaseState {
  /** 是否存在**此刻仍有效**的租约。 */
  readonly active: boolean
  /** 快照内的绑定行数；无快照时为 0。 */
  readonly bindings: number
  /** 单调时钟下的到期时刻；无快照时为 null。 */
  readonly expiresAt: number | null
  /** 单调时钟下的安装时刻；无快照时为 null。 */
  readonly installedAt: number | null
  /** 成功安装次数。 */
  readonly installs: number
  /** 因任何原因清空缓存的次数。 */
  readonly clears: number
  /** 最近一次拒绝原因（不清空日志语义，只是诊断）。 */
  readonly lastRejection: SnapshotRejection | null
}

/**
 * `@myrix/binding-lease` 暴露给 Lead 的服务面。
 *
 * 这是**装配适配点**：`myrix-runtime-driver` 的 `create/resume` 路径不在本插件
 * 可写的文件范围内，因此新绑定写入数据库后、周期快照尚未包含它时，
 * Lead 在 driver 的 setup 适配里 `await ctx.bindingLease.refresh()` 一次，
 * 用一次真实下载消除创建竞态 —— 而不是放宽准入。
 */
export interface BindingLease {
  /**
   * 立即拉取一次快照并原子替换缓存。
   *
   * - 并发调用合并到同一个在途请求（不会因为 N 个新会话放大成 N 次下载）。
   * - 成功 → 返回 `installed: true`，租约有效期从**本次请求开始**的单调时刻算起。
   * - 任何失败（HTTP 非 200、重定向、响应过大、非法 JSON/字段、跨 cell/租户、
   *   重复 sid、超时、abort）→ **清空缓存**并返回 `installed: false`。
   * - 从不抛出：调用方（setup 适配）不该因为"刷新失败"而 panic；拒绝由随后的
   *   `principals.lookup` 完成，语义与"未安装活性"完全一致。
   */
  refresh(): Promise<LeaseRefreshOutcome>
  /** 清空缓存并拒绝后续一切身份使用（撤权、drain、失联时调用）。 */
  invalidate(reason: string): void
  /** 诊断状态；不含任何主体字段。 */
  state(): LeaseState
}
