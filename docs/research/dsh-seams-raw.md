# DSH 扩展点与配置键 — 原始证据调研

> 只读调研，未修改 DSH 源码。目标版本 `0.2.0-rc.2`（`package.json:3`）。
> 路径基准：除特别标注外，均相对 DSH 源码根 `/Users/yueban/code/github/deepseek-harness`。
> 配置键形态：Cordis 插件行的 `id` + `name` + `config`；字段名即各包导出的 `Config`。生成目录：`docs/config-catalog.md`。

## 1. 身份 / 用户体系与鉴权

### 1.1 packages/identity
- 该组只有 `anonymous-user-id` 一个包，定位是"每 harness-home 一个匿名 UUID，用于关联遥测/反馈/DeepSeek 请求"：`packages/identity/README.md:12`、`packages/identity/README.md:25`。
- 它是**纯库，不是插件**：没有 Cordis service、没有 config、没有 invariant companion：`packages/identity/anonymous-user-id/README.md:69`。
- API `getOrCreateAnonymousUserId()`：`packages/identity/anonymous-user-id/src/index.ts:68`；持久化文件名 `.anonymous-user-id`：`packages/identity/anonymous-user-id/src/index.ts:29`。
- 消费点仅三处——遥测 `user.id`、feedback 确认、DeepSeek 请求头 `x-deepseek-harness-user-id`：`packages/identity/anonymous-user-id/README.md:34-36`；且明确"不同 `$DSH_HOME` 之间不可关联"：`packages/identity/anonymous-user-id/README.md:123`。
- 结论：它**不是身份来源 seam**，不能承载企业用户账号体系。

### 1.2 Web/HTTP 层鉴权
- 浏览器会话用"每进程随机 launch token + authority-bound 签名 Cookie"：进程启动打印/打开 `?token=...`，仅在 `GET /` 兑换为 Cookie 并重定向，其余路径缺/错 Cookie 一律 401：`packages/client/connection/README.md:39`。
- Cookie 签名密钥是 owner-scoped credential grant record `client-connection/browser-session`，持久化在 `$DSH_HOME/.credentials.yaml`：`packages/client/connection/src/browser-auth.ts:12`；Cookie 属性 `HttpOnly; SameSite=Strict; Path=/; Max-Age`：`packages/client/connection/src/browser-auth.ts:122`。
- 请求信任 fence（防 DNS rebinding / 跨站，非鉴权）：`packages/client/connection/src/api-request-trust.ts:91`；Host 必须 loopback 或命中 `trustedHosts`：`packages/client/connection/src/api-request-trust.ts:103`；Origin / `sec-fetch-site` 检查：`packages/client/connection/src/api-request-trust.ts:106-117`；"never establish identity"：`packages/client/connection/src/api-request-trust.ts:11-13`。
- 配置键（全名即字段名）：`client-connection.trustedHosts` / `cookieMaxAgeDays`(默认30) / `maxRequestBodyBytes`(默认300MiB) / `recovery.*`：`packages/client/connection/src/index.ts:92-115`、`docs/config-catalog.md:432-458`。
- web-app 注入表达式（LAN literals + `--trusted-host`）：`packages/bundle/web-app/cordis.patch.yml:216-223`；`dsh-web-app` 自身也有 `trustedHosts` 配置：`docs/config-catalog.md:4138-4139`。
- `dsh web --host 0.0.0.0` 明确"仍不支持"：`packages/client/connection/README.md:43`（与 webserver 自身支持 `0.0.0.0` 形成张力，见第 8 节）。

