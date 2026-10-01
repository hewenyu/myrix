import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { PlatformStore } from "../../../packages/platform-store/src/store";
import { assertRuntimeDatabase } from "../../../packages/platform-store/src/runtime-db";
import { migrateToLatest } from "../../../packages/platform-store/src/migrate";
import type { MigrationDatabase, PlatformDatabase } from "../../../packages/platform-store/src/schema";
import { createGatewayBusinessReaders } from "../src/business-reader";
import { createAuthorizer } from "../src/authorize";
import { createProductionGateway } from "../src/production";
import { migrateToLatest as migrateGateway } from "../src/db/migrate";
import { createPostgresCredentialAdmin } from "../src/db/credentials";
import type { GatewayDatabase } from "../src/db/schema";

const appUrl = process.env.BFF_TEST_DATABASE_URL;
const migrationUrl = process.env.BFF_TEST_MIGRATION_DATABASE_URL;
describe.skipIf(!appUrl || !migrationUrl)("gateway business reads under real LOGIN RLS", () => {
  const tid = randomUUID(), uid = randomUUID(), sid = randomUUID(), wid = randomUUID();
  let migration: Kysely<MigrationDatabase>;
  let db: Kysely<PlatformDatabase>;
  let readers: ReturnType<typeof createGatewayBusinessReaders>;
  let authorizer: ReturnType<typeof createAuthorizer>;
  beforeAll(async () => {
    migration = new Kysely<MigrationDatabase>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: migrationUrl, max: 1 }) }) });
    db = new Kysely<PlatformDatabase>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: appUrl, max: 2 }) }) });
    await migrateToLatest(migration);
    const role = await sql<{ login: boolean; rolsuper: boolean; rolbypassrls: boolean; owns: boolean }>`select current_user=session_user as login, r.rolsuper, r.rolbypassrls, c.relowner=r.oid as owns from pg_roles r cross join pg_class c where r.rolname=current_user and c.oid='session_bindings'::regclass`.execute(db);
    expect(role.rows[0]).toEqual({ login: true, rolsuper: false, rolbypassrls: false, owns: false });
    await migration.insertInto("tenants").values({ id: tid, slug: `gateway-reader-${tid}`, name: "Gateway reader integration" }).execute();
    await migration.insertInto("members").values({ tenant_id: tid, user_id: uid, role: "member", status: "active" }).execute();
    await migration.insertInto("works").values({ tenant_id: tid, id: wid, owner_user_id: uid, title: "Private", description: "" }).execute();
    await migration.insertInto("session_bindings").values({ tenant_id: tid, id: sid, owner_user_id: uid, work_id: wid, preset: "novel-chapter", status: "active", policy_revision: "test-v1", cell_id: "reader-cell" }).execute();
    readers = createGatewayBusinessReaders(new PlatformStore({ db }));
    // Only credential resolution is injected here; all business authorization reads use real PostgreSQL.
    authorizer = createAuthorizer({ ...readers, async resolveCredential(token) {
      return token === "fixture-cell-token" ? { tenantId: tid, cellId: "reader-cell" } : undefined;
    } });
  });
  afterAll(async () => { await db?.destroy(); await migration?.destroy(); });
  const authorize = (claimedRevision = 1) => authorizer.authorize({ token: "fixture-cell-token", sessionId: sid, claimedRevision });

  it("assembles persistent credentials/accounting with a real gateway LOGIN and survives server recreation", async () => {
    // Same database, different type projection; all migration operations remain on the opt-in owner connection.
    const gatewayAdmin = migration as unknown as Kysely<GatewayDatabase>;
    await migrateGateway(gatewayAdmin);
    const roleName = `myrix_gw_test_${randomUUID().replaceAll("-", "")}`;
    const password = randomUUID(), cellToken = randomUUID();
    await sql`create role ${sql.id(roleName)} login password ${sql.lit(password)} nosuperuser nobypassrls nocreatedb nocreaterole`.execute(migration);
    let assembled: Awaited<ReturnType<typeof createProductionGateway>> | undefined;
    try {
      await sql`grant myrix_gateway_app to ${sql.id(roleName)}`.execute(migration);
      const ledgerUrl = new URL(migrationUrl!);
      ledgerUrl.username = roleName; ledgerUrl.password = password;
      const credentials = createPostgresCredentialAdmin(gatewayAdmin);
      await credentials.upsert({ token: cellToken, tenantId: tid, cellId: "reader-cell" });
      await credentials.upsert({ token: cellToken, tenantId: tid, cellId: "reader-cell" });
      await expect(credentials.upsert({ token: cellToken, tenantId: randomUUID(), cellId: "reader-cell" })).rejects.toThrow("禁止");
      await expect(credentials.upsert({ token: cellToken, tenantId: tid, cellId: "different-cell" })).rejects.toThrow("禁止");
      const env = { DATABASE_URL: appUrl!, MYRIX_GATEWAY_DATABASE_URL: ledgerUrl.toString(),
        MYRIX_GATEWAY_UPSTREAM_URL: "http://127.0.0.1:1/v1/responses", MYRIX_GATEWAY_UPSTREAM_MODEL: "fixture-model" };
      assembled = await createProductionGateway(env);
      expect(assembled.runtime.diagnostics).toMatchObject({ credentialSource: "port", ledger: "injected", upstreamConfigured: false });
      expect(await assembled.runtime.authorizer.authorize({ token: cellToken, sessionId: sid, claimedRevision: 1 })).toMatchObject({ effect: "allow" });
      expect(await assembled.runtime.authorizer.authorize({ token: "not-registered", sessionId: sid, claimedRevision: 1 })).toMatchObject({ effect: "deny" });
      const unavailable = await assembled.server.inject({ method: "POST", url: "/v1/responses",
        headers: { authorization: `Bearer ${cellToken}`, "x-myrix-session": sid, "x-myrix-revision": "1" },
        payload: { model: "fixture-model", input: [{ role: "user", content: "Do not send to a model without a key" }] } });
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json()).toMatchObject({ error: { code: "model_not_configured" } });
      const untouched = await sql<{ count: string }>`select count(*)::text as count from myrix_gateway.quota_reservations where tenant_id=${tid}::uuid`.execute(migration);
      expect(untouched.rows[0]?.count).toBe("0");
      const reservation = { requestId: randomUUID(), tenantId: tid, userId: uid, sessionId: sid, cellId: "reader-cell", model: "fixture-model", reservedTokens: 100 };
      expect(await assembled.runtime.ledger.tryReserve(reservation)).toMatchObject({ ok: true, replayed: false });
      await assembled.server.close(); assembled = undefined;
      assembled = await createProductionGateway(env);
      expect(await assembled.runtime.ledger.tryReserve(reservation)).toMatchObject({ ok: true, replayed: true });
      await assembled.runtime.ledger.release(reservation.requestId, tid, "test complete");
      await credentials.revoke(cellToken);
      expect(await assembled.runtime.authorizer.authorize({ token: cellToken, sessionId: sid, claimedRevision: 1 })).toMatchObject({ effect: "deny" });
    } finally {
      await assembled?.server.close();
      // This random, per-test role owns no objects and is never reused by another process.
      await sql`drop role ${sql.id(roleName)}`.execute(migration);
    }
  }, 15_000);

  it("permits the nonowner runtime LOGIN but rejects migration credentials and missing schemas", async () => {
    await expect(assertRuntimeDatabase(db, ["public.tenants", "public.members", "public.works", "public.session_bindings"])).resolves.toBeUndefined();
    await expect(assertRuntimeDatabase(migration, ["public.session_bindings"])).rejects.toThrow("独立非特权 LOGIN");
    await expect(assertRuntimeDatabase(db, ["public.no_such_myrix_runtime_table"])).rejects.toThrow("表缺失");
  });
  it("resolves only a current matching principal and rejects stale revisions", async () => {
    expect(await authorize()).toMatchObject({ effect: "allow", principal: { tenantId: tid, userId: uid, sessionId: sid, revision: 1 } });
    expect(await authorize(2)).toMatchObject({ effect: "deny", statusCode: 403 });
  });
  it("cannot read another tenant or leave a tenant GUC on the pooled connection", async () => {
    expect(await readers.loadSessionBinding(randomUUID(), sid)).toBeUndefined();
    expect(await readers.loadMember(randomUUID(), uid)).toBeUndefined();
    expect(await db.selectFrom("session_bindings").select("id").execute()).toEqual([]);
  });
  it("denies a deleted work even while its session binding remains active", async () => {
    await migration.updateTable("works").set({ status: "deleted" }).where("id", "=", wid).execute();
    try { expect(await authorize()).toMatchObject({ effect: "deny", code: "unknown_session" }); }
    finally { await migration.updateTable("works").set({ status: "active" }).where("id", "=", wid).execute(); }
  });
  it("denies disabled members and suspended tenants without cached authority", async () => {
    await migration.updateTable("members").set({ status: "disabled", disabled_at: new Date() }).where("tenant_id", "=", tid).where("user_id", "=", uid).execute();
    try { expect(await authorize()).toMatchObject({ effect: "deny", statusCode: 403 }); }
    finally { await migration.updateTable("members").set({ status: "active", disabled_at: null }).where("tenant_id", "=", tid).where("user_id", "=", uid).execute(); }
    await migration.updateTable("tenants").set({ status: "suspended" }).where("id", "=", tid).execute();
    try {
      expect(await readers.loadMember(tid, uid)).toBeUndefined();
      expect(await authorize()).toMatchObject({ effect: "deny", code: "unknown_session" });
    } finally { await migration.updateTable("tenants").set({ status: "active" }).where("id", "=", tid).execute(); }
  });
});
