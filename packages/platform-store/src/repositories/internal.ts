import { errors } from "../errors";
import type { PlatformStore, StoreTx } from "../store";
import type { PlatformAction, PlatformActor, PlatformRequest, PlatformResourceRef } from "../authz";
import type { MemberRole, MemberStatus } from "../domain";

/**
 * 仓储共享的内部工具：
 *   * `loadTenantStatus` / `requireActiveTenant`：租户必须存在且 active；
 *   * `loadMembership` / `requireActiveMembership`：成员必须存在且 active；
 *   * `authorizeTx`：把"租户 + 成员 + 资源"的事实显式映射进 `PlatformRequest` 后交给 Authorizer。
 *
 * 这里**没有**任何 allow 逻辑：只做"读事实 + 交给 Authorizer + 把拒绝翻译成异常"。
 *
 * fail-closed 的两道闸门：
 *   1. 仓储层先在库内确认"租户 active 且成员 active/disabled 状态被读出"，
 *      不把"租户是否可用"的判断权交给 authorizer（governance 只看成员，看不到租户状态）；
 *   2. 再问 authorizer；默认实现是全拒，生产必须绑定 governance。
 */

export interface MembershipRow {
  status: MemberStatus;
  role: MemberRole;
}

export async function loadTenantStatus(tx: StoreTx, tenantId = tx.tenantId): Promise<string | null> {
  const row = await tx.trx
    .selectFrom("tenants")
    .select(["status"])
    .where("id", "=", tenantId)
    .executeTakeFirst();
  return row?.status ?? null;
}

/**
 * 租户必须是 active；suspended / deleted / 不存在一律拒绝。
 * 租户停用后即使成员行仍是 active，也不允许任何业务读写。
 */
export async function requireActiveTenant(tx: StoreTx): Promise<void> {
  const status = await loadTenantStatus(tx);
  if (status === null) {
    throw errors.forbidden(`tenant-not-found: 租户 ${tx.tenantId} 不存在或不在当前上下文`);
  }
  if (status !== "active") {
    throw errors.forbidden(
      `tenant-not-active: 租户 ${tx.tenantId} 状态为 ${status}，只有 active 租户可执行操作`,
    );
  }
}

export async function loadMembership(tx: StoreTx, userId: string): Promise<MembershipRow | null> {
  if (!userId) return null;
  const row = await tx.trx
    .selectFrom("members")
    .select(["status", "role"])
    .where("user_id", "=", userId)
    .executeTakeFirst();
  return row ? { status: row.status, role: row.role } : null;
}

export async function requireActiveMembership(tx: StoreTx, userId: string): Promise<MembershipRow> {
  const membership = await loadMembership(tx, userId);
  if (!membership) {
    throw errors.forbidden("not-member: 调用者不是该租户成员", { actorUserId: userId });
  }
  if (membership.status !== "active") {
    throw errors.forbidden("member-disabled: 成员已被停用，拒绝全部请求", { actorUserId: userId });
  }
  return membership;
}

export interface AuthorizeInput {
  actorUserId: string | undefined;
  action: PlatformAction;
  resource: PlatformResourceRef;
  /** 调用方持有的版本（已有会话的 read/send/resume/revoke 必填） */
  expectedRevision?: number;
  /** 已知的成员状态（避免同事务重复查询）；未提供则从库读 */
  membership?: MembershipRow | null;
  /** 已知租户状态；未提供则从库读 */
  tenantStatus?: string | null;
}

/**
 * 判定入口。拒绝时抛 forbidden，reason 来自 authorizer（governance 的中文结论）。
 * membership 为 null 也照样传给 Authorizer —— 由 governance 决定"非成员"如何拒绝。
 */
export async function authorizeTx(
  store: PlatformStore,
  tx: StoreTx,
  input: AuthorizeInput,
): Promise<void> {
  const tenantStatus = input.tenantStatus !== undefined ? input.tenantStatus : await loadTenantStatus(tx);
  if (tenantStatus !== "active") {
    throw errors.forbidden(
      tenantStatus === null
        ? `tenant-not-found: 租户 ${tx.tenantId} 不存在或不在当前上下文`
        : `tenant-not-active: 租户 ${tx.tenantId} 状态为 ${tenantStatus}，只有 active 租户可执行操作`,
    );
  }

  const membership =
    input.membership !== undefined
      ? input.membership
      : input.actorUserId
        ? await loadMembership(tx, input.actorUserId)
        : null;

  const actor: PlatformActor = {
    userId: input.actorUserId ?? "",
    tenantId: tx.tenantId,
    membership: membership ? { status: membership.status, role: membership.role } : null,
  };

  const request: PlatformRequest = {
    actor,
    action: input.action,
    resource: input.resource,
    ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
  };

  store.authorize(request);
}

/** 所有仓储共用的"当前事务时间"：统一取注入时钟（可测试、可复放） */
export function occurredAt(store: PlatformStore): string {
  return store.now().toISOString();
}
