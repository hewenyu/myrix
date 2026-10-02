import type {
  AuditEvent,
  EntitlementGrant,
  EntitlementSet,
  PolicyDecision,
  PolicyRequest,
  PolicyResource,
  PolicyRule,
  Principal,
  Role,
  RoleBinding,
  SubjectContext,
  Tenant,
} from "@myrix/contracts";
import { RoleStore, decide, globMatches } from "@myrix/governance";
import { KnowledgeFederation, MemoryKnowledgeConnector } from "@myrix/knowledge";
import {
  PluginCatalog,
  buildProfileSpec,
  computeEntitlement,
  renderProfilePatch,
  type ProfileSpec,
} from "@myrix/registry";
import { demoSeed, type GovernanceSeed } from "./seed";

/** 平台自身提供的能力（不来自插件目录） */
const PLATFORM_CAPABILITIES = ["llm", "workspace", "session", "sandbox", "audit"];

export interface DecisionEnvelope {
  decision: PolicyDecision;
  /** 判定来源：rbac（角色权限点未覆盖）/ abac（策略规则） */
  source: "rbac" | "abac";
  reason: string;
  principalId: string;
  action: string;
  resource: string;
}

export interface DecideInput {
  principalId: string;
  action: string;
  resource: PolicyResource;
  context?: Record<string, unknown>;
  /**
   * 本次判定的时刻。缺省用控制面注入的时钟；显式传入可复放/测试。
   */
  at?: string | Date;
}

export interface GovernanceStoreOptions {
  /** 控制面的时钟；纯函数 `decide` 由这里取 now，缺省为系统时钟 */
  now?: () => Date;
}

/**
 * 控制面状态：把身份、RBAC、ABAC、插件授权、知识库联邦与审计放在同一个
 * 可替换的存储边界后面。当前实现是内存版，Postgres 版见 deploy/postgres。
 *
 * 时钟：`@myrix/governance` 的 `decide` 是纯函数，不读系统时钟，必须由调用方注入 `now`。
 * 控制面在这里把"当前时刻"适配进去（`options.now`，缺省 `() => new Date()`），
 * 这是本文件唯一允许读时钟的地方；判定逻辑本身保持确定性。
 */
export class GovernanceStore {
  readonly tenants: Tenant[];
  readonly principals: Principal[];
  readonly policies: PolicyRule[];
  readonly grants: EntitlementGrant[];
  readonly roles: Role[];
  readonly catalog: PluginCatalog;
  readonly roleStore: RoleStore;
  readonly federation: KnowledgeFederation;

  private readonly bindings: RoleBinding[];
  private readonly auditLog: AuditEvent[] = [];
  private readonly clock: () => Date;
  private auditSeq = 0;

  constructor(seed: GovernanceSeed = demoSeed(), options: GovernanceStoreOptions = {}) {
    this.tenants = seed.tenants;
    this.principals = seed.principals;
    this.policies = seed.policies;
    this.grants = [...seed.grants];
    this.roles = seed.roles;
    this.bindings = seed.bindings;
    this.clock = options.now ?? (() => new Date());
    this.catalog = new PluginCatalog();
    this.catalog.registerAll(seed.catalog);
    this.roleStore = new RoleStore();
    for (const role of seed.roles) this.roleStore.upsert(role);

    this.federation = new KnowledgeFederation();
    this.federation.register(
      new MemoryKnowledgeConnector({ id: "memory-main", bases: seed.knowledgeBases }),
    );
  }

  get policyRevision(): string {
    return "policies-" + this.policies.length.toString() + "-" + this.grants.length.toString();
  }

  listPrincipals(tenantId?: string): Principal[] {
    return this.principals.filter((principal) => tenantId === undefined || principal.tenantId === tenantId);
  }

  getPrincipal(principalId: string): Principal | undefined {
    return this.principals.find((principal) => principal.id === principalId);
  }

  listRoles(tenantId?: string): Role[] {
    return this.roleStore.list(tenantId);
  }

  /** 展开某主体最终生效的角色与权限点（RBAC 层的结果，供管理后台展示） */
  resolveAccess(principalId: string): { roles: string[]; permissions: string[]; unresolvedRoles: string[] } | undefined {
    const principal = this.getPrincipal(principalId);
    if (!principal) return undefined;
    return this.roleStore.resolve(principal.id, principal.tenantId, this.bindings);
  }

  subjectContext(principal: Principal): SubjectContext {
    return {
      principalId: principal.id,
      tenantId: principal.tenantId,
      groups: principal.groups,
      ...(principal.department === undefined ? {} : { department: principal.department }),
      attributes: { ...principal.attributes, status: principal.status },
    };
  }

