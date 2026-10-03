# BFF 运行时路由、持久投递与事件投影

依据：[runtime-driver.md](runtime-driver.md)（driver 的线契约）、[bff-api.md](bff-api.md)（浏览器契约）、
[business.md](../business.md)（业务对象与授权链）、ADR-0010（ES256 凭证）、
ADR-0019（Cell 活性租约）、ADR-0022（查回执凭证 / 一 Cell 一租户 / 外部错误安全原因）。
原平台/技术草案与首版过程记录已于 2026-10-02 本地归档，见[文档维护、归档与脱密](../documentation-policy.md)。

本文件描述 `apps/bff/src/runtime-*.ts`：真实 `RuntimeRouter`、Postgres 持久队列的投递循环、
driver HTTP 客户端、SSE 白名单投影，以及 CLI 配置工厂与装配例子。

## 0. 交付物与写入边界

| 路径 | 内容 |
|---|---|
| `apps/bff/src/runtime-router.ts` | `RuntimeRouter` 实现 + `RuntimeDispatcher`（claim/lease/FIFO/backoff）+ 撤权 outbox 投递 |
| `apps/bff/src/runtime-driver-client.ts` | driver HTTP 客户端（命令/回执/SSE/revoke/ready）与有界 SSE 帧解析 |
| `apps/bff/src/runtime-stream.ts` | driver SSE 帧 → 公开 `SessionStreamEvent` 的**白名单投影** |
| `apps/bff/src/runtime-cells.ts` | 可注入的静态 `CellDirectory`（每租户地址/cellId/serviceToken） |
| `apps/bff/src/runtime-config.ts` | CLI 配置工厂（环境变量 → 装配输入）+ 部署一致性检查 |
| `apps/bff/src/runtime-compose.ts` | 装配例子（`assembleRuntime`） |
| `apps/bff/src/runtime-log.ts` | 最小日志接缝（结构化、只写标识与原因） |
| `apps/bff/tests/runtime-stream.test.ts` | 纯单元：投影白名单、SSE 解析、客户端失败分类、目录/配置 fail-closed |
| `apps/bff/tests/runtime-router.test.ts` | 真实 Postgres + 明确假 driver：队列、FIFO、退避、撤权、SSE、重启 |

**未改动**：`packages/platform-store/**`、`packages/grant/**`、`packages/governance/**`、`packages/contracts/**`、
`apps/bff/src/{server,ports,novel-store,works-server,auth,config}.ts`、root 配置、`vendor/**`、`plugins/**`。
没有新增迁移、没有新增表、没有改动既有表或 RLS 策略。

## 1. `RuntimeRouter` 的六个方法

接口定义在 [`apps/bff/src/ports.ts`](../../apps/bff/src/ports.ts)。语义与 [bff-api.md](bff-api.md) 的浏览器契约、[business.md](../business.md) 的业务对象与授权链对齐：
**平台 `queued` 只表示 DB 持久入队；cell `accepted` 只表示 inbox + flush；回复只能从事件流观察。**

| 方法 | 行为 | 失败语义 |
|---|---|---|
| `createSession(actor, workId, preset)` | 解析该租户的 cell placement，然后 `SessionsRepository.create`：**绑定 + create 命令同一事务**；`status` 返回 `creating`，`cell_id` 落库 | 无 placement → 503 `cell_unplaced`；preset/作品/成员不合法 → 仓储层 4xx |
| `send(actor, sid, {commandId,text})` | `CommandsRepository.enqueue(op='send')`，正文 `{op,sid,commandId,text}`；成功后唤醒投递循环 | 非 owner → 404；rev 不一致 → 409；同 commandId 换正文 → 409；该命令此前已 failed/dead → 409 `command_failed`；会话已归档 → 409 `session_archived`（不产生命令行） |
| `cancel(actor, sid, commandId)` | 同上，`op='cancel'`、正文 `{op,sid,commandId}`；归档不阻止取消 | 同上 |
| `archive(actor, sid, archived)` | `SessionsRepository.setArchived`：同一事务内做所有者事实 + `authorizeTx` + CAS，只写 `archived_at`，**不**动 status/rev、不写 outbox、不入队 | 非 owner（含管理员/跨租户）→ 404；并发改归档态 → 409；已撤权 → 410 |
| `revoke(actor, sid)` | `SessionsRepository.revoke`：**数据库优先**（status=revoked + rev+1 + 同事务写 `session.revoke` outbox），成功即返回；通知 cell 由 outbox 退避重试 | 非 owner → 404；rev 竞争 → 409 |
| `events(actor, sid, after, signal)` | 先授权再解析 cell/`ready` 取 bootId，签发 `op=subscribe` 凭证，打开 driver 事件流并**白名单投影**；流上持续复核当前态；归档不阻断订阅或必要 resume | 非 owner → 404；已撤权 → 410；cell 未就绪 → 503；driver 拒凭证 → 502 |

