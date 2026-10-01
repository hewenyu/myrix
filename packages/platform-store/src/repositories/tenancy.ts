import { errors } from "../errors";
import { randomId } from "../util";
import type { PlatformStore, StoreTx } from "../store";
import { isMemberRole, type MemberRole, type MemberStatus } from "../domain";
import { authorizeTx, loadMembership, loadTenantStatus, requireActiveMembership } from "./internal";
import { insertAuditEvent } from "./audit";
import { revokeActiveBindingsOfOwner } from "./bindings";

/**
 * 租户与成员。
 *
 * 判定路径刻意分成两类，绝不混用：
 *
 * 1. **成员请求**（`members:list`）：走 governance 的 `authorizePlatform`，
 *    同租户 active 成员可以看成员目录（目录里只有身份信息，没有他人作品/会话内容）。
 *
 * 2. **系统操作**（`tenant.read` / `tenant.manage`）：读租户本身、建租户、加/停用成员，
 *    是部署期装配与登录态解析路径，需要显式 `ServiceCapability`，浏览器不可调用。
 *    这些操作**没有**对应的 governance 动作，因此绝不能被映射成成员 allow。
 *
 * 所有方法的 tenantId 都是显式入参：它由服务端会话 / 令牌决定，
 * 绝不允许从请求体或"最后设置的 set_config"推断。
 */

export interface TenantRecord {
  id: string;
  slug: string;
  name: string;
  residency: string | null;
  status: "active" | "suspended" | "deleted";
  createdAt: string;
  updatedAt: string;
}

export interface MemberRecord {
  tenantId: string;
  userId: string;
  role: MemberRole;
  status: MemberStatus;
  displayName: string | null;
  email: string | null;
  createdAt: string;
  updatedAt: string;
  disabledAt: string | null;
}

export interface AddMemberInput {
  userId: string;
  role: MemberRole;
  displayName?: string;
  email?: string;
}

export class TenancyRepository {
  constructor(private readonly store: PlatformStore) {}

  /**
   * 读租户（登录态装配用）。系统操作：需要 tenant.read 能力。
   * 只返回当前租户上下文里的那一行（RLS 也保证跨租户读不到）。
   */
  async getTenant(tenantId: string, actorUserId: string | undefined): Promise<TenantRecord> {
    this.store.requireService("tenant.read", "tenancy.getTenant");
    return this.store.withTenant({ tenantId, ...(actorUserId ? { actorUserId } : {}) }, async (tx) => {
      const row = await tx.trx
        .selectFrom("tenants")
        .selectAll()
        .where("id", "=", tenantId)
        .executeTakeFirst();
      if (!row) throw errors.notFound("tenant-not-found: 租户不存在或不在当前上下文");
      return toTenantRecord(row);
    });
  }

  /**
   * 成员目录。成员请求：走 governance（`members:list`）。
   * 返回的是同租户成员的身份与角色，用于展示"谁在这个租户里"；
   * 不包含任何作品、章节、设定或会话内容。
   */
  async listMembers(tenantId: string, actorUserId: string): Promise<MemberRecord[]> {
    return this.store.withTenant({ tenantId, actorUserId }, async (tx) => {
      await authorizeTx(this.store, tx, {
        actorUserId,
        action: "members:list",
        resource: { kind: "member", tenantId },
      });
      const rows = await tx.trx.selectFrom("members").selectAll().orderBy("created_at", "asc").execute();
      return rows.map(toMemberRecord);
    });
  }

  /** 单个成员（用于 `members:update` 前的目标读取，也走成员目录判定） */
  async getMember(tenantId: string, actorUserId: string, targetUserId: string): Promise<MemberRecord> {
    return this.store.withTenant({ tenantId, actorUserId }, async (tx) => {
      await authorizeTx(this.store, tx, {
        actorUserId,
        action: "members:list",
        resource: { kind: "member", tenantId, ownerUserId: targetUserId },
      });
      const row = await tx.trx
        .selectFrom("members")
        .selectAll()
        .where("user_id", "=", targetUserId)
        .executeTakeFirst();
      if (!row) throw errors.notFound("member-not-found: 成员不存在");
      return toMemberRecord(row);
    });
  }

