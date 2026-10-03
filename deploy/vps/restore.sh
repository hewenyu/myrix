#!/bin/sh
# Copyright 2026 The Myrix Authors
# SPDX-License-Identifier: Apache-2.0
#
# 单机 VPS 恢复：把一个**完整且已校验**的备份集恢复到本机空库/空卷。
#
# 用法：sh deploy/vps/restore.sh <备份集目录>
#   <备份集目录> 必须是 backup.sh 生成的**单个**时间戳子目录，且包含同一次备份的：
#     myrix.dump  keycloak.dump  cell-home.tgz  config.tgz  sha256sums  SUCCESS
#   恢复只认这一套：先校验 SUCCESS 与 sha256sums 全部通过，才动数据库和卷；
#   不会"取最新文件"、不会挑选、不会混合不同时间的快照。
#
# 安全边界（fail-closed）：
#   * 缺少 SUCCESS、缺少任一产物、清单不是"恰好 4 行合法条目"、任一哈希不符 → 拒绝。
#     清单在跑 sha256sum 之前逐行严格解析，拒绝额外/空/非法行与目录外路径，
#     因此 sha256sum 绝不会去打开清单里越界的文件。
#   * 任一步骤出错立即非零退出，绝不打印"已恢复"。
#   * 数据库恢复用**显式超级用户连接**：口令仅在容器内从受控文件读入环境变量，
#     绝不出现在命令行参数里（宿主机 ps 看不到）。`pg_restore` 用
#     `--no-owner --role` 指定 owner：custom 归档里的 owner 不会被直接套用
#     （仅 `--role` 并不等于忽略 archive owner）。业务库 owner=myrix_migrator，
#     Keycloak 库 owner=keycloak。
#     **故意不加 `--no-privileges`**：ACL/GRANT 必须从可信的同部署备份恢复回来。
#     renderGrantsSql（init.mjs）只重放认证 schema 与组成员关系，migrate 的记录
#     会因 migrations 已存在而跳过，因此 migrate/auth/grants **不能**重建所有
#     权限；丢掉归档 ACL 就会永久丢授权。
#   * **前提：全部原始角色必须已经 provision 出来。** 归档里的 GRANT 引用
#     myrix_app / myrix_gateway_app / myrix_bff / myrix_auth / myrix_gateway /
#     myrix_migrator 等角色；缺任一角色时 pg_restore 会失败（fail-closed），
#     绝不会悄悄跳过授权。
#   * **只在空库、空卷上恢复**：目标库已有任何非系统表即拒绝；Cell 卷非空即拒绝，
#     绝不覆盖已有历史。脚本**不创建、不删除、不清空**任何库或卷，也不做 down -v。
#
# 配置归档**不在此脚本内自动解包**：它含签名私钥（等同会话伪造能力），必须按
# docs/deployment/backup-restore.md 手工、安全地恢复同套私有配置。
#
# 前置条件：postgres 必须已运行；业务库与 Keycloak 库必须已经由 provision
# 建成**空库/角色**（本脚本不建库、不建角色）。恢复期间不要启动应用，顺序见文档。
set -eu

cd "$(dirname "$0")"

die() { echo "restore: $*" >&2; exit 1; }

command -v sha256sum >/dev/null 2>&1 || die "缺少 sha256sum（本脚本只支持 Ubuntu VPS）"
command -v docker >/dev/null 2>&1 || die "缺少 docker"

SET_DIR="${1:?用法: sh deploy/vps/restore.sh <备份集目录>}"
[ -d "$SET_DIR" ] || die "找不到备份集目录 $SET_DIR"
SET_ABS="$(cd "$SET_DIR" && pwd)"
[ "$SET_ABS" != "/" ] || die "拒绝把 / 当作备份集目录"
# 备份集必须是一个"套"目录，而不是存放多套备份的父目录。
[ -f "$SET_ABS/sha256sums" ] || die "不是备份集目录：$SET_ABS 缺少 sha256sums（不要传 backups 根目录）"

[ -f secrets/migrator.env ] || die "缺少 secrets/migrator.env（先按 backup-restore.md 恢复同套私有配置）"
[ -f secrets/postgres-superuser-password ] || die "缺少 secrets/postgres-superuser-password"
[ -s secrets/postgres-superuser-password ] || die "secrets/postgres-superuser-password 为空，拒绝用空口令连接"
[ -f .env ] || die "缺少 .env（先按 backup-restore.md 恢复同套私有配置）"
POSTGRES_IMAGE="$(grep '^MYRIX_IMAGE_POSTGRES=' .env | cut -d= -f2-)"
[ -n "$POSTGRES_IMAGE" ] || die ".env 缺少 MYRIX_IMAGE_POSTGRES"

