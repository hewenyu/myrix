import type { AuthActor } from "./auth";

export interface BffEnvironment {
  mode: "development" | "oidc";
  origin: string;
  host: string;
  port: number;
  databaseUrl: string;
  authDatabaseUrl: string;
  sessionTtlSeconds: number;
  developmentUsers?: Readonly<Record<string, AuthActor>>;
  oidc?: { issuer: string; clientId: string; clientSecret: string };
  staticRoot?: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name];
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
};
const integer = (value: string, name: string, min: number, max: number): number => {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${name} is out of range`);
  return number;
};
function databaseUrl(env: NodeJS.ProcessEnv, name: string): string {
  const raw = required(env, name);
  let value: URL;
  try { value = new URL(raw); } catch { throw new Error(`${name} must be a PostgreSQL URL`); }
  if (!["postgres:", "postgresql:"].includes(value.protocol) || !value.hostname || !value.username || value.hash) {
    throw new Error(`${name} must be a PostgreSQL URL with an explicit login`);
  }
  return raw;
}
/** No implicit development identity, migrator URL fallback, or production HTTP authentication. */
export function readEnvironment(env: NodeJS.ProcessEnv): BffEnvironment {
  const mode = required(env, "MYRIX_AUTH_MODE");
  if (mode !== "development" && mode !== "oidc") throw new Error("MYRIX_AUTH_MODE must be development or oidc");
  const origin = required(env, "MYRIX_ORIGIN");
  let parsed: URL;
  try { parsed = new URL(origin); } catch { throw new Error("MYRIX_ORIGIN must be an exact HTTP(S) origin"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin || parsed.username || parsed.password) {
    throw new Error("MYRIX_ORIGIN must be an exact HTTP(S) origin");
  }
  const host = env.MYRIX_BIND_HOST ?? (mode === "development" ? "127.0.0.1" : "0.0.0.0");
  const output: BffEnvironment = {
    mode, origin, host,
    port: integer(env.MYRIX_PORT ?? "8787", "MYRIX_PORT", 1, 65535),
    databaseUrl: databaseUrl(env, "DATABASE_URL"),
    authDatabaseUrl: databaseUrl(env, "MYRIX_AUTH_DATABASE_URL"),
    sessionTtlSeconds: integer(env.MYRIX_SESSION_TTL_SECONDS ?? "28800", "MYRIX_SESSION_TTL_SECONDS", 60, 86400),
    ...(env.MYRIX_STATIC_ROOT ? { staticRoot: env.MYRIX_STATIC_ROOT } : {}),
  };
  if (mode === "development") {
    if (!["127.0.0.1", "::1"].includes(host) || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
      throw new Error("Development login requires a loopback origin AND bind address");
    }
    let users: unknown;
    try { users = JSON.parse(required(env, "MYRIX_DEV_USERS")); } catch { throw new Error("MYRIX_DEV_USERS must explicitly map login names to seeded actors"); }
    if (!users || typeof users !== "object" || Array.isArray(users) || Object.keys(users).length === 0) throw new Error("MYRIX_DEV_USERS cannot be empty");
    const result: Record<string, AuthActor> = Object.create(null);
    for (const [name, actor] of Object.entries(users)) {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || !actor || typeof actor !== "object" || Array.isArray(actor)
        || Object.keys(actor).some(key => key !== "tenantId" && key !== "userId")
        || typeof actor.tenantId !== "string" || !uuid.test(actor.tenantId) || typeof actor.userId !== "string" || !uuid.test(actor.userId)) {
        throw new Error("MYRIX_DEV_USERS contains an invalid login or actor");
      }
      result[name] = { tenantId: actor.tenantId, userId: actor.userId };
    }
    output.developmentUsers = Object.freeze(result);
  } else {
    if (parsed.protocol !== "https:") throw new Error("OIDC authentication requires an HTTPS origin");
    if (env.MYRIX_DEV_USERS) throw new Error("MYRIX_DEV_USERS must not be set in OIDC mode");
    const issuer = required(env, "MYRIX_OIDC_ISSUER");
    let issuerUrl: URL;
    try { issuerUrl = new URL(issuer); } catch { throw new Error("MYRIX_OIDC_ISSUER must be an HTTPS issuer URL"); }
    if (issuerUrl.protocol !== "https:" || issuerUrl.username || issuerUrl.password || issuerUrl.search || issuerUrl.hash) throw new Error("MYRIX_OIDC_ISSUER must be an HTTPS issuer URL");
    output.oidc = { issuer, clientId: required(env, "MYRIX_OIDC_CLIENT_ID"), clientSecret: required(env, "MYRIX_OIDC_CLIENT_SECRET") };
  }
  return output;
}
