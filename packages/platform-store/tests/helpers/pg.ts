/**
 * PG 集成测试的共享夹具。
 *
 * 两条连接：
 *   * `admin`（迁移角色，本机是 superuser）：建/清测试数据、跑迁移、读内部表；
 *   * `app`（myrix_app，NOBYPASSRLS 非 owner）：模拟真实运行期连接，用于 RLS 负例。
 *
 * 连接串默认指向本仓库约定的本地开发库（deploy/compose.dev.yml），
 * 也可用 MYRIX_TEST_DATABASE_URL / MYRIX_TEST_APP_PASSWORD 覆盖。
 * 数据库不可达时调用方会 `describe.skipIf`，而不是让整个测试套件失败。
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import type { PlatformDatabase } from "../../src/schema";
import { migrateToLatest } from "../../src/migrate";
import type { MigrationDatabase } from "../../src/schema";

export const TEST_ADMIN_URL =
  process.env["MYRIX_TEST_DATABASE_URL"] ??
  "postgres://myrix_migrator:myrix_local_migrator@127.0.0.1:55439/myrix";

export const TEST_APP_PASSWORD = process.env["MYRIX_TEST_APP_PASSWORD"] ?? "myrix_local_app";

/** 测试用的固定租户/用户（与开发 seed 不重叠，避免清库时互相踩） */
export const T = {
  tenantA: "7e000000-0000-4000-8000-00000000000a",
  tenantB: "7e000000-0000-4000-8000-00000000000b",
  authorA: "7e000000-0000-4000-8000-00000000000c",
  adminA: "7e000000-0000-4000-8000-00000000000d",
  editorA: "7e000000-0000-4000-8000-00000000000e",
  auditorA: "7e000000-0000-4000-8000-00000000000f",
  memberB: "7e000000-0000-4000-8000-000000000010",
} as const;

function appUrl(): string {
  const url = new URL(TEST_ADMIN_URL);
  url.username = "myrix_app";
  url.password = TEST_APP_PASSWORD;
  return url.toString();
}

