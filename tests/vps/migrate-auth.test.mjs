// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0
/**
 * auth schema 迁移入口的纯测试：不连接数据库、不加载 tsx、不调用真实模型。
 *
 * 它覆盖 Lead 的 `deploy/images/migrate.mjs` 不包含的那一段：`myrix_auth`
 * schema 由 BFF 的 `migrateAuth()` 建表并授权，因此单机部署需要一个显式的
 * 一次性入口，而且必须 fail-closed。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import {
  AuthMigrationError,
  loadPgPool,
  resolveInputs,
  runAuthMigration,
  sanitizeError,
} from "../../deploy/vps/migrate-auth.mjs";

const FILE = new URL("../../deploy/vps/migrate-auth.mjs", import.meta.url).pathname;
const REPO = new URL("../../", import.meta.url).pathname;

test("缺少迁移连接串或应用角色时拒绝执行", async () => {
  assert.throws(() => resolveInputs({}), AuthMigrationError);
  assert.throws(() => resolveInputs({ MYRIX_MIGRATE_DATABASE_URL: "postgres://u:p@h/db" }), AuthMigrationError);
  assert.throws(
    () => resolveInputs({ MYRIX_MIGRATE_DATABASE_URL: "mysql://u:p@h/db", MYRIX_AUTH_ROLE: "myrix_auth" }),
    AuthMigrationError,
  );
  assert.throws(
    () => resolveInputs({ MYRIX_MIGRATE_DATABASE_URL: "postgres://u:p@h", MYRIX_AUTH_ROLE: "myrix_auth" }),
    AuthMigrationError,
  );
  // 角色名必须是安全的 SQL 标识符（migrateAuth 自身也会校验）。
  assert.throws(
    () => resolveInputs({ MYRIX_MIGRATE_DATABASE_URL: "postgres://u:p@h/db", MYRIX_AUTH_ROLE: "bad-role!" }),
    AuthMigrationError,
  );
});

test("只接受显式的迁移角色连接串与角色名", () => {
  const { url, role } = resolveInputs({
    MYRIX_MIGRATE_DATABASE_URL: "postgres://myrix_migrator:pw@postgres:5432/myrix?sslmode=disable",
    MYRIX_AUTH_ROLE: "myrix_auth",
  });
  assert.match(url, /^postgres:\/\/myrix_migrator:/);
  assert.equal(role, "myrix_auth");
});

test("runAuthMigration 把校验后的 URL 与角色交给注入的 runner", async () => {
  const calls = [];
  const result = await runAuthMigration({
    env: {
      MYRIX_MIGRATE_DATABASE_URL: "postgres://myrix_migrator:secret-pw@postgres:5432/myrix",
      MYRIX_AUTH_ROLE: "myrix_auth",
    },
    appRoot: "/app",
    migrate: async (url, role, appRoot) => { calls.push({ url, role, appRoot }); },
  });
  assert.equal(result.role, "myrix_auth");
  assert.deepEqual(calls, [{
    url: "postgres://myrix_migrator:secret-pw@postgres:5432/myrix",
    role: "myrix_auth",
    appRoot: "/app",
  }]);
});

test("MYRIX_APP_ROOT 可覆盖镜像内的仓库根路径", async () => {
  const calls = [];
  await runAuthMigration({
    env: {
      MYRIX_MIGRATE_DATABASE_URL: "postgres://u:p@h/db",
      MYRIX_AUTH_ROLE: "myrix_auth",
      MYRIX_APP_ROOT: "/srv/myrix",
    },
    migrate: async (_url, _role, appRoot) => { calls.push(appRoot); },
  });
  assert.deepEqual(calls, ["/srv/myrix"]);
});

test("失败信息不会回显连接串里的密码", () => {
  const message = sanitizeError(new Error("connect ECONNREFUSED postgres://myrix_migrator:hunter2@postgres:5432/myrix"));
  assert.doesNotMatch(message, /hunter2/);
  assert.match(message, /\[redacted\]/);
  assert.doesNotMatch(sanitizeError(new Error("password=hunter2 failed")), /hunter2/);
});

test("入口文件不 seed、不包含开发身份常量", () => {
  const source = readFileSync(FILE, "utf8");
  assert.doesNotMatch(source, /DEV_IDENTITIES|DEV_TENANT_ID|myrix_local_app/);
  // 不导入任何 seed 模块，也没有 seed 调用（注释里说明"never seeds"是允许的）。
  assert.doesNotMatch(source, /from ['"][^'"]*seed[^'"]*['"]/);
  assert.doesNotMatch(source, /\brunSeed\s*\(/);
  assert.doesNotMatch(source, /MYRIX_SEED/);
  // 可被镜像以只读方式挂载执行。
  assert.ok(statSync(FILE).size > 0);
});

test("pg 从声明它的 workspace 解析，仓库根目录没有也不该有 pg 依赖", async () => {
  const source = readFileSync(FILE, "utf8");
  // 必须用 createRequire(<appRoot>/apps/bff/package.json) 解析，而不是裸 import('pg')。
  assert.match(source, /createRequire/);
  assert.match(source, /apps\/bff\/package\.json/);
  assert.doesNotMatch(source, /await import\(['"]pg['"]\)/);
  // 仓库根 package.json 不得声明 pg；apps/bff 才声明。
  const rootPkg = JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8"));
  assert.equal(Boolean(rootPkg.dependencies?.pg ?? rootPkg.devDependencies?.pg), false, "root 不应有 pg 依赖");
  const bffPkg = JSON.parse(readFileSync(resolve(REPO, "apps/bff/package.json"), "utf8"));
  assert.equal(typeof bffPkg.dependencies.pg, "string");
  // 真实解析可用（本仓库已安装 workspace 依赖）。
  const Pool = await loadPgPool(REPO);
  assert.equal(typeof Pool, "function");
  // 解析不到时必须 fail-closed，而不是退回别的驱动。
  await assert.rejects(() => loadPgPool("/nonexistent-image-root"), AuthMigrationError);
});
