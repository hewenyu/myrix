/**
 * 初始订阅（cursor `0`）必须触发**真实历史回放**的回归测试。
 *
 * 复现的真实 BUG：`runtime-router.ts` 曾经把 `after === 0` 折叠成 `undefined` 再传给
 * driver，于是"轮次已提交、随后首次订阅"的会话在网页重载后历史空白 —— user 持久事件
 * （真实证据：`data/cells/cell-dev-2/.../session.v4.jsonl` 第 7 行 `user/message` seq=5
 * 已落盘）在 BFF 侧整段消失，而流本身看起来完全正常。
 *
 * 为什么这条测试不是"mock 返回固定内容"：整条数据路径都是真实组件，只有两个
 * **文档化的注入缝**（BFF 的 `validators.currentFacts` 与 inert 的 Kysely db）被替换，
 * 二者都不参与 cursor/replay 语义：
 *
 *   BFF `runtime.events()` 真实代码（含被修的那一行）
 *     → 真实 ES256 签发（`createGrantSigner`）
 *     → 真实 driver HTTP 客户端与真实 SSE 帧解析（`createDriverHttpClient`）
 *     → 真实 driver 路由 + 真实 `SessionController` 订阅鉴权（`createRouter` / `verifyAndConsume`）
 *     → **真实 `EventHub`**（`plugins/myrix-runtime-driver/src/events.ts` 的补发/合并/去重水位）
 *     → 真实 SSE 编码（`encodeSseFrame`）
 *     → 真实白名单投影（`projectDriverFrame`）
 *
 * 历史事件用**真实会话日志的形状与 seq 编号**（seq 0 `agent/inbox/spliced` …
 * seq 5 `user/message` … seq 8 `assistant/message` … seq 10 `turn/end`），正文是合成的，
 * 不含任何请求元数据或私密配置。
 *
 * 同时冻结 driver 的既有语义（**不改 driver**）：
 *   * `undefined` / 缺头 = live-only，只发当前水位标记，绝不补发历史；
 *   * `0` = 从 `seq > 0` 补发 —— 这正是 BFF 初始订阅必须转发的东西。
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createGrantSigner, createGrantVerifier, generateTestKeyPair, type GrantVerifier } from "@myrix/grant";
import type { PlatformIdentity, SessionStreamEvent } from "@myrix/contracts";
import type { Kysely } from "kysely";
import { PlatformStore, type PlatformDatabase } from "@myrix/platform-store";
import { SessionController, type ControllerHost, type RuntimePorts } from "../../../plugins/myrix-runtime-driver/src/controller";
import { EventHub } from "../../../plugins/myrix-runtime-driver/src/events";
import { createRouter } from "../../../plugins/myrix-runtime-driver/src/router";
import type { SseSink } from "../../../plugins/myrix-runtime-driver/src/http";
import type { StreamEvent } from "../../../plugins/myrix-runtime-driver/src/types";
import { createStaticCellDirectory } from "../src/runtime-cells";
import { createDriverHttpClient } from "../src/runtime-driver-client";
import { createRuntimeRouter, RUNTIME_SERVICE_CAPABILITIES, type DeliveryFacts, type RuntimeRuntime } from "../src/runtime-router";

const tenantId = "11111111-1111-4111-8111-111111111111";
const ownerUserId = "22222222-2222-4222-8222-222222222222";
const workId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";
const cellId = "cell-replay-zero";
const driverBootId = "boot-replay-zero";
const preset = "novel-chapter";
const owner: PlatformIdentity = { tenantId, userId: ownerUserId, role: "member", displayName: "作者" };

/**
 * "已提交的一轮"：类型与 seq 编号取自真实会话日志（seq 0/1/2/3/4/5/6/7/8/9/10），
 * 正文为合成文本。白名单只放行 user/message、assistant/message、turn/end；
 * 其余（`system/message`、`request/header`、`request/context`、`step/*`）不投影，
 * 因此公开 seq 合法跳跃。
 */
const committedTurn: readonly StreamEvent[] = [
  { seq: 0, type: "agent/inbox/spliced", data: { target: "next-turn" }, time: 1000 },
  { seq: 1, type: "turn/start", data: { turn: 1 }, time: 1001 },
  { seq: 2, type: "agent/inbox/spliced", data: { target: "next-turn" }, time: 1002 },
  { seq: 3, type: "step/start", data: { turn: 1, step: 1 }, time: 1003 },
  { seq: 4, type: "system/message", data: { message: { role: "system", content: [{ type: "text", text: "系统提示不外泄" }] } }, time: 1004 },
  { seq: 5, type: "user/message", data: { id: "m-1", role: "user", content: [{ type: "text", text: "请仅回复 replay-zero-marker。" }], source: { kind: "user" } }, time: 1005 },
  { seq: 6, type: "request/header", data: { tools: [{ name: "secret_tool" }], config: { model: "private-model" } }, time: 1006 },
  { seq: 7, type: "request/context", data: { tokens: 42 }, time: 1007 },
  { seq: 8, type: "assistant/message", data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "reasoning", text: "推理不外泄" }, { type: "text", text: "replay-zero-marker" }] }, stream: [] }, time: 1008 },
  { seq: 9, type: "step/end", data: { turn: 1, step: 1 }, time: 1009 },
  { seq: 10, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } }, time: 1010 },
];

