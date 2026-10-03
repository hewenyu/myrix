-- 0011_drop_session_archive_consistency.sql — 删除"已撤权不得带归档"这条无意义约束
--
-- 背景：0010 引入 `session_bindings_archived_consistency`
-- （`not (status = 'revoked' and archived_at is not null)`），当时的归档语义是
-- "暂停交互"：归档期间拒绝 send/cancel/事件流/工具调用/恢复，所以"已撤权"与
-- "归档中"被视为互斥状态。
--
-- 修订后的语义：**归档只整理历史，不停止任务**。归档与撤权正交 ——
--   * 归档只拒绝新的 send（BFF 层 409 session_archived，可 restore）；
--   * cancel、事件流（含必要 resume）、Cell 工具权限/快照、已入队命令都不受影响；
--   * 撤权是终态，作用在归档会话上完全合法（DELETE /sessions/:id、停用成员触发的
--     批量撤权），而且**必须成功**。
--
-- 保留该约束会让"撤权一条已归档会话"直接违反 23514 → 500：
--   * `SessionsRepository.revoke` 只 UPDATE status/revoked_revision/revoked_at，
--     不清 archived_at；
--   * `revokeActiveBindingsOfOwner`（停用成员）同样是批量 UPDATE。
-- 该约束此时不保护任何东西：撤权后的会话本就退出列表、不接受归档/恢复写入。
-- 因此把它删掉，而不是让每条撤权路径都额外写一次 archived_at（那是把展示元数据
-- 混进撤权事务，反而扩大撤权路径的写面）。
--
-- 0010 已经应用到既有环境（迁移表记录校验和，不可改写），所以这里用追加迁移。

alter table session_bindings
  drop constraint if exists session_bindings_archived_consistency;
