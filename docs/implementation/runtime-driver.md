# Runtime Driver 实现与接口契约

依据：[platform-plan-v2 §2.1/§3](../plan/platform-plan-v2.md)、[tech-design-v1 §3.2/§4.1](../plan/tech-design-v1.md)。DSH 锁定 `639ed015397290b3745d163aafe02ffee4aa3f84`（包版本 `0.2.0-rc.2`，`@deepseek-ai/cordis@4.0.4`）。

本文件是 **Lead 装配 BFF/路由与 bundle 时的接口基线**：端点、请求体格式、principal service 方法、Config、以及"谁负责签发什么"。

## 1. 交付物与写入边界

| 路径 | 内容 |
|---|---|
| `plugins/myrix-runtime-driver/` | Cell 内运行时驱动（真实 Cordis function plugin） |
| `plugins/myrix-principals/` | `ctx.principals`：Agent → 身份 绑定表（Service class plugin） |
| `plugins/myrix-policy-enforcer/` | PEP：同步 guard + `tools/pre-execute` waterfall |

本批三处窄修复只改 `plugins/myrix-runtime-driver/**`（`src/index.ts`、`src/router.ts`、`src/controller.ts`、`src/http.ts`、`tests/**`）与 `docs/adr/0016-runtime-driver.md`、本文件；未改 `plugins/myrix-principals/**`、`plugins/myrix-policy-enforcer/**`、`apps/bff/**`（Lead 正在写 `production.ts`）、`apps/cell-manager/**`、`vendor/**`、`bundles/**` 与根配置。

未改动 `tests/poc/**`、`packages/**`（`@myrix/grant` 未动：不加"只校验不消费"的 API）、`packages/contracts/**`（他人范围）。

## 2. 装配方式（Lead 需要做的）

```yaml
# bundles/myrix-base/cordis.patch.yml（示意，最终由 bundle owner 落盘）
plugins:
  '@myrix/principals':        {}            # Service class，default export
  '@myrix/policy-enforcer':   { }           # function plugin
  '@myrix/runtime-driver':
    cellId:         !env MYRIX_CELL_ID
    tenantId:       !env MYRIX_TENANT_ID
    issuer:         myrix-control-plane
    keys:           !env MYRIX_GRANT_JWKS   # JWKS 形态公钥数组
    defaultProvider: myrix-gateway          # 必填；= 网关 adapter 的 provider route
    defaultModel:    myrix-chat             # 必填；由 provider adapter 解释
    drainToken:     !env MYRIX_DRAIN_TOKEN  # 或 drainSignatureVerifier
    revokeToken:    !env MYRIX_REVOKE_TOKEN # 或 revokeSignatureVerifier
```

**`defaultProvider`/`defaultModel` 是必填**：驱动的会话是按凭证**动态创建**的，没有
声明式 Agent 可以承载 provider/model；而 pinned vendor 的 agent loop 在没有
`AgentOptions.provider` + `AgentOptions.model`、且没有 `agent/request` waterfall 时
直接抛错（`agent "…" has no provider/model: set AgentOptions.provider and
AgentOptions.model or supply both via the agent/request waterfall`，
`@deepseek-ai/dsh-agent-loop`）。**不配就拒绝启动**，而不是让每个会话在第一次模型
请求时才失败。名字必须与 `myrix-llm-gateway` 的 `providers` 配置一致（默认
`myrix-gateway`）。驱动**不**注册 `agent/request` waterfall 来补这个值 —— 那是
bundle 的测试专用接缝（`MYRIX_CELL_ROUTE_SEAM`），不是生产方案。

加载顺序无关紧要（三者通过 Cordis 服务查找解耦）；但 `myrix-principals` 必须先于另外两个**激活**，否则它们的 `inject` 不满足、不会启动 —— 这是刻意的 fail-closed。

