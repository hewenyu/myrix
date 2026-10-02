import { randomId } from "../util";
import { errors } from "../errors";
import { hashJson } from "../util";
import { sql } from "kysely";
import type { PlatformStore, StoreTx } from "../store";
import { assertHashShape, decideVersionedWrite } from "../cas";
import { authorizeTx } from "./internal";
import { assertWorkOwned } from "./ownership";
import { insertAuditEvent } from "./audit";
import type { SaveResult } from "./results";
import type { BibleAttributes, BibleEntryKind } from "../domain";

/**
 * 设定圣经：条目 + 不可变版本，CAS 与章节一致。
 *
 * 搜索刻意保持简单（ILIKE 命中 name/summary），不引入 pg_trgm 等扩展：
 * 迁移必须能在任何标准 Postgres 上跑通。检索质量后续再迭代，
 * 但"设定以作品服务为权威、按需检索"这个边界现在就成立。
 */

const KINDS: readonly BibleEntryKind[] = ["character", "location", "faction", "timeline", "item", "concept"];

export interface BibleEntryRecord {
  tenantId: string;
  id: string;
  workId: string;
  kind: BibleEntryKind;
  name: string;
  summary: string;
  attributes: BibleAttributes;
  version: number;
  parentVersion: number | null;
  contentHash: string;
  updatedAt: string;
}

export interface BibleHit {
  id: string;
  kind: BibleEntryKind;
  name: string;
  summary: string;
  attributes: BibleAttributes;
  version: number;
  score: number;
}

export interface SaveBibleEntryInput {
  entryId: string;
  name: string;
  summary: string;
  attributes?: BibleAttributes;
  kind?: BibleEntryKind;
  expectedVersion: number;
}

export interface CreateBibleEntryInput {
  workId: string;
  kind: BibleEntryKind;
  name: string;
  summary?: string;
  attributes?: BibleAttributes;
}

export class BibleRepository {
  constructor(private readonly store: PlatformStore) {}

