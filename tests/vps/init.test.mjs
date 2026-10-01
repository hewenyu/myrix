// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0
/**
 * 单机 VPS 部署生成器的纯测试：不调用真实模型、不连接数据库、不启动容器。
 *
 * 覆盖：秘密边界（Cell 绝不拿到 upstream key/DB/私钥/OIDC secret）、文件权限
 * 0600、覆盖拒绝、四个镜像同 SHA、单 Cell/单租户/单 owner、Keycloak 独立库、
 * 以及“同机 Keycloak + 宿主 Nginx、没有 Caddy”这一部署边界。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, stat, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  CELL_INTERNAL_HTTP_ORIGINS,
  ERROR_CODES,
  InitError,
  POSTGRES_IMAGE,
  TARGETS,
  assertAbsentOrForced,
  assertSameImageSha,
  buildDeployment,
  envLine,
  loadAuthFactory,
  parseArgs,
  preflightTargets,
  renderEnvFile,
  rollbackCreated,
  validateCellCount,
  validateImage,
  validateOrigin,
  validateUpstream,
  writeSecure,
} from "../../deploy/vps/init.mjs";
import { createAuthConfig } from "../../deploy/auth/auth-config.ts";

const run = promisify(execFile);
const REPO = new URL("../../", import.meta.url).pathname;
const INIT = join(REPO, "deploy/vps/init.mjs");
const SHA = (char) => char.repeat(40);
const IMAGE = (component, char) => `docker.io/hewenyulucky/myrix:${component}-sha-${SHA(char)}`;
/** 同一个 commit SHA 的四个组件镜像。 */
const SAME_SHA = "a";
const IMAGES = Object.freeze({
  bffImage: IMAGE("bff", SAME_SHA),
  gatewayImage: IMAGE("gateway", SAME_SHA),
  cellImage: IMAGE("cell", SAME_SHA),
  keycloakImage: IMAGE("keycloak", SAME_SHA),
});

const BASE_INPUT = Object.freeze({
  domain: "myrix.example.com",
  origin: "https://myrix.example.com",
  ...IMAGES,
  upstreamUrl: "https://api.apikey.fan/v1/responses",
  upstreamModel: "deepseek-flash",
  upstreamApiKey: "sk-upstream-value",
});

function build(overrides = {}) {
  return buildDeployment({ ...BASE_INPUT, ...overrides }, { auth: createAuthConfig });
}

const cellEnvOf = (deployment, cellId) => deployment.files[TARGETS.cellEnv(cellId)];

// ---------------------------------------------------------------------------
// 1. 镜像与 tag 契约
// ---------------------------------------------------------------------------

test("镜像 tag 必须是 hewenyulucky/myrix 的 <component>-sha-<40hex>", () => {
  assert.equal(validateImage(IMAGE("bff", "a"), "bff", "bff").reference, IMAGE("bff", "a"));
  assert.equal(validateImage(IMAGE("cell", "0"), "cell", "cell").sha, SHA("0"));
  for (const bad of [
    "docker.io/other/myrix:bff-sha-" + SHA("a"),
    "docker.io/hewenyulucky/myrix:latest",
    "docker.io/hewenyulucky/myrix:bff-sha-" + "a".repeat(39),
    "docker.io/hewenyulucky/myrix:bff-sha-" + "A".repeat(40),
    "docker.io/hewenyulucky/myrix:bff-latest",
  ]) {
    assert.throws(() => validateImage(bad, "bff", "bff"), InitError, bad);
  }
  // 组件与用途必须一致：cell 镜像不能配给 gateway。
  assert.throws(() => validateImage(IMAGE("cell", "c"), "gateway", "gateway"), InitError);
});

test("四个 Myrix 镜像必须来自同一个完整 commit SHA，错混一律拒绝", () => {
  assert.equal(assertSameImageSha({
    bff: validateImage(IMAGE("bff", "a"), "bff", "b"),
    gateway: validateImage(IMAGE("gateway", "a"), "gateway", "g"),
    cell: validateImage(IMAGE("cell", "a"), "cell", "c"),
    keycloak: validateImage(IMAGE("keycloak", "a"), "keycloak", "k"),
  }), SHA("a"));
  // 换掉任意一个组件的 SHA 都必须失败：不允许错混镜像。
  assert.throws(() => build({ keycloakImage: IMAGE("keycloak", "b") }), /同一完整 commit SHA/);
  assert.throws(() => build({ gatewayImage: IMAGE("gateway", "b") }), /同一完整 commit SHA/);
  assert.equal(build().commitSha, SHA(SAME_SHA));
  // .env 里四个 tag 指向同一个 SHA。
  const env = build().files[TARGETS.composeEnv];
  for (const key of ["MYRIX_IMAGE_BFF", "MYRIX_IMAGE_GATEWAY", "MYRIX_IMAGE_CELL", "MYRIX_IMAGE_KEYCLOAK"]) {
    assert.match(env[key], new RegExp(`${SAME_SHA}{40}$`), key);
  }
});

