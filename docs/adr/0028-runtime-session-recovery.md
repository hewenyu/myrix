# ADR 0028：BFF 会话恢复（open-proof + 有界 resume 入队）

- 状态：已采用（最小完整方案 + 真实 Postgres / 真实 driver 回归）
- 日期：2026-10-01
- 相关：ADR-0016（Runtime 驱动与身份绑定）、ADR-0022（查回执凭证）、ADR-0027（初始订阅回放）、[runtime-driver 契约](../implementation/runtime-driver.md)、[BFF 运行时](../implementation/bff-runtime.md)
- 实现：`apps/bff/src/runtime-recovery.ts`、`apps/bff/src/runtime-router.ts`、`apps/bff/tests/runtime-recovery.test.ts`

## 背景

历史本地验收重启整个 `pnpm dev` 之后，某个 other-tenant 会话的订阅得到 502 `stream_unavailable`（实际会话 ID 仅本地留存），
driver 侧 403；后续 `send` 得到 409 `session_not_open`，并被 BFF **永久 `fail`**（用户消息丢失）。

根因是"控制面绑定状态"与"cell 进程内状态"是两套事实：

| 事实 | 重启后的值 |
|---|---|
| `session_bindings.status` | 仍是 `active`（持久，不受 cell 重启影响） |
| driver `controller.live`（活跃 Agent） | **空** |
| driver `principals`（会话 → 主体绑定表） | **空** |

于是：

* `send` 在 `controller.send` 走到 `requireOwned` → `409 session_not_open`；
* `events` 在 `authorizeSubscribe` 走到 `host.lookupPrincipalBySession` → `403 identity_invalid`；
* 旧 BFF 把两者都归入"driver 明确拒绝（不可重试）" → 一条被 `fail`（丢消息），一条 502。

**BFF 侧此前没有任何 `resume` 入队点**：`commands` 表里 `resume` 这个 op 存在、`sessions:resume` 这个 governance 动作存在、
driver 的 `op='resume'` 路径也被真实测试覆盖，但没有任何生产代码会**生成**一条 resume 命令。

## 决策

### 1. 「已打开」由一个可对账的证明回答，而不是猜测

`open-proof`（`RuntimeSessionRecovery.openProof`）只读两件既有事实：

1. `commands` 中该绑定最近一条**成功**的 `create`/`resume` 回执里的 `receipt.bootId`
   （`DriverCommandReceipt.bootId`，driver 自报的本进程标识）；
2. 当前 `GET /v1/ready` 的 `bootId`。

结论是**三态 + 一故障态**，调用方必须按 `state` 分支，不能只看 `known`：

| `state` | 含义 | 调用方行为 |
|---|---|---|
| `open` | 回执 bootId === 当前 bootId | 正常投递/订阅 |
| `mismatch` | 回执 bootId !== 当前 bootId | **提前**生成 resume（让路 / 503） |
| `unknown` | 没有可用的成功回执（老数据、绑定由测试/运维直接插入） | 不做推断，交给 driver 权威判定 |
| `unavailable` | **读取本身失败**（数据库不可用等） | **fail-closed**：不投递、不订阅、不生成 resume，按暂时不可用退避重试 |

`state:"unavailable"` 是刻意的 fail-closed：把"数据库暂时读不了"伪装成"没有回执"
再继续把请求交给 driver，是一种隐式降级 —— 读取失败时既不能证明会话已打开，也无法
安全地判断"是否需要恢复"。这时唯一正确的动作是明确地暂时不可用并释放重试，
而不是"晚一步再发现"。同理，`requestResume` 的绑定读取失败返回 `unavailable`
（**不是** `denied`）：绝不把一次短暂故障写成"绑定不存在/被拒"这种不可撤销的授权结论。

刻意**不**引入第二权威源、不新增表、不信任磁盘 header 身份、不做隐式 `create`。

### 2. 只在「正向的 boot 不匹配」时提前恢复

`state === "mismatch"` 才在投递/订阅**之前**生成 resume。`state === "unknown"`（没有成功回执：老数据、绑定由测试/运维直接插入）
时不做任何推断 —— 直接把请求交给 driver，由 driver 的 `live`/`principals` 给出权威结论，再走反应式恢复。

