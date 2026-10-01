import { generateKeyPairSync, createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { DEV_IDENTITIES, DEV_TENANT_ID, DEV_OTHER_TENANT_ID } from "../../../packages/platform-store/src/bin/seed";

export interface DevelopmentConfig {
  version: 1;
  database: { host: string; port: string; name: string };
  env: Record<string, string>;
  publicKeys: Record<string, unknown>[];
  cells: { tenantId: string; cellId: string; port: number; token: string; serviceToken: string }[];
}

/** This provisioner is deliberately limited to the repository's named loopback development database. */
export function developmentDatabase(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("MYRIX_MIGRATE_DATABASE_URL 必须是本仓本地开发数据库 URL"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.port !== "55439" || !/^\/myrix(?:_[a-z0-9_]+)?$/.test(url.pathname) || !url.username || url.search || url.hash) {
    throw new Error("开发装配只允许 loopback:55439 的 myrix/myrix_* 库；禁止指向其他数据库或带连接选项");
  }
  return url;
}

const secret = () => randomBytes(32).toString("base64url");
function loginUrl(source: URL, role: string, password: string) {
  const url = new URL(source); url.username = role; url.password = password; return url.toString();
}

export function makeDevelopmentConfig(migrationUrl: string, staticRoot: string): DevelopmentConfig {
  const database = developmentDatabase(migrationUrl);
  const suffix = createHash("sha256").update(database.pathname).digest("hex").slice(0, 10);
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const kid = `dev-${randomBytes(8).toString("hex")}`;
  const cells = [DEV_TENANT_ID, DEV_OTHER_TENANT_ID].map((tenantId, index) => ({
    tenantId, cellId: `cell-dev-${index + 1}`, port: 7801 + index, token: secret(), serviceToken: secret(),
  }));
  return {
    version: 1,
    database: { host: database.hostname, port: database.port, name: database.pathname.slice(1) },
    cells,
    publicKeys: [{ ...publicKey.export({ format: "jwk" }), kid, alg: "ES256", use: "sig" }],
    env: {
      MYRIX_AUTH_MODE: "development", MYRIX_ORIGIN: "http://127.0.0.1:8787", MYRIX_BIND_HOST: "127.0.0.1", MYRIX_PORT: "8787",
      MYRIX_STATIC_ROOT: staticRoot,
      // This is the existing public local-only seed password, not a production credential.
      DATABASE_URL: loginUrl(database, "myrix_app", "myrix_local_app"),
      MYRIX_AUTH_DATABASE_URL: loginUrl(database, `myrix_auth_dev_${suffix}`, secret()),
      MYRIX_GATEWAY_DATABASE_URL: loginUrl(database, `myrix_gateway_dev_${suffix}`, secret()),
      MYRIX_DEV_USERS: JSON.stringify(Object.fromEntries(DEV_IDENTITIES.map(({ login, tenantId, userId }) => [login, { tenantId, userId }]))),
      MYRIX_WORKS_HOST: "127.0.0.1", MYRIX_WORKS_PORT: "8791", MYRIX_GATEWAY_HOST: "127.0.0.1", MYRIX_GATEWAY_PORT: "8790",
      MYRIX_CELL_CREDENTIALS: JSON.stringify(cells.map(({ tenantId, cellId, token }) => ({ tenantId, cellId, token }))),
      MYRIX_RUNTIME_CELLS_JSON: JSON.stringify(cells.map(({ tenantId, cellId, port, serviceToken }) => ({ tenantId, cellId, baseUrl: `http://127.0.0.1:${port}`, serviceToken }))),
      MYRIX_RUNTIME_SIGNING_KEY_PEM: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      MYRIX_RUNTIME_SIGNING_KID: kid, MYRIX_RUNTIME_ISSUER: "myrix-control-plane", MYRIX_RUNTIME_OUTBOX_ENABLED: "true",
      MYRIX_RUNTIME_JWKS_JSON: JSON.stringify(Object.fromEntries(cells.map(cell => [cell.cellId, [{ ...publicKey.export({ format: "jwk" }), kid, alg: "ES256", use: "sig" }]]))),
    },
  };
}

/** Runtime loading never needs or reads a migration URL, and never creates missing credentials. */
export async function readDevelopmentConfig(path: string): Promise<DevelopmentConfig> {
  const metadata = await stat(path);
  if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) throw new Error("开发凭据文件必须是权限 0600 的普通文件");
  const value = JSON.parse(await readFile(path, "utf8")) as DevelopmentConfig;
  if (value?.version !== 1 || !value.env || !value.database || !Array.isArray(value.cells) || value.cells.length !== 2 || !Array.isArray(value.publicKeys) || value.publicKeys.length !== 1) throw new Error("开发配置格式无效；请先执行 setup:dev");
  for (const field of ["DATABASE_URL", "MYRIX_AUTH_DATABASE_URL", "MYRIX_GATEWAY_DATABASE_URL"]) {
    const login = developmentDatabase(value.env[field] ?? "");
    if (login.hostname !== value.database.host || login.port !== value.database.port || login.pathname.slice(1) !== value.database.name) throw new Error("开发运行连接与配置目标不匹配");
  }
  if (!value.env.MYRIX_RUNTIME_JWKS_JSON) value.env.MYRIX_RUNTIME_JWKS_JSON = JSON.stringify(Object.fromEntries(value.cells.map(cell => [cell.cellId, value.publicKeys])));
  return value;
}

/** Never overwrite existing keys. Concurrent first-time setup loses the exclusive create race safely. */
export async function loadOrCreateDevelopmentConfig(path: string, migrationUrl: string, staticRoot: string): Promise<DevelopmentConfig> {
  const target = developmentDatabase(migrationUrl);
  try {
    const value = await readDevelopmentConfig(path);
    if (value.version !== 1 || value.database?.host !== target.hostname || value.database.port !== target.port || value.database.name !== target.pathname.slice(1)
      || !value.env || !Array.isArray(value.cells) || value.cells.length !== 2 || !Array.isArray(value.publicKeys) || value.publicKeys.length !== 1) {
      throw new Error("已有开发配置与指定数据库不匹配；拒绝覆盖既有密钥");
    }
    for (const field of ["DATABASE_URL", "MYRIX_AUTH_DATABASE_URL", "MYRIX_GATEWAY_DATABASE_URL"]) {
      const login = developmentDatabase(value.env[field] ?? "");
      if (login.hostname !== target.hostname || login.port !== target.port || login.pathname !== target.pathname) throw new Error("开发运行连接与迁移目标不匹配");
    }
    // Derive a public deployment manifest for configurations created before that field existed;
    // no private file rewrite or key regeneration is necessary.
    if (!value.env.MYRIX_RUNTIME_JWKS_JSON) value.env.MYRIX_RUNTIME_JWKS_JSON = JSON.stringify(Object.fromEntries(value.cells.map(cell => [cell.cellId, value.publicKeys])));
    return value;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  const config = makeDevelopmentConfig(migrationUrl, staticRoot);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(config, null, 2) + "\n", "utf8"); await file.sync(); }
  finally { await file.close(); }
  return config;
}