test("Postgres 按已验证的双架构摘要固定，并写进 .env 供 compose 读取", () => {
  assert.match(POSTGRES_IMAGE, /^docker\.io\/library\/postgres:17-alpine@sha256:[0-9a-f]{64}$/);
  assert.match(POSTGRES_IMAGE, /b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24$/);
  const env = build().files[TARGETS.composeEnv];
  assert.equal(env.MYRIX_IMAGE_POSTGRES, POSTGRES_IMAGE);
  assert.equal(env.MYRIX_IMAGE_KEYCLOAK, IMAGE("keycloak", SAME_SHA));
  assert.equal(env.MYRIX_DOMAIN, BASE_INPUT.domain);
});

// ---------------------------------------------------------------------------
// 2. 秘密边界：Cell 绝不拿到 upstream key / DB / 私钥 / OIDC secret
// ---------------------------------------------------------------------------

test("Cell 的 env 不含 upstream key、数据库、签名私钥或 OIDC secret", () => {
  const deployment = build();
  const env = cellEnvOf(deployment, "cell-1");
  const forbiddenKey = /UPSTREAM|DATABASE|SIGNING|PRIVATE_KEY|OIDC|MIGRAT|POSTGRES|PASSWORD/i;
  for (const key of Object.keys(env)) {
    assert.doesNotMatch(key, forbiddenKey, `Cell 不应出现 ${key}`);
  }
  const text = JSON.stringify(env);
  assert.doesNotMatch(text, /sk-upstream-value/, "Cell 不得携带 upstream key");
  assert.doesNotMatch(text, /BEGIN PRIVATE KEY/, "Cell 不得携带签名私钥");
  assert.doesNotMatch(text, /postgres:\/\//, "Cell 不得携带数据库连接串");
  assert.doesNotMatch(text, /https:\/\/myrix\.example\.com\/auth/, "Cell 不得携带 OIDC issuer/secret");
  assert.equal(env.MYRIX_TENANT_ID, deployment.cells[0].tenantId);
  assert.equal(env.MYRIX_CELL_ID, "cell-1");
  // 内部 HTTP 白名单精确等于 cell-entry 允许的两个服务 origin。
  assert.deepEqual(JSON.parse(env.MYRIX_CELL_INTERNAL_HTTP_ORIGINS), [...CELL_INTERNAL_HTTP_ORIGINS]);
  assert.equal(env.MYRIX_WORKS_ORIGIN, "http://bff:8791");
  assert.equal(env.MYRIX_GATEWAY_URL, "http://gateway:8790/v1");
});

test("upstream key 只出现在 gateway env；签名私钥只出现在 bff env", () => {
  const deployment = build();
  for (const [relative, record] of Object.entries(deployment.files)) {
    if (typeof record === "string") continue;
    const text = JSON.stringify(record);
    if (text.includes("sk-upstream-value")) assert.equal(relative, TARGETS.gatewayEnv, `upstream key 泄漏到 ${relative}`);
    if (text.includes("BEGIN PRIVATE KEY")) assert.equal(relative, TARGETS.bffEnv, `签名私钥泄漏到 ${relative}`);
  }
});

test("OIDC client secret 只出现在 bff env 与 Keycloak env，绝不进 Cell", () => {
  const deployment = build();
  const secret = deployment.files[TARGETS.bffEnv].MYRIX_OIDC_CLIENT_SECRET;
  assert.equal(typeof secret, "string");
  assert.ok(secret.length >= 16);
  // Keycloak 侧的 realm 导入也必须带同一个 secret。
  assert.ok(deployment.files[TARGETS.realmImport].includes(secret), "realm 导入缺少 client secret");
  for (const [relative, record] of Object.entries(deployment.files)) {
    if (typeof record === "string") continue;
    if (JSON.stringify(record).includes(secret)) {
      assert.ok(
        relative === TARGETS.bffEnv || relative === TARGETS.keycloakEnv || relative === TARGETS.realmImport,
        `client secret 泄漏到 ${relative}`,
      );
    }
  }
  assert.doesNotMatch(JSON.stringify(cellEnvOf(deployment, "cell-1")), new RegExp(secret));
});

test("Cell 的凭据互不相同且不含管理员令牌", () => {
  const deployment = build();
  const cell = deployment.cells[0];
  assert.notEqual(cell.cellToken, cell.serviceToken);
  const env = cellEnvOf(deployment, cell.cellId);
  assert.equal(env.MYRIX_WORKS_TOKEN, cell.cellToken);
  assert.equal(env.MYRIX_GATEWAY_TOKEN, cell.cellToken);
  assert.equal(env.MYRIX_DRAIN_TOKEN, cell.serviceToken);
  assert.equal(env.MYRIX_REVOKE_TOKEN, cell.serviceToken);
});

// ---------------------------------------------------------------------------
// 3. 单 Cell / 单租户 / 单 owner
// ---------------------------------------------------------------------------

test("首版只允许 1 Cell：--cells > 1 明确拒绝，不假装支持多租户", () => {
  assert.equal(validateCellCount(undefined), 1);
  assert.equal(validateCellCount("1"), 1);
  for (const bad of ["0", "-1", "2", "8", "1.5"]) {
    assert.throws(() => validateCellCount(bad), InitError, bad);
  }
  assert.throws(() => build({ cells: "2" }), /只支持 --cells 1/);
  const deployment = build();
  assert.equal(deployment.cells.length, 1);
  assert.equal(deployment.cells[0].cellId, "cell-1");
  assert.equal(deployment.cells[0].port, 8404);
  assert.equal(deployment.cells[0].baseUrl, "http://cell-1:8404");
});

test("迁移/授权 job 的 env 同时给出连接串与 psql 的 PG* 变量", () => {
  const deployment = build();
  const migrator = deployment.files[TARGETS.migratorEnv];
  // migrate/auth 走显式连接串；grants.sh 走 psql，必须有 PGPASSWORD 等。
  assert.match(migrator.MYRIX_MIGRATE_DATABASE_URL, /^postgres:\/\/myrix_migrator:/);
  assert.match(migrator.MYRIX_GATEWAY_MIGRATE_DATABASE_URL, /^postgres:\/\/myrix_migrator:/);
  assert.equal(migrator.MYRIX_AUTH_ROLE, "myrix_auth");
  assert.equal(migrator.PGHOST, "postgres");
  assert.equal(migrator.PGDATABASE, "myrix");
  assert.equal(migrator.PGUSER, "myrix_migrator");
  assert.equal(migrator.PGPORT, "5432");
  assert.equal(typeof migrator.PGPASSWORD, "string");
  assert.ok(migrator.PGPASSWORD.length >= 16);
  // provision 用超级用户建角色。
  const provision = deployment.files[TARGETS.provisionEnv];
  assert.equal(provision.PGUSER, "myrix_admin");
  assert.equal(provision.PGDATABASE, "myrix");
  // 迁移凭据绝不进入常驻服务的 env。
  for (const relative of [TARGETS.bffEnv, TARGETS.gatewayEnv, TARGETS.cellEnv("cell-1")]) {
    const record = deployment.files[relative];
    assert.equal("PGPASSWORD" in record, false, `${relative} 不应有 PGPASSWORD`);
    assert.doesNotMatch(JSON.stringify(record), new RegExp(migrator.PGPASSWORD));
  }
});

test("owner UUID 同时是 Keycloak sub、subjects.subject 与业务 user id", () => {
  const deployment = build();
  const realm = JSON.parse(deployment.files[TARGETS.realmImport]);
  const user = realm.users[0];
  const identity = deployment.sql[TARGETS.identitySql];
  assert.equal(user.id, deployment.owner.subject);
  assert.equal(user.username, deployment.owner.username);
  assert.equal(deployment.owner.userId, deployment.owner.subject);
  assert.match(identity, new RegExp(deployment.owner.subject));
  // subjects 只登记这一条 (issuer, subject)，且 issuer 与 realm 的公共 issuer 一致。
  assert.ok(identity.includes(deployment.oidc.issuer));
  assert.equal((identity.match(/insert into myrix_auth\.subjects/g) ?? []).length, 1);
  assert.equal(deployment.owner.username, "myrix-owner");
});

test("显式 --tenant-uuid 必须是 UUID，否则拒绝", () => {
  const pinned = build({ tenantUuid: "11111111-1111-4111-8111-111111111111" });
  assert.equal(pinned.cells[0].tenantId, "11111111-1111-4111-8111-111111111111");
  assert.throws(() => build({ tenantUuid: "not-a-uuid" }), InitError);
});

// ---------------------------------------------------------------------------
// 4. 秘密生成：ES256 / JWKS / Keycloak 独立库
// ---------------------------------------------------------------------------

test("签名的 JWKS 是 ES256 P-256 且不含私钥参数 d", () => {
  const deployment = build();
  const jwks = JSON.parse(deployment.files[TARGETS.bffEnv].MYRIX_RUNTIME_JWKS_JSON);
  const keys = jwks["cell-1"];
  assert.ok(Array.isArray(keys) && keys.length === 1);
  for (const key of keys) {
    assert.equal(key.kty, "EC");
    assert.equal(key.crv, "P-256");
    assert.equal(key.alg, "ES256");
    assert.equal(key.use, "sig");
    assert.equal(key.d, undefined, "公开 JWKS 不得含有私钥参数");
    assert.ok(key.x && key.y);
  }
  assert.match(deployment.files[TARGETS.bffEnv].MYRIX_RUNTIME_SIGNING_KEY_PEM, /BEGIN PRIVATE KEY/);
  // Cell 的 grant JWKS 与部署方公布的公钥一致。
  assert.deepEqual(JSON.parse(cellEnvOf(deployment, "cell-1").MYRIX_GRANT_JWKS), keys);
});

test("Keycloak 用独立库与低权角色，SQL 不是 compose 启动的一部分", () => {
  const deployment = build();
  const sql = deployment.sql[TARGETS.keycloakDbSql];
  assert.match(sql, /CREATE DATABASE keycloak OWNER keycloak/);
  assert.match(sql, /CREATE ROLE keycloak LOGIN PASSWORD/);
  assert.match(sql, /NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS/);
  // auth-config.ts 明确写出：这是显式 provision，不是应用启动时自动迁移。
  assert.match(sql, /不是应用启动时自动迁移|不是 docker compose 的一部分/);
  assert.equal(sql.includes("GRANT ALL"), false);
  const roles = deployment.sql[TARGETS.rolesSql];
  assert.doesNotMatch(roles, /create role keycloak/i, "业务角色 SQL 不应顺带创建 keycloak 角色");
});

test("Keycloak 环境由 createAuthConfig 生成：/auth 相对路径与回环发布", () => {
  const deployment = build();
  const env = deployment.files[TARGETS.keycloakEnv];
  assert.equal(env.KC_HTTP_RELATIVE_PATH, "/auth");
  assert.equal(env.KC_HTTP_MANAGEMENT_RELATIVE_PATH, "/");
  // Keycloak 26.8 的真实 discovery 在 /auth 下，KC_HOSTNAME 必须带 /auth；
  // 浏览器 origin 仍是 https://myrix.example.com。
  assert.equal(env.KC_HOSTNAME, "https://myrix.example.com/auth");
  // 修正 KC_HOSTNAME 不得改变浏览器 origin 与逐字节 issuer。
  assert.equal(deployment.origin, "https://myrix.example.com");
  assert.equal(deployment.oidc.issuer, "https://myrix.example.com/auth/realms/myrix");
  assert.equal(env.KC_PROXY_HEADERS, "xforwarded");
  assert.equal(env.KC_DB_URL, "jdbc:postgresql://postgres:5432/keycloak");
  assert.equal(env.KC_DB_USERNAME, "keycloak");
  assert.ok(typeof env.KC_DB_PASSWORD === "string" && env.KC_DB_PASSWORD.length >= 16);
  assert.ok(typeof env.KC_BOOTSTRAP_ADMIN_PASSWORD === "string" && env.KC_BOOTSTRAP_ADMIN_PASSWORD.length >= 16);
  assert.equal(env.KC_BOOTSTRAP_ADMIN_USERNAME, "myrix-admin");
  assert.equal(deployment.keycloak.keycloakHostPort, 18080);
  assert.equal(deployment.keycloak.bffHostPort, 8787);
  assert.equal(deployment.keycloak.realmImportFileName, "realm-myrix.json");
});

// ---------------------------------------------------------------------------
// 5. 配置校验：fail-closed
// ---------------------------------------------------------------------------

test("生产 origin 必须是精确 https，且与 DOMAIN 一致", () => {
  assert.throws(() => validateOrigin("http://myrix.example.com", "myrix.example.com"), InitError);
  assert.throws(() => validateOrigin("https://myrix.example.com/path", "myrix.example.com"), InitError);
  assert.throws(() => validateOrigin("https://myrix.example.com:8443", "myrix.example.com"), InitError);
  assert.throws(() => validateOrigin("https://a.example.com", "b.example.com"), InitError);
  assert.deepEqual(validateOrigin("https://myrix.example.com", "myrix.example.com"), {
    origin: "https://myrix.example.com", domain: "myrix.example.com",
  });
});

test("上游必须是完整的 https /responses 端点，禁止 chat/completions", () => {
  assert.throws(() => validateUpstream("http://api.example.com/v1/responses", "m"), InitError);
  assert.throws(() => validateUpstream("https://api.example.com/v1", "m"), InitError);
  assert.throws(() => validateUpstream("https://api.example.com/v1/chat/completions", "m"), InitError);
  assert.throws(() => validateUpstream("https://api.example.com/v1/responses?x=1", "m"), InitError);
  assert.throws(() => validateUpstream("https://api.example.com/v1/responses", ""), InitError);
  assert.equal(validateUpstream("https://api.example.com/v1/responses", "m").model, "m");
});

test("缺少上游密钥或必填项时构造期失败，且错误信息不含秘密值", () => {
  for (const field of ["upstreamApiKey", "domain", "origin", "bffImage"]) {
    const input = { ...BASE_INPUT, [field]: "" };
    assert.throws(() => buildDeployment(input, { auth: createAuthConfig }), (error) => {
      assert.ok(error instanceof InitError);
      assert.doesNotMatch(error.message, /sk-upstream-value/);
      return true;
    }, field);
  }
  // 非法上下文窗口。
  assert.throws(() => build({ contextWindow: "1024" }), InitError);
});

test("没有 createAuthConfig 注入时拒绝生成（内部错误，不是静默降级）", () => {
  assert.throws(() => buildDeployment(BASE_INPUT), /createAuthConfig/);
});

test("loadAuthFactory 能拿到 deploy/auth 的 createAuthConfig", async () => {
  const factory = await loadAuthFactory();
  assert.equal(typeof factory, "function");
  assert.equal(factory, createAuthConfig);
});

// ---------------------------------------------------------------------------
// 6. env 序列化：换行/引号按 compose 规则转义
// ---------------------------------------------------------------------------

test("envLine 只对需要的内容加引号，并把换行转义成 \\n", () => {
  assert.equal(envLine("A", "plain"), "A=plain");
  assert.equal(envLine("A", "has space"), 'A="has space"');
  assert.equal(envLine("A", "line1\nline2"), 'A="line1\\nline2"');
  assert.equal(envLine("A", 'quote"inside'), 'A="quote\\"inside"');
  assert.equal(envLine("A", "back\\slash"), 'A="back\\\\slash"');
  assert.equal(envLine("A", "#comment"), 'A="#comment"');
  const rendered = renderEnvFile({ A: "one\ntwo", B: "plain" }, "test");
  const bodyLines = rendered.trimEnd().split("\n").filter((line) => !line.startsWith("#"));
  assert.equal(bodyLines.length, 2);
});

test("envLine 转义 $ 以免 Compose 插值破坏值；控制字符明确拒绝", () => {
  // `$` 必须转义成 `\$`，否则 compose 会把 `$UPSTREAM` 当变量替换/清空。
  assert.equal(envLine("A", "sk-$UPSTREAM"), 'A="sk-\\$UPSTREAM"');
  assert.equal(envLine("A", "pre${X}post"), 'A="pre\\${X}post"');
  assert.equal(envLine("A", "$"), 'A="\\$"');
  // 控制字符（含 CR）没有可靠表示：fail-closed，不静默删除后继续。
  assert.throws(() => envLine("A", "a\u0007b"), InitError);
  assert.throws(() => envLine("A", "a\rb"), InitError);
});

// 用真实 `docker compose config` 的 env_file 解析验证 roundtrip（仅解析，不启动容器）。
const COMPOSE = process.env.MYRIX_TEST_COMPOSE ?? "docker compose";
async function composeConfigJson(dir, composeFile) {
  const cli = COMPOSE.split(" ");
  const { stdout } = await run(
    cli[0],
    [...cli.slice(1), "-f", composeFile, "config", "--format", "json"],
    { cwd: dir },
  );
  return JSON.parse(stdout).services.t.environment;
}

test("envLine 输出经真实 docker compose env_file 解析后 $/引号/换行(PEM) roundtrip", async (t) => {
  // 只依赖本机 docker compose CLI 做静态 config 解析，不拉镜像、不启动容器。
  try {
    await run("docker", ["compose", "version"]);
  } catch {
    t.skip("本机没有 docker compose，跳过真实 env_file 解析验证");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "myrix-vps-envfile-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const record = {
    PLAIN: "plain",
    DOLLAR: "sk-$UPSTREAM-${BRACE}-end",
    PEM: "-----BEGIN PRIVATE KEY-----\nAAAA\nBBBB\n-----END PRIVATE KEY-----\n",
    QUOTE: 'has "double" and \'single\'',
    HASH: "value # not a comment",
    BACK: "back\\slash",
  };
  await writeFile(join(dir, "round.env"), Object.keys(record).map((k) => envLine(k, record[k])).join("\n") + "\n");
  await writeFile(join(dir, "compose.yml"), [
    "services:",
    "  t:",
    "    image: busybox",
    "    env_file: [round.env]",
    '    command: ["env"]',
    "",
  ].join("\n"));
  const parsed = await composeConfigJson(dir, join(dir, "compose.yml"));
  // `config --format json` 对字面 `$` 会再显示为 `$$`（compose 的插值转义），
  // 恢复成真实容器里看到的值后必须与原始取值逐字节一致。
  const decoded = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v).replace(/\$\$/g, "$")]));
  assert.equal(decoded.PLAIN, record.PLAIN);
  assert.equal(decoded.DOLLAR, record.DOLLAR, "含 $ 的值被 compose 插值损坏");
  assert.equal(decoded.PEM, record.PEM, "PEM 换行没能 roundtrip");
  assert.equal(decoded.QUOTE, record.QUOTE, "引号没能 roundtrip");
  assert.equal(decoded.HASH, record.HASH, "行内 # 被当成注释截断");
  assert.equal(decoded.BACK, record.BACK, "反斜杠没能 roundtrip");
});

