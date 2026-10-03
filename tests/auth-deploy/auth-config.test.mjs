// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0
/**
 * `deploy/auth/auth-config.ts` 的**离线纯测试**（node:test）。
 *
 * 约束（与部署安全要求一致）：
 *   - 不打印任何 secret 值：断言只比较布尔/结构，失败输出里出现的是 `false` 或已脱敏文本；
 *   - 不读取环境变量、不写文件、不拉镜像、不启动服务、不做真实域名/证书/ACME 操作；
 *   - 全部使用 RFC 保留域名 `*.example.test` 与明显的假口令；
 *   - 不要求 docker / nginx 可执行文件存在（纯字符串与结构断言）。
 *
 * 运行：node --test tests/auth-deploy/auth-config.test.mjs
 * （file: 说明符相对本文件解析，因此从仓库任意目录调用都成立。）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  createAuthConfig,
  describeAuthConfig,
  renderKeycloakEnvFile,
} from "../../deploy/auth/auth-config.ts";

const DOMAIN = "myrix.example.test";
const SHA40 = "a".repeat(40);
const IMMUTABLE_IMAGE = `docker.io/hewenyulucky/myrix:keycloak-sha-${SHA40}`;
const DIGEST_IMAGE = `docker.io/hewenyulucky/myrix@sha256:${"b".repeat(64)}`;

const SECRETS = {
  clientSecret: "bff-client-secret-value-0001",
  ownerPassword: "owner-temporary-password-0001",
  keycloakDbPassword: "keycloak-db-password-0001",
  keycloakAdminPassword: "keycloak-admin-password-0001",
};

const INPUT = Object.freeze({
  domain: DOMAIN,
  clientId: "myrix-bff",
  clientSecret: SECRETS.clientSecret,
  ownerId: "11111111-1111-4111-8111-111111111111",
  ownerUsername: "owner",
  ownerPassword: SECRETS.ownerPassword,
  keycloakDbPassword: SECRETS.keycloakDbPassword,
  keycloakAdminUsername: "kcadmin",
  keycloakAdminPassword: SECRETS.keycloakAdminPassword,
  images: Object.freeze({
    keycloak: IMMUTABLE_IMAGE,
    postgres: "postgres:17.6-alpine",
  }),
  ownerEmail: "owner@example.test",
});

const build = (overrides = {}) => createAuthConfig({ ...INPUT, ...overrides });
const SECRET_VALUES = Object.values(SECRETS);

/** 断言某个受检值确实包含 secret，但不把 secret 带进断言输出。 */
const holdsSecret = (actual) =>
  typeof actual === "string" && SECRET_VALUES.some(value => actual.includes(value));

/** 断言某个受检文本确实包含 init SQL 用的库口令。 */
const holdsDbSecret = (actual) => typeof actual === "string" && actual.includes(SECRETS.keycloakDbPassword);

/* ------------------------------------------------------------------ */
/* 契约：issuer / redirect / BFF 环境                                   */
/* ------------------------------------------------------------------ */

test("issuer / keycloakBaseUrl / redirect_uri / webOrigins 与 BFF 契约逐字节一致", () => {
  const config = build();
  assert.equal(config.origin, `https://${DOMAIN}`);
  // 浏览器 origin 不含路径；Keycloak 基础 URL 必须含 /auth（KC_HTTP_RELATIVE_PATH）。
  assert.equal(config.keycloakBaseUrl, `https://${DOMAIN}/auth`);
  assert.equal(config.issuer, `https://${DOMAIN}/auth/realms/myrix`);
  // issuer 建立在 keycloakBaseUrl 之上，绝不是裸 origin + 路径的巧合。
  assert.equal(config.issuer, `${config.keycloakBaseUrl}/realms/myrix`);
  // apps/bff/src/oidc.ts: new URL("/api/v1/auth/callback", origin).href
  assert.equal(config.redirectUri, `https://${DOMAIN}/api/v1/auth/callback`);
  assert.deepEqual(config.webOrigins, [`https://${DOMAIN}`]);
  assert.deepEqual(config.ownerSubject, {
    issuer: `https://${DOMAIN}/auth/realms/myrix`,
    subject: INPUT.ownerId,
  });
});

test("BFF 侧 OIDC 环境满足 apps/bff/src/config.ts 的校验", () => {
  const config = build();
  const env = config.bffOidcEnv;
  assert.equal(env.MYRIX_AUTH_MODE, "oidc");
  assert.equal(env.MYRIX_ORIGIN, `https://${DOMAIN}`);
  assert.equal(env.MYRIX_OIDC_ISSUER, config.issuer);
  assert.equal(env.MYRIX_OIDC_CLIENT_ID, "myrix-bff");
  assert.ok(holdsSecret(env.MYRIX_OIDC_CLIENT_SECRET));
  // OIDC 模式下开发登录必须不可用（config.ts 明确拒绝 MYRIX_DEV_USERS）。
  assert.equal("MYRIX_DEV_USERS" in env, false);
  // BFF 仍然发布在编排内网的 8787；宿主回环由 compose 固定。
  assert.equal(env.MYRIX_PORT, "8787");
  // issuer 必须是 HTTPS 且无 userinfo/query/fragment。
  const issuer = new URL(env.MYRIX_OIDC_ISSUER);
  assert.equal(issuer.protocol, "https:");
  assert.equal(issuer.username, "");
  assert.equal(issuer.search, "");
  assert.equal(issuer.hash, "");
});

/* ------------------------------------------------------------------ */
/* realm 导入                                                          */
/* ------------------------------------------------------------------ */

