# `myrix-llm-gateway`：Cell 侧 LLM provider adapter（OpenAI Responses）

> 状态：**Responses 迁移完成，测试通过**（2026-10-01）。范围：`plugins/myrix-llm-gateway/**` 与本文档。
> 标注：**[实测]** = 本仓库测试真实跑出来的结果；**[源码]** = 只读对照
> `vendor/deepseek-harness`（submodule 提交 `639ed015397290b3745d163aafe02ffee4aa3f84`，
> 即 `@deepseek-ai/dsh@0.2.0-rc.2`）；**[未验证]** = 明确没做的事。
> 本文不改 `tech-design-v1.md` 与 `platform-plan-v2.md` 的任何设计决策。

---

## 0. 一句话

`myrix-llm-gateway` 是一个**真实的 Cordis function plugin**：它把 DSH 的普通对话调用与压缩/
标题等辅助调用，按**进程内权威身份表的会话归因**强制转发到 `apps/model-gateway` 的
OpenAI **Responses** 端点（`POST <baseURL>/responses`），并忠实翻译流式文本、reasoning 摘要、
工具调用分片、真实 `usage`、Responses 终态（completed/incomplete/failed/error）与调用方取消。

它**不**提供任何绕过网关的路径，**没有**"网关不可用时的降级"或本地模拟，也**没有**
`chat/completions` 回退。仓库层面禁止 `chat/completions`（AGENTS.md 硬性规则 6）：
配置成旧协议会在启动时被显式拒绝。

---

## 1. 公开面（给 Lead 对接用）

| 项 | 值 |
|---|---|
| 包名 | `@myrix/llm-gateway`（`plugins/myrix-llm-gateway`，`main: ./src/index.ts`） |
| Cordis 插件名 | `myrix-llm-gateway`（function plugin：具名导出 `name`/`inject`/`apply`，**无** default export） |
| 依赖服务（`inject`） | `llm`、`principals` —— 缺任一个插件不激活 |
| **provider route id** | 默认 `myrix-gateway`，由 `providers` 配置覆盖（会出现在会话的 `request/header` 与 `GenerateOptions.provider`） |
| **model 命名** | 由部署的 `models` 清单显式给定，例如 `myrix-chat`；未列出的一律拒绝（无前缀通配、无默认模型） |
| 上游协议 | OpenAI **Responses**：`POST <baseURL>/responses`（SSE 流式 + 非流式 `output` 数组） |
| 请求体 | `{model, input[], instructions?, tools?, max_output_tokens?, stream, store:false}` —— **无状态完整历史** |
| 上下文容量 | 每个模型**必须**有确切 `contextWindow`（`dsh-compaction-basic` 的硬依赖） |
| Cell 凭据 | `Authorization: Bearer <cell 服务令牌>`；令牌**只**在 Cell 内，上游密钥只在网关进程 |
| 归因头 | `x-myrix-session`、`x-myrix-revision`、`x-myrix-cell-tenant`（诊断）、`x-myrix-purpose`（辅助调用） |

### 1.1 Config schema（cordis.yml / patch 的 `config:` 段）

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `baseURL` | `string` | **是** | — | 网关 **origin**（可带路径前缀，例如 `https://gw.internal/v1`）；适配器追加 `/responses`。只允许 https（loopback 允许 http） |
| `cellToken` | `string` | 二选一 | — | Cell 服务令牌字面量（建议用 `!!js process.env.X`）；也可加载后 `__setCellToken()` 注入 |
| `providers` | `string[]` | 否 | `['myrix-gateway']` | 注册的 provider route id |
| `models` | `string[]` | **是** | — | 允许的模型清单；**空数组即启动失败** |
| `isModelAllowed` | `(model) => boolean` | 否 | — | 动态 allowlist（覆盖 `models`），便于接控制面策略快照 |
| `contextWindow` | `number` | **是** | — | 未在 `modelContextWindows` 单独指定的模型的上下文容量 |
| `modelContextWindows` | `Record<string, number>` | 否 | — | 按模型覆盖容量 |
| `sessionHeader` | `string` | 否 | `x-myrix-session` | 会话归因头名 |
| `revisionHeader` | `string` | 否 | `x-myrix-revision` | 撤权版本头名 |
| `purposeHeader` | `string` | 否 | `x-myrix-purpose` | 辅助调用分类头名 |
| `tenantHeader` | `string` | 否 | `x-myrix-cell-tenant` | 本适配器归属租户（仅诊断；网关**不**信它） |
| `modelAliases` | `Record<string,string>` | 否 | `{}` | DSH 模型名 → 上游模型名；不改归因 |
| `requestTimeoutMs` | `number` | 否 | `600000` | **整次请求**（含流式读取）超时 → `TIMEOUT` |
| `streamIdleTimeoutMs` | `number` | 否 | `60000` | 两次上游 SSE 事件之间最长间隔 → `TIMEOUT`；`0` 关闭 |
| `maxResponseBytes` | `number` | 否 | `8388608` | 响应体字节上限（流式与非流式都生效） |
| `defaultMaxTokens` | `number` | 否 | — | 调用方没给 `maxTokens` 时的 `max_output_tokens` |
| `toolStrict` | `boolean` | 否 | `false` | 是否给 function 工具声明加 `strict: true`（需上游支持） |
| `onRequest` | `(record) => void` | 否 | — | 诊断回调（不含正文/令牌/提示词） |

