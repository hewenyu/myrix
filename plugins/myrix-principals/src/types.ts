/**
 * Myrix Cell 侧身份注册表的公开类型。
 *
 * 这里是"一个 Agent 代表谁"的唯一进程内表示。权威记录始终在控制面数据库；
 * 本服务只保存**本次进程内**由授权凭证派生出来的绑定，因此它不构成第二个权威源。
 *
 * @module @myrix/principals/types
 */

/**
 * 一个已绑定 Agent 的授权主体。
 *
 * 字段与 `@myrix/grant` 的 claim 一一对应（`sid`/`tid`/`sub`/`wid`/`preset`/`rev`），
 * 这样"凭证说了什么"与"运行时认得什么"不会各自漂移。这里**不含**凭证本身、
 * 不含任何密钥或正文，可以安全地进日志。
 */
export interface Principal {
  /** 会话 id（= Agent id）。 */
  readonly sid: string;
  /** 租户 id；一个进程只服务一个租户，但仍逐条记录以便审计与断言。 */
  readonly tid: string;
  /** 所有者用户 id（唯一所有者，见 platform-plan-v2 D11）。 */
  readonly sub: string;
  /** 作品 id；业务工具只访问该作品。 */
  readonly wid: string;
  /** 绑定时凭证声明的 preset id。 */
  readonly preset: string;
  /** 策略/撤权版本（非负整数）；越大越新。 */
  readonly rev: number;
}

/**
 * 活性判定的外部提供者（bindings / currentMember 的当前状态）。
 *
 * 契约：返回 `true` 表示"此刻该主体仍然有效"，其余一切情况（`false`、
 * `undefined`、抛错）都按"失效"处理。判定必须是**同步**的：guard 在工具
 * 执行前同步调用它，不允许在这里做 I/O。
 */
export type PrincipalLiveness = (principal: Principal) => boolean;

/** 会话级的撤权高水位；用于拒绝乱序/重放的旧撤权通知。 */
export interface RevocationState {
  /** 已接受的最大撤权版本。 */
  readonly rev: number;
  /** 断言该会话已被撤权（一旦为 true 就不会回到 false）。 */
  readonly revoked: true;
  /** 可读原因，直接用于审计与拒绝信息。 */
  readonly reason: string;
}

/** `revoke` 的结果；`accepted: false` 表示通知比已知高水位更旧，被忽略。 */
export interface RevokeOutcome {
  readonly accepted: boolean;
  /** 被忽略的原因（已接受时为 `"accepted"`）。 */
  readonly reason: string;
  /** 处理后的高水位。 */
  readonly highWaterRev: number;
}

/** 主体查找失败的原因，供 driver/审计生成可读且不含敏感的拒绝信息。 */
export type PrincipalLookupDenial =
  | 'no-agent'
  | 'unbound'
  | 'revoked'
  | 'liveness-unavailable'
  | 'liveness-stale'
  | 'liveness-error';

/** 一次带原因的查找结果（fail-closed 路径要能说清"为什么拒"）。 */
export type PrincipalLookup =
  | { readonly ok: true; readonly principal: Principal }
  | { readonly ok: false; readonly reason: PrincipalLookupDenial; readonly detail: string };