test("realm 导入 JSON：关闭自助注册、仅标准流、关闭 ROPC", () => {
  const config = build();
  const realm = JSON.parse(config.realmImportJson);
  assert.equal(realm.realm, "myrix");
  assert.equal(realm.enabled, true);
  assert.equal(realm.registrationAllowed, false);
  assert.equal(realm.verifyEmail, false);
  assert.equal(realm.resetPasswordAllowed, false);
  assert.equal(realm.duplicateEmailsAllowed, false);

  assert.equal(realm.clients.length, 1);
  const client = realm.clients[0];
  assert.equal(client.clientId, "myrix-bff");
  assert.equal(client.publicClient, false, "BFF 必须是 confidential client");
  assert.equal(client.standardFlowEnabled, true);
  assert.equal(client.implicitFlowEnabled, false);
  assert.equal(client.directAccessGrantsEnabled, false);
  assert.equal(client.serviceAccountsEnabled, false);
  assert.equal(client.bearerOnly, false);
  assert.deepEqual(client.redirectUris, [`https://${DOMAIN}/api/v1/auth/callback`]);
  assert.deepEqual(client.webOrigins, [`https://${DOMAIN}`]);
  // openid-client 使用 ClientSecretPost + PKCE S256。
  assert.equal(client.attributes["pkce.code.challenge.method"], "S256");
  assert.equal(client.attributes["token.endpoint.auth.method"], "client_secret_post");
  assert.deepEqual(client.defaultClientScopes, ["openid", "profile"]);
  assert.ok(holdsSecret(client.secret));
});

test("realm 导入 JSON：初始 owner 使用确定 UUID 作为 sub，临时密码首次更换", () => {
  const config = build();
  const realm = JSON.parse(config.realmImportJson);
  assert.equal(realm.users.length, 1);
  const user = realm.users[0];
  // user.id 就是 Keycloak 签发的 sub，也必须是预置到 myrix_auth.subjects 的 subject。
  assert.equal(user.id, INPUT.ownerId);
  assert.equal(user.username, INPUT.ownerUsername);
  assert.equal(user.enabled, true);
  assert.equal(user.emailVerified, true);
  assert.deepEqual(user.requiredActions, ["UPDATE_PASSWORD"]);
  // 单机首版无 SMTP：绝不能要求邮件验证。
  assert.equal(user.requiredActions.includes("VERIFY_EMAIL"), false);
  assert.equal(user.credentials.length, 1);
  assert.equal(user.credentials[0].type, "password");
  assert.equal(user.credentials[0].temporary, true);
  assert.ok(holdsSecret(user.credentials[0].value));
  assert.deepEqual(user.realmRoles, ["default-roles-myrix"]);
});

test("owner 只能有一个确定 subject，后续成员由 Lead 用迁移凭据预置", () => {
  const config = build();
  assert.equal(config.realmImport.users.length, 1);
  assert.equal(config.ownerSubject.subject, config.realmImport.users[0].id);
  // 首次登录不按 email 自动并入租户：BFF 的 resolveSubject 只查 (issuer, subject)。
  const realm = JSON.parse(config.realmImportJson);
  assert.equal(realm.loginWithEmailAllowed, true);
  assert.equal(realm.registrationAllowed, false);
  assert.equal(realm.resetPasswordAllowed, false);
});

/* ------------------------------------------------------------------ */
/* Keycloak：环境、运行身份、挂载、端口                                 */
/* ------------------------------------------------------------------ */

test("Keycloak 环境变量：/auth 相对路径、管理根路径、含 /auth 的公共基础 URL、xforwarded", () => {
  const config = build();
  const env = config.keycloakPublicEnv;
  assert.equal(env.KC_HTTP_RELATIVE_PATH, "/auth");
  assert.equal(env.KC_HTTP_MANAGEMENT_RELATIVE_PATH, "/");
  // KC_HOSTNAME 必须是**含 /auth 的完整基础 URL**：Keycloak 26.8 不会把
  // KC_HTTP_RELATIVE_PATH 拼进 hostname，只给裸 origin 会发布缺失 /auth 的 issuer。
  assert.equal(env.KC_HOSTNAME, `https://${DOMAIN}/auth`);
  assert.equal(env.KC_HOSTNAME, config.keycloakBaseUrl);
  // 与浏览器 origin 是不同概念：origin 无路径。
  assert.notEqual(env.KC_HOSTNAME, config.origin);
  assert.equal(config.origin, `https://${DOMAIN}`);
  assert.equal(env.KC_PROXY_HEADERS, "xforwarded");
  assert.equal(env.KC_HTTP_ENABLED, "true");
  assert.equal(env.KC_HEALTH_ENABLED, "true");
  assert.equal(env.KC_DB, "postgres");
  assert.equal(env.KC_DB_URL, "jdbc:postgresql://postgres:5432/keycloak");
  assert.equal(env.KC_DB_USERNAME, "keycloak");
  // KC_HOSTNAME_STRICT 在新版本会与 xforwarded 冲突，且不再是显式要求。
  assert.equal("KC_HOSTNAME_STRICT" in env, false);
  // 数据库口令只出现在 secret 分组里，且只有 Keycloak 服务持有该变量。
  assert.equal("KC_DB_PASSWORD" in env, false);
  assert.ok(holdsSecret(config.keycloakSecretEnv.KC_DB_PASSWORD));
  assert.ok(holdsSecret(config.keycloakSecretEnv.KC_BOOTSTRAP_ADMIN_PASSWORD));
  assert.equal(config.keycloakSecretEnv.KC_BOOTSTRAP_ADMIN_USERNAME, "kcadmin");
});

/* ------------------------------------------------------------------ */
/* 回归：公共 origin 与 Keycloak 基础 URL 是不同概念                    */
/* ------------------------------------------------------------------ */