这条边界是必要的：把"没有回执"当成"没打开"会把正常会话（以及所有注入 `currentFacts` 的装配）一并拦下，
而且会让 cursor `0` 的既有回放回归失去意义。

`state === "unavailable"`（读取失败）则**既不投递也不恢复**：命令路径 `deferForRecovery` 退避并退还认领预算、
订阅路径答 503 `stream_unavailable`。这与"没有回执"是两种不同的事实，绝不能合并。

### 3. 反应式恢复，严格限定两个机器可读码

driver 明确回答 `session_not_open`（409）或 `identity_invalid`（403）时，才触发恢复：

* `session_not_open`：覆盖 `open-proof` 看不到的窗口（同一 boot 下 Agent 被释放、被别的路径清空 `live`）；
* `identity_invalid`：覆盖同一 boot 下 `principals` 被清空。

**其余 403 一律不可恢复**：`not_owner`、`identity_mismatch`、`rev_stale`、`session_revoked`、`grant/*`。
把任意 403 当成可恢复等于"用一次 resume 去试探授权"。这条在 `isRecoverableDriverCode` 里是显式白名单，并有单测冻结。

### 4. 恢复命令走既有持久队列，不开侧门

恢复命令通过**同一套** `CommandsRepository.enqueue` 入队：

* governance 的 `sessions:resume` 判定 + 当前成员/租户/作品属主/六字段 rev 校验；
* 与 `send` 共用 `commands` 表、FIFO、advisory lock 与投递循环；
* 投递时由 `deliver` 重新读取当前事实（撤权、成员停用、rev 变化一律拒绝），签发真实 ES256 凭证。

绝不"借 CLI 或内部调用绕过 BFF 直接向 driver 发 resume"。`commands.enqueue` 在它自己的事务里重取权威事实，
调用方读到的旧事实不能替代它。

### 5. 幂等键必须含 bootId + rev + sid + attempt（确定性 UUID）

`commands.id` 是 **uuid** 列，不能拼 `resume-<sid>`。派生规则：

```
uuid5(PREFIX, `myrix:runtime:resume:${tid}:${sid}:${rev}:${bootId}:${attempt}`)
```

* 同一 boot / rev / attempt 的并发请求算出**同一个** uuid → `on conflict do nothing` 合并成一行（多副本/多标签页合并）；
* 换 boot 一定算出**不同** uuid —— 绝不跨 boot 复用一枚已被 `accepted` 的旧键
  （复用会让 driver 的幂等回执把新 resume 当成旧的 `duplicate`，恢复永远不发生）；
* `attempt` 由**枚举**得到：先由确定性公式算出本 boot/rev 的全部候选 uuid
  （最多 `maxAttemptsPerBoot` 枚），再用**一条** SQL 在**同一快照**上同时取回它们的
  使用状况与待投递 resume（见下），取第一个空闲的。因此同一 boot 下 Agent 被再次释放时
  仍能拿到第 2、3… 枚新命令。
* 上限 `MAX_RESUME_ATTEMPTS_PER_BOOT`（默认 5），硬上限
  `MAX_RESUME_ATTEMPTS_LIMIT`（100）。撞上限 ⇒ `exhausted`，不再新增；
  `maxAttemptsPerBoot` 非法（非正整数或超过硬上限）在构造期**直接抛错**，绝不静默裁剪。

**为什么查询范围是有界的、且绝不按 created_at 截断**（修复的真实缺陷）：

旧实现用 `order by created_at asc limit 200` 拉"该绑定最近的 resume"，再在内存里挑
第一个空闲 attempt。历史超过 200 条以后，`created_at asc` 的顺序截断会把**当前 boot
刚用掉的 id 截到窗口之外**（更老的随机历史行排在前面先占满 200），于是 attempt 永远
算回 0、反复 enqueue 同一枚已被 driver `accepted` 的 commandId —— 幂等命中让状态停在
`pending`，恢复永远不发生。

现在改成**一条** SQL、**同一个 MVCC 快照**，**既不截掉有关记录，也不把全表拉回内存**：

