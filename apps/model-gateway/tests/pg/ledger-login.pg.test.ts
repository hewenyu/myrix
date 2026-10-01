/**
 * Postgres 集成测试（**opt-in**）：真实 LOGIN 非 owner 角色 + 按真实 usage 的据实结算。
 *
 * 为什么单独一个文件、单独一个库：
 *   * `ledger.pg.test.ts` 用 `options: -c role=myrix_gateway_app` 在 **migrator 会话**里
 *     切换角色。RLS 判定依据 `current_user`，所以那里的隔离断言本身有效；但
 *     `session_user` 仍是 migrator，**不能**证明"生产用一个真实登录的应用角色连接"
 *     这条链路。真实登录、`session_user = current_user` 的验收必须在别的连接上做。
 *   * 本文件在 `127.0.0.1` 的本地 Postgres 上创建**随机命名的自有 fixture 库**与
 *     随机命名的 LOGIN 角色，跑完即删；**绝不** drop/reset `myrix` /
 *     `myrix_bff_acceptance` 等既有库，也不修改既有角色属性。
 *
 * 运行（需要 admin/迁移角色，本机是 superuser）：
 *
 *   MYRIX_GATEWAY_TEST_DATABASE_URL=postgres://myrix_migrator:myrix_local_migrator@127.0.0.1:55439/myrix \
 *     pnpm vitest run apps/model-gateway/tests/pg/ledger-login.pg.test.ts
 *
 * 未设置该变量时完全跳过（与其它 PG 测试一致），默认 `pnpm test` 不需要数据库。
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { createPostgresLedger, usageForTenant } from "../../src/db/ledger";
import { migrateToLatest } from "../../src/db/migrate";
import { MemoryLedger } from "../../src/ledger";
import type { GatewayDatabase } from "../../src/db/schema";

const ADMIN_URL = process.env["MYRIX_GATEWAY_TEST_DATABASE_URL"];
const TENANT_A = "cccccccc-1111-4000-8000-00000000000a";
const TENANT_B = "cccccccc-1111-4000-8000-00000000000b";
// 内存/PG 一致性用例用独立租户，避免被前面用例的超额结算污染统计。
const TENANT_C = "cccccccc-1111-4000-8000-00000000000c";
const USER_A = "dddddddd-1111-4000-8000-00000000000a";

const describePg = ADMIN_URL ? describe : describe.skip;
const TIMEOUT = 60_000;

/**
 * 普通 `DROP DATABASE` 的有界重试次数与间隔。
 *
 * 为什么需要重试：`pool.end()` 回调返回时，客户端连接已经断开，但服务端 backend
 * 可能仍在退出过程中（TCP 关闭 / 后端收尾尚未完成）。PG 在 DROP DATABASE 时会等
 * 待"正在退出"的 backend 最多约 5s；若等待窗口内仍被计入，就返回 55006
 * （object_in_use）。这可能是瞬时收尾，也可能是真实泄漏；重试耗尽必须失败。
 *
 * 为什么重试窗口远小于 afterAll 的 60s：单次 DROP 自身的等待大约 5s，三次合计
 * 不超过 ~15s，超时仍然会失败并冒泡，不会静默通过。
 */
const DROP_DB_MAX_ATTEMPTS = 3;
const DROP_DB_RETRY_DELAY_MS = 250;

/** 取出 PG 错误码（非 PG 错误返回 undefined）。 */
function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * 只用普通 `DROP DATABASE`（**不加 `WITH (FORCE)`**）删除本文件的 fixture 库。
 *
 * `WITH (FORCE)` 会杀掉"正在关闭"的连接：客户端池已经 `end()`，服务端 backend 尚在
 * 退出，被强杀后该 backend 会发出 PG 57P01（admin_shutdown）并打断收尾流程 —— 这就
 * 是"断言全绿但库里仍有 57P01"的来源。普通 DROP 让 PG 自己等待连接退出。
 *
 * 仅对 55006（object_in_use，连接正在退出）做有界重试；其它错误（含 57P01）一律继续
 * 抛出，绝不吞掉。这里不注册任何 uncaughtException / unhandledRejection 监听器。
 */
