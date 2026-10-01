/**
 * BFF 会话恢复（`resume`）的真实 Postgres + 真实 driver 回归。
 *
 * 复现的真实故障：Lead 实际重启整个 `pnpm dev` 之后，原 other-tenant 会话
 * `e632d2b7-5552-4862-bfdf-5caa61fdf084` 的订阅得到 502 `stream_unavailable`，
 * driver 侧 403 `identity_invalid`；后续 send 会 409 `session_not_open` 并被
 * BFF 永久 `fail`（消息丢）。
 *
 * 为什么这条测试不是"mock 返回固定内容"：
 *
 *   BFF `runtime.events()` / `dispatcher.dispatchOnce()`
 *     → 真实 ES256 签发（`createGrantSigner`）
 *     → 真实 driver HTTP 客户端 + 真实 SSE 帧解析（`createDriverHttpClient`）
 *     → 真实 driver 路由 + 真实 `SessionController`（真实验签 + jti 一次性 + 六字段核对）
 *     → **真实 `PrincipalRegistry`**（重启后为空 —— 这正是故障根因）
 *     → 真实 `EventHub`（游标 0 的补发/合并/去重）
 *     → 真实持久队列（Postgres `commands` / RLS / advisory lock / FIFO）
 *
 * 唯一的行为替身是 DSH 端口本身（`plugins/myrix-runtime-driver/tests/fake-dsh.ts`），
 * 它把 `flush = 持久性屏障`、`create/resume` 的 setup 顺序、`dispose` 语义都按契约
 * 实现出来；"进程重启"= 换一个新的 cell 实例 + **同一份 FakeDisk** + 空的身份表，
 * 与真实重启的差别只在"没有真的 JSONL 文件与 torn tail"。
 *
 * 只追加数据、不 reset/删库；每次运行生成独立随机租户。
 *
 * ```sh
 * BFF_TEST_DATABASE_URL='postgres://myrix_bff_test:myrix_local_bff_test@127.0.0.1:55439/myrix_bff_acceptance' \
 * BFF_TEST_MIGRATION_DATABASE_URL='postgres://myrix_migrator:myrix_local_migrator@127.0.0.1:55439/myrix_bff_acceptance' \
 * pnpm exec vitest run apps/bff/tests/runtime-recovery.test.ts
 * ```
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { createGrantSigner, createGrantVerifier, generateTestKeyPair, sha256Hex } from "@myrix/grant";
import type { PlatformIdentity, SessionStreamEvent } from "@myrix/contracts";
import { PlatformStore } from "../../../packages/platform-store/src/store";
import { createGovernanceAuthorizer } from "../../../packages/platform-store/src/authz";
import { authorizePlatform } from "@myrix/governance";
import { migrateToLatest } from "../../../packages/platform-store/src/migrate";
import type { MigrationDatabase, PlatformDatabase } from "../../../packages/platform-store/src/schema";
import { createStaticCellDirectory } from "../src/runtime-cells";
import { createDriverHttpClient, type DriverHttpClient } from "../src/runtime-driver-client";
import { createBffServer } from "../src/server";
import type { AuthRepository, AuthSession, LoginFlow } from "../src/auth";
import type { NovelRepository } from "../src/ports";
import {
  createRuntimeRouter,
  RUNTIME_SERVICE_CAPABILITIES,
  wireBodyOf,
  type RuntimeRuntime,
} from "../src/runtime-router";
import {
  isRecoverableDriverCode,
  MAX_RESUME_ATTEMPTS_LIMIT,
  recoveryCommandId,
  resumeBodyOf,
  RuntimeSessionRecovery,
} from "../src/runtime-recovery";
import { SessionController, type ControllerHost, type RuntimePorts } from "../../../plugins/myrix-runtime-driver/src/controller";
import { EventHub } from "../../../plugins/myrix-runtime-driver/src/events";
import { createRouter } from "../../../plugins/myrix-runtime-driver/src/router";
import type { StreamEvent } from "../../../plugins/myrix-runtime-driver/src/types";
import { createFakeDisk, createFakeRuntime, type FakeDisk, type FakeRuntime } from "../../../plugins/myrix-runtime-driver/tests/fake-dsh";

const appUrl = process.env.BFF_TEST_DATABASE_URL;
const migrationUrl = process.env.BFF_TEST_MIGRATION_DATABASE_URL;

const key = generateTestKeyPair("kid-runtime-recovery");

interface CellRequest {
  readonly path: string;
  readonly method: string;
  readonly authorization: string | undefined;
  readonly lastEventId: string | undefined;
  readonly body: Buffer | undefined;
}

/** 一个真实 driver cell（真实路由 + 真实控制器 + 真实 EventHub），跑在真实 node:http 上。 */
interface Cell {
  readonly url: string;
  readonly cellId: string;
  readonly bootId: string;
  readonly hub: EventHub;
  readonly controller: SessionController;
  readonly runtime: FakeRuntime;
  readonly principals: TestPrincipalTable;
  readonly requests: CellRequest[];
  close(): Promise<void>;
}

/**
 * cell 侧进程内身份表的最小忠实替身。
 *
 * 为什么不用真实 `@myrix/principals`：那是 `plugins/` 的依赖（`@deepseek-ai/cordis`
 * 只在 `plugins/node_modules` 下可见），`apps/bff` 的 tsconfig 解析不到它。
 * 这里只实现 driver 用到的三条契约，语义与真实表逐条一致：
 *   * `bySid` 在 Agent dispose/scope 回卷时**立刻清掉**（重启后为空正是本次故障根因）；
 *   * `lookup`/`lookupBySession` 失败时给出原因而不是放行；
 *   * 撤权是单调高水位，已撤权会话永不重新绑定。
 */
class TestPrincipalTable {
  private readonly byAgent = new WeakMap<object, Principal>();
  private readonly bySid = new Map<string, { principal: Principal; agent: WeakRef<object> }>();
  private readonly revocations = new Map<string, number>();

  bind(agent: object, principal: Principal): () => void {
    this.byAgent.set(agent, principal);
    this.bySid.set(principal.sid, { principal, agent: new WeakRef(agent) });
    return () => {
      if (this.byAgent.get(agent) === principal) this.byAgent.delete(agent);
      const entry = this.bySid.get(principal.sid);
      if (entry?.principal === principal) this.bySid.delete(principal.sid);
    };
  }

  /** 会话被释放：模拟真实表在 `agent/disposed` 上清索引 + WeakMap 随 scope 回收。 */
  release(sid: string): void {
    this.bySid.delete(sid);
  }

  isRevoked(sid: string): boolean {
    return this.revocations.has(sid);
  }

  highWaterRev(sid: string): number {
    return this.revocations.get(sid) ?? 0;
  }

  revoke(sid: string, rev: number): boolean {
    const high = this.revocations.get(sid) ?? 0;
    if (rev < high) return false;
    this.revocations.set(sid, rev);
    this.bySid.delete(sid);
    return true;
  }

  lookup(agent: object | undefined): { ok: true; principal: Principal } | { ok: false; reason: string; detail: string } {
    if (agent === undefined) return { ok: false, reason: "no-agent", detail: "请求没有携带 Agent" };
    const principal = this.byAgent.get(agent);
    if (principal === undefined) return { ok: false, reason: "unbound", detail: "Agent 没有绑定授权主体" };
    return { ok: true, principal };
  }

  lookupBySession(sid: string): { ok: true; principal: Principal } | { ok: false; reason: string; detail: string } {
    if (this.revocations.has(sid)) return { ok: false, reason: "revoked", detail: `会话 ${sid} 已撤权` };
    const entry = this.bySid.get(sid);
    if (entry === undefined) return { ok: false, reason: "unbound", detail: `会话 ${sid} 没有绑定授权主体` };
    return { ok: true, principal: entry.principal };
  }
}

interface Principal {
  readonly sid: string;
  readonly tid: string;
  readonly sub: string;
  readonly wid: string;
  readonly preset: string;
  readonly rev: number;
}

/**
 * 故障注入用的最小事务形状。
 *
 * 只在测试里包一层 `Proxy` 观察"某条查询读了哪张表、选了哪些列"，用来**精确**命中
 * `openProof`（唯一选 `receipt` 列）与 `requestResume` 的绑定读取（唯一选三列且含
 * `owner_user_id`）。这样注入的失败不会误伤 `readFacts` / 认领 / 结算。
 */
interface StoreTxLike {
  readonly trx: Record<string, unknown>;
  readonly tenantId: string;
  readonly actorUserId: string | undefined;
}

/** 一条查询的判据：表名 + `.select()` 传入的列。 */
interface QueryMeta {
  table: string;
  columns: unknown;
}

/**
 * 构造一个 store 替身：**只有**命中 `classify` 的读查询被替换一次，其余原样走真实 SQL。
 *
 * `classify` 返回 `"throw"`（模拟读取失败）或 `"empty"`（模拟"查不到该行"）时命中；
 * 返回 `undefined` 则不干预。
 *
 * 为什么要递归包装：Kysely 的 `selectFrom().select().where()` 每一步都返回**新的**
 * builder 对象，只包最外层会在第一次链式调用后失效。这里把链上每个"还是 builder"
 * 的返回值继续包住，并把表名/列名随链传递，直到终结方法（execute*）时才判定。
 */
function injectReadFailure(
  store: PlatformStore,
  classify: (meta: QueryMeta) => "throw" | "empty" | undefined,
  once = true,
): PlatformStore {
  const realWithTenant = store.withTenant.bind(store);
  let armed = once;
  const decide = (meta: QueryMeta): "throw" | "empty" | undefined => {
    if (!armed) return undefined;
    const verdict = classify(meta);
    if (verdict !== undefined) armed = false;
    return verdict;
  };
  const isBuilder = (value: unknown): boolean =>
    value !== null && typeof value === "object" && typeof (value as { compile?: unknown }).compile === "function";
  const wrapBuilder = (builder: unknown, meta: QueryMeta): unknown =>
    new Proxy(builder as Record<string, unknown>, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const nextMeta: QueryMeta = { ...meta };
          if (key === "select" && args.length === 1) nextMeta.columns = args[0];
          if (key === "execute" || key === "executeTakeFirst" || key === "executeTakeFirstOrThrow") {
            const verdict = decide(nextMeta);
            if (verdict === "throw") return Promise.reject(new Error("injected read failure"));
            if (verdict === "empty") return Promise.resolve(undefined);
          }
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          return isBuilder(result) ? wrapBuilder(result, nextMeta) : result;
        };
      },
    });
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property !== "withTenant") return Reflect.get(target, property, receiver);
      return (input: { tenantId: string }, fn: (tx: unknown) => Promise<unknown>) =>
        realWithTenant(input, (tx) => {
          const typed = tx as unknown as StoreTxLike;
          const trxProxy = new Proxy(typed.trx, {
            get(trxTarget, key, trxReceiver) {
              const value = Reflect.get(trxTarget, key, trxReceiver);
              if (key !== "selectFrom" || typeof value !== "function") {
                return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(trxTarget) : value;
              }
              return (table: string) => wrapBuilder((value as (t: string) => unknown).call(trxTarget, table), { table, columns: undefined });
            },
          });
          return fn({ ...typed, trx: trxProxy } as unknown as never);
        });
    },
  }) as PlatformStore;
}

/**
 * 在**某一条读查询的结果已经返回之后、调用方继续之前**执行一次受控副作用。
 *
 * 为什么需要它：并发合并缺陷的本质是"同一 READ COMMITTED 事务里的两条独立 SELECT
 * 看到了不同快照"。要确定性地（不是靠循环撞概率）复现/证伪它，必须让"另一条连接
 * 在当前请求的读之间入队 candidate"这件事发生在**精确的语句边界**上。
 *
 * `afterExecute` 在每次 `execute`/`executeTakeFirst` 真正取到结果返回给调用方之前被
 * 调用一次（`once=true` 时只调用一次）。判据仍由 `classify(meta)` 精确限定到某条查询，
 * 避免误伤 `readFacts`/认领/结算。副作用里另开的连接（`migration`/`fx.store`）是**独立
 * 事务**，因此它提交后对当前 READ COMMITTED 事务的下一句可见、对已经执行完的那句不可见
 * —— 这正是旧实现两段查询之间发生的事。
 */
