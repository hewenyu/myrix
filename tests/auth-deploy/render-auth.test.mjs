// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0
/**
 * `deploy/auth/render-auth.mjs` 的**CLI 回归测试**（node:test，子进程）。
 *
 * 只覆盖落盘安全语义，不接触网络/镜像/服务：
 *   - 默认 no-clobber：重复运行必须拒绝，且既有文件 bytes 不变；
 *   - 危险 basename（路径分隔符 / `..`）必须在校验阶段拒绝，绝不先建目录；
 *   - 已有目标即使是 symlink（含 dangling）也拒绝；
 *   - stdout / stderr 在任何路径都不得回显任何 secret 值。
 *
 * 所有输入都用 RFC 保留域名 `*.example.test` 与明显假口令；输出写到
 * `os.tmpdir()` 下的独立临时目录，**不在仓库内落任何文件、不读真实 .env**。
 *
 * 运行：node --test tests/auth-deploy/render-auth.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RENDERER = fileURLToPath(new URL("../../deploy/auth/render-auth.mjs", import.meta.url));

const SECRETS = {
  clientSecret: "bff-client-secret-value-0001",
  ownerPassword: "owner-temporary-password-0001",
  keycloakDbPassword: "keycloak-db-password-0001",
  keycloakAdminPassword: "keycloak-admin-password-0001",
};
const SECRET_VALUES = Object.values(SECRETS);

/** 显式的假环境（不含任何真实凭据）；不读取进程里已有的 MYRIX_* 覆盖。 */
const ENV = {
  MYRIX_DOMAIN: "myrix.example.test",
  MYRIX_OIDC_CLIENT_SECRET: SECRETS.clientSecret,
  MYRIX_OWNER_ID: "11111111-1111-4111-8111-111111111111",
  MYRIX_OWNER_USERNAME: "owner",
  MYRIX_OWNER_PASSWORD: SECRETS.ownerPassword,
  KEYCLOAK_DB_PASSWORD: SECRETS.keycloakDbPassword,
  KEYCLOAK_ADMIN_USERNAME: "kcadmin",
  KEYCLOAK_ADMIN_PASSWORD: SECRETS.keycloakAdminPassword,
  KEYCLOAK_IMAGE: `docker.io/hewenyulucky/myrix:keycloak-sha-${"a".repeat(40)}`,
  POSTGRES_IMAGE: "postgres:17.6-alpine",
};

const tempDirs = [];
const makeTemp = () => {
  const dir = mkdtempSync(join(tmpdir(), "myrix-render-auth-"));
  tempDirs.push(dir);
  return dir;
};
process.on("exit", () => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响断言结果。
    }
  }
});

const run = (outDir, extraEnv = {}) =>
  spawnSync(process.execPath, [RENDERER, "--out", outDir], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", TMPDIR: tmpdir(), ...ENV, ...extraEnv },
  });

const leaksSecret = text => SECRET_VALUES.some(value => (text ?? "").includes(value));

test("首次渲染：目录 0700、含密文件 0600，且 stdout/stderr 不泄露 secret", () => {
  const outDir = join(makeTemp(), "generated");
  const result = run(outDir);
  assert.equal(result.status, 0, "renderer should succeed on a fresh directory");
  assert.equal(leaksSecret(result.stdout), false, "stdout leaked a secret");
  assert.equal(leaksSecret(result.stderr), false, "stderr leaked a secret");

  // 生成物齐全。
  for (const name of ["realm-myrix.json", "myrix-auth.conf", "keycloak.env", "bff-oidc.env", "keycloak-db-init.sql", ".gitignore"]) {
    assert.equal(existsSync(join(outDir, name)), true, `${name} should exist`);
  }
  // 目录 0700；realm / env / sql 都是 0600（realm 的 1000:1000 由部署者另行 chown，脚本不做）。
  assert.equal(statSync(outDir).mode & 0o777, 0o700);
  for (const name of ["realm-myrix.json", "keycloak.env", "bff-oidc.env", "keycloak-db-init.sql"]) {
    assert.equal(statSync(join(outDir, name)).mode & 0o777, 0o600, `${name} should be 0600`);
  }
  // stdout 只含非密事实。
  assert.equal(result.stdout.includes(SECRETS.ownerPassword), false);
});

