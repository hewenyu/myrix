/**
 * RuntimeRouter / 投递循环的**真实 Postgres + 明确假 driver** 集成测试。
 *
 * 为什么这样组合：
 *   * 存储侧（binding、commands、outbox、RLS、advisory lock、FIFO、退避）用真的 Postgres——
 *     队列语义的 bug 都藏在 SQL 与事务里，用内存替身等于什么都没测。
 *   * driver 侧用一个**显式的假 HTTP driver**——它按真实 HTTP 语义回应（状态码、SSE 帧、
 *     超时、拒绝），因此"不模拟成功"这条约束真的被验证：网络失败时命令必须留在队列里。
 *   * grant 用真实 ES256：验签用的是真公钥、真 claim 表，负例（改一个字节）必须失败。
 *
 * 独立随机 fixture：每次运行生成新的 tenant/member/work/session id，**只追加**数据，
 * 不 reset、不删库、不碰既有行（与 `postgres.integration.test.ts` 同一数据库约定）。
 *
 * 运行命令（与 bff 集成测试一致）：
 *
 * ```sh
 * BFF_TEST_DATABASE_URL='postgres://myrix_bff_test:myrix_local_bff_test@127.0.0.1:55439/myrix_bff_acceptance' \
 * BFF_TEST_MIGRATION_DATABASE_URL='postgres://myrix_migrator:myrix_local_migrator@127.0.0.1:55439/myrix_bff_acceptance' \
 * pnpm exec vitest run apps/bff/tests/runtime-router.test.ts
 * ```
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { createGrantSigner, createGrantVerifier, generateTestKeyPair, sha256Hex, type GrantVerifier } from "@myrix/grant";
import { authorizePlatform } from "@myrix/governance";
import type { PlatformIdentity } from "@myrix/contracts";
import { PlatformStore } from "../../../packages/platform-store/src/store";
import { createGovernanceAuthorizer } from "../../../packages/platform-store/src/authz";
import { migrateToLatest } from "../../../packages/platform-store/src/migrate";
import type { CommandsTable, MigrationDatabase, PlatformDatabase, SessionBindingsTable } from "../../../packages/platform-store/src/schema";
import type { Selectable } from "kysely";
import { OutboxRepository } from "../../../packages/platform-store/src/repositories/outbox";
import { PostgresNovelRepository } from "../src/novel-store";
import { createStaticCellDirectory } from "../src/runtime-cells";
import { CellCredentialRegistry, createBindingSnapshotReader } from "../src/works-server";
import { createDriverHttpClient, type DriverSseFrame } from "../src/runtime-driver-client";
import { createRuntimeRouter, RUNTIME_SERVICE_CAPABILITIES, receiptCommandId, subscribeCommandId, wireBodyOf, type RuntimeRuntime } from "../src/runtime-router";

const appUrl = process.env.BFF_TEST_DATABASE_URL;
const migrationUrl = process.env.BFF_TEST_MIGRATION_DATABASE_URL;

/** 一次 driver 调用的记录，用于断言"确实发了什么字节"。 */
interface DriverCall {
  method: string;
  path: string;
  authorization: string | undefined;
  body: Buffer | undefined;
  lastEventId: string | undefined;
}

/**
 * 明确假 driver：不是"永远成功"的替身，而是按需返回真实 HTTP 语义的测试驱动。
 * 默认一切都拒绝（503），每个用例必须显式声明它允许什么 —— 这样"忘记配置"不会变成
 * 一个看起来通过的用例。
 *
 * `GET /v1/commands/:id` 用**真实 ES256 验签**（`createGrantVerifier.verifyAndConsume`）：
 * 它强制要求查回执用一枚**全新**的 receipt grant（`op=subscribe`、`cmd=receipt-<id>`、
 * `bh=sha256(空正文)`、其余六字段与当次 principal/boot 一致）。语法 Bearer、复用 POST
 * grant、错误绑定都会在这里被拒 —— 因此"BFF 真的按冻结契约签发"是被验证的事实。
 */
class FakeDriver {
  readonly calls: DriverCall[] = [];
  bootId = "boot-fixed-1";
  ready = true;
  draining = false;
  posts: Array<{ status: number; body: unknown }> = [];
  receipt: { status: number; body: unknown } | undefined;
  readyBehavior: "ok" | "unreachable" | "timeout" | "stale-boot" = "ok";
  streamFrames: DriverSseFrame[] = [];
  streamStatus = 200;
  revokes: Array<{ path: string; body: unknown; authorization: string | undefined }> = [];
  revokeStatus = 200;
  /** 由 fixture 注入的验签器；未注入时 GET 回执一律 401（不允许"假验证"通过）。 */
  verifier: GrantVerifier | undefined;
  /** 测试观察：GET 回执路径上的验签/绑定结果。 */
  readonly receiptChecks: Array<
    | { kind: "accepted"; claims: Record<string, unknown>; commandId: string }
    | { kind: "rejected"; commandId: string; code: string }
  > = [];
  private hangUntilAbort = false;
  /** 第 N 次 POST 之后开始失败（用于验证退避重试与回执回读）。 */
  postFailureFrom: number | undefined;

  readonly client = createDriverHttpClient({
    deadlineMs: 2_000,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const path = new URL(url).pathname;
      const body = init?.body instanceof Uint8Array ? Buffer.from(init.body) : undefined;
      this.calls.push({
        method: init?.method ?? "GET",
        path,
        authorization: (init?.headers as Record<string, string> | undefined)?.["authorization"],
        body,
        lastEventId: (init?.headers as Record<string, string> | undefined)?.["last-event-id"],
      });
      if (path === "/v1/ready") {
        if (this.readyBehavior === "unreachable") throw new TypeError("fetch failed");
        if (this.readyBehavior === "timeout") {
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
          });
        }
        const bootId = this.readyBehavior === "stale-boot" ? "boot-fixed-1" : this.bootId;
        return new Response(JSON.stringify({ ready: this.ready, bootId, draining: this.draining }), { status: this.ready ? 200 : 503 });
      }
      if (path === "/v1/commands" && init?.method === "POST") {
        const index = this.calls.filter((call) => call.path === "/v1/commands" && call.method === "POST").length;
        if (this.hangUntilAbort) {
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
          });
        }
        if (this.postFailureFrom !== undefined && index >= this.postFailureFrom) {
          throw new TypeError("fetch failed");
        }
        const next = this.posts.shift();
        if (!next) return new Response(JSON.stringify({ error: "not_configured", reason: "测试未配置该 POST 的响应" }), { status: 500 });
        return new Response(JSON.stringify(next.body), { status: next.status });
      }
      if (path.startsWith("/v1/commands/")) {
        return this.handleReceiptGet(path.slice("/v1/commands/".length), init);
      }
      if (path.endsWith("/events")) {
        if (this.streamStatus !== 200) {
          return new Response(JSON.stringify({ error: "grant_rejected", reason: "凭证被拒" }), { status: this.streamStatus });
        }
        const frames = this.streamFrames;
        const encoded = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const frame of frames) {
              const id = frame.id === undefined ? "" : `id: ${String(frame.id)}\n`;
              controller.enqueue(encoded.encode(`${id}event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`));
            }
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      if (path === "/v1/admin/revoke") {
        this.revokes.push({
          path,
          body: body === undefined ? undefined : JSON.parse(body.toString("utf8")),
          authorization: (init?.headers as Record<string, string> | undefined)?.["authorization"],
        });
        if (this.revokeStatus !== 200) return new Response(JSON.stringify({ error: "admin_denied", reason: "凭据不足" }), { status: this.revokeStatus });
        const parsed = JSON.parse(body!.toString("utf8")) as { sid: string; rev: number };
        return new Response(JSON.stringify({ accepted: true, sid: parsed.sid, rev: parsed.rev, reason: "accepted", disposed: true, closedStreams: 1 }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "not_found", reason: "未知端点" }), { status: 404 });
    }) as typeof fetch,
  });

  /**
   * `GET /v1/commands/:id` 的真实语义：
   *   1. 取 Bearer → 用真实 verifier 以**固定绑定** `{op:'subscribe', cmd:'receipt-<id>', bh:sha256('')}`
   *      调 `verifyAndConsume`（这一步同时验签、验 claim 形、验六字段、消费 jti）；
   *      失败 → 401/403 + 机器可读 code（绝不放行）。
   *   2. 通过后按测试配置返回 200 回执或 404 no_receipt。
   */
  private handleReceiptGet(encodedCommandId: string, init?: RequestInit): Response {
    const commandId = decodeURIComponent(encodedCommandId);
    const authorization = (init?.headers as Record<string, string> | undefined)?.["authorization"];
    const token = authorization?.startsWith("Bearer ") === true ? authorization.slice("Bearer ".length) : undefined;
    if (this.verifier === undefined || token === undefined || token.length === 0) {
      this.receiptChecks.push({ kind: "rejected", commandId, code: "grant_missing" });
      return new Response(JSON.stringify({ error: "grant_missing", code: "grant_missing", reason: "缺少或未配置验签器" }), { status: 401 });
    }
    let claims;
    try {
      claims = this.verifier.verifyAndConsume(token, {
        op: "subscribe",
        cmd: receiptCommandId(commandId),
        bh: sha256Hex(Buffer.alloc(0)),
      });
    } catch (error) {
      const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "grant_rejected";
      this.receiptChecks.push({ kind: "rejected", commandId, code });
      return new Response(JSON.stringify({ error: code, code, reason: "凭证不合格" }), { status: 403 });
    }
    this.receiptChecks.push({ kind: "accepted", claims: claims as unknown as Record<string, unknown>, commandId });
    if (!this.receipt) return new Response("", { status: 404 });
    return new Response(JSON.stringify(this.receipt.body), { status: this.receipt.status });
  }

  post(body: unknown, status = 200): void {
    this.posts.push({ status, body });
  }
  hangNextPost(): void {
    this.hangUntilAbort = true;
  }
}