/**
 * 从**已发射的 Keycloak 运行期 env** 重建公共 OIDC 端点，模拟 Keycloak 发布
 * discovery 的方式：`KC_HOSTNAME` 是基础 URL，但它**不会**自动带上
 * `KC_HTTP_RELATIVE_PATH`，所以基础 URL 必须自己已含 `/auth`。
 *
 * 这是本次线上故障的核心回归：若 `KC_HOSTNAME` 退化成裸 origin，
 * 下面的 `issuer` 会变成 `https://<domain>/realms/<realm>`（缺 `/auth`）。
 */
const reconstructOidc = config => {
  const env = config.keycloakPublicEnv;
  const base = env.KC_HOSTNAME.replace(/\/+$/, "");
  const realmBase = `${base}/realms/${config.realm}`;
  return {
    issuer: realmBase,
    authorizationEndpoint: `${realmBase}/protocol/openid-connect/auth`,
    tokenEndpoint: `${realmBase}/protocol/openid-connect/token`,
    jwksUri: `${realmBase}/protocol/openid-connect/certs`,
  };
};

/** 所有需要验证的装配变体：每个变体都必须重建出带 /auth 的 issuer 与端点。 */
const VARIANTS = Object.freeze([
  { label: "default" },
  { label: "snippet", nginxSiteType: "snippet" },
  { label: "other-domain", domain: "other.example.test" },
  { label: "keycloak-port", keycloakHostPort: 18081, bffHostPort: 8788 },
  { label: "ipv6-loopback", keycloakBindHost: "::1" },
  { label: "auth-mount", composeAuthMount: "./auth-generated" },
  { label: "declare-network", declareNetwork: true },
  { label: "long-domain", domain: "very-long-subdomain.auth.example.test" },
]);

test("公共 origin 与 Keycloak 基础 URL 是两个不同的值（origin 无路径，base 含 /auth）", () => {
  const config = build();
  assert.equal(config.origin, `https://${DOMAIN}`);
  assert.equal(config.keycloakBaseUrl, `https://${DOMAIN}/auth`);
  // 基础 URL = origin + KC_HTTP_RELATIVE_PATH，二者绝不相同。
  assert.equal(config.keycloakBaseUrl, `${config.origin}${config.keycloakPublicEnv.KC_HTTP_RELATIVE_PATH}`);
  assert.notEqual(config.keycloakBaseUrl, config.origin);
  // webOrigins / redirectUri 用浏览器 origin（无 /auth），issuer 用基础 URL（含 /auth）。
  assert.deepEqual(config.webOrigins, [config.origin]);
  assert.equal(config.redirectUri.startsWith(`${config.origin}/api/`), true);
  assert.equal(config.redirectUri.startsWith(`${config.keycloakBaseUrl}/`), false);
  assert.equal(config.issuer.startsWith(`${config.keycloakBaseUrl}/realms/`), true);
});

test("每个装配变体都从已发射 env 重建出 /auth 下的 issuer 与授权/token/JWKS 端点", () => {
  for (const { label, ...overrides } of VARIANTS) {
    const config = build(overrides);
    const env = config.keycloakPublicEnv;
    // KC_HOSTNAME 必须是含 /auth 的完整基础 URL，绝不等于裸 origin。
    assert.equal(env.KC_HOSTNAME, `${config.origin}/auth`, `${label}: KC_HOSTNAME 缺少 /auth`);
    assert.notEqual(env.KC_HOSTNAME, config.origin, `${label}: KC_HOSTNAME 不能退化成裸 origin`);
    assert.equal(env.KC_HTTP_RELATIVE_PATH, "/auth", `${label}: 相对路径必须仍是 /auth`);

    const oidc = reconstructOidc(config);
    const expected = `https://${config.domain}/auth/realms/myrix`;
    assert.equal(oidc.issuer, expected, `${label}: 重建 issuer 不含 /auth`);
    assert.equal(oidc.issuer, config.issuer, `${label}: 重建 issuer 必须逐字节等于 config.issuer`);
    // BFF 契约：MYRIX_OIDC_ISSUER 就是它，且必须落在 /auth 下。
    assert.equal(env.KC_HOSTNAME.includes("/auth"), true, `${label}: 基础 URL 未携带公网路径`);
    assert.equal(config.bffOidcEnv.MYRIX_OIDC_ISSUER, oidc.issuer, `${label}: BFF issuer 与重建结果不一致`);
    for (const endpoint of [oidc.issuer, oidc.authorizationEndpoint, oidc.tokenEndpoint, oidc.jwksUri]) {
      assert.equal(new URL(endpoint).pathname.startsWith("/auth/realms/myrix"), true, `${label}: ${endpoint} 不在 /auth 下`);
    }
    // 反例守卫：裸 origin 方案会重建出缺失 /auth 的 issuer。
    const broken = { ...config, keycloakPublicEnv: { ...env, KC_HOSTNAME: config.origin } };
    assert.notEqual(reconstructOidc(broken).issuer, config.issuer, `${label}: 裸 origin 必须被该回归检出`);
  }
});

test("KC_HOSTNAME 与 authority 之间不出现重复 /auth，也不泄漏到 webOrigins/回调", () => {
  const config = build();
  const env = config.keycloakPublicEnv;
  // 不重复拼接：完整 URL 只出现一次 /auth。
  assert.equal(env.KC_HOSTNAME.split("/auth").length - 1, 1);
  // 浏览器可见的 origin 级字段不得出现 /auth 路径。
  assert.equal(config.origin.includes("/auth"), false);
  assert.equal(config.webOrigins.some(origin => origin.includes("/auth")), false);
  assert.equal(config.redirectUri.includes("/auth/realms"), false);
  // realm 导入的 redirect/webOrigin 仍然只认浏览器 origin。
  const realm = JSON.parse(config.realmImportJson);
  assert.deepEqual(realm.clients[0].redirectUris, [config.redirectUri]);
  assert.deepEqual(realm.clients[0].webOrigins, [config.origin]);
});

