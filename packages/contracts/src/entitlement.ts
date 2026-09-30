export type PluginKind =
  | "dsh-bundle"
  | "dsh-plugin"
  | "tool"
  | "skill"
  | "mcp-server"
  | "model-provider";

export type RiskLevel = "low" | "medium" | "high";

/** 插件目录中的一条可选功能；管理后台的"功能裁剪"以它为单位 */
export interface PluginDescriptor {
  id: string;
  kind: PluginKind;
  displayName: string;
  description: string;
  risk: RiskLevel;
  /** 依赖的能力 id，例如 "llm" / "workspace" / "mcp" */
  requires: string[];
  /** 该插件提供的能力 id；用于满足其他插件的 requires */
  provides: string[];
  /** 互斥能力 id，例如某些内置浏览器与外部 CDP 驱动 */
  conflictsWith: string[];
  defaultEnabled: boolean;
  /** npm 包名与版本，例如 "@deepseek-ai/dsh-base@0.2.0-rc.2"；平台内置功能可为空 */
  source?: string;
  /** 该插件在 cordis 配置中的行 id（用于生成 patch） */
  cordisRowId?: string;
  /** 配置 schema 的引用标识；具体 schema 由插件包自带 */
  settingsSchemaRef?: string;
}

export interface EntitlementGrant {
  pluginId: string;
  tenantId: string;
  /** 授权对象可以是 principalId、角色 id 或组 id（"role:xxx" / "group:xxx"） */
  grantee: string;
  grantedBy: string;
  grantedAt: string;
  expiresAt?: string;
  /** 附带的额外约束，例如仅允许 read-only 沙箱 */
  constraints?: string[];
}

export interface EntitlementDecision {
  pluginId: string;
  enabled: boolean;
  reason: string;
}

export interface EntitlementSet {
  principalId: string;
  tenantId: string;
  enabled: string[];
  disabled: string[];
  decisions: EntitlementDecision[];
  /** 生成 profile 时使用的 cordis 行集合 */
  cordisRowIds: string[];
}
