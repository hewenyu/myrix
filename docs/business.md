# 业务说明

本文描述 Myrix 小说创作业务的**当前主线**：作品/章节/大纲/设定、会话绑定、六个模型工具、
写入的版本（revision）与命令（command）语义、以及授权身份与限制。
所有结论都标注了可核对的源码位置；**本文不是测试报告**，运行验证边界见
[项目复盘（2026-10）](<reviews/project-review-2026-10.md>)。

- 接口契约：[implementation/bff-api.md](<implementation/bff-api.md>)
- 运行时与工具边界：[ADR 0017](<adr/0017-novel-tools-boundary.md>)、[ADR 0026](<adr/0026-novel-write-output.md>)
- 存储与 RLS：[implementation/platform-store.md](<implementation/platform-store.md>)

---

## 1. 角色与身份

| 概念 | 含义 | 来源 |
| --- | --- | --- |
| 租户 tenant | 数据与 Cell 的隔离边界 | `tenants` 表；RLS 的 `tenant_id` |
| 成员 member | 租户内的用户，角色为 `admin / member / auditor` | `members` 表；[domain.ts](<../packages/platform-store/src/domain.ts#L12-L15>) |
| 作品所有者 owner | 作品的唯一所有者，读/写/删都只认它 | `works.owner_user_id`；[works.ts](<../packages/platform-store/src/repositories/works.ts#L9-L10>) |
| 主体 principal | Cell 内 Agent 与控制面主体的可信绑定（`sid/tid/sub/wid/preset/rev`） | `@myrix/principals` + 绑定快照 |
| Cell 凭据 | 部署生成的单租户 + 单 Cell 服务令牌，工具/模型调用用它归因 | [works-server.ts](<../apps/bff/src/works-server.ts#L14-L31>) |

关键限制：

- **内容只有所有者可读写**。`admin` 不是内容管理员：作品列表永远按 `owner_user_id` 过滤，
  没有"租户可见"分支；见 [works.ts](<../packages/platform-store/src/repositories/works.ts#L109-L125>)。
- 生产认证是 OIDC Authorization Code + PKCE；身份来自预置的 `(issuer, subject) → (tenantId, userId)`，
  未知 subject 不自动注册、不按 email 合并账号；见 [ADR 0013](<adr/0013-bff-authentication.md>)。
- 浏览器提交的任何 `tenantId / userId / owner / rev` 都被忽略，actor 一律由服务端会话确定。

---

## 2. 业务对象

数据库行类型定义在 [schema.ts](<../packages/platform-store/src/schema.ts>)，领域枚举在
[domain.ts](<../packages/platform-store/src/domain.ts>)。

### 2.1 作品（Work）

| 字段 | 说明 |
| --- | --- |
| `tenant_id` / `id` | 复合主键，RLS 前缀 |
| `owner_user_id` | 唯一所有者 |
| `title` / `description` | 标题与简介 |
| `status` | `active / archived / deleted`（wire 只暴露 `active / archived`，`deleted` 读不到） |
| `version` | 作品级版本号 |

- 软删除：`status = deleted`，读接口按 `not_found` 处理；删除作品前必须先撤销关联会话
  （[bff-api.md](<implementation/bff-api.md>)）。

### 2.2 章节（Chapter）与章节版本（ChapterVersion）

- `chapters`：`work_id`、`title`、`current_version`、`parent_version`、`content_hash`、`status`。
- `chapter_versions`：只追加；每次成功写入产生一行，含 `version`、`parent_version`、`text`、
  `content_hash`、`author_user_id`、可选 `client_key`。
- 章节从"存在但未写入"开始，`current_version = 0`、正文为空；成功后 `0 → 1 → 2 …`。
- 历史版本可读：`GET /works/:workId/chapters/:chapterId/versions`
  （[bff-api.md](<implementation/bff-api.md>)）。

### 2.3 大纲（Outline）

- `outline_documents`：每个作品一行，`current_version` / `parent_version` / `content_hash` / `updated_by`。
- `outline_versions`：只追加，`document` 是 jsonb。
- **当前 wire 是纯文本**：浏览器的读写走 `synopsis`，`chapters` 保持为空；
  见 [`PostgresNovelRepository`](<../apps/bff/src/novel-store.ts#L61-L70>)。
- 模型工具 `get_outline / update_outline` 与浏览器共用同一仓储语义
  （[works-server.ts](<../apps/bff/src/works-server.ts#L70-L77>)）。

### 2.4 设定（Bible entry）与设定版本

- `bible_entries`：`work_id`、`kind`、`name`、`summary`、`attributes`、`current_version`、`status`。
- `bible_entry_versions`：只追加，保存完整条目快照。
- 存储层 `kind`：`character / location / faction / timeline / item / concept`
  （[domain.ts](<../packages/platform-store/src/domain.ts#L47>)）。
- 对外 wire 收敛为三类：`character / setting / timeline`；`location / faction / item / concept`
  读回时归为 `setting`（[novel-store.ts](<../apps/bff/src/novel-store.ts#L27>)）。
- 生产路径的映射是**直接字段映射**：新建时 `title → name`、`text → summary`；
  更新时 `name` 保持不变、`text` 覆盖 `summary`
  （[novel-store.ts](<../apps/bff/src/novel-store.ts#L116-L126>)）。
- `name` 在作品内唯一（SQL 侧有 `lower(name)` 唯一约束），更新接口不改名。
- **不要参考 `apps/works-service` 的"正文首行是名称"映射**：那是未接入主线的并行实现，
  语义与生产路径不同，见 [项目复盘：重复作品实现](<reviews/project-review-2026-10.md>)。

### 2.5 关系

```text
tenant
 └─ work (owner_user_id)
     ├─ chapter ──< chapter_version（只追加）
     ├─ outline_document ──< outline_version（只追加）
     ├─ bible_entry ──< bible_entry_version（只追加）
     └─ session_binding ──< command（会话命令）
                          └─ outbox_message（跨进程通知）
```

所有子对象的写路径都必须验证"属于同一作品且属于当前 owner"，不能只校验同一用户。

---

## 3. 写入语义：revision（版本）

### 3.1 客户端契约

写接口统一带 `expectedVersion`（刚读取到的版本），保存返回 `{ status, version }`：

- `saved`：写入新版本。
- `duplicate`：同一次写入的重试，返回已有版本，不产生新版本。
- 冲突：HTTP 409 `{ status: "conflict", version }`，客户端必须保留草稿并重新读取，**不得强制覆盖**。

### 3.2 服务端判定

章节、大纲、设定共用同一个纯函数判定，规则见
[`decideVersionedWrite`](<../packages/platform-store/src/cas.ts#L43-L90>)：

| 条件 | 结果 |
| --- | --- |
| `expectedVersion == currentVersion` | `append`：写新版本 `currentVersion + 1` |
| `currentVersion.parentVersion == expectedVersion` 且 `contentHash == incomingHash` | `duplicate`：同一次写入的重试 |
| 其他 | `conflict`：必须重新读取 |

- 哈希由**服务端**计算（sha256 hex），不信任客户端声明的哈希。
- 并发由数据库行锁 + `WHERE current_version = ?` 兜底；指针与版本不一致时宁可回滚。
- 章节还支持可选的 `client_key` 幂等键：同键同内容返回已有版本，同键不同内容直接冲突。

> 注意：这里的 `revision` 是**内容版本**（章节/大纲/设定的 `version`），
> 与会话绑定上的撤权版本 `revoked_revision` 是两套独立编号，不能混用。

---

## 4. 会话绑定与预设

### 4.1 绑定（session_binding）

| 字段 | 说明 |
| --- | --- |
| `id` | 会话 id（UUID），工具/模型调用都归因到它 |
| `owner_user_id` | 单一所有者 |
| `work_id` | 绑定的作品；工具不接受 workId 参数，由服务端从这里取 |
| `preset` | `novel-outline / novel-chapter / novel-bible` |
| `cell_id` | 当前放置的 Cell；工具调用必须与该 Cell 凭据一致 |
| `status` | `creating / active / revoked / closed` |
| `revoked_revision` | 撤权版本 `rev`；创建时为 1，撤权时 +1 |
| `policy_revision` | 策略版本标记 |

生命周期：

1. `create`：同一事务写绑定（`creating`）+ 入队 `create` 命令；判定对象是**作品**
   （`sessions:create`），要求调用者是 owner；见
   [`SessionsRepository.create`](<../packages/platform-store/src/repositories/bindings.ts#L56-L130>)。
2. 投递成功后绑定激活为 `active`，并记录 `cell_id`。
3. `revoke`：`status=revoked` + `revoked_revision+1` + 同事务写 outbox 通知 Cell + 审计；
   撤权后的命令与发送一律拒绝；见
   [`revoke`](<../packages/platform-store/src/repositories/bindings.ts#L268-L356>)。
4. `closed` 是存储层历史状态；对外与治理判定都按"不可用"处理，绝不当作"非 revoked 即放行"
   （[domain.ts](<../packages/platform-store/src/domain.ts#L30-L40>)）。

### 4.2 绑定快照与活性租约

- Cell 通过 `GET /internal/v1/cells/:cellId/bindings` 拉取本 Cell 的绑定快照，
  字段为 `{sid, tid, sub, wid, preset, rev}`，不含正文与凭据；
  见 [createBindingSnapshotReader](<../apps/bff/src/works-server.ts#L129-L161>)。
- 快照只包含：当前 Cell 的 `creating/active` 绑定、active 租户、active 成员、
  未删除且同 owner 的作品。
- Cell 把它当作**有限时长的活性租约**：默认 TTL 10s、刷新 3s、上限 30s，
  任何失败立即清空（[binding-lease](<../plugins/myrix-binding-lease/src/index.ts#L24-L35>)）。
- 租约只是"降低窗口"，**不能替代**每次操作回到数据库核对当前绑定、成员、租户与版本。

---

## 5. 三个助手与六个工具

| preset | 助手定位 | 可见工具 |
| --- | --- | --- |
| `novel-outline` | 大纲 | `get_outline`、`update_outline`、`search_bible` |
| `novel-chapter` | 章节正文 | `get_outline`、`get_chapter`、`save_chapter_draft`、`search_bible` |
| `novel-bible` | 设定管理 | `get_outline`、`get_chapter`、`search_bible`、`update_bible_entry` |

工具名与掩码的唯一来源是 [`novel-protocol`](<../packages/novel-protocol/src/index.ts#L4-L10>)；
工具在**各自 preset 的作用域内**注册，根作用域看不到任何小说工具
（[preset-tools.ts](<../plugins/myrix-novel/src/preset-tools.ts#L59-L66>)）。

### 5.1 六个工具与参数

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `get_outline` | 无 | 读取当前作品大纲及版本 |
| `update_outline` | `text`, `expectedVersion` | 按已读取版本保存完整大纲 |
| `get_chapter` | `chapterId` | 读取指定章节的完整草稿、标题和版本 |
| `save_chapter_draft` | `chapterId`, `text`, `expectedVersion` | 保存完整章节草稿并生成新版本 |
| `search_bible` | `query` | 检索角色/设定/时间线；空串列出全部 |
| `update_bible_entry` | `entryId`, `text`, `expectedVersion` | 按已读取版本更新既有设定条目完整正文 |

参数 schema 对模型声明 `additionalProperties: false`，但**强制点在执行路径**：
`parseToolArguments()` 在任何网络 I/O 之前拒绝非对象、身份字段、非法 UUID、
负/非整数 `expectedVersion`、超长文本；见
[`parseToolArguments`](<../packages/novel-protocol/src/index.ts#L25-L46>)。

| 限制 | 值 |
| --- | --- |
| `text` 长度 | ≤ 1,000,000 字符（完整新正文，不是 diff） |
| `query` 长度 | ≤ 1,000 字符 |
| `expectedVersion` | 非负安全整数 |
| `chapterId` / `entryId` | UUID 形状 |
| 工具总数 / 单次响应体积 | 六个；客户端默认上限 1,000,000 字节、超时 15s |

### 5.2 工具输出投影

工具返回值在回给模型前经**窄化投影**，只保留声明字段：
写工具返回 `{ status, version }`，读工具只保留 wire 字段。
存储层记录里的 `contentHash / updatedAt / reason / tenantId / parentVersion` 不泄漏给模型，
否则 DSH 会以 `additionalProperties: false` 判 `INVALID_TOOL_OUTPUT`；见
[ADR 0026](<adr/0026-novel-write-output.md>)、[output.ts](<../plugins/myrix-novel/src/output.ts>)。

---

## 6. 一次工具调用的完整授权链

入口：`POST /internal/v1/sessions/:sessionId/tools/:tool`，Bearer Cell 凭据 +
`x-myrix-revision`（撤权版本）；见 [works-server.ts](<../apps/bff/src/works-server.ts#L172-L185>)。

顺序（任一步失败即拒绝，且失败发生在写之前）：

1. **Cell 凭据**：令牌只存 SHA-256 摘要，解析出唯一的 `(tenantId, cellId)`；无效 401。
2. **参数强校验**：拒绝身份/额外字段与非法版本。
3. **同一事务**读取并 `FOR SHARE` 锁定：会话绑定、成员、租户、作品。
4. 绑定必须 `status = active` 且 `cell_id` 等于凭据的 Cell；
   成员与租户必须 active；作品必须 active 且 owner 等于绑定 owner。
5. **governance**：以 `sessions:send` + 绑定当前状态/版本 + 调用方 `expectedRevision` 判定。
6. **preset 白名单**：工具必须属于该绑定的 preset，否则 `tool_not_allowed`。
7. 设置数据库 actor，在同一事务/连接内进入资源级授权与 CAS 读写。

实现见 [`createWorksExecutor`](<../apps/bff/src/works-server.ts#L44-L81>)。
身份只来自运行时可信绑定（`principals.require(agent)`），**绝不从模型参数读取**。

---

## 7. 会话命令与幂等（command）

除内容写入外，会话动作走 `commands` 表：

| `op` | 触发 | governance 动作 |
| --- | --- | --- |
| `create` | 创建会话 | `sessions:create`（判定对象是作品） |
| `resume` | 重启/恢复后重新打开 | `sessions:resume` |
| `send` | 用户发消息 | `sessions:send` |
| `cancel` | 用户取消 | `sessions:cancel` |
| `subscribe` | 打开事件流 | `sessions:subscribe` |

命令不变量（[commands.ts](<../packages/platform-store/src/repositories/commands.ts#L90-L308>)）：

- 唯一键 `(tenant_id, id)`；`commandId` 由客户端提供，用于幂等。
- 调用方必须传入当前会话 `rev`；与库中不一致立即 409，避免撤权竞态。
- 同一 `commandId` 复用必须主体、会话、`op`、**正文哈希**全部一致；正文哈希由服务端计算。
- 只有会话所有者能发命令；非所有者拒绝并写 deny 审计。
- 状态机 `queued → inflight → succeeded / failed / dead`；投递失败只释放并指数退避，
  行永不丢失；超过 `max_attempts` 进 `dead`。
- 命令可作为凭证查询回执（`GET /v1/commands/:commandId`），超时后先查再重发，
  避免重复投递。
- 状态变化与业务写入同事务，跨进程通知走 `outbox_messages`（至少一次投递）。

> `202 queued` 只表示**数据库已持久入队**，不代表模型已完成；完成以持久助手消息与
> 实际业务数据为准（[bff-api.md](<implementation/bff-api.md>)）。

---

## 8. 授权身份与限制汇总

| 维度 | 当前规则 | 证据 |
| --- | --- | --- |
| 认证 | 生产仅 OIDC Code+PKCE；开发登录仅显式 loopback | [auth.ts](<../apps/bff/src/auth.ts#L54-L66>)、[ADR 0013](<adr/0013-bff-authentication.md>) |
| 会话 Cookie | 256 位不透明串，DB 只存 SHA-256；HttpOnly / SameSite=Lax / 生产 Secure | [auth.ts](<../apps/bff/src/auth.ts#L44-L68>) |
| CSRF / Origin | 所有变更请求要求精确 Origin + `X-CSRF-Token` | [auth.ts](<../apps/bff/src/auth.ts#L76-L99>) |
| 会话有效期 | 60 – 86,400 秒（部署指定） | [auth.ts](<../apps/bff/src/auth.ts#L58-L59>) |
| 限流 | 每 IP 每分钟 120 次 | [server.ts](<../apps/bff/src/server.ts#L44>) |
| 内容归属 | 单一 owner；同租户非属主 403、跨租户 404；admin 无正文旁路 | [works.ts](<../packages/platform-store/src/repositories/works.ts#L9-L10>) |
| Cell 隔离 | **一 Cell 一租户**，重复即拒绝启动 | [runtime-cells.ts](<../apps/bff/src/runtime-cells.ts#L105-L150>) |
| 首版租户规模 | 初始化为1 Cell / 1租户 / 1 owner；可补同租户成员，同一 IdP subject 不支持多租户切换 | [单机部署指南 §5](<deployment/self-hosting.md>) |
| 工具面 | 六个工具；preset 掩码 + 部署策略交集，只能收窄 | [works-server.ts](<../apps/bff/src/works-server.ts#L106-L127>) |
| 模型协议 | 仅 OpenAI Responses；`chat/completions` 无路由、无回退 | [server.ts](<../apps/model-gateway/src/server.ts#L71-L94>) |
| 秘密边界 | Cell 不持有 DB 连接、上游密钥、签名私钥、OIDC secret | [ADR 0029](<adr/0029-single-vps-runtime.md>) |
| 审计 | allow/deny 都带 reason；`data-write`、`admin-change`、`policy-decision` 等分类 | [schema.ts](<../packages/platform-store/src/schema.ts#L201-L220>) |

---

## 9. 审计与可追溯

- 判定、数据写入、管理变更、知识访问都写 `audit_events`，含 `effect`、可读 `reason`、
  `matched_rules`、`obligations`、`trace_id`。
- 版本表只追加，因此可以回答"某个版本由谁、在什么父版本之上写入"。
- 命令保留 `body`、`body_hash`、`receipt` 与 `last_error`，超时后可查回执再决定是否重发。

## 10. 明确不做

- 不接受模型或浏览器提交身份、作品、URL、凭据或任意附加字段。
- 不允许跨作品的 `chapterId / entryId` 混用。
- 不做内容层的"管理员代看/代改"。
- 不在 Cell 或浏览器保存上游模型密钥。
- 不提供 `chat/completions` 兼容入口、协议转换或失败回退。
