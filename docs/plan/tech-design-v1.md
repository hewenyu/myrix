# Myrix 技术方案 v1：语言、组件与伪代码

> 状态：**评审定稿候选**（2026-09-30）。以 [platform-plan-v2.md](platform-plan-v2.md) 为边界，不改变其中的产品与部署决策。
> 来源：Astra 与 DeepSeek 各自出初稿，再互相质询一轮，Lead 对照源码裁决。
> 标注：**[源码]** 已在 `vendor/deepseek-harness`（锁定 639ed01）核实；**[推论]** 设计选择；**[PoC]** 进入 MVP 前必须实测。伪代码表达接口与时序，不能直接运行；`M.*` 都是 Myrix 拟建的辅助接口。

## 0. 结论

| 组件 | 语言 / 框架 | 存储 | 一句话理由 |
|---|---|---|---|
| Cell 内插件（driver、principal、guard、llm、audit、novel） | TypeScript，Node ESM，Cordis | `DSH_HOME` + JSONL + RWO PVC | DSH 扩展只能是 Cordis 插件 [源码] |
| Cell 驱动传输 | HTTP POST 命令 + SSE 事件流，挂在 `dsh-host-webserver` 上 | 无 | 每条命令天然一个回执；SSE 用 `seq` 续传；不装 DSH Web UI |
| BFF + 会话路由 | TypeScript，Fastify | Postgres（命令队列） | 与控制面共享契约；少一个组件 |
| 控制面 | TypeScript，Fastify，Kysely + `pg` | Postgres | 直接复用 `governance`、`registry` 纯函数 |
| 作品服务 | TypeScript，Fastify，Kysely | Postgres（`tenant_id` + RLS） | 写路径要显式版本号与幂等，SQL 比 ORM 直白 |
| 模型网关 | TypeScript，Fastify，Undici（自研薄治理层） | Postgres（配额账本） | 归因、额度、撤权是平台独有逻辑 |
| Cell 管理器 | **Go**，controller-runtime | CRD `TenantCell` | 它本质是 K8s controller，Go 生态现成 |
| 前端 | React，Vite，TanStack Query，Tiptap | — | 自建小说工作台，不复用 DSH Web |
| 部署 | Helm，cert-manager，OpenTelemetry + Prometheus | — | SaaS 与私有化同一套 chart |

**语言策略：TypeScript 为主，Go 只用于 Cell 管理器。** 策略、授权、契约全部在 TS 一侧，只写一份；Go 不做任何授权判定，只通过 CRD 和版本化 JSON Schema 与 TS 通信。

## 1. 选型说明

### 1.1 为什么主体是 TypeScript

- Cell 内只能写 Cordis 插件，没有其他语言选项 [源码]。
- 控制面要复用 `packages/governance`（纯函数 PDP）和 `packages/registry`（profile 渲染），它们已经是 TS。
- 授权语义如果在两种语言里各写一份，最容易出权限事故。一种语言就只有一份。
- 团队只需一套构建、lint、测试工具链：沿用仓库现有的 pnpm、TypeScript、Vitest。

### 1.2 为什么 Cell 管理器用 Go

它的工作是 watch K8s 状态、调谐副本数、leader election、失败重试。controller-runtime 现成提供 informer 缓存、workqueue、resync 和选主。用 Node 实现，等于重写一个不成熟的 operator 框架。它不碰授权，例外成本可控。

### 1.3 框架选择与放弃项

| 选择 | 放弃 | 原因 |
|---|---|---|
| Fastify | 手写 `node:http` 路由 | 鉴权钩子、schema 校验、SSE、限流都有成熟插件 |
| Kysely + `pg` | Prisma 等完整 ORM | 需要精确控制事务、`FOR UPDATE`、RLS 会话变量 |
| Postgres 命令队列 | Kafka；Redis 作为唯一队列 | 已有 Postgres；Redis 只可做唤醒通知，不能持有已回执命令的唯一副本 |
| 自研薄模型网关 | 直接用 LiteLLM、Envoy AI Gateway | 所有者授权、撤权、账本要平台自己做。开源网关可作下游协议转换，**本次未联网核实能力与许可** [PoC] |
| React + Vite | Next.js | 无 SSR 需求，少一个服务端运行时 |

