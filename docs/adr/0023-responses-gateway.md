# ADR-0023：模型网关只讲 OpenAI Responses，且不做 chat/completions 回退

- 状态：已接受（`apps/model-gateway` 已实现）
- 日期：2026-10-01
- 相关：[ADR-0004](./0004-llm-gateway-boundary.md)（模型治理放在 LLM 网关层）、[ADR-0015](./0015-model-accounting.md)（归因、额度与账本边界）、[ADR-0020](./0020-production-assembly.md)（持久运行入口）、`AGENTS.md` 硬性规则 6
- 实现：`apps/model-gateway/src/{protocol,usage,gateway,server,upstream,config}.ts`、`apps/model-gateway/tests/*`
- 接口契约：[docs/implementation/model-gateway.md](../implementation/model-gateway.md)

## 背景

模型网关原先实现的是 OpenAI `chat/completions`：入站 `POST /v1/chat/completions`，
上游是完整 `/chat/completions` URL，SSE 按 `data: {choices:[{delta:…}]}` 解析，结算读
`usage.prompt_tokens` / `usage.completion_tokens`。

三件事要求把它整体换成 **OpenAI Responses**：

1. **用户与仓库规则明确要求**：项目禁止 `chat/completions` 协议，不得保留兼容入口、
   隐式转换或失败回退；模型链路必须是 Responses（或显式实现并验证的 Messages）。
2. **Cell 侧已经按 Responses 冻结契约**（另一个并行 Cell adapter 任务）：
   POST `/v1/responses`，Bearer cell token + `x-myrix-session` + `x-myrix-revision`，
   正文是标准 Responses（`input` 为 role 消息数组 / `function_call` / `function_call_output`，
   可选 `instructions`、`tools`、`tool_choice`、`max_output_tokens`、`stream`、`store:false`）。
3. **"表面上能跑"的风险**：如果只是把 chat 请求**翻译**成 Responses 再转发，或保留旧路径做回退，
   那么"协议真实性"无从验证——任何一侧的字段漂移都会被翻译层悄悄吸收。

同时必须原样保留 ADR-0015 的全部安全不变量：凭据/当前成员/六字段绑定/RLS/额度/审计/撤权/中止，
以及"缺上游密钥在**预占之前** 503"。

## 决策

### 1. 只实现 Responses，旧协议就是 404（没有翻译层）

- 入站只注册 `POST /v1/responses`；`setNotFoundHandler` 对未注册路径返回
  **404 `not_found`**，并在文案里点名 `/v1/responses`。`/v1/chat/completions` 因此是 404。
- **不存在** chat→Responses 或 Responses→chat 的转换代码：上游收到的是网关按 Responses
  白名单构造的 JSON，回给客户端的是上游 Responses 事件逐条转发。
- 上游 URL 必须是**完整** `/responses` 端点（`assertUpstreamUrl`）：
  * 路径不以 `/responses` 结尾 → 启动即失败（不做 base URL 补全，避免掩盖配置错误）；
  * 路径含 `chat/completions` → 启动即失败并点名禁止；
  * 不接受查询串/fragment（避免把参数夹带进上游请求）；
  * 不接受 URL 用户名/密码，避免把认证秘密放进地址，错误文案也不回显这些值。
- 旧字段（`messages` / `max_tokens` / `stream_options` / `n` / `temperature` / …）在
  Responses 白名单外，出现即 **400**，绝不"顺手"接受并转换。

**理由**：协议要么真，要么假。翻译层会让"Cell 说的"和"上游收到的"之间多出一个没有契约的
中间态；一旦上游字段语义变化，翻译层是唯一没人验证的地方。404 让旧客户端立刻、明确地失败，
而不是被静默降级。

### 2. 无状态：`store:false` 恒真，状态类字段一律拒绝

- 出站正文**恒含** `store: false`；入站 `store` 只能是 `false`（缺省也按 false 发送，
  `true` → 400）。
- 显式 400 并给出可读原因的字段：
  * `previous_response_id`、`conversation`、`background` —— 把会话状态留在上游；
  * `user`、`metadata`、`safety_identifier`、`prompt_cache_key` —— 可能覆盖主体归因或缓存主体。

**理由**：ADR-0015 的归因只来自"服务端凭据 + 数据库绑定行"。任何能让客户端把用量/缓存
归到别处的字段都必须拒绝，而不是忽略（忽略会掩盖攻击意图，也让人误以为生效）。

### 3. 转发真实 Responses 事件；没有终态事件就不算成功

流式转发上游 `response.*` 事件（`event:` 行 + `data:` 行逐条透传），关键事件：

