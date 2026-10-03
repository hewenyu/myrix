# platform-store / works-service 实施记录

状态：已实现；2026-09-30 的本地真实 Postgres 验收记录见 §五（**历史本地记录**，不构成当前版本的保证；
当前验证方法与证据边界见 [验证方法](../testing/acceptance.md)）。
相关：[ADR-0011](../adr/0011-postgres-ownership.md)、[ADR-0012](../adr/0012-platform-authorization.md)、
[业务说明](../business.md)、[bff-api.md](bff-api.md)。

## 交付物

| 路径 | 内容 |
| --- | --- |
| `packages/platform-store/src/` | Postgres + Kysely 存储：typed schema、10 个仓储、CAS、命令队列、outbox、审计 |
| `packages/platform-store/src/migrations/` | `0000`–`0011` + `0099`/`0100` 共 14 个 SQL 迁移（`0010` 加统一助手 preset 与 `archived_at`，`0011` 删除已无意义的归档约束） |
| `packages/platform-store/src/index.ts` | **冻结给 BFF 的公开导出** |
| `packages/platform-store/src/testing/index.ts` | 测试专用导出（`createTestAuthorizer` 只在这里） |
| `packages/platform-store/src/bin/migrate.ts` `seed.ts` | 迁移 / 开发种子入口 |
| `packages/platform-store/tests/` | 测试文件：真实 PG 集成、迁移回归、单元与授权接缝（具体用例数随代码演进，以 CI 为准） |
| `apps/works-service/src/` | BFF 直接可用的小说创作用例层（wire 映射 + 错误映射） |
| `apps/works-service/src/bin/smoke.ts` | 端到端冒烟（真实 `myrix_app` 连接） |

## 一、数据库

### 角色

| 角色 | 属性 | 用途 |
| --- | --- | --- |
| `myrix_migrator`（本地）/ 部署期 owner | superuser（本地） | 跑迁移、开发种子、运维查询 |
| `myrix_app` | `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`，非任何业务表 owner | 应用运行期连接 |

`0000_roles.sql` 会校验 `myrix_app` 不存在越权属性，否则迁移直接失败。
`0009_hardening.sql` 补 `LOGIN`；开发密码只在**确认 loopback** 后由种子脚本设置。

### 表

`tenants`、`members`、`works`、`chapters` + `chapter_versions`、`outline_documents` +
`outline_versions`、`bible_entries` + `bible_entry_versions`、`session_bindings`、
`commands`、`outbox_messages`、`audit_events`（+ `myrix_internal.migrations`）。

共同约定：

- 每张业务表的主键前缀是 `tenant_id`，子表外键带 `(tenant_id, parent_id)`，**跨租户引用不可能成立**；
- 全部 `ENABLE + FORCE ROW LEVEL SECURITY`，策略是
  `tenant_id = myrix_current_tenant()`（事务级 `set_config(..., true)`）；
- 没有租户上下文时 `tenant_id = NULL` 恒不成立 → 读 0 行、写入被 `WITH CHECK` 拒绝；
- 版本表与 `audit_events` 只追加（触发器拒 UPDATE/DELETE，且应用角色无 UPDATE 权限）；
- `0009` 起 `works.owner_user_id`、`session_bindings.owner_user_id`、`commands.actor_user_id`
  都有指向 `members (tenant_id, user_id)` 的复合外键。

### 迁移表

`myrix_internal.migrations` 记录文件名 + SHA-256；内容改动会在下次迁移时报错
（"迁移文件一旦发布就不可改写"）。迁移在**会话级** advisory lock
（`pg_advisory_lock(hashtextextended('myrix:migrations', 0))`）下执行，多副本启动安全。

关键约束（收尾修复，见 §六.6）：取锁、全部迁移语句、放锁**必须钉在同一条被租约占住的
连接**上。`migrateToLatest()` 用 `db.connection()` 从池里租一条连接并全程复用
（Kysely 的 `SingleConnectionProvider`），`finally` 里在同一条连接上 `pg_advisory_unlock`，
结束时归还。每迁移一个事务的语义不变（单条迁移失败整体回滚）。

## 二、授权边界（最重要的一节）

存储层把调用分成**两扇互不相通的门**：

### 门 1：成员请求 → `@myrix/governance`

`platform-store` 直接依赖 `@myrix/governance`（`workspace:*`），
`WorksService` 默认用 `createGovernanceAuthorizer(governance)` 绑定真实 `authorizePlatform`。

`src/authz.ts` 的 `toGovernanceInput()` 做**逐字段显式映射**：

```
PlatformRequest{actor{tenantId,userId,membership?}, action, resource{...}, expectedRevision}
   ↓ 显式映射（不做结构化侥幸赋值）
AuthorizePlatformInput{actor{tenantId,userId}, member{tenantId,userId,status,role},
                       action, resource{tenantId,ownerUserId,status,revision,role}, expectedRevision}
```

