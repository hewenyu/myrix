-- 0000_roles.sql — 内部 schema、租户上下文函数、公共触发器，以及应用角色
--
-- 目标（对应 docs/adr/0011-postgres-ownership.md）：
--   * 业务表的 owner 是"迁移角色"（部署时通常叫 myrix_owner，本仓库测试里就是库管理员）。
--   * 应用连接用的角色 myrix_app 必须是：NOSUPERUSER / NOBYPASSRLS / NOCREATEDB / NOCREATEROLE。
--     这样 FORCE ROW LEVEL SECURITY 对它一定生效，跨租户只能靠 RLS 拦。
--   * 迁移表放在 myrix_internal schema，不授予应用角色任何权限。

create schema if not exists myrix_internal;

-- 当前事务的租户上下文。未设置时返回 NULL，任何 `tenant_id = NULL` 都不成立 →
-- 没有上下文时一行都读不到、也写不进去（fail-closed）。
-- 由应用在事务内用 set_config('myrix.tenant_id', $1, true) 注入，true = 仅本事务有效，
-- 事务结束后连接池复用该连接也不会残留（见 PlatformStore.withTenant）。
create or replace function myrix_current_tenant() returns uuid
language sql
stable
as $$
  select nullif(current_setting('myrix.tenant_id', true), '')::uuid
$$;

-- 当前事务的操作者（可空）。仅用于审计辅助列，不参与授权判定。
create or replace function myrix_current_actor() returns uuid
language sql
stable
as $$
  select nullif(current_setting('myrix.actor_user_id', true), '')::uuid
$$;

-- updated_at 维护
create or replace function myrix_touch_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- 不可变表（版本、审计）：任何 UPDATE / DELETE 一律报错。
-- 这是第二道防线：第一道是 0099_grants.sql 里只授予 SELECT / INSERT。
create or replace function myrix_reject_mutation() returns trigger
language plpgsql
as $$
begin
  raise exception 'myrix: % 是只追加表，不允许 %', tg_table_name, tg_op
    using errcode = 'restrict_violation';
end
$$;

do $$
declare
  r pg_roles;
begin
  select * into r from pg_roles where rolname = 'myrix_app';

  if not found then
    begin
      create role myrix_app nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
    exception
      when insufficient_privilege then
        raise exception
          'myrix: 角色 myrix_app 不存在，且当前用户无权创建角色。请由 DBA 执行 deploy/sql/bootstrap-roles.sql 后再跑迁移。';
    end;
    select * into r from pg_roles where rolname = 'myrix_app';
  end if;

  if r.rolsuper or r.rolbypassrls or r.rolcreatedb or r.rolcreaterole then
    raise exception
      'myrix: 应用角色 myrix_app 权限过大（superuser=%, bypassrls=%, createdb=%, createrole=%）。RLS 会被绕过，必须收紧后重试。',
      r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole;
  end if;
end
$$;
