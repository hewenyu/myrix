-- 0000_gateway.sql — 模型网关账本（schema myrix_gateway）
--
-- 设计要点（对应 docs/adr/0015-model-accounting.md）：
--   * 账本只放计量数字、状态、关联 id：**不放聊天正文、不放任何密钥**。
--   * FORCE ROW LEVEL SECURITY + 非 owner 应用角色 myrix_gateway_app：
--     NOSUPERUSER / NOBYPASSRLS / NOCREATEDB / NOCREATEROLE，且不是表 owner，
--     因此连表 owner 之外的角色也无法跨租户读写。
--   * 预占串行化：reserve 在事务里先取租户/用户/会话三个事务级 advisory lock，
--     再算窗口内已占用量并插入；并发请求因此排队，不会出现超卖。
--   * 幂等：主键 (tenant_id, request_id)；重复预占返回既有行，不重复扣减。
--   * cell 凭据表不授予应用角色任何权限，只能通过 SECURITY DEFINER 函数按
--     令牌 SHA-256 精确查询单行，避免跨租户枚举。

create schema if not exists myrix_gateway;

do $$
declare
  r pg_roles;
begin
  if not exists (select 1 from pg_namespace where nspname = 'myrix_gateway') then
    raise exception 'myrix_gateway: schema 创建失败';
  end if;

  select * into r from pg_roles where rolname = 'myrix_gateway_app';
  if not found then
    begin
      create role myrix_gateway_app nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
    exception
      when insufficient_privilege then
        raise exception
          'myrix_gateway: 角色 myrix_gateway_app 不存在，且当前用户无权创建角色。请由 DBA 执行 deploy/sql/bootstrap-roles.sql 后再跑迁移。';
    end;
    select * into r from pg_roles where rolname = 'myrix_gateway_app';
  end if;

  if r.rolsuper or r.rolbypassrls or r.rolcreatedb or r.rolcreaterole then
    raise exception
      'myrix_gateway: 应用角色权限过大（superuser=%, bypassrls=%, createdb=%, createrole=%），RLS 会被绕过，必须收紧后重试。',
      r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole;
  end if;
end
$$;

-- 事务级租户上下文：未设置时返回 NULL，tenant_id = NULL 恒不成立 → fail-closed。
create or replace function myrix_gateway.current_tenant() returns uuid
language sql
stable
as $$
  select nullif(current_setting('myrix_gateway.tenant_id', true), '')::uuid
$$;

