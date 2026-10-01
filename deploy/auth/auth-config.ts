// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0
/**
 * Myrix 单机 VPS 认证装配 —— **纯 config 工厂**（Keycloak + 宿主 Nginx）。
 *
 * 本版部署边界（覆盖早期"Caddy 容器"设计）：
 *   - TLS / 路由由**宿主上既有的 Nginx** 负责，本仓库不引入 Caddy、不生成 Caddyfile、
 *     不声明 `caddy` 服务、没有端口模式分支，也没有任何 Caddy 兼容层；
 *   - Keycloak 是 CI 预构建的 **immutable 生产镜像**（`keycloak-sha-<40hex>` 或 `@sha256:`），
 *     `kc.sh build` 只在 GitHub Actions 里跑；容器**启动时绝不 build**；
 *   - Keycloak 只发布宿主回环 `127.0.0.1:18080 -> 8080`，管理端口 9000 不发布；
 *     BFF 仍是 `127.0.0.1:8787`。两者都只能经宿主 Nginx 到达。
 *
 * 契约来源（不得改动，改动即破坏登录）：
 *   - `apps/bff/src/oidc.ts`：redirect_uri = `new URL("/api/v1/auth/callback", origin)`，
 *     scope = `openid profile`，Authorization Code + PKCE(S256) + state + nonce，
 *     且 `config.serverMetadata().issuer !== options.issuer` 直接报错 —— 所以
 *     `MYRIX_OIDC_ISSUER` 必须与 Keycloak 实际发布的 issuer **逐字节相等**。
 *     注意：issuer 含 `/auth`（Keycloak 公网基础路径），而浏览器 origin 不含路径。
 *     Keycloak 26.8 **不会**把 `KC_HTTP_RELATIVE_PATH` 自动拼进 `KC_HOSTNAME`，
 *     所以 `KC_HOSTNAME` 必须是含 `/auth` 的完整 URL；只给裸 origin 会让 discovery
 *     发布缺少 `/auth` 的 issuer，BFF 会拒绝启动。
 *   - `apps/bff/src/config.ts`：OIDC 模式要求 HTTPS origin、`MYRIX_OIDC_ISSUER` 为
 *     HTTPS URL、`MYRIX_DEV_USERS` 必须不存在。
 *   - `apps/bff/src/auth.ts` / `apps/bff/src/auth-store.ts`：
 *     `resolveSubject(claims.iss, claims.sub)` 只查 `myrix_auth.subjects`，不自动开户。
 *   - `apps/bff/src/server.ts`：`GET /api/v1/sessions/:sessionId/events` 是 SSE
 *     （`text/event-stream`），反向代理必须关闭缓冲。
 *
 * 本模块**不读环境变量、不写文件、不拉镜像、不连网络、不开服务、不做真实域名/证书操作**。
 * 所有镜像引用由调用方显式固定；本模块没有 `latest`、没有默认 tag、没有隐式回退。
 */

export type NginxSiteType = "server" | "snippet";

/** Keycloak 容器内端口（9042 之类不在此列：只有 HTTP 与服务账号无关的管理端口）。 */
export const KEYCLOAK_HTTP_PORT = 8080;
/** 管理端口（health/ready 在此）：**绝不发布到宿主**。 */
export const KEYCLOAK_MANAGEMENT_PORT = 9000;
/** Keycloak 的可写数据目录；read-only rootfs 下必须挂 tmpfs，import 以只读子挂载。 */
export const KEYCLOAK_DATA_DIR = "/opt/keycloak/data";
export const KEYCLOAK_IMPORT_DIR = `${KEYCLOAK_DATA_DIR}/import`;
/**
 * Keycloak 的公网基础路径。必须与 CI 镜像 `kc.sh build` 时的
 * `KC_HTTP_RELATIVE_PATH` 逐字节一致（`deploy/images/Dockerfile.keycloak`）。
 *
 * 关键：Keycloak **不会**把 `KC_HTTP_RELATIVE_PATH` 自动拼进 `KC_HOSTNAME`。
 * 因此规范 Keycloak 基础 URL（`keycloakBaseUrl`）必须显式带上该路径，
 * 否则 discovery 的 `issuer` 会退化成 `https://<domain>/realms/<realm>`（缺 `/auth`），
 * 与 BFF 期望的 `MYRIX_OIDC_ISSUER` 不匹配，`createOidcAdapter` 会拒绝启动。
 */
export const KEYCLOAK_BASE_PATH = "/auth";

export interface AuthImagePins {
  /**
   * CI 预构建的 immutable 生产镜像。例：
   *   `docker.io/hewenyulucky/myrix:keycloak-sha-<40hex>`
   *   `docker.io/hewenyulucky/myrix@sha256:<64hex>`
   * 没有默认值；不接受 `latest`，也不要求镜像名形如 `keycloak:<semver>`。
   */
  readonly keycloak: string;
  /** 例：`postgres:17.6-alpine`。宿主既有 postgres 容器所用镜像，由 Lead 定义。 */
  readonly postgres: string;
}

export interface CreateAuthConfigInput {
  /** 裸 FQDN，无 scheme/端口/路径，例：`br.example.test`。 */
  readonly domain: string;
  readonly clientId: string;
  /** BFF 用的 confidential client secret；Keycloak 侧同一值。 */
  readonly clientSecret: string;
  /** 初始 owner 的 Keycloak user id，同时就是 ID Token 的 `sub`（确定 UUID）。 */
  readonly ownerId: string;
  readonly ownerUsername: string;
  /** 临时密码；首次登录强制更换。 */
  readonly ownerPassword: string;
  /** 已有 postgres 容器里独立 `keycloak` 库的专用低权角色密码，仅 Keycloak 知道。 */
  readonly keycloakDbPassword: string;
  /** master realm bootstrap admin（管理面不暴露公网）。 */
  readonly keycloakAdminUsername: string;
  readonly keycloakAdminPassword: string;
  readonly images: AuthImagePins;

  readonly ownerEmail?: string;
  readonly ownerFirstName?: string;
  readonly ownerLastName?: string;
  /** 固定为 `myrix`；提供该字段只是为了在代码里显式化，任何其它值都会被拒绝。 */
  readonly realm?: string;