`createSession` 不返回 `active`。`creating → active` 只发生在 **create 命令真的拿到 driver 回执之后**
（`SessionsRepository.markActive`，需要 `session.activate` 能力）。因此"网络不通"永远不可能被读成"会话已激活"。

## 2. 持久命令队列与投递循环

### 2.1 命令行

`commands` 表（既有迁移 0007，未改动）保存 `body jsonb`、`body_hash`、`status`、`attempts`、`max_attempts`、
`available_at`、`locked_by`、`lease_expires_at`、`receipt`。

**入队正文与投递正文同形**，因此 `commands.body_hash` 就是"实际发送字节"的摘要：

```ts
enqueueBodyOf({ op:'send', sessionId, commandId, text })  // { op, sid, commandId, text }
wireBodyOf(command)                                       // { op, sid, commandId, text? } —— 键顺序固定
```

投递时 `Buffer.from(JSON.stringify(wireBodyOf(cmd)))` **就是**交给签发方的 `rawBody`，并且**原样**作为 HTTP body 发出。
`wireBodyOf` 是唯一构造 driver 请求体的地方，所以重试时字节稳定、`bh` 稳定、driver 侧 `commandId` 幂等判定稳定。
测试断言了这一点：把序列化键顺序换掉（签一套、发另一套）会让真实 ES256 验签失败。

### 2.2 每会话 FIFO 与唯一投递者

投递循环**不**用批量 `claimAnyCommands` 一次取多条：它的候选查询用 `not exists(inflight)` 表达"每会话串行"，
但批量 UPDATE 发生在该检查之后，同一会话里的两条 queued 会被**一起**认领 —— FIFO 就退化成"排序"。

实际做法（`dispatchOnce`）：

1. `candidateSessions(tenantId, limit)`：按会话聚合，只取**每个会话最早的一条**（`min(available_at)`, `min(created_at)`），
   且该会话当前没有 inflight 行；绑定必须是 `active` 或 `creating`（`creating` 只为它的 create 命令存在）。
2. 对每个候选会话调用仓储自带的 `claimSessionCommand`：它在**一个事务**里
   取 `myrix_try_lock_session(binding_id)` 事务级 advisory lock、回收过期租约、
   检查 inflight、按 `created_at, id` 取最早一条并置为 inflight（`attempts+1`、写 lease）。
3. 拿不到锁（`busy`）或没有可领的命令（`empty`）就跳过该会话，不排队等锁。

于是"前一条没 settle，后一条不会被取走"是**事务内**成立的事实，而不是排序假设。

### 2.3 失败分类（不模拟成功）

| driver 结果 | 处理 |
|---|---|
| 2xx 且回执形态合法 | `settleCommand(succeeded, receipt)`；`create/resume` 之后再 `markActive` |
| 4xx（凭证/契约错误，不可重试） | `settleCommand(failed, receipt)` + 审计事件 `command.failed`（deny） |
| 5xx / 429（可重试） | `releaseCommand`：attempts 已在 claim 时 +1，指数退避 `min(2^attempts·500ms, 5min)` |
| 连接失败/超时（结果未知） | **先用新签的 receipt 凭证 `GET /v1/commands/:id` 查回执**（见 §3.1）：查到就结算；查不到（404）或查询也失败才退避重试 |
| attempts 撞上 `max_attempts` | 仓储层置 `dead` + `last_error`，不再自动重试（人工 `requeueDead`） |

