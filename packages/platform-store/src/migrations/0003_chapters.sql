-- 0003_chapters.sql — 章节头 + 不可变版本
--
-- 章节保存规则（tech-design-v1 §3.5）：
--   expectedVersion == current_version                      → 写新版本
--   current_version.parent_version == expectedVersion
--     且服务端算出的正文哈希 == current_version.content_hash → duplicate（返回已有版本）
--   其他                                                     → conflict
-- 头行只保留指针与哈希，正文只存在 chapter_versions，避免两处正文漂移。

create table chapters (
  tenant_id uuid not null,
  id uuid not null,
  work_id uuid not null,
  title text not null default '',
  current_version integer not null default 0 check (current_version >= 0),
  parent_version integer,
  content_hash text not null,
  status text not null default 'active' check (status in ('active', 'deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  foreign key (tenant_id, work_id) references works (tenant_id, id),
  constraint chapters_title_shape check (length(title) <= 300),
  constraint chapters_hash_shape check (content_hash ~ '^[0-9a-f]{64}$'),
  -- 版本 0 = 无内容；此后每个版本都必须记住父版本，duplicate 判定才有依据
  constraint chapters_version_shape check (
    (current_version = 0 and parent_version is null)
    or (current_version > 0 and parent_version = current_version - 1)
  )
);

create index chapters_work_idx on chapters (tenant_id, work_id, created_at);

alter table chapters enable row level security;
alter table chapters force row level security;

create policy tenant_isolation on chapters
  using (tenant_id = myrix_current_tenant())
  with check (tenant_id = myrix_current_tenant());

create trigger chapters_touch
  before update on chapters
  for each row execute function myrix_touch_updated_at();

create table chapter_versions (
  tenant_id uuid not null,
  chapter_id uuid not null,
  version integer not null check (version >= 0),
  parent_version integer,
  title text not null default '',
  text text not null,
  content_hash text not null,
  author_user_id uuid not null,
  -- 客户端可选的幂等键：同一作者重复提交同一键不会产生第二个版本
  client_key text,
  created_at timestamptz not null default now(),
  primary key (tenant_id, chapter_id, version),
  foreign key (tenant_id, chapter_id) references chapters (tenant_id, id),
  constraint chapter_versions_hash_shape check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint chapter_versions_version_shape check (
    (version = 0 and parent_version is null)
    or (version > 0 and parent_version = version - 1)
  ),
  constraint chapter_versions_client_key_shape check (client_key is null or length(client_key) between 1 and 200)
);

create index chapter_versions_recent_idx
  on chapter_versions (tenant_id, chapter_id, version desc);

alter table chapter_versions enable row level security;
alter table chapter_versions force row level security;

create policy tenant_isolation on chapter_versions
  using (tenant_id = myrix_current_tenant())
  with check (tenant_id = myrix_current_tenant());
