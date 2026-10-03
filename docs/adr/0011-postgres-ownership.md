# ADR-0011：Postgres 业务存储的所有权、RLS 与判定边界

- 状态：已接受（首版）
- 日期：2026-09-30
- 相关：ADR-0001（分层治理）、ADR-0012（平台授权纯函数）、ADR-0013（BFF 认证）、
  [业务说明](../business.md)（写入语义与单一所有者）、[平台存储实现](../implementation/platform-store.md)。
  原平台/技术草案与首版过程记录已于 2026-10-02 本地归档，见[文档维护、归档与脱密](../documentation-policy.md)。

## 背景

首版的小说业务数据（作品、章节、设定、大纲、会话绑定、命令、outbox、审计）要落到 Postgres。
这些数据里既有"用户创作内容"，也有"平台治理事实"，必须在数据库层就把两件事钉死：

1. **租户隔离**不能只靠应用拼 `where tenant_id = ?`。一次漏拼就是跨租户泄漏，
   而应用代码永远会有下一个作者忘记。
2. **单一所有者**（D11）不能只靠路由里的 `if`。章节正文、设定、会话都在同一租户内，
   RLS 拦不住"同租户的 admin 读别人的小说"。

同时，授权判定必须只有一处实现：`packages/governance` 的纯函数（ADR-0012）。
存储层的职责是"读事实 → 交给判定 → 执行读写"，**不能**内联任何 allow 逻辑。

## 决策

### 1. 连接角色分工：owner 与应用角色严格分开

| 角色 | 用途 | 属性 |
| --- | --- | --- |
| 迁移/owner（部署时创建；本地开发 `myrix_migrator`） | 建表、建策略、跑迁移、部署期装配 | 库 owner；本地是 superuser，**只用于迁移与运维** |
| `myrix_app` | 应用运行期连接 | `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`，**不是任何业务表的 owner** |

`0000_roles.sql` 里有一个 `do $$` 块：如果 `myrix_app` 已存在但 `rolsuper/rolbypassrls/
rolcreatedb/rolcreaterole` 任一为真，**迁移直接报错**。宁可在部署期失败，也不要带着
可绕过 RLS 的角色上线。`0009_hardening.sql` 只补 `LOGIN`，密码由开发种子脚本对
**loopback** 库设置（见 `src/bin/seed.ts` 的 `assertLoopback`），绝不写进迁移或版本库。

### 2. 每张业务表都 `ENABLE + FORCE ROW LEVEL SECURITY`

策略统一是：

```sql
using (tenant_id = myrix_current_tenant())
with check (tenant_id = myrix_current_tenant())
```

- `myrix_current_tenant()` 读的是事务级 `set_config('myrix.tenant_id', $1, true)`；
- 没有上下文时函数返回 `NULL`，`tenant_id = NULL` 恒不成立 → **读回 0 行、写入被拒**（fail-closed）；
- `FORCE` 让 owner 也必须遵守策略，因此"应用误用 owner 连接"不会静默跳过隔离；
- 上下文是**事务级**的（`is_local = true`），连接池复用不会串租户
  （集成测试 `租户上下文在事务结束后清空` 断言了这一点）。

### 3. 所有者必须是同租户成员（SQL 约束，不只靠应用）

`0009_hardening.sql` 给三处加了复合外键，指向 `members (tenant_id, user_id)`：

```sql
alter table works            add constraint works_owner_member_fk
  foreign key (tenant_id, owner_user_id) references members (tenant_id, user_id);
alter table session_bindings add constraint session_bindings_owner_member_fk
  foreign key (tenant_id, owner_user_id) references members (tenant_id, user_id);
alter table commands         add constraint commands_actor_member_fk
  foreign key (tenant_id, actor_user_id) references members (tenant_id, user_id);
```

于是"某租户的作品属于另一个租户的人"在**约束层**不可能成立 —— 即使应用代码写错、
即使有人拿到 owner 连接直接 INSERT。章节/大纲/设定通过 `(tenant_id, work_id) → works`
继承同一保证。

### 4. 判定只有两扇门：成员请求走 governance，系统操作走显式能力

存储层把调用分成两类，**绝不混用**：

**(a) 成员请求** → `store.authorize(PlatformRequest)` → `@myrix/governance` 的
`authorizePlatform`（冒号 + 复数动作：`works:read`、`members:update`、`audit:list` …）。
入参映射是逐字段显式的（`src/authz.ts` 的 `toGovernanceInput`）：

- `actor` + **独立的 `member` 字段**（`tenantId/userId/status/role`）—— governance 没有
  `actor.membership` 这种嵌套结构，靠"结构化类型侥幸赋值"是不允许的；
- `resource.{tenantId, ownerUserId, status, revision, role}` 与 `expectedRevision`。

