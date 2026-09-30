import type { Role, RoleBinding } from "@myrix/contracts";

export type { Role, RoleBinding };

export interface ResolvedPermissions {
  roles: string[];
  permissions: string[];
  /** 引用了但目录中不存在的角色 —— 显式暴露，避免静默无权限 */
  unresolvedRoles: string[];
}

export class RoleStore {
  private readonly roles = new Map<string, Role>();

  upsert(role: Role): void {
    this.roles.set(role.id, { ...role, inherits: [...role.inherits] });
  }

  get(roleId: string): Role | undefined {
    return this.roles.get(roleId);
  }

  list(tenantId?: string): Role[] {
    return [...this.roles.values()].filter(
      (role) => tenantId === undefined || role.tenantId === undefined || role.tenantId === tenantId,
    );
  }

  /** 展开继承链并合并权限；缺失角色与循环继承都不会导致死循环 */
  resolve(principalId: string, tenantId: string, bindings: readonly RoleBinding[]): ResolvedPermissions {
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
      const role = this.roles.get(roleId);
      if (!role) {
        unresolved.push(roleId);
        return;
      }
      roleIds.push(roleId);
      for (const permission of role.permissions) permissions.add(permission);
      for (const parent of role.inherits) visit(parent);
    };

    for (const binding of applicable) visit(binding.roleId);

    return { roles: roleIds, permissions: [...permissions].sort(), unresolvedRoles: unresolved };
  }
}
