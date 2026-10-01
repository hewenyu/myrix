#!/usr/bin/env tsx
/**
 * 迁移入口：`pnpm --filter @myrix/platform-store migrate`
 *
 * 必须用**迁移角色**（库 owner）的连接串，例如本地开发：
 *   MYRIX_MIGRATE_DATABASE_URL=postgres://myrix_migrator:...@127.0.0.1:55439/myrix
 *
 * 绝不使用应用角色 myrix_app 跑迁移：它连建表权限都没有，也不该有。
 */

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

import { migrateToLatest } from "../migrate";
import type { MigrationDatabase } from "../schema";

function requireUrl(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`myrix: 缺少环境变量 ${name}（迁移必须使用 owner/迁移角色的连接串）`);
  }
  return value;
}

export async function runMigrate(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString, max: 1, application_name: "myrix-migrate" });
  const db = new Kysely<MigrationDatabase>({ dialect: new PostgresDialect({ pool }) });
  try {
    const result = await migrateToLatest(db);
    for (const name of result.skipped) console.log(`skip    ${name}`);
    for (const name of result.applied) console.log(`applied ${name}`);
    console.log(
      `migrate: ${result.applied.length} applied, ${result.skipped.length} already present`,
    );
  } finally {
    // Kysely 的 destroy() 会关掉 PostgresDialect 持有的 pool；不要再 pool.end()
    await db.destroy();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");
if (invokedDirectly) {
  runMigrate(requireUrl("MYRIX_MIGRATE_DATABASE_URL")).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
