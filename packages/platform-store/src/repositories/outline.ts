import { errors } from "../errors";
import { hashJson } from "../util";
import type { PlatformStore, StoreTx } from "../store";
import { assertHashShape, decideVersionedWrite } from "../cas";
import { authorizeTx } from "./internal";
import { assertWorkOwned } from "./ownership";
import { insertAuditEvent } from "./audit";
import { insertOutboxMessage } from "./outbox";
import type { SaveResult } from "./results";
import { emptyOutlineDocument, type OutlineDocument } from "../domain";

/**
 * 大纲：每作品一份文档 + 不可变版本，CAS 语义与章节完全一致
 * （first-version.md："大纲和设定同样使用显式 expectedVersion，避免默默覆盖"）。
 *
 * 文档不存在时视为 version 0 / 空大纲；第一次保存 expectedVersion 必须为 0。
 * 头行用 upsert 处理"首次创建"，但 upsert 只在 version 0 → 1 时发生。
 */

export interface OutlineSnapshot {
  workId: string;
  version: number;
  parentVersion: number | null;
  document: OutlineDocument;
  contentHash: string;
  updatedAt: string;
}

export interface SaveOutlineInput {
  workId: string;
  document: OutlineDocument;
  expectedVersion: number;
  title?: string;
}

export class OutlineRepository {
  constructor(private readonly store: PlatformStore) {}

  async get(tenantId: string, actorUserId: string, workId: string): Promise<OutlineSnapshot> {
    return this.store.withTenant({ tenantId, actorUserId }, async (tx) => {
      await assertWorkOwned(tx, actorUserId, workId);
      await authorizeTx(this.store, tx, {
        actorUserId,
        action: "outline:read",
        resource: { kind: "outline", tenantId, ownerUserId: actorUserId },
      });

      const head = await tx.trx
        .selectFrom("outline_documents")
        .selectAll()
        .where("work_id", "=", workId)
        .executeTakeFirst();
      if (!head) {
        return {
          workId,
          version: 0,
          parentVersion: null,
          document: emptyOutlineDocument(),
          contentHash: hashJson(emptyOutlineDocument()),
          updatedAt: this.store.now().toISOString(),
        };
      }
      const document = await loadDocumentAt(tx, workId, head.current_version);
      return {
        workId,
        version: head.current_version,
        parentVersion: head.parent_version,
        document,
        contentHash: head.content_hash,
        updatedAt: head.updated_at.toISOString(),
      };
    });
  }

  /** 保存大纲；三态与章节一致（saved / duplicate / version_conflict） */
  async save(tenantId: string, actorUserId: string, input: SaveOutlineInput): Promise<SaveResult> {
    const document = normalizeOutline(input.document);
    const incomingHash = hashJson(document);
    assertHashShape(incomingHash, "incomingHash");
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw errors.invalidInput(`expectedVersion 必须是 >= 0 的整数，收到 ${String(input.expectedVersion)}`);
    }