**依赖路径**：`package.json` 里用的是真实包名与精确版本（`@deepseek-ai/dsh-agent@0.2.0-rc.2` 等）。根 workspace 目前 exclude `vendor`，因此需要在统一装配时由 Lead 决定 DSH 依赖的引入方式（npm 精确版本，或把 `vendor/deepseek-harness/vendor/*`、`packages/*` 纳入 workspace）。**本实现没有碰 `vendor` 与根 `pnpm-workspace.yaml`。**

## 3. HTTP 端点

全部挂在 `dsh-host-webserver` 上（`ctx.webServer.register`），安装即注册、fiber 卸载即反注册。

| 方法 | 路径 | 认证 | 成功响应 |
|---|---|---|---|
| POST | `/v1/commands` | `Authorization: Bearer <grant>` | 200 `{status, commandId, bootId, note?}` |
| GET | `/v1/commands/:commandId` | `Bearer <grant op=subscribe cmd=receipt-:commandId bh=sha256("")>`（**每次单独签发**，见 §3.5） | 200 同上；无回执**或属于别的 sid** 404 `no_receipt` |
| GET | `/v1/sessions/:sid/events` | `Bearer <grant op=subscribe>` | 200 `text/event-stream`；非法 `Last-Event-ID` 400 |
| POST | `/v1/admin/drain` | service credential 或签名信封 | 200 `{drained, bootId, activeSessions, waitedMs, rejectionCode?, readOnly, noActiveTurns, inboxEmpty, flushed, generation?}`（`drained:false` 不是 ack） |
| POST | `/v1/admin/idle` | **与 drain 同一 credential** | 200 `{proofId, bootId, noActiveTurns, inboxEmpty, flushed, lastCommandAt, observedAt, readOnly, rejectionCode?, generation?}`（拒绝也是 200 + 真实字段，见下） |
| POST | `/v1/admin/revoke` | service credential 或签名信封 | 200 `{accepted, sid, rev, reason, disposed, closedStreams}` |
| GET | `/v1/ready` | 无 | 200 `{ready:true, bootId, draining:false}`；drain 后 503 |

`/v1/admin/idle` 是 Cell 管理器 `internal/driver.IdleProof` 已冻结的接口形状：**只读**，绝不关闭准入（`readOnly:true`），因此"查询空闲"不会把 cell 关掉。`drain` 是它的写动作对应物：关准入 + 等空闲 + flush，成功后 cell 不再接受命令。

错误响应统一 `{ error, reason, code?, stage? }`，**不含 token、正文、上游原始异常**。

### 3.1 `POST /v1/commands` 请求体

```jsonc
{
  "op": "create",          // create | resume | send | cancel | subscribe
  "sid": "s-8f3c…",        // 会话 id，必须等于凭证 sid
  "commandId": "c-91ab…",  // 必填；业务幂等键，重试时不变
  "text": "写一个开头",     // 仅 op=send 必填，非空
  "messageId": "m-…"       // 可选；省略时用 commandId 作为 messageId
}
```

**正文就是 `bh` 的唯一输入。** 路由签发凭证时必须对**即将发送的这些字节**算 SHA-256：

```ts
const rawBody = Buffer.from(JSON.stringify(payload), 'utf8')
const bh = sha256Hex(rawBody)      // = @myrix/grant 的 bodyHash()
signer.issue({ ..., bh 由 issue 内部按 rawBody 计算 })
// 然后把 rawBody 原样作为 HTTP body 发出
```

字段顺序/空白不同会导致 `bh` 不同；**必须复用同一个 Buffer**，不要"签一次、序列化一次"。

### 3.2 回执语义

- `status: "accepted"` = 消息已进入 inbox **且** `ctx.sessions.flush` 已成功返回（至少一个持久化监听者参与）。**不表示模型已回复。**
- `status: "duplicate"` = 同一条命令的重试（`commandId` 相同且 `op`/`sid`/`bh` 全部一致）。不重复执行。
- `commandId` 相同但 `op`/`sid`/`bh` 任一不同 → **409 `command_id_conflict`**。
- `messageId` 只能省略或等于 `commandId`；给一个不同的值 → **400 `malformed_body`**。消息 id 就是崩溃对账的键，不能由调用方指定。
- `send` 在落盘前会回读**磁盘持久日志**与本进程已提交的会话日志：找到同一 `commandId` 且正文一致 ⇒ 视为重试，不追加；正文不同 ⇒ **409**。这覆盖进程重启后的重试（此时内存回执表为空）。
- `create` 的重试遇到磁盘已有该会话 ⇒ 改走 `resume` 并核对 `meta.agentPreset`，**不覆盖**；`resume` 而磁盘不存在 ⇒ **409 `session_not_found`**。

