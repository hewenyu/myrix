-- 0001_honest_settlement.sql — 结算据实：允许真实用量超过预占
--
-- 背景（窄域安全修复）：
--   * 旧实现按 `min(预占, 真实 usage)` 结算，而预占本身又被
--     `maxReservationTokens` 截断；大中文 prompt（约 1 token/汉字，甚至更贵）因此
--     既骗过额度闸门、又在结算时把超额部分白送。
--   * 预占的语义是**防超卖的闸门**，不是本次调用的计费上限。真实 usage 必须
--     **完整**写入 `consumed_tokens`；超出预占的部分在后续 `reserve` 的窗口统计里
--     生效，使该租户/用户/会话随后被 429，直到滚动窗口滑出。
--
-- 因此 `quota_reservations_consumed_within_reservation` 必须移除。同时把
-- `total_tokens` 落库（此前只存 prompt/completion，超额结算无法对账）。
--
-- 注意：RLS / 授权 / 列黑名单不变；这里只改计量一致性约束并新增一个计量列。

-- 1) 去掉"结算不得超过预占"的约束（它正是把超额用量截断的结构性原因）。
alter table myrix_gateway.quota_reservations
  drop constraint if exists quota_reservations_consumed_within_reservation;

-- 2) 记录上游声明的 total_tokens，便于对账"真实用量 > 预占"的行。
alter table myrix_gateway.quota_reservations
  add column if not exists total_tokens integer;

alter table myrix_gateway.quota_reservations
  drop constraint if exists quota_reservations_total_tokens_check;
alter table myrix_gateway.quota_reservations
  add constraint quota_reservations_total_tokens_check
  check (total_tokens is null or total_tokens >= 0);

comment on column myrix_gateway.quota_reservations.total_tokens is
  '上游声明的 total_tokens；consumed_tokens 以 max(total_tokens, prompt+completion) 为准，可大于 reserved_tokens（预占是闸门，不是计费上限）';