- 动作名与 governance 完全一致（冒号 + 复数）：`works:read`、`chapters:write`、
  `members:update`、`audit:list` …；`src/authz.ts` 的类型直接别名 governance 的 `PlatformAction`，
  两边不可能漂移；
- `membership` 是 `PlatformActor` 上的**独立字段**，映射成 governance 顶层的 `member`；
  缺失时保持 `undefined`（不补空壳），由治理层按"未知身份"拒绝；
- 默认 authorizer 是 `createDenyAllAuthorizer()`；
- `assertWorkOwned` / `loadMembership` 是**事实读取**，不是策略判定。

### 门 2：系统操作 → `ServiceCapability`

| 能力 | 覆盖的操作 |
| --- | --- |
| `tenant.read` | 读租户、读成员状态（登录态装配） |
| `tenant.manage` | 建租户、加成员、改角色（部署期/运维） |
| `session.activate` | cell 回报 `creating → active` |
| `command.enqueue` / `command.claim` / `command.settle` / `command.read` | 命令队列 |
| `outbox.enqueue` / `outbox.claim` / `outbox.settle` | outbox 投递 |
| `audit.write` | 独立事务写审计 |

只在服务端装配时绑定（`PlatformStoreOptions.serviceCapabilities`），
未授予时 `forbidden`，reason 明确写"浏览器与普通成员请求不可调用"。
**浏览器永远拿不到这些能力**：它们不出现在任何 HTTP 请求体里。

### 列表与管理员边界

- `works.list()`、`sessions.listOwn()`、`sessions.listForWork()`、`listCommands()`、`getCommand()`
  的 SQL 里永远带 owner/actor 过滤；不存在 `scope=tenant` 分支；
- admin 不能读/改他人作品、章节、设定、大纲、会话；
- admin 的唯一跨所有者能力是 `sessions:revoke`（裁决见 ADR-0012），
  它只改 `status` 与 `revoked_revision`，不返回任何会话内容；
- `members:update`（停用/恢复成员）仅 admin，且不能作用于自己或其他 admin；
- `audit:list` 仅 admin 与 auditor。

### 会话状态与 rev

- `sessionStatusForGovernance()`：`creating|active|revoked` 原样返回，**`closed` 返回 `null`**，
  调用方立即拒绝（绝不当成"非 revoked 即放行"）；
- 已有会话的 read/send/resume/cancel/revoke 必须同时提供
  库中 rev（`resource.revision`）与调用方 `expectedRevision`；不一致拒绝；
- 撤权：`status='revoked'` + `revoked_revision + 1` + outbox `session.revoke` + 审计，同事务。

### CAS

章节/大纲/设定共用 `decideVersionedWrite()`（服务端算 hash）：

| 条件 | 结果 |
| --- | --- |
| `expectedVersion == currentVersion` | `append` |
| `currentParentVersion == expectedVersion` 且 `currentContentHash == incomingHash` | `duplicate`（返回已有版本） |
| 其他 | 抛 `version_conflict` |

## 三、冻结给 BFF 的接口

### 装配（服务端）

```ts
import { createPlatformDatabase, createPlatformPool, createGovernanceAuthorizer } from "@myrix/platform-store";
import { WorksService } from "@myrix/works-service";

const service = new WorksService({
  db: createPlatformDatabase(createPlatformPool({ connectionString: MYRIX_APP_URL })),
  serviceCapabilities: ["command.enqueue", "command.read", "tenant.read"], // 按需显式列出
});
```

`WorksService` 内部已经绑定 governance；`toHttpError(error)` 把
`PlatformStoreError` 映射成 `{ status, body: { error, reason } }`，未预期错误一律
`500 { error: "internal", reason: "服务端内部错误" }`（不带 SQL/正文）。

### 调用（BFF 路由）

`Caller` 就是 `PlatformIdentity`（来自服务端会话，**绝不来自请求体**）：

| 方法 | 对应 BFF 路由 |
| --- | --- |
| `listWorks(caller)` / `createWork` / `getWork` / `deleteWork` | `GET/POST /works`、`GET/DELETE /works/:id` |
| `getOutline` / `saveOutline` | `GET/PUT /works/:id/outline` |
| `listChapters` / `createChapter` / `getChapter` / `saveChapter` / `listChapterVersions` | `/works/:id/chapters…` |
| `listBible` / `createBibleEntry` / `saveBibleEntry` | `/works/:id/bible…` |
| `listSessions` / `createSession` / `revokeSession` | `/works/:id/sessions`、`DELETE /sessions/:id` |
| `enqueueSessionCommand` | `POST /sessions/:id/messages`、`/cancel` |
| `getCommand` | `GET /v1/commands/:id`（超时后先查再重发） |

