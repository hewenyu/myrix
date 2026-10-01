# Myrix Phase0 P1/P2 运行时 PoC 依赖清单

本文件说明 PoC 与 v0.1 本地开发栈所共用的**独立锁定 DSH 安装**。

`tests/poc/.dsh-install/` 不在 `pnpm-workspace.yaml` 的包列表内，必须单独安装。
除 `tests/poc/**` smoke 外，当前 `pnpm dev` 也通过同一个 CLI 解析器使用此安装；
业务包不会把整个 DSH 发布包混入自身的工作区依赖。真实开发装配步骤见
[本地开发指南](<../../docs/implementation/local-development.md>)。

## 1. 运行时本体

| 包 | 版本 | 说明 |
|---|---|---|
| `@deepseek-ai/dsh` | `0.2.0-rc.2` | CLI + 启动器；与只读 vendor 的锁定源码版本号相同，但未证明 npm 产物逐字节对应提交 `639ed01` |

一条命令（在 `tests/poc/.dsh-install/` 下）：

```bash
pnpm install
```

`node-linker=hoisted` + `auto-install-peers=true` 是**必须的**，见
`.dsh-install/.npmrc` 的注释：DSH 的 profile 解析器会遍历安装目录的依赖图，
嵌套的 pnpm 布局会让 `@deepseek-ai/dsh-*` 的查找依赖虚拟 store 的哈希。

## 2. 白名单 bundle 实际用到的 DSH 包

这些**不需要单独安装**：它们是 `@deepseek-ai/dsh` 的依赖闭包，由第 1 步一并装上。
列出它们是为了让“白名单”可审计 —— `bundles/myrix-base/cordis.patch.yml`
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

### 传递 peer / 服务定义包（不在 patch 里出现，但必须可解析）

`@deepseek-ai/dsh-scope`、`@deepseek-ai/dsh-invariants`、
`@deepseek-ai/dsh-session-persistence`、`@deepseek-ai/dsh-typert-protocol`、
`@deepseek-ai/dsh-typert-registry`、`@deepseek-ai/dsh-brand`、
`@deepseek-ai/dsh-util-values`、`@deepseek-ai/dsh-home-paths`、
`@deepseek-ai/dsh-attachment`、`@deepseek-ai/dsh-compaction`、
`@deepseek-ai/dsh-commands`（仅类型）、`@deepseek-ai/dsh-agent-preset-registry`、
`@deepseek-ai/cordis`、`@deepseek-ai/cordis-plugin-include`、
`@deepseek-ai/cordis-plugin-loader`、`@deepseek-ai/cordis-plugin-group`。

## 3. 明确不安装（白名单排除）

以下包**不在** bundle 里，PoC 会断言它们既没有挂载服务、也没有出现在
`--dump-config` 输出中：

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

> 注：这些包**仍然会被 `pnpm install` 下载**，因为它们是 `@deepseek-ai/dsh`
> 的依赖闭包。白名单的作用是**不把它们挂进 Cordis 树**，不是不下载它们。
> 生产镜像要真正瘦身，需要按 `cordis.patch.yml` 裁剪安装目录（Phase 0 之后再做）。

## 4. 其它前提

| 项 | 要求 |
|---|---|
| Node | `^22.19.0 \|\| >=24.0.0`（实测 `v24.13.0`；DSH 自带要求 24.18.1+，但 PoC 未用到需要更高版本的特性） |
| 网络 | 第 1 步需要 npm registry 可访问；之后 PoC 全程离线（模型调用走本地 mock 适配器，不需要任何 API key） |
| 平台 | 实测 macOS arm64。`compression: none` 避免了 zstd native 依赖；如需 `zstd`，`dsh-session-persistence-jsonl` 会引入 `koffi` 与 `@deepseek-ai/node-addon-system` |
