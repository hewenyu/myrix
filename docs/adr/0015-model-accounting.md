# ADR-0015：模型网关的归因、额度与账本边界

- 状态：已接受（首版 / M2 落地）。**协议面已被 [ADR-0023](0023-responses-gateway.md) 取代**：网关当前只讲 OpenAI Responses
  （`POST /v1/responses`），不再有 `chat/completions` 入口；本文关于归因、额度与账本边界的决策仍然有效。
- 日期：2026-09-30
- 相关：ADR-0004（把模型治理放在 LLM 网关层）、ADR-0012（平台授权与 D11 单一所有者）、ADR-0013（BFF 身份）、
  [ADR-0023](0023-responses-gateway.md)（Responses 协议）、[模型网关实现](../implementation/model-gateway.md)。
  原技术/平台草案已于 2026-10-02 本地归档，见[文档维护、归档与脱密](../documentation-policy.md)

## 背景

ADR-0004 把"模型路由、配额、模型白名单、审计、密钥托管"整体划给企业 LLM 网关，Myrix 只下发义务。
首版需要把这个边界**落成可运行的代码**，并回答 ADR-0004 没定的四件事：

1. **归因从哪来**。DSH 侧 `myrix-llm-gateway` 插件会把 `x-myrix-session` 传下来（原技术草案 §4.4 的设计；草案已本地归档），
   但请求头是客户端可控的。如果网关按 `x-myrix-tenant` / `x-myrix-user` 记账，任何 cell 都能把用量
   记到别的租户头上，也能读到别人的额度视图。
2. **额度是"检查"还是"预占"**。只做"先查余额、再调用、后回写"会在并发下超卖：
   两个请求都查到"还有额度"，然后都调用上游。
3. **拿不到 usage 怎么办**。上游断流、5xx、客户端取消时没有真实 token 数。
   若按 0 计费，额度就是摆设；若猜测一个数，账单无法解释。
4. **账本里能放什么**。提示词与响应正文属于租户数据，密钥属于平台秘密。

同时，业务侧 `AuthorizerPort` 的实现方（会话绑定/成员读取）由另一个子任务在开发，
网关必须能独立推进并让 Lead 事后装配，而不是阻塞在业务 store 上。

## 决策

### 1. 主体只来自"服务端凭据 + 数据库绑定行"，请求头一律不可信

一次模型调用的主体判定固定为两步：

1. `Authorization: Bearer <cell 服务令牌>` → `sha256(token)` → 数据库里的 `(tenantId, cellId)` 绑定；
2. `x-myrix-session` + `x-myrix-revision` → 该会话在数据库里的**当前**绑定行
   （`ownerUserId`、`cellId`、`status`、`rev`）。

然后复用 ADR-0012 的纯函数判定：

- `sessions:send`，`resource = { tenantId, ownerUserId, status, revision }`，`expectedRevision = 客户端带来的 rev`
  → 校验"所有者 + 未撤销 + rev 一致"；
- `models:invoke`，`resource.ownerUserId = 会话所有者` → 校验"同租户 active 成员且不把用量归因到他人资源"。

由此推出几条硬性行为：

- 请求体里的 `tenant_id` / `user` / `actor` 之类字段**不在协议白名单内**，出现即 400；
- 请求头 `x-myrix-tenant` / `x-myrix-user` **被忽略**（网关根本不读）；
- 绑定行的 `cellId` 必须等于凭据的 `cellId`，否则 403（防跨 cell 冒用 sessionId）；
- **缺少 rev 一律 400**，不回退到"用当前 rev"——否则撤权后的旧凭据会自动获得新 rev。

### 2. 额度是"事务内预占 + 真实 usage 结算"，未知用量保守保留

