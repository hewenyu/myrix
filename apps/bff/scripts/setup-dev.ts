import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { migrateToLatest as migratePlatform } from "../../../packages/platform-store/src/migrate";
import { assertRuntimeDatabase } from "../../../packages/platform-store/src/runtime-db";
import { runSeed } from "../../../packages/platform-store/src/bin/seed";
import type { MigrationDatabase } from "../../../packages/platform-store/src/schema";
import { migrateToLatest as migrateGateway } from "../../model-gateway/src/db/migrate";
import type { GatewayDatabase } from "../../model-gateway/src/db/schema";
import { createPostgresCredentialAdmin } from "../../model-gateway/src/db/credentials";
import { migrateAuth } from "../src/auth-store";
import { developmentDatabase, loadOrCreateDevelopmentConfig } from "./dev-config";

const root = fileURLToPath(new URL("../../../", import.meta.url));

/** Explicit local provisioning only; never invoked by the server entrypoint. */
export async function setupDevelopment(migrationUrl: string) {
  developmentDatabase(migrationUrl);
  const path = resolve(root, "data/dev-runtime.json");
  const config = await loadOrCreateDevelopmentConfig(path, migrationUrl, resolve(root, "apps/novel-web/dist"));
  const pool = new Pool({ connectionString: migrationUrl, max: 2, application_name: "myrix-development-provisioner" });
  const db = new Kysely<MigrationDatabase>({ dialect: new PostgresDialect({ pool }) });
  const gateway = new Kysely<GatewayDatabase>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: migrationUrl, max: 1 }) }) });
  async function ensureLogin(connectionString: string, family: "auth" | "gateway") {
    const url = developmentDatabase(connectionString), role = url.username;
    if (!new RegExp(`^myrix_${family}_dev_[a-f0-9]{10}$`).test(role)) throw new Error("拒绝修改非本地装配专用的认证/网关角色");
    const existing = await sql<{ rolsuper: boolean; rolbypassrls: boolean; rolcreatedb: boolean; rolcreaterole: boolean }>`
      select rolsuper, rolbypassrls, rolcreatedb, rolcreaterole from pg_roles where rolname=${role}`.execute(db);
    const flags = existing.rows[0];
    if (flags && Object.values(flags).some(Boolean)) throw new Error("已有开发角色包含高权限，拒绝静默降级或继续使用");
    if (!flags) await sql`create role ${sql.id(role)} login nosuperuser nobypassrls nocreatedb nocreaterole`.execute(db);
    await sql`alter role ${sql.id(role)} with login password ${sql.lit(decodeURIComponent(url.password))}`.execute(db);
    return role;
  }
  try {
    await migratePlatform(db);
    await runSeed({ connectionString: migrationUrl, appPassword: decodeURIComponent(new URL(config.env.DATABASE_URL!).password) });
    await migrateGateway(gateway);
    const authRole = await ensureLogin(config.env.MYRIX_AUTH_DATABASE_URL!, "auth");
    const gatewayRole = await ensureLogin(config.env.MYRIX_GATEWAY_DATABASE_URL!, "gateway");
    await migrateAuth(pool, authRole);
    await sql`grant myrix_gateway_app to ${sql.id(gatewayRole)}`.execute(db);
    const credentials = createPostgresCredentialAdmin(gateway);
    for (const cell of config.cells) {
      // Re-running uses the same private configuration; explicit regeneration retires old credentials for these local cells.
      await gateway.transaction().execute(async tx => {
        await sql`select set_config('myrix_gateway.tenant_id', ${cell.tenantId}, true)`.execute(tx);
        await sql`update myrix_gateway.cell_credentials set status='disabled', revoked_at=now()
          where tenant_id=${cell.tenantId}::uuid and cell_id=${cell.cellId}`.execute(tx);
      });
      await credentials.upsert(cell);
    }
    const checks: [string, string[], boolean][] = [
      [config.env.DATABASE_URL!, ["public.tenants", "public.members", "public.works", "public.session_bindings", "public.commands"], true],
      [config.env.MYRIX_AUTH_DATABASE_URL!, ["myrix_auth.sessions", "myrix_auth.flows", "myrix_auth.subjects"], false],
      [config.env.MYRIX_GATEWAY_DATABASE_URL!, ["myrix_gateway.quota_reservations"], true],
    ];
    for (const [connectionString, tables, requireRls] of checks) {
      const runtime = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 1 }) }) });
      try { await assertRuntimeDatabase(runtime, tables, { requireRls }); }
      finally { await runtime.destroy(); }
    }
    return { path, cells: config.cells.length };
  } finally { await Promise.all([db.destroy(), gateway.destroy()]); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const connection = process.env.MYRIX_MIGRATE_DATABASE_URL;
  if (!connection) {
    console.error("缺少 MYRIX_MIGRATE_DATABASE_URL；开发装配只接受 loopback:55439 的 myrix/myrix_* 库");
    process.exitCode = 1;
  } else {
    setupDevelopment(connection).then(({ cells }) => {
      console.log(`开发迁移、身份与 ${cells} 个 Cell 凭据已就绪；私有配置保存于 data/dev-runtime.json（0600，不输出秘密）`);
      console.log("运行服务只使用独立低权限 LOGIN；请勿将迁移连接传给服务进程。");
    }).catch(() => {
      console.error("开发装配失败：请检查专用本地数据库、迁移权限、已有配置归属及文件权限。未回显连接串或凭据。");
      process.exitCode = 1;
    });
  }
}