| 事件 | 网关行为 |
| --- | --- |
| `response.created` | 透传 |
| `response.output_item.added` | 透传（含 `function_call` 的 name/call_id/id） |
| `response.output_text.delta` | 透传 |
| `response.function_call_arguments.delta` / `.done` | 透传 |
| `response.output_item.done` | 透传 |
| `response.completed` | 透传；**成功终态** |
| `response.incomplete` / `response.failed` | 透传；**已知终态但不是成功** |
| `error` | **不原样转发**（可能含上游内部信息），换成网关固定文案的 `event: error` |

- 只有 `response.completed` 才算成功结束；`incomplete` / `failed` 之后补一个
  `event: error`（`upstream_incomplete`），**不把失败当成功**。
- 流在没有任何终态事件的情况下断开 → `upstream_truncated`，结算 `unknown`（保守保留预占）。
  **绝不因为"已经收到 200 和若干 delta"就推断成功。**
- 非流式同理：响应体必须有终态 `status`，否则 502 + `unknown`；`status: "failed"` 一律错误返回。
- 单个 SSE 事件超过 `maxSseEventBytes`（默认 1 MiB）→ `SseFramingError` → 中止 + `unknown`：
  有界帧解析，不把上游当可信无限缓冲。

### 4. 结算口径：Responses 字段映射到既有账本，缓存/推理只作审计

| Responses | 账本 |
| --- | --- |
| `usage.input_tokens` | `prompt_tokens` |
| `usage.output_tokens` | `completion_tokens` |
| `total_tokens` | `max(上游声明值, input+output)` —— 上游报小时不少计 |
| `input_tokens_details.cached_tokens` | **仅审计元数据**（已含在 input 内） |
| `output_tokens_details.reasoning_tokens` | **仅审计元数据**（已含在 output 内） |

- `cached_tokens` / `reasoning_tokens` **不参与扣减**：它们已经包含在 input/output 之内，
  再扣一次等于少计。审计记录新增 `cachedTokens` / `reasoningTokens` 两个可选字段。
- 结算语义保持 ADR-0015：真实用量**完整**入账（可超预占）；`unknown` 按预占保守保留；
  上游 4xx（非 429）→ `released` 退款；缺 key 在预占之前 503，**不触碰任何额度**。
- **不修改迁移**、不新增账本列；Responses 只是把 `usage` 换成新的字段名，账本内部
  (`reserved/prompt/completion/total/consumed`) 完全不变。

### 5. 传输层加固：拒绝重定向、异常文案不外泄、提前退出必须 cancel

- 上游 `fetch` 用 `redirect: "error"`，并在客户端里对 3xx 再挡一次：
  跟随重定向会把 `Authorization: Bearer <上游密钥>` 送到另一个 origin，等于泄露密钥。
- 连接失败的 reason 是固定文案，**不回显**上游异常 message（可能含 URL/主机名）；
  上游 4xx 的正文从不透传（只回固定 `upstream_rejected`）。
- `readResponseBody` / `readLimitedText` 在提前退出、超限或 abort 时 **cancel** reader，
  不只是 `releaseLock()`：否则上游会继续往一个没人读的流里写（浪费额度、延迟取消传播）。

### 6. 配置命名：内部名保留、公开体是 Responses

`MYRIX_GATEWAY_MAX_OUTPUT_TOKENS` / `DEFAULT_MAX_OUTPUT_TOKENS` / `MODEL_ALLOWLIST` /
`UPSTREAM_*` 等部署配置名保持不变（运维面无需变更）；但**公开请求体字段是
`max_output_tokens`**（Responses 标准），不是 `max_tokens`。`limits` 结构体里
`maxMessages/maxMessageChars` 更名为 `maxInputItems/maxInputChars`（内部名，反映 Responses 的
`input` 项语义），并新增 `maxSseEventBytes`。

## 保留不变的安全不变量

以下全部原样保留（逐条有测试）：

1. 凭据 → `(tenantId, cellId)`；会话绑定行必须是**当前**状态、`active`、`cellId` 匹配、
   `rev` 匹配、成员 active（`@myrix/governance` 的 `authorizePlatform`）。
2. 请求头 `x-myrix-tenant` / `x-myrix-user` / `x-myrix-purpose` 等一律忽略；
   主体只来自凭据与数据库（诊断头不参与判定）。