### 1.3 可替换的身份来源 seam
- `ctx.connection.operator` 是唯一 `PeerScope`，`admit()` 之后所有请求都"代表 operator"：`packages/client/connection/src/rpc-host.ts:64-65`、`packages/client/connection/src/rpc-host.ts:110-112`。
- `PeerScope` 注释明确"Who the Peer is and what it may do are not recorded here"：`packages/typert/protocol/src/types.ts:377-390`；每个 Remote 调用可通过 `this.ctx.invocation.peer` 读到它：`packages/typert/protocol/src/types.ts:406`。
- 结论：`PeerScope` 是天然的"请求主体"注入点，但当前恒为单 operator；接企业 SSO 需要**替换/包装 Connection provider**，或在 `admit()` 层派生 peer。
- `connection/request` 是已认证请求的 waterfall，可拒绝或包一层，但签名里没有 peer，**不能重绑身份**：`packages/client/connection/src/index.ts:55-67`、`packages/client/connection/src/index.ts:149-158`。
- `api-account-controller` 只是 DeepSeek 平台账号（登录/额度/赠金），不是企业用户体系：`packages/api/account-controller/src/index.ts:10-13`；后端 provider 可换（`dsh-deepseek-account` / `dsh-deepseek-account-platform`）：`docs/capability-seams.md:109-114`。
- secret 接缝 `ctx.credentials` 为 owner-scoped credential（key + grant record）：`docs/capability-seams.md:106-108`；`credentialRef()` / `resolve()` / `set()` / record CRUD 用法见 `packages/credentials/credentials/README.md:54-58`、`packages/credentials/credentials/README.md:74-78`。

## 2. 沙箱权限与审批

### 2.1 沙箱配置键
- `ctx.sandboxPolicy`（`@deepseek-ai/dsh-sandbox-policy`）配置键：`mode`（默认 `read-only`）、`workspaceRoot`（绝对路径，默认 `process.cwd()`）：`packages/sandbox/sandbox-policy/src/index.ts:71-79`、schema 默认：`packages/sandbox/sandbox-policy/src/index.ts:112-117`。
- `ctx.sandbox`（本地 provider `@deepseek-ai/dsh-sandbox-local`）配置键：`runnerCommand`、`runnerFailureSignatures`、`probeTimeoutMs`：`packages/sandbox/sandbox-local/src/index.ts:45-57`、`docs/config-catalog.md:2427-2458`。
- 具体 profile 行：`id: sandbox` → `@deepseek-ai/dsh-sandbox-local`；`id: sandbox-policy` → `@deepseek-ai/dsh-sandbox-policy`，其 config 为 `mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`、`workspaceRoot: !!js process.cwd()`：`packages/bundle/base/cordis.patch.yml:226-233`。
- bash/pwsh 执行器（`id: bash-sandbox` / `pwsh-sandbox`）只透传本地执行器旋钮，策略不在这里：`packages/bundle/base/cordis.patch.yml:235-243`、`docs/config-catalog.md:411-430`；`fs-sandbox` 同理：`docs/config-catalog.md:1242-1263`。
- 模式类型：`read-only | workspace-write | danger-full-access`：`docs/subsystems/sandbox.md:20`；`resolve()` 优先级 = 显式 approved mode > session 内最后一次 `sandbox/mode` > 部署默认；session cwd 是 workspace-write 边界，无 session 时用 `workspaceRoot`：`docs/subsystems/sandbox.md:196-216`。
- 执行期 API：`ctx.sandbox.confine(argv, policy, signal)` 返回 `ConfinedArgv`，无可用后端时 fail-closed：`docs/subsystems/sandbox.md:156`。

### 2.2 审批策略（approval policy）
- 服务 `ctx.approval`（`@deepseek-ai/dsh-user-approval`）；配置键 `approval.policy`，默认 `'ask'`，另一值 `'never'`：`packages/interaction/user-approval/src/index.ts:135-153`。
- profile 行：`id: approval` + `config.policy: !!js "(process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'"`：`packages/bundle/base/cordis.patch.yml:245-248`。
- 语义：`ask` 委托 answerer chain（无 answerer 则 fail-closed 为 `unavailable`），`never` 直接 `rejected`；有效值取 session log 最后一次 `approval/policy`，写入唯一路径 `setApprovalPolicy`：`docs/subsystems/approval.md:33`、`docs/subsystems/approval.md:46`。
- 审批 answerer 的注册点 = `approval/request` waterfall（agent-scoped）：`docs/subsystems/approval.md:152-164`；结果只允许 `allowed-once | rejected | cancelled | unavailable`，仅 `allowed-once` 放行：`docs/subsystems/approval.md:28`。
- UI 侧 answerer：`@deepseek-ai/dsh-client-ui-approval`：`packages/bundle/web-app/cordis.patch.yml:311-312`；ACP 自动化桥也提供机器决策：`docs/subsystems/approval.md:5`。

