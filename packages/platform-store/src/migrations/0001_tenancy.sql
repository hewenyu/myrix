-- 0001_tenancy.sql — 租户与成员
--
-- members.role   : admin | member（本仓库 first-version 要求 admin/member 两档）
-- members.status : active | disabled（撤权走 status=disabled，不物理删除，保留审计）

create table tenants (
  id uuid primary key,
  slug text not null,
  name text not null,
  residency text,
  status text not null default 'active' check (status in ('active', 'suspended', 'deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tenants_slug_key unique (slug),
  constraint tenants_slug_shape check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  constraint tenants_name_shape check (length(btrim(name)) between 1 and 200)
);

alter table tenants enable row level security;
alter table tenants force row level security;

-- 没有 TO 子句：策略对所有角色生效（含表 owner），与 FORCE 叠加后连 owner 也必须在
-- 正确租户上下文里才能读写。superuser 天然绕过 RLS，因此部署禁止用 superuser 跑应用。
create policy tenant_isolation on tenants
  using (id = myrix_current_tenant())
  with check (id = myrix_current_tenant());

create trigger tenants_touch
  before update on tenants
  for each row execute function myrix_touch_updated_at();

create table members (
  tenant_id uuid not null references tenants (id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('admin', 'member')),
  status text not null default 'active' check (status in ('active', 'disabled')),
  display_name text,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disabled_at timestamptz,
  primary key (tenant_id, user_id),
  constraint members_disabled_consistency check ((status = 'disabled') = (disabled_at is not null))
);

create index members_status_idx on members (tenant_id, status);

alter table members enable row level security;
alter table members force row level security;

create policy tenant_isolation on members
  using (tenant_id = myrix_current_tenant())
  with check (tenant_id = myrix_current_tenant());

create trigger members_touch
  before update on members
  for each row execute function myrix_touch_updated_at();
