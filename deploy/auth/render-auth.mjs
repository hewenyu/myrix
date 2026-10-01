// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0
/**
 * 把 `createAuthConfig()` 的产物落盘，供单机 VPS 的首次初始化使用。
 *
 * 设计约束：
 *   - **不打印任何 secret**：stdout 只输出 `describeAuthConfig()` 的非密事实；
 *     stderr 的错误只带**固定字段名与文件名**，绝不回显任何 secret 值；
 *   - 所有输入必须显式给出（无默认域名、无默认密钥、无默认镜像 tag），没有 `latest`；
 *   - **默认 no-clobber**：任何目标（含 `.gitignore`）已存在就整体拒绝，绝不静默覆盖
 *     既有秘密；已有目标是 symlink（哪怕 dangling）同样拒绝。没有 `--force`：
 *     要重渲染先由人显式移走旧文件；
 *   - 只写文件，不接触网络、不拉镜像、不启动服务、不做 ACME/DNS 操作，
 *     **不读取也不生成任何私钥或证书**（TLS 由宿主既有 Nginx 负责）；
 *   - 输出目录权限 0700，含密文件 0600；目录内自带 `.gitignore` 防止误提交；
 *     本脚本**不**对生成物做 chown —— realm 交给你/部署者按文档显式改为 `1000:1000`。
 *
 * 用法：
 *   node deploy/auth/render-auth.mjs --out deploy/auth/generated
 *   （domain / 密钥 / owner / 镜像 等通过环境变量提供，见 deploy/auth/README.md）
 */
