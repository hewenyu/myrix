import { randomId } from "../util";
import { errors } from "../errors";
import type { PlatformStore, StoreTx } from "../store";
import { authorizeTx, loadMembership } from "./internal";
import { insertAuditEvent } from "./audit";

/**
 * 作品。**单一所有者**（platform-plan-v2 D11 + ADR-0012）：
 *   * 只有所有者能读、改、删自己的作品；admin **不能**看或改别人的作品；
 *   * 列表**永远**按 `owner_user_id = 调用者` 过滤，没有任何"租户可见"分支；
 *   * 每条路径先确认"租户 active + 成员 active/存在"（见 authorizeTx），再走 governance 判定。
 *
 * 仓储层不内联策略：owner 过滤是查询条件，不是判定结果；
 * "能不能做这个动作"完全交给注入的 Authorizer（生产 = governance 的 authorizePlatform）。
 */

export interface WorkRecord {
  tenantId: string;
  id: string;
  ownerUserId: string;
  title: string;
  description: string;
  status: "active" | "archived" | "deleted";
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkInput {
  title: string;
  description?: string;
}

export interface UpdateWorkInput {
  title?: string;
  description?: string;
  status?: "active" | "archived";
  /** 乐观并发：必须等于当前 version；不匹配即 version_conflict */
  expectedVersion: number;
}

export interface ListWorksOptions {
  limit?: number;
  /** 默认只列 active；测试/运维可显式包含 archived（仍强制 owner 过滤） */
  includeArchived?: boolean;
}

export class WorksRepository {
  constructor(private readonly store: PlatformStore) {}

  async create(tenantId: string, actorUserId: string, input: CreateWorkInput): Promise<WorkRecord> {
    const title = input.title?.trim() ?? "";
    if (title.length === 0 || title.length > 300) {
      throw errors.invalidInput("title 长度必须在 1..300 之间");
    }
    const description = input.description ?? "";
    if (description.length > 20000) {
      throw errors.invalidInput("description 长度不能超过 20000");
    }

    return this.store.withTenant({ tenantId, actorUserId }, async (tx) => {
      const membership = await loadMembership(tx, actorUserId);
      await authorizeTx(this.store, tx, {
        actorUserId,
        action: "works:create",
        resource: { kind: "work", tenantId, ownerUserId: actorUserId },
        membership,
      });
      const row = await tx.trx
        .insertInto("works")
        .values({
          tenant_id: tenantId,
          id: randomId(),
          owner_user_id: actorUserId,
          title,
          description,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await insertAuditEvent(tx, {
        actorUserId,
        actorKind: "user",
        category: "data-write",
        action: "works:create",
        resource: `work:${row.id}`,
        effect: "allow",
        reason: `作品已创建，owner=${actorUserId}（D11 单一所有者）`,
        workId: row.id,
      });
      return toWorkRecord(row);
    });
  }

  async get(tenantId: string, actorUserId: string, workId: string): Promise<WorkRecord> {
    return this.store.withTenant({ tenantId, actorUserId }, async (tx) => {
      const row = await loadWork(tx, workId);
      await authorizeTx(this.store, tx, {
        actorUserId,
        action: "works:read",
        resource: { kind: "work", tenantId, ownerUserId: row.owner_user_id },
      });
      return toWorkRecord(row);
    });
  }

  /**
   * 列表**只**返回调用者自己的作品。没有 scope=tenant 这种分支：
   * 成员身份不等于可读全部，admin 也只看得到自己的作品。
   */
  async list(
    tenantId: string,
    actorUserId: string,
    options: ListWorksOptions = {},
  ): Promise<WorkRecord[]> {
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50)));
    return this.store.withTenant({ tenantId, actorUserId }, async (tx) => {
      const membership = await loadMembership(tx, actorUserId);
      await authorizeTx(this.store, tx, {
        actorUserId,
        action: "works:list",
        resource: { kind: "work", tenantId, ownerUserId: actorUserId },
        membership,
      });
      let query = tx.trx.selectFrom("works").selectAll().where("owner_user_id", "=", actorUserId);
      if (!options.includeArchived) query = query.where("status", "=", "active");
      const rows = await query.orderBy("created_at", "desc").limit(limit).execute();
      return rows.map(toWorkRecord);
    });
  }

