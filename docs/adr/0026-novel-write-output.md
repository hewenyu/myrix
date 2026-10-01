# ADR-0026：小说写工具的数据面输出边界（工具返回值窄化投影）

- 状态：已实现并回归（真实非 owner PostgreSQL + 真实 HTTP + 真实 DSH ToolRuntime 校验）；真实模型工具回合的验收状态以验收记录为准，不由单元测试推定。
- 日期：2026-10-01
- 相关：[ADR-0017](./0017-novel-tools-boundary.md)、[ADR-0011](./0011-postgres-ownership.md)、[ADR-0025](./0025-novel-deployment-policy.md)。

## 背景

2026-10-01 的真实浏览器 + 上游 Responses 调用链里，模型按预期先 `get_outline` 再
`update_outline`。大纲**确实落库到 PG v4**，但 DSH 把该次工具调用判为失败：

```
Error: tool "update_outline" returned invalid output:
  "value.contentHash" is not a declared property (additionalProperties: false);
  "value.updatedAt"  is not a declared property (additionalProperties: false);
  "value.reason"     is not a declared property (additionalProperties: false)
→ ToolOutputError / INVALID_TOOL_OUTPUT
```

证据：`data/cells/cell-dev-1/sessions/_no-cwd/4df0b31b-2f4f-4aa8-b5f8-29db5af3a96d/session.v4.jsonl` 第 17 行。

根因不是数据库、不是 CAS、也不是授权，而是**两侧契约各说各话**：

1. **声明侧（模型面）**：[`plugins/myrix-novel/src/tools.ts`](../../plugins/myrix-novel/src/tools.ts)
   给六个工具声明了 `output.schema`，全部 `additionalProperties: false`，
   写工具只声明 `{ status, version }`。`get_chapter` 只声明
   `id/workId/title/text/version/updatedAt`。
2. **返回侧（数据面）**：作品服务返回的是**存储层记录**。
   [`packages/platform-store/src/repositories/results.ts`](../../packages/platform-store/src/repositories/results.ts)
   的 `SaveResult` 是 `{ status, version, contentHash, updatedAt, reason }`；
   `getChapter` 返回 `ChapterRecord + text`，含 `tenantId`/`parentVersion`/
   `contentHash`/`createdAt`。
3. **执行侧（真实强制）**：`@deepseek-ai/dsh-tools` 的
   `createSuccessResult()` 会真的调用 `validateJsonSchemaValue(output.schema, value)`
   （vendor 只读参照 `packages/core/tools/src/index.ts:1834`）。于是数据面多返回的
   字段直接变成 `INVALID_TOOL_OUTPUT`。

受影响的**不止证据里的那一次**：三个写工具（`update_outline`、
`save_chapter_draft`、`update_bible_entry`）都会带回 `contentHash`/`updatedAt`/
`reason`；`get_chapter` 会带回四个额外的存储字段。也就是说，"真实模型每次保存
大纲/章节/设定都会失败一次"，而写入已经发生 —— 最坏的一种：**副作用已生效，模型
却看到失败并可能重试或向用户谎报未保存**。

为什么此前测试没抓到：旧测试的替身只回"**刚好符合 schema** 的理想值"
（`{ status: 'saved', version: n }`），把真实 executor 的返回形状整个掩盖了。
这正是"替身必须复刻真实返回形状，而不是复刻理想 schema"的教训。

## 决策

1. **模型面输出契约是窄的、封闭的，且是唯一事实来源。**
   新增 [`plugins/myrix-novel/src/output.ts`](../../plugins/myrix-novel/src/output.ts)，
   把六个工具的 `output.schema` 与对应的**窄化投影**放在同一文件成对维护。
   schema 保持 `additionalProperties: false`：任何"服务端多返回了内部字段"
   都应是可见的失败，而不是被悄悄回显给模型。

2. **在模型面边界做投影，而不是放宽 schema。**
   工具的 `execute` 在拿到作品服务返回值后，经 `projectToolOutput(name, value)`
   只挑出声明过的字段，其余一律丢弃。放宽 schema（把 `contentHash`/`reason`/
   `tenantId` 写进声明）是错误方向：它会把存储实现细节固化成对模型的长期承诺，
   并让内部字段（正文哈希、租户 id、审计原因）进入模型上下文与日志。