### 2.3 预设与权限判定调用链
- `ctx.permissionPresets` 配置：`presets: Record<name,{sandbox,approval,name?,description?}>` + `defaultPreset`：`docs/config-catalog.md:2167-2195`；默认表 `workspace-write`/`danger-full-access` 见 `packages/bundle/base/cordis.patch.yml:250-262`。
- `set(session,name)` 会分别写 `sandbox/mode` 与 `approval/policy`：`docs/subsystems/permission-presets.md:73`。
- 工具调用链（核心）：`tools/pre-execute` waterfall → 若决策为 `ask` → `ctx.tools` 内部 `serviceAsk()` → `ctx.approval.request()` → 再跑 monotonic guards：`packages/core/tools/src/index.ts:1505-1519`、`packages/core/tools/src/index.ts:1727-1768`。
- 沙箱/fs 在工具体内生效：fs 写入经 `fs/write-intent`、编辑经 `fs/edit-intent`：`packages/fs/fs/src/index.ts:59`、`packages/fs/tool-fs/src/write.ts:115`。

## 3. 工具执行管线与可拦截 hook

### 3.1 docs/tool-execution-pipeline.md 描述的切面
- 顺序：`tool/call`（落日志）→ UI pending → `tools/pre-execute` → monotonic guards → (ask → `ctx.approval`) → `tools/execute`（around，超时/重试/指标）→ 工具体 → `fs/write-intent|fs/edit-intent` → `projectContent` → `tools/post-execute` → `finalizeContent` → `tools/result`（同步通知）→ `tool/result`（session event）→ additionalContexts FIFO：`docs/tool-execution-pipeline.md:6`、`docs/tool-execution-pipeline.md:13-27`、`docs/tool-execution-pipeline.md:30-60`。
- 工具内自产事件：`todo/write`、`fs/observed`、`hook/invoked`、`hook/result`、`tool/ptc-dispatch`：`docs/tool-execution-pipeline.md:20`。

### 3.2 可用于"调用前鉴权/拦截"的 hook / 事件
- `tools/pre-execute` — waterfall，可返回 `allow|deny|ask|cancel`，scope-filtered by agent：`packages/core/tools/src/index.ts:142-153`；决策类型：`packages/core/tools/src/index.ts:607-611`。
- `ctx.tools.guard(guard)` — 在 pre-execute 之后运行的**单调 guard**，只能返回 reason 拒绝，不能把拒绝改回允许；普通 ctx 注册为全局，经 `agent.ctx` 注册只作用于该 agent：`packages/core/tools/src/index.ts:1126-1142`、`packages/core/tools/src/index.ts:1144-1153`。**这是最合适的模型工具 PEP。**
- `ctx.tools.restrict(filter)` — 对"全局工具集"施加 allow/deny 掩码，掩码取交集：`packages/core/tools/src/index.ts:1097`、`packages/core/tools/README.md:81`。
- `tools/execute` — around-dispatch 包装（超时、重试、指标）：`packages/core/tools/src/index.ts:154-164`。
- `tools/post-execute` — 接受/替换/阻断/附加上下文：`packages/core/tools/src/index.ts:165-176`。
- `tools/result` — emit，只读观察冻结后的最终结果，监听器失败被吞：`packages/core/tools/src/index.ts:191-198`。
- `tools/ptc-dispatch-log` — PTC 子调用落日志前的内容替换：`packages/core/tools/src/index.ts:190`。
- 更高层控制点：`agent/pre-step`（拒绝/改写进入 step 的消息）`packages/core/agent/src/runtime-types.ts:309-320`；`agent/request`（替换 frozen 调用配置）`packages/core/agent/src/runtime-types.ts:321-337`。

### 3.3 packages/hooks 里有什么
- 不是通用原生 hook 总线，而是"复用 Claude Code / Codex 的 shell hooks"桥：`packages/hooks/README.md:12`、`packages/hooks/README.md:27-29`。
- 三个包：`hook-protocol`（库，共享引擎）、`hooks-claude-code`、`hooks-codex`：`packages/hooks/README.md:27-29`。
- 配置键：`hooks-claude-code.configPath` / `pluginRoot?` / `projectDir?` / `defaultTimeoutMs?`：`docs/config-catalog.md:1333-1341`；`hooks-codex.configPath` / `model?`：`docs/config-catalog.md:1372-1379`。
- 触发点：`SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop/...`：`packages/hooks/hooks-claude-code/src/config.ts:12-20`；产生 log-only `hook/invoked`/`hook/result`（按 `handlerId` 配对）：`packages/hooks/hook-protocol/src/events.ts:71-76`、`packages/hooks/hook-protocol/src/types.ts:19`。
- 限制：`updatedInput` 解析但**不生效**；`{"continue":false}` 无 run 级效果；仅 command hook 会执行：`packages/hooks/hook-protocol/README.md:127-129`。

