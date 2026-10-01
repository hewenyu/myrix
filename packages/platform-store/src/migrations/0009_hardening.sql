-- 0009_hardening.sql — 所有者完整性、审计 actor 可空、应用角色可登录
--
-- 这一版把三件事收口（对应 docs/adr/0011-postgres-ownership.md 的"所有者强制"）：
--
--   1. **所有者必须是同租户成员**：works / session_bindings / commands 的 owner/actor
--      列上加复合外键 (tenant_id, user_id) → members(tenant_id, user_id)。
--      这样"某租户的作品属于另一个租户的人"在约束层就不可能存在，
--      即使应用代码写错、RLS 上下文被绕过，数据库也会拒绝。
--      作品下的章节/大纲/设定通过 (tenant_id, work_id) → works 间接继承同一保证。
--
--   2. **审计的 actor 可为 NULL**：投递循环、outbox 重投递这类系统事件没有具体的人。
--      原先 not null 会逼着调用方编一个假 userId，那是更糟的审计。
--
--   3. **成员角色补齐 auditor**：governance（ADR-0012）有 member/admin/auditor 三档，
--      SQL 侧的 check 必须一致，否则 auditor 分支永远不会被真实数据触发。
--
--   4. **myrix_app 可登录但仍是 NOBYPASSRLS 非 owner**：LOGIN 只解决"能不能连"，
--      SUPERUSER / BYPASSRLS / CREATEDB / CREATEROLE 在 0000 里已被显式禁止。
--      密码**不写进迁移**（会随版本库泄漏到生产）；开发密码由 `pnpm seed:dev` 在
--      确认目标是 loopback 库之后设置，见 packages/platform-store/src/bin/seed.ts。

-- 1) 角色补齐 auditor（与 packages/governance/src/authorize-platform.ts 对齐）
alter table members drop constraint if exists members_role_check;
alter table members add constraint members_role_check check (role in ('admin', 'member', 'auditor'));

-- 2) 审计 actor 可空：系统事件（投递循环/outbox/运维）没有人类发起人
alter table audit_events alter column actor_user_id drop not null;

-- 3) 所有者完整性：owner / actor 必须是**同租户**的成员
alter table works
  add constraint works_owner_member_fk
  foreign key (tenant_id, owner_user_id) references members (tenant_id, user_id);

alter table session_bindings
  add constraint session_bindings_owner_member_fk
  foreign key (tenant_id, owner_user_id) references members (tenant_id, user_id);

alter table commands
  add constraint commands_actor_member_fk
  foreign key (tenant_id, actor_user_id) references members (tenant_id, user_id);

-- 4) 应用角色：只放开 LOGIN，其余仍是 0000 里校验过的收紧值。
--    密码留空 = 只能靠 `SET ROLE` 或 DBA 后续授权，不引入默认口令。
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'myrix_app') then
    execute 'alter role myrix_app login';
  end if;
end
$$;
