import { errors } from "../errors";
import { randomId } from "../util";
import type { PlatformStore, StoreTx } from "../store";
import {
  isSessionPreset,
  sessionStatusForGovernance,
  type BindingStatus,
  type SessionPreset,
} from "../domain";
import { authorizeTx, loadMembership } from "./internal";
import { loadOwnedWork } from "./ownership";
import { insertOutboxMessage } from "./outbox";
import { insertAuditEvent, insertDenyEvent } from "./audit";
import { enqueueCommandInTx } from "./commands";

/**
 * 会话绑定：控制面写入的权威记录（platform-plan-v2 §3.1）。
 *
 * 不变式：
 *   * 创建绑定与入队 create 命令必须**同一个事务**（first-version.md 验收项）：
 *     任何一个失败，另一个也不存在。
 *   * 撤权是 status='revoked' + revoked_revision+1，并写 outbox 通知 cell；
 *     不物理删除，保留审计与"曾经存在过这个会话"的证据。
 *   * 已有会话的 read/send/resume/revoke 判定必须同时给出**当前 rev**（从库读）
 *     与**调用方 expectedRev**（入参）；只有 status 不足以判定凭证是否已过期。
 *   * 数据库里若出现 governance 不认识的 `closed`，一律按拒绝处理
 *     （见 `sessionStatusForGovernance`），绝不当作"非 revoked 即放行"。
 */

export interface SessionBindingRecord {
  tenantId: string;
  id: string;
  ownerUserId: string;
  workId: string;
  preset: SessionPreset;
  policyRevision: string;
  cellId: string | null;
  status: BindingStatus;
  revokedRevision: number;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

export interface CreateBindingInput {
  workId: string;
  preset: SessionPreset;
  policyRevision?: string;
  cellId?: string | null;
  /** 由调用方决定 sessionId 便于幂等重试；省略则服务端生成 */
  sessionId?: string;
  /** create 命令的幂等键；省略则服务端生成 */
  commandId?: string;
}

export class SessionsRepository {
  constructor(private readonly store: PlatformStore) {}

