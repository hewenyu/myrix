#!/usr/bin/env node
// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0
/**
 * Myrix 单机 VPS 部署初始化器（宿主 Nginx + 同机 Keycloak）。
 *
 * 只做两件事，而且**都不接触真实数据库或网络**：
 *
 *   1. 生成一整套私有配置：ES256 签名密钥/JWKS、独立角色密码、Cell 令牌、
 *      同机 Keycloak 的 realm 导入、KC_* 环境、宿主 Nginx 站点片段、以及
 *      owner UUID/临时口令与 OIDC client secret；
 *   2. 生成一次性 SQL：建角色（含 Keycloak 独立库/低权角色）、迁移后授权、
 *      登记 Cell 凭据摘要、登记唯一 owner 主体。
 *
 * 认证装配复用 `deploy/auth/auth-config.ts` 的 `createAuthConfig()`（另一个
 * 作者维护的接口）：本文件不重新实现 realm/nginx/env 渲染，也不再生成任何
 * Caddy 文件或 `--profile tls` 分支。
 *
 * 明确**不**做的事：
 *   * 不要求用户提供外部 issuer / client secret / owner subject：owner UUID、
 *     临时口令、client secret、Keycloak 库与 admin 口令都由这里随机生成；
 *   * 不 seed 开发身份、不使用开发 launcher、不伪造固定 dev 身份；
 *   * 不连接数据库、不下发迁移、**绝不覆盖任何已有文件**；没有 `--force`，
 *     重建必须换一个新的 `--out` 目录（Keycloak realm 只在首次导入，强制重建
 *     只会破坏已有映射）；
 *   * 不把 upstream key / 数据库连接 / 签名私钥 / OIDC secret 交给 Cell；
 *   * 不在 stdout/stderr 打印任何秘密值，也不回显误传的未知参数/取值。
 *
 * 首版 bootstrap 只支持 **1 Cell / 1 tenant / 1 owner**：`myrix_auth.subjects`
 * 的唯一键是 (issuer, subject)，同一 issuer/sub 向多个租户重复插入会被唯一键
 * 吞掉，因此 `--cells > 1` 被明确拒绝，而不是假装支持多租户切换。
 *
 * 用法见 docs/deployment/self-hosting.md；参数校验失败一律非零退出并只报变量名。
 */
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, open, rmdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * 已验证的双架构 Postgres 索引摘要（17.11-alpine3.24）。
 *
 * 单机部署不允许 `postgres:17-alpine` 这类浮动 tag：升级必须是显式改这一行，
 * 或在 .env 里覆盖 MYRIX_IMAGE_POSTGRES。
 */
export const POSTGRES_IMAGE =
  "docker.io/library/postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24";

/** Cell 内部 HTTP 的精确白名单（与 cell-entry 的校验逐字节一致）。 */
export const CELL_INTERNAL_HTTP_ORIGINS = Object.freeze(["http://bff:8791", "http://gateway:8790"]);

/** 生成物文件名与用途（写权限一律 0600，目录 0700）。 */
export const TARGETS = Object.freeze({
  composeEnv: ".env",
  postgresPassword: "secrets/postgres-superuser-password",
  provisionEnv: "secrets/provision.env",
  migratorEnv: "secrets/migrator.env",
  bffEnv: "secrets/bff.env",
  gatewayEnv: "secrets/gateway.env",
  cellEnv: (cellId) => `secrets/${cellId}.env`,
  keycloakEnv: "auth/keycloak.env",
  realmImport: "auth/realm-myrix.json",
  nginxSite: "auth/nginx-myrix.conf",
  keycloakDbSql: "sql/05_keycloak_db.sql",
  rolesSql: "sql/00_roles.sql",
  grantsSql: "sql/10_grants.sql",
  cellCredentialsSql: "sql/20_cell_credentials.sql",
  identitySql: "sql/30_identity.sql",
});

const SHA40 = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_REPO = "docker.io/hewenyulucky/myrix";
const DEFAULT_OIDC_CLIENT_ID = "myrix-bff";
const DEFAULT_OWNER_USERNAME = "myrix-owner";
const DEFAULT_KEYCLOAK_ADMIN_USERNAME = "myrix-admin";

/** 六个已验收的小说工具；Cell 只允许这些（与 plugins/myrix-novel 契约一致）。 */
export const NOVEL_TOOLS = Object.freeze([
  "get_outline",
  "update_outline",
  "get_chapter",
  "save_chapter_draft",
  "search_bible",
  "update_bible_entry",
]);

export class InitError extends Error {}

/**
 * 固定的 redacted 失败文案。参数校验/文件系统异常一律用这些常量，
 * 绝不把未知 argv 取值、secret、底层 error.message 拼进错误信息。
 */
export const ERROR_CODES = Object.freeze({
  unknownArgument: "存在无法识别的命令行参数；本工具只接受 --help 列出的字段名（不接收位置参数或秘密值）",
  invalidOutRoot: "输出目录不安全；请给出一个真实目录作为 --out（不跟随 symlink）",
  targetExists: "目标目录已存在私有配置；拒绝覆盖。请改用新的 --out 目录（或先自行备份并移走旧目录）",
  unsafeParent: "目标路径的父级不是安全目录（含 symlink/非目录）；拒绝在其下写入秘密",
  unsafeTarget: "目标已存在（含 dangling symlink）；拒绝覆盖既有路径",
  forceRefused: "本工具不支持 --force：已经存在的 Keycloak realm 不会在 startup 重新导入，强制重建只会破坏 owner/realm/秘密映射。请改用新的 --out 目录",
  ioFailure: "写入配置失败：目标不可写或文件系统异常（已 redacted，未回显任何取值）",
  authFailure: "认证装配失败：deploy/auth/auth-config.ts 未接受当前输入或发生内部错误（已 redacted）",
  loadFailure: "无法加载 deploy/auth/auth-config.ts（已 redacted）",
  authContract: "deploy/auth/auth-config.ts 未导出 createAuthConfig（等待 auth 作者/Lead 对齐）",
  missingAuthFactory: "缺少 createAuthConfig：请用 deploy/auth/auth-config.ts 的导出（内部错误）",
});

