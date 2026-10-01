-- 0099_grants.sql — 权限收口
--
-- 应用角色 myrix_app 的能力边界：
--   * 业务表：SELECT / INSERT / UPDATE（不能 DELETE —— 删除都是软删除）
--   * 版本表与 audit_events：只有 SELECT / INSERT（append-only，连应用也无法改写历史）
--   * 迁移表 schema myrix_internal：完全不授权，应用看不到迁移状态
--   * 所有函数默认 EXECUTE 给 PUBLIC，这里显式收回到 myrix_app

grant usage on schema public to myrix_app;
grant select, insert, update on
  tenants,
  members,
  works,
  chapters,
  outline_documents,
  bible_entries,
  session_bindings,
  commands,
  outbox_messages
to myrix_app;

grant select, insert on
  chapter_versions,
  outline_versions,
  bible_entry_versions,
  audit_events
to myrix_app;

revoke all on schema myrix_internal from public;
revoke all on all tables in schema myrix_internal from public;
revoke all on all sequences in schema myrix_internal from public;
grant usage on schema myrix_internal to myrix_app;

grant execute on function
  myrix_current_tenant(),
  myrix_current_actor()
to myrix_app;
