// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0
/**
 * Compose 契约测试：只读 compose.yml / compose.auth.yml，不启动任何容器、
 * 不接触现有开发数据库。
 *
 * 断言的是部署边界本身：所有服务在同一个 `myrix` 网络、只有 BFF（固定
 * 127.0.0.1:8787）与 Keycloak（覆盖片段 127.0.0.1:18080）发布宿主端口、
 * 每个服务只挂自己的 env_file、Cell 对齐 UID65532 与
 * DSH_HOME=/var/lib/myrix/dsh-home、迁移是显式一次性 job。
 *
 * 除了静态文本断言，本文件还用**真实的 `docker compose config --format json`**
 * 合并两个 compose 文件来验证网络/端口/路径/depends_on —— 只用正则自证不算数。
 * 全部使用假密钥与临时目录，绝不启动正式服务。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const REPO = new URL("../../", import.meta.url).pathname;
const COMPOSE = `${REPO}deploy/vps/compose.yml`;
const AUTH_FRAGMENT = `${REPO}deploy/auth/compose.auth.yml`;
const text = readFileSync(COMPOSE, "utf8");
const fragment = readFileSync(AUTH_FRAGMENT, "utf8");

/** 顶层服务段落切片：返回 { name, body } 数组。 */
function services(source = text) {
  const body = source.split(/^services:\s*$/m)[1] ?? "";
  const lines = body.split("\n");
  const found = [];
  let current = null;
  for (const line of lines) {
    if (/^[A-Za-z_][\w.-]*:\s*$/.test(line)) break;
    const match = /^  ([a-z0-9][a-z0-9-]*):\s*$/.exec(line);
    if (match) {
      if (current) found.push(current);
      current = { name: match[1], body: "" };
      continue;
    }
    if (current) current.body += `${line}\n`;
  }
  if (current) found.push(current);
  return found;
}

const byName = Object.fromEntries(services().map((service) => [service.name, service.body]));
const EXPECTED_SERVICES = ["postgres", "provision", "migrate", "auth", "grants", "bff", "gateway", "cell-1"];
const PERSISTENT = ["bff", "gateway", "cell-1"];
const ONESHOT_SERVICES = ["provision", "migrate", "auth", "grants"];
const ALL_BASE_SERVICES = [...new Set([...EXPECTED_SERVICES, ...PERSISTENT])];

test("编排包含全部预期服务，且完全没有 Caddy / CellManager / Helm", () => {
  assert.deepEqual(services().map((service) => service.name), EXPECTED_SERVICES);
  const definitions = Object.values(byName).join("\n");
  assert.doesNotMatch(definitions, /cell-manager/i);
  assert.doesNotMatch(definitions, /kubernetes|helm/i);
  // Caddy 必须彻底消失：没有服务、没有 profile、没有 Caddyfile 引用。
  assert.doesNotMatch(definitions, /caddy/i);
  assert.doesNotMatch(text, /profiles:/);
  assert.doesNotMatch(fragment, /^\s{2}caddy:/m);
});

test("基底每个服务都显式加入同一个 myrix 网络", () => {
  assert.match(text, /^name: myrix-vps$/m);
  assert.match(text, /^  myrix:\n    name: myrix-vps$/m);
  // provision/migrate/auth/grants 也必须显式声明，否则会落到 default 网络而连不上 postgres。
  for (const name of ALL_BASE_SERVICES) {
    assert.match(byName[name], /^\s{4}networks:\n\s{6}- myrix$/m, `${name} 必须加入 myrix 网络`);
  }
});