async function dropFixtureDatabase(fixtureAdmin: Kysely<GatewayDatabase>, database: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await sql`drop database if exists ${sql.id(database)}`.execute(fixtureAdmin);
      return;
    } catch (error) {
      if (postgresErrorCode(error) !== "55006" || attempt >= DROP_DB_MAX_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, DROP_DB_RETRY_DELAY_MS));
    }
  }
}

let admin: Kysely<GatewayDatabase>;
let app: Kysely<GatewayDatabase>;
let baseAdmin: Kysely<GatewayDatabase>;
let fixtureDb: string | undefined;
let loginRole: string | undefined;
// A generated name is not ownership proof: failed CREATE (including a name
// collision) must never cause teardown to remove an existing resource.
let fixtureCreated = false;
let roleCreated = false;
const loginPassword = `pw_${randomUUID().replace(/-/g, "")}`;

/** 把一条 URL 的库名/账号换成 fixture 库与 LOGIN 角色。 */
function withCredentials(url: string, user: string, password: string, database: string): string {
  const parsed = new URL(url);
  parsed.username = user;
  parsed.password = password;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

beforeAll(async () => {
  if (!ADMIN_URL) return;
  const suffix = randomUUID().slice(0, 8);
  fixtureDb = `myrix_gw_fixture_${suffix}`;
  loginRole = `myrix_gw_login_${suffix}`;

  baseAdmin = new Kysely<GatewayDatabase>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: ADMIN_URL, max: 2, application_name: "myrix-gateway-fixture-admin" }) }),
  });
  // 自有随机库：不碰 myrix / myrix_bff_acceptance。
  await sql`create database ${sql.id(fixtureDb!)}`.execute(baseAdmin);
  fixtureCreated = true;

  admin = new Kysely<GatewayDatabase>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: withCredentials(ADMIN_URL, new URL(ADMIN_URL).username, new URL(ADMIN_URL).password, fixtureDb!), max: 2, application_name: "myrix-gateway-fixture-db" }),
    }),
  });
  await migrateToLatest(admin);

  // 专用 LOGIN 角色：非 superuser、非 bypassrls、非 owner；通过成员关系拿到与
  // 生产应用角色 `myrix_gateway_app` **完全相同**的授权集合（不从测试里复制 grant）。
  const adminRole = new URL(ADMIN_URL).username;
  await baseAdmin.transaction().execute(async (tx) => {
    await sql`create role ${sql.id(loginRole!)} login password ${sql.lit(loginPassword)} nosuperuser nocreatedb nocreaterole nobypassrls`.execute(tx);
    await sql`grant ${sql.id("myrix_gateway_app")} to ${sql.id(loginRole!)}`.execute(tx);
    void adminRole;
  });
  roleCreated = true;

  app = new Kysely<GatewayDatabase>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: withCredentials(ADMIN_URL, loginRole!, loginPassword, fixtureDb!), max: 2, application_name: "myrix-gateway-fixture-login" }),
    }),
  });
}, TIMEOUT);

afterAll(async () => {
  try {
    // 先关池：客户端连接在 destroy() resolve 时已回调收尾。随后普通 DROP DATABASE
    // 会等 PG 服务端把剩余 backend 退出，不需要（也绝不允许）FORCE 强杀。
    await app?.destroy();
    await admin?.destroy();
    if (baseAdmin && fixtureDb && fixtureCreated) {
      await dropFixtureDatabase(baseAdmin, fixtureDb);
    }
    if (baseAdmin && loginRole && roleCreated) {
      await sql`drop role if exists ${sql.id(loginRole)}`.execute(baseAdmin);
    }
  } finally {
    // 无论 DROP 成功还是抛错，都必须释放 baseAdmin 自己的连接（否则同一个 57P01
    // 会以"库没删掉、连接还挂着"的形式泄漏）。
    await baseAdmin?.destroy();
  }
}, TIMEOUT);

