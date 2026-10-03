# binding-lease：Cell 侧绑定租约（实现与接口契约）

状态：已实现；2026-09-30 做过本地局部测试（**历史本地记录**，不构成当前保证，
用例数不再复述；当前验证方法与证据边界见 [验证方法](../testing/acceptance.md)）。真实端到端
（真实 DSH agent-loop + 真实作品服务）见 §9。

依据：[ADR-0019](../adr/0019-cell-binding-leases.md)、[ADR-0024](../adr/0024-policy-snapshot-lease.md)、
[ADR-0025](../adr/0025-novel-deployment-policy.md)。原平台/技术草案（含本节早期依赖的章节号）
已于 2026-10-02 本地归档，见[文档维护、归档与脱密](../documentation-policy.md)；本文不再链接草案路径。
DSH 锁定 `639ed015397290b3745d163aafe02ffee4aa3f84`（包版本 `0.2.0-rc.2`，`@deepseek-ai/cordis@4.0.4`）。

## 1. 为什么需要这个插件

`@myrix/principals` 的准入路径是**同步**的：guard 在工具执行前同步调用 `lookup()`，
而 `lookup()` 要求外部通过 `setLiveness(fn)` 安装一个 `(principal) => boolean`。
未安装时一律 `liveness-unavailable` —— 这是刻意的 fail-closed，但意味着
`myrix-runtime-driver` 与 `myrix-policy-enforcer` 装好之后，**所有工具调用都会被拒**。

`myrix-runtime-driver` 不安装活性判定是对的：它不持有权威绑定数据，也不该去发网络请求。
所以"谁能在不破坏同步约束的前提下回答'此刻这个主体还是不是 active 成员'"必须是一个
独立插件。本插件就是它：把作品服务的**有限时长授权快照**翻译成一个进程内的同步判定。

写边界：只新增 `plugins/myrix-binding-lease/**` 与本文件。未改 `vendor/`、其他 `plugins/*`、
`apps/*`、根 `package.json`/`pnpm-workspace.yaml`/`pnpm-lock.yaml`/`tsconfig.json`/`vitest.config.ts`。

## 2. 公开配置（`Config`）

```yaml
'@myrix/binding-lease':
  cellId:     !env MYRIX_CELL_ID
  tenantId:   !env MYRIX_TENANT_ID
  origin:     !env MYRIX_WORKS_ORIGIN       # https://works.internal:8443 或 http://127.0.0.1:8081
  token:      !env MYRIX_CELL_WORKS_TOKEN   # Cell 服务 token；Config 是唯一来源
  # 以下都可省略，用默认值
  # path: '/internal/v1/cells/{cellId}/bindings'
  # ttlMs: 10000
  # refreshMs: 3000
  # requestTimeoutMs: 3000
  # maxResponseBytes: 1048576
  # refreshOnAgentCreated: true
```

| 字段 | 必填 | 默认 | 约束（违反即**加载失败**） |
|---|---|---|---|
| `cellId` | 是 | — | 非空、≤128 字符；用于拼路径并把响应里的 `cellId` 比对掉 |
| `tenantId` | 是 | — | 非空、≤128 字符；响应里的 `tenantId` 必须相等 |
| `origin` | 是 | — | 必须显式 `https:`；`http:` **仅**允许 `127.0.0.1`/`localhost`/`[::1]`；不得带凭据、路径、查询串、fragment |
| `token` | 是 | — | ≥32 字符；只作为 `Authorization: Bearer …` 发出，不写日志、不进诊断 |
| `path` | 否 | `/internal/v1/cells/{cellId}/bindings` | 必须以 `/` 开头、必须含 `{cellId}`、不得含查询串/fragment/`.`/`..` 段 |
| `ttlMs` | 否 | `10000` | `[1000, 30000]` |
| `refreshMs` | 否 | `3000` | `[100, ttlMs]` 且必须 **严格小于 `ttlMs/2`** |
| `requestTimeoutMs` | 否 | `min(refreshMs, 3000)` | `[100, 10000]` |
| `maxResponseBytes` | 否 | `1048576` | `[1024, 1048576]` |
| `refreshOnAgentCreated` | 否 | `true` | 布尔值；见 §5 |

`refreshMs < ttlMs/2` 是硬约束而不是建议：若周期刷新追不上租约过期，表现会是
"服务完全正常但工具时好时坏全拒"，把真正的失效淹没在噪声里。

## 3. 服务面（运行时装配接口）

插件通过 `ctx.provide('bindingLease', runtime)` 暴露服务，类型 `BindingLease`：

```ts
interface BindingLease {
  /**
   * 立即拉取一次快照并原子替换缓存。永不抛出。
   * 成功 → { installed: true, bindings: n, elapsedMs, expiresAt }
   * 任何失败 → 清空缓存，{ installed: false, rejection, detail }
   */
  refresh(): Promise<LeaseRefreshOutcome>
  /** 清空缓存但保留判定（drain / 失联时调用）；此后一切身份使用被拒。 */
  invalidate(reason: string): void
  /** 诊断；只含计数与到期时刻，**不含**主体列表。 */
  state(): LeaseState
}
```

