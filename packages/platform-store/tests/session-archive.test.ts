/**
 * 会话归档（展示元数据）在**真实非 owner LOGIN + RLS** 上的回归。
 *
 * 为什么不放进 `apps/bff` 的集成测试：归档的授权、CAS 与数据库约束都在
 * `SessionsRepository` 里，和 BFF 路由无关；放这里能同时覆盖"跨 owner / 跨租户 /
 * 管理员 / 已撤权 / 未知 preset"这些只由存储层决定的负例。
 *
 * 覆盖点：
 *   1. 所有者本人归档 → `archivedAt` 置位；恢复 → 置回 null；两步都幂等；
 *   2. 归档**不动** `status` / `revoked_revision` / `revoked_at`（不是撤权）；
 *   3. 非所有者、跨租户成员、管理员都不能归档他人会话（统一 not_found，不泄漏存在性）；
 *   4. 已撤权会话不能归档（410 revoked）；反过来，**归档会话必须仍可撤权**：
 *      DELETE 路径（`revoke`）与停用成员的批量撤权（`revokeActiveBindingsOfOwner`）
 *      都不被归档状态阻塞（归档与撤权正交）；
 *   5. 未知 preset 一律 `invalid_input`；`novel-assistant` 可落库（迁移 0010 的 check）。
 *
 * 独立随机 fixture，只追加数据、不删库、不 reset 既有行。
 *
 * ```sh
 * BFF_TEST_DATABASE_URL='postgres://myrix_bff_test:myrix_local_bff_test@127.0.0.1:55439/myrix_bff_acceptance' \
 * BFF_TEST_MIGRATION_DATABASE_URL='postgres://myrix_migrator:myrix_local_migrator@127.0.0.1:55439/myrix_bff_acceptance' \
 * pnpm exec vitest run packages/platform-store/tests/session-archive.test.ts
 * ```
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { authorizePlatform } from "@myrix/governance";
import { createGovernanceAuthorizer } from "../src/authz";
import { PlatformStore } from "../src/store";
import { migrateToLatest } from "../src/migrate";
import { SessionsRepository } from "../src/repositories/bindings";
import { revokeActiveBindingsOfOwner } from "../src/internal-api";
import type { MigrationDatabase, PlatformDatabase } from "../src/schema";

const appUrl = process.env.BFF_TEST_DATABASE_URL;
const migrationUrl = process.env.BFF_TEST_MIGRATION_DATABASE_URL;

describe.skipIf(!appUrl || !migrationUrl)("session archive on a real nonowner LOGIN", () => {
  const tenantId = randomUUID();
  const foreignTenantId = randomUUID();
  const owner = randomUUID();
  const otherMember = randomUUID();
  const admin = randomUUID();
  const foreignOwner = randomUUID();
  const workId = randomUUID();
  const foreignWorkId = randomUUID();

  let migration: Kysely<MigrationDatabase>;
  let db: Kysely<PlatformDatabase>;
  let sessions: SessionsRepository;

  /** 每个用例一条新绑定：归档是可变状态，用例之间不能共享。 */
  async function newBinding(preset: string = "novel-assistant", ownerUserId: string = owner): Promise<string> {
    const id = randomUUID();
    await migration.insertInto("session_bindings").values({
      tenant_id: tenantId, id, owner_user_id: ownerUserId, work_id: workId,
      preset: preset as never, policy_revision: "archive-test", cell_id: "archive-cell",
      status: "active", revoked_revision: 1,
    }).execute();
    return id;
  }

  const bindingRow = (id: string) =>
    migration.selectFrom("session_bindings").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

  beforeAll(async () => {
    migration = new Kysely<MigrationDatabase>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: migrationUrl, max: 1 }) }) });
    db = new Kysely<PlatformDatabase>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: appUrl, max: 4 }) }) });
    await migrateToLatest(migration);
    // 应用连接必须仍是低权 LOGIN（归档路径不得依赖 owner/superuser 能力）。
    const roles = await sql<{ login: boolean; rolsuper: boolean; rolbypassrls: boolean; owns: boolean }>`
      select current_user = session_user as login, r.rolsuper, r.rolbypassrls, c.relowner = r.oid as owns
      from pg_roles r cross join pg_class c
      where r.rolname = current_user and c.oid = 'session_bindings'::regclass`.execute(db);
    expect(roles.rows[0]).toEqual({ login: true, rolsuper: false, rolbypassrls: false, owns: false });

    await migration.insertInto("tenants").values([
      { id: tenantId, slug: `archive-${tenantId}`, name: "Archive integration A" },
      { id: foreignTenantId, slug: `archive-${foreignTenantId}`, name: "Archive integration B" },
    ]).execute();
    await migration.insertInto("members").values([
      { tenant_id: tenantId, user_id: owner, role: "member", status: "active", display_name: "所有者" },
      { tenant_id: tenantId, user_id: otherMember, role: "member", status: "active", display_name: "同租户他人" },
      { tenant_id: tenantId, user_id: admin, role: "admin", status: "active", display_name: "管理员" },
      { tenant_id: foreignTenantId, user_id: foreignOwner, role: "member", status: "active", display_name: "其他租户" },
    ]).execute();
    await migration.insertInto("works").values([
      { tenant_id: tenantId, id: workId, owner_user_id: owner, title: "归档作品", description: "" },
      { tenant_id: foreignTenantId, id: foreignWorkId, owner_user_id: foreignOwner, title: "其他租户作品", description: "" },
    ]).execute();

    sessions = new SessionsRepository(new PlatformStore({ db, authorizer: createGovernanceAuthorizer({ authorizePlatform }) }));
  }, 30_000);

  afterAll(async () => { await db?.destroy(); await migration?.destroy(); });

  it("owner 归档后 archivedAt 置位；恢复后置回 null；两步幂等", async () => {
    const id = await newBinding();

    const archived = await sessions.setArchived(tenantId, owner, id, true);
    expect(archived.archivedAt).not.toBeNull();
    expect(Date.parse(archived.archivedAt!)).not.toBeNaN();
    // 归档是展示元数据，不是撤权：状态机字段一个都不动。
    expect(archived.status).toBe("active");
    expect(archived.revokedRevision).toBe(1);
    expect(archived.revokedAt).toBeNull();
    const row = await bindingRow(id);
    expect(row.archived_at).not.toBeNull();
    expect(row.status).toBe("active");
    expect(row.revoked_revision).toBe(1);

    // 幂等：重复归档返回同一条记录（archivedAt 不刷新）。
    const again = await sessions.setArchived(tenantId, owner, id, true);
    expect(again.archivedAt).toBe(archived.archivedAt);

    const restored = await sessions.setArchived(tenantId, owner, id, false);
    expect(restored.archivedAt).toBeNull();
    expect((await bindingRow(id)).archived_at).toBeNull();
    // 恢复同样幂等。
    expect((await sessions.setArchived(tenantId, owner, id, false)).archivedAt).toBeNull();
  });

  it("归档写审计（sessions:archive，allow），且审计明确写出不是撤权", async () => {
    const id = await newBinding();
    await sessions.setArchived(tenantId, owner, id, true);
    const events = await migration.selectFrom("audit_events")
      .select(["action", "effect", "reason", "session_id", "work_id"])
      .where("tenant_id", "=", tenantId).where("session_id", "=", id)
      .where("action", "=", "sessions:archive").execute();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ effect: "allow", work_id: workId });
    expect(events[0]!.reason).toContain("不是撤权");
    expect(events[0]!.reason).toContain("rev=1 不变");
  });

  it("非所有者、跨租户、管理员都不能归档他人会话：统一 not_found 且行不变", async () => {
    const id = await newBinding();
    for (const [actor, label] of [[otherMember, "同租户他人"], [foreignOwner, "跨租户"], [admin, "管理员"]] as const) {
      const tenant = actor === foreignOwner ? foreignTenantId : tenantId;
      await expect(sessions.setArchived(tenant, actor, id, true), label)
        .rejects.toMatchObject({ code: "not_found", httpStatus: 404 });
      // 恢复路径同样只有所有者能走。
      await expect(sessions.setArchived(tenant, actor, id, false), `${label}/restore`)
        .rejects.toMatchObject({ code: "not_found", httpStatus: 404 });
    }
    expect((await bindingRow(id)).archived_at).toBeNull();
    // 跨租户路径也不得留下任何审计（连"存在过"都不泄漏）。
    const foreignAudit = await migration.selectFrom("audit_events").select(["id"])
      .where("tenant_id", "=", foreignTenantId).where("session_id", "=", id).execute();
    expect(foreignAudit).toEqual([]);
    const ownAudit = await migration.selectFrom("audit_events").select(["id"])
      .where("tenant_id", "=", tenantId).where("session_id", "=", id).where("action", "=", "sessions:archive").execute();
    expect(ownAudit).toEqual([]);
  });

  it("已撤权会话不能归档也不能恢复：410 revoked，行不变", async () => {
    const id = await newBinding();
    await migration.updateTable("session_bindings")
      .set({ status: "revoked", revoked_revision: 2, revoked_at: new Date() })
      .where("id", "=", id).execute();

    await expect(sessions.setArchived(tenantId, owner, id, true)).rejects.toMatchObject({ code: "revoked", httpStatus: 410 });
    await expect(sessions.setArchived(tenantId, owner, id, false)).rejects.toMatchObject({ code: "revoked", httpStatus: 410 });
    const row = await bindingRow(id);
    expect(row.status).toBe("revoked");
    expect(row.archived_at).toBeNull();
  });

  it("数据库 check 拒绝未知 preset；'已撤权 + archived_at' 不再是约束（归档与撤权正交）", async () => {
    const id = await newBinding();
    // 0011 删除 `session_bindings_archived_consistency` 之后，直接写"已撤权 + 归档"
    // 必须成功：否则 `revoke` / 停用成员的批量撤权会在数据库层 23514 直接 500。
    await expect(migration.updateTable("session_bindings")
      .set({ status: "revoked", revoked_at: new Date(), archived_at: new Date() })
      .where("id", "=", id).execute()).resolves.toBeDefined();
    expect(await bindingRow(id)).toMatchObject({ status: "revoked" });

    await expect(migration.insertInto("session_bindings").values({
      tenant_id: tenantId, id: randomUUID(), owner_user_id: owner, work_id: workId,
      preset: "novel-unknown" as never, policy_revision: "archive-test", status: "active", revoked_revision: 1,
    }).execute()).rejects.toMatchObject({ code: "23514" });

    // 四个已登记 preset 都能落库。
    for (const preset of ["novel-assistant", "novel-outline", "novel-chapter", "novel-bible"]) {
      await expect(newBinding(preset)).resolves.toEqual(expect.any(String));
    }
  });

  it("归档会话仍可撤权：DELETE 路径（revoke）不被 archived_at 阻塞", async () => {
    const id = await newBinding();
    await sessions.setArchived(tenantId, owner, id, true);

    // 撤权是终态，必须能在归档态上生效（否则 DELETE /sessions/:id 会 500）。
    const revoked = await sessions.revoke(tenantId, owner, id, 1, "归档后由所有者结束会话");
    expect(revoked.status).toBe("revoked");
    expect(revoked.revokedRevision).toBe(2);
    // 归档是展示元数据：撤权不篡改它（也不因此回滚撤权）。
    expect(revoked.archivedAt).not.toBeNull();
    const row = await bindingRow(id);
    expect(row.status).toBe("revoked");
    expect(row.revoked_at).not.toBeNull();

    // 撤权通知照常进 outbox，且只针对这一条绑定。
    const outbox = await migration.selectFrom("outbox_messages").select(["payload"])
      .where("tenant_id", "=", tenantId).where("topic", "=", "session.revoke").execute();
    expect(outbox.filter((message) => (message.payload as { bindingId?: string }).bindingId === id)).toHaveLength(1);

    // 撤权后不能再用归档接口：与既有 410 语义一致（终态不可变）。
    await expect(sessions.setArchived(tenantId, owner, id, false)).rejects.toMatchObject({ code: "revoked", httpStatus: 410 });
  });

  it("归档会话仍可被停用成员的批量撤权（revokeActiveBindingsOfOwner）", async () => {
    const bulkOwner = randomUUID();
    await migration.insertInto("members").values({ tenant_id: tenantId, user_id: bulkOwner, role: "member", status: "active", display_name: "批量撤权对象" }).execute();
    const id = await newBinding("novel-assistant", bulkOwner);
    await sessions.setArchived(tenantId, bulkOwner, id, true);

    const store = new PlatformStore({ db, authorizer: createGovernanceAuthorizer({ authorizePlatform }) });
    const count = await store.withTenant({ tenantId }, (tx) => revokeActiveBindingsOfOwner(tx, {
      actorUserId: admin,
      ownerUserId: bulkOwner,
      reason: "member-disabled: 测试停用成员时批量撤权归档会话",
    }));
    expect(count).toBeGreaterThanOrEqual(1);
    expect((await bindingRow(id)).status).toBe("revoked");
  });

  it("仓储层的未知 preset 拒绝（fail-closed），novel-assistant 成功创建", async () => {
    const store = new PlatformStore({ db, authorizer: createGovernanceAuthorizer({ authorizePlatform }) });
    const repository = new SessionsRepository(store);
    await expect(repository.create(tenantId, owner, { workId, preset: "novel-unknown" as never }))
      .rejects.toMatchObject({ code: "invalid_input", httpStatus: 400 });

    const created = await repository.create(tenantId, owner, { workId, preset: "novel-assistant" });
    expect(created.preset).toBe("novel-assistant");
    expect(created.archivedAt).toBeNull();
    expect(created.status).toBe("creating");
  });
});
