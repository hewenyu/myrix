import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { authorizePlatform } from "@myrix/governance";
import type { PlatformIdentity } from "@myrix/contracts";
import { PlatformStore } from "../../../packages/platform-store/src/store";
import { createGovernanceAuthorizer } from "../../../packages/platform-store/src/authz";
import { migrateToLatest } from "../../../packages/platform-store/src/migrate";
import { SessionsRepository } from "../../../packages/platform-store/src/repositories/bindings";
import type { MigrationDatabase, PlatformDatabase } from "../../../packages/platform-store/src/schema";
import { PostgresNovelRepository } from "../src/novel-store";
import { CellCredentialRegistry, createWorksExecutor, createBindingSnapshotReader, loadIdentity } from "../src/works-server";

const appUrl = process.env.BFF_TEST_DATABASE_URL;
const migrationUrl = process.env.BFF_TEST_MIGRATION_DATABASE_URL;
// Opt-in, dedicated database only. Never switches role on the owner connection; no tables/data are deleted.
describe.skipIf(!appUrl || !migrationUrl)("BFF real nonowner PostgreSQL integration", () => {
  const tenantId = randomUUID();
  const owner: PlatformIdentity = { tenantId, userId: randomUUID(), role: "member", displayName: "作者" };
  const admin: PlatformIdentity = { tenantId, userId: randomUUID(), role: "admin", displayName: "管理员" };
  const foreign: PlatformIdentity = { tenantId: randomUUID(), userId: randomUUID(), role: "member", displayName: "其他租户" };
  let migration: Kysely<MigrationDatabase>;
  let db: Kysely<PlatformDatabase>;
  let store: PlatformStore;
  let repository: PostgresNovelRepository;
  let workId: string;
  let secondWorkId: string;
  let chapterId: string;
  const sid = randomUUID();
  const token = `test-cell-${randomUUID()}`;
  let execute: ReturnType<typeof createWorksExecutor>;

  beforeAll(async () => {
    migration = new Kysely<MigrationDatabase>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: migrationUrl, max: 1 }) }) });
    db = new Kysely<PlatformDatabase>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: appUrl, max: 3 }) }) });
    await migrateToLatest(migration);
    const roles = await sql<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean; owns: boolean }>`select current_user, r.rolsuper, r.rolbypassrls, (c.relowner = r.oid) as owns from pg_roles r cross join pg_class c where r.rolname=current_user and c.oid='works'::regclass`.execute(db);
    expect(roles.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false, owns: false });
    await migration.insertInto("tenants").values([
      { id: tenantId, slug: `bff-${tenantId}`, name: "BFF integration A" },
      { id: foreign.tenantId, slug: `bff-${foreign.tenantId}`, name: "BFF integration B" },
    ]).execute();
    await migration.insertInto("members").values([owner, admin, foreign].map(actor => ({ tenant_id: actor.tenantId, user_id: actor.userId, role: actor.role, status: "active" as const, display_name: actor.displayName }))).execute();
    store = new PlatformStore({ db, authorizer: createGovernanceAuthorizer({ authorizePlatform }) });
    repository = new PostgresNovelRepository(store);
    workId = (await repository.createWork(owner, { title: "作品 A", description: "" })).id;
    secondWorkId = (await repository.createWork(owner, { title: "作品 B", description: "" })).id;
    chapterId = (await repository.createChapter(owner, workId, { title: "第一章" })).id;
    await migration.insertInto("session_bindings").values({ tenant_id: tenantId, id: sid, owner_user_id: owner.userId, work_id: workId, preset: "novel-chapter", policy_revision: "test-v1", cell_id: "test-cell", status: "active", revoked_revision: 1 }).execute();
    execute = createWorksExecutor(store, new CellCredentialRegistry([{ tenantId, cellId: "test-cell", token }]));
  }, 30_000);
  afterAll(async () => { await db?.destroy(); await migration?.destroy(); });

  it("does not expose another owner's content even to admin, or another tenant", async () => {
    expect(await repository.listWorks(admin)).toEqual([]);
    await expect(repository.getWork(admin, workId)).rejects.toMatchObject({ statusCode: 403 });
    await expect(repository.getWork(foreign, workId)).rejects.toMatchObject({ statusCode: 404 });
    expect(await db.selectFrom("works").selectAll().execute()).toEqual([]);
  });
  it("binds nested chapter to requested work and has saved/duplicate/conflict CAS", async () => {
    await expect(repository.getChapter(owner, secondWorkId, chapterId)).rejects.toMatchObject({ statusCode: 404 });
    expect(await repository.saveChapter(owner, workId, chapterId, { text: "原稿", expectedVersion: 0 })).toMatchObject({ status: "saved", version: 1 });
    expect(await repository.saveChapter(owner, workId, chapterId, { text: "原稿", expectedVersion: 0 })).toMatchObject({ status: "duplicate", version: 1 });
    expect(await repository.saveChapter(owner, workId, chapterId, { text: "不同草稿", expectedVersion: 0 })).toEqual({ status: "conflict", version: 1 });
    expect(await repository.chapterVersions(owner, workId, chapterId)).toHaveLength(1);
    expect((await repository.getChapter(owner, workId, chapterId)).text).toBe("原稿");
  });
  it("persists outline and bible text, including explicit conflicts", async () => {
    expect(await repository.saveOutline(owner, workId, { text: "大纲", expectedVersion: 0 })).toMatchObject({ status: "saved", version: 1 });
    expect(await repository.saveOutline(owner, workId, { text: "大纲", expectedVersion: 0 })).toMatchObject({ status: "duplicate", version: 1 });
    expect(await repository.getOutline(owner, workId)).toMatchObject({ text: "大纲", version: 1 });
    const entry = await repository.createBible(owner, workId, { title: "世界", kind: "setting", text: "最初设定" });
    expect(entry).toMatchObject({ kind: "setting", title: "世界", text: "最初设定" });
    expect(await repository.saveBible(owner, workId, entry.id, { text: "修订设定", expectedVersion: 0 })).toMatchObject({ status: "saved", version: 1 });
    expect(await repository.saveBible(owner, workId, entry.id, { text: "修订设定", expectedVersion: 0 })).toMatchObject({ status: "duplicate", version: 1 });
    expect(await repository.listBible(owner, workId, "修订")).toHaveLength(1);
  });
  it("resolves tool owner/work from binding, rejects preset and stale revision", async () => {
    await expect(execute(`Bearer ${token}`, sid, 1, "get_chapter", { chapterId })).resolves.toMatchObject({ workId, id: chapterId });
    await expect(execute(`Bearer ${token}`, sid, 0, "get_outline", {})).rejects.toMatchObject({ statusCode: 403 });
    await expect(execute(`Bearer ${token}`, sid, 1, "update_outline", { text: "x", expectedVersion: 1 })).rejects.toMatchObject({ statusCode: 403 });
    const otherChapter = await repository.createChapter(owner, secondWorkId, { title: "其他作品" });
    await expect(execute(`Bearer ${token}`, sid, 1, "get_chapter", { chapterId: otherChapter.id })).rejects.toMatchObject({ statusCode: 404 });
  });
  it("exposes only current owner bindings to the authenticated Cell, without content", async () => {
    const readSnapshot = createBindingSnapshotReader(store, new CellCredentialRegistry([{ tenantId, cellId: "test-cell", token }]));
    await expect(readSnapshot(undefined, "test-cell")).rejects.toMatchObject({ statusCode: 401 });
    await expect(readSnapshot(`Bearer ${token}`, "another-cell")).rejects.toMatchObject({ statusCode: 403 });
    expect(await readSnapshot(`Bearer ${token}`, "test-cell")).toEqual({ tenantId, cellId: "test-cell", bindings: [
      { sid, tid: tenantId, sub: owner.userId, wid: workId, preset: "novel-chapter", rev: 1 },
    ] });
    await migration.updateTable("works").set({ status: "deleted" }).where("id", "=", workId).execute();
    try {
      expect((await readSnapshot(`Bearer ${token}`, "test-cell")).bindings).toEqual([]);
      await expect(execute(`Bearer ${token}`, sid, 1, "get_outline", {})).rejects.toMatchObject({ statusCode: 403, code: "work_unavailable" });
    } finally {
      await migration.updateTable("works").set({ status: "active" }).where("id", "=", workId).execute();
    }
  });
  it("holds binding and work locks through a blocked content write", async () => {
    let release!: () => void;
    let locked!: () => void;
    let reading!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const chapterLocked = new Promise<void>(resolve => { locked = resolve; });
    const toolReading = new Promise<void>(resolve => { reading = resolve; });
    const blocker = store.withTenant({ tenantId, actorUserId: owner.userId }, async tx => {
      await tx.trx.selectFrom("chapters").select("id").where("id", "=", chapterId).forUpdate().executeTakeFirstOrThrow();
      locked();
      await released;
    });
    await chapterLocked;
    const observedStore = new PlatformStore({ db, authorizer: request => {
      if (request.action === "chapters:read") reading();
      return store.authorizer(request);
    } });
    const observedExecutor = createWorksExecutor(observedStore, new CellCredentialRegistry([{ tenantId, cellId: "test-cell", token }]));
    const saving = observedExecutor(`Bearer ${token}`, sid, 1, "save_chapter_draft", { chapterId, text: "并发合法保存", expectedVersion: 1 });
    try {
      await toolReading;
      await expect(store.withTenant({ tenantId, actorUserId: owner.userId }, async tx => {
        await sql`set local lock_timeout = '100ms'`.execute(tx.trx);
        await tx.trx.updateTable("session_bindings").set({ status: "revoked", revoked_revision: 2, revoked_at: new Date() }).where("id", "=", sid).execute();
      })).rejects.toMatchObject({ code: "55P03" });
      await expect(store.withTenant({ tenantId, actorUserId: owner.userId }, async tx => {
        await sql`set local lock_timeout = '100ms'`.execute(tx.trx);
        await tx.trx.updateTable("works").set({ status: "deleted" }).where("id", "=", workId).execute();
      })).rejects.toMatchObject({ code: "55P03" });
    } finally {
      release();
      await blocker;
    }
    await expect(saving).resolves.toMatchObject({ status: "saved", version: 2 });
  }, 10_000);
  it("archives and restores a session: snapshot, tool executor and listing agree", async () => {
    const archiveWorkId = (await repository.createWork(owner, { title: "作品 归档", description: "" })).id;
    const archiveSid = randomUUID();
    await migration.insertInto("session_bindings").values({
      tenant_id: tenantId, id: archiveSid, owner_user_id: owner.userId, work_id: archiveWorkId,
      preset: "novel-assistant", policy_revision: "test-v1", cell_id: "test-cell", status: "active", revoked_revision: 1,
    }).execute();
    const readSnapshot = createBindingSnapshotReader(store, new CellCredentialRegistry([{ tenantId, cellId: "test-cell", token }]));
    const snapshotIds = async () => (await readSnapshot(`Bearer ${token}`, "test-cell")).bindings.map((binding) => binding.sid);

    // 统一助手 preset 是六工具全集：以前只属于历史 preset 的工具现在同一会话都可用。
    await expect(execute(`Bearer ${token}`, archiveSid, 1, "update_outline", { text: "统一助手写大纲", expectedVersion: 0 }))
      .resolves.toMatchObject({ status: "saved" });
    expect(await snapshotIds()).toContain(archiveSid);

    // 归档（所有者本人）：只整理历史，不改工具权限/快照；列表仍可读并带 archivedAt。
    const archived = await repository.listSessions(owner, archiveWorkId);
    expect(archived.find((session) => session.id === archiveSid)?.archivedAt).toBeNull();
    const sessions = new SessionsRepository(store);
    const archivedRow = await sessions.setArchived(tenantId, owner.userId, archiveSid, true);
    expect(archivedRow.archivedAt).not.toBeNull();
    // 快照与工具权限都不因归档改变：归档不停止任务，Cell 仍要能服务这条会话。
    expect(await snapshotIds()).toContain(archiveSid);
    await expect(execute(`Bearer ${token}`, archiveSid, 1, "get_outline", {}))
      .resolves.toMatchObject({ version: 1 });
    await expect(execute(`Bearer ${token}`, archiveSid, 1, "update_outline", { text: "归档期间继续写", expectedVersion: 1 }))
      .resolves.toMatchObject({ status: "saved", version: 2 });
    const listed = await repository.listSessions(owner, archiveWorkId);
    expect(listed.find((session) => session.id === archiveSid)).toMatchObject({ status: "active", archivedAt: archivedRow.archivedAt });

    // 归档会话仍可被所有者撤权（DELETE /sessions/:id 的存储路径）：
    // 归档与撤权正交，撤权是终态且必须成功（否则会撞上数据库 23514 → 500）。
    const revokedAfterArchive = await sessions.revoke(tenantId, owner.userId, archiveSid, 1, "归档后结束会话");
    expect(revokedAfterArchive).toMatchObject({ status: "revoked", revokedRevision: 2 });
    // 撤权后归档接口一律 410（终态不可变）。
    await expect(sessions.setArchived(tenantId, owner.userId, archiveSid, false)).rejects.toMatchObject({ code: "revoked", httpStatus: 410 });

    // 非所有者（含管理员）不能归档/恢复：统一 not_found（不泄漏存在性）。
    const standalone = randomUUID();
    await migration.insertInto("session_bindings").values({
      tenant_id: tenantId, id: standalone, owner_user_id: owner.userId, work_id: archiveWorkId,
      preset: "novel-assistant", policy_revision: "test-v1", cell_id: "test-cell", status: "active", revoked_revision: 1,
    }).execute();
    await expect(sessions.setArchived(tenantId, admin.userId, standalone, true)).rejects.toMatchObject({ code: "not_found", httpStatus: 404 });
    await expect(sessions.setArchived(foreign.tenantId, foreign.userId, standalone, true)).rejects.toMatchObject({ code: "not_found", httpStatus: 404 });
    // 恢复：快照仍在、工具调用照旧；rev 与 status 全程未变。
    await sessions.setArchived(tenantId, owner.userId, standalone, true);
    expect(await snapshotIds()).toContain(standalone);
    await sessions.setArchived(tenantId, owner.userId, standalone, false);
    expect(await snapshotIds()).toContain(standalone);
    expect(await repository.listSessions(owner, archiveWorkId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: standalone, status: "active", archivedAt: null }),
    ]));
  }, 30_000);

  it("revocation and membership disabling deny the next operation without cached authority", async () => {
    await migration.updateTable("session_bindings").set({ status: "revoked", revoked_revision: 2, revoked_at: new Date() }).where("id", "=", sid).execute();
    await expect(execute(`Bearer ${token}`, sid, 1, "get_outline", {})).rejects.toMatchObject({ statusCode: 403 });
    await migration.updateTable("members").set({ status: "disabled", disabled_at: new Date() }).where("tenant_id", "=", tenantId).where("user_id", "=", owner.userId).execute();
    expect(await loadIdentity(store, owner)).toBeUndefined();
    const readSnapshot = createBindingSnapshotReader(store, new CellCredentialRegistry([{ tenantId, cellId: "test-cell", token }]));
    expect((await readSnapshot(`Bearer ${token}`, "test-cell")).bindings).toEqual([]);
    await expect(repository.getWork(owner, workId)).rejects.toMatchObject({ statusCode: 403 });
  });
});