### 3.2.1 打开顺序（安全属性，改动前先读）

```
setup 内：
  1) resume 时核对磁盘 header 的 agentPreset 与凭证一致
  2) principals.bind(agent, principal)          <- 先绑定，且注册 agentCtx.effect(unbind)
  3) await agentPresets.mount(agentCtx, preset) <- 再挂载（新 preset 在加载期就 require principal）
  4) 返回同步 commit：撤权 / rev 高水位 / 绑定仍在（含活性）/ 六字段逐项一致
```

`mount` 失败或返回不一致时**同步解绑**，不依赖 scope 回卷时机。

打开前还有一次可选的真实刷新（`myrix-binding-lease` 的 `ctx.bindingLease.refresh()`），用于消除"绑定刚写入、周期快照还没包含"的创建竞态。

**关键：`bindingLease.refresh()` 永不抛出。** 失败时它返回
`{installed:false, rejection, detail}` 并已清空缓存；因此"没有抛错"**不等于**刷新成功。
驱动必须显式检查 `installed === true`，否则抛出一个固定的非秘密错误
（`identity_refresh_failed`，503），打开随之中止 —— "无法证明仍然有效"就是拒绝。
`refresh()` 抛错（适配器异常）同样中止打开。缺 `bindingLease` 时不刷新（可选加固，
不是新依赖）；此时活性仍由 `principals` 的活性提供者决定，未安装活性提供者时一切
`require` 路径拒绝，所以"没有 liveness 就不会放行"这一条不因缺少刷新而改变。

### 3.3 `op=subscribe` 的 `cmd` 派生

事件流没有业务 commandId，用**同一个派生函数**（`@myrix/runtime-driver` 导出 `subscribeCommandId`）：

```ts
subscribeCommandId(sid) === `subscribe-${sid}`
```

签发 subscribe 凭证时 `bh = sha256Hex("")`（空正文摘要，插件导出常量 `EMPTY_BODY_SHA256`）。驱动侧用同一个常量做绑定校验。

### 3.5 `GET /v1/commands/:id` 的凭证协议（越权修复）

**旧行为（已废弃，是已确认的越权漏洞）**：GET 只做 `Authorization: Bearer` 语法解析，
任何拿得到一个 commandId 的人都能读到他人会话的回执 —— 回执表变成一个可被枚举的侧信道。
"GET 没有原始正文所以无法验签"是错误结论：GET 需要的不是"原 POST 的正文"，而是**一枚
为读取这个动作单独签发的凭证**。

**冻结协议**（BFF 与控制面按此签发，driver 按此校验）：

| claim | 值 |
|---|---|
| `op` | `subscribe` |
| `cmd` | `` `receipt-${commandId}` ``（插件导出 `receiptCommandId`） |
| `bh` | `sha256(Buffer.alloc(0))` = `EMPTY_BODY_SHA256`（空正文摘要） |
| `sid`/`tid`/`sub`/`wid`/`preset`/`rev` | 与原 principal **六字段完全相同** |
| `boot` | 当前 `/v1/ready` 返回的 bootId |
| `jti` | **全新**（每次读取一枚；一次性消费，重放即 403） |

签发伪代码（BFF 侧）：

```ts
const signer = /* 控制面 signer */
const grant = signer.issue({
  aud: cellId, boot: bootId, tid, sid, sub, wid, preset, rev,
  op: 'subscribe',
  cmd: receiptCommandId(commandId),   // `receipt-${commandId}`
  rawBody: Buffer.alloc(0),           // ⇒ bh = EMPTY_BODY_SHA256
})
await fetch(`${cell.baseUrl}/v1/commands/${encodeURIComponent(commandId)}`, {
  headers: { authorization: `Bearer ${grant.token}` },
})
```

