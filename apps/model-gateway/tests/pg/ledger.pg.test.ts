/**
 * Postgres 集成测试（**opt-in**）。
 *
 * 只有显式设置 `MYRIX_GATEWAY_TEST_DATABASE_URL` 才会运行；默认 `pnpm test`
 * 完全跳过，不需要本地数据库。这与单测（fake upstream + 内存账本）分开，
 * 避免"把替身当成真实 Postgres 验收"。
 *
 *   MYRIX_GATEWAY_TEST_DATABASE_URL=postgres://myrix_migrator:***@127.0.0.1:55439/myrix \
 *     pnpm vitest run apps/model-gateway/tests/pg
 *
 * 两条连接（与 platform-store 的做法一致）：
 *   * `admin`：迁移角色/库 owner，跑迁移、准备凭据行、清理与断言内部状态；
 *   * `app`：以 `myrix_gateway_app` 身份连接（NOSUPERUSER / NOBYPASSRLS / 非表 owner），
 *     账本与 RLS 负例全部走它 —— 这样 FORCE ROW LEVEL SECURITY 才是真的生效。
 *
 * 关于"在 superuser 会话里 `set local role` 能不能验证隔离"（旧注释说法有误）：
 *   * RLS 策略按 **`current_user`** 判定，`set local role` 确实会把 `current_user`
 *     换成目标角色，因此这里通过启动参数 `-c role=...` 切换身份后，RLS 断言**不是假绿**；
 *   * 但它并没有证明"生产用一个真实登录的 LOGIN 角色连接"这条链路：
 *     `session_user` 仍是 migrator，属于**登录身份验收**的缺口，而不是 RLS 缺口。
 *     真实 LOGIN、`session_user = current_user` 的验收在
 *     `ledger-login.pg.test.ts`（自有随机 fixture 库 + 随机 LOGIN 角色）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { createPostgresCredentialAdmin, createPostgresCredentialResolver } from "../../src/db/credentials";
import { createPostgresLedger, usageForTenant } from "../../src/db/ledger";
import { migrateToLatest } from "../../src/db/migrate";
import type { GatewayDatabase } from "../../src/db/schema";

const ADMIN_URL = process.env["MYRIX_GATEWAY_TEST_DATABASE_URL"];
const APP_ROLE = process.env["MYRIX_GATEWAY_TEST_APP_ROLE"] ?? "myrix_gateway_app";
const TENANT_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const TENANT_B = "aaaaaaaa-0000-4000-8000-00000000000b";
// 并发闸门测试需要一个"没有任何在途预占"的干净租户，否则会受前面用例影响。
const TENANT_C = "aaaaaaaa-0000-4000-8000-00000000000c";
const USER_A = "bbbbbbbb-0000-4000-8000-00000000000a";

const describePg = ADMIN_URL ? describe : describe.skip;
const TIMEOUT = 30_000;

let admin: Kysely<GatewayDatabase>;
let app: Kysely<GatewayDatabase>;

const hashOf = (token: string): string => createHash("sha256").update(token).digest("hex");

beforeAll(async () => {
  if (!ADMIN_URL) return;
  const adminPool = new Pool({ connectionString: ADMIN_URL, max: 2, application_name: "myrix-gateway-pg-admin" });
  admin = new Kysely<GatewayDatabase>({ dialect: new PostgresDialect({ pool: adminPool }) });
  await migrateToLatest(admin);

  // 以应用角色连接：连接启动参数 SET ROLE，之后每条 SQL 都受 FORCE RLS 约束。
  const appPool = new Pool({
    connectionString: ADMIN_URL,
    max: 2,
    application_name: "myrix-gateway-pg-app",
    options: `-c role=${APP_ROLE}`,
  });
  app = new Kysely<GatewayDatabase>({ dialect: new PostgresDialect({ pool: appPool }) });

  const identity = await sql<{ current_user: string; is_superuser: string; bypassrls: boolean | null }>`
    select current_user,
           current_setting('is_superuser') as is_superuser,
           (select rolbypassrls from pg_roles where rolname = current_user) as bypassrls
  `.execute(app);
  expect(identity.rows[0]?.current_user).toBe(APP_ROLE);
  expect(identity.rows[0]?.is_superuser).toBe("off");
  expect(identity.rows[0]?.bypassrls).toBe(false);

  await sql`delete from myrix_gateway.quota_reservations where tenant_id in (${TENANT_A}::uuid, ${TENANT_B}::uuid, ${TENANT_C}::uuid)`.execute(admin);
  await sql`delete from myrix_gateway.cell_credentials where tenant_id in (${TENANT_A}::uuid, ${TENANT_B}::uuid)`.execute(admin);
}, TIMEOUT);

afterAll(async () => {
  if (app) await app.destroy();
  if (admin) await admin.destroy();
}, TIMEOUT);

describePg("myrix_gateway：RLS 与角色收口（以真实应用角色连接）", () => {
  it("应用角色不能直接读 cell_credentials 表，但能通过 SECURITY DEFINER 函数按摘要精确解析", async () => {
    const hash = hashOf("pg-test-cell-token-000000000001");
    await sql`
      insert into myrix_gateway.cell_credentials (token_hash, tenant_id, cell_id)
      values (${hash}, ${TENANT_A}::uuid, 'cell-pg-1')
      on conflict (token_hash) do update set status = 'active', revoked_at = null
    `.execute(admin);

    const resolved = await sql<{ tenant_id: string; cell_id: string }>`
      select tenant_id, cell_id from myrix_gateway.resolve_cell_credential(${hash})
    `.execute(app);
    expect(resolved.rows).toEqual([{ tenant_id: TENANT_A, cell_id: "cell-pg-1" }]);

    // 直接 select 表：应用角色没有任何表权限 → 权限错误。
    await expect(sql`select token_hash from myrix_gateway.cell_credentials`.execute(app)).rejects.toThrow(/permission denied/i);
  }, TIMEOUT);

  it("撤销的凭据解析不出来（status=disabled）", async () => {
    const hash = hashOf("pg-test-cell-token-revoked-000002");
    await sql`
      insert into myrix_gateway.cell_credentials (token_hash, tenant_id, cell_id, status, revoked_at)
      values (${hash}, ${TENANT_A}::uuid, 'cell-pg-1', 'disabled', now())
    `.execute(admin);
    const resolved = await sql`select tenant_id from myrix_gateway.resolve_cell_credential(${hash})`.execute(app);
    expect(resolved.rows).toHaveLength(0);
  }, TIMEOUT);

  it("凭据解析函数拒绝非法摘要（不报错、不返回行）", async () => {
    const resolved = await sql`select tenant_id from myrix_gateway.resolve_cell_credential('not-a-hash')`.execute(app);
    expect(resolved.rows).toHaveLength(0);
  }, TIMEOUT);

  it("应用角色没有租户上下文时，账本一行都读不到（FORCE RLS fail-closed）", async () => {
    await sql`
      insert into myrix_gateway.quota_reservations
        (tenant_id, request_id, user_id, session_id, cell_id, model, reserved_tokens, consumed_tokens, outcome)
      values (${TENANT_A}::uuid, 'req-pg-rls-0001', ${USER_A}::uuid, 'sess-pg', 'cell-pg-1', 'deepseek-chat', 100, 0, 'pending')
    `.execute(admin);

    const visible = await sql<{ count: string }>`select count(*)::text as count from myrix_gateway.quota_reservations`.execute(app);
    expect(visible.rows[0]?.count).toBe("0");
  }, TIMEOUT);
});

describePg("myrix_gateway：预占、并发与幂等（应用角色 + 租户上下文）", () => {
  it("预占后可见、按真实 usage 结算、重复结算幂等", async () => {
    const ledger = createPostgresLedger(app, { policy: { tenantTokens: 1_000_000, userTokens: 1_000_000, sessionTokens: 1_000_000 } });
    const reserved = await ledger.tryReserve({
      requestId: "req-pg-settle-0001", tenantId: TENANT_A, userId: USER_A,
      sessionId: "sess-pg", cellId: "cell-pg-1", model: "deepseek-chat", reservedTokens: 500,
    });
    expect(reserved.ok).toBe(true);

    const first = await ledger.consume({
      requestId: "req-pg-settle-0001", tenantId: TENANT_A, consumption: "settled",
      promptTokens: 100, completionTokens: 200, totalTokens: 300, upstreamStatus: 200, latencyMs: 1234,
    });
    expect(first.consumedTokens).toBe(300);
    expect(first.refundedTokens).toBe(200);

    const second = await ledger.consume({
      requestId: "req-pg-settle-0001", tenantId: TENANT_A, consumption: "settled",
      promptTokens: 100, completionTokens: 200, totalTokens: 300,
    });
    expect(second.replayed).toBe(true);
    expect(second.consumedTokens).toBe(300);

    const rows = await sql<{ outcome: string; consumed_tokens: number; prompt_tokens: number; latency_ms: number }>`
      select outcome, consumed_tokens, prompt_tokens, latency_ms from myrix_gateway.quota_reservations
      where request_id = 'req-pg-settle-0001'
    `.execute(admin);
    expect(rows.rows[0]).toEqual({ outcome: "settled", consumed_tokens: 300, prompt_tokens: 100, latency_ms: 1234 });
  }, TIMEOUT);

  it("未知用量按预占量结算（保守保留），不会少扣", async () => {
    const ledger = createPostgresLedger(app);
    await ledger.tryReserve({
      requestId: "req-pg-unknown-0001", tenantId: TENANT_A, userId: USER_A,
      sessionId: "sess-pg-u", cellId: "cell-pg-1", model: "deepseek-chat", reservedTokens: 777,
    });
    const result = await ledger.consume({ requestId: "req-pg-unknown-0001", tenantId: TENANT_A, consumption: "unknown" });
    expect(result.consumedTokens).toBe(777);
    expect(result.refundedTokens).toBe(0);
  }, TIMEOUT);

  it("真实 usage 超过预占时完整入账（据实结算），并收紧后续预占", async () => {
    // 修复前：consumed = min(预占, 真实)，且表上有 consumed <= reserved 约束；
    // 大中文 prompt 因此既骗过闸门、又白送超额用量。
    const ledger = createPostgresLedger(app, { policy: { tenantTokens: 1_000_000, userTokens: 1_000_000, sessionTokens: 120_000 } });
    await ledger.tryReserve({
      requestId: "req-pg-over-0001", tenantId: TENANT_A, userId: USER_A,
      sessionId: "sess-pg-over", cellId: "cell-pg-1", model: "deepseek-chat", reservedTokens: 5_000,
    });
    const settled = await ledger.consume({
      requestId: "req-pg-over-0001", tenantId: TENANT_A, consumption: "settled",
      promptTokens: 90_000, completionTokens: 30_000, totalTokens: 120_000,
    });
    expect(settled.consumedTokens).toBe(120_000);
    expect(settled.refundedTokens).toBe(0);

    const rows = await sql<{ consumed_tokens: number; reserved_tokens: number; total_tokens: number | null }>`
      select consumed_tokens, reserved_tokens, total_tokens from myrix_gateway.quota_reservations
      where request_id = 'req-pg-over-0001'
    `.execute(admin);
    expect(rows.rows[0]).toEqual({ consumed_tokens: 120_000, reserved_tokens: 5_000, total_tokens: 120_000 });

    // 超额部分进入窗口统计 → 会话窗口 120_000 已满，下一次预占被拒。
    const denied = await ledger.tryReserve({
      requestId: "req-pg-over-0002", tenantId: TENANT_A, userId: USER_A,
      sessionId: "sess-pg-over", cellId: "cell-pg-1", model: "deepseek-chat", reservedTokens: 1,
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.code).toBe("session_quota");
  }, TIMEOUT);

  it("同一 requestId 重复预占是幂等重放，不重复扣减", async () => {
    const ledger = createPostgresLedger(app);
    const input = {
      requestId: "req-pg-idem-0001", tenantId: TENANT_A, userId: USER_A,
      sessionId: "sess-pg", cellId: "cell-pg-1", model: "deepseek-chat", reservedTokens: 50,
    } as const;
    const first = await ledger.tryReserve(input);
    const second = await ledger.tryReserve(input);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(second.replayed).toBe(true);
    const rows = await sql<{ count: string }>`
      select count(*)::text as count from myrix_gateway.quota_reservations where request_id = 'req-pg-idem-0001'
    `.execute(admin);
    expect(rows.rows[0]?.count).toBe("1");
  }, TIMEOUT);

  it("并发预占串行化：额度只够一次时不会超卖", async () => {
    const ledger = createPostgresLedger(app, { policy: { tenantTokens: 600, userTokens: 600, sessionTokens: 600, tenantConcurrency: 10, userConcurrency: 10 } });
    const seed = await ledger.tryReserve({
      requestId: "req-pg-budget-seed", tenantId: TENANT_B, userId: USER_A,
      sessionId: "sess-pg-b", cellId: "cell-pg-1", model: "deepseek-chat", reservedTokens: 400,
    });
    expect(seed.ok).toBe(true);

    // 三条并发都想再占 300：只剩 200，必须全部被拒（并发控制失效就会出现多占）。
    const attempts = await Promise.all(
      ["req-pg-race-0001", "req-pg-race-0002", "req-pg-race-0003"].map((requestId) =>
        ledger.tryReserve({
          requestId, tenantId: TENANT_B, userId: USER_A,
          sessionId: "sess-pg-race", cellId: "cell-pg-1", model: "deepseek-chat", reservedTokens: 300,
        }),
      ),
    );
    expect(attempts.every((attempt) => attempt.ok === false)).toBe(true);
    const snapshot = await usageForTenant(app, TENANT_B);
    expect(snapshot.reservedTokens).toBe(400);

    // 刚好放得下一条 200 的预占。
    const fits = await ledger.tryReserve({
      requestId: "req-pg-race-0004", tenantId: TENANT_B, userId: USER_A,
      sessionId: "sess-pg-race-2", cellId: "cell-pg-1", model: "deepseek-chat", reservedTokens: 200,
    });
    expect(fits.ok).toBe(true);
  }, TIMEOUT);

  it("并发闸门：未结算请求数达到上限时拒绝新请求（按租户/用户分别计数）", async () => {
    const ledger = createPostgresLedger(app, { policy: { tenantConcurrency: 1, userConcurrency: 1, tenantTokens: 1_000_000, userTokens: 1_000_000, sessionTokens: 1_000_000 } });
    const first = await ledger.tryReserve({
      requestId: "req-pg-conc-0001", tenantId: TENANT_C, userId: USER_A,
      sessionId: "sess-pg-c", cellId: "cell-pg-1", model: "deepseek-chat", reservedTokens: 10,
    });
    expect(first.ok).toBe(true);
    const second = await ledger.tryReserve({
      requestId: "req-pg-conc-0002", tenantId: TENANT_C, userId: USER_A,
      sessionId: "sess-pg-c", cellId: "cell-pg-1", model: "deepseek-chat", reservedTokens: 10,
    });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.code).toBe("concurrency");
    // 结算后闸门释放，可以再次预占（同时清理掉这条 pending，保持租户干净）。
    await ledger.consume({ requestId: "req-pg-conc-0001", tenantId: TENANT_C, consumption: "released" });
    const third = await ledger.tryReserve({
      requestId: "req-pg-conc-0003", tenantId: TENANT_C, userId: USER_A,
      sessionId: "sess-pg-c", cellId: "cell-pg-1", model: "deepseek-chat", reservedTokens: 10,
    });
    expect(third.ok).toBe(true);
    await ledger.consume({ requestId: "req-pg-conc-0003", tenantId: TENANT_C, consumption: "released" });
  }, TIMEOUT);

  it("租户上下文隔离：A 看不到 B 的行，统计也不串号", async () => {
    const usageA = await usageForTenant(app, TENANT_A);
    const usageB = await usageForTenant(app, TENANT_B);
    // A：rls-0001(100) + idem-0001(50) 仍 pending；settle/unknown/conc-0001 已结算、rls 之外的都结算过。
    expect(usageA.reservedTokens).toBe(150);
    // B：budget-seed(400) + race-0004(200) 仍 pending。
    expect(usageB.reservedTokens).toBe(600);

    const leaked = await app.transaction().execute(async (tx) => {
      await sql`select set_config('myrix_gateway.tenant_id', ${TENANT_A}, true)`.execute(tx);
      return (
        await sql<{ n: string }>`
          select count(*)::text as n from myrix_gateway.quota_reservations where tenant_id = ${TENANT_B}::uuid
        `.execute(tx)
      ).rows[0]?.n;
    });
    expect(leaked).toBe("0");
  }, TIMEOUT);

  it("结算必须带正确租户：用 B 的上下文结算 A 的 requestId 会失败", async () => {
    const ledger = createPostgresLedger(app);
    await ledger.tryReserve({
      requestId: "req-pg-xtenant-0001", tenantId: TENANT_A, userId: USER_A,
      sessionId: "sess-pg-x", cellId: "cell-pg-1", model: "deepseek-chat", reservedTokens: 20,
    });
    await expect(
      ledger.consume({ requestId: "req-pg-xtenant-0001", tenantId: TENANT_B, consumption: "released" }),
    ).rejects.toThrow(/没有 requestId/);
  }, TIMEOUT);

  it("凭据管理（owner 角色）登记/幂等重启用/撤销后，运行期解析立即生效", async () => {
    const adminApi = createPostgresCredentialAdmin(admin);
    const resolver = createPostgresCredentialResolver(app);
    const token = "pg-admin-managed-token-00000003";
    await adminApi.upsert({ token, tenantId: TENANT_B, cellId: "cell-pg-admin" });
    expect(await resolver.resolve(token)).toEqual({ tenantId: TENANT_B, cellId: "cell-pg-admin" });

    // 同一归属重复登记 = 幂等重启用（不改变 token 的归属）。
    await adminApi.upsert({ token, tenantId: TENANT_B, cellId: "cell-pg-admin" });
    expect(await resolver.resolve(token)).toEqual({ tenantId: TENANT_B, cellId: "cell-pg-admin" });

    // 换 cell 或换租户登记一律拒绝：凭据归属不能被 upsert 改写。
    await expect(adminApi.upsert({ token, tenantId: TENANT_B, cellId: "cell-pg-admin-2" })).rejects.toThrow(/禁止/);
    await expect(adminApi.upsert({ token, tenantId: TENANT_A, cellId: "cell-pg-admin" })).rejects.toThrow(/禁止/);
    expect(await resolver.resolve(token)).toEqual({ tenantId: TENANT_B, cellId: "cell-pg-admin" });

    expect(await adminApi.revoke(token)).toBe(true);
    expect(await resolver.resolve(token)).toBeUndefined();
    // 重复撤销返回 false（幂等，不报错）。
    expect(await adminApi.revoke(token)).toBe(false);
    // 被撤销后按原归属重新登记可以恢复，但仍不能改变归属。
    await adminApi.upsert({ token, tenantId: TENANT_B, cellId: "cell-pg-admin" });
    expect(await resolver.resolve(token)).toEqual({ tenantId: TENANT_B, cellId: "cell-pg-admin" });
    // 弱口令拒绝。
    await expect(adminApi.upsert({ token: "short", tenantId: TENANT_B, cellId: "c" })).rejects.toThrow(/至少 16 个字符/);
  }, TIMEOUT);

  it("账本表里不存在正文与密钥列（结构性保证）", async () => {
    const columns = await sql<{ column_name: string }>`
      select column_name from information_schema.columns
      where table_schema = 'myrix_gateway' and table_name = 'quota_reservations'
    `.execute(admin);
    const names = new Set(columns.rows.map((row) => row.column_name));
    // 精确列名黑名单：只允许计量数字、状态与关联 id（token 计数列除外，见下方白名单）。
    for (const forbidden of ["content", "messages", "prompt_text", "completion_text", "body", "request_body", "response_body", "api_key", "secret", "upstream_api_key"]) {
      expect(names.has(forbidden)).toBe(false);
    }
    expect([...names].sort()).toEqual([
      "cell_id", "completion_tokens", "consumed_tokens", "created_at", "latency_ms",
      "model", "outcome", "prompt_tokens", "request_id", "reserved_tokens",
      "session_id", "settled_at", "tenant_id", "total_tokens", "upstream_status", "user_id",
    ].sort());
  }, TIMEOUT);
});