**启动即失败**（fail-closed，插件不激活）：缺 `baseURL` / 缺令牌 / 非 loopback 的明文 http /
`baseURL` 带凭据或查询串 / `baseURL` 指向 `chat/completions`（禁止旧协议）/
`baseURL` 已含 `/responses`（要求给 origin，避免双写）/ `models` 为空 / 缺 `contextWindow` /
头名非法。

### 1.2 部署 patch 示例

```yaml
- insert:
    - id: myrix-principals
      name: '@myrix/principals'

    - id: myrix-llm-gateway
      name: '@myrix/llm-gateway'
      config:
        baseURL: !!js process.env.MYRIX_GATEWAY_URL            # 网关 origin，例如 https://gw.internal/v1
        cellToken: !!js process.env.MYRIX_CELL_TOKEN           # 由 Secret 注入，不写进配置文件
        providers: [myrix-gateway]
        models:
          - myrix-chat
          - myrix-long
        contextWindow: 131072
        modelContextWindows:
          myrix-long: 262144
        modelAliases:
          myrix-chat: deepseek-chat
```

> 端点由适配器追加：`MYRIX_GATEWAY_URL=https://gw.internal/v1`
> → `POST https://gw.internal/v1/responses`。
> 本地联调 `http://127.0.0.1:3123/v1` → `POST http://127.0.0.1:3123/v1/responses`。

装配方若在加载后才拿到令牌（例如 Secret 挂载晚于 profile 加载），可在自己的插件里
`ctx.inject(['myrix-llm-gateway'], ...)` 之后调用 `apply()` 的返回值：

```ts
import { apply as installGateway } from '@myrix/llm-gateway'

const gateway = installGateway(ctx, config)          // 此时 config.cellToken 可留空
gateway.setCellToken(await readSecret('cell-token')) // 令牌轮转同样走这里
```

> 用 Loader 行加载（`name: '@myrix/llm-gateway'`）时拿不到该返回值，此时应在配置里给
> `cellToken`（推荐 `!!js process.env.MYRIX_CELL_TOKEN`）。两条路径都在**启动时**断言令牌
> 存在：缺令牌 = 插件不激活。

---

## 2. 归因模型（安全核心）

`stream(options)` 的顺序是固定的，**先归因，再取令牌，最后才可能发出网络请求**。
这个检查在**每一次**主调用与压缩/标题辅助调用之前都会执行：

```text
options.sessionId
   └─ ctx.principals.requireBySession(sid)      ← 唯一的会话来源
        ├─ 缺 sid / 未绑定 / 已撤权 / 活性不可用 / 活性抛错 → 抛 PrincipalDeniedError（0 字节外发）
        └─ { sid, tid, sub, wid, preset, rev }
             └─ 每次请求重新解析：不缓存 Principal，不缓存 rev → 撤权在下一次调用立刻生效
```

要点：

1. **模型参数无法改写归因。** 请求头只由 `requireBySession` 的返回值构造；消息正文、
   工具参数都进不了头。**[实测]** 用例把
   `x-myrix-session: sid-attacker` 之类的文本塞进正文后，到达 fake 网关的头仍是权威值，
   且 `x-myrix-*` 头恰好三个（无注入头）。
2. **模型 allowlist 在归因之后、发请求之前判定**，不在清单即拒绝。
3. **上游密钥永不进入 Cell。** 适配器只持有 cell 服务令牌；令牌出现在 `Authorization`
   头里，且在构造任何外发错误文本前都会被 `[REDACTED]` 遮蔽。**[实测]** 两条路径都覆盖：
   HTTP 错误体回显令牌、**流内错误事件**回显令牌（后者经 `sanitizeChunk` 兜底，因为它由
   翻译器直接产出 chunk 而不是抛出）。
