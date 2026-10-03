# ADR-0016：Runtime Cell 驱动、身份绑定与策略执行点

- 状态：已接受（首版实现）
- 日期：2026-09-30
- 相关：ADR-0002（身份与插件授权）、ADR-0010（授权凭证）、ADR-0012（平台授权）、ADR-0013（BFF 认证）、[业务说明](../business.md)、[架构](../architecture.md)。原平台/技术草案与其中的伪代码章节已于 2026-10-02 本地归档，见[文档维护、归档与脱密](../documentation-policy.md)
- 实现：`plugins/myrix-runtime-driver/`、`plugins/myrix-principals/`、`plugins/myrix-policy-enforcer/`
- 接口契约：[docs/implementation/runtime-driver.md](../implementation/runtime-driver.md)

## 背景

原平台草案的 D1/D4 定下：按租户分 Runtime，一个 DSH 进程只服务一个租户；会话绑定由控制面写权威记录并签发授权凭证，Runtime 驱动在 Agent 创建事务内验证并安装身份；技术草案的驱动伪代码（已本地归档）也给了形状。本 ADR 记录把这些伪代码落成**真实 Cordis 插件**时，做出的判断与取舍。

落地时面对四类具体问题：

1. **伪代码里的 `M.*` 全部不存在。** `M.receiptStore`、`M.admissionGate`、`M.events`、`M.routes` 都是示意。仓库里此前只有 `packages/dsh-shim`——一份与真实 DSH API 不一致的占位类型（原平台草案已判定删除；草案本地归档，legacy 说明见 [legacy-dsh-shim](../integration/legacy-dsh-shim.md)）。用 shim 或 mock 顶上，等于把"验证真实内核"变成"验证自己写的替身"。

2. **身份表不能做成每 Agent 一个服务。** 原平台草案 §3.4 已经警告（草案本地归档）：为每个 Agent 注册同名服务会在进程级冲突。身份查表只能是**一个进程内单例 + 一张表**。

3. **绑定 ≠ 仍然有效。** `WeakMap` 里的条目只证明"创建时这个人是谁"。成员被移除、角色变化、控制面失联之后，绑定还在。这中间的空隙必须显式堵上，否则 guard 会放行一个已经被停用的用户。

4. **"已接收"的语义要能被证明。** 伪代码的 `receipts.put` 与 `sessions.flush` 出现顺序，决定了 `accepted` 回执到底承诺了什么。如果回执早于 flush，崩溃就会丢已回执的消息。

## 决策

### 1. 三个插件、三类导出形状，严格照 DSH 契约

DSH 的 `packages/AGENTS.md` 规定：service 包 `default export` 服务类；function plugin **具名导出** `name`/`inject`/`Config`/`apply` 且**没有 default export**（混用会让 Loader 丢掉命名空间）。据此：

| 插件 | 形状 | 理由 |
|---|---|---|
| `myrix-principals` | `default export class PrincipalRegistry extends Service` | 它是被三方消费的服务，必须能被 `inject` 与 `ctx.principals` 找到 |
| `myrix-runtime-driver` | 具名 `name`/`inject`/`apply` | 它是端点提供者，不需要成为服务 |
| `myrix-policy-enforcer` | 具名 `name`/`inject`/`apply` | 同上 |

`tests/plugin-surface.test.ts` 把这三条形状断言成测试，避免将来有人"顺手加个 default export"。

### 2. 编排与 DSH 之间用端口分离，编排逻辑可穷举测试

driver 的全部编排放在 `SessionController`，DSH 能力通过 `RuntimePorts`（`create`/`resume`/`flush`/`mountPreset`/`bindPrincipal`/`composedPreset`/`createUserMessage`/`now`，外加可选的 `refreshIdentity`/`persistedSession`/`persistedUserMessages`）注入。真实插件只做映射。

理由不是"为了好测试"这种泛泛的好处，而是：编排里的每一步顺序都是安全属性（setup 内绑定、commit 同步校验、flush 后回执、撤权三步顺序），必须能在没有真实 DSH 进程时被负例穷举；而端口到真实 API 的对应关系是**编译期**核对的（`src/index.ts` 里对 `ctx.agents.create` 等使用真实类型，`satisfies CreateAgentOptions` 锁形状）。

### 3. 身份表：`WeakMap<Agent, Principal>` + 反查索引 + 单调撤权

```ts
private readonly byAgent = new WeakMap<Agent, Principal>()   // 主键：随 Agent scope 回收
private readonly bySid   = new Map<string, SidEntry>()        // 反查：撤权/归因
private readonly revocations = new Map<string, RevocationState>()
```

