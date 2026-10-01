-- 0005_bible.sql — 设定圣经条目 + 不可变版本
--
-- 条目覆盖角色 / 地点 / 势力 / 时间线等（kind）。搜索用 name/summary/attributes 的
-- 简单 ILIKE 命中；分词语义留给后续（v0.1 不引入 pg_trgm / 全文索引，保持迁移无扩展依赖）。

create table bible_entries (
  tenant_id uuid not null,
  id uuid not null,
  work_id uuid not null,
  kind text not null check (kind in ('character', 'location', 'faction', 'timeline', 'item', 'concept')),
  name text not null,
  summary text not null default '',
  attributes jsonb not null default '{}'::jsonb,
  current_version integer not null default 0 check (current_version >= 0),
  parent_version integer,
  content_hash text not null,
  status text not null default 'active' check (status in ('active', 'deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  foreign key (tenant_id, work_id) references works (tenant_id, id),
  constraint bible_entries_name_shape check (length(btrim(name)) between 1 and 200),
  constraint bible_entries_summary_shape check (length(summary) <= 20000),
  constraint bible_entries_attributes_object check (jsonb_typeof(attributes) = 'object'),
  constraint bible_entries_hash_shape check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint bible_entries_version_shape check (
    (current_version = 0 and parent_version is null)
    or (current_version > 0 and parent_version = current_version - 1)
  )
);

-- 同一作品内条目名唯一（软删除的不算），避免"两个林黛玉"这种设定漂移
create unique index bible_entries_name_key
  on bible_entries (tenant_id, work_id, lower(name))
  where status <> 'deleted';

create index bible_entries_work_idx on bible_entries (tenant_id, work_id, kind, name);

alter table bible_entries enable row level security;
alter table bible_entries force row level security;

create policy tenant_isolation on bible_entries
  using (tenant_id = myrix_current_tenant())
  with check (tenant_id = myrix_current_tenant());

create trigger bible_entries_touch
  before update on bible_entries
  for each row execute function myrix_touch_updated_at();

create table bible_entry_versions (
  tenant_id uuid not null,
  entry_id uuid not null,
  version integer not null check (version >= 0),
  parent_version integer,
  kind text not null check (kind in ('character', 'location', 'faction', 'timeline', 'item', 'concept')),
  name text not null,
  summary text not null default '',
  attributes jsonb not null default '{}'::jsonb,
  content_hash text not null,
  author_user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, entry_id, version),
  foreign key (tenant_id, entry_id) references bible_entries (tenant_id, id),
  constraint bible_entry_versions_object check (jsonb_typeof(attributes) = 'object'),
  constraint bible_entry_versions_hash_shape check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint bible_entry_versions_version_shape check (
    (version = 0 and parent_version is null)
    or (version > 0 and parent_version = version - 1)
  )
);

create index bible_entry_versions_recent_idx
  on bible_entry_versions (tenant_id, entry_id, version desc);

alter table bible_entry_versions enable row level security;
alter table bible_entry_versions force row level security;

create policy tenant_isolation on bible_entry_versions
  using (tenant_id = myrix_current_tenant())
  with check (tenant_id = myrix_current_tenant());