function afterQuery(
  store: PlatformStore,
  classify: (meta: QueryMeta) => boolean,
  afterExecute: () => Promise<void>,
  once = true,
): PlatformStore {
  const realWithTenant = store.withTenant.bind(store);
  let armed = once;
  const isBuilder = (value: unknown): boolean =>
    value !== null && typeof value === "object" && typeof (value as { compile?: unknown }).compile === "function";
  const wrapBuilder = (builder: unknown, meta: QueryMeta): unknown =>
    new Proxy(builder as Record<string, unknown>, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const nextMeta: QueryMeta = { ...meta };
          if (key === "select" && args.length === 1) nextMeta.columns = args[0];
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          if (key === "execute" || key === "executeTakeFirst" || key === "executeTakeFirstOrThrow") {
            const shouldRun = armed && classify(nextMeta);
            if (shouldRun) armed = false;
            return Promise.resolve(result).then(async (resolved) => {
              if (shouldRun) await afterExecute();
              return resolved;
            });
          }
          return isBuilder(result) ? wrapBuilder(result, nextMeta) : result;
        };
      },
    });
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property !== "withTenant") return Reflect.get(target, property, receiver);
      return (input: { tenantId: string }, fn: (tx: unknown) => Promise<unknown>) =>
        realWithTenant(input, (tx) => {
          const typed = tx as unknown as StoreTxLike;
          const trxProxy = new Proxy(typed.trx, {
            get(trxTarget, key, trxReceiver) {
              const value = Reflect.get(trxTarget, key, trxReceiver);
              if (key !== "selectFrom" || typeof value !== "function") {
                return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(trxTarget) : value;
              }
              return (table: string) => wrapBuilder((value as (t: string) => unknown).call(trxTarget, table), { table, columns: undefined });
            },
          });
          return fn({ ...typed, trx: trxProxy } as unknown as never);
        });
    },
  }) as PlatformStore;
}

/**
 * 起一个真实 cell。
 *
 * `bootId` 显式传入：同一个值 + 新的身份表/`runtime` 就是"**同一 boot 下
 * Agent 被释放**"（身份表与 live 都空，但 bootId 没变）；换新的 `bootId` 就是
 * 真正的"进程重启"。
 */
async function startCell(input: {
  cellId: string;
  bootId: string;
  tenantId: string;
  disk: FakeDisk;
  heartbeatMs?: number;
}): Promise<Cell> {
  const requests: CellRequest[] = [];
  const runtime = createFakeRuntime(input.disk);
  const principals = new TestPrincipalTable();
  // 把行为替身的 bindPrincipal 接到**真实语义**的身份表：resume 的 `setup` 内绑定
  // 必须真的写进表，否则"恢复后订阅可用"就没有被验证。
  const baseBind = runtime.ports.bindPrincipal;
  runtime.ports.bindPrincipal = (agent, principal) => {
    const unbind = principals.bind(agent as unknown as object, principal);
    const traceUnbind = baseBind(agent, principal);
    return () => {
      traceUnbind();
      if (unbind !== undefined) unbind();
    };
  };
  // dispose 必须让身份立刻失效（真实表在 Agent scope 回收时清索引）——
  // 这正是"重启后 principals 为空"与"同 boot 下 Agent 被释放"的共同根因。
  const baseCreate = runtime.ports.create;
  const baseResume = runtime.ports.resume;
  runtime.ports.create = async (options) => {
    const handle = await baseCreate(options);
    const baseDispose = handle.dispose;
    return {
      agent: handle.agent,
      dispose: async () => {
        principals.release(options.sessionId);
        await baseDispose();
      },
    };
  };
  runtime.ports.resume = async (options) => {
    const handle = await baseResume(options);
    const baseDispose = handle.dispose;
    return {
      agent: handle.agent,
      dispose: async () => {
        principals.release(options.resumeSessionId);
        await baseDispose();
      },
    };
  };

  const hub = new EventHub();
  // 历史来自"磁盘"（提交时 flush 写入），与真实 driver 从会话日志取历史同语义。
  hub.setHistoryProvider((sid) => {
    const events = input.disk.sessions.get(sid) ?? [];
    return events.map((event) => ({ seq: event.seq, type: event.type, data: event.data, time: event.time })) as StreamEvent[];
  });

  const host: ControllerHost = {
    lookupPrincipal(agent) {
      const result = principals.lookup(agent as unknown as object | undefined);
      return result.ok
        ? { ok: true, principal: result.principal }
        : { ok: false, reason: result.reason, detail: result.detail };
    },
    lookupPrincipalBySession(sid) {
      const result = principals.lookupBySession(sid);
      return result.ok
        ? { ok: true, principal: result.principal }
        : { ok: false, reason: result.reason, detail: result.detail };
    },
    revoke(request) {
      const accepted = principals.revoke(request.sid, request.rev);
      return { accepted, reason: accepted ? "accepted" : "stale rev" };
    },
    isRevoked(sid) {
      return principals.isRevoked(sid);
    },
    highWaterRev(sid) {
      return principals.highWaterRev(sid);
    },
  };
  const verifier = createGrantVerifier({
    audience: input.cellId,
    tenantId: input.tenantId,
    bootId: input.bootId,
    startedAt: 0,
    issuer: "myrix-control-plane",
    keys: [key.jwk],
  });
  const controller = new SessionController(runtime.ports, host, verifier, input.bootId);
  const router = createRouter(controller, hub, {
    tenantId: input.tenantId,
    bootId: input.bootId,
    heartbeatMs: input.heartbeatMs ?? 0,
  });

  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://cell.invalid").pathname;
    // 请求记录必须**不消费**请求体：driver 的 `readRawBody` 用 `for await (const chunk of req)`
    // 读同一份流，抢读会把正文吃掉（PUT/POST 全部变成空正文）。
    // 这里通过**代理异步迭代器**做 tee：原样把每个 chunk 交给 driver，同时留一份给断言。
    const chunks: Buffer[] = [];
    const record: CellRequest & { body: Buffer | undefined } = {
      path,
      method: req.method ?? "GET",
      authorization: req.headers.authorization,
      lastEventId: req.headers["last-event-id"] as string | undefined,
      body: undefined,
    };
    Object.defineProperty(record, "body", {
      enumerable: true,
      get: () => (chunks.length === 0 ? undefined : Buffer.concat(chunks)),
    });
    requests.push(record);
    const originalIterator = req[Symbol.asyncIterator].bind(req);
    req[Symbol.asyncIterator] = async function* tee(): AsyncGenerator<unknown, undefined, undefined> {
      for await (const chunk of originalIterator()) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
        yield chunk;
      }
      return undefined;
    };
    for (const route of router.routes) {
      const matches = route.kind === "exact" ? path === route.path : path === route.path || path.startsWith(`${route.path}/`);
      if (matches) {
        void Promise.resolve(route.handler(req, res)).catch(() => {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
        return;
      }
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    cellId: input.cellId,
    bootId: input.bootId,
    hub,
    controller,
    runtime,
    principals,
    requests,
    close: async () => {
      router.dispose();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** 读回真实验签器认得的 claim；用于断言六字段/boot/jti/bodyhash 真的成立。 */
function verifierFor(cell: Cell, tenantId: string) {
  return createGrantVerifier({
    audience: cell.cellId,
    tenantId,
    bootId: cell.bootId,
    startedAt: 0,
    issuer: "myrix-control-plane",
    keys: [key.jwk],
  });
}

const cells: Cell[] = [];
const runtimes: RuntimeRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispatcher.stop()));
  await Promise.all(cells.splice(0).map((cell) => cell.close()));
});

function makeRuntime(input: {
  store: PlatformStore;
  cell: Cell;
  tenantId: string;
  workerId: string;
  serviceToken: string;
  recovery?: { enabled?: boolean; maxAttemptsPerBoot?: number };
  /** 注入 driver（默认真实 HTTP 客户端）；负例用它伪造固定的 driver 响应。 */
  driver?: DriverHttpClient;
}): RuntimeRuntime {
  const signer = createGrantSigner({ privateKey: key.privateKeyPem, kid: key.kid, issuer: "myrix-control-plane" });
  const runtime = createRuntimeRouter({
    store: input.store,
    signer,
    directory: createStaticCellDirectory([
      { tenantId: input.tenantId, cellId: input.cell.cellId, baseUrl: input.cell.url, serviceToken: input.serviceToken },
    ]),
    driver: input.driver ?? createDriverHttpClient({ deadlineMs: 5_000 }),
    workerId: input.workerId,
    leaseMs: 30_000,
    claimBatch: 5,
    revalidateMs: 60_000,
    // 测试驱动的时点：`candidateSessions`/`claimSessionCommand` 用的是数据库/进程
    // **墙钟** `new Date()`，而夹具行的 `available_at` 是 Postgres 的 `now()`（默认
    // 同一台机器，但夹具时点可能比 `new Date()` 晚几十毫秒）。把逻辑时钟整体推后
    // 一小段，等价于"退避窗口已经过去"，让每一轮都能立刻领取 queued 行 ——
    // 这不改变任何投递语义，只是免去每个用例手动拨 available_at。
    clock: () => new Date(Date.now() - 60_000),
    ...(input.recovery === undefined ? {} : { recovery: input.recovery }),
  });
  runtimes.push(runtime);
  return runtime;
}

