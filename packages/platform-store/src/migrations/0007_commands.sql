-- 0007_commands.sql — 持久命令队列（Postgres，非 Redis）
--
-- 关键约束：
--   * (tenant_id, id) 幂等：同一 commandId 重复入队只会有一行；
--     正文哈希不同则整体拒绝（400 语义），见 apps/works-service 的 enqueueCommand。
--   * 每会话 FIFO + 同一会话同时只有一个投递者：靠 pg_advisory_xact_lock
--     （key = 'myrix:command-lock:' || binding_id）而不是行锁，避免会话没有在途命令时
--     "无行可锁"。锁在事务结束时自动释放，claim 的 SELECT ... FOR UPDATE SKIP LOCKED
--     再保证不会有第二个 worker 拿到同一行。
--   * 超时不等于丢失：投递失败只清空锁定、attempts+1、status 回到 queued，
--     行永远留在表里，直到被 settle 成 succeeded / failed / dead。
--   * dead 不是自动死的：只有 attempts 撞到 max_attempts 才进入，且带 last_error，
--     必须人工/运维显式重新入队（requeue_dead）。

create table commands (
  tenant_id uuid not null references tenants (id),
  id uuid not null,
  binding_id uuid not null,
  work_id uuid not null,
  actor_user_id uuid not null,
  op text not null check (op in ('create', 'resume', 'send', 'cancel', 'subscribe')),
  -- 请求体 SHA-256（十六进制）。凭证的 bh 与它绑定，正文不落库。
  body_hash text not null,
  -- 请求体本身。小说命令正文是用户创作内容，平台本来就存正文（见 ADR-0011 "平台存正文"）。
  body jsonb not null default '{}'::jsonb,
  -- 命令创建时的绑定授权版本，用于"执行时 rev 是否已被推进"的判断
  grant_revision integer not null check (grant_revision >= 1),
  status text not null default 'queued'
    check (status in ('queued', 'inflight', 'succeeded', 'failed', 'dead')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 100),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  lease_expires_at timestamptz,
  settled_at timestamptz,
  receipt jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  foreign key (tenant_id, binding_id) references session_bindings (tenant_id, id),
  constraint commands_body_object check (jsonb_typeof(body) = 'object'),
  constraint commands_hash_shape check (body_hash ~ '^[0-9a-f]{64}$'),
  constraint commands_lock_consistency check (
    (status = 'inflight') = (locked_at is not null and locked_by is not null)
  ),
  constraint commands_settled_consistency check (
    (status in ('succeeded', 'failed', 'dead')) = (settled_at is not null)
  )
);

-- FIFO 取件：同会话按创建时间（同秒用 id 兜底），跨会话按 available_at
create index commands_claim_idx
  on commands (tenant_id, available_at, created_at, id)
  where status = 'queued';

create index commands_binding_idx
  on commands (tenant_id, binding_id, created_at, id);

-- 过期在途命令的回收扫描
create index commands_stale_idx
  on commands (lease_expires_at)
  where status = 'inflight';

alter table commands enable row level security;
alter table commands force row level security;

create policy tenant_isolation on commands
  using (tenant_id = myrix_current_tenant())
  with check (tenant_id = myrix_current_tenant());

create trigger commands_touch
  before update on commands
  for each row execute function myrix_touch_updated_at();
