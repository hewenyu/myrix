/**
 * 服务端 cell 凭据 → 权威主体解析。
 *
 * 硬性要求（platform-plan-v2 D4 / tech-design-v1 §3.1）：
 * * 客户端**不能**自报 tenantId/userId/sessionId 的归属；网关只信两样东西：
 *   1. `Authorization: Bearer <cell 服务令牌>` 解析出的 (tenantId, cellId)（凭据绑定）；
 *   2. 数据库里该 sessionId 的**当前**绑定行（所有者、cellId、撤权版本 rev、状态）。
 * * `Authorization` 里的 tenant 归因头（x-myrix-tenant 等）一律忽略；如果请求头里的
 *   sessionId 与路径/凭据不一致，直接拒绝。
 *
 * 判定复用 `@myrix/governance` 的纯函数 `authorizePlatform`，动作是
 * `sessions:send`（读会话、必须 owner + 未撤销 + rev 匹配）与 `models:invoke`。
 */
import type { PlatformMember, PlatformResource } from "@myrix/governance";

export interface CellCredentialBinding {
  tenantId: string;
  cellId: string;
}

export interface SessionBindingSnapshot {
  sessionId: string;
  tenantId: string;
  ownerUserId: string;
  cellId: string | null;
  status: string;
  /** 撤权版本（rev） */
  revision: number;
}

/**
 * 业务存储端口。由业务 store 实现（另一个子任务在代理开发）；
 * `createAuthorizer` 提供默认装配，Lead 接入时只需注入 DB 连接。
 */
export interface AuthorizerPort {
  /** 服务端凭据 → 绑定租户/cell。找不到即拒绝（fail-closed）。 */
  resolveCredential(token: string): Promise<CellCredentialBinding | undefined>;
  /**
   * 会话绑定当前快照；找不到即拒绝。tenantId 来自凭据绑定（不是请求头），
   * 实现方必须用它设置 RLS 上下文，只在该租户范围内查询。
   */
  loadSessionBinding(tenantId: string, sessionId: string): Promise<SessionBindingSnapshot | undefined>;
  /** 当前成员记录；停用/不存在返回 undefined。 */
  loadMember(tenantId: string, userId: string): Promise<PlatformMember | undefined>;
}

export interface AuthorizeInput {
  /** 服务端凭据里的原始 token（用于查绑定，不落库、不写日志） */
  token: string;
  /** 客户端声称的 sessionId；必须与绑定行一致 */
  sessionId: string;
  /** 客户端随请求带来的 rev；必须等于数据库当前 rev */
  claimedRevision?: number;
}

export interface AuthorizedRequest {
  tenantId: string;
  cellId: string;
  userId: string;
  sessionId: string;
  /** 数据库当前的撤权版本 */
  revision: number;
  /** 可读判定原因，写入审计/日志（不含正文与密钥） */
  reason: string;
}

export type AuthorizationOutcome =
  | { effect: "allow"; principal: AuthorizedRequest }
  | { effect: "deny"; statusCode: number; code: string; reason: string };

export const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface Authorizer {
  authorize(input: AuthorizeInput): Promise<AuthorizationOutcome>;
  /** 流式响应期间轮询：返回 false 表示权限已失效，必须中止上游请求 */
  isStillAuthorized(principal: AuthorizedRequest): Promise<boolean>;
}
