#!/bin/sh
# Copyright 2026 The Myrix Authors
# SPDX-License-Identifier: Apache-2.0
#
# 单机 VPS 备份：两个数据库的自定义格式快照 + Cell 持久卷 + 私有配置归档。
#
# 一次备份 = 一个新的唯一时间戳子目录，里面固定四份产物 + SHA-256 清单 + 成功标记：
#   backups/<UTC 时间戳>/myrix.dump        业务库（含 myrix_auth schema + 网关账本）
#   backups/<UTC 时间戳>/keycloak.dump     Keycloak 独立库（realm/用户/client/会话）
#   backups/<UTC 时间戳>/cell-home.tgz     Cell 持久卷（/var/lib/myrix/dsh-home）
#   backups/<UTC 时间戳>/config.tgz        .env/secrets/sql/auth 私有配置
#   backups/<UTC 时间戳>/sha256sums        上面四份产物的 SHA-256 清单
#   backups/<UTC 时间戳>/SUCCESS            仅当以上全部成功后才写入
#
# 为什么必须同时备份四部分（缺任何一份都无法完整恢复）：
#   1. 业务库：业务表 + 网关账本 + `myrix_auth` schema；
#   2. **`keycloak` 独立库**：原来的 `pg_dump myrix` 不足以恢复登录；
#   3. Cell 持久卷 `myrix-cell-1-home`；
#   4. 私有配置（签名私钥、Cell 令牌、Keycloak realm 导入与 KC_* 环境）。
#
# 安全与失败语义：
#   * 任何一步失败都以非零退出，绝不打印"完成"；错误信息不回显任何秘密。
#   * 数据库 dump 用**一次显式超级用户连接**（仅本次备份进程内使用），
#     口令通过容器内环境变量（PGPASSWORD）传递，绝不出现在命令行参数里，
#     因此宿主机 `ps` 看不到口令；本脚本自身也不打印连接串。
#   * **绝不**用 myrix_migrator（NOBYPASSRLS）做 dump：业务表 FORCE ROW LEVEL
#     SECURITY 对它同样生效。pg_dump 默认 `row_security=off`，遇到会受策略影响
#     的表会**直接报错退出**（不是静默出一份残缺 dump），因此用迁移角色根本拿不到
#     完整备份；也**绝不**加 `--enable-row-security` —— 那才会把策略过滤后的行
#     **静默**导出成看似完整的 dump。正确做法是用超级用户（BYPASSRLS），并且
#     **不**为了备份关闭/削弱任何 RLS。
#   * **ACL 随 trusted 备份保留**：同一次部署产生的 custom 格式归档是可信备份，
#     对象授权（GRANT/REVOKE）必须随归档一起保存，因此 pg_dump **不**加
#     `--no-privileges`。后续 migrate/grants 只补充/收口权限，**不能**重建全部
#     授权；删掉归档 ACL 会让恢复永久丢权限（见 backup-restore.md）。
#   * 两个库各自独立 pg_dump、各自 consistency；Cell 卷另起一次 tar。
#   * 卷必须已存在（精确名 myrix-vps_myrix-cell-1-home）；本脚本不创建卷，
#     不做 `docker compose up`，任何 docker 调用失败都不吞错。
#   * 容器产物（*.dump / cell-home.tgz）由容器内先 `umask 077`、`chmod 600`，
#     再 `chown` 给挂载点 /out 的数字属主（`stat -c '%u:%g' /out`），因此宿主
#     UID 1000 才能读 hash 并 chmod；Cell 卷属 UID 65532/0700，tar 必须容器内
#     root 只读读取，本脚本绝不改动源卷 ownership。
#   * 既有备份输出目录只接受非 symlink、权限恰为 0700 的真实目录；本脚本对既有
#     目录绝不 chmod/chown。不防恶意 root，也不防同一 UID 的竞态（见文档边界）。
#
# 用法：sh deploy/vps/backup.sh [输出目录]（默认 deploy/vps/backups）
#
# 一致性前置条件（脚本只**检查**、不代操作）：操作者必须先停掉本项目
# （compose project = myrix-vps）除 postgres 之外的**全部**容器，包括 bff /
# gateway / cell-1 / keycloak 与 migrate/auth/grants 等一次性 job；postgres 继续运行。
# 本脚本不是在线热备，也不声称原子一致。
set -eu