`timeout` 与 `aborted` 在客户端层就分开：`aborted`（调用方取消）不可重试，`timeout` 可重试但必须先查回执；
查回执**绝不能**复用 POST 那枚已被消费的凭证（见 §3.1）。

### 2.4 投递前的当前态复核与一 Cell 一租户

`deliver` 先读当前事实（一条租户事务读 binding / member / work / tenant），然后：

1. 绑定必须存在，且 `owner_user_id === command.actor_user_id`（命令发起人必须是所有者）；
2. `status === 'revoked'` → 永久失败；
3. 通过 `authorizePlatform` 判定：`create` 用 `sessions:create` + **作品**资源；其余用 `OP_ACTION[op]` + 当前
   `status` + 当前 `rev` + `expectedRevision = 当前 rev`；
4. 事实层再收紧：租户必须 active、作品必须 active 且属主与绑定所有者一致、成员记录必须存在；
5. `create` 之外的操作要求绑定已 `active`（否则 release 等待 create 完成）。

**调用方的角色从不参与**：判定只用数据库里的当前 member 行。

**一 Cell 一租户在调用侧也要成立。** cellId 是凭证的 `aud`，也是租户隔离边界，所以：

* `createStaticCellDirectory` 只要 `cellId` 出现第二次就拒绝启动（**地址/凭据相同也拒绝**），
  同一租户的重复条目同样拒绝；`readRuntimeEnvironment` 在解析配置时也拒绝，`inspectRuntimeEnvironment`
  把它列进装配问题清单；
* `CellDirectory.byId(cellId, expectedTenantId)` 的第二个参数是**必填**的请求方租户，实现必须核对；
* 路由侧 `resolveCell`（投递 + 撤权 outbox）与 `requireCell`（建会话）都用 `cellServesTenant(endpoint, tenantId)`
  再核对一次；不匹配一律按"没有放置"处理（`release` 退避 / 503 `cell_unplaced`）。
  目录是可注入的，构造期检查管不住别的实现，所以**取用处必须自查**。

### 2.5 撤权（数据库优先）与 outbox 重试

`revoke` 只做数据库那一步。`session.revoke` outbox 消息由 `dispatchOutboxOnce` 投递：

* `OutboxRepository.claim`（`FOR UPDATE SKIP LOCKED` + 租约回收），只取 `topics: ['session.revoke']`；
* 按 payload 的 `cellId`（缺失时按租户）解析 cell；**byId 取到的 endpoint 必须服务本租户**，
  否则退回按租户解析，都不匹配即判"无法解析"（不误投到别人的 cell）；
* `POST /v1/admin/revoke`，正文 `{sid, rev, reason}`，带该 cell 的 `serviceToken`；
* 成功 → `settle`；失败 → `fail`（指数退避 `min(2^attempts·1000ms, 15min)`，撞 `max_attempts` 变 dead）；
* payload 不合契约（缺 sid/rev）→ 直接 `fail`，不无意义重试。

**撤权结论与投递解耦**：driver 不可达时绑定已经是 `revoked`，outbox 一直重试到成功或 dead。
撤权后该会话的其余排队命令**不投递、也不改写**（见 §6 未决项）。

### 2.6 后台循环的生命周期

* `start()`：幂等；启动后立刻跑第一轮，之后按固定间隔（默认 1s）轮询。
* `wake()`：`send`/`cancel`/`create`/`revoke` 成功后调用，把下一轮提前到 0ms。
  一轮正在跑时只是记下"待唤醒"，由这一轮结束后立刻续跑 ——
  **同一 worker 不会并行跑两轮**（否则同一会话会自我竞争 advisory lock）。
* `stop()`：先停掉排定的定时器，再 **await 在途那一轮**。因此 `stop()` 返回之后不可能还有投递在跑；
  `stop()` 之后 `wake()` 不再启动新的一轮。