**不得放宽**：全局的 `jti` 一次性与 `bh` 绑定都不放宽。不能"复用 POST 命令的那枚凭证"——
它在 POST 时已被消费，重放会被 `grant/replayed` 拒掉；这正是"新凭证绑定空 body"是正确解
而非将就的原因。

驱动侧唯一入口是控制器 API（路由不再直接读回执表）：

```ts
controller.authorizeReceipt(bearer: string | undefined, commandId: string): CommandReceipt
```

校验顺序（任一步失败都拒绝）：

1. `verifier.verifyAndConsume(bearer, { op: 'subscribe', cmd: receiptCommandId(commandId), bh: EMPTY_BODY_SHA256 })`
   —— 真实验签（ES256/`kid`/`iss`/`aud`/`tid`/`boot`）、时效、绑定、一次性 `jti`；
2. 撤权与 rev 高水位（`session_revoked` / `rev_stale`）；
3. `lookupPrincipalBySession(claims.sid)` 活性 + **六字段**逐项一致（`identity_invalid` / `identity_mismatch`）；
4. 只有 `record.sid === claims.sid` 才返回回执；**未知回执与属于别的 sid 的回执都返回
   404 `no_receipt`** —— 不能泄露"其他会话存在这条回执"。

| 情形 | 结果 |
|---|---|
| 原 POST 被消费后，新签的 GET 凭证 | 200 `{status, commandId, bootId}` |
| 重放同一枚 GET 凭证 | 403 `grant/replayed` |
| `cmd` 指向别的命令 | 403 `grant/operation-mismatch` |
| `bh` 不是空正文摘要 | 403 `grant/body-hash-mismatch` |
| `op` 不是 `subscribe` | 403 `grant/operation-mismatch` |
| 伪造/乱写 Bearer | 403 `grant/bad-signature`（不是 404） |
| 凭证 sid 未绑定 | 403 `identity_invalid` |
| 回执属于别的 **已绑定** sid | 404 `no_receipt` |
| 未知 commandId | 404 `no_receipt` |
| 缺 `Authorization` | 401 `grant_missing` |
| 路径 `decodeURIComponent` 畸形（如 `%E0%A4%A`） | 400 `malformed_request`（不抛未处理异常） |

`receiptOf(commandId)` 现在是 **private**（仅供诊断/测试）；HTTP 边界无法绕过
`authorizeReceipt` 直接读回执表。

### 3.4 SSE 帧格式

```
id: 42                      <- 持久事件才有；值 = SessionEvent.seq
event: user/message         <- DSH 事件类型，或 myrix/* 控制帧
data: {"id":"m-…",…}

: hb                        <- 心跳注释帧（默认 15s）

event: myrix/ready          <- 鉴权通过、开始补发
event: myrix/subscribed     <- 未带 Last-Event-ID 时的当前水位
event: myrix/truncated      <- 缓冲已丢，显式告知不连续
event: myrix/assistant-stream  <- 瞬态增量，无 id，断线不补
```

续传：客户端发 `Last-Event-ID: <seq>`，服务端**先订阅再补发、按 seq 去重**，只发 `seq > lastEventId` 的事件。**非法值（非十进制、负数、小数、超安全整数）直接 400 `malformed_last_event_id`**，不当成"未声明"——否则一次笔误会被静默解释成"从当前水位开始"，中间事件全丢。

背压：单连接在 `ServerResponse` 里积压的字节数超过 `sseMaxBufferedBytes`（默认 1 MiB）时，驱动 `destroy()` 这条连接并关掉订阅，由客户端带 `Last-Event-ID` 重连补发。**不丢帧、不补假 `seq`、不把半截流冒充成功**。

## 4. `ctx.principals`（`@myrix/principals`）