成员记录 `undefined` 时**不补空壳**，让 governance 按"未知身份"拒绝。
默认 authorizer 是 `createDenyAllAuthorizer()`（全拒）。

**(b) 系统操作** → `store.requireService(capability, operation)`。
命令队列的 claim/settle/release/requeue、outbox 的入队/投递/结算、
独立审计写入、租户装配（建租户/加成员/改角色）、cell 回报激活，这些在 governance
的动作表里**没有对应项**，因此不可能被映射成"成员 allow"。它们的能力清单
（`SERVICE_CAPABILITIES`）只在服务端装配 `PlatformStore` 时绑定：

```ts
new PlatformStore({ db, authorizer, serviceCapabilities: ["command.claim", "outbox.settle"] })
```

未授予时抛 `forbidden`，reason 明确写"该操作是内部可信调用路径，浏览器与普通成员请求不可调用"。

### 5. 列表永远 owner 过滤，管理员的例外只有三个

| 动作 | member | admin | auditor |
| --- | --- | --- | --- |
| `works:list` / `sessions:list` | 仅本人的行（查询强制 `owner_user_id = actor`） | 同左，**看不到别人的** | 无 |
| `works:read|update|delete`、`chapters:*`、`bible:*`、`outline:*` | 仅所有者 | 仅自己的 | 无 |
| `sessions:read|send|resume|cancel|subscribe` | 仅所有者 | 仅自己的 | 无 |
| `sessions:revoke` | 自己的会话 | **任意同租户会话**（不读内容） | 无 |
| `members:list` | 同租户目录 | 同左 | 无 |
| `members:update` | 拒绝 | 同租户非 admin 且非本人 | 拒绝 |
| `audit:list` | 拒绝 | 允许 | 允许 |

仓储层从不提供 `scope=tenant` 这类分支；`works.list()`、`sessions.listOwn()`、
`listForWork()` 的 SQL 里永远带 `owner_user_id = actorUserId`。
`getCommand` / `listCommands` 在系统能力之外还强制 `actor_user_id = 调用者`。

### 6. 会话判定必须同时给 status 与 rev

`session_bindings.status` 有四个值 `creating/active/revoked/closed`，
但 governance（ADR-0012）只认 `creating/active/revoked`。存储层用
`sessionStatusForGovernance()` 做规范化：**`closed` 返回 `null` → 直接拒绝**，
绝不当成"非 revoked 所以放行"。已有会话的 read/send/resume/cancel/revoke 都必须
同时提供库中的 `revoked_revision`（作为 `resource.revision`）与调用方的
`expectedRevision`；不一致即拒绝（"撤权版本不匹配，疑似凭据过期或已撤权"）。
撤权时 `revoked_revision` 单调 +1，并写 `session.revoke` outbox 通知 cell。

### 7. CAS：服务端算 hash，duplicate 需要 parent + 同正文

章节/大纲/设定共用 `decideVersionedWrite()`：

| 条件 | 结果 |
| --- | --- |
| `expectedVersion == currentVersion` | `append`：写新版本 |
| `currentParentVersion == expectedVersion` **且** `currentContentHash == 服务端算出的 incomingHash` | `duplicate`：返回已有版本，不写新行 |
| 其他 | `conflict` → 抛 `version_conflict`（**不让调用方忽略**） |

客户端从不提交哈希供采信；`save` 一律用 `sha256Hex(text)` / `hashJson(document)` 现算。
章节头行用 `select ... for update` 锁住后再判定，避免并发写产生两个同号版本。
冲突的 `details` 带 `currentVersion` 与当前正文/文档，供 BFF 转成
`409 { status: "conflict", version }`（前端保留未保存草稿）。

### 8. 命令队列：同事务入队、每会话 FIFO、超时不丢

- 绑定与 `create` 命令**同一个事务**（`sessions.create` 内部调用
  `enqueueCommandInTx`），不会出现"有绑定没命令"；
- 幂等键 `(tenant_id, commandId)`：只有 **actor、binding、op、服务端正文 hash 全部一致**才返回已有行；不同返回 `duplicate_request`（409），不改写原命令。`ON CONFLICT DO NOTHING` 后重读的并发分支执行同样的完整校验。
  独立验收曾复现同用户、同正文、不同会话/操作被误当成成功重试；现已修复，真实非 owner LOGIN 的 `command-idempotency.test.ts` 修复前 2 项失败、修复后 6 项通过；
- 每会话 FIFO 是**保序**而不是排序：`claim` 先看该会话有没有 `inflight` 行，
  有就返回 `empty`；`claimAny` 用 `not exists (... status = 'inflight')` 排除。
  （这是集成测试抓出的真实缺陷：初版只按 `status='queued'` 排序，同一会话能同时
  有多条在途命令。）