describe.skipIf(!appUrl || !migrationUrl)("BFF session recovery against real PostgreSQL and a real driver cell", () => {
  let migration: Kysely<MigrationDatabase>;
  let db: Kysely<PlatformDatabase>;

  beforeAll(async () => {
    migration = new Kysely<MigrationDatabase>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: migrationUrl, max: 2 }) }) });
    db = new Kysely<PlatformDatabase>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: appUrl, max: 4 }) }) });
    await migrateToLatest(migration);
  }, 30_000);

  afterAll(async () => {
    await db?.destroy();
    await migration?.destroy();
  });

  interface Fixture {
    tenantId: string;
    owner: PlatformIdentity;
    cellId: string;
    serviceToken: string;
    workId: string;
    store: PlatformStore;
    /**
     * 投递循环用的 store（读同一批持久行）。与 `store` 同一实例：本测试不区分
     * 请求/投递两种装配，只验证恢复语义本身。
     */
    driverStore: PlatformStore;
    disk: FakeDisk;
    commandsOf(bindingId: string): Promise<Array<{ id: string; op: string; status: string; body: Record<string, unknown>; receipt: Record<string, unknown> | null; last_error: string | null; attempts: number; max_attempts: number; available_at: Date }>>;
    auditOf(bindingId: string): Promise<Array<{ action: string; effect: string; reason: string; detail: Record<string, unknown> }>>;
    bindingOf(id: string): Promise<{ status: string; revoked_revision: number }>;
  }

  async function createFixture(): Promise<Fixture> {
    const tenantId = randomUUID();
    const owner: PlatformIdentity = { tenantId, userId: randomUUID(), role: "member", displayName: "作者" };
    const serviceToken = `service-token-${randomUUID()}`;
    await migration.insertInto("tenants").values({ id: tenantId, slug: `rec-${tenantId.slice(0, 8)}-${randomUUID().slice(0, 6)}`, name: "recovery e2e" }).execute();
    await migration.insertInto("members").values({ tenant_id: tenantId, user_id: owner.userId, role: "member", status: "active", display_name: owner.displayName }).execute();
    const workId = randomUUID();
    await migration.insertInto("works").values({ tenant_id: tenantId, id: workId, owner_user_id: owner.userId, title: "恢复作品", description: "" }).execute();
    const driverStore = new PlatformStore({
      db,
      authorizer: createGovernanceAuthorizer({ authorizePlatform }),
      serviceCapabilities: RUNTIME_SERVICE_CAPABILITIES,
    });
    const store = driverStore;
    return {
      tenantId,
      owner,
      cellId: `cell-${randomUUID().slice(0, 8)}`,
      serviceToken,
      workId,
      store,
      driverStore,
      disk: createFakeDisk(),
      async commandsOf(bindingId: string) {
        const rows = await migration
          .selectFrom("commands")
          .selectAll()
          .where("tenant_id", "=", tenantId)
          .where("binding_id", "=", bindingId)
          .orderBy("created_at", "asc")
          .orderBy("id", "asc")
          .execute();
        return rows.map((row) => ({
          id: row.id,
          op: row.op,
          status: row.status,
          body: row.body as Record<string, unknown>,
          receipt: row.receipt as Record<string, unknown> | null,
          last_error: row.last_error,
          attempts: row.attempts,
          max_attempts: row.max_attempts,
          available_at: row.available_at,
        }));
      },
      async auditOf(bindingId: string) {
        const rows = await migration
          .selectFrom("audit_events")
          .select(["action", "effect", "reason", "detail"])
          .where("tenant_id", "=", tenantId)
          .where("session_id", "=", bindingId)
          .orderBy("seq", "asc")
          .execute();
        return rows.map((row) => ({ action: row.action, effect: row.effect, reason: row.reason, detail: row.detail as Record<string, unknown> }));
      },
      async bindingOf(id: string) {
        const row = await migration.selectFrom("session_bindings").select(["status", "revoked_revision"]).where("id", "=", id).executeTakeFirstOrThrow();
        return { status: row.status, revoked_revision: row.revoked_revision };
      },
    };
  }

  /**
   * 插入 `count` 条**历史** resume 行（早于当前 boot），并让它们的 `created_at`
   * 严格早于之后新插入的行。
   *
   * 用途：把 `created_at asc LIMIT 200` 式的顺序截断暴露出来 —— 历史足够多时，
   * 当前 boot 刚用掉的 id 会被挤到窗口之外；精确候选查询则不受影响。
   *
   * 这些行的 id 是随机 uuid（不是任何 boot 的确定性候选），
   * 因此它们**不会**被"本 boot 候选精确查询"看到，也就不会占据 attempt 槽位 ——
   * 这正是"历史行数不该影响当前 boot 的 attempt 枚举"的语义。
   */
  async function seedHistoricalResumes(
    fx: Fixture,
    sessionId: string,
    count: number,
    ownerUserId: string,
  ): Promise<void> {
    const base = Date.now() - 3_600_000;
    for (let index = 0; index < count; index += 1) {
      const id = randomUUID();
      await migration.insertInto("commands").values({
        tenant_id: fx.tenantId,
        id,
        binding_id: sessionId,
        work_id: fx.workId,
        actor_user_id: ownerUserId,
        op: "resume",
        body_hash: sha256Hex(JSON.stringify(resumeBodyOf({ sessionId, commandId: id }))),
        body: resumeBodyOf({ sessionId, commandId: id }),
        grant_revision: 1,
        status: "succeeded",
        settled_at: new Date(base + index),
        created_at: new Date(base + index),
        receipt: { status: "accepted", commandId: id, bootId: "boot-history" },
      }).execute();
    }
  }

  /**
   * 直接在库里写入一枚**当前 boot 成功过**的确定性 resume（模拟"boot B 的 attempt 0
   * 已经 accepted"）。它的 created_at 取当下，比历史行更晚。
   *
   * `settledAt` 可显式回拨：当用例需要 `open-proof` 仍然看到**更早的、属于别的 boot**
   * 的回执（即"boot 不匹配 → 走恢复分支"）时，占用当前 boot 槽位的行不能同时成为
   * "最近一条成功回执"。
   */
  async function seedSucceededResume(
    fx: Fixture,
    sessionId: string,
    ownerUserId: string,
    input: { bootId: string; attempt: number; revision?: number; settledAt?: Date },
  ): Promise<string> {
    const id = recoveryCommandId({
      tenantId: fx.tenantId,
      sessionId,
      revision: input.revision ?? 1,
      bootId: input.bootId,
      attempt: input.attempt,
    });
    await migration.insertInto("commands").values({
      tenant_id: fx.tenantId,
      id,
      binding_id: sessionId,
      work_id: fx.workId,
      actor_user_id: ownerUserId,
      op: "resume",
      body_hash: sha256Hex(JSON.stringify(resumeBodyOf({ sessionId, commandId: id }))),
      body: resumeBodyOf({ sessionId, commandId: id }),
      grant_revision: 1,
      status: "succeeded",
      settled_at: input.settledAt ?? new Date(),
      receipt: { status: "accepted", commandId: id, bootId: input.bootId },
    }).execute();
    return id;
  }

  /**
   * 真实的一轮：BFF 创建绑定 → 投递 create → 发一条消息并落盘 → 在磁盘上补完一轮。
   * 返回 (runtime, cell, sid, sendCommandId)。
   */
  async function seedCommittedTurn(fx: Fixture, cell: Cell, workerId: string): Promise<{ runtime: RuntimeRuntime; sid: string; sendCommandId: string; userSeq: number }> {
    const runtime = makeRuntime({ store: fx.driverStore, cell, tenantId: fx.tenantId, workerId, serviceToken: fx.serviceToken });
    const session = await runtime.createSession(fx.owner, fx.workId, "novel-chapter");
    const created = await runtime.dispatcher.dispatchOnce();
    expect(created).toMatchObject({ claimed: 1, settled: 1 });
    expect(await fx.bindingOf(session.id)).toMatchObject({ status: "active" });

    const sendCommandId = randomUUID();
    await runtime.send(fx.owner, session.id, { commandId: sendCommandId, text: "重启前已提交的用户消息" });
    const sent = await runtime.dispatcher.dispatchOnce();
    expect(sent).toMatchObject({ claimed: 1, settled: 1 });

    // 在"磁盘"上补完这一轮（与真实 JSONL 已提交一轮同形）。
    const live = cell.runtime.sessions.get(session.id);
    expect(live).toBeDefined();
    live!.append("assistant/message", {
      turn: 1,
      step: 1,
      message: { role: "assistant", content: [{ type: "text", text: "重启前的回答" }] },
      stream: [],
    });
    live!.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    expect(await cell.runtime.ports.flush(live!)).toBe(true);

    const userEvent = fx.disk.sessions.get(session.id)!.find((event) => event.type === "user/message");
    expect(userEvent).toBeDefined();
    return { runtime, sid: session.id, sendCommandId, userSeq: userEvent!.seq };
  }

  /**
   * 模拟"让路窗口已经过去"：只把**非 resume** 的 queued 行拨回当下。
   *
   * 让路（`deferForRecovery`）刻意把原命令的 `available_at` 推到未来 1 秒，而
   * 恢复命令入队时就是"立刻可领"。这两个时间点合起来正是让 resume 先被领取的机制：
   * 在 (now, now+1s) 这个窗口里，只有 resume 满足 `available_at <= now`，
   * 即使它的 `created_at` 更晚也会先被 FIFO 查询选中。
   *
   * 单测不会真的等 1 秒，所以要模拟的是"原命令的窗口过去了"；
   * **绝不能**连带把 resume 也拨回 —— 那会人为造成两者同时到期，
   * 反而掩盖了"resume 本来就有优先窗口"这条语义。
   */
  async function advanceBackoff(fx: Fixture, bindingId: string): Promise<void> {
    await migration
      .updateTable("commands")
      .set({ available_at: new Date(Date.now() - 1_000) })
      .where("tenant_id", "=", fx.tenantId)
      .where("binding_id", "=", bindingId)
      .where("status", "=", "queued")
      .where("op", "!=", "resume")
      .execute();
  }

  /** 读到 `turn-end` 就断开（真实事件流不会自己结束）。 */
  async function drainUntilTurnEnd(stream: AsyncIterable<SessionStreamEvent>, controller: AbortController): Promise<SessionStreamEvent[]> {
    const seen: SessionStreamEvent[] = [];
    try {
      for await (const event of stream) {
        seen.push(event);
        if (event.type === "turn-end") break;
      }
    } finally {
      controller.abort();
    }
    return seen;
  }

  it("proves the open state through command receipts: a mismatched boot reopens the session, then the stream replays cursor 0", async () => {
    const fx = await createFixture();
    const cellA = await startCell({ cellId: fx.cellId, bootId: "boot-A", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellA);
    const seeded = await seedCommittedTurn(fx, cellA, "worker-a");

    // 真实重启：新进程、新 bootId、**空的身份表与 live**，磁盘会话不变。
    const cellB = await startCell({ cellId: fx.cellId, bootId: "boot-B", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellB);
    const restarted = makeRuntime({ store: fx.driverStore, cell: cellB, tenantId: fx.tenantId, workerId: "worker-b", serviceToken: fx.serviceToken });

    // 1) 重启后的订阅：绝不先发 subscribe 再吃 403，而是入队 resume + 503 session_reopening。
    const controller = new AbortController();
    await expect(restarted.events(fx.owner, seeded.sid, 0, controller.signal)).rejects.toMatchObject({
      statusCode: 503,
      code: "session_reopening",
    });
    const afterFirst = await fx.commandsOf(seeded.sid);
    const resumes = afterFirst.filter((row) => row.op === "resume");
    expect(resumes).toHaveLength(1);
    expect(resumes[0]).toMatchObject({ status: "queued" });
    // resume 的正文与投递正文同形（body_hash 就是实际发送字节的摘要）。
    expect(resumes[0]!.body).toEqual({ op: "resume", sid: seeded.sid, commandId: resumes[0]!.id });
    expect(wireBodyOf({ op: "resume", bindingId: seeded.sid, id: resumes[0]!.id, body: resumes[0]!.body })).toEqual(resumes[0]!.body);

    // 2) 恢复审计：allow + bootId 明细。
    const audits = await fx.auditOf(seeded.sid);
    const requested = audits.filter((row) => row.action === "session.recovery_requested");
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({ effect: "allow" });
    expect(requested[0]!.detail).toMatchObject({ bootId: "boot-B", openProof: "mismatch" });
    // 还没有任何命令被永久判失败。
    expect(afterFirst.some((row) => row.status === "failed")).toBe(false);

    // 3) 正常投递循环发送 resume。真实 ES256 / 六字段 / boot / bh 全部由 cell 验证。
    const resumed = await restarted.dispatcher.dispatchOnce();
    expect(resumed).toMatchObject({ claimed: 1, settled: 1 });
    const resumeRow = (await fx.commandsOf(seeded.sid)).find((row) => row.op === "resume")!;
    expect(resumeRow).toMatchObject({ status: "succeeded" });
    expect(resumeRow.receipt).toMatchObject({ status: "accepted", bootId: "boot-B" });
    expect(await fx.bindingOf(seeded.sid)).toMatchObject({ status: "active" });

    const resumePost = cellB.requests.find((call) => call.method === "POST" && call.path === "/v1/commands" && call.body !== undefined
      && (JSON.parse(call.body.toString("utf8")) as { commandId: string }).commandId === resumeRow.id)!;
    expect(resumePost).toBeDefined();
    const claims = verifierFor(cellB, fx.tenantId).verifyAndConsume(resumePost.authorization!.replace("Bearer ", ""), {
      op: "resume",
      cmd: resumeRow.id,
      bh: sha256Hex(resumePost.body!),
    });
    expect(claims).toMatchObject({
      op: "resume", cmd: resumeRow.id, sid: seeded.sid, tid: fx.tenantId,
      sub: fx.owner.userId, wid: fx.workId, preset: "novel-chapter", rev: 1, boot: "boot-B",
    });
    // bh 绑定真实生效：改一个字节就必须被拒。
    const tampered = Buffer.from(resumePost.body!);
    tampered[0] = tampered[0]! ^ 0x20;
    expect(() =>
      verifierFor(cellB, fx.tenantId).verifyAndConsume(resumePost.authorization!.replace("Bearer ", ""), {
        op: "resume", cmd: resumeRow.id, bh: sha256Hex(tampered),
      }),
    ).toThrow();

    // 4) 恢复之后再次订阅：**cursor 0 原样转发**，并且真的回放出重启前已落盘的历史。
    const replay = new AbortController();
    const stream = await restarted.events(fx.owner, seeded.sid, 0, replay.signal);
    const seen = await drainUntilTurnEnd(stream, replay);
    const userEvents = seen.filter((event) => event.type === "user");
    expect(userEvents).toHaveLength(1);
    expect(userEvents[0]).toMatchObject({ seq: seeded.userSeq, text: "重启前已提交的用户消息" });
    expect(seen.filter((event) => event.type === "assistant")).toHaveLength(1);
    expect(seen.filter((event) => event.type === "turn-end")).toHaveLength(1);
    // 单调且不重复。
    const seqs = seen.flatMap((event) => (typeof event.seq === "number" ? [event.seq] : []));
    expect(seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]!)).toBe(true);
    expect(new Set(seqs).size).toBe(seqs.length);

    const eventCall = cellB.requests.filter((call) => call.path.endsWith("/events")).at(-1)!;
    expect(eventCall.lastEventId).toBe("0");
    expect(eventCall.authorization).toMatch(/^Bearer /);
  }, 60_000);

  it("reopens before delivering a send: the original command keeps its identity, is delivered exactly once and never failed", async () => {
    const fx = await createFixture();
    const cellA = await startCell({ cellId: fx.cellId, bootId: "boot-A", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellA);
    const seeded = await seedCommittedTurn(fx, cellA, "worker-a");
    // 清掉 boot A 上的 live/principal，模拟"重启后 send 会 session_not_open"。
    const cellB = await startCell({ cellId: fx.cellId, bootId: "boot-B", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellB);
    const restarted = makeRuntime({ store: fx.driverStore, cell: cellB, tenantId: fx.tenantId, workerId: "worker-b", serviceToken: fx.serviceToken });

    const sendCommandId = randomUUID();
    await restarted.send(fx.owner, seeded.sid, { commandId: sendCommandId, text: "重启后的新消息" });

    // 第一轮：open-proof 发现 boot 不匹配 → 先入队 resume，send 让路（不是 failed）。
    const first = await restarted.dispatcher.dispatchOnce();
    expect(first).toMatchObject({ claimed: 1, settled: 0, released: 1, failed: 0 });
    let rows = await fx.commandsOf(seeded.sid);
    const sendRow = () => rows.find((row) => row.id === sendCommandId)!;
    expect(sendRow()).toMatchObject({ status: "queued" });
    expect(rows.filter((row) => row.op === "resume")).toHaveLength(1);
    // 让路把这次认领原样退还：不让"等待恢复"消耗投递预算。
    expect(sendRow().attempts).toBe(0);
    expect(sendRow().last_error).toMatch(/session-reopening/);
    // 让路不是失败：没有 command.failed 审计。
    expect((await fx.auditOf(seeded.sid)).some((row) => row.action === "command.failed")).toBe(false);

    // 第二轮：resume 立刻可领（原命令的 available_at 还被让路推在未来），
    // 因此 resume 先被投递 —— 这正是"让路"要达成的次序。
    const second = await restarted.dispatcher.dispatchOnce();
    expect(second).toMatchObject({ claimed: 1, settled: 1 });
    expect((await fx.commandsOf(seeded.sid)).find((row) => row.op === "resume")!).toMatchObject({ status: "succeeded" });
    // 第三轮：原 send 按**原 commandId** 投递，只投一次。
    await advanceBackoff(fx, seeded.sid);
    const third = await restarted.dispatcher.dispatchOnce();
    expect(third).toMatchObject({ claimed: 1, settled: 1 });

    rows = await fx.commandsOf(seeded.sid);
    expect(sendRow()).toMatchObject({ status: "succeeded" });
    expect(sendRow().receipt).toMatchObject({ status: "accepted", commandId: sendCommandId, bootId: "boot-B" });
    expect((await fx.auditOf(seeded.sid)).some((row) => row.action === "command.failed")).toBe(false);

    // 真实 driver 侧：该 commandId 在 cell B 上只被 POST 一次，且驱动只追加了一条用户消息。
    const posts = [...cellA.requests, ...cellB.requests].filter(
      (call) => call.method === "POST" && call.path === "/v1/commands" && call.body !== undefined
        && (JSON.parse(call.body.toString("utf8")) as { commandId: string }).commandId === sendCommandId,
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body!.toString("utf8")).toBe(JSON.stringify({ op: "send", sid: seeded.sid, commandId: sendCommandId, text: "重启后的新消息" }));
    const persisted = fx.disk.sessions.get(seeded.sid)!.filter(
      (event) => event.type === "user/message" && (event.data as { id?: string }).id === sendCommandId,
    );
    expect(persisted).toHaveLength(1);
  }, 60_000);

  it("derives a new recovery command for a new boot and merges concurrent requests for the same boot", async () => {
    const fx = await createFixture();
    const cellA = await startCell({ cellId: fx.cellId, bootId: "boot-A", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellA);
    const seeded = await seedCommittedTurn(fx, cellA, "worker-a");

    const cellB = await startCell({ cellId: fx.cellId, bootId: "boot-B", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellB);
    const onB = makeRuntime({ store: fx.driverStore, cell: cellB, tenantId: fx.tenantId, workerId: "worker-b", serviceToken: fx.serviceToken });

    // 并发两个订阅（多副本/多标签页）：只允许产生**一条** resume。
    const controller = new AbortController();
    const results = await Promise.allSettled([
      onB.events(fx.owner, seeded.sid, 0, controller.signal),
      onB.events(fx.owner, seeded.sid, 0, controller.signal),
    ]);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      expect((result as PromiseRejectedResult).reason).toMatchObject({ statusCode: 503, code: "session_reopening" });
    }
    const firstBootResumes = (await fx.commandsOf(seeded.sid)).filter((row) => row.op === "resume");
    expect(firstBootResumes).toHaveLength(1);
    expect(firstBootResumes[0]!.id).toBe(recoveryCommandId({ tenantId: fx.tenantId, sessionId: seeded.sid, revision: 1, bootId: "boot-B", attempt: 0 }));

    // boot C（再一次真实重启）必须算出**不同**的恢复命令，绝不跨 boot 复用已 accepted 的旧键。
    const cellC = await startCell({ cellId: fx.cellId, bootId: "boot-C", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellC);
    const onC = makeRuntime({ store: fx.driverStore, cell: cellC, tenantId: fx.tenantId, workerId: "worker-c", serviceToken: fx.serviceToken });
    // 先把 boot B 的 resume 投递掉，否则请求会被"已有待投递 resume"合并。
    expect(firstBootResumes[0]!.status).toBe("queued");
    expect(await onB.dispatcher.dispatchOnce()).toMatchObject({ claimed: 1, settled: 1 });

    const controllerC = new AbortController();
    await expect(onC.events(fx.owner, seeded.sid, 0, controllerC.signal)).rejects.toMatchObject({
      statusCode: 503,
      code: "session_reopening",
    });
    const resumes = (await fx.commandsOf(seeded.sid)).filter((row) => row.op === "resume");
    expect(resumes).toHaveLength(2);
    const ids = resumes.map((row) => row.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain(recoveryCommandId({ tenantId: fx.tenantId, sessionId: seeded.sid, revision: 1, bootId: "boot-B", attempt: 0 }));
    expect(ids).toContain(recoveryCommandId({ tenantId: fx.tenantId, sessionId: seeded.sid, revision: 1, bootId: "boot-C", attempt: 0 }));
  }, 60_000);

  it("refuses to reopen a revoked session or a disabled member, and never resumes a non-owner", async () => {
    const fx = await createFixture();
    const cell = await startCell({ cellId: fx.cellId, bootId: "boot-A", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cell);
    const seeded = await seedCommittedTurn(fx, cell, "worker-a");

    // 撤权：绑定 revoked → 订阅 410，恢复被明确拒绝（deny 审计，且不新增 resume）。
    await fx.disk.sessions.set(seeded.sid, fx.disk.sessions.get(seeded.sid)!);
    const recovery = new RuntimeSessionRecovery({ store: fx.store });
    await fx.store.withTenant({ tenantId: fx.tenantId }, async (tx) => {
      await tx.trx.updateTable("session_bindings").set({ status: "revoked", revoked_at: new Date(), revoked_revision: 2 }).where("id", "=", seeded.sid).execute();
    });
    const revoked = await recovery.requestResume({ tenantId: fx.tenantId, sessionId: seeded.sid, bootId: "boot-B", reason: "test-revoked" });
    expect(revoked.status).toBe("denied");
    expect((await fx.commandsOf(seeded.sid)).filter((row) => row.op === "resume")).toHaveLength(0);
    const denyAudits = (await fx.auditOf(seeded.sid)).filter((row) => row.action === "session.recovery_requested");
    expect(denyAudits.at(-1)).toMatchObject({ effect: "deny" });
    expect(denyAudits.at(-1)!.reason).toMatch(/revoked/);

    // 成员停用：活跃绑定也不投递、更不恢复。
    const live = await fx.store.withTenant({ tenantId: fx.tenantId }, async (tx) => {
      const id = randomUUID();
      await tx.trx.insertInto("session_bindings").values({
        tenant_id: fx.tenantId, id, owner_user_id: fx.owner.userId, work_id: fx.workId,
        preset: "novel-chapter", policy_revision: "test", cell_id: fx.cellId, status: "active", revoked_revision: 1,
      }).execute();
      return id;
    });
    await migration.updateTable("members").set({ status: "disabled", disabled_at: new Date() })
      .where("tenant_id", "=", fx.tenantId).where("user_id", "=", fx.owner.userId).execute();
    try {
      const runtime = makeRuntime({ store: fx.driverStore, cell, tenantId: fx.tenantId, workerId: "worker-disabled", serviceToken: fx.serviceToken });
      const rejected = await recovery.requestResume({ tenantId: fx.tenantId, sessionId: live, bootId: "boot-B", reason: "test-disabled-member" });
      expect(rejected.status).toBe("denied");
      expect((await fx.commandsOf(live)).filter((row) => row.op === "resume")).toHaveLength(0);
      // 订阅边界同样 403（governance 的成员判定）。
      await expect(runtime.events(fx.owner, live, 0, new AbortController().signal)).rejects.toMatchObject({ statusCode: 403 });
    } finally {
      await migration.updateTable("members").set({ status: "active", disabled_at: null })
        .where("tenant_id", "=", fx.tenantId).where("user_id", "=", fx.owner.userId).execute();
    }
  }, 60_000);

  it("reopens when the agent was released within the same boot (boot proof alone is not enough)", async () => {
    const fx = await createFixture();
    const cellA = await startCell({ cellId: fx.cellId, bootId: "boot-A", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellA);
    const seeded = await seedCommittedTurn(fx, cellA, "worker-a");

    // **同一个 bootId**，但身份表与 live 都是空的（Agent 被释放/驱逐）。
    const revived = await startCell({ cellId: fx.cellId, bootId: "boot-A", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(revived);
    const runtime = makeRuntime({ store: fx.driverStore, cell: revived, tenantId: fx.tenantId, workerId: "worker-same-boot", serviceToken: fx.serviceToken });

    // 订阅：open-proof 说"本 boot 打开过"（bootId 相同），于是照常发 subscribe，
    // driver 以 403 identity_invalid 拒绝 —— 反应式恢复必须把它救回来。
    const controller = new AbortController();
    await expect(runtime.events(fx.owner, seeded.sid, 0, controller.signal)).rejects.toMatchObject({
      statusCode: 503,
      code: "session_reopening",
    });
    const resumes = (await fx.commandsOf(seeded.sid)).filter((row) => row.op === "resume");
    expect(resumes).toHaveLength(1);
    // 同 boot 的第一枚恢复命令（attempt 0），不是跨 boot 复用。
    expect(resumes[0]!.id).toBe(recoveryCommandId({ tenantId: fx.tenantId, sessionId: seeded.sid, revision: 1, bootId: "boot-A", attempt: 0 }));

    expect(await runtime.dispatcher.dispatchOnce()).toMatchObject({ claimed: 1, settled: 1 });
    const replay = new AbortController();
    const seen = await drainUntilTurnEnd(await runtime.events(fx.owner, seeded.sid, 0, replay.signal), replay);
    expect(seen.some((event) => event.type === "user")).toBe(true);
    expect(seen.some((event) => event.type === "turn-end")).toBe(true);

    // 再次释放 Agent（**同一 bootId**，身份表又空了）。此时 open-proof 仍然是
    // "本 boot 打开过"，所以 BFF 会照常投递 send；driver 以 409 session_not_open
    // 拒绝 —— 这正是"纯 boot 证明不涵盖同 boot 下 Agent 被释放"的那条边界，
    // 必须有有界的反应式恢复把它救回来。
    const releasedAgain = await startCell({ cellId: fx.cellId, bootId: "boot-A", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(releasedAgain);
    const onReleased = makeRuntime({ store: fx.driverStore, cell: releasedAgain, tenantId: fx.tenantId, workerId: "worker-same-boot-2", serviceToken: fx.serviceToken });
    const sendCommandId = randomUUID();
    await onReleased.send(fx.owner, seeded.sid, { commandId: sendCommandId, text: "同 boot 恢复后的消息" });

    // 这一轮：send 发给 driver → 409 session_not_open → 入队第二枚 resume，并把 send
    // 的 available_at 推到未来（让路）。failed=0：等待恢复不是永久失败。
    const round = await onReleased.dispatcher.dispatchOnce();
    expect(round.failed).toBe(0);
    const afterDefer = await fx.commandsOf(seeded.sid);
    expect(afterDefer.find((row) => row.id === sendCommandId)!).toMatchObject({ status: "queued", attempts: 0 });
    expect(afterDefer.filter((row) => row.op === "resume")).toHaveLength(2);
    // 让路窗口内：resume 立刻可领、原 send 还在未来 → 下一轮先投递 resume。
    expect(await onReleased.dispatcher.dispatchOnce()).toMatchObject({ claimed: 1, settled: 1 });
    expect((await fx.commandsOf(seeded.sid)).filter((row) => row.op === "resume").every((row) => row.status === "succeeded")).toBe(true);
    // 窗口过去（真实运行里就是墙钟前进 1s）：原 send 按**原 commandId** 投递。
    await advanceBackoff(fx, seeded.sid);
    expect(await onReleased.dispatcher.dispatchOnce()).toMatchObject({ claimed: 1, settled: 1 });

    const rows = await fx.commandsOf(seeded.sid);
    expect(rows.find((row) => row.id === sendCommandId)!).toMatchObject({ status: "succeeded" });
    expect(rows.filter((row) => row.op === "resume").length).toBeGreaterThanOrEqual(2);
    expect(rows.some((row) => row.status === "failed")).toBe(false);
    // 同 boot 的第二枚恢复命令用的是 attempt 1（有界、且与第一枚不同 id）。
    const resumeIds = rows.filter((row) => row.op === "resume").map((row) => row.id);
    expect(resumeIds).toContain(recoveryCommandId({ tenantId: fx.tenantId, sessionId: seeded.sid, revision: 1, bootId: "boot-A", attempt: 1 }));
    expect(new Set(resumeIds).size).toBe(resumeIds.length);
  }, 90_000);

  it("bounds the recovery attempts per boot and keeps the waiting message queued instead of failing it", async () => {
    const fx = await createFixture();
    const cellA = await startCell({ cellId: fx.cellId, bootId: "boot-A", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellA);
    const seeded = await seedCommittedTurn(fx, cellA, "worker-a");
    const cellB = await startCell({ cellId: fx.cellId, bootId: "boot-B", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellB);
    const runtime = makeRuntime({
      store: fx.driverStore, cell: cellB, tenantId: fx.tenantId, workerId: "worker-bounded", serviceToken: fx.serviceToken,
      recovery: { maxAttemptsPerBoot: 2 },
    });
    const recovery = new RuntimeSessionRecovery({ store: fx.store, maxAttemptsPerBoot: 2 });

    // 用满上限：attempt 0、1 都被占（用确定性 id 直接入队，模拟已经恢复过两次）。
    for (const attempt of [0, 1]) {
      const id = recoveryCommandId({ tenantId: fx.tenantId, sessionId: seeded.sid, revision: 1, bootId: "boot-B", attempt });
      await fx.store.withTenant({ tenantId: fx.tenantId }, async (tx) => {
        await tx.trx.insertInto("commands").values({
          tenant_id: fx.tenantId, id, binding_id: seeded.sid, work_id: fx.workId, actor_user_id: fx.owner.userId,
          op: "resume", body_hash: sha256Hex(JSON.stringify(resumeBodyOf({ sessionId: seeded.sid, commandId: id }))),
          body: resumeBodyOf({ sessionId: seeded.sid, commandId: id }), grant_revision: 1, status: "succeeded",
          settled_at: new Date(), receipt: { status: "accepted", commandId: id, bootId: "boot-B" },
        }).execute();
      });
    }
    const exhausted = await recovery.requestResume({ tenantId: fx.tenantId, sessionId: seeded.sid, bootId: "boot-B", reason: "test-bounded" });
    expect(exhausted.status).toBe("exhausted");
    expect((await fx.commandsOf(seeded.sid)).filter((row) => row.op === "resume")).toHaveLength(2);
    const exhaustedAudit = (await fx.auditOf(seeded.sid)).filter((row) => row.action === "session.recovery_requested").at(-1)!;
    expect(exhaustedAudit).toMatchObject({ effect: "deny" });
    expect(exhaustedAudit.reason).toMatch(/recovery-attempts-exhausted/);

    // 等待恢复的消息保持队列（退避），绝不因为"恢复被限流"被永久判失败。
    const sendCommandId = randomUUID();
    await runtime.send(fx.owner, seeded.sid, { commandId: sendCommandId, text: "等待恢复的消息" });
    const round = await runtime.dispatcher.dispatchOnce();
    expect(round.failed).toBe(0);
    const sendRow = (await fx.commandsOf(seeded.sid)).find((row) => row.id === sendCommandId)!;
    expect(sendRow.status).toBe("queued");
    expect(sendRow.last_error).toMatch(/recovery-exhausted/);
    expect((await fx.auditOf(seeded.sid)).some((row) => row.action === "command.failed")).toBe(false);
  }, 60_000);

  it("does not treat an arbitrary 403/identity mismatch as recoverable", async () => {
    const fx = await createFixture();
    const cell = await startCell({ cellId: fx.cellId, bootId: "boot-A", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cell);
    const runtime = makeRuntime({ store: fx.driverStore, cell, tenantId: fx.tenantId, workerId: "worker-negative", serviceToken: fx.serviceToken });
    const session = await runtime.createSession(fx.owner, fx.workId, "novel-chapter");
    expect(await runtime.dispatcher.dispatchOnce()).toMatchObject({ claimed: 1, settled: 1 });

    // 撤权（一个**真实的**、明确的授权拒绝）：绑定 revoked + rev 前进。
    // 这既不是 boot 不匹配，也不是 driver 的 session_not_open/identity_invalid，
    // 因此必须按原分类永久失败，绝不生成 resume。
    const sendCommandId = randomUUID();
    await migration.updateTable("session_bindings")
      .set({ status: "revoked", revoked_at: new Date(), revoked_revision: 2 })
      .where("id", "=", session.id).execute();
    const round = await runtime.dispatcher.dispatchOnce();
    // 撤权绑定不再进入投递候选：一条命令都不会被认领，更没有 failed。
    expect(round).toMatchObject({ claimed: 0, failed: 0 });
    const rows = await fx.commandsOf(session.id);
    expect(rows.filter((row) => row.op === "resume")).toHaveLength(0);
    expect(rows.some((row) => row.status === "failed")).toBe(false);

    // 另一条真实负例：**身份不匹配**（tool 的凭证 sub 与绑定所有者不同）绝不会被
    // 当成可恢复。这里用一个把 driver 响应伪造成 403 identity_mismatch 的注入 client
    // 来直接验证分类边界（否则需要真的另一份私有密钥）。
    const sid = await fx.store.withTenant({ tenantId: fx.tenantId }, async (tx) => {
      const id = randomUUID();
      await tx.trx.insertInto("session_bindings").values({
        tenant_id: fx.tenantId, id, owner_user_id: fx.owner.userId, work_id: fx.workId,
        preset: "novel-chapter", policy_revision: "test", cell_id: fx.cellId, status: "active", revoked_revision: 1,
      }).execute();
      return id;
    });
    const mismatchCommandId = randomUUID();
    await runtime.send(fx.owner, sid, { commandId: mismatchCommandId, text: "身份不匹配" });
    const mismatchRuntime = makeRuntime({
      store: fx.driverStore,
      cell,
      tenantId: fx.tenantId,
      workerId: "worker-mismatch",
      serviceToken: fx.serviceToken,
      driver: {
        ...createDriverHttpClient({ deadlineMs: 5_000 }),
        postCommand: async () => ({
          ok: false as const,
          kind: "http" as const,
          status: 403,
          code: "identity_mismatch",
          reason: "driver 返回 403（凭证或权限被拒）",
          retryable: false,
        }),
      },
    });
    const mismatchRound = await mismatchRuntime.dispatcher.dispatchOnce();
    expect(mismatchRound).toMatchObject({ claimed: 1, failed: 1, settled: 0 });
    const mismatchRows = await fx.commandsOf(sid);
    expect(mismatchRows.find((row) => row.id === mismatchCommandId)).toMatchObject({ status: "failed" });
    expect(mismatchRows.filter((row) => row.op === "resume")).toHaveLength(0);
  }, 60_000);

  it("never sends a subscribe grant that the cell would reject, and does not open a stream on a stale boot", async () => {
    const fx = await createFixture();
    const cellA = await startCell({ cellId: fx.cellId, bootId: "boot-A", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellA);
    const seeded = await seedCommittedTurn(fx, cellA, "worker-a");
    const cellB = await startCell({ cellId: fx.cellId, bootId: "boot-B", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellB);
    const runtime = makeRuntime({ store: fx.driverStore, cell: cellB, tenantId: fx.tenantId, workerId: "worker-no-blind", serviceToken: fx.serviceToken });

    const before = cellB.requests.filter((call) => call.path.endsWith("/events")).length;
    await expect(runtime.events(fx.owner, seeded.sid, 0, new AbortController().signal)).rejects.toMatchObject({
      statusCode: 503,
      code: "session_reopening",
    });
    // 关键反例：不接受"先发 subscribe 再吃 403"——一个字节都没有发到 events 端点。
    expect(cellB.requests.filter((call) => call.path.endsWith("/events")).length).toBe(before);

    // 反例：恢复被禁用时行为回到旧语义（502/503 stream_unavailable），绝不静默假装成功。
    const legacy = makeRuntime({
      store: fx.driverStore, cell: cellB, tenantId: fx.tenantId, workerId: "worker-legacy", serviceToken: fx.serviceToken,
      recovery: { enabled: false },
    });
    const controller = new AbortController();
    await expect(legacy.events(fx.owner, seeded.sid, 0, controller.signal)).rejects.toMatchObject({
      statusCode: 502,
      code: "stream_unavailable",
    });
    // 旧语义下这条被 driver 拒掉，且不产生任何 resume。
    expect((await fx.commandsOf(seeded.sid)).filter((row) => row.op === "resume")).toHaveLength(1);
  }, 60_000);

  it("does not truncate the current boot's resume usage behind 200 rows of history (exact candidate lookup)", async () => {
    const fx = await createFixture();
    const cellA = await startCell({ cellId: fx.cellId, bootId: "boot-A", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellA);
    const seeded = await seedCommittedTurn(fx, cellA, "worker-a");

    // 塞进**远超 200** 条历史 resume（全部 created_at 比之后的新行更早）。
    await seedHistoricalResumes(fx, seeded.sid, 250, fx.owner.userId);

    // 当前 boot B 的 attempt 0 已经 accepted：模拟"boot B 恢复过一次、Agent 又被释放"。
    const attempt0 = await seedSucceededResume(fx, seeded.sid, fx.owner.userId, { bootId: "boot-B", attempt: 0 });

    const cellB = await startCell({ cellId: fx.cellId, bootId: "boot-B", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellB);
    const onB = makeRuntime({ store: fx.driverStore, cell: cellB, tenantId: fx.tenantId, workerId: "worker-boot-b", serviceToken: fx.serviceToken });

    // 当前 boot 再次丢失：必须生成 attempt 1，绝不能被历史截断骗回 attempt 0（那会
    // 幂等命中已 accepted 的 attempt0，状态永远停在 pending，恢复永远不发生）。
    const controller = new AbortController();
    await expect(onB.events(fx.owner, seeded.sid, 0, controller.signal)).rejects.toMatchObject({
      statusCode: 503,
      code: "session_reopening",
    });
    const expectedAttempt1 = recoveryCommandId({ tenantId: fx.tenantId, sessionId: seeded.sid, revision: 1, bootId: "boot-B", attempt: 1 });
    // 只取当前 boot 的候选行（历史行 id 是随机 uuid，不会命中确定性候选）。
    const currentBootResumes = (await fx.commandsOf(seeded.sid)).filter((row) => row.id === attempt0 || row.id === expectedAttempt1);
    expect(currentBootResumes.map((row) => row.id).sort()).toEqual([attempt0, expectedAttempt1].sort());
    const attempt1Row = (await fx.commandsOf(seeded.sid)).find((row) => row.id === expectedAttempt1)!;
    expect(attempt1Row).toMatchObject({ status: "queued" });
    // 真实入队了（不是幂等命中）：created=false 的 pending 是"已存在"，这里必须是新行。
    const published = await onB.dispatcher.dispatchOnce();
    expect(published).toMatchObject({ claimed: 1, settled: 1 });
    expect((await fx.commandsOf(seeded.sid)).find((row) => row.id === expectedAttempt1)).toMatchObject({ status: "succeeded" });
    expect((await fx.commandsOf(seeded.sid)).find((row) => row.id === attempt0)).toMatchObject({ status: "succeeded" });
  }, 90_000);

  it("still derives a fresh id for a different boot and merges concurrent requests, with deep history present", async () => {
    const fx = await createFixture();
    const cellA = await startCell({ cellId: fx.cellId, bootId: "boot-A", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellA);
    const seeded = await seedCommittedTurn(fx, cellA, "worker-a");
    await seedHistoricalResumes(fx, seeded.sid, 240, fx.owner.userId);
    await seedSucceededResume(fx, seeded.sid, fx.owner.userId, { bootId: "boot-B", attempt: 0 });

    const cellB = await startCell({ cellId: fx.cellId, bootId: "boot-B", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellB);
    const onB = makeRuntime({ store: fx.driverStore, cell: cellB, tenantId: fx.tenantId, workerId: "worker-boot-b2", serviceToken: fx.serviceToken });

    // 同 boot 并发：合并成**一条** attempt 1。
    const controller = new AbortController();
    const results = await Promise.allSettled([
      onB.events(fx.owner, seeded.sid, 0, controller.signal),
      onB.events(fx.owner, seeded.sid, 0, controller.signal),
    ]);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      expect((result as PromiseRejectedResult).reason).toMatchObject({ statusCode: 503, code: "session_reopening" });
    }
    const attempt1 = recoveryCommandId({ tenantId: fx.tenantId, sessionId: seeded.sid, revision: 1, bootId: "boot-B", attempt: 1 });
    const attempt1Rows = (await fx.commandsOf(seeded.sid)).filter((row) => row.id === attempt1);
    expect(attempt1Rows).toHaveLength(1);

    // 换 boot C：必须算出一个**不同**的确定性 id（attempt 0，因为 boot C 没用过），
    // 绝不跨 boot 复用 boot B 已 accepted 的旧键。
    const cellC = await startCell({ cellId: fx.cellId, bootId: "boot-C", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellC);
    const onC = makeRuntime({ store: fx.driverStore, cell: cellC, tenantId: fx.tenantId, workerId: "worker-boot-c", serviceToken: fx.serviceToken });
    // 先把 boot B 的 attempt 1 投递掉，避免被"已有待投递 resume"合并。
    expect(await onB.dispatcher.dispatchOnce()).toMatchObject({ claimed: 1, settled: 1 });
    await expect(onC.events(fx.owner, seeded.sid, 0, new AbortController().signal)).rejects.toMatchObject({
      statusCode: 503,
      code: "session_reopening",
    });
    const bootC = recoveryCommandId({ tenantId: fx.tenantId, sessionId: seeded.sid, revision: 1, bootId: "boot-C", attempt: 0 });
    const rows = await fx.commandsOf(seeded.sid);
    expect(rows.some((row) => row.id === bootC)).toBe(true);
    expect(bootC).not.toBe(attempt1);
  }, 90_000);

  it("sees one snapshot: a candidate queued between reads is either merged or chosen as attempt 0, never both", async () => {
    const fx = await createFixture();
    const cellA = await startCell({ cellId: fx.cellId, bootId: "boot-A", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellA);
    const seeded = await seedCommittedTurn(fx, cellA, "worker-a");
    const cellB = await startCell({ cellId: fx.cellId, bootId: "boot-B", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellB);

    const candidate0 = recoveryCommandId({ tenantId: fx.tenantId, sessionId: seeded.sid, revision: 1, bootId: "boot-B", attempt: 0 });
    const candidate1 = recoveryCommandId({ tenantId: fx.tenantId, sessionId: seeded.sid, revision: 1, bootId: "boot-B", attempt: 1 });
    const body = resumeBodyOf({ sessionId: seeded.sid, commandId: candidate0 });

    // 受控交错：`requestResume` 的恢复使用状况读取**结果返回之后**，由另一条连接
    // （`migration`，独立事务、提交）把 candidate0 作为 queued 入队。
    //
    //   * 旧实现把这段逻辑拆成"pending SELECT" + "used SELECT" 两条语句：副作用发生在
    //     第一条之后、第二条之前，于是第二条（used）看见 candidate0、第一条（pending）
    //     看不见 —— 分配 candidate1，产生**两条** resume。这是真实并发缺陷的确定性复现，
    //     不靠循环撞概率。
    //   * 新实现只有**一条** SQL：副作用发生在它之后，本次请求读到的是"当时没有候选、
    //     也没有 pending"的同一快照，于是仍选 attempt0，靠 `enqueue` 幂等合并到 candidate0，
    //     绝不产生 attempt1。
    //
    // 判据同时匹配新旧两种写法下"选两列含 status 的 commands 读"（旧=pending 查询，
    // 新=唯一查询），因此对两种实现都精确命中、不误伤 open-proof（选 receipt）。
    const isResumeUsageRead = (meta: QueryMeta): boolean =>
      meta.table === "commands" && Array.isArray(meta.columns) && meta.columns.length === 2 && meta.columns.includes("status");
    let injected = false;
    const interleaved = afterQuery(fx.store, isResumeUsageRead, async () => {
      if (injected) return;
      injected = true;
      await migration.insertInto("commands").values({
        tenant_id: fx.tenantId, id: candidate0, binding_id: seeded.sid, work_id: fx.workId,
        actor_user_id: fx.owner.userId, op: "resume", body_hash: sha256Hex(JSON.stringify(body)), body,
        grant_revision: 1, status: "queued",
      }).execute();
    });

    const onB = makeRuntime({ store: interleaved, cell: cellB, tenantId: fx.tenantId, workerId: "worker-snapshot", serviceToken: fx.serviceToken });
    // 独立 INSERT 就是受控的并发写者；只发一个订阅，避免第二个无屏障订阅
    // 抢在注入 INSERT 前写入 candidate0，让反例自身产生唯一键竞态。
    // 两个真实并发订阅的合并仍由前面的独立用例覆盖。
    await expect(onB.events(fx.owner, seeded.sid, 0, new AbortController().signal)).rejects.toMatchObject({
      statusCode: 503, code: "session_reopening",
    });
    expect(injected).toBe(true);
    // 核心反例：无论交错先后，同一 boot/rev 只能有一条 resume，且必定是 candidate0。
    // 旧实现会在这里出现 candidate0 + candidate1 两条。
    const resumes = (await fx.commandsOf(seeded.sid)).filter((row) => row.op === "resume");
    expect(resumes).toHaveLength(1);
    expect(resumes[0]!.id).toBe(candidate0);
    expect(resumes.some((row) => row.id === candidate1)).toBe(false);
    // candidate0 仍在等待投递（queued），因此下一条请求会合并到它，而不是分配新 attempt。
    expect(resumes[0]!.status).toBe("queued");
  }, 60_000);

  it("rejects an out-of-range maxAttemptsPerBoot instead of silently clamping it", () => {
    const store = new PlatformStore({ db: {} as Kysely<PlatformDatabase>, serviceCapabilities: RUNTIME_SERVICE_CAPABILITIES });
    for (const bad of [0, -1, 1.5, MAX_RESUME_ATTEMPTS_LIMIT + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new RuntimeSessionRecovery({ store, maxAttemptsPerBoot: bad })).toThrow(/maxAttemptsPerBoot/);
    }
    // 边界内的合法值可以构造（不抛错）。
    expect(() => new RuntimeSessionRecovery({ store, maxAttemptsPerBoot: MAX_RESUME_ATTEMPTS_LIMIT })).not.toThrow();
    expect(() => new RuntimeSessionRecovery({ store })).not.toThrow();
  });

  it("fails closed when the open-proof read fails: no driver call, no resume, then recovers once reads work", async () => {
    const fx = await createFixture();
    const cellA = await startCell({ cellId: fx.cellId, bootId: "boot-A", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellA);
    const seeded = await seedCommittedTurn(fx, cellA, "worker-a");
    const cellB = await startCell({ cellId: fx.cellId, bootId: "boot-B", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellB);

    // 故障注入：只让**投递循环里的 open-proof 读取**失败。
    //
    // 判据必须精确：`readFacts` 读 session_bindings/members/works/tenants，
    // `candidateSessions` / `claimSessionCommand` 也读 `commands`；按表名注入会打挂
    // 认领而不是证明。`openProof` 是**唯一**选择 `receipt` 列的查询
    // （`.select(["id","receipt"])`），因此只在"这一条查询选中了 receipt 列"时注入
    // 一次失败；其余读写原样走真实 SQL。
    const flaky = injectReadFailure(
      fx.store,
      (meta) => (meta.table === "commands" && Array.isArray(meta.columns) && meta.columns.includes("receipt") ? "throw" : undefined),
    );

    const runtime = makeRuntime({ store: flaky, cell: cellB, tenantId: fx.tenantId, workerId: "worker-flaky", serviceToken: fx.serviceToken });
    const sendCommandId = randomUUID();
    await runtime.send(fx.owner, seeded.sid, { commandId: sendCommandId, text: "proof 读取失败时的消息" });

    const postsBefore = [...cellA.requests, ...cellB.requests].filter((call) => call.method === "POST" && call.path === "/v1/commands").length;

    // 第一轮：open-proof 读取失败 → fail-closed（release），绝不投递给 driver。
    const round = await runtime.dispatcher.dispatchOnce();
    expect(round).toMatchObject({ claimed: 1, settled: 0, failed: 0 });
    const sendRow = (await fx.commandsOf(seeded.sid)).find((row) => row.id === sendCommandId)!;
    expect(sendRow.status).toBe("queued");
    expect(sendRow.last_error).toMatch(/recovery-unavailable/);
    expect((await fx.commandsOf(seeded.sid)).filter((row) => row.op === "resume")).toHaveLength(0);
    const postsAfterFail = [...cellA.requests, ...cellB.requests].filter((call) => call.method === "POST" && call.path === "/v1/commands").length;
    expect(postsAfterFail).toBe(postsBefore);
    expect((await fx.auditOf(seeded.sid)).some((row) => row.action === "command.failed")).toBe(false);

    // 读取恢复后正常继续：按 open-proof 的 boot 不匹配生成 resume 并让路（不是 failed）。
    // 先让这次 release 的退避窗口过去（真实运行里就是墙钟前进）。
    await advanceBackoff(fx, seeded.sid);
    const recovered = await runtime.dispatcher.dispatchOnce();
    expect(recovered.failed).toBe(0);
    expect((await fx.commandsOf(seeded.sid)).filter((row) => row.op === "resume")).toHaveLength(1);
    expect((await fx.commandsOf(seeded.sid)).find((row) => row.id === sendCommandId)!.status).toBe("queued");
  }, 60_000);

  it("does not burn the real delivery budget while the open-proof is unreadable: max_attempts=1 stays queued, then the same commandId is delivered", async () => {
    const fx = await createFixture();
    const cellA = await startCell({ cellId: fx.cellId, bootId: "boot-A", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellA);
    const seeded = await seedCommittedTurn(fx, cellA, "worker-a");
    const cellB = await startCell({ cellId: fx.cellId, bootId: "boot-B", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellB);

    // 只让 open-proof 的读取失败一次（唯一选中 `receipt` 列的查询）。
    const flaky = injectReadFailure(
      fx.store,
      (meta) => (meta.table === "commands" && Array.isArray(meta.columns) && meta.columns.includes("receipt") ? "throw" : undefined),
    );
    const runtime = makeRuntime({ store: flaky, cell: cellB, tenantId: fx.tenantId, workerId: "worker-budget", serviceToken: fx.serviceToken });
    const sendCommandId = randomUUID();
    await runtime.send(fx.owner, seeded.sid, { commandId: sendCommandId, text: "预算为 1 时的等待消息" });
    // 把真实投递预算压到 1：若"等待恢复"走通用 release，这一轮 attempts 就会撞上限，
    // `releaseCommand` 会把命令标成 `dead` —— 消息永久投不出去。
    await migration.updateTable("commands").set({ max_attempts: 1 }).where("tenant_id", "=", fx.tenantId).where("id", "=", sendCommandId).execute();

    const posts = () => [...cellA.requests, ...cellB.requests].filter((call) => call.method === "POST" && call.path === "/v1/commands").length;
    const events = () => cellB.requests.filter((call) => call.path.endsWith("/events")).length;
    const postsBefore = posts();
    const eventsBefore = events();

    const round = await runtime.dispatcher.dispatchOnce();
    expect(round).toMatchObject({ claimed: 1, settled: 0, released: 1, failed: 0 });
    const sendRow = (await fx.commandsOf(seeded.sid)).find((row) => row.id === sendCommandId)!;
    // 核心反例：等待恢复不消耗投递预算 —— queued、attempts 退回 0、绝不是 dead。
    expect(sendRow).toMatchObject({ status: "queued", attempts: 0, max_attempts: 1 });
    expect(sendRow.last_error).toMatch(/recovery-unavailable/);
    expect((await fx.commandsOf(seeded.sid)).filter((row) => row.op === "resume")).toHaveLength(0);
    expect(posts()).toBe(postsBefore);
    expect(events()).toBe(eventsBefore);
    expect((await fx.auditOf(seeded.sid)).some((row) => row.action === "command.failed")).toBe(false);

    // 读取恢复：先入队 resume 并让路，再投递 resume，最后同一条 send 按**原 commandId** 成功投递。
    await advanceBackoff(fx, seeded.sid);
    const reopened = await runtime.dispatcher.dispatchOnce();
    expect(reopened.failed).toBe(0);
    expect((await fx.commandsOf(seeded.sid)).filter((row) => row.op === "resume")).toHaveLength(1);
    expect((await fx.commandsOf(seeded.sid)).find((row) => row.id === sendCommandId)!).toMatchObject({ status: "queued", attempts: 0 });

    expect(await runtime.dispatcher.dispatchOnce()).toMatchObject({ claimed: 1, settled: 1 });
    expect((await fx.commandsOf(seeded.sid)).find((row) => row.op === "resume")!).toMatchObject({ status: "succeeded" });

    await advanceBackoff(fx, seeded.sid);
    expect(await runtime.dispatcher.dispatchOnce()).toMatchObject({ claimed: 1, settled: 1 });
    const delivered = (await fx.commandsOf(seeded.sid)).find((row) => row.id === sendCommandId)!;
    expect(delivered).toMatchObject({ status: "succeeded", attempts: 1, max_attempts: 1 });
    expect(delivered.receipt).toMatchObject({ status: "accepted", commandId: sendCommandId, bootId: "boot-B" });
  }, 60_000);

  it("stays fail-closed after an exhausted or governance-denied recovery: no POST, queued, budget intact", async () => {
    const fx = await createFixture();
    const cellA = await startCell({ cellId: fx.cellId, bootId: "boot-A", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellA);
    const seeded = await seedCommittedTurn(fx, cellA, "worker-a");
    const cellB = await startCell({ cellId: fx.cellId, bootId: "boot-B", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellB);

    // --- exhausted：本 boot 的恢复上限已用满。---
    await seedSucceededResume(fx, seeded.sid, fx.owner.userId, {
      bootId: "boot-B", attempt: 0, settledAt: new Date(Date.now() - 3_600_000),
    });
    const exhaustedRuntime = makeRuntime({
      store: fx.driverStore, cell: cellB, tenantId: fx.tenantId, workerId: "worker-terminal-exhausted", serviceToken: fx.serviceToken,
      recovery: { maxAttemptsPerBoot: 1 },
    });
    const exhaustedSend = randomUUID();
    await exhaustedRuntime.send(fx.owner, seeded.sid, { commandId: exhaustedSend, text: "exhausted 后的消息" });
    await migration.updateTable("commands").set({ max_attempts: 1 }).where("tenant_id", "=", fx.tenantId).where("id", "=", exhaustedSend).execute();

    const posts = () => [...cellA.requests, ...cellB.requests].filter((call) => call.method === "POST" && call.path === "/v1/commands").length;
    const before = posts();
    const round = await exhaustedRuntime.dispatcher.dispatchOnce();
    expect(round).toMatchObject({ claimed: 1, settled: 0, failed: 0 });
    const exhaustedRow = (await fx.commandsOf(seeded.sid)).find((row) => row.id === exhaustedSend)!;
    // 恢复被耗尽后**绝不**继续用旧授权 POST；也绝不消耗预算变 dead。
    expect(exhaustedRow).toMatchObject({ status: "queued", attempts: 0, max_attempts: 1 });
    expect(exhaustedRow.last_error).toMatch(/recovery-exhausted/);
    expect(posts()).toBe(before);
    // 终止态没有新增 resume（只保留预占的 attempt0）。
    expect((await fx.commandsOf(seeded.sid)).filter((row) => row.op === "resume")).toHaveLength(1);

    // --- denied：投递前的授权用的是当时的成员事实；`ready` 钩子在授权之后把成员停用，
    // 于是随后 resume 入队被**真实 governance** 拒绝（denied）——此后同样不得 POST。---
    const deniedSend = randomUUID();
    await exhaustedRuntime.send(fx.owner, seeded.sid, { commandId: deniedSend, text: "denied 后的消息" });
    await migration.updateTable("commands").set({ max_attempts: 1 }).where("tenant_id", "=", fx.tenantId).where("id", "=", deniedSend).execute();

    const base = createDriverHttpClient({ deadlineMs: 5_000 });
    const denyOnReady: DriverHttpClient = {
      ...base,
      async ready(cell, options) {
        await migration.updateTable("members").set({ status: "disabled", disabled_at: new Date() })
          .where("tenant_id", "=", fx.tenantId).where("user_id", "=", fx.owner.userId).execute();
        return base.ready(cell, options);
      },
    };
    // 这里用默认每-boot 上限（attempt0 已被预占、attempt1 空闲）：恢复请求会真的走到
    // `commands.enqueue`，由**真实 governance** 因成员停用而拒绝，返回 `denied`。
    const deniedRuntime = makeRuntime({ store: fx.driverStore, cell: cellB, tenantId: fx.tenantId, workerId: "worker-terminal-denied", serviceToken: fx.serviceToken, driver: denyOnReady });
    try {
      const beforeDenied = posts();
      const deniedRound = await deniedRuntime.dispatcher.dispatchOnce();
      expect(deniedRound).toMatchObject({ claimed: 1, settled: 0, failed: 0 });
      const deniedRow = (await fx.commandsOf(seeded.sid)).find((row) => row.id === deniedSend)!;
      expect(deniedRow).toMatchObject({ status: "queued", attempts: 0, max_attempts: 1 });
      expect(deniedRow.last_error).toMatch(/recovery-denied/);
      expect(posts()).toBe(beforeDenied);
      expect((await fx.auditOf(seeded.sid)).some((row) => row.action === "command.failed")).toBe(false);
    } finally {
      await migration.updateTable("members").set({ status: "active", disabled_at: null })
        .where("tenant_id", "=", fx.tenantId).where("user_id", "=", fx.owner.userId).execute();
    }
  }, 90_000);

  it("maps a recovery usage-read failure to unavailable with a sanitized 503, never to unknown/denied", async () => {
    const fx = await createFixture();
    const cellA = await startCell({ cellId: fx.cellId, bootId: "boot-A", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellA);
    const seeded = await seedCommittedTurn(fx, cellA, "worker-a");
    const cellB = await startCell({ cellId: fx.cellId, bootId: "boot-B", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellB);

    // `listResumes` 的"待投递 resume"查询是唯一在 `commands` 上选两列（含 status）的读；
    // open-proof 选 `receipt`，候选查询只选 `id`。只打挂这一条，制造"恢复使用状况读取故障"。
    const isUsageRead = (meta: QueryMeta): boolean =>
      meta.table === "commands" && Array.isArray(meta.columns) && meta.columns.length === 2 && meta.columns.includes("status");
    const posts = () => [...cellA.requests, ...cellB.requests].filter((call) => call.method === "POST" && call.path === "/v1/commands").length;
    const events = () => cellB.requests.filter((call) => call.path.endsWith("/events")).length;

    // 命令路径：恢复读取故障 ⇒ unavailable（不是 unknown/denied），让路且不消耗预算、不 POST。
    const flakyCommand = injectReadFailure(fx.store, (meta) => (isUsageRead(meta) ? "throw" : undefined));
    const runtime = makeRuntime({ store: flakyCommand, cell: cellB, tenantId: fx.tenantId, workerId: "worker-usage-read", serviceToken: fx.serviceToken });
    const sendCommandId = randomUUID();
    await runtime.send(fx.owner, seeded.sid, { commandId: sendCommandId, text: "恢复读取故障时的消息" });
    await migration.updateTable("commands").set({ max_attempts: 1 }).where("tenant_id", "=", fx.tenantId).where("id", "=", sendCommandId).execute();

    const postsBefore = posts();
    const eventsBefore = events();
    const round = await runtime.dispatcher.dispatchOnce();
    expect(round).toMatchObject({ claimed: 1, settled: 0, failed: 0 });
    const sendRow = (await fx.commandsOf(seeded.sid)).find((row) => row.id === sendCommandId)!;
    expect(sendRow).toMatchObject({ status: "queued", attempts: 0, max_attempts: 1 });
    expect(sendRow.last_error).toMatch(/recovery-unavailable/);
    expect(sendRow.status).not.toBe("dead");
    expect((await fx.commandsOf(seeded.sid)).filter((row) => row.op === "resume")).toHaveLength(0);
    expect(posts()).toBe(postsBefore);

    // 订阅路径：同一故障必须答**固定脱敏**的 503 stream_unavailable，零 subscribe、零 resume。
    const flakySubscribe = injectReadFailure(fx.driverStore, (meta) => (isUsageRead(meta) ? "throw" : undefined));
    const subscriber = makeRuntime({ store: flakySubscribe, cell: cellB, tenantId: fx.tenantId, workerId: "worker-usage-read-sub", serviceToken: fx.serviceToken });
    const resumesBefore = (await fx.commandsOf(seeded.sid)).filter((row) => row.op === "resume").length;
    const failure = await subscriber.events(fx.owner, seeded.sid, 0, new AbortController().signal).then(
      () => undefined,
      (error: unknown) => error as { statusCode: number; code: string; reason: string },
    );
    expect(failure).toMatchObject({ statusCode: 503, code: "stream_unavailable" });
    // 不记录/不回显 SQL 或私密原因，也不冒充 denied。
    expect(failure!.code).not.toBe("session_recovery_denied");
    expect(failure!.reason).not.toMatch(/SQL|injected|commands|status|resume-read-failed|binding/i);
    expect(events()).toBe(eventsBefore);
    expect((await fx.commandsOf(seeded.sid)).filter((row) => row.op === "resume")).toHaveLength(resumesBefore);
  }, 90_000);

  it("blocks the subscribe when the open-proof read fails: 503 stream_unavailable, zero subscribe, zero resume", async () => {
    const fx = await createFixture();
    const cellA = await startCell({ cellId: fx.cellId, bootId: "boot-A", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellA);
    const seeded = await seedCommittedTurn(fx, cellA, "worker-a");
    const cellB = await startCell({ cellId: fx.cellId, bootId: "boot-B", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellB);

    const flaky = injectReadFailure(
      fx.store,
      (meta) => (meta.table === "commands" && Array.isArray(meta.columns) && meta.columns.includes("receipt") ? "throw" : undefined),
    );
    const runtime = makeRuntime({ store: flaky, cell: cellB, tenantId: fx.tenantId, workerId: "worker-proof-fail-sub", serviceToken: fx.serviceToken });

    const resumesBefore = (await fx.commandsOf(seeded.sid)).filter((row) => row.op === "resume").length;
    const eventsBefore = cellB.requests.filter((call) => call.path.endsWith("/events")).length;
    // 证明读取失败 → fail-closed：明确"暂时不可用"，不订阅、不生成 resume。
    await expect(runtime.events(fx.owner, seeded.sid, 0, new AbortController().signal)).rejects.toMatchObject({
      statusCode: 503,
      code: "stream_unavailable",
    });
    expect(cellB.requests.filter((call) => call.path.endsWith("/events")).length).toBe(eventsBefore);
    expect((await fx.commandsOf(seeded.sid)).filter((row) => row.op === "resume")).toHaveLength(resumesBefore);
  }, 60_000);

  it("classifies a binding-read failure as unavailable, not as binding-not-found", async () => {
    const fx = await createFixture();
    const cellA = await startCell({ cellId: fx.cellId, bootId: "boot-A", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellA);
    const seeded = await seedCommittedTurn(fx, cellA, "worker-a");
    const cellB = await startCell({ cellId: fx.cellId, bootId: "boot-B", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellB);

    // 只在 `requestResume` 自己的绑定读取（三列、含 owner_user_id、不含 tenant_id）上
    // 注入**数据库读取失败**。`readFacts`（八列、含 tenant_id）与 open-proof 都不受影响。
    const flaky = injectReadFailure(
      fx.store,
      (meta) =>
        meta.table === "session_bindings" && Array.isArray(meta.columns) && meta.columns.includes("owner_user_id") && !meta.columns.includes("tenant_id")
          ? "throw"
          : undefined,
    );
    const runtime = makeRuntime({ store: flaky, cell: cellB, tenantId: fx.tenantId, workerId: "worker-binding-fail", serviceToken: fx.serviceToken });

    const eventsBefore = cellB.requests.filter((call) => call.path.endsWith("/events")).length;
    // 读取失败绝不能被伪装成"绑定不存在/被拒"（那是不可撤销的授权结论），
    // 而应明确是"暂时不可用"，且不订阅、不生成 resume。
    const failure = await runtime.events(fx.owner, seeded.sid, 0, new AbortController().signal).then(
      () => undefined,
      (error: unknown) => error as { statusCode: number; code: string; reason: string },
    );
    expect(failure).toMatchObject({ statusCode: 503, code: "stream_unavailable" });
    expect(failure!.code).not.toBe("session_recovery_denied");
    expect(cellB.requests.filter((call) => call.path.endsWith("/events")).length).toBe(eventsBefore);
    expect((await fx.commandsOf(seeded.sid)).filter((row) => row.op === "resume")).toHaveLength(0);

    // 读取恢复正常后，同一条订阅会按 boot 不匹配正常走恢复（证明故障是暂时的）。
    const healthy = makeRuntime({ store: fx.driverStore, cell: cellB, tenantId: fx.tenantId, workerId: "worker-binding-ok", serviceToken: fx.serviceToken });
    await expect(healthy.events(fx.owner, seeded.sid, 0, new AbortController().signal)).rejects.toMatchObject({
      statusCode: 503,
      code: "session_reopening",
    });
    expect((await fx.commandsOf(seeded.sid)).filter((row) => row.op === "resume")).toHaveLength(1);
  }, 60_000);

  it("answers a denied recovery with a fixed 403 and an exhausted recovery with a fixed 409, never 503 session_reopening", async () => {
    const fx = await createFixture();
    const cellA = await startCell({ cellId: fx.cellId, bootId: "boot-A", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellA);
    const seeded = await seedCommittedTurn(fx, cellA, "worker-a");
    const cellB = await startCell({ cellId: fx.cellId, bootId: "boot-B", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellB);

    // --- denied：恢复原语给出明确的 `denied`（绑定在两次读取之间消失/被撤权的竞态），
    // 订阅端点必须答固定的 403，而不是 503 session_reopening。
    //
    // 注入点精确到"`requestResume` 自己的绑定读取"：它只选
    // `["owner_user_id","status","revoked_revision"]`，而 `loadGrantInput` 走的
    // `readFacts` 选 8 列。让这条三列查询返回 not-found，就能在不放宽任何授权的前提下
    // 确定性地命中 denied 分支。
    const deniedStore = injectReadFailure(
      fx.store,
      (meta) =>
        meta.table === "session_bindings" && Array.isArray(meta.columns) && meta.columns.includes("owner_user_id") && !meta.columns.includes("tenant_id")
          ? "empty"
          : undefined,
    );

    const deniedRuntime = makeRuntime({ store: deniedStore, cell: cellB, tenantId: fx.tenantId, workerId: "worker-denied", serviceToken: fx.serviceToken });
    const eventsBeforeDenied = cellB.requests.filter((call) => call.path.endsWith("/events")).length;
    const resumesBeforeDenied = (await fx.commandsOf(seeded.sid)).filter((row) => row.op === "resume").length;
    const deniedFailure = await deniedRuntime.events(fx.owner, seeded.sid, 0, new AbortController().signal).then(
      () => undefined,
      (error: unknown) => error as { statusCode: number; code: string; reason: string },
    );
    expect(deniedFailure).toMatchObject({ statusCode: 403, code: "session_recovery_denied" });
    // 固定脱敏文案：不回显内部 reason / 绑定细节 / 尝试序号。
    expect(deniedFailure!.reason).not.toMatch(/binding-not-found|boot|attempt|owner/i);
    // 终止态：不新增 resume、不订阅（一个字节都不发给 events 端点）。
    expect((await fx.commandsOf(seeded.sid)).filter((row) => row.op === "resume")).toHaveLength(resumesBeforeDenied);
    expect(cellB.requests.filter((call) => call.path.endsWith("/events")).length).toBe(eventsBeforeDenied);

    // --- exhausted：用满每-boot 上限，订阅必须答 409（而不是 503 session_reopening）。---
    const exhaustedRuntime = makeRuntime({
      store: fx.driverStore, cell: cellB, tenantId: fx.tenantId, workerId: "worker-exhausted-http", serviceToken: fx.serviceToken,
      recovery: { maxAttemptsPerBoot: 1 },
    });
    const attempt0 = await seedSucceededResume(fx, seeded.sid, fx.owner.userId, {
      bootId: "boot-B",
      attempt: 0,
      // 占用当前 boot B 的 attempt 0，但把 settled_at 回拨到**早于** boot A 的 create
      // 回执：open-proof 仍读到"boot 不匹配"（进入恢复分支），而恢复侧的候选查询发现
      // attempt 0 已被占用 —— 于是以 maxAttemptsPerBoot=1 撞上 exhausted。
      settledAt: new Date(Date.now() - 3_600_000),
    });
    const eventsBeforeExhausted = cellB.requests.filter((call) => call.path.endsWith("/events")).length;
    const exhaustedFailure = await exhaustedRuntime.events(fx.owner, seeded.sid, 0, new AbortController().signal).then(
      () => undefined,
      (error: unknown) => error as { statusCode: number; code: string; reason: string },
    );
    expect(exhaustedFailure).toMatchObject({ statusCode: 409, code: "session_recovery_exhausted" });
    expect(exhaustedFailure!.reason).not.toMatch(/recovery-attempts-exhausted|attempt=|boot=/);
    // 终止态：只有已存在的那一枚 attempt0，没有新增；也没有向 driver 订阅。
    const resumesAfterExhausted = (await fx.commandsOf(seeded.sid)).filter((row) => row.op === "resume");
    expect(resumesAfterExhausted.map((row) => row.id)).toEqual([attempt0]);
    expect(cellB.requests.filter((call) => call.path.endsWith("/events")).length).toBe(eventsBeforeExhausted);
  }, 60_000);

  it("maps the reactive identity_invalid branch to the same terminal codes, with no resume and no send failure", async () => {
    const fx = await createFixture();
    const cellA = await startCell({ cellId: fx.cellId, bootId: "boot-A", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellA);
    const seeded = await seedCommittedTurn(fx, cellA, "worker-a");
    // **同一个 bootId**，身份表为空：open-proof 说"本 boot 打开过"，于是照常发 subscribe，
    // driver 以 403 identity_invalid 拒绝 —— 走的是**反应式**分支。
    const revived = await startCell({ cellId: fx.cellId, bootId: "boot-A", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(revived);
    const runtime = makeRuntime({ store: fx.driverStore, cell: revived, tenantId: fx.tenantId, workerId: "worker-reactive", serviceToken: fx.serviceToken });

    // 反应式分支 + exhausted：预占该 boot 的唯一 attempt。
    await seedSucceededResume(fx, seeded.sid, fx.owner.userId, { bootId: "boot-A", attempt: 0, settledAt: new Date(Date.now() - 3_600_000) });
    const exhaustedRuntime = makeRuntime({
      store: fx.driverStore, cell: revived, tenantId: fx.tenantId, workerId: "worker-reactive-exhausted", serviceToken: fx.serviceToken,
      recovery: { maxAttemptsPerBoot: 1 },
    });
    const eventsBefore = revived.requests.filter((call) => call.path.endsWith("/events")).length;
    const failure = await exhaustedRuntime.events(fx.owner, seeded.sid, 0, new AbortController().signal).then(
      () => undefined,
      (error: unknown) => error as { statusCode: number; code: string; reason: string },
    );
    // 反应式分支同样不能把终止态冒充成 session_reopening。
    expect(failure).toMatchObject({ statusCode: 409, code: "session_recovery_exhausted" });
    expect(failure!.reason).not.toMatch(/recovery-attempts-exhausted|attempt=|boot=/);
    // 反应式恢复确实向 driver 发过一次 subscribe（这是该分支的语义），但没有新增 resume。
    expect(revived.requests.filter((call) => call.path.endsWith("/events")).length).toBe(eventsBefore + 1);
    expect((await fx.commandsOf(seeded.sid)).filter((row) => row.op === "resume")).toHaveLength(1);

    // 同 boot 的反应式分支在**恢复可用**时仍正常生成 resume（attempt 1）。
    const releasedAgain = await startCell({ cellId: fx.cellId, bootId: "boot-A", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(releasedAgain);
    const healthy = makeRuntime({ store: fx.driverStore, cell: releasedAgain, tenantId: fx.tenantId, workerId: "worker-reactive-ok", serviceToken: fx.serviceToken });
    await expect(healthy.events(fx.owner, seeded.sid, 0, new AbortController().signal)).rejects.toMatchObject({
      statusCode: 503,
      code: "session_reopening",
    });
    const attempt1 = recoveryCommandId({ tenantId: fx.tenantId, sessionId: seeded.sid, revision: 1, bootId: "boot-A", attempt: 1 });
    expect((await fx.commandsOf(seeded.sid)).some((row) => row.id === attempt1)).toBe(true);
    // 反应式恢复的审计必须如实标注触发来源（driver 报的码），而不是含糊的 "mismatch-or-unknown"。
    const reactiveAudit = (await fx.auditOf(seeded.sid)).filter((row) => row.action === "session.recovery_requested").at(-1)!;
    expect(reactiveAudit).toMatchObject({ effect: "allow" });
    expect(reactiveAudit.detail).toMatchObject({ openProof: "driver-reported" });

    // 等待恢复的 send 绝不被永久 fail。
    const sendCommandId = randomUUID();
    await healthy.send(fx.owner, seeded.sid, { commandId: sendCommandId, text: "反应式恢复后要投递的消息" });
    const round = await healthy.dispatcher.dispatchOnce();
    expect(round.failed).toBe(0);
    expect((await fx.commandsOf(seeded.sid)).find((row) => row.id === sendCommandId)!.status).toBe("queued");
  }, 90_000);

  it("exposes the honest terminal recovery code through the real HTTP boundary (409 exhausted), never 503 reopening", async () => {
    const fx = await createFixture();
    const cellA = await startCell({ cellId: fx.cellId, bootId: "boot-A", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellA);
    const seeded = await seedCommittedTurn(fx, cellA, "worker-a");
    const cellB = await startCell({ cellId: fx.cellId, bootId: "boot-B", tenantId: fx.tenantId, disk: fx.disk });
    cells.push(cellB);
    const exhaustedRuntime = makeRuntime({
      store: fx.driverStore, cell: cellB, tenantId: fx.tenantId, workerId: "worker-http-exhausted", serviceToken: fx.serviceToken,
      recovery: { maxAttemptsPerBoot: 1 },
    });
    await seedSucceededResume(fx, seeded.sid, fx.owner.userId, {
      bootId: "boot-B", attempt: 0, settledAt: new Date(Date.now() - 3_600_000),
    });

    // 真实 Fastify 边界：同源开发登录 + 真实 CSRF，`events` 路由调用真实 runtime。
    const sessions = new Map<string, AuthSession>();
    const auth: AuthRepository = {
      async createSession(k, v) { sessions.set(k, v); },
      async findSession(k) { return sessions.get(k); },
      async deleteSession(k) { sessions.delete(k); },
      async identity() { return fx.owner; },
      async createFlow(_k: string, _v: LoginFlow) {},
      async consumeFlow() { return undefined; },
      async resolveSubject() { return undefined; },
    };
    const repository = new Proxy({}, { get: () => () => { throw new Error("novel repository not used by this test"); } }) as unknown as NovelRepository;
    const app: FastifyInstance = await createBffServer({
      auth: { mode: "development", origin: "http://127.0.0.1:8787", sessionTtlSeconds: 3600, repository: auth,
        developmentUsers: { author: fx.owner } },
      repository,
      runtime: exhaustedRuntime,
    });
    try {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/dev-login", headers: { origin: "http://127.0.0.1:8787" }, payload: { user: "author" } });
      expect(login.statusCode).toBe(200);
      const cookies = { myrix_session: login.cookies[0]!.value };
      const eventsBefore = cellB.requests.filter((call) => call.path.endsWith("/events")).length;
      const res = await app.inject({ method: "GET", url: `/api/v1/sessions/${seeded.sid}/events`, cookies });
      // 核心断言：终止态经真实 HTTP 边界是 409 + 机器可读码，而不是 503 session_reopening。
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "session_recovery_exhausted" });
      expect(res.json().reason).not.toMatch(/recovery-attempts-exhausted|attempt=|boot=|severity|SQL/i);
      // 零 subscribe、零新增 resume。
      expect(cellB.requests.filter((call) => call.path.endsWith("/events")).length).toBe(eventsBefore);
      expect((await fx.commandsOf(seeded.sid)).filter((row) => row.op === "resume")).toHaveLength(1);
    } finally {
      await app.close();
    }
  }, 60_000);
});

describe("recovery primitives (pure)", () => {
  const base = { tenantId: "11111111-1111-4111-8111-111111111111", sessionId: "22222222-2222-4222-8222-222222222222", revision: 1 };

  it("derives a stable RFC-4122 uuid that changes with boot, attempt and revision", () => {
    const a = recoveryCommandId({ ...base, bootId: "boot-A", attempt: 0 });
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // 确定性：同一输入永远同一 id（并发合并的前提）。
    expect(recoveryCommandId({ ...base, bootId: "boot-A", attempt: 0 })).toBe(a);
    // 换 boot / 换 attempt / 换 rev 都必须是**不同**命令。
    expect(recoveryCommandId({ ...base, bootId: "boot-B", attempt: 0 })).not.toBe(a);
    expect(recoveryCommandId({ ...base, bootId: "boot-A", attempt: 1 })).not.toBe(a);
    expect(recoveryCommandId({ ...base, revision: 2, bootId: "boot-A", attempt: 0 })).not.toBe(a);
    // 不能是 `resume-<sid>` 这类非 uuid 形态（commands.id 是 uuid 列）。
    expect(a).not.toContain("resume-");
  });

  it("keeps the resume body free of extra fields so bh stays the contract body", () => {
    const commandId = recoveryCommandId({ ...base, bootId: "boot-A", attempt: 0 });
    const body = resumeBodyOf({ sessionId: base.sessionId, commandId });
    // boot/attempt 只出现在确定性 uuid 与审计里，绝不扩 driver 的线契约。
    expect(Object.keys(body).sort()).toEqual(["commandId", "op", "sid"]);
    expect(body).toEqual({ op: "resume", sid: base.sessionId, commandId });
    expect(wireBodyOf({ op: "resume", bindingId: base.sessionId, id: commandId, body })).toEqual(body);
    expect(JSON.stringify(body)).toBe(JSON.stringify(wireBodyOf({ op: "resume", bindingId: base.sessionId, id: commandId, body })));
  });

  it("only ever treats session_not_open and identity_invalid as recoverable", () => {
    expect(isRecoverableDriverCode("session_not_open")).toBe(true);
    expect(isRecoverableDriverCode("identity_invalid")).toBe(true);
    for (const code of ["not_owner", "identity_mismatch", "rev_stale", "session_revoked", "grant/expired", "grant_replay", "malformed_body", "no_receipt", undefined]) {
      expect(isRecoverableDriverCode(code)).toBe(false);
    }
  });

  it("never confuses a recovery id with a client commandId shape", () => {
    const id = recoveryCommandId({ ...base, bootId: "boot-A", attempt: 0 });
    // commands.id 是 uuid 列：`resume-<sid>` 形态会在 Postgres 直接失败。
    expect(() => randomUUID()).not.toThrow();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(id.startsWith("resume-")).toBe(false);
    expect(id.includes(base.sessionId)).toBe(false);
  });
});
