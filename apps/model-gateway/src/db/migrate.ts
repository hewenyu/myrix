/**
 * 迁移运行器：纯 SQL 文件 + Kysely（不引入 knex 或额外 CLI）。
 *
 * 与 `@myrix/platform-store` 的迁移是同一种做法，但**表独立**：
 * 账本迁移记录在 `myrix_gateway.schema_migrations`，业务库的迁移记录在
 * `myrix_internal.migrations`，两边互不影响，可以单独部署。
 *
 * 迁移文件不可改写：记录 SHA-256，重跑时内容变了就报错（避免环境之间 DDL 漂移）。
 * 并发安全：先取 advisory lock，多副本同时启动只有一个真正执行。
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql, type Kysely } from "kysely";
import type { GatewayMigrationDatabase } from "./schema";

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export const checksumOf = (sqlText: string): string => createHash("sha256").update(sqlText, "utf8").digest("hex");

const MIGRATION_LOCK_KEY = "myrix_gateway:migrations";

const MIGRATIONS_TABLE_DDL = `
create schema if not exists myrix_gateway;

create table if not exists myrix_gateway.schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now(),
  checksum text not null
);
`;

export async function loadMigrations(directory = defaultDirectory()): Promise<MigrationFile[]> {
  const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  const loaded: MigrationFile[] = [];
  for (const name of files) {
    const text = await readFile(join(directory, name), "utf8");
    loaded.push({ name, sql: text, checksum: checksumOf(text) });
  }
  return loaded;
}

function defaultDirectory(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "migrations");
}

/**
 * 应用所有未执行的迁移。必须用**迁移角色**（库 owner / DBA）调用，
 * 不能用 `myrix_gateway_app`（它没有建表权限，也不该有）。
 */
export async function migrateToLatest(
  db: Kysely<GatewayMigrationDatabase>,
  directory = defaultDirectory(),
): Promise<MigrationResult> {
  const migrations = await loadMigrations(directory);
  const applied: string[] = [];
  const skipped: string[] = [];

  // Session advisory locks must be acquired/released on the same leased physical connection.
  return db.connection().execute(async conn => {
    await sql`select pg_advisory_lock(hashtextextended(${MIGRATION_LOCK_KEY}, 0))`.execute(conn);
    try {
      await sql.raw(MIGRATIONS_TABLE_DDL).execute(conn);
      const existing = await conn.selectFrom("myrix_gateway.schema_migrations").select(["name", "checksum"]).execute();
      const byName = new Map(existing.map((row) => [row.name, row.checksum]));

      for (const migration of migrations) {
        const previous = byName.get(migration.name);
        if (previous !== undefined) {
          if (previous !== migration.checksum) {
            throw new Error(
              `myrix: 迁移 ${migration.name} 的内容已变更（记录 ${previous.slice(0, 12)}…，当前 ${migration.checksum.slice(0, 12)}…）。` +
                "迁移文件一旦发布就不可改写；请新增一个迁移文件。",
            );
          }
          skipped.push(migration.name);
          continue;
        }
        await conn.transaction().execute(async tx => {
          await sql.raw(migration.sql).execute(tx);
          await tx.insertInto("myrix_gateway.schema_migrations")
            .values({ name: migration.name, checksum: migration.checksum }).execute();
        });
        applied.push(migration.name);
      }
    } finally {
      await sql`select pg_advisory_unlock(hashtextextended(${MIGRATION_LOCK_KEY}, 0))`.execute(conn);
    }
    return { applied, skipped };
  });
}
