import { describe, expect, it } from "vitest";
import { assertCellSecretIsolation, operatingEnvironment, serviceEnvironment } from "../scripts/child-environment";

describe("development child secret isolation", () => {
  const configured = {
    DATABASE_URL: "business-login", MYRIX_AUTH_DATABASE_URL: "auth-login", MYRIX_GATEWAY_DATABASE_URL: "ledger-login",
    MYRIX_RUNTIME_SIGNING_KEY_PEM: "signing-secret", MYRIX_CELL_CREDENTIALS: "all-cell-secrets",
    MYRIX_AUTH_MODE: "development", MYRIX_BIND_HOST: "127.0.0.1", MYRIX_PORT: "8787",
  };
  const parent = { ...configured, PATH: "/usr/bin", HOME: "/home/user", MYRIX_MIGRATE_DATABASE_URL: "superuser-secret",
    MYRIX_GATEWAY_UPSTREAM_API_KEY: "model-secret", MYRIX_GATEWAY_UPSTREAM_URL: "https://models.example/v1/responses",
    MYRIX_GATEWAY_UPSTREAM_MODEL: "explicit-model", NODE_OPTIONS: "--import ambient-code.js", NODE_PATH: "/ambient/modules", ANTHROPIC_API_KEY: "unrelated-secret" };
  it("gives the BFF only business/auth/signing/Cell administration secrets, never a migration or model key", () => {
    const env = serviceEnvironment("bff", configured, parent);
    expect(env).toMatchObject({ PATH: "/usr/bin", DATABASE_URL: "business-login", MYRIX_AUTH_DATABASE_URL: "auth-login", MYRIX_RUNTIME_SIGNING_KEY_PEM: "signing-secret" });
    for (const key of ["MYRIX_GATEWAY_DATABASE_URL", "MYRIX_GATEWAY_UPSTREAM_API_KEY", "MYRIX_MIGRATE_DATABASE_URL", "NODE_OPTIONS", "NODE_PATH", "ANTHROPIC_API_KEY"]) expect(env[key]).toBeUndefined();
  });
  it("gives the gateway its ledger and model key but not auth, signing, admin registry or migrator credentials", () => {
    const env = serviceEnvironment("gateway", configured, parent);
    expect(env).toMatchObject({ DATABASE_URL: "business-login", MYRIX_GATEWAY_DATABASE_URL: "ledger-login", MYRIX_GATEWAY_UPSTREAM_API_KEY: "model-secret" });
    for (const key of ["MYRIX_AUTH_DATABASE_URL", "MYRIX_RUNTIME_SIGNING_KEY_PEM", "MYRIX_CELL_CREDENTIALS", "MYRIX_MIGRATE_DATABASE_URL", "NODE_OPTIONS", "ANTHROPIC_API_KEY"]) expect(env[key]).toBeUndefined();
    expect(serviceEnvironment("gateway", configured, {}).MYRIX_GATEWAY_UPSTREAM_API_KEY).toBeUndefined();
    expect(serviceEnvironment("gateway", configured, {}).MYRIX_GATEWAY_UPSTREAM_MODEL).toBeUndefined();
  });
  it("starts Cell assembly from an OS-only allowlist and rejects accidental platform secret inclusion", () => {
    const env = { ...operatingEnvironment(parent), DSH_HOME: "/isolated/cell-1", MYRIX_WORKS_TOKEN: "own-works-token", MYRIX_GATEWAY_TOKEN: "own-gateway-token" };
    expect(operatingEnvironment(parent)).toEqual({ PATH: "/usr/bin", HOME: "/home/user" });
    expect(() => assertCellSecretIsolation(env)).not.toThrow();
    for (const name of ["DATABASE_URL", "MYRIX_RUNTIME_SIGNING_KEY_PEM", "MYRIX_GATEWAY_UPSTREAM_API_KEY", "NODE_OPTIONS", "MYRIX_RUNTIME_CELLS_JSON"]) {
      expect(() => assertCellSecretIsolation({ ...env, [name]: "sensitive-value" })).toThrow("platform-only");
    }
  });
});
