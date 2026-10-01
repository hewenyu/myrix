-- 0002_works.sql — 作品（单一所有者，见 platform-plan-v2 D11）
--
-- 说明：
--   * 复合主键 (tenant_id, id)：租户列永远是查询前缀，子表外键也把 tenant_id 一起带上，
--     这样"跨租户引用"在约束层就不可能成立。
--   * 刻意不建 tenant_id → tenants(id) 的全局唯一索引：主键已保证 (tenant_id, id) 唯一，
--     多余的唯一约束只是索引开销。
--   * works 不物理删除：status='deleted' 软删除；版本表的 append-only 约束与
--     ON DELETE RESTRICT 共同保证"删作品必须显式清理版本"（见 ADR-0011）。

create table works (
  tenant_id uuid not null references tenants (id),
  id uuid not null,
  owner_user_id uuid not null,
  title text not null,
  description text not null default '',
  status text not null default 'active' check (status in ('active', 'archived', 'deleted')),
  -- 作品级乐观版本：任何 update 自增，用于 ETag / 列表缓存失效
  version integer not null default 0 check (version >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  constraint works_title_shape check (length(btrim(title)) between 1 and 300),
  constraint works_description_shape check (length(description) <= 20000)
);

create index works_owner_idx on works (tenant_id, owner_user_id, created_at desc);
create index works_list_idx on works (tenant_id, created_at desc) where status <> 'deleted';

alter table works enable row level security;
alter table works force row level security;

create policy tenant_isolation on works
  using (tenant_id = myrix_current_tenant())
  with check (tenant_id = myrix_current_tenant());

create trigger works_touch
  before update on works
  for each row execute function myrix_touch_updated_at();