// ---------------------------------------------------------------------------
// 7. 文件权限、覆盖拒绝与 symlink 安全
// ---------------------------------------------------------------------------

async function collectModes(root) {
  const walk = async (dir) => {
    const modes = {};
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) Object.assign(modes, await walk(path));
      else modes[path.slice(root.length + 1)] = (await stat(path)).mode & 0o777;
    }
    return modes;
  };
  return walk(root);
}

/** 生成完整配置到一个全新目录，返回 { dir, deployment }。 */
async function generateAll(dir) {
  const deployment = build();
  for (const [relative, record] of Object.entries(deployment.files)) {
    const body = typeof record === "string" ? record : renderEnvFile(record, relative);
    await writeSecure(dir, relative, body);
  }
  for (const [relative, body] of Object.entries(deployment.sql)) await writeSecure(dir, relative, body);
  return deployment;
}

test("生成的秘密文件权限一律 0600，且不覆盖已有文件", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "myrix-vps-init-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const deployment = await generateAll(dir);

  const modes = await collectModes(dir);
  assert.ok(Object.keys(modes).length >= 12, "应生成完整的配置/ SQL 集合");
  for (const [relative, mode] of Object.entries(modes)) {
    assert.equal(mode, 0o600, `${relative} 权限应为 0600，实际 ${mode.toString(8)}`);
  }

  const target = join(dir, TARGETS.gatewayEnv);
  const before = await readFile(target, "utf8");
  await writeFile(join(dir, "sentinel"), "x");
  await assert.rejects(() => writeSecure(dir, TARGETS.gatewayEnv, "REPLACED"), InitError);
  assert.equal(await readFile(target, "utf8"), before);
  // force:true 也必须 fail-closed：不覆盖、不改动既有文件。
  await assert.rejects(
    () => writeSecure(dir, TARGETS.gatewayEnv, "REPLACED\n", { force: true }),
    (error) => {
      assert.ok(error instanceof InitError);
      assert.match(error.message, /不支持 --force/);
      return true;
    },
  );
  assert.equal(await readFile(target, "utf8"), before, "force 请求不得改动既有文件");
});