  readonly keycloakService?: string;
  readonly postgresService?: string;
  /**
   * 基底编排里创建独立 Keycloak 库/角色的一次性 job（`deploy/vps/compose.yml`
   * 的 `provision`）。Keycloak 必须等它成功退出后才能连库，否则会以
   * `FATAL: role "keycloak" does not exist` 反复重启。默认 `provision`。
   */
  readonly provisionService?: string;
  /** 宿主 BFF 回环端口（`deploy/vps/compose.yml` 固定 8787）。 */
  readonly bffHostPort?: number;
  /** 宿主 Keycloak HTTP 回环端口。默认 18080。 */
  readonly keycloakHostPort?: number;
  /** Keycloak 发布绑定的宿主地址；只允许回环（默认 `127.0.0.1`）。 */
  readonly keycloakBindHost?: string;

  /** `server` = 可直接放进 sites-available/conf.d 的完整站点；`snippet` = 放进已有 server 块。 */
  readonly nginxSiteType?: NginxSiteType;
  /**
   * 写入 nginxSite 的站点名。**默认是占位符** `MYRIX_PUBLIC_DOMAIN`（不是一个真实域名）；
   * Lead 集成时显式传入真实 FQDN，或对生成文件做占位符替换。
   */
  readonly nginxSiteDomain?: string;
  /** ACME HTTP-01 的 webroot（默认 `/var/www/html`）。 */
  readonly nginxAcmeWebroot?: string;
  /** 证书目录（默认 `/etc/letsencrypt/live/<站点名>`）；不由本模块生成或读取任何私钥。 */
  readonly nginxTlsDirectory?: string;
  /** SSE 前缀（默认 `/api/v1/sessions/`，对应 apps/bff/src/server.ts 的事件路由）。 */
  readonly ssePathPrefix?: string;
  /** 追加的公网拒绝前缀（默认已含 `/auth/admin` 与 `/auth/realms/master`）。 */
  readonly extraDeniedPaths?: readonly string[];

  readonly keycloakDb?: string;
  readonly keycloakDbUser?: string;
  /** 若 Keycloak 库角色/库名与这些名字冲突则拒绝装配。 */
  readonly reservedDbUsers?: readonly string[];
  /** 与 `deploy/vps/compose.yml` 同名（默认 `myrix`）。 */
  readonly network?: string;
  /**
   * 是否在片段里重复声明该网络。默认 false：基底 compose 已声明 `myrix`
   * （`name: myrix-vps`），片段再声明会覆盖其 `name`，所以只在独立使用时打开。
   */
  readonly declareNetwork?: boolean;
  readonly sessionTtlSeconds?: number;
  readonly accessTokenLifespanSeconds?: number;
  readonly passwordPolicy?: string;
  /** 生成的 realm/env/sql 在 compose 里的相对挂载目录（默认 `./auth`）。 */
  readonly composeAuthMount?: string;
}

export interface RealmImportUserCredential {
  readonly type: "password";
  readonly value: string;
  readonly temporary: true;
}

export interface RealmImportUser {
  readonly id: string;
  readonly username: string;
  readonly enabled: true;
  readonly emailVerified: true;
  readonly email?: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly requiredActions: readonly ["UPDATE_PASSWORD"];
  readonly credentials: readonly RealmImportUserCredential[];
  readonly realmRoles: readonly string[];
}

export interface RealmImportClient {
  readonly clientId: string;
  readonly name: string;
  readonly enabled: true;
  readonly protocol: "openid-connect";
  readonly publicClient: false;
  readonly bearerOnly: false;
  readonly standardFlowEnabled: true;
  readonly implicitFlowEnabled: false;
  readonly directAccessGrantsEnabled: false;
  readonly serviceAccountsEnabled: false;
  readonly consentRequired: false;
  readonly redirectUris: readonly string[];
  readonly webOrigins: readonly string[];
  readonly secret: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly defaultClientScopes: readonly string[];
  readonly optionalClientScopes: readonly string[];
}

export interface RealmImport {
  readonly realm: string;
  readonly enabled: true;
  readonly registrationAllowed: false;
  readonly resetPasswordAllowed: boolean;
  readonly loginWithEmailAllowed: boolean;
  readonly duplicateEmailsAllowed: false;
  readonly editUsernameAllowed: false;
  readonly verifyEmail: false;
  readonly sslRequired: "external";
  readonly bruteForceProtected: true;
  readonly permanentLockout: false;
  readonly failureFactor: number;
  readonly waitIncrementSeconds: number;
  readonly quickLoginCheckMilliSeconds: number;
  readonly minimumQuickLoginWaitSeconds: number;
  readonly maxFailureWaitSeconds: number;
  readonly maxDeltaTimeSeconds: number;
  readonly passwordPolicy: string;
  readonly accessTokenLifespan: number;
  readonly ssoSessionIdleTimeout: number;
  readonly ssoSessionMaxLifespan: number;
  readonly clients: readonly RealmImportClient[];
  readonly users: readonly RealmImportUser[];
}

/** 纯数据（JSON 可序列化），由 Lead 合并进 `deploy/vps/compose.yml`。 */
export interface ComposeFragment {
  readonly services: Record<string, Record<string, unknown>>;
  readonly networks: Record<string, Record<string, never>>;
}

export interface AuthBootstrap {
  /**
   * 与 `start` 完全相同的 argv，仅为兼容早期调用方而保留。
   *
   * Keycloak 的 startup import 是**创建**语义：realm 已存在就跳过，不会覆盖用户/密码。
   * 因此**不需要**再用 `docker compose run --rm keycloak ...` 做一次阻塞的一次性导入，
   * 常规 `up -d` 的启动命令本身就会在首次缺库时导入。
   */
  readonly importRealm: readonly string[];
  /**
   * 唯一启动命令：`start --optimized --import-realm`，与 Lead 的
   * `deploy/images/Dockerfile.keycloak` 的 `CMD` 一致；任何容器都不做 `build`。
   */
  readonly start: readonly string[];
}

export interface AuthArtifacts {
  readonly realmImport: string;
  readonly keycloakEnv: string;
  readonly bffOidcEnv: string;
  readonly keycloakDbInitSql: string;
  /** 宿主 Nginx 站点文件的建议落点（由 Lead 集成，不在本仓库）。 */
  readonly nginxSite: string;
}