关键 wire 语义（与 `docs/implementation/bff-api.md` 一致）：

- 列表返回 `{ items: T[] }`，时间 ISO8601 UTC，标识是 UUID；
- 冲突**不**在返回值里：`version_conflict` 异常 → BFF 转 `409 { status: "conflict", version }`；
- `NovelSessionView.rev` 必须回传给后续 send/cancel/revoke（只有 status 不足以判定凭证是否过期）；
- `SaveOutcome.status` 只有 `saved | duplicate`。

## 四、开发库与固定 UUID（BFF `dev-login` 用）

迁移（应用角色 `myrix_app` 的密码默认 `myrix_local_app`，仅 loopback）：

```bash
export MYRIX_MIGRATE_DATABASE_URL='postgres://myrix_migrator:myrix_local_migrator@127.0.0.1:55439/myrix'
pnpm --filter @myrix/platform-store migrate
pnpm --filter @myrix/platform-store seed:dev
```

`seed:dev` 幂等写入以下**固定**身份（值固定是为了让 BFF / 前端 / 测试可以直接对拍）：

| login | 租户 | tenantId | userId | role |
| --- | --- | --- | --- | --- |
| `admin` | myrix-dev | `11111111-1111-4111-8111-111111111111` | `a0000000-0000-4000-8000-000000000001` | admin |
| `author` | myrix-dev | `11111111-1111-4111-8111-111111111111` | `a0000000-0000-4000-8000-000000000002` | member |
| `editor` | myrix-dev | `11111111-1111-4111-8111-111111111111` | `a0000000-0000-4000-8000-000000000003` | member |
| `other-tenant` | myrix-other | `22222222-2222-4222-8222-222222222222` | `b0000000-0000-4000-8000-000000000001` | member |

- `author` 与 `editor` 是**同租户的两个独立所有者**：互相看不到对方的作品/章节/设定/会话，
  这是"单一所有者"最直观的负例；
- `admin` 与 `author`/`editor` 同租户：能 `members:update`、`audit:list`、撤销他人会话，
  但**看不到**他们的任何内容；
- `other-tenant` 在另一个租户：任何指向主租户资源的请求都必须 404/403。

BFF 的 `/auth/dev-login` 只能把 `author|editor|other-tenant` 映射到上表，
**不得**接受浏览器传入任意 userId。

## 五、实际执行过的命令与结果

全部在本机 `deploy/compose.dev.yml` 起的独立数据库上执行
（`postgres://myrix_migrator:***@127.0.0.1:55439/myrix`，PostgreSQL 17.11，**未触碰其他数据库**）。

以下命令与语义是 2026-09-30 的本地记录；用例数量随代码演进变化，此处不复述，当前门禁见
[验证方法](../testing/acceptance.md)。

```text
$ MYRIX_MIGRATE_DATABASE_URL='postgres://myrix_migrator:myrix_local_migrator@127.0.0.1:55439/myrix' \
    npx tsx packages/platform-store/src/bin/migrate.ts
applied 0000_roles.sql
applied 0001_tenancy.sql
applied 0002_works.sql
applied 0003_chapters.sql
applied 0004_outline.sql
applied 0005_bible.sql
applied 0006_bindings.sql
applied 0007_commands.sql
applied 0008_outbox_audit.sql
applied 0009_hardening.sql
applied 0099_grants.sql
applied 0100_internal_helpers.sql
migrate: 12 applied, 0 already present

$ MYRIX_MIGRATE_DATABASE_URL=... npx tsx packages/platform-store/src/bin/seed.ts
seed: 4 identities
  admin         tenant=11111111-1111-4111-8111-111111111111 user=a0000000-0000-4000-8000-000000000001 role=admin
  author        tenant=11111111-1111-4111-8111-111111111111 user=a0000000-0000-4000-8000-000000000002 role=member
  editor        tenant=11111111-1111-4111-8111-111111111111 user=a0000000-0000-4000-8000-000000000003 role=member
  other-tenant  tenant=22222222-2222-4222-8222-222222222222 user=b0000000-0000-4000-8000-000000000001 role=member
app role: myrix_app
app url : postgres://myrix_app:myrix_local_app@127.0.0.1:55439/myrix

$ npx vitest run --config packages/platform-store/vitest.config.ts
✓ tests/pg-integration.test.ts
✓ tests/migrate.test.ts
✓ tests/unit.test.ts
✓ tests/authz-seam.test.ts
全部通过（用例数随代码演进，不复述旧数字）

$ MYRIX_MIGRATE_DATABASE_URL=... npx tsx apps/works-service/src/bin/smoke.ts
PASS  创建作品（owner=author）
PASS  作者能看到自己的作品
PASS  同租户编辑看不到作者的作品
PASS  新作品大纲 version=0 且为空
PASS  保存大纲 → saved v1
PASS  回读大纲内容一致
PASS  创建章节 version=0
PASS  保存章节 → saved v1
PASS  同 parent + 同正文重试 → duplicate v1
PASS  冲突映射成 409
PASS  章节版本历史可读
PASS  创建设定条目 version=0
PASS  设定检索命中
PASS  创建会话（creating + rev=1）
PASS  入队 send 命令返回 queued
PASS  rev 不匹配映射成 409
PASS  撤权后 rev+1
PASS  跨租户映射成 404/403 且不泄漏细节
PASS  错误体不含 SQL 片段
PASS  会话列表默认不含已撤权会话

smoke: 全部检查通过（2026-09-30 本地记录）

$ node（以 myrix_app 身份直连核对角色属性）
connected as { current_user: 'myrix_app', current_database: 'myrix' }
tenant rows visible without context: { count: 0 }        ← 无上下文读 0 行
rolsuper/bypass: { rolsuper: false, rolbypassrls: false, rolcanlogin: true }
create table denied: 42501                                ← 非 owner，无建表权限
migrations read denied: 42501                             ← myrix_internal 不可见
```

