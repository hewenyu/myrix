# `myrix-novel` 运行时装配（首版）

本文记录 `plugins/myrix-novel` 从"HTTP/客户端边界"补齐为**真实 Cordis 插件**的实际做法、
实测命令与结果，以及**尚未验证**的部分。
[ADR-0017](../adr/0017-novel-tools-boundary.md) 是决策记录，这里只写"怎么做、测到了什么"。

## 1. 公开装配接口

包名 `@myrix/novel`（`plugins/myrix-novel/package.json`，`private`，Apache-2.0）。
两个 Loader 行：

| 行 | 模块 | 作用 |
| --- | --- | --- |
| 根插件 | `@myrix/novel`（`src/index.ts`） | 提供 `ctx.novelStore`，注册三个 preset |
| preset 子插件 | `@myrix/novel/preset-tools`（`src/preset-tools.ts`） | 在被装载的 preset 作用域内注册该助手的工具与提示段落 |

根插件导出形状遵循 DSH `packages/AGENTS.md`：具名 `name` / `inject` / `apply`，
**没有 default export**。

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
  缺任何一个都不激活：本插件没有"没有身份也能跑"的降级形态。
- **就绪语义**：`apply` 在返回前 `await` 三个 `agentPresets.register()`，所以
  **`apply` resolve 即 `ctx.novelStore` 可读、三个 preset 已在 roster**。装配方仍应按
  Cordis fiber 语义 `await ctx.plugin(...)`（Loader 的 `resolve` 回调就是本 `apply`）。
  副作用是：若宿主把它挂在 preset 子树之外或 `agentPresets` 不可用的位置，
  `register()` 会在装载阶段直接抛错 —— 这就是"明确 driver 挂载发现"失败的方式，
  不会静默跳过。
- **配置没有默认 origin、没有默认凭据**：漏配即抛错，不会静默指向某个地址。
- 注册的三个 preset ID 固定为 `novel-outline` / `novel-chapter` / `novel-bible`
  （`docs/implementation/first-version.md` 的基线），显示名/描述/order 见 `src/presets.ts`。

### 工具与掩码

六个工具只按 preset 掩码注册（`src/protocol.ts` 的 `PRESET_TOOLS`，`src/presets.ts` 生成行）：

| preset | 工具 |
| --- | --- |
| `novel-outline` | `get_outline`、`update_outline`、`search_bible` |
| `novel-chapter` | `get_outline`、`get_chapter`、`save_chapter_draft`、`search_bible` |
| `novel-bible` | `get_outline`、`get_chapter`、`search_bible`、`update_bible_entry` |

**不在根作用域注册**：`tools.schemas()` 永远为空，不属于某助手的工具对该助手
`tools.schemas(agent)` 不可见，越权调用返回 `unknown tool`（不是"可见但被劝阻"）。
preset 行里的 `config.tools` 与协议掩码不一致时，子插件装载**抛错**（不静默少注册）。

### 身份与凭据边界

- 工具 `execute` 的身份只来自可信 `ToolRunContext.agent` → `ctx.principals.require(agent)`
  （`@myrix/principals` 的严格路径：绑定 + 撤权 + 活性；未安装活性提供者即拒绝）。
  **不使用** `get` / `bySession`（它们绕过活性检查）。
- 模型参数**不接受** `tenantId`/`userId`/`workId`/`sessionId`/URL/凭据/任意附加字段。
- 发给作品服务的只有 `{sessionId, revision}` 与工具参数；workId/owner/成员/当前 preset
  由作品服务在同一事务内查库核验（ADR-0017 决策 5）。请求 URL 里没有 workId。
- 系统提示只注入**服务端绑定**的 `workId`；凭据、URL、token 永不进提示。身份失效时
  渲染为"没有可用的作品绑定"，不猜作品。

### 严格参数校验的落点（实测结论）

`dsh-tools` 的 `register()` **不校验**模型实参，也不校验参数 schema 的关键字子集；
`tools.execute()` 把 `arguments` 原样交给工具。实测（`0.2.0-rc.2`）：

