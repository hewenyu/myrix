import { errors } from "../errors";
import { randomId, sha256Hex } from "../util";
import type { PlatformStore, StoreTx } from "../store";
import type { SaveResult } from "./results";
import { assertHashShape, decideVersionedWrite } from "../cas";
import { authorizeTx } from "./internal";
import { assertWorkOwned } from "./ownership";
import { insertAuditEvent } from "./audit";

/**
 * 章节：头行（指针）+ 不可变版本。
 *
 * 保存的竞态防护：`select ... for update` 先锁住 chapter 头行，再做 CAS 判定，
 * 最后插入版本 + 更新指针。READ COMMITTED 下第二个并发写者会在锁上等待，
 * 拿到的是已提交的新头行，于是得到 duplicate（同文重试）或 conflict（改过内容），
 * 不会出现"两个版本号相同的行"或"默默覆盖别人写的正文"。
 */

export interface ChapterRecord {
  tenantId: string;
  id: string;
  workId: string;
  title: string;
  version: number;
  parentVersion: number | null;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChapterWithText extends ChapterRecord {
  text: string;
}

export interface ChapterSummary {
  id: string;
  workId: string;
  title: string;
  version: number;
  updatedAt: string;
}

export interface ChapterVersionRecord {
  chapterId: string;
  version: number;
  parentVersion: number | null;
  title: string;
  text: string;
  contentHash: string;
  authorUserId: string;
  createdAt: string;
}

export interface SaveChapterInput {
  chapterId: string;
  text: string;
  expectedVersion: number;
  title?: string;
  /** 客户端幂等键：同作者同键重复提交不会产生第二个版本 */
  clientKey?: string;
}

/** 空章节的正文哈希：version 0 表示"无内容"，用它填充非空约束 */
export const EMPTY_TEXT_HASH = sha256Hex("");

export class ChaptersRepository {
  constructor(private readonly store: PlatformStore) {}