## 2. 评审分歧与裁决

两份初稿在 8 个点上不同，互相质询后的结果：

| # | 议题 | Astra 初稿 | DeepSeek 初稿 | 裁决 |
|---|---|---|---|---|
| A1 | 驱动传输 | HTTPS + SSE，自起服务 | WebSocket，`registerUpgrade` | **POST + SSE，挂在 `dsh-host-webserver`**。质询后双方都接受对方方案，Lead 选 POST + SSE：命令与回执一一对应，重试和对账简单；SSE 用 `Last-Event-ID` 续传。WebSocket 的“取消语义更好”不成立，取消本来就是一条命令 |
| A2 | 签名算法 | ES256 | EdDSA，理由是签名更短 | **ES256**。两者签名都是 64 字节，“更短”不成立；ES256 是各家 KMS 的公共支持项。算法在验签端写死 |
| A3 | 命令队列 | Postgres | Redis | **Postgres**。DeepSeek 已让步 |
| A4 | Cell 状态权威 | Postgres CAS | CRD + controller | **CRD 管生命周期，Postgres 只管业务绑定与放置**。存活看 K8s readiness 与 `observedGeneration`，不把观测态再抄一份进 Postgres |
| A5 | 防重放 | `bootId` + 进程内 `jti` | `iat ≥ 进程启动时间` | **三者叠加**：`boot` 必须等于当前进程，`jti` 进程内一次性，`iat` 门槛作纵深。单靠 `iat` 受秒精度和时钟偏差影响 |
| A6 | 写操作幂等键 | 由 `callId` 派生 | 模型传 `idempotencyKey` | **都不用**。`callId` 在崩溃恢复后会变 [源码]；模型不能负责生成稳定键。改为作品服务按 `(作品, 章节, expectedVersion, 正文哈希)` 自行判定，见 §3.5 |
| A7 | setup 写法 | 先 `await presets.mount`，setup 内绑定身份 | `void mount()`；身份写在 setup 之外 | **采纳 Astra**：`await presets.mount()` [源码]；身份在 setup 里绑定，commit 只做同步校验 |
| A8 | 回执与撤权 | 回执前 `flush` | 撤权直接 cancel | **回执语义是“已持久接收”，不是“执行完成”**；`flush` 只表示会话缓冲已写盘 [源码]。撤权顺序：先让身份失效，再 cancel，再 dispose。空闲 Agent 上 cancel 什么都不做，dispose 才注销 [源码] |

另外两份初稿里各有一处被纠正：DeepSeek 的 `create` 在 setup 之外写身份索引，commit 时读不到；Astra 的伪代码自起 HTTPS 监听，绕开了 DSH 的服务生命周期。

## 3. 关键协议

### 3.1 授权凭证（JWS / ES256）

```text
header : alg=ES256, kid=<轮转 id>
claims : iss=myrix-control-plane
         aud=<cellId>  boot=<cell 当前 bootId>
         tid  sid  sub  wid  preset  rev
         op=create|resume|send|cancel|subscribe
         cmd=<commandId>  bh=<请求体 SHA-256>
         jti  iat  exp=iat+60s
```

- 私钥在 KMS 或受控 Secret，只有控制面能签；cell 只装公钥（JWKS），拉取失败就拒绝一切命令。
- `bh` 把凭证和请求体绑定，凭证不能拿去换一条消息或换一个操作。正文放请求体，凭证只放摘要。JWT 不加密，不放敏感内容，也不进模型上下文。
- **重试规则**：同一条命令重试时 `commandId` 不变，凭证重新签发（新 `jti`）。`jti` 防重放，`commandId` 管业务幂等，两者不混用。

