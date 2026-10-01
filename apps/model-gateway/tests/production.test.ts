import { describe, expect, it } from "vitest";
import { createProductionGateway } from "../src/production";

describe("production gateway startup is explicit and fail closed", () => {
  it("requires real database connections rather than a memory fallback", async () => {
    await expect(createProductionGateway({})).rejects.toThrow("DATABASE_URL 必须显式配置");
    await expect(createProductionGateway({ DATABASE_URL: "postgres://app:fixture@localhost/myrix" })).rejects.toThrow("MYRIX_GATEWAY_DATABASE_URL 必须显式配置");
  });
  it("does not echo secrets in malformed connection-string errors", async () => {
    await expect(createProductionGateway({ DATABASE_URL: "secret-not-a-url" })).rejects.not.toThrow("secret-not-a-url");
  });
  it("refuses env-supplied identity maps before opening any connections", async () => {
    await expect(createProductionGateway({
      DATABASE_URL: "postgres://app:fixture@localhost/myrix",
      MYRIX_GATEWAY_DATABASE_URL: "postgres://gateway:fixture@localhost/myrix",
      MYRIX_GATEWAY_CREDENTIAL_SOURCE: "env",
    })).rejects.toThrow("只允许 PostgreSQL 凭据解析");
  });
});
