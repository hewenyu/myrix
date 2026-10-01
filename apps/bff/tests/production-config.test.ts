import { describe, expect, it } from "vitest";
import { makeDevelopmentConfig } from "../scripts/dev-config";
import { readStartupEnvironment } from "../src/startup-config";
import { createProductionBff } from "../src/production";

function fixture() { return makeDevelopmentConfig("postgres://myrix_migrator:fixture-secret@127.0.0.1:55439/myrix", "/tmp/myrix-web"); }
describe("persistent BFF startup configuration", () => {
  it("accepts explicit development deployment without carrying a migration identity into runtime", () => {
    const fixtureValue = fixture();
    const config = readStartupEnvironment(fixtureValue.env);
    expect(config.bff.mode).toBe("development");
    expect(config.worksPort).toBe(8791);
    expect(config.runtime.cells).toHaveLength(2);
    expect(config.registry.resolve(`Bearer ${JSON.parse(fixtureValue.env.MYRIX_CELL_CREDENTIALS!)[0].token}`)).toBeDefined();
  });
  it("refuses missing placement, credentials or public-key deployment manifest", async () => {
    for (const key of ["MYRIX_RUNTIME_CELLS_JSON", "MYRIX_CELL_CREDENTIALS", "MYRIX_RUNTIME_JWKS_JSON"]) {
      const env = fixture().env; delete env[key];
      await expect(createProductionBff(env)).rejects.toThrow();
    }
  });
  it("refuses shared logins, disabled revoke delivery and public development listeners", () => {
    for (const change of [{ MYRIX_AUTH_DATABASE_URL: "same" }, { MYRIX_RUNTIME_OUTBOX_ENABLED: "false" }, { MYRIX_WORKS_HOST: "0.0.0.0" }]) {
      const env = fixture().env;
      Object.assign(env, change, change.MYRIX_AUTH_DATABASE_URL ? { MYRIX_AUTH_DATABASE_URL: env.DATABASE_URL } : {});
      expect(() => readStartupEnvironment(env)).toThrow();
    }
  });
  it("requires public key bytes to match, not merely a matching kid", () => {
    const value = fixture(); const other = fixture();
    const key = { ...other.publicKeys[0], kid: value.env.MYRIX_RUNTIME_SIGNING_KID };
    value.env.MYRIX_RUNTIME_JWKS_JSON = JSON.stringify(Object.fromEntries(value.cells.map(cell => [cell.cellId, [key]])));
    expect(() => readStartupEnvironment(value.env)).toThrow("does not match");
  });
  it("refuses private JWK material and cross-tenant credential reassignment without echoing tokens", () => {
    const value = fixture();
    value.env.MYRIX_RUNTIME_JWKS_JSON = JSON.stringify(Object.fromEntries(value.cells.map(cell => [cell.cellId, [{ ...value.publicKeys[0], d: "private-secret" }]])));
    expect(() => readStartupEnvironment(value.env)).toThrow("private key material");
    const next = fixture();
    const entries = JSON.parse(next.env.MYRIX_CELL_CREDENTIALS!); entries[0].tenantId = next.cells[1]!.tenantId;
    next.env.MYRIX_CELL_CREDENTIALS = JSON.stringify(entries);
    try { readStartupEnvironment(next.env); throw new Error("unexpected allow"); }
    catch (error) { expect(String(error)).toContain("does not match"); expect(String(error)).not.toContain(entries[0].token); }
  });
});