test("Keycloak 服务：只读、UID1000、无能力、/tmp 与 data(tmpfs) 可写、import 只读挂载", () => {
  const config = build();
  const keycloak = config.compose.services.keycloak;
  assert.equal(keycloak.read_only, true);
  assert.equal(keycloak.user, "1000:1000");
  assert.deepEqual(keycloak.cap_drop, ["ALL"]);
  assert.deepEqual(keycloak.security_opt, ["no-new-privileges:true"]);
  // read-only rootfs 下两个可写点：/tmp 给 Quarkus，/opt/keycloak/data 给运行期与 import 父目录。
  assert.ok(keycloak.tmpfs.some(entry => entry.startsWith("/tmp:")));
  assert.ok(keycloak.tmpfs.some(entry => entry.startsWith("/opt/keycloak/data:rw")));
  assert.ok(keycloak.tmpfs.some(entry => /uid=1000/.test(entry)));
  // 唯一的挂载是只读 realm 导入，位于 data/import 之下。
  assert.equal(keycloak.volumes.length, 1);
  assert.match(keycloak.volumes[0], /^\.\/auth\/realm-myrix\.json:\/opt\/keycloak\/data\/import\/realm-myrix\.json:ro$/);
  assert.deepEqual(keycloak.networks, ["myrix"]);
});

test("Keycloak 端口：只发布宿主回环 127.0.0.1:18080->8080，管理端口 9000 不发布", () => {
  const config = build();
  const keycloak = config.compose.services.keycloak;
  assert.deepEqual(keycloak.ports, ["127.0.0.1:18080:8080"]);
  // 9000 只允许出现在容器内健康检查里，绝不能出现在 ports/expose。
  assert.equal(JSON.stringify(keycloak.ports).includes("9000"), false);
  assert.equal("expose" in keycloak, false);
  // 健康检查走管理端口，且不发布到宿主。
  assert.match(keycloak.healthcheck.test.join(" "), /\/dev\/tcp\/127\.0\.0\.1\/9000/);
  assert.match(keycloak.healthcheck.test.join(" "), /GET \/health\/ready/);
  assert.deepEqual(keycloak.healthcheck.test.slice(0, 3), ["CMD", "/bin/bash", "-ec"]);
  assert.ok(keycloak.healthcheck.test[3].includes('test "$$status" = 200'));
  assert.doesNotMatch(keycloak.healthcheck.test[3], /grep/);
  // 绑定地址必须是回环。
  assert.throws(() => build({ keycloakBindHost: "0.0.0.0" }), /loopback/);
  assert.deepEqual(build({ keycloakBindHost: "::1" }).compose.services.keycloak.ports, ["[::1]:18080:8080"]);
});

test("Keycloak 启动：唯一命令是 start --optimized --import-realm，绝不 build / offline import", () => {
  const config = build();
  const keycloak = config.compose.services.keycloak;
  // 与 Lead 的 deploy/images/Dockerfile.keycloak CMD 一致。
  assert.deepEqual(keycloak.command, ["start", "--optimized", "--import-realm"]);
  // bootstrap 只描述进程 argv，不包含 build。
  assert.equal("build" in config.bootstrap, false);
  // importRealm 与 start 同 argv：startup import 对已存在 realm 是跳过语义，
  // 因此不再需要单独的阻塞式一次性导入，日常启动命令本身就是安全的。
  assert.deepEqual(config.bootstrap.start, ["start", "--optimized", "--import-realm"]);
  assert.deepEqual(config.bootstrap.importRealm, ["start", "--optimized", "--import-realm"]);
  assert.deepEqual(config.bootstrap.importRealm, config.bootstrap.start);
  // 可执行部分（compose 片段 + bootstrap argv）里不得出现任何 build 子命令或参数。
  const executable = `${JSON.stringify(config.compose)}\n${JSON.stringify(config.bootstrap)}`;
  assert.equal(/\bbuild\b/.test(executable), false);
  assert.equal(executable.includes("--import-realm"), true);
  // 绝不用 offline import --override（那会覆盖/破坏已存在 realm）。
  assert.equal(/offline/.test(executable), false);
  assert.equal(/--override/.test(executable), false);
  // 说明文字明确要求构建只在 CI 完成（只检查意图，不作为可执行内容）。
  assert.ok(config.notes.some(note => /CI/.test(note) && /build/.test(note)));
});

test("compose 片段：只有一个 keycloak 服务，没有 Caddy/全局安全数组重复", () => {
  const config = build();
  const doc = config.compose;
  assert.deepEqual(Object.keys(doc.services), ["keycloak"]);
  // 基底已声明同名网络（name: myrix-vps），片段默认不再声明以免覆盖。
  assert.deepEqual(doc.networks, {});
  assert.deepEqual(Object.keys(build({ declareNetwork: true }).compose.networks), ["myrix"]);
  const keycloak = doc.services.keycloak;
  // pids 限额必须在 deploy 里：与顶层 pids_limit 并存会让 compose 直接报错。
  assert.ok(Number.isSafeInteger(keycloak.deploy.resources.limits.pids));
  assert.equal("pids_limit" in keycloak, false);
  assert.equal(keycloak.restart, "unless-stopped");
  assert.ok(keycloak.deploy.resources.limits.memory);
  // 不重复声明基底已有服务的健康依赖之外的顶层结构。
  // 同机 Compose：独立 Keycloak 库/角色由基底 provision 一次性 job 创建，
  // keycloak 必须在 postgres 健康且 provision 成功退出后才启动。
  assert.deepEqual(keycloak.depends_on, {
    postgres: { condition: "service_healthy" },
    provision: { condition: "service_completed_successfully" },
  });
  // 可选 provisionService：默认 provision，可改名，但不得与 keycloak/postgres 撞名。
  assert.deepEqual(build({ provisionService: "db-provision" }).compose.services.keycloak.depends_on, {
    postgres: { condition: "service_healthy" },
    "db-provision": { condition: "service_completed_successfully" },
  });
  assert.throws(() => build({ provisionService: "keycloak" }), /provisionService/);
  assert.throws(() => build({ provisionService: "postgres" }), /provisionService/);
  assert.throws(() => build({ keycloakService: "postgres" }), /distinct/);
});

