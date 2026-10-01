import { randomUUID } from "node:crypto";

import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { MIGRATION_LOCK_KEY, MIGRATIONS_TABLE_DDL, listMigrations, migrateToLatest } from "../src/migrate";
import type { MigrationDatabase } from "../src/schema";
import { TEST_ADMIN_URL, isReachable } from "./helpers/pg";

/**
 * 迁移运行器的回归测试：**advisory lock 是会话级的，必须与整段迁移在同一条连接上**。
 *
 * 背景（修复前的真实缺陷）：`migrateToLatest(db)` 直接在池化 `db` 上取锁/放锁，
 * 每条语句都可能落到池里不同的物理连接上：
 *   * 拿锁的会话可能不是执行 DDL 的会话，也可能不是放锁的会话；
 *   * `pg_advisory_unlock` 在别的连接上返回 `false`（功能上等于没放锁），
 *     而真正持有锁的那条连接会一直把会话锁留在 PostgreSQL 里；
 *   * 如果持锁连接中途被池回收/替换，锁会在迁移进行中消失，串行化保证直接失效。
 *
 * 这里的假池 `RotatingPool` 每次 `connect()` 都返回一条**全新的物理连接**，
 * 把"池化连接不保证复用同一条连接"变成确定性事实：修复前，第一条语句在 conn#1
 * 取锁，后续语句落在 conn#2..#N，最后的 unlock 返回 false 且锁泄漏；
 * 修复后整段迁移只 `connect()` 一次，取锁/语句/放锁同 pid，unlock 返回 true。
 *
 * 每个用例在自己的临时数据库里跑（`myrix_mig_test_*`，用完 `drop ... with (force)`），
 * 因此不会碰 `myrix`、`myrix_bff_acceptance` 等任何既有数据库。
 */

const reachable = await isReachable();

/**
 * pg 在运行期给每条连接挂了 `processID`（后端 pid），但 `@types/pg` 没有声明它。
 * 这里显式读取并校验，避免用 `any` 把类型放宽。
 */
function backendPid(client: pg.PoolClient): number {
  const pid = (client as unknown as { processID?: number | null }).processID;
  if (typeof pid !== "number") {
    throw new Error("myrix: 无法读取连接的 backend pid（pg 未填充 processID）");
  }
  return pid;
}

interface Statement {
  readonly pid: number;
  readonly text: string;
  readonly rows: readonly Record<string, unknown>[];
}

/** 每条语句都换一条物理连接的假池（结构上满足 Kysely 的 PostgresPool）。 */
class RotatingPool {
  readonly statements: Statement[] = [];
  connects = 0;
  private readonly pools: pg.Pool[] = [];
  private ended = false;

  constructor(private readonly connectionString: string) {}

  async connect(): Promise<pg.PoolClient> {
    this.connects += 1;
    // max: 1 + 一个独立池 = 保证本次连接不可能是上一次那条
    const pool = new pg.Pool({ connectionString: this.connectionString, max: 1 });
    this.pools.push(pool);
    const client = await pool.connect();
    const original = client.query.bind(client) as (...args: unknown[]) => Promise<{ rows?: unknown[] }>;
    Object.defineProperty(client, "query", {
      configurable: true,
      value: async (text: unknown, params?: unknown): Promise<unknown> => {
        const result = await original(text, params);
        this.statements.push({
          pid: backendPid(client),
          text: String(text),
          rows: (result.rows ?? []) as Record<string, unknown>[],
        });
        return result;
      },
    });
    return client;
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    await Promise.all(this.pools.map((pool) => pool.end().catch(() => undefined)));
  }
}

function asKysely(pool: RotatingPool): Kysely<MigrationDatabase> {
  return new Kysely<MigrationDatabase>({
    dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = () => settle();
  });
  return { promise, resolve };
}

/**
 * 真实连接池，但会在执行到标记载荷时暂停一次（不释放、不换连接）。
 * 用来在"迁移正跑到一半"的时刻，从**另一条会话**观察 advisory lock 是否真的被持有。
 */
class GatedPool {
  private readonly real: pg.Pool;
  private readonly gate = deferred();
  private readonly reached = deferred();
  private paused = false;
  private ended = false;

  constructor(
    url: string,
    private readonly marker: string,
  ) {
    this.real = new pg.Pool({ connectionString: url, max: 4 });
  }

  get pausedInsideMigration(): Promise<void> {
    return this.reached.promise;
  }

  openGate(): void {
    this.gate.resolve();
  }

  async connect(): Promise<pg.PoolClient> {
    const client = await this.real.connect();
    const original = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
    Object.defineProperty(client, "query", {
      configurable: true,
      value: async (text: unknown, params?: unknown): Promise<unknown> => {
        if (!this.paused && String(text).includes(this.marker)) {
          this.paused = true;
          this.reached.resolve();
          await this.gate.promise;
        }
        return original(text, params);
      },
    });
    return client;
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    await this.real.end();
  }
}

