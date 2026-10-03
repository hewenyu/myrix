# Model gateway（Responses）

`apps/model-gateway`：OpenAI **Responses** 模型网关。cell 通过它调用上游模型；网关负责
**归因、模型白名单、额度预占与结算、撤权中止、计量审计**。协议与错误形状对齐 OpenAI，
便于 DSH 侧 `myrix-llm-gateway` 适配器直接对接。

**只讲 Responses。** 仓库硬性规则禁止 `chat/completions`：入站只有 `POST /v1/responses`，
旧路径一律 404，上游必须是完整 `/responses` 端点，且没有任何协议翻译层或失败回退。

- 决策与取舍：[ADR-0023](../adr/0023-responses-gateway.md)
- 归因与额度：[ADR-0015](../adr/0015-model-accounting.md)
- 上游边界：[ADR-0004](../adr/0004-llm-gateway-boundary.md)
- 启动与配置：[model-gateway-operations.md](model-gateway-operations.md)

## HTTP 接口

### `POST /v1/responses`

请求头（只有这三个参与判定，其余归因/诊断头一律忽略）：

| 头 | 必填 | 说明 |
| --- | --- | --- |
| `Authorization: Bearer <cell 服务令牌>` | 是 | 服务端凭据。网关只存其 SHA-256，用于解析 `(tenantId, cellId)` |
| `x-myrix-session` | 是 | 会话 id。绑定行的 `cellId` 必须等于凭据的 `cellId` |
| `x-myrix-revision` | 是 | 撤权版本 rev。必须等于数据库当前 rev，缺省即 400 |
| `x-request-id` | 否 | 幂等键；不合形状时服务端生成新 id |

请求体：OpenAI Responses 子集。允许字段白名单（其余字段 → 400）：

| 字段 | 说明 |
| --- | --- |
| `model` | allowlist 内模型名（字母数字与 `. _ : / -`） |
| `input` | **非空**数组：`{role,content}` 消息（`system`/`developer`/`user`/`assistant`）、`function_call`、`function_call_output` |
| `instructions` | 可选系统级指令（有界字符串） |
| `tools` | 可选，只支持 `{ type: "function", name, description?, parameters?, strict? }` |
| `tool_choice` | 可选：`"none"` / `"auto"` / `"required"` / `{ type: "function", name }` |
| `max_output_tokens` | 可选输出预算；超过部署硬上限 → 400 |
| `stream` | 可选布尔 |
| `store` | 只能是 `false`（缺省也按 false 处理并向上游发送） |

`input[].content` 只支持字符串或 `{ type: "input_text" | "output_text", text }` 数组
（首版不做图片/音频/文件输入）。**显式 400 的字段**：

- 状态类：`previous_response_id`、`conversation`、`background` —— 网关无状态转发完整历史；
- 归因类：`user`、`metadata`、`safety_identifier`、`prompt_cache_key` —— 可能覆盖主体/缓存归因。

响应：

- 非流式：HTTP 200 + 上游 Responses JSON（含 `usage`）。但**必须**有终态 `status`；
  缺 `status` 或 `status: "failed"` → 502（不以 HTTP 200 推断成功）。
- 流式：HTTP 200 + `text/event-stream`，逐条转发上游 `event:`/`data:` 帧。
  上游 `error` 事件**不原样转发**，换成网关固定文案的 `event: error`。
- 错误：HTTP 4xx/5xx + `{ "error": { "message", "type", "code" } }`。
  流已经开始后无法改状态码，改为在流里补一个 `event: error` 事件。

上游 Responses 事件与网关行为：

| 事件 | 网关行为 |
| --- | --- |
| `response.created` | 透传 |
| `response.output_item.added` | 透传（`function_call` 含 name/call_id/id） |
| `response.output_text.delta` | 透传 |
| `response.function_call_arguments.delta` / `.done` | 透传 |
| `response.output_item.done` | 透传 |
| `response.completed` | 透传；**唯一成功终态** |
| `response.incomplete` / `response.failed` | 透传；已知终态但**不是成功**，随后补 `event: error`（`upstream_incomplete`） |
| `error` | 不透传原文；换 `event: error`（`upstream_error`），保守保留预占 |

**没有终态事件就断开 = 截断**（`upstream_truncated`，结算 `unknown`），绝不因为"已收到
200 与若干 delta"推断成功。

状态码与 `code`：

