# ADR-0034：统一创作助手 preset 与持久会话归档（展示元数据，不是撤权）

- 状态：后端已实现并回归（真实非 owner PostgreSQL + RLS + 真实 Cell 快照 + 真实 Cordis preset 作用域）；归档语义已订正为"**只整理历史、只拒绝新的 send**，不停止任务、不撤权"（见决策 2）。前端接入与真实模型回合验收按后续 UI 变更为准，不由本 ADR 推定。
- 日期：2026-10-02
- 相关：[ADR-0017](./0017-novel-tools-boundary.md)、[ADR-0012](./0012-platform-authorization.md)、[ADR-0011](./0011-postgres-ownership.md)、[ADR-0019](./0019-cell-binding-leases.md)、[ADR-0026](./0026-novel-write-output.md)、[ADR-0028](./0028-runtime-session-recovery.md)。

## 背景

首版把"大纲 / 正文 / 设定"拆成三个 preset，每个只持有一个收窄的工具掩码
（3 / 4 / 4 个工具）。这是当时的**安全**设计：单属主内容授权之外，还靠
"作用域里没有这个工具"做第二道收窄。但作者的实际使用方式是**一段连续对话**：
先聊整体走向、再落到某一章、中间还要确认人物设定。要求用户先选助手类型，是把
平台的实现细节变成用户的负担；而跨类任务的正确做法（读完大纲再决定改哪一章）
也与"每个助手只看得见自己那半张表"的收窄相冲突。

与此同时，工作台需要"归档"能力：作者想让不再使用的会话从当前列表里退出，但
**不能**撤权 —— 撤权是终态（`status=revoked` + `revoked_revision` 递增 + outbox
通知 Cell 使凭证失效），历史会话一旦撤权就再也回不去，也不该为了"列表清爽"
付出这个代价。

本 ADR 记录两件互相独立但同一批交付的事情：**新增统一创作助手 preset**，以及
**新增会话归档（archived_at）**。

## 决策 1：`novel-assistant` = 现有六个工具全集

- `packages/novel-protocol` 新增 `novel-assistant`，掩码逐字等于 `NOVEL_TOOLS`
  （六个既有工具），并新增 `toolsForPreset(preset)`：**未知 preset 返回
  `undefined`**，调用方必须 fail-closed 拒绝，绝不回退到"全集"或"默认助手"。
- 三个历史 preset 的掩码**逐字不变**（`novel-outline` 3 个、`novel-chapter` 4 个、
  `novel-bible` 4 个）。历史会话重放、显式选择它们时拿到的权限不扩大。
- 新增 preset 走既有的 preset-scope 注册机制（`@myrix/novel/preset-tools` 在
  preset 子树里按 `config.tools` 注册），**没有**新增任何全局工具、没有新增通用
  Cell 工具、没有改 vendor。根作用域仍然看不到任何小说工具。
- 数据库侧：`session_bindings.preset` 的 check 约束在**追加迁移 0010** 里改为四个
  值（旧三个原样保留），`SessionPreset` 类型与 `SESSION_PRESETS` 同步为四个。三处
  （契约类型 / DSH 装配 / DB 约束）必须同时贯通，否则会出现"代码声称支持、
  数据库拒绝落库"或反之。

### 不要求用户选 preset，但保留显式选择

浏览器创建会话时 `preset` 仍是**必填显式字段**（JSON Schema 枚举四个值）；
"不需要选"由**服务端默认值**表达（UI 传 `novel-assistant`），而不是由后端隐式
兜底。这样历史会话与显式选择路径完全不变，验收也不必解释两套语义。

### 系统提示如何指导判断（可读的"为什么"）

统一助手的预设提示段落（`plugins/myrix-novel/src/presets.ts`）明确写出：

1. 用户不会也不需要先选助手类型；从自然语言判断任务（整体走向 → 大纲；某章文字 →
   正文；人物/地点/势力/时间线/物品/概念 → 设定），一次对话可先后做多类任务；
2. **工具现实**：只有六个工具，**不能**新建作品/章节/设定条目、不能删除、不能读
   章节版本历史；用户要求这些时如实说明并给出替代方案，**绝不假装已经创建**；
3. **先读后 CAS 写**：`update_outline` / `save_chapter_draft` / `update_bible_entry`
   都必须带刚读到的 `expectedVersion`；没有先读到版本不写；冲突时先重读、保留用户
   草稿、不覆盖；
4. 读到的内容不足时直接提问，不凭聊天摘要编造事实。

"不能创建对象"是**能力事实**，不是策略措辞：六个工具里没有 create 工具，所以
提示里的这句话与真实可调用面一致；这与"只用工具作用域做收窄"是同一套机制。

## 决策 2：归档是展示元数据，只整理历史，不停止任务