`refresh()` 的并发语义（已测）：

- **同时到达**的 N 个调用方共享一次下载 —— 与 N 无关，20 个并发仍是至多 2 次新请求。
- **在途请求期间到达**的调用方不会复用那份可能看不到自己的快照，而是等到一次
  **开始于它到达之后**的下载；与它同时到达的调用方共享那一次。
- 峰值在途请求数 ≤ 2（当前 + 一次紧随其后），不会线性放大。
- 卸载后调用返回 `{ installed: false, rejection: 'aborted' }`。

## 4. 线协议（BFF 内部端点）

请求：`GET {origin}{path}`，`Authorization: Bearer <Cell 服务 token>`，`Accept: application/json`。
本插件只发这两个头，`redirect: 'manual'`，不计 cookie、不跟随重定向。

响应（成功，HTTP 200）：

```json
{
  "cellId": "cell-1",
  "tenantId": "t_acme",
  "bindings": [
    { "sid": "…", "tid": "t_acme", "sub": "u_1", "wid": "w_1", "preset": "novel-chapter", "rev": 3 }
  ]
}
```

服务端语义（ADR-0019，`apps/bff/src/works-server.ts` 已实现）：
只返回当前 cell 的 `creating`/`active` 绑定、`active` 租户、`active` 成员、
**未删除且同 owner** 的作品；成员/会话准入复用纯函数 `authorizePlatform` 的 `sessions:read`；
超过 10,000 行返回 503 而不是截断；响应 `Cache-Control: no-store`。

插件侧的拒绝面（任一命中即**清空缓存**）：

| `rejection` | 触发条件 |
|---|---|
| `http-status` | HTTP ≠ 200（只记录状态码，不回显上游正文） |
| `redirect` | 任何 3xx（跟随即意味着 token 可能被带去别的 origin） |
| `too-large` | `content-length` 或流式读取超过 `maxResponseBytes`（行数 >10,000 同样按此拒绝） |
| `malformed-json` | 非 UTF-8 / 非 JSON / 非对象 / 缺 `cellId`/`tenantId`/`bindings` |
| `wrong-cell` / `wrong-tenant` | 响应顶层或行级租户与本 cell 配置不一致 |
| `duplicate-sid` | 同一 `sid` 出现两行（两份矛盾记录无法判断真假） |
| `malformed-row` | 字段缺失/超长、`rev` 非非负安全整数、出现**未知字段**（wire 漂移必须显式暴露） |
| `aborted` | 请求超时、`invalidate()`、scope 卸载 |
| `network` | 连接层异常（只保留异常类型名） |

## 5. 创建竞态：为什么这样挂钩，以及残留窗口

**竞态**：控制面把一个新绑定写入数据库后立刻下发 `driver create`，而周期快照
（`refreshMs` 默认 3s）还没有它 → 绑定后的第一次工具调用会被拒。

**不做的事**：不放宽准入（例如"查不到就当作有效"）。那会把"成员刚被停用"也一起放行。

**做两件事**：

1. **默认自动挂钩**（`refreshOnAgentCreated: true`）：本插件监听 `agent/created`，
   在监听器里 `await refresh()`。

   ```ts
   ctx.on('agent/created', async () => { await runtime.refresh() })
   ```

   `agent/created` 是 DSH 声明的 **serial** 事件
   （`packages/core/agent/src/runtime-types.ts:261`），由
   `AgentRegistry.announce()` 用 `await this.ctx.serial(entry.carrier, 'agent/created', …)` 派发
   （`packages/core/agent/src/index.ts:537-556`，serial 派发在 `:550`），而 `announce()` 在
   `PreparedAgent.publish()` 内部被 await（`packages/core/agent-loop/src/index.ts:624`），
   `publish()` 又位于 `ctx.agents.create()/resume()` **resolve 之前**
   （同文件 `setupAndPublish` `:753-779`，其中 `:776` 先跑 setup commit、`:778` 才 publish）。
   因此这个 hook 确实是"被 await 的"，不是 fire-and-forget。

2. **暴露 `refresh()` 服务**：调用方若在 driver `setup` 适配里刷新，
   `await ctx.bindingLease.refresh()` 同样安全（合并 + 幂等）。

**残留窗口（诚实记录）**：`myrix-runtime-driver` 在 `setup` 回调**内部**就
`principals.bind(...)`，而 setup 在 `agent/created` **之前**执行。若在 setup 内部、
绑定之后立刻发生一次**同步**工具调用或身份查询，它会看到"判定已装但无有效租约"并被拒。
本插件与 driver 现存的代码里没有这种路径（driver 的 `commit()` 只查撤权；
第一个工具调用发生在发布并收到 `send` 之后）。方向是正确的：窗口内**拒绝**，
不是放行。彻底消除需要 driver 侧改动（`setup` 内 `await principals.refreshLiveness()`），
须同步评审 driver 生命周期，不能通过放宽活性判定解决。

