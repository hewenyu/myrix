# `myrix-novel` 运行时装配

本文记录 `plugins/myrix-novel` 作为**真实 Cordis 插件**的装配接口、安全边界与可复现的冒烟方法。
决策背景见 [ADR-0017](../adr/0017-novel-tools-boundary.md)；业务语义见 [business.md](../business.md)；
当前的证据边界见 [验证方法](../testing/acceptance.md) 与 [小说工具 smoke](../testing/novel-smoke.md)。

状态：已装配进 [bundles/myrix-base/cell.patch.yml](../../bundles/myrix-base/cell.patch.yml)（`myrix-novel` 行）。
本文中标注日期的运行结果都是**历史本地记录**，只描述当时那次运行；它们不构成当前提交、
当前依赖解析或部署形态的保证。

## 1. 公开装配接口

包名 `@myrix/novel`（[package.json](../../plugins/myrix-novel/package.json)，`private`，Apache-2.0）。
两个 Loader 行：

| 行 | 模块 | 作用 |
| --- | --- | --- |
| 根插件 | `@myrix/novel`（[src/index.ts](../../plugins/myrix-novel/src/index.ts)） | 提供 `ctx.novelStore`，注册三个 preset |
| preset 子插件 | `@myrix/novel/preset-tools`（[src/preset-tools.ts](../../plugins/myrix-novel/src/preset-tools.ts)） | 在被装载的 preset 作用域内注册该助手的工具与提示段落 |

根插件导出形状遵循 DSH 的插件约定：具名 `name` / `inject` / `apply`，**没有 default export**。

```yaml
- insert:
    - id: myrix-novel
      name: '@myrix/novel'
      config:
        origin: 'http://works-service:8080'   # 必填；http/https、无路径/查询/凭据
        credential: !!js process.env.MYRIX_WORKS_TOKEN   # 必填；>=32 字符的 Cell 服务凭据
        timeoutMs: 15000                      # 可选，100–120000
        maxResponseBytes: 1000000             # 可选，1024–8000000
        presetPlugin: '@myrix/novel/preset-tools'  # 可选；覆盖 preset 行说明符
```

- `inject = ['tools', 'systemPrompt', 'agentPresets', 'principals']`。
  缺任何一个都不激活：本插件没有“没有身份也能跑”的降级形态。
- **就绪语义**：`apply` 在返回前 `await` 三个 `agentPresets.register()`，所以
  **`apply` resolve 即 `ctx.novelStore` 可读、三个 preset 已在 roster**。装配方仍应按
  Cordis fiber 语义 `await ctx.plugin(...)`（Loader 的 `resolve` 回调就是本 `apply`）。
  副作用是：若宿主把它挂在 preset 子树之外或 `agentPresets` 不可用的位置，
  `register()` 会在装载阶段直接抛错 —— 这就是“明确 driver 挂载发现”失败的方式，
  不会静默跳过。
- **配置没有默认 origin、没有默认凭据**：漏配即抛错，不会静默指向某个地址。
- 注册的三个 preset ID 固定为 `novel-outline` / `novel-chapter` / `novel-bible`，
  显示名/描述/order 见 [presets.ts](../../plugins/myrix-novel/src/presets.ts)。
- 部署侧把 `origin` / `credential` 接在部署配置上；仓库的 Cell 装配层从环境变量读取
  （`MYRIX_WORKS_ORIGIN` / `MYRIX_WORKS_TOKEN`），见 [cell.patch.yml](../../bundles/myrix-base/cell.patch.yml)。
  `agentPresets.default` 仍是 `myrix-empty`：**没有会话绑定的一段预设不会拿到小说工具**；
  带绑定的会话 preset 由控制面判定后写进绑定与凭证。

### 工具与掩码

六个工具只按 preset 掩码注册（唯一来源是
[packages/novel-protocol/src/index.ts](../../packages/novel-protocol/src/index.ts) 的 `PRESET_TOOLS`，
插件侧经 [src/protocol.ts](../../plugins/myrix-novel/src/protocol.ts) 原样再导出；
[src/presets.ts](../../plugins/myrix-novel/src/presets.ts) 据此生成 preset 行）：

| preset | 工具 |
| --- | --- |
| `novel-outline` | `get_outline`、`update_outline`、`search_bible` |
| `novel-chapter` | `get_outline`、`get_chapter`、`save_chapter_draft`、`search_bible` |
| `novel-bible` | `get_outline`、`get_chapter`、`search_bible`、`update_bible_entry` |

**不在根作用域注册**：`tools.schemas()` 永远为空，不属于某助手的工具对该助手
`tools.schemas(agent)` 不可见，越权调用返回 `unknown tool`（不是“可见但被劝阻”）。
preset 行里的 `config.tools` 与协议掩码不一致时，子插件装载**抛错**（不静默少注册）。