  /**
   * 两级判定：
   * 1) RBAC 粗粒度——角色权限点是否覆盖该 action（没有权限点直接拒绝，不进入 ABAC）
   * 2) ABAC 细粒度——属性/上下文条件与义务（沙箱、审批、配额、范围）
   * 这样"能不能用某类能力"由角色决定，"在什么条件下、以什么方式用"由策略决定。
   */
  decide(input: DecideInput): DecisionEnvelope {
    const principal = this.getPrincipal(input.principalId);
    const resourceKey = input.resource.type + ":" + input.resource.id;
    const evaluatedAt = (input.at === undefined ? this.clock() : new Date(input.at)).toISOString();
    if (!principal) {
      const decision: PolicyDecision = {
        effect: "deny",
        matched: "default-deny",
        matchedRules: [],
        obligations: [],
        policyRevision: this.policyRevision,
        evaluatedAt,
      };
      return {
        decision,
        source: "rbac",
        reason: "主体不存在：" + input.principalId,
        principalId: input.principalId,
        action: input.action,
        resource: resourceKey,
      };
    }

    const resolved = this.roleStore.resolve(principal.id, principal.tenantId, this.bindings);
    const rbacGranted = resolved.permissions.some((permission) => globMatches(permission, input.action));
    if (!rbacGranted) {
      const decision: PolicyDecision = {
        effect: "deny",
        matched: "default-deny",
        matchedRules: [],
        obligations: [],
        policyRevision: this.policyRevision,
        evaluatedAt,
      };
      const envelope: DecisionEnvelope = {
        decision,
        source: "rbac",
        reason: "角色权限点未覆盖该动作：角色 " + resolved.roles.join("+") + " 缺少 " + input.action,
        principalId: principal.id,
        action: input.action,
        resource: resourceKey,
      };
      this.recordDecision(envelope);
      return envelope;
    }

    const request: PolicyRequest = {
      subject: this.subjectContext(principal),
      action: input.action,
      resource: input.resource,
      context: input.context ?? {},
    };
    const decision = decide(request, this.policies, { policyRevision: this.policyRevision, now: input.at ?? this.clock() });
    const envelope: DecisionEnvelope = {
      decision,
      source: "abac",
      reason:
        decision.effect === "allow"
          ? "策略放行：" + decision.matchedRules.join(", ")
          : decision.matched === "explicit-deny"
            ? "策略拒绝：" + decision.matchedRules.join(", ")
            : "无策略显式放行，按 fail-closed 拒绝",
      principalId: principal.id,
      action: input.action,
      resource: resourceKey,
    };
    this.recordDecision(envelope);
    return envelope;
  }

  entitlements(principalId: string): EntitlementSet | undefined {
    const principal = this.getPrincipal(principalId);
    if (!principal) return undefined;
    const resolved = this.roleStore.resolve(principal.id, principal.tenantId, this.bindings);
    const pluginDenies = this.policies
      .filter((rule) => rule.effect === "deny")
      .filter((rule) => rule.actions.some((action) => action.startsWith("plugin:")))
      .flatMap((rule) => rule.resources)
      .filter((resource) => resource.startsWith("plugin:"))
      .map((resource) => resource.slice("plugin:".length));
    return computeEntitlement({
      principal,
      catalog: this.catalog,
      grants: this.grants,
      roleIds: resolved.roles,
      deniedPluginIds: pluginDenies,
      platformCapabilities: PLATFORM_CAPABILITIES,
      // 装配层注入时钟：registry 保持纯函数，过期判定与 profile.generatedAt 可复放
      now: () => this.clock(),
    });
  }

  profile(principalId: string): { spec: ProfileSpec; yaml: string } | undefined {
    const entitlement = this.entitlements(principalId);
    if (!entitlement) return undefined;
    const spec = buildProfileSpec(entitlement, this.catalog, {
      profile: "enterprise",
      policyRevision: this.policyRevision,
      now: () => this.clock(),
    });
    return { spec, yaml: renderProfilePatch(spec) };
  }

  addGrant(grant: EntitlementGrant): EntitlementGrant {
    this.grants.push(grant);
    this.record({
      category: "admin-change",
      tenantId: grant.tenantId,
      principalId: grant.grantedBy,
      action: "grant.create",
      resource: "plugin:" + grant.pluginId,
      effect: "allow",
      detail: { grantee: grant.grantee },
    });
    return grant;
  }

  listAudit(limit = 50): AuditEvent[] {
    return this.auditLog.slice(-limit).reverse();
  }

  record(event: Omit<AuditEvent, "id" | "ts">): AuditEvent {
    this.auditSeq += 1;
    const full: AuditEvent = {
      id: "evt_" + this.auditSeq.toString().padStart(6, "0"),
      ts: this.clock().toISOString(),
      ...event,
    };
    this.auditLog.push(full);
    if (this.auditLog.length > 5000) this.auditLog.shift();
    return full;
  }

  private recordDecision(envelope: DecisionEnvelope): void {
    this.record({
      category: "policy-decision",
      tenantId: this.getPrincipal(envelope.principalId)?.tenantId ?? "unknown",
      principalId: envelope.principalId,
      action: envelope.action,
      resource: envelope.resource,
      effect: envelope.decision.effect,
      matchedRules: envelope.decision.matchedRules,
      obligations: envelope.decision.obligations,
      detail: { source: envelope.source, reason: envelope.reason },
    });
  }
}