Service class plugin，`default export`，服务名 `principals`。主键 `WeakMap<Agent, Principal>`，随 Agent scope 回收。

```ts
interface Principal { sid: string; tid: string; sub: string; wid: string; preset: string; rev: number }

// 绑定（在 setup 内调用；返回解绑函数，应放进 agentCtx.effect）
bind(agent: Agent, p: Principal): () => void
// 已撤权 或 Agent.id !== p.sid 或 已属其他 sub → 抛 PrincipalDeniedError

// 活性：外部提供"此刻是否仍然有效"。未安装 → 一切 require 路径拒绝。
setLiveness(fn: ((p: Principal) => boolean) | undefined): () => void
hasLiveness(): boolean

// 宽松查询：只看绑定 + 撤权，不查活性。不要用它做准入。
get(agent?: Agent): Principal | undefined
bySession(sid?: string): Principal | undefined

// 严格查询（含活性）—— guard 与业务工具的唯一准入路径
lookup(agent?: Agent): { ok: true; principal } | { ok: false; reason; detail }
lookupBySession(sid?: string): 同上
require(agent?: Agent): Principal            // 失败抛 PrincipalDeniedError
requireBySession(sid?: string): Principal

// 撤权：单调、不可逆
revoke({ sid, rev, reason }): { accepted: boolean; reason: string; highWaterRev: number }
isRevoked(sid): boolean
revocationOf(sid): RevocationState | undefined
highWaterRev(sid): number
stats(): { bound; live; revoked; denied; liveness }
```

**活性判定的说明（Lead 需注意）**：驱动本身**不安装**活性判定。控制面心跳 / 绑定快照适配器必须在进程内调用 `setLiveness` 提供 `bindings`/`currentMember` 的当前状态；未安装时 `lookup` 一律返回 `liveness-unavailable`，即**任何工具调用都会被拒**。这是设计选择：无法证明仍然有效 = 拒绝。

## 5. `myrix-runtime-driver` 的 Config

```ts
interface Config {
  cellId: string                 // 必填；= 凭证 aud
  tenantId: string               // 必填；= 凭证 tid
  issuer: string                 // 必填；= 凭证 iss（myrix-control-plane）
  keys: GrantPublicJwk[]         // 必填且非空；空 = 拒绝启动
  defaultProvider: string        // 必填；真实 agents.create/resume 的 agentOptions.provider
  defaultModel: string           // 必填；真实 agents.create/resume 的 agentOptions.model
  maxBodyBytes?: number          // 默认 1 MiB
  heartbeatMs?: number           // 默认 15000；0 = 关闭
  replayWindow?: number          // 默认 2048（每会话重放缓冲条数）
  sseMaxBufferedBytes?: number   // 默认 1 MiB；超界断开连接由 Last-Event-ID 重放
  generation?: number            // 非负整数；配置了才在 drain/idle 响应里出现
  drainToken?: string            // drain 与 idle 共用；与 drainSignatureVerifier 二选一
  revokeToken?: string           // 与 revokeSignatureVerifier 二选一
  drainSignatureVerifier?: (rawBody: Buffer, header: string | undefined) => {ok:true} | {ok:false, reason}
  revokeSignatureVerifier?: 同上
}
```

`defaultProvider`/`defaultModel` 一并作为 `agentOptions` 传给
`ctx.agents.create`/`ctx.agents.resume`；`create` 与 `resume` 都传（恢复的会话同样要能发请求）。

`sessionPersistence` 是 `inject` 的硬依赖：不装 `session-persistence-*` 后端时驱动**不激活**（否则 `resume` 直接抛错、`flush` 没有监听者，"已接受"无法被证明）。`bindingLease` **不在** `inject` 里：它是可选的创建竞态加固。

- **未配置 admin 认证**：端点仍注册，但一律 **503 `admin_unavailable`**。不允许匿名 drain/revoke。
- 两个都配置 → 启动时抛错。
- 缺 `cellId`/`tenantId`/`issuer`/`keys` → 启动时抛错（fail-closed，不"先跑起来"）。