- **预占量 = 输入保守估算 + 本次输出上限，不做截断。**
  估算按 **UTF-8 字节**（默认 3 字节/token），并计入消息结构字段
  （role/name/tool_call_id/tool_calls）与 `tools`/`tool_choice`/`response_format`
  的 JSON 成本。网关没有上游 tokenizer，**不声称精确换算**：3 字节/token 只是保守下界
  （英文约 3.5–4 字节/token、中文 3 字节/字约 0.6 token/字，两种文字下都不低于常见真实值）。
- **估算超过输入硬上限 → 明确拒绝（400 `input_too_large`），绝不静默截断成更小的预占。**
  硬上限取部署的正文上限（`ceil(maxBodyBytes / 3)`）：合法请求本就受传输层
  `maxBodyBytes` 约束，因此不会被误拒；它只对绕过 HTTP 层直接调用 `ModelGateway`
  的路径起 fail-closed 兜底。`max_tokens` 超过部署硬上限同样直接 400。
  默认 `MYRIX_GATEWAY_MAX_OUTPUT_TOKENS` 保持 8192（未调整默认硬上限：普通章节写作
  的输出预算照旧；需要更长输出时由部署方显式提高，并与正文上限一起核算输入预算）。
  > 修正记录（窄域安全修复）：旧实现按"约 4 **字符**/token"估算，并用
  > `maxReservationTokens = max(4×maxOutputTokens, 8192)` 封顶，最后在结算时
  > 再 `min(预占, 真实 usage)`。中文在 UTF-8 下是 3 字节/字、约 1 token/字，
  > 于是 6 万汉字 prompt 被估成 15004、预占 16028，真实 6 万只结算 16028——
  > 单次请求白送 43972 token，且 20 万汉字 prompt 会被压到硬上限 32768，
  > 连额度闸门都拦不住。字符数不是 token 数的上界，这条路径必须按字节保守估算。
- **预占在一个事务里串行化**：Postgres 版先取租户/用户/会话三个 `pg_advisory_xact_lock`，
  再统计窗口内 `pending`（记预占量）与已结算（记 `consumed_tokens`）之和，最后插入。
  内存版用同一条 Promise 串行链表达同样语义，便于单测。
- 额度闸门有三层：租户窗口、用户窗口、会话窗口；另有租户/用户**并发未结算请求数**上限。
  任一不满足 → 429，且**不调用上游**（不消耗上游额度）。
- **预占是防超卖的闸门，不是本次调用的计费上限。**
  - 有 usage 且正常结束 → `settled`，**真实 `total_tokens` 全额计入**：
    小于预占则退回差额；**大于预占则 `refunded=0`，超额部分留在窗口统计里**，
    使后续预占被 429，直到滚动窗口滑出（迁移 0001 因此移除了
    `consumed_tokens <= reserved_tokens` 约束，并新增 `total_tokens` 列用于对账）。
  - 没有 usage、流中途断开、上游 5xx、撤权中止、上游超时 → `unknown`，**按预占量计入消费，不退款**；
  - 上游 4xx（除 429）说明请求被上游拒绝、未产生生成 → `released`，全额退回；
  - 客户端在请求**到达上游之前**就断开 → `released`。

  取舍理由：额度是防滥用的闸门，宁可多扣（可在运维侧对账修正）也不能少扣；
  "猜测 token 数"会让账本失去可解释性，所以未知就是"按预占上限计"。
  而**已知真实用量时必须以真实值为准**：把真实用量截断成预占量同样让账本失去
  可解释性，还会让闸门在超额请求上失效。

### 3. 幂等靠 `requestId`，唯一约束在账本，不在客户端

`requestId` 取自 `x-request-id`（不合形状则由服务端生成）。账本主键 `(tenant_id, request_id)`：

- 重复预占 → 返回既有行并标记 `replayed`，网关随后返回 **409 `request_id_reused`**；
  网关**不重放模型响应**，避免"一次计费、两次上游调用"。
- 重复结算 → 返回既有结果（`replayed: true`），不二次扣减。
- 跨租户复用同一 `requestId` → 403（否则 A 租户的键能影响 B 租户账本）。

### 4. 账本不含正文与密钥