  /**
   * 创建绑定 + 同事务入队 create 命令。
   *
   * 要求：调用者是 active 成员、作品所有者，且 governance 放行 `sessions:create`
   * （resource 是**作品**，不是尚不存在的会话，因此不带 status/revision）。
   */
  async create(
    tenantId: string,
    actorUserId: string,
    input: CreateBindingInput,
  ): Promise<SessionBindingRecord> {
    if (!isSessionPreset(input.preset)) {
      throw errors.invalidInput(
        `preset 必须是 novel-outline / novel-chapter / novel-bible，收到 ${String(input.preset)}`,
      );
    }
    const sessionId = input.sessionId ?? randomId();

    return this.store.withTenant({ tenantId, actorUserId }, async (tx) => {
      const work = await loadOwnedWork(tx, actorUserId, input.workId);
      await authorizeTx(this.store, tx, {
        actorUserId,
        action: "sessions:create",
        // governance 的 sessions:create 判定对象是**目标作品**：有成员身份不等于
        // 能在别人作品上创建会话。
        resource: { kind: "session_binding", tenantId, ownerUserId: work.owner_user_id },
      });

      const row = await tx.trx
        .insertInto("session_bindings")
        .values({
          tenant_id: tenantId,
          id: sessionId,
          owner_user_id: actorUserId,
          work_id: input.workId,
          preset: input.preset,
          policy_revision: input.policyRevision ?? "inline",
          cell_id: input.cellId ?? null,
          status: "creating",
          revoked_revision: 1,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      // 绑定与 create 命令同事务：first-version.md 的硬性验收项
      await enqueueCommandInTx(this.store, tx, actorUserId, {
        commandId: input.commandId ?? randomId(),
        bindingId: row.id,
        op: "create",
        body: { preset: row.preset, workId: row.work_id },
        expectedRevision: row.revoked_revision,
        grantRevision: row.revoked_revision,
      });

      await insertAuditEvent(tx, {
        actorUserId,
        actorKind: "user",
        category: "data-write",
        action: "sessions:create",
        resource: `session_binding:${row.id}`,
        effect: "allow",
        reason: `会话绑定已创建（preset=${row.preset}，rev=${row.revoked_revision}），create 命令同事务入队`,
        sessionId: row.id,
        workId: row.work_id,
      });

      return toBindingRecord(row);
    });
  }

  /**
   * 读一条绑定（管理端详情 / 发送前校验）。
   * 必须提供调用方持有的 expectedRevision；与库中 revoked_revision 不一致即拒绝。
   */
  async get(
    tenantId: string,
    actorUserId: string,
    bindingId: string,
    expectedRevision: number,
  ): Promise<SessionBindingRecord> {
    return this.store.withTenant({ tenantId, actorUserId }, async (tx) => {
      const row = await loadBinding(tx, bindingId);
      const status = sessionStatusForGovernance(row.status);
      if (status === null) {
        await insertDenyEvent(tx, {
          actorUserId,
          actorKind: "user",
          action: "sessions:read",
          resource: `session_binding:${row.id}`,
          reason: `unknown-session-status: 会话状态 ${row.status} 不在治理状态集（creating/active/revoked）内，按拒绝处理`,
          sessionId: row.id,
          workId: row.work_id,
        });
        throw errors.forbidden(
          `unknown-session-status: 会话状态 ${row.status} 不可用于判定，按拒绝处理`,
        );
      }

      await authorizeTx(this.store, tx, {
        actorUserId,
        action: "sessions:read",
        resource: {
          kind: "session_binding",
          tenantId,
          ownerUserId: row.owner_user_id,
          status,
          revision: row.revoked_revision,
        },
        expectedRevision,
      });
      return toBindingRecord(row);
    });
  }

  /**
   * 列出**调用者本人**的会话。列表永远按 owner 过滤：
   * 成员身份不代表可以读别人的会话，admin 也一样。
   */
  async listOwn(
    tenantId: string,
    actorUserId: string,
    options: { includeRevoked?: boolean } = {},
  ): Promise<SessionBindingRecord[]> {
    return this.store.withTenant({ tenantId, actorUserId }, async (tx) => {
      const membership = await loadMembership(tx, actorUserId);
      await authorizeTx(this.store, tx, {
        actorUserId,
        action: "sessions:list",
        resource: { kind: "session_binding", tenantId, ownerUserId: actorUserId },
        membership,
      });
      let query = tx.trx
        .selectFrom("session_bindings")
        .selectAll()
        .where("owner_user_id", "=", actorUserId);
      if (!options.includeRevoked) query = query.where("status", "!=", "revoked");
      const rows = await query.orderBy("created_at", "desc").execute();
      return rows.map(toBindingRecord);
    });
  }

  /** 列出某作品下**本人**的会话（作品必须属于调用者） */
  async listForWork(
    tenantId: string,
    actorUserId: string,
    workId: string,
  ): Promise<SessionBindingRecord[]> {
    return this.store.withTenant({ tenantId, actorUserId }, async (tx) => {
      await loadOwnedWork(tx, actorUserId, workId);
      await authorizeTx(this.store, tx, {
        actorUserId,
        action: "sessions:list",
        resource: { kind: "session_binding", tenantId, ownerUserId: actorUserId },
      });
      const rows = await tx.trx
        .selectFrom("session_bindings")
        .selectAll()
        .where("work_id", "=", workId)
        .where("owner_user_id", "=", actorUserId)
        .where("status", "!=", "revoked")
        .orderBy("created_at", "desc")
        .execute();
      return rows.map(toBindingRecord);
    });
  }

  /**
   * cell 回报创建成功：creating → active。
   * 内部可信回调（cell driver），需要 `session.activate` 能力；浏览器不可调用。
   */
  async markActive(tenantId: string, bindingId: string, cellId: string): Promise<SessionBindingRecord> {
    this.store.requireService("session.activate", "sessions.markActive");
    return this.store.withTenant({ tenantId }, async (tx) => {
      const current = await tx.trx
        .selectFrom("session_bindings")
        .select(["id", "status", "cell_id", "owner_user_id", "revoked_revision"])
        .where("id", "=", bindingId)
        .executeTakeFirst();
      if (!current) throw errors.notFound("binding-not-found: 会话绑定不存在");
      if (current.status === "revoked") {
        throw errors.revoked("binding-revoked: 绑定已撤权，禁止激活");
      }

      const row = await tx.trx
        .updateTable("session_bindings")
        .set({ status: "active", cell_id: cellId })
        .where("id", "=", bindingId)
        .where("revoked_revision", "=", current.revoked_revision)
        .returningAll()
        .executeTakeFirst();
      if (!row) {
        throw errors.conflict("activate-race: 绑定状态在激活过程中被并发修改，请重试");
      }

      await insertAuditEvent(tx, {
        actorUserId: current.owner_user_id,
        actorKind: "service",
        category: "data-write",
        action: "sessions:activate",
        resource: `session_binding:${bindingId}`,
        effect: "allow",
        reason: `cell ${cellId} 回报会话激活（系统能力 session.activate）`,
        sessionId: bindingId,
      });
      return toBindingRecord(row);
    });
  }

  /**
   * 撤权一条绑定。调用者必须是所有者，或 admin（governance 的 `sessions:revoke` 是
   * 管理员唯一能作用于他人资源的动作，且 reason 明确说明不读取会话内容）。
   * 必须提供当前 rev 作为 expectedRevision。
   *
   * 同事务：绑定置 revoked → rev+1 → 写 outbox(session.revoke) 通知 cell → 审计。
   */
  async revoke(
    tenantId: string,
    actorUserId: string,
    bindingId: string,
    expectedRevision: number,
    reason: string,
  ): Promise<SessionBindingRecord> {
    return this.store.withTenant({ tenantId, actorUserId }, async (tx) => {
      const current = await loadBinding(tx, bindingId);
      const status = sessionStatusForGovernance(current.status);

      // 已撤权：不再重复判定/重复写 outbox，直接幂等返回（但要按 owner 过滤，避免探测他人会话）。
      if (current.status === "revoked") {
        if (current.owner_user_id !== actorUserId) {
          throw errors.notFound("binding-not-found: 会话绑定不存在");
        }
        return toBindingRecord(current);
      }

      if (status === null) {
        await insertDenyEvent(tx, {
          actorUserId,
          actorKind: "user",
          action: "sessions:revoke",
          resource: `session_binding:${current.id}`,
          reason: `unknown-session-status: 会话状态 ${current.status} 不在治理状态集内，按拒绝处理`,
          sessionId: current.id,
          workId: current.work_id,
        });
        throw errors.forbidden(
          `unknown-session-status: 会话状态 ${current.status} 不可用于判定，按拒绝处理`,
        );
      }

      await authorizeTx(this.store, tx, {
        actorUserId,
        action: "sessions:revoke",
        resource: {
          kind: "session_binding",
          tenantId,
          ownerUserId: current.owner_user_id,
          status,
          revision: current.revoked_revision,
        },
        expectedRevision,
      });

      const row = await tx.trx
        .updateTable("session_bindings")
        .set(({ eb }) => ({
          status: "revoked",
          revoked_at: new Date(this.store.now().getTime()),
          // rev 单调递增：cell / 作品服务 / 网关各自按自己看到的 rev 判断凭证是否过期
          revoked_revision: eb("revoked_revision", "+", 1),
        }))
        .where("id", "=", bindingId)
        .where("revoked_revision", "=", current.revoked_revision)
        .returningAll()
        .executeTakeFirst();
      if (!row) {
        throw errors.conflict("revoke-race: 绑定状态在撤权过程中被并发修改，请重试");
      }

      await insertOutboxMessage(tx, {
        topic: "session.revoke",
        dedupeKey: `session.revoke:${bindingId}:${row.revoked_revision}`,
        payload: {
          bindingId,
          sessionId: bindingId,
          cellId: row.cell_id,
          revokedRevision: row.revoked_revision,
          reason,
        },
      });

      await insertAuditEvent(tx, {
        actorUserId,
        actorKind: "user",
        category: "admin-change",
        action: "sessions:revoke",
        resource: `session_binding:${bindingId}`,
        effect: "allow",
        reason: `会话已撤权并发 outbox 通知 cell：rev ${current.revoked_revision} → ${row.revoked_revision}；${reason}`,
        sessionId: bindingId,
        workId: row.work_id,
      });
      return toBindingRecord(row);
    });
  }
}

/**
 * 在已有事务里把一个成员名下的所有活跃绑定撤掉；返回被撤数量。
 * 每个绑定各写一条 outbox，供 cell 侧的撤权通知重试。
 *
 * 这是"停用成员"的一部分，判定已在 `tenancy.disableMember` 的 `members:update` 里完成；
 * 这里只做数据变更，不再做第二次策略判定（避免把系统级动作映射成成员 allow）。
 */
export async function revokeActiveBindingsOfOwner(
  tx: StoreTx,
  input: { actorUserId: string; ownerUserId: string; reason: string },
): Promise<number> {
  const rows = await tx.trx
    .updateTable("session_bindings")
    .set(({ eb }) => ({
      status: "revoked",
      revoked_at: new Date(),
      revoked_revision: eb("revoked_revision", "+", 1),
    }))
    .where("owner_user_id", "=", input.ownerUserId)
    .where("status", "in", ["creating", "active"])
    .returning(["id", "cell_id", "revoked_revision"])
    .execute();

  for (const row of rows) {
    await insertOutboxMessage(tx, {
      topic: "session.revoke",
      dedupeKey: `session.revoke:${row.id}:${row.revoked_revision}`,
      payload: {
        bindingId: row.id,
        sessionId: row.id,
        cellId: row.cell_id,
        revokedRevision: row.revoked_revision,
        reason: input.reason,
        actorUserId: input.actorUserId,
      },
    });
  }
  return rows.length;
}

async function loadBinding(tx: StoreTx, bindingId: string) {
  const row = await tx.trx
    .selectFrom("session_bindings")
    .selectAll()
    .where("id", "=", bindingId)
    .executeTakeFirst();
  if (!row) throw errors.notFound("binding-not-found: 会话绑定不存在");
  return row;
}

function toBindingRecord(row: {
  tenant_id: string;
  id: string;
  owner_user_id: string;
  work_id: string;
  preset: SessionPreset;
  policy_revision: string;
  cell_id: string | null;
  status: BindingStatus;
  revoked_revision: number;
  created_at: Date;
  updated_at: Date;
  revoked_at: Date | null;
}): SessionBindingRecord {
  return {
    tenantId: row.tenant_id,
    id: row.id,
    ownerUserId: row.owner_user_id,
    workId: row.work_id,
    preset: row.preset,
    policyRevision: row.policy_revision,
    cellId: row.cell_id,
    status: row.status,
    revokedRevision: row.revoked_revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
  };
}