| 状态 | code | 触发条件 |
| --- | --- | --- |
| 400 | `invalid_request_error` | 字段白名单/类型/长度不合法、`max_output_tokens` 超硬上限、`store:true`、状态类/归因类字段 |
| 400 | `input_too_large` | 输入保守估算超过硬上限（**不截断预占**）；或 `tools`/`tool_choice` 无法计量 |
| 400 | `missing_revision` | 缺 `x-myrix-revision`（fail-closed，不猜当前 rev） |
| 400 | `invalid_session` | 缺/非法 `x-myrix-session` |
| 401 | `unknown_cell_credential` / `missing_cell_credential` | 凭据解析不到 |
| 403 | `not_authorized` / `cross_tenant_session` / `wrong_cell` / `session_not_active` | 治理判定拒绝 |
| 403 | `model_not_allowed` | `model` 不在部署 allowlist |
| 404 | `not_found` | 未注册路径（含旧 `chat/completions`）；**不保留兼容入口** |
| 409 | `request_id_reused` | 同一 `requestId` 已在使用；网关不重放响应 |
| 413 | `payload_too_large` | 正文超过 `MYRIX_GATEWAY_MAX_BODY_BYTES` |
| 429 | `insufficient_quota` | 租户/用户/会话额度或并发闸门 |
| 429 | `upstream_rate_limited` | 上游 429 |
| 502 | `upstream_error` / `upstream_rejected` | 上游 5xx / 4xx（正文不透传）、响应缺终态、上游 `failed` 或重定向 |
| 503 | `model_not_configured` | 未配置上游密钥；**不预占、不降级** |
| 504 | `upstream_timeout` | 上游超时 |
| 499 | `client_closed_request` | 客户端在请求到达上游前断开 |

流内的错误事件 code：`session_revoked`、`client_aborted`、`upstream_timeout`、
`upstream_protocol_error`、`upstream_truncated`、`upstream_incomplete`、`upstream_error`。

### `GET /healthz`、`GET /readyz`、`GET /v1/models`

`/readyz` 返回 `{ ready, upstreamConfigured, models, reason? }`（未配置密钥 → 503，不含密钥）。
`/v1/models` 只列 allowlist，供客户端发现可用模型。

### 未注册路径（含旧协议）

`setNotFoundHandler` 对任何未注册路径返回 404 `not_found`，文案点名 `POST /v1/responses`。
**不存在** `/v1/chat/completions` 路由、兼容层或隐式转换；回归测试断言旧路径 /
旧变体 / 旧字段都不会触达上游。

## 计量与结算语义

| 场景 | outcome | 计费 |
| --- | --- | --- |
| 有真实 usage 且收到终态事件/`status` | `settled` | **真实 `input+output` 全额计入**；小于预占时退回差额，大于预占时 `refunded=0` 且超额部分进入窗口统计 |
| 无 usage / 断流 / 上游 5xx / 撤权 / 超时 / 无终态 | `unknown` | 按**预占量**计，不退款（保守保留） |
| 上游 4xx（非 429） | `released` | 0（请求未产生生成） |
| 客户端在到达上游前断开 | `released` | 0 |
| 额度/并发闸门拒绝 | 无预占行 | 0，且不调用上游 |
| 输入估算超过硬上限 | 无预占行 | 400 `input_too_large`，**不降低预占** |

`response.incomplete` / `response.failed` 若携带真实 usage，按 `settled` 计费（token 确实产生），
但 HTTP/流式层面仍以错误呈现 —— "已知真实用量不截断"与"不把失败当成功"同时成立。

**Responses usage → 账本字段映射**：

| Responses | 账本 / 审计 |
| --- | --- |
| `usage.input_tokens` | `prompt_tokens` |
| `usage.output_tokens` | `completion_tokens` |
| `usage.total_tokens` | 取 `max(声明值, input+output)`（上游报小时不少计） |
| `input_tokens_details.cached_tokens` | 审计 `cachedTokens`（已含在 input 内，**不扣减**） |
| `output_tokens_details.reasoning_tokens` | 审计 `reasoningTokens`（已含在 output 内，**不扣减**） |

**预占量 = 输入保守估算 + 本次输出预算，不做任何截断。**
输入估算按 **UTF-8 字节**计算：`input` 三类项的正文与结构字段（role/name/call_id/arguments/output）、
`instructions`，以及 `tools`/`tool_choice` 的 JSON 成本都计入，默认系数
`DEFAULT_BYTES_PER_TOKEN = 3`（3 字节/token）。网关**没有上游 tokenizer，不声称精确换算**；
该系数只是保守下界：英文约 3.5–4 字节/token、中文 3 字节/字约 0.6 token/字，
两种主要文字下都不低于常见真实值。万一个别字符仍被低估，由"结算据实全额入账"兜底。