cd "$(dirname "$0")"

die() { echo "backup: $*" >&2; exit 1; }

command -v sha256sum >/dev/null 2>&1 || die "缺少 sha256sum（本脚本只支持 Ubuntu VPS）"
command -v docker >/dev/null 2>&1 || die "缺少 docker"

OUT="${1:-backups}"
# 受控秘密文件必须是普通文件；由宿主 tar 归档，因此空口令也会被拒绝（见下）。
[ -f secrets/migrator.env ] || die "缺少 secrets/migrator.env（先用 init.mjs 生成配置）"
[ -f secrets/postgres-superuser-password ] || die "缺少 secrets/postgres-superuser-password"
[ -s secrets/postgres-superuser-password ] || die "secrets/postgres-superuser-password 为空，拒绝用空口令连接"

[ -f .env ] || die "缺少 .env（先用 init.mjs 生成配置）"
POSTGRES_IMAGE="$(grep '^MYRIX_IMAGE_POSTGRES=' .env | cut -d= -f2-)"
[ -n "$POSTGRES_IMAGE" ] || die ".env 缺少 MYRIX_IMAGE_POSTGRES"
# 不用 myrix_migrator：它是 NOBYPASSRLS，pg_dump 默认 row_security=off，遇到受
# FORCE RLS 影响的表会直接失败（而不是静默出残缺 dump）；加 --enable-row-security
# 才会静默缺行，本脚本绝不那样做。
case "$POSTGRES_IMAGE" in
  *[!A-Za-z0-9._:/@+-]*) die ".env 里的 MYRIX_IMAGE_POSTGRES 含非法字符" ;;
esac

umask 077
# 末尾斜杠会让 `[ -L ]` 之类的检查穿透 symlink，直接拒绝，避免绕过下面的目录检查。
case "$OUT" in
  */) die "备份输出目录不要以 / 结尾：请写成 ${OUT%/}" ;;
esac
if [ -e "$OUT" ]; then
  # 既有目录：**绝不 chmod/chown**（可能是他人或其它用途的目录）。只接受已经是
  # 非 symlink 的真实目录且权限恰为 0700；否则说明原因让操作者自己另选私有目录。
  [ -d "$OUT" ] || die "$OUT 已存在但不是目录"
  [ -L "$OUT" ] && die "$OUT 是符号链接；拒绝把备份写进链接目标，请改用真实私有目录"
  OUT_MODE="$(ls -ld "$OUT" | cut -c1-10)"
  [ "$OUT_MODE" = "drwx------" ] \
    || die "既有备份目录 $OUT 权限是 ${OUT_MODE#?}（不是 0700）；本脚本不改动他人目录。请自行 chmod 700，或换一个私有的 0700 目录"
else
  # 新建目录一次成型为 0700，不依赖 umask 之外的二次 chmod。
  mkdir -p -m 700 "$OUT" || die "无法创建备份输出目录 $OUT"
fi
OUT_ABS="$(cd -P "$OUT" && pwd)"

# --- 事前检查（必须在创建备份集目录之前）：卷存在、部署已停止 ------------------
VOLUME="myrix-vps_myrix-cell-1-home"
if ! docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  die "数据卷 $VOLUME 不存在；本脚本绝不创建或删除卷，请先按 README 完成部署"
fi

RUNNING_NONPG="$(docker ps \
  --filter "label=com.docker.compose.project=myrix-vps" \
  --filter "status=running" \
  --format '{{.Label "com.docker.compose.service"}}')"
