/**
 * 作品服务的公开契约（**冻结**给 BFF 使用）。
 *
 * 这一层是 BFF 与 `@myrix/platform-store` 之间唯一的接口：BFF 只认这里的类型，
 * 不直接 import 仓储类，也不接触 SQL 行类型。冻结的含义：
 *   * 字段名与 docs/implementation/bff-api.md 的 wire 字段一致（camelCase + ISO8601 UTC）；
 *   * 新增字段必须同时更新这里、works-service 的映射与 docs/implementation/platform-store.md；
 *   * **浏览器永远不能**传入 actor / tenantId / owner / rev：这些一律由 BFF 从会话确定。
 */

import type { PlatformIdentity } from "@myrix/contracts";

/** BFF 每次调用都显式传入的调用者身份（来源是服务端会话，不是请求体）。 */
export type Caller = PlatformIdentity;

export type WorkView = {
  id: string;
  tenantId: string;
  ownerUserId: string;
  title: string;
  description: string;
  status: "active" | "archived";
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ChapterView = {
  id: string;
  workId: string;
  title: string;
  text: string;
  version: number;
  updatedAt: string;
};

export type ChapterSummaryView = {
  id: string;
  workId: string;
  title: string;
  version: number;
  updatedAt: string;
};

export type ChapterVersionView = {
  version: number;
  text: string;
  createdAt: string;
};

/** 大纲对外永远是纯文本（wire 基线是 `text`+`expectedVersion`）。 */
export type OutlineView = {
  workId: string;
  text: string;
  version: number;
  updatedAt: string;
};

export type BibleEntryView = {
  id: string;
  workId: string;
  kind: "character" | "setting" | "timeline";
  title: string;
  text: string;
  version: number;
  updatedAt: string;
};

export type NovelSessionView = {
  id: string;
  workId: string;
  preset: "novel-outline" | "novel-chapter" | "novel-bible";
  status: "creating" | "active" | "revoked";
  /** 撤权版本：BFF 必须把它回传给后续 send/cancel/revoke，不能只带 status */
  rev: number;
  createdAt: string;
};

/**
 * 保存结果。与 `@myrix/contracts` 的 `SaveResult` 同形：
 * 冲突**不在这里**返回 —— 抛 `ConflictError`，由 BFF 转成 `409 { status: "conflict", version }`。
 */
export type SaveOutcome = {
  status: "saved" | "duplicate";
  version: number;
};

export type QueuedCommandView = {
  commandId: string;
  status: "queued";
  /** 命令针对的会话的 rev，便于 BFF 在 409 后让前端重新读取 */
  rev: number;
};

export type SessionStreamEventView = {
  type: string;
  seq?: number;
  text?: string;
  status?: string;
  toolName?: string;
  commandId?: string;
};