test("只有 BFF 固定发布宿主端口 127.0.0.1:8787，没有可选公网 bind", () => {
  const published = Object.entries(byName)
    .filter(([, body]) => /^\s{4}ports:/m.test(body))
    .map(([name]) => name);
  assert.deepEqual(published, ["bff"]);
  // 固定回环，且绝不使用 MYRIX_BFF_BIND 之类的可配置 bind。
  assert.match(byName.bff, /^\s{6}- "127\.0\.0\.1:8787:8787"$/m);
  assert.doesNotMatch(text, /MYRIX_BFF_BIND/);
  assert.doesNotMatch(text, /\$\{[A-Z_]*BIND/);
  for (const name of ["gateway", "cell-1", "postgres", "provision", "migrate", "auth", "grants"]) {
    assert.doesNotMatch(byName[name], /^\s{4}ports:/m, `${name} 不应发布宿主端口`);
  }
  // 内部监听绝不发布。
  for (const mapping of ["8791:8791", "8404:8404", "8790:8790", "5432:5432", "9000:9000"]) {
    assert.equal(text.includes(mapping), false, `不应发布 ${mapping}`);
  }
  // Keycloak 的回环发布只属于覆盖片段。
  assert.match(fragment, /^\s{6}- "127\.0\.0\.1:18080:8080"$/m);
  assert.equal(fragment.includes("9000:9000"), false);
});

test("每个服务只挂自己的 env_file，Cell 不接触平台秘密", () => {
  for (const name of PERSISTENT) assert.match(byName[name], /env_file:/, `${name} 缺少 env_file`);
  assert.doesNotMatch(byName.bff, /public\.env/);
  assert.doesNotMatch(byName.gateway, /public\.env/);
  assert.doesNotMatch(byName["cell-1"], /secrets\/bff\.env|secrets\/gateway\.env|public\.env/);
  assert.match(byName["cell-1"], /secrets\/cell-1\.env/);
  assert.match(byName.bff, /secrets\/bff\.env/);
  assert.match(byName.gateway, /secrets\/gateway\.env/);
  for (const name of ["bff", "cell-1"]) assert.doesNotMatch(byName[name], /secrets\/gateway\.env/);
  // Keycloak env 只在覆盖片段里，且只挂给 keycloak。
  assert.match(fragment, /\.\/auth\/keycloak\.env/);
  assert.doesNotMatch(Object.values(byName).join("\n"), /keycloak\.env/);
});

test("Cell 对齐 K8s/镜像契约：UID65532、/var/lib/myrix/dsh-home、8404", () => {
  assert.match(byName["cell-1"], /^\s{4}user: "65532:65532"$/m);
  assert.match(byName["cell-1"], /DSH_HOME: \/var\/lib\/myrix\/dsh-home/);
  assert.doesNotMatch(byName["cell-1"], /DSH_HOME: \/(?:root|tmp)\b/);
  assert.doesNotMatch(byName["cell-1"], /\/home\/node/);
  assert.match(byName["cell-1"], /myrix-cell-1-home:\/var\/lib\/myrix\/dsh-home/);
  assert.match(byName["cell-1"], /MYRIX_DRIVER_PORT: "8404"/);
  assert.match(byName["cell-1"], /http:\/\/127\.0\.0\.1:8404\/v1\/ready/);
  for (const volume of ["myrix-pgdata", "myrix-cell-1-home"]) {
    assert.match(text, new RegExp(`^  ${volume}:$`, "m"), `缺少卷 ${volume}`);
  }
  // Cell 的 env 白名单由 init.mjs 写入 cell-1.env；compose 不内联平台秘密。
  assert.doesNotMatch(byName["cell-1"], /MYRIX_CELL_INTERNAL_HTTP_ORIGINS/);
});

test("迁移/授权是显式一次性 job，常驻服务依赖其成功", () => {
  assert.match(text, /x-oneshot:[\s\S]*?restart: "no"/);
  for (const name of ONESHOT_SERVICES) {
    assert.match(byName[name], /<<: \*oneshot/, `${name} 必须套用一次性基线`);
  }
  for (const name of PERSISTENT) {
    assert.match(byName[name], /condition: service_completed_successfully/, `${name} 必须等待一次性 job`);
  }
  assert.match(byName.migrate, /postgres:[\s\S]*?condition: service_healthy/);
  assert.match(byName.postgres, /pg_isready/);
  // Postgres 镜像由 .env 固定，不再内联浮动 tag。
  assert.match(byName.postgres, /MYRIX_IMAGE_POSTGRES/);
  assert.doesNotMatch(text, /image: postgres:17-alpine\b/);
  assert.match(byName.postgres, /myrix-pgdata:\/var\/lib\/postgresql\/data/);
  assert.match(byName.migrate, /\/app\/deploy\/images\/migrate\.mjs", "--target", "business,gateway"/);
  // auth job 只读挂载本目录的入口。
  assert.match(byName.auth, /\.\/migrate-auth\.mjs:\/app\/deploy\/images\/migrate-auth\.mjs:ro/);
  assert.match(byName.grants, /auth:[\s\S]*?condition: service_completed_successfully/);
  // provision 显式创建 Keycloak 独立库（两步：角色 + keycloak 库）。
  assert.match(readFileSync(`${REPO}deploy/vps/sql/provision.sh`, "utf8"), /05_keycloak_db\.sql/);
});

test("常驻服务非 root、read_only、tmpfs", () => {
  assert.match(text, /x-hardening:[\s\S]*?no-new-privileges:true/);
  assert.match(text, /x-hardening:[\s\S]*?read_only: true/);
  assert.match(text, /x-hardening:[\s\S]*?cap_drop:[\s\S]*?- ALL/);
  for (const name of PERSISTENT) assert.match(byName[name], /<<: \*hardening/, `${name} 未套用安全基线`);
});

test("BFF 使用公共 issuer DNS，不绕过既有 CDN/源站访问限制", () => {
  assert.doesNotMatch(byName.bff, /^\s+extra_hosts:/m);
  assert.doesNotMatch(byName.bff, /host-gateway/);
});

test("PostgreSQL 随宿主重启，私有 SQL 作业使用明确的文件属主 UID", () => {
  assert.match(byName.postgres, /restart: unless-stopped/);
  assert.match(byName.postgres, /stop_grace_period: 60s/);
  for (const name of ["provision", "grants"]) {
    assert.match(byName[name], /user: "1000:1000"/);
  }
  assert.match(byName.provision, /exec \/bin\/sh \/sql\/provision\.sh/);
  const provision = readFileSync(`${REPO}deploy/vps/sql/provision.sh`, "utf8");
  assert.match(provision, /log_min_error_statement=panic/);
  assert.match(provision, /log_statement=none/);
  assert.equal((provision.match(/-v VERBOSITY=terse/g) ?? []).length, 2);
});

test("备份/恢复覆盖 Keycloak 独立库与 Cell 卷，且禁止 down -v 捷径", () => {
  const backup = readFileSync(`${REPO}deploy/vps/backup.sh`, "utf8");
  const restore = readFileSync(`${REPO}deploy/vps/restore.sh`, "utf8");
  // Keycloak 独立库必须单独 dump：原来的 pg_dump myrix 不足以恢复登录。
  assert.match(backup, /keycloak/);
  assert.match(backup, /myrix-vps_myrix-cell-1-home/);
  assert.match(backup, /auth\b/);
  assert.match(restore, /keycloak/);
  // 卷名在 compose 里是逻辑名，Compose 再前缀项目名。
  assert.match(restore, /myrix-vps_myrix-cell-1-home/);
  // 脚本绝不把“删卷重置”当作恢复手段：注释里警告可以，命令行里不行。
  const commandLines = (source) => source.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  for (const script of [backup, restore]) {
    assert.doesNotMatch(commandLines(script), /docker\s+(compose\s+)?down\b/);
    assert.doesNotMatch(commandLines(script), /volume\s+rm\b/);
    assert.doesNotMatch(commandLines(script), /\brm\s+-rf\b[\s\S]{0,40}volume/);
  }
  // README 里也必须明确禁止。
  const readme = readFileSync(`${REPO}deploy/vps/README.md`, "utf8");
  assert.match(readme, /down -v/);
  assert.match(readme, /nginx -t/);
  assert.match(readme, /原样保留/);
});

test("公开 compose 校验（真实 docker compose config --format json，仅 docker 可用时）", async (t) => {
  let dockerOk = true;
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
  } catch {
    dockerOk = false;
  }
  if (!dockerOk) {
    t.skip("docker compose 不可用，跳过实际解析校验");
    return;
  }
  const { mkdtemp, mkdir, cp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "myrix-vps-compose-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // 复刻真实布局：基底在 <root>/vps/compose.yml，片段在 <root>/auth/compose.auth.yml。
  await mkdir(join(dir, "vps"), { recursive: true });
  await mkdir(join(dir, "auth"), { recursive: true });
  await cp(COMPOSE, join(dir, "vps", "compose.yml"));
  await cp(AUTH_FRAGMENT, join(dir, "auth", "compose.auth.yml"));
  await mkdir(join(dir, "vps", "secrets"), { recursive: true });
  await mkdir(join(dir, "vps", "auth"), { recursive: true });
  await mkdir(join(dir, "vps", "sql"), { recursive: true });
  // 假密钥：绝不使用真实 .env 或模型密钥。
  await cp(`${REPO}deploy/vps/sql/provision.sh`, join(dir, "vps", "sql", "provision.sh"));
  await cp(`${REPO}deploy/vps/sql/grants.sh`, join(dir, "vps", "sql", "grants.sh"));
  for (const name of ["provision.env", "migrator.env", "bff.env", "gateway.env", "cell-1.env"]) {
    await writeFile(join(dir, "vps", "secrets", name), "# placeholder\n");
  }
  await writeFile(join(dir, "vps", "secrets", "postgres-superuser-password"), "placeholder\n", { mode: 0o600 });
  await writeFile(join(dir, "vps", "auth", "keycloak.env"), "KC_DB=postgres\n");
  await writeFile(join(dir, "vps", "auth", "realm-myrix.json"), "{}\n");
  await cp(`${REPO}deploy/vps/migrate-auth.mjs`, join(dir, "vps", "migrate-auth.mjs"));
  const sha = "a".repeat(40);
  await writeFile(join(dir, "vps", ".env"), [
    `MYRIX_IMAGE_BFF=docker.io/hewenyulucky/myrix:bff-sha-${sha}`,
    `MYRIX_IMAGE_GATEWAY=docker.io/hewenyulucky/myrix:gateway-sha-${sha}`,
    `MYRIX_IMAGE_CELL=docker.io/hewenyulucky/myrix:cell-sha-${sha}`,
    `MYRIX_IMAGE_KEYCLOAK=docker.io/hewenyulucky/myrix:keycloak-sha-${sha}`,
    "MYRIX_IMAGE_POSTGRES=docker.io/library/postgres:17-alpine@sha256:" + "b".repeat(64),
    "MYRIX_DOMAIN=example.test",
    "",
  ].join("\n"));

  // 基底单独解析：Keycloak 不在基底，所以 keycloak 依赖的 provision 之外没有别的服务。
  const baseOut = execFileSync("docker", ["compose", "-f", join(dir, "vps", "compose.yml"), "config", "--format", "json"], {
    cwd: join(dir, "vps"), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const base = JSON.parse(baseOut);
  assert.equal(base.services.keycloak, undefined, "基底不得内联 Keycloak 服务");

  // 两个文件合并：这才是最终部署命令。
  const out = execFileSync("docker", [
    "compose",
    "-f", join(dir, "vps", "compose.yml"),
    "-f", join(dir, "auth", "compose.auth.yml"),
    "config", "--format", "json",
  ], { cwd: join(dir, "vps"), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const merged = JSON.parse(out);

  // 1) 服务集合：基底八个 + 覆盖片段的 keycloak。
  assert.deepEqual(Object.keys(merged.services).sort(),
    ["auth", "bff", "cell-1", "gateway", "grants", "keycloak", "migrate", "postgres", "provision"]);

  // 2) 所有服务都在同一个 myrix 网络上。
  assert.deepEqual(Object.keys(merged.networks), ["myrix"]);
  assert.equal(merged.networks.myrix.name, "myrix-vps");
  for (const [name, service] of Object.entries(merged.services)) {
    assert.deepEqual(Object.keys(service.networks ?? {}), ["myrix"], `${name} 未加入 myrix 网络`);
  }

  // 3) 端口：只有 bff 与 keycloak，且都绑回环。
  const published = Object.fromEntries(Object.entries(merged.services)
    .filter(([, service]) => (service.ports ?? []).length > 0)
    .map(([name, service]) => [name, service.ports]));
  assert.deepEqual(Object.keys(published).sort(), ["bff", "keycloak"]);
  assert.equal(published.bff[0].host_ip, "127.0.0.1");
  assert.equal(String(published.bff[0].published), "8787");
  assert.equal(published.keycloak[0].host_ip, "127.0.0.1");
  assert.equal(String(published.keycloak[0].published), "18080");
  assert.equal(String(published.keycloak[0].target), "8080");
  assert.equal(JSON.stringify(published.keycloak).includes("9000"), false);

  // 4) Cell：UID65532、DSH_HOME 路径、卷挂载、内部 HTTP 契约。
  const cell = merged.services["cell-1"];
  assert.equal(cell.user, "65532:65532");
  assert.equal(cell.environment.DSH_HOME, "/var/lib/myrix/dsh-home");
  assert.equal(cell.environment.MYRIX_DRIVER_PORT, "8404");
  assert.deepEqual(cell.volumes.map((volume) => `${volume.source}->${volume.target}`),
    ["myrix-cell-1-home->/var/lib/myrix/dsh-home"]);
  // Compose 会给命名卷加项目前缀，备份脚本必须用真实卷名。
  assert.equal(merged.volumes["myrix-cell-1-home"].name, "myrix-vps_myrix-cell-1-home");
  assert.equal(cell.read_only, true);
  assert.deepEqual(cell.cap_drop, ["ALL"]);
  assert.ok((cell.tmpfs ?? []).length > 0);

  // 5) 保留公共 issuer DNS 和源站限制，不加直连宿主的解析覆盖。
  assert.equal(merged.services.bff.read_only, true);
  assert.equal(merged.services.bff.extra_hosts, undefined);
  assert.equal(merged.services.postgres.restart, "unless-stopped");
  for (const name of ["provision", "grants"]) {
    assert.equal(merged.services[name].user, "1000:1000");
    assert.deepEqual(merged.services[name].cap_drop, ["ALL"]);
  }
  assert.ok(merged.services.keycloak.healthcheck.test[3].includes('test "$$status" = 200'));

  // 6) depends_on：一次性链与跨文件依赖。
  assert.equal(merged.services.migrate.depends_on.provision.condition, "service_completed_successfully");
  assert.equal(merged.services.auth.depends_on.migrate.condition, "service_completed_successfully");
  assert.equal(merged.services.grants.depends_on.auth.condition, "service_completed_successfully");
  assert.equal(merged.services.bff.depends_on.grants.condition, "service_completed_successfully");
  assert.equal(merged.services["cell-1"].depends_on.grants.condition, "service_completed_successfully");
  // keycloak 依赖基底的 provision（跨文件）与 postgres。
  assert.equal(merged.services.keycloak.depends_on.provision.condition, "service_completed_successfully");
  assert.equal(merged.services.keycloak.depends_on.postgres.condition, "service_healthy");

  // 7) 卷：只应有 pgdata 与 cell home，没有 caddy 卷。
  assert.deepEqual(Object.keys(merged.volumes ?? {}).sort(), ["myrix-cell-1-home", "myrix-pgdata"]);

  // 8) 解析后的常驻服务确实是只读、非 root 能力、且有 tmpfs。
  for (const name of PERSISTENT) {
    assert.equal(merged.services[name].read_only, true, `${name} read_only`);
    assert.deepEqual(merged.services[name].cap_drop, ["ALL"], `${name} cap_drop`);
    assert.ok((merged.services[name].tmpfs ?? []).length > 0, `${name} tmpfs`);
  }

  // 9) 镜像：四个 Myrix 组件指向同一个 SHA，postgres 用摘要。
  assert.match(merged.services.bff.image, /:bff-sha-a{40}$/);
  assert.match(merged.services.keycloak.image, /:keycloak-sha-a{40}$/);
  assert.match(merged.services.postgres.image, /^docker\.io\/library\/postgres:17-alpine@sha256:b{64}$/);
  assert.equal(merged.services.provision.image, merged.services.postgres.image);
});
