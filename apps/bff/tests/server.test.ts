import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AuthRepository, AuthSession, LoginFlow } from "../src/auth";
import type { NovelRepository, RuntimeRouter } from "../src/ports";
import { ApiFailure } from "../src/ports";
import { createBffServer } from "../src/server";

const origin = "http://127.0.0.1:8787";
const workId = "00000000-0000-4000-8000-000000000001";
const sessionId = "00000000-0000-4000-8000-000000000002";
const commandId = "00000000-0000-4000-8000-000000000003";
const identity = { tenantId: "tenant", userId: "author", displayName: "Author", role: "member" as const };
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

async function setup() {
  const sessions = new Map<string, AuthSession>();
  const auth: AuthRepository = {
    async createSession(k, v) { sessions.set(k, v); }, async findSession(k) { return sessions.get(k); },
    async deleteSession(k) { sessions.delete(k); }, async identity() { return identity; },
    async createFlow(_k: string, _v: LoginFlow) {}, async consumeFlow() { return undefined; }, async resolveSubject() { return undefined; },
  };
  // Protocol doubles only. Ownership/CAS correctness is separately tested against real Postgres.
  const methods = {
    listWorks: vi.fn(async () => []),
    createWork: vi.fn(async () => ({ id: workId })),
    saveOutline: vi.fn(async () => ({ status: "conflict", version: 4 })),
    getWork: vi.fn(async () => { throw new ApiFailure(403, "forbidden", "非资源所有者"); }),
    listBible: vi.fn(async () => { throw new Error("SQL password=must-not-leak"); }),
  };
  const repository = new Proxy(methods, { get(target, key) { return Reflect.get(target, key) ?? (() => { throw new Error("Unconfigured protocol double"); }); } }) as unknown as NovelRepository;
  const runtime: RuntimeRouter = {
    createSession: vi.fn(async () => { throw new Error("Not configured for this test"); }),
    send: vi.fn(async (_actor, _id, input) => ({ commandId: input.commandId, status: "queued" as const })),
    cancel: vi.fn(async (_actor, _id, commandId) => ({ commandId, status: "queued" as const })),
    revoke: vi.fn(async () => {}),
    archive: vi.fn(async () => { throw new Error("Not configured for this test"); }),
    events: vi.fn(async function* () {
      yield { type: "delta", text: "瞬态", seq: 99 } as const;
      yield { type: "assistant", text: "持久正文", seq: 7 } as const;
      yield { type: "turn-end", seq: 8 } as const;
    }) as unknown as RuntimeRouter["events"],
  };
  const app = await createBffServer({ auth: { mode: "development", origin, sessionTtlSeconds: 3600, repository: auth,
    developmentUsers: { author: identity } }, repository, runtime });
  apps.push(app);
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/dev-login", headers: { origin }, payload: { user: "author" } });
  expect(login.statusCode).toBe(200);
  return { app, methods, runtime, cookies: { myrix_session: login.cookies[0]!.value }, headers: { origin, "x-csrf-token": login.json<{ csrfToken: string }>().csrfToken } };
}