### 3.2 驱动 HTTP 接口（cell 内）

| 方法 | 路径 | 调用方 | 说明 |
|---|---|---|---|
| POST | `/v1/commands` | 会话路由 | `Authorization: Bearer <grant>`，返回回执 `{status: accepted\|duplicate, commandId, bootId}` |
| GET | `/v1/commands/:commandId` | 会话路由 | 超时后先查回执，不盲目重发 |
| GET | `/v1/sessions/:sid/events` | 会话路由 | SSE，需 `op=subscribe` 凭证；`Last-Event-ID` 为持久事件 `seq` |
| POST | `/v1/admin/drain` | Cell 管理器 | 关闭准入，等待空闲，flush |
| POST | `/v1/admin/revoke` | 控制面 outbox | 控制面签名的撤权通知，`rev` 单调递增 |
| GET | `/v1/ready` | kubelet、Cell 管理器 | 就绪探针，返回 `bootId` |

传输安全：mTLS 由网格终止。为避免每个缩到零的小 Pod 再多一个 sidecar，优先选节点级的 mTLS 方案；若不可行，退回由 driver 插件自己持有 HTTPS 监听 [PoC]。NetworkPolicy 只允许路由、Cell 管理器、控制面访问这些端口。

### 3.3 回执与事件

- **回执 `accepted`**：消息已进入 inbox，且会话已 flush 到盘。它不表示模型已回复。
- **执行结果**：从事件流观察 `turn/end` 等持久事件。
- **流式文字**：`agent/assistant-stream` 的块是瞬态的，断线后不能补；客户端重连后以持久事件为准 [源码]。
- **SSE 续传**：先订阅，再按 `Last-Event-ID` 从会话日志补发持久事件，按 `seq` 去重。

### 3.4 Cell 状态

- CRD `TenantCell`：`spec.tier`（shared / dedicated）、`spec.wantRunning`；`status.phase`（Stopped / Starting / Ready / Draining / Failed）、`status.bootId`、`status.observedGeneration`。
- Postgres：租户、成员、会话绑定、放置（`sessionId → cellId`）、命令队列、撤权版本。
- 路由只在 `phase=Ready` 且 `bootId` 与凭证一致时投递。

### 3.5 写操作幂等（小说）

崩溃后 DSH 会用合成 closer 关掉中断的轮次，模型看到“结果未知”后可能换个 `callId` 重试 [源码]。所以幂等由作品服务自己判定：

- `save_chapter_draft` 必带 `expectedVersion`。
- 当前版本 = `expectedVersion` → 写入新版本。
- 当前版本的父版本 = `expectedVersion`，且正文哈希相同 → 视为重复请求，返回已有版本。
- 其他情况 → 返回冲突和当前版本号，模型重新读取。

以后的报销、订酒店等外部写操作，按 [platform-plan-v2 §5.3](platform-plan-v2.md) 使用服务端业务操作 ID，超时先查结果。

## 4. 伪代码

### 4.1 `myrix-runtime-driver`

