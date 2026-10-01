/**
 * `myrix-policy-enforcer` 的公开类型：策略快照、配置、判定结果。
 *
 * 本插件只做"取判定结果 → 翻译成 DSH 拒绝"（AGENTS.md 对 `plugins/*` 的定位），
 * **不保存策略**：策略快照由控制面下发、由外部持有者安装，这里只是读取与校验。
 *
 * @module @myrix/policy-enforcer/types
 */

/** 控制面下发的策略快照（只含本 cell 需要的最小信息）。 */
export interface PolicySnapshot {
  /** 策略版本；单调递增，仅用于诊断与审计。 */
  readonly rev: number
  /** 本快照所属租户；必须与主体 `tid` 一致，否则拒绝。 */
  readonly tid: string
  /** 快照失效时刻（Unix 毫秒）。到点即视为缺失。 */
  readonly expiresAt: number
  /** 快照允许的工具名（下一步还要与静态 allowlist 取交集）。 */
  readonly tools: readonly string[]
}

/**
 * 生产者交给持有者的策略**授权内容**（不含到期时刻）。
 *
 * 到期时刻由持有者用自己的两个时钟（墙钟 + 单调）从 `remainingMs` 算出来：
 * 生产者只被允许回答"还剩多久"，不允许回答"到期是什么时刻"。这样就不存在
 * "两个进程/两个时基各自算一个绝对时刻、取到较小的那个却被当成已过期"的错配
 * （单调时基的绝对值与 Unix 毫秒根本不在同一个数轴上）。
 */
export interface PolicyGrant {
  /** 策略版本；同版本重装允许，回退一律拒绝（含清空之后）。 */
  readonly rev: number
  /** 本快照所属租户；必须与主体 `tid` 一致，否则拒绝。 */
  readonly tid: string
  /** 快照允许的工具名（下一步还要与静态 allowlist 取交集）。 */
  readonly tools: readonly string[]
}

/** 快照来源：由外部生产者安装、本插件同步读取的持有者。 */
export interface PolicySnapshotSource {
  /** 同步读取当前快照；没有有效快照时返回 undefined。 */
  current(): PolicySnapshot | undefined
}

/**
 * 一份策略快照被授权给进程的**时限上界**。
 *
 * 快照本身带 `expiresAt`（墙钟），但墙钟可以被回拨；`remainingMs` 让持有者
 * 再用单调时基压一层。单调时刻只增不减，因此系统时间回拨不会把授权延长 ——
 * 这是"有限时长"承诺在墙钟之外的第二道实现点。
 */
export interface PolicySnapshotBounds {
  /**
   * 本次授权在**生产者单调时基**下剩余的毫秒数。
   *
   * 生产者必须已经把它裁到"服务端 `ttlMs`、本地租约剩余、硬上限 30s"的最小值，
   * 再减去请求已经花掉的时间。
   */
  readonly remainingMs: number
}

/**
 * 策略快照的生产者接口（Cordis 服务 `myrixPolicySnapshots` 的结构面）。
 *
 * 唯一的生产者是 `@myrix/binding-lease`：它把**同一份**凭证认证绑定快照里的
 * 策略字段安装进来，并在任何刷新失败/失效/卸载时清空。本插件不拉取策略。
 */
export interface PolicySnapshotSink {
  /**
   * 安装或（任何拒绝时）清空。**永不抛出**；调用方只需看返回值。
   *
   * @param grant - 已校验的同租户策略内容（版本、租户、工具集合）。
   * @param bounds - 本次授权的剩余时长上界。
   * @returns `installed` 表示策略此刻生效；false 时快照已被清空、一切工具调用被拒。
   */
  installOrClear(grant: PolicyGrant, bounds: PolicySnapshotBounds): PolicyInstallOutcome
  /** 清空当前策略；之后一切工具调用被拒。 */
  clear(reason?: string): void
}

/** `installOrClear` 的结果；失败原因可安全外发（不含凭证与正文）。 */
export type PolicyInstallOutcome =
  | { readonly installed: true; readonly rev: number; readonly expiresAt: number }
  | { readonly installed: false; readonly reason: string }

/** 一次工具准入的判定结果。 */
export type ToolAdmission =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string }

/** 判定输入：把一切外部状态显式传进来，保证纯函数可穷举测试。 */
export interface AdmissionInput {
  /** `ctx.principals.lookup()` 的结果（含失败原因）。 */
  readonly principal:
    | { readonly ok: true; readonly principal: { readonly sid: string; readonly tid: string; readonly sub: string; readonly rev: number } }
    | { readonly ok: false; readonly reason: string; readonly detail: string }
  /** 工具名。 */
  readonly toolName: string
  /** 静态 allowlist（配置提供，必须显式）。 */
  readonly allowedTools: readonly string[]
  /** 当前策略快照；`undefined` 表示"此刻没有快照"。 */
  readonly snapshot: PolicySnapshot | undefined
  /** 当前时刻（Unix 毫秒）。 */
  readonly now: number
}
