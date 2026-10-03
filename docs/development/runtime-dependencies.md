# Myrix 当前运行时依赖

本文件说明 Myrix 本地开发、Cell 白名单装配与 smoke 所共用的**独立锁定 DSH 运行时**，
以及"哪些包装进机器、哪些包允许挂进 Cell"这两件事的区别。真实开发装配步骤见
[本地开发指南](<../implementation/local-development.md>)；证据边界见
[验证方法](<../testing/acceptance.md>)。（本文件替代早期的 Phase0/P1/P2 PoC 依赖清单。）

`tests/poc/.dsh-install/` 不在 `pnpm-workspace.yaml` 的包列表内，必须单独安装。
除 `tests/poc/**` smoke 外，当前 `pnpm dev` 也通过同一个 CLI 解析器使用此安装；
业务包不会把整个 DSH 发布包混入自身的工作区依赖。

## 1. 运行时本体

| 包 | 版本 | 说明 |
|---|---|---|
| `@deepseek-ai/dsh` | `0.2.0-rc.2` | CLI + 启动器；与只读 vendor 的锁定源码版本号相同，但未证明 npm 产物逐字节对应提交 `639ed01` |

一条命令（在 `tests/poc/.dsh-install/` 下）：

```bash
pnpm install --frozen-lockfile
```

`node-linker=hoisted` + `auto-install-peers=true` 是**必须的**，见
[隔离安装的 .npmrc](<../../tests/poc/.dsh-install/.npmrc>) 的注释：DSH 的 profile 解析器会遍历安装目录的依赖图，
嵌套的 pnpm 布局会让 `@deepseek-ai/dsh-*` 的查找依赖虚拟 store 的哈希。

## 2. 白名单 bundle 实际用到的 DSH 包

这些**不需要单独安装**：它们是 `@deepseek-ai/dsh` 的依赖闭包，由第 1 步一并装上。
列出它们是为了让“白名单”可审计 —— [cordis.patch.yml](../../bundles/myrix-base/cordis.patch.yml)
里的每一行 `name:` 都必须在下面出现。

### 行（row）插件：构成 Cordis 树

| patch 行 id | 包名 | 服务/职责 |
|---|---|---|
| `timer` | `@deepseek-ai/cordis-plugin-timer` | `ctx.timeout` / `interval` / `throttle` / `debounce` |
| `llm` | `@deepseek-ai/dsh-llm` | `ctx.llm` 适配器注册表 + `stream()` |
| `session` | `@deepseek-ai/dsh-session` | `ctx.sessions`；`flush()`；`session/event`、`session/flush` |
| `session-persistence-jsonl` | `@deepseek-ai/dsh-session-persistence-jsonl` | `ctx.sessionPersistence`；JSONL 后端 |
| `session-projection` | `@deepseek-ai/dsh-session-projection` | `ctx.sessionProjections`（preset 与 token-meter 的硬依赖） |
| `system-prompt` | `@deepseek-ai/dsh-system-prompt` | `ctx.systemPrompt`；prompt 段落/变量 |
| `tools` | `@deepseek-ai/dsh-tools` | `ctx.tools`；`register()` / `guard()` / `execute()` |
| `agent` | `@deepseek-ai/dsh-agent` | `ctx.agents`；`create()` / `resume()` / `AgentHandle` |
| `agent-loop` | `@deepseek-ai/dsh-agent-loop` | `AgentFactory`；`followup()` / `whenIdle()` / `cancel()` |
| `llm-retry` | `@deepseek-ai/dsh-llm-retry` | 请求重试 |
| `token-meter` | `@deepseek-ai/dsh-token-meter` | `ctx.tokenMeter` |
| `compaction` | `@deepseek-ai/dsh-compaction-basic` | `ctx.compaction`；`compactIfNeeded` / `compactNow` |
| `approval` | `@deepseek-ai/dsh-user-approval` | `ctx.approval`；本 bundle 配 `policy: never`（fail-closed） |
| `attachment-local` | `@deepseek-ai/dsh-attachment-local` | `ctx.attachments` 的本地实现 |
| `agent-preset-registry` | `@deepseek-ai/dsh-agent-preset-registry` | `ctx.agentPresets`；`mount(ctx, id)` |
| `preset-myrix-empty` | `@deepseek-ai/dsh-agent-preset` | 一条 preset 声明（`plugins: []`） |
| `invariants` | `@deepseek-ai/dsh-invariants` | `ctx.invariants` 注册表 |
| `session-invariant` | `@deepseek-ai/dsh-session/invariant` | session 包的不变量伴侣 |
| `agent-invariant` | `@deepseek-ai/dsh-agent/invariant` | agent 包的不变量伴侣 |
| `scope-invariant` | `@deepseek-ai/dsh-scope/invariant` | scope 包的不变量伴侣 |
| `agent-loop-invariant` | `@deepseek-ai/dsh-agent-loop/invariant` | agent-loop 包的不变量伴侣 |