```ts
// function plugin：具名导出，无 default export [源码 packages/AGENTS.md]
export const name = 'myrix-runtime-driver'
export const inject = ['webServer', 'agents', 'sessions', 'agentPresets', 'principals']
export const Config = M.driverConfigSchema   // cellId、tenantId、jwksUrl、限额、空闲阈值

export function apply(ctx: Context, cfg: DriverConfig) {
  const bootId = M.randomId()
  const startedAt = M.nowSec()
  const live = new Map<SessionId, AgentHandle>()
  const receipts = M.receiptStore()           // commandId → 回执；本进程内
  const gate = M.admissionGate()              // cell 准入 + 每会话串行
  const verifier = M.grantVerifier(cfg, { bootId, startedAt })  // ES256、aud、boot、iat、jti 一次性

  // ---- 打开会话：身份在 setup 内安装，commit 只做同步校验 ----
  async function open(g: Grant): Promise<void> {
    const setup = async (agentCtx: Context, agent: Agent) => {
      if (g.op === 'resume' && agent.session.header.agentPreset !== g.preset)
        throw new Error('resume: preset 与绑定不一致')
      await ctx.agentPresets.mount(agentCtx, g.preset)            // [源码] async mount(ctx, id)
      agentCtx.effect(() => ctx.principals.bind(agent, M.principalOf(g)))  // 返回解绑函数
      return { commit() { M.assertNotRevoked(g) } }               // 同步、无 I/O
    }
    const h = g.op === 'create'
      ? await ctx.agents.create({ sessionId: M.sid(g.sid), meta: { agentPreset: g.preset }, setup })
      : await ctx.agents.resume({ resumeSessionId: M.sid(g.sid), setup })
    try {
      M.assertNotRevoked(g)                                        // 覆盖发布期间到达的撤权
      if (!(await ctx.sessions.flush(h.agent.session))) throw new Error('持久化未就绪')
      live.set(h.agent.session.id, h)
    } catch (e) { await h.dispose(); throw e }
  }

  // ---- 命令入口 ----
  async function command(req: Req): Promise<Receipt> {
    const g = await verifier.verifyAndConsume(req.bearer, M.sha256(req.rawBody))
    return gate.run(g.sid, async () => {
      const seen = receipts.get(g.cmd)
      if (seen) return { ...seen, status: 'duplicate' }

      switch (g.op) {
        case 'create':
        case 'resume':
          if (!live.has(M.sid(g.sid))) await open(g)
          break
        case 'send': {
          const h = M.requireOwned(live, ctx.principals, g)       // 所有者 = g.sub
          // [PoC] 用 commandId 作为消息 id，进程重启后可在会话日志里对账
          h.agent.followup(M.userMessage(req.body.text, { messageId: g.cmd }))
          if (!(await ctx.sessions.flush(h.agent.session))) throw new Error('未持久化')
          break
        }
        case 'cancel':
          M.requireOwned(live, ctx.principals, g).agent.cancel({ kind: 'user' })
          break
        default:
          throw new Error('不支持的操作')                           // 默认拒绝
      }
      return receipts.put(g.cmd, { status: 'accepted', commandId: g.cmd, bootId })
    })
  }

  // ---- 撤权：先失效身份，再取消，再销毁 ----
  async function revoke(n: SignedRevocation) {
    M.revocations.acceptMonotonic(M.verifyControlPlaneSignature(n))
    ctx.principals.invalidate(n.sid)          // guard 与模型适配器立即拒绝
    M.events.close(n.sid)
    const h = live.get(n.sid)
    if (h) { h.agent.cancel({ kind: 'disposed' }); await h.dispose(); live.delete(n.sid) }
  }

  // ---- 排空：关准入 → 等空闲 → flush；之后不再打开准入 ----
  async function drain() {
    await gate.closeAndWait()
    for (const h of live.values()) {
      await h.agent.whenIdle()                                     // [源码]
      M.assertInboxEmpty(h.agent)                                  // [PoC] 读 inbox 投影
      if (!(await ctx.sessions.flush(h.agent.session))) throw new Error('flush 失败')
    }
    await M.audit.flushBounded()
    return { drained: true, bootId }
  }

  // ---- 事件：持久事件带 seq，可续传；流式块只转发不补发 ----
  ctx.on('session/event', (session, event) => M.events.publishDurable(session.id, event))
  ctx.on('agent/assistant-stream', p => M.events.publishTransient(p))  // [PoC] 取会话 id 的字段

  // ---- 路由注册：全部通过 effect，卸载时自动撤销 ----
  ctx.effect(() => M.routes(ctx.webServer, {                       // [源码] webServer.register()
    'POST /v1/commands': command,
    'GET /v1/commands/:id': req => receipts.get(req.params.id) ?? M.notFound(),
    'GET /v1/sessions/:sid/events': req => M.events.sse(req, verifier, live),
    'POST /v1/admin/drain': M.requireManager(drain),
    'POST /v1/admin/revoke': M.requireControlPlane(revoke),
    'GET /v1/ready': () => M.readiness({ bootId }),
  }))
  ctx.effect(() => async () => {
    await gate.closeAndWait()
    await Promise.all([...live.values()].map(h => h.dispose()))
  })
}
```

