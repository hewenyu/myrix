-- 0008_outbox_audit.sql — 事务性 outbox + 只追加审计
--
-- outbox：凡是"数据库提交了、外部系统也必须最终知道"的动作（撤权通知、唤醒 cell、
-- 审计外送）都在业务事务里写 outbox 行，再由投递循环搬运。不允许在事务外直接发通知，
-- 否则进程崩溃会永久丢事件。
--
-- audit_events：只追加。第一版定位为运营审计（谁、何时、哪个会话、做了什么），
-- 不宣称合规级不可抵赖；哈希链留给后续 ADR。UPDATE/DELETE 由触发器直接报错，
-- 加上 0099_grants.sql 只授予 SELECT/INSERT，构成双保险。

create table outbox_messages (
  tenant_id uuid not null references tenants (id),
  id uuid not null,
  topic text not null,
  -- 同一租户内去重键：同一业务事实只投递一次
  dedupe_key text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'inflight', 'delivered', 'failed', 'dead')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 10 check (max_attempts between 1 and 100),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  lease_expires_at timestamptz,
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  constraint outbox_topic_shape check (topic ~ '^[a-z][a-z0-9._-]{2,63}$'),
  constraint outbox_dedupe_shape check (length(dedupe_key) between 1 and 200),
  constraint outbox_payload_object check (jsonb_typeof(payload) = 'object'),
  constraint outbox_dedupe_unique unique (tenant_id, dedupe_key),
  constraint outbox_lock_consistency check (
    (status = 'inflight') = (locked_at is not null and locked_by is not null)
  ),
  constraint outbox_delivered_consistency check ((status = 'delivered') = (delivered_at is not null))
);

create index outbox_claim_idx
  on outbox_messages (tenant_id, available_at, created_at, id)
  where status = 'pending';

create index outbox_stale_idx
  on outbox_messages (lease_expires_at)
  where status = 'inflight';

alter table outbox_messages enable row level security;
alter table outbox_messages force row level security;

create policy tenant_isolation on outbox_messages
  using (tenant_id = myrix_current_tenant())
  with check (tenant_id = myrix_current_tenant());

create trigger outbox_messages_touch
  before update on outbox_messages
  for each row execute function myrix_touch_updated_at();

create table audit_events (
  tenant_id uuid not null references tenants (id),
  id uuid not null,
  -- 全局单调序号：只用于"按记录顺序"读取与外部对账，不参与授权
  seq bigint generated always as identity,
  occurred_at timestamptz not null default now(),
  recorded_at timestamptz not null default now(),
  actor_user_id uuid not null,
  actor_kind text not null check (actor_kind in ('user', 'service', 'agent')),
  session_id uuid,
  work_id uuid,
  category text not null check (
    category in ('policy-decision', 'tool-execution', 'knowledge-access', 'admin-change', 'data-write')
  ),
  action text not null,
  resource text not null,
  effect text not null check (effect in ('allow', 'deny')),
  -- 为什么开/关：仓库硬性规则 3 要求可读原因，默认拒绝也必须写清
  reason text not null,
  matched_rules text[] not null default '{}',
  obligations jsonb not null default '[]'::jsonb,
  detail jsonb not null default '{}'::jsonb,
  trace_id text,
  primary key (tenant_id, id),
  constraint audit_action_shape check (length(action) between 1 and 200),
  constraint audit_resource_shape check (length(resource) between 1 and 300),
  constraint audit_reason_shape check (length(reason) between 1 and 2000),
  constraint audit_obligations_array check (jsonb_typeof(obligations) = 'array'),
  constraint audit_detail_object check (jsonb_typeof(detail) = 'object')
);

create index audit_events_time_idx on audit_events (tenant_id, occurred_at desc, seq desc);
create index audit_events_actor_idx on audit_events (tenant_id, actor_user_id, occurred_at desc);
create index audit_events_session_idx on audit_events (tenant_id, session_id, occurred_at desc);

alter table audit_events enable row level security;
alter table audit_events force row level security;

create policy tenant_isolation on audit_events
  using (tenant_id = myrix_current_tenant())
  with check (tenant_id = myrix_current_tenant());

create trigger audit_events_append_only
  before update or delete on audit_events
  for each row execute function myrix_reject_mutation();