- 同一会话同一时刻只有一个投递者：`myrix_try_lock_session()`（事务级 advisory lock）；
- 投递失败只 `release`（`attempts+1` + 指数退避 + 回 `queued`），行永远在表里，
  直到 settle 或 attempts 耗尽进入 `dead`（需人工 requeue）。

### 9. outbox 与审计

- 凡是"数据库提交了、外部也必须最终知道"的动作（撤权通知等）都在业务事务里写
  outbox 行，`(tenant_id, dedupe_key)` 唯一；投递失败不丢消息，过期租约自动回收。
- `audit_events` 只追加：触发器 `myrix_reject_mutation()` 直接报错，且应用角色只有
  `SELECT/INSERT`；另有 `(tenant_id, occurred_at, seq)` 索引供读取。
- 审计里**不写创作正文**：`sanitizeDetail()` 丢弃 `text/body/content/document/prompt/
  completion` 等键并截断长字符串；集成测试断言章节正文不出现在审计序列化结果里。
- 审计 actor 可为 `NULL`（投递循环/重投递这类系统事件没有人类发起人）。

### 10. HTTP 边界不泄漏内部错误

`PlatformStoreError.toResponseBody()` 只返回 `{ error, reason }`，`reason` 必须是
调用方写好的可读中文原因。`PlatformStore.toStoreError()` 与 `errors.internal()`
把未知/数据库错误折叠成固定 reason（原始 message 只进 `cause`，供服务端日志）。
`apps/works-service` 的 `toHttpError()` 对未预期错误返回
`500 { error: "internal", reason: "服务端内部错误" }`，不带任何原始 message。

## 为什么不用其他方案

| 方案 | 拒绝理由 |
| --- | --- |
| 只在应用层拼 `where tenant_id` | 一次漏拼就是跨租户泄漏；测试无法穷举所有查询 |
| 用 `SET SESSION` 而非事务级 `set_config` | 连接池复用会把 A 租户上下文带给 B 租户 |
| 给 `myrix_app` 加 `BYPASSRLS` "图方便" | 等于关掉 RLS；0000 迁移直接拒绝这种角色 |
| 把 owner 校验只写在应用里 | 应用写错/绕过时数据库没有任何兜底；复合外键是零成本的第二道锁 |
| 把 `command.claim` 也塞进 governance 动作表 | 投递循环不是"某个成员的能力"；映射成成员 allow 会让浏览器有机会调用 |
| 用 `closed` 表示"已结束"并当作可用状态 | governance 不认识它；把未知状态当放行是 fail-open |

## 后果

- 正面：跨租户与越权在数据库层就被拦住；判定只有 governance 一处；系统操作与成员请求
  在类型上分开（`Authorizer` vs `ServiceCapability`）；CAS 与队列行为有真实 PG 测试。
- 负面：需要维护两个数据库角色与一份迁移角色连接串；新增动作/能力要同时改
  governance（或 `SERVICE_CAPABILITIES`）、仓储与测试；`closed` 需要额外的规范化分支。
- 边界：本 ADR 不覆盖 cell 的运行期隔离、ES256 凭证格式（ADR-0010）、
  BFF 的认证与 CSRF（ADR-0013）、模型网关的配额归因。

## 验证

- `packages/platform-store/tests/`：

- `unit.test.ts`：CAS 三态、哈希形状、审计 detail 白名单、错误序列化、系统能力默认拒绝；
- `authz-seam.test.ts`：接缝映射（冒号动作、独立 member 字段、跨租户、rev 校验、`closed` 拒绝）、
  admin/auditor 边界；
- `migrate.test.ts`：迁移运行器的会话锁约束 —— 假池让每条语句都换物理连接，
  断言取锁/全部迁移语句/放锁在同一条连接上（`pg_advisory_unlock` 返回 `true`），
  失败路径也在 `finally` 放锁且不泄漏，迁移进行中另一条会话 `pg_try_advisory_lock = false`；
- `pg-integration.test.ts`：真实 Postgres + `myrix_app`（NOBYPASSRLS 非 owner）——
  角色属性、FORCE RLS、无上下文读 0 行、跨租户读写、所有者复合外键、admin 读不到
  他人内容、租户/成员停用、CAS 三态、绑定+命令同事务、rev 校验、撤权 outbox 幂等、
  FIFO 保序、SKIP LOCKED 并发、系统能力缺失拒绝、审计只追加与不泄漏正文。

未决：

- `closed` 目前是"只能由运维写入并一律拒绝"的状态。是否要在 SQL check 里删掉它，
  等会话生命周期（ADR 待写）定稿后再决定。
- 审计的哈希链与防篡改留到后续版本；当前只承诺"只追加 + 触发器拒绝改写"。
