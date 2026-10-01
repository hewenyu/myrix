#!/bin/sh
# 由 deploy/vps/init.mjs 生成；一次性执行，在迁移之后做低权授权与凭据登记。
# 使用 migrator 角色连接（PG* 变量由 secrets/migrator.env 提供）；
# 账本表/函数必须已经由 migrate 建好。
set -eu

: "${PGHOST:?secrets/migrator.env 缺少 PGHOST}"
: "${PGDATABASE:?secrets/migrator.env 缺少 PGDATABASE}"
: "${PGUSER:?secrets/migrator.env 缺少 PGUSER}"

psql -v ON_ERROR_STOP=1 -f /sql/10_grants.sql
psql -v ON_ERROR_STOP=1 -f /sql/20_cell_credentials.sql
psql -v ON_ERROR_STOP=1 -f /sql/30_identity.sql
echo "grants: 低权授权、Cell 凭据摘要与初始身份已登记（未输出任何秘密）"