/** 记录写入的 sink；与 driver 的 `SseSink` 契约一致（无 I/O）。 */
function recordingSink(): SseSink & { readonly frames: string[] } {
  const frames: string[] = [];
  let closed = false;
  return {
    frames,
    get open() {
      return !closed;
    },
    write(frame: string): boolean {
      if (closed) return false;
      frames.push(frame);
      return true;
    },
    close(): void {
      closed = true;
    },
  };
}

/** Cell 侧观察到的一次事件流请求；用于断言"到底发了什么头"。 */
interface CellRequest {
  readonly path: string;
  readonly headerPresent: boolean;
  readonly lastEventId: string | undefined;
  readonly authorization: string | undefined;
}

interface ReplayCell {
  readonly url: string;
  readonly hub: EventHub;
  /** 请求记录：转为 `last-event-id` 是否被真的发出（而不是"缺头"）。 */
  readonly requests: CellRequest[];
  readonly verifier: GrantVerifier;
  /**
   * 与 `verifier` 同一把公钥、但**独立 jti store** 的验签器：cell 路由已经消费过
   * 到达的那枚凭证，测试要用它检查 claim 就必须另起一枚不共享一次性存储的实例。
   */
  readonly inspectVerifier: GrantVerifier;
  close(): Promise<void>;
}

/**
 * 起一个**真实** driver cell：真实 `EventHub` + 真实 `SessionController` 订阅鉴权 +
 * 真实 `createRouter` 路由，跑在真实 `node:http` 上。
 *
 * 这里唯一"假"的是 DSH 会话日志本身（用 `history` 数组代表已落盘的 JSONL）——
 * 它正是要被回放的**数据**，不是被验证的逻辑。
 */
async function startReplayCell(
  history: readonly StreamEvent[],
  options: { publishInProcess?: readonly number[]; verifyKey: ReturnType<typeof generateTestKeyPair> } = { verifyKey: generateTestKeyPair("kid-replay-zero") },
): Promise<ReplayCell> {
  const requests: CellRequest[] = [];
  const hub = new EventHub();
  hub.setHistoryProvider((sid) => (sid === sessionId ? history : []));
  // 本进程在提交时已经 publish 过的持久事件（真实进程里 `session/event` 通知会做这件事）：
  // 与 history 的重叠必须靠 seq 去重，不能重复补发。
  for (const seq of options.publishInProcess ?? []) {
    const event = history.find((candidate) => candidate.seq === seq);
    if (event !== undefined) hub.publishDurable(sessionId, event);
  }

  const principal = { sid: sessionId, tid: tenantId, sub: ownerUserId, wid: workId, preset, rev: 1 };
  const host: ControllerHost = {
    lookupPrincipal: () => ({ ok: true, principal }),
    lookupPrincipalBySession: () => ({ ok: true, principal }),
    revoke: () => ({ accepted: true, reason: "accepted" }),
    isRevoked: () => false,
    highWaterRev: () => 0,
  };
  const unused = (): never => {
    throw new Error("driver 测试替身：订阅路径不应触达 DSH 端口");
  };
  const ports = {
    create: unused, resume: unused, flush: unused, mountPreset: unused,
    bindPrincipal: unused, composedPreset: unused, createUserMessage: unused,
    now: () => 1_790_000_000_000,
  } as unknown as RuntimePorts;
  const verifier = createGrantVerifier({
    audience: cellId, tenantId, bootId: driverBootId, startedAt: 0, issuer: "myrix-control-plane", keys: [options.verifyKey.jwk],
  });
  const inspectVerifier = createGrantVerifier({
    audience: cellId, tenantId, bootId: driverBootId, startedAt: 0, issuer: "myrix-control-plane", keys: [options.verifyKey.jwk],
  });
  const controller = new SessionController(ports, host, verifier, driverBootId);
  const router = createRouter(controller, hub, { tenantId, bootId: driverBootId, heartbeatMs: 0 });

  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://cell.invalid").pathname;
    if (path.endsWith("/events")) {
      requests.push({
        path,
        headerPresent: req.headers["last-event-id"] !== undefined,
        lastEventId: req.headers["last-event-id"] as string | undefined,
        authorization: req.headers.authorization,
      });
    }
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
    hub,
    requests,
    verifier,
    inspectVerifier,
    close: async () => {
      router.dispose();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const cells: ReplayCell[] = [];
const runtimes: RuntimeRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispatcher.stop()));
  await Promise.all(cells.splice(0).map((cell) => cell.close()));
});