```sql
select id, status from commands
where binding_id = :sid and op = 'resume'
  and ( id in (本 boot/rev 的全部候选 uuid，最多 maxAttemptsPerBoot 枚)
        or status in ('queued','inflight') )
order by created_at asc, id asc
limit maxAttemptsPerBoot + 1
```

从这**一份**结果里同时判"是否有待投递 resume"与"哪些候选已占用"。历史行（id 是随机
uuid）只会经由 `status in (...)` 分支进入结果，绝不影响当前 boot 的 attempt 枚举；
不同 boot 仍各自从 attempt 0 起算，得到不同 id。

**为什么必须是同一条语句（修复的第二个真实缺陷：撕裂快照）**：
`PlatformStore.withTenant` 用 READ COMMITTED，同一事务里的**每条语句各取一个快照**。
最初的实现把它拆成两条独立 SELECT——先查 `queued|inflight`（`limit 1`），再查候选 id——
于是并发请求里出现：第一条执行时看不到别的事务刚入队的 candidate0，第二条执行时却
已经看到，本请求既没合并到 pending、又把 candidate0 当成"已用过"，错误分配 candidate1。
两个并发订阅因此各生成一条不同 resume（attempt0 / attempt1），本该幂等合并的恢复变成两条。
合并到一条语句后，两条判据在同一快照上求值：要么看见 candidate0（待投递 → 合并），
要么看不见（当时确实没有 → 分配 attempt0，再由 `enqueue` 的 `on conflict do nothing`
与并发写者幂等合并），绝不出现"pending 看不见、used 看见了"的撕裂。

**有界且不漏的证明**（C = 候选行数 ≤ `maxAttemptsPerBoot` = M，结果取前 M+1 行）：
若匹配行 ≤ M+1，则无截断，`used` 完整、pending 若存在必可见；若匹配行 > M+1，则窗口内
至多 C ≤ M 行候选，必**至少有一行非候选**，而查询只匹配"候选 或 `queued|inflight`"，
故那一行必是 pending —— 直接合并，`used` 是否被截断不影响结论。特别地，
**无 pending 时匹配行只有候选行（≤ M < M+1）**，不可能截断，`used` 一定完整。

### 6. 让路（defer）—— 避免"自己持有 inflight 却等排在后面的 resume"

`claimSessionCommand` 只取 `available_at <= now`、按 `created_at` FIFO。原命令的 `created_at` 必定早于刚入队的 resume，
若它保持 available，下一个候选永远是它自己，resume 永远排在后面。

因此认领到命令后若需要恢复，`deferForRecovery` 会：

1. 把该命令放回 `queued`，`available_at = now + 1s`；
2. **退还这次认领的 attempts**（`greatest(attempts-1, 0)`）——"等待恢复"不是投递失败，
   消耗投递预算会在 cell 重启稍慢时把仍值得投递的消息推成 `dead`；恢复循环本身由每-boot 上限限死；
3. 写一条 `command.deferred` 审计。

于是出现一个确定的时间窗口：resume 入队即可领（`available_at = now`），原命令被推到未来 1 秒。
即使 resume 的 `created_at` 更晚，窗口内只有 resume 满足 `available_at <= now`，它先被 FIFO 选中。
条件更新带 `locked_by = workerId AND status = 'inflight'`，租约过期被别的 worker 回收时宁可不更新，也不覆盖别人的状态。

### 7. 订阅：既「绝不先发 subscribe 再吃 403」，也「不把终止态冒充成恢复中」

`events()` 在 `state === "mismatch"` 时并发入队 resume，并按下表给出**诚实**的失败：
一个字节都不发到 driver 的 events 端点。

| 恢复结论 | HTTP | 语义 |
|---|---|---|
| `enqueued` / `pending` | 503 `session_reopening` | 真的在恢复中，客户端可带同一 `Last-Event-ID` 重连 |
| `unavailable` | 503 `stream_unavailable` | 暂时不可用（读取/入队失败），可重试 |
| `denied` | 403 `session_recovery_denied` | **终止态**：明确拒绝，重连无用 |
| `exhausted` | 409 `session_recovery_exhausted` | **终止态**：已达每-boot 上限，重连无用 |

