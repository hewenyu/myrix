# ADR-0022：查回执用全新短凭证，Cell 严格一租户，对外错误只给固定安全原因

- 状态：已接受（BFF 侧已实现；driver 侧对 receipt 绑定的签名消费、同六字段活性与回执记录 `sid` 核对由 Lead 补齐验收）
- 日期：2026-10-01
- 相关：[ADR-0010](./0010-grant-es256.md)（ES256 凭证）、[ADR-0012](./0012-platform-authorization.md)（平台授权）、[ADR-0013](./0013-bff-authentication.md)、[ADR-0016](./0016-runtime-driver.md)（runtime driver）、[ADR-0019](./0019-cell-binding-leases.md)
- 实现：`apps/bff/src/runtime-{cells,router,driver-client,stream,config}.ts`、`apps/bff/tests/runtime-*.test.ts`
- 接口契约：[docs/implementation/runtime-driver.md §3](../implementation/runtime-driver.md)、[docs/implementation/bff-runtime.md](../implementation/bff-runtime.md)

## 背景

BFF 运行时（`apps/bff/src/runtime-*.ts`）首版实现后的评审发现四个必须修的问题。它们都属于"看起来能跑、但边界不成立"的类型，因此在这里把决定与理由固定下来。

1. **同一个 cellId 可以被两个租户复用。** `createStaticCellDirectory` 只在"地址/凭据不同"时拒绝重复 cellId；地址相同就放行。但 cellId 就是凭证的 `aud`、也是租户隔离的边界：一个 cellId 服务两个租户，等于把 tenant B 的会话投到 tenant A 的 driver 上，`tid` 绑定形同虚设。而且 `byId(cellId)` 直接返回目录条目，不核对调用方请求的是哪个租户 —— 目录本身是可注入的（`CellDirectory` 是接口），所以"构造期检查"根本管不住别的实现。

2. **超时后查回执复用 POST 的凭证。** `deliver` 在 POST 超时/不可达时调 `getReceipt(cell, command.id, grant.token)`，把投递凭证原样复用。这是错的：该凭证的 `jti` 已经被消费（一次性），复用就是重放；而且它的 `bh` 绑定的是**投递正文**，而 `GET /v1/commands/:id` 没有正文 —— 原样的 `bh` 无法验证一次空 GET。driver 侧当时的实现只能做"Bearer 语法解析"，因此这个错误协议从未被真正验证。

3. **`myrix/assistant-stream` 的 `end`/`abandoned` 没有映射。** 前端 reducer 只认 `stream-start` / `stream-abandoned` 这两个控制 status 来清除"未提交的流式 delta"。DSH 的真实帧是嵌套的 `AssistantStreamFrame`（`{type:'end', outcome:{kind:'abandoned'|'committed'|…}}`），BFF 只映射了 `start`/`chunk`：重试或取消后本轮的未提交片段会在浏览器里与下一轮拼接。同一次评审还确认：`user/message` 的 data **就是** `UserMessage`（不是 `{message:…}`）、`assistant/message` 的 data 是 `{message,stream,usage,…}`、`tool/result` 没有 `toolName`、`request/header` 带 prompt 与工具 schema —— 白名单必须逐字段读，不能整包透传。

4. **driver 客户端会回显上游原始信息，且有界读取不取消连接。** HTTP 失败把 driver 的 `reason` 原文带进外部 reason；连接失败把上游异常 `name` 带出去；`readBoundedText` 与 SSE 帧解析在超限/提前退出时只 `releaseLock()`，不 `cancel()` response body。上游文本可能含 prompt、header、token 或内部异常细节；不取消连接则上游会继续往一个没人读的流里写。

## 决策

### 1. 一 Cell 一租户：构造期拒绝任何重复，取用时再核对租户

- `createStaticCellDirectory` 只要 `cellId` 出现第二次就抛错，**无论地址/凭据是否相同**；同一租户重复条目同样抛错。错误字符串只含 tenantId / cellId，不含 `serviceToken`。
- `CellDirectory.byId(cellId, expectedTenantId)` 的第二个参数是**必填**的请求方租户；实现必须核对 endpoint 确实服务该租户，不匹配返回 `undefined`。
- 导出 `cellServesTenant(endpoint, tenantId)` 作为两侧共用的判定：`runtime-router.ts` 在 `resolveCell`（投递与撤权 outbox）与 `requireCell`（建会话）里都调用它；`undefined` 或不匹配一律按"没有放置"处理（`release` 退避 / 503 `cell_unplaced`）。
- `readRuntimeEnvironment` 在配置解析阶段也拒绝重复 cellId/tenantId；`inspectRuntimeEnvironment` 把"cell 被多个租户复用"列进装配问题清单。
- 理由：目录是可注入的，构造期校验只能约束某一个实现；把租户核对放进接口签名，就没有实现能绕过去。

### 2. 查回执用**全新**短凭证（与 Lead 的冻结契约）

`GET /v1/commands/:commandId` 的路径不变，但每次查询都重新签发一枚凭证：

| claim | 值 |
|---|---|
| `op` | `subscribe`（读语义；**不新增** grantOp） |
| `cmd` | `receipt-<commandId>`（`receiptCommandId()` 派生） |
| `bh` | `sha256(空 Buffer)`（GET 没有正文） |
| `aud`/`boot`/`tid`/`sid`/`sub`/`wid`/`preset`/`rev` | 与**当次**投递的 principal / boot 完全相同 |
| `jti` | 每次签发都是新的（签发方内部生成） |