# 受控常量：与 deploy/vps/compose.yml 及 deploy/auth/auth-config.ts 的默认值一致。
# Keycloak 库 owner 必须是 Keycloak 自己的 role（默认 "keycloak"），否则应用连上
# 却没有表权限；业务库 owner 是 myrix_migrator，ACL 由 grants 一次性 job 重放。
SUPERUSER="myrix_admin"
BUSINESS_DB="myrix"
BUSINESS_OWNER="myrix_migrator"
KEYCLOAK_DB="keycloak"
KEYCLOAK_OWNER="keycloak"
VOLUME="myrix-vps_myrix-cell-1-home"
for ident in "$SUPERUSER" "$BUSINESS_DB" "$BUSINESS_OWNER" "$KEYCLOAK_DB" "$KEYCLOAK_OWNER"; do
  case "$ident" in
    *[!A-Za-z0-9_]*) die "内部常量包含非法标识符字符，拒绝继续" ;;
  esac
done
case "$POSTGRES_IMAGE" in
  *[!A-Za-z0-9._:/@+-]*) die ".env 里的 MYRIX_IMAGE_POSTGRES 含非法字符" ;;
esac
case "$VOLUME" in
  *[!A-Za-z0-9_.-]*) die "卷名包含非法字符，拒绝继续" ;;
esac

# --- 1. 完整性：SUCCESS + 固定清单 + 全部哈希通过（在动数据库/卷之前） ---------
[ -f "$SET_ABS/SUCCESS" ] || die "备份集缺少 SUCCESS 标记，说明它不是一次完整成功的备份，拒绝恢复"
for f in myrix.dump keycloak.dump cell-home.tgz config.tgz; do
  [ -s "$SET_ABS/$f" ] || die "备份集缺少非空的 $f，拒绝恢复（恢复必须是完整同一套）"
done
[ -s "$SET_ABS/sha256sums" ] || die "sha256sums 为空，拒绝恢复"

# 清单必须**恰好**四行、每行形如 `<64位小写十六进制>  <名字>`，名字只能取四份
# 固定产物之一且各出现一次。逐行严格解析（不再用 awk 过滤坏行后只数好行）：
# 任何空行/注释/额外行/单空格/大写哈希/目录外路径/`-` 都会被拒绝，并且是在跑
# `sha256sum -c` **之前**完成——绝不让 sha256sum 打开或读取清单里越界的文件。
EXPECTED="myrix.dump keycloak.dump cell-home.tgz config.tgz"
MANIFEST="$SET_ABS/sha256sums"
SEEN=""
line_no=0
while IFS= read -r line || [ -n "$line" ]; do
  line_no=$((line_no + 1))
  [ "$line_no" -le 4 ] || die "sha256sums 超过 4 行（第 $line_no 行起多余）；拒绝恢复"
  case "$line" in
    *"  "*) ;;
    *) die "sha256sums 第 $line_no 行格式非法（应为 <64位小写十六进制> 加两个空格再加固定名字）；拒绝恢复" ;;
  esac
  hash="${line%%  *}"
  name="${line#*  }"
  [ -n "$hash" ] || die "sha256sums 第 $line_no 行缺少哈希；拒绝恢复"
  case "$hash" in
    *[!0-9a-f]*) die "sha256sums 第 $line_no 行哈希含非小写十六进制字符；拒绝恢复" ;;
  esac
  [ "${#hash}" -eq 64 ] || die "sha256sums 第 $line_no 行哈希不是 64 位十六进制；拒绝恢复"
  case "$name" in
    myrix.dump|keycloak.dump|cell-home.tgz|config.tgz) ;;
    *) die "sha256sums 第 $line_no 行的 $name 不是四份固定产物之一（拒绝额外/目录外/非法路径）；拒绝恢复" ;;
  esac
  case " $SEEN " in
    *" $name "*) die "sha256sums 重复列出 $name；拒绝恢复" ;;
  esac
  SEEN="$SEEN $name"
done < "$MANIFEST"
[ "$line_no" -eq 4 ] || die "sha256sums 必须恰好 4 行，实际 $line_no 行；拒绝恢复不完整/被改写的备份集"
for want in $EXPECTED; do
  case " $SEEN " in
    *" $want "*) ;;
    *) die "sha256sums 缺少固定产物 $want；拒绝恢复" ;;
  esac
