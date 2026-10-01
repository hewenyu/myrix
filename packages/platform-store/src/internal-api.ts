/**
 * 可信内部 API（与 `PlatformStore` 同进程的装配代码使用，例如 works-service 的用例层）。
 *
 * 这些函数**必须**在已经建立租户事务的上下文里调用（`store.withTenant`），
 * 或者自己在事务内先完成判定。它们不做能力检查，因为它们不是对外入口。
 *
 * 不要从 HTTP 路由处理器直接导入本模块；路由只能调用仓储类的公开方法。
 */

export { insertAuditEvent, insertDenyEvent, sanitizeDetail } from "./repositories/audit";
export { insertOutboxMessage } from "./repositories/outbox";
export { assertWorkOwned, loadOwnedWork } from "./repositories/ownership";
export { revokeActiveBindingsOfOwner } from "./repositories/bindings";
export {
  authorizeTx,
  loadMembership,
  loadTenantStatus,
  requireActiveMembership,
  requireActiveTenant,
  occurredAt,
} from "./repositories/internal";
export type { AuthorizeInput, MembershipRow } from "./repositories/internal";
export { enqueueCommandInTx, claimSessionCommand, claimAnyCommands, settleCommand, releaseCommand, getCommand, listCommands, requeueDeadCommand } from "./repositories/commands";
