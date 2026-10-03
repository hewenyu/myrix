import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AuthRepository, AuthSession, LoginFlow } from "../src/auth";
import type { NovelRepository, RuntimeRouter } from "../src/ports";
import { ApiFailure } from "../src/ports";
import { createBffServer } from "../src/server";

const origin = "http://127.0.0.1:8787";
const workId = "00000000-0000-4000-8000-000000000001";
const sessionId = "00000000-0000-4000-8000-000000000002";
const identity = { tenantId: "tenant", userId: "author", displayName: "Author", role: "member" as const };
const marker = "SENSITIVE-MARKER-must-not-leak";
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

/**
 * Protocol doubles only. Body parsing itself is Fastify's real implementation: the
 * tests never stub the content-type parser, they drive it through `app.inject`.
 */
async function setup(overrides: Partial<Record<string, unknown>> = {}) {
  const sessions = new Map<string, AuthSession>();
  const auth: AuthRepository = {
    async createSession(k, v) { sessions.set(k, v); }, async findSession(k) { return sessions.get(k); },
    async deleteSession(k) { sessions.delete(k); }, async identity() { return identity; },
    async createFlow(_k: string, _v: LoginFlow) {}, async consumeFlow() { return undefined; }, async resolveSubject() { return undefined; },
  };
  const methods = {
    listWorks: vi.fn(async () => []),
    createWork: vi.fn(async () => ({ id: workId })),
    ...overrides,
  };
  const repository = new Proxy(methods, { get(target, key) { return Reflect.get(target, key) ?? (() => { throw new Error("Unconfigured protocol double"); }); } }) as unknown as NovelRepository;
  const runtime: RuntimeRouter = {
    createSession: vi.fn(async () => { throw new Error("Not configured for this test"); }),
    send: vi.fn(async (_actor, _id, input) => ({ commandId: input.commandId, status: "queued" as const })),
    cancel: vi.fn(async (_actor, _id, commandId) => ({ commandId, status: "queued" as const })),
    revoke: vi.fn(async () => {}),
    archive: vi.fn(async () => { throw new Error("Not configured for this test"); }),
    events: vi.fn(async function* () {}) as unknown as RuntimeRouter["events"],
  };
  const app = await createBffServer({ auth: { mode: "development", origin, sessionTtlSeconds: 3600, repository: auth,
    developmentUsers: { author: identity } }, repository, runtime });
  apps.push(app);
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/dev-login", headers: { origin }, payload: { user: "author" } });
  expect(login.statusCode).toBe(200);
  return { app, methods, runtime, cookies: { myrix_session: login.cookies[0]!.value }, headers: { origin, "x-csrf-token": login.json<{ csrfToken: string }>().csrfToken } };
}

describe("BFF HTTP body parsing failures", () => {
  it("classifies an empty JSON body as 400 instead of 503 without touching the runtime", async () => {
    const { app, runtime, cookies, headers } = await setup();
    const res = await app.inject({ method: "DELETE", url: `/api/v1/sessions/${sessionId}`, cookies,
      headers: { ...headers, "content-type": "application/json" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_input", reason: "请求正文为空，但 Content-Type 声明了 JSON" });
    expect(res.body).not.toContain(marker);
    expect(runtime.revoke).not.toHaveBeenCalled();
  });

  it("classifies malformed JSON as 400 and never calls the repository or echoes the input", async () => {
    const { app, methods, cookies, headers } = await setup();
    const res = await app.inject({ method: "POST", url: "/api/v1/works", cookies,
      headers: { ...headers, "content-type": "application/json" }, payload: `{"title":"${marker}"` });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_input", reason: "请求正文不是合法的 JSON" });
    expect(res.body).not.toContain(marker);
    expect(methods.createWork).not.toHaveBeenCalled();
  });

  it("classifies an over-limit body as 413 without calling the repository", async () => {
    const { app, methods, cookies, headers } = await setup();
    const res = await app.inject({ method: "POST", url: "/api/v1/works", cookies,
      headers: { ...headers, "content-type": "application/json" }, payload: `{"title":"${"x".repeat(2_100_000)}"}` });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: "payload_too_large", reason: "请求正文超过大小上限" });
    expect(res.body).not.toContain(marker);
    expect(methods.createWork).not.toHaveBeenCalled();
  });

  it("classifies an unsupported media type as 415 without calling the repository", async () => {
    const { app, methods, cookies, headers } = await setup();
    const res = await app.inject({ method: "POST", url: "/api/v1/works", cookies,
      headers: { ...headers, "content-type": "application/xml" }, payload: `<title>${marker}</title>` });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toEqual({ error: "unsupported_media_type", reason: "不支持的 Content-Type" });
    expect(res.body).not.toContain(marker);
    expect(methods.createWork).not.toHaveBeenCalled();
  });

  it("keeps an unknown repository error at 503 even when it forges a client status and Fastify error code", async () => {
    const forged = Object.assign(new Error(`SQL password=${marker}`), { statusCode: 400, code: "FST_ERR_CTP_EMPTY_JSON_BODY" });
    const { app, cookies } = await setup({ listWorks: vi.fn(async () => { throw forged; }) });
    const res = await app.inject({ url: "/api/v1/works", cookies });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "service_unavailable", reason: "服务暂不可用；操作结果未知时，请先重新读取状态，不要盲目重试" });
    expect(res.body).not.toContain(marker);
  });

  it("keeps an ApiFailure classification readable", async () => {
    const { app, cookies } = await setup({ listWorks: vi.fn(async () => { throw new ApiFailure(403, "forbidden", "非资源所有者"); }) });
    const res = await app.inject({ url: "/api/v1/works", cookies });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "forbidden", reason: "非资源所有者" });
  });

  it("still accepts standard bodyless mutations", async () => {
    const { app, runtime, cookies, headers } = await setup();
    const revoked = await app.inject({ method: "DELETE", url: `/api/v1/sessions/${sessionId}`, cookies, headers });
    expect(revoked.statusCode).toBe(204);
    expect(runtime.revoke).toHaveBeenCalledWith(identity, sessionId);
    const logout = await app.inject({ method: "POST", url: "/api/v1/auth/logout", cookies, headers });
    expect(logout.statusCode).toBe(204);
  });

  it("keeps schema rejections at 400 and rate limiting at 429", async () => {
    const { app, methods, cookies, headers } = await setup();
    const rejected = await app.inject({ method: "POST", url: "/api/v1/works", cookies, headers,
      payload: { title: "小说", description: "", actor: { userId: "victim" } } });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toEqual({ error: "invalid_input", reason: "参数格式不正确或包含不允许的字段" });
    expect(methods.createWork).not.toHaveBeenCalled();

    let limited: Awaited<ReturnType<FastifyInstance["inject"]>> | undefined;
    for (let i = 0; i < 121 && limited?.statusCode !== 429; i++) limited = await app.inject({ url: "/healthz" });
    expect(limited?.statusCode).toBe(429);
    expect(limited?.json()).toEqual({ error: "rate_limited", reason: "请求过于频繁，请稍后重试" });
  });
});