# 只允许 postgres 在跑；其余（含一次性 job）在 running 状态就拒绝，避免热备出残片。
RUNNING_OTHER="$(printf '%s\n' "$RUNNING_NONPG" | awk 'NF && $0 != "postgres"')"
if [ -n "$RUNNING_OTHER" ]; then
  echo "backup: 项目 myrix-vps 仍有除 postgres 之外的容器在运行，拒绝热备：" >&2
  printf '%s\n' "$RUNNING_OTHER" | sed 's/^/backup:   - /' >&2
  echo "backup: 请先停 bff/gateway/cell-1/keycloak 与 migrate/auth/grants，再重跑；postgres 保持运行。" >&2
  exit 1
fi

# --- 唯一时间戳子目录：同一次备份的产物永远在一起，恢复也只认这一套 ---------
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SET_DIR="$OUT_ABS/$STAMP"
if [ -e "$SET_DIR" ]; then
  # 不覆盖已有备份；同秒重跑宁可失败也不合并两套产物。
  n=1
  while [ -e "${SET_DIR}-${n}" ]; do
    n=$((n + 1))
    [ "$n" -le 99 ] || die "同一秒内备份次数过多，请稍后重试"
  done
  SET_DIR="${SET_DIR}-${n}"
fi
mkdir -m 700 "$SET_DIR"

echo "backup: 备份集 $SET_DIR（先备份，任何一步失败都不会写 SUCCESS）"

# --- 1+2. 两个库：各自独立一次 pg_dump，各自 consistency ---------------------
# 命令行只出现受控路径与镜像名，不出现任何口令；超级用户口令只在容器内从只读
# 受控文件读入环境变量，宿主机 ps 只能看到挂载路径与 sh -c 脚本本身。
if ! docker run --rm --network myrix-vps \
  -e PGCONNECT_TIMEOUT=15 \
  -v "$(pwd)/secrets:/secrets:ro" \
  -v "$SET_DIR:/out" \
  -w /out \
  "$POSTGRES_IMAGE" /bin/sh -c '
    set -eu
    # 容器默认 root、umask 0022；先收紧 umask，再按 /out 的属主写文件。
    umask 077
    OUT_OWNER="$(stat -c "%u:%g" /out)"
    [ -n "$OUT_OWNER" ] || { echo "backup: 无法读取 /out 的属主" >&2; exit 1; }
    SUPER_PASSWORD="$(cat /secrets/postgres-superuser-password)"
    [ -n "$SUPER_PASSWORD" ] || { echo "backup: 超级用户口令为空" >&2; exit 1; }
    export PGPASSWORD="$SUPER_PASSWORD"
    # 显式超级用户：仅本次备份使用；业务库的 migrator 角色是 NOBYPASSRLS，
    # pg_dump 默认 row_security=off 会对受 FORCE RLS 影响的表直接报错，拿不到完整
    # 备份；也绝不用 --enable-row-security 去"绕过"（那会静默缺行）。
    # 这里不关闭/不改动任何 RLS 设置。
    # `--no-owner` 对 custom 归档**不起作用**（owner 仍会写进归档），它只是保持
    # plain-SQL 语义的一致性；真正决定恢复后 owner 的是 restore.sh 的
    # `pg_restore --no-owner --role=<owner>`，不是这里。
    # **不加 `--no-privileges`**：ACL 必须留在可信的同部署归档里，否则恢复端
    # 会丢失对象授权；migrate 跳过已记录迁移，grants 仅覆盖部分 schema 与成员关系，
    # 不能充当所有 ACL 的重建途径。
    pg_dump --format=custom --no-owner \
      --host=postgres --port=5432 --username=myrix_admin --dbname=myrix \
      --file=/out/myrix.dump
    # Keycloak 独立库：同一个超级用户连接，但库/角色与业务库完全分离。
    # 同样保留 ACL；Keycloak 的表权限也随归档恢复。
    pg_dump --format=custom --no-owner \
      --host=postgres --port=5432 --username=myrix_admin --dbname=keycloak \
      --file=/out/keycloak.dump
    unset PGPASSWORD
    # 容器内先 chmod 600 再 chown 给 /out 的数字属主：宿主（Ubuntu UID 1000）
    # 不是这些 root-owned 文件的属主，绝不能由宿主 chmod，否则必然 EPERM。
    chmod 600 /out/myrix.dump /out/keycloak.dump
    chown "$OUT_OWNER" /out/myrix.dump /out/keycloak.dump
  '; then
  die "数据库 dump 失败（业务库/Keycloak 库）；未写 SUCCESS，$SET_DIR 不完整"
