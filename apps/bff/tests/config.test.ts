import { describe, expect, it } from "vitest";
import { readEnvironment } from "../src/config";
const actor = { tenantId: "11111111-1111-4111-8111-111111111111", userId: "a0000000-0000-4000-8000-000000000002" };
const env = { MYRIX_AUTH_MODE: "development", MYRIX_ORIGIN: "http://127.0.0.1:8787", DATABASE_URL: "postgres://myrix_app:local@127.0.0.1/myrix", MYRIX_AUTH_DATABASE_URL: "postgres://bff_auth:local@127.0.0.1/myrix", MYRIX_DEV_USERS: JSON.stringify({ author: actor }) };
describe("BFF fail-closed startup configuration", () => {
  it("requires explicit authentication mode, database logins and seeded actors", () => {
    const parsed = readEnvironment(env);
    expect(parsed).toMatchObject({ host: "127.0.0.1", port: 8787, developmentUsers: { author: actor } });
    for (const key of ["MYRIX_AUTH_MODE", "MYRIX_ORIGIN", "DATABASE_URL", "MYRIX_AUTH_DATABASE_URL", "MYRIX_DEV_USERS"]) {
      expect(() => readEnvironment({ ...env, [key]: undefined })).toThrow();
    }
    expect(() => readEnvironment({ ...env, MYRIX_DEV_USERS: "{}" })).toThrow();
    expect(() => readEnvironment({ ...env, MYRIX_DEV_USERS: JSON.stringify({ author: { ...actor, role: "admin" } }) })).toThrow();
  });
  it("cannot expose development login by changing only bind address or origin", () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.1", "example.com"]) expect(() => readEnvironment({ ...env, MYRIX_BIND_HOST: host })).toThrow("loopback");
    for (const origin of ["https://example.com", "http://127.0.0.1:8787/", "http://user:pass@127.0.0.1:8787", "file:///tmp"]) expect(() => readEnvironment({ ...env, MYRIX_ORIGIN: origin })).toThrow();
    expect(() => readEnvironment({ ...env, DATABASE_URL: "https://user:secret@example.com" })).toThrow("PostgreSQL");
    expect(() => readEnvironment({ ...env, MYRIX_PORT: "0" })).toThrow();
    expect(() => readEnvironment({ ...env, MYRIX_PORT: "65536" })).toThrow();
    expect(() => readEnvironment({ ...env, MYRIX_SESSION_TTL_SECONDS: "-1" })).toThrow();
  });
  it("requires HTTPS production OIDC and refuses development identity leakage", () => {
    const production = { ...env, MYRIX_AUTH_MODE: "oidc", MYRIX_ORIGIN: "https://novel.example", MYRIX_DEV_USERS: undefined, MYRIX_OIDC_ISSUER: "https://idp.example/realms/myrix", MYRIX_OIDC_CLIENT_ID: "myrix", MYRIX_OIDC_CLIENT_SECRET: "private" };
    expect(readEnvironment(production)).toMatchObject({ mode: "oidc", host: "0.0.0.0", oidc: { issuer: production.MYRIX_OIDC_ISSUER } });
    expect(() => readEnvironment({ ...production, MYRIX_DEV_USERS: env.MYRIX_DEV_USERS })).toThrow("must not");
    expect(() => readEnvironment({ ...production, MYRIX_ORIGIN: "http://novel.example" })).toThrow("HTTPS");
    expect(() => readEnvironment({ ...production, MYRIX_OIDC_CLIENT_SECRET: undefined })).toThrow("required");
    expect(() => readEnvironment({ ...production, MYRIX_OIDC_ISSUER: "http://idp.example" })).toThrow("HTTPS");
  });
});