describe.skipIf(!appUrl || !migrationUrl)("BFF runtime router against real PostgreSQL", () => {
  const key = generateTestKeyPair("kid-runtime-e2e");
  const signer = createGrantSigner({ privateKey: key.privateKeyPem, kid: key.kid, issuer: "myrix-control-plane" });

  let migration: Kysely<MigrationDatabase>;
  let db: Kysely<PlatformDatabase>;

  /**
   * 每个用例一套**独立租户 fixture**。
   *
   * 为什么不能共用租户：投递循环按租户扫描候选命令（`plan.allTenants` 语义：一个 worker 会
   * 认领它能看到的全部租户），上一条用例留下的 queued 行会被下一条用例的 `dispatchOnce()`
   * 一起认领。测试之间必须靠租户边界隔离，而不是靠"上一条刚好清空了队列"。
   */
  interface Fixture {
    tenantId: string;
    owner: PlatformIdentity;
    cellId: string;
    serviceToken: string;
    workId: string;
    store: PlatformStore;
    driver: FakeDriver;
    runtime: RuntimeRuntime;
    newBinding(status?: "creating" | "active"): Promise<string>;
    commandsOf(bindingId: string): Promise<Selectable<CommandsTable>[]>;
    bindingOf(id: string): Promise<Selectable<SessionBindingsTable>>;
  }

  async function createFixture(): Promise<Fixture> {
    const tenantId = randomUUID();
    const owner: PlatformIdentity = { tenantId, userId: randomUUID(), role: "member", displayName: "作者" };
    const cellId = `cell-${randomUUID().slice(0, 8)}`;
    const serviceToken = `service-token-${randomUUID()}`;
    await migration.insertInto("tenants").values({ id: tenantId, slug: `rt-${tenantId.slice(0, 8)}-${randomUUID().slice(0, 6)}`, name: "runtime e2e" }).execute();
    await migration.insertInto("members").values({ tenant_id: tenantId, user_id: owner.userId, role: "member", status: "active", display_name: owner.displayName }).execute();
    const workId = randomUUID();
    await migration.insertInto("works").values({ tenant_id: tenantId, id: workId, owner_user_id: owner.userId, title: "运行时作品", description: "" }).execute();
    const store = new PlatformStore({
      db,
      authorizer: createGovernanceAuthorizer({ authorizePlatform }),
      serviceCapabilities: RUNTIME_SERVICE_CAPABILITIES,
    });
    const driver = new FakeDriver();
    // 假 driver 的 GET 回执用**真实** verifier 验签：只有 BFF 按冻结契约签发的新 grant 能通过。
    driver.verifier = createGrantVerifier({
      audience: cellId, tenantId, bootId: driver.bootId, startedAt: 0,
      issuer: "myrix-control-plane", keys: [key.jwk],
    });
    const runtime = createRuntimeRouter({
      store,
      signer,
      directory: createStaticCellDirectory([{ tenantId, cellId, baseUrl: "http://cell.invalid:7801", serviceToken }]),
      driver: driver.client,
      workerId: "test-worker",
      leaseMs: 30_000,
      claimBatch: 5,
      revalidateMs: 60_000,
      // 固定时钟：投递循环里的时间戳必须来自注入时钟，测试才能确定地复现。
      clock: () => new Date("2026-09-30T12:00:00.000Z"),
    });
    return {
      tenantId,
      owner,
      cellId,
      serviceToken,
      workId,
      store,
      driver,
      runtime,
      async newBinding(status: "creating" | "active" = "active"): Promise<string> {
        const id = randomUUID();
        await migration.insertInto("session_bindings").values({
          tenant_id: tenantId, id, owner_user_id: owner.userId, work_id: workId,
          preset: "novel-chapter", policy_revision: "test", cell_id: cellId, status, revoked_revision: 1,
        }).execute();
        return id;
      },
      async commandsOf(bindingId: string) {
        return await migration.selectFrom("commands").selectAll().where("tenant_id", "=", tenantId).where("binding_id", "=", bindingId).orderBy("created_at", "asc").execute();
      },
      async bindingOf(id: string) {
        return await migration.selectFrom("session_bindings").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
      },
    };
  }

  /** 快照读取用的 Cell 凭据注册表（与 fixture 的 serviceToken/cellId 绑定）。 */
  function credentialRegistry(fx: Fixture): CellCredentialRegistry {
    return new CellCredentialRegistry([{ tenantId: fx.tenantId, cellId: fx.cellId, token: fx.serviceToken }]);
  }

  beforeAll(async () => {
    migration = new Kysely<MigrationDatabase>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: migrationUrl, max: 2 }) }) });
    db = new Kysely<PlatformDatabase>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: appUrl, max: 4 }) }) });
    await migrateToLatest(migration);
  }, 30_000);

  afterAll(async () => {
    await db?.destroy();
    await migration?.destroy();
  });

  it("creates a binding and its create command in one transaction, then activates only on a real receipt", async () => {
    const fx = await createFixture();
    fx.driver.post({ status: "accepted", commandId: "placeholder", bootId: "boot-fixed-1" });
    const session = await fx.runtime.createSession(fx.owner, fx.workId, "novel-chapter");
    expect(session.status).toBe("creating");

    const queued = await fx.commandsOf(session.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ op: "create", status: "queued", binding_id: session.id, body_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // 入队正文与投递正文同形：body_hash 就是实际发送字节的摘要。
    const wire = wireBodyOf({ op: "create", bindingId: session.id, id: queued[0]!.id, body: queued[0]!.body as Record<string, unknown> });
    expect(wire).toEqual({ op: "create", sid: session.id, commandId: queued[0]!.id, preset: "novel-chapter", workId: fx.workId });
    expect(await fx.bindingOf(session.id)).toMatchObject({ status: "creating" });
    // 还没投递：不能假装已激活。
    expect(fx.driver.calls.filter((call) => call.path === "/v1/commands")).toHaveLength(0);

    // fx.driver 拒绝（503）时仍不能激活。
    fx.driver.posts = [];
    fx.driver.post({ error: "not_persisted", reason: "flush 没有监听者" }, 503);
    const first = await fx.runtime.dispatcher.dispatchOnce();
    expect(first).toMatchObject({ claimed: 1, settled: 0, released: 1 });
    expect(await fx.bindingOf(session.id)).toMatchObject({ status: "creating" });
    expect((await fx.commandsOf(session.id))[0]).toMatchObject({ status: "queued", attempts: 1 });

    // 退避窗口内不会被立刻重取；把 available_at 拨回当下即可重试（模拟时间前进）。
    await migration.updateTable("commands").set({ available_at: new Date(Date.now() - 1000) }).where("id", "=", queued[0]!.id).execute();
    fx.driver.post({ status: "accepted", commandId: queued[0]!.id, bootId: "boot-fixed-1" });
    const second = await fx.runtime.dispatcher.dispatchOnce();
    expect(second).toMatchObject({ claimed: 1, settled: 1, released: 0, failed: 0 });
    expect(await fx.bindingOf(session.id)).toMatchObject({ status: "active", cell_id: fx.cellId });
    expect((await fx.commandsOf(session.id))[0]).toMatchObject({ status: "succeeded" });

    // 投递的字节与签发凭证的 bh 一致：用真实 ES256 验签（错一个字节就得失败）。
    const post = fx.driver.calls.filter((call) => call.method === "POST" && call.path === "/v1/commands").at(-1)!;
    const verifier = createGrantVerifier({
      audience: fx.cellId, tenantId: fx.tenantId, bootId: "boot-fixed-1", startedAt: 0,
      issuer: "myrix-control-plane", keys: [key.jwk],
    });
    const token = post.authorization!.replace("Bearer ", "");
    const claims = verifier.verifyAndConsume(token, {
      op: "create", cmd: queued[0]!.id, bh: sha256Hex(post.body!),
    });
    expect(claims).toMatchObject({ op: "create", sid: session.id, sub: fx.owner.userId, wid: fx.workId, rev: 1 });
    // 篡改一个字节之后，同一枚凭证必须被拒（bh 绑定真实生效）。
    const tampered = Buffer.from(post.body!);
    tampered[0] = tampered[0]! ^ 0x20;
    expect(() => verifier.verifyAndConsume(token, { op: "create", cmd: queued[0]!.id, bh: sha256Hex(tampered) })).toThrow();
  }, 30_000);

  it("keeps per-session FIFO and never fakes success for send/cancel", async () => {
    const fx = await createFixture();
    const sid = await fx.newBinding("active");
    const first = randomUUID();
    const second = randomUUID();
    await expect(fx.runtime.send(fx.owner, sid, { commandId: first, text: "第一条" })).resolves.toEqual({ commandId: first, status: "queued" });
    await expect(fx.runtime.cancel(fx.owner, sid, second)).resolves.toEqual({ commandId: second, status: "queued" });

    // 第一条投递失败 → 第二条**不能**被跳过（FIFO + 串行）。
    fx.driver.postFailureFrom = 1;
    const round1 = await fx.runtime.dispatcher.dispatchOnce();
    expect(round1).toMatchObject({ claimed: 1, settled: 0, released: 1 });
    const rows = await fx.commandsOf(sid);
    expect(rows.map((row) => [row.id, row.status])).toEqual([[first, "queued"], [second, "queued"]]);
    expect(rows[1]!.attempts).toBe(0);

    // fx.driver 恢复：第一条先成功，第二条才被认领。
    fx.driver.postFailureFrom = undefined;
    await migration.updateTable("commands").set({ available_at: new Date(Date.now() - 1000) }).where("id", "=", first).execute();
    fx.driver.post({ status: "accepted", commandId: first, bootId: "boot-fixed-1" });
    fx.driver.post({ status: "accepted", commandId: second, bootId: "boot-fixed-1" });
    const round2 = await fx.runtime.dispatcher.dispatchOnce();
    expect(round2).toMatchObject({ claimed: 1, settled: 1 });
    expect((await fx.commandsOf(sid)).map((row) => [row.id, row.status])).toEqual([[first, "succeeded"], [second, "queued"]]);

    const round3 = await fx.runtime.dispatcher.dispatchOnce();
    expect(round3).toMatchObject({ claimed: 1, settled: 1 });
    const settled = await fx.commandsOf(sid);
    expect(settled.map((row) => row.status)).toEqual(["succeeded", "succeeded"]);
    // send 的正文确实带上了 text，且 op 正确。
    const sendCall = fx.driver.calls.filter((call) => call.method === "POST" && call.path === "/v1/commands").at(-2)!;
    expect(JSON.parse(sendCall.body!.toString("utf8"))).toEqual({ op: "send", sid, commandId: first, text: "第一条" });
  }, 30_000);

  it("recovers an unknown outcome with a fresh receipt grant, never by replaying the consumed POST grant", async () => {
    const fx = await createFixture();
    const sid = await fx.newBinding("active");
    const commandId = randomUUID();
    await fx.runtime.send(fx.owner, sid, { commandId, text: "超时用例" });
    fx.driver.hangNextPost();
    fx.driver.receipt = { status: 200, body: { status: "accepted", commandId, bootId: "boot-fixed-1", note: "已接收" } };
    const round = await fx.runtime.dispatcher.dispatchOnce();
    expect(round).toMatchObject({ claimed: 1, settled: 1 });
    // 超时之后只查了一次回执，**没有**盲目重发。
    // 注意：这里不比较"POST 总数"——超时那次的 fetch 已经进入 mock 并被记录，
    // 真正要断言的是"没有第二次携带同一 commandId 的 POST"。
    const postsAfter = fx.driver.calls.filter((call) => call.method === "POST" && call.path === "/v1/commands"
      && call.body !== undefined && (JSON.parse(call.body.toString("utf8")) as { commandId: string }).commandId === commandId).length;
    expect(postsAfter).toBe(1);
    const getCall = fx.driver.calls.find((call) => call.method === "GET" && call.path === `/v1/commands/${commandId}`);
    expect(getCall).toBeDefined();
    // 关键：GET 用的是**新签发的 receipt grant**，不是 POST 那枚已被消费的凭证。
    const postCall = fx.driver.calls.find((call) => call.method === "POST" && call.path === "/v1/commands");
    expect(getCall!.authorization).not.toBe(postCall!.authorization);

    // 冻结契约逐项核对（假 driver 已经用真实 verifyAndConsume 验过一次，这里再对 claim 断言）。
    const verifier = createGrantVerifier({ audience: fx.cellId, tenantId: fx.tenantId, bootId: "boot-fixed-1", startedAt: 0, issuer: "myrix-control-plane", keys: [key.jwk] });
    const claims = verifier.verifyAndConsume(getCall!.authorization!.replace("Bearer ", ""), {
      op: "subscribe", cmd: receiptCommandId(commandId), bh: sha256Hex(Buffer.alloc(0)),
    });
    expect(claims).toMatchObject({
      op: "subscribe", cmd: `receipt-${commandId}`, sid, tid: fx.tenantId,
      sub: fx.owner.userId, wid: fx.workId, rev: 1, boot: "boot-fixed-1",
    });
    // "其余六字段与当次 principal/boot 完全相同"：与 POST 那枚凭证逐字段相等。
    const postVerifier = createGrantVerifier({ audience: fx.cellId, tenantId: fx.tenantId, bootId: "boot-fixed-1", startedAt: 0, issuer: "myrix-control-plane", keys: [key.jwk] });
    const postClaims = postVerifier.verifyAndConsume(postCall!.authorization!.replace("Bearer ", ""), {
      op: "send", cmd: commandId, bh: sha256Hex(postCall!.body!),
    });
    for (const field of ["aud", "boot", "tid", "sid", "sub", "wid", "preset", "rev"] as const) {
      expect(claims[field], `receipt grant 的 ${field} 必须与 POST grant 相同`).toEqual(postClaims[field]);
    }
    expect(fx.driver.receiptChecks.at(-1)).toMatchObject({ kind: "accepted", commandId });
    expect((await fx.commandsOf(sid))[0]).toMatchObject({ status: "succeeded" });
  }, 30_000);

  it("keeps the receipt query verifiable after the POST grant has already been consumed", async () => {
    const fx = await createFixture();
    const sid = await fx.newBinding("active");
    const commandId = randomUUID();
    await fx.runtime.send(fx.owner, sid, { commandId, text: "POST 已消费" });

    // 真实的"结果未知"形态：driver **已经消费了 POST 的那枚 jti**（验签+绑定+消费全过），
    // 但响应在回程丢了。此时复用 POST grant 去查回执必然是重放 —— 所以 BFF 必须另签一枚。
    const postVerifier = createGrantVerifier({
      audience: fx.cellId, tenantId: fx.tenantId, bootId: "boot-fixed-1", startedAt: 0,
      issuer: "myrix-control-plane", keys: [key.jwk],
    });
    let postToken: string | undefined;
    let postRawBody: Buffer | undefined;
    const consumingDriver = {
      ...fx.driver.client,
      postCommand: async (_cell: Parameters<typeof fx.driver.client.postCommand>[0], rawBody: Buffer, grant: string) => {
        postToken = grant;
        postRawBody = rawBody;
        const body = JSON.parse(rawBody.toString("utf8")) as { op: "create" | "resume" | "send" | "cancel"; commandId: string };
        // driver 侧真的消费了这枚凭证。
        postVerifier.verifyAndConsume(grant, { op: body.op, cmd: body.commandId, bh: sha256Hex(rawBody) });
        return { ok: false as const, kind: "timeout" as const, reason: "driver 请求超时，结果未知（必须先查回执再决定是否重发）", retryable: true };
      },
    };
    const runtime = createRuntimeRouter({
      store: fx.store,
      signer,
      directory: createStaticCellDirectory([{ tenantId: fx.tenantId, cellId: fx.cellId, baseUrl: "http://cell.invalid:7801", serviceToken: fx.serviceToken }]),
      driver: consumingDriver,
      workerId: "consumed-worker",
      leaseMs: 30_000,
      clock: () => new Date("2026-09-30T12:00:00.000Z"),
    });
    fx.driver.receipt = { status: 200, body: { status: "accepted", commandId, bootId: "boot-fixed-1" } };
    const round = await runtime.dispatcher.dispatchOnce();
    expect(round).toMatchObject({ claimed: 1, settled: 1 });

    // POST 的 jti 已经烧掉：即便用**原样**的原文与绑定，第二次也是重放被拒。
    expect(postToken).toBeDefined();
    expect(() => postVerifier.verifyAndConsume(postToken!, { op: "send", cmd: commandId, bh: sha256Hex(postRawBody!) })).toThrow(/jti|replay/i);
    // 而拿它去查回执（GET 无正文）连 bh 都对不上：这正是"复用 POST grant"必然失败的原因。
    expect(() => postVerifier.verifyAndConsume(postToken!, { op: "send", cmd: commandId, bh: sha256Hex(Buffer.alloc(0)) })).toThrow(/body-hash-mismatch/);

    // GET 用的是新 grant，未消费过 → 真实 verifyAndConsume 通过。
    const getCall = fx.driver.calls.find((call) => call.method === "GET" && call.path === `/v1/commands/${commandId}`)!;
    expect(getCall.authorization).not.toBe(`Bearer ${postToken!}`);
    const getVerifier = createGrantVerifier({ audience: fx.cellId, tenantId: fx.tenantId, bootId: "boot-fixed-1", startedAt: 0, issuer: "myrix-control-plane", keys: [key.jwk] });
    const claims = getVerifier.verifyAndConsume(getCall.authorization!.replace("Bearer ", ""), {
      op: "subscribe", cmd: receiptCommandId(commandId), bh: sha256Hex(Buffer.alloc(0)),
    });
    expect(claims).toMatchObject({ op: "subscribe", cmd: `receipt-${commandId}`, sid, rev: 1, boot: "boot-fixed-1" });
    // 假 driver 侧同样验过一次，证明这枚新绑定真的成立。
    expect(fx.driver.receiptChecks.at(-1)).toMatchObject({ kind: "accepted", commandId });
    expect((await fx.commandsOf(sid))[0]).toMatchObject({ status: "succeeded" });
  }, 30_000);

  it("binds the receipt GET to cmd/path/body-hash: a mismatched binding must be rejected", async () => {
    const fx = await createFixture();
    const sid = await fx.newBinding("active");
    const commandId = randomUUID();
    await fx.runtime.send(fx.owner, sid, { commandId, text: "绑定负例" });
    fx.driver.hangNextPost();
    fx.driver.receipt = { status: 200, body: { status: "accepted", commandId, bootId: "boot-fixed-1" } };
    await fx.runtime.dispatcher.dispatchOnce();
    const token = fx.driver.calls
      .find((call) => call.method === "GET" && call.path === `/v1/commands/${commandId}`)!
      .authorization!.replace("Bearer ", "");

    const verifier = createGrantVerifier({ audience: fx.cellId, tenantId: fx.tenantId, bootId: "boot-fixed-1", startedAt: 0, issuer: "myrix-control-plane", keys: [key.jwk] });
    // 1) cmd 绑定：换成别的 commandId（或 subscribe-<sid>）必须失败。
    expect(() => verifier.verifyAndConsume(token, { op: "subscribe", cmd: receiptCommandId(randomUUID()), bh: sha256Hex(Buffer.alloc(0)) })).toThrow();
    expect(() => verifier.verifyAndConsume(token, { op: "subscribe", cmd: subscribeCommandId(sid), bh: sha256Hex(Buffer.alloc(0)) })).toThrow();
    // 2) 正文绑定：GET 没有正文，bh 必须是空正文摘要；拿 POST 正文摘要去对必然失败。
    const postBody = fx.driver.calls.find((call) => call.method === "POST" && call.path === "/v1/commands")!.body!;
    expect(() => verifier.verifyAndConsume(token, { op: "subscribe", cmd: receiptCommandId(commandId), bh: sha256Hex(postBody) })).toThrow();
    // 3) op 绑定：投递 op（send）也不能拿来查回执。
    expect(() => verifier.verifyAndConsume(token, { op: "send", cmd: receiptCommandId(commandId), bh: sha256Hex(Buffer.alloc(0)) })).toThrow();
    // 4) 六字段一致：这些对不上同样被拒（aud/tid/boot 在 verifier 构造时绑定）。
    for (const audience of ["cell-other", fx.cellId]) {
      const strict = createGrantVerifier({
        audience,
        tenantId: audience === fx.cellId ? fx.tenantId : randomUUID(),
        bootId: audience === fx.cellId ? "boot-fixed-1" : "boot-other",
        startedAt: 0, issuer: "myrix-control-plane", keys: [key.jwk],
      });
      if (audience === fx.cellId) expect(strict.verifyAndConsume).toBeDefined();
      else expect(() => strict.verifyAndConsume(token, { op: "subscribe", cmd: receiptCommandId(commandId), bh: sha256Hex(Buffer.alloc(0)) })).toThrow(/aud|tid|boot/);
    }
    // 同一枚 receipt grant 的 jti 只能消费一次：第一次成功，第二次必须被拒（重放）。
    const replayCheck = createGrantVerifier({ audience: fx.cellId, tenantId: fx.tenantId, bootId: "boot-fixed-1", startedAt: 0, issuer: "myrix-control-plane", keys: [key.jwk] });
    expect(replayCheck.verifyAndConsume(token, { op: "subscribe", cmd: receiptCommandId(commandId), bh: sha256Hex(Buffer.alloc(0)) })).toBeDefined();
    expect(() => replayCheck.verifyAndConsume(token, { op: "subscribe", cmd: receiptCommandId(commandId), bh: sha256Hex(Buffer.alloc(0)) })).toThrow(/jti|replay/i);
  }, 30_000);

  it("issues a distinct fresh receipt grant for each unknown-outcome recovery", async () => {
    const fx = await createFixture();
    const sid = await fx.newBinding("active");
    const commandId = randomUUID();
    await fx.runtime.send(fx.owner, sid, { commandId, text: "两次查询各有新 jti" });
    // 第一次：POST 超时 → GET 未配置回执（404）→ release；第二次重试：POST 失败 → GET 仍 404。
    // 两次 GET 必须是两枚不同凭证（各自新 jti），且都不能复用 POST 的那枚。
    fx.driver.hangNextPost();
    fx.driver.postFailureFrom = undefined;
    await fx.runtime.dispatcher.dispatchOnce();
    await migration.updateTable("commands").set({ available_at: new Date(Date.now() - 1000) }).where("id", "=", commandId).execute();
    fx.driver.postFailureFrom = 1;
    await fx.runtime.dispatcher.dispatchOnce();
    const gets = fx.driver.calls.filter((call) => call.method === "GET" && call.path === `/v1/commands/${commandId}`);
    expect(gets.length).toBe(2);
    expect(gets[0]!.authorization).not.toBe(gets[1]!.authorization);
    const postToken = fx.driver.calls.find((call) => call.method === "POST" && call.path === "/v1/commands")!.authorization;
    expect(gets.every((call) => call.authorization !== postToken)).toBe(true);
    // 两次都真的通过了验签（不是语法 Bearer 假验证）。
    expect(fx.driver.receiptChecks.filter((check) => check.kind === "accepted")).toHaveLength(2);
    expect((await fx.commandsOf(sid))[0]!.status).toBe("queued");
  }, 30_000);

  it("refuses to trust a GET whose receipt grant fails real verification", async () => {
    const fx = await createFixture();
    const sid = await fx.newBinding("active");
    const commandId = randomUUID();
    await fx.runtime.send(fx.owner, sid, { commandId, text: "假验证负例" });
    // 用**错误的公钥**构造 driver 的验签器：BFF 签得再对，driver 侧也必须拒。
    const otherKey = generateTestKeyPair("kid-wrong");
    fx.driver.verifier = createGrantVerifier({
      audience: fx.cellId, tenantId: fx.tenantId, bootId: fx.driver.bootId, startedAt: 0,
      issuer: "myrix-control-plane", keys: [otherKey.jwk],
    });
    fx.driver.hangNextPost();
    fx.driver.receipt = { status: 200, body: { status: "accepted", commandId, bootId: "boot-fixed-1" } };
    const round = await fx.runtime.dispatcher.dispatchOnce();
    // 验签失败的 GET 被当成查询失败：命令保持队列退避，绝不按"查到回执"结算。
    expect(round).toMatchObject({ claimed: 1, settled: 0, released: 1 });
    expect(fx.driver.receiptChecks.at(-1)).toMatchObject({ kind: "rejected", commandId });
    expect((await fx.commandsOf(sid))[0]).toMatchObject({ status: "queued", attempts: 1 });
  }, 30_000);

  it("applies exponential backoff and stops retrying forever once attempts are exhausted", async () => {
    const fx = await createFixture();
    const sid = await fx.newBinding("active");
    const commandId = randomUUID();
    await fx.runtime.send(fx.owner, sid, { commandId, text: "重试用例" });
    // 把最大尝试次数压到 2，避免测试里真的跑 5 轮。
    await migration.updateTable("commands").set({ max_attempts: 2 }).where("id", "=", commandId).execute();
    fx.driver.postFailureFrom = 1;

    await fx.runtime.dispatcher.dispatchOnce();
    let row = (await fx.commandsOf(sid))[0]!;
    // POST 超时（2s deadline）后先查回执；测试未配置回执 → 404 → 才 release 退避。
    expect(row).toMatchObject({ status: "queued", attempts: 1 });
    expect(row.available_at.getTime()).toBeGreaterThan(Date.now());

    await migration.updateTable("commands").set({ available_at: new Date(Date.now() - 1000) }).where("id", "=", commandId).execute();
    await fx.runtime.dispatcher.dispatchOnce();
    row = (await fx.commandsOf(sid))[0]!;
    // attempts 撞上 max_attempts → dead（带 last_error），不会无限重试。
    expect(row).toMatchObject({ status: "dead", attempts: 2 });
    expect(row.last_error).toMatch(/unreachable/);

    fx.driver.postFailureFrom = undefined;
    const drained = await fx.runtime.dispatcher.dispatchOnce();
    expect(drained.claimed).toBe(0);
    expect((await fx.commandsOf(sid))[0]!.status).toBe("dead");
  }, 30_000);

  it("never delivers to a revoked binding or a disabled member, and honours the current revision", async () => {
    const fx = await createFixture();
    const sid = await fx.newBinding("active");
    const commandId = randomUUID();
    await fx.runtime.send(fx.owner, sid, { commandId, text: "撤权用例" });
    await migration.updateTable("session_bindings")
      .set({ status: "revoked", revoked_at: new Date(), revoked_revision: 2 })
      .where("id", "=", sid).execute();
    // 撤权后的绑定不再产生投递候选：命令原样留在队列里等审计/运维，fx.driver 一次都没被调用。
    const round = await fx.runtime.dispatcher.dispatchOnce();
    expect(round).toMatchObject({ claimed: 0, failed: 0 });
    const row = (await fx.commandsOf(sid))[0]!;
    expect(row).toMatchObject({ status: "queued", attempts: 0 });
    expect(fx.driver.calls.filter((call) => call.path === "/v1/commands" && call.method === "POST")).toHaveLength(0);

    // 成员停用：即使绑定仍然 active 也不能投递。
    const live = await fx.newBinding("active");
    const liveCommand = randomUUID();
    await fx.runtime.send(fx.owner, live, { commandId: liveCommand, text: "成员停用" });
    await migration.updateTable("members").set({ status: "disabled", disabled_at: new Date() })
      .where("tenant_id", "=", fx.tenantId).where("user_id", "=", fx.owner.userId).execute();
    try {
      const blocked = await fx.runtime.dispatcher.dispatchOnce();
      expect(blocked).toMatchObject({ failed: 1 });
      expect((await fx.commandsOf(live))[0]!.receipt).toMatchObject({ error: "forbidden" });
    } finally {
      await migration.updateTable("members").set({ status: "active", disabled_at: null })
        .where("tenant_id", "=", fx.tenantId).where("user_id", "=", fx.owner.userId).execute();
    }
  }, 30_000);

  it("archives and restores a session without touching the revocation state", async () => {
    const fx = await createFixture();
    const sid = await fx.newBinding("active");
    const created = await fx.runtime.archive(fx.owner, sid, true);
    expect(created.archivedAt).not.toBeNull();
    expect(created.status).toBe("active");

    // 归档**不是**撤权：status / revoked_revision / revoked_at 都不动，也不发 outbox。
    const row = await fx.bindingOf(sid);
    expect(row).toMatchObject({ status: "active", revoked_revision: 1, revoked_at: null });
    expect(row.archived_at).not.toBeNull();
    expect(await migration.selectFrom("outbox_messages").select(["id"])
      .where("tenant_id", "=", fx.tenantId).where("topic", "=", "session.revoke").execute()).toEqual([]);

    // 归档期间唯一新增的边界是**新的 send**：409 session_archived，可读、提示恢复，
    // 且不为这条被拒的消息落任何命令行。
    await expect(fx.runtime.send(fx.owner, sid, { commandId: randomUUID(), text: "归档后发送" }))
      .rejects.toMatchObject({ statusCode: 409, code: "session_archived" });
    expect(await fx.commandsOf(sid)).toEqual([]);

    // cancel **必须**仍然可用：作者要能停下一条已在跑的任务，否则归档会变成"只能看着它跑"。
    await expect(fx.runtime.cancel(fx.owner, sid, randomUUID()))
      .resolves.toMatchObject({ status: "queued" });
    expect((await fx.commandsOf(sid)).map((command) => command.op)).toEqual(["cancel"]);

    // 事件流**不**因归档中断：完整历史照常可读（这里用一条持久 user 消息证明订阅真的建立了）。
    fx.driver.streamFrames = [
      { id: 7, event: "user/message", data: { id: "m-archive", role: "user", content: [{ type: "text", text: "归档前的历史" }], source: { kind: "user" } } },
    ];
    const streaming = await fx.runtime.events(fx.owner, sid, 0, new AbortController().signal);
    const collected = [];
    for await (const event of streaming) collected.push(event);
    expect(collected).toEqual([{ type: "user", seq: 7, text: "归档前的历史" }]);
    expect(fx.driver.calls.some((call) => call.path.endsWith("/events"))).toBe(true);

    // 归档仍然可读：会话列表里带着 archivedAt（不是被隐藏，也不是 revoked）。
    const listed = await new PostgresNovelRepository(fx.store).listSessions(fx.owner, fx.workId);
    const listedSession = listed.find((session) => session.id === sid);
    expect(listedSession).toMatchObject({ id: sid, status: "active" });
    expect(listedSession?.archivedAt).toBe(created.archivedAt);

    // 恢复后立即可用：同一条会话可以重新发送。
    const restored = await fx.runtime.archive(fx.owner, sid, false);
    expect(restored.archivedAt).toBeNull();
    await expect(fx.runtime.send(fx.owner, sid, { commandId: randomUUID(), text: "恢复后发送" }))
      .resolves.toMatchObject({ status: "queued" });
  }, 30_000);

  it("delivers a command that was enqueued before the archive", async () => {
    const fx = await createFixture();
    const sid = await fx.newBinding("active");
    const commandId = randomUUID();
    await fx.runtime.send(fx.owner, sid, { commandId, text: "归档前已入队" });
    // 归档只整理历史，不停止任务：归档前入队的命令在归档后必须照常投给 cell。
    await fx.runtime.archive(fx.owner, sid, true);
    fx.driver.post({ status: "accepted", commandId, bootId: "boot-fixed-1" });

    const round = await fx.runtime.dispatcher.dispatchOnce();
    expect(round).toMatchObject({ claimed: 1, settled: 1, failed: 0 });
    const row = (await fx.commandsOf(sid))[0]!;
    expect(row.status).toBe("succeeded");
    // 真的 POST 给了 cell（而不是像旧实现那样本地判 archived-binding 失败）。
    expect(fx.driver.calls.filter((call) => call.method === "POST" && call.path === "/v1/commands").length).toBe(1);
  }, 30_000);

  it("keeps archived sessions inside the Cell authorization snapshot", async () => {
    const fx = await createFixture();
    const sid = await fx.newBinding("active");
    const snapshot = createBindingSnapshotReader(fx.store, credentialRegistry(fx));
    const before = await snapshot(`Bearer ${fx.serviceToken}`, fx.cellId);
    expect(before.bindings.map((binding) => binding.sid)).toContain(sid);

    // 归档不改 Cell 工具权限/活性租约：快照必须原样包含该会话，否则归档会把一条
    // 仍在执行的会话从 Cell 的可服务主体里摘掉。
    await fx.runtime.archive(fx.owner, sid, true);
    const after = await snapshot(`Bearer ${fx.serviceToken}`, fx.cellId);
    expect(after.bindings.map((binding) => binding.sid)).toContain(sid);

    await fx.runtime.archive(fx.owner, sid, false);
    const restored = await snapshot(`Bearer ${fx.serviceToken}`, fx.cellId);
    expect(restored.bindings.map((binding) => binding.sid)).toContain(sid);
  }, 30_000);

  it("enqueues only durable commands and refuses a reused commandId with different content", async () => {
    const fx = await createFixture();
    const sid = await fx.newBinding("active");
    const commandId = randomUUID();
    await fx.runtime.send(fx.owner, sid, { commandId, text: "原始正文" });
    // 同 commandId 换正文：仓储层必须拒绝（duplicate_request → 409）。
    await expect(fx.runtime.send(fx.owner, sid, { commandId, text: "换了正文" })).rejects.toMatchObject({ statusCode: 409 });
    // 同 commandId 同正文：幂等返回 queued，不产生第二行。
    await expect(fx.runtime.send(fx.owner, sid, { commandId, text: "原始正文" })).resolves.toEqual({ commandId, status: "queued" });
    expect(await fx.commandsOf(sid)).toHaveLength(1);
    // 不是所有者：404，不泄漏存在性。
    const stranger: PlatformIdentity = { tenantId: fx.tenantId, userId: randomUUID(), role: "member", displayName: "他人" };
    await expect(fx.runtime.send(stranger, sid, { commandId: randomUUID(), text: "越权" })).rejects.toMatchObject({ statusCode: 404 });
    // 空正文在路由层就被拒绝。
    await expect(fx.runtime.send(fx.owner, sid, { commandId: randomUUID(), text: "   " })).rejects.toMatchObject({ statusCode: 400 });
  }, 30_000);

  it("revokes database-first and keeps an outbox record for fx.driver notification", async () => {
    const fx = await createFixture();
    const sid = await fx.newBinding("active");
    await fx.runtime.revoke(fx.owner, sid);
    expect(await fx.bindingOf(sid)).toMatchObject({ status: "revoked", revoked_revision: 2 });
    const pending = await new OutboxRepository(fx.store).listPending(fx.tenantId);
    const revoke = pending.find((message) => message.topic === "session.revoke" && message.dedupeKey.endsWith(`:${sid}:2`));
    expect(revoke).toBeDefined();
    expect(revoke!.payload).toMatchObject({ sessionId: sid, revokedRevision: 2, cellId: fx.cellId });

    // fx.driver 拒绝时：撤权结论不回滚，消息留在 outbox 等待重试。
    fx.driver.revokeStatus = 403;
    const failed = await fx.runtime.dispatcher.dispatchOutboxOnce();
    expect(failed.claimed).toBeGreaterThanOrEqual(1);
    expect(failed.delivered).toBe(0);
    expect(await fx.bindingOf(sid)).toMatchObject({ status: "revoked" });

    fx.driver.revokeStatus = 200;
    await migration.updateTable("outbox_messages").set({ available_at: new Date(Date.now() - 1000) })
      .where("tenant_id", "=", fx.tenantId).where("dedupe_key", "=", `session.revoke:${sid}:2`).execute();
    const delivered = await fx.runtime.dispatcher.dispatchOutboxOnce();
    expect(delivered.delivered).toBeGreaterThanOrEqual(1);
    // 发送给 fx.driver 的 admin revoke 带上了 service credential，且只含必要字段。
    const call = fx.driver.revokes.at(-1)!;
    expect(call.authorization).toBe(`Bearer ${fx.serviceToken}`);
    expect(call.body).toEqual({ sid, rev: 2, reason: expect.any(String) });
    const after = (await new OutboxRepository(fx.store).listPending(fx.tenantId)).find((message) => message.dedupeKey === `session.revoke:${sid}:2`);
    expect(after).toBeUndefined();
  }, 30_000);

  it("projects the live event stream with a whitelist, honours Last-Event-ID and aborts", async () => {
    const fx = await createFixture();
    const sid = await fx.newBinding("active");
    fx.driver.streamFrames = [
      { id: 10, event: "user/message", data: { id: "m-1", role: "user", content: [{ type: "text", text: "你好" }], source: { kind: "user" } } },
      { event: "myrix/ready", data: { sid } },
      { id: 11, event: "request/header", data: { tools: [{ name: "secret" }], config: { model: "private-model" } } },
      { event: "myrix/assistant-stream", data: { type: "start", attemptId: "a1", revision: 1, turn: 1, step: 1 } },
      { event: "myrix/assistant-stream", data: { type: "chunk", attemptId: "a1", revision: 1, index: 0, time: 1, chunk: { type: "reasoning-delta", index: 0, text: "不要外泄的推理" } } },
      { event: "myrix/assistant-stream", data: { type: "chunk", attemptId: "a1", revision: 1, index: 1, time: 2, chunk: { type: "text-delta", index: 0, text: "增量" } } },
      { event: "myrix/assistant-stream", data: { type: "end", attemptId: "a1", revision: 1, index: 2, outcome: { kind: "abandoned" } } },
      { id: 12, event: "assistant/message", data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "回答" }, { type: "reasoning", text: "推理" }] }, stream: [] } },
      { event: "myrix/assistant-stream", data: { type: "end", attemptId: "a1", revision: 1, index: 3, outcome: { kind: "committed", eventType: "assistant/message", seq: 12 } } },
      { id: 15, event: "tool/result", data: { turn: 1, step: 1, message: { role: "tool", toolCallId: "call-1", content: [{ type: "text", text: "工具结果" }] }, error: { name: "ToolError", code: "E_TOOL", reason: "内部原因" } } },
      { event: "myrix/truncated", data: { sid, from: 1, availableFrom: 40 } },
      { id: 13, event: "tool/call", data: { turn: 1, step: 1, callId: "call-1", name: "save_chapter_draft", arguments: '{"text":"正文"}' } },
      { id: 14, event: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
    ];
    const controller = new AbortController();
    const events = await fx.runtime.events(fx.owner, sid, 9, controller.signal);
    const collected = [];
    for await (const event of events) collected.push(event);
    expect(collected).toEqual([
      { type: "user", seq: 10, text: "你好" },
      // start → stream-start：前端 reducer 据此清掉未提交 delta。
      { type: "status", status: "stream-start" },
      { type: "delta", text: "增量" },
      // abandoned end → stream-abandoned：本轮流被丢弃。
      { type: "status", status: "stream-abandoned" },
      { type: "assistant", seq: 12, text: "回答" },
      { type: "status", status: "replay-required" },
      { type: "tool", seq: 13, toolName: "save_chapter_draft", commandId: "call-1" },
      { type: "turn-end", seq: 14 },
    ]);
    // 下游看不到 prompt、工具 schema、推理内容、工具结果或内部错误原因；committed end 也不合成 assistant.final。
    expect(JSON.stringify(collected)).not.toMatch(/secret|private-model|推理|工具结果|内部原因/);
    expect(collected.some((event) => event.type === "assistant" && event.seq === undefined)).toBe(false);
    const seqs = collected.flatMap((event) => (typeof event.seq === "number" ? [event.seq] : []));
    // 公开 seq 合法跳跃：11（request/header）与 15（tool/result）被白名单过滤。
    expect(seqs).toEqual([10, 12, 13, 14]);
    // subscribe 凭证：op/cmd/bh 与 fx.driver 约定逐字一致，且 Last-Event-ID 被转发。
    const streamCall = fx.driver.calls.filter((call) => call.path.endsWith("/events")).at(-1)!;
    expect(streamCall.lastEventId).toBe("9");
    const verifier = createGrantVerifier({ audience: fx.cellId, tenantId: fx.tenantId, bootId: "boot-fixed-1", startedAt: 0, issuer: "myrix-control-plane", keys: [key.jwk] });
    const claims = verifier.verifyAndConsume(streamCall.authorization!.replace("Bearer ", ""), {
      op: "subscribe", cmd: subscribeCommandId(sid), bh: sha256Hex(Buffer.alloc(0)),
    });
    expect(claims).toMatchObject({ op: "subscribe", sid, cmd: `subscribe-${sid}` });

    // 中途 abort：迭代立刻结束，不阻塞。
    const abortController = new AbortController();
    const reopened = await fx.runtime.events(fx.owner, sid, 9, abortController.signal);
    const iterator = reopened[Symbol.asyncIterator]();
    await iterator.next();
    abortController.abort();
    const rest = await iterator.next();
    expect(rest.done).toBe(true);
  }, 30_000);

  it("forwards the initial cursor 0 as Last-Event-ID: 0 instead of dropping it as live-only", async () => {
    const fx = await createFixture();
    const sid = await fx.newBinding("active");
    fx.driver.streamFrames = [
      { id: 5, event: "user/message", data: { id: "m-1", role: "user", content: [{ type: "text", text: "重载后仍应看到" }], source: { kind: "user" } } },
      { id: 8, event: "assistant/message", data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "已回答" }] }, stream: [] } },
      { id: 10, event: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
    ];
    const controller = new AbortController();

    // 初始订阅（HTTP 边界缺省 cursor 就是 0）必须转发 0：driver 侧 undefined = live-only，
    // 0 = 从 seq>0 补发。旧实现把 0 折叠成 undefined，driver 于是只回水位标记，
    // 已提交的 user/assistant/turn-end 全部丢失。
    const initial = await fx.runtime.events(fx.owner, sid, 0, controller.signal);
    const seen = [];
    for await (const event of initial) seen.push(event);
    expect(seen).toEqual([
      { type: "user", seq: 5, text: "重载后仍应看到" },
      { type: "assistant", seq: 8, text: "已回答" },
      { type: "turn-end", seq: 10 },
    ]);
    const zeroCall = fx.driver.calls.filter((call) => call.path.endsWith("/events")).at(-1)!;
    // 精确断言：`0` 被原样转发，而不是"没有这个头"。
    expect(zeroCall.lastEventId).toBe("0");
    expect(zeroCall.lastEventId).not.toBeUndefined();

    // >0 续传同样是单调水位，且不回退成 0（不重放已确认的旧事件）。
    const resumed = await fx.runtime.events(fx.owner, sid, 6, controller.signal);
    for await (const _event of resumed) { /* 走完即可，断言在头与前一条相同 */ }
    const resumedCall = fx.driver.calls.filter((call) => call.path.endsWith("/events")).at(-1)!;
    expect(resumedCall.lastEventId).toBe("6");

    // 非法 cursor 回归保留：负数/小数/NaN/超安全整数一律 400 invalid_cursor，绝不静默当成 0。
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY]) {
      await expect(fx.runtime.events(fx.owner, sid, bad, controller.signal)).rejects.toMatchObject({
        statusCode: 400, code: "invalid_cursor",
      });
    }
  }, 30_000);

  it("closes an open stream when the binding is revoked mid-stream (continuous revalidation)", async () => {
    const fx = await createFixture();
    const sid = await fx.newBinding("active");
    // 可变时钟把"复核间隔"跨过去；driver 侧只发一条持久事件，流随后结束。
    let nowMs = Date.parse("2026-09-30T12:00:00.000Z");
    const runtime = createRuntimeRouter({
      store: fx.store,
      signer,
      directory: createStaticCellDirectory([{ tenantId: fx.tenantId, cellId: fx.cellId, baseUrl: "http://cell.invalid:7801", serviceToken: fx.serviceToken }]),
      driver: fx.driver.client,
      workerId: "revalidate-worker",
      revalidateMs: 1_000,
      clock: () => new Date(nowMs),
    });
    fx.driver.streamFrames = [
      { id: 1, event: "user/message", data: { id: "m-1", role: "user", content: [{ type: "text", text: "开头" }], source: { kind: "user" } } },
    ];
    // 打开流之后把 rev 推进；用一个"永不产生下一帧"的迭代器模拟空闲会话，
    // 只有**独立定时器**触发的复核才能结束这条流。
    let abortedByRevalidation = false;
    // 先给一帧（证明正常投影），随后**永不**产生下一帧：只有独立定时器能结束这条流。
    const idleFrames: AsyncIterable<DriverSseFrame> = {
      [Symbol.asyncIterator]() {
        let delivered = false;
        return {
          next: () => {
            if (!delivered) {
              delivered = true;
              return Promise.resolve({
                done: false,
                value: { id: 1, event: "user/message", data: { content: [{ type: "text", text: "开头" }] } } satisfies DriverSseFrame,
              });
            }
            return new Promise<IteratorResult<DriverSseFrame>>(() => undefined);
          },
          return: async () => {
            abortedByRevalidation = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const streamed = createRuntimeRouter({
      store: fx.store,
      signer,
      directory: createStaticCellDirectory([{ tenantId: fx.tenantId, cellId: fx.cellId, baseUrl: "http://cell.invalid:7801", serviceToken: fx.serviceToken }]),
      driver: {
        ...fx.driver.client,
        streamEvents: async () => ({ ok: true as const, value: idleFrames }),
      },
      workerId: "revalidate-worker-2",
      revalidateMs: 25,
      clock: () => new Date(nowMs),
    });
    const controller = new AbortController();
    const events = await streamed.events(fx.owner, sid, 0, controller.signal);
    const iterator = events[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toEqual({ type: "user", seq: 1, text: "开头" });
    await migration.updateTable("session_bindings")
      .set({ status: "revoked", revoked_at: new Date(), revoked_revision: 2 }).where("id", "=", sid).execute();
    const closed = await iterator.next();
    expect(closed.value).toMatchObject({ type: "status", status: expect.stringContaining("session-ended") });
    expect(closed.done).not.toBe(true);
    await iterator.return?.(undefined as never);
    // 复核不通过时必须停止继续读上游（取消订阅），而不是把连接挂着。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(abortedByRevalidation).toBe(true);
    await streamed.dispatcher.stop();
    await runtime.dispatcher.stop();
  }, 30_000);

  it("refuses to open a stream for a revoked session, a stranger, or a fx.driver that rejects the grant", async () => {
    const fx = await createFixture();
    const sid = await fx.newBinding("active");
    const controller = new AbortController();
    const stranger: PlatformIdentity = { tenantId: fx.tenantId, userId: fx.owner.userId, role: "admin", displayName: "管理员" };
    // admin 也不能读别人的会话（actor.role 不参与判定）。
    await expect(fx.runtime.events({ ...stranger, userId: randomUUID() }, sid, 0, controller.signal)).rejects.toMatchObject({ statusCode: 404 });

    await migration.updateTable("session_bindings")
      .set({ status: "revoked", revoked_at: new Date(), revoked_revision: 2 }).where("id", "=", sid).execute();
    await expect(fx.runtime.events(fx.owner, sid, 0, controller.signal)).rejects.toMatchObject({ statusCode: 410 });

    const live = await fx.newBinding("active");
    fx.driver.streamStatus = 403;
    await expect(fx.runtime.events(fx.owner, live, 0, controller.signal)).rejects.toMatchObject({ statusCode: 502 });
    fx.driver.streamStatus = 200;
  }, 30_000);

  it("does not report a session subscription as active before the cell is ready", async () => {
    const fx = await createFixture();
    const sid = await fx.newBinding("active");
    const controller = new AbortController();
    fx.driver.readyBehavior = "unreachable";
    try {
      await expect(fx.runtime.events(fx.owner, sid, 0, controller.signal)).rejects.toMatchObject({ statusCode: 503 });
    } finally {
      fx.driver.readyBehavior = "ok";
    }
    fx.driver.ready = false;
    try {
      await expect(fx.runtime.events(fx.owner, sid, 0, controller.signal)).rejects.toMatchObject({ statusCode: 503 });
    } finally {
      fx.driver.ready = true;
    }
  }, 30_000);

  it("refuses to deliver when the injected directory returns a cell that serves another tenant", async () => {
    const fx = await createFixture();
    const sid = await fx.newBinding("active");
    const commandId = randomUUID();
    await fx.runtime.send(fx.owner, sid, { commandId, text: "跨租户目录" });
    // 一个**手写**的可注入目录：它绕过了静态目录的构造期检查，byId/resolve 都返回别人的 endpoint。
    const foreign = { tenantId: randomUUID(), cellId: fx.cellId, baseUrl: "http://cell.invalid:7801", serviceToken: fx.serviceToken };
    const hostile = createRuntimeRouter({
      store: fx.store,
      signer,
      directory: {
        async resolve() { return foreign; },
        async byId() { return foreign; },
        async tenants() { return [fx.tenantId]; },
      },
      driver: fx.driver.client,
      workerId: "hostile-directory",
      leaseMs: 30_000,
    });
    const round = await hostile.dispatcher.dispatchOnce();
    // 拿到的 endpoint 不服务本租户 → 视为"没有放置"：保持队列退避，绝不投到别人的 cell。
    expect(round).toMatchObject({ claimed: 1, settled: 0, released: 1, failed: 0 });
    expect((await fx.commandsOf(sid))[0]).toMatchObject({ status: "queued", attempts: 1 });
    expect(fx.driver.calls.filter((call) => call.method === "POST" && call.path === "/v1/commands")).toHaveLength(0);
    // createSession 同样 fail-closed。
    await expect(hostile.createSession(fx.owner, fx.workId, "novel-chapter")).rejects.toMatchObject({ statusCode: 503 });
  }, 30_000);

  it("starts and stops the background dispatcher without duplicate delivery", async () => {
    const fx = await createFixture();
    const sid = await fx.newBinding("active");
    const commandId = randomUUID();
    fx.driver.post({ status: "accepted", commandId, bootId: "boot-fixed-1" });
    await fx.runtime.send(fx.owner, sid, { commandId, text: "后台投递" });
    fx.runtime.dispatcher.start();
    expect(fx.runtime.dispatcher.running).toBe(true);
    fx.runtime.dispatcher.start(); // 幂等
    const deadline = Date.now() + 8_000;
    let status = "queued";
    while (Date.now() < deadline) {
      status = (await fx.commandsOf(sid))[0]!.status;
      if (status === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await fx.runtime.dispatcher.stop();
    expect(fx.runtime.dispatcher.running).toBe(false);
    expect(status).toBe("succeeded");
    // 只投递一次：第二条 POST 不存在。
    const posts = fx.driver.calls.filter((call) => call.method === "POST" && call.path === "/v1/commands" && JSON.parse(call.body!.toString("utf8")).commandId === commandId);
    expect(posts).toHaveLength(1);
  }, 30_000);

  it("stops only after the in-flight round has finished (no delivery runs past stop)", async () => {
    const fx = await createFixture();
    const sid = await fx.newBinding("active");
    const commandId = randomUUID();
    await fx.runtime.send(fx.owner, sid, { commandId, text: "停机会话" });

    // 让 POST 一直挂住，直到测试显式放行：这样"一轮正在跑"的状态可以稳定观察。
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let entering!: () => void;
    const entered = new Promise<void>((resolve) => { entering = resolve; });
    let posts = 0;
    const base = fx.driver.client;
    const slow = createRuntimeRouter({
      store: fx.store,
      signer,
      directory: createStaticCellDirectory([{ tenantId: fx.tenantId, cellId: fx.cellId, baseUrl: "http://cell.invalid:7801", serviceToken: fx.serviceToken }]),
      driver: {
        ...base,
        postCommand: async (cell, rawBody, grant) => {
          posts += 1;
          entering();
          await released;
          return base.postCommand(cell, rawBody, grant);
        },
      },
      workerId: "stop-worker",
      leaseMs: 30_000,
    });
    fx.driver.post({ status: "accepted", commandId, bootId: "boot-fixed-1" });
    slow.dispatcher.start();
    await entered;

    let stopped = false;
    const stopping = slow.dispatcher.stop().then(() => { stopped = true; });
    // 在途一轮还没结束：stop() 必须还在等，而不是报"已停止"却仍有投递在跑。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopped).toBe(false);
    expect(slow.dispatcher.running).toBe(false);
    // stop 之后 wake() 不得再启动新的一轮。
    slow.dispatcher.wake();

    release();
    await stopping;
    expect(stopped).toBe(true);
    expect((await fx.commandsOf(sid))[0]).toMatchObject({ status: "succeeded" });
    // 只投递一次；停止之后也不会有第二轮。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(posts).toBe(1);
  }, 30_000);

  it("keeps the queue durable across a simulated restart (new worker, same rows)", async () => {
    const fx = await createFixture();
    const sid = await fx.newBinding("active");
    const commandId = randomUUID();
    fx.driver.postFailureFrom = 1;
    await fx.runtime.send(fx.owner, sid, { commandId, text: "重启用例" });
    await fx.runtime.dispatcher.dispatchOnce();
    const afterCrash = (await fx.commandsOf(sid))[0]!;
    // 未配置回执的 404 → 退避；行必须留在持久队列里，而不是被当成成功。
    expect(afterCrash).toMatchObject({ status: "queued", attempts: 1 });

    // 新进程：新的 workerId + 新的 fetch 记录器，读的是同一批持久行。
    const restarted = new FakeDriver();
    restarted.post({ status: "accepted", commandId, bootId: "boot-fixed-1" });
    const restartedRuntime = createRuntimeRouter({
      store: fx.store,
      signer,
      directory: createStaticCellDirectory([{ tenantId: fx.tenantId, cellId: fx.cellId, baseUrl: "http://cell.invalid:7801", serviceToken: fx.serviceToken }]),
      driver: restarted.client,
      workerId: "test-worker-2",
      leaseMs: 30_000,
    });
    await migration.updateTable("commands").set({ available_at: new Date(Date.now() - 1000) }).where("id", "=", commandId).execute();
    const round = await restartedRuntime.dispatcher.dispatchOnce();
    expect(round).toMatchObject({ claimed: 1, settled: 1 });
    expect((await fx.commandsOf(sid))[0]).toMatchObject({ status: "succeeded", locked_by: null });
    await restartedRuntime.dispatcher.stop();
  }, 30_000);
});
