/**
 * 领域内联类型（不进 @myrix/contracts：那是 Lead 的写入范围）。
 *
 * 这些结构是 Postgres 列类型（jsonb）的 TypeScript 投影，只保证"能安全存取"；
 * 结构语义校验在 apps/works-service 的 schema 层做。
 */

/**
 * 成员角色与 `@myrix/governance` 的 `PLATFORM_MEMBER_ROLES` 保持一致：
 * `member | admin | auditor`。SQL 侧 check 约束同步（见 0009 迁移）。
 */
export type MemberRole = "admin" | "member" | "auditor";
export type MemberStatus = "active" | "disabled";

export const MEMBER_ROLES: readonly MemberRole[] = ["admin", "member", "auditor"];

export function isMemberRole(value: unknown): value is MemberRole {
  return value === "admin" || value === "member" || value === "auditor";
}

export type WorkStatus = "active" | "archived" | "deleted";

export type SessionPreset = "novel-outline" | "novel-chapter" | "novel-bible";
export const SESSION_PRESETS: readonly SessionPreset[] = [
  "novel-outline",
  "novel-chapter",
  "novel-bible",
];

export type BindingStatus = "creating" | "active" | "revoked" | "closed";

/**
 * governance（ADR-0012）只认 `creating | active | revoked`；它没有 `closed`。
 * 存储层遇到数据库里可能存在的 `closed` 必须**规范化成拒绝**，
 * 绝不能把它当作"非 revoked 所以放行"。返回 null 表示"该状态不可用于判定"。
 */
export function sessionStatusForGovernance(status: BindingStatus): "creating" | "active" | "revoked" | null {
  if (status === "creating" || status === "active" || status === "revoked") return status;
  return null;
}

export type CommandOp = "create" | "resume" | "send" | "cancel" | "subscribe";
export type CommandStatus = "queued" | "inflight" | "succeeded" | "failed" | "dead";

export type OutboxStatus = "pending" | "inflight" | "delivered" | "failed" | "dead";

export type BibleEntryKind = "character" | "location" | "faction" | "timeline" | "item" | "concept";

export type AuditCategory =
  | "policy-decision"
  | "tool-execution"
  | "knowledge-access"
  | "admin-change"
  | "data-write";

/**
 * 大纲文档：一章一个节点，order 决定展示顺序。
 * 这是 v0.1 的最小结构；后续扩展字段必须保持向后兼容（读旧写新）。
 */
export interface OutlineChapterNode {
  id: string;
  title: string;
  summary?: string;
  /** 关联的章节 id（可为空：大纲先于章节存在） */
  chapterId?: string;
  status?: "planned" | "drafting" | "done";
}

export interface OutlineDocument {
  synopsis?: string;
  chapters: OutlineChapterNode[];
}

export function emptyOutlineDocument(): OutlineDocument {
  return { chapters: [] };
}

/** 设定条目的自由属性；值限制为 JSON 标量或字符串数组，便于检索展示 */
export type BibleAttributeValue = string | number | boolean | string[];
export type BibleAttributes = Record<string, BibleAttributeValue>;

export const SESSION_PRESET_VALUES: Record<SessionPreset, true> = {
  "novel-outline": true,
  "novel-chapter": true,
  "novel-bible": true,
};

export function isSessionPreset(value: string): value is SessionPreset {
  return Object.prototype.hasOwnProperty.call(SESSION_PRESET_VALUES, value);
}