test("越界路径被拒绝", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "myrix-vps-escape-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(() => writeSecure(dir, "../escape.env", "x"), InitError);
  await assert.rejects(() => writeSecure(dir, "secrets/../../escape.env", "x"), InitError);
});

test("root 之外的系统祖先 symlink 不误判（/var -> /private/var 类），最终目标仍在 root 内", async (t) => {
  const raw = await mkdtemp(join(tmpdir(), "myrix-vps-realpath-"));
  t.after(() => rm(raw, { recursive: true, force: true }));
  const base = await realpath(raw);
  // root 的**祖先**是 symlink（模拟 macOS /var -> /private/var 这类系统别名）：
  // 只以显式输出 root 为边界检查其内，不因 root 祖先含链接而误判。
  const realParent = join(base, "real-parent");
  const out = join(realParent, "out");
  await mkdir(realParent, { recursive: true });
  await symlink(realParent, join(base, "link-parent"), "dir");
  const linkedRoot = join(base, "link-parent", "out");
  await writeSecure(linkedRoot, "secrets/a.env", "x=1\n");
  // 落盘仍在真实 root 之内，没有跑到 root 之外。
  assert.equal(await readFile(join(out, "secrets/a.env"), "utf8"), "x=1\n");
});

test("dangling symlink / 父级 symlink 目标在写第一份秘密前被拒绝，root 外哨兵不变", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "myrix-vps-link-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dir = join(base, "out");
  const outside = join(base, "outside");
  await writeSecure(outside, "sentinel", "ORIGINAL\n");

  // 1) 目标本身是 dangling symlink（stat 会漏掉，lstat 必须抓到）指向 root 外。
  const danglingTarget = join(dir, "secrets");
  await writeSecure(dir, "keep", "k\n");
  await symlink(join(outside, "does-not-exist"), join(dir, TARGETS.composeEnv), "file");
  await assert.rejects(() => preflightTargets(dir, [TARGETS.composeEnv]), InitError);
  assert.equal((await lstat(join(dir, TARGETS.composeEnv))).isSymbolicLink(), true, "dangling link 未被改动");

  // 2) 父级 symlink：secrets/ 是指向 root 外的链接，逐级检查必须拒绝。
  const dir2 = join(base, "out2");
  await writeSecure(dir2, "keep", "k\n");
  await symlink(outside, join(dir2, "secrets"), "dir");
  await assert.rejects(
    () => preflightTargets(dir2, [TARGETS.gatewayEnv, TARGETS.bffEnv]),
    InitError,
  );
  assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "ORIGINAL\n");
  assert.equal((await lstat(join(dir2, "secrets"))).isSymbolicLink(), true);

  // 3) root 自身若是一个指向别处的 symlink：拒绝，绝不跟着写出去。
  const linkRoot = join(base, "linked-root");
  await symlink(outside, linkRoot, "dir");
  await assert.rejects(() => preflightTargets(linkRoot, [TARGETS.composeEnv]), InitError);
  assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "ORIGINAL\n");
});