export interface AuthConfig {
  readonly realm: string;
  readonly images: AuthImagePins;
  readonly domain: string;
  /** 浏览器可见的站点 origin（无路径），用于 `MYRIX_ORIGIN` / `webOrigins` / 回调。 */
  readonly origin: string;
  /**
   * Keycloak 公网基础 URL，**含** `/auth` 相对路径：`<origin>/auth`。它是
   * Keycloak 发布 issuer 与授权/token/JWKS 端点的基础，绝不等于浏览器 origin。
   */
  readonly keycloakBaseUrl: string;
  /** 规范化 OIDC issuer：`<keycloakBaseUrl>/realms/<realm>`，必须逐字节等于发现结果。 */
  readonly issuer: string;
  readonly redirectUri: string;
  readonly webOrigins: readonly string[];
  readonly nginxSite: string;
  readonly nginxSiteType: NginxSiteType;
  readonly deniedPaths: readonly string[];
  readonly keycloakHostPort: number;
  readonly bffHostPort: number;
  readonly realmImport: RealmImport;
  readonly realmImportJson: string;
  readonly realmImportFileName: string;
  readonly keycloakPublicEnv: Readonly<Record<string, string>>;
  readonly keycloakSecretEnv: Readonly<Record<string, string>>;
  readonly keycloakDbInitSql: string;
  readonly bffOidcEnv: Readonly<Record<string, string>>;
  readonly ownerSubject: { readonly issuer: string; readonly subject: string };
  readonly compose: ComposeFragment;
  readonly bootstrap: AuthBootstrap;
  readonly artifacts: AuthArtifacts;
  readonly notes: readonly string[];
}

/* ------------------------------------------------------------------ */
/* 校验：错误信息一律不得回显任何 secret 值                            */
/* ------------------------------------------------------------------ */

const DOMAIN = /^(?=.{4,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENT = /^[a-z][a-z0-9_]{0,62}$/;
const SERVICE = /^[a-z][a-z0-9_-]{0,62}$/;
const USERNAME = /^[a-z][a-z0-9._-]{2,63}$/;
/** 同时作用于 Keycloak DB 密码 / client secret / 临时密码：JSON、YAML、env_file、
 *  form-urlencoded、SQL 单引号字面量、以及 `postgres://user:pass@host` 都无需转义。 */
const SAFE_SECRET = /^[A-Za-z0-9._~!=-]{16,200}$/;
const IMAGE_DENY_TAGS = new Set(["latest", "stable", "main", "master", "edge", "dev", "rolling", "nightly", "current"]);
/** 仓库/路径部分 + 可选的 `@sha256:` 摘要；tag 单独校验。 */
const IMAGE_BASE = /^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$/;
/** 只允许回环：IdP 绝不发布到公网接口。 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
/** 站点名占位符：不是一个真实域名，必须由 Lead 替换。 */
const DEFAULT_SITE_NAME = "MYRIX_PUBLIC_DOMAIN";

/** 声明为 function（带显式 `: never`）才能让 TS 在调用点完成收窄。 */
function fail(message: string): never {
  throw new Error(message);
}

function assertSecret(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE_SECRET.test(value)) {
    // 绝不回显 value。
    fail(`${field} must be 16-200 chars of [A-Za-z0-9._~!=-]; whitespace, quotes, '$', '#', '@', '/', ':' and '\\' are rejected`);
  }
  return value;
}

function assertIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENT.test(value)) fail(`${field} must match ^[a-z][a-z0-9_]{0,62}$`);
  return value;
}

function assertServiceName(value: unknown, field: string): string {
  if (typeof value !== "string" || !SERVICE.test(value)) fail(`${field} must match ^[a-z][a-z0-9_-]{0,62}$`);
  return value;
}

function assertUsername(value: unknown, field: string): string {
  if (typeof value !== "string" || !USERNAME.test(value)) fail(`${field} must match ^[a-z][a-z0-9._-]{2,63}$`);
  return value;
}

function assertUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) fail(`${field} must be a canonical UUID (it becomes the OIDC sub claim)`);
  return value;
}

function assertPort(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 65535) fail(`${field} must be an integer port`);
  return value as number;
}

function assertLoopbackHost(value: unknown, field: string): string {
  if (typeof value !== "string" || !LOOPBACK_HOSTS.has(value)) {
    fail(`${field} must be a loopback address (127.0.0.1 or ::1): the IdP must never be published on a public interface`);
  }
  return value;
}

function assertSiteName(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 253 || /[\s"'{};#\\]/.test(value)) {
    fail(`${field} must be a non-empty nginx server_name token without whitespace or nginx metacharacters`);
  }
  return value;
}

function assertPathPrefix(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 200 || /[\s"'{};#\\]/.test(value)) {
    fail(`${field} must be an absolute path prefix without whitespace or nginx metacharacters`);
  }
  return value;
}

/** 版本由 Lead/环境提供且必须显式固定：没有默认值，也没有 `latest`。 */
function assertPinnedImage(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 300 || /[\s"'<>]/.test(value)) {
    fail(`${field} must be a fully qualified image reference with an explicit version tag or sha256 digest`);
  }
  const reference = value as string;
  const atIndex = reference.indexOf("@");
  const digest = atIndex >= 0 ? reference.slice(atIndex + 1) : undefined;
  const withTag = atIndex >= 0 ? reference.slice(0, atIndex) : reference;
  if (digest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(digest)) {
    fail(`${field} digest must be exactly 'sha256:' + 64 lowercase hex characters`);
  }
  // registry 端口（`registry:5000/img`）与 tag 用最后一个 '/' 之后的第一个 ':' 区分。
  const lastSlash = withTag.lastIndexOf("/");
  const colon = withTag.indexOf(":", lastSlash);
  const base = colon >= 0 ? withTag.slice(0, colon) : withTag;
  const tag = colon >= 0 ? withTag.slice(colon + 1) : undefined;
  if (!IMAGE_BASE.test(base) || base.length > 255 || base.includes("//")) {
    fail(`${field} has an invalid registry/repository portion`);
  }
  if (tag !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(tag) || tag.endsWith(".") || tag.endsWith("-"))) {
    fail(`${field} has an invalid tag`);
  }
  if (digest === undefined) {
    if (tag === undefined) fail(`${field} must pin an exact version tag or a sha256 digest (no implicit tag is allowed)`);
    if (IMAGE_DENY_TAGS.has(tag.toLowerCase())) fail(`${field} must not use the floating tag '${tag}'`);
    // major 或 major.minor（如 `2` / `2.10`）同样视为浮动。
    if (/^\d+(\.\d+)?$/.test(tag)) fail(`${field} must pin at least a full patch version tag (or a sha256 digest)`);
  }
  return reference;
}