## 4. 插件管理 / profile / bundle

### 4.1 能力（`dsh plugin ...`）
- `ctx.pluginManager` 管理"当前 profile"的插件行与 bundle，可安装/移除外部 bundle；需要 `danger-full-access` 或审批：`packages/boot/plugin-manager/README.md:14`、`packages/boot/plugin-manager/README.md:31`。
- CLI：`dsh plugin --profile <name> <pnpm args...>` 把剩余参数**原样转发给 pnpm**（`add`/`remove`/`why`...），profile 首次使用会自动初始化：`apps/cli/src/args.ts:187-198`、`packages/boot/plugin-manager/README.md:77-81`。
- DSH 自有子命令：`version-exemptions`、`allow-version <pkg@ver> --dsh-version <ver> --accept-risk`、`revoke-version`：`apps/cli/src/plugin.ts:16-53`、`packages/boot/plugin-manager/README.md:65-69`。
- Agent 工具 `plugin_manager`，`action` 枚举含 `list_plugins/list_bundles/set_plugin/set_bundle/install_bundle/remove_bundle/...`：`packages/boot/plugin-manager/src/tools.ts:20-23`。
- manager 自身配置键：`pnpmCommand`、`outputBytes`、`lockWaitMs`、`inspectTimeoutMs`、`githubConnectionTimeoutMs`、`idleTimeoutMs`、`registry`、`fallbackRegistries`：`docs/config-catalog.md:2253-2277`。

### 4.2 profile / bundle / cordis.patch.yml 确切结构
- Profile 目录：`$DSH_HOME/profiles/<name>` = `package.json`（依赖 + `dsh.profile` manifest）+ `cordis.patch.yml`（用户层）+ 由 `initProfile` 写的 `pnpm-workspace.yaml`（`nodeLinker: hoisted`, `autoInstallPeers: false`）：`packages/boot/app-boot/src/profile.ts:37-40`、`packages/boot/app-boot/src/profile.ts:68-71`、`packages/boot/app-boot/src/profile.ts:220-263`。
- Bundle 包 = `package.json` 声明 `dsh.bundle.patch`（单文件或文件数组，按序应用）+ 对应 `cordis.patch.yml`：`packages/util/package-manifest/src/types.ts:69-72`、`packages/boot/app-boot/src/profile.ts:58-64`。
- 最小示例（字段名与代码一致）：
  ```json
  // $DSH_HOME/profiles/demo/package.json
  { "name":"dsh-profile-demo","private":true,
    "dependencies":{"dsh-hello-plugin":"link:/path/to/hello-plugin"},
    "dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","dsh-hello-plugin"]}} }
  ```
  ```json
  // dsh-hello-plugin/package.json
  { "name":"dsh-hello-plugin","version":"0.1.0","type":"module","main":"index.js",
    "dsh":{"bundle":{"patch":"./cordis.patch.yml"}} }
  ```
  ```yaml
  # dsh-hello-plugin/cordis.patch.yml
  - insert:
      - id: hello
        name: dsh-hello-plugin
  ```
  依据：`docs/user/develop/basic/publish.md:33-64`、`docs/user/develop/basic/publish.md:85-101`。
- patch 是 YAML 顶层数组；条目支持按 `id` 覆盖（整块替换 `config`，不是深合并）、`disabled`、`insert:`、`!!js` 表达式；group 可用 `name: cordis:group` + `isolate:`：`docs/user/develop/basic/publish.md:56-64`、`docs/user/develop/basic/publish.md:129-132`、`apps/cli/config/examples/github-review/cordis.yml:17-27`。
- 层序（后层按行胜出）：profile 的 `dsh.profile.bundles` 顺序 → profile 自己的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → 每个 `--patch`：`docs/user/develop/basic/publish.md:118-125`、`docs/architecture.md:27`。
- 配置存储服务 `ctx.configure`/HMR 使 YAML 改动可热加载（base 开启 config-only HMR）：`docs/architecture.md:29`。