test("默认 no-clobber：重复运行拒绝，且既有文件 bytes 完全不变", () => {
  const outDir = join(makeTemp(), "generated");
  const first = run(outDir);
  assert.equal(first.status, 0);
  const realmPath = join(outDir, "realm-myrix.json");
  const envPath = join(outDir, "keycloak.env");
  const before = {
    realm: readFileSync(realmPath),
    env: readFileSync(envPath),
    realmMode: statSync(realmPath).mode & 0o777,
  };

  // 换一组 secret 再跑一次：必须整体拒绝，绝不静默覆盖既有秘密。
  const second = run(outDir, {
    MYRIX_OIDC_CLIENT_SECRET: "bff-client-secret-value-9999",
    KEYCLOAK_ADMIN_PASSWORD: "keycloak-admin-password-9999",
  });
  assert.notEqual(second.status, 0, "second render over existing files must fail");
  assert.match(second.stderr, /already exists/);
  assert.equal(leaksSecret(second.stdout), false, "failed stdout leaked a secret");
  assert.equal(leaksSecret(second.stderr), false, "failed stderr leaked a secret");
  // 既有秘密与新秘密都不得回显。
  assert.equal(second.stderr.includes("bff-client-secret-value-9999"), false);

  // 原文件 bytes 与权限不变。
  assert.deepEqual(readFileSync(realmPath), before.realm);
  assert.deepEqual(readFileSync(envPath), before.env);
  assert.equal(statSync(realmPath).mode & 0o777, before.realmMode);
  // 新 secret 也绝不能被写进去。
  assert.equal(readFileSync(envPath, "utf8").includes("keycloak-admin-password-9999"), false);
});

test("危险 basename 在创建目录前就被拒绝（各种分隔符/父目录）", () => {
  // NUL 无法经 env 传给子进程（Node 直接拒绝），故此处只覆盖路径类危险取值。
  for (const bad of ["../evil.conf", "dir/evil.conf", "..\\evil.conf", "/etc/evil.conf"]) {
    const outDir = join(makeTemp(), `generated-${bad.replace(/[^a-z]/gi, "_")}`);
    const result = run(outDir, { MYRIX_NGINX_CONF_NAME: bad });
    assert.notEqual(result.status, 0, `basename ${JSON.stringify(bad)} must be rejected`);
    // 校验必须先于 mkdirSync：拒绝时绝不留下新目录。
    assert.equal(existsSync(outDir), false, "rejected basename must not create the output directory");
    // 错误信息只给固定字段说明，不回显可疑取值，也不回显 secret。
    assert.match(result.stderr, /basename|MYRIX_NGINX_CONF_NAME/);
    assert.equal(result.stderr.includes(bad), false, "error must not echo the rejected file name");
    assert.equal(leaksSecret(result.stderr), false);
  }
});

test("已有目标含 symlink（哪怕 dangling）也拒绝覆盖", () => {
  const outDir = join(makeTemp(), "generated");
  mkdirSync(outDir, { mode: 0o700 });
  // 指向不存在文件的 symlink：lstat 仍能识别，绝不能顺着链接写出去。
  symlinkSync(join(outDir, "does-not-exist"), join(outDir, "realm-myrix.json"));
  const result = run(outDir);
  assert.notEqual(result.status, 0, "symlink target must be rejected");
  assert.match(result.stderr, /already exists/);
  assert.equal(leaksSecret(result.stderr), false);
  // 仍然是 symlink，没有被替换成普通文件。
  assert.equal(lstatSync(join(outDir, "realm-myrix.json")).isSymbolicLink(), true);
});

test("缺失必填输入时拒绝，且错误只给字段名不回显取值", () => {
  const outDir = join(makeTemp(), "generated");
  const result = run(outDir, { KEYCLOAK_DB_PASSWORD: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /KEYCLOAK_DB_PASSWORD is required/);
  assert.equal(existsSync(outDir), false);
  assert.equal(leaksSecret(result.stderr), false);
});