## 6. 命令处理顺序（安全属性）

```
解析正文 → 取 Bearer → verifier.verifyAndConsume(token, {op, cmd, bh})
  → sid 交叉核对 → messageId 必须等于 commandId → 撤权/rev 校验 → 会话锁
      → 回执幂等判定（同 commandId 比 op/sid/bh）
      → create|resume: 打开前 await refreshIdentity（可选）
                       → 磁盘已有会话时 create 改走 resume
                       → setup 内【核对磁盘 preset → principals.bind → await agentPresets.mount → commit 同步严校验】
                       → 再查撤权（覆盖发布期间） → flush 成功才登记 live
      → send: 权威对账（磁盘持久日志 + 本进程日志；命中即不追加，文本不同 409）
              → 所有者核对 → followup(messageId = commandId) → flush 成功才回执
      → cancel: 所有者核对 → agent.cancel({kind:'user'})
  → 记录回执
```

撤权顺序：**身份失效 → 关闭 SSE → cancel({kind:'disposed'}) → dispose**。
排空：**关闭准入 → 等在途命令 → 逐会话 whenIdle + inbox 空 + flush → drained:true**；`ready` 在 drain 后返回 503。
空闲证明（`POST /v1/admin/idle`）：**只读**，同步看 `Agent.status` 判有无轮次，逐会话真 `flush`；拒绝码 `ActiveTurns`/`InboxNotEmpty`/`NotFlushed`。它**不**关准入。

## 7. 崩溃恢复对账（R3）

`messageId = commandId` 是刻意选择：进程重启后内存回执表为空，但持久会话日志里已经有这条 `user/message`。驱动**在 `send` 落盘前真的调用对账**（不是只导出 helper）：

```ts
controller.reconcileFromHistory(session, commandId): number | undefined   // 本进程日志里的 seq
controller.reconcileLive(session, commandId, text)                        // 本进程日志 + 正文比对
controller.reconcilePersisted(sid, commandId, text)                       // 磁盘持久日志 + 正文比对
```

规则：命中同一 `commandId` 且正文一致 ⇒ 不追加；正文不同 ⇒ 409 `command_id_conflict`；读不到权威日志 ⇒ 503 `persistence_unavailable`。对账发生在 `requireOwned` **之前**，因此重启后没有活跃 Agent 时也能识别重试。

`GET /v1/commands/:id` 重启后仍返回 404（回执刻意是进程内、有界的），但 `reason` 会说明"回执不跨重启保留，请回读权威日志对账"。**404 不区分"没有回执"与"回执属于别的 sid"**：存在性不可被探测（见 §3.5）。

## 7.1 只读空闲证明 `/v1/admin/idle`

Cell 管理器要求 drain **与** idle 两份独立证据。驱动补上后者，形状与 `apps/cell-manager/internal/driver.IdleProof` 逐项一致：

```json
{
  "proofId": "uuid",
  "bootId": "本进程 bootId",
  "noActiveTurns": true,
  "inboxEmpty": true,
  "flushed": true,
  "lastCommandAt": "RFC3339（最后一次真正结算成功的命令）",
  "observedAt": "RFC3339",
  "readOnly": true,
  "rejectionCode": "仅在被拒时出现：ActiveTurns | InboxNotEmpty | NotFlushed",
  "generation": "仅在 Config 显式配置时出现"
}
```

- 只读：不 `closeAll`、不 `closeAndWait`、不 `seal`；查询前后准入状态不变。
- 用 `Agent.status` 同步判"有没有轮次在跑"，不 `await whenIdle()`。
- 复用 drain credential；未配置 ⇒ 503 `admin_unavailable`。
- 拒绝时同样返回 **200**，但带精确 `rejectionCode` 与可读 `reason`。**200 不是 ack**：`noActiveTurns:false` 就是"没有证明空闲"。刻意不用非 2xx，因为 cell-manager 的 `HTTPClient` 把非 2xx 当作"驱动不可达"的硬错误，会把"忙"误判成 `DriverUnavailable` 而读不到拒绝码。
- `generation` 不配就不出现（驱动看不到 K8s `metadata.generation`，不猜值）。