fi
[ -s "$SET_DIR/myrix.dump" ] || die "业务库 dump 为空；拒绝标记成功"
[ -s "$SET_DIR/keycloak.dump" ] || die "Keycloak 库 dump 为空；拒绝标记成功"

# --- 3. Cell 持久卷：只读挂载精确卷名，tar 失败即整体失败 ---------------------
# 卷在调用前已用 `docker volume inspect` 确认存在；`-v` 只挂既有卷，不创建卷。
# **不能**给这次 tar 加 `--user 1000`：Cell 数据属 UID 65532 且目录 0700，
# 非 root 读不了；这里就是要用容器内 root 只读地读卷，且不改变源卷 ownership。
if ! docker run --rm \
  -v "$VOLUME:/data:ro" \
  -v "$SET_DIR:/out" \
  -w /out \
  "$POSTGRES_IMAGE" /bin/sh -c '
    set -eu
    umask 077
    OUT_OWNER="$(stat -c "%u:%g" /out)"
    [ -n "$OUT_OWNER" ] || { echo "backup: 无法读取 /out 的属主" >&2; exit 1; }
    [ -d /data ] || { echo "backup: /data 不存在" >&2; exit 1; }
    tar -czf /out/cell-home.tgz -C /data .
    chmod 600 /out/cell-home.tgz
    chown "$OUT_OWNER" /out/cell-home.tgz
  '; then
  die "Cell 卷 $VOLUME 归档失败；未写 SUCCESS，$SET_DIR 不完整"
fi
[ -s "$SET_DIR/cell-home.tgz" ] || die "Cell 卷归档为空；拒绝标记成功"

# --- 4. 私有配置：逐项显式归档，缺任何一项都直接失败，不吞错 ----------------
# 宿主 tar 直接读文件，不经过 shell 展开，路径里的元字符不会变成注入。
if ! tar -czf "$SET_DIR/config.tgz" \
  .env secrets sql auth; then
  die "私有配置归档失败（.env/secrets/sql/auth）；未写 SUCCESS，$SET_DIR 不完整"
fi
[ -s "$SET_DIR/config.tgz" ] || die "私有配置归档为空；拒绝标记成功"

# --- 5. SHA-256 清单：逐项校验，任何缺失/不可读都在写 SUCCESS 之前失败 --------
(
  cd "$SET_DIR"
  sha256sum myrix.dump keycloak.dump cell-home.tgz config.tgz > sha256sums
)
# 容器已把三份容器产物 chmod 600 并 chown 给 /out 的属主（= 宿主本用户），
# 所以宿主这里的 chmod/读 hash 才合法；config.tgz 由宿主自己创建。
# 若这三份仍是容器 root 所有，宿主 chmod 会 EPERM——那说明容器侧收尾没执行。
chmod 600 "$SET_DIR"/*.dump "$SET_DIR"/*.tgz "$SET_DIR"/sha256sums
if ! (cd "$SET_DIR" && sha256sum -c sha256sums >/dev/null); then
  die "备份集自校验失败；未写 SUCCESS，$SET_DIR 不完整"
fi

# --- 6. 最后成功标记：只有到这里才写 ------------------------------------------
: > "$SET_DIR/SUCCESS"
chmod 600 "$SET_DIR/SUCCESS"

echo "backup: 备份集已完成并自校验：$SET_DIR"
echo "backup: 包含 myrix.dump / keycloak.dump / cell-home.tgz / config.tgz + sha256sums + SUCCESS"
echo "backup: 请把整个备份集复制到 VPS 之外；缺任何一份都无法完整恢复。"
echo "backup: 恢复步骤见 docs/deployment/backup-restore.md；绝不要删除数据卷来“重置”。"
