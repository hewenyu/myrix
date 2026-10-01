-- 0004_outline.sql — 大纲（每作品一份文档）+ 不可变版本
--
-- 与章节一致的 CAS 语义：expectedVersion == current_version → 写新版本；
-- current_version - 1 == expectedVersion 且哈希相同 → duplicate；否则 conflict。
-- 作品没有大纲时 outline_documents 不存在，读取返回 version 0 / 空文档。

create table outline_documents (
  tenant_id uuid not null,
  work_id uuid not null,
  current_version integer not null default 0 check (current_version >= 0),
  parent_version integer,
  content_hash text not null,
  updated_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, work_id),
  foreign key (tenant_id, work_id) references works (tenant_id, id),
  constraint outline_hash_shape check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint outline_version_shape check (
    (current_version = 0 and parent_version is null)
    or (current_version > 0 and parent_version = current_version - 1)
  )
);

alter table outline_documents enable row level security;
alter table outline_documents force row level security;

create policy tenant_isolation on outline_documents
  using (tenant_id = myrix_current_tenant())
  with check (tenant_id = myrix_current_tenant());

create trigger outline_documents_touch
  before update on outline_documents
  for each row execute function myrix_touch_updated_at();

create table outline_versions (
  tenant_id uuid not null,
  work_id uuid not null,
  version integer not null check (version >= 0),
  parent_version integer,
  -- 结构化大纲节点；结构由 apps/works-service 的 schema 校验，DB 只保证是 JSON 对象
  document jsonb not null,
  content_hash text not null,
  author_user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, work_id, version),
  foreign key (tenant_id, work_id) references works (tenant_id, id),
  constraint outline_versions_object check (jsonb_typeof(document) = 'object'),
  constraint outline_versions_hash_shape check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint outline_versions_version_shape check (
    (version = 0 and parent_version is null)
    or (version > 0 and parent_version = version - 1)
  )
);

create index outline_versions_recent_idx
  on outline_versions (tenant_id, work_id, version desc);

alter table outline_versions enable row level security;
alter table outline_versions force row level security;

create policy tenant_isolation on outline_versions
  using (tenant_id = myrix_current_tenant())
  with check (tenant_id = myrix_current_tenant());