## 六、测试抓出并修好的真实缺陷

1. **迁移运行器找不到 SQL 文件**：`loadMigrations()` 读的是运行器所在目录（`src/`），
   而 SQL 在 `src/migrations/`，导致首次运行"0 applied"。已修正为
   `join(dirname(...), "migrations")`。
2. **审计 jsonb 数组类型错误**：`obligations: []` 被 pg 驱动转成 Postgres 数组字面量
   `{}`，撞 `audit_obligations_array`（`jsonb_typeof = 'array'`）。改为
   `sql\`${JSON.stringify(...)}::jsonb\``。
3. **每会话 FIFO 没有真正保序**：初版 `claim` 只按 `status='queued'` 排序，
   同一会话已有一条 `inflight` 时仍会取下一条 —— 排序，不是保序。
   已改为"该会话存在 inflight 行就返回 empty"，`claimAny` 用
   `not exists (... status='inflight')` 排除。集成测试 `命令 FIFO + 会话锁` 现在锁住这个行为。
4. **`withSystem` 的类型断言**（`Kysely<PlatformDatabase>` → `Kysely<MigrationDatabase>`）
   触发 TS2352；改走 `unknown`，并去掉 `allowOwnerBypass` 这个"运行期绕过 RLS 开关"——
   跨租户运维只允许通过部署凭据（owner 连接串）完成。
5. **`createTestAuthorizer` 在生产入口**：已移出 `src/authz.ts`，只在
   `@myrix/platform-store/testing` 导出；生产入口只有 `createGovernanceAuthorizer`
   与 `createDenyAllAuthorizer`。
6. **迁移 advisory lock 取在池化连接上，导致串行化失效 + 会话锁泄漏**（收尾代理修复）：
   `migrateToLatest(db)` 原先把 `pg_advisory_lock` / `pg_advisory_unlock` 直接发到池化
   `db` 上，而中间每个迁移事务、迁移表 DDL 都各自 `db.transaction()` / 语句执行，
   **不保证落在同一条物理连接**。后果：
   - `pg_advisory_unlock` 在另一条连接上返回 `false`，真正持锁的那条连接把
     **会话级锁一直留着**（直到连接被池关闭）→ 锁泄漏；
   - 更严重的是，持锁连接若在迁移途中被池回收，锁在迁移进行中消失，
     "多副本同时启动只有一个执行"的保证失效 → 两个副本可能并发跑 DDL。

   修复：整段迁移放进 `db.connection().execute(async (conn) => …)`，从一个显式
   租约连接上取锁，所有语句与每迁移事务都跑在该 `conn` 上，`finally` 用同一 `conn`
   `pg_advisory_unlock`。新增 `tests/migrate.test.ts` 用"每条语句都换一条物理连接"的
   假池把该缺陷变成确定性回归：修复前 4 条连接 / unlock=false，修复后 1 条连接 /
   unlock=true；并在迁移执行中从另一条会话断言 `pg_try_advisory_lock = false`
   （锁真的被持有），结束后立即变为可获取（无泄漏）。

## 七、未完成 / 留给后续

- 会话 SSE 回放与 Cell 通知由[BFF运行时](<bff-runtime.md>)及 driver 承担；本包提供 outbox claim/settle 与撤权事务，不应重复实现传输逻辑。
- 历史[contracts/platform.ts](<../../packages/contracts/src/platform.ts>)的 `MemberRole` 是 `admin | member`；当前存储/治理主线含 `auditor`，见[ADR0033](<../adr/0033-condition-malformed-and-role-partition.md>)。不能仅改旧类型就声称具备审计 UI。
- 转让所有权、多人协作不在首版；`works` 没有 `owner` 之外的授权模型。