/* ------------------------------------------------------------------ */
/* 宿主 Nginx 站点                                                     */
/* ------------------------------------------------------------------ */

test("Nginx 站点：默认站点名是占位符，不含真实域名，也不含任何 Caddy 痕迹", () => {
  const config = build();
  assert.equal(config.nginxSiteType, "server");
  assert.match(config.nginxSite, /server_name MYRIX_PUBLIC_DOMAIN;/);
  // 未显式提供站点名时，生成物里绝不能出现入参域名。
  assert.equal(config.nginxSite.includes(DOMAIN), false);
  assert.equal(/caddy/i.test(config.nginxSite), false);
  // 通用性：可显式换成真实 FQDN 与证书目录。
  const real = build({ nginxSiteDomain: "br.example.test", nginxTlsDirectory: "/etc/letsencrypt/live/br.example.test" });
  assert.match(real.nginxSite, /server_name br\.example\.test;/);
  assert.match(real.nginxSite, /ssl_certificate\s+\/etc\/letsencrypt\/live\/br\.example\.test\/fullchain\.pem;/);
  assert.match(real.nginxSite, /ssl_certificate_key \/etc\/letsencrypt\/live\/br\.example\.test\/privkey\.pem;/);
  // 负例：站点名/证书目录不接受 nginx 元字符或相对路径。
  assert.throws(() => build({ nginxSiteDomain: "a b" }), /nginxSiteDomain/);
  assert.throws(() => build({ nginxSiteDomain: "evil;}" }), /nginxSiteDomain/);
  assert.throws(() => build({ nginxTlsDirectory: "relative/path" }), /nginxTlsDirectory/);
});

test("Nginx 路由：/auth/ 到 18080、其余到 8787，且精确保留回调", () => {
  const config = build();
  const site = config.nginxSite;
  assert.match(site, /location = \/auth \{\n\t\tproxy_pass http:\/\/127\.0\.0\.1:18080;\n\t\}/);
  assert.match(site, /location \/auth\/ \{\n\t\tproxy_pass http:\/\/127\.0\.0\.1:18080;\n\t\}/);
  // 精确回调显式列出，且在兜底 location / 之前（兜底块没有 return 301）。
  const callbackAt = site.indexOf("location = /api/v1/auth/callback");
  const fallbackAt = site.indexOf("location / {\n\t\tproxy_pass");
  assert.ok(callbackAt > 0 && fallbackAt > callbackAt);
  assert.match(site, /location = \/api\/v1\/auth\/callback \{\n\t\tproxy_pass http:\/\/127\.0\.0\.1:8787;\n\t\}/);
  assert.match(site, /location \/ \{\n\t\tproxy_pass http:\/\/127\.0\.0\.1:8787;\n\t\}/);
});

test("Nginx 拒绝：/auth/admin 与 master realm 及其子路径返回 404，且排在 /auth 之前", () => {
  const config = build();
  const site = config.nginxSite;
  assert.deepEqual(config.deniedPaths, ["/auth/admin", "/auth/realms/master"]);
  // 子路径与自身都命中：`(/|$)` 而不是只匹配 `/auth/admin*`。
  assert.match(site, /location ~ \^\/auth\/admin\(\/\|\$\) \{\n\t\treturn 404;\n\t\}/);
  assert.match(site, /location ~ \^\/auth\/realms\/master\(\/\|\$\) \{\n\t\treturn 404;\n\t\}/);
  const adminAt = site.indexOf("location ~ ^/auth/admin");
  const masterAt = site.indexOf("location ~ ^/auth/realms/master");
  const authAt = site.indexOf("location /auth/ {");
  assert.ok(adminAt > 0 && masterAt > adminAt && authAt > masterAt, "拒绝规则必须排在 /auth 超集之前");
  // 登录资源没有被误伤。
  assert.equal(/location ~ \^\/auth\/realms\/myrix/.test(site), false);
  // 可追加拒绝前缀，但不允许不安全字符。
  assert.deepEqual(build({ extraDeniedPaths: ["/internal"] }).deniedPaths, ["/auth/admin", "/auth/realms/master", "/internal"]);
  assert.throws(() => build({ extraDeniedPaths: ["/bad path"] }), /deniedPaths/);
});

test("Nginx 转发头：固定 https 与 $remote_addr，绝不透传客户端链", () => {
  const config = build();
  const site = config.nginxSite;
  assert.match(site, /\tproxy_set_header Host \$host;/);
  assert.match(site, /\tproxy_set_header X-Forwarded-Proto https;/);
  assert.match(site, /\tproxy_set_header X-Forwarded-Host \$host;/);
  assert.match(site, /\tproxy_set_header X-Forwarded-For \$remote_addr;/);
  // 不得信任客户端伪造的转发链，也不得用 $scheme 让 HTTP 请求伪装成 https。
  assert.equal(site.includes("$proxy_add_x_forwarded_for"), false);
  assert.equal(site.includes("X-Forwarded-Proto $scheme"), false);
  assert.equal(/\$http_x_forwarded/i.test(site), false);
});