- **主键是 `WeakMap`**：Agent 的 scope 结束时条目自然不可达，不需要"记得清理"。
- **反查索引是 `Map`**：撤权与模型归因只有 `sid`，必须能反查；条目在 `agent/disposed` 与 `revoke` 时删除。删除时比对 `WeakRef<Agent>`，避免旧 Agent 的 dispose 误删新绑定。
- **撤权单调且不可逆**：更旧的 `rev` 被忽略而不是回退状态；**已撤权的 sid 永远不能再次绑定**，即便控制面之后又签发了新凭证。这一条挡住"撤权 → resume 洗白"。
- **不引入第二权威源**：表里只存凭证派生值，不用来证明权限，只用来在**已经验签之后**回答"这个 Agent 代表谁"。

### 4. 活性由外部提供，缺失即拒绝（本 ADR 最重要的一条）

绑定表只能回答"曾经是谁"。因此：

```ts
lookup(agent)  // 严格：撤权检查 + 活性检查；任一不过都返回 {ok:false, reason}
get(agent)     // 宽松：只看绑定 + 撤权。文档明确标注"不要用于准入"
```

- **未安装活性判定 → `liveness-unavailable` → 拒绝**。不提供"没配就放行"的默认值。
- 判定必须**同步**（guard 在工具体之前同步调用），返回非 `true`（含 `undefined`、`false`）或抛错一律按失效处理。
- driver 本身**不安装**活性判定：那是控制面心跳/绑定快照适配器的职责。这是一个显式的接线缺口，已写进实现文档的"尚未覆盖"表——**不接则一切工具调用被拒**。

这不是过度设计：原平台草案 §3.3 要求"撤权不只依赖凭证过期"（草案本地归档），而凭证 TTL 只有 60s，成员被移除后到凭证过期之间必须有第二个判定点。

### 5. PEP：同步 guard 兜底 + waterfall 一定 `next()`

`tools/pre-execute` 是 waterfall，不调用 `next()` 等于否决整条链；`ctx.tools.guard` 是单调 guard，只能收紧不能放宽。两者都注册：

- **guard 读进程内快照，零 I/O，同步返回拒绝字符串。** 它挡的是"绕过 pre-execute 的直接调用"。
- **判定是纯函数** `admitTool(input)`，判定链固定有序：身份 → 静态 allowlist 未安装 → 不在 allowlist → 快照缺失 → 快照过期 → 租户不符 → 不在快照允许集。
- **两个集合并集？不。取交集。** 快照只能收窄静态 allowlist，不能放宽（AGENTS.md 规则 2）。
- **缺快照 = 拒绝**，而不是"回退到静态 allowlist"。网络失败、未下发、被撤下走同一条路径。
- **`tools` 的 allowlist 恰好 6 个小说工具**（原平台草案 §5.2，草案本地归档），不含 shell/fs/net/jobs/goals/subagents 等任何泛能力。
- **不保存策略**：快照由外部持有者安装（`setPolicySnapshotHolder` / `policySnapshotHolderOf`），本插件只读、只翻译成拒绝。符合 AGENTS.md 对 `plugins/*` 的定位。

### 6. 回执在 `flush` 之后；`jti` 与 `commandId` 严格分离

- **凭证**用 `@myrix/grant`（ADR-0010）：`verifyAndConsume(token, {op, cmd, bh})`，`aud`/`tid`/`boot`/`startedAt` 在构造 verifier 时绑定。`bh` 是**原始字节**的 SHA-256，因此路由必须复用同一个 Buffer。
- **`jti` 一次性**（防重放）与 **`commandId` 业务幂等**（防重复执行）是两层，不混用。重试时 `commandId` 不变、凭证重新签发（新 `jti`）。
- **同 `commandId` 但 `op`/`sid`/`bh` 任一不同 → 409 冲突**，不是"返回旧回执"。后者会把一次伪造或路由 bug 变成静默成功。
- **`messageId` 只能省略或等于 `commandId`**：消息 id 是对账键，允许调用方自带一个不同的 id 等于让它绕开"按 `commandId` 回读权威日志"，因此出现但不等于 `commandId` 时直接 400。
- **`accepted` 的承诺是"已持久接收"**：`send` 先 `followup(messageId = commandId)`，再 `flush`（DSH 的 `ctx.sessions.flush` 返回是否有持久化监听者参与），`flush` 失败就返回错误。`create`/`resume` 同样是 `flush` 成功才登记为 live。
- **`receipts` 有界**（默认 4096，超限淘汰最旧）。淘汰只会让长期重试退化为"重新执行一次"，不会放行未授权请求。
- **错误文本不回显上游异常**：`open_failed`/`followup_failed`/`persistence_unavailable` 的 `reason` 只给稳定码与类别（如 `error.name`），不带 `error.message` —— 插件异常里可能含有 prompt 片段或密钥。

