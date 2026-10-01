-- 0006_bindings.sql — 会话绑定（控制面权威记录）
--
-- 绑定 = {sessionId, tenantId, ownerUserId, workId, preset, policyRevision, cellId, status, rev}。
-- 撤权不删行：status='revoked' + revoked_revision 单调递增，cell / 作品服务 / 模型网关
-- 各自按自己看到的 rev 判断"我手里的凭证是不是已经过期"（tech-design-v1 §3.3）。
--
-- 三个 preset 固定为 novel-outline / novel-chapter / novel-bible，用 check 约束而不是
-- 外键到配置表：preset 是运行时代码里的常量，不想为它在数据库再开一张可变表。

create table session_bindings (
  tenant_id uuid not null references tenants (id),
  id uuid not null,
  owner_user_id uuid not null,
  work_id uuid not null,
  preset text not null check (preset in ('novel-outline', 'novel-chapter', 'novel-bible')),
  policy_revision text not null default 'inline',
  cell_id text,
  status text not null default 'creating' check (status in ('creating', 'active', 'revoked', 'closed')),
  -- 撤权版本：契约 JSON 里叫 rev，单调递增；创建即为 1
  revoked_revision integer not null default 1 check (revoked_revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (tenant_id, id),
  foreign key (tenant_id, work_id) references works (tenant_id, id),
  constraint session_bindings_cell_shape check (cell_id is null or length(cell_id) between 1 and 128),
  constraint session_bindings_revoked_consistency check ((status = 'revoked') = (revoked_at is not null))
);

create index session_bindings_owner_idx
  on session_bindings (tenant_id, owner_user_id, created_at desc);

create index session_bindings_work_idx
  on session_bindings (tenant_id, work_id, created_at desc);

-- 投递循环按 cell 查"这个 cell 上还有哪些活跃会话"
create index session_bindings_cell_idx
  on session_bindings (tenant_id, cell_id, status);

alter table session_bindings enable row level security;
alter table session_bindings force row level security;

create policy tenant_isolation on session_bindings
  using (tenant_id = myrix_current_tenant())
  with check (tenant_id = myrix_current_tenant());

create trigger session_bindings_touch
  before update on session_bindings
  for each row execute function myrix_touch_updated_at();