即：不用被消费过的 POST `jti`，也不用绑定投递正文的 `bh`。因此 driver 侧可以对 receipt 路径做**真实的** `verifyAndConsume(token, {op:'subscribe', cmd:'receipt-<id>', bh:sha256('')})`。

BFF 侧测试用一个**真实验签**的假 driver GET 强制这一点：语法 Bearer、复用 POST grant、错误的 cmd / op / bh / aud / tid / boot 全部被拒；POST 的 jti 被消费后，GET 仍能独立验签通过。driver 侧的负例（unknown receipt / replay / `sid` 不符）由 Lead 在其范围内补齐。

### 3. 事件白名单按字段读；`end` 只映射 `abandoned`

`myrix/assistant-stream`：

- `start` → `{type:'status', status:'stream-start'}`
- `chunk` 且 `chunk.type === 'text-delta'` → `{type:'delta', text}`（无 seq）；`reasoning-delta` / `tool-call-delta` / `block-*` / `usage` / `finish` 一律不投影
- `end` 且 `outcome.kind === 'abandoned'` → `{type:'status', status:'stream-abandoned'}`
- `end` 且 `outcome.kind === 'committed'` → **不投影**：落定正文由持久 `assistant/message` 承载，BFF 绝不自己合成 `assistant.final`
- 形态不合契约的 `end`（缺 outcome / 未知 kind）同样不投影，不能默认当成 `abandoned`

其余白名单保持：`user/message`（data 就是 `UserMessage`，只取 `content` 里的 `text` 块）、`assistant/message`（只取 `data.message.content` 的 `text` 块）、`tool/call`（只给 `toolName` 与 `callId`，不含 `arguments`）、`turn/end`（失败只给固定文案）、`myrix/truncated`（无 seq）。`request/header`、`system/message`、`developer/message`、`assistant/message.stream` 的 reasoning、`assistant/attempt`、`tool/result`（含 `error.reason`）、`myrix/ready`、`myrix/subscribed` 一律不投影。

### 4. driver 客户端：外部原因固定文案，提前结束必须 cancel

- **HTTP 失败**只保留机器可读的 `code`（经 `safeCode` 过滤：短标识符字符，否则丢弃）与状态码；外部 reason 用本模块的固定分类文案（`driver 返回 <status>（凭证或权限被拒 / cell 内部错误 / …）`），**不回显** driver 的 `reason` 原文。
- **连接失败**的 reason 固定为"无法连接 driver（网络错误或连接被拒）"，不带上游异常 name/message。
- `GET /v1/ready` 的 `reason` 去控制字符并截断（它是 driver 自述文案，不是任意上游正文）。
- 重试分类**不变**：5xx / 429 → `retryable: true`；401/403/409 等 4xx → `retryable: false`；`timeout`/`unreachable` → `retryable: true`；`aborted` → `retryable: false`。
- `readBoundedText` 超限（含 `content-length` 声明超限）与 `sseFrames` 提前退出（超限抛错 / abort / 调用方 `return()`）都 **cancel** reader；正常读完才只 `releaseLock()`。
- `GET /v1/commands/:id` 的 404 仍然返回 `{ok:true, value:undefined}`（"没有回执"，不是成功、也不是失败），调用方据此决定是否重放。

## 代价与替代方案

- **代价**：`byId` 增加了必填参数，所有实现与调用点都要改；查回执多签一枚 60s 凭证（一次签名开销）。这两项换来的是"任何目录实现都绕不过一租户一 Cell"与"查回执可被 driver 真实验签"。
- **不采用"沿用 `op=send` 的查询凭证"**：`op` 必须描述本次请求的真实语义；用投递 op 去读回执，会让 driver 侧无法仅凭 `op` 区分写与读。
- **不采用"在 `@myrix/grant` 加一个只校验不消费的 API 给 GET 用"**：那会让同一枚凭证被长期复用（jti 不再一次性），反而削弱重放防护；新签一枚短凭证更简单也更强。
- **不采用"GET 不带凭证、只靠 commandId 猜测"**：回执表会变成可枚举的侧信道。
- **`committed` 不合成 `assistant.final`**：任何"BFF 自己造最终消息"的路径都会把没有持久事件确认的内容当成已保存回复，违反"不模拟成功"。

## 验证范围

BFF 侧自动化验证（`apps/bff/tests/runtime-stream.test.ts`、`apps/bff/tests/runtime-router.test.ts`，真实 PostgreSQL + 明确假 driver + 真实 ES256）：

- 目录：cellId 复用的多种形态（地址相同 / 同一租户重复 / 手写可注入目录返回别人的 endpoint）全部被拒；`byId` 核对 requested tenant；负例 reason 不含 `serviceToken`。
- 回执协议：超时后用新 grant 查回执并结算；POST grant 与 GET grant 不同；cmd / op / bh（空正文）/ aud / tid / boot 的错配全部被真实 `verifyAndConsume` 拒；同一 jti 二次消费被拒；两轮恢复各签一枚新凭证；**验签器公钥不对时命令保持队列退避**（不按"查到回执"结算）。
- 投影：`start`→`stream-start`、`abandoned`→`stream-abandoned`、`committed` 不投影；reasoning / 工具 arguments / `tool/result` / prompt / 工具 schema / 内部错误原文都不出现在公开事件里。
- 客户端：响应体超限与声明超限都 cancel 上游；连接异常与 driver `reason` 原文不外泄；404 保留 `undefined`。

未覆盖 / 由他人补齐：driver 侧的 receipt 绑定签名消费与同六字段活性核对、回执记录 `sid` 核对、unknown receipt / replay / 不同 `sid` 的负例（Lead 范围）；Cell 管理器写 CRD 后的动态目录仍复用同一接口，未实现。