* `dispatchOnce()` / `dispatchOutboxOnce()`：单轮，给运维与测试用（不需要启动后台循环）。

上述三条都各有一条测试：单轮语义（FIFO/退避/回执）、`start/stop` 不重复投递、以及"在途一轮结束时 `stop()` 才返回"。

## 3. driver HTTP 客户端

契约与 [runtime-driver.md §3](runtime-driver.md) 逐字一致（driver 侧实现在
`plugins/myrix-runtime-driver/src/{http,router}.ts`）：

| 方法 | 端点 | 说明 |
|---|---|---|
| `ready` | `GET /v1/ready` | 取 `bootId`；`bootId` 是签发凭证的必需 claim，所以"就绪检查"先于签发 |
| `postCommand` | `POST /v1/commands` | `Authorization: Bearer <grant>`；body 是调用方给的 `Buffer`，逐字节发出 |
| `getReceipt` | `GET /v1/commands/:id` | `Authorization: Bearer <receipt grant>`（见 §3.1）；**404 视为"没有回执"**（`{ok:true,value:undefined}`），不是失败 |
| `streamEvents` | `GET /v1/sessions/:sid/events` | SSE；带 `Last-Event-ID`；返回**有界**的帧异步迭代器 |
| `revoke` | `POST /v1/admin/revoke` | service credential；控制面签名信封形态以后可替换 `authorization` 头 |

保护与语义：

* **截止时间**：每个请求合并"调用方 signal + 客户端 deadline"，并区分 `timeout` 与 `aborted`；
* **有界响应**：非流式响应先看 `content-length`，再按字节累计，超限即 `malformed`（不是把内存打满），
  并**取消**（`response.body.cancel()`）而不是只 `releaseLock()` —— 否则上游会继续往没人读的流里写；
* **有界 SSE 帧**：单帧超过 `maxFrameBytes`、被 abort、或调用方提前 `return()` 都抛错/结束迭代并 cancel reader；
* **不转发浏览器头**：只发我们自己构造的头；
* **错误不回显敏感内容**：HTTP 失败只保留机器可读的 `code`（短标识符，否则丢弃）与状态码，
  外部 reason 是**固定分类文案**（`driver 返回 <status>（凭证或权限被拒 / cell 内部错误 / …）`）；
  连接失败的 reason 固定为"无法连接 driver（网络错误或连接被拒）"，不带上游异常 name/message；
  `GET /v1/ready` 的 `reason` 去控制字符并截断。**driver 的 `reason` 原文（可能含 prompt / header /
  工具 schema / token / 内部异常）一律不透传。** 重试分类不变：5xx / 429 可重试，其余 4xx 不可。

`streamEvents` 的 deadline 只覆盖"建立连接 + 收到响应头"，不覆盖整个流生命周期：
会话可以长时间没有输出，生命周期由调用方 signal（浏览器断开/撤权/进程关闭）控制。

### 3.1 查回执的凭证（冻结契约）

查回执是**读**操作、没有业务正文，因此不复用投递凭证：`GET /v1/commands/:id` 每次都用
`issueReceiptGrant` **新签**一枚短凭证。为什么必须如此 —— POST 那枚的 `jti` 已被消费
（复用即重放），且它的 `bh` 绑定的是投递正文，无法验证一次空 GET。

| claim | 值 |
|---|---|
| `op` | `subscribe`（读语义；不新增 grantOp） |
| `cmd` | `receipt-<commandId>`（`receiptCommandId()`，与 driver 侧逐字一致） |
| `bh` | `sha256(空 Buffer)` |
| `aud`/`boot`/`tid`/`sid`/`sub`/`wid`/`preset`/`rev` | 与**当次**投递的 principal / boot 完全相同 |
| `jti` | 每次签发都是新的 |

路径仍是 `GET /v1/commands/:commandId`。driver 侧据此可做真实的
`verifyAndConsume(token, {op:'subscribe', cmd:'receipt-<id>', bh:sha256('')})`。
集成测试里的假 driver GET 就是用真实 ES256 验签强制的：语法 Bearer、复用 POST grant、
错误的 cmd/op/bh/aud/tid/boot 全部被拒；验签器公钥不对时命令保持队列退避（不按"查到回执"结算）。

