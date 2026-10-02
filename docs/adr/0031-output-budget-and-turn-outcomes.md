# ADR 0031：输出预算的实用默认值 与 `turn/end` 的严格终态投影

- 状态：已采用（实现与回归测试见相应 PR；本 ADR 不是上线成功证明）
- 日期：2026-10-01
- 相关：ADR-0015（模型计量）、ADR-0016（运行时驱动）、ADR-0023（Responses 网关）、ADR-0030（同机内部 HTTP origin 契约）
- 实现：`apps/model-gateway/src/config.ts`、`apps/bff/src/runtime-stream.ts`
- 回归测试：`apps/model-gateway/tests/config.test.ts`、`apps/model-gateway/tests/protocol.test.ts`、`apps/model-gateway/tests/usage.test.ts`、`apps/bff/tests/runtime-stream.test.ts`
- 未改动但语义相关（只读引用）：`apps/model-gateway/src/protocol.ts`（线上字段与硬上限校验）、`apps/model-gateway/src/usage.ts`（预占公式）、`plugins/myrix-llm-gateway/src/wire.ts`（失败原文的构造方）

## 背景

一次真实生产回合（部署版本 `024c74c9`，小说大纲新助手，2026-10-02 02:53 UTC）以失败结束。只读复核确认：绑定有效、`create` 与 `send` 都成功、真实回合确实调用了 `get_outline` 与 `search_bible` 两个工具，**第二个模型调用只返回了 reasoning（1024 token），没有可见正文**。

该回合持久化的终态是：

```jsonc
// turn/end
{ "reason": { "kind": "error",
              "error": { "code": "INVALID_RESPONSE",
                         "message": "myrix-llm-gateway: 上游响应未完成（status=incomplete, reason=length）" } } }
// 该次 attempt 的 usage
{ "input": 163, "cacheRead": 768, "output": 1024, "reasoning": 1024, "total": 1955 }
```

`output` 恰好等于 1024，说明推理把输出预算吃光后上游以 `incomplete(reason=length)` 收尾。插件把 "incomplete 但不是 `max_output_tokens`" 映射成显式失败（`INVALID_RESPONSE`）——这是**正确**的，问题不在插件：

1. 网关的 `MYRIX_GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS` 默认值只有 **1024**，远小于硬上限 8192。请求方（Cell/插件）在不显式指定时拿到 1024，一个典型推理回合的 reasoning 就能耗尽它。该默认值不足以覆盖此次回合的推理与正文输出；不能据此推断所有写作请求都会截断。
2. BFF 的 SSE 白名单投影（`apps/bff/src/runtime-stream.ts`）在 `turn/end` 上**不是 fail-closed**：只有 `error` / `aborted` / `interrupted` / `forked` 被显式处理，**其余任何 kind（包括 `max-tokens` 与未知/缺失 kind）都返回 `{type:'turn-end'}`**，即浏览器读到的终态是"本轮已完成"。一个失败或截断的回合因此可能被前端当成成功落定，`max-tokens` 这一类"输出被截断"的事实也完全没有出现在用户视野里。

本次生产回合实际显示的是无具体原因的"本轮执行失败"；输出预算耗尽的原因需要从持久化事件和 usage 复核。另一个独立发现是：`max-tokens` 或未知 kind 存在被误投影成"已完成"的风险，不能把这一风险说成本次已经发生的终态。

## 决策

### 1. 未显式配置时，默认输出预算 = min(8192, 生效硬上限)；显式配置语义不变

- 新增常量 `PRACTICAL_DEFAULT_MAX_OUTPUT_TOKENS = 8192`，并让 `DEFAULT_LIMITS.defaultMaxOutputTokens` 取该值。
- `resolveGatewayConfig` 区分"显式配置"与"未配置"，并且**隐式默认在生效的硬上限上推导**：
  - **生效硬上限** = `overrides.limits.maxOutputTokens ?? env.MYRIX_GATEWAY_MAX_OUTPUT_TOKENS`（override 优先）。
    隐式默认必须先看到 override，否则 override 调低硬上限时，按 env 算出的 8192 会被误判为非法配置并启动失败。
  - **默认值优先级**：`overrides.limits.defaultMaxOutputTokens` > `MYRIX_GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS`（env）>
    `min(PRACTICAL_DEFAULT_MAX_OUTPUT_TOKENS, 生效硬上限)`。
  - **未配置**（env 与 override 都没给默认值）→ 取 `min(8192, 生效硬上限)`。硬上限被调低时默认随之下调；
    硬上限被调高时默认仍是 8192（不跟着无限放大）。
  - **显式配置** → 原样生效，运维的意图不被默认值覆盖。
  - **显式默认大于生效硬上限** → 仍然**启动即失败**（fail-closed），不会被静默压低成硬上限；
    两个方向都拒绝：env 显式默认 4096 + override 硬上限 2048，以及 env 硬上限 2048 + override 显式默认 4096。