function assertDomain(value: unknown, field: string): string {
  if (typeof value !== "string" || !DOMAIN.test(value)) {
    fail(`${field} must be a lowercase FQDN without scheme, port, trailing dot or wildcard`);
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(value as string)) fail(`${field} must be a DNS name, not an IP literal`);
  return value as string;
}

/* ------------------------------------------------------------------ */
/* 渲染辅助（纯字符串，不含 I/O）                                      */
/* ------------------------------------------------------------------ */

function renderKeycloakEnvFile(config: AuthConfig, options: { readonly redact?: boolean } = {}): string {
  const redact = options.redact === true;
  const secretKeys = new Set(Object.keys(config.keycloakSecretEnv));
  const lines: string[] = [];
  for (const [key, value] of Object.entries({ ...config.keycloakPublicEnv, ...config.keycloakSecretEnv })) {
    lines.push(`${key}=${redact && secretKeys.has(key) ? "<redacted>" : value}`);
  }
  return `${lines.join("\n")}\n`;
}

/** 只暴露"非密"事实，用于文档、日志与人工核对。 */
function describeAuthConfig(config: AuthConfig): Readonly<Record<string, unknown>> {
  return Object.freeze({
    realm: config.realm,
    domain: config.domain,
    origin: config.origin,
    keycloakBaseUrl: config.keycloakBaseUrl,
    issuer: config.issuer,
    redirectUri: config.redirectUri,
    webOrigins: config.webOrigins,
    nginxSiteType: config.nginxSiteType,
    deniedPaths: config.deniedPaths,
    keycloakHostPort: config.keycloakHostPort,
    bffHostPort: config.bffHostPort,
    keycloakImage: config.compose.services.keycloak?.image,
    ownerSubject: config.ownerSubject,
    registrationAllowed: config.realmImport.registrationAllowed,
    directAccessGrantsEnabled: config.realmImport.clients[0]?.directAccessGrantsEnabled,
    standardFlowEnabled: config.realmImport.clients[0]?.standardFlowEnabled,
    temporaryOwnerPassword: config.realmImport.users[0]?.credentials[0]?.temporary,
    requiredActions: config.realmImport.users[0]?.requiredActions,
  });
}

/* ------------------------------------------------------------------ */
/* 主体：宿主 Nginx 站点                                               */
/* ------------------------------------------------------------------ */

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 生成**通用**站点配置：不含任何真实域名默认值（默认站点名是占位符
 * `MYRIX_PUBLIC_DOMAIN`），也**不读取、不生成、不校验任何证书或私钥**。
 *
 * 路由（顺序即优先级，拒绝规则必须排在最前）：
 *   /auth/admin/**            -> 404（永不代理到 Keycloak 管理面）
 *   /auth/realms/master/**    -> 404（master realm 不含 BFF 需要的东西）
 *   /auth  /auth/**           -> 127.0.0.1:18080（Keycloak）
 *   /api/v1/auth/callback     -> 精确回调，显式列出（虽然也会落到 BFF）
 *   /api/v1/sessions/**       -> BFF，且 `proxy_buffering off`（SSE）
 *   其它                      -> 127.0.0.1:8787（BFF）
 */
/** 一条 `location` 块：`body` 是**未缩进**的指令行，渲染时统一补一级缩进。 */
interface NginxBlock {
  readonly key: string;
  readonly head: string | undefined;
  readonly comment: string | undefined;
  readonly body: readonly string[];
}

function renderNginxBlock(block: NginxBlock, indent: string): string {
  const lines: string[] = [];
  if (block.comment) lines.push(`${indent}# ${block.comment}`);
  lines.push(`${indent}${block.head} {`);
  for (const line of block.body) lines.push(line === "" ? "" : `${indent}\t${line}`);
  lines.push(`${indent}}`);
  return lines.join("\n");
}

