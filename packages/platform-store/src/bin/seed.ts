#!/usr/bin/env tsx
/**
 * 开发种子：`pnpm --filter @myrix/platform-store seed:dev`
 *
 * 只做三件事，且**只允许对本地开发库执行**（连接串主机必须是 loopback）：
 *
 *   1. 幂等地写入固定 UUID 的开发租户与成员，供 BFF 的 dev-login 使用
 *      （`author` / `editor` / `other-tenant`，见 docs/implementation/platform-store.md）。
 *   2. 给应用角色 `myrix_app` 设置开发密码（默认 `myrix_local_app`），
 *      密码只在本机 loopback 库上设置，绝不写进迁移或版本库。
 *   3. 打印应用角色的连接串，便于本地起 BFF。
 *
 * 这些 ID 是**测试夹具**，不是生产标识；BFF 只能把 dev-login 映射到这里的
 * 固定身份，不能接受浏览器传入任意 userId。
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import { DEFAULT_APP_ROLE } from "../db";
import type { MigrationDatabase } from "../schema";

// ---------------------------------------------------------------------------
// 固定开发身份（UUIDv4 形状，值固定是为了让 BFF / 前端 / 测试可以对拍）
// ---------------------------------------------------------------------------

/** 主租户（author 与 admin 都是这里的成员） */
export const DEV_TENANT_ID = "11111111-1111-4111-8111-111111111111";
export const DEV_TENANT_SLUG = "myrix-dev";
/** 第二个租户：用于跨租户负例（other-tenant 看自己的作品，看不到主租户任何东西） */
export const DEV_OTHER_TENANT_ID = "22222222-2222-4222-8222-222222222222";
export const DEV_OTHER_TENANT_SLUG = "myrix-other";

/** admin：成员治理与会话撤销；**没有**读取他人作品/会话内容的权限 */
export const DEV_ADMIN_USER_ID = "a0000000-0000-4000-8000-000000000001";
/** author：作品所有者之一（与 editor 同租户但互相看不到对方的作品） */
export const DEV_AUTHOR_USER_ID = "a0000000-0000-4000-8000-000000000002";
/** editor：同租户的另一个独立所有者 */
export const DEV_EDITOR_USER_ID = "a0000000-0000-4000-8000-000000000003";
/** other-tenant：另一个租户的成员，任何跨租户访问都必须被拒绝 */
export const DEV_OTHER_USER_ID = "b0000000-0000-4000-8000-000000000001";

export interface DevIdentity {
  /** BFF `/auth/dev-login` 接受的名字 */
  login: string;
  tenantId: string;
  userId: string;
  role: "admin" | "member" | "auditor";
  displayName: string;
}

export const DEV_IDENTITIES: readonly DevIdentity[] = [
  {
    login: "admin",
    tenantId: DEV_TENANT_ID,
    userId: DEV_ADMIN_USER_ID,
    role: "admin",
    displayName: "开发管理员",
  },
  {
    login: "author",
    tenantId: DEV_TENANT_ID,
    userId: DEV_AUTHOR_USER_ID,
    role: "member",
    displayName: "开发作者",
  },
  {
    login: "editor",
    tenantId: DEV_TENANT_ID,
    userId: DEV_EDITOR_USER_ID,
    role: "member",
    displayName: "开发编辑",
  },
  {
    login: "other-tenant",
    tenantId: DEV_OTHER_TENANT_ID,
    userId: DEV_OTHER_USER_ID,
    role: "member",
    displayName: "异租户成员",
  },
];

const DEFAULT_DEV_APP_PASSWORD = "myrix_local_app";

/** 只允许 loopback：避免有人把开发密码种到 staging/生产库上。 */
export function assertLoopback(connectionString: string): URL {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("myrix: seed 的连接串不是合法 URL");
  }
  const host = url.hostname;
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost" || host === "[::1]";
  if (!loopback) {
    throw new Error(
      `myrix: seed:dev 只允许对 loopback 数据库执行，收到主机 ${host}；开发密码不得写入其他环境`,
    );
  }
  return url;
}

export interface SeedResult {
  identities: readonly DevIdentity[];
  appRole: string;
  appConnectionString: string;
}