### 身份与凭据边界

- 工具 `execute` 的身份只来自可信 `ToolRunContext.agent` → `ctx.principals.require(agent)`
  （[`@myrix/principals`](../../plugins/myrix-principals/src/index.ts) 的严格路径：绑定 + 撤权 + 活性；
  未安装活性提供者即拒绝）。**不使用** `get` / `bySession`（它们绕过活性检查）。
- 模型参数**不接受** `tenantId`/`userId`/`workId`/`sessionId`/URL/凭据/任意附加字段。
- 发给作品服务的只有 `{sessionId, revision}` 与工具参数；workId/owner/成员/当前 preset
  由作品服务在同一事务内查库核验（ADR-0017 决策 5）。请求 URL 里没有 workId。
- 系统提示只注入**服务端绑定**的 `workId`；凭据、URL、token 永不进提示。身份失效时
  渲染为“没有可用的作品绑定”，不猜作品。
- 活性来源是 [`myrix-binding-lease`](../../plugins/myrix-binding-lease/src/index.ts)
  的租约（[ADR-0019](../adr/0019-cell-binding-leases.md)、[binding-lease.md](binding-lease.md)）；
  单独装配本插件时 `require*` 一律拒绝（fail-closed），这是预期行为。

### 严格参数校验的落点

`dsh-tools` 的 `register()` **不校验**模型实参，也不校验参数 schema 的关键字子集；
`tools.execute()` 把 `arguments` 原样交给工具。在锁定 DSH（`0.2.0-rc.2`）上的实测结论：

- 用 raw JSON Schema 当 `parameters`，`additionalProperties:false` / `required` /
  `minimum` 都会**原样投影给模型**；
- 但传入多余字段或把 `expectedVersion` 设成 `-5`，工具照样被执行（`isError:false`）。

因此六个工具的**强制点**是 `execute` 里的 `parseToolArguments()`
（[novel-protocol](../../packages/novel-protocol/src/index.ts)）：
非对象、身份字段、坏 UUID、负/非整数 `expectedVersion`、超长 `query`/`text` 全部拒绝，
且发生在**任何网络 I/O 之前**。输出 schema 另外用 strict `additionalProperties:false`
定义（见 [output.ts](../../plugins/myrix-novel/src/output.ts)、
[ADR-0026](../adr/0026-novel-write-output.md)），避免服务端内部字段被回显给模型。

## 2. 冒烟方法

```sh
# 前置：独立锁定运行时（见运行时依赖文档）
node plugins/myrix-novel/tests/smoke/novel-cell-smoke.mjs
```

冒烟脚本 [novel-cell-smoke.mjs](../../plugins/myrix-novel/tests/smoke/novel-cell-smoke.mjs)
用与 Cell 装配相同的编译/解析契约，在临时 `$DSH_HOME` 里起一个真实锁定 CLI，
再由 [smoke-app.mjs](../../plugins/myrix-novel/tests/smoke/smoke-app.mjs) 探针核对：

| 探针 | 期望 |
| --- | --- |
| `ctx.novelStore` 已提供 | ✅ |
| 三个 preset 在 roster 且 `broken` 为空 | ✅（与 bundle 自带的 `myrix-empty` 并存） |
| 根作用域小说工具数为 0 | ✅ |
| 各 preset 掩码（实测可见工具名） | ✅ 与 `PRESET_TOOLS` 完全一致 |
| `get_outline` 经真实 HTTP 打到替身作品服务并回传结果 | ✅ |
| 提示注入了服务端 `workId`、含 `expectedVersion` 约束 | ✅ |

脚本自身的用途、替身范围与前置条件以 [小说工具 smoke](../testing/novel-smoke.md) 为准；
退出码只表示那次探针是否通过。

冒烟里值得记下的两个**实测坑**（都不是猜测）：

1. **`spawnSync` 会饿死进程内替身服务器**：探针的作品服务跑在父进程里，同步启动子进程
   会阻塞父进程事件循环，子进程的 HTTP 请求永远等不到响应（表现为 15s 超时、零请求到达）。
   改为 async `spawn` 后正常。
2. **profile-local `.mjs` 解析不到裸 `@deepseek-ai/*`**：因此插件必须以**真实包**
   装在 `node_modules/@myrix/novel/`（带自己的 `exports`），preset 行才能用默认包名
   `@myrix/novel/preset-tools`。这与 [cell-profile.mjs](../../tests/poc/lib/cell-profile.mjs)
   的 Cell 组装方式一致。
3. 冒烟若**不**安装活性提供者，`principals.require()` 会以
   `liveness-unavailable` 拒绝一切身份 —— 这是设计行为。冒烟用显式的活性替身替代 driver。

## 3. 测试覆盖