describePg("myrix_gateway：真实 LOGIN 非 owner 角色（session_user = current_user）", () => {
  it("连接身份是真的登录角色：LOGIN、非 superuser、非 bypassrls、非表 owner", async () => {
    const identity = await sql<{
      current_user: string;
      session_user: string;
      is_superuser: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcanlogin: boolean;
      owns_reservations: boolean;
    }>`
      select current_user,
             session_user,
             current_setting('is_superuser') as is_superuser,
             r.rolsuper,
             r.rolbypassrls,
             r.rolcanlogin,
             (c.relowner = r.oid) as owns_reservations
      from pg_roles r
      cross join pg_class c
      where r.rolname = current_user and c.oid = 'myrix_gateway.quota_reservations'::regclass
    `.execute(app);

    const row = identity.rows[0];
    // 关键：不是 `set local role` 切换出来的身份 —— 两者都是登录角色本身。
    expect(row?.current_user).toBe(loginRole);
    expect(row?.session_user).toBe(loginRole);
    expect(row?.is_superuser).toBe("off");
    expect(row).toMatchObject({ rolsuper: false, rolbypassrls: false, rolcanlogin: true, owns_reservations: false });
  }, TIMEOUT);

  it("RLS 对这个真实登录角色生效：无租户上下文读 0 行，跨租户写被拒", async () => {
    await sql`
      insert into myrix_gateway.quota_reservations
        (tenant_id, request_id, user_id, session_id, cell_id, model, reserved_tokens, consumed_tokens, outcome)
      values (${TENANT_A}::uuid, 'req-login-rls-0001', ${USER_A}::uuid, 'sess-login', 'cell-login', 'deepseek-chat', 100, 0, 'pending')
    `.execute(admin);

    const visible = await sql<{ count: string }>`select count(*)::text as count from myrix_gateway.quota_reservations`.execute(app);
    expect(visible.rows[0]?.count).toBe("0");

    const leaked = await app.transaction().execute(async (tx) => {
      await sql`select set_config('myrix_gateway.tenant_id', ${TENANT_A}, true)`.execute(tx);
      return (await sql<{ count: string }>`select count(*)::text as count from myrix_gateway.quota_reservations where tenant_id = ${TENANT_B}::uuid`.execute(tx)).rows[0]?.count;
    });
    expect(leaked).toBe("0");

    await expect(
      app.transaction().execute(async (tx) => {
        await sql`select set_config('myrix_gateway.tenant_id', ${TENANT_A}, true)`.execute(tx);
        await sql`insert into myrix_gateway.quota_reservations
          (tenant_id, request_id, user_id, session_id, cell_id, model, reserved_tokens, consumed_tokens, outcome)
          values (${TENANT_B}::uuid, 'req-login-rls-0002', ${USER_A}::uuid, 'sess-login', 'cell-login', 'deepseek-chat', 1, 0, 'pending')`.execute(tx);
      }),
    ).rejects.toThrow(/row-level security/i);
  }, TIMEOUT);

  it("超额结算：真实 usage 完整入账（可大于预占），随后同一会话预占被拒", async () => {
    const ledger = createPostgresLedger(app, { policy: { tenantTokens: 1_000_000, userTokens: 1_000_000, sessionTokens: 120_000 } });
    const reserved = await ledger.tryReserve({
      requestId: "req-login-over-0001", tenantId: TENANT_A, userId: USER_A,
      sessionId: "sess-login-over", cellId: "cell-login", model: "deepseek-chat", reservedTokens: 5_000,
    });
    expect(reserved.ok).toBe(true);

    const settled = await ledger.consume({
      requestId: "req-login-over-0001", tenantId: TENANT_A, consumption: "settled",
      promptTokens: 90_000, completionTokens: 30_000, totalTokens: 120_000,
    });
    // 修复前：min(5000, 120000) = 5000 → 白送 115000；修复后完整 120000 入账。
    expect(settled.consumedTokens).toBe(120_000);
    expect(settled.refundedTokens).toBe(0);

    // 数据库层面也据实落库（不再有 consumed <= reserved 的约束）。
    const rows = await sql<{ consumed_tokens: number; reserved_tokens: number; total_tokens: number | null }>`
      select consumed_tokens, reserved_tokens, total_tokens from myrix_gateway.quota_reservations
      where request_id = 'req-login-over-0001'
    `.execute(admin);
    expect(rows.rows[0]).toEqual({ consumed_tokens: 120_000, reserved_tokens: 5_000, total_tokens: 120_000 });

    // 会话窗口 120_000 已被据实撑满：下一次预占被拒（超额部分真的进窗口统计）。
    const denied = await ledger.tryReserve({
      requestId: "req-login-over-0002", tenantId: TENANT_A, userId: USER_A,
      sessionId: "sess-login-over", cellId: "cell-login", model: "deepseek-chat", reservedTokens: 1,
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.code).toBe("session_quota");
    expect(denied.reason).toContain("120000");
  }, TIMEOUT);

  it("内存账本与 PG 账本对同一序列给出相同结果（含超额结算）", async () => {
    const pg = createPostgresLedger(app, { policy: { tenantTokens: 1_000_000, userTokens: 1_000_000, sessionTokens: 1_000_000 } });
    const memory = new MemoryLedger({ policy: { tenantTokens: 1_000_000, userTokens: 1_000_000, sessionTokens: 1_000_000 } });

    const sequence = [
      { requestId: "req-parity-settle", reserved: 400, consumption: "settled" as const, prompt: 100, completion: 50, total: 150 },
      { requestId: "req-parity-over", reserved: 300, consumption: "settled" as const, prompt: 800, completion: 400, total: 1_200 },
      { requestId: "req-parity-unknown", reserved: 250, consumption: "unknown" as const, prompt: undefined, completion: undefined, total: undefined },
      { requestId: "req-parity-release", reserved: 900, consumption: "released" as const, prompt: undefined, completion: undefined, total: undefined },
    ];

    const results: Array<{ pg: unknown; memory: unknown }> = [];
    for (const step of sequence) {
      for (const ledger of [pg, memory]) {
        await ledger.tryReserve({
          requestId: step.requestId, tenantId: TENANT_C, userId: USER_A,
          sessionId: `sess-parity-${step.requestId}`, cellId: "cell-login", model: "deepseek-chat", reservedTokens: step.reserved,
        });
      }
      const pgResult = await pg.consume({
        requestId: step.requestId, tenantId: TENANT_C, consumption: step.consumption,
        ...(step.total === undefined ? {} : { promptTokens: step.prompt, completionTokens: step.completion, totalTokens: step.total }),
      });
      const memoryResult = await memory.consume({
        requestId: step.requestId, tenantId: TENANT_C, consumption: step.consumption,
        ...(step.total === undefined ? {} : { promptTokens: step.prompt, completionTokens: step.completion, totalTokens: step.total }),
      });
      results.push({
        pg: { outcome: pgResult.outcome, consumed: pgResult.consumedTokens, refunded: pgResult.refundedTokens },
        memory: { outcome: memoryResult.outcome, consumed: memoryResult.consumedTokens, refunded: memoryResult.refundedTokens },
      });
    }

    expect(results).toEqual([
      { pg: { outcome: "settled", consumed: 150, refunded: 250 }, memory: { outcome: "settled", consumed: 150, refunded: 250 } },
      { pg: { outcome: "settled", consumed: 1_200, refunded: 0 }, memory: { outcome: "settled", consumed: 1_200, refunded: 0 } },
      { pg: { outcome: "unknown", consumed: 250, refunded: 0 }, memory: { outcome: "unknown", consumed: 250, refunded: 0 } },
      { pg: { outcome: "released", consumed: 0, refunded: 900 }, memory: { outcome: "released", consumed: 0, refunded: 900 } },
    ]);

    // 相同序列的窗口统计也一致（已结算按 consumed_tokens 计）。
    const pgUsage = await usageForTenant(app, TENANT_C);
    const memoryUsage = await memory.usageSnapshot();
    expect(memoryUsage.consumedTokens).toBe(1_600);
    expect(pgUsage.consumedTokens).toBe(1_600);
    expect(memoryUsage.entries).toBe(4);
    expect(pgUsage.entries).toBe(4);
  }, TIMEOUT);
});