## 4. SSE 投影（白名单）

依据 driver 的**实际**帧格式（`encodeSseFrame`）：`data:` 是 `StreamEvent.data`（**不是**整个信封），`id:` 才是 `seq`。

允许公开（`runtime-stream.ts`）：

| driver event | 读取路径 | 投影 |
|---|---|---|
| `user/message` | `data.content` 里 `type:'text'` 的块（data **就是** `UserMessage`） | `{type:'user', seq, text}` |
| `assistant/message` | `data.message.content` 里 `type:'text'` 的块 | `{type:'assistant', seq, text}` |
| `myrix/assistant-stream` 的 `chunk` | `chunk.type === 'text-delta'` | `{type:'delta', text}`（**无 seq**） |
| `myrix/assistant-stream` 的 `start` | — | `{type:'status', status:'stream-start'}` |
| `myrix/assistant-stream` 的 `end`（`outcome.kind==='abandoned'`） | — | `{type:'status', status:'stream-abandoned'}` |
| `myrix/assistant-stream` 的 `end`（`outcome.kind==='committed'`） | — | **不投影**（落定正文由持久 `assistant/message` 承载，BFF 不合成 `assistant.final`） |
| `myrix/truncated` | — | `{type:'status', status:'replay-required'}`（**无 seq**） |
| `tool/call` | `data.name` / `data.callId` | `{type:'tool', seq, toolName, commandId}`（**不含 arguments**） |
| `turn/end` | `data.reason.kind` | `{type:'turn-end', seq}`；`error` → 固定文案 error 帧；`aborted`/`interrupted`/`forked` → `status:'interrupted'` |

`myrix/assistant-stream` 的三种 frame 对应 DSH 的 `AssistantStreamFrame`：`start` 让前端清掉上一条未落定的
delta；`chunk` 只投 `text-delta`（`reasoning-delta`/`tool-call-delta`/`block-*`/`usage`/`finish` 全跳过）；
`end` 只有 `abandoned` 才映射 `stream-abandoned`（重试/取消后本轮流被丢弃的明确信号），`committed`
与形态不合契约的 `end`（缺 outcome / 未知 kind）一律不投影。

明确**不投影**：`request/header`、`system/message`、`developer/message`（prompt 与工具 schema）、
`assistant/message.stream` 里的 reasoning、`assistant/attempt`、`compaction/*`、`tool/result`
（工具结果与 `error.reason`）、`myrix/ready`、`myrix/subscribed`、以及解析失败（`parseError`）的帧。
`tool/call` 在真实 DSH 形状里没有 `toolName` 字段 —— 白名单从 `data.name` 取，`arguments` 永不外泄。

因此**公开的 `seq` 可以合法跳跃**：`10, 12, 13, 14` 是正常的（11 是 `request/header`）。
测试里显式断言了这条。

两条硬规则：

1. 持久白名单事件**没有 seq 就丢弃** —— 否则浏览器会把它当瞬态帧，重连后丢消息；
2. `myrix/*` 控制帧一律**不带** `seq`。`myrix/truncated` 的 `data.availableFrom` 是"可用起点"，
   若当成水位回传，客户端会跳过那条事件。

**模型增量不是 durable**：`myrix/assistant-stream` 的 chunk 是瞬态帧，断线不补；
浏览器必须从 `assistant/message` 的持久事件重建文本（`docs/implementation/bff-api.md` 的 UX 要求）。

### 4.1 持续复核与取消

`projectStream` 用"下一帧 vs 复核定时器"竞速，而不是只在收到帧时检查时间：

* 每 `revalidateMs`（默认 5s）复核一次：绑定必须仍是 `active`、`rev` 必须等于调用方持有的 `expectedRevision`、
  租户 active、成员 active、作品 active 且属主一致；
* 不通过 → 发一条**无 seq** 的 `{type:'status', status:'session-ended: <原因>'}` 然后结束流，
  并停止读取上游（取消 driver 订阅）。空闲会话同样会被撤权立刻切断，不必等下一次重连；