Cell 的第二层 patch（[cell.patch.yml](../../bundles/myrix-base/cell.patch.yml)）在此之上追加
Myrix 自己的行（`@myrix/principals`、`@myrix/policy-enforcer`、`@myrix/binding-lease`、
`@myrix/runtime-driver`、`@myrix/llm-gateway`、`@myrix/novel`）与 Cell HTTP 载体
`@deepseek-ai/dsh-host-webserver`；行的职责见[与 DSH 的集成入口](../integration/dsh-seams.md)。

### 传递 peer / 服务定义包（不在 patch 里出现，但必须可解析）

`@deepseek-ai/dsh-scope`、`@deepseek-ai/dsh-invariants`、
`@deepseek-ai/dsh-session-persistence`、`@deepseek-ai/dsh-typert-protocol`、
`@deepseek-ai/dsh-typert-registry`、`@deepseek-ai/dsh-brand`、
`@deepseek-ai/dsh-util-values`、`@deepseek-ai/dsh-home-paths`、
`@deepseek-ai/dsh-attachment`、`@deepseek-ai/dsh-compaction`、
`@deepseek-ai/dsh-commands`（仅类型）、`@deepseek-ai/dsh-agent-preset-registry`、
`@deepseek-ai/cordis`、`@deepseek-ai/cordis-plugin-include`、
`@deepseek-ai/cordis-plugin-loader`、`@deepseek-ai/cordis-plugin-group`。

## 3. 明确不装配（Cell 白名单排除）

“不装配”不等于“不下载”。以下包是 `@deepseek-ai/dsh` 依赖闭包的一部分，`pnpm install`
仍会把它们下载到安装目录；**Cell 白名单不挂载它们的行**，装配断言它们既没有挂载服务、
也没有出现在 `--dump-config` 输出中：

`@deepseek-ai/dsh-base`（整体）、`dsh-tool-bash`、`dsh-tool-pwsh`、
`dsh-tool-bash-persistent`、`dsh-tool-pwsh-persistent`、`dsh-terminal`、
`dsh-subprocess-local`、`dsh-sandbox-local`、`dsh-sandbox-policy`、
`dsh-bash-sandbox`、`dsh-pwsh-sandbox`、`dsh-fs-local`、`dsh-tool-fs`、
`dsh-tool-fs-search`、`dsh-fs-observation-policy`、`dsh-tool-web`、
`dsh-web-fetch-http`、`dsh-web-search-deepseek`、`dsh-web-app`、
`dsh-jobs-local`、`dsh-tool-jobs`、`dsh-goal`、`dsh-goal-round-driver`、
`dsh-tool-goal`、`dsh-subagent`、`dsh-tool-subagent`、`dsh-tool-subagent-control`、
`dsh-tool-workflow`、`dsh-workflow-ptc`、`dsh-ptc-runtime-node`、
`dsh-mcp-client`、`dsh-mcp-resources`、`dsh-plugin-manager`、`dsh-hmr`、
`dsh-config-editor`、`dsh-settings`、`dsh-credentials-local`、
`dsh-api-session-controller`、`dsh-workspace`、`dsh-schedule`、
`dsh-skill`、`dsh-skill-filesystem`、`dsh-tool-skill`、
`dsh-agent-instructions`、`dsh-session-query-sqlite`、`dsh-plan-mode`、
`dsh-permission-presets`、`dsh-shell-env`。

其中 **skill 相关包（`dsh-skill` / `dsh-skill-filesystem` / `dsh-tool-skill`）在依赖闭包里，
但 Myrix Cell 不启用它们**：Cell 的 Agent 没有 skill 工具，也没有 skill 文件系统。
仓库为开发者维护的项目 skills（`myrix-business`、`myrix-development` 等，见
[项目 skills](skills.md)）属于开发工具面，**不是 Cell 启用 skill**；新增或修改它们
不改变 Cell 的工具面，也不得借此改动 Cell 已启用的工具或 skill 装配。

> 生产镜像要真正瘦身，需要按 `cordis.patch.yml` 裁剪安装目录（当前范围外）。

## 4. 其它前提

| 项 | 要求 |
|---|---|
| Node | 根 [package.json](../../package.json) `engines.node` = `^22.19.0 \|\| >=24.0.0`；本地实测 `v24.13.0` |
| 网络 | 第 1 步需要 npm registry 可访问；smoke 使用本地替身、不需 API key。`pnpm dev` 的真实模型链路仍需要用户自己的 Responses 配置与密钥 |
| 平台 | 实测 macOS arm64。`compression: none` 避免了 zstd native 依赖；如需 `zstd`，`dsh-session-persistence-jsonl` 会引入 `koffi` 与 `@deepseek-ai/node-addon-system` |