3. **投影是 fail-closed 的，不编造合法值。**
   缺字段、类型不符、未知 `status`、非整数版本 —— 一律抛出**不携带原始值**的错误，
   以工具错误呈现。错误文本不含租户 id、正文哈希或审计 reason，避免借错误消息
   泄漏内部字段。绝不做"默认填一个 saved"这类静默兜底。

4. **投影不改变任何业务语义。** `saved`/`duplicate`/`conflict` 三态、CAS
   （HTTP 409 → `{ result: { status:"conflict", version } }`）、idempotence、
   身份隔离全部原样保留。投影只发生在**返回路径的最后一跳**，在授权、仓储、
   HTTP 之后，因此不影响任何写入判定。`packages/platform-store` 的 `SaveResult`
   与 `apps/bff` 的 executor **保持不变**：数据面继续返回完整记录，浏览器 API
   继续需要它；被收窄的只是**模型面**。

5. **`get_outline` 与 `search_bible` 的现有形状不动。** 它们的返回本来就是
   模型面形状（`getOutline` 已在 BFF 映射成 `{workId,text,version,updatedAt}`，
   `toBible` 已映射成 `{id,workId,kind,title,text,version,updatedAt}`）。投影对
   它们做的是**同形状透传 + 校验**，仍会拦下未来任何一个多出来的字段。

## 后果

- 真实链路不再断在工具返回处：模型看到 `{ status, version }` 或只读实体的声明字段。
- 代价是每个工具返回处多一次纯函数投影与字段校验（无 I/O、无时钟，可单测）。
- **新增字段必须先加 schema 再加投影**：只加投影字段会被 schema 拒绝（校验兜底），
  只加 schema 字段会被投影丢弃（模型看不到）。两者同文件成对维护即为此。
- 若某天确实需要把版本上下文（如 `updatedAt`）暴露给模型，正确做法是**显式**把它
  加进 `output.ts` 的 schema 与投影，并在此 ADR 记录为什么它是模型面契约的一部分，
  而不是让存储记录直接穿透。

## 验证边界

- [`plugins/myrix-novel/tests/output-contract.test.ts`](../../plugins/myrix-novel/tests/output-contract.test.ts)
  （真实 DSH `ctx.tools.execute()` + 真实 `validateJsonSchemaValue`）：六工具全覆盖，
  写工具的三态、duplicate、CAS conflict，以及形状不符时的 fail-closed。
  作品服务替身**刻意复刻真实仓储返回形状**（含 `contentHash`/`updatedAt`/`reason`、
  `tenantId`/`parentVersion`/`contentHash`/`createdAt`），否则会重演"替身掩盖缺陷"。
- [`apps/bff/tests/novel-tool-contract.integration.test.ts`](../../apps/bff/tests/novel-tool-contract.integration.test.ts)
  （真实非 owner PostgreSQL → 真实 `PostgresNovelRepository` → 真实
  `createWorksExecutor`/`createWorksServer` → 真实 `NovelStoreClient` fetch →
  真实 DSH ToolRuntime）：三个写工具各跑 saved → duplicate → conflict，
  只读工具丢弃内部字段，并保留身份隔离。使用专用验收库
  `BFF_TEST_DATABASE_URL`/`BFF_TEST_MIGRATION_DATABASE_URL`，不迁移业务 dev DB。
- 两个文件都已实测：把投影退回"直接返回 `JSON.parse(payload)`"时，它们会逐字复现
  与证据第 17 行相同的 `INVALID_TOOL_OUTPUT`；恢复投影后全部通过。

**不**由本 ADR 证明：真实模型工具回合（本 ADR 只保证"真实 executor 的返回能通过
真实校验"）、供应商 Responses 适配器、浏览器完整闭环。这些以验收记录为准。

## 未采用的做法

- **放宽 schema 收纳内部字段**：把存储实现细节变成对模型的承诺，并让租户 id /
  正文哈希 / 审计 reason 进入模型上下文与持久会话日志。
- **在 BFF / executor 侧提前删字段**：会让浏览器 API（`/api/v1/...`）也丢掉它需要
  的 `updatedAt`/内容，等于把模型面契约的收窄错误地施加到数据面。执行器保持返回
  完整记录，收窄只发生在模型面。
- **把 `extra` 字段塞进 `render` 而不改 canonical value**：DSH 校验的是 canonical
  `value`（在校验**之前**），`render` 在校验之后；绕过不了校验，只会让失败更隐蔽。