test("后序目标冲突时 preflight 先拒绝，不先写任何一份秘密", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "myrix-vps-order-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dir = join(base, "out");
  await writeSecure(dir, "keep", "k\n");
  // 冲突发生在列表末尾：preflight 必须在写第一份之前就发现。
  const relatives = [TARGETS.composeEnv, TARGETS.postgresPassword, TARGETS.identitySql];
  await mkdir(join(dir, "sql"), { recursive: true });
  await symlink(join(base, "nope"), join(dir, TARGETS.identitySql), "file");
  await assert.rejects(() => preflightTargets(dir, relatives), InitError);
  for (const relative of [TARGETS.composeEnv, TARGETS.postgresPassword]) {
    await assert.rejects(() => lstat(join(dir, relative)), /ENOENT/, `${relative} 不应被写入`);
  }
  // 兼容导出名行为一致：force=true 明确拒绝。
  await assert.rejects(() => assertAbsentOrForced(dir, relatives, false), InitError);
  await assert.rejects(() => assertAbsentOrForced(dir, relatives, true), /不支持 --force/);
});

test("失败只回滚本次创建的文件，绝不删除既有用户文件", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "myrix-vps-rollback-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dir = join(base, "out");
  // 既有用户文件：必须在失败后原样保留。
  await writeSecure(dir, "user-owned.env", "KEEP=me\n");
  // 先写一份本次文件，再人为让后续写入失败（父级临时改成文件）。
  const created = [];
  await writeSecure(dir, "secrets/first.env", "A=1\n", { created });
  await writeFile(join(dir, "auth"), "not a directory", "utf8");
  await assert.rejects(() => writeSecure(dir, "auth/second.env", "B=2\n"), InitError);
  assert.equal(await readFile(join(dir, "user-owned.env"), "utf8"), "KEEP=me\n");
  assert.equal(await readFile(join(dir, "secrets/first.env"), "utf8"), "A=1\n");
});