describe("BFF JSON and SSE protocol", () => {
  it("does not accept browser-supplied actors and binds operations to server identity", async () => {
    const { app, cookies, headers, methods } = await setup();
    const bad = await app.inject({ method: "POST", url: "/api/v1/works", cookies, headers,
      payload: { title: "小说", description: "", actor: { userId: "victim" } } });
    expect(bad.statusCode).toBe(400);
    expect(methods.createWork).not.toHaveBeenCalled();
    const ok = await app.inject({ method: "POST", url: "/api/v1/works", cookies, headers, payload: { title: "小说", description: "" } });
    expect(ok.statusCode).toBe(201);
    expect(methods.createWork).toHaveBeenCalledWith(identity, { title: "小说", description: "" });
  });
  it("preserves a CAS conflict as 409 without claiming it saved", async () => {
    const { app, cookies, headers } = await setup();
    const res = await app.inject({ method: "PUT", url: `/api/v1/works/${workId}/outline`, cookies, headers,
      payload: { text: "我的未保存内容", expectedVersion: 2 } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ status: "conflict", version: 4 });
  });
  it("returns queued, not completed, and validates command ids", async () => {
    const { app, cookies, headers, runtime } = await setup();
    const res = await app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/messages`, cookies, headers, payload: { commandId, text: "写一段" } });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ commandId, status: "queued" });
    expect(runtime.send).toHaveBeenCalledWith(identity, sessionId, { commandId, text: "写一段" });
    expect((await app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/messages`, cookies, headers,
      payload: { commandId: "not-a-uuid", text: "x" } })).statusCode).toBe(400);
  });
  it("returns readable authorization failures but hides unexpected storage details", async () => {
    const { app, cookies } = await setup();
    const denied = await app.inject({ url: `/api/v1/works/${workId}`, cookies });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: "forbidden", reason: "非资源所有者" });
    const unavailable = await app.inject({ url: `/api/v1/works/${workId}/bible`, cookies });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.body).not.toContain("must-not-leak");
  });
  it("only exposes durable SSE ids and accepts an authenticated replay cursor", async () => {
    const { app, cookies, runtime } = await setup();
    const res = await app.inject({ url: `/api/v1/sessions/${sessionId}/events`, cookies, headers: { "last-event-id": "6" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).not.toContain("id: 99");
    expect(res.body).toContain("id: 7\nevent: message");
    expect(res.body).toContain("id: 8\nevent: message");
    expect(runtime.events).toHaveBeenCalledWith(identity, sessionId, 6, expect.any(AbortSignal));
    expect((await app.inject({ url: `/api/v1/sessions/${sessionId}/events`, cookies, headers: { "last-event-id": "NaN" } })).statusCode).toBe(400);
  });

  it("归档接口：显式布尔值、CSRF 必需、未知字段与缺字段都拒绝", async () => {
    const { app, cookies, headers, runtime } = await setup();
    const archivedSession = { id: sessionId, workId, preset: "novel-assistant" as const, status: "active" as const, createdAt: "2026-09-30T00:00:00.000Z", archivedAt: "2026-09-30T01:00:00.000Z" };
    vi.mocked(runtime.archive).mockResolvedValueOnce(archivedSession);

    const ok = await app.inject({ method: "PATCH", url: `/api/v1/sessions/${sessionId}`, cookies, headers, payload: { archived: true } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual(archivedSession);
    expect(runtime.archive).toHaveBeenCalledWith(identity, sessionId, true);

    // 缺 archived / 无法解释成布尔 / 多余字段：schema 拒绝，且不触达运行时。
    // （Fastify 的 ajv 开启类型强制，因此 `1` / `"true"` 会被解释成布尔 true —— 语义无歧义；
    // 但"yes" 与缺字段一律 400。）
    vi.mocked(runtime.archive).mockClear();
    for (const payload of [{}, { archived: "yes" }, { archived: true, ownerUserId: "victim" }]) {
      const bad = await app.inject({ method: "PATCH", url: `/api/v1/sessions/${sessionId}`, cookies, headers, payload });
      expect(bad.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(runtime.archive).not.toHaveBeenCalled();

    // 可强制成布尔的标量仍是显式请求：运行时收到的**一定是**布尔值（而不是原始 JSON）。
    for (const [payload, expected] of [[{ archived: "true" }, true], [{ archived: 1 }, true], [{ archived: 0 }, false], [{ archived: false }, false]] as const) {
      vi.mocked(runtime.archive).mockClear();
      vi.mocked(runtime.archive).mockResolvedValueOnce(archivedSession);
      const coerced = await app.inject({ method: "PATCH", url: `/api/v1/sessions/${sessionId}`, cookies, headers, payload });
      expect(coerced.statusCode, JSON.stringify(payload)).toBe(200);
      expect(runtime.archive, JSON.stringify(payload)).toHaveBeenCalledWith(identity, sessionId, expected);
    }

    // 缺 CSRF：mutating 方法必须先过统一 hook。
    const noCsrf = await app.inject({ method: "PATCH", url: `/api/v1/sessions/${sessionId}`, cookies,
      headers: { origin }, payload: { archived: true } });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json()).toMatchObject({ error: "csrf_rejected" });
  });

  it("归档只拒绝新的发送（409 session_archived）；取消与订阅照常通过 HTTP 边界", async () => {
    const { app, cookies, headers, runtime } = await setup();
    vi.mocked(runtime.send).mockRejectedValueOnce(new ApiFailure(409, "session_archived", "会话已归档，恢复后才能继续发送新消息"));

    // 新的 send：可读的 409（不是 403/410），文案提示恢复。
    const send = await app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/messages`, cookies, headers, payload: { commandId, text: "写一段" } });
    expect(send.statusCode).toBe(409);
    expect(send.json()).toEqual({ error: "session_archived", reason: "会话已归档，恢复后才能继续发送新消息" });

    // cancel 必须仍然可用：归档不停止任务，作者要能停下一条已在跑的回合。
    const cancel = await app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/cancel`, cookies, headers, payload: { commandId } });
    expect(cancel.statusCode).toBe(202);
    expect(cancel.json()).toEqual({ commandId, status: "queued" });

    // 事件流同样不该被归档拦截：路由原样把请求交给运行时（这里由默认 mock 的 200 SSE 证明）。
    const events = await app.inject({ url: `/api/v1/sessions/${sessionId}/events`, cookies });
    expect(events.statusCode).toBe(200);
    expect(runtime.events).toHaveBeenCalledWith(identity, sessionId, 0, expect.any(AbortSignal));
  });

  it("创建会话时接受 novel-assistant，拒绝未知 preset", async () => {
    const { app, cookies, headers, runtime } = await setup();
    const created = { id: sessionId, workId, preset: "novel-assistant" as const, status: "creating" as const, createdAt: "2026-09-30T00:00:00.000Z", archivedAt: null };
    vi.mocked(runtime.createSession).mockResolvedValueOnce(created);

    const ok = await app.inject({ method: "POST", url: `/api/v1/works/${workId}/sessions`, cookies, headers, payload: { preset: "novel-assistant" } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toEqual(created);
    expect(runtime.createSession).toHaveBeenCalledWith(identity, workId, "novel-assistant");

    vi.mocked(runtime.createSession).mockClear();
    for (const preset of ["novel-unknown", "novel-assistant ", "NOVEL-ASSISTANT", ""]) {
      const bad = await app.inject({ method: "POST", url: `/api/v1/works/${workId}/sessions`, cookies, headers, payload: { preset } });
      expect(bad.statusCode, preset).toBe(400);
    }
    expect(runtime.createSession).not.toHaveBeenCalled();
  });
});
