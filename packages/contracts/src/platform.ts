/** Public BFF wire types. Credentials and authoritative identity never come from request bodies. */
/**
 * 会话 preset。
 *
 * `novel-assistant` 是统一创作助手（六个小说工具全集，由系统提示在自然对话里
 * 判断大纲/正文/设定任务）；三个历史 preset 保留原掩码，供既有会话重放与显式选择。
 */
export type NovelPreset = "novel-assistant" | "novel-outline" | "novel-chapter" | "novel-bible";
export type MemberRole = "admin" | "member";

export interface PlatformIdentity {
  tenantId: string;
  userId: string;
  displayName: string;
  role: MemberRole;
}

export interface Work {
  id: string;
  tenantId: string;
  ownerUserId: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface Chapter {
  id: string;
  workId: string;
  title: string;
  text: string;
  version: number;
  updatedAt: string;
}

export interface Outline {
  workId: string;
  text: string;
  version: number;
  updatedAt: string;
}

export type BibleKind = "character" | "setting" | "timeline";
export interface BibleEntry {
  id: string;
  workId: string;
  kind: BibleKind;
  title: string;
  text: string;
  version: number;
  updatedAt: string;
}

export interface NovelSession {
  id: string;
  workId: string;
  preset: NovelPreset;
  status: "creating" | "active" | "revoked";
  createdAt: string;
  /**
   * 归档时间（ISO8601）；不归档时为 `null`（历史行与新建会话都是 `null`）。
   *
   * 归档是**展示元数据**（分组/收起），不是 `revoked`：归档不使凭证失效、不改
   * `status`、不停止任务，可以随时恢复。归档期间服务器只拒绝**新的 send**
   * （409 `session_archived`）；cancel、事件流与完整历史、Cell 工具调用、归档前
   * 已入队的命令都照常工作。
   */
  archivedAt?: string | null;
}

/** A conflict must retain the caller's unsaved content in the UI. */
export interface SaveResult {
  status: "saved" | "duplicate" | "conflict";
  version: number;
}

export interface QueuedCommand {
  commandId: string;
  status: "queued";
}

export interface ApiError {
  error: string;
  reason: string;
}

/** Durable events have a monotonic sequence; transient deltas have no sequence. */
export interface SessionStreamEvent {
  type: "user" | "assistant" | "delta" | "tool" | "status" | "error" | "turn-end";
  seq?: number;
  text?: string;
  status?: string;
  toolName?: string;
  commandId?: string;
}