输入硬上限取部署的正文上限（`ceil(maxBodyBytes / 3)`，默认约 333k token）：
超出即 400 `input_too_large`。合法请求本就受 `MYRIX_GATEWAY_MAX_BODY_BYTES` 约束，
因此不会被误拒；该上限只对"绕过 HTTP 层直接调用 `ModelGateway`"这条路径起 fail-closed 兜底。

**预占是防超卖的闸门，不是计费上限。** 真实 usage 完整写入 `consumed_tokens`
（允许 `consumed_tokens > reserved_tokens`，迁移 0001 移除了旧的
`consumed_tokens <= reserved_tokens` 约束并新增 `total_tokens` 列用于对账）。
超出预占的部分会在**下一次**预占时由窗口统计体现：该租户/用户/会话随后收到 429，
直到滚动窗口滑出。

账本主键 `(tenant_id, request_id)`：重复预占 → 409；重复结算 → 幂等返回既有结果。
内存账本与 PG 账本对同一序列（含超额结算）给出相同结果，由 PG 测试断言。

审计记录（`GatewayAuditRecord`）字段：`requestId / tenantId / userId / sessionId / cellId /
requestedModel / upstreamModel / stream / status / outcome / reservedTokens / consumedTokens /
promptTokens? / completionTokens? / cachedTokens? / reasoningTokens? / latencyMs / reason?`。
**不含**请求正文与任何密钥。

## 上游转发边界

- 上游 URL（完整 `/responses`）/ 模型 / 密钥**只来自部署配置**；客户端无法指定，
  请求里的 `model` 只用于 allowlist 校验，转发用的模型名恒等于配置值。
- 出站正文恒含 `store:false`；只发网关构造的字段，不转发任何客户端头或字段。
- **拒绝重定向**（`redirect: "error"` + 3xx 双保险）：跟随重定向会把上游密钥带到别的 origin。
- 上游 4xx 正文与连接异常 message **一律不回显**（只回固定分类文案）。
- 提前退出/超限/abort 时 **cancel** 上游响应流，不只是 `releaseLock()`。

## 端口与装配

```ts
// 运行期协议与端口（不依赖 kysely/pg）
import { createAuthorizer, createModelGatewayServer, ModelGateway } from "@myrix/model-gateway";
// 数据库装配（Kysely + pg），仅在需要 Postgres 账本/凭据时导入
import {
  createPostgresCredentialAdmin, createPostgresCredentialResolver,
  createPostgresLedger, createPortFromReaders, migrateToLatest, usageForTenant,
} from "@myrix/model-gateway/db";
```

> 两个入口互不 re-export：`.` 是纯协议/端口，`./db` 才引入 `kysely`/`pg`。

1. `createPostgresLedger(db, { policy })` → `LedgerPort`（账本，schema `myrix_gateway`）。
2. `createPostgresCredentialResolver(db)` → 运行期凭据解析（`resolve_cell_credential` 函数）。
   登记/撤销凭据用 **owner 角色**的 `createPostgresCredentialAdmin(db)`；应用角色故意无表权限。
   同一 token 只能重启用原 `(tenantId, cellId)`；换归属的 upsert 被拒绝。
3. 业务 store 提供 `loadSessionBinding(tenantId, sessionId)` 与 `loadMember(tenantId, userId)`；
   用 `createPortFromReaders({ credentials, business })` 合成 `AuthorizerPort`。
4. `createGatewayRuntime({ authorizerPort, ledger })` 或 `createAuthorizer(port)` + `new ModelGateway(...)`。
5. `createModelGatewayServer({ gateway, bodyLimitBytes })` 起 Fastify。

`ModelGateway` 的入口方法是 **`handleResponse(input)`**（原 `handleChatCompletion` 已移除）。

`AuthorizerPort` 三个方法都必须用传入的 `tenantId` 设置业务库 RLS 上下文
（该 `tenantId` 来自凭据绑定，不是请求头）：

```ts
export interface AuthorizerPort {
  resolveCredential(token: string): Promise<CellCredentialBinding | undefined>;
  loadSessionBinding(tenantId: string, sessionId: string): Promise<SessionBindingSnapshot | undefined>;
  loadMember(tenantId: string, userId: string): Promise<PlatformMember | undefined>;
}
```

依赖仍在开发的业务 store 时，先注入 `MemoryAuthorizerStore`（`src/authorize.ts`）
做联调；生产缺失端口会**启动即抛错**，不会静默放行。

## 数据库（schema `myrix_gateway`）