- 新增可空列 `session_bindings.archived_at timestamptz`（迁移 0010，追加式；
  `null` = 未归档，历史行天然满足，不需要回填）。
- 归档**不**改 `status`、**不**递增 `revoked_revision`、**不**写 outbox、
  **不**通知 Cell：已签发的凭证不因此失效，历史版本与命令历史全部保留。
- 恢复（`archived_at = null`）完全可逆；`revoked_revision` 全程不变。
- 归档**与撤权正交**：撤权是终态，可以作用在已归档会话上，而且必须成功。
- 授权动作**复用 `sessions:read`**（见下）。

### 归档只拒绝"新的 send"，其余能力一条都不减

用户要求明确回答这一条，这里的结论是：**归档只整理历史、不停止任务** ——
归档期间唯一新增的边界是"不能再发新消息"，其他能力一条都不减。逐条原因
（每一条都有对应测试）：

| 操作 | 归档期间 | 原因与实现 |
| --- | --- | --- |
| `POST /sessions/:id/messages`（send） | **409 `session_archived`** | 唯一新增边界：归档是用户显式收起的历史，静默丢弃或排队都会让作者以为消息已发出。由 `RuntimeRouter.enqueue` 在读取本人绑定后判定，**不产生任何命令行**；文案明确提示"恢复后才能继续发送" |
| `POST /sessions/:id/cancel` | **正常入队（202）** | 归档不停止任务：作者必须能停下一条已经在跑的回合。"归档后连取消都做不到"会让任务失控 |
| `GET /sessions/:id/events` | **正常订阅**（允许为订阅触发必要 resume） | 归档要能"看完整历史"。为重启后的会话重新订阅而需要的恢复命令照常走同一套治理/审计/投递路径，`Last-Event-ID` 续传语义不变 |
| 归档前已入队、归档后才被认领的命令 | **照常投递给 Cell** | 归档不停止任务：这些命令是归档之前用户已经发出的意图，归档不能把它们静默作废 |
| 后台会话恢复（resume） | **正常**（不因归档拒绝） | 归档不是撤权，恢复原语只按 `status` / rev / 所有者判定；为投递残留命令或订阅事件流而触发的 resume 都必须能进行 |
| Cell 工具执行（`/internal/v1/sessions/:id/tools/:tool`） | **正常**（权限只看 preset 与所有权） | 归档期间模型继续写正文/大纲/设定是**预期行为**（任务没有被停止）；"归档后偷偷撤掉工具权限"会把归档变成半个撤权 |
| Cell 授权快照 | **该绑定照常出现在快照里** | 快照是 Cell 的活性租约；归档会话仍在执行，把它从快照里摘掉会掐断正在跑的会话（ADR-0019） |
| 读取（列表 / 详情） | **仍然可读**，`archivedAt` 非空 | 归档只做分组/收起：`GET /works/:id/sessions` 原样返回并带 `archivedAt` |
| `DELETE /sessions/:id`（撤权） | **正常撤权（204）** | 归档与撤权正交；撤权是终态，必须能在归档态上生效（见下"数据库约束"） |

返回码选择：`409`（而不是 `403/410`）。归档是**可逆的状态冲突**，不是授权结论、
更不是撤权；用 `403` 会把"恢复即可继续"谎报成"你没权限"，用 `410` 会与撤权混淆。

### 数据库约束：删除"已撤权不得归档"

0010 曾新增 `session_bindings_archived_consistency`
（`not (status = 'revoked' and archived_at is not null)`）。在"归档只整理历史"
的语义下这条约束**没有保护任何东西，而且会制造 500**：

- `SessionsRepository.revoke`（`DELETE /sessions/:id` 的存储路径）与
  `revokeActiveBindingsOfOwner`（停用成员时的批量撤权）都是直接
  `UPDATE ... SET status='revoked'`，不清 `archived_at`；对已归档会话执行会直接
  违反 23514 → 用户看到 500。
- 撤权后的会话本就退出列表、也不再接受归档/恢复写入；约束没有多挡住任何一个操作。

因此追加迁移 `0011_drop_session_archive_consistency.sql` 删掉它（0010 已应用到既有
环境，迁移表记录校验和、不可改写），而不是让每条撤权路径都额外写一次
`archived_at` —— 那会把展示元数据混进撤权事务，反而扩大撤权路径的写面。
归档与撤权正交后，"撤权 + 归档"是合法状态：撤权不回滚、也不篡改用户的归档标记。

### 授权：为什么复用 `sessions:read`，而不是新增动作

`authorizePlatform` 的动作清单在 `packages/governance`（本次改动的独占写范围之外）。
归档/恢复的准入规则是：**只有会话所有者本人**；非所有者（含管理员）统一
`not_found`（不泄漏他人会话是否存在）。实现顺序是：

