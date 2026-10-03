# ADR 0027：初始订阅的会话历史回放（cursor 0 必须转发）

- 状态：已采用（最小修复 + 真实链路回归）
- 日期：2026-10-01
- 相关：ADR-0016（Runtime 驱动与身份绑定）、[runtime-driver 契约](../implementation/runtime-driver.md)、[BFF 运行时](../implementation/bff-runtime.md)
- 实现：`apps/bff/src/runtime-router.ts`、`apps/bff/src/server.ts`、`apps/bff/tests/runtime-replay-zero.test.ts`、`apps/bff/tests/runtime-router.test.ts`

## 背景

真实验收（`tests/acceptance/session-lifecycle.mjs prepare`，真实 BFF + 两个隔离 Cell + 真实模型）发现：**初始订阅时，较快模型的回合其 user 持久事件会丢**。同一租户的作者侧能看到 `user`，而租户 2 的 JSONL 里已经落盘的 `seq=5 user/message` 在首次订阅的流里不存在 —— 网页重载后历史空白。

历史证据：本地持久日志已有 `{"type":"user/message","seq":5,…}`，即“回合已提交”是事实，不是推断。实际会话 ID、文件路径与原始稿件仅本地留存；当前回归入口见下文测试，不要求读者持有私有日志。

根因在 [runtime-router.ts:1006](<../../apps/bff/src/runtime-router.ts>)：

```ts
const lastEventId = after > 0 ? after : undefined;   // ← 0 被折叠成 undefined
// 之后 `...(lastEventId === undefined ? {} : { lastEventId })` 根本不发这个头
```

而 driver 的 `EventHub`（`plugins/myrix-runtime-driver/src/events.ts` 的 `collectHistory`）对这两个值给的是**不同语义**：

| 传入 | driver 行为 |
|---|---|
| `undefined` / 缺 `Last-Event-ID` 头 | live-only：只回一条 `myrix/subscribed` 当前水位标记，**不补发任何历史** |
| `0` | 补发全部 `seq > 0` 的持久事件 |

BFF 的 HTTP 边界**默认 cursor 就是 `0`**（[server.ts:106](<../../apps/bff/src/server.ts>)：`request.headers["last-event-id"] ?? "0"`），因为浏览器首屏/刷新必须拿到已提交的历史。于是默认路径恰好走进了 live-only 分支：流本身完全正常（只有一条被白名单丢弃的控制帧），但已提交的 `user/message`、`assistant/message`、`turn/end` 整段消失。模型越快、回合越早提交，越容易在用户首次订阅之前完成，因此表现为"偶发丢首条 user"。

## 决策

### 1. `after` 原样转发，包括 0

`events()` 只做边界校验（非法游标 400），不再改写语义：

```ts
if (!Number.isSafeInteger(after) || after < 0) throw new ApiFailure(400, "invalid_cursor", …);
const lastEventId = after;                       // 0 保持为 0
…
deps.driver.streamEvents(cell, sessionId, { grant: grant.token, signal, lastEventId });
```

### 2. 不改 driver 已定义的 `undefined` 语义

`undefined = live-only` 是有意的、被文档与单测冻结的行为（断线重连之外还有人只是想收增量）。要回放历史就显式声明水位，而不是让"没声明"隐式等于"从零开始" —— 后者会让每个不关心历史的订阅者都收到全量补发。这条 ADR 只修 BFF 的转发，不碰 `vendor/` 与 driver 源码。

### 3. 非法游标仍然 fail-closed，绝不静默降级

`-1`、小数、`NaN`、超安全整数的游标继续在 BFF 边界答 `400 invalid_cursor`，**不会**被当成 `0` 或 live-only 放过去。一个有笔误的游标若被静默解释成"从当前水位开始"，就会退化成"客户端以为在续传、实际中间事件全丢"，这与本 ADR 要修的 bug 是同一类错误。

## 验证

新增 [runtime-replay-zero.test.ts](<../../apps/bff/tests/runtime-replay-zero.test.ts>)。它不是"mock 返回固定内容"：整条数据路径都是真实组件，只有两个**文档化的注入缝**（BFF 的 `validators.currentFacts`、inert 的 Kysely db），二者都不参与 cursor/replay 语义：

```
BFF runtime.events()（含被修的那一行）
  → 真实 ES256 签发
  → 真实 driver HTTP 客户端 + 真实 SSE 帧解析
  → 真实 driver 路由 + 真实 SessionController 订阅鉴权（真实验签 + jti 一次性消费）
  → 真实 EventHub（补发 / 日志与缓冲按 seq 合并去重 / 水位推进）
  → 真实 SSE 编码 → 真实白名单投影
```

断言（组合条件刻意做成"只有真的补发了才可能通过"）：

- **历史先于订阅提交**：`history` 里已含 seq 0–10 的完整轮次（seq 5 `user/message`、seq 8 `assistant/message`、seq 10 `turn/end`），且进程内已 publish 过 5/8/10。首次以 cursor `0` 订阅，公开流必须恰好得到 `user@5`、`assistant@8`、`turn-end@10`。
- **seq 单调且不重复**：`[5,8,10]` 严格递增、无重复，`user` 恰好一条；seq 11 之前的 `system/message`/`request/header`/`request/context`/`step/*` 不投影（合法跳跃）。
- **真的发到了 cell**：记录 `Last-Event-ID: 0` 的头**存在且等于 `"0"`**（而非缺头），路径为 `/v1/sessions/<sid>/events`，并携带一枚被真实验签器接受的 `op=subscribe` 凭证。
- **cell 侧冻结**：同一测试内用真实 `EventHub` 断言 `undefined` 仍然只发 `myrix/subscribed` 且不含 `id: 5`；`0` 才补发 5/8/10，且不把 `seq 0` 当历史。
- **>0 续传不重放**：cursor `5` 必须只得到 8/10，且 `Last-Event-ID` 为 `"5"`。
- **非法游标回归**：负数/小数/NaN/Infinity/超安全整数 → `400 invalid_cursor`，且**一个字节都没发到 cell**。
- **不削弱鉴权**：真实 cell 上缺凭证 → 401、伪凭证 → 403，两种情况下响应里都不出现会话正文。

修订后的 [runtime-router.test.ts](<../../apps/bff/tests/runtime-router.test.ts>) 用既有 `FakeDriver` 精确断言转发头：`lastEventId === "0"`（并显式断言不是 `undefined`）、`>0` 时为 `"6"`、非法游标 400。

变异验证（手工跑过）：把 `const lastEventId = after` 改回 `after > 0 ? after : undefined` 并恢复条件展开后，
`runtime-replay-zero.test.ts` 的"cursor 0 回放"用例失败（`expected [ {type:'status'} ] to deeply equal [ [3 items] ]`，即只剩控制帧），
`runtime-router.test.ts` 的"forwards the initial cursor 0"用例同时失败。改回修复后两个文件全绿。

## 影响与未决

- 该修复**只影响初始/显式 cursor 为 `0` 的订阅**：`>0` 续传与非法游标行为逐字不变。
- BFF 仍只做投影（`after` 透传为 `Last-Event-ID`），去重与补发窗口仍由 driver 的 `EventHub` 决定；缓冲被丢弃时由 `myrix/truncated` → `replay-required` 显式告知，客户端据此重新拉取，不假装连续。
- 本 ADR 不改 vendor、不改 driver、不引入 `chat/completions` 兼容入口，也不改持久数据。