done
if ! (cd "$SET_ABS" && sha256sum -c sha256sums >/dev/null); then
  die "SHA-256 校验失败（文件损坏或被篡改）；拒绝恢复，绝不在坏备份上继续"
fi
echo "restore: 备份集 $SET_ABS 完整且 SHA-256 全部通过"

# --- 2. 项目必须已停：只允许 postgres 在跑，否则拒绝（不代替操作者停服务） -----
RUNNING_NONPG="$(docker ps \
  --filter "label=com.docker.compose.project=myrix-vps" \
  --filter "status=running" \
  --format '{{.Label "com.docker.compose.service"}}')"
RUNNING_OTHER="$(printf '%s\n' "$RUNNING_NONPG" | awk 'NF && $0 != "postgres"')"
if [ -n "$RUNNING_OTHER" ]; then
  echo "restore: 项目 myrix-vps 仍有除 postgres 之外的容器在运行，拒绝恢复：" >&2
  printf '%s\n' "$RUNNING_OTHER" | sed 's/^/restore:   - /' >&2
  echo "restore: 请先停 bff/gateway/cell-1/keycloak 与 migrate/auth/grants，再重跑；postgres 保持运行。" >&2
  exit 1
fi

# --- 3. 卷必须存在且为空：不创建、不删除、不清空 ------------------------------
if ! docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  die "数据卷 $VOLUME 不存在；本脚本绝不创建或删除卷，请先按文档完成部署/建空卷"
fi
# 用 `ls -A`（POSIX/BusyBox 均有）判断是否为空；读取失败也一律拒绝。
VOLUME_ENTRIES="$(docker run --rm -v "$VOLUME:/data:ro" "$POSTGRES_IMAGE" \
  /bin/sh -c 'set -eu; [ -d /data ] || exit 1; ls -A /data')" \
  || die "无法读取卷 $VOLUME 的内容，拒绝继续"
if [ -n "$VOLUME_ENTRIES" ]; then
  die "Cell 卷 $VOLUME 非空（例如 $(printf '%s' "$VOLUME_ENTRIES" | head -n 1)）；拒绝覆盖已有历史。请人工确认后再换空卷"
fi

# --- 4. 两个空库：显式超级用户连接，全程容器内组装口令 ------------------------
# 口令只从受控只读文件读入容器内环境变量；命令行参数与日志里没有连接串/口令。
restore_databases() {
  docker run --rm --network myrix-vps \
    -e PGCONNECT_TIMEOUT=15 \
    -e PGHOST=postgres \
    -e PGPORT=5432 \
    -e PGUSER="$SUPERUSER" \
    -e BUSINESS_DB="$BUSINESS_DB" \
    -e BUSINESS_OWNER="$BUSINESS_OWNER" \
    -e KEYCLOAK_DB="$KEYCLOAK_DB" \
    -e KEYCLOAK_OWNER="$KEYCLOAK_OWNER" \
    -v "$(pwd)/secrets:/secrets:ro" \
    -v "$SET_ABS:/backup:ro" \
    "$POSTGRES_IMAGE" /bin/sh -c '
      set -eu
      PGPASSWORD="$(cat /secrets/postgres-superuser-password)"
      [ -n "$PGPASSWORD" ] || { echo "restore: 超级用户口令为空" >&2; exit 1; }
      export PGPASSWORD

      # 目标库必须已由 provision 建好；能连上才说明它存在。
      # 本脚本不建库、不建角色；连不上就失败。
      require_database() {
        psql -d "$1" -tA -v ON_ERROR_STOP=1 -c "select 1" >/dev/null 2>&1 || {
          echo "restore: 数据库 $1 不存在或不可连接；请先用 provision 建空库/角色（见 backup-restore.md）" >&2
          exit 1
        }
      }
      # 空库检查：连库失败或查询失败都必须失败退出，绝不吞错、绝不假设为空。
      require_empty() {
        count="$(psql -d "$1" -tA -v ON_ERROR_STOP=1 \
          -c "select count(*) from information_schema.tables where table_schema not in ('"'"'pg_catalog'"'"','"'"'information_schema'"'"')")"
        [ "$count" = "0" ] || {
          echo "restore: 目标库 $1 已有 $count 张表，拒绝覆盖；请先备份并人工确认" >&2
          exit 1
        }
      }

      require_database "$BUSINESS_DB"
      require_database "$KEYCLOAK_DB"
      require_empty "$BUSINESS_DB"
      require_empty "$KEYCLOAK_DB"

      # --role 决定对象 owner；但**归档里带着 dump 时的 owner/toast 归属信息**，
      # 仅给 --role 并不等于忽略 archive owner，所以必须同时显式 `--no-owner`
      # （让对象归到 SET ROLE 后的 --role）。
      # **不加 `--no-privileges`**：ACL 必须从可信的同部署归档恢复；migrate/auth/
      # grants 无法重建全部授权（renderGrantsSql 只覆盖认证 schema 与成员关系，
      # 已记录的迁移会跳过）。ACL 里引用的角色必须已由 provision 建好，否则此处
      # 会失败退出，而不是静默丢权限。
      pg_restore --exit-on-error --no-owner \
        --role="$BUSINESS_OWNER" \
        --dbname "$BUSINESS_DB" /backup/myrix.dump
      pg_restore --exit-on-error --no-owner \
        --role="$KEYCLOAK_OWNER" \
        --dbname "$KEYCLOAK_DB" /backup/keycloak.dump
      unset PGPASSWORD
    '
}
if ! restore_databases; then
  die "数据库恢复失败；未完成，也不会自动清理或覆盖任何已有数据"