### 6.1 崩溃恢复对账发生在真正落盘之前（R3 的闭环）

内存回执表跨重启为空。为了让"重试不再 append 一遍"成为**被证明**的行为而不是"导出了一个 helper"：

- `send` 在 `followup` **之前**依次查两处权威记录：磁盘持久日志（`sessionPersistence.open(sid,'read')` + `read(0)`）与**本进程已提交的会话日志**（覆盖 `flush` 失败后的同进程重试）。
- 命中同一个 `commandId`：正文一致 ⇒ 视为重试，不追加；正文不同 ⇒ **409 `command_id_conflict`**。
- 对账放在 `requireOwned` **之前**：重启后的重试没有活跃 Agent，先要求"会话已打开"会让对账永远走不到，退化成再 append 一次。
- 认两种事件：`user/message`（模型真正看到的消息）与 `agent/inbox/spliced`（已入 inbox、轮次尚未消费时崩溃）。
- 无法读取权威日志时返回 503 `persistence_unavailable`，**不**退化成"查不到就当新命令"。

`create` 的重试同样服从磁盘事实：`create` 而磁盘已有该会话 ⇒ 改走 `resume` 并核对 `meta.agentPreset`，绝不覆盖；`resume` 而磁盘不存在 ⇒ 409 `session_not_found`。

### 6.2 `GET /v1/commands/:id` 必须真的验签（越权修复）

**这是本 ADR 修正的一条错误结论。** 早期实现里 GET 只做 `Authorization: Bearer` 的
**语法解析**，理由是"GET 没有原始正文，给不出 `bh` 去调 `verifyAndConsume`，要真正验签
需要 `@myrix/grant` 提供只校验不消费的新 API"。这两句都错：

- **"没有正文 ⇒ 无法绑定"是伪命题**：GET 需要的不是"原 POST 的那份字节"，而是一枚
  **为读取这个动作单独签发**的凭证。给这次读取绑定一个确定的**空正文摘要**就是正确的
  解决方案，而不是将就。
- **"需要只 verify 不 consume 的 API"是错的方向**：那会放宽全局的一次性 `jti` 语义。
  正确做法是**重新签一枚**（全新 `jti`），让它照常走一次性的 `verifyAndConsume`。

后果的严重性是它被列为必修项的理由：只 parse Bearer 等于**任何拿得到一个 commandId
的人都能读到他人会话的回执**，回执表成为一个可被外部枚举的侧信道。

冻结协议（governance：签发方 BFF/控制面，校验方 driver）：

```
op  = subscribe
cmd = `receipt-${commandId}`        // subscribeCommandId 的姊妹派生函数 receiptCommandId
bh  = sha256(Buffer.alloc(0))       // EMPTY_BODY_SHA256；空正文摘要
sid/tid/sub/wid/preset/rev          // 与原 principal 六字段完全相同
boot                                // 当前 /v1/ready 的 bootId
jti                                 // 每次读取全新；重放即 403
```

驱动侧唯一入口是 `controller.authorizeReceipt(bearer, commandId)`：先
`verifyAndConsume(bearer, { op:'subscribe', cmd: receiptCommandId(commandId), bh:
EMPTY_BODY_SHA256 })`，再撤权判定、再 `lookupPrincipalBySession(claims.sid)` +
**六字段**逐项一致，最后**只有 `record.sid === claims.sid` 才返回回执**。

- **未知回执与"属于别的 sid 的回执"返回同一个 404 `no_receipt`**：否则 404/200 的差异
  本身就泄露了"其他会话存在这条回执"。
- **`receiptOf` 改为 private**：HTTP 边界不得绕过 `authorizeReceipt` 直接读回执表。
- **不放宽全局 `jti`/`bh`**：不复用 POST 那枚已消费的凭证，也不为 GET 造一个"只校验"
  的旁路。
- 畸形百分号编码（`decodeURIComponent` 会抛 `URIError`）必须是 400，不能变成未处理异常。

### 7. 打开顺序：先绑身份，再挂 preset；失败即解绑

`setup` 内的顺序改为 **`principals.bind` → `await agentPresets.mount` → 返回同步 `commit`**。理由不是风格：

- preset 是**组合**（工具、提示词段、`restrict()` 都在 `mount` 期间注册）。新的 `myrix-novel` preset 在加载期就会 `requirePrincipal`；若先 `mount` 再 `bind`，它读不到主体而失败，或者更糟——以空身份完成组合。
- 绑定返回的 `unbind` 注册进 `agentCtx.effect`；`mount` 抛错或结果不一致时**同步解绑一次**，不依赖 scope 回卷时机，"失败即刻失效"。