4. **重定向一律拒绝。** `fetch` 固定 `redirect: 'error'`：带 cell 令牌与归因头的请求不会
   被 307/302 转发到另一个 origin。**[实测]** 用一个 307 指向第二个 loopback 服务，后者
   收到 **0 个请求**。
5. **没有旁路。** 代码里没有"直连上游"的分支；网关不可用就是失败。

---

## 3. 协议翻译（Responses）

### 3.1 请求：DSH → Responses `input`

| DSH 输入 | Responses 请求 |
|---|---|
| `GenerateOptions.system` | 顶层 `instructions`（不重复进 `input`） |
| `system` 消息 | `{role:'system', content:[{type:'input_text',…}]}`（保留原角色） |
| `developer` 消息 | `{role:'developer', content:[{type:'input_text',…}]}`（**保留 developer 角色**，不折进 system）；`tool-addition/removal` 不转发（适配器始终发送完整工具表） |
| `user` | `{role:'user', content:[{type:'input_text',…}]}` |
| `assistant` 文本 | `{role:'assistant', content:[{type:'output_text',…}]}` |
| `assistant` `tool-call` | `{type:'function_call', call_id, name, arguments}`（`arguments` 保持原始 JSON 字符串） |
| `assistant` `reasoning` | **不回放**（无状态 Responses 需要 reasoning item 的 `encrypted_content`/item id，本适配器刻意不持有该状态） |
| `tool` 结果 | `{type:'function_call_output', call_id, output}` |
| `tools`（`ToolSchema`） | `{type:'function', name, description, parameters, strict?}`（**扁平**，无嵌套 `function`） |
| `maxTokens` | `max_output_tokens` |
| `sessionId` / `purpose` | **请求头**（不是正文） |
| `stream` / `store` | `stream:true|false` / 恒 `store:false` |

**协议事实（与旧 chat/completions 适配器的差异，不是遗漏）：**

* Responses **没有 `stop` 字段**；`temperature` 也不在本适配器白名单内 —— 两者都不发送。
* **永远**不发送 `previous_response_id` / `conversation` / `background`：每轮都是完整历史，
  服务端不持有任何会话状态。

### 3.2 响应：Responses 事件 → DSH chunk

| Responses 事件 | DSH chunk |
|---|---|
| `response.output_item.added`（`message` / `reasoning` / `function_call`） | `block-start`（索引按首次出现顺序分配） |
| `response.output_text.delta` / `response.refusal.delta` | `text-delta` |
| `response.reasoning_summary_text.delta` / `response.reasoning_text.delta` | `reasoning-delta` |
| `response.function_call_arguments.delta` | `tool-call-delta`（保持原始 JSON 字符串） |
| `response.output_item.done` | 必要时补发差额 delta，然后 `block-end`（携带权威完整块） |
| `response.completed`（`usage`） | `usage`（只发一次）→ `finish`（`stop`，或 `tool-calls`） |
| `response.incomplete` | `max_output_tokens` → `finish:max-tokens`；其他原因 → `finish:error(INVALID_RESPONSE)` |
| `response.failed` / 流内 `error` | `finish:error`，错误码经分类（`session_revoked`→`AUTH`、额度→`QUOTA`、限速→`RATE_LIMIT`…） |
| `response.created` / `in_progress` / `content_part.*` 等信息性事件 | 安全忽略（不携带用户可见内容） |

**实现约束（都有测试）：**

* **相关性双保险**：块按事件的 `output_index` 关联（缺失时退回 `item_id`），并交叉校验
  `item_id` / `call_id`。两个交错到达的 `function_call` 分片不会串台；同一 `output_index`
  上出现冲突类型或不同 `item_id` → `INVALID_RESPONSE`。
* **重复载荷不重复发**：`function_call_arguments.done` 与 `output_item.done` 会重复完整
  参数/文本。适配器只在权威值**严格延长**已发出内容时补发差额；权威完整值只通过一次
  `block-end` 给出。**[实测]** 分片拼接总量等于完整载荷，不多不少。
* **`usage` 早于 `finish`，且只发一次**；互斥口径：
  `inputTokens = input_tokens − cached − cache_write`（缓存单列 `cacheReadTokens`），
  `outputTokens = output_tokens`，`reasoningTokens = output_tokens_details.reasoning_tokens`
  （推理是输出的**子集**明细，不从中扣除）。