test("rollbackCreated 只删本次记录的文件/空目录，既有用户文件绝不动", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "myrix-vps-rollback2-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dir = join(base, "out");
  await writeSecure(dir, "user-owned.env", "KEEP=me\n");
  const created = [];
  await writeSecure(dir, "secrets/mine.env", "A=1\n", { created });
  await rollbackCreated([join(dir, "secrets/mine.env")], created);
  await assert.rejects(() => lstat(join(dir, "secrets/mine.env")), /ENOENT/);
  // secrets/ 是本次创建的空目录：可以回滚；但 root 与既有文件必须留下。
  await assert.rejects(() => lstat(join(dir, "secrets")), /ENOENT/);
  assert.equal(await readFile(join(dir, "user-owned.env"), "utf8"), "KEEP=me\n");
  assert.ok((await lstat(dir)).isDirectory(), "root 不应被回滚");
});

test("写秘密不会 chmod 既有 repo 目录（只新建 0700，不改已有目录模式）", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "myrix-vps-mode-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dir = join(base, "out");
  await mkdir(dir, { recursive: true, mode: 0o755 });
  await writeFile(join(dir, "existing.txt"), "user\n", { mode: 0o644 });
  const before = (await stat(dir)).mode & 0o777;
  await generateAll(dir);
  assert.equal((await stat(dir)).mode & 0o777, before, "不得改动既有目录权限");
  // 新建子目录是 0700。
  assert.equal((await stat(join(dir, "secrets"))).mode & 0o777, 0o700);
  assert.equal((await stat(join(dir, "auth"))).mode & 0o777, 0o700);
  assert.equal((await stat(join(dir, "sql"))).mode & 0o777, 0o700);
});