- 用 raw JSON Schema 当 `parameters`，`additionalProperties:false` / `required` /
  `minimum` 都会**原样投影给模型**；
- 但传入多余字段或把 `expectedVersion` 设成 `-5`，工具照样被执行（`isError:false`）。

因此六个工具的**强制点**是 `execute` 里的 `parseToolArguments()`（`src/protocol.ts`）：
非对象、身份字段、坏 UUID、负/非整数 `expectedVersion`、超长 `query`/`text` 全部拒绝，
且发生在**任何网络 I/O 之前**。输出 schema 另外用 strict `additionalProperties:false`
定义（`src/tools.ts`），避免服务端内部字段被回显给模型。

## 2. 实测命令与结果

```sh
# 插件单独类型检查（干净）
npx tsc -p plugins/myrix-novel/tsconfig.json

# 全仓类型检查
pnpm typecheck            # tsc -p tsconfig.json && (novel-web)  → 通过

# 插件测试（44 项，含原有 client.test.ts 的 6 项）
npx vitest run plugins/myrix-novel
#  → 4 files / 44 tests passed

# 真实锁定 DSH 冒烟
node plugins/myrix-novel/tests/smoke/novel-cell-smoke.mjs
#  → dsh exit=0；7/7 探针通过；作品服务收到 3 次 get_outline
```

冒烟（`tests/smoke/novel-cell-smoke.mjs`）实测到的事实：

| 探针 | 结果 |
| --- | --- |
| `ctx.novelStore` 已提供 | ✅ |
| 三个 preset 在 roster 且 `broken` 为空 | ✅（与 bundle 自带的 `myrix-empty` 并存） |
| 根作用域小说工具数为 0 | ✅ |
| 各 preset 掩码（实测可见工具名） | ✅ 与 `PRESET_TOOLS` 完全一致 |
| `get_outline` 经真实 HTTP 打到替身作品服务并回传结果 | ✅ |
| 提示注入了服务端 `workId`、含 `expectedVersion` 约束 | ✅ |

冒烟里值得记下的两个**实测坑**（都不是猜测）：

1. **`spawnSync` 会饿死进程内替身服务器**：探针的作品服务跑在父进程里，同步启动子进程
   会阻塞父进程事件循环，子进程的 HTTP 请求永远等不到响应（表现为 15s 超时、零请求到达）。
   改为 async `spawn` 后正常。
2. **profile-local `.mjs` 解析不到裸 `@deepseek-ai/*`**：因此插件必须以**真实包**
   装在 `node_modules/@myrix/novel/`（带自己的 `exports`），preset 行才能用默认包名
   `@myrix/novel/preset-tools`。这与 `tests/poc/lib/cell-profile.mjs` 的 Cell 组装方式一致。
3. 冒烟若**不**安装活性提供者，`principals.require()` 会以
   `liveness-unavailable` 拒绝一切身份 —— 这是设计行为（首版里活性由
   `myrix-runtime-driver` 的 binding lease 提供）。冒烟用显式的活性替身替代 driver。

## 3. 测试覆盖

| 文件 | 覆盖 |
| --- | --- |
| `tests/tools.test.ts`（19） | `execute` 契约：身份来源、身份字段注入拒绝、版本/ID/长度校验、冲突不伪装、只读工具免版本 |
| `tests/plugin.test.ts`（14） | 真实 Cordis：preset roster、作用域可见性、掩码拒绝、撤权后立即拒绝、活性缺失 fail-closed、提示注入与撤权后不回显、卸载清理、一次真实 Agent 回合（替身模型） |
| `tests/preset-module.test.ts`（5） | preset 行默认包名、掩码一致性、提示安全约束（含"不含 token/Bearer"） |
| `tests/client.test.ts`（6，原有） | HTTP 客户端边界：注入、会话/版本传递、409 保留、限额、origin、六工具掩码 |

**替身声明**（测试结论的适用范围）：

- **模型**：`tests/stub-model.ts` / `tests/smoke/smoke-mock-llm.mjs` 的无密钥适配器。
  真实 Agent 回合（工具调用 → 真实 `dsh-tools` 执行 → 结果回灌）是真的，但
  **模型本身是替身**，不证明任何真实 provider/model 可用。