create or replace function myrix_gateway.current_actor() returns uuid
language sql
stable
as $$
  select nullif(current_setting('myrix_gateway.actor_user_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- cell 服务凭据：token 的 SHA-256 → (tenant_id, cell_id)
-- 明文令牌不进数据库、不进日志；撤销 = 删行（或 status='disabled'）。
-- ---------------------------------------------------------------------------
create table if not exists myrix_gateway.cell_credentials (
  token_hash text primary key,
  tenant_id uuid not null,
  cell_id text not null,
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint cell_credentials_hash_shape check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint cell_credentials_cell_shape check (length(cell_id) between 1 and 128),
  constraint cell_credentials_revoked_consistency check ((status = 'disabled') = (revoked_at is not null))
);

alter table myrix_gateway.cell_credentials enable row level security;
alter table myrix_gateway.cell_credentials force row level security;

create policy cell_credentials_tenant_isolation on myrix_gateway.cell_credentials
  using (tenant_id = myrix_gateway.current_tenant())
  with check (tenant_id = myrix_gateway.current_tenant());

-- FORCE RLS 连表 owner 也拦，所以 "查凭据" 这一步必须在策略里显式开口：
-- 只允许**精确匹配本次查询的令牌摘要**（lookup_hash 由 SECURITY DEFINER 函数设置，
-- 应用角色既没有表权限、也不能自己设置这个开关去旁路策略）。
create or replace function myrix_gateway.lookup_hash() returns text
language sql
stable
as $$
  select nullif(current_setting('myrix_gateway.lookup_hash', true), '')
$$;

drop policy if exists cell_credentials_lookup on myrix_gateway.cell_credentials;
create policy cell_credentials_lookup on myrix_gateway.cell_credentials
  for select
  using (token_hash = myrix_gateway.lookup_hash());

-- 唯一对外入口：按令牌摘要精确查一行。调用方拿不到表权限，也无法按租户列举。
create or replace function myrix_gateway.resolve_cell_credential(p_token_hash text)
returns table (tenant_id uuid, cell_id text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, myrix_gateway
as $$
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return;
  end if;
  perform set_config('myrix_gateway.lookup_hash', p_token_hash, true);
  return query
    select c.tenant_id, c.cell_id
    from myrix_gateway.cell_credentials c
    where c.token_hash = p_token_hash
      and c.status = 'active';
end
$$;

-- ---------------------------------------------------------------------------
-- 额度预占与结算账本：一行 = 一次逻辑模型调用
-- ---------------------------------------------------------------------------
create table if not exists myrix_gateway.quota_reservations (
  tenant_id uuid not null,
  request_id text not null,
  user_id uuid not null,
  session_id text not null,
  cell_id text not null,
  model text not null,
  reserved_tokens integer not null check (reserved_tokens > 0),
  consumed_tokens integer not null default 0 check (consumed_tokens >= 0),
  outcome text not null default 'pending' check (outcome in ('pending', 'settled', 'unknown', 'released')),
  prompt_tokens integer check (prompt_tokens is null or prompt_tokens >= 0),
  completion_tokens integer check (completion_tokens is null or completion_tokens >= 0),
  upstream_status integer,
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  primary key (tenant_id, request_id),
  constraint quota_reservations_request_shape check (request_id ~ '^[A-Za-z0-9._:-]{8,128}$'),
  constraint quota_reservations_session_shape check (length(session_id) between 1 and 128),
  constraint quota_reservations_cell_shape check (length(cell_id) between 1 and 128),
  constraint quota_reservations_model_shape check (length(model) between 1 and 200),
  constraint quota_reservations_settled_consistency check ((outcome = 'pending') = (settled_at is null)),
  -- 结算值不得超过预占：预占就是本次调用的计费上限（"保守保留"即等于预占量）。
  constraint quota_reservations_consumed_within_reservation check (consumed_tokens <= reserved_tokens)
);

create index if not exists quota_reservations_tenant_window_idx
  on myrix_gateway.quota_reservations (tenant_id, created_at desc);
create index if not exists quota_reservations_user_window_idx
  on myrix_gateway.quota_reservations (tenant_id, user_id, created_at desc);
create index if not exists quota_reservations_session_window_idx
  on myrix_gateway.quota_reservations (tenant_id, session_id, created_at desc);
create index if not exists quota_reservations_pending_idx
  on myrix_gateway.quota_reservations (tenant_id, outcome)
  where outcome = 'pending';

alter table myrix_gateway.quota_reservations enable row level security;
alter table myrix_gateway.quota_reservations force row level security;

create policy quota_reservations_tenant_isolation on myrix_gateway.quota_reservations
  using (tenant_id = myrix_gateway.current_tenant())
  with check (tenant_id = myrix_gateway.current_tenant());

-- 审批/运维只读视图（仍受 RLS 约束），不给应用角色 DELETE。
grant usage on schema myrix_gateway to myrix_gateway_app;
grant select, insert, update on myrix_gateway.quota_reservations to myrix_gateway_app;
grant execute on function myrix_gateway.current_tenant(), myrix_gateway.current_actor() to myrix_gateway_app;
grant execute on function myrix_gateway.resolve_cell_credential(text) to myrix_gateway_app;

-- cell_credentials 表本身不授权：只能走 SECURITY DEFINER 函数。
revoke all on myrix_gateway.cell_credentials from public;
revoke all on myrix_gateway.cell_credentials from myrix_gateway_app;

comment on table myrix_gateway.quota_reservations is
  '额度预占与结算账本：只有计量数字与关联 id，不含聊天正文与密钥；FORCE RLS 按租户隔离';
comment on function myrix_gateway.resolve_cell_credential(text) is
  '按 cell 服务令牌的 SHA-256 解析 (tenant_id, cell_id)，仅返回 active 行；表本身不授予应用角色';