// ---------------------------------------------------------------------------
// 8. CLI：端到端生成 + 覆盖拒绝 + 不打印秘密
// ---------------------------------------------------------------------------

function cliArgs(out) {
  return [
    INIT, "--out", out,
    "--domain", BASE_INPUT.domain,
    "--origin", BASE_INPUT.origin,
    "--bff-image", BASE_INPUT.bffImage,
    "--gateway-image", BASE_INPUT.gatewayImage,
    "--cell-image", BASE_INPUT.cellImage,
    "--keycloak-image", BASE_INPUT.keycloakImage,
    "--upstream-url", BASE_INPUT.upstreamUrl,
    "--upstream-model", BASE_INPUT.upstreamModel,
    "--cells", "1",
  ];
}

test("CLI 端到端生成，stdout 不泄露秘密，二次运行默认拒绝覆盖", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "myrix-vps-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, MYRIX_UPSTREAM_API_KEY: "sk-cli-secret" };
  const first = await run(process.execPath, cliArgs(dir), { env });
  assert.doesNotMatch(first.stdout + first.stderr, /sk-cli-secret/);
  assert.match(first.stdout, /未连接数据库、未部署/);
  assert.match(first.stdout, /issuer=https:\/\/myrix\.example\.com\/auth\/realms\/myrix/);

  const cellEnv = await readFile(join(dir, "secrets", "cell-1.env"), "utf8");
  assert.doesNotMatch(cellEnv, /sk-cli-secret|postgres:\/\//);
  assert.match(cellEnv, /^MYRIX_CELL_ID=cell-1$/m);
  assert.match(cellEnv, /MYRIX_CELL_INTERNAL_HTTP_ORIGINS/);
  // Keycloak 的私有文件也必须生成，且不含上游密钥。
  const keycloakEnv = await readFile(join(dir, "auth", "keycloak.env"), "utf8");
  assert.match(keycloakEnv, /^KC_DB_PASSWORD=\S+$/m);
  assert.doesNotMatch(keycloakEnv, /sk-cli-secret/);
  const realm = JSON.parse(await readFile(join(dir, "auth", "realm-myrix.json"), "utf8"));
  assert.equal(realm.realm, "myrix");

  // 二次运行（无 --force）必须失败，且不覆盖已生成文件。
  await assert.rejects(
    () => run(process.execPath, cliArgs(dir), { env }),
    (error) => {
      assert.match(error.stderr, /拒绝覆盖/);
      assert.doesNotMatch(error.stderr, /sk-cli-secret/);
      return true;
    },
  );
});

