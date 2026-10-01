import { createHash } from "node:crypto";

import { sql, type Kysely } from "kysely";

import type { MigrationDatabase } from "./schema";

/**
 * 迁移运行器：纯 SQL 文件 + Kysely，不引入 knex 或额外 CLI。
 *
 * 设计取舍：
 *   * 每个迁移文件在**一个事务**里执行（Postgres DDL 是事务性的），失败整体回滚。
 *   * 迁移文件不可改写：记录 SHA-256，重跑时发现内容变了就报错，避免"环境之间 DDL 漂移"。
 *   * 迁移表放在 myrix_internal.migrations，且从不对应用角色授权。
 *   * 迁移是并发安全的：先取**会话级** advisory lock，多副本同时启动只有一个真正执行。
 *
 * SQL 文件在编译期不存在（.ts 源码不打包 .sql），所以这里用 fs 读取相对本文件的目录。
 */

export interface MigrationFile {
  /** 形如 "0001_tenancy.sql"，字典序即执行顺序 */
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export function checksumOf(sqlText: string): string {
  return createHash("sha256").update(sqlText, "utf8").digest("hex");
}

/**
 * 迁移锁的名字。会话级 advisory lock 的真实 key 是
 * `hashtextextended(MIGRATION_LOCK_KEY, 0)`；导出这个字符串是为了让测试
 * 用同一条表达式反查 `pg_locks` / `pg_try_advisory_lock`，避免两处漂移。
 */
export const MIGRATION_LOCK_KEY = "myrix:migrations";

export const MIGRATIONS_TABLE_DDL = `
create schema if not exists myrix_internal;

create table if not exists myrix_internal.migrations (
  name text primary key,
  applied_at timestamptz not null default now(),
  checksum text not null
);
`;

async function loadMigrations(): Promise<MigrationFile[]> {
  const { readdir, readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");

  // SQL 文件与运行器不在同一层：运行器在 src/，迁移在 src/migrations/
  const here = join(dirname(fileURLToPath(import.meta.url)), "migrations");
  const files = (await readdir(here)).filter((name) => name.endsWith(".sql")).sort();

  const loaded: MigrationFile[] = [];
  for (const name of files) {
    const sqlText = await readFile(join(here, name), "utf8");
    loaded.push({ name, sql: sqlText, checksum: checksumOf(sqlText) });
  }
  return loaded;
}

/**
 * 应用所有未执行的迁移。可重复调用；已应用的迁移会校验校验和。
 *
 * 用迁移角色（通常是库 owner，测试里就是 postgres 超级用户）调用，
 * 不要用 myrix_app 调用 —— 它没有建表权限，也不该有。
 *
 * ## 为什么整段迁移必须钉在同一条连接上
 *
 * `pg_advisory_lock` 是**会话级**的：锁属于"拿到它的那条物理连接"，
 * 而且只有同一条连接上的 `pg_advisory_unlock` 才能把它放掉。
 * 如果像最初那样直接在池化 `db` 上执行：
 *
 *   1. `pg_advisory_lock` 落在连接 A；
 *   2. 迁移表 DDL、每个迁移事务按池的调度落在连接 B/C/D…（完全不保证是 A）；
 *   3. `pg_advisory_unlock` 又可能落在连接 E —— Postgres 返回 `false`
 *      （不是本会话持有的锁），于是 **A 上的锁从此泄漏**，直到 A 被池关闭；
 *   4. 更糟的是，若 A 在迁移进行中被池回收，锁会在迁移途中消失，
 *      "多副本同时启动只有一个执行"的串行化保证直接失效 —— 两个副本可能并发跑 DDL。
 *
 * 因此这里用 `db.connection()` 从池里租一条连接并**全程复用**（Kysely 的
 * `SingleConnectionProvider` 保证回调内的所有语句都用它），迁移结束（含抛错）
 * 才在 `finally` 里释放锁并归还连接。
 *
 * 每迁移一个事务的语义保持不变：下面的 `conn.transaction()` 仍然一条迁移一提交，
 * 失败整体回滚，只是它现在也跑在同一条被 pin 住的连接上。
 */
export async function migrateToLatest(db: Kysely<MigrationDatabase>): Promise<MigrationResult> {
  const migrations = await loadMigrations();
  const applied: string[] = [];
  const skipped: string[] = [];

  return db.connection().execute(async (conn) => {
    await sql`select pg_advisory_lock(hashtextextended(${MIGRATION_LOCK_KEY}, 0))`.execute(conn);
    try {
      await sql.raw(MIGRATIONS_TABLE_DDL).execute(conn);

      const existing = await conn
        .selectFrom("myrix_internal.migrations")
        .select(["name", "checksum"])
        .execute();
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

        // 单条迁移一个事务：DDL 失败整体回滚，不会留下半套 schema
        await conn.transaction().execute(async (tx) => {
          await sql.raw(migration.sql).execute(tx);
          await tx
            .insertInto("myrix_internal.migrations")
            .values({ name: migration.name, checksum: migration.checksum })
            .execute();
        });
        applied.push(migration.name);
      }
    } finally {
      // 必须在**同一条** pin 住的连接上放锁：换连接会返回 false 并泄漏会话锁
      await sql`select pg_advisory_unlock(hashtextextended(${MIGRATION_LOCK_KEY}, 0))`.execute(conn);
    }

    return { applied, skipped };
  });
}

/** 列出磁盘上的迁移（测试用：确认编号连续、没有重复前缀） */
export async function listMigrations(): Promise<MigrationFile[]> {
  return loadMigrations();
}