function renderNginxSite(input: {
  readonly type: NginxSiteType;
  readonly serverName: string;
  readonly keycloakHostPort: number;
  readonly bffHostPort: number;
  readonly ssePathPrefix: string;
  readonly acmeWebroot: string;
  readonly tlsDirectory: string;
  readonly deniedPaths: readonly string[];
}): string {
  const { type, serverName, keycloakHostPort, bffHostPort, ssePathPrefix, acmeWebroot, tlsDirectory, deniedPaths } = input;
  const keycloak = `http://127.0.0.1:${keycloakHostPort}`;
  const bff = `http://127.0.0.1:${bffHostPort}`;

  // 逐行列出，禁止把客户端伪造的转发链原样透传：
  //   - X-Forwarded-Proto 由本机固定为 https（不取 $scheme，也不取客户端头）；
  //   - X-Forwarded-For 用 $remote_addr 覆盖，而不是 $proxy_add_x_forwarded_for。
  const forwarded = [
    "proxy_set_header Host $host;",
    "proxy_set_header X-Forwarded-Proto https;",
    "proxy_set_header X-Forwarded-Host $host;",
    "proxy_set_header X-Forwarded-For $remote_addr;",
    'proxy_set_header Connection "";',
  ];

  // 顺序即优先级：拒绝规则必须排在 /auth 超集之前。
  const deny_blocks = deniedPaths.map((path): NginxBlock => ({
    key: `deny:${path}`,
    head: `location ~ ^${escapeRegex(path)}(\/|$)`,
    comment: "公网永不可达。",
    body: ["return 404;"],
  }));

  const proxy_blocks: readonly NginxBlock[] = [
    { key: "auth-exact", head: "location = /auth", comment: undefined, body: [`proxy_pass ${keycloak};`] },
    { key: "auth-prefix", head: "location /auth/", comment: "Keycloak：/realms/...、/resources/...、登录动作必须可达。", body: [`proxy_pass ${keycloak};`] },
    { key: "callback", head: "location = /api/v1/auth/callback", comment: "BFF 精确回调（apps/bff/src/oidc.ts 固定该路径）。", body: [`proxy_pass ${bff};`] },
    {
      key: "sse",
      head: `location ^~ ${ssePathPrefix}`,
      comment: "SSE：apps/bff/src/server.ts 的 text/event-stream，必须关缓冲。",
      body: [`proxy_pass ${bff};`, "proxy_buffering off;", "proxy_cache off;", "proxy_read_timeout 1h;"],
    },
    { key: "fallback", head: "location /", comment: "其余全部交给 BFF。", body: [`proxy_pass ${bff};`] },
  ];

  const preamble = [
    "# 由 deploy/auth/auth-config.ts 生成；集成说明见 deploy/auth/README.md。",
    `# 不含真实域名默认值：站点名占位符为 ${DEFAULT_SITE_NAME}，集成前必须替换为真实 FQDN。`,
    "# 刻意关闭 access log：/api/v1/auth/callback 的查询串携带一次性 authorization code，",
    "# 访问日志会把令牌写进磁盘 —— 需要日志时请自行加脱敏方案，不要直接打开 access log。",
    "# 证书由宿主既有的 ACME/证书流程管理；本文件不读取、不生成任何私钥。",
    "",
  ];

  if (type === "snippet") {
    // 片段不能依赖外层 server 级指令，因此每个代理 location 自带转发头。
    const snippetBody = [
      ...deny_blocks.map(block => renderNginxBlock(block, "\t")),
      "",
      ...proxy_blocks.map(block =>
        renderNginxBlock({ ...block, body: [...block.body, "", ...forwarded] }, "\t"),
      ),
    ];
    return `${[
      ...preamble,
      "# 片段模式：把下面的 location 块放进宿主 Nginx 已有的 server {} 内；",
      "# 不含监听端口、TLS 证书、站点名与 80→443 跳转指令，这些由宿主配置负责。",
      "",
      ...snippetBody,
    ].join("\n")}\n`;
  }

  const httpsServer = [
    "server {",
    "\tlisten 443 ssl;",
    "\tlisten [::]:443 ssl;",
    "\t# http2 on;  # nginx >= 1.25.1 打开；旧版本用 `listen 443 ssl http2;`",
    `\tserver_name ${serverName};`,
    "",
    `\tssl_certificate     ${tlsDirectory}/fullchain.pem;`,
    `\tssl_certificate_key ${tlsDirectory}/privkey.pem;`,
    "\tssl_protocols TLSv1.2 TLSv1.3;",
    "\tssl_prefer_server_ciphers off;",
    "\tserver_tokens off;",
    "",
    "\t# 不记录访问日志（回调查询串含一次性授权码）。",
    "\taccess_log off;",
    "",
    '\tadd_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;',
    '\tadd_header X-Content-Type-Options "nosniff" always;',
    '\tadd_header Referrer-Policy "no-referrer" always;',
    "",
    "\t# server 级转发头由所有 location 继承；想收紧就退化成 snippet 模式自己写。",
    ...forwarded.map(line => `\t${line}`),
    "",
    ...deny_blocks.map(block => renderNginxBlock(block, "\t")),
    "",
    ...proxy_blocks.map(block => renderNginxBlock(block, "\t")),
    "}",
  ];

  const httpServer = [
    "server {",
    "\tlisten 80;",
    "\tlisten [::]:80;",
    `\tserver_name ${serverName};`,
    "\tserver_tokens off;",
    "",
    "\t# ACME HTTP-01 挑战：必须在 80→443 跳转之前放行。",
    "\tlocation ^~ /.well-known/acme-challenge/ {",
    `\t\troot ${acmeWebroot};`,
    '\t\tdefault_type "text/plain";',
    "\t\ttry_files $uri =404;",
    "\t}",
    "",
    "\t# 其余全部永久跳转到 HTTPS（用字面站点名，避免 Host 头注入的开放重定向）。",
    `\tlocation / {\n\t\treturn 301 https://${serverName}$request_uri;\n\t}`,
    "}",
  ];

  return `${[...preamble, ...httpServer, "", ...httpsServer].join("\n")}\n`;
}

/* ------------------------------------------------------------------ */
/* 主体：Keycloak realm 导入 JSON                                      */
/* ------------------------------------------------------------------ */

function buildRealmImport(input: {
  readonly realm: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly origin: string;
  readonly ownerId: string;
  readonly ownerUsername: string;
  readonly ownerPassword: string;
  readonly ownerEmail?: string;
  readonly ownerFirstName?: string;
  readonly ownerLastName?: string;
  readonly passwordPolicy: string;
  readonly accessTokenLifespan: number;
  readonly sessionTtlSeconds: number;
}): RealmImport {
  const user: RealmImportUser = {
    id: input.ownerId,
    username: input.ownerUsername,
    enabled: true,
    // 单机首版没有 SMTP：绝不能挂 VERIFY_EMAIL，否则首次登录会走进死胡同。
    emailVerified: true,
    ...(input.ownerEmail ? { email: input.ownerEmail } : {}),
    ...(input.ownerFirstName ? { firstName: input.ownerFirstName } : {}),
    ...(input.ownerLastName ? { lastName: input.ownerLastName } : {}),
    requiredActions: ["UPDATE_PASSWORD"],
    credentials: [{ type: "password", value: input.ownerPassword, temporary: true }],
    realmRoles: [`default-roles-${input.realm}`],
  };
  const client: RealmImportClient = {
    clientId: input.clientId,
    name: "Myrix BFF",
    enabled: true,
    protocol: "openid-connect",
    publicClient: false,
    bearerOnly: false,
    standardFlowEnabled: true,
    implicitFlowEnabled: false,
    // ROPC 关闭：BFF 只走 Authorization Code + PKCE，不接受直接拿密码换 token。
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false,
    consentRequired: false,
    redirectUris: [input.redirectUri],
    webOrigins: [input.origin],
    secret: input.clientSecret,
    attributes: {
      // openid-client 的 ClientSecretPost + calculatePKCECodeChallenge。
      "pkce.code.challenge.method": "S256",
      "token.endpoint.auth.method": "client_secret_post",
    },
    defaultClientScopes: ["openid", "profile"],
    optionalClientScopes: [],
  };
  return {
    realm: input.realm,
    enabled: true,
    registrationAllowed: false,
    resetPasswordAllowed: false,
    loginWithEmailAllowed: true,
    duplicateEmailsAllowed: false,
    editUsernameAllowed: false,
    verifyEmail: false,
    sslRequired: "external",
    bruteForceProtected: true,
    permanentLockout: false,
    failureFactor: 10,
    waitIncrementSeconds: 60,
    quickLoginCheckMilliSeconds: 1000,
    minimumQuickLoginWaitSeconds: 60,
    maxFailureWaitSeconds: 900,
    maxDeltaTimeSeconds: 43200,
    passwordPolicy: input.passwordPolicy,
    accessTokenLifespan: input.accessTokenLifespan,
    ssoSessionIdleTimeout: 1800,
    ssoSessionMaxLifespan: input.sessionTtlSeconds,
    clients: [client],
    users: [user],
  };
}