1. `SessionsRepository.setArchived` 在**同一事务**里读绑定，先做所有者事实校验
   （非所有者 `not_found`），再做撤权/未知状态拒绝；
2. 然后仍调用 `authorizeTx`（生产 = governance），动作取 `sessions:read`
   —— 它与归档同级（都只是读元数据），owner-scoped、要求 `status` 与当前
   `expectedRevision`，且 `status=revoked` 一律拒绝。

因此实际生效的授权**只能比"所有者本人 + 未撤权"更窄**，不会更宽：
管理员的 `sessions:revoke` 覆盖权在这里用不上（第 1 步已经 `not_found`）。
不新增 `sessions:archive` 动作是刻意的取舍：不为一个元数据开关扩大动作词表，
也就不会顺带扩大任何角色的白名单。若后续治理侧愿意，`sessions:archive` 可以作为
独立动作在 governance 中落地，再把这里的动作名换掉 —— 语义不变、权限不变。

### API 确切形状

```
POST   /api/v1/works/:workId/sessions
  body     { preset: "novel-assistant" | "novel-outline" | "novel-chapter" | "novel-bible" }   # 显式必填
  201      { id, workId, preset, status, createdAt, archivedAt: null }

GET    /api/v1/works/:workId/sessions
  200      { items: [{ id, workId, preset, status, createdAt, archivedAt }] }   # 含已归档，未撤权

PATCH  /api/v1/sessions/:sessionId
  body     { archived: boolean }     # 显式、必填、additionalProperties: false
  200      { id, workId, preset, status, createdAt, archivedAt }   # 更新后的会话
  400      schema 拒绝（缺字段 / 无法解释成布尔 / 多余字段）
  403      csrf_rejected / origin_rejected（统一 hook；PATCH 属 mutating）
  404      not_found（非本人会话；含管理员与其他租户，不泄漏存在性）
  409      conflict（归档态在并发中被修改）
  410      revoked（已撤权会话不能归档或恢复）

POST   /api/v1/sessions/:sessionId/messages     409 session_archived（归档期间；唯一新增边界）
POST   /api/v1/sessions/:sessionId/cancel       不变：归档期间照常 202 入队（任务不因归档停止）
GET    /api/v1/sessions/:sessionId/events       不变：归档期间照常订阅/续传（必要时照常触发 resume）
DELETE /api/v1/sessions/:sessionId              不变：撤权（410/204 语义不动），归档态上照常生效
```

`NovelSession.archivedAt?: string | null` 是**可选**字段：老客户端忽略它即可；
新写入总是带上（`null` 表示未归档）。`archivedAt` 不等于 `revoked`，也不替代
`status`。

## 迁移与兼容

追加迁移 `0010_session_archive_and_assistant.sql`（不改写既有迁移；迁移运行器对
已发布文件的校验和是不变量）：

1. `drop constraint if exists session_bindings_preset_check` 后按四个值重建；
2. `add column if not exists archived_at timestamptz`（旧行为 `null`）；
3. 新增 `(tenant_id, owner_user_id, archived_at, created_at desc)` 索引。

追加迁移 `0011_drop_session_archive_consistency.sql`：删除 0010 里那条
`session_bindings_archived_consistency`。0010 已经应用到既有环境、校验和不可改写，
所以用追加迁移而不是原地修改（原因见"数据库约束"一节）：这条约束会让
"撤权已归档会话"直接 23514，而修订后的语义下归档与撤权正交。

历史会话：`preset` 仍是旧三个值之一，`archived_at` 为 `null`，重放/撤权/列表语义
逐字不变；`PRESET_TOOLS` 对旧 preset 的值没有变化，因此"历史会话的工具面"没有
扩大。

## 被否决的方案

- **用一个布尔 `archived` 列**：`archived bool not null default false` 需要回填、
  丢掉了"什么时候归档"的可读信息；可空时间戳对历史行零成本，且同时回答"是否归档"
  与"何时归档"。契约里仍以 `archivedAt: string | null` 暴露，UI 需要布尔时自行派生。
- **归档 = 复用 revoked**：不可逆、会通知 Cell、会让历史会话永久失去恢复能力，
  与"不破坏历史"直接冲突。
- **归档 = 暂停交互（拒绝 send/cancel/事件流/工具调用/恢复，并从 Cell 快照移除）**：
  曾短暂实现过，但它把"整理历史"偷偷变成了"半个撤权"：作者归档一条仍在跑的会话后
  既停不下来（cancel 被拒）、也看不完整历史（订阅被拒）、恢复还得绕过被摘掉的快照。
  归档的唯一新增边界只能是"新的 send"，其余一律不变。