function urlForDatabase(database: string): string {
  const url = new URL(TEST_ADMIN_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

/** 在同一个 PG 实例上建一个一次性数据库，跑完（含失败）一定删掉。 */
async function withTemporaryDatabase<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const name = `myrix_mig_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: urlForDatabase("postgres") });
  await admin.connect();
  try {
    await admin.query(`create database "${name}"`);
    return await fn(urlForDatabase(name));
  } finally {
    await admin.query(`drop database if exists "${name}" with (force)`).catch(() => undefined);
    await admin.end();
  }
}

/** 另一条会话能否立刻拿到迁移锁：false 说明锁被泄漏（仍被某条连接持有）。 */
async function advisoryLockIsFree(probe: pg.Client): Promise<boolean> {
  const acquired = await probe.query<{ ok: boolean }>(
    "select pg_try_advisory_lock(hashtextextended($1, 0)) as ok",
    [MIGRATION_LOCK_KEY],
  );
  const ok = acquired.rows[0]?.ok === true;
  if (ok) {
    await probe.query("select pg_advisory_unlock(hashtextextended($1, 0))", [MIGRATION_LOCK_KEY]);
  }
  return ok;
}

function expectSingleLease(pool: RotatingPool): void {
  expect(pool.connects).toBe(1);
  expect(new Set(pool.statements.map((statement) => statement.pid)).size).toBe(1);
  expect(pool.statements[0]?.text).toMatch(/pg_advisory_lock/i);
  const unlock = pool.statements.at(-1);
  expect(unlock?.text).toMatch(/pg_advisory_unlock/i);
  // 关键断言：放锁必须成功（false = 放的是"另一条连接"，等于锁泄漏）
  expect(unlock?.rows[0]).toMatchObject({ pg_advisory_unlock: true });
}

describe.skipIf(!reachable)("迁移运行器：advisory lock 与迁移固定在同一条连接", () => {
  it("首次迁移：锁、全部迁移语句、放锁都在同一条被租约占住的连接上", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = new RotatingPool(url);
      const db = asKysely(pool);
      try {
        const result = await migrateToLatest(db);
        const expected = (await listMigrations()).map((migration) => migration.name);
        expect(result.applied).toEqual(expected);
        expect(result.skipped).toEqual([]);
        expectSingleLease(pool);
        // 每迁移一个事务：12 个迁移 + 迁移表 DDL + 读已有迁移 = 语句数远多于 1，
        // 但都必须在同一条连接上（上式已断言 pid 唯一）。
        expect(pool.statements.length).toBeGreaterThan(expected.length);
      } finally {
        await db.destroy().catch(() => undefined);
        await pool.end();
      }
    });
  });

  it("重复迁移：全部跳过，仍然只租用一条连接且放锁成功", async () => {
    await withTemporaryDatabase(async (url) => {
      const first = new RotatingPool(url);
      const firstDb = asKysely(first);
      try {
        await migrateToLatest(firstDb);
      } finally {
        await firstDb.destroy().catch(() => undefined);
        await first.end();
      }

      const second = new RotatingPool(url);
      const secondDb = asKysely(second);
      try {
        const result = await migrateToLatest(secondDb);
        expect(result.applied).toEqual([]);
        expect(result.skipped.length).toBe((await listMigrations()).length);
        expectSingleLease(second);
      } finally {
        await secondDb.destroy().catch(() => undefined);
        await second.end();
      }
    });
  });

  it("迁移中途失败：finally 仍在同一条连接上放锁，锁不泄漏", async () => {
    await withTemporaryDatabase(async (url) => {
      const [firstMigration] = await listMigrations();
      expect(firstMigration).toBeDefined();

      // 注入一条校验和不匹配的记录：migrateToLatest 会在取锁之后、执行迁移之前失败
      const seed = new pg.Client({ connectionString: url });
      await seed.connect();
      await seed.query(MIGRATIONS_TABLE_DDL);
      await seed.query("insert into myrix_internal.migrations (name, checksum) values ($1, $2)", [
        firstMigration!.name,
        "0".repeat(64),
      ]);
      await seed.end();

      const probe = new pg.Client({ connectionString: url });
      await probe.connect();
      const pool = new RotatingPool(url);
      const db = asKysely(pool);
      try {
        await expect(migrateToLatest(db)).rejects.toThrow(/内容已变更/);
        expectSingleLease(pool);
        expect(await advisoryLockIsFree(probe)).toBe(true);
      } finally {
        await db.destroy().catch(() => undefined);
        await pool.end();
        await probe.end();
      }
    });
  });

  it("迁移进行中锁确实被持有（另一条会话 pg_try_advisory_lock = false）", async () => {
    await withTemporaryDatabase(async (url) => {
      // 在第一条迁移的正中间暂停：此时锁已取、迁移尚未跑完
      const pool = new GatedPool(url, "create table tenants");
      const db = new Kysely<MigrationDatabase>({
        dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
      });
      const probe = new pg.Client({ connectionString: url });
      await probe.connect();
      try {
        const running = migrateToLatest(db);
        await pool.pausedInsideMigration;

        const during = await probe.query<{ ok: boolean }>(
          "select pg_try_advisory_lock(hashtextextended($1, 0)) as ok",
          [MIGRATION_LOCK_KEY],
        );
        expect(during.rows[0]?.ok).toBe(false); // 迁移期间锁被真正持有

        pool.openGate();
        const result = await running;
        expect(result.applied.length).toBe((await listMigrations()).length);

        expect(await advisoryLockIsFree(probe)).toBe(true); // 结束后已释放
      } finally {
        await db.destroy().catch(() => undefined);
        await pool.end();
        await probe.end();
      }
    });
  });
});