function fail(message) {
  throw new InitError(message);
}

/** 把任意底层异常折叠成固定 redacted 文案，绝不传播 error.message。 */
function redact(caught, message) {
  return caught instanceof InitError ? caught : new InitError(message);
}

const token = () => randomBytes(32).toString("base64url");
const password = () => randomBytes(24).toString("base64url");

// ---------------------------------------------------------------------------
// 纯函数：参数校验
// ---------------------------------------------------------------------------

/**
 * 校验镜像引用：必须是声明的 Docker Hub 仓库 + `<component>-sha-<40位>` 标签。
 * 组件必须与用途一致；返回 { reference, sha } 以便调用方核对四个镜像同 SHA。
 */
export function validateImage(value, component, field) {
  if (typeof value !== "string" || value.length === 0) fail(`${field} 必填`);
  const match = /^(.+):([^:]+)$/.exec(value.trim());
  if (!match) fail(`${field} 必须是 repo:tag 形式`);
  const [, repo, tag] = match;
  if (repo !== IMAGE_REPO) fail(`${field} 必须来自 ${IMAGE_REPO}，收到其他仓库`);
  const prefix = `${component}-sha-`;
  if (!tag.startsWith(prefix)) fail(`${field} 标签必须是 ${prefix}<40位GitSHA>`);
  const sha = tag.slice(prefix.length);
  if (!SHA40.test(sha)) fail(`${field} 标签的 GitSHA 必须是 40 位小写十六进制`);
  return { reference: `${repo}:${tag}`, sha };
}

/** 四个 Myrix 镜像必须来自同一个完整 commit SHA；错混一律拒绝。 */
export function assertSameImageSha(images) {
  const shas = new Set(Object.values(images).map((image) => image.sha));
  if (shas.size !== 1) {
    const detail = Object.entries(images).map(([name, image]) => `${name}=${image.sha.slice(0, 12)}…`).join(" ");
    fail(`四个 Myrix 镜像（bff/gateway/cell/keycloak）必须同一完整 commit SHA；当前 ${detail}`);
  }
  return [...shas][0];
}

/** 公网 origin 必须是精确 https origin（宿主 Nginx 在 443 终止 TLS）。 */
export function validateOrigin(origin, domain) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    fail("--origin 必须是合法 URL");
  }
  if (url.protocol !== "https:") fail("--origin 在生产 OIDC 模式下必须是 https（BFF 会拒绝 http）");
  if (url.origin !== origin) fail("--origin 必须是精确 origin，不带路径/查询/片段/凭据");
  if (url.port !== "" && url.port !== "443") fail("--origin 只支持默认 443 端口（宿主 Nginx 在 443 终止 TLS）");
  if (typeof domain !== "string" || domain.length === 0) fail("--domain 必填");
  if (domain !== url.hostname) fail("--domain 必须与 --origin 的主机名完全一致");
  return { origin, domain };
}

export function validateUpstream(url, model) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail("--upstream-url 不是合法 URL");
  }
  if (parsed.protocol !== "https:") fail("--upstream-url 必须是 https");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) fail("--upstream-url 不得携带凭据/查询串/片段");
  if (!parsed.pathname.endsWith("/responses")) {
    fail("--upstream-url 必须指向完整的 Responses 端点（以 /responses 结尾）；本仓库禁止 chat/completions");
  }
  if (typeof model !== "string" || model.trim().length === 0) fail("--upstream-model 必填");
  return { url: parsed.toString(), model: model.trim() };
}

/**
 * 首版 bootstrap 只允许 1 个 Cell（= 1 tenant / 1 owner）。
 *
 * 授权数据模型 `myrix_auth.subjects` 以 (issuer, subject) 为主键；同一 issuer
 * 下的同一个 subject 无法同时登记到两个租户（唯一键会吞掉第二条），所以多
 * Cell 会被明确拒绝，而不是默默只让第一个 Cell 能登录。
 */
export function validateCellCount(raw) {
  const count = Number(raw ?? 1);
  if (!Number.isSafeInteger(count) || count < 1) fail("--cells 必须是正整数");
  if (count > 1) {
    fail("首版 bootstrap 只支持 --cells 1（1 tenant / 1 owner）；同一 issuer/sub 无法登记到多个租户");
  }
  return 1;
}

export function validateTenantUuid(raw, uuid = randomUUID) {
  if (raw === undefined || raw === null || raw === "") return uuid();
  if (typeof raw !== "string" || !UUID.test(raw)) fail("--tenant-uuid 必须是 UUID");
  return raw;
}

// ---------------------------------------------------------------------------
// 纯函数：秘密与配置渲染
// ---------------------------------------------------------------------------

