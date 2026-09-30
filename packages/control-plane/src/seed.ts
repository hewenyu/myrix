import type {
  EntitlementGrant,
  KnowledgeBaseRef,
  PluginDescriptor,
  PolicyRule,
  Principal,
  Role,
  RoleBinding,
  Tenant,
} from "@myrix/contracts";

export interface GovernanceSeed {
  tenants: Tenant[];
  principals: Principal[];
  roles: Role[];
  bindings: RoleBinding[];
  policies: PolicyRule[];
  grants: EntitlementGrant[];
  catalog: PluginDescriptor[];
  knowledgeBases: { ref: KnowledgeBaseRef; documents: { id: string; text: string; score: number; title?: string; visibleToGroups?: string[] }[] }[];
}

const DSH_VERSION = "0.2.0-rc.2";

export function demoSeed(): GovernanceSeed {
  const tenants: Tenant[] = [
    { id: "acme", name: "Acme 集团", residency: "cn-shanghai" },
    { id: "globex", name: "Globex 事业部", residency: "cn-beijing" },
  ];

  const principals: Principal[] = [
    {
      id: "u_1001",
      kind: "user",
      tenantId: "acme",
      displayName: "张三",
      email: "zhangsan@acme.example",
      department: "engineering",
      title: "高级工程师",
      groups: ["dept:engineering", "all-staff"],
      attributes: { level: 3, admin: false },
      status: "active",
    },
    {
      id: "u_1002",
      kind: "user",
      tenantId: "acme",
      displayName: "李四",
      email: "lisi@acme.example",
      department: "finance",
      title: "财务分析师",
      groups: ["dept:finance", "all-staff"],
      attributes: { level: 2, admin: false },
      status: "active",
    },
    {
      id: "u_1003",
      kind: "user",
      tenantId: "acme",
      displayName: "王五",
      email: "wangwu@acme.example",
      department: "it",
      title: "平台管理员",
      groups: ["dept:it", "all-staff"],
      attributes: { level: 5, admin: true },
      status: "active",
    },
    {
      id: "svc_ci",
      kind: "service",
      tenantId: "acme",
      displayName: "CI 流水线",
      department: "it",
      groups: ["svc"],
      attributes: { admin: false },
      status: "active",
    },
  ];

  const roles: Role[] = [
    {
      id: "employee",
      tenantId: "acme",
      name: "全员",
      description: "基础办公能力：Web 界面、只读工具、知识库检索",
      permissions: ["plugin:*", "tool:fs:read", "tool:web:search", "kb:search", "kb:read", "model:invoke", "session:*"],
      inherits: [],
    },
    {
      id: "engineer",
      tenantId: "acme",
      name: "研发",
      description: "研发常用能力：本地 shell、代码检索、MCP 扩展",
      permissions: ["tool:bash", "tool:fs:write", "tool:lsp", "plugin:mcp-*", "kb:search:repo"],
      inherits: ["employee"],
    },
    {
      id: "finance",
      tenantId: "acme",
      name: "财务",
      description: "财务数据只读能力",
      permissions: ["tool:sheet", "kb:read:finance"],
      inherits: ["employee"],
    },
    {
      id: "platform-admin",
      tenantId: "acme",
      name: "平台管理员",
      description: "管理后台与全部能力",
      permissions: ["*"],
      inherits: ["engineer"],
    },
  ];

  const bindings: RoleBinding[] = [
    { principalId: "u_1001", roleId: "engineer", tenantId: "acme" },
    { principalId: "u_1002", roleId: "finance", tenantId: "acme" },
    { principalId: "u_1003", roleId: "platform-admin", tenantId: "acme" },
    { principalId: "svc_ci", roleId: "engineer", tenantId: "acme", scopeType: "pipeline", scopeId: "ci" },
  ];

  const policies: PolicyRule[] = [
    {
      id: "allow-employee-baseline",
      description: "全员可检索知识库、调用模型、使用 Web 能力",
      effect: "allow",
      tenantId: "acme",
      actions: ["kb:search", "kb:read", "model:invoke", "tool:web:search", "session:*"],
      resources: ["*"],
      obligations: [{ kind: "audit", level: "metadata" }],
    },
    {
      id: "allow-engineering-bash",
      description: "研发允许 bash，但只能写工作区，且需要审计",
      effect: "allow",
      tenantId: "acme",
      actions: ["tool:bash", "tool:fs:write"],
      resources: ["tool:*"],
      condition: { attr: "subject.groups", op: "contains", value: "dept:engineering" },
      obligations: [
        { kind: "sandbox", mode: "workspace-write" },
        { kind: "audit", level: "metadata" },
      ],
    },
    {
      id: "deny-danger-full-access",
      description: "除管理员外，任何人不得使用 danger-full-access 沙箱能力",
      effect: "deny",
      actions: ["sandbox:danger-full-access", "tool:computer-use"],
      resources: ["*"],
      condition: { attr: "subject.attributes.admin", op: "neq", value: true },
    },
    {
      id: "deny-finance-kb-for-non-finance",
      description: "财务知识库只对财务组开放",
      effect: "deny",
      actions: ["kb:search", "kb:read"],
      resources: ["kb:finance-*"],
      condition: { attr: "subject.groups", op: "notIn", value: ["dept:finance"] },
    },
    {
      id: "allow-finance-kb",
      description: "财务组可检索财务知识库，结果限制在该库内",
      effect: "allow",
      actions: ["kb:search"],
      resources: ["kb:finance-*"],
      condition: { attr: "subject.groups", op: "contains", value: "dept:finance" },
      obligations: [{ kind: "knowledgeScope", baseIds: ["kb-finance", "kb-handbook"] }],
    },
    {
      id: "allow-high-risk-with-approval",
      description: "高风险工具需人工审批，且模型与配额受限",
      effect: "allow",
      actions: ["tool:computer-use", "tool:browser-use"],
      resources: ["tool:*"],
      condition: { attr: "subject.attributes.admin", op: "eq", value: true },
      obligations: [
        { kind: "approval", required: true, reason: "高风险工具：需管理员审批" },
        { kind: "rateLimit", key: "llm", perMinute: 30 },
        { kind: "modelScope", models: ["deepseek-chat", "deepseek-reasoner"] },
        { kind: "audit", level: "full" },
      ],
    },
    {
      id: "deny-outside-working-hours",
      description: "生产环境变更仅允许工作时段（示例 ABAC 时间条件）",
      effect: "deny",
      actions: ["tool:deploy"],
      resources: ["env:prod-*"],
      condition: { any: [{ attr: "context.hour", op: "lt", value: 9 }, { attr: "context.hour", op: "gte", value: 19 }] },
    },
  ];

  const catalog: PluginDescriptor[] = [
    {
      id: "dsh-base",
      kind: "dsh-bundle",
      displayName: "DSH 基础包（dsh-base）",
      description: "模型适配器、工具注册表、会话存储、沙箱与审批策略、凭据、遥测",
      risk: "low",
      requires: [],
      provides: ["llm", "workspace", "session", "sandbox", "audit"],
      conflictsWith: [],
      defaultEnabled: true,
      source: "@deepseek-ai/dsh-base@" + DSH_VERSION,
      cordisRowId: "base",
    },
    {
      id: "dsh-web-app",
      kind: "dsh-bundle",
      displayName: "Web 应用",
      description: "浏览器端 Agent 工作台",
      risk: "low",
      requires: ["llm", "session"],
      provides: ["web"],
      conflictsWith: [],
      defaultEnabled: true,
      source: "@deepseek-ai/dsh-web-app@" + DSH_VERSION,
      cordisRowId: "web-app",
    },
    {
      id: "dsh-mcp-client",
      kind: "dsh-plugin",
      displayName: "MCP 客户端",
      description: "接入外部 MCP Server（知识库、内部系统）的通道",
      risk: "medium",
      requires: [],
      provides: ["mcp"],
      conflictsWith: [],
      defaultEnabled: true,
      source: "@deepseek-ai/dsh-mcp-client@" + DSH_VERSION,
      cordisRowId: "mcp",
    },
    {
      id: "dsh-plugin-manager",
      kind: "dsh-plugin",
      displayName: "插件管理器",
      description: "profile 内插件的安装与启停",
      risk: "medium",
      requires: ["session"],
      provides: ["plugin-management"],
      conflictsWith: [],
      defaultEnabled: true,
      source: "@deepseek-ai/dsh-plugin-manager@" + DSH_VERSION,
      cordisRowId: "plugin-manager",
    },
    {
      id: "tool-computer-use",
      kind: "tool",
      displayName: "Computer Use（桌面自动化）",
      description: "高风险：可操作本机桌面，默认关闭，需单独授权 + 审批",
      risk: "high",
      requires: ["computer-use-runtime"],
      provides: [],
      conflictsWith: ["tool-browser-use"],
      defaultEnabled: false,
      source: "@deepseek-ai/dsh-computer-use@" + DSH_VERSION,
      cordisRowId: "computer-use",
    },
    {
      id: "tool-browser-use",
      kind: "tool",
      displayName: "Browser Use（浏览器自动化）",
      description: "高风险：可操作浏览器，默认关闭",
      risk: "high",
      requires: ["browser-runtime"],
      provides: [],
      conflictsWith: ["tool-computer-use"],
      defaultEnabled: false,
      source: "@deepseek-ai/dsh-browser-use@" + DSH_VERSION,
      cordisRowId: "browser-use",
    },
    {
      id: "myrix-plugin-governance",
      kind: "dsh-plugin",
      displayName: "Myrix 治理插件（PEP）",
      description: "在工具执行前调用控制面 PDP，把治理结论翻译成 DSH 沙箱/审批配置",
      risk: "low",
      requires: ["session"],
      provides: ["governance-pep"],
      conflictsWith: [],
      defaultEnabled: true,
      source: "@myrix/dsh-plugin-governance",
      cordisRowId: "myrix-governance",
    },
    {
      id: "myrix-plugin-entitlement",
      kind: "dsh-plugin",
      displayName: "Myrix 功能授权插件",
      description: "按主体授权裁剪工具与插件可见性，渲染 profile",
      risk: "low",
      requires: ["plugin-management"],
      provides: ["entitlement"],
      conflictsWith: [],
      defaultEnabled: true,
      source: "@myrix/dsh-plugin-entitlement",
      cordisRowId: "myrix-entitlement",
    },
    {
      id: "myrix-plugin-knowledge",
      kind: "mcp-server",
      displayName: "Myrix 知识库 MCP",
      description: "把企业知识库联邦暴露为 MCP 检索能力，身份透传",
      risk: "medium",
      requires: ["mcp"],
      provides: ["knowledge-retrieval"],
      conflictsWith: [],
      defaultEnabled: false,
      source: "@myrix/dsh-plugin-knowledge",
      cordisRowId: "myrix-knowledge",
    },
  ];

  const grants: EntitlementGrant[] = [
    {
      pluginId: "myrix-plugin-knowledge",
      tenantId: "acme",
      grantee: "role:engineer",
      grantedBy: "admin:wuwang",
      grantedAt: "2026-09-01T02:00:00.000Z",
    },
    {
      pluginId: "myrix-plugin-knowledge",
      tenantId: "acme",
      grantee: "role:finance",
      grantedBy: "admin:wuwang",
      grantedAt: "2026-09-01T02:00:00.000Z",
    },
    {
      pluginId: "tool-browser-use",
      tenantId: "acme",
      grantee: "u_1001",
      grantedBy: "admin:wuwang",
      grantedAt: "2026-09-10T02:00:00.000Z",
      constraints: ["approval-required", "sandbox:workspace-write"],
    },
  ];

  const knowledgeBases = [
    {
      ref: { id: "kb-handbook", tenantId: "acme", name: "员工手册", provider: "memory" as const, description: "全员可见的制度文档" },
      documents: [
        { id: "hb-1", text: "年假规则：入职满一年 10 天，满三年 15 天。", score: 0.92, title: "年假规则" },
        { id: "hb-2", text: "差旅报销标准：一线城市住宿上限 600 元/晚。", score: 0.81, title: "差旅标准" },
      ],
    },
    {
      ref: {
        id: "kb-finance",
        tenantId: "acme",
        name: "财务底稿",
        provider: "memory" as const,
        description: "仅财务组可见",
        aclDomain: "finance",
        metadata: { visibleToGroups: ["dept:finance"] },
      },
      documents: [
        { id: "fin-1", text: "2026 Q3 集团营收 1.24 亿元，同比 +18%。", score: 0.95, title: "Q3 经营简报" },
      ],
    },
    {
      ref: {
        id: "kb-repo",
        tenantId: "acme",
        name: "代码仓库索引",
        provider: "memory" as const,
        description: "研发组代码语义检索",
        metadata: { visibleToGroups: ["dept:engineering", "dept:it"] },
      },
      documents: [{ id: "repo-1", text: "billing-service 的退款流程在 RefundService.java 中实现。", score: 0.88, title: "退款流程" }],
    },
  ];

  return { tenants, principals, roles, bindings, policies, grants, catalog, knowledgeBases };
}