fi
echo "restore: 两个库已恢复（业务库 owner=$BUSINESS_OWNER，Keycloak 库 owner=$KEYCLOAK_OWNER）"

# --- 5. Cell 卷：已确认空，才解包；不做任何删除/移动 --------------------------
if ! docker run --rm \
  -v "$VOLUME:/data" \
  -v "$SET_ABS:/backup:ro" \
  "$POSTGRES_IMAGE" /bin/sh -c '
    set -eu
    tar -xzf /backup/cell-home.tgz -C /data
  '; then
  die "Cell 卷解包失败；卷可能处于半完成状态，请人工检查 $VOLUME"
fi
echo "restore: Cell 卷 $VOLUME 已从同一备份集解包"

# --- 6. 收尾：只列**尚未完成**的步骤，绝不让人重做已完成动作 ------------------
# 配置归档已在本次恢复之前由操作者手工恢复过，空库/角色也已由 provision 建好，
# 本脚本也刚刚跑完；此时库与卷都已非空，重跑 restore.sh / provision 必然被拒绝，
# 所以这里只列后续的 migrate/auth/grants/up 与人工核对项。
echo "restore: 数据库与 Cell 卷已恢复；**配置归档未自动解包**（它含签名私钥与令牌）。"
echo "restore: 不要重跑本脚本，也不要再跑 provision/建库：库与卷现在都非空，会被拒绝。"
echo "restore: 接下来只剩这些（按序，见 docs/deployment/backup-restore.md 第 4 节）："
echo "restore:   1) docker compose ... run --rm migrate   # 幂等；已存在的表/记录会跳过"
echo "restore:   2) docker compose ... run --rm auth      # 建/补齐 myrix_auth schema"
echo "restore:   3) docker compose ... run --rm grants    # 幂等收口 + Cell 凭据/身份登记"
echo "restore:   4) docker compose ... up -d --wait       # 最后启动应用并等健康检查"
echo "restore: 注意：ACL 已随本次归档恢复；migrate/auth/grants **不是** ACL 的完整重建途径。"
echo "restore:   若本备份集是用旧脚本 --no-privileges 生成的，归档里没有 GRANT，恢复后"
echo "restore:   migrate/auth/grants 也无法补全所有权限（尤其 myrix_auth/网关账本之外的对象）；"
echo "restore:   请人工审查权限，绝不要声称已完整恢复。"
echo "restore: 前提：归档里的 GRANT 引用的全部原始角色（myrix_app/myrix_gateway_app/"
echo "restore:   myrix_bff/myrix_auth/myrix_gateway/myrix_migrator 等）必须已由 provision 建好。"
echo "restore: 人工核对（脚本无法代做）：secrets/bff.env 的签名 KID 与 cell-1.env 的"
echo "restore:   MYRIX_GRANT_JWKS 配对、realm owner id 与 sql/30_identity.sql 的 subject 一致、"
echo "restore:   并用真实浏览器完成一次 owner 登录。"
echo "restore: 隔离 PostgreSQL 夹具已验证 FORCE RLS 下的数据/权限恢复；这不替代现场核对。"
echo "restore:   本次恢复仍须人工核对行数、关键行、低权限 LOGIN 与完整 Keycloak 登录。"
echo "restore: 绝不要用“删卷重置”之类捷径：那会把数据卷一并删掉，等于第二次数据丢失。"
