import type { Role, RoleBinding } from "@myrix/contracts";

export type { Role, RoleBinding };

/** 全局角色的分区键（角色未声明 tenantId 时） */
const GLOBAL_TENANT_KEY = Symbol("global roles");

export interface ResolvedPermissions {
  roles: string[];
  permissions: string[];
  /** 引用了但目录中不存在的角色 —— 显式暴露，避免静默无权限 */
  unresolvedRoles: string[];
  /** 解析使用的租户：可读审计用，同时也是"跨租户不生效"的凭证 */
  tenantId: string;
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** 深拷贝角色：调用方拿到目录内的对象后再改 tenantId/permissions，绝不能改到已写入的角色 */
function copyRole(role: Role): Role {
  return {
    ...role,
    permissions: [...role.permissions],
    inherits: [...role.inherits],
  };
}

/**
 * 角色目录：按租户分区存储 + 解析。
 *
 * 历史实现用单一 `Map<roleId, Role>`，`id` 相同而 `tenantId` 不同的两个角色
 * 会互相覆盖 —— 后写入的租户角色会被另一个租户的主体解析到，
 * 这是真实的跨租户越权面。现在分区规则是：
 *
 * - 角色以 `(tenantId, id)` 为键：`role.tenantId === undefined` 表示全局角色，使用独立 Symbol 键，不与任何租户字符串冲突；
 * - 解析时先查本租户分区，查不到再退化到全局分区；**绝不**查看其他租户分区；
 * - `list(tenantId)` 里同一 id 的租户角色覆盖全局角色，不出现重复项；
 * - 绑定引用的角色若只存在于别的租户，按"未解析"处理（fail-closed，且显式暴露）；
 * - 写入与读出都做副本：目录内的角色不会被调用方从外部改掉。
 */
export class RoleStore {
  /** tenantKey → (roleId → Role)；Symbol 分区只存全局角色 */
  private readonly rolesByTenant = new Map<string | symbol, Map<string, Role>>();

  upsert(role: Role): void {
    if (role === null || typeof role !== "object") {
      throw new Error("RoleStore.upsert：角色必须是对象，拒绝写入畸形角色");
    }
    if (!isNonBlank(role.id)) {
      throw new Error("RoleStore.upsert：角色 id 必须是非空白字符串，拒绝写入畸形角色");
    }
    if (role.tenantId !== undefined && !isNonBlank(role.tenantId)) {
      throw new Error(`RoleStore.upsert：角色 ${role.id} 的 tenantId 必须是非空白字符串，拒绝写入`);
    }
    if (!Array.isArray(role.permissions) || !role.permissions.every(isNonBlank) ||
        !Array.isArray(role.inherits) || !role.inherits.every(isNonBlank)) {
      throw new Error(`RoleStore.upsert：角色 ${role.id} 的 permissions/inherits 必须是非空白字符串数组，拒绝写入`);
    }
    const tenantKey = role.tenantId ?? GLOBAL_TENANT_KEY;
    const bucket = this.rolesByTenant.get(tenantKey) ?? new Map<string, Role>();
    bucket.set(role.id, copyRole(role));
    this.rolesByTenant.set(tenantKey, bucket);
  }

  /** 按租户读取角色（返回副本）；不给 tenantId 时只读全局角色，绝不下沉到其他租户 */
  get(roleId: string, tenantId?: string): Role | undefined {
    const role = tenantId === undefined
      ? this.rolesByTenant.get(GLOBAL_TENANT_KEY)?.get(roleId)
      : this.lookup(roleId, tenantId);
    return role === undefined ? undefined : copyRole(role);
  }

  /**
   * 列出角色（返回副本）：带 tenantId 时返回"全局 + 本租户"，同一 id 以本租户定义为准；
   * 不带时返回全部（供管理后台展示）。
   */
  list(tenantId?: string): Role[] {
    if (tenantId === undefined) {
      return [...this.rolesByTenant.values()].flatMap((bucket) => [...bucket.values()].map(copyRole));
    }
    const byId = new Map<string, Role>();
    for (const bucket of [this.rolesByTenant.get(GLOBAL_TENANT_KEY), this.rolesByTenant.get(tenantId)]) {
      if (bucket === undefined) continue;
      // 后写的本租户分区覆盖全局分区：同名角色只出现一次
      for (const [id, role] of bucket) byId.set(id, role);
    }
    return [...byId.values()].map(copyRole);
  }

  private lookup(roleId: string, tenantId: string): Role | undefined {
    return this.rolesByTenant.get(tenantId)?.get(roleId) ?? this.rolesByTenant.get(GLOBAL_TENANT_KEY)?.get(roleId);
  }

  /** 展开继承链并合并权限；缺失角色与循环继承都不会导致死循环 */
  resolve(principalId: string, tenantId: string, bindings: readonly RoleBinding[]): ResolvedPermissions {
    // fail-closed：租户标识缺失/非法时不解析任何角色，避免退化成"全局角色人人可用"
    if (!isNonBlank(tenantId) || !isNonBlank(principalId)) {
      return { roles: [], permissions: [], unresolvedRoles: [], tenantId: "" };
    }

    const applicable = bindings.filter(
      (binding) =>
        binding.principalId === principalId && (binding.tenantId === tenantId || binding.tenantId === "*"),
    );
    const roleIds: string[] = [];
    const permissions = new Set<string>();
    const unresolved: string[] = [];
    const visited = new Set<string>();

    const visit = (roleId: string): void => {
      if (visited.has(roleId)) return;
      visited.add(roleId);
      // 只在本租户（或全局）分区里查角色：同 id 的其他租户角色一律不可见
      const role = this.lookup(roleId, tenantId);
      if (!role) {
        unresolved.push(roleId);
        return;
      }
      roleIds.push(roleId);
      for (const permission of role.permissions) permissions.add(permission);
      for (const parent of role.inherits) visit(parent);
    };

    for (const binding of applicable) visit(binding.roleId);

    return { roles: roleIds, permissions: [...permissions].sort(), unresolvedRoles: unresolved, tenantId };
  }
}