  /** 更新作品元数据；CAS 在 works.version 上（与内容版本无关） */
  async update(
    tenantId: string,
    actorUserId: string,
    workId: string,
    input: UpdateWorkInput,
  ): Promise<WorkRecord> {
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw errors.invalidInput("expectedVersion 必须是 >= 0 的整数");
    }
    return this.store.withTenant({ tenantId, actorUserId }, async (tx) => {
      const current = await tx.trx
        .selectFrom("works")
        .selectAll()
        .where("id", "=", workId)
        .forUpdate()
        .executeTakeFirst();
      if (!current || current.status === "deleted") throw errors.notFound("work-not-found: 作品不存在");

      await authorizeTx(this.store, tx, {
        actorUserId,
        action: "works:update",
        resource: { kind: "work", tenantId, ownerUserId: current.owner_user_id },
      });

      if (current.version !== input.expectedVersion) {
        throw errors.versionConflict(
          `version-conflict: 作品当前版本 ${current.version}，expectedVersion=${input.expectedVersion}`,
          { currentVersion: current.version },
        );
      }

      const nextTitle = input.title?.trim() ?? current.title;
      if (nextTitle.length === 0 || nextTitle.length > 300) {
        throw errors.invalidInput("title 长度必须在 1..300 之间");
      }
      const nextDescription = input.description ?? current.description;
      if (nextDescription.length > 20000) {
        throw errors.invalidInput("description 长度不能超过 20000");
      }

      const row = await tx.trx
        .updateTable("works")
        .set({
          title: nextTitle,
          description: nextDescription,
          ...(input.status ? { status: input.status } : {}),
          version: current.version + 1,
        })
        .where("id", "=", workId)
        .where("version", "=", current.version)
        .returningAll()
        .executeTakeFirst();
      if (!row) throw errors.conflict("concurrent-update: 作品在更新过程中被并发修改，请重试");

      await insertAuditEvent(tx, {
        actorUserId,
        actorKind: "user",
        category: "data-write",
        action: "works:update",
        resource: `work:${row.id}`,
        effect: "allow",
        reason: `作品元数据已更新：version ${current.version} → ${row.version}`,
        workId: row.id,
      });
      return toWorkRecord(row);
    });
  }

  /** 软删除：不物理删行，保留版本历史与审计线索 */
  async softDelete(tenantId: string, actorUserId: string, workId: string): Promise<void> {
    await this.store.withTenant({ tenantId, actorUserId }, async (tx) => {
      const current = await tx.trx
        .selectFrom("works")
        .select(["owner_user_id", "status"])
        .where("id", "=", workId)
        .executeTakeFirst();
      if (!current || current.status === "deleted") throw errors.notFound("work-not-found: 作品不存在");

      await authorizeTx(this.store, tx, {
        actorUserId,
        action: "works:delete",
        resource: { kind: "work", tenantId, ownerUserId: current.owner_user_id },
      });

      await tx.trx.updateTable("works").set({ status: "deleted" }).where("id", "=", workId).execute();
      await insertAuditEvent(tx, {
        actorUserId,
        actorKind: "user",
        category: "data-write",
        action: "works:delete",
        resource: `work:${workId}`,
        effect: "allow",
        reason: "作品已软删除（status=deleted），版本历史保留",
        workId,
      });
    });
  }
}

async function loadWork(tx: StoreTx, workId: string): Promise<{
  tenant_id: string;
  id: string;
  owner_user_id: string;
  title: string;
  description: string;
  status: "active" | "archived" | "deleted";
  version: number;
  created_at: Date;
  updated_at: Date;
}> {
  const row = await tx.trx.selectFrom("works").selectAll().where("id", "=", workId).executeTakeFirst();
  if (!row || row.status === "deleted") throw errors.notFound("work-not-found: 作品不存在");
  return row;
}

function toWorkRecord(row: {
  tenant_id: string;
  id: string;
  owner_user_id: string;
  title: string;
  description: string;
  status: "active" | "archived" | "deleted";
  version: number;
  created_at: Date;
  updated_at: Date;
}): WorkRecord {
  return {
    tenantId: row.tenant_id,
    id: row.id,
    ownerUserId: row.owner_user_id,
    title: row.title,
    description: row.description,
    status: row.status,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