* `AbortSignal` 一 abort 立刻停止读取；
* 单帧超限或上游断开 → 结束流（发出 `stream-interrupted`），客户端按 `Last-Event-ID` 续传持久事件。

## 5. 装配

### 5.1 必需的系统能力

`createRuntimeRouter` 在构造期检查 `PlatformStore` 是否授予（缺任何一个直接抛错）：

```
command.enqueue, command.claim, command.settle, command.read,
session.activate, outbox.enqueue, outbox.claim, outbox.settle
```

导出为 `RUNTIME_SERVICE_CAPABILITIES`。生产装配应给投递循环**单独**的 store 实例，
不要与浏览器请求路径共用（浏览器的 store 不需要、也不应该拥有 `command.*`）。

### 5.2 环境变量（CLI 配置工厂）

| 变量（前缀 `MYRIX_RUNTIME_`） | 必填 | 说明 |
|---|---|---|
| `CELLS_JSON` | 是 | `[{tenantId,cellId,baseUrl,serviceToken?}]`，非空；未知字段直接报错；**一 Cell 一租户**：重复 tenantId 或重复 cellId 直接报错（地址相同也一样） |
| `SIGNING_KEY_PEM` | 是 | ES256(P-256) PKCS#8 PEM；读取时就校验，非 P-256 立即失败 |
| `SIGNING_KID` | 是 | 写进 `header.kid`；必须与 cell 侧安装的公钥 kid 一致 |
| `ISSUER` | 否 | 默认 `myrix-control-plane` |
| `TENANT_IDS` | 否 | 逗号分隔；缺省用目录里的全部租户 |
| `WORKER_ID` | 否 | 写进 `locked_by`，便于排查 |
| `LEASE_MS` / `CLAIM_BATCH` / `REVALIDATE_MS` | 否 | 1s..600s / 1..100 / 1s..300s |
| `OUTBOX_ENABLED` | 否 | `"false"` 关闭 outbox 投递循环 |

私钥只用于签发，**绝不进日志或响应**；`CELLS_JSON` 里的 `serviceToken` 只在内存保存，
任何拒绝原因里都不出现它。`inspectRuntimeEnvironment(env, jwksByCell)` 在启动期报出四类部署错误：
cell 没装任何公钥、cell 未装当前 `kid` 的公钥、轮询租户不在目录里、cellId 被多个租户复用。

### 5.3 装配例子

```ts
const env = readRuntimeEnvironment(process.env);
const pool = createPlatformPool({ connectionString: process.env.DATABASE_URL! });
const db = createPlatformDatabase(pool);
const store = new PlatformStore({
  db,
  authorizer: createGovernanceAuthorizer({ authorizePlatform }),
  serviceCapabilities: RUNTIME_SERVICE_CAPABILITIES,   // 只有投递循环这一个 store 需要
});
const runtime = assembleRuntime({ env, store, jwksByCell: JSON.parse(process.env.MYRIX_RUNTIME_JWKS_JSON!) });
runtime.dispatcher.start();
const server = await createBffServer({ auth, repository, runtime });
process.on("SIGTERM", () => { void runtime.dispatcher.stop().then(() => server.close()); });
```

`RuntimeRuntime` = `RuntimeRouter` + `{ dispatcher, workerId }`；
`dispatcher` 有 `start()` / `stop()` / `dispatchOnce()` / `dispatchOutboxOnce()` / `wake()` / `running`，
单轮方法让运维与测试可以确定性地推进循环。

## 6. 可注入接缝与测试

可注入：`store`、`signer`（`GrantSigner`）、`directory`（`CellDirectory`；静态实现每租户一个地址/cellId/serviceToken，
且 `byId` 必填请求方租户、路由侧再核对一次）、
`driver.fetch`（`driverOptions.fetchImpl` 或整个 `driver`）、`clock`、`workerId`、`leaseMs`、`claimBatch`、
`revalidateMs`、`tenantIds`、`projection.maxTextChars`、`logger`。