`commit` 是 DSH 在发布前调用的唯一同步校验点，因此它一次问完所有能同步回答的问题（全部零 I/O）：撤权、撤权高水位 vs 凭证 `rev`、绑定仍在（`lookupPrincipal` 含活性）、**六字段**（`sid`/`tid`/`sub`/`wid`/`preset`/`rev`）与凭证逐项一致。任一项不符都拒绝发布。

### 7.1 创建竞态：打开前的一次真实刷新

新绑定写入控制面数据库后马上 `create`，周期快照可能还没包含它。正确解法是**在真正 awaited 的 hook 里重新拉一次**，不是放宽准入：控制器在 `open()` 进入 `setup` 之前调用可选端口 `refreshIdentity(principal)`（真实插件映射到 `myrix-binding-lease` 的 `ctx.bindingLease.refresh()`）。刷新失败即中止打开（503 `identity_refresh_failed`），因为"无法证明仍然有效"就是拒绝。驱动**不**把 `bindingLease` 放进 `inject`：它是可选加固，缺失时驱动照常工作（只是少了这一次刷新），active 判定仍由 `principals` 的活性提供者决定。

**失败判定必须是 `installed === true`，不能只看"没有抛错"。** 适配器的契约是
`refresh(): Promise<LeaseRefreshOutcome>`，**永不抛出**：失败时返回
`{installed:false, rejection, detail}` 并已清空缓存（这样一次网络抖动不会把租约问题
放大成"会话打不开"）。因此 `await lease.refresh()` 成功返回**什么都不能证明**：
只看它会把"刷新失败、缓存已被清空"当成"刷新成功"，随后按一份不存在的快照打开会话。
真实插件显式检查 `installed === true`，否则抛出一个**固定的非秘密错误**
（不回显 `rejection`/`detail` 里可能存在的上游原文），打开随之中止。`refresh()` 抛错
（适配器自身异常）同样中止打开。

### 7.2 动态创建的会话必须显式携带 provider/model

驱动的会话是**按凭证动态创建**的（`ctx.agents.create/resume`），进程里没有任何声明式
Agent 可以承载模型路由。而 pinned vendor 的 agent loop 在
`AgentOptions.provider` 与 `AgentOptions.model` 都缺失、且没有 `agent/request`
waterfall 时**直接抛错**：

```
agent "<sid>" has no provider/model: set AgentOptions.provider and AgentOptions.model
or supply both via the agent/request waterfall
```

（`@deepseek-ai/dsh-agent-loop` 的 `prepareRequest`；WebUI 的模型选择器此时根本不会装载。）
因此 Config 增加**必填**的 `defaultProvider`/`defaultModel`，由真实插件的 `createPorts`
一并作为 `agentOptions` 传给 `create` **与** `resume`：

```ts
interface Config {
  // ...
  defaultProvider: string   // 必须与 myrix-llm-gateway 的 providers 一致（默认 myrix-gateway）
  defaultModel: string
}
```

取舍与理由：

- **两者必须同时给出，且非空**：只给一个仍然是"没有 provider/model"，启动期拒绝比
  运行期第一次模型请求才 502 更早、更可诊断。
- **不猜默认值**：provider route 名字由 profile 的网关配置决定（`myrix-llm-gateway` 的
  `providers`，默认 `myrix-gateway`，可被 `MYRIX_MODEL_PROVIDERS` 覆盖），模型 id 由
  adapter 解释。写死一个会让"配置漏了"表现为"会话打开了但发不出请求"。
- **不注册 `agent/request` waterfall 来补这个值**：bundle 里的 `cell-route-seam`
  是**测试专用接缝**（`MYRIX_CELL_ROUTE_SEAM=waterfall`，默认 disabled）。把它当生产
  方案等于让每个 cell 依赖一段测试代码来让模型请求合法。
- **测试 seam 兼容**：控制器与端口的既有测试继续用注入端口（`fake-dsh.ts`），
  不受 Config 变化影响；只有真实 `apply()` 的装配测试补上这两个字段。真实
  `index.apply` 选择 fail-closed（缺则启动失败），因为"能创建会话却永远发不出请求"
  的部署比"启动失败"更难发现。

### 8. SSE：先订阅、再补发、按 seq 去重；瞬态帧无 seq 不补发

竞态是这里唯一的难点：先读历史再挂订阅会丢掉中间到达的事件。顺序固定为：