- 这**不是**"无限预算"：输出预算始终被生效硬上限收窄，且请求方显式传入的 `max_output_tokens` 依旧按
  `[1, 硬上限]` 校验、超出即 400。
- 不引入任何协议回退、不重放、不改动上游协议（仍然是 Responses）。输入项数/字符、正文大小、超时、撤权轮询等**其它限制一律不变**；预占公式（输入估算 + 输出预算，不截断）也不变。

### 2. `turn/end` 只有 `reason.kind === 'completed'` 能投影成成功

`apps/bff/src/runtime-stream.ts` 改为显式穷举，默认分支 fail-closed：

| `reason.kind` | 投影 | 说明 |
|---|---|---|
| `completed` | `{type:'turn-end', seq}` | **唯一**的成功终态 |
| `aborted` / `interrupted` / `forked` | `{type:'status', seq, status:'interrupted'}` | 既有中断语义原样保留 |
| `max-tokens` | `{type:'error', seq, text:<输出上限文案>}` | DSH 的"至少一步触顶"，不是成功 |
| `blocked` | `{type:'error', seq, text:<固定拦截文案>}` | DSH 的 pre-step 拒绝；非完成，但也不是"原因未知"。拒绝可能发生在已有 step **之后**，固定文案只说"未完成"，不断言"未执行" |
| `error` | `{type:'error', seq, text:<固定文案>}` | 文案见决策 3 |
| 其它 / 缺失 / 非对象 reason | `{type:'error', seq, text:'本轮执行失败'}` | **fail-closed**：不假装成功，也不静默丢弃 |

### 3. 只有**精确命中**的已知安全文案才升级为友好文案；原文永不进浏览器

- 识别 `plugins/myrix-llm-gateway/src/wire.ts` 中 `mapResponsesTerminal` 逐字构造的两条消息
  （`code === 'INVALID_RESPONSE'` 且 message 完全相等）：

  ```
  myrix-llm-gateway: 上游响应未完成（status=incomplete, reason=length）
  myrix-llm-gateway: 上游响应未完成（status=incomplete, reason=max_output_tokens）
  ```

  命中 → 固定的"输出达到上限"友好文案（说明可能不完整、可重试或调高上限）。
- 其它已知 code（`TRANSPORT` / `TIMEOUT` / `UNSUPPORTED_CONTENT`）按 `code` **精确相等**映射到各自固定分类文案；输出是常量，不回显 code 本身。
- 其余一律兜底为 `本轮执行失败`。
- **绝不使用 `includes` / 前缀 / 正则匹配**：任何前缀、后缀、换行追加、密钥夹带都会落回兜底文案。`reason.error` 的 `name` / `message` / 原始 `code`、以及 `aborted.reason` 等字段的文本，在任何分支下都不会进入浏览器。

### 4. 明确不做的事

- 不为了"让事故不再发生"而放宽任何授权/身份判定；本次改动不触及鉴权、绑定、RLS、凭据。
- 不在 BFF 里重跑或重试模型调用，不合成 `assistant.final`，不把 reasoning 内容投影给浏览器。
- 不修改上游 DSH（`vendor/deepseek-harness`）与模型网关插件的协议行为。插件的失败分类是正确的；**当前已经持久化的历史失败**（旧的 `INVALID_RESPONSE`）也必须能被识别，因此识别逻辑放在 BFF 投影层，而不是"等插件改完再看"。
- 本次不改动 `deploy/vps/compose.yml`（另一路 SSE 调查在工作树/其它范围进行），不改动其它服务路径。

## 保留不变的安全不变量