### 4.3 挂载 out-of-tree 插件
- 本地路径：`dsh plugin --profile demo add ./hello-plugin`（link）；npm 包名：`add <pkg>`；git：`add github:you/hello-plugin`；tarball：`add ./x.tgz`：`docs/user/develop/basic/publish.md:79-84`、`docs/user/develop/basic/publish.md:161-184`。
- git 安装只取源码，需作者提供 `prepare`，且用户要在 profile 的 `pnpm-workspace.yaml` 写 `allowBuilds` 放行安装脚本：`docs/user/develop/basic/publish.md:167-179`。
- 注意：安装的 Host 代码在进程内执行，**不受 workspace sandbox 限制**：`packages/boot/plugin-manager/README.md:31`。
- 手动（无插件管理）只需把 bundle 加进 `dsh.profile.bundles`；`@deepseek-ai/dsh-base` 等 in-box bundle 始终从安装解析，不经 pnpm：`packages/boot/app-boot/src/profile.ts:630-641`、`docs/user/develop/basic/publish.md:134`。

### 4.4 bundle 的 `package.json.dsh` schema
- `DshPackageManifest{name,version,description?,icon?,private?,dependencies?,peerDependencies?,engines?,dsh?}`：`packages/util/package-manifest/src/types.ts:8-27`。
- `DshManifest{manifestVersion?:1, bundle?:DshBundleManifest, profile?:DshProfileManifest, client?:DshClientManifest}`：`packages/util/package-manifest/src/types.ts:30-39`。
- `DshBundleManifest{patch: string|string[]}`：`packages/util/package-manifest/src/types.ts:69-72`；`DshProfileManifest{bundles?: string[]}`：`packages/util/package-manifest/src/types.ts:75-78`；`DshClientManifest{platform, inject?, immediately?, external?}`：`packages/util/package-manifest/src/types.ts:81-94`。
- 版本兼容：`engines.dsh`（SemVer range）：`packages/util/package-manifest/src/types.ts:57-66`；profile 可用 `compatibility.json` 做精确 `pkg@ver` ↔ DSH 运行时版本豁免：`packages/boot/plugin-manager/README.md:63-69`。

## 5. MCP 接入

- 每个 `@deepseek-ai/dsh-mcp-client` 插件实例接一个外部 MCP server；工具以 `mcp__<serverName>__<rawName>` 注册进 `ctx.tools`：`packages/mcp/mcp-client/README.md:12`、`packages/mcp/mcp-client/README.md:75`。
- 配置键（全名）：`transport`(`stdio`|`streamable-http`)、`serverName`、stdio `command/args/env/cwd`、http `url/headers`、`toolCallTimeoutMs`(默认60000)、`maxInstructionBytes`(32768)、`failOnStartupError`、`reconnect.{enabled,initialDelayMs,maxDelayMs,maxAttempts}`：`packages/mcp/mcp-client/README.md:55-67`、`packages/mcp/mcp-client/src/index.ts:54-140`。
- 最小配置示例（Streamable HTTP + Bearer）：`packages/mcp/mcp-client/README.md:34-53`。
- **作为企业知识库检索通道可行**：用 `transport: streamable-http` + `headers.Authorization` 指向企业 MCP 服务；资源侧另有三个共享工具 `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource`（需显式 server 参数，按需读取）：`packages/mcp/mcp-resources/src/tools.ts:33-52`、`packages/mcp/mcp-resources/README.md:12`、`packages/mcp/mcp-resources/README.md:92`。
- MCP 工具同样走 `ctx.tools` 管线，所以 `tools/pre-execute` 与 guard 对企业 MCP 调用一样生效：`packages/mcp/mcp-client/README.md:149`。
- 限制：stdio 子进程 env 会用 subprocess 的 `scrubbedParentEnv()`（丢弃匹配 `KEY|PASSWORD|SECRET|TOKEN` 与 `DSH_*` 的环境）再合并配置 env：`packages/mcp/mcp-client/README.md:138`；连接/发现超时继承 MCP SDK 的 60s，无独立配置：`packages/mcp/mcp-client/README.md:210`。

## 6. Web / 远端 API 与管理后台选型

