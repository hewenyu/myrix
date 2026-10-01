import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import cookie from "@fastify/cookie";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PlatformIdentity } from "@myrix/contracts";

export interface AuthActor { tenantId: string; userId: string }
export interface LoginFlow { state: string; nonce: string; verifier: string; expiresAt: Date }
export interface AuthSession { actor: AuthActor; csrfToken: string; expiresAt: Date }

/** Credential storage. Tokens are stored only as SHA-256 digests, never in audit logs. */
export interface AuthRepository {
  createSession(hash: string, session: AuthSession): Promise<void>;
  findSession(hash: string): Promise<AuthSession | undefined>;
  deleteSession(hash: string): Promise<void>;
  createFlow(hash: string, flow: LoginFlow): Promise<void>;
  consumeFlow(hash: string): Promise<LoginFlow | undefined>;
  resolveSubject(issuer: string, subject: string): Promise<AuthActor | undefined>;
  /** Reads current tenant/member status every time. Disabled/missing members return undefined. */
  identity(actor: AuthActor): Promise<PlatformIdentity | undefined>;
}

export interface OidcAdapter {
  begin(): Promise<{ flow: Omit<LoginFlow, "expiresAt">; url: string }>;
  complete(url: URL, flow: LoginFlow): Promise<{ issuer: string; subject: string }>;
}

export interface AuthConfig {
  mode: "development" | "oidc";
  origin: string;
  sessionTtlSeconds: number;
  repository: AuthRepository;
  oidc?: OidcAdapter;
  developmentUsers?: Readonly<Record<string, AuthActor>>;
  now?: () => Date;
}

declare module "fastify" {
  interface FastifyRequest {
    identity: PlatformIdentity | null;
    authSession: AuthSession | null;
  }
}