  /** 新建章节（version 0，无内容）。只有作品所有者可以创建。 */
  async create(tenantId: string, actorUserId: string, workId: string, title = ""): Promise<ChapterRecord> {
    return this.store.withTenant({ tenantId, actorUserId }, async (tx) => {
      await assertWorkOwned(tx, actorUserId, workId);
      await authorizeTx(this.store, tx, {
        actorUserId,
        action: "chapters:write",
        resource: { kind: "chapter", tenantId, ownerUserId: actorUserId },
      });
      const row = await tx.trx
        .insertInto("chapters")
        .values({
          tenant_id: tenantId,
          id: randomId(),
          work_id: workId,
          title,
          current_version: 0,
          parent_version: null,
          content_hash: EMPTY_TEXT_HASH,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await insertAuditEvent(tx, {
        actorUserId,
        actorKind: "user",
        category: "data-write",
        action: "chapters:write",
        resource: `chapter:${row.id}`,
        effect: "allow",
        reason: `章节已创建（version 0，无内容），work=${workId}`,
        workId,
      });
      return toChapterRecord(row);
    });
  }

  async list(tenantId: string, actorUserId: string, workId: string): Promise<ChapterSummary[]> {
    return this.store.withTenant({ tenantId, actorUserId }, async (tx) => {
      await assertWorkOwned(tx, actorUserId, workId);
      await authorizeTx(this.store, tx, {
        actorUserId,
        action: "chapters:read",
        resource: { kind: "chapter", tenantId, ownerUserId: actorUserId },
      });
      const rows = await tx.trx
        .selectFrom("chapters")
        .select(["id", "work_id", "title", "current_version", "updated_at"])
        .where("work_id", "=", workId)
        .where("status", "=", "active")
        .orderBy("created_at", "asc")
        .execute();
      return rows.map((row) => ({
        id: row.id,
        workId: row.work_id,
        title: row.title,
        version: row.current_version,
        updatedAt: row.updated_at.toISOString(),
      }));
    });
  }

  /** 读章节头 + 当前版本正文；version 0 返回空串 */
  async get(tenantId: string, actorUserId: string, chapterId: string): Promise<ChapterWithText> {
    return this.store.withTenant({ tenantId, actorUserId }, async (tx) => {
      const chapter = await loadChapter(tx, chapterId);
      await assertWorkOwned(tx, actorUserId, chapter.work_id);
      await authorizeTx(this.store, tx, {
        actorUserId,
        action: "chapters:read",
        resource: { kind: "chapter", tenantId, ownerUserId: actorUserId },
      });
      const text = await loadTextAt(tx, chapter.id, chapter.current_version);
      return { ...toChapterRecord(chapter), text };
    });
  }

  /**
   * 保存章节。返回值三态：
   *   saved     —— 写入新版本
   *   duplicate —— 同一次写入的重试，返回已有版本
   *   抛出 version_conflict（带 currentVersion / currentText）—— 必须重新读取
   */
  async save(tenantId: string, actorUserId: string, input: SaveChapterInput): Promise<SaveResult> {
    const incomingHash = sha256Hex(input.text);
    assertHashShape(incomingHash, "incomingHash");
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw errors.invalidInput(`expectedVersion 必须是 >= 0 的整数，收到 ${String(input.expectedVersion)}`);
    }
    if (typeof input.text !== "string") {
      throw errors.invalidInput("text 必须是字符串");
    }

    return this.store.withTenant({ tenantId, actorUserId }, async (tx) => {
      const chapter = await lockChapter(tx, input.chapterId);
      await assertWorkOwned(tx, actorUserId, chapter.work_id);
      await authorizeTx(this.store, tx, {
        actorUserId,
        action: "chapters:write",
        resource: { kind: "chapter", tenantId, ownerUserId: actorUserId },
      });

      // 客户端幂等键优先：同键已落库且哈希一致 → 直接返回该版本
      if (input.clientKey) {
        const existing = await tx.trx
          .selectFrom("chapter_versions")
          .select(["version", "content_hash"])
          .where("chapter_id", "=", chapter.id)
          .where("client_key", "=", input.clientKey)
          .executeTakeFirst();
        if (existing) {
          if (existing.content_hash !== incomingHash) {
            throw errors.conflict(
              `idempotency-key-reused: clientKey=${input.clientKey} 已用于另一份正文，拒绝覆盖`,
              { version: existing.version },
            );
          }
          return {
            status: "duplicate",
            version: existing.version,
            contentHash: existing.content_hash,
            updatedAt: chapter.updated_at.toISOString(),
            reason: `clientKey=${input.clientKey} 已存在且正文一致，返回已有版本`,
          };
        }
      }

      const decision = decideVersionedWrite(
        {
          currentVersion: chapter.current_version,
          currentParentVersion: chapter.parent_version,
          currentContentHash: chapter.content_hash,
        },
        { expectedVersion: input.expectedVersion, incomingHash },
      );

      if (decision.effect === "conflict") {
        const currentText = await loadTextAt(tx, chapter.id, chapter.current_version);
        throw errors.versionConflict(decision.reason, {
          currentVersion: decision.currentVersion,
          currentText,
          currentContentHash: chapter.content_hash,
        });
      }

      if (decision.effect === "duplicate") {
        return {
          status: "duplicate",
          version: decision.version,
          contentHash: chapter.content_hash,
          updatedAt: chapter.updated_at.toISOString(),
          reason: decision.reason,
        };
      }

      const nextTitle = input.title ?? chapter.title;
      await tx.trx
        .insertInto("chapter_versions")
        .values({
          tenant_id: tenantId,
          chapter_id: chapter.id,
          version: decision.nextVersion,
          parent_version: chapter.current_version,
          title: nextTitle,
          text: input.text,
          content_hash: incomingHash,
          author_user_id: actorUserId,
          client_key: input.clientKey ?? null,
        })
        .execute();

      const updated = await tx.trx
        .updateTable("chapters")
        .set({
          current_version: decision.nextVersion,
          parent_version: chapter.current_version,
          content_hash: incomingHash,
          title: nextTitle,
        })
        .where("id", "=", chapter.id)
        .where("current_version", "=", chapter.current_version)
        .returning(["updated_at"])
        .executeTakeFirst();

      if (!updated) {
        // 头行被人绕过锁改过：宁可回滚也不写出"指针与版本不一致"的状态
        throw errors.conflict("concurrent-update: 章节在保存过程中被并发修改，请重试");
      }

      await insertAuditEvent(tx, {
        actorUserId,
        actorKind: "user",
        category: "data-write",
        action: "chapters:write",
        resource: `chapter:${chapter.id}`,
        effect: "allow",
        reason: `章节保存为新版本 ${decision.nextVersion}（旧版本 ${chapter.current_version}）`,
        workId: chapter.work_id,
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

  /** 版本历史（倒序）；只读，含每版正文哈希，便于对账 */
  async history(tenantId: string, actorUserId: string, chapterId: string): Promise<ChapterVersionRecord[]> {
    return this.store.withTenant({ tenantId, actorUserId }, async (tx) => {
      const chapter = await loadChapter(tx, chapterId);
      await assertWorkOwned(tx, actorUserId, chapter.work_id);
      await authorizeTx(this.store, tx, {
        actorUserId,
        action: "chapters:read",
        resource: { kind: "chapter_version", tenantId, ownerUserId: actorUserId },
      });
      const rows = await tx.trx
        .selectFrom("chapter_versions")
        .selectAll()
        .where("chapter_id", "=", chapterId)
        .orderBy("version", "desc")
        .execute();
      return rows.map((row) => ({
        chapterId: row.chapter_id,
        version: row.version,
        parentVersion: row.parent_version,
        title: row.title,
        text: row.text,
        contentHash: row.content_hash,
        authorUserId: row.author_user_id,
        createdAt: row.created_at.toISOString(),
      }));
    });
  }
}

interface ChapterRow {
  tenant_id: string;
  id: string;
  work_id: string;
  title: string;
  current_version: number;
  parent_version: number | null;
  content_hash: string;
  status: "active" | "deleted";
  created_at: Date;
  updated_at: Date;
}

async function loadChapter(tx: StoreTx, chapterId: string): Promise<ChapterRow> {
  const row = await tx.trx
    .selectFrom("chapters")
    .selectAll()
    .where("id", "=", chapterId)
    .executeTakeFirst();
  if (!row || row.status === "deleted") throw errors.notFound("chapter-not-found: 章节不存在");
  return row;
}

/** 关键路径：锁住头行，后续判定与写入都在锁内完成 */
async function lockChapter(tx: StoreTx, chapterId: string): Promise<ChapterRow> {
  const row = await tx.trx
    .selectFrom("chapters")
    .selectAll()
    .where("id", "=", chapterId)
    .forUpdate()
    .executeTakeFirst();
  if (!row || row.status === "deleted") throw errors.notFound("chapter-not-found: 章节不存在");
  return row;
}

async function loadTextAt(tx: StoreTx, chapterId: string, version: number): Promise<string> {
  if (version <= 0) return "";
  const row = await tx.trx
    .selectFrom("chapter_versions")
    .select(["text"])
    .where("chapter_id", "=", chapterId)
    .where("version", "=", version)
    .executeTakeFirst();
  return row?.text ?? "";
}

function toChapterRecord(row: ChapterRow): ChapterRecord {
  return {
    tenantId: row.tenant_id,
    id: row.id,
    workId: row.work_id,
    title: row.title,
    version: row.current_version,
    parentVersion: row.parent_version,
    contentHash: row.content_hash,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