### 6.1 HTTP 路由与鉴权
- `/api` 由 `ctx.webServer` 上注册的 prefix 路由承载；先 `connection.admit()`（信任 + 浏览器会话），再过 `connection/request` waterfall，最后交给共享 Fetch handler：`packages/client/connection/src/index.ts:145-158`。
- Typert Gateway 认领两段式 endpoint：客户端 `connection.rpc.call('/api', '<ns>/<method>', {args})` → HTTP `POST /api/<namespace>/<method>`：`docs/api-gateway.md:123-129`；流式走 `/api/remote.mux` WebSocket：`docs/api-gateway.md:58`、`packages/api/gateway/README.md:35`。
- 非 JSON 响应用"精确 Fetch 路由"注册：`ctx.connection.fetch.register({path,methods,requestBody,fetch})`，注释明确它运行在物理 carrier 已施加信任/鉴权**之后**：`packages/client/connection/src/rpc.ts:144-163`、`packages/client/connection/src/rpc.ts:151`。
- Host 侧可替换 RPC 通道：`ctx.connection.rpc.handle(channel,handler)` / `intercept('/api',matches,handler)`：`packages/client/connection/src/rpc.ts:165-190`。
- 业务服务通过 `@Remote` / `@RemoteScope` + `TypertRemoteService` 暴露；Client 侧需在 `packages/api/remotes` 显式挂载：`docs/api-gateway.md:9-15`、`docs/api-gateway.md:78-80`。

### 6.2 SDK JSON-RPC 契约
- 传输：stdio 上 newline-delimited JSON-RPC 2.0；方法仅 3 个 client→server：`initialize`、`session/prompt`、`shutdown`；4 个 server→client 通知：`session.event`、`session.status`、`subagent.started`、`subagent.finished`：`packages/sdk/protocol/README.md:32-47`。
- `session/prompt` 只返回`{messageId}`（入队回执），没有 per-prompt result；没有 cancel / session-close：`packages/sdk/server/README.md:48`、`packages/sdk/server/README.md:125-128`。
- 服务端配置只有 `maxTokensAsSuccess`（默认 false）：`packages/sdk/server/README.md:36-40`；`initialize` 是就绪边界，未握手前 `session/prompt` 被拒：`packages/sdk/server/README.md:48`。
- **没有任何鉴权层**（进程 stdio 信任模型）：`packages/sdk/server/README.md:12`。

### 6.3 管理后台选型判断
- 判断依据一：现有浏览器 API 是**单 operator** 模型（Cookie 只证明"本进程的 operator"，`PeerScope` 不含身份）：`packages/client/connection/README.md:45`、`packages/typert/protocol/src/types.ts:377-390`。因此直接复用 `/api` Remote 做多用户管理后台会缺少身份维度。
- 判断依据二：想做独立认证面的企业后台，仓库里有成熟模式——用 `cordis:group` + `isolate.webServer:true` 起**第二个 WebServer**，只注册自己的路由（示例：GitHub webhook 入口 3081）：`apps/cli/config/examples/github-review/cordis.yml:17-34`、`docs/user/guide/github-review.md:42`。
- 判断依据三：SDK 面向"进程外自动化/CI"，无 HTTP、无鉴权、无取消，不适合浏览器多用户后台：`packages/sdk/server/README.md:12`、`packages/sdk/protocol/README.md:113-115`。
- 判断依据四：client 插件只是把 UI 挂进现有 Web shell，其数据仍走单 operator 的 Connection：`docs/api-gateway.md:78-80`。
- 结论：**企业多租户管理后台应新增独立认证的 HTTP/BFF 面**（第二个 webServer + 自有 auth，或自建 Connection provider 让 `PeerScope` 携带企业身份），再在其后调用 Host 服务；`@Remote` 与 SDK 适合单 operator / 进程外自动化。若仅需在同一进程内被 Web UI 消费且不涉及多用户，用 `@Remote` + client 插件即可。

## 7. 已知"企业化缺口"与最合适的 PEP 注入点

### 7.1 缺口证据
- 全仓库 `packages/` 无 `rbac`、无 `multi-tenant`/`tenantId` 命中（研究时 grep 0 命中）；`tenant` 仅出现在存储测试的 service key 命名与 LLM 测试：`packages/storage/storage/tests/registry.spec.ts:30`（不是多租户实现）。
- 身份仅有 home 级匿名 UUID：`packages/identity/README.md:12`；账号仅 DeepSeek 平台账号：`packages/api/account-controller/src/index.ts:10-13`。
- RAG：无向量库/检索 seam；可用的"检索"只有 MCP resources + web search provider（`ctx.web` 只是 web 访问 provider registry）：`docs/capability-seams.md:248-249`、`packages/mcp/mcp-resources/src/tools.ts:33-52`。
- Session/Workspace 无租户边界；持久化可换 provider，但不带 tenant 概念：`docs/architecture.md:163`。