* **终态必须显式**：只有 `response.completed` 算成功。流在终态事件之前结束（`[DONE]`/EOF/
  中途断开）→ 先 `block-end`，再发 `TRANSPORT` **失败** finish，绝不假装正常结束。
* **无界输出类型不静默丢弃**：`computer_call` 等本适配器无法表达的 item → `UNSUPPORTED_CONTENT`
  显式失败（宁可报错，也不静默吞掉模型输出）。
* `resolveModel` 声明 `inputModalities: ['text']`，因此 DSH 会把图片/文件投影成确定性
  占位文本再下发；适配器本体只收到文本，图片字节永远不会发给网关（**[实测]**）。

### 3.3 边界与取消

* **整次请求超时**（`requestTimeoutMs`）：发起前武装，覆盖连接到流结束。
* **空闲看门狗**（`streamIdleTimeoutMs`）：在**逐次读取**上计时 —— "上游半天不说话"与
  "整次太久"是两种故障，分别产生 `TIMEOUT`。
* **字节上限**（`maxResponseBytes`）：流式累计超过即失败，不无限缓冲；非流式先看
  `content-length`，再累计实际字节。
* **reader 取消**：任何提前退出（abort / 协议错误 / 字节超限）都在 `finally` 里
  `reader.cancel()` + `releaseLock()`，让上游 socket 立刻关闭。
  **[实测]** fake 网关观察到连接在响应结束前中断。

---

## 4. 测试与证据

```bash
# 单测 + 真实 DSH smoke（55 项）
npx vitest run plugins/myrix-llm-gateway/tests

# 只跑真实 DSH smoke（需要 tests/poc/.dsh-install，见 runtime-poc.md §1）
npx vitest run plugins/myrix-llm-gateway/tests/smoke.dsh.test.ts

# 只跑本插件的类型检查
npx tsc -p plugins/myrix-llm-gateway/tsconfig.json
```

**[实测] 结果：`Test Files 2 passed (2) / Tests 55 passed (55)`**（单测约 0.5s，smoke 约 16s）。

### 4.1 单测（`tests/adapter.test.ts`，52 项）

跑在**真实 Cordis**（`Context` + `LlmRuntime` + `PrincipalRegistry`）与**真实 HTTP**
（`tests/fake-gateway.ts` 的 loopback 服务，**Responses** 协议）之上；唯一的替身是"模型网关"
这个外部对端（**不是**伪 LLM：链路里没有模拟模型的分支）。覆盖：

* 走 `/v1/responses`；body 是 Responses 形状，且**断言不含**任何 chat/completions 字段
  （`messages`/`max_tokens`/`stream_options`）与有状态续接字段
  （`previous_response_id`/`conversation`/`background`）；
* 归因头正确；`purpose=compaction` 转发；模型参数无法改写归因；
* 缺 `sessionId` / 未绑定 / 撤权 / 未安装活性判定 / 模型不在清单 → **fake 网关收到 0 个请求**；
* 编码：`system`→`instructions`；`developer` 保留角色；助手历史 →
  `output_text`/`function_call`；工具结果 → `function_call_output`；扁平 tools + `strict`；
  非文本块显式失败；
* 流式文本、reasoning 摘要、跨事件工具归并、两个交错工具调用不串台、只有 done 事件也能产出；
* `usage` 只发一次、在 `finish` 之前、按互斥口径换算；上游无 usage 时不产生 usage chunk；
* 终态矩阵：`completed`→stop；`incomplete(max_output_tokens)`→max-tokens；
  其他 incomplete / `failed` / 流内 `error` / 终态前 EOF → 显式失败且分类正确；
* 冲突类型、item id 漂移、非 JSON data 行、无法表达的输出类型 → `INVALID_RESPONSE`/`UNSUPPORTED_CONTENT`；
* HTTP 403/503/429（额度 vs 速率）分类正确；**错误信息不含 cell 令牌**（含流内错误路径）；
* **重定向被拒绝**：307 目标收到 0 个请求；
* 调用方 `abort`、整次超时、空闲看门狗、字节上限 → 都收敛成终态且**真实断开上游**；
* 非流式 `output` 数组产出与流式等价；`resolveModel` 给出确切 `contextWindow`；模型别名只改转发名。

### 4.2 真实 DSH smoke（`tests/smoke.dsh.test.ts`，3 项）

把插件作为**正常 profile 行**挂进锁定版 DSH（真实 `apply` + fail-closed 校验 +
`ctx.llm.registerAdapter`），用**真实 agent loop**与**真实压缩引擎**发起调用。
判定标准是**到达 fake 网关的真实 HTTP 请求头**与会话日志事件。

