#!/bin/sh
# 消费 deploy/vps/init.mjs 生成的私有 SQL；一次性用超级用户建角色并转移库 owner。
# 幂等：重复执行不会重建已存在的角色，也不会重置它们的密码。
# 第二步显式创建 Keycloak 的**独立库**与低权 LOGIN（不复用任何业务角色）。
set -eu

: "${PGHOST:?provision.env 缺少 PGHOST}"
: "${PGDATABASE:?provision.env 缺少 PGDATABASE}"
: "${PGUSER:?provision.env 缺少 PGUSER}"

# 角色 DDL 含私有口令：本次管理员连接不记录 SQL/慢语句，客户端不打印错误行上下文。
# 不改变服务器全局审计配置，也不把这些超级用户参数交给应用角色。
PGOPTIONS='-c log_statement=none -c log_min_error_statement=panic -c log_min_duration_statement=-1 -c log_min_duration_sample=-1'
export PGOPTIONS
psql -v ON_ERROR_STOP=1 -v VERBOSITY=terse -f /sql/00_roles.sql
psql -v ON_ERROR_STOP=1 -v VERBOSITY=terse -f /sql/05_keycloak_db.sql
echo "provision: 角色、库 owner 与 Keycloak 独立库已就绪（未输出任何秘密）"
