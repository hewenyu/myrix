import { afterEach, describe, expect, it } from "vitest";
import { createPrivateKey } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { developmentDatabase, loadOrCreateDevelopmentConfig, makeDevelopmentConfig } from "../scripts/dev-config";

const migrationUrl = "postgres://myrix_migrator:local-only-secret@127.0.0.1:55439/myrix";
const ownedDirectories = new Set<string>();
async function configPath() {
  const directory = await mkdtemp(join(tmpdir(), "myrix-dev-config-"));
  ownedDirectories.add(resolve(directory));
  return join(directory, "dev-runtime.json");
}
afterEach(async () => {
  for (const directory of ownedDirectories) {
    const target = resolve(directory);
    if (target !== directory || !ownedDirectories.has(target) || !target.startsWith(join(tmpdir(), "myrix-dev-config-"))) throw new Error("Unsafe fixture cleanup path");
    await rm(target, { recursive: true });
  }
  ownedDirectories.clear();
});

describe("explicit local development provisioning configuration", () => {
  it("rejects remote, unrelated, privileged connection-option and malformed targets without echoing secrets", () => {
    for (const url of ["not-a-url-with-secret", "postgres://root:secret@example.org:55439/myrix", "postgres://root:secret@localhost:5432/myrix", "postgres://root:secret@localhost:55439/other", `${migrationUrl}?options=-c%20role=owner`]) {
      expect(() => developmentDatabase(url)).toThrow();
      try { developmentDatabase(url); } catch (error) { expect(String(error)).not.toContain("secret"); }
    }
  });
  it("creates distinct runtime logins, Cell secrets and ES256 signing keys, never a migration connection", () => {
    const config = makeDevelopmentConfig(migrationUrl, "/tmp/myrix-static");
    const urls = [config.env.DATABASE_URL!, config.env.MYRIX_AUTH_DATABASE_URL!, config.env.MYRIX_GATEWAY_DATABASE_URL!];
    expect(new Set(urls.map(url => new URL(url).username)).size).toBe(3);
    expect(urls.every(url => !url.includes("myrix_migrator"))).toBe(true);
    expect(new Set(config.cells.flatMap(cell => [cell.token, cell.serviceToken])).size).toBe(4);
    expect(createPrivateKey(config.env.MYRIX_RUNTIME_SIGNING_KEY_PEM!).asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(config.publicKeys[0]?.d).toBeUndefined();
    expect(config.env.MYRIX_RUNTIME_OUTBOX_ENABLED).toBe("true");
    expect(config.env.MYRIX_GATEWAY_UPSTREAM_API_KEY).toBeUndefined();
  });
  it("persists private configuration once with 0600 permissions and reuses the same keys", async () => {
    const path = await configPath();
    const first = await loadOrCreateDevelopmentConfig(path, migrationUrl, "/tmp/myrix-static");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const before = await readFile(path, "utf8");
    expect(await loadOrCreateDevelopmentConfig(path, migrationUrl, "/tmp/myrix-static")).toEqual(first);
    expect(await readFile(path, "utf8")).toBe(before);
    await expect(loadOrCreateDevelopmentConfig(path, migrationUrl + "_other", "/tmp/myrix-static")).rejects.toThrow("拒绝覆盖");
    expect(await readFile(path, "utf8")).toBe(before);
  });
  it("refuses a credential file readable by other users without silently changing it", async () => {
    const path = await configPath();
    await loadOrCreateDevelopmentConfig(path, migrationUrl, "/tmp/myrix-static");
    await chmod(path, 0o644);
    await expect(loadOrCreateDevelopmentConfig(path, migrationUrl, "/tmp/myrix-static")).rejects.toThrow("0600");
  });
});
