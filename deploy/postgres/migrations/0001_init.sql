-- Myrix 控制面数据模型（PostgreSQL 16+）
-- 设计原则：
--   1) 治理数据（谁、对什么、什么条件、以什么方式）与 DSH 无关，独立建模；
--   2) 审计事件与 LLM 网关的调用记录通过 trace_id 关联，平台不复制提示词内容；
--   3) 所有表带 tenant_id，多租户在数据层就隔离，而不是靠应用层约定。

begin;

create schema if not exists myrix;

create table if not exists myrix.tenants (
  id            text primary key,
  name          text not null,
  residency     text,
  status        text not null default 'active' check (status in ('active','suspended')),
  created_at    timestamptz not null default now()
);

create table if not exists myrix.principals (
  id            text primary key,
  tenant_id     text not null references myrix.tenants(id) on delete cascade,
  kind          text not null check (kind in ('user','service','agent')),
  display_name  text not null,
  email         text,
  department    text,
  title         text,
  groups        text[] not null default '{}',
  attributes    jsonb not null default '{}'::jsonb,
  status        text not null default 'active' check (status in ('active','disabled')),
  external_id   text,                                   -- IdP 侧唯一标识（OIDC sub / LDAP DN）
  idp           text,                                   -- 来源：oidc:feishu / ldap:corp / local
  synced_at     timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists principals_tenant_dept_idx on myrix.principals (tenant_id, department);
create index if not exists principals_groups_idx on myrix.principals using gin (groups);
create unique index if not exists principals_idp_external_idx on myrix.principals (idp, external_id) where idp is not null;

create table if not exists myrix.roles (
  id            text primary key,
  tenant_id     text references myrix.tenants(id) on delete cascade,
  name          text not null,
  description   text,
  permissions   text[] not null default '{}',
  inherits      text[] not null default '{}',
  updated_at    timestamptz not null default now()
);

create table if not exists myrix.role_bindings (
  id            bigserial primary key,
  tenant_id     text not null references myrix.tenants(id) on delete cascade,
  principal_id  text not null references myrix.principals(id) on delete cascade,
  role_id       text not null references myrix.roles(id) on delete cascade,
  scope_type    text,
  scope_id      text,
  granted_by    text,
  created_at    timestamptz not null default now(),
  unique (tenant_id, principal_id, role_id, scope_type, scope_id)
);
create index if not exists role_bindings_principal_idx on myrix.role_bindings (principal_id, tenant_id);

-- 策略是版本化对象：修订不可变，便于回答"当时为什么放行"
create table if not exists myrix.policy_revisions (
  revision      text primary key,
  tenant_id     text references myrix.tenants(id) on delete cascade,
  note          text,
  created_by    text,
  created_at    timestamptz not null default now()
);

create table if not exists myrix.policies (
  id            text not null,
  revision      text not null references myrix.policy_revisions(revision) on delete cascade,
  tenant_id     text references myrix.tenants(id) on delete cascade,
  effect        text not null check (effect in ('allow','deny')),
  description   text,
  actions       text[] not null,
  resources     text[] not null,
  condition     jsonb,
  obligations   jsonb not null default '[]'::jsonb,
  primary key (id, revision)
);
create index if not exists policies_revision_idx on myrix.policies (revision);

create table if not exists myrix.plugins (
  id            text primary key,
  kind          text not null,
  display_name  text not null,
  description   text,
  risk          text not null check (risk in ('low','medium','high')),
  requires      text[] not null default '{}',
  provides      text[] not null default '{}',
  conflicts_with text[] not null default '{}',
  default_enabled boolean not null default false,
  source        text,                                    -- npm 包名@版本
  cordis_row_id text,                                    -- 对应 cordis 配置行 id
  updated_at    timestamptz not null default now()
);

create table if not exists myrix.plugin_grants (
  id            bigserial primary key,
  tenant_id     text not null references myrix.tenants(id) on delete cascade,
  plugin_id     text not null references myrix.plugins(id) on delete cascade,
  grantee       text not null,                           -- u_xxx / role:xxx / group:xxx / tenant:xxx
  granted_by    text not null,
  granted_at    timestamptz not null default now(),
  expires_at    timestamptz,
  constraints   text[] not null default '{}',
  unique (tenant_id, plugin_id, grantee)
);

create table if not exists myrix.tenant_plugin_baseline (   -- 租户级默认启用集合
  tenant_id     text not null references myrix.tenants(id) on delete cascade,
  plugin_id     text not null references myrix.plugins(id) on delete cascade,
  enabled       boolean not null default true,
  primary key (tenant_id, plugin_id)
);

-- 知识库目录：平台只存"连接器与库的元信息"，正文与 ACL 仍在企业知识库侧
create table if not exists myrix.knowledge_connectors (
  id            text primary key,
  provider      text not null,
  endpoint      text,
  acl_domain    text,
  secret_ref    text,                                    -- 指向 ctx.credentials / Vault 的引用，不落明文
  created_at    timestamptz not null default now()
);

create table if not exists myrix.knowledge_bases (
  id            text primary key,
  tenant_id     text not null references myrix.tenants(id) on delete cascade,
  connector_id  text not null references myrix.knowledge_connectors(id) on delete cascade,
  name          text not null,
  description   text,
  acl_domain    text,
  metadata      jsonb not null default '{}'::jsonb,
  synced_at     timestamptz
);

-- 平台侧的"可见性提示"：最终裁决仍在知识库侧，这里只用于目录展示与路由
create table if not exists myrix.knowledge_base_visibility (
  base_id       text not null references myrix.knowledge_bases(id) on delete cascade,
  subject_kind  text not null check (subject_kind in ('principal','group','role')),
  subject_id    text not null,
  primary key (base_id, subject_kind, subject_id)
);

create table if not exists myrix.audit_events (
  id            bigserial primary key,
  event_id      text not null unique,
  ts            timestamptz not null default now(),
  tenant_id     text not null,
  principal_id  text not null,
  session_id    text,
  trace_id      text,
  category      text not null check (category in ('policy-decision','tool-execution','knowledge-access','admin-change')),
  action        text not null,
  resource      text not null,
  effect        text not null check (effect in ('allow','deny')),
  matched_rules text[] not null default '{}',
  obligations   jsonb not null default '[]'::jsonb,
  detail        jsonb not null default '{}'::jsonb
);
create index if not exists audit_events_tenant_ts_idx on myrix.audit_events (tenant_id, ts desc);
create index if not exists audit_events_principal_ts_idx on myrix.audit_events (principal_id, ts desc);
create index if not exists audit_events_trace_idx on myrix.audit_events (trace_id);

-- LLM 网关侧写入的调用记录（模型、用量、成本）。平台只做关联，不存提示词正文。
create table if not exists myrix.llm_gateway_calls (
  id            bigserial primary key,
  trace_id      text not null,
  ts            timestamptz not null default now(),
  tenant_id     text not null,
  principal_id  text not null,
  session_id    text,
  agent_id      text,
  provider      text not null,
  model         text not null,
  prompt_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_micros   bigint not null default 0,
  latency_ms    integer,
  status        text not null default 'ok',
  policy_revision text,                                  -- 判定时使用的策略版本，便于回溯
  detail        jsonb not null default '{}'::jsonb
);
create index if not exists llm_gateway_calls_tenant_ts_idx on myrix.llm_gateway_calls (tenant_id, ts desc);
create index if not exists llm_gateway_calls_trace_idx on myrix.llm_gateway_calls (trace_id);

-- 管理后台操作员：只存映射关系，认证交给 IdP
create table if not exists myrix.console_operators (
  principal_id  text primary key references myrix.principals(id) on delete cascade,
  tenant_id     text not null references myrix.tenants(id) on delete cascade,
  console_role  text not null check (console_role in ('viewer','operator','admin')),
  created_at    timestamptz not null default now()
);

insert into myrix.policy_revisions (revision, tenant_id, note, created_by)
values ('policies-7-3', 'acme', '演示种子：与 packages/control-plane/src/seed.ts 对齐', 'bootstrap')
on conflict (revision) do nothing;

commit;