**[实测] 证据**（探针报告由 fixture 临时 home 承载，用完即删；`MYRIX_SMOKE_KEEP=1` 可保留现场）：

| 断言 | 实测结果 |
|---|---|
| 普通对话：`smoke_main_*` 请求 | `POST /v1/responses`、`authorization: Bearer <token>`、`x-myrix-revision: 9`、`x-myrix-cell-tenant: t_smoke`、无 `x-myrix-purpose`、`store:false`、无 `messages`/`stream_options` |
| 普通对话完成 | `assistant/message` ×1，`turn/end.reason.kind = completed` |
| 无身份会话 | **0 个请求到达网关**，`turn/end.reason = error`，原因 `myrix: 会话没有有效身份（unbound）…` |
| 压缩辅助调用 | `smoke_compact_*` 请求带 `x-myrix-revision: 4` 与 `x-myrix-purpose: compaction` |
| 压缩是否收敛 | `compactNow` 返回"摘要不够小"的**引擎可读原因**（fake 摘要太短，属预期；本 smoke 证明的是归因，不是收敛） |
| 上游 503 | `turn/end.reason = error`，原因含 `HTTP 503`、`model_not_configured`，**不含** cell 令牌；**0 条 assistant 消息**（无降级）。该用例约 15s：这是 **DSH 自身 `llm-retry` 对 `SERVER` 的 5 次退避重试**（500ms→10s），生产行为如此，不是测试拖时间 |
| 缺 cell 令牌 | 插件行不激活，DSH 报可读原因；网关收到 **0 个请求** |

**smoke 的装载与隔离（相对旧版的三处修正）：**

1. **插件以编译后的 JS 进 profile。** 用仓库已有的 `esbuild` 现场编译成单文件 ESM
   （`@deepseek-ai/*` external，`@myrix/principals` 内联；未新增依赖、未改 lockfile）。
   子进程是普通 Node，**不再需要 `NODE_OPTIONS=--experimental-transform-types`** ——
   也就没有"测试用 TS 开关跑通、生产编译后行为不同"的假绿（runtime-poc.md R20）。
2. **私有 fixture `$DSH_HOME`。** 每个用例 `mkdtemp` 一个独立 home 并铺真实布局
   （`profiles/node_modules` symlink、profile 内 `node_modules/@myrix/*`），
   不碰机器上的 `~/.dsh`，并发/重跑不互相删报告。
3. **有界等待 + 环境变量白名单。** 等待以"子进程结束"为界：正常路径由探针在报告写盘后
   `exit(0)`，异常路径由探针自己的看门狗写盘后 `exit(3)`；外围 kill 只是兜底，
   不靠猜时长。子进程只继承**操作系统变量白名单**（`PATH`/`HOME`/`TMPDIR`/代理/证书）
   加显式 DSH 变量，父进程的 `process.env` 不整体注入，本机可能存在的 `MYRIX_*`
   秘密不会流进被测进程。

---

## 5. 为什么没有复用 pinned DSH 的 openai 转换器

`platform-plan` 的要求是"尽量复用官方 provider/adapter 的公开转换器，但如果公共 API 不允许
安全注入 headers，就写明确且测试充分的 adapter"。核对 `vendor@639ed01` 的结果是**后一种**：

| 候选 | 公开面 | 为什么不能直接用于本次需求 |
|---|---|---|
| `@deepseek-ai/dsh-llm-pi-ai` 的 `PiAiAdapter` | 构造参数 `PiAiAdapterOptions` 只有 `profiles`/`resolveApiKey`/`auth`/attachments 钩子 [源码 `packages/llm/llm-pi-ai/src/adapter.ts:74`] | headers 只来自**静态的** `profile.headers` 与 `attributionHeaders()`，二者在构造/解析期固定 [源码 `adapter.ts:205`、`:388`]；`options.sessionId` 只被映射成 pi-ai 的 `sessionId` 选项 [源码 `adapter.ts:384`]，不能变成 `x-myrix-session`，更不能携带**每请求变化**的 `rev` |
| `@deepseek-ai/dsh-llm-deepseek` 的 `DeepSeekAdapter` | 导出 `Config`/`DeepSeekAdapter` [源码 `packages/llm/llm-deepseek/src/index.ts`] | 协议是 DeepSeek Messages（`/anthropic`），与网关的 Responses 协议不同 |
| `@earendil-works/pi-ai` 的 `openai-responses` | `streamSimple(model, context, options)` 且 `StreamOptions.headers` 可传任意头 [源码 pi-ai `dist/api/openai-responses.js`] | 方向不对：那是**网关**该用的上游 SDK，不是 Cell 侧适配器；在 Cell 里用它等于把网关职责搬进 Cell。其 `convertResponsesMessages` / `processResponsesStream` 是**只读参考**，用来核对线协议形状 |