    return this.store.withTenant({ tenantId, actorUserId }, async (tx) => {
      await assertWorkOwned(tx, actorUserId, input.workId);
      await authorizeTx(this.store, tx, {
        actorUserId,
        action: "outline:write",
        resource: { kind: "outline", tenantId, ownerUserId: actorUserId },
      });

      // 锁头行；不存在时用 advisory lock 兜住"两个并发首次创建"
      const head = await tx.trx
        .selectFrom("outline_documents")
        .selectAll()
        .where("work_id", "=", input.workId)
        .forUpdate()
        .executeTakeFirst();

      if (!head) {
        if (input.expectedVersion !== 0) {
          throw errors.versionConflict(
            `version-conflict: 大纲尚不存在（当前版本 0），但 expectedVersion=${input.expectedVersion}`,
            { currentVersion: 0, currentDocument: emptyOutlineDocument(), currentContentHash: hashJson(emptyOutlineDocument()) },
          );
        }
        const created = await tx.trx
          .insertInto("outline_documents")
          .values({
            tenant_id: tenantId,
            work_id: input.workId,
            current_version: 1,
            parent_version: 0,
            content_hash: incomingHash,
            updated_by: actorUserId,
          })
          .onConflict((oc) => oc.columns(["tenant_id", "work_id"]).doNothing())
          .returning(["updated_at"])
          .executeTakeFirst();
        if (!created) {
          throw errors.conflict("concurrent-update: 大纲已被并发创建，请重新读取后重试");
        }
        await tx.trx
          .insertInto("outline_versions")
          .values({
            tenant_id: tenantId,
            work_id: input.workId,
            version: 1,
            parent_version: 0,
            document,
            content_hash: incomingHash,
            author_user_id: actorUserId,
          })
          .execute();
        await insertAuditEvent(tx, {
          actorUserId,
          actorKind: "user",
          category: "data-write",
          action: "outline:write",
          resource: `outline:${input.workId}`,
          effect: "allow",
          reason: "大纲首次创建，写入版本 1",
          workId: input.workId,
        });
        return {
          status: "saved",
          version: 1,
          contentHash: incomingHash,
          updatedAt: created.updated_at.toISOString(),
          reason: "大纲首次创建，写入版本 1",
        };
      }

      const decision = decideVersionedWrite(
        {
          currentVersion: head.current_version,
          currentParentVersion: head.parent_version,
          currentContentHash: head.content_hash,
        },
        { expectedVersion: input.expectedVersion, incomingHash },
      );

      if (decision.effect === "conflict") {
        throw errors.versionConflict(decision.reason, {
          currentVersion: decision.currentVersion,
          currentDocument: await loadDocumentAt(tx, input.workId, head.current_version),
          currentContentHash: head.content_hash,
        });
      }
      if (decision.effect === "duplicate") {
        return {
          status: "duplicate",
          version: decision.version,
          contentHash: head.content_hash,
          updatedAt: head.updated_at.toISOString(),
          reason: decision.reason,
        };
      }

      await tx.trx
        .insertInto("outline_versions")
        .values({
          tenant_id: tenantId,
          work_id: input.workId,
          version: decision.nextVersion,
          parent_version: head.current_version,
          document,
          content_hash: incomingHash,
          author_user_id: actorUserId,
        })
        .execute();

      const updated = await tx.trx
        .updateTable("outline_documents")
        .set({
          current_version: decision.nextVersion,
          parent_version: head.current_version,
          content_hash: incomingHash,
          updated_by: actorUserId,
        })
        .where("work_id", "=", input.workId)
        .where("current_version", "=", head.current_version)
        .returning(["updated_at"])
        .executeTakeFirst();
      if (!updated) {
        throw errors.conflict("concurrent-update: 大纲在保存过程中被并发修改，请重试");
      }

      await insertAuditEvent(tx, {
        actorUserId,
        actorKind: "user",
        category: "data-write",
        action: "outline:write",
        resource: `outline:${input.workId}`,
        effect: "allow",
        reason: `大纲保存为新版本 ${decision.nextVersion}（旧版本 ${head.current_version}）`,
        workId: input.workId,
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

  /** 版本历史（只读） */
  async history(tenantId: string, actorUserId: string, workId: string): Promise<OutlineSnapshot[]> {
    return this.store.withTenant({ tenantId, actorUserId }, async (tx) => {
      await assertWorkOwned(tx, actorUserId, workId);
      await authorizeTx(this.store, tx, {
        actorUserId,
        action: "outline:read",
        resource: { kind: "outline", tenantId, ownerUserId: actorUserId },
      });
      const rows = await tx.trx
        .selectFrom("outline_versions")
        .selectAll()
        .where("work_id", "=", workId)
        .orderBy("version", "desc")
        .execute();
      return rows.map((row) => ({
        workId: row.work_id,
        version: row.version,
        parentVersion: row.parent_version,
        document: row.document,
        contentHash: row.content_hash,
        updatedAt: row.created_at.toISOString(),
      }));
    });
  }
}

/** 结构归一化：只保留已知字段，避免调用方塞进任意 JSON 污染版本内容 */
export function normalizeOutline(input: OutlineDocument): OutlineDocument {
  if (!input || typeof input !== "object" || !Array.isArray(input.chapters)) {
    throw errors.invalidInput("outline.document 必须是 { synopsis?, chapters: [] } 形状");
  }
  const chapters = input.chapters.map((node, index) => {
    if (!node || typeof node !== "object" || typeof node.id !== "string" || typeof node.title !== "string") {
      throw errors.invalidInput(`outline.chapters[${index}] 需要 string 类型的 id 与 title`);
    }
    const normalized: OutlineDocument["chapters"][number] = { id: node.id, title: node.title };
    if (typeof node.summary === "string") normalized.summary = node.summary;
    if (typeof node.chapterId === "string") normalized.chapterId = node.chapterId;
    if (node.status === "planned" || node.status === "drafting" || node.status === "done") {
      normalized.status = node.status;
    }
    return normalized;
  });
  const document: OutlineDocument = { chapters };
  if (typeof input.synopsis === "string") document.synopsis = input.synopsis;
  return document;
}

async function loadDocumentAt(tx: StoreTx, workId: string, version: number): Promise<OutlineDocument> {
  if (version <= 0) return emptyOutlineDocument();
  const row = await tx.trx
    .selectFrom("outline_versions")
    .select(["document"])
    .where("work_id", "=", workId)
    .where("version", "=", version)
    .executeTakeFirst();
  return row?.document ?? emptyOutlineDocument();
}

export { insertOutboxMessage as enqueueOutlineOutbox };
