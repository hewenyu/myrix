/**
 * 身份域契约。
 *
 * 设计要点：Myrix 的身份体系与 DSH 的 anonymous-user-id 解耦。
 * DSH 只作为 PEP（策略执行点）接收一个已经认证过的主体标识；
 * 主体、组织、租户、组的权威来源是企业 IdP（OIDC / LDAP / 飞书等），
 * 统一由控制面归一化为 Principal 后下发给各数据面。
 */

export type PrincipalKind = "user" | "service" | "agent";

export interface Tenant {
  id: string;
  name: string;
  /** 数据驻留/合规标记，供策略与网关共同消费 */
  residency?: string;
}

export interface Principal {
  /** 稳定唯一标识，例如 "u_10086"；不随邮箱/工号变更 */
  id: string;
  kind: PrincipalKind;
  tenantId: string;
  displayName: string;
  email?: string;
  department?: string;
  title?: string;
  /** 外部 IdP 组标识（也可映射为角色），例如 "dept:risk" */
  groups: string[];
  /** 任意 ABAC 属性；键名由企业策略约定 */
  attributes: Record<string, string | number | boolean | string[]>;
  status: "active" | "disabled";
}

/** 传给数据面（DSH 插件、知识库 Connector、LLM 网关）的最小主体引用 */
export interface SubjectRef {
  principalId: string;
  tenantId: string;
  /** 管理员/代理场景：真正发起人的 principalId，用于审计追溯 */
  impersonatedBy?: string;
  /** 本次会话/任务标识，用于审计串联 */
  sessionId?: string;
  agentId?: string;
}

/** 策略求值用的主体上下文（Principal 的投影 + 运行时属性） */
export interface SubjectContext extends SubjectRef {
  groups: string[];
  department?: string;
  attributes: Record<string, unknown>;
}