`mismatch` 但 open-proof 读取失败（`state === "unavailable"`）同样答 503
`stream_unavailable`：不订阅、不生成 resume。

两条终止态只回显**固定脱敏文案**，绝不把内部 `reason`（binding 状态、SQL 细节、boot、
attempt 序号等）带过 HTTP 边界；内部原因只进审计与日志。

主动（`open-proof` 不匹配）与反应式（driver `session_not_open` / `identity_invalid`）
两条路径共用同一个映射函数（`recoveryApiFailure`），因此两处的语义完全一致。

前端的 `EventSource` 默认重连 + 指数退避会带着同一个 `Last-Event-ID` 重试；恢复生效后，
第二次订阅会原样转发 cursor（含 `0`）并回放已提交历史 —— ADR-0027 的行为逐字保留。
HTTP 客户端可以据此区分终止态并停止重连；但浏览器 `EventSource` 的错误事件不暴露 HTTP 状态，当前页面尚不能据此显示具体的恢复拒绝原因，不能把服务端分类等同于前端终止提示已完成。

### 8. 网络失败 fail-closed，且不把等待恢复的消息永久标 failed

* open-proof / 恢复使用状况 **读取失败** 或 resume **入队失败**（数据库不可用等）⇒ `unavailable`，用 `deferForRecovery` 退避并退还本次认领的 attempts，绝不 `fail`；不能使用通用 `releaseCommand`，后者达到 `max_attempts` 会标记 `dead`。
* 恢复被拒绝（`denied`）或次数耗尽（`exhausted`）⇒ `deferForRecovery` 保持队列、退还预算并延后 **60 秒**，`last_error` 说明原因。已证明 boot 不匹配时必须立即返回，**不得落穿到 driver POST**；反应式恢复也使用相同退还预算语义。
  **不**判永久失败 —— 等待恢复的消息不该因为恢复故障而丢失；
* 只有 driver 的**明确拒绝**（非上述两个码、正文不合契约、撤权事实）才走原有 `fail` 路径。

## 验证

`apps/bff/tests/runtime-recovery.test.ts`：真实 Postgres（`myrix_bff_acceptance`，非 owner/NOBYPASSRLS 的 `myrix_bff_test`
独立 LOGIN）+ **真实 driver cell**（真实 `SessionController` + 真实路由 + 真实 `EventHub`，跑在真实 `node:http` 上）。
"进程重启"= 新的 cell 实例 + **同一份磁盘会话** + 空的身份表；"同 boot 释放"= 同一个 `bootId` + 空身份表。

覆盖：

1. boot A 创建并提交一轮 → boot B（身份表清空）→ 订阅 503 `session_reopening` 并入队 resume →
   正常投递循环发送 resume（真实 ES256 / 六字段 / boot / jti / bodyhash 全部由 cell 验证，篡改一字节即失败）→
   再次订阅保持 `Last-Event-ID: 0` 并回放已提交的 user/assistant/turn-end，seq 单调不重复；
2. `send` 先让路、恢复后按**原 commandId** 投递且只 POST 一次、磁盘只追加一条 user/message、全程 `command.failed` 为 0、
   attempts 被退还；
3. 不同 boot 得到不同的确定性恢复命令；同 boot 的并发请求合并成一条；
4. 撤权 / 成员停用：恢复被拒绝（deny 审计），不新增 resume；
5. 同 boot 下 Agent 被释放：`identity_invalid` / `session_not_open` 触发第 2 枚恢复命令（attempt 1），最终投递成功；
6. 每-boot 上限：`exhausted` + deny 审计，等待的消息保持 `queued` 而不是 `failed`；
7. 负例：撤权绑定不进入候选；伪造 `identity_mismatch` 的 403 明确失败且**不**生成 resume；
8. 断言"一个字节都没发给 events 端点"，以及 `recovery.enabled=false` 时回到旧语义（不静默成功）；
9. **历史截断回归**：先插入 250 条历史 resume，再让当前 boot 的 attempt 0 已 `succeeded`；
   Agent 再次丢失时必须生成 **attempt 1** 的新命令（不是幂等命中 attempt 0 后假 `pending`），
   且该命令能被真实投递循环 `succeeded`；不同 boot 仍各自产生新 id，同 boot 并发仍合并为一条；
