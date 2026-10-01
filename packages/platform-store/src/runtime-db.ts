import { sql, type Kysely } from "kysely";

/** Fail startup closed if a runtime URL accidentally uses migration/owner credentials. */
export async function assertRuntimeDatabase<DB>(
  db: Kysely<DB>,
  tables: readonly string[],
  options: { requireRls?: boolean } = {},
): Promise<void> {
  if (!tables.length) throw new Error("运行数据库角色校验必须指定受保护表");
  const identity = await sql<{ login: boolean; privileged: boolean; owns_database: boolean }>`
    select current_user = session_user as login,
      exists (select 1 from pg_catalog.pg_roles r
        where (r.rolsuper or r.rolbypassrls or r.rolcreatedb or r.rolcreaterole)
        and pg_has_role(current_user, r.oid, 'MEMBER')) as privileged,
      pg_has_role(current_user, d.datdba, 'MEMBER') as owns_database
    from pg_catalog.pg_database d where d.datname = current_database()
  `.execute(db);
  const role = identity.rows[0];
  if (!role?.login || role.privileged || role.owns_database) {
    throw new Error("运行数据库必须使用独立非特权 LOGIN；禁止迁移角色、数据库 owner、SET ROLE 或可切换到特权角色的成员");
  }
  const relations = await sql<{ exists: boolean; owns: boolean; rls: boolean; forced: boolean }>`
    select c.oid is not null as exists,
      pg_has_role(current_user, c.relowner, 'MEMBER') as owns,
      c.relrowsecurity as rls, c.relforcerowsecurity as forced
    from unnest(${[...tables]}::text[]) as expected(name)
    left join pg_catalog.pg_class c on c.oid = to_regclass(expected.name)
  `.execute(db);
  if (relations.rows.length !== tables.length || relations.rows.some(row =>
    !row.exists || row.owns || ((options.requireRls ?? true) && (!row.rls || !row.forced)))) {
    throw new Error("运行数据库表缺失、角色可取得表所有权或 FORCE RLS 未开启；请先以独立迁移角色完成部署");
  }
}