import { closeSync, chmodSync, lstatSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { createAuthConfig, describeAuthConfig, renderKeycloakEnvFile } from "./auth-config.ts";

const required = name => {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required; this renderer has no defaults and never falls back to a floating image tag`);
  }
  return value;
};

const optional = name => {
  const value = process.env[name];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
};

/** 目标名必须是无目录、无元字符的纯 basename（部署者会拿它当 sudo chown 的路径）。 */
const assertBaseName = name => {
  if (typeof name !== "string" || name.length === 0 || name.length > 200 || /[/\\\0:]/.test(name) || name === "." || name === "..") {
    // 只回显字段名，不回显可疑取值（可能是别人塞进来的路径）。
    throw new Error("output file name must be a plain basename without directories or separators");
  }
  return name;
};

const argv = process.argv.slice(2);
const outIndex = argv.indexOf("--out");
if (outIndex >= 0 && !argv[outIndex + 1]) throw new Error("--out requires a directory");
const outDir = resolve(outIndex >= 0 ? (argv[outIndex + 1] ?? "") : "deploy/auth/generated");

const config = createAuthConfig({
  domain: required("MYRIX_DOMAIN"),
  clientId: optional("MYRIX_OIDC_CLIENT_ID") ?? "myrix-bff",
  clientSecret: required("MYRIX_OIDC_CLIENT_SECRET"),
  ownerId: required("MYRIX_OWNER_ID"),
  ownerUsername: required("MYRIX_OWNER_USERNAME"),
  ownerPassword: required("MYRIX_OWNER_PASSWORD"),
  keycloakDbPassword: required("KEYCLOAK_DB_PASSWORD"),
  keycloakAdminUsername: optional("KEYCLOAK_ADMIN_USERNAME") ?? "kcadmin",
  keycloakAdminPassword: required("KEYCLOAK_ADMIN_PASSWORD"),
  images: {
    keycloak: required("KEYCLOAK_IMAGE"),
    postgres: required("POSTGRES_IMAGE"),
  },
  ...(optional("MYRIX_OWNER_EMAIL") ? { ownerEmail: optional("MYRIX_OWNER_EMAIL") } : {}),
  // 站点名默认留占位符：集成时显式传真实 FQDN，或落盘后做占位符替换。
  ...(optional("MYRIX_NGINX_SITE_TYPE") ? { nginxSiteType: optional("MYRIX_NGINX_SITE_TYPE") } : {}),
  ...(optional("MYRIX_NGINX_SITE_DOMAIN") ? { nginxSiteDomain: optional("MYRIX_NGINX_SITE_DOMAIN") } : {}),
  ...(optional("MYRIX_NGINX_ACME_WEBROOT") ? { nginxAcmeWebroot: optional("MYRIX_NGINX_ACME_WEBROOT") } : {}),
  ...(optional("MYRIX_NGINX_TLS_DIR") ? { nginxTlsDirectory: optional("MYRIX_NGINX_TLS_DIR") } : {}),
  ...(optional("MYRIX_BFF_HOST_PORT") ? { bffHostPort: Number(optional("MYRIX_BFF_HOST_PORT")) } : {}),
  ...(optional("MYRIX_KEYCLOAK_HOST_PORT") ? { keycloakHostPort: Number(optional("MYRIX_KEYCLOAK_HOST_PORT")) } : {}),
});

/** 站点文件名不能带路径分隔符（只允许相对 basename）。 */
const nginxName = assertBaseName(optional("MYRIX_NGINX_CONF_NAME") ?? "myrix-auth.conf");
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.conf$/.test(nginxName)) {
  throw new Error("MYRIX_NGINX_CONF_NAME must be a plain '<name>.conf' file name without directories");
}

const files = [
  // realm 导入必须最早存在且只读；Keycloak 只在 startup import 时读取它。
  // 生成仍用 0600：容器以 UID 1000 运行，部署者必须**在容器启动前**只给该 inode
  //   sudo chown 1000:1000 <file> && sudo chmod 0600 <file>
  // 宿主父目录保持 0700；绝不 chmod 777，也绝不把其它秘密文件一起放开。
  [config.realmImportFileName, config.realmImportJson, 0o600],
  [nginxName, config.nginxSite, 0o644],
  ["keycloak.env", renderKeycloakEnvFile(config), 0o600],
  ["bff-oidc.env", `${Object.entries(config.bffOidcEnv).map(([key, value]) => `${key}=${value}`).join("\n")}\n`, 0o600],
  ["keycloak-db-init.sql", config.keycloakDbInitSql, 0o600],
  [".gitignore", "*\n!.gitignore\n", 0o644],
];

for (const [name] of files) assertBaseName(name);

// no-clobber 预检：**全量目标**都不存在才落盘。lstat 能识别 symlink（含 dangling），
// 因此不会顺着符号链接覆盖到目录外。校验先于创建目录，避免"目录建好才发现要拒绝"。
const targets = files.map(([name]) => resolve(outDir, name));
for (const target of targets) {
  try {
    lstatSync(target);
    throw new Error(`${target} already exists; refusing to overwrite rendered auth artifacts (remove it explicitly to re-render)`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

// 目录：不存在才创建（并显式收紧为 0700）；已存在则只做类型检查，不改动其权限。
let createdDir = false;
try {
  const stat = lstatSync(outDir);
  if (!stat.isDirectory()) throw new Error("--out must be a directory (existing symlink or file is not accepted)");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  createdDir = true;
}
if (createdDir) chmodSync(outDir, 0o700);

// 落盘：`wx` 是原子排他创建，重复运行或并发运行都会被内核拒绝，而不是静默截断。
const created = [];
try {
  for (const [name, content, mode] of files) {
    const target = resolve(outDir, name);
    const fd = openSync(target, "wx", mode);
    created.push(target);
    try {
      writeFileSync(fd, content);
    } finally {
      closeSync(fd);
    }
    // open 的 mode 会被 umask 削，这里再显式收紧一次。
    chmodSync(target, mode);
  }
} catch (error) {
  // 失败时清掉本次已创建的文件（绝不触碰先前就存在的文件），避免半成品残留。
  for (const target of created) {
    try {
      unlinkSync(target);
    } catch {
      // 清理失败不掩盖原始错误。
    }
  }
  throw error;
}

// 只输出非密事实；describeAuthConfig 不含任何 secret。
process.stdout.write(`${JSON.stringify({
  outDir,
  files: files.map(([name]) => name),
  artifacts: config.artifacts,
  config: describeAuthConfig(config),
  next: [
    "realm 导入文件必须在容器启动前仅对该 inode 执行 sudo chown 1000:1000 && sudo chmod 0600（宿主父目录保持 0700，不要 chmod 777）。",
    "首次部署镜像必须来自合并 master 后的 GitHub Actions 构建；本脚本不构建、不拉取、不部署。",
  ],
}, null, 2)}\n`);
