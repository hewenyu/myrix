// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0
/**
 * VPS 备份/恢复的**安全回归**：用 shell mock 掉 `docker`（以及固定 `date`），
 * 在临时目录里真实执行 `deploy/vps/backup.sh` 与 `deploy/vps/restore.sh`。
 *
 * 这些测试**不**连接数据库、**不**跑真实备份/恢复；它们证明的是脚本的失败语义：
 *   * 任何一步失败都以非零退出，且不写 SUCCESS、不打印"已完成"；
 *   * 缺卷 / 卷非空 / 项目容器仍在 running → 拒绝；
 *   * SHA-256 校验失败或清单不完整 → 在动库之前拒绝；
 *   * 数据库 dump 用显式超级用户（不是 NOBYPASSRLS 的 migrator）；
 *   * dump/restore **绝不用 `--no-privileges`**：ACL 必须随可信的同部署归档保留，
 *     migrate/auth/grants 无法重建全部授权；restore 保留 `--no-owner` 与 `--role`；
 *   * 脚本不创建/删除卷，不做 `down -v`，不自动解包配置归档，不吞错（无 `|| true`）。
 *
 * 不声称"真机恢复实测通过"：真实恢复验证需要 VPS + 真实镜像，见
 * deploy/vps/backup-restore.md。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("../../", import.meta.url).pathname;
const BACKUP_SRC = join(REPO, "deploy/vps/backup.sh");
const RESTORE_SRC = join(REPO, "deploy/vps/restore.sh");

const POSTGRES_IMAGE = "myrix/postgres:17.11-alpine3.24@sha256:" + "0".repeat(64);
const FIXED_STAMP = "20240101T000000Z";

// ---------------------------------------------------------------------------
// 夹具：临时 vps 目录 + mock bin
// ---------------------------------------------------------------------------

/**
 * mock docker 的行为完全由 MOCK_* 环境变量驱动，并把每次调用的 argv 追加到
 * MOCK_DOCKER_LOG，方便断言"某个危险调用根本没发生"。
 */