3. 六字段绑定、RLS（FORCE ROW LEVEL SECURITY 在真实 LOGIN 下生效）、跨租户 requestId 拒绝。
4. 额度预占（租户/用户/会话 + 并发）→ 429，且不触达上游；`requestId` 幂等 → 409。
5. 流式期间按 `revokePollMs` 轮询撤权 → abort 上游 + `session_revoked` + `unknown`。
6. 审计只含计量元数据，**不含正文与密钥**。
7. 缺上游密钥 → 503 `model_not_configured`，且发生在预占**之前**。
8. 真实 LOGIN 校验（`session_user = current_user`、非 owner）不被削弱。

## 代价与替代方案

| 方案 | 拒绝理由 |
| --- | --- |
| 保留 `/v1/chat/completions` 作为 legacy 回退 | 与用户要求、AGENTS.md 6 冲突；回退路径会成为没人验证的第二条协议面 |
| 网关内部把 chat 请求翻译成 Responses 再转发 | "看起来能跑"但协议不真实：切换协议时字段语义漂移被翻译层吸收，无法验证上游真的收到了 Responses |
| 只给 base URL 自动补 `/responses` | 掩盖部署配置错误；且历史上有 `chat/completions` 配置，自动补路径会静默改变协议 |
| `store:true` + `previous_response_id` 省 token | 与"网关无状态、归因只来自数据库"冲突；上游保存的会话变成第二份不可治理的状态 |
| 把 `cached_tokens` / `reasoning_tokens` 从计费里扣除 | 它们已含在 input/output 内，扣除等于少计；审计展示足够 |
| 没有终态事件也按"收到 200 + delta"结算 | 截断/中途失败会被当成成功，账本失去可解释性 |
| 流式直接透传上游 `error` 事件 | 上游错误正文可能含内部细节/密钥形状，违反"不回显上游原文" |

## 代价

- **破坏性变更**：旧调用方（若还有）会在 `/v1/chat/completions` 收到 404，必须迁移到
  `/v1/responses`；Cell 侧适配器与开发装配也必须同步（属其他任务范围）。
- 上游必须是真正的 Responses 端点。**本仓库尚未对真实上游 `/v1/responses` 跑过端到端验收**
  （外部端点验证由 Lead 负责）；当前全部证据来自 fixture 上游与真实 HTTP 冒烟。
- `incomplete` 之后网关会补一个 `event: error`，因此客户端可能先看到终态事件再看到错误事件；
  这是"终态不是成功"的显式表达，客户端必须按错误处理。

## 验证范围

自动化验证（`pnpm exec vitest run apps/model-gateway/tests`，110 项通过）：

- **协议**（`protocol.test.ts`）：Responses 白名单；`store` 只能 false；四个状态类字段与四个
  归因类字段分别 400；`input` 三类项（message / function_call / function_call_output）校验；
  `tools`/`tool_choice`/`instructions` 校验；非文本 part 拒绝；SSE 有界帧解析（CRLF、跨块、
  超限 `SseFramingError`）；终止语义（只有 `completed` 成功）。
- **网关**（`gateway.test.ts`）：鉴权/归因/撤权全部负例；缺 key 503 不预占；非流式按 Responses
  usage 结算；cached+reasoning 元数据入账但不扣减；缺 usage/缺 status/`failed` 不推断成功；
  4xx 退款且不回显原文；流式事件转发、工具调用 delta/done、截断 → `unknown`、
  `incomplete` → 据实 + 错误提示、上游 `error` 不外泄、畸形块中止；撤权轮询；大中文预占与据实结算。
- **HTTP**（`server.test.ts`）：`/v1/responses` 流式/非流式/413/400/归因忽略/readyz/models；
  **旧 `chat/completions` 与其它变体一律 404 且不触达上游**；旧字段走新路径 400。
- **上游客户端**（`upstream.test.ts`）：出站头白名单、`redirect:"error"`、3xx 双保险、
  连接失败不回显 URL、缺 key 不发请求、abort 透传、提前退出 cancel。
- **配置**（`config.test.ts`）：缺 URL/model 拒绝启动；URL 必须 https（loopback 可 http）且
  必须以 `/responses` 结尾；chat/completions 端点拒绝；查询串/fragment 拒绝。
- **数据面**（PG opt-in）：`ledger.pg.test.ts` 18 项（含凭据归属不可改写）、
  `ledger-login.pg.test.ts` 真实 LOGIN 4 项、`business-reader.integration.test.ts` 6 项全部通过。
- **真实 HTTP 冒烟**（`scripts/smoke.ts`）：Responses 流式/非流式、旧协议 404、缺密钥 503、
  真实 usage 结算、客户端断开取消上游，13 项全通过。

未覆盖 / 由他人补齐：真实上游 Responses 端点验收（Lead）；BFF/开发装配、部署清单与 Cell 侧
适配器的协议切换（其他任务）；`plugins/**` 中残留的 chat 引用。