`myrix_gateway.quota_reservations` 只有：租户/用户/会话/cell id、模型名、计量数字、状态、
上游状态码、延迟、时间戳。**没有** messages、completion 文本、任何令牌。
网关日志同理：不打印请求体、不打印 `Authorization`、不把上游响应体回给客户端
（上游 4xx 只回一个固定的 `upstream_rejected` 说明）。
cell 凭据只存 SHA-256，且该表**不授予应用角色任何权限**。

### 5. 上游必须显式配置；缺密钥 503，没有模拟降级

- 上游 URL 与模型名缺失 → **启动即失败**（部署错误不该等到请求时才暴露）。
- 上游密钥缺失 → 服务可启动（便于探活/灰度），但 `/v1/responses` 返回
  503 `model_not_configured`，且发生在**预占之前**（不扣任何额度）。
  （旧 `chat/completions` 入口已按 [ADR-0023](0023-responses-gateway.md) 退役，路径返回 404。）
- 测试用的 fake upstream 只存在于 `tests/fakes.ts`，生产代码不引用。
- 客户端**无法**指定上游 URL/model/key：转发用的模型名恒等于部署配置，
  请求里的 `model` 只用于 allowlist 校验。
- 上游必须是 `https`；只有 loopback 允许 `http`（本地联调）。

### 6. `AuthorizerPort` 可注入，网关不拥有业务表

网关只拥有 `myrix_gateway` schema。会话绑定与成员记录在业务库
（`myrix.session_bindings` / `members`，由 `@myrix/platform-store` 或业务服务拥有）。
接口是三个读取方法：

```ts
resolveCredential(token): Promise<{ tenantId, cellId } | undefined>
loadSessionBinding(tenantId, sessionId): Promise<{ sessionId, tenantId, ownerUserId, cellId, status, revision } | undefined>
loadMember(tenantId, userId): Promise<PlatformMember | undefined>
```

`createPortFromReaders({ credentials, business })` 是给 Lead 的装配捷径：
`createPostgresCredentialResolver(db)` 提供凭据解析，业务 store 提供后两个读取方法。
网关**不复制**业务 SQL，避免两处漂移。

### 7. 流式响应期间轮询撤权

流式调用在传输期间按 `revokePollMs`（默认 5s）轮询"权限是否仍然有效"
（绑定行 rev/状态/cell/所有者一致 + 成员仍 active）。失效即 abort 上游连接、
给客户端补一个 `session_revoked` 错误事件，并把该次调用结算为 `unknown`（保守保留预占）。
轮询本身失败按"权限已失效"处理（fail-closed）。
客户端断开同样 abort 上游：不继续消耗上游额度。

## 备选方案与为什么拒绝

| 方案 | 拒绝理由 |
| --- | --- |
| 信任请求头 `x-myrix-tenant` / `x-myrix-user` 做归因 | 任何 cell 都能伪造，用量与额度会跨租户串号；与原平台草案 D4"不许自报归因"冲突（草案本地归档） |
| 只在调用前查余额、调用后回写 | 并发下必然超卖；崩溃还会丢账 |
| 没有 usage 时按 0 计费 | 断流即可白嫖额度，闸门形同虚设 |
| 没有 usage 时按 `max_tokens` 之外的猜测值计费 | 账单不可解释、无法对账 |
| 已知真实 usage 时仍按 `min(预占, 真实)` 结算 | 超额用量白送、窗口统计偏低 → 闸门对"输入估算被低估的请求"（典型是中文）完全失效；真实值已知时截断它，与"按猜测计费"一样不可解释 |
| 输入估算超上限时把预占压到上限（`min(估算, cap)`） | 等于用"更小的假预算"骗过闸门与结算；正确做法是**明确拒绝**（400）或提高部署上限 |
| 用 `content.length`（UTF-16 码元）折算 token | 中文一字只算 0.25 token；字符数不是 token 数的上界，必须按 UTF-8 字节保守估算 |
| 由客户端提供幂等键并要求其保证唯一 | 客户端崩溃重启会换键（原技术草案 §3.5 的同类教训；草案本地归档）；改由服务端校验 + 主键唯一约束 |
| 网关直接读写业务表 | 两个服务共享表结构 = 迁移耦合；业务 store 已在开发中，接口化可并行推进 |
| 让网关自己签发/校验 cell 凭据 | 凭据由控制面签发、cell 只持有一份；网关只做"令牌摘要 → 绑定"查询，职责更小 |
| 网关内做内容安全/提示词审计 | ADR-0004 已把内容治理划给企业网关；本网关显式不存正文 |