/** 造一把 ES256 (P-256) 签名密钥，并导出部署方要分发给 Cell 的公钥 JWK。 */
export function createSigningMaterial({ generateKeyPair = generateKeyPairSync, tokenFactory = token } = {}) {
  const { privateKey, publicKey } = generateKeyPair("ec", { namedCurve: "prime256v1" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const kid = `vps-${tokenFactory().replace(/[^A-Za-z0-9]/g, "").slice(0, 12)}`;
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "ES256", use: "sig" };
  return { pem, kid, jwk };
}

function cellIds(count) {
  return Array.from({ length: count }, (_, index) => `cell-${index + 1}`);
}

/** 只暴露非密事实，供 CLI 输出与测试核对。 */
export function summarizeAuth(authConfig) {
  return {
    realm: authConfig.realm,
    issuer: authConfig.issuer,
    origin: authConfig.origin,
    redirectUri: authConfig.redirectUri,
    keycloakHostPort: authConfig.keycloakHostPort,
    bffHostPort: authConfig.bffHostPort,
    realmImportFileName: authConfig.realmImportFileName,
    image: authConfig.images.keycloak,
  };
}

/**
 * 组装全部配置。返回的结构里既有秘密也有非秘密，调用方负责按文件切分；
 * 这个函数本身不落盘、不打印。
 *
 * @param {object} input - 已解析的参数（见 parseArgs / main）。
 * @param {object} [deps] - 注入点：`auth` 必须是 `createAuthConfig`。
 */
export function buildDeployment(input, {
  now = () => new Date(),
  tokenFactory = token,
  passwordFactory = password,
  uuid = randomUUID,
  signing = createSigningMaterial({ tokenFactory }),
  auth,
} = {}) {
  if (typeof auth !== "function") fail("缺少 createAuthConfig：请用 deploy/auth/auth-config.ts 的导出（内部错误）");
  const bff = validateImage(input.bffImage, "bff", "--bff-image");
  const gateway = validateImage(input.gatewayImage, "gateway", "--gateway-image");
  const cell = validateImage(input.cellImage, "cell", "--cell-image");
  const keycloak = validateImage(input.keycloakImage, "keycloak", "--keycloak-image");
  const commitSha = assertSameImageSha({ bff, gateway, cell, keycloak });

  const { origin, domain } = validateOrigin(input.origin, input.domain);
  const upstream = validateUpstream(input.upstreamUrl, input.upstreamModel);
  if (typeof input.upstreamApiKey !== "string" || input.upstreamApiKey === "") {
    fail("缺少 MYRIX_UPSTREAM_API_KEY：请用环境变量提供，不要放在命令行参数里");
  }
  const contextWindow = Number(input.contextWindow ?? 65536);
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 4096) fail("--context-window 必须是不小于 4096 的整数");
  const count = validateCellCount(input.cells);
  const tenantId = validateTenantUuid(input.tenantUuid, uuid);

  // 单一 owner：同一个 UUID 既是 Keycloak user id（ID Token 的 sub），也是
  // myrix_auth.subjects 的 subject 与业务 members.user_id。
  const ownerSubject = uuid();
  const ownerUsername = input.ownerUsername ?? DEFAULT_OWNER_USERNAME;
  const ownerPassword = passwordFactory();
  const oidcClientSecret = passwordFactory();
  const keycloakDbPassword = passwordFactory();
  const keycloakAdminPassword = passwordFactory();
  const keycloakAdminUsername = input.keycloakAdminUsername ?? DEFAULT_KEYCLOAK_ADMIN_USERNAME;

  const database = { host: "postgres", port: "5432", name: "myrix" };
  const roles = {
    migrator: { name: "myrix_migrator", password: passwordFactory() },
    bff: { name: "myrix_bff", password: passwordFactory() },
    auth: { name: "myrix_auth", password: passwordFactory() },
    gateway: { name: "myrix_gateway", password: passwordFactory() },
  };
  const postgresPassword = passwordFactory();

  const cells = cellIds(count).map((cellId, index) => {
    const cellToken = tokenFactory();
    const serviceToken = tokenFactory();
    return {
      cellId,
      tenantId: index === 0 ? tenantId : uuid(),
      port: 8404,
      baseUrl: `http://${cellId}:8404`,
      cellToken,
      serviceToken,
    };
  });

  const url = (role) => `postgres://${role.name}:${role.password}@${database.host}:${database.port}/${database.name}`;

  // --- 认证装配：完全交给 deploy/auth/auth-config.ts -------------------------
  let authConfig;
  try {
    authConfig = auth({
      domain,
      clientId: input.oidcClientId ?? DEFAULT_OIDC_CLIENT_ID,
      clientSecret: oidcClientSecret,
      ownerId: ownerSubject,
      ownerUsername,
      ownerPassword,
      keycloakDbPassword,
      keycloakAdminUsername,
      keycloakAdminPassword,
      images: { keycloak: keycloak.reference, postgres: POSTGRES_IMAGE },
      // 基底 compose 的网络名是 `myrix`；auth 接口当前只接受 `network`。
      network: "myrix",
      composeAuthMount: "./auth",
      nginxSiteType: input.nginxSiteType ?? "snippet",
      nginxSiteDomain: domain,
      bffHostPort: 8787,
      keycloakHostPort: 18080,
    });
  } catch (error) {
    throw redact(error, ERROR_CODES.authFailure);
  }

  const bffEnv = {
    ...authConfig.bffOidcEnv,
    MYRIX_PORT: "8787",
    MYRIX_WORKS_PORT: "8791",
    MYRIX_STATIC_ROOT: "/app/apps/novel-web/dist",
    DATABASE_URL: url(roles.bff),
    MYRIX_AUTH_DATABASE_URL: url(roles.auth),
    MYRIX_RUNTIME_SIGNING_KEY_PEM: signing.pem,
    MYRIX_RUNTIME_SIGNING_KID: signing.kid,
    MYRIX_RUNTIME_ISSUER: "myrix-control-plane",
    MYRIX_RUNTIME_OUTBOX_ENABLED: "true",
    MYRIX_RUNTIME_JWKS_JSON: JSON.stringify(Object.fromEntries(cells.map((row) => [row.cellId, [signing.jwk]]))),
    MYRIX_RUNTIME_CELLS_JSON: JSON.stringify(cells.map((row) => ({
      tenantId: row.tenantId, cellId: row.cellId, baseUrl: row.baseUrl, serviceToken: row.serviceToken,
    }))),
    MYRIX_CELL_CREDENTIALS: JSON.stringify(cells.map((row) => ({
      tenantId: row.tenantId, cellId: row.cellId, token: row.cellToken,
    }))),
  };

  const gatewayEnv = {
    DATABASE_URL: url(roles.gateway),
    MYRIX_GATEWAY_DATABASE_URL: url(roles.gateway),
    MYRIX_GATEWAY_UPSTREAM_URL: upstream.url,
    MYRIX_GATEWAY_UPSTREAM_MODEL: upstream.model,
    MYRIX_GATEWAY_UPSTREAM_API_KEY: input.upstreamApiKey,
    MYRIX_GATEWAY_MODEL_ALLOWLIST: upstream.model,
  };

  const cellEnvs = Object.fromEntries(cells.map((row) => [row.cellId, {
    MYRIX_CELL_ID: row.cellId,
    MYRIX_TENANT_ID: row.tenantId,
    MYRIX_ISSUER: "myrix-control-plane",
    MYRIX_WORKS_ORIGIN: "http://bff:8791",
    MYRIX_GATEWAY_URL: "http://gateway:8790/v1",
    MYRIX_CELL_INTERNAL_HTTP_ORIGINS: JSON.stringify(CELL_INTERNAL_HTTP_ORIGINS),
    MYRIX_MODEL_PROVIDERS: "myrix-gateway",
    MYRIX_MODELS: upstream.model,
    MYRIX_MODEL_CONTEXT_WINDOW: String(contextWindow),
    MYRIX_ALLOWED_TOOLS: NOVEL_TOOLS.join(","),
    MYRIX_REQUIRE_POLICY: "1",
    MYRIX_GRANT_JWKS: JSON.stringify([signing.jwk]),
    MYRIX_WORKS_TOKEN: row.cellToken,
    MYRIX_GATEWAY_TOKEN: row.cellToken,
    MYRIX_DRAIN_TOKEN: row.serviceToken,
    MYRIX_REVOKE_TOKEN: row.serviceToken,
  }]));

  const provisionEnv = {
    PGHOST: database.host,
    PGPORT: database.port,
    PGUSER: "myrix_admin",
    PGDATABASE: database.name,
    MYRIX_MIGRATOR_PASSWORD: roles.migrator.password,
    MYRIX_BFF_PASSWORD: roles.bff.password,
    MYRIX_AUTH_PASSWORD: roles.auth.password,
    MYRIX_GATEWAY_PASSWORD: roles.gateway.password,
  };

  // 迁移/授权 job 共用同一份迁移角色配置：既给出显式连接串（migrate/auth 用），
  // 也给出 PG* 变量（grants.sh 用 psql 直连，缺 PGPASSWORD 会认证失败）。
  const migratorEnv = {
    PGHOST: database.host,
    PGPORT: database.port,
    PGUSER: roles.migrator.name,
    PGPASSWORD: roles.migrator.password,
    PGDATABASE: database.name,
    MYRIX_MIGRATE_DATABASE_URL: url(roles.migrator),
    MYRIX_GATEWAY_MIGRATE_DATABASE_URL: url(roles.migrator),
    MYRIX_AUTH_ROLE: roles.auth.name,
  };

  const composeEnv = {
    MYRIX_IMAGE_BFF: bff.reference,
    MYRIX_IMAGE_GATEWAY: gateway.reference,
    MYRIX_IMAGE_CELL: cell.reference,
    MYRIX_IMAGE_KEYCLOAK: keycloak.reference,
    MYRIX_IMAGE_POSTGRES: POSTGRES_IMAGE,
    MYRIX_DOMAIN: domain,
  };

  const keycloakEnv = { ...authConfig.keycloakPublicEnv, ...authConfig.keycloakSecretEnv };

  return {
    generatedAt: now().toISOString(),
    commitSha,
    images: {
      bff: bff.reference,
      gateway: gateway.reference,
      cell: cell.reference,
      keycloak: keycloak.reference,
      postgres: POSTGRES_IMAGE,
    },
    origin,
    domain,
    upstream,
    oidc: { issuer: authConfig.issuer, clientId: authConfig.bffOidcEnv.MYRIX_OIDC_CLIENT_ID },
    keycloak: summarizeAuth(authConfig),
    owner: { subject: ownerSubject, username: ownerUsername, tenantId, userId: ownerSubject },
    roles,
    cells,
    files: {
      [TARGETS.composeEnv]: composeEnv,
      [TARGETS.postgresPassword]: postgresPassword,
      [TARGETS.provisionEnv]: provisionEnv,
      [TARGETS.migratorEnv]: migratorEnv,
      [TARGETS.bffEnv]: bffEnv,
      [TARGETS.gatewayEnv]: gatewayEnv,
      [TARGETS.keycloakEnv]: keycloakEnv,
      [TARGETS.realmImport]: authConfig.realmImportJson,
      [TARGETS.nginxSite]: authConfig.nginxSite,
      ...Object.fromEntries(cells.map((row) => [TARGETS.cellEnv(row.cellId), cellEnvs[row.cellId]])),
    },
    sql: {
      [TARGETS.keycloakDbSql]: authConfig.keycloakDbInitSql,
      [TARGETS.rolesSql]: renderRolesSql(provisionEnv),
      [TARGETS.grantsSql]: renderGrantsSql(roles),
      [TARGETS.cellCredentialsSql]: renderCellCredentialSql(cells),
      [TARGETS.identitySql]: renderIdentitySql({
        cells,
        ownerUserId: ownerSubject,
        issuer: authConfig.issuer,
        subject: authConfig.ownerSubject.subject,
        domain,
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// 纯函数：SQL 渲染
// ---------------------------------------------------------------------------

/** 只允许 base64url 形状的秘密进入 SQL 字面量，避免任何引号拼接问题。 */
function psqlLiteral(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    fail("内部错误：生成的秘密必须是 base64url 形状");
  }
  return `'${value}'`;
}

/** 用户提供的值（issuer / subject / domain）进入 SQL 字面量前把单引号翻倍。 */
function sqlString(value) {
  if (typeof value !== "string" || value.includes("\\")) fail("该取值不能包含反斜杠");
  return `'${value.replace(/'/g, "''")}'`;
}

/** 建角色：组角色（迁移脚本会引用）+ 四个独立 LOGIN + 库 owner 转移。 */
export function renderRolesSql(provision) {
  const create = (name, attrs) =>
    `select format('create role %I ${attrs}', '${name}')\n  where not exists (select 1 from pg_roles where rolname = '${name}')\n\\gexec`;
  return `-- 由 deploy/vps/init.mjs 生成；仅供一次性 provision 以超级用户执行。
-- 不 seed 任何开发身份；不授予运行角色任何特权。
\\set ON_ERROR_STOP on

-- 迁移脚本（packages/platform-store / apps/model-gateway）会引用这两个组角色。
${create("myrix_app", "nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls")}
${create("myrix_gateway_app", "nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls")}

-- 迁移角色：库 owner + CREATEROLE（PostgreSQL 16 起还需要 ADMIN OPTION 才能改角色）。
${create("myrix_migrator", "login createrole nosuperuser nobypassrls nocreatedb")}

-- 运行角色：真实 LOGIN、非 owner、非特权、不可建库建角色。
${create("myrix_bff", "login nosuperuser nobypassrls nocreatedb nocreaterole")}
${create("myrix_auth", "login nosuperuser nobypassrls nocreatedb nocreaterole")}
${create("myrix_gateway", "login nosuperuser nobypassrls nocreatedb nocreaterole")}

-- 密码始终与当前 env 文件对齐（重跑 provision 会重置为文件里的值）。
alter role myrix_migrator with login password ${psqlLiteral(provision.MYRIX_MIGRATOR_PASSWORD)};
alter role myrix_bff with login password ${psqlLiteral(provision.MYRIX_BFF_PASSWORD)};
alter role myrix_auth with login password ${psqlLiteral(provision.MYRIX_AUTH_PASSWORD)};
alter role myrix_gateway with login password ${psqlLiteral(provision.MYRIX_GATEWAY_PASSWORD)};

-- 角色成员关系：运行角色只继承应用组角色；迁移角色持有 ADMIN OPTION。
grant myrix_app to myrix_migrator with admin option;
grant myrix_gateway_app to myrix_migrator with admin option;
grant myrix_app to myrix_bff;
grant myrix_app to myrix_gateway;
grant myrix_gateway_app to myrix_gateway;

-- 库 owner 是迁移角色，运行角色既不是 owner 也不是其成员。
alter database ${provision.PGDATABASE} owner to myrix_migrator;
`;
}

/** 迁移之后的低权授权：auth schema（migrateAuth 之外再显式收口一次，幂等）。 */
export function renderGrantsSql(roles) {
  return `-- 由 deploy/vps/init.mjs 生成；在迁移之后以 migrator 角色执行（幂等）。
\\set ON_ERROR_STOP on

grant myrix_app to ${roles.bff.name};
grant myrix_app to ${roles.gateway.name};
grant myrix_gateway_app to ${roles.gateway.name};

-- 认证 schema 单独授权给认证 LOGIN：运行期不能登记 IdP 主体。
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'myrix_auth') then
    execute 'grant usage on schema myrix_auth to ${roles.auth.name}';
    execute 'grant select, insert, delete on myrix_auth.sessions, myrix_auth.flows to ${roles.auth.name}';
    execute 'grant select on myrix_auth.subjects to ${roles.auth.name}';
  end if;
end
$$;
`;
}

/** Cell 凭据登记：只写 SHA-256 摘要，明文令牌永不进数据库/日志。 */
export function renderCellCredentialSql(cells) {
  return cells.map((cell) => `-- ${cell.cellId}（tenant ${cell.tenantId}）：令牌摘要登记
begin;
select set_config('myrix_gateway.tenant_id', ${sqlString(cell.tenantId)}, true);
insert into myrix_gateway.cell_credentials (token_hash, tenant_id, cell_id, status, revoked_at)
values (${sqlString(sha256Hex(cell.cellToken))}, ${sqlString(cell.tenantId)}, ${sqlString(cell.cellId)}, 'active', null)
on conflict (token_hash) do update set status = 'active', revoked_at = null
where myrix_gateway.cell_credentials.tenant_id = excluded.tenant_id
  and myrix_gateway.cell_credentials.cell_id = excluded.cell_id;
commit;
`).join("\n");
}

/**
 * 唯一租户/成员/OIDC 主体：owner UUID 同时是 Keycloak sub 与业务 user id。
 *
 * 首版只有一个 Cell，所以这里只写一个租户；多 Cell 在
 * {@link validateCellCount} 就被拒绝，绝不会用 `on conflict` 假装登记成功。
 */
export function renderIdentitySql({ cells, ownerUserId, issuer, subject, domain }) {
  const base = domain.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 54) || "myrix";
  const blocks = cells.map((cell, index) => {
    const slug = cells.length === 1 ? base : `${base}-${index + 1}`;
    return `-- ${cell.cellId} 的租户（${cell.tenantId}）：租户、属主成员与唯一 OIDC 主体
begin;
-- FORCE RLS 对 owner 同样生效，因此显式设置租户上下文。
select set_config('myrix.tenant_id', ${sqlString(cell.tenantId)}, true);
insert into tenants (id, slug, name, status)
values (${sqlString(cell.tenantId)}, ${sqlString(slug)}, ${sqlString(slug)}, 'active')
on conflict (id) do nothing;
insert into members (tenant_id, user_id, role, status, display_name)
values (${sqlString(cell.tenantId)}, ${sqlString(ownerUserId)}, 'admin', 'active', 'Owner')
on conflict (tenant_id, user_id) do nothing;
-- 显式登记同一个 owner UUID：Keycloak 的 sub 与业务 user id 必须是它。
-- 首版单租户，所以不存在同一 (issuer, subject) 指向第二个租户的冲突。
insert into myrix_auth.subjects (issuer, subject, tenant_id, user_id)
values (${sqlString(issuer)}, ${sqlString(subject)}, ${sqlString(cell.tenantId)}, ${sqlString(ownerUserId)})
on conflict (issuer, subject) do update set tenant_id = excluded.tenant_id, user_id = excluded.user_id;
commit;
`;
  });
  return `-- 由 deploy/vps/init.mjs 生成；以 migrator 角色在迁移之后执行（幂等）。
-- owner 的 Keycloak sub 与业务 user id 是同一个 UUID。
\\set ON_ERROR_STOP on
${blocks.join("\n")}`;
}

// ---------------------------------------------------------------------------
// 纯函数：env 文件序列化
// ---------------------------------------------------------------------------

/** non-printable 控制字符（含 CR）在 env 文件里没有可靠表示，直接拒绝。 */
const ENV_FORBIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f]/;

/**
 * 序列化一个 env 赋值，规则与 `docker compose` 的 env_file 解析一致
 * （已用真实 `docker compose config` 逐项验证，见 tests/vps/init.test.mjs）：
 *
 *   * 无特殊字符的裸值原样输出；
 *   * 含空白/`"`/`'`/`#`/`\`/`$`/` 时用双引号包裹；
 *   * 包裹时将 `\` 转义为 `\\`、`"` 转义为 `\"`，并把 LF 表示为 `\n`；
 *   * **`$` 必须转义为 `\$`**：compose 会对 env_file 做插值（`$VAR`/`${VAR}`），
 *     不转义的上游 API key 会在 compose 侧被替身/清空；
 *   * CR 与控制字符没有可靠转义，明确 fail-closed 而不是静默损坏。
 *
 * 用户提供的取值只做“能否安全表达”的判断，不等于信任其内容。
 */
export function envLine(key, value) {
  const text = String(value);
  if (ENV_FORBIDDEN.test(text)) {
    fail(`无法安全序列化 ${key} 的取值（含控制字符）；拒绝生成可能损坏的 env 文件`);
  }
  if (!/[\s"'#\\$`]/.test(text) && text.length > 0) return `${key}=${text}`;
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/\n/g, "\\n");
  return `${key}="${escaped}"`;
}

export function renderEnvFile(record, header) {
  const lines = [`# ${header}`, "# 由 deploy/vps/init.mjs 生成；权限 0600；不要提交到版本库。"];
  for (const key of Object.keys(record).sort()) lines.push(envLine(key, record[key]));
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// 落盘：0700 独占目录 + 0600 独占文件，任何情况下不覆盖
// ---------------------------------------------------------------------------
//
// 威胁边界（见 README/ADR 0029）：本工具防范“仓库/宿主上已有同名文件或
// symlink 导致秘密写到 root 外或被覆盖”，**不防范 VPS root**，也不是完整抗
// 恶意宿主方案。刻意不做的、未测试的 race 边界：
//   * 检查与 write 之间存在 TOCTOU：preflight/lstat 之后、open 之前，攻击者
//     若能在同一 UID 下替换父级目录为 symlink，仍可能重定向写入。缓解依赖
//     `open(..., 'wx')` 的独占创建（绝不覆盖已存在目标）和目录 0700 的去竞争，
//     本仓库没有做基于 dirfd 的逐段 openat/O_NOFOLLOW 加固；
//   * 单机同 UID 的另一进程在 preflight 后抢建同名文件会被 'wx' 拒绝，但
//     抢建目录（同名空目录）会被当作合法父级接受；
//   * 不检查磁盘配额/写满、不 fsync 父目录、不做跨设备检测。
// 这些边界在 tests/vps/init.test.mjs 的“未测试 race 边界”注释中同步记录。

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function insideRoot(root, absolute) {
  const rel = relative(root, absolute);
  return rel === "" || (!rel.startsWith(".." + sep) && rel !== "..");
}

/** 解析并校验：目标必须严格位于显式输出 root 之内。 */
function resolveInsideRoot(root, relativePath) {
  const absolute = resolve(root, relativePath);
  if (!insideRoot(root, absolute)) fail(`拒绝写入越界路径 ${relativePath}`);
  return absolute;
}

async function lstatOrNull(absolute) {
  try {
    return await lstat(absolute);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw redact(error, ERROR_CODES.ioFailure);
  }
}

/**
 * 输出 root 是显式安全边界：root **自身**必须是不存在的路径或真实目录——
 * symlink（含 dangling）root 一律拒绝，避免顺着链接把秘密写到边界之外。
 * root **之上**的祖先不检查（例如 macOS `/var -> /private/var` 这类系统别名，
 * 或调用方自己用 symlink 指的父目录），那属于 root 之外，不应误判。
 * root 不存在时只在其父级（跟随 symlink）确实是目录的前提下新建 0700。
 */
async function ensureRootDirectory(root, created) {
  const existing = await lstatOrNull(root);
  if (existing) {
    if (!existing.isDirectory()) fail(ERROR_CODES.invalidOutRoot);
    return;
  }
  const parent = dirname(root);
  if (parent === root) fail(ERROR_CODES.invalidOutRoot);
  const parentStat = await stat(parent).catch(() => null);
  if (!parentStat || !parentStat.isDirectory()) fail(ERROR_CODES.invalidOutRoot);
  try {
    await mkdir(root, { mode: 0o700 });
    created.push(root);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      const raced = await lstatOrNull(root);
      if (raced && raced.isDirectory()) return;
      fail(ERROR_CODES.invalidOutRoot);
    }
    throw redact(error, ERROR_CODES.ioFailure);
  }
}

/** 确保目录存在且每层都是“本次独立创建的真实目录（0700）”。 */
async function ensureOwnedDirectory(dir, created) {
  const existing = await lstatOrNull(dir);
  if (existing) {
    if (!existing.isDirectory()) fail(ERROR_CODES.unsafeParent);
    return;
  }
  const parent = dirname(dir);
  if (parent !== dir) await ensureOwnedDirectory(parent, created);
  try {
    await mkdir(dir, { mode: 0o700 });
    created.push(dir);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      // 竞态：别的进程刚创建。再 lstat 一次，只接受真实目录，且不据为己有（不回滚它）。
      const raced = await lstatOrNull(dir);
      if (raced && raced.isDirectory()) return;
      fail(ERROR_CODES.unsafeParent);
    }
    throw redact(error, ERROR_CODES.ioFailure);
  }
}

/**
 * 写一个 0600 文件，**只允许新建**。
 *
 * `force: true` 一律 fail-closed（见 {@link ERROR_CODES.forceRefused}）。
 * 路径上的父级目录若不存在则由本次创建（0700）；已存在的父级必须是真实目录，
 * symlink/普通文件/悬空链接都会在写入前拒绝。创建过的目录记录在 `created`
 * 中，供调用方在后续失败时只回滚自己创建的部分。
 */
export async function writeSecure(root, relativePath, content, { force = false, created = [] } = {}) {
  if (force) fail(ERROR_CODES.forceRefused);
  const resolvedRoot = resolve(root);
  const absolute = resolveInsideRoot(resolvedRoot, relativePath);
  await ensureRootDirectory(resolvedRoot, created);
  const parent = dirname(absolute);
  if (parent !== resolvedRoot) {
    if (!insideRoot(resolvedRoot, parent)) fail(`拒绝写入越界路径 ${relativePath}`);
    await ensureOwnedDirectory(parent, created);
  }
  let handle;
  try {
    handle = await open(absolute, "wx", 0o600);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      fail(ERROR_CODES.targetExists);
    }
    throw redact(error, ERROR_CODES.ioFailure);
  }
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    // 这是本次 'wx' 独占创建的文件，可以安全删除，避免留下半套配置。
    await rm(absolute, { force: true }).catch(() => {});
    throw redact(error, ERROR_CODES.ioFailure);
  } finally {
    await handle.close().catch(() => {});
  }
  return absolute;
}

