/**
 * RBAC 的领域模型放在 contracts：角色与绑定是跨包共享的领域对象，
 * 判定引擎（@myrix/governance）只负责解析与展开。
 */

export interface Role {
  id: string;
  tenantId?: string;
  name: string;
  description?: string;
  /** 权限点，语法与策略动作一致，支持通配，例如 "tool:bash" / "plugin:*" */
  permissions: string[];
  /** 角色继承（RBAC 层级），子角色获得父角色的权限 */
  inherits: string[];
}

export interface RoleBinding {
  principalId: string;
  roleId: string;
  tenantId: string;
  /** 作用域（可选）：把角色绑定限定到某个资源域，例如 scopeType = kb, scopeId = finance */
  scopeType?: string;
  scopeId?: string;
}