## 后果

- 正面：一次模型调用的租户/用户归因可被数据库证据（绑定行 + 凭据绑定）解释；
  额度不会超卖；断流不会漏计；**已知真实用量时不多收也不少收**，超额用量真的收紧后续额度；
  账本可用于对账且不含敏感内容。
- 负面：预占依赖"输入保守估算（UTF-8 字节）+ 输出上限"，短对话会短暂多占额度（结算即退回）；
  中文请求的预占比英文同字节数更保守（因为按字节而非字计），并发上限以内存在短暂高估，
  需要运维在告警阈值上留余量。
- 负面：内存与 Postgres 账本都必须允许 `consumed_tokens > reserved_tokens`；
  任何消费该表的报表/约束都要按"真实用量可超额"来写。
- 负面：输入估算按字节保守放大，超长输入的合法请求可能较早触达 `input_too_large`
  （受 `MYRIX_GATEWAY_MAX_BODY_BYTES` 约束）；需要更大输入时应显式提高该配置，
  而不是让它静默截断预占。
- 负面：轮询撤权有最长 `revokePollMs` 的窗口（默认 5s）。首版接受；
  若需要秒级撤权，可改为控制面 push 通知（outbox 已有 revoke 事件类型）。
- 负面：`unknown` 结算对租户是"多扣"，需要在管理后台提供对账/手工冲正入口（后续任务）。
- 待办：管理后台按租户查询用量（`usageForTenant` 已提供）、`unknown` 冲正流程、
  多上游路由（当前是单上游单模型，符合"明确配置"的要求）。

## 验收标准（首版）

1. 伪造 `x-myrix-tenant` / `x-myrix-user` / 请求体 `tenant_id` 不影响归因与账本（单测）。
2. 旧 rev、缺 rev、已撤销会话、被停用成员、跨 cell sessionId 全部被拒（单测）。
3. 缺上游密钥返回 503 且**不产生预占**；上游 4xx 退预占、5xx/断流保守保留（单测）。
4. 同 `requestId` 第二次调用返回 409 且上游只被调用一次（单测）。
5. 流中途撤权：abort 上游连接、客户端收到 `session_revoked`、结算为 `unknown`（单测）。
6. 账本与审计记录里不出现请求正文与密钥（单测断言序列化结果）。
7. Postgres 路径（opt-in `MYRIX_GATEWAY_TEST_DATABASE_URL`）：FORCE RLS 在无租户上下文时读不到行、
   应用角色无法直接读凭据表、并发预占不超卖、重复结算幂等。
8. 据实结算（窄域安全修复新增）：
   - 中文 prompt 的预占按 UTF-8 字节估算且不被截断；输入超硬上限返回 400 `input_too_large`（单测 before/after）；
   - 真实 usage 超过预占时 `consumed_tokens` 全额入账、`refunded=0`，随后同窗口预占被 429（内存单测 + PG）；
   - 内存账本与 PG 账本对同一序列（含超额结算）给出相同结果（PG 单测）；
   - `unknown` 断流仍按完整预占保留（单测）；
   - 真实 **LOGIN 非 owner** 角色（自有随机 fixture 库，`session_user = current_user`）
     下 RLS 与账本语义同样成立（`tests/pg/ledger-login.pg.test.ts`）。
