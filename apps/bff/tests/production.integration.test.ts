import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { migrateToLatest, type MigrationDatabase } from "@myrix/platform-store";
import { makeDevelopmentConfig } from "../scripts/dev-config";
import { migrateAuth } from "../src/auth-store";
import { createProductionBff } from "../src/production";

const businessUrl = process.env.BFF_TEST_DATABASE_URL;
const migrationUrl = process.env.BFF_TEST_MIGRATION_DATABASE_URL;
describe.skipIf(!businessUrl || !migrationUrl)("persistent production BFF assembly with actual LOGIN connections", () => {
  const tenantId = randomUUID(), userId = randomUUID(), adminId = randomUUID();
  const role = `myrix_auth_test_${randomUUID().replaceAll("-", "")}`;
  const password = randomBytes(32).toString("base64url");
  let migration: Kysely<MigrationDatabase>;
  let application: Awaited<ReturnType<typeof createProductionBff>> | undefined;
  let env: Record<string, string>;
  let roleCreated = false;
  beforeAll(async () => {
    const ownerPool = new Pool({ connectionString: migrationUrl!, max: 2 });
    migration = new Kysely<MigrationDatabase>({ dialect: new PostgresDialect({ pool: ownerPool }) });
    await migrateToLatest(migration);
    await sql`create role ${sql.id(role)} login nosuperuser nobypassrls nocreatedb nocreaterole noinherit password ${sql.lit(password)}`.execute(migration);
    roleCreated = true;
    await migrateAuth(ownerPool, role);
    await migration.insertInto("tenants").values({ id: tenantId, slug: `assembly-${tenantId}`, name: "Assembly fixture" }).execute();
    await migration.insertInto("members").values([
      { tenant_id: tenantId, user_id: userId, role: "member", status: "active" },
      { tenant_id: tenantId, user_id: adminId, role: "admin", status: "active" },
    ]).execute();
    const fixture = makeDevelopmentConfig(migrationUrl!, "/unused-test-static-root");
    env = fixture.env;
    delete env.MYRIX_STATIC_ROOT;
    env.DATABASE_URL = businessUrl!;
    const authUrl = new URL(migrationUrl!); authUrl.username = role; authUrl.password = password;
    env.MYRIX_AUTH_DATABASE_URL = authUrl.href;
    env.MYRIX_DEV_USERS = JSON.stringify({ author: { tenantId, userId }, admin: { tenantId, userId: adminId } });
    env.MYRIX_RUNTIME_CELLS_JSON = JSON.stringify([{ tenantId, cellId: fixture.cells[0]!.cellId, baseUrl: "http://127.0.0.1:7801", serviceToken: fixture.cells[0]!.serviceToken }]);
    env.MYRIX_CELL_CREDENTIALS = JSON.stringify([{ tenantId, cellId: fixture.cells[0]!.cellId, token: fixture.cells[0]!.token }]);
    application = await createProductionBff(env);
  }, 30_000);
  afterAll(async () => {
    await application?.close();
    try {
      // The generated role owns no tables; remove this fixture's grants before dropping only that role.
      if (roleCreated && /^myrix_auth_test_[a-f0-9]{32}$/.test(role)) {
        await sql`drop owned by ${sql.id(role)}`.execute(migration);
        await sql`drop role ${sql.id(role)}`.execute(migration);
      }
    } finally { await migration?.destroy(); }
  });
  it("persists server-side login and content across factory reconstruction; admin cannot read another owner's work", async () => {
    const login = await application!.server.inject({ method: "POST", url: "/api/v1/auth/dev-login", headers: { origin: env.MYRIX_ORIGIN! }, payload: { user: "author" } });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const headers = { cookie, origin: env.MYRIX_ORIGIN!, "x-csrf-token": login.json().csrfToken as string };
    const created = await application!.server.inject({ method: "POST", url: "/api/v1/works", headers, payload: { title: "Durable assembly work", description: "" } });
    expect(created.statusCode).toBe(201);
    const work = created.json() as { id: string };
    const session = await application!.server.inject({ method: "POST", url: `/api/v1/works/${work.id}/sessions`, headers, payload: { preset: "novel-chapter" } });
    expect(session.statusCode).toBe(201);
    expect(session.json()).toMatchObject({ status: "creating" });
    const cell = JSON.parse(env.MYRIX_CELL_CREDENTIALS!)[0] as { cellId: string; token: string };
    const snapshotUrl = `/internal/v1/cells/${cell.cellId}/bindings`;
    const unauthenticatedSnapshot = await application!.worksServer.inject({ url: snapshotUrl });
    expect(unauthenticatedSnapshot.statusCode).toBe(401);
    const snapshot = await application!.worksServer.inject({ url: snapshotUrl, headers: { authorization: `Bearer ${cell.token}` } });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({
      cellId: cell.cellId, tenantId,
      policy: { rev: 1, ttlMs: 10_000, tools: ["get_outline", "update_outline", "get_chapter", "save_chapter_draft", "search_bible", "update_bible_entry"] },
      bindings: [{ sid: session.json().id, tid: tenantId, sub: userId, wid: work.id, preset: "novel-chapter", rev: 1 }],
    });
    expect(snapshot.body).not.toContain(cell.token);
    const wrongCell = await application!.worksServer.inject({ url: `/internal/v1/cells/not-this-cell/bindings`, headers: { authorization: `Bearer ${cell.token}` } });
    expect(wrongCell.statusCode).toBe(403);
    await application!.close();
    await application!.close(); // Lifecycle closure is idempotent.
    application = await createProductionBff(env);
    const identity = await application.server.inject({ url: "/api/v1/auth/session", headers: { cookie } });
    expect(identity.statusCode).toBe(200);
    expect(identity.json().identity).toMatchObject({ tenantId, userId });
    const restored = await application.server.inject({ url: `/api/v1/works/${work.id}`, headers: { cookie } });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ id: work.id, title: "Durable assembly work" });
    const adminLogin = await application.server.inject({ method: "POST", url: "/api/v1/auth/dev-login", headers: { origin: env.MYRIX_ORIGIN! }, payload: { user: "admin" } });
    expect(adminLogin.statusCode).toBe(200);
    const adminCookie = String(adminLogin.headers["set-cookie"]).split(";")[0]!;
    const denied = await application.server.inject({ url: `/api/v1/works/${work.id}`, headers: { cookie: adminCookie } });
    expect([403, 404]).toContain(denied.statusCode);
    const outbox = await migration.selectFrom("commands").select(["status", "binding_id"]).where("tenant_id", "=", tenantId).execute();
    expect(outbox).toEqual([{ status: "queued", binding_id: session.json().id }]);
    await migration.updateTable("members").set({ status: "disabled", disabled_at: new Date() }).where("tenant_id", "=", tenantId).where("user_id", "=", userId).execute();
    const revoked = await application.server.inject({ url: "/api/v1/auth/session", headers: { cookie } });
    expect(revoked.statusCode).toBe(401);
  });
  it("refuses owner LOGIN without using its credentials as a fallback", async () => {
    await expect(createProductionBff({ ...env, DATABASE_URL: migrationUrl! })).rejects.toThrow("assembly failed");
  });
});