因此本插件自己实现了 `LlmAdapter.stream()` **与** OpenAI Responses 线协议转换，并且：

* 每个请求都重新解析 Principal 与 `rev`（不同会话不同 rev；撤权即时生效）；
* 上游请求头在**每次** `fetch` 时按归因事实构造；
* abort / SSE / 工具调用 / usage / 终态 / 边界超时全部有测试。

**这是明确取舍，不是"绕开公共 API"**：`registerAdapter` 是官方公开的扩展点
[源码 `packages/llm/llm/src/index.ts:396`]，`LlmAdapter` 只强制 `stream()`
[源码 `index.ts:290`]。

---

## 6. 未验证 / 范围外

| 项 | 说明 |
|---|---|
| 真实模型网关（`apps/model-gateway` + Postgres）的 Responses 路由 | **本仓库快照里网关只有 `/v1/chat/completions`**，还没有 `/v1/responses`；因此真实网关联调会 404，直到网关侧补上该路由。本轮验证的是适配器侧（loopback fake + 真实 DSH） |
| 观测到的 `http://127.0.0.1:3123/v1` 404 | 外部端点侧的排查由 Lead 负责；本适配器按用户要求请求 `<origin>/responses`，**没有**静默改回旧协议 |
| 真实上游模型（DeepSeek/OpenAI Responses 端点） | 无 key，未跑；上游侧由网关的 smoke 单独覆盖 |
| `temperature` / `stop` | 不发送（Responses 无 `stop`；`temperature` 不在白名单）。DSH agent loop 若设置 `temperature`，线协议上不会体现 |
| 工具调用历史的 `fc_` item id | 回放只带 `call_id`/`name`/`arguments`（用户指定的形状），不合成 `fc_*` item id |
| 推理回放 | 推理块不进入下一轮 `input`；无状态 Responses 的推理续接需要 `encrypted_content`，本适配器不持有 |
| 图片/多模态 | **明确不支持**：`inputModalities: ['text']`，DSH 侧投影成占位文本 |
| `reasoningEffort` | 不映射到上游（`stream()` 忽略该字段）；`resolveModel` 不声明 `reasoning` 能力 |
| 运行中换/轮转令牌 | `__setCellToken()` 会即时生效（每次请求重新解析），但**未**写自动化测试 |
| 每请求 `rev` 与网关绑定行严格一致 | 由网关侧校验；Cell 侧只保证"把 principals 里的 rev 如实送出"，**未**与真数据库对账 |
| DSH 版本差异 | 一切结论以 submodule `639ed01` / `@deepseek-ai/dsh@0.2.0-rc.2` 为准；`0.1.x` 的适配器面不同 |

### 6.1 给 Lead 的待办

1. **网关侧补 `/v1/responses`**：请求体白名单
   `{model,input,instructions?,tools?,max_output_tokens?,stream,store:false}`、SSE 事件
   （`response.created`/`output_item.added`/`output_text.delta`/`function_call_arguments.*`/
   `output_item.done`/`completed`/`incomplete`/`failed`/`error`）、
   非流式 `output` 数组与 `usage` 形状见 §3。
2. **令牌来源**：推荐 Secret → 环境变量 → `!!js process.env.MYRIX_CELL_TOKEN`；
   若装载顺序不允许，请让 Cell 镜像在加载后用 `apply()` 的返回值注入。
3. **`rev` 的来源**：本适配器用 `principals` 里的 `rev`。生产上该值由
   `myrix-runtime-driver` 依据控制面凭证写入，因此**driver 必须保证**每次撤权都
   同步更新绑定或直接 `revoke(sid, rev)`，否则适配器只会送出旧的 rev（网关会拒绝）。
4. **本适配器之外的旧协议残留**：`tests/poc/lib/stubs.mjs` 的模型 stub 仍只答复
   `/v1/chat/completions`，`bundles/myrix-base/cell.patch.yml` 的 `MYRIX_GATEWAY_URL`
   语义也相应变化（现在应是 origin）。两处都不在本插件的所有权范围内，未改动。