/* ------------------------------------------------------------------ */
/* 主体：PostgreSQL 独立库初始化 SQL                                   */
/* ------------------------------------------------------------------ */

/**
 * 在**宿主已有的 postgres 容器/实例**上创建 Keycloak 专用库与低权 LOGIN。
 *
 * 部署编排（`deploy/vps/compose.yml`）走的是显式 `provision` 一次性 job：
 * keycloak 依赖它 `service_completed_successfully`，**不是**应用启动时自动迁移。
 * 本 SQL 只是**单独手工**执行时的等价示例，必须用专用 PG 管理员连接串
 * （业务迁移角色 `myrix_migrator` 没有 CREATEDB，且按职责分离不得承载 IdP 库）。
 */
function renderKeycloakDbInitSql(db: string, user: string, password: string): string {
  return `-- 由 deploy/auth/auth-config.ts 生成：Keycloak 专用库与专用低权角色。
-- 部署路径：由基底 compose 的显式 provision 一次性 job 创建（keycloak 依赖它成功退出），
--   不是应用启动时自动迁移。
-- 单独手工执行的示例（必须用**专用 PG 管理员连接串**，不要用业务迁移角色 myrix_migrator，
--   它没有 CREATEDB，且业务迁移角色按职责分离不得承载 IdP 库）：
--   psql "$MYRIX_PG_ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f keycloak-db-init.sql
-- SECURITY: 本文件明文包含数据库密码。
--   1) 写到被 .gitignore 覆盖的路径（例如 deploy/auth/generated/），权限 0600；
--   2) 绝不提交、绝不进镜像层、绝不进 CI 日志，用完即删；
--   3) 该口令只有 Keycloak 服务知道，BFF / Cell / gateway 不得复用该角色。

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${user}') THEN
    CREATE ROLE ${user} LOGIN PASSWORD '${password}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  ELSE
    ALTER ROLE ${user} WITH LOGIN PASSWORD '${password}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

-- CREATE DATABASE 不能出现在事务/DO 块里，用 psql 的 \\gexec 处理幂等。
SELECT 'CREATE DATABASE ${db} OWNER ${user}'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${db}')\\gexec

ALTER DATABASE ${db} OWNER TO ${user};
REVOKE ALL ON DATABASE ${db} FROM PUBLIC;
GRANT CONNECT ON DATABASE ${db} TO ${user};
`;
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 生成 Keycloak realm 导入 JSON、宿主 Nginx 站点、Keycloak 独立环境与 Compose 片段。
 * 纯函数：同样入参永远得到同样输出；不触碰文件系统、网络、时钟或环境变量。
 */
export function createAuthConfig(input: CreateAuthConfigInput): AuthConfig {
  const domain = assertDomain(input?.domain, "domain");
  const clientId = typeof input.clientId === "string" && input.clientId.length > 0 && input.clientId.length <= 200
    ? input.clientId
    : fail("clientId is required");
  const clientSecret = assertSecret(input.clientSecret, "clientSecret");
  const ownerId = assertUuid(input.ownerId, "ownerId");
  const ownerUsername = assertUsername(input.ownerUsername, "ownerUsername");
  const ownerPassword = assertSecret(input.ownerPassword, "ownerPassword");
  const keycloakDbPassword = assertSecret(input.keycloakDbPassword, "keycloakDbPassword");
  const keycloakAdminUsername = assertUsername(input.keycloakAdminUsername, "keycloakAdminUsername");
  const keycloakAdminPassword = assertSecret(input.keycloakAdminPassword, "keycloakAdminPassword");

  if (input.images === undefined || input.images === null) fail("images (keycloak/postgres) must be provided explicitly");
  const keycloakImage = assertPinnedImage(input.images.keycloak, "images.keycloak");
  const postgresImage = assertPinnedImage(input.images.postgres, "images.postgres");

  const realm = input.realm ?? "myrix";
  if (realm !== "myrix") fail("realm must be exactly 'myrix'");

  const keycloakService = assertServiceName(input.keycloakService ?? "keycloak", "keycloakService");
  const postgresService = assertServiceName(input.postgresService ?? "postgres", "postgresService");
  if (keycloakService === postgresService) fail("keycloakService and postgresService must be distinct");
  // 基底（deploy/vps/compose.yml）确有这个一次性 provision job：它建 Keycloak 专用库/角色。
  const provisionService = assertServiceName(input.provisionService ?? "provision", "provisionService");
  if (provisionService === keycloakService || provisionService === postgresService) {
    fail("provisionService must be distinct from keycloakService and postgresService");
  }
  const bffHostPort = assertPort(input.bffHostPort ?? 8787, "bffHostPort");
  const keycloakHostPort = assertPort(input.keycloakHostPort ?? 18080, "keycloakHostPort");
  if (bffHostPort === keycloakHostPort) fail("bffHostPort and keycloakHostPort must be distinct");
  const keycloakBindHost = assertLoopbackHost(input.keycloakBindHost ?? "127.0.0.1", "keycloakBindHost");

  const keycloakDb = assertIdentifier(input.keycloakDb ?? "keycloak", "keycloakDb");
  const keycloakDbUser = assertIdentifier(input.keycloakDbUser ?? "keycloak", "keycloakDbUser");
  const reserved = ["postgres", ...(input.reservedDbUsers ?? [])];
  if (reserved.includes(keycloakDbUser)) fail("keycloakDbUser must be a dedicated role, not a shared/administrative one");
  if (reserved.includes(keycloakDb)) fail("keycloakDb must be a dedicated database, not a shared/administrative one");

  const sessionTtlSeconds = input.sessionTtlSeconds ?? 28800;
  if (!Number.isSafeInteger(sessionTtlSeconds) || sessionTtlSeconds < 60 || sessionTtlSeconds > 86400) {
    fail("sessionTtlSeconds must be between 60 and 86400 (apps/bff/src/config.ts contract)");
  }
  const accessTokenLifespan = input.accessTokenLifespanSeconds ?? 300;
  if (!Number.isSafeInteger(accessTokenLifespan) || accessTokenLifespan < 60 || accessTokenLifespan > 3600) {
    fail("accessTokenLifespanSeconds must be between 60 and 3600");
  }
  const passwordPolicy = input.passwordPolicy ?? "length(14) and notUsername and notEmail and passwordHistory(5)";

  const network = assertServiceName(input.network ?? "myrix", "network");
  const authMount = input.composeAuthMount ?? "./auth";
  if (typeof authMount !== "string" || authMount.length === 0 || authMount.length > 200 || /[\s"']/.test(authMount)) {
    fail("composeAuthMount must be a non-empty relative or absolute path without whitespace or quotes");
  }

  const nginxSiteType: NginxSiteType = input.nginxSiteType ?? "server";
  if (nginxSiteType !== "server" && nginxSiteType !== "snippet") fail("nginxSiteType must be 'server' or 'snippet'");
  // 默认是占位符而不是真实域名：生成物可安全地进仓库/文档。
  const siteName = assertSiteName(input.nginxSiteDomain ?? DEFAULT_SITE_NAME, "nginxSiteDomain");
  const acmeWebroot = assertPathPrefix(input.nginxAcmeWebroot ?? "/var/www/html", "nginxAcmeWebroot");
  const tlsDirectory = assertPathPrefix(input.nginxTlsDirectory ?? `/etc/letsencrypt/live/${siteName}`, "nginxTlsDirectory");
  const ssePathPrefix = assertPathPrefix(input.ssePathPrefix ?? "/api/v1/sessions/", "ssePathPrefix");

  // origin 是浏览器可见的站点根（无路径）；keycloakBaseUrl 才是 Keycloak 的公网
  // 基础 URL，必须显式带上 KC_HTTP_RELATIVE_PATH=/auth。二者是不同概念：
  // webOrigins/redirectUri/回调用 origin，issuer 与 Keycloak 端点用 keycloakBaseUrl。
  const origin = `https://${domain}`;
  const keycloakBaseUrl = `${origin}${KEYCLOAK_BASE_PATH}`;
  const issuer = `${keycloakBaseUrl}/realms/${realm}`;
  const redirectUri = `${origin}/api/v1/auth/callback`;
  const deniedPaths = ["/auth/admin", "/auth/realms/master", ...(input.extraDeniedPaths ?? [])].map(path =>
    assertPathPrefix(path, "deniedPaths"),
  );

  const nginxSite = renderNginxSite({
    type: nginxSiteType,
    serverName: siteName,
    keycloakHostPort,
    bffHostPort,
    ssePathPrefix,
    acmeWebroot,
    tlsDirectory,
    deniedPaths,
  });

  const realmImport = buildRealmImport({
    realm, clientId, clientSecret, redirectUri, origin, ownerId, ownerUsername, ownerPassword,
    ...(input.ownerEmail ? { ownerEmail: input.ownerEmail } : {}),
    ...(input.ownerFirstName ? { ownerFirstName: input.ownerFirstName } : {}),
    ...(input.ownerLastName ? { ownerLastName: input.ownerLastName } : {}),
    passwordPolicy, accessTokenLifespan, sessionTtlSeconds,
  });

  const keycloakPublicEnv: Record<string, string> = {
    KC_DB: "postgres",
    KC_DB_URL: `jdbc:postgresql://${postgresService}:5432/${keycloakDb}`,
    KC_DB_USERNAME: keycloakDbUser,
    KC_HTTP_ENABLED: "true",
    // 与 CI 镜像 build-time 值一致（deploy/images/Dockerfile.keycloak）。
    KC_HTTP_RELATIVE_PATH: KEYCLOAK_BASE_PATH,
    // 管理面（health/metrics）独立端口与根相对路径；9000 不发布到宿主。
    KC_HTTP_MANAGEMENT_RELATIVE_PATH: "/",
    // 必须是**完整基础 URL 且含 /auth**：Keycloak 26.8 不会把 KC_HTTP_RELATIVE_PATH
    // 自动拼进 KC_HOSTNAME，只给 origin 会让 discovery 发布
    // https://<domain>/realms/<realm>（缺 /auth），与 BFF 的 MYRIX_OIDC_ISSUER 不符。
    KC_HOSTNAME: keycloakBaseUrl,
    KC_PROXY_HEADERS: "xforwarded",
    KC_HEALTH_ENABLED: "true",
    KC_HTTP_PORT: String(KEYCLOAK_HTTP_PORT),
    KC_METRICS_ENABLED: "false",
    KC_LOG_LEVEL: "INFO",
  };
  const keycloakSecretEnv: Record<string, string> = {
    KC_DB_PASSWORD: keycloakDbPassword,
    KC_BOOTSTRAP_ADMIN_USERNAME: keycloakAdminUsername,
    KC_BOOTSTRAP_ADMIN_PASSWORD: keycloakAdminPassword,
  };

  const keycloakServiceDefinition: Record<string, unknown> = {
    image: keycloakImage,
    restart: "unless-stopped",
    // 官方/预构建镜像本就以 UID 1000 运行；这里显式固定，避免镜像默认值漂移。
    user: "1000:1000",
    read_only: true,
    cap_drop: ["ALL"],
    security_opt: ["no-new-privileges:true"],
    // 唯一启动命令，与 Lead 的 Dockerfile.keycloak CMD 一致：首次启动导入 realm，
    // 之后因 startup import 的"已存在则跳过"语义而不覆盖任何用户/密码，也绝不 build。
    command: ["start", "--optimized", "--import-realm"],
    environment: { ...keycloakPublicEnv, ...keycloakSecretEnv },
    // read-only rootfs 下必须可写：Quarkus 需要 /tmp，Keycloak 需要 data（含 import 的父目录）。
    tmpfs: [
      "/tmp:rw,noexec,nosuid,size=64m,mode=1777",
      `${KEYCLOAK_DATA_DIR}:rw,noexec,nosuid,size=64m,mode=0700,uid=1000,gid=1000`,
    ],
    volumes: [`${authMount}/realm-${realm}.json:${KEYCLOAK_IMPORT_DIR}/realm-${realm}.json:ro`],
    // 只发布到宿主回环：公网只能经宿主 Nginx 的 /auth/ 到达。管理端口 9000 绝不发布。
    ports: [`${keycloakBindHost === "::1" ? "[::1]" : keycloakBindHost}:${keycloakHostPort}:${KEYCLOAK_HTTP_PORT}`],
    networks: [network],
    // 基底确有一次性 provision job：它创建独立 Keycloak 库/角色。Keycloak 必须等
    // postgres 健康 **且** provision 成功退出后才能启动，否则角色不存在会启动失败。
    depends_on: {
      [postgresService]: { condition: "service_healthy" },
      [provisionService]: { condition: "service_completed_successfully" },
    },
    // pids 必须写在 deploy 里：与顶层 pids_limit 并存会让 compose 直接报错。
    deploy: { resources: { limits: { cpus: "1.50", memory: "1g", pids: 1024 } } },
    healthcheck: {
      // 健康检查问管理端口（9000，容器内），不经过 Nginx 也不发布到宿主。
      // Require HTTP 200, not a substring: a DOWN response can contain an UP sub-check.
      // $$ survives Compose interpolation; bash/read/test need no curl or grep package.
      test: ["CMD", "/bin/bash", "-ec", `exec 3<>/dev/tcp/127.0.0.1/${KEYCLOAK_MANAGEMENT_PORT}; printf 'GET /health/ready HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n' >&3; read -r protocol status remainder <&3; test "$$status" = 200`],
      interval: "10s",
      timeout: "5s",
      retries: 18,
      start_period: "90s",
    },
  };

  const compose: ComposeFragment = {
    services: { [keycloakService]: keycloakServiceDefinition },
    // 与基底同名时不再声明：基底已经用 `name: myrix-vps` 固定了真实网络名，
    // 片段重复声明会把 `name` 覆盖掉。
    networks: input.declareNetwork === true ? { [network]: {} } : {},
  };

  const config: AuthConfig = {
    realm, domain, origin, keycloakBaseUrl, issuer, redirectUri, webOrigins: [origin],
    images: Object.freeze({ keycloak: keycloakImage, postgres: postgresImage }),
    nginxSite, nginxSiteType, deniedPaths, keycloakHostPort, bffHostPort,
    realmImport,
    realmImportJson: `${JSON.stringify(realmImport, null, 2)}\n`,
    realmImportFileName: `realm-${realm}.json`,
    keycloakPublicEnv,
    keycloakSecretEnv,
    keycloakDbInitSql: renderKeycloakDbInitSql(keycloakDb, keycloakDbUser, keycloakDbPassword),
    bffOidcEnv: {
      MYRIX_AUTH_MODE: "oidc",
      MYRIX_ORIGIN: origin,
      MYRIX_OIDC_ISSUER: issuer,
      MYRIX_OIDC_CLIENT_ID: clientId,
      MYRIX_OIDC_CLIENT_SECRET: clientSecret,
      MYRIX_BIND_HOST: "0.0.0.0",
      MYRIX_PORT: String(bffHostPort),
      MYRIX_SESSION_TTL_SECONDS: String(sessionTtlSeconds),
    },
    ownerSubject: { issuer, subject: ownerId },
    compose,
    bootstrap: {
      // 与 compose.command 及 Dockerfile.keycloak CMD 完全一致。
      // startup import 对已存在的 realm 是跳过语义，所以日常重启同样安全，无需分开两条命令。
      start: ["start", "--optimized", "--import-realm"],
      // 兼容保留：与 start 同 argv，无需再单独阻塞式 run。
      importRealm: ["start", "--optimized", "--import-realm"],
    },
    artifacts: {
      realmImport: `${authMount}/${`realm-${realm}.json`}`,
      keycloakEnv: `${authMount}/keycloak.env`,
      bffOidcEnv: `${authMount}/bff-oidc.env`,
      keycloakDbInitSql: `${authMount}/keycloak-db-init.sql`,
      nginxSite: "/etc/nginx/conf.d/myrix-auth.conf",
    },
    notes: [
      `公共 issuer 必须逐字节等于 ${issuer}（apps/bff/src/oidc.ts 会拒绝不匹配的 issuer）。`,
      `Keycloak 基础 URL（含相对路径）是 ${keycloakBaseUrl}：KC_HOSTNAME 必须给出完整 URL，Keycloak 不会自动拼上 KC_HTTP_RELATIVE_PATH。`,
      `浏览器 origin 仍是 ${origin}（不含路径）：webOrigins 与 MYRIX_ORIGIN 用它，issuer/授权/token/JWKS 用 ${keycloakBaseUrl}。`,
      `BFF 回调固定为 ${redirectUri}，由 apps/bff/src/oidc.ts 从 MYRIX_ORIGIN 推导，不接受转发头。`,
      `Keycloak 只发布宿主回环 ${keycloakBindHost}:${keycloakHostPort} -> ${KEYCLOAK_HTTP_PORT}；管理端口 ${KEYCLOAK_MANAGEMENT_PORT} 不发布。`,
      `宿主 Nginx: /auth/ -> 127.0.0.1:${keycloakHostPort}，其余 -> 127.0.0.1:${bffHostPort}，并保留精确回调 /api/v1/auth/callback 与 SSE 关缓冲。`,
      "Nginx 站点里的 MYRIX_PUBLIC_DOMAIN 是占位符，集成前必须替换为真实 FQDN（Lead 负责落盘与 reload）。",
      "Keycloak 管理面（/auth/admin、/auth/realms/master）在公网返回 404；登录资源 /auth/realms/myrix/** 保持可达。",
      "Realm 通过 Keycloak startup import 导入：realm 已存在即跳过，不会覆盖用户/密码，所以日常启动命令同样带 --import-realm 也安全。",
      "kc.sh build 已在 CI 镜像里完成；任何容器（常驻或一次性）都不得再执行 build。",
      "Keycloak 库/角色由基底的 provision 一次性 job 显式创建；keycloak 依赖它 service_completed_successfully，不依赖应用启动时自动迁移。",
      "keycloakDbInitSql 含明文库口令，仅作单独手工示例；执行时必须用专用 PG 管理员连接串，绝不使用业务迁移角色 myrix_migrator（它没有 CREATEDB，且按职责分离不得承载 IdP 库）。",
      "Keycloak 容器以 UID 1000 运行，realm 导入文件必须在容器启动前设为 1000:1000 且 0600（宿主父目录保持 0700，绝不 chmod 777）。",
      "owner 用户 id 即 ID Token 的 sub；必须由 Lead 用迁移凭据写入 myrix_auth.subjects 才能登录成功。",
      "数据库口令只进入 Keycloak 环境与一次性 init SQL；不得复用 BFF/Cell 的角色。",
      "合并片段时：keycloak 是新服务，数组不会与基底冲突（无需 !override）；network 与基底同名即自动并入。",
    ],
  };

  return Object.freeze(config);
}

export { renderKeycloakEnvFile, describeAuthConfig, renderNginxSite };