  /**
   * 新增成员。系统操作（tenant.manage）：部署期装配 / 运维补员。
   * 运行期由成员自己调用的"邀请同事"能力**不存在**，所以没有对应的成员动作。
   */
  async addMember(tenantId: string, actorUserId: string | undefined, input: AddMemberInput): Promise<MemberRecord> {
    validateMemberInput(input);
    this.store.requireService("tenant.manage", "tenancy.addMember");
    return this.store.withTenant({ tenantId, ...(actorUserId ? { actorUserId } : {}) }, async (tx) => {
      const existing = await tx.trx
        .selectFrom("members")
        .select(["user_id", "status"])
        .where("user_id", "=", input.userId)
        .executeTakeFirst();
      if (existing) {
        throw errors.conflict(`member-exists: 成员 ${input.userId} 已存在（status=${existing.status}）`);
      }
      const row = await tx.trx
        .insertInto("members")
        .values({
          tenant_id: tenantId,
          user_id: input.userId,
          role: input.role,
          status: "active",
          display_name: input.displayName ?? null,
          email: input.email ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await insertAuditEvent(tx, {
        actorUserId: actorUserId ?? input.userId,
        actorKind: "service",
        category: "admin-change",
        action: "tenant.add-member",
        resource: `member:${input.userId}`,
        effect: "allow",
        reason: `新增成员 role=${input.role}（系统操作 tenant.manage）`,
      });
      return toMemberRecord(row);
    });
  }

  /**
   * 修改角色。系统操作（tenant.manage）。不允许把最后一个 active admin 降级。
   * 注意：运行期的"停用成员"属于成员治理动作 `members:update`（见 stopMember），
   * 这里只处理部署期/运维的角色调整。
   */
  async setMemberRole(
    tenantId: string,
    actorUserId: string | undefined,
    targetUserId: string,
    role: MemberRole,
  ): Promise<MemberRecord> {
    if (!isMemberRole(role)) {
      throw errors.invalidInput(`role 必须是 admin / member / auditor 之一，收到 ${String(role)}`);
    }
    this.store.requireService("tenant.manage", "tenancy.setMemberRole");
    return this.store.withTenant({ tenantId, ...(actorUserId ? { actorUserId } : {}) }, async (tx) => {
      const target = await tx.trx
        .selectFrom("members")
        .selectAll()
        .where("user_id", "=", targetUserId)
        .executeTakeFirst();
      if (!target) throw errors.notFound("member-not-found: 成员不存在");

      if (target.role === "admin" && role !== "admin" && target.status === "active") {
        const otherAdmins = await countActiveAdmins(tx, targetUserId);
        if (otherAdmins === 0) {
          throw errors.conflict("last-admin: 不能降级最后一名 active admin，租户将失去管理入口");
        }
      }

      const row = await tx.trx
        .updateTable("members")
        .set({ role })
        .where("user_id", "=", targetUserId)
        .returningAll()
        .executeTakeFirstOrThrow();

      await insertAuditEvent(tx, {
        actorUserId: actorUserId ?? targetUserId,
        actorKind: "service",
        category: "admin-change",
        action: "tenant.set-role",
        resource: `member:${targetUserId}`,
        effect: "allow",
        reason: `成员角色变更：${target.role} → ${role}（系统操作 tenant.manage）`,
      });
      return toMemberRecord(row);
    });
  }

  /**
   * 停用成员（成员治理，admin 的 `members:update`）。同一事务内：
   *   1. 读目标成员当前 role/status（供 governance 判定"目标是否可停用"）；
   *   2. governance 判定 `members:update`（admin 才能通过，且不能停用自己/其他 admin）；
   *   3. 撤销该成员名下所有 creating/active 绑定并写 outbox；
   *   4. status=disabled + disabled_at；
   *   5. 写审计。
   *
   * 四步必须原子，否则会出现"成员已停用但会话还能用"的窗口。
   */
  async disableMember(
    tenantId: string,
    actorUserId: string,
    targetUserId: string,
  ): Promise<{ member: MemberRecord; revokedBindings: number }> {
    return this.store.withTenant({ tenantId, actorUserId }, async (tx) => {
      const target = await tx.trx
        .selectFrom("members")
        .select(["role", "status"])
        .where("user_id", "=", targetUserId)
        .executeTakeFirst();
      if (!target) throw errors.notFound("member-not-found: 成员不存在");

      await authorizeTx(this.store, tx, {
        actorUserId,
        action: "members:update",
        resource: {
          kind: "member",
          tenantId,
          ownerUserId: targetUserId,
          role: target.role,
          status: target.status,
        },
      });

      if (target.status === "disabled") {
        // 幂等：已停用的成员不重复撤绑定、不重复写 outbox（避免重复投递）
        const row = await tx.trx
          .selectFrom("members")
          .selectAll()
          .where("user_id", "=", targetUserId)
          .executeTakeFirstOrThrow();
        return { member: toMemberRecord(row), revokedBindings: 0 };
      }

      if (target.role === "admin") {
        const otherAdmins = await countActiveAdmins(tx, targetUserId);
        if (otherAdmins === 0) {
          throw errors.conflict("last-admin: 不能停用最后一名 active admin");
        }
      }

      const revokedBindings = await revokeActiveBindingsOfOwner(tx, {
        actorUserId,
        ownerUserId: targetUserId,
        reason: `member-disabled: 成员 ${targetUserId} 被 ${actorUserId} 停用`,
      });

      const row = await tx.trx
        .updateTable("members")
        .set({ status: "disabled", disabled_at: new Date(this.store.now().getTime()) })
        .where("user_id", "=", targetUserId)
        .returningAll()
        .executeTakeFirstOrThrow();

      await insertAuditEvent(tx, {
        actorUserId,
        actorKind: "user",
        category: "admin-change",
        action: "members:update",
        resource: `member:${targetUserId}`,
        effect: "allow",
        reason: `管理员停用成员 ${targetUserId}，同事务撤销 ${revokedBindings} 条活跃会话绑定`,
      });

      return { member: toMemberRecord(row), revokedBindings };
    });
  }

  /** 恢复成员（不恢复旧绑定；绑定必须重新创建）。同样是 admin 的 `members:update`。 */
  async enableMember(tenantId: string, actorUserId: string, targetUserId: string): Promise<MemberRecord> {
    return this.store.withTenant({ tenantId, actorUserId }, async (tx) => {
      const target = await tx.trx
        .selectFrom("members")
        .select(["role", "status"])
        .where("user_id", "=", targetUserId)
        .executeTakeFirst();
      if (!target) throw errors.notFound("member-not-found: 成员不存在");

      await authorizeTx(this.store, tx, {
        actorUserId,
        action: "members:update",
        resource: {
          kind: "member",
          tenantId,
          ownerUserId: targetUserId,
          role: target.role,
          status: target.status,
        },
      });

      const row = await tx.trx
        .updateTable("members")
        .set({ status: "active", disabled_at: null })
        .where("user_id", "=", targetUserId)
        .returningAll()
        .executeTakeFirstOrThrow();

      await insertAuditEvent(tx, {
        actorUserId,
        actorKind: "user",
        category: "admin-change",
        action: "members:update",
        resource: `member:${targetUserId}`,
        effect: "allow",
        reason: `管理员恢复成员 ${targetUserId} 为 active（旧会话绑定不恢复）`,
      });
      return toMemberRecord(row);
    });
  }

  /**
   * 读成员状态用于装配授权上下文（BFF 登录态解析）。系统操作：tenant.read。
   * 返回 null 表示"不是成员 / 租户不可用"，调用方必须按拒绝处理。
   */
  async membershipOf(
    tenantId: string,
    userId: string,
  ): Promise<{ role: MemberRole; status: MemberStatus } | null> {
    this.store.requireService("tenant.read", "tenancy.membershipOf");
    return this.store.withTenant({ tenantId, actorUserId: userId }, async (tx) => {
      const tenantStatus = await loadTenantStatus(tx);
      if (tenantStatus !== "active") return null;
      const membership = await loadMembership(tx, userId);
      return membership ? { role: membership.role, status: membership.status } : null;
    });
  }

  /** 供绑定创建路径在已有事务里复用 */
  async assertActiveMemberInTx(
    tx: StoreTx,
    userId: string,
  ): Promise<{ role: MemberRole; status: MemberStatus }> {
    const membership = await requireActiveMembership(tx, userId);
    return { role: membership.role, status: membership.status };
  }
}

async function countActiveAdmins(tx: StoreTx, excludingUserId: string): Promise<number> {
  const row = await tx.trx
    .selectFrom("members")
    .select(({ fn }) => [fn.countAll<string>().as("count")])
    .where("role", "=", "admin")
    .where("status", "=", "active")
    .where("user_id", "!=", excludingUserId)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

function validateMemberInput(input: AddMemberInput): void {
  if (!input.userId) throw errors.invalidInput("userId 不能为空");
  if (!isMemberRole(input.role)) {
    throw errors.invalidInput(`role 必须是 admin / member / auditor 之一，收到 ${String(input.role)}`);
  }
}

function toTenantRecord(row: {
  id: string;
  slug: string;
  name: string;
  residency: string | null;
  status: "active" | "suspended" | "deleted";
  created_at: Date;
  updated_at: Date;
}): TenantRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    residency: row.residency,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toMemberRecord(row: {
  tenant_id: string;
  user_id: string;
  role: MemberRole;
  status: MemberStatus;
  display_name: string | null;
  email: string | null;
  created_at: Date;
  updated_at: Date;
  disabled_at: Date | null;
}): MemberRecord {
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    role: row.role,
    status: row.status,
    displayName: row.display_name,
    email: row.email,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    disabledAt: row.disabled_at ? row.disabled_at.toISOString() : null,
  };
}

/** 建租户是平台级系统操作（部署期初始化脚本调用），需要 tenant.manage。 */
export interface CreateTenantInput {
  slug: string;
  name: string;
  residency?: string;
  /** 首个 admin；不提供则租户没有任何管理员，后续无法自助管理 */
  initialAdminUserId?: string;
}

export { randomId as newId };