const MOCK_DOCKER = `#!/bin/sh
log="\${MOCK_DOCKER_LOG:-/dev/null}"
printf '%s\\n' "$*" >> "$log"
# 容器产物必须有容器侧收尾：先 umask 077，按 /out 数字属主 chown，并 chmod 600。
# 这是"命令契约"回归：backup.sh 若删掉容器侧收尾，mock 会直接失败而不是假装成功。
require_out_contract() {
  case "$payload" in *"umask 077"*) ;; *) echo "mock docker: 容器脚本缺少 umask 077" >&2; exit 41 ;; esac
  case "$payload" in *"stat -c"*"/out"*) ;; *) echo "mock docker: 容器脚本缺少 /out 属主探测" >&2; exit 41 ;; esac
  case "$payload" in *"chmod 600"*) ;; *) echo "mock docker: 容器脚本缺少 chmod 600" >&2; exit 41 ;; esac
  case "$payload" in *"chown"*OUT_OWNER*) ;; *) echo "mock docker: 容器脚本缺少 chown 到 /out 属主" >&2; exit 41 ;; esac
}
case "$1" in
  volume)
    [ "$2" = inspect ] || exit 0
    [ "\${MOCK_VOLUME_EXISTS:-1}" = "1" ] && exit 0 || exit 1
    ;;
  ps)
    printf '%s' "\${MOCK_PS_OUTPUT:-}"
    ;;
  run)
    payload="$*"
    # ACL 必须随可信的同部署归档保留：dump/restore 都不得丢弃授权。
    # 只看真正会执行的命令行——注释里说明"不加 --no-privileges"不算违规。
    payload_cmds="$(printf '%s\n' "$payload" | sed 's/^[[:space:]]*#.*$//')"
    case "$payload_cmds" in
      *--no-privileges*)
        echo "mock docker: 检测到 --no-privileges，会丢弃归档 ACL；拒绝" >&2
        exit 42
        ;;
    esac
    outdir=""
    for a in "$@"; do
      case "$a" in *:/out) outdir="\${a%:/out}" ;; esac
    done
    case "$payload" in
      *"ls -A /data"*)
        printf '%s' "\${MOCK_VOLUME_LS:-}"
        exit "\${MOCK_VOLUME_LS_EXIT:-0}"
        ;;
      *pg_dump*)
        require_out_contract
        exit_code="\${MOCK_DUMP_EXIT:-0}"
        if [ "$exit_code" = "0" ] && [ -n "$outdir" ]; then
          # 两个 pg_dump 在同一次 docker run 里：payload 同时含两条 --dbname。
          # 明确按数据库名分别产出非空自定义格式文件。
          case "$payload" in
            *--dbname=myrix*) printf 'PGDMP-business' > "$outdir/myrix.dump" ;;
          esac
          case "$payload" in
            *--dbname=keycloak*) printf 'PGDMP-keycloak' > "$outdir/keycloak.dump" ;;
          esac
        fi
        exit "$exit_code"
        ;;
      *pg_restore*)
        printf '%s' "\${MOCK_RESTORE_OUT:-}"
        exit "\${MOCK_RESTORE_EXIT:-0}"
        ;;
      *"tar -czf"*)
        require_out_contract
        if [ -n "$outdir" ]; then printf 'tgz' > "$outdir/cell-home.tgz"; fi
        exit "\${MOCK_TAR_EXIT:-0}"
        ;;
      *"tar -xzf"*)
        exit "\${MOCK_UNTAR_EXIT:-0}"
        ;;
      *)
        exit 0
        ;;
    esac
    ;;
esac
exit 0
`;

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "myrix-vps-safety-"));
  const vps = join(root, "vps");
  mkdirSync(vps, { recursive: true });
  copyFileSync(BACKUP_SRC, join(vps, "backup.sh"));
  copyFileSync(RESTORE_SRC, join(vps, "restore.sh"));

  writeFileSync(join(vps, ".env"), `MYRIX_IMAGE_POSTGRES=${POSTGRES_IMAGE}\n`);
  mkdirSync(join(vps, "secrets"), { recursive: true });
  writeFileSync(join(vps, "secrets/migrator.env"), "PGUSER=myrix_migrator\n");
  // 只用假口令；绝不读取真实 .env / secrets。
  writeFileSync(join(vps, "secrets/postgres-superuser-password"), "not-a-real-password\n");
  mkdirSync(join(vps, "sql"), { recursive: true });
  writeFileSync(join(vps, "sql/00_roles.sql"), "-- fixture\n");
  mkdirSync(join(vps, "auth"), { recursive: true });
  writeFileSync(join(vps, "auth/keycloak.env"), "KC_DB=postgres\n");

  const mockBin = join(root, "mockbin");
  mkdirSync(mockBin);
  writeFileSync(join(mockBin, "docker"), MOCK_DOCKER, { mode: 0o700 });
  // 固定时间戳，让"不覆盖已有备份"可以被确定性地断言。
  writeFileSync(join(mockBin, "date"), `#!/bin/sh\nprintf '%s\\n' ${FIXED_STAMP}\n`, { mode: 0o700 });

  return { root, vps, mockBin, log: join(root, "docker.log") };
}