- **在 revoke / 停用成员路径里清 `archived_at`**：能保住约束但把展示元数据写进撤权
  事务、扩大撤权写面，且撤权后会话本就退出列表；直接删掉无意义约束更小、更诚实。
- **归档期间静默丢弃 send**：作者无法区分"已发出"和"被丢掉"；返回可读 409 并保留
  会话可读性才是诚实的失败。
- **归档前已入队的命令判 `archived-binding` 失败**：那是把用户归档前已经发出的意图
  作废，等同于"归档停止任务"；必须照常投递。
- **给归档新增 `sessions:archive` 动作**：动作清单属 `packages/governance`
  （本次写范围之外）；且复用 `sessions:read` 在 owner-only 事实校验之后实际更窄。
- **隐式默认 preset（浏览器省略 `preset` 就发 `novel-assistant`）**：把"不需要选"
  变成服务端猜测；显式默认值放在 UI 侧，后端保持 fail-closed。
- **新增 create 类工具**（让助手"真的能新建章节/条目"）：超出本次范围，且属于
  `NOVEL_TOOLS` 白名单变更；提示里如实说明"不能创建"，不谎称能力。

## 验证范围（本次实际执行）

- `plugins/myrix-novel/tests/preset-module.test.ts`：**统一 preset 掩码**四个 preset
  逐字对照、未知 preset（含大小写与尾随空白）在协议层就没有工具集、历史掩码不扩大、
  提示含"不需选类型/不能新建对象/先读后写/冲突重读"。
- `plugins/myrix-novel/tests/plugin.test.ts`：真实 Cordis preset 作用域里四个 preset
  的工具可见性（助手 = 六个全集；历史三个逐项不扩大）、未知 preset 注册失败、
  助手提示装配、助手在真实（替身模型）回合里调用工具。
- `packages/platform-store/tests/session-archive.test.ts`（真实非 owner LOGIN + RLS）：
  所有者归档/恢复与幂等、归档不动 status/rev/outbox、审计写明"不是撤权"、
  非所有者/跨租户/管理员统一 `not_found` 且行不变、已撤权 410、未知 preset 仍被
  check 拒绝、`novel-assistant` 可建；**归档会话仍可 `revoke`（DELETE 路径）与
  停用成员批量撤权**（0011 删除约束后不再 23514），且"撤权 + 归档"是合法行。
- `apps/bff/tests/runtime-router.test.ts`（真实 PostgreSQL + 假 driver）：归档/恢复
  全流程、归档期间只有**新的 send** 409 且零命令行、cancel 照常入队、事件流照常
  订阅并回放历史、归档前入队命令**照常投递**、快照**保留**归档会话、列表带
  `archivedAt`。
- `apps/bff/tests/runtime-recovery.test.ts`：归档会话订阅照常触发 resume（503
  `session_reopening` 而不是 409/403），恢复原语返回 `enqueued/pending`（没有
  `binding-archived` 拒绝、审计无该原因），resume 投递成功后 cursor 0 真的回放
  归档前历史。
- `apps/bff/tests/postgres.integration.test.ts`：归档期间工具执行**照常成功**、
  快照保留归档会话、归档后撤权成功且 rev 递增、撤权后归档 410、非所有者
  （含管理员）不能归档、列表 `archivedAt` 全程正确。
- `apps/bff/tests/server.test.ts`：PATCH 的显式布尔、CSRF、缺字段/多余字段/不可解释
  值 400、四个 preset 的枚举接受与未知 preset 400；send 的 409 经真实 HTTP 边界，
  而 cancel 202、events 200 都照常穿过边界。
- `tests/poc/tests/compiler.test.mjs`：Cell 插件编译仍内联 `@myrix/novel-protocol`
  （四个 preset 的掩码变化不破坏打包）。

未验证边界：前端（`apps/novel-web`，由 UI 变更方接入）尚未调用 PATCH；真实模型在
统一助手下的端到端创作回合（含"要求新建章节时如实拒绝"的自然语言行为）需要真实
模型授权与浏览器验收，本 ADR 不声称已通过。

## 同步事项（不在本次写范围）

- `apps/works-service`（历史实现）的 `NovelSessionView.preset` 只声明三个旧 preset；
  本次已让它对 `novel-assistant` **显式抛错**而不是强转，但该服务与 `apps/bff` 的
  契约合并属于后续工作。
- `bundles/myrix-base/cell.patch.yml` 的**配置行无需改动**（preset 由插件自行注册）；
  本次只订正其中的过时注释（"3 preset subtrees" → 四个 preset 的名称与掩码说明）。
- 前端需要把新建会话的 `preset` 显式传为 `novel-assistant`、展示 `archivedAt`
  分组，并调用 PATCH 归档/恢复。
