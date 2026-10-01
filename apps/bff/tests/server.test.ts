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
});