### 4.2 `myrix-principal` 与 `myrix-policy-guard`

```ts
// service class：default export [源码 packages/AGENTS.md]
export default class Principals extends Service {
  private byAgent = new WeakMap<Agent, Principal>()
  private bySid = new Map<SessionId, Principal>()      // 撤权与模型适配器按会话查
  private revoked = new Set<SessionId>()

  constructor(ctx: Context) { super(ctx, 'principals') }

  bind(agent: Agent, p: Principal): () => void {
    this.byAgent.set(agent, p); this.bySid.set(p.sid, p)
    return () => { this.byAgent.delete(agent); this.bySid.delete(p.sid) }
  }
  get(agent?: Agent) {
    const p = agent && this.byAgent.get(agent)
    return p && !this.revoked.has(p.sid) ? p : undefined
  }
  bySession(sid?: SessionId) {
    const p = sid && this.bySid.get(sid)
    return p && !this.revoked.has(p.sid) ? p : undefined
  }
  invalidate(sid: SessionId) { this.revoked.add(sid) }
}

// guard：同步，返回字符串即拒绝；undefined 只表示“本 guard 不拒绝”
export const name = 'myrix-policy-guard'
export const inject = ['tools', 'principals']
export function apply(ctx: Context) {
  ctx.effect(() => ctx.tools.guard(exec => {
    const p = ctx.principals.get(exec.agent)
    if (!p) return 'myrix: 会话没有有效身份'
    return M.policy.denialFor(p, exec.name)       // 读控制面下发的策略快照，过期即拒绝
  }))
}
```

### 4.3 小说服务与工具

```ts
// Service Provider：只调用作品服务，服务端再做所有者授权
export default class NovelStore extends Service {
  constructor(ctx: Context) { super(ctx, 'novelStore') }

  saveDraft(p: Principal, d: Draft, signal: AbortSignal) {
    return M.works.post('/chapters/save', {
      auth: M.cellServiceCredential(), actor: p,      // 作品服务校验 actor.tid = 凭证租户
      workId: p.wid, ...d, contentHash: M.sha256(d.text), signal,
    })                                                  // 幂等规则见 §3.5
  }
  searchBible(p: Principal, query: string, signal: AbortSignal) {
    return M.works.post('/bible/search', { auth: M.cellServiceCredential(), actor: p,
      workId: p.wid, query, limit: 12, signal })
  }
}

// Consumer：模型可见工具。参数里没有 tenantId / userId / workId
export const name = 'novel-tools'
export const inject = ['tools', 'principals', 'novelStore']
export function apply(ctx: Context) {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'save_chapter_draft',
    description: '把章节草稿保存为新版本。返回冲突时，先读取最新版本再修改。',
    parameters: {
      chapterId:       { type: 'string', required: true },
      text:            { type: 'string', required: true },
      expectedVersion: { type: 'number', required: true },
    },
    output: M.schemas.saveResult,                      // { status: saved|duplicate|conflict, version }
    async execute(args, exec) {
      const p = ctx.principals.get(exec.agent)
      if (!p) throw new Error('无身份')                 // guard 之外工具自己也检查
      return ctx.novelStore.saveDraft(p, M.pickDraft(args), exec.signal)
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'search_bible',
    description: '检索当前作品的角色、设定与时间线。',
    parameters: { query: { type: 'string', required: true } },
    output: M.schemas.bibleHits,
    async execute(args, exec) {
      const p = ctx.principals.get(exec.agent)
      if (!p) throw new Error('无身份')
      return ctx.novelStore.searchBible(p, M.nonEmpty(args.query), exec.signal)
    },
  })))
}
```