export async function isReachable(): Promise<boolean> {
  const pool = new Pool({ connectionString: TEST_ADMIN_URL, max: 1, connectionTimeoutMillis: 1_500 });
  try {
    await pool.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export interface Harness {
  admin: Kysely<MigrationDatabase>;
  app: Kysely<PlatformDatabase>;
  /** 用 owner 连接直接跑 SQL（清数据、断言内部状态） */
  raw: Kysely<MigrationDatabase>;
  dispose(): Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const adminPool = new Pool({ connectionString: TEST_ADMIN_URL, max: 4, application_name: "myrix-test-admin" });
  const admin = new Kysely<MigrationDatabase>({ dialect: new PostgresDialect({ pool: adminPool }) });
  await migrateToLatest(admin);

  const appPool = new Pool({ connectionString: appUrl(), max: 4, application_name: "myrix-test-app" });
  const app = new Kysely<PlatformDatabase>({ dialect: new PostgresDialect({ pool: appPool }) });

  return {
    admin,
    app,
    raw: admin,
    async dispose() {
      await app.destroy();
      await admin.destroy();
    },
  };
}

/**
 * 重建测试租户与成员。用 owner 连接执行（superuser 绕过 RLS），
 * 但每个租户仍显式设置 set_config，保持与生产写入路径一致。
 */
export async function resetTestFixtures(h: Harness): Promise<void> {
  // 清掉旧数据。superuser 绕过 FORCE RLS，所以这里不需要租户上下文。
  //
  // audit_events 有"只追加"触发器（连 owner 的 DELETE 也会被拒），这是产品行为，
  // 不是缺陷。清测试数据时临时关掉触发器，用完立刻打开 —— 只发生在测试夹具里，
  // 应用路径永远碰不到这个开关。
  await sql`alter table audit_events disable trigger audit_events_append_only`.execute(h.admin);
  try {
    await sql`delete from audit_events where tenant_id in (${T.tenantA}::uuid, ${T.tenantB}::uuid)`.execute(h.admin);
  } finally {
    await sql`alter table audit_events enable trigger audit_events_append_only`.execute(h.admin);
  }
  await sql`delete from outbox_messages where tenant_id in (${T.tenantA}::uuid, ${T.tenantB}::uuid)`.execute(h.admin);
  await sql`delete from commands where tenant_id in (${T.tenantA}::uuid, ${T.tenantB}::uuid)`.execute(h.admin);
  await sql`delete from session_bindings where tenant_id in (${T.tenantA}::uuid, ${T.tenantB}::uuid)`.execute(h.admin);
  await sql`delete from chapter_versions where tenant_id in (${T.tenantA}::uuid, ${T.tenantB}::uuid)`.execute(h.admin);
  await sql`delete from chapters where tenant_id in (${T.tenantA}::uuid, ${T.tenantB}::uuid)`.execute(h.admin);
  await sql`delete from outline_versions where tenant_id in (${T.tenantA}::uuid, ${T.tenantB}::uuid)`.execute(h.admin);
  await sql`delete from outline_documents where tenant_id in (${T.tenantA}::uuid, ${T.tenantB}::uuid)`.execute(h.admin);
  await sql`delete from bible_entry_versions where tenant_id in (${T.tenantA}::uuid, ${T.tenantB}::uuid)`.execute(h.admin);
  await sql`delete from bible_entries where tenant_id in (${T.tenantA}::uuid, ${T.tenantB}::uuid)`.execute(h.admin);
  await sql`delete from works where tenant_id in (${T.tenantA}::uuid, ${T.tenantB}::uuid)`.execute(h.admin);
  await sql`delete from members where tenant_id in (${T.tenantA}::uuid, ${T.tenantB}::uuid)`.execute(h.admin);
  await sql`delete from tenants where id in (${T.tenantA}::uuid, ${T.tenantB}::uuid)`.execute(h.admin);

  for (const tenant of [
    { id: T.tenantA, slug: "myrix-test-a", name: "测试租户 A" },
    { id: T.tenantB, slug: "myrix-test-b", name: "测试租户 B" },
  ]) {
    await h.admin.transaction().execute(async (trx) => {
      await sql`select set_config('myrix.tenant_id', ${tenant.id}, true)`.execute(trx);
      await sql`
        insert into tenants (id, slug, name, status)
        values (${tenant.id}::uuid, ${tenant.slug}, ${tenant.name}, 'active')
      `.execute(trx);
    });
  }

  const members: Array<{ tenant: string; user: string; role: string; name: string }> = [
    { tenant: T.tenantA, user: T.authorA, role: "member", name: "作者 A" },
    { tenant: T.tenantA, user: T.adminA, role: "admin", name: "管理员 A" },
    { tenant: T.tenantA, user: T.editorA, role: "member", name: "编辑 A" },
    { tenant: T.tenantA, user: T.auditorA, role: "auditor", name: "审计员 A" },
    { tenant: T.tenantB, user: T.memberB, role: "member", name: "租户 B 成员" },
  ];
  for (const member of members) {
    await h.admin.transaction().execute(async (trx) => {
      await sql`select set_config('myrix.tenant_id', ${member.tenant}, true)`.execute(trx);
      await sql`
        insert into members (tenant_id, user_id, role, status, display_name)
        values (${member.tenant}::uuid, ${member.user}::uuid, ${member.role}, 'active', ${member.name})
      `.execute(trx);
    });
  }
}

/** 直接以 owner 身份插入一个作品（绕过应用层，用于构造 RLS 负例） */
export async function insertWorkDirect(
  h: Harness,
  tenantId: string,
  ownerUserId: string,
  title = "直插作品",
): Promise<string> {
  const id = crypto.randomUUID();
  await h.admin.transaction().execute(async (trx) => {
    await sql`select set_config('myrix.tenant_id', ${tenantId}, true)`.execute(trx);
    await sql`
      insert into works (tenant_id, id, owner_user_id, title, description)
      values (${tenantId}::uuid, ${id}::uuid, ${ownerUserId}::uuid, ${title}, '')
    `.execute(trx);
  });
  return id;
}
