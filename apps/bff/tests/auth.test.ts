import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { registerAuth, tokenHash, type AuthRepository, type AuthSession, type LoginFlow } from "../src/auth";

function fixture() {
  const sessions = new Map<string, AuthSession>();
  const flows = new Map<string, LoginFlow>();
  let active = true;
  const repo: AuthRepository = {
    async createSession(hash, value) { sessions.set(hash, value); },
    async findSession(hash) { return sessions.get(hash); },
    async deleteSession(hash) { sessions.delete(hash); },
    async createFlow(hash, value) { flows.set(hash, value); },
    async consumeFlow(hash) { const value = flows.get(hash); flows.delete(hash); return value; },
    async resolveSubject() { return undefined; },
    async identity(actor) { return active ? { ...actor, displayName: "测试作者", role: "member" } : undefined; },
  };
  return { repo, sessions, disable: () => { active = false; } };
}

async function setup() {
  const f = fixture();
  const app = Fastify();
  await registerAuth(app, {
    mode: "development", origin: "http://127.0.0.1:8787", sessionTtlSeconds: 3600,
    repository: f.repo, developmentUsers: { author: { tenantId: "t1", userId: "u1" } },
  });
  app.post("/api/v1/protected", async (req) => ({ identity: req.identity }));
  await app.ready();
  return { ...f, app };
}
const origin = "http://127.0.0.1:8787";

describe("BFF authentication boundary", () => {
  it("rejects absent cookie even with actor attribution headers", async () => {
    const { app } = await setup();
    try {
      const res = await app.inject({ url: "/api/v1/auth/session", headers: { "x-myrix-tenant": "t1", "x-myrix-principal": "u1" } });
      expect(res.statusCode).toBe(401);
    } finally { await app.close(); }
  });
  it("requires same-origin login and rejects unconfigured/arbitrary identities", async () => {
    const { app } = await setup();
    try {
      for (const headers of [{}, { origin: "https://evil.example" }]) {
        const res = await app.inject({ method: "POST", url: "/api/v1/auth/dev-login", headers, payload: { user: "author" } });
        expect(res.statusCode).toBe(403);
      }
      const res = await app.inject({ method: "POST", url: "/api/v1/auth/dev-login", headers: { origin }, payload: { user: "__proto__" } });
      expect(res.statusCode).toBe(403);
    } finally { await app.close(); }
  });
  it("stores only hashed tokens, checks CSRF and fresh membership, invalidates logout", async () => {
    const { app, sessions, disable } = await setup();
    try {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/dev-login", headers: { origin }, payload: { user: "author" } });
      expect(login.statusCode).toBe(200);
      const cookie = login.cookies[0]!;
      expect(cookie.name).toBe("myrix_session");
      expect(cookie.httpOnly).toBe(true);
      expect(cookie.sameSite).toBe("Lax");
      expect(sessions.has(cookie.value)).toBe(false);
      expect(sessions.has(tokenHash(cookie.value))).toBe(true);
      const cookies = { myrix_session: cookie.value };
      const csrf = login.json<{ csrfToken: string }>().csrfToken;
      expect((await app.inject({ method: "POST", url: "/api/v1/protected", cookies, headers: { origin } })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/api/v1/protected", cookies, headers: { origin, "x-csrf-token": csrf }, payload: { userId: "victim" } })).json()).toMatchObject({ identity: { userId: "u1" } });
      const logout = await app.inject({ method: "POST", url: "/api/v1/auth/logout", cookies, headers: { origin, "x-csrf-token": csrf } });
      expect(logout.statusCode).toBe(204);
      expect((await app.inject({ url: "/api/v1/auth/session", cookies })).statusCode).toBe(401);
      const again = await app.inject({ method: "POST", url: "/api/v1/auth/dev-login", headers: { origin }, payload: { user: "author" } });
      disable();
      expect((await app.inject({ url: "/api/v1/auth/session", cookies: { myrix_session: again.cookies[0]!.value } })).statusCode).toBe(401);
    } finally { await app.close(); }
  });
  it("fails startup for public development authentication and HTTP OIDC", async () => {
    const { repo } = fixture();
    const app = Fastify();
    try {
      await expect(registerAuth(app, { mode: "development", origin: "http://0.0.0.0:8787", repository: repo, sessionTtlSeconds: 3600 })).rejects.toThrow("loopback");
      await expect(registerAuth(app, { mode: "oidc", origin: "http://localhost:8787", repository: repo, sessionTtlSeconds: 3600 })).rejects.toThrow("HTTPS");
    } finally { await app.close(); }
  });
});