| 对象 | 说明 |
| --- | --- |
| `myrix_gateway.cell_credentials` | 令牌 SHA-256 → `(tenant_id, cell_id)`，`status` 可 disabled；**不授权给应用角色** |
| `myrix_gateway.quota_reservations` | 预占/结算账本，FORCE RLS + 非 owner 应用角色，主键 `(tenant_id, request_id)`；`consumed_tokens` 可大于 `reserved_tokens`（据实结算），`total_tokens` 记录上游声明总量 |
| `myrix_gateway.schema_migrations` | 迁移记录（不授权给应用角色） |
| `myrix_gateway.resolve_cell_credential(text)` | SECURITY DEFINER，按摘要精确解析单行（内建 `lookup_hash` 策略开口） |
| `myrix_gateway.current_tenant()` / `current_actor()` | 事务级租户/操作者上下文 |

**Responses 迁移不修改任何数据库对象**：只是把上游 `usage` 换成 Responses 字段名，
账本内部列保持不变（迁移仍是 `0000_gateway.sql` 与 `0001_honest_settlement.sql`）。

角色 `myrix_gateway_app`：`NOSUPERUSER / NOBYPASSRLS / NOCREATEDB / NOCREATEROLE`，且不是表 owner。
`myrix_app`（业务库角色）无法访问 `myrix_gateway` schema；两个 schema 各自独立部署、各跑各的迁移。

## 测试

```bash
pnpm vitest run apps/model-gateway/tests            # 单测（fake upstream + 内存账本），默认跑
pnpm --filter @myrix/model-gateway smoke            # 端到端冒烟（真实 HTTP 假上游）
MYRIX_GATEWAY_TEST_DATABASE_URL=postgres://myrix_migrator:...@127.0.0.1:55439/myrix \
  pnpm vitest run apps/model-gateway/tests/pg       # Postgres 集成测试（opt-in）
```

- 单测用 `tests/fakes.ts` 的明确 fake upstream 验证 Responses 协议（事件转发、工具调用
  delta/done、usage 映射、abort、截断、撤权轮询），**不把替身当真实 Postgres 验收**。
- 冒烟脚本走真实 socket：Responses 流式/非流式、**旧协议 404**、缺密钥 503、
  真实 usage 结算、客户端断开时上游连接被取消。
- PG 测试默认跳过，连接串在本地指向 `127.0.0.1:55439`：
  - `tests/pg/ledger.pg.test.ts`：以 `options: -c role=myrix_gateway_app` 连接，覆盖 RLS 负例、
    并发不超卖、幂等、据实结算、凭据归属不可改写。
  - `tests/pg/ledger-login.pg.test.ts`：**真实 LOGIN 非 owner 角色**验收。它在本地 Postgres 上
    创建**随机命名的自有 fixture 库**与随机 LOGIN 角色（通过成员关系获得与 `myrix_gateway_app`
    相同的授权），断言 `session_user = current_user`、RLS 生效、超额结算完整入账，
    以及内存/PG 账本对同一序列结果一致；跑完即删，
    **不 drop/reset `myrix` / `myrix_bff_acceptance`**，也不改既有角色属性。
  - `tests/business-reader.integration.test.ts`：真实业务 LOGIN + 随机网关 LOGIN 组合验收。
- 未设置该变量时 `pnpm test` 完全跳过 PG 部分，不需要本地数据库。

### 关于 `set local role` 与 RLS（更正旧说法）

- RLS 策略按 **`current_user`** 判定，`set local role`（或启动参数 `-c role=...`）会把
  `current_user` 换成目标角色，`is_superuser` 也随之变 `off`。因此这里的隔离断言
  **是真实生效的**，不是假绿。
- 真正的区别在**登录身份**：`set local role` 之后 `session_user` 仍是迁移/superuser 角色，
  所以它证明不了"生产用一个真实登录的 LOGIN 角色连接"这条链路。
  真实登录验收必须另开连接，见 `tests/pg/ledger-login.pg.test.ts`。

## 未做（当前范围外）

- **真实上游 `/v1/responses` 端到端验收**：需要部署环境与显式凭据，按
  [验证方法](../testing/acceptance.md)单独执行；不要用本地 fixture 的成功推断上游可用性。
  BFF/开发装配、部署清单与 `plugins/myrix-llm-gateway` 的协议切换见[集成入口](../integration/dsh-seams.md)。
- 内容安全 / 提示词审计（ADR-0004 划给企业网关）。
- 多上游、多供应商路由、按模型分账定价（当前单上游单模型，价格表未纳入）。
- `unknown` 结算的冲正 UI（需要在管理后台提供对账入口）。
- 控制面 push 撤权（当前靠轮询）。