/** 一次测试共享的密钥对：BFF 用它签发，cell 用同一把公钥验签（真实 ES256 往返）。 */
function sharedKey(): ReturnType<typeof generateTestKeyPair> {
  return generateTestKeyPair("kid-replay-zero");
}

/** BFF 侧装配：真实签名、真实 driver HTTP 客户端；`currentFacts` 是文档化注入缝。 */
function startBff(cell: ReplayCell, key: ReturnType<typeof generateTestKeyPair>): RuntimeRuntime {
  const signer = createGrantSigner({ privateKey: key.privateKeyPem, kid: key.kid, issuer: "myrix-control-plane" });
  // 只有 `hasService` 会被运行时装配读取；`events()` 走注入的 currentFacts，不碰数据库。
  const store = new PlatformStore({ db: {} as Kysely<PlatformDatabase>, serviceCapabilities: RUNTIME_SERVICE_CAPABILITIES });
  const facts: DeliveryFacts = {
    binding: {
      tenantId, id: sessionId, ownerUserId, workId, preset,
      status: "active", revokedRevision: 1, cellId,
    },
    member: { status: "active", role: "member" },
    work: { ownerUserId, status: "active" },
    tenantStatus: "active",
  };
  const runtime = createRuntimeRouter({
    store,
    signer,
    directory: createStaticCellDirectory([{ tenantId, cellId, baseUrl: cell.url, serviceToken: "service-token-replay-zero" }]),
    driver: createDriverHttpClient({ deadlineMs: 2_000 }),
    workerId: "replay-zero-worker",
    revalidateMs: 60_000,
    validators: { currentFacts: async () => facts },
    // 本用例只验证 cursor/回放的 driver 语义，**不测会话恢复**，且用的是 inert 的 Kysely
    // db（`:memory:` 形状的空对象）。恢复默认开启会去读 `commands` 表，读取失败在
    // fail-closed 语义下会阻止订阅 —— 那不是本用例要断言的行为。这里显式关闭恢复，
    // 让所有原有断言（真实订阅、`Last-Event-ID` 转发、白名单投影）逐字不变。
    recovery: { enabled: false },
  });
  runtimes.push(runtime);
  return runtime;
}

/** 读到 `turn-end` 就断开（与真实验收脚本一致：事件流不会自己结束）。 */
async function drainUntilTurnEnd(stream: AsyncIterable<SessionStreamEvent>, controller: AbortController): Promise<SessionStreamEvent[]> {
  const seen: SessionStreamEvent[] = [];
  try {
    for await (const event of stream) {
      seen.push(event);
      // 真实验收脚本同样在 `turn-end` 处断开：事件流不会自己结束。
      if (event.type === "turn-end") break;
    }
  } finally {
    controller.abort();
  }
  return seen;
}