### 4.4 `myrix-llm-gateway`

```ts
class GatewayAdapter extends LlmAdapter {          // [源码] 只需实现 stream()
  constructor(private principals: Principals, private cfg: GatewayConfig) { super() }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const p = this.principals.bySession(options.sessionId)   // [源码] loop 会填 sessionId
    if (!p) throw new Error('myrix: 无归因的模型请求被拒绝')   // [PoC] 压缩等辅助请求是否带 sessionId
    const res = await M.gateway.stream({
      url: this.cfg.baseURL,
      headers: { ...attributionHeaders(/* 按源码签名 */), authorization: M.tenantGatewayToken(),
                 'x-myrix-session': p.sid },          // 网关凭 sid 查权威绑定，不信任其他头
      body: M.gateway.encode(options),
      signal: options.signal,
    })
    yield* M.gateway.toStreamChunks(res)              // 工具参数增量、usage、错误、取消
  }
}

export const name = 'myrix-llm-gateway'
export const inject = ['llm', 'principals']
export function apply(ctx: Context, cfg: GatewayConfig) {
  ctx.effect(() => ctx.llm.registerAdapter(cfg.providers, new GatewayAdapter(ctx.principals, cfg)))
}
```

### 4.5 控制面

```ts
async function createSession(auth: Auth, input: { workId: string; preset: string }) {
  return db.transaction().execute(async tx => {
    await M.requireActiveMember(tx, auth)
    await M.requireWorkOwner(tx, auth, input.workId)            // D11 单一所有者
    const decision = M.governance.decide(M.request(auth, input), await M.rules(tx), { now: clock.now })
    if (decision.effect !== 'allow') throw new Forbidden(decision)
    const b = await tx.insertInto('session_bindings').values({
      sid: M.randomId(), tid: auth.tid, owner: auth.sub, wid: input.workId,
      preset: input.preset, rev: decision.policyRevision,
      cell_id: await M.placeCell(tx, auth.tid), status: 'creating',
    }).returningAll().executeTakeFirstOrThrow()
    await M.enqueueCommand(tx, { sid: b.sid, op: 'create', actor: auth.sub, commandId: M.randomId() })
    return b
  })
}

// 由路由在 cell Ready 之后调用；每次签发都重新检查当前权限
async function issueGrant(cmd: Command, cell: ReadyCell, rawBody: Buffer) {
  const b = await M.loadBinding(cmd.sid)
  if (b.status === 'revoked') throw new Forbidden('revoked')
  await M.requireActiveMember(db, { tid: b.tid, sub: cmd.actor })
  if (b.owner !== cmd.actor) throw new Forbidden('非所有者')
  return M.signES256({
    iss: 'myrix-control-plane', aud: cell.id, boot: cell.bootId,
    tid: b.tid, sid: b.sid, sub: b.owner, wid: b.wid, preset: b.preset, rev: b.rev,
    op: cmd.op, cmd: cmd.commandId, bh: M.sha256(rawBody), jti: M.randomId(), ttl: 60,
  })
}

async function revokeSession(auth: Auth, sid: string) {
  await db.transaction().execute(async tx => {
    await M.authorizeRevocation(tx, auth, sid)
    const rev = await M.markRevokedAndBumpRev(tx, sid)
    await M.outbox(tx, { type: 'revoke', sid, rev })   // 重试通知 cell、作品服务、模型网关
  })
}
```

### 4.6 Cell 管理器（Go）