1. 把订阅者挂进实时集合（此后事件进入它的待发队列）；
2. 补发历史（`seq > lastEventId`），历史来源优先是 DSH 权威会话日志（`session.snapshotEvents()`），缓冲只补日志里还没有的部分；
3. 冲刷待发队列，按各自的 `seq` 水位去重。

- 瞬态帧（`agent/assistant-stream`）**没有 `seq`**，只发给此刻连接的订阅者，不入缓冲、不补发（原技术草案 §3.3，草案本地归档）。
- 缓冲出现空洞时先发 `myrix/truncated`，显式告知不连续，而不是给出一段有洞的流。
- `Last-Event-ID` 解析从严：非数字/负数一律当"未声明"，不静默回退到 0。
- **每请求与逐帧**都做撤权检查：准入回调返回 false 或抛错 → 立刻关闭连接（fail-closed）。

### 9. 撤权顺序与排空证明

**撤权**：身份失效 → 关闭该会话 SSE → `cancel({kind:'disposed'})` → `dispose()` → 从 live 表移除。

顺序是安全属性（原技术草案 §2 A8，草案本地归档）：身份先失效，在途工具立刻被 guard 拒绝；空闲 Agent 上 `cancel` 什么都不做，只有 `dispose` 会注销。

**排空**：关闭准入（单向，不再打开）→ 等在途命令结算 → 逐会话 `whenIdle` + inbox 空 + `flush` → 返回 `{drained:true, activeSessions:0, waitedMs}`。

任何一步失败都返回 200 + `drained:false` 与可读原因外加精确的 `rejectionCode`（`ActiveTurns`/`InboxNotEmpty`/`NotFlushed`）、以及 `noActiveTurns`/`inboxEmpty`/`flushed` 三个布尔，**不给假证明**：管理器据此重试，而不是把副本数设为 0。`ready` 在 drain 后返回 503。

### 9.1 只读空闲证明 `/v1/admin/idle`

Cell 管理器的 `Draining` 分支要求 `POST /v1/admin/drain` **与** `POST /v1/admin/idle` 两份独立证据（ADR-0014 §3，接口形状已冻结在 `internal/driver.IdleProof`）。驱动补上后者，语义边界是：

- **只读**：`closeAll`/`closeAndWait`/`seal` 一概不调用，准入状态不变（`readOnly:true`），因此"查询空闲"不会把 cell 关掉。
- **同步判空闲**：用 `Agent.status`（`'idle' | 'running'`）判断有没有轮次在跑，**不** `await whenIdle()` —— 后者会把只读查询变成阻塞，还会把长轮次误当空闲。`status` 缺失（旧端口/替身）按"无法证明"处理。
- **`flushed` 必须被证明**：逐会话真调 `ctx.sessions.flush`；没有活跃会话时视为真（没有待落盘的东西）。
- 一律 200 + `proofId`/`bootId`/三个布尔/RFC3339 的 `lastCommandAt`/`observedAt`；未证明空闲时带精确 `rejectionCode`。**200 不是 ack**，刻意不用非 2xx：cell-manager 的 `HTTPClient` 把非 2xx 当作"驱动不可达"的硬错误，会把"忙"误判成 `DriverUnavailable` 而读不到拒绝码。
- **复用 drain credential**：两者都是 Cell 管理器的动作，权限相同；未配置时一律 503 `admin_unavailable`。
- **`generation` 是显式声明才发出的前向字段**：驱动在 Pod 内看不到 `metadata.generation`，cell-manager 当前契约也不校验它，因此不配就不出现在响应里，不猜值。

### 10. admin 端点不允许匿名

`/v1/admin/drain`、`/v1/admin/idle` 与 `/v1/admin/revoke` 必须配置 service credential（常量时间比对）或签名信封校验器（收到的是**原始字节**）。未配置时端点仍注册但一律 **503 `admin_unavailable`**——"忘了配"与"拒绝"同向。两者同时配置则启动失败。

### 11. 启动即失败

缺 `cellId`/`tenantId`/`issuer`、`keys` 为空、两条 admin 认证来源冲突——都在 `apply` 里抛错，让 profile 加载失败。`sessionPersistence` 也是硬依赖（`inject` 里包含）：没有持久化后端时 `resume` 直接抛错、`create` 的 `flush` 必然没有监听者参与，"已接受"无法被证明，因此宁可插件不激活。不构造一个"暂时没有校验依据"的驱动器（ADR-0010 的 fail-closed 结论）。

## 备选方案与为什么拒绝