- **作品服务**：进程内 `fetch` / HTTP 替身，**不证明** RLS、数据库权限、并发撤权安全。
- 测试台把 preset 子插件注册为 Loader 内建 `cordis:…` 行（vitest 进程没有 profile 解析根）；
  **默认包名**路径由冒烟（真实 profile）与 `preset-module.test.ts` 分别覆盖。

## 4. 尚未验证 / 不得声称

- **不是模型验收**：没有用真实 provider 跑过工具回合；模型归因、限额、取消、压缩辅助调用未验证。
- **不证明数据库安全**：真实 PostgreSQL 的非 owner 登录、RLS、事务撤权竞态由
  `apps/bff/tests/postgres.integration.test.ts` 覆盖；本文档的冒烟只用了替身。
- **不是浏览器闭环**：`apps/novel-web` ↔ BFF ↔ Cell ↔ 作品服务的端到端尚未打通。
- **未装配进 `bundles/myrix-base`**：`cell.patch.yml` 里还没有 `myrix-novel` 行，也没有
  `MYRIX_WORKS_TOKEN` 的注入；`bundles/` 由 Lead 统一组装。
- **preset 默认路由**：`agentPresets` 的 `default` 仍是 `myrix-empty`；浏览器按会话选
  preset 的路径（`agent/request` waterfall）尚未接到这三个 preset。
- **活性来源**：首版活性只能由 `myrix-runtime-driver` 的 binding lease 提供；单独装配
  本插件时 `require*` 一律拒绝（fail-closed），这是**预期**行为而非缺陷。
- **全仓 `npx vitest run` 的基线**：本插件 44 项全通过。同一命令下仍有两处**与本插件无关**的失败
  （都不含 novel 代码，均可单独复现，属其他 agent 的范围）：
  - `apps/bff/tests/runtime-stream.test.ts`：一处断言正则 `/同一租户出现多个 cell/` 与实际
    抛出的中文文案不匹配（断言文案问题，不是行为问题）。
  - `plugins/myrix-llm-gateway/tests/smoke.dsh.test.ts`：并发全量运行时偶发 2 项失败，
    单独重跑 3/3 通过（负载相关）。
  Lead 做全量准入时需先处理这两处，再确认本插件不回归。

## 5. 依赖与装配注意事项（给 Lead）

- **未跑全仓 `pnpm install`**。插件依赖已写进 `plugins/myrix-novel/package.json`：
  `dependencies` 是运行期真正需要的（`cordis`、`dsh-tools`、`dsh-system-prompt`、
  `dsh-agent-preset-registry`、`@myrix/principals`）；`devDependencies` 只是**测试台**用的
  （`cordis-plugin-loader`/`cordis-plugin-group` 用于真实 Loader 子树，`dsh-agent`/
  `dsh-agent-loop`/`dsh-session`/`dsh-session-projection`/`dsh-llm` 用于组合台）。
- 本次本地验证借用的是既有 gitignored 临时安装 `node_modules/.dsh-types/`（见
  `docs/implementation/runtime-driver.md` §9）；为跑真实 Loader 子树，我在该临时目录里
  补了两个链接 `cordis-plugin-loader@1.0.5`、`cordis-plugin-group@1.0.4`（版本取自
  `tests/poc/.dsh-install` 的锁定安装）。**`.dsh-types` 不是交付物**；Lead 统一
  `pnpm install` 后应由 lockfile 解析这些依赖。
- `package.json` 的 `exports` 含 `./preset-tools`：**preset 行的默认说明符**
  `@myrix/novel/preset-tools` 依赖它。若部署把子插件改名或改路径，请用根插件的
  `presetPlugin` 配置覆盖，而不是删掉这条 subpath。
- 细胞装配还需要 `MYRIX_WORKS_TOKEN`（写成 `origin`/`credential` 两行配置）与
  `myrix-principals` 行；`bundles/myrix-base/cell.patch.yml` 尚未加入本插件。