```go
func (r *CellReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    cell := &v1.TenantCell{}
    if err := r.Get(ctx, req.NamespacedName, cell); err != nil { return ignoreNotFound(err) }
    sts := r.statefulSetFor(cell)            // 每租户一个 StatefulSet + PVC

    switch cell.Status.Phase {
    case Stopped:
        if cell.Spec.WantRunning || cell.Spec.Tier == Dedicated {
            return r.setReplicasThen(ctx, cell, sts, 1, Starting)
        }
    case Starting:
        if podReady(sts) {
            boot, err := r.driver.Ready(ctx, cell)          // GET /v1/ready
            if err == nil { return r.markReady(ctx, cell, boot) }
        }
        if timedOut(cell) { return r.markFailed(ctx, cell, "wake timeout") }
        return requeueAfter(2 * time.Second)
    case Ready:
        if cell.Spec.Tier == Shared && r.idleLongEnough(ctx, cell) {
            return r.setPhase(ctx, cell, Draining)          // 路由立即停止投递
        }
    case Draining:
        if err := r.driver.Drain(ctx, cell); err != nil { return requeueAfter(5 * time.Second) }
        if err := r.scale(ctx, sts, 0); err != nil { return ctrl.Result{}, err }
        if !podGone(sts) { return requeueAfter(2 * time.Second) }
        return r.setPhase(ctx, cell, Stopped)                // 下一轮若 WantRunning 再启动
    case Failed:
        return r.backoffRecover(ctx, cell)                   // 不强删仍存活的旧 Pod
    }
    return ctrl.Result{}, nil
}
```

`WantRunning` 由会话路由通过 Cell 管理器的内部接口置位；路由本身没有 K8s 权限。所有阶段迁移基于 `resourceVersion` 乐观并发，多副本时 leader election 只让一个实例调谐。

### 4.7 会话路由

```ts
// 浏览器命令：持久入队即返回，表示“平台已接收”
async function acceptBrowserCommand(auth: Auth, cmd: BrowserCommand) {
  await M.authorizeAtBff(auth, cmd)
  await M.queue.insertUnique(cmd)            // 唯一键 commandId；正文哈希不同则拒绝
  return { status: 'queued', commandId: cmd.commandId }
}

// 投递循环：每会话 FIFO，同一会话同一时间只有一个投递者
async function deliver(sid: string) {
  await M.queue.withSessionLock(sid, async cmd => {   // pg_try_advisory_xact_lock + FOR UPDATE SKIP LOCKED
    const cell = await M.cellOf(sid)
    if (cell.phase !== 'Ready') { await M.cellManager.wantRunning(cell.id); return }
    const prior = await M.driver.getReceipt(cell, cmd.commandId)   // 先查，避免重复
    if (prior) return M.queue.settle(cmd, prior)
    const grant = await issueGrant(cmd, cell, cmd.rawBody)          // 就绪后才签发
    const receipt = await M.driver.post(cell, cmd.rawBody, grant)
    await M.queue.settle(cmd, receipt)       // 超时不标记，下一轮先查回执
  })
}
```

## 5. 仓库结构

```text
myrix/
├─ apps/                       # 可部署进程
│  ├─ bff/                     # Fastify：OIDC、CSRF、SSE 转发；会话路由作为模块
│  ├─ control-plane/           # 由 packages/control-plane 迁入
│  ├─ works-service/
│  ├─ model-gateway/
│  ├─ novel-web/               # React + Vite
│  ├─ console/                 # 管理后台
│  └─ cell-manager/            # Go，独立 go.mod，不进 pnpm workspace
├─ packages/                   # 库
│  ├─ contracts/               # 类型 + 线协议 JSON Schema（Go 侧据此生成/校验）
│  ├─ governance/              # 纯函数 PDP，时钟由调用方注入
│  ├─ registry/                # 纯函数 profile 渲染
│  ├─ grant/                   # 凭证签发与校验（控制面、driver 共用）
│  └─ knowledge/               # 保留契约，v0.1 不用
├─ plugins/                    # Cordis 插件
│  ├─ myrix-runtime-driver/  myrix-principal/  myrix-policy-guard/
│  ├─ myrix-llm-gateway/     myrix-audit/
│  └─ novel-store/           novel-tools/
├─ bundles/
│  ├─ myrix-base/              # package.json 的 dsh.bundle + cordis.patch.yml 白名单
│  └─ myrix-novel/             # 小说插件 + presets
├─ deploy/helm/myrix/
└─ tests/{loader,integration,e2e,poc}/
```