| 方案 | 拒绝理由 |
|---|---|
| 继续用 `packages/dsh-shim` 的类型 | 与真实 DSH API 不一致（原平台草案已判删除，草案本地归档）；用它写出的驱动上线才发现类型对不上 |
| 用 mock/fake 端口替代真实 Cordis 装配 | 验证的是替身而不是内核。本实现的端口替身只用于**单元测试**，另有一组测试把插件通过真实 `ctx.plugin()` 加载并断言路由注册/卸载 |
| 每 Agent 注册一个同名身份服务 | Cordis 服务名是进程级的，会冲突（原平台草案 §3.4） |
| 身份表用 `Map<SessionId, Principal>` 且不清理 | 撤权后表还在；Agent 销毁后条目泄漏。改用 `WeakMap` 主键 + 显式反查索引 |
| 绑定即视为有效（不做活性判定） | 成员被移除到凭证过期之间有窗口；原平台草案 §3.3 要求第二判定点（草案本地归档） |
| 活性缺失时默认放行 | 违反 AGENTS.md 规则 1；"配置漏了"必须与"拒绝"同向 |
| guard 里发网络请求向控制面问策略 | `ctx.tools.guard` 只接受**同步**函数；异步判定会被静默丢弃或阻塞执行路径 |
| 只注册 guard，不注册 waterfall（或反之） | guard 挡直接调用，waterfall 挡正常的模型调用；两者覆盖面不同，缺一有洞 |
| 快照与静态 allowlist 取并集 | 违反"合并只能收窄"（AGENTS.md 规则 2）；快照必须只能收紧 |
| 缺快照时回退到静态 allowlist | 把"控制面失联"变成"按旧配置继续放行" |
| 同 `commandId` 不同内容时返回旧回执 | 把伪造/路由 bug 变成静默成功；必须显式 409 |
| 让调用方自带任意 `messageId` | 消息 id 就是对账键；可任意取值等于允许绕开"按 `commandId` 回读权威日志" |
| 只导出 `reconcileFromHistory` 就声称幂等 | 导出能力 ≠ 真的调用。对账必须在 `send` 落盘前发生且覆盖重启后的进程（没有活跃 Agent 的路径） |
| 先 `mount` preset 再 `bind` 身份 | 新 preset 在 `mount` 期间就 `requirePrincipal`；顺序反了会以空身份完成组合或直接失败 |
| `mount` 失败后等 scope 自己回收才解绑 | 回卷时机不由驱动控制；失败路径必须同步解绑，"失败即刻失效" |
| `commit` 只查 `isRevoked` | 覆盖不到"高水位已前进但 isRevoked 尚未置位""绑定被换成另一个 sub/wid/preset""活性已不可用" |
| `/v1/admin/idle` 复用 drain（关准入再查询） | 查询空闲会把 cell 关掉，管理器再也无法"查完再决定是否缩容" |
| idle 查询 `await whenIdle()` | 把只读查询变成阻塞，还会把仍在跑的长轮次当成已空闲 |
| idle 缺 `Agent.status` 时假定空闲 | 违反 AGENTS.md 规则 1；无法证明空闲就是拒绝 |
| 回执早于 `flush` | `accepted` 就不再承诺持久性；崩溃会丢已回执消息（原技术草案 §2 A8，草案本地归档） |
| 撤权时直接 `cancel` 不 `dispose` | 空闲 Agent 上 `cancel` 是 no-op，不会注销（原技术草案 §2 A8 明确指出） |
| `drain` 不检查 inbox 就返回成功 | 缩零后未处理的输入会随进程消失；管理器拿到假证明就把副本数设为 0 |
| admin 端点复用命令凭证 | drain/revoke/idle 的操作者是 Cell 管理器与控制面 outbox，不是会话所有者；语义不同，不能共用一个 claim 集 |
| SSE 先读历史再挂订阅 | 中间到达的事件会丢，且无法被发现（静默丢事件） |
| SSE 背压时静默丢帧或无限累积 `res.write` | 丢帧会让客户端以为"这段没有事件"而 seq 已跳过；无限累积让一个不读的客户端吃光内存。必须断开并由 `Last-Event-ID` 重放 |
| 非法 `Last-Event-ID` 当成"未声明" | 一次笔误或代理改写会静默变成"客户端以为在续传、实际丢了中间所有事件"；必须 400 |
| `open_failed`/`followup_failed` 拼接 `error.message` | 插件异常可能含 prompt 片段或密钥，会经 HTTP 边界外泄 |
| 给瞬态 delta 也编 seq | 瞬态帧断线后本来就无法补；编造 seq 会让客户端以为可以续传，重连后拿到空洞 |
| `GET /v1/commands/:id` 只 parse Bearer（不验签） | **已确认越权**：任何拿到 commandId 的人都能读到他人会话的回执，回执表成为可枚举的侧信道。GET 不是"无法验签"，而是需要一枚**为读取动作单独签发**的凭证（`op=subscribe`/`cmd=receipt-<id>`/`bh=sha256("")`，全新 `jti`） |
| 为 GET 给 `@myrix/grant` 加"只校验不消费"的 API | 放宽全局一次性 `jti` 语义；正确做法是重新签一枚并照常消费 |
| 复用 POST 命令那枚凭证去 GET | POST 时它已被消费，重放会被 `grant/replayed` 拒绝；这正是"新凭证绑定空 body"是正确解的证据 |
| GET 未知回执返回 404、他人回执返回 403（或反之） | 状态码差异本身就泄露"其他会话存在这条回执"；两者必须同为 404 `no_receipt` |
| 缺少 `defaultProvider`/`defaultModel` 时用硬编码默认值 | provider route 名由网关 profile 配置决定、model id 由 adapter 解释；猜一个会让"配置漏了"表现为"会话能开但发不出请求"。必须启动期拒绝 |
| 用 `agent/request` waterfall 补 provider/model | bundle 的 route seam 是**测试专用**（`MYRIX_CELL_ROUTE_SEAM`）；把测试接缝当生产方案等于让模型请求合法依赖测试代码 |
| `refreshIdentity` 只 `await lease.refresh()` 就认为刷新成功 | 适配器契约是**永不抛出**、失败以 `{installed:false, …}` 表达；不检查 `installed` 会把"刷新失败、缓存已清空"当成成功，随后按不存在的快照打开会话 |
| 把 `rejection`/`detail` 拼进 refresh 失败的错误文本 | 上游 detail 可能含响应正文；驱动只抛固定的非秘密错误 |