test("CLI 明确拒绝 --force，不覆盖也不重建", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "myrix-vps-force-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, MYRIX_UPSTREAM_API_KEY: "sk-cli-secret" };
  await run(process.execPath, cliArgs(dir), { env });
  const before = await readFile(join(dir, ".env"), "utf8");
  await assert.rejects(
    () => run(process.execPath, [...cliArgs(dir), "--force"], { env }),
    (error) => {
      assert.match(error.stderr, /不支持 --force/);
      assert.doesNotMatch(error.stderr, /sk-cli-secret/);
      return true;
    },
  );
  assert.equal(await readFile(join(dir, ".env"), "utf8"), before, "--force 不得改动既有配置");
});

test("CLI 误把 secret 当位置参数时不回显原文", async () => {
  const secret = "sk-positional-should-not-leak";
  await assert.rejects(
    () => run(process.execPath, [INIT, secret], { env: { ...process.env, MYRIX_UPSTREAM_API_KEY: "sk-env-secret" } }),
    (error) => {
      assert.doesNotMatch(error.stderr, new RegExp(secret));
      assert.match(error.stderr, /无法识别的命令行参数/);
      return true;
    },
  );
  // 未知 flag 的取值同样不回显。
  await assert.rejects(
    () => run(process.execPath, [INIT, "--smuggle", secret], { env: { ...process.env, MYRIX_UPSTREAM_API_KEY: "sk-env-secret" } }),
    (error) => {
      assert.doesNotMatch(error.stderr, new RegExp(secret));
      return true;
    },
  );
});

test("parseArgs 不把未知取值/位置参数写进错误信息，且拒绝 --force", () => {
  const secret = "sk-argv-secret-value";
  for (const argv of [[secret], ["--nope", secret], ["positional"], ["--force"]]) {
    assert.throws(() => parseArgs(argv), (error) => {
      assert.ok(error instanceof InitError);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    }, JSON.stringify(argv.map(() => "<redacted>")));
  }
  assert.throws(() => parseArgs(["--force"]), /不支持 --force/);
});

test("auth 装配抛错时错误信息固定 redacted，不传播原始 message", () => {
  assert.throws(
    () => buildDeployment(BASE_INPUT, { auth: () => { throw new Error("secret-looking-internal-detail sk-xyz"); } }),
    (error) => {
      assert.ok(error instanceof InitError);
      assert.doesNotMatch(error.message, /secret-looking-internal-detail|sk-xyz/);
      assert.equal(error.message, ERROR_CODES.authFailure);
      return true;
    },
  );
});

test("CLI 缺少上游密钥时失败且不回显", async () => {
  const args = cliArgs(join(tmpdir(), "myrix-vps-none"));
  const env = { ...process.env };
  delete env.MYRIX_UPSTREAM_API_KEY;
  await assert.rejects(() => run(process.execPath, args, { env }), (error) => {
    assert.match(error.stderr, /MYRIX_UPSTREAM_API_KEY/);
    return true;
  });
});

test("CLI 拒绝 cells>1，并给出可读原因", async () => {
  const dir = await mkdtemp(join(tmpdir(), "myrix-vps-cells-"));
  await rm(dir, { recursive: true, force: true });
  const args = [...cliArgs(dir)];
  args[args.indexOf("--cells") + 1] = "2";
  await assert.rejects(
    () => run(process.execPath, args, { env: { ...process.env, MYRIX_UPSTREAM_API_KEY: "sk-cli-secret" } }),
    (error) => {
      assert.match(error.stderr, /只支持 --cells 1/);
      assert.doesNotMatch(error.stderr, /sk-cli-secret/);
      return true;
    },
  );
});