function runScript(fixture, script, args, env = {}) {
  const result = spawnSync("sh", [script, ...args], {
    cwd: fixture.vps,
    encoding: "utf8",
    env: {
      PATH: `${fixture.mockBin}:${process.env.PATH}`,
      MOCK_DOCKER_LOG: fixture.log,
      MOCK_VOLUME_EXISTS: "1",
      ...env,
    },
  });
  const log = existsSync(fixture.log) ? readFileSync(fixture.log, "utf8") : "";
  return { ...result, log, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * mock 日志把整个 `sh -c` 载荷按 `$*` 打在一行，但载荷自带换行与 `\` 续行；
 * 展平后才能对"跨行的同一条命令"做匹配。
 */
function flatLog(log) {
  return log.replace(/\\\r?\n/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * 只保留真正会执行的命令行：丢掉整行注释。容器载荷里的注释（例如解释"不加
 * --no-privileges 的原因"）不是命令，不能拿来做"是否丢弃 ACL"的断言。
 */
function commandLog(log) {
  return log
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

/** 造一个合法、完整的最小备份集（内容不含真实数据）。 */
function makeBackupSet(root, {
  tamper = null,
  extraManifestLine = null,
  manifestName = null,
  omitSuccess = false,
  omitFile = null,
  rawManifest = null,
} = {}) {
  const dir = join(root, "backup-set");
  mkdirSync(dir, { recursive: true });
  const files = {
    "myrix.dump": "business-dump",
    "keycloak.dump": "keycloak-dump",
    "cell-home.tgz": "cell-tgz",
    "config.tgz": "config-tgz",
  };
  for (const [name, body] of Object.entries(files)) {
    if (name === omitFile) continue;
    writeFileSync(join(dir, name), body);
  }
  const sha = (name) => createHash("sha256").update(files[name]).digest("hex");
  const names = Object.keys(files).filter((n) => n !== omitFile);
  let lines = names.map((n) => `${sha(n)}  ${manifestName && n === "myrix.dump" ? manifestName : n}`);
  if (extraManifestLine) lines = [...lines, extraManifestLine];
  if (tamper) writeFileSync(join(dir, tamper), "TAMPERED");
  writeFileSync(join(dir, "sha256sums"), rawManifest ?? lines.join("\n") + "\n");
  if (!omitSuccess) writeFileSync(join(dir, "SUCCESS"), "");
  return dir;
}

// ---------------------------------------------------------------------------
// 0. 语法
// ---------------------------------------------------------------------------

test("backup.sh 与 restore.sh 都能通过 sh -n（POSIX sh）", () => {
  for (const file of [BACKUP_SRC, RESTORE_SRC]) {
    const r = spawnSync("sh", ["-n", file], { encoding: "utf8" });
    assert.equal(r.status, 0, `${file} 语法错误：${r.stderr}`);
  }
});

// ---------------------------------------------------------------------------
// 1. backup：缺卷 / 项目在跑 / dump 失败 → 拒绝且不称成功
// ---------------------------------------------------------------------------

test("backup：卷不存在时明确拒绝，不创建卷，也不写任何备份集", () => {
  const f = makeFixture();
  const out = join(f.root, "out");
  const r = runScript(f, "backup.sh", [out], { MOCK_VOLUME_EXISTS: "0" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /卷 .*不存在/);
  assert.doesNotMatch(r.stdout, /已完成/);
  assert.equal(existsSync(join(out, FIXED_STAMP)), false);
  assert.doesNotMatch(r.log, /volume create/); // 脚本绝不创建卷
  assert.doesNotMatch(r.log, /volume rm/);
});

test("backup：项目 myrix-vps 仍有非 postgres 容器在跑时拒绝，且不做任何 dump", () => {
  const f = makeFixture();
  const out = join(f.root, "out");
  const r = runScript(f, "backup.sh", [out], { MOCK_PS_OUTPUT: "bff\ngateway\nkeycloak" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /拒绝热备/);
  assert.match(r.stderr, /bff/);
  assert.doesNotMatch(r.stdout, /已完成/);
  assert.equal(existsSync(join(out, FIXED_STAMP)), false);
  assert.doesNotMatch(r.log, /pg_dump/);
});

test("backup：docker ps 用的是精确 project=myrix-vps 与 running 过滤", () => {
  const f = makeFixture();
  const r = runScript(f, "backup.sh", [join(f.root, "out")], { MOCK_PS_OUTPUT: "" });
  assert.match(r.log, /ps .*label=com\.docker\.compose\.project=myrix-vps/);
  assert.match(r.log, /status=running/);
});

test("backup：数据库 dump 失败 → 非零退出、无 SUCCESS、不打印完成", () => {
  const f = makeFixture();
  const out = join(f.root, "out");
  const r = runScript(f, "backup.sh", [out], { MOCK_DUMP_EXIT: "3" });
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /已完成/);
  assert.equal(existsSync(join(out, FIXED_STAMP, "SUCCESS")), false);
});

test("backup：Cell 卷 tar 失败 → 非零退出且不写 SUCCESS", () => {
  const f = makeFixture();
  const out = join(f.root, "out");
  const r = runScript(f, "backup.sh", [out], { MOCK_TAR_EXIT: "2" });
  assert.notEqual(r.status, 0);
  assert.equal(existsSync(join(out, FIXED_STAMP, "SUCCESS")), false);
});

test("backup：dump 用显式超级用户 myrix_admin，绝不用 NOBYPASSRLS 的 migrator", () => {
  const f = makeFixture();
  const out = join(f.root, "out");
  const r = runScript(f, "backup.sh", [out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.log, /pg_dump/);
  assert.match(r.log, /--username=myrix_admin/);
  assert.doesNotMatch(r.log, /myrix_migrator/);
  // ACL 必须留在可信的同部署归档里：dump 不得用 --no-privileges 丢弃授权
  // （migrate/auth/grants 无法重建全部 ACL）。--no-owner 保留，用于与恢复端一致。
  const backupCmds = commandLog(r.log);
  assert.match(backupCmds, /--no-owner/);
  assert.doesNotMatch(backupCmds, /--no-privileges/);
  // 也绝不用 --enable-row-security 把受策略影响的行静默过滤掉。
  assert.doesNotMatch(backupCmds, /--enable-row-security/);
  // 口令只经容器内文件/环境，绝不出现在 argv 里的连接串。
  assert.doesNotMatch(r.log, /postgres:\/\//);
  assert.doesNotMatch(r.log, /not-a-real-password/);
});

test("backup：成功时写入成套产物 + sha256sums + SUCCESS（0700/0600）", () => {
  const f = makeFixture();
  const out = join(f.root, "out");
  const r = runScript(f, "backup.sh", [out]);
  assert.equal(r.status, 0, r.stderr);
  const set = join(out, FIXED_STAMP);
  assert.equal(statSync(out).mode & 0o777, 0o700);
  assert.equal(statSync(set).mode & 0o777, 0o700);
  for (const name of ["myrix.dump", "keycloak.dump", "cell-home.tgz", "config.tgz", "sha256sums", "SUCCESS"]) {
    const p = join(set, name);
    assert.ok(existsSync(p), `缺少 ${name}`);
    assert.equal(statSync(p).mode & 0o777, 0o600, `${name} 权限不是 0600`);
  }
  // 清单自校验：恢复脚本用的正是这一份。
  const check = spawnSync("sh", ["-c", "sha256sum -c sha256sums"], { cwd: set, encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  // 配置归档必须真的包含受控秘密目录。
  const list = spawnSync("tar", ["-tzf", join(set, "config.tgz")], { encoding: "utf8" });
  assert.equal(list.status, 0);
  assert.match(list.stdout, /\.env/);
  assert.match(list.stdout, /secrets\//);
  assert.match(r.stdout, /已完成/);
});

test("backup：同秒重跑不覆盖已有备份，而是新建独立备份集", () => {
  const f = makeFixture();
  const out = join(f.root, "out");
  assert.equal(runScript(f, "backup.sh", [out]).status, 0);
  const second = runScript(f, "backup.sh", [out]);
  assert.equal(second.status, 0, second.stderr);
  assert.ok(existsSync(join(out, FIXED_STAMP)));
  assert.ok(existsSync(join(out, `${FIXED_STAMP}-1`)));
  assert.ok(existsSync(join(out, FIXED_STAMP, "SUCCESS")));
});

test("backup：既有 OUT 目录不是 0700 → 拒绝且不 chmod 该目录", () => {
  const f = makeFixture();
  const out = join(f.root, "shared");
  mkdirSync(out, { mode: 0o755 });
  const before = statSync(out).mode & 0o777;
  const r = runScript(f, "backup.sh", [out]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /0700/);
  assert.equal(statSync(out).mode & 0o777, before, "脚本不得改动既有目录权限");
  assert.doesNotMatch(r.log, /pg_dump/);
});

test("backup：既有 OUT 是符号链接 → 拒绝", () => {
  const f = makeFixture();
  const real = join(f.root, "real");
  mkdirSync(real, { mode: 0o700 });
  const link = join(f.root, "outlink");
  // 造一个指向 0700 真实目录的 symlink；脚本仍必须拒绝写进链接。
  const make = spawnSync("ln", ["-s", real, link], { encoding: "utf8" });
  assert.equal(make.status, 0, make.stderr);
  const r = runScript(f, "backup.sh", [link]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /符号链接|symlink/);
  assert.doesNotMatch(r.log, /pg_dump/);
});

test("backup：OUT 以 / 结尾 → 拒绝（避免 symlink 检查被穿透）", () => {
  const f = makeFixture();
  const r = runScript(f, "backup.sh", [`${join(f.root, "out")}/`]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /不要以 \//);
  assert.doesNotMatch(r.log, /pg_dump/);
});

test("backup：容器侧必须执行 umask 077 + chmod 600 + chown 到 /out 属主", () => {
  const f = makeFixture();
  const out = join(f.root, "out");
  const r = runScript(f, "backup.sh", [out]);
  assert.equal(r.status, 0, r.stderr);
  // mock 的 require_out_contract 已在 docker run 时强制这些契约；这里再从日志
  // 正向确认两处容器调用都带上了收尾命令。
  const flat = flatLog(r.log);
  const dumpStart = flat.indexOf("run --rm --network myrix-vps");
  const tarStart = flat.indexOf("run --rm -v myrix-vps_myrix-cell-1-home:/data:ro");
  assert.ok(dumpStart >= 0, "应有 pg_dump 容器调用");
  assert.ok(tarStart > dumpStart, "应有 Cell 卷 tar 容器调用");
  const dumpSeg = flat.slice(dumpStart, tarStart);
  const tarSeg = flat.slice(tarStart);
  for (const [label, seg] of [["dump", dumpSeg], ["tar", tarSeg]]) {
    assert.match(seg, /umask 077/, `${label} 容器脚本缺 umask 077`);
    assert.match(seg, /stat -c/, `${label} 容器脚本缺 /out 属主探测`);
    assert.match(seg, /chmod 600/, `${label} 容器脚本缺 chmod 600`);
    assert.match(seg, /chown "\$OUT_OWNER"/, `${label} 容器脚本缺 chown 到 /out 属主`);
  }
  assert.match(dumpSeg, /pg_dump/);
  assert.match(tarSeg, /tar -czf/);
  // Cell 卷必须容器内 root 只读读取（不能 --user 1000 读 UID 65532/0700）。
  assert.doesNotMatch(tarSeg, /--user/);
  assert.match(tarSeg, /:ro/);
});

// ---------------------------------------------------------------------------
// 2. restore：完整性 / 缺卷 / 卷非空 / 空库检查失败 → 全部拒绝
// ---------------------------------------------------------------------------

test("restore：缺少 SUCCESS 标记 → 在动库之前拒绝", () => {
  const f = makeFixture();
  const set = makeBackupSet(f.root, { omitSuccess: true });
  const r = runScript(f, "restore.sh", [set]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /SUCCESS/);
  assert.doesNotMatch(r.stdout, /已恢复：|两个库已恢复/);
  assert.doesNotMatch(r.log, /pg_restore/);
});

test("restore：SHA-256 与清单不符 → 拒绝且不跑 pg_restore", () => {
  const f = makeFixture();
  const set = makeBackupSet(f.root, { tamper: "myrix.dump" });
  const r = runScript(f, "restore.sh", [set]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /SHA-256|校验失败/);
  assert.doesNotMatch(r.stdout, /两个库已恢复/);
  assert.doesNotMatch(r.log, /pg_restore/);
});

test("restore：清单含目录外/额外条目 → 拒绝", () => {
  const f = makeFixture();
  const set = makeBackupSet(f.root, { extraManifestLine: `${"a".repeat(64)}  ../outside` });
  const r = runScript(f, "restore.sh", [set]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /拒绝|校验失败|不一致|条目/);
  assert.doesNotMatch(r.log, /pg_restore/);
});

test("restore：4 条正常 + 第 5 条坏行 → 拒绝（旧逻辑会过滤坏行后放行）", () => {
  const f = makeFixture();
  const files = {
    "myrix.dump": "business-dump",
    "keycloak.dump": "keycloak-dump",
    "cell-home.tgz": "cell-tgz",
    "config.tgz": "config-tgz",
  };
  const sha = (n) => createHash("sha256").update(files[n]).digest("hex");
  const good = Object.keys(files).map((n) => `${sha(n)}  ${n}`);
  // 第 5 行是"坏行"：旧 awk 会把它过滤掉，于是 LISTED 仍是 4 条并通过。
  const set = makeBackupSet(f.root, { rawManifest: [...good, "this-is-not-a-valid-line"].join("\n") + "\n" });
  const r = runScript(f, "restore.sh", [set]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /4 行|超过 4 行|非法/);
  assert.doesNotMatch(r.log, /pg_restore/);
});

test("restore：清单含空行/重复项/大写哈希/单空格 → 逐一拒绝", () => {
  const f = makeFixture();
  const files = {
    "myrix.dump": "business-dump",
    "keycloak.dump": "keycloak-dump",
    "cell-home.tgz": "cell-tgz",
    "config.tgz": "config-tgz",
  };
  const sha = (n) => createHash("sha256").update(files[n]).digest("hex");
  const good = Object.keys(files).map((n) => `${sha(n)}  ${n}`);

  const cases = [
    ["空行", [...good.slice(0, 2), "", ...good.slice(2)].join("\n") + "\n"],
    ["重复项", [...good.slice(0, 3), good[0]].join("\n") + "\n"],
    ["大写哈希", [`${sha("myrix.dump").toUpperCase()}  myrix.dump`, ...good.slice(1)].join("\n") + "\n"],
    ["单空格", [`${sha("myrix.dump")} myrix.dump`, ...good.slice(1)].join("\n") + "\n"],
    ["目录外路径", [`${sha("myrix.dump")}  /etc/passwd`, ...good.slice(1)].join("\n") + "\n"],
  ];
  for (const [label, manifest] of cases) {
    const set = makeBackupSet(f.root, { rawManifest: manifest });
    const r = runScript(f, "restore.sh", [set]);
    assert.notEqual(r.status, 0, `${label} 应被拒绝`);
    assert.doesNotMatch(r.log, /pg_restore/, `${label} 时不应跑 pg_restore`);
  }
});

test("restore：清单只有 4 条合法条目、目录里没有多余文件时才通过", () => {
  const f = makeFixture();
  const set = makeBackupSet(f.root);
  const r = runScript(f, "restore.sh", [set]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /完整且 SHA-256 全部通过/);
});

test("restore：拒绝恢复时绝不把越界文件交给 sha256sum（先解析后校验）", () => {
  const f = makeFixture();
  // 清单里放一个目录外的绝对路径并使用真实存在的 /etc/hostname 哈希；
  // 若脚本先跑 sha256sum 再解析，这个越界路径就可能被读取/通过。
  const outside = "/etc/hostname";
  let body = null;
  try {
    body = readFileSync(outside);
  } catch {
    body = null;
  }
  const outsideHash = body
    ? createHash("sha256").update(body).digest("hex")
    : "a".repeat(64);
  const files = {
    "myrix.dump": "business-dump",
    "keycloak.dump": "keycloak-dump",
    "cell-home.tgz": "cell-tgz",
  };
  const sha = (n) => createHash("sha256").update(files[n]).digest("hex");
  const manifest =
    [`${sha("myrix.dump")}  myrix.dump`,
     `${sha("keycloak.dump")}  keycloak.dump`,
     `${sha("cell-home.tgz")}  cell-home.tgz`,
     `${outsideHash}  ${outside}`].join("\n") + "\n";
  const set = makeBackupSet(f.root, { rawManifest: manifest });
  const r = runScript(f, "restore.sh", [set]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /不是四份固定产物|拒绝/);
  assert.doesNotMatch(r.log, /pg_restore/);
});

test("restore：清单少一项 → 拒绝（必须是完整同一套）", () => {
  const f = makeFixture();
  const set = makeBackupSet(f.root, { omitFile: "keycloak.dump" });
  const r = runScript(f, "restore.sh", [set]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /keycloak\.dump/);
  assert.doesNotMatch(r.log, /pg_restore/);
});

test("restore：项目 myrix-vps 仍有非 postgres 容器在跑时拒绝，且不动库/卷", () => {
  const f = makeFixture();
  const set = makeBackupSet(f.root);
  const r = runScript(f, "restore.sh", [set], { MOCK_PS_OUTPUT: "bff\ncell-1\nkeycloak" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /拒绝恢复/);
  assert.doesNotMatch(r.stdout, /已恢复/);
  assert.doesNotMatch(r.log, /pg_restore/);
});

test("restore：Cell 卷不存在 → 拒绝，不创建卷", () => {
  const f = makeFixture();
  const set = makeBackupSet(f.root);
  const r = runScript(f, "restore.sh", [set], { MOCK_VOLUME_EXISTS: "0" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /卷 .*不存在/);
  assert.doesNotMatch(r.log, /volume create/);
  assert.doesNotMatch(r.log, /pg_restore/);
});

test("restore：Cell 卷非空 → 拒绝覆盖已有历史，且不跑 pg_restore", () => {
  const f = makeFixture();
  const set = makeBackupSet(f.root);
  const r = runScript(f, "restore.sh", [set], { MOCK_VOLUME_LS: "dsh-state\ndb.sqlite" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /非空/);
  assert.doesNotMatch(r.stdout, /已恢复/);
  assert.doesNotMatch(r.log, /pg_restore/);
});

test("restore：卷内容读取失败 → 拒绝，绝不假设为空", () => {
  const f = makeFixture();
  const set = makeBackupSet(f.root);
  const r = runScript(f, "restore.sh", [set], { MOCK_VOLUME_LS_EXIT: "1" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /无法读取卷/);
  assert.doesNotMatch(r.log, /pg_restore/);
});

test("restore：空库检查/还原失败（容器非零退出）→ 非零且不打印已恢复", () => {
  const f = makeFixture();
  const set = makeBackupSet(f.root);
  const r = runScript(f, "restore.sh", [set], { MOCK_RESTORE_EXIT: "1" });
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /两个库已恢复/);
  assert.doesNotMatch(r.stdout, /数据库与 Cell 卷已恢复/);
});

// ---------------------------------------------------------------------------
// 3. restore：owner role、秘密卫生、不越界
// ---------------------------------------------------------------------------

test("restore：业务库 owner=myrix_migrator、Keycloak 库 owner=keycloak，且不丢弃 ACL", () => {
  const f = makeFixture();
  const set = makeBackupSet(f.root);
  const r = runScript(f, "restore.sh", [set]);
  assert.equal(r.status, 0, r.stderr);
  const flat = flatLog(r.log);
  assert.match(flat, /pg_restore --exit-on-error --no-owner --role="\$BUSINESS_OWNER"/);
  assert.match(flat, /pg_restore --exit-on-error --no-owner --role="\$KEYCLOAK_OWNER"/);
  assert.match(flat, /--dbname "\$BUSINESS_DB" \/backup\/myrix\.dump/);
  assert.match(flat, /--dbname "\$KEYCLOAK_DB" \/backup\/keycloak\.dump/);
  // 常量在宿主侧固定，并通过环境传给容器脚本。
  assert.match(r.log, /-e BUSINESS_OWNER=myrix_migrator/);
  assert.match(r.log, /-e KEYCLOAK_OWNER=keycloak/);
  assert.match(r.log, /-e KEYCLOAK_DB=keycloak/);
  // custom 归档带 owner/ACL：恢复必须用 --no-owner + --role 指定 owner，但**不能**
  // 用 --no-privileges 丢弃 ACL；ACL 没有其它可靠的重建路径。
  const pgRestoreSegs = flat.match(/pg_restore[^|]*?--dbname "\$[A-Z_]+" \/backup\/[a-z.]+\.dump/g) ?? [];
  assert.equal(pgRestoreSegs.length, 2, "应恰好两处 pg_restore");
  for (const seg of pgRestoreSegs) {
    assert.match(seg, /--no-owner/);
    assert.match(seg, /--role=/);
    assert.doesNotMatch(seg, /--no-privileges/, "pg_restore 不得丢弃归档 ACL");
  }
  // 全日志（含宿主 argv 与容器载荷）都不得出现 ACL 丢弃开关——容器载荷里的
  // 注释说明"不加 --no-privileges"不算违规，所以只看可执行命令行。
  assert.doesNotMatch(commandLog(r.log), /--no-privileges/);
  // 口令只从容器内文件读入环境变量，argv/日志里没有连接串或明文口令。
  assert.doesNotMatch(r.log, /postgres:\/\//);
  assert.doesNotMatch(r.log, /not-a-real-password/);
});

test("restore：只认传入的同一个备份集，不会自动挑最新文件", () => {
  const f = makeFixture();
  const set = makeBackupSet(f.root);
  // 在同一父目录里放一个"更新的"伪备份集，restore 必须无视它。
  const decoy = join(f.root, "backup-set-2");
  mkdirSync(decoy);
  writeFileSync(join(decoy, "myrix.dump"), "decoy");
  const r = runScript(f, "restore.sh", [set]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.log, /decoy|backup-set-2/);
  assert.doesNotMatch(r.stdout, /decoy/);
});

test("restore：不自动解包配置归档，不 down -v、不动其他卷", () => {
  const f = makeFixture();
  const set = makeBackupSet(f.root);
  const r = runScript(f, "restore.sh", [set]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.log, /config\.tgz/); // 配置归档留给操作者手工恢复
  assert.doesNotMatch(r.log, /down -v/);
  assert.doesNotMatch(r.log, /volume rm/);
  assert.doesNotMatch(r.log, /volume create/);
  // 只碰这一个明确卷名。
  const volumes = [...r.log.matchAll(/-v ([A-Za-z0-9_.-]+):/g)].map((m) => m[1]);
  for (const v of volumes) assert.equal(v, "myrix-vps_myrix-cell-1-home");
  assert.match(r.stdout, /配置归档未自动解包/);
});

// ---------------------------------------------------------------------------
// 4. 源码层的 fail-closed 契约（防止未来回归引入吞错）
// ---------------------------------------------------------------------------

/**
 * 只保留"会执行的行"：丢掉空行、整行注释与 `echo` 提示行。
 * 注释和收尾提示里出现 `down -v` 这类字样是**说明**，不是可执行命令；
 * 回归要拦的是真的执行了危险动作。
 */
function executableLines(src) {
  return src
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (t === "" || t.startsWith("#")) return false;
      if (/^echo\b/.test(t)) return false;
      return true;
    })
    .join("\n");
}

test("两个脚本都不含吞错模式：无 `|| true`、无 `2>/dev/null || echo 0`", () => {
  for (const file of [BACKUP_SRC, RESTORE_SRC]) {
    const src = executableLines(readFileSync(file, "utf8"));
    assert.doesNotMatch(src, /\|\|\s*true/, `${file} 出现吞错`);
    assert.doesNotMatch(src, /2>\/dev\/null\s*\|\|\s*echo\s+0/, `${file} 把空库检查伪装成 0`);
  }
});

test("两个脚本都绝不关闭/绕过 RLS，也不创建删除卷、不做 down -v", () => {
  for (const file of [BACKUP_SRC, RESTORE_SRC]) {
    const src = executableLines(readFileSync(file, "utf8"));
    assert.doesNotMatch(src, /disable\s+row\s+level\s+security/i, `${file} 不得关闭 RLS`);
    assert.doesNotMatch(src, /session_replication_role/i, `${file} 不得绕过 RLS`);
    assert.doesNotMatch(src, /docker\s+volume\s+(create|rm)\b/, `${file} 不得创建/删除卷`);
    assert.doesNotMatch(src, /down\s+-v/, `${file} 不得 down -v`);
    assert.doesNotMatch(src, /docker\s+compose\b/, `${file} 不得自行编排服务`);
  }
});

test("backup.sh 用超级用户 dump；restore.sh 两处 pg_restore 保留 --no-owner/--role，且双方都不丢弃 ACL", () => {
  const backup = readFileSync(BACKUP_SRC, "utf8");
  assert.match(backup, /--username=myrix_admin/);
  // 可执行行里绝不出现 NOBYPASSRLS 的迁移角色（注释里说明"不要用"是允许的）。
  assert.doesNotMatch(executableLines(backup), /myrix_migrator/);
  // ACL 必须随可信的同部署归档保留：两条 pg_dump 都不得带 --no-privileges。
  const dumpLines = backup.replace(/\\\r?\n\s*/g, " ").split("\n").filter((l) => l.includes("pg_dump "));
  assert.ok(dumpLines.length >= 2, "backup.sh 应有两处 pg_dump");
  for (const line of dumpLines) {
    assert.doesNotMatch(line, /--no-privileges/, "pg_dump 不得丢弃 ACL");
  }
  // custom 归档里的 owner 不会因 dump 的 --no-owner 消失，恢复端必须显式覆盖。
  const restoreSrc = readFileSync(RESTORE_SRC, "utf8");
  assert.doesNotMatch(executableLines(restoreSrc), /--no-owner.*dump|pg_dump/);
  // 展平 `\` 续行，才能把"跨行的同一条 pg_restore 命令"当作一个匹配单元。
  const flatRestore = restoreSrc.replace(/\\\r?\n\s*/g, " ");
  const restoreLines = flatRestore.split("\n").filter((l) => l.includes("pg_restore") && l.includes("--role="));
  assert.ok(restoreLines.length >= 2, "restore.sh 应有两处 pg_restore");
  for (const line of restoreLines) {
    assert.match(line, /--no-owner/, "pg_restore 必须显式 --no-owner");
    assert.match(line, /--role=/, "pg_restore 必须保留 --role 指定 owner");
    assert.doesNotMatch(line, /--no-privileges/, "pg_restore 不得丢弃归档 ACL");
  }
});

test("两个脚本都要求 sha256sum，且源码不内联任何连接串", () => {
  for (const file of [BACKUP_SRC, RESTORE_SRC]) {
    const src = readFileSync(file, "utf8");
    assert.match(src, /command -v sha256sum/);
    // 连接串/口令绝不作为命令参数：源码里不出现 postgres:// 形式的 URL。
    assert.doesNotMatch(src, /postgres:\/\//);
  }
});

test("backup.sh 明确要求停服务、restore.sh 明确拒绝混合快照", () => {
  const backup = readFileSync(BACKUP_SRC, "utf8");
  const restore = readFileSync(RESTORE_SRC, "utf8");
  assert.match(backup, /拒绝热备/);
  assert.match(backup, /label=com\.docker\.compose\.project=myrix-vps/);
  assert.match(restore, /sha256/); // 完整性校验存在
  assert.match(restore, /SUCCESS/);
  assert.match(restore, /非空/);
});