## 后果

**正面**

- 四条安全属性（凭证绑定、身份活性、撤权即时性、回执读取不越权）都有单元负例，且判定内核是纯函数、可穷举。
- 编排与 DSH 的耦合面被压缩成 8 个端口方法，端口到真实 API 的对应由编译器核对。
- fail-closed 的每一处"缺口"都是显式配置项或显式拒绝原因，而不是隐式默认值。
- 端点、请求体、SSE 帧、principal 方法、Config 全部写进实现文档，Lead 装配路由/bundle 不需要读源码。

**负面 / 代价**

- **需要一次显式接线**：控制面心跳适配器必须调用 `principals.setLiveness`（或装配 `myrix-binding-lease`），否则工具调用全被拒。这是刻意的，但会让"只装驱动不装心跳"的部署表现为"什么都干不了"——需要在部署文档里说清。
- 回执表是进程内的、有界的；跨重启的幂等由 `send` 在落盘前回读**磁盘持久日志**保证（不依赖路由先查回执）。`GET /v1/commands/:id` 重启后仍返回 404，因此 404 的 `reason` 里显式说明"回执不跨重启保留，请回读权威日志对账"，避免调用方把 404 当成"没执行过"。
- `send` 的对账会在每次发送前多做一次 `stat`/`open(read)`（有界读全量事件）；这是拿一点延迟换"不重复 append"，作者认为方向正确，但真实负载下的成本需要实测。
- SSE 重放缓冲有窗口（默认 2048 条/会话），超出后只能靠 DSH 会话日志补；缓冲与日志不一致时会发 `myrix/truncated`。
- SSE 背压上界默认 1 MiB：客户端读得比我们写得慢时会被**主动断开**，由 `Last-Event-ID` 重连补发。这是有意的取舍（不丢事件、不吃内存），但慢客户端会看到更多重连。
- **2026-10-02 更正早期装配记录**：依赖已由各插件自己的 `package.json` 与根 lockfile 声明/锁定，运行 CLI 另有隔离安装；不再需要早期临时类型目录，不将 DSH 加入根 workspace。按[运行时依赖](<../development/runtime-dependencies.md>)执行 frozen install，保持 vendor 只读。
- `sessionPersistence` 进入 `inject`：不装 `session-persistence-*` 后端的 profile 里，驱动**不会激活**（而不是"激活但无法对账"）。这是 fail-closed 的选择，但让装配多了一条硬前置。

**未覆盖（明确列出，不宣称已解决）**