## 6. 为什么缓存必须逐字段全比（不是只比 sid/rev）

`Principal` 有六个字段，每个都承载一条权限事实：

| 字段 | 不比它会发生什么 |
|---|---|
| `sid` | 会话换了主人也照样放行 |
| `tid` | 跨租户主体被当成同租户 |
| `sub` | 同一 `sid` 被换成另一个所有者（会话接管） |
| `wid` | 越权访问别的作品 |
| `preset` | 挂上别的 preset 的工具集 |
| `rev` | 已撤权/已过期的版本被当成当前版本 |

`LeaseCache.lookup()` 的顺序是**先 TTL、再六字段全等**；租约过期后即使行还在表里
（诊断上要能区分"租约失效"与"数据被删"），判定也必须是 `false`。

## 7. 生命周期与资源

- `apply()` 里 `ctx.effect(() => { runtime.start(); return () => runtime.dispose() })`：
  注册即启动，fiber 卸载即停止。
- `start()` **同步**完成（首次刷新是已捕获的 fire-and-forget），因此插件加载不会变成异步。
- `dispose()` 顺序：停周期 timer → abort 在途请求 → 等在途 promise 收敛 →
  `principals.setLiveness(undefined)`。卸载后 `principals.hasLiveness()` 为 `false`，
  `lookup()` 回到 `liveness-unavailable`。
- 默认定时器带 `unref()`：租约心跳不会阻止进程退出。
- 不写盘、不生成身份、不持久化 token；只保留解析后的六元组，不保留原始响应字节。

## 8. 测试覆盖

```bash
npx tsc -p plugins/myrix-binding-lease/tsconfig.json      # 类型检查
npx vitest run plugins/myrix-binding-lease                # 局部测试
```

| 文件 | 覆盖 |
|---|---|
| [`tests/config.test.ts`](../../plugins/myrix-binding-lease/tests/config.test.ts) | origin 白名单（HTTPS / 显式回环 HTTP）、路径模板与编码、TTL/refresh 边界、token 不回显、`redact` |
| [`tests/snapshot.test.ts`](../../plugins/myrix-binding-lease/tests/snapshot.test.ts) | 解析拒绝面（跨 cell/租户、重复 sid、未知字段、>10,000 行）、六字段逐一不等、到期半开区间、请求开始时刻起算、替换而非合并 |
| [`tests/fetch.test.ts`](../../plugins/myrix-binding-lease/tests/fetch.test.ts) | 只发两个头、`redirect: 'manual'`、3xx 拒绝、非 200 不回显正文、content-length 预检、流式超限即断、abort、错误不含 URL/token |
| [`tests/plugin.test.ts`](../../plugins/myrix-binding-lease/tests/plugin.test.ts) | **真实 Cordis**：加载 + 首次刷新、周期替换、TTL 到期拒绝、8 类失败清空、撤权/停用成员移除、六字段换值拒绝、创建竞态、`agent/created` 真实 `ctx.serial` 刷新、并发合并（4/20 个调用方）、卸载（timer 清空 / abort / 无 unhandledRejection / 监听器移除）、`invalidate`、无 secret 泄漏、缺 `principals` 不激活、非法配置加载失败 |

每个文件的用例数量随代码演进变化，不复述旧数字；结果以 CI 实际运行为准
（[验证方法](../testing/acceptance.md)）。时间相关的用例全部通过注入的**手动单调时钟**（`ManualClock`）
与手动定时器（`ManualTimers`）驱动，不依赖 sleep。

## 9. 未验证 / 待处理

| 项 | 状态 |
|---|---|
| 真实 DSH agent-loop + 真实作品服务的端到端（新会话创建后首次工具调用） | **未验证**；本文仅验证到"`ctx.serial('agent/created', …)` 返回时缓存已就绪"这一层 |
| `agent/created` 在真实 `agents.create()` 路径上的时序 | **已读源码核实**（§5 行号），但未在真实进程里跑过 |
| BFF `/internal/v1/cells/:cellId/bindings` 的联调（真实 Postgres + 真实 Cell 凭据） | 端点已在 [`apps/bff/src/works-server.ts`](../../apps/bff/src/works-server.ts) 实现；Cell 装配见 [cell.patch.yml](../../bundles/myrix-base/cell.patch.yml) |
| DSH 依赖引入方式 | 各插件在自己的 `package.json` 写精确版本（`@deepseek-ai/cordis@4.0.4`、`@deepseek-ai/dsh-agent@0.2.0-rc.2`、`@myrix/principals@workspace:*`），由根 workspace + lockfile 解析，见[运行时依赖](../development/runtime-dependencies.md) |
