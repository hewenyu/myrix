-- 0010_session_archive_and_assistant.sql — 统一创作助手 preset + 会话归档（展示元数据）
--
-- 两件事，都是**追加式**变更（不改写历史行、不删列、不重建表）：
--
--   1. 新增 preset `novel-assistant`：一个助手持有现有六个小说工具全集，
--      由系统提示指导它在自然对话里自行判断大纲/正文/设定任务。
--      `PRESET_TOOLS`（packages/novel-protocol）里一次性登记四个 preset 的掩码；
--      这里的 check 约束必须与它逐字一致，否则"代码声称支持、数据库拒绝落库"。
--      三个历史 preset 的值**原样保留**：已有会话继续可读、可恢复、可重放，
--      且它们的工具掩码在代码侧逐字不变（掩码只收窄，不扩大）。
--
--   2. 新增 `archived_at`：会话**归档**是展示元数据，不是撤权。
--      * 与 `revoked_at` 语义正交：归档不递增 revoked_revision、不发 outbox、
--        不使任何凭证失效；恢复（置回 null）是完全可逆的。
--      * 历史行 `archived_at` 为 null，天然"未归档"，不需要数据回填。
--      * 约束 `(status = 'revoked') = (revoked_at is not null)` 保持不动，
--        新增的归档一致性约束只限制"已撤权的会话不得处于归档态"：
--        撤权是终态，归档只对 creating/active 有意义。
--
-- 索引 `session_bindings_owner_archived_idx` 支撑"按所有者列出未归档会话"
-- （BFF 的 works/:workId/sessions 列表路径）。

-- 1) preset check：四个值。先删后加，历史值逐字保留。
alter table session_bindings drop constraint if exists session_bindings_preset_check;
alter table session_bindings
  add constraint session_bindings_preset_check
  check (preset in ('novel-assistant', 'novel-outline', 'novel-chapter', 'novel-bible'));

-- 2) 归档列：nullable timestamptz；null = 未归档（历史行默认值）。
alter table session_bindings add column if not exists archived_at timestamptz;

-- 归档一致性：撤权后的会话不允许再标归档（撤权是终态；归档只是展示分组）。
alter table session_bindings
  add constraint session_bindings_archived_consistency
  check (not (status = 'revoked' and archived_at is not null));

create index if not exists session_bindings_owner_archived_idx
  on session_bindings (tenant_id, owner_user_id, archived_at, created_at desc);