export async function runSeed(options: { connectionString: string; appPassword?: string }): Promise<SeedResult> {
  const url = assertLoopback(options.connectionString);
  const appPassword = options.appPassword ?? process.env["MYRIX_APP_PASSWORD"] ?? DEFAULT_DEV_APP_PASSWORD;

  const pool = new Pool({ connectionString: options.connectionString, max: 1, application_name: "myrix-seed" });
  const db = new Kysely<MigrationDatabase>({ dialect: new PostgresDialect({ pool }) });

  try {
    // 租户 + 成员：以迁移角色写入，此时还没有租户上下文，RLS 会挡住普通连接，
    // 但表 owner 在 FORCE RLS 下同样受策略约束，因此这里显式设置租户上下文，
    // 逐租户 upsert（这也是"应用在正确上下文中写入"的示范）。
    for (const tenant of [
      { id: DEV_TENANT_ID, slug: DEV_TENANT_SLUG, name: "Myrix 开发租户" },
      { id: DEV_OTHER_TENANT_ID, slug: DEV_OTHER_TENANT_SLUG, name: "Myrix 异租户（负例）" },
    ]) {
      await db.transaction().execute(async (trx) => {
        await sql`select set_config('myrix.tenant_id', ${tenant.id}, true)`.execute(trx);
        await sql`
          insert into tenants (id, slug, name, status)
          values (${tenant.id}::uuid, ${tenant.slug}, ${tenant.name}, 'active')
          on conflict (id) do update set slug = excluded.slug, name = excluded.name, status = 'active'
        `.execute(trx);

        for (const identity of DEV_IDENTITIES.filter((item) => item.tenantId === tenant.id)) {
          await sql`
            insert into members (tenant_id, user_id, role, status, display_name)
            values (${tenant.id}::uuid, ${identity.userId}::uuid, ${identity.role}, 'active', ${identity.displayName})
            on conflict (tenant_id, user_id) do update
              set role = excluded.role, status = 'active', disabled_at = null, display_name = excluded.display_name
          `.execute(trx);
        }
      });
    }

    // 应用角色：只加密码，其余收紧属性（NOSUPERUSER/NOBYPASSRLS/NOCREATEDB/NOCREATEROLE）
    // 由 0000 迁移与这里的断言共同保证。
    const role = await sql<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
    }>`
      select rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
      from pg_roles where rolname = ${DEFAULT_APP_ROLE}
    `.execute(db);
    const row = role.rows[0];
    if (!row) {
      throw new Error(
        `myrix: 应用角色 ${DEFAULT_APP_ROLE} 不存在；请先用迁移角色跑完迁移（pnpm --filter @myrix/platform-store migrate）`,
      );
    }
    if (row.rolsuper || row.rolbypassrls || row.rolcreatedb || row.rolcreaterole) {
      throw new Error(
        `myrix: 应用角色 ${DEFAULT_APP_ROLE} 权限过大（super=${row.rolsuper}, bypassrls=${row.rolbypassrls}, ` +
          `createdb=${row.rolcreatedb}, createrole=${row.rolcreaterole}）；RLS 会被绕过，拒绝继续`,
      );
    }
    if (appPassword.length < 12) {
      throw new Error("myrix: 开发密码至少 12 个字符");
    }
    // 密码用参数化不了的 DDL：用 quote_literal 显式转义，避免拼接注入
    const quoted = await sql<{ literal: string }>`select quote_literal(${appPassword}) as literal`.execute(db);
    const literal = quoted.rows[0]?.literal;
    if (!literal) throw new Error("myrix: 无法为应用角色生成密码字面量");
    await sql
      .raw(`alter role ${DEFAULT_APP_ROLE} with login password ${literal}`)
      .execute(db);

    const appUrl = new URL(url.toString());
    appUrl.username = DEFAULT_APP_ROLE;
    appUrl.password = appPassword;

    return {
      identities: DEV_IDENTITIES,
      appRole: DEFAULT_APP_ROLE,
      appConnectionString: appUrl.toString(),
    };
  } finally {
    // Kysely 的 destroy() 会关掉 PostgresDialect 持有的 pool；不要再 pool.end()
    await db.destroy();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");
if (invokedDirectly) {
  const connectionString = process.env["MYRIX_MIGRATE_DATABASE_URL"];
  if (!connectionString) {
    console.error("myrix: 缺少 MYRIX_MIGRATE_DATABASE_URL（seed 需要 owner/迁移角色）");
    process.exitCode = 1;
  } else {
    runSeed({ connectionString })
      .then((result) => {
        console.log(`seed: ${result.identities.length} identities`);
        for (const identity of result.identities) {
          console.log(
            `  ${identity.login.padEnd(13)} tenant=${identity.tenantId} user=${identity.userId} role=${identity.role}`,
          );
        }
        console.log(`app role: ${result.appRole}`);
        console.log(`app url : ${result.appConnectionString}`);
      })
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      });
  }
}