测试文件是对 `execute` 契约与真实 Cordis 装配的回归，具体用例数随代码演进变化，
以 CI 实际运行为准（见 [验证方法](../testing/acceptance.md)）：

| 文件 | 覆盖 |
| --- | --- |
| [tests/tools.test.ts](../../plugins/myrix-novel/tests/tools.test.ts) | `execute` 契约：身份来源、身份字段注入拒绝、版本/ID/长度校验、冲突不伪装、只读工具免版本 |
| [tests/plugin.test.ts](../../plugins/myrix-novel/tests/plugin.test.ts) | 真实 Cordis：preset roster、作用域可见性、掩码拒绝、撤权后立即拒绝、活性缺失 fail-closed、提示注入与撤权后不回显、卸载清理、一次真实 Agent 回合（替身模型） |
| [tests/preset-module.test.ts](../../plugins/myrix-novel/tests/preset-module.test.ts) | preset 行默认包名、掩码一致性、提示安全约束（含“不含 token/Bearer”） |
| [tests/output-contract.test.ts](../../plugins/myrix-novel/tests/output-contract.test.ts) | 工具输出投影：只回声明字段，不泄漏存储层内部字段 |
| [tests/client.test.ts](../../plugins/myrix-novel/tests/client.test.ts) | HTTP 客户端边界：注入、会话/版本传递、409 保留、限额、origin、六工具掩码 |

**替身声明**（测试结论的适用范围）：

- **模型**：[tests/stub-model.ts](../../plugins/myrix-novel/tests/stub-model.ts) /
  [tests/smoke/smoke-mock-llm.mjs](../../plugins/myrix-novel/tests/smoke/smoke-mock-llm.mjs)
  的无密钥适配器。真实 Agent 回合（工具调用 → 真实 `dsh-tools` 执行 → 结果回灌）是真的，
  但**模型本身是替身**，不证明任何真实 provider/model 可用。
- **作品服务**：进程内 `fetch` / HTTP 替身，**不证明** RLS、数据库权限、并发撤权安全。
- 测试台把 preset 子插件注册为 Loader 内建 `cordis:…` 行（vitest 进程没有 profile 解析根）；
  **默认包名**路径由冒烟（真实 profile）与 preset 模块测试分别覆盖。

## 4. 历史本地验收不保证当前

- 本文和 [小说工具 smoke](../testing/novel-smoke.md) 记录过本地跑通的真实装配冒烟；
  那是**当时那次本地运行**，不是当前提交、当前依赖解析或线上部署的证明。
  证据分层与解读方式见 [验证方法](../testing/acceptance.md)。
- **不是模型验收**：真实 provider 的工具回合、模型归因、限额、取消、压缩辅助调用
  由显式 opt-in 的浏览器/模型验收覆盖，不在本插件的冒烟范围内。
- **不证明数据库安全**：真实 PostgreSQL 的非 owner 登录、RLS、事务撤权竞态由
  [apps/bff/tests/postgres.integration.test.ts](../../apps/bff/tests/postgres.integration.test.ts)
  等集成测试覆盖；本插件的冒烟只用了替身。
- **历史本地记录里曾出现的整仓测试失败**属于当时的并行开发状态，已不是当前事实；
  当前门禁以 [验证方法](../testing/acceptance.md) 与 CI 为准，本文不再复述当时的失败清单。

## 5. 依赖与装配注意事项

- 插件依赖写在 [plugins/myrix-novel/package.json](../../plugins/myrix-novel/package.json)：
  `dependencies` 是运行期真正需要的（`@deepseek-ai/cordis`、`dsh-tools`、`dsh-system-prompt`、
  `dsh-agent-preset-registry`、`@myrix/novel-protocol`、`@myrix/principals`）；
  `devDependencies` 只是**测试台**用的（`cordis-plugin-loader`/`cordis-plugin-group`
  用于真实 Loader 子树，`dsh-agent`/`dsh-agent-loop`/`dsh-session`/`dsh-session-projection`/`dsh-llm`
  用于组合台）。依赖解析方式见[运行时依赖](../development/runtime-dependencies.md)。
- `package.json` 的 `exports` 含 `./preset-tools`：**preset 行的默认说明符**
  `@myrix/novel/preset-tools` 依赖它。若部署把子插件改名或改路径，请用根插件的
  `presetPlugin` 配置覆盖，而不是删掉这条 subpath。
- Cell 装配还需要 `MYRIX_WORKS_TOKEN`（`origin`/`credential` 两行配置）与 `myrix-principals`
  等行；当前装配已在 [cell.patch.yml](../../bundles/myrix-base/cell.patch.yml) 的 `myrix-novel` 行完成，
  由 `myrix-policy-enforcer` 再把六个工具名与部署白名单、策略快照取交集。