1. 输出预算必须不超过硬上限；隐式默认取 `min(8192, 生效硬上限)`，显式超限请求直接返回 400，不静默截断。
2. 预占 = 输入保守估算（UTF-8 字节/3）+ 输出预算，**不截断**；输入超限 400 `input_too_large`。
3. 额度窗口、并发闸门、幂等 `requestId`、结算口径（cached/reasoning 只作审计）全部不变。
4. 上游仍是完整 Responses 端点；无 `chat/completions`、无路径补全、无协议回退。
5. `turn/end` 之外的白名单不变；持久事件缺 `seq` 仍丢弃；控制帧仍不带 `seq`。
6. 失败终态只能是固定文案；浏览器永远拿不到上游/插件的原始错误串。

## 验证要求

- 网关配置：未配置默认 → 8192；硬上限调低 → 默认跟随；硬上限调高 → 默认仍 8192；显式默认保留；显式默认 > 硬上限 → 报错。
  另含 override 路径：override-only 硬上限 2048 → 默认 2048（不得因 env 隐式 8192 而误报）；override-only 硬上限 16384 → 默认仍 8192；
  override 显式默认 512 → 512；env 显式默认 4096 + override 硬上限 2048 → 拒绝；env 硬上限 2048 + override 显式默认 4096 → 拒绝。
- 协议/预占：缺省请求（含 `tools` + `tool_choice`）线上 `max_output_tokens` 等于默认预算；代表性推理预算（1024）被默认值覆盖；显式收窄时预占与线上字段一起收窄；预占 = 输入估算 + 输出预算。
- 投影：只有 `completed` 得到 `turn-end`；`max-tokens`、未知/缺失 kind、伪造 message（前缀/后缀/夹带密钥或 prompt）、未知 code 都得到固定文案；已知安全原文升级为输出上限文案；`aborted` / `interrupted` / `forked` 语义不变；重放同一批帧的终态完全一致；只有工具调用的回合永远不会被读成完成。

## 代价

- **每次请求的预占变大**：预占 = 输入估算 + 输出预算。默认预算从 1024 提到 8192 后，
  每次请求最多多预占 7168 token（真结算仍按上游真实 usage，多占部分会退回）。
  会话/租户窗口较紧的部署可能因此更早看到 429；这是"覆盖推理输出"的必要成本，
  需要更紧预算的部署可以**显式**配置 `MYRIX_GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS`，
  或让调用方显式传 `max_output_tokens`；也可以在嵌入 `overrides.limits`（例如开发装配/测试）
  时收窄硬上限与默认值。窗口配额本身不因此改变。
- `max-tokens` 与未知 kind 从此都以 `error` 终态呈现，前端"完成但无正文"的提示路径
  （`turn-incomplete`）不再覆盖这类截断回合：用户会看到明确的失败，而不是模糊的成功。
- 输出上限文案是固定中文文案，不是上游原文；排障需要精确定位时仍要读服务端审计/持久日志。

## 备选方案与为什么拒绝

| 方案 | 拒绝理由 |
| --- | --- |
| 只把默认值改成 8192（常量） | 硬上限若被调低（例如 2048），默认 8192 会直接触发启动校验失败，或被迫静默压低；"未配置"与"显式配置"必须分开表达，隐式默认必须按生效硬上限推导 |
| 先按 `env.MYRIX_GATEWAY_MAX_OUTPUT_TOKENS` 算出隐式默认，再让 `overrides.limits` 覆盖硬上限 | override 单独把硬上限压到 2048 时，隐式默认仍是按 env 的 8192，随后被判为"默认 > 硬上限"而启动失败——即本次评审修掉的回归（`tests/config.test.ts` 已覆盖） |
| 干脆去掉 `max_output_tokens`，让上游用自身默认 | 预占必须覆盖输出预算，无上界的请求会让额度闸门失效（等于无限预算） |
| 在 BFF 里按 `reason.error.message` 的子串判断"是不是输出上限" | 子串匹配把上游/伪造文本变成可信输入，且会把夹带的密钥或 prompt 一并带入判定 |
| 把未知 kind 直接丢弃（不发终态） | 前端会一直停在"进行中"，比给出固定失败文案更糟，且掩盖真实故障 |
| 让 `max-tokens` 也投影成 `turn-end`（"至少模型答完了一步"） | 与 DSH 语义冲突：`max-tokens` 明确表示输出被截断，冒充完成正是本次事故的放大因素 |
| 等插件改成直接映射 `max-tokens` 再修 BFF | 已经持久化的历史失败不会因此改变；识别逻辑必须在读取侧，与插件改动解耦。插件侧把"reason 非 `max_output_tokens` 的 incomplete"继续判为失败是**正确**的，本次不改插件 |
