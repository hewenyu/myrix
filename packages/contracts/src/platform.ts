/** Public BFF wire types. Credentials and authoritative identity never come from request bodies. */
export type NovelPreset = "novel-outline" | "novel-chapter" | "novel-bible";
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