- **没有真实模型、没有真集群 kill -9**。重启对账用"共享一份内存 disk + 新建 runtime"模拟（内存全丢、只有已 flush 的会话还在），**不是真的进程崩溃**：不覆盖真实 JSONL 的 torn tail、并发写、文件系统错误。真实 DSH/集群闭环由 Lead 负责。
- `GET /v1/commands/:id` 的验签**已做**（§6.2），但它依赖控制面为每次读取**重新签发**一枚凭证：BFF 侧不签就没有回执可读。这是显式的接线要求，不是驱动能单方面补齐的。
- `defaultProvider`/`defaultModel` 只覆盖"每 cell 一套默认路由"。按会话/按作品选择不同模型（WebUI 选择器切换）不在本批内 —— 那需要一条从控制面到 `agentOptions` 的授权通路，本轮只保证"生产装配有确定来源且缺失即拒绝"。
- `create` 遇到磁盘已有会话时改走 `resume`，但这依赖 `sessionPersistence.stat` 可见；纯 create 与"上次 create 从未 flush"之间的边界（会话物理存在但从不 materialize）没有独立测试。
- 真实模型 + 真实 JSONL 持久化下的组合验证（P1/P2）属于 `tests/poc/`（他人范围）。本实现的测试用行为替身覆盖编排语义，用真实 Cordis 组合覆盖装配面。
- 早期分工不代表当前缺口：BFF 已签发 subscribe/receipt 凭证并接入静态 Cell。Kubernetes drain/idle 的凭据、连通性和真实集群验收仍是独立边界，见[Cell 管理器](<../implementation/cell-manager.md>)。
- `myrix-llm-gateway`、`myrix-audit`、novel 工具、网关/作品服务配置不在本实现内。
- 跨进程/多副本 cell 的 `jti` 分裂问题由部署模型（每 cell 一进程）回避，未在本层解决。
- 未做真实 Postgres/JWKS 拉取；`keys` 由配置注入，拉取失败即拒绝一切命令（ADR-0010）。

## 验收标准（本批）

1. 三个插件均通过局部 `tsc`（用锁定 vendor 源码路径映射与 rc.2 声明两种方式核对），0 错误。
2. 端点 7 个：技术方案 §3.2 的 6 个 + 补上的只读 `/v1/admin/idle`（`DRIVER_ENDPOINTS` 有测试锁死）。
3. 凭证负例：缺 Bearer、`bh` 不符、`cmd` 不符、`jti` 重放、未知 op，全部有测试。
4. 幂等负例：同 `commandId` 换 `sid`/`bh`/`op` 冲突全部有测试；`messageId ≠ commandId` 400 有测试。
5. 撤权测试断言"身份失效 + `disposed` cancel + dispose + live 表清空"。
6. 排空测试断言 inbox 非空/`flush` 失败时**不**返回 `drained:true`，并给出精确 `rejectionCode`。
7. admin 端点：未配置认证 503、错误凭证 403、正确凭证生效，三种都有 HTTP 层测试（含 idle）。
8. 插件通过真实 `ctx.plugin()` 加载后注册 7 条路由，fiber 卸载后归零；缺 `sessionPersistence` 时不激活。
9. 打开顺序 `bind → mount → commit`、mount 失败即解绑、mount 期间主体可读，三条都有测试。
10. 重启对账：同 `commandId` 重试不重复 append（磁盘）、换正文 409、无需活跃会话即可对账，三条都有测试。
11. idle 只读：查询不关准入、精确拒绝码（`ActiveTurns`/`InboxNotEmpty`/`NotFlushed`）、`generation` 显式才发出，都有测试。
12. SSE：非法 `Last-Event-ID` 返回 400、背压超界断开，有测试；`open_failed`/`followup_failed` 不回显异常原文，有 HTTP 层测试。
13. 本地命令：`npx vitest run plugins/myrix-runtime-driver`、`npx tsc -p plugins/myrix-runtime-driver/tsconfig.json`。
14. **回执越权**：原 POST 凭证被消费后新签的 GET 凭证可查回执、重放 GET 凭证 403、
    `cmd`/`bh`/`op` 不符 403、伪造 Bearer 403、他人 sid 404、未知回执 404、撤权 403、
    活性不可用 403、畸形百分号编码 400，全部有真实签名 + HTTP 负例。
15. **provider/model**：`create`/`resume` 都带 `agentOptions`、Config 缺任一项启动失败、
    名字来自 Config 而非硬编码，有测试。
16. **租约刷新**：`installed:false`/`undefined`/`null`/非布尔 `installed` 一律中止打开且
    错误文本不含上游 detail；`installed:true` 通过；无 `bindingLease` 时不阻塞，有测试。

实测（2026-10-01，Node v24.13.0）：driver 8 个测试文件、204 项测试全部通过；driver 局部 `tsc` 0 错误；全仓 `npx tsc -p tsconfig.json` 在 driver 上 0 错误。本批新增 §6.2（回执验签）、§7.1 的 `installed` 判定、§7.2（provider/model 来源）三处修复与对应负例（原 168 项 → 204 项）。