const SESSION_COOKIE = "myrix_session";
const FLOW_COOKIE = "myrix_login";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");
const randomToken = (): string => randomBytes(32).toString("base64url");
const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Installs same-origin authentication; identity fields in JSON and attribution headers are ignored. */
export async function registerAuth(app: FastifyInstance, config: AuthConfig): Promise<void> {
  const origin = new URL(config.origin);
  if (origin.origin !== config.origin || origin.username || origin.password) throw new Error("MYRIX_ORIGIN must be an exact origin");
  if (!Number.isSafeInteger(config.sessionTtlSeconds) || config.sessionTtlSeconds < 60 || config.sessionTtlSeconds > 86400) {
    throw new Error("Session TTL must be between 60 and 86400 seconds");
  }
  if (config.mode === "development" && !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)) {
    throw new Error("Development authentication is restricted to loopback");
  }
  if (config.mode === "oidc" && (origin.protocol !== "https:" || !config.oidc)) {
    throw new Error("OIDC mode requires HTTPS and a configured OIDC adapter");
  }
  const now = config.now ?? (() => new Date());
  const cookieOptions = { httpOnly: true, secure: origin.protocol === "https:", sameSite: "lax" as const, path: "/" };
  await app.register(cookie);
  app.decorateRequest("identity", null);
  app.decorateRequest("authSession", null);

  const publicPaths = new Set([
    "/api/v1/auth/config", "/api/v1/auth/login", "/api/v1/auth/callback", "/api/v1/auth/dev-login",
  ]);
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    if (!path.startsWith("/api/")) return;
    reply.header("cache-control", "no-store");
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    // Login mutations also require Origin, preventing login CSRF in development mode.
    if (mutating && request.headers.origin !== config.origin) {
      return reply.code(403).send({ error: "origin_rejected", reason: "请求来源与应用来源不一致" });
    }
    if (publicPaths.has(path)) return;
    const token = request.cookies[SESSION_COOKIE];
    const session = token && TOKEN_PATTERN.test(token) ? await config.repository.findSession(tokenHash(token)) : undefined;
    if (!session || session.expiresAt.getTime() <= now().getTime()) {
      return reply.code(401).send({ error: "unauthenticated", reason: "请登录，或重新登录已过期的会话" });
    }
    const identity = await config.repository.identity(session.actor);
    if (!identity) return reply.code(401).send({ error: "membership_inactive", reason: "当前成员或租户已停用" });
    request.identity = identity;
    request.authSession = session;
    const csrf = request.headers["x-csrf-token"];
    if (mutating && (typeof csrf !== "string" || !safeEqual(csrf, session.csrfToken))) {
      return reply.code(403).send({ error: "csrf_rejected", reason: "缺少有效的 CSRF 凭证" });
    }
  });

  async function establish(actor: AuthActor) {
    const identity = await config.repository.identity(actor);
    if (!identity) return undefined;
    const token = randomToken();
    const session: AuthSession = { actor, csrfToken: randomToken(), expiresAt: new Date(now().getTime() + config.sessionTtlSeconds * 1000) };
    await config.repository.createSession(tokenHash(token), session);
    return { token, session, identity };
  }
  app.get("/api/v1/auth/config", async () => ({ mode: config.mode, loginUrl: "/api/v1/auth/login" }));
  app.get("/api/v1/auth/session", async (request) => ({
    identity: request.identity, csrfToken: request.authSession?.csrfToken, mode: config.mode,
  }));
  app.post<{ Body: { user: string } }>("/api/v1/auth/dev-login", {
    schema: { body: { type: "object", required: ["user"], additionalProperties: false, properties: { user: { type: "string", maxLength: 64 } } } },
  }, async (request, reply) => {
    if (config.mode !== "development") return reply.code(404).send({ error: "not_found", reason: "开发登录未启用" });
    const actor = Object.hasOwn(config.developmentUsers ?? {}, request.body.user) ? config.developmentUsers?.[request.body.user] : undefined;
    const result = actor && await establish(actor);
    if (!result) return reply.code(403).send({ error: "login_denied", reason: "未配置此开发用户，或成员已停用" });
    const oldToken = request.cookies[SESSION_COOKIE];
    if (oldToken && TOKEN_PATTERN.test(oldToken)) await config.repository.deleteSession(tokenHash(oldToken));
    reply.setCookie(SESSION_COOKIE, result.token, { ...cookieOptions, maxAge: config.sessionTtlSeconds });
    return { identity: result.identity, csrfToken: result.session.csrfToken, mode: config.mode };
  });
  app.post("/api/v1/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await config.repository.deleteSession(tokenHash(token));
    reply.clearCookie(SESSION_COOKIE, cookieOptions);
    return reply.code(204).send();
  });
  app.get("/api/v1/auth/login", async (_request, reply) => {
    if (config.mode !== "oidc" || !config.oidc) return reply.code(400).send({ error: "development_mode", reason: "请使用页面上的开发用户登录" });
    const started = await config.oidc.begin();
    const token = randomToken();
    await config.repository.createFlow(tokenHash(token), { ...started.flow, expiresAt: new Date(now().getTime() + 300_000) });
    reply.setCookie(FLOW_COOKIE, token, { ...cookieOptions, maxAge: 300 });
    return reply.redirect(started.url);
  });
  app.get("/api/v1/auth/callback", async (request, reply) => {
    reply.clearCookie(FLOW_COOKIE, cookieOptions);
    if (config.mode !== "oidc" || !config.oidc) return reply.code(404).send({ error: "not_found", reason: "OIDC 未启用" });
    const token = request.cookies[FLOW_COOKIE];
    const flow = token && TOKEN_PATTERN.test(token) ? await config.repository.consumeFlow(tokenHash(token)) : undefined;
    if (!flow || flow.expiresAt.getTime() <= now().getTime()) return reply.code(401).send({ error: "login_expired", reason: "登录状态已过期或已使用，请重新登录" });
    try {
      const subject = await config.oidc.complete(new URL(request.url, config.origin), flow);
      const actor = await config.repository.resolveSubject(subject.issuer, subject.subject);
      const result = actor && await establish(actor);
      if (!result) return reply.code(403).send({ error: "not_provisioned", reason: "此账号未被管理员加入有效租户" });
      const previous = request.cookies[SESSION_COOKIE];
      if (previous && TOKEN_PATTERN.test(previous)) await config.repository.deleteSession(tokenHash(previous));
      reply.setCookie(SESSION_COOKIE, result.token, { ...cookieOptions, maxAge: config.sessionTtlSeconds });
      return reply.redirect("/");
    } catch {
      // Never expose IdP responses, authorization codes or tokens in browser errors/logs.
      return reply.code(401).send({ error: "oidc_failed", reason: "身份提供方验证失败，请重新登录" });
    }
  });
}

export function requireIdentity(request: FastifyRequest): PlatformIdentity {
  if (!request.identity) throw new Error("Authentication hook did not establish identity");
  return request.identity;
}