测试策略：

* **真实 Postgres**（`BFF_TEST_DATABASE_URL`，非 owner、NOBYPASSRLS 的 `myrix_bff_test`）跑队列/绑定/outbox；
  每个用例一套**独立随机租户 fixture**，只追加数据，不 reset、不删表、不删库。
* **明确假 HTTP driver**（`FakeDriver`）：默认一切都拒绝，每个用例必须显式声明允许什么；
  它按真实 HTTP 语义回应（状态码、SSE 帧、超时挂起、拒凭证），因此"不模拟成功"被真的验证。
  **它的 `GET /v1/commands/:id` 用真实 `verifyAndConsume` 验签**：强制 BFF 按 §3.1 的冻结契约
  签发 receipt 凭证，语法 Bearer / 复用 POST grant / 错误绑定都过不去。
* **真实 ES256 验签**：用 `generateTestKeyPair` 生成密钥，对**实际发出的 body** 验签并断言 `bh`；
  篡改一个字节后同一枚凭证必须被拒。
* **一 Cell 一租户负例**：手写一个"无视 expectedTenantId、返回别人 endpoint"的可注入目录，
  断言投递退避、不发 POST、`createSession` 503。
* **客户端边界负例**：响应体超限/声明超限必须 cancel 上游；连接异常与 driver `reason` 原文不外泄。
* 变异验证（手工跑过）：把可重试失败当成功、把 revoked 绑定加入候选、把撤权检查去掉、
  把签名字节与发送字节改成不同顺序、把复核定时器去掉 —— 都会被测试抓住。

运行命令（与 `postgres.integration.test.ts` 一致，同一个验收库）：

```sh
BFF_TEST_DATABASE_URL='postgres://myrix_bff_test:myrix_local_bff_test@127.0.0.1:55439/myrix_bff_acceptance' \
BFF_TEST_MIGRATION_DATABASE_URL='postgres://myrix_migrator:myrix_local_migrator@127.0.0.1:55439/myrix_bff_acceptance' \
pnpm exec vitest run apps/bff/tests/runtime-router.test.ts apps/bff/tests/runtime-stream.test.ts
```

## 7. 尚未覆盖 / 未决

| 项 | 状态 |
|---|---|
| 撤权时队列里未投递的命令 | **留在 `commands` 表**（不投递、不写 failed）：撤权事实已由 binding + outbox 表达。是否改为"同事务结算成 failed 便于运维视图"待后续产品/运维设计决定 |
| 动态 CellDirectory（读 CRD / 控制面放置表） | 未实现；接口已留好（`byId(cellId, expectedTenantId)` 必填租户），静态实现是首版装配 |
| driver 侧 receipt 凭证的真实签名消费 | 已按 `{op:'subscribe', cmd:'receipt-<id>', bh:sha256('')}` 消费签名并核对活性与 `sid`；未知回执、重放与不同 sid 负例见[回执测试](<../../plugins/myrix-runtime-driver/tests/controller.test.ts>) |
| `GET /v1/commands/:id` 的跨重启回执 | 回执表仍是进程内有界；404 只表示"本进程没有回执"，调用方按权威会话日志对账 |
| `bootId` 缓存 | 每次投递都先 `GET /v1/ready`（正确但多一次往返）；`phase=Ready` 的缓存与失效策略待 Cell 管理器落地后再说 |
| 控制面签名信封形式的 admin revoke | 客户端目前只发 service credential；driver 侧已支持签名信封，装配时可替换 |
| 事件流的"按 seq 去重/断点续传"在 BFF 侧 | 由浏览器按 `Last-Event-ID` 触发、driver 侧补发；BFF 只做投影（`after` 透传为 `Last-Event-ID`） |
| 真实 driver 进程的端到端（P1/P2） | 由独立 smoke / 验收脚本覆盖；本模块用明确假 driver 验证协议与失败语义，执行边界见[验收指南](<../testing/acceptance.md>) |
| 多副本投递循环的吞吐/公平性 | 靠 `SKIP LOCKED` + 会话 advisory lock 保证不重复；未做压测 |