### 7.2 PEP（策略执行点）注入点排序
1. `ctx.tools.guard(guard)` — 覆盖所有模型工具调用（含 MCP、PTC 子调用）；单调、只能 deny、不能被子序 listener 反转为 allow，可按 agent 作用域：`packages/core/tools/src/index.ts:1126-1142`、`packages/core/tools/src/index.ts:1144-1153`。**首选。**
2. `tools/pre-execute` waterfall — 需要 deny/ask/cancel 或做策略组合时：`packages/core/tools/src/index.ts:142-153`。
3. `ctx.approval` + `approval/request` waterfall — 把人工审批替换为企业审批/工单流：`docs/subsystems/approval.md:152-164`、`packages/interaction/user-approval/src/index.ts:150-153`。
4. `ctx.typert.lookups.configure('agent'|'session', ...)` — API 边界上的对象解析策略，可在进入业务代码前做租户/所有权校验（session-controller 是默认实现）：`docs/api-gateway.md:11`、`docs/api-gateway.md:129`。
5. `RemoteInvocation.peer` — 每个 Host Remote 方法可读调用主体；当自定义 Connection 让 peer 携带企业用户后，业务服务可据此做 PEP：`packages/typert/protocol/src/types.ts:406`。
6. `connection/request` waterfall — 只适合二级策略/审计（不能重绑身份）：`packages/client/connection/src/index.ts:67`。
7. `ctx.credentials` owner-scoped grant — 存放企业 secret / 授权记录：`docs/capability-seams.md:106-108`。
8. `ctx.webhookRuntime` + 隔离 WebServer — 企业系统入站通道（认证由 provider adapter 负责）：`docs/subsystems/webhook.md:5`、`docs/subsystems/webhook.md:35-37`。

## 8. 仍不确定 / 需要验证的问题

- **能否在不 fork 的情况下替换 `PeerScope` 身份？** 目前 `operator` 由 `HostConnectionService` 内部构造（`packages/client/connection/src/rpc-host.ts:81`），未见公开的 provider 替换接口；需要验证能否通过自定义 Connection carrier / loader 行覆盖。
- **`connection/request` listener 能否影响下游 Peer？** 事件签名无 peer 参数（`packages/client/connection/src/index.ts:67`），推测不能；需以实测/维护者确认。
- **浏览器 Cookie 与外部 SSO 的整合点**：没有发现可插拔的 BrowserAuth provider；若要 OIDC/JWT，可能要替换 `packages/client/connection` 或新增独立 WebServer 面。
- **`dsh web --host 0.0.0.0` 的实际拒绝位置**：README 称不支持（`packages/client/connection/README.md:43`），但 webserver Config 接受 `0.0.0.0`（`docs/config-catalog.md:1503`）；需确认是 CLI 层拒绝还是仅文档立场。
- **MCP 的 per-user 凭据注入**：当前 header/token 来自静态 config 或 process.env（`packages/mcp/mcp-client/README.md:45-53`），未发现按用户动态注入的机制。
- **是否有未公开的企业能力**：`packages/experimental` 内无 auth/RBAC/RAG 包（包列表：`packages/experimental` 目录），但未穷尽 `vendor/` 与私有分支。
- **`ctx.settings` 与 `api-settings-controller` 是否可作为企业配置下发面**：本轮未深入（仅知是 plugin 配置表单 + Remote 控制器，`docs/capability-seams.md:101-104`、`docs/capability-seams.md:76-78`），需要进一步验证。
- **多租户 session 隔离**：`ctx.sessions` 是 in-memory store（`docs/capability-seams.md:60-61`），持久化有 `SessionPersistence` seam，但没有租户命名空间；需要自行在 provider 或 Workspace 层实现。
- **`permissionPresets.set` 由客户端触发**（`docs/subsystems/permission-presets.md:73`），当前无 per-user 服务端鉴权；企业部署需在 PEP 处补齐。
