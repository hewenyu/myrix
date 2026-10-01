-- 0100_internal_helpers.sql — 队列/outbox 取件的共享 SQL 视图
--
-- 这些函数体是安全关键：任何"跨租户"可能都来自这里写错。集中一处、只写一次，
-- 由 packages/platform-store/tests/rls.test.ts 在真实 Postgres 上验证。

-- 会话锁：同一 binding 同时只有一个投递者。用事务级 advisory lock，
-- 事务提交/回滚即释放；不需要"会话里有在途行"这个前提。
create or replace function myrix_lock_session(p_binding_id uuid) returns void
language sql
volatile
as $$
  select pg_advisory_xact_lock(hashtextextended('myrix:command-lock:' || p_binding_id::text, 0))
$$;

create or replace function myrix_lock_cell(p_cell_id text) returns void
language sql
volatile
as $$
  select pg_advisory_xact_lock(hashtextextended('myrix:cell-lock:' || p_cell_id, 0))
$$;

-- 非阻塞版本：拿不到就返回 false，调用方跳过这个会话（不排队、不阻塞连接）。
-- 投递循环用它保证"同一会话同时只有一个投递者"，比行锁可靠：会话没有在途行时也成立。
create or replace function myrix_try_lock_session(p_binding_id uuid) returns boolean
language sql
volatile
as $$
  select pg_try_advisory_xact_lock(hashtextextended('myrix:command-lock:' || p_binding_id::text, 0))
$$;

comment on function myrix_lock_session(uuid) is
  '事务级会话锁（每会话 FIFO 的唯一投递者）；键由 binding_id 派生，事务结束自动释放';
comment on function myrix_try_lock_session(uuid) is
  '事务级会话锁的非阻塞版本：false 表示已有投递者在处理该会话';
comment on function myrix_lock_cell(text) is
  '事务级 cell 锁：同一 cell 的 outbox 投递串行化，避免顺序错乱';

grant execute on function
  myrix_lock_session(uuid),
  myrix_try_lock_session(uuid),
  myrix_lock_cell(text)
to myrix_app;
