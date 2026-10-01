import type { ColumnType, Generated } from "kysely";

import type {
  AuditCategory,
  BibleAttributes,
  BindingStatus,
  CommandOp,
  CommandStatus,
  MemberRole,
  MemberStatus,
  OutlineDocument,
  OutboxStatus,
  SessionPreset,
  WorkStatus,
} from "./domain";

/**
 * 数据库行类型。约定：
 *   * 每张业务表都有 tenant_id，且是复合主键的前缀；RLS 用它做隔离，仓储层永远显式带上它。
 *   * 时间列 pg 驱动返回 JS Date；插入允许 ISO 字符串或 Date，也可省略走数据库默认值。
 *   * jsonb 列由 pg 解析成对象；这里用 Json<T> 固定读写两端的类型，避免 any 泄漏。
 *   * 版本表 / 审计表是只追加：Kysely 侧没有 update 类型（因为数据库也没授予 UPDATE 权限）。
 *
 * 注意 version 表的主键都不含 tenant_id 之外的代理键：chapter_versions 用
 * (tenant_id, chapter_id, version)，与 SQL 迁移一一对应。
 */

type Timestamp = ColumnType<Date, string | Date | undefined, string | Date>;
type Json<T> = ColumnType<T, T | undefined, T>;

export interface TenantsTable {
  id: string;
  slug: string;
  name: string;
  residency: string | null;
  status: Generated<"active" | "suspended" | "deleted">;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface MembersTable {
  tenant_id: string;
  user_id: string;
  role: MemberRole;
  status: Generated<MemberStatus>;
  display_name: string | null;
  email: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  disabled_at: Timestamp | null;
}

export interface WorksTable {
  tenant_id: string;
  id: string;
  owner_user_id: string;
  title: string;
  description: string;
  status: Generated<WorkStatus>;
  version: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ChaptersTable {
  tenant_id: string;
  id: string;
  work_id: string;
  title: string;
  current_version: Generated<number>;
  parent_version: number | null;
  content_hash: string;
  status: Generated<"active" | "deleted">;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ChapterVersionsTable {
  tenant_id: string;
  chapter_id: string;
  version: number;
  parent_version: number | null;
  title: string;
  text: string;
  content_hash: string;
  author_user_id: string;
  client_key: string | null;
  created_at: Timestamp;
}

export interface OutlineDocumentsTable {
  tenant_id: string;
  work_id: string;
  current_version: Generated<number>;
  parent_version: number | null;
  content_hash: string;
  updated_by: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface OutlineVersionsTable {
  tenant_id: string;
  work_id: string;
  version: number;
  parent_version: number | null;
  document: Json<OutlineDocument>;
  content_hash: string;
  author_user_id: string;
  created_at: Timestamp;
}

export interface BibleEntriesTable {
  tenant_id: string;
  id: string;
  work_id: string;
  kind: string;
  name: string;
  summary: string;
  attributes: Json<BibleAttributes>;
  current_version: Generated<number>;
  parent_version: number | null;
  content_hash: string;
  status: Generated<"active" | "deleted">;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface BibleEntryVersionsTable {
  tenant_id: string;
  entry_id: string;
  version: number;
  parent_version: number | null;
  kind: string;
  name: string;
  summary: string;
  attributes: Json<BibleAttributes>;
  content_hash: string;
  author_user_id: string;
  created_at: Timestamp;
}

export interface SessionBindingsTable {
  tenant_id: string;
  id: string;
  owner_user_id: string;
  work_id: string;
  preset: SessionPreset;
  policy_revision: string;
  cell_id: string | null;
  status: Generated<BindingStatus>;
  revoked_revision: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
  revoked_at: Timestamp | null;
}

export interface CommandsTable {
  tenant_id: string;
  id: string;
  binding_id: string;
  work_id: string;
  actor_user_id: string;
  op: CommandOp;
  body_hash: string;
  body: Json<Record<string, unknown>>;
  grant_revision: number;
  status: Generated<CommandStatus>;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  available_at: ColumnType<Date, string | Date | undefined, string | Date>;
  locked_at: Timestamp | null;
  locked_by: string | null;
  lease_expires_at: Timestamp | null;
  settled_at: Timestamp | null;
  receipt: Json<Record<string, unknown>> | null;
  last_error: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface OutboxMessagesTable {
  tenant_id: string;
  id: string;
  topic: string;
  dedupe_key: string;
  payload: Json<Record<string, unknown>>;
  status: Generated<OutboxStatus>;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  available_at: ColumnType<Date, string | Date | undefined, string | Date>;
  locked_at: Timestamp | null;
  locked_by: string | null;
  lease_expires_at: Timestamp | null;
  delivered_at: Timestamp | null;
  last_error: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AuditEventsTable {
  tenant_id: string;
  id: string;
  seq: Generated<string>;
  occurred_at: ColumnType<Date, string | Date | undefined, string | Date>;
  recorded_at: ColumnType<Date, string | Date | undefined, string | Date>;
  actor_user_id: string | null;
  actor_kind: "user" | "service" | "agent";
  session_id: string | null;
  work_id: string | null;
  category: AuditCategory;
  action: string;
  resource: string;
  effect: "allow" | "deny";
  reason: string;
  matched_rules: ColumnType<string[], string[] | undefined, string[]>;
  obligations: Json<unknown[]>;
  detail: Json<Record<string, unknown>>;
  trace_id: string | null;
}

/** 迁移表在 myrix_internal schema，应用角色只读不到（这里仅用于迁移运行器） */
export interface MigrationsTable {
  name: string;
  applied_at: Timestamp;
  checksum: string;
}

export interface PlatformDatabase {
  tenants: TenantsTable;
  members: MembersTable;
  works: WorksTable;
  chapters: ChaptersTable;
  chapter_versions: ChapterVersionsTable;
  outline_documents: OutlineDocumentsTable;
  outline_versions: OutlineVersionsTable;
  bible_entries: BibleEntriesTable;
  bible_entry_versions: BibleEntryVersionsTable;
  session_bindings: SessionBindingsTable;
  commands: CommandsTable;
  outbox_messages: OutboxMessagesTable;
  audit_events: AuditEventsTable;
}

/** 迁移运行器自己的库类型：额外挂上 myrix_internal.migrations */
export interface MigrationDatabase extends PlatformDatabase {
  "myrix_internal.migrations": MigrationsTable;
}