  async create(tenantId: string, actorUserId: string, input: CreateBibleEntryInput): Promise<BibleEntryRecord> {
    if (!KINDS.includes(input.kind)) {
      throw errors.invalidInput(`kind 必须是 ${KINDS.join(" / ")} 之一，收到 ${String(input.kind)}`);
    }
    const name = input.name?.trim() ?? "";
    if (name.length === 0 || name.length > 200) {
      throw errors.invalidInput("name 长度必须在 1..200 之间");
    }
    const summary = input.summary ?? "";
    const attributes = normalizeAttributes(input.attributes ?? {});

    return this.store.withTenant({ tenantId, actorUserId }, async (tx) => {
      await assertWorkOwned(tx, actorUserId, input.workId);
      await authorizeTx(this.store, tx, {
        actorUserId,
        action: "bible:write",
        resource: { kind: "bible_entry", tenantId, ownerUserId: actorUserId },
      });

      const duplicate = await tx.trx
        .selectFrom("bible_entries")
        .select(["id"])
        .where("work_id", "=", input.workId)
        .where("status", "=", "active")
        // lower(name) 唯一索引在 SQL 侧兜底；这里先查一次给出可读冲突原因
        .where(sql<boolean>`lower(name) = ${name.toLowerCase()}`)
        .executeTakeFirst();
      if (duplicate) {
        throw errors.conflict(`bible-name-taken: 作品内已存在同名条目（id=${duplicate.id}）`);
      }

      const entryId = randomId();
      const row = await tx.trx
        .insertInto("bible_entries")
        .values({
          tenant_id: tenantId,
          id: entryId,
          work_id: input.workId,
          kind: input.kind,
          name,
          summary,
          attributes,
          current_version: 0,
          parent_version: null,
          content_hash: hashJson({}),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await insertAuditEvent(tx, {
        actorUserId,
        actorKind: "user",
        category: "data-write",
        action: "bible:write",
        resource: `bible_entry:${row.id}`,
        effect: "allow",
        reason: `设定条目已创建（kind=${row.kind}，version 0）`,
        workId: input.workId,
      });

      // 版本 0 表示"刚建立、还没有正文内容"；保存第一次编辑时才写版本 1
      return toEntryRecord(row);
    });
  }

  async get(tenantId: string, actorUserId: string, entryId: string): Promise<BibleEntryRecord> {
    return this.store.withTenant({ tenantId, actorUserId }, async (tx) => {
      const entry = await loadEntry(tx, entryId);
      await assertWorkOwned(tx, actorUserId, entry.work_id);
      await authorizeTx(this.store, tx, {
        actorUserId,
        action: "bible:read",
        resource: { kind: "bible_entry", tenantId, ownerUserId: actorUserId },
      });
      return toEntryRecord(entry);
    });
  }

  async listByWork(
    tenantId: string,
    actorUserId: string,
    workId: string,
    kind?: BibleEntryKind,
  ): Promise<BibleEntryRecord[]> {
    return this.store.withTenant({ tenantId, actorUserId }, async (tx) => {
      await assertWorkOwned(tx, actorUserId, workId);
      await authorizeTx(this.store, tx, {
        actorUserId,
        action: "bible:read",
        resource: { kind: "bible_entry", tenantId, ownerUserId: actorUserId },
      });
      let query = tx.trx
        .selectFrom("bible_entries")
        .selectAll()
        .where("work_id", "=", workId)
        .where("status", "=", "active");
      if (kind) query = query.where("kind", "=", kind);
      const rows = await query.orderBy("kind", "asc").orderBy("name", "asc").execute();
      return rows.map(toEntryRecord);
    });
  }

  /**
   * 简单检索：name 精确/前缀优先，其次 summary 命中。
   * 返回 score 便于调用方排序；limit 由调用方给（novel 工具默认 12）。
   */
  async search(
    tenantId: string,
    actorUserId: string,
    workId: string,
    query: string,
    limit = 12,
  ): Promise<BibleHit[]> {
    const trimmed = query.trim();
    if (trimmed.length === 0) throw errors.invalidInput("query 不能为空");
    const pattern = `%${escapeLike(trimmed)}%`;
    const prefix = `${escapeLike(trimmed)}%`;
    const boundedLimit = Math.max(1, Math.min(50, Math.floor(limit)));

    return this.store.withTenant({ tenantId, actorUserId }, async (tx) => {
      await assertWorkOwned(tx, actorUserId, workId);
      await authorizeTx(this.store, tx, {
        actorUserId,
        action: "bible:read",
        resource: { kind: "bible_entry", tenantId, ownerUserId: actorUserId },
      });

      const rows = await tx.trx
        .selectFrom("bible_entries")
        .selectAll()
        .where("work_id", "=", workId)
        .where("status", "=", "active")
        .where((eb) =>
          eb.or([
            eb("name", "ilike", pattern),
            eb("summary", "ilike", pattern),
          ]),
        )
        .limit(boundedLimit)
        .execute();

      const lowered = trimmed.toLowerCase();
      return rows
        .map((row) => {
          const name = row.name.toLowerCase();
          const score =
            name === lowered ? 3 : row.name.toLowerCase().startsWith(lowered) ? 2 : isPrefixMatch(row.name, prefix) ? 2 : 1;
          return {
            id: row.id,
            kind: row.kind as BibleEntryKind,
            name: row.name,
            summary: row.summary,
            attributes: row.attributes,
            version: row.current_version,
            score,
          };
        })
        .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
    });
  }

  /** 保存条目内容：CAS 三态与章节一致 */
  async save(tenantId: string, actorUserId: string, input: SaveBibleEntryInput): Promise<SaveResult> {
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw errors.invalidInput(`expectedVersion 必须是 >= 0 的整数，收到 ${String(input.expectedVersion)}`);
    }
    const name = input.name?.trim() ?? "";
    if (name.length === 0 || name.length > 200) {
      throw errors.invalidInput("name 长度必须在 1..200 之间");
    }
    const attributes = normalizeAttributes(input.attributes ?? {});

    return this.store.withTenant({ tenantId, actorUserId }, async (tx) => {
      const entry = await lockEntry(tx, input.entryId);
      await assertWorkOwned(tx, actorUserId, entry.work_id);
      await authorizeTx(this.store, tx, {
        actorUserId,
        action: "bible:write",
        resource: { kind: "bible_entry", tenantId, ownerUserId: actorUserId },
      });

      const kind = (input.kind ?? entry.kind) as BibleEntryKind;
      if (!KINDS.includes(kind)) {
        throw errors.invalidInput(`kind 必须是 ${KINDS.join(" / ")} 之一，收到 ${String(kind)}`);
      }
      const summary = input.summary;
      const incomingHash = hashJson({ kind, name, summary, attributes });
      assertHashShape(incomingHash, "incomingHash");

      const decision = decideVersionedWrite(
        {
          currentVersion: entry.current_version,
          currentParentVersion: entry.parent_version,
          currentContentHash: entry.content_hash,
        },
        { expectedVersion: input.expectedVersion, incomingHash },
      );

      if (decision.effect === "conflict") {
        throw errors.versionConflict(decision.reason, {
          currentVersion: decision.currentVersion,
          currentDocument: {
            kind: entry.kind,
            name: entry.name,
            summary: entry.summary,
            attributes: entry.attributes,
          },
          currentContentHash: entry.content_hash,
        });
      }
      if (decision.effect === "duplicate") {
        return {
          status: "duplicate",
          version: decision.version,
          contentHash: entry.content_hash,
          updatedAt: entry.updated_at.toISOString(),
          reason: decision.reason,
        };
      }

      await tx.trx
        .insertInto("bible_entry_versions")
        .values({
          tenant_id: tenantId,
          entry_id: entry.id,
          version: decision.nextVersion,
          parent_version: entry.current_version,
          kind,
          name,
          summary,
          attributes,
          content_hash: incomingHash,
          author_user_id: actorUserId,
        })
        .execute();

      const updated = await tx.trx
        .updateTable("bible_entries")
        .set({
          kind,
          name,
          summary,
          attributes,
          current_version: decision.nextVersion,
          parent_version: entry.current_version,
          content_hash: incomingHash,
        })
        .where("id", "=", entry.id)
        .where("current_version", "=", entry.current_version)
        .returning(["updated_at"])
        .executeTakeFirst();
      if (!updated) {
        throw errors.conflict("concurrent-update: 条目在保存过程中被并发修改，请重试");
      }

      await insertAuditEvent(tx, {
        actorUserId,
        actorKind: "user",
        category: "data-write",
        action: "bible:write",
        resource: `bible_entry:${entry.id}`,
        effect: "allow",
        reason: `设定条目保存为新版本 ${decision.nextVersion}（旧版本 ${entry.current_version}）`,
        workId: entry.work_id,
      });

      return {
        status: "saved",
        version: decision.nextVersion,
        contentHash: incomingHash,
        updatedAt: updated.updated_at.toISOString(),
        reason: decision.reason,
      };
    });
  }
}

interface BibleEntryRow {
  tenant_id: string;
  id: string;
  work_id: string;
  kind: string;
  name: string;
  summary: string;
  attributes: BibleAttributes;
  current_version: number;
  parent_version: number | null;
  content_hash: string;
  status: "active" | "deleted";
  created_at: Date;
  updated_at: Date;
}

async function loadEntry(tx: StoreTx, entryId: string): Promise<BibleEntryRow> {
  const row = await tx.trx.selectFrom("bible_entries").selectAll().where("id", "=", entryId).executeTakeFirst();
  if (!row || row.status === "deleted") throw errors.notFound("bible-entry-not-found: 设定条目不存在");
  return row;
}

async function lockEntry(tx: StoreTx, entryId: string): Promise<BibleEntryRow> {
  const row = await tx.trx
    .selectFrom("bible_entries")
    .selectAll()
    .where("id", "=", entryId)
    .forUpdate()
    .executeTakeFirst();
  if (!row || row.status === "deleted") throw errors.notFound("bible-entry-not-found: 设定条目不存在");
  return row;
}

/** 自由属性白名单化：只接受标量与字符串数组，避免任意 JSON 结构 */
export function normalizeAttributes(input: BibleAttributes): BibleAttributes {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw errors.invalidInput("attributes 必须是对象");
  }
  const output: BibleAttributes = {};
  for (const [key, value] of Object.entries(input)) {
    if (key.length === 0 || key.length > 100) {
      throw errors.invalidInput(`attributes 键长度必须在 1..100 之间：${JSON.stringify(key)}`);
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      output[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      output[key] = [...value];
      continue;
    }
    throw errors.invalidInput(`attributes.${key} 只支持 string/number/boolean/string[]`);
  }
  return output;
}

function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function isPrefixMatch(_name: string, _prefixPattern: string): boolean {
  return false;
}

function toEntryRecord(row: BibleEntryRow): BibleEntryRecord {
  return {
    tenantId: row.tenant_id,
    id: row.id,
    workId: row.work_id,
    kind: row.kind as BibleEntryKind,
    name: row.name,
    summary: row.summary,
    attributes: row.attributes,
    version: row.current_version,
    parentVersion: row.parent_version,
    contentHash: row.content_hash,
    updatedAt: row.updated_at.toISOString(),
  };
}