describe("initial session replay from cursor 0", () => {
  it("keeps driver semantics frozen: undefined is live-only, only explicit 0 replays history", () => {
    const hub = new EventHub();
    hub.setHistoryProvider((sid) => (sid === sessionId ? committedTurn : []));

    // 未声明水位（真实的 Last-Event-ID 缺失）→ 只发一条当前水位标记，**不补发**历史。
    // 这条断言把 driver 的既有语义钉死：修 BFF 时绝不能去改这里的行为。
    const liveOnly = recordingSink();
    hub.subscribe(sessionId, undefined, liveOnly, () => true);
    const liveOnlyText = liveOnly.frames.join("");
    expect(liveOnlyText).toContain("myrix/subscribed");
    expect(liveOnlyText).not.toContain("id: 5");

    // 显式 0 → 补发 seq > 0 的全部持久事件（含 seq 5 的 user/message）。
    const fromZero = recordingSink();
    hub.subscribe(sessionId, 0, fromZero, () => true);
    const fromZeroText = fromZero.frames.join("");
    expect(fromZeroText).toContain("id: 5");
    expect(fromZeroText).toContain("id: 8");
    expect(fromZeroText).toContain("id: 10");
    expect(fromZeroText).not.toContain("myrix/subscribed");
    // seq 0 是边界标记，不属于 `seq > 0`。
    expect(fromZeroText).not.toContain("id: 0\n");
  });

  it("replays the already-committed user/assistant/turn-end on a first subscribe at cursor 0, with monotonic unique seq", async () => {
    const key = sharedKey();
    // 真实形态：进程内 publish 过 5/8/10，会话日志里也有 0..10 —— 合并后必须按 seq 去重。
    const cell = await startReplayCell(committedTurn, { publishInProcess: [5, 8, 10], verifyKey: key });
    cells.push(cell);
    const runtime = startBff(cell, key);
    const controller = new AbortController();

    const stream = await runtime.events(owner, sessionId, 0, controller.signal);
    const seen = await drainUntilTurnEnd(stream, controller);

    // 修好之后：首 user durable 事件必须在（这正是 Lead 验收里 tenant2 丢失的那条）。
    expect(seen).toEqual([
      { type: "user", seq: 5, text: "请仅回复 replay-zero-marker。" },
      { type: "assistant", seq: 8, text: "replay-zero-marker" },
      { type: "turn-end", seq: 10 },
    ]);
    const seqs = seen.flatMap((event) => (typeof event.seq === "number" ? [event.seq] : []));
    expect(seqs).toEqual([5, 8, 10]);
    // 严格单调递增 + 不重复：重放期间不能把同一条事件发两遍。
    expect(seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]!)).toBe(true);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seen.filter((event) => event.type === "user")).toHaveLength(1);
    // 白名单之外的 prompt/schema/推理一律不过界。
    expect(JSON.stringify(seen)).not.toMatch(/系统提示|secret_tool|private-model|推理/);

    // 关键断言：BFF 真的发出了 `Last-Event-ID: 0`（缺头 = live-only，就会丢上面整段历史）。
    const first = cell.requests.at(-1)!;
    expect(first.headerPresent).toBe(true);
    expect(first.lastEventId).toBe("0");
    expect(first.path).toBe(`/v1/sessions/${sessionId}/events`);
    // 到达 cell 的确实是一枚被真实验签器接受的 subscribe 凭证（否则路由会 403，不会有帧）。
    expect(first.authorization).toMatch(/^Bearer /);
    const claims = cell.inspectVerifier.verifyAndConsume(first.authorization!.slice("Bearer ".length), {
      op: "subscribe", cmd: `subscribe-${sessionId}`, bh: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
    expect(claims).toMatchObject({ op: "subscribe", sid: sessionId, tid: tenantId, sub: ownerUserId, wid: workId, preset, rev: 1 });
  });

  it("resumes from a non-zero cursor without replaying old events", async () => {
    const key = sharedKey();
    const cell = await startReplayCell(committedTurn, { verifyKey: key });
    cells.push(cell);
    const runtime = startBff(cell, key);
    const controller = new AbortController();

    // 水位 5 = 已经见过 seq 5：只允许 8/10，绝不能再发一遍 seq 5。
    const stream = await runtime.events(owner, sessionId, 5, controller.signal);
    const seen = await drainUntilTurnEnd(stream, controller);
    expect(seen).toEqual([
      { type: "assistant", seq: 8, text: "replay-zero-marker" },
      { type: "turn-end", seq: 10 },
    ]);
    expect(seen.some((event) => event.seq === 5)).toBe(false);

    const call = cell.requests.at(-1)!;
    expect(call.headerPresent).toBe(true);
    expect(call.lastEventId).toBe("5");
  });

  it("still rejects an invalid cursor with 400 before touching the cell", async () => {
    const key = sharedKey();
    const cell = await startReplayCell(committedTurn, { verifyKey: key });
    cells.push(cell);
    const runtime = startBff(cell, key);
    const controller = new AbortController();
    const before = cell.requests.length;

    for (const bad of [-1, -0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(runtime.events(owner, sessionId, bad, controller.signal)).rejects.toMatchObject({
        statusCode: 400, code: "invalid_cursor",
      });
    }
    // 非法游标是 BFF 边界拒绝：一个字节都不该发到 cell（绝不静默降级成 0 或 live-only）。
    expect(cell.requests.length).toBe(before);
  });

  it("does not weaken cell authentication: a bad or missing subscription grant is refused", async () => {
    const cell = await startReplayCell(committedTurn, { verifyKey: sharedKey() });
    cells.push(cell);
    const url = `${cell.url}/v1/sessions/${sessionId}/events`;

    const missing = await fetch(url, { headers: { "last-event-id": "0" } });
    expect(missing.status).toBe(401);
    const rejected = await fetch(url, { headers: { authorization: "Bearer not-a-grant", "last-event-id": "0" } });
    expect(rejected.status).toBe(403);
    // 真实 cell 在无有效凭证时既不补发历史、也不建立订阅。
    expect((await missing.text()) + (await rejected.text())).not.toContain("replay-zero-marker");
  });
});