test("Nginx SSE：会话事件流关闭缓冲", () => {
  const config = build();
  const site = config.nginxSite;
  assert.match(site, /location \^~ \/api\/v1\/sessions\/ \{\n\t\tproxy_pass http:\/\/127\.0\.0\.1:8787;\n\t\tproxy_buffering off;\n\t\tproxy_cache off;/);
  // 无缓冲的 location 必须在兜底之前，否则 /api/v1/sessions 会被兜底吃掉缓冲设置。
  assert.ok(site.indexOf("location ^~ /api/v1/sessions/") < site.indexOf("location / {\n\t\tproxy_pass"));
  assert.throws(() => build({ ssePathPrefix: "api/v1/sessions/" }), /ssePathPrefix/);
});

test("Nginx HTTP：80 只做 ACME 挑战与到 HTTPS 的跳转（跳转用字面站点名）", () => {
  const config = build();
  const site = config.nginxSite;
  const httpServer = site.split("server {")[1] ?? "";
  assert.match(httpServer, /listen 80;/);
  assert.match(httpServer, /location \^~ \/\.well-known\/acme-challenge\/ \{\n\t\troot \/var\/www\/html;\n\t\tdefault_type "text\/plain";\n\t\ttry_files \$uri =404;\n\t\}/);
  assert.match(httpServer, /return 301 https:\/\/MYRIX_PUBLIC_DOMAIN\$request_uri;/);
  // 80 端口上不得代理任何上游。
  assert.equal(/proxy_pass/.test(httpServer), false);
  // ACME 挑战必须先于跳转。
  assert.ok(httpServer.indexOf("acme-challenge") < httpServer.indexOf("return 301"));
  // 跳转目标用字面站点名而不是 $host，避免 Host 头注入的开放重定向。
  assert.equal(httpServer.includes("https://$host"), false);
  // HTTPS server 不记录访问日志（回调查询串携带一次性授权码）。
  assert.match(site, /\taccess_log off;/);
});

test("Nginx snippet 模式：不含监听端口/证书/站点名/跳转，且每个 location 自带转发头", () => {
  const config = build({ nginxSiteType: "snippet" });
  const text = config.nginxSite;
  assert.equal(config.nginxSiteType, "snippet");
  // 只允许注释里说明"不含这些指令"，真正的指令必须一个都没有。
  const directives = text.split("\n").filter(line => !line.trimStart().startsWith("#")).join("\n");
  assert.equal(/\blisten \d/.test(directives), false);
  assert.equal(/ssl_certificate/.test(directives), false);
  assert.equal(/server_name/.test(directives), false);
  assert.equal(/return 301/.test(directives), false);
  // location 块仍完整，且每个代理块都显式带转发头。
  assert.match(text, /location \/auth\/ \{/);
  assert.match(text, /location = \/api\/v1\/auth\/callback \{/);
  assert.match(text, /location \^~ \/api\/v1\/sessions\/ \{/);
  assert.match(text, /proxy_buffering off;/);
  const blocks = text.split("location ").slice(1);
  for (const block of blocks) {
    if (!block.includes("proxy_pass")) continue;
    assert.match(block, /proxy_set_header X-Forwarded-For \$remote_addr;/);
    assert.match(block, /proxy_set_header X-Forwarded-Proto https;/);
  }
  assert.throws(() => build({ nginxSiteType: "vhost" }), /nginxSiteType/);
});

/* ------------------------------------------------------------------ */
/* 数据库隔离                                                          */
/* ------------------------------------------------------------------ */

test("数据库隔离：独立 keycloak 库与专用角色，init SQL 不做共享授权", () => {
  const config = build();
  const sql = config.keycloakDbInitSql;
  assert.match(sql, /CREATE DATABASE keycloak OWNER keycloak/);
  assert.match(sql, /CREATE ROLE keycloak LOGIN PASSWORD/);
  assert.match(sql, /NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS/);
  // 明文库口令只应出现在这份一次性 init SQL 里由操作者落盘（0600、gitignore）。
  assert.ok(holdsDbSecret(sql));
  assert.equal(sql.includes("GRANT ALL"), false);
  assert.equal(/GRANT .* TO PUBLIC/.test(sql), false);
  assert.match(sql, /REVOKE ALL ON DATABASE keycloak FROM PUBLIC/);
  // 部署编排走显式 provision 一次性 job，不是应用启动自动迁移。
  assert.match(sql, /provision/);
  assert.match(sql, /不是应用启动时自动迁移/);
  // 单独手工示例必须用专用 PG 管理员连接串，不得用业务迁移角色 myrix_migrator
  // （它没有 CREATEDB，且按职责分离不得承载 IdP 库）。
  assert.equal(sql.includes("MYRIX_MIGRATE_DATABASE_URL"), false);
  assert.match(sql, /MYRIX_PG_ADMIN_DATABASE_URL/);
  assert.match(sql, /myrix_migrator/);
  // 负例：不得复用共享/管理角色。
  assert.throws(() => build({ keycloakDbUser: "postgres" }), /dedicated role/);
  assert.throws(() => build({ keycloakDbUser: "myrix", reservedDbUsers: ["myrix"] }), /dedicated role/);
  assert.throws(() => build({ keycloakDb: "myrix", reservedDbUsers: ["myrix"] }), /keycloakDb must be a dedicated database/);
});

/* ------------------------------------------------------------------ */
/* 纯函数、镜像 pin、秘密不外泄                                        */
/* ------------------------------------------------------------------ */

test("realm 导入语义：startup import 对已存在 realm 跳过，日常重启不重置用户或密码", () => {
  const config = build();
  // 唯一启动 argv 同时承担首次导入；Keycloak 对已存在的 realm 是"创建/跳过"语义。
  assert.ok(config.bootstrap.start.includes("--import-realm"));
  assert.deepEqual(config.bootstrap.start, config.bootstrap.importRealm);
  // 绝不 offline import / --override（那才是会覆盖/重置的路径）。
  const argv = JSON.stringify(config.bootstrap);
  assert.equal(/offline/.test(argv), false);
  assert.equal(/--override/.test(argv), false);
  // 导入文件是只读挂载，运行期不会被改写。
  assert.match(config.compose.services.keycloak.volumes[0], /:ro$/);
});

test("纯函数：同入参同输出，且版本必须显式固定、绝不出现 latest", () => {
  const first = build();
  const second = build();
  const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  assert.equal(digest(first.realmImport), digest(second.realmImport));
  assert.equal(first.nginxSite, second.nginxSite);
  assert.equal(digest(first.compose), digest(second.compose));

  const serialized = JSON.stringify({
    realm: first.realmImport,
    compose: first.compose,
    nginx: first.nginxSite,
    env: first.keycloakPublicEnv,
    notes: first.notes,
  });
  assert.equal(/latest/.test(serialized), false);
  assert.equal(/latest/.test(first.nginxSite), false);
});

test("镜像：接受 immutable 生产镜像（sha tag 或 digest），拒绝浮动与缺失版本", () => {
  const config = build();
  assert.deepEqual(config.images, INPUT.images);
  assert.equal(Object.isFrozen(config.images), true);
  // 不要求镜像名形如 keycloak:<semver>：component 前缀的 40hex tag 是合法 pin。
  assert.equal(config.compose.services.keycloak.image, IMMUTABLE_IMAGE);
  // digest pin 同样接受。
  assert.equal(build({ images: { ...INPUT.images, keycloak: DIGEST_IMAGE } }).compose.services.keycloak.image, DIGEST_IMAGE);
  // 官方 postgres 必须显式 pin。
  assert.equal(build({ images: { ...INPUT.images, postgres: "postgres:17.6-alpine" } }).images.postgres, "postgres:17.6-alpine");

  assert.throws(() => build({ images: { ...INPUT.images, keycloak: "quay.io/keycloak/keycloak:latest" } }), /images\.keycloak/);
  assert.throws(() => build({ images: { ...INPUT.images, keycloak: "docker.io/hewenyulucky/myrix@sha256:deadbeef" } }), /images\.keycloak/);
  assert.throws(() => build({ images: { ...INPUT.images, keycloak: "docker.io/hewenyulucky/myrix" } }), /images\.keycloak/);
  assert.throws(() => build({ images: { ...INPUT.images, postgres: "postgres:17" } }), /images\.postgres/);
  assert.throws(() => build({ images: { ...INPUT.images, postgres: "postgres" } }), /images\.postgres/);
  assert.throws(() => build({ images: undefined }), /must be provided explicitly/);
});

test("describeAuthConfig 与 keycloak env 渲染都不泄露任何 secret", () => {
  const config = build();
  const described = JSON.stringify(describeAuthConfig(config));
  for (const secret of SECRET_VALUES) assert.equal(described.includes(secret), false, "described config leaked a secret");
  const notes = JSON.stringify(config.notes);
  for (const secret of SECRET_VALUES) assert.equal(notes.includes(secret), false, "notes leaked a secret");

  const plain = renderKeycloakEnvFile(config);
  assert.ok(holdsSecret(plain));
  assert.match(plain, /^KC_DB_PASSWORD=\S+$/m);
  const redacted = renderKeycloakEnvFile(config, { redact: true });
  for (const secret of SECRET_VALUES) assert.equal(redacted.includes(secret), false, "redacted env leaked a secret");
  assert.match(redacted, /^KC_DB_PASSWORD=<redacted>$/m);
  assert.match(redacted, /^KC_HOSTNAME=https:\/\/myrix\.example\.test\/auth$/m);
});

test("describeAuthConfig 暴露的是新的 Nginx 接口，不含 caddy* 字段", () => {
  const described = describeAuthConfig(build());
  assert.equal("caddyfile" in described, false);
  assert.equal("caddyImage" in described, false);
  assert.equal("caddyPortMode" in described, false);
  assert.equal(described.nginxSiteType, "server");
  assert.equal(described.keycloakHostPort, 18080);
  assert.equal(described.bffHostPort, 8787);
});

/* ------------------------------------------------------------------ */
/* 负例：校验与错误信息                                                */
/* ------------------------------------------------------------------ */

test("负例：secret 不允许需要转义的字符（避免 env_file / YAML / SQL / JSON 双重转义）", () => {
  for (const bad of ["short", `has space in it 12345`, `quote"inside-value-1234`, `dollar$inside-value-123`, "single'quote-value-1234", "back\\slash-value-12345", "at@sign-value-1234567", "colon:value-1234567890"]) {
    assert.throws(
      () => build({ clientSecret: bad }),
      (error) => error.message.includes("clientSecret") && !bad.split(/[^A-Za-z0-9]/).some(token => token.length > 5 && error.message.includes(token)),
    );
  }
});

test("负例：realm 固定为 myrix；domain / owner / 端口 / 挂载目录校验", () => {
  assert.throws(() => build({ realm: "master" }), /realm must be exactly 'myrix'/);
  assert.throws(() => build({ domain: "https://myrix.example.test" }), /domain/);
  assert.throws(() => build({ domain: "myrix.example.test/path" }), /domain/);
  assert.throws(() => build({ domain: "203.0.113.10" }), /domain/);
  assert.throws(() => build({ domain: "myrix" }), /domain/);
  assert.throws(() => build({ ownerId: "not-a-uuid" }), /ownerId/);
  assert.throws(() => build({ ownerUsername: "Owner" }), /ownerUsername/);
  assert.throws(() => build({ bffHostPort: 0 }), /bffHostPort/);
  assert.throws(() => build({ keycloakHostPort: 0 }), /keycloakHostPort/);
  // 端口不能撞车：否则 Nginx 会把 IdP 与 BFF 混在一起。
  assert.throws(() => build({ bffHostPort: 18080 }), /must be distinct/);
  assert.throws(() => build({ composeAuthMount: "has space" }), /composeAuthMount/);
  assert.throws(() => build({ network: "Bad Network" }), /network/);
});

test("负例：会话 TTL 与 access token 有效期必须在契约区间内", () => {
  assert.throws(() => build({ sessionTtlSeconds: 10 }), /sessionTtlSeconds/);
  assert.throws(() => build({ sessionTtlSeconds: 90000 }), /sessionTtlSeconds/);
  assert.throws(() => build({ accessTokenLifespanSeconds: 5 }), /accessTokenLifespanSeconds/);
  assert.equal(build({ sessionTtlSeconds: 86400 }).bffOidcEnv.MYRIX_SESSION_TTL_SECONDS, "86400");
});

test("错误信息绝不回显 secret 值", () => {
  // 触发另一个字段的错误，确认失败路径不会把 secret 打进 message。
  try {
    build({ domain: "not a domain" });
    assert.fail("expected createAuthConfig to throw");
  } catch (error) {
    for (const secret of SECRET_VALUES) assert.equal(error.message.includes(secret), false, "error message leaked a secret");
  }
  try {
    build({ clientSecret: "bad secret with spaces" });
    assert.fail("expected createAuthConfig to throw");
  } catch (error) {
    assert.equal(error.message.includes("bad secret with spaces"), false, "error message leaked the rejected secret");
  }
});

/* ------------------------------------------------------------------ */
/* 参考片段不漂移                                                      */
/* ------------------------------------------------------------------ */

test("compose.auth.yml 参考片段不漂移：无 Caddy、不可变镜像、无重复全局数组", () => {
  const reference = readFileSync(new URL("../../deploy/auth/compose.auth.yml", import.meta.url), "utf8");
  // 注释里可以解释"为什么不引入 Caddy"；只对真正的 compose 指令做结构断言。
  const directives = reference
    .split("\n")
    .filter(line => !line.trimStart().startsWith("#"))
    .join("\n");
  // 镜像必须由环境显式固定，且绝不出现 latest 或内联常量镜像。
  assert.match(directives, /image: \$\{MYRIX_IMAGE_KEYCLOAK:\?/);
  assert.equal(/:latest\b/.test(directives), false);
  assert.equal(/image: [^$\s]/.test(directives), false);
  // 绝不引入 Caddy 服务、Caddyfile 挂载或 80/443 端口。
  assert.equal(/caddy/i.test(directives), false);
  assert.equal(/\b80:80\b|\b443:443\b/.test(directives), false);
  // 只定义 keycloak 一个服务（含缩进的服务键）。
  assert.deepEqual([...directives.matchAll(/^  ([a-z0-9][a-z0-9-]*):$/gm)].map(m => m[1]), ["keycloak"]);
  // 关键运行身份/隔离字段。
  assert.match(directives, /user: "1000:1000"/);
  assert.match(directives, /read_only: true/);
  assert.match(directives, /command: \["start", "--optimized", "--import-realm"\]/);
  assert.match(directives, /127\.0\.0\.1:18080:8080/);
  assert.match(directives, /\/opt\/keycloak\/data:rw/);
  assert.match(directives, /realm-myrix\.json:\/opt\/keycloak\/data\/import\/realm-myrix\.json:ro/);
  // 同机 Compose：keycloak 依赖基底的 provision 一次性 job（不重新定义它）。
  assert.match(directives, /provision:\n\s+condition: service_completed_successfully/);
  assert.equal(/^  provision:$/m.test(directives), false);
  // 不重复基底已有的安全数组/网络/全局锚点。
  assert.equal(/!override/.test(directives), false);
  assert.equal(/x-hardening/.test(directives), false);
  assert.equal(/^\s+pids_limit:/m.test(directives), false);
  assert.match(directives, /pids: 1024/);
  // Keycloak 唯一启动命令必须带 --import-realm（startup import 跳过已存在 realm），但绝不 build。
  assert.match(directives, /--import-realm/);
  assert.equal(/offline|--override/.test(directives), false);
  assert.equal(/kc\.sh build|build --db/.test(directives), false);
  // 秘密只经 env_file 注入，不在 compose 里插值。
  assert.match(directives, /\.\/auth\/keycloak\.env/);
  assert.equal(/KC_DB_PASSWORD:/.test(directives), false);
  // 不重复声明基底已有的网络（会把 name: myrix-vps 覆盖掉）。
  assert.equal(/^networks:$/m.test(directives), false);
  assert.match(directives, /^\s+- myrix$/m);
});

test("README 描述的接口与工厂输出一致（键名与路径）", () => {
  const readme = readFileSync(new URL("../../docs/deployment/authentication.md", import.meta.url), "utf8");
  assert.match(readme, /deploy\/auth\/auth-config\.ts/);
  assert.match(readme, /nginxSite/);
  assert.match(readme, /keycloakPublicEnv/);
  assert.match(readme, /keycloakSecretEnv/);
  assert.match(readme, /bffOidcEnv/);
  assert.match(readme, /realmImportJson/);
  assert.match(readme, /keycloakDbInitSql/);
  assert.match(readme, /ownerSubject/);
  // 文档里不得再出现 Caddy 部署路径。
  assert.equal(/Caddyfile|Caddy 容器|caddyPortMode/.test(readme), false);
});