10. **故障注入**：只让 open-proof 的读取（唯一选中 `receipt` 列的查询）失败时，
    命令路径 `deferForRecovery` 退避并退还认领预算且 `last_error` 为 `recovery-unavailable`、**不** POST、**不**生成 resume、
    无 `command.failed`；订阅路径答 503 `stream_unavailable`、零 subscribe、零 resume；
    读恢复后同一路径正常生成并投递 resume。绑定读取失败被归类为 `unavailable`（**不是** `denied`/not-found）；
11. **HTTP 诚实终止态**：`denied` ⇒ 403 `session_recovery_denied`；`exhausted` ⇒ 409
    `session_recovery_exhausted`；两者都零 subscribe、零新增 resume，且 reason 为固定脱敏文案
    （不含内部 `binding-not-found` / `boot` / `attempt` 等文本）；
12. `maxAttemptsPerBoot` 越界（0、负数、小数、超过硬上限、NaN、Infinity）在构造期抛错；
13. **最小预算反例**：`max_attempts=1` 时 open-proof 读取故障仍保持 `queued/attempts=0`，零 POST、零 resume；读取恢复后同一 commandId 成功且仅投递一次。`denied/exhausted` 同样保持预算且零 POST；恢复使用状况查询故障映射固定脱敏 503，不冒充 `unknown/denied`。
14. **受控交错回归（单快照）**：一次订阅的恢复使用状况读取返回后，由另一条独立连接把 candidate0 作为 `queued` 入队。旧两段查询看到不同快照而分配 candidate1；新单语句读取仍选择 candidate0，由入队幂等合并，**绝不**产生 attempt1。独立 INSERT 本身即受控并发写者，不再混入第二个无屏障订阅，避免反例自身产生唯一键竞态；两个真实并发订阅的合并由另一用例覆盖。

另加纯函数单测冻结：确定性 UUID 形状与随 boot/attempt/rev 变化、恢复正文与 `wireBodyOf` 逐字节同形、
可恢复码白名单、命令 id 不是 `resume-<sid>` 形态。

`runtime-replay-zero.test.ts` 的**纯内存无 DB** 夹具显式 `recovery:{enabled:false}`：该用例只验证
cursor/回放的 driver 语义，不测恢复，所有原断言逐字不变。真正测恢复的用例一律保持恢复开启。

## 影响与未决

* **只改 BFF 的会话恢复路径**：driver、governance、platform-store、迁移、RLS、vendor 一律未改；未新增表/列/迁移。
* `recovery.enabled` 默认开启；缺省 `maxAttemptsPerBoot = 5`，硬上限 100，越界抛错。
  关闭时行为与修复前逐字一致（含 502/403 语义），这条也有测试。
* **恢复不是"信任 boot"**：它只是把"是否需要重新打开"变成一个可对账的判断，真正的准入始终在 driver
  （`principals` + 六字段 + 撤权）与 governance（成员/租户/作品/rev）。
* **已知边界（未实现，不掩盖）**：
  1. `attempt` 的枚举只覆盖本 boot/rev 的候选 id，**没有**跨 `resume` 与 `create` 共用计数；
     极端情况下（人工 requeue 历史 resume）可能出现 attempt 空洞，但确定性 id 与每-boot 上限不变。
  2. 恢复命令本身如果被 driver 以 `session_not_found`（磁盘上没有该会话）拒绝，属于**明确失败**，
     当前按原分类 `fail` —— 这不是可恢复情形（磁盘确实没有会话），但也没有额外的告警通道，
     只留 `command.failed` 审计。
  3. `denied` 与 `exhausted` 现在是可区分的 403/409 终止态，但**没有**独立的运维告警通道：
     `exhausted` 只留 deny 审计 + `last_error`，等待的消息会一直保持 `queued` 直到有界恢复的
     boot 变化或人工介入。
  4. 恢复的触发依赖 `GET /v1/ready` 成功；cell 完全不可达时仍是原有的退避/503 语义，不产生 resume。
* 本项目禁止 `chat/completions` 协议：本次改动不涉及任何模型链路，未新增该协议的兼容入口或回退。
