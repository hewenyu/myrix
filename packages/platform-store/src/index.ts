/**
 * `@myrix/platform-store` 公开入口。
 *
 * 给 BFF / works-service 的稳定契约（尽早冻结，Lead 的 BFF 依赖这些名字）：
 *
 *   1. 装配：`createPlatformPool` / `createPlatformDatabase` / `PlatformStore`
 *   2. 授权接缝：`createGovernanceAuthorizer`（生产必须用它绑定 governance）、
 *      `createDenyAllAuthorizer`（默认）、`SERVICE_CAPABILITIES`（系统操作能力）
 *   3. 仓储（`repositories` 命名空间下逐个导出，避免与 wire 类型重名）
 *   4. 迁移/种子入口：`migrateToLatest` / `listMigrations`（CLI 见 `src/bin`）
 *
 * 约定：
 *   * 浏览器**永远**不能调用系统操作（commands claim/settle、outbox、audit.write、tenant.*）。
 *     它们只在服务端装配时通过 `serviceCapabilities` 显式授予。
 *   * 成员请求一律走 `authorizePlatform`，默认 deny。
 *   * 列表永远按 owner 过滤，admin 也看不到别人的作品/章节/设定/会话。
 */

export {
  createDenyAllAuthorizer,
  createGovernanceAuthorizer,
  isPlatformActionShape,
  SERVICE_CAPABILITIES,
  isServiceCapability,
} from "./authz";
export type {
  Authorizer,
  GovernancePlatformModule,
  MemberRoleName,
  MembershipStatusName,
  PlatformAction,
  PlatformActor,
  PlatformDecision,
  PlatformRequest,
  PlatformResourceKind,
  PlatformResourceRef,
  ServiceCapability,
} from "./authz";

export { PlatformStore } from "./store";
export type {
  PlatformStoreOptions,
  StoreTx,
  StoreTxWithInternal,
  TenantContextInput,
} from "./store";

export { createPlatformDatabase, createPlatformPool, DEFAULT_APP_ROLE, DEFAULT_APP_PASSWORD_ENV } from "./db";
export type { PlatformPoolOptions } from "./db";
export { assertRuntimeDatabase } from "./runtime-db";

export {
  PlatformStoreError,
  errors,
  isPlatformStoreError,
} from "./errors";
export type { PlatformErrorCode } from "./errors";

export {
  decideVersionedWrite,
  assertHashShape,
} from "./cas";
export type {
  VersionedState,
  VersionedWriteDecision,
  VersionedWriteEffect,
  VersionedWriteRequest,
} from "./cas";

export {
  assertLength,
  assertUuid,
  canonicalText,
  hashJson,
  isUuid,
  randomId,
  sha256Hex,
  stableStringify,
} from "./util";

export * from "./domain";
export type { MigrationDatabase, PlatformDatabase } from "./schema";
export {
  migrateToLatest,
  listMigrations,
  checksumOf,
  MIGRATIONS_TABLE_DDL,
  MIGRATION_LOCK_KEY,
} from "./migrate";
export type { MigrationFile, MigrationResult } from "./migrate";

// ---------------------------------------------------------------------------
// 仓储：显式列出，避免 `export *` 把内部工具（insertAuditEvent 等）暴露成公共 API。
// ---------------------------------------------------------------------------

export { WorksRepository } from "./repositories/works";
export type {
  CreateWorkInput,
  ListWorksOptions,
  UpdateWorkInput,
  WorkRecord,
} from "./repositories/works";

export { TenancyRepository } from "./repositories/tenancy";
export type {
  AddMemberInput,
  CreateTenantInput,
  MemberRecord,
  TenantRecord,
} from "./repositories/tenancy";

export { SessionsRepository } from "./repositories/bindings";
export type {
  CreateBindingInput,
  SessionBindingRecord,
} from "./repositories/bindings";

export { ChaptersRepository, EMPTY_TEXT_HASH } from "./repositories/chapters";
export type {
  ChapterRecord,
  ChapterSummary,
  ChapterVersionRecord,
  ChapterWithText,
  SaveChapterInput,
} from "./repositories/chapters";

export { OutlineRepository, normalizeOutline } from "./repositories/outline";
export type { OutlineSnapshot, SaveOutlineInput } from "./repositories/outline";

export { BibleRepository, normalizeAttributes } from "./repositories/bible";
export type {
  BibleEntryRecord,
  BibleHit,
  CreateBibleEntryInput,
  SaveBibleEntryInput,
} from "./repositories/bible";

export { CommandsRepository, COMMAND_OPS, computeBodyHash } from "./repositories/commands";
export {
  getCommand,
  listCommands,
  claimSessionCommand,
  claimAnyCommands,
  settleCommand,
  releaseCommand,
  requeueDeadCommand,
} from "./repositories/commands";
export type {
  ClaimCommandsInput,
  CommandRecord,
  EnqueueCommandInput,
  EnqueueCommandResult,
  SettleCommandInput,
} from "./repositories/commands";

export { OutboxRepository, dedupeKeyFor, payloadDigest } from "./repositories/outbox";
export type {
  ClaimOutboxInput,
  EnqueueOutboxInput,
  OutboxClaim,
  OutboxRecord,
} from "./repositories/outbox";

export { AuditRepository, sanitizeDetail } from "./repositories/audit";
export type { AuditEventInput, AuditEventRecord, ListAuditInput } from "./repositories/audit";

export type { ConflictDetails, SaveResult } from "./repositories/results";

/**
 * 内部模块（`insertAuditEvent` / `insertOutboxMessage` / `authorizeTx` / `assertWorkOwned` …）。
 * 只给"和 store 同进程的可信装配代码"用；BFF 路由处理器不应导入这个命名空间。
 */
export * as platformStoreInternal from "./internal-api";