/**
 * 写第一份秘密之前的 preflight：一次性检查**全部**目标与 root 内父级路径。
 *
 *   * root 必须是不存在的路径，或已存在的真实目录（symlink root 一律拒绝）；
 *   * 目标：`lstat`（不是 `stat`）——已有的普通文件、目录、symlink（含 dangling）
 *     全部拒绝；
 *   * 父级：root 内每一层必须是不存在或真实目录，symlink 父级拒绝；
 *   * 只读检查，不修改任何已有路径（合法既有 repo 目录不会被 chmod）。
 *
 * 纯检查，不创建任何路径：目录创建推迟到 {@link writeSecure}。
 */
export async function preflightTargets(root, relatives) {
  const resolvedRoot = resolve(root);
  const rootStat = await lstatOrNull(resolvedRoot);
  if (rootStat && !rootStat.isDirectory()) fail(ERROR_CODES.invalidOutRoot);

  for (const relativePath of relatives) {
    const absolute = resolveInsideRoot(resolvedRoot, relativePath);
    if (!insideRoot(resolvedRoot, absolute)) fail(`拒绝写入越界路径 ${relativePath}`);
    const existing = await lstatOrNull(absolute);
    if (existing) fail(`${ERROR_CODES.unsafeTarget}（${relativePath}）`);
    // 自 root 起逐级检查父级：绝不 traversing symlink，也绝不检查 root 之外。
    const relDir = relative(resolvedRoot, dirname(absolute));
    if (relDir === "" || relDir === ".") continue;
    let current = resolvedRoot;
    for (const segment of relDir.split(sep).filter((part) => part !== "")) {
      current = join(current, segment);
      const parentStat = await lstatOrNull(current);
      if (parentStat && !parentStat.isDirectory()) fail(ERROR_CODES.unsafeParent);
    }
  }
  return { created: [] };
}