依赖方向：`apps → packages`；`plugins → DSH 公共 API + packages/contracts、packages/grant`；Go 只依赖 `contracts` 导出的 JSON Schema。插件不导入任何 `apps/*`；前端只调用 BFF。`pnpm-workspace.yaml` 需要加入 `bundles/*`。删除 `packages/dsh-shim`；`plugins/dsh-plugin-governance` 由 `myrix-policy-guard` 取代，`dsh-plugin-entitlement`、`dsh-plugin-knowledge` 在 v0.1 移出构建。

## 6. 测试策略

| 层 | 工具 | 覆盖 |
|---|---|---|
| 纯函数 | Vitest + fast-check | PDP 判定、凭证校验表（每个 claim 的错误值）、Cell 状态机迁移与竞态、幂等判定 |
| DSH 真实组合 | `dsh-loader-smoke`（vendor test-support）+ test-only profile | 只 mock 模型与作品服务；断言工具可见性、无身份拒绝、setup/commit 失败不发布、dispose 后注册消失、`--dump-config` 无禁用插件 |
| 数据库 | 真实 Postgres（CI 服务容器） | RLS 以非 BYPASSRLS 角色运行；跨租户查询为空；队列唯一键与会话锁 |
| Go | envtest | 调谐、选主、超时回退 |
| 集群 | kind + 故障脚本 | `kill -9`、节点驱逐、缩容与唤醒竞争 |
| 前端 | Playwright | 唤醒中提示、断线续传、冲突处理 |

准入门槛保持 `pnpm typecheck && pnpm test`，另加 Loader 组合测试与 Go 测试。Phase 0 的 P1–P8 映射：P1、P2 → DSH 组合测试；P3、P4 → 数据库与集群负例；P5、P6 → 集群故障脚本；P7 → 小说事实准确率回归；P8 → 换 DSH 版本跑全部组合测试与历史会话回放。

## 7. 风险与 PoC

| # | 项 | 处置 |
|---|---|---|
| R1 | 在 setup 内 `await presets.mount()` 的行为 | P1 首先验证；失败则 preset 改为在 bundle 中静态挂载 |
| R2 | `myrix-base` 白名单能否独立启动（`sdk-minimal` 也带 shell 与 jobs，不能整包照抄 [源码]） | P1 |
| R3 | `send` 能否用 `commandId` 作消息 id，从而重启后在日志里对账 | P2；不行则只保证进程内去重，跨重启依赖路由先查回执 |
| R4 | 压缩等辅助模型请求是否携带 `sessionId` | P2；不带则拒绝，或为其补归因 |
| R5 | `agent/assistant-stream` 负载里取会话 id 的字段 | P1 读源码确认 |
| R6 | 节点级 mTLS 方案是否可用 | P3；不可用则 driver 自持 HTTPS |
| R7 | 每节点块存储卷上限、冷启动 p95 | P6 |
| R8 | 撤权通知延迟与在途写入的竞争 | P2、P4 实测；作品服务同时校验撤销版本兜底 |
| R9 | 开源模型网关能否作为下游 | Phase 0 联网核实后再定 |
| R10 | DSH API pre-stable | 锁定 639ed01；升级必须过 P8 |

## 8. 需要新写的 ADR

1. Runtime Cell、CRD 与缩到零状态机
2. 授权凭证格式（ES256、claims、重放防护、重试规则）
3. 驱动协议（POST + SSE、回执语义、续传）
4. 写操作幂等（版本号 + 正文哈希；外部系统用业务操作 ID）
5. 语言策略（TS 为主，Go 仅限 Cell 管理器）