## 8. 尚未覆盖 / 需要 Lead 或他人补齐

| 项 | 状态 |
|---|---|
| `@myrix/runtime-driver` 等包在根 workspace 的装配（依赖解析） | 未做；需 Lead 决定 vendor/npm 引入方式 |
| bundle `myrix-base` 的 plugin 白名单与 Config 落盘 | 他人范围（bundle owner） |
| 控制面侧签发 subscribe 凭证 / **回执读取凭证（`receipt-<id>`，§3.5）** / drain / idle / revoke 信封 | Lead（BFF/contracts）；驱动侧协议已冻结并实现，BFF 侧由 `apps/bff` 按 §3.5 落盘 |
| `POST /v1/admin/idle` 与 cell-manager 的接线 | 驱动端点已实现（形状与 `internal/driver.IdleProof` 一致）。cell-manager 侧 `Client.IdleProof` 已在，**本次未改 apps/cell-manager**（他人范围）；生成器字段 `generation` 需要显式配置才出现 |
| 控制面心跳 → `principals.setLiveness` 适配器 | 由 `plugins/myrix-binding-lease` 提供（`GET /internal/v1/cells/:cellId/bindings` 短租约）+ 驱动打开前的 `refreshIdentity`（**检查 `installed === true`**，失败即中止打开）。**不接则一切工具调用被拒** |
| `GET /v1/commands/:id` 的凭证验签 | **已做**：控制面为每次读取单独签 `op=subscribe` / `cmd=receipt-<id>` / `bh=sha256("")` 的新凭证（新 `jti`）；驱动走 `authorizeReceipt` 真实验签 + 一次性消费 + 撤权 + 六字段身份核对，且只在该回执属于凭证 sid 时返回。详见 §3.5 |
| 真实进程 kill -9 / 真实 JSONL torn tail | **未覆盖**。重启对账用"共享内存 disk + 新建 runtime"模拟；真实闭环由 Lead 验证 |
| DSH 类型依赖的本地解析 | 我用 `node_modules/.dsh-types/`（gitignored 的临时 pnpm 安装，`@deepseek-ai/*@0.2.0-rc.2` + `cordis@4.0.4` + `schemastery@3.18.4`）让局部 tsc 可跑。**它不是交付物**；`pnpm install` 后需由 Lead 决定 DSH 依赖的正式引入方式 |
| 真实模型/JSONL 持久化下的组合验证（P1/P2） | 他人范围（`tests/poc/`） |
| `myrix-llm-gateway`、`myrix-audit`、novel 工具 | 其他代理 |
| 网关/作品服务配置 | 领域工具负责，本实现不含 |

## 9. 本地验证命令

```bash
# 局部类型检查（用锁定 vendor 源码的路径映射，不写 vendor）
npx tsc -p plugins/myrix-principals/tsconfig.json
npx tsc -p plugins/myrix-policy-enforcer/tsconfig.json
npx tsc -p plugins/myrix-runtime-driver/tsconfig.json

# 局部测试（根 vitest.config.ts 已包含 plugins/*/tests/**）
npx vitest run plugins/myrix-principals plugins/myrix-policy-enforcer plugins/myrix-runtime-driver
```

实测（2026-09-30，Node v24.13.0）：
- 三个插件各自 `tsc` 无错误；根 `pnpm typecheck` 中本批插件 0 错误。
- driver：8 个测试文件、**204 项测试**全部通过（原 168 项 + 本批 36 项负例）。
- 全仓 `pnpm test`：由 Lead 统一跑。

**注意**：上表的 `npx tsc -p plugins/<name>/tsconfig.json` 依赖 DSH 类型可解析。当前根 workspace exclude `vendor`，我在 `node_modules/.dsh-types/` 放了一份临时精确版本安装（gitignored）。纯 `pnpm install` 后需由 Lead 决定正式引入方式（推荐：`@deepseek-ai/*` 精确版本进根 `package.json`）。