/**
 * 兼容旧调用名；`force` 现在一律拒绝（保留导出只是为了让旧调用点/测试
 * 明确报错而不是静默换行为）。
 */
export async function assertAbsentOrForced(root, relatives, force = false) {
  if (force) fail(ERROR_CODES.forceRefused);
  return preflightTargets(root, relatives);
}

/**
 * 只回滚“本次运行创建”的文件与目录，绝不删除任何既有用户文件。
 *
 * 只有当文件确实是本次写出的（记录了绝对路径）才 unlink；目录只有在本进程
 * 亲手创建（{@link ensureOwnedDirectory} 记录）且为空时才 rmdir。任何删除失败
 * 都被吞掉——回滚尽力而为，绝不掩盖最初的失败原因。
 */
export async function rollbackCreated(createdFiles, createdDirs) {
  for (const file of [...createdFiles].reverse()) {
    await rm(file, { force: true }).catch(() => {});
  }
  for (const dir of [...createdDirs].reverse()) {
    await rmdir(dir).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * 解析 CLI 参数。
 *
 * fail-closed：遇到位置参数（不以 `--` 开头）或未知 flag 一律拒绝，且**绝不把
 * 未知取值拼进错误信息**——用户可能误把 secret 当 argv，回显即泄漏。提示只列
 * 出允许的字段名，便于对照。
 */
export function parseArgs(argv) {
  const flags = new Map();
  const allowed = new Set([
    "out", "domain", "origin", "bff-image", "gateway-image", "cell-image", "keycloak-image",
    "upstream-url", "upstream-model", "context-window", "tenant-uuid", "cells",
    "nginx-site-type", "force", "help",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (typeof item !== "string" || !item.startsWith("--")) {
      // 不回显 item：位置参数很可能就是误传的 secret。
      fail(ERROR_CODES.unknownArgument);
    }
    const name = item.slice(2);
    if (!allowed.has(name)) fail(ERROR_CODES.unknownArgument);
    if (name === "force") {
      // 明确拒绝（比未知参数更可读的可读原因）；不静默忽略，也不进入 flags。
      fail(ERROR_CODES.forceRefused);
    }
    if (name === "help") {
      flags.set(name, true);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`--${name} 缺少取值`);
    flags.set(name, value);
    index += 1;
  }
  return flags;
}

const USAGE = `用法：node deploy/vps/init.mjs --domain HOST --origin https://HOST \\
  --bff-image ${IMAGE_REPO}:bff-sha-<40hex> \\
  --gateway-image ${IMAGE_REPO}:gateway-sha-<40hex> \\
  --cell-image ${IMAGE_REPO}:cell-sha-<40hex> \\
  --keycloak-image ${IMAGE_REPO}:keycloak-sha-<40hex> \\
  --upstream-url https://provider/v1/responses --upstream-model MODEL \\
  [--cells 1] [--tenant-uuid UUID] [--context-window 65536] \\
  [--nginx-site-type snippet|server] [--out DIR]

四个 Myrix 镜像必须是同一个完整 commit SHA。

本工具不提供 --force：Keycloak realm 只在启动时首次导入，强制重建只会破坏
已有 owner/realm/秘密映射。要重新生成，请换一个新的 --out 目录。

秘密只从环境变量读取，绝不经过命令行参数：
  MYRIX_UPSTREAM_API_KEY        上游 Responses 密钥（只写入 secrets/gateway.env）

其余秘密（owner UUID/临时口令、OIDC client secret、Keycloak 库口令与
bootstrap admin 口令）都由本初始化器随机生成，不经过命令行也不需要用户提供。`;

/** 动态加载 createAuthConfig；接口暂时不可用时给出可读的阻塞说明。 */
export async function loadAuthFactory() {
  let module;
  try {
    module = await import(pathToFileURL(join(REPO_ROOT, "deploy/auth/auth-config.ts")).href);
  } catch (error) {
    // 不回显底层 error.message：未知模块/语法/加载错误文本不传播给用户。
    throw redact(error, ERROR_CODES.loadFailure);
  }
  if (typeof module.createAuthConfig !== "function") fail(ERROR_CODES.authContract);
  return module.createAuthConfig;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.get("help")) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const out = resolve(flags.get("out") ?? join(dirname(fileURLToPath(import.meta.url))));
  const createAuthConfig = await loadAuthFactory();
  const deployment = buildDeployment({
    domain: flags.get("domain"),
    origin: flags.get("origin"),
    bffImage: flags.get("bff-image"),
    gatewayImage: flags.get("gateway-image"),
    cellImage: flags.get("cell-image"),
    keycloakImage: flags.get("keycloak-image"),
    upstreamUrl: flags.get("upstream-url"),
    upstreamModel: flags.get("upstream-model"),
    contextWindow: flags.get("context-window"),
    upstreamApiKey: process.env.MYRIX_UPSTREAM_API_KEY,
    tenantUuid: flags.get("tenant-uuid"),
    cells: flags.get("cells"),
    nginxSiteType: flags.get("nginx-site-type"),
  }, { auth: createAuthConfig });

  const envFiles = Object.keys(deployment.files);
  const sqlFiles = Object.keys(deployment.sql);
  const allTargets = [...envFiles, ...sqlFiles];
  // 一次性 preflight：写第一份秘密前拒绝任何已有目标/非目录或 symlink 父级。
  await preflightTargets(out, allTargets);

  const createdDirs = [];
  const createdFiles = [];
  try {
    for (const [relativePath, record] of Object.entries(deployment.files)) {
      const body = typeof record === "string" ? record : renderEnvFile(record, relativePath);
      const absolute = await writeSecure(out, relativePath, body, { created: createdDirs });
      createdFiles.push(absolute);
    }
    for (const [relativePath, body] of Object.entries(deployment.sql)) {
      const absolute = await writeSecure(out, relativePath, body, { created: createdDirs });
      createdFiles.push(absolute);
    }
  } catch (error) {
    // 只回滚本次创建的文件/目录；既有用户文件绝不删除。
    await rollbackCreated(createdFiles, createdDirs);
    throw error;
  }

  process.stdout.write(
    `Myrix VPS 配置已生成于 ${out}\n`
    + `  origin=${deployment.origin} cells=${deployment.cells.length} tenant=${deployment.owner.tenantId}\n`
    + `  issuer=${deployment.oidc.issuer} image-sha=${deployment.commitSha}\n`
    + `  已写入 ${envFiles.length} 个 env/秘密文件（0600）与 ${sqlFiles.length} 个一次性 SQL\n`
    + "  未连接数据库、未部署、未打印任何秘密。下一步见 docs/deployment/self-hosting.md。\n",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // 只输出固定 redacted 文案：不传播未知 argv 取值/secret/底层异常细节。
    process.stderr.write(`${error instanceof InitError ? error.message : ERROR_CODES.ioFailure}\n`);
    process.exitCode = 1;
  });
}
