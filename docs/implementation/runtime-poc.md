# Runtime PoC：真实 DSH 白名单组合与 API 验证（Phase 0 P1 / P2）

> 状态：**实测通过**（2026-09-30）。范围：`platform-plan-v2.md` §8 的 **P1**（`myrix-base` 最小插件树）与
> **P2**（会话绑定）中可由单进程验证的部分。
> 标注：**[实测]** = 本仓库 `tests/poc/run-poc.mjs` 真实跑出来的结果；**[源码]** = 只读对照
> `vendor/deepseek-harness`（锁定 `639ed01`）；**[推论]** = 由前两者推出、尚未实测。
> 本文档**只报告事实与风险**，不改变 `tech-design-v1.md` 的任何设计决策。

---

## 0. 复现方式与结论摘要

```bash
# 一次性安装锁定运行时（需要网络；详见 tests/poc/DEPENDENCIES.md）
cd tests/poc/.dsh-install && pnpm install

# 组合检查：断言 --dump-config 里没有任何被禁用插件
node tests/poc/run-poc.mjs --dump-config     # 退出码 0 = 无泄漏

# 完整 smoke：起真 DSH 两次（第二次验证崩溃重启），16 条探针
node tests/poc/run-poc.mjs                   # 退出码 0 = 16/16 通过
```

> 本轮**没有**改根 `package.json` 的 `scripts`（根配置与 `apps/*` 属其他 scope）。
> 若要加便捷脚本，建议由 Lead 统一加：
> `"poc:runtime": "node tests/poc/run-poc.mjs"` 与
> `"poc:runtime:config": "node tests/poc/run-poc.mjs --dump-config"`。

**[实测] 结果：`--dump-config` 禁用插件泄漏 0 条；16/16 探针通过；两次启动都成功。**
原始输出保存在 `tests/poc/.work/poc-report.json`（含每条探针的完整 detail）。

**最重要的一条结论**：`myrix-base` 白名单**可以独立启动**，不需要 `dsh-base`，对话、压缩、
preset 挂载、工具注册表、JSONL 持久化全部可用 —— 这与 `tech-design-v1.md` R2 的担忧相反，
**R2 已消除**（详见 §6）。

---

## 1. 版本与安装事实（本节的每个数字都是实测）

| 项 | 值 | 来源 |
|---|---|---|
| 运行时 CLI | `@deepseek-ai/dsh@0.2.0-rc.2` | **实测** `dsh --version` |
| 运行时的完整性哈希 | `sha512-EAJ3gPNcVt/uv8X19PMm9NkVhWgT7xXNMk0UKCVm+IQ5rpSQOcsMUa0HWlnYYVybKMsccjcRB21vVVsaXQ6IdA==` | **实测** `tests/poc/.dsh-install/pnpm-lock.yaml` |
| 锁定传递依赖数 | 3472 条 `@deepseek-ai/*` 记录 | **实测** 同上 |
| 对照上游提交 | `639ed01`（= `release-dsh-0.2.0-rc.2` 之后一次合并） | `git -C vendor/deepseek-harness log -1` |
| npm 上是否有同版本 | 有，`0.2.0-rc.2` 已发布 | **实测** `npm view` |
| 安装后包数 | 289 个 `@deepseek-ai/*` | **实测** |
| Node | `v24.13.0`（darwin arm64） | **实测** |

`tests/poc/.dsh-install/pnpm-lock.yaml` **入库**：它把锁定的运行时及其整棵传递依赖钉死，
正是“锁定 DSH 精确版本”的落点。`node_modules` 不入库。

### 1.1 运行时版本与锁定 vendor 的关系（回答“运行时版本可能与锁定 vendor 不同”）

结论：**本机运行时的 DSH 内核就是 `0.2.0-rc.2`，与锁定的 vendor 同一版本**，但需要区分三处安装：

| 位置 | 版本 | 性质 |
|---|---|---|
| `vendor/deepseek-harness`（submodule） | `0.2.0-rc.2` @ `639ed01` | **源码基线**；只读对照，不参与运行 |
| `~/.dsh/profiles/node_modules/@deepseek-ai/dsh` | **`0.1.0-rc.6`** | ⚠️ **陈旧残留**，指向 npx 缓存，与 submodule 不一致 |
| `tests/poc/.dsh-install/` | `0.2.0-rc.2` | PoC 实际使用的隔离安装 |

**风险**：本机存在一个 `0.1.0-rc.6` 的陈旧 profile 安装。任何用默认 `~/.dsh` 起的实验都可能
悄悄跑在旧版本上。PoC 因此**显式设置 `DSH_HOME`** 到自己的临时目录，绝不复用 `~/.dsh`。

> **[实测] 代码级差异的确存在**：`0.2.0-rc.2` 才有 `packages/preset/agent-preset-registry`
> （`ctx.agentPresets`、`await mount(ctx, id)`）。`0.1.0-rc.6` 里对应的是
> `dsh-agent-presets`，服务名与 `mount` 语义不同。因此 **P1/P2 的一切结论都以 `0.2.0-rc.2` 为准**。

### 1.2 安装方式的硬性要求（踩过的坑，写下来避免重复）

`tests/poc/.dsh-install/.npmrc` 必须同时满足：

| 设置 | 为什么 |
|---|---|
| `node-linker=hoisted` | DSH 的 profile 解析器会 **遍历安装目录的依赖图**（BFS over dependencies + peerDependencies）。嵌套 pnpm 布局下 `@deepseek-ai/dsh-*` 的解析会依赖虚拟 store 的哈希目录，profile 解析直接失败 |
| `auto-install-peers=true` | `dsh-app-boot` 直接 `import '@deepseek-ai/cordis-plugin-group'`，而它只是 peer。不装 peer 时启动即 `ERR_MODULE_NOT_FOUND` |

另外两点：

1. **profile 内的插件文件必须物理位于 profile 目录之内。** 用绝对路径把插件指向仓库
   （`name: /repo/tests/poc/plugins/poc-app.mjs`）会以 `failed to import` 失败：该文件的
   `import '@deepseek-ai/dsh-llm'` 会从仓库目录向上解析，而那里没有 DSH 安装。
   PoC 的做法是把插件 **复制进** `$DSH_HOME/profiles/<name>/plugins/`，并在
   `$DSH_HOME/profiles/node_modules` 放一个指向安装目录的符号链接 —— 这正是真实部署的布局。
2. `compression: none`（见 §2）避免 zstd 原生依赖；用 `zstd` 会引入 `koffi` +
   `@deepseek-ai/node-addon-system`。

---

## 2. `bundles/myrix-base` 的真实组成

`bundles/myrix-base/cordis.patch.yml` 是**一层 insert**，不叠加 `dsh-base`。实测挂载后
Loader 里有 **24 行**（含两个 PoC 测试行与启动器自身的 `cordis:include`）：

```text
cordis:include
@deepseek-ai/cordis-plugin-timer
@deepseek-ai/dsh-llm
@deepseek-ai/dsh-session
@deepseek-ai/dsh-session-persistence-jsonl
@deepseek-ai/dsh-session-projection
@deepseek-ai/dsh-system-prompt
@deepseek-ai/dsh-tools
@deepseek-ai/dsh-agent
@deepseek-ai/dsh-agent-loop
@deepseek-ai/dsh-llm-retry
@deepseek-ai/dsh-token-meter
@deepseek-ai/dsh-compaction-basic
@deepseek-ai/dsh-user-approval
@deepseek-ai/dsh-attachment-local
@deepseek-ai/dsh-agent-preset-registry
@deepseek-ai/dsh-agent-preset
@deepseek-ai/dsh-invariants
@deepseek-ai/dsh-session/invariant
@deepseek-ai/dsh-agent/invariant
@deepseek-ai/dsh-scope/invariant
@deepseek-ai/dsh-agent-loop/invariant
```

### 2.1 与 `platform-plan-v2.md` §5.1 清单的差异（必须让 Lead 拍板）

§5.1 的白名单里有 4 项**没有**进这一版，原因是**[实测] 它们不是“插件行”，单独挂载会失败或无用**：

| §5.1 清单项 | 实际处理 | 理由 |
|---|---|---|
| `dsh-session-persistence-jsonl` | ✅ 已挂 | 同 |
| `dsh-attachment-local` | ✅ 已挂 | 同（并**修正**了 §5.1 的假设：它提供 `ctx.attachments` 的本地实现，`dsh-attachment` 只是抽象定义包，不是行） |
| `dsh-token-meter` | ✅ 已挂 | 同；`compaction-basic` 硬依赖 `ctx.tokenMeter` |
| `dsh-compaction-basic` | ✅ 已挂 | 同 |
| `dsh-agent-preset-registry` | ✅ 已挂 | 同；**包名**是 `@deepseek-ai/dsh-agent-preset-registry` |
| `dsh-user-approval` | ✅ 已挂（`policy: never`） | 同 |
| `invariants` 系列 | ✅ 已挂 5 行 | `dsh-invariants` + 4 个 `/invariant` 伴侣 |
| `dsh-session-projection` | ✅ **补上** | §5.1 漏了。它是 `agent-preset-registry` 与 `token-meter` 的**硬注入**（`static inject = ['sessionProjections']`），不挂则两者都不激活 |
| `dsh-agent` | ✅ 已挂 | 注册表服务 `ctx.agents` |
| `dsh-agent-loop` | ✅ 已挂 | **必须是单独一行**：`ctx.agents` 只是注册表，真正的 `AgentFactory`（`create`/`resume`）由 `dsh-agent-loop` 提供。只挂 `dsh-agent` 则 `create()` 抛 `NO_FACTORY` |
| `dsh-llm-retry` | ✅ 已挂 | 同 |
| `dsh-system-prompt` | ✅ 已挂 | 同 |
| `dsh-tools` | ✅ 已挂（`mode: native`） | 显式写 `native`：本 bundle 没有 `ctx.ptcRuntime`，`ptc`/`both` 都会在注册时抛错 |
| `dsh-session` | ✅ 已挂 | 同 |
| `dsh-llm` | ✅ 已挂 | 同 |
| `cordis-plugin-timer` | ✅ 已挂 | 同 |

**[实测] 明确未挂载且可以确认缺席的服务**（探针逐项断言 `ctx.get(x) === undefined`）：

```text
subprocess  terminal  terminals  bash  sandbox  sandboxPolicy  fs  web  jobs  goals
subagents  workflowEngine  skills  pluginManager  configEditor  settings  hmr
sessionQuery  storage  storageDomain  spillStore  commands  userQuestions  agentTeams
```

**[实测] 工具面为空**：`ctx.tools.schemas()` 返回 `[]`。这是白名单最有力的证据 ——
没有 shell、没有 fs、没有 web，模型在 `myrix-base` 下**一个工具都调不到**。

### 2.1.1 “不叠加 `dsh-base`”的准确含义（**别误读**）

`@deepseek-ai/dsh-base` 是 `@deepseek-ai/dsh` CLI 的**直接依赖**，所以
`pnpm install` 一定会把它下载到 `node_modules` 里。**[实测] 它确实可被解析到**：

```text
dsh-base resolvable (installed): true      # createRequire(...).resolve('@deepseek-ai/dsh-base/package.json') 成功
```

白名单的作用是**不把它作为 profile bundle 挂进 Cordis 树** —— profile 的
`dsh.profile.bundles` 只有 `@myrix/dsh-bundle-myrix-base` 一项，`dsh-base` 的
patch 从未被加载，因此它的 100+ 行插件一个都不存在。

**推论（需要 Lead 知晓）**：镜像体积不会因为白名单自动变小。
“不下载”需要另外的裁剪步骤（按 `cordis.patch.yml` 反向剪枝安装目录），
Phase 0 之后再做。白名单保证的是**执行面**，不是**交付面**。

### 2.2 与 `dsh-base` 的其余差异（[源码] 对照）

- 不装 `commands` / `settings` / `config-editor` / `plugin-manager` / `hmr`：`dsh-base` 用
  `!!js "!ctx.get('profileContext')"` 把它们在非 profile 场景关掉；白名单直接不写这些行，更干净。
- 不装 `session-title*`：标题生成会额外调一次模型，平台第一版不需要（可由 `myrix-novel` 自己决定）。
- 不装 `storage*` / `spill*` / `otel` / `session-query-sqlite`：都是平台不需要的面。
- 不装 `sandbox*` / `subprocess` / shell / terminal：见 D6。
- 不装 `agent-instructions`：它会读 `$DSH_HOME/AGENTS.md`（§5.1 已明确排除）。

**一个需要 Lead 知晓的取舍**：不挂 `dsh-sandbox-policy` 意味着 `ctx.get('sandboxPolicy')`
为 `undefined`。`dsh-tools` 只在 **PTC 模式**下要求它（[源码] `dsh-tools: confined PTC runtime
requires sandboxPolicy`），`native` 模式不需要，因此**当前组合是自洽的**。但将来任何插件
若读取 `sandboxPolicy` 做判定，必须自己处理 `undefined`（fail-closed）。

---

## 3. API 签名与公共包名（供 runtime 实现直接照抄）

以下签名全部经 **`cordis_inspect_query`（实时进程）+ vendor 源码**二次核对。

### 3.1 包名与导入路径（**易错点**）

| 能力 | 正确的包名 / 子路径 | 服务键 |
|---|---|---|
| Agent 注册表 | `@deepseek-ai/dsh-agent` | `ctx.agents` |
| Agent 工厂（create/resume 实现） | `@deepseek-ai/dsh-agent-loop` | `ctx.agentLoop` |
| 会话存储 | `@deepseek-ai/dsh-session` | `ctx.sessions` |
| 会话持久化（JSONL 后端） | `@deepseek-ai/dsh-session-persistence-jsonl` | `ctx.sessionPersistence` |
| 投影注册表 | `@deepseek-ai/dsh-session-projection` | `ctx.sessionProjections` |
| 工具 | `@deepseek-ai/dsh-tools` | `ctx.tools` |
| 模型 | `@deepseek-ai/dsh-llm` | `ctx.llm` |
| Preset | `@deepseek-ai/dsh-agent-preset-registry` | `ctx.agentPresets` |
| Preset 声明行 | `@deepseek-ai/dsh-agent-preset` | 无服务（注册即可） |
| 审批 | `@deepseek-ai/dsh-user-approval` | `ctx.approval` |
| 附件 | `@deepseek-ai/dsh-attachment-local` | `ctx.attachments`（定义在 `dsh-attachment`） |
| 压缩 | `@deepseek-ai/dsh-compaction-basic` | `ctx.compaction`（定义在 `dsh-compaction`） |
| 用量 | `@deepseek-ai/dsh-token-meter` | `ctx.tokenMeter` |
| 提示词 | `@deepseek-ai/dsh-system-prompt` | `ctx.systemPrompt` |
| 不变量 | `@deepseek-ai/dsh-invariants`（+ `dsh-<pkg>/invariant`） | `ctx.invariants` |

**注意**：`platform-plan-v2.md` §5.1 把会话包写成 `dsh-session-projection` /
`dsh-session-persistence-jsonl` 是正确的，但**没有**提到 `dsh-agent-loop` 是独立一行 ——
这一条是 P1 的关键（见 §2.1）。

### 3.2 `ctx.agents`（[实测] + [源码]）

```ts
// @deepseek-ai/dsh-agent
interface CreateAgentOptions {
  readonly sessionId: SessionId                      // 调用方提供；不自动生成
  readonly parentAgent?: Agent
  readonly meta?: {
    readonly cwd?: string                            // 必须是绝对路径
    readonly parentSession?: SessionId
    readonly isSeeded?: boolean
    readonly origin?: 'subagent'
    readonly delegationDepth?: number
    readonly agentPreset?: string                    // ← 会写进会话 header
  }
  readonly inheritedEventCount?: SessionLogOffset
  readonly seed?: readonly SessionEvent[]
  readonly agentOptions?: AgentOptions               // { provider?, model?, reasoningEffort?, maxTokens? }
  readonly signal?: AbortSignal
  readonly setup?: AgentSetup
}

type AgentSetup = (
  agentCtx: Context,
  agent: Agent,
) => AgentSetupCommit | Promise<AgentSetupCommit | void> | void

interface AgentSetupCommit { commit(): void }        // 必须同步

interface ResumeAgentOptions {
  readonly resumeSessionId: SessionId
  readonly parentAgent?: Agent
  readonly agentOptions?: AgentOptions
  readonly signal?: AbortSignal
  readonly setup?: AgentSetup
}

interface AgentHandle { agent: Agent; dispose(): Promise<void> }

// 服务方法
create(options: CreateAgentOptions): Promise<AgentHandle>
resume(options: ResumeAgentOptions): Promise<AgentHandle>
get(id: SessionId): Agent | undefined
list(): Agent[]
roots(): Agent[]
```

**[实测] 探针 `P1:create-await-preset-mount-and-commit` 输出**：

```json
{"setupRan":true,"commitRan":true,"mountedPreset":"myrix-empty",
 "headerPreset":"myrix-empty",
 "headerKeys":["version","id","createdAt","isSeeded","agentPreset"]}
```

结论（逐条对应 `tech-design-v1.md`）：

- **A7 成立**：`setup` 内 `await ctx.agentPresets.mount(agentCtx, 'myrix-empty')` 在真实 DSH 上
  可用；`commit()` 确实在发布前被调用。**R1 消除**。
- **setup / commit 失败不发布**：**[实测]** 故意在 `setup` 抛错的 `create` 失败，
  且 `ctx.agents.get(badSid) === undefined` —— **没有发布**。
- **会话 header 的字段是固定的**：只有 `version / id / createdAt / isSeeded / agentPreset`。
  **没有自定义 meta 字段可写** —— `platform-plan-v2.md` §3.1 的判断成立，身份只能放
  `principals` 的 `WeakMap<Agent, Principal>`，不能进 header。

### 3.3 `ctx.sessions`（[实测]）

```ts
flush(session: Session): Promise<boolean>   // true = 至少一个持久化 listener 参与且全部成功
get(id: SessionId): Session | undefined
```

**[实测]** `flush()` 返回 `true`。

**[源码] `session/flush` 语义（重要，A8 的依据）**：它是 `parallel` 模式，每个 listener 都跑、
调用方 await 全部、没有 waterfall 否决。**`flush` 成功只表示“缓冲事件已写盘”，不表示“模型已回复”**。
回执语义必须按 `tech-design-v1.md` §3.3 定为“已持久接收”。

### 3.4 事件：`session/event` 与 `agent/assistant-stream`（[实测]）

```ts
'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void   // mode: emit
'agent/assistant-stream'(this: Scoped<Agent>, payload: { agent: Agent; frame: AssistantStreamFrame }): void
```

**[实测] `P1:assistant-stream-payload-shape`：payload 的键恰好是 `["agent","frame"]`，
`payload.agent.id === sessionId`。** 这直接回答 **R5**：取会话 id 的字段是 `payload.agent.id`
（不是 `payload.sessionId`，也不是 `payload.session.id`）。

> **[源码] 注意**：这是 `Scoped<Agent>` 事件，`agent-scoped listeners receive only that agent`。
> 想在**整个进程**上看到所有会话的流，必须在根 context 上监听；在 `agent.ctx` 上监听只能看到自己。

**[实测] `AssistantStreamFrame` 的实际序列**（一次 `followup` → 一个 turn）：

```text
start → chunk ×5 → end
```

`end` 帧的 `outcome` 是 `{ kind: 'committed', eventType, seq }` 或 `{ kind: 'abandoned' }`。
[源码] **`chunk` 帧是瞬态的，断线不能补**；`end` 帧里的 `seq` 指向真正持久化的
`assistant/message` 或 `assistant/attempt` 事件。SSE 实现必须按此分流（`tech-design-v1.md` §3.3 成立）。

### 3.5 持久事件的 `seq`（[实测]，**含一个重要修正**）

**[实测] 单进程内 `seq` 从 0 开始、严格连续**：

```json
{"eventTypes":["agent/inbox/spliced","turn/start","agent/inbox/spliced","step/start",
 "system/message","user/message","request/header","request/context",
 "assistant/message","step/end","turn/end"],
 "seqs":[0,1,2,3,4,5,6,7,8,9,10],
 "seqIsZeroBasedContiguous":true,
 "messageIdSurvivesToLog":true,"lastSeq":10}
```

**[实测] 跨进程重启时 `seq` 单调但不一定连续 —— 这是 SSE 续传的实现约束。**
探针 `P2:restart-resume-reuses-the-same-seq-space` 把同一个 `$DSH_HOME` 起了**两次真 DSH**：

```json
{"previousProcessFinalSeqOnDisk":10,
 "firstNewSeq":12,
 "seqDeltaAcrossRestart":2,
 "seqStrictlyIncreases":true,
 "seqContinuesWithoutReuse":true}
```

磁盘上的连续序列证明了原因：

```text
 seq 10  turn/end
 seq 11  session/end-seed     ← 进程退出时追加的“收尾”事件
 seq 12  agent/inbox/spliced  ← 重启后的第一个事件
```

**结论（对 SSE 实现是硬要求）**：DSH 在恢复一个**未提交收尾标记**的会话时，会**修复**日志，
补一条合成的 `session/end-seed`（[源码]：恢复时用合成 closer 关闭被中断的轮次）。因此：

1. `seq` **绝不复用**（同内容不会被赋予相同 seq）—— `Last-Event-ID` 语义成立；
2. 但**不能假设 `lastCommittedSeq + 1` 就是下一个 seq**；
3. SSE 续传必须**按 `seq` 去重**并**容忍空洞**，不能按算术连续来推断。

> 顺带修正 `tech-design-v1.md` §3.3 的一处隐含假设：原文说“按 `seq` 去重”是对的，
> 但“从会话日志补发持久事件”实现时必须处理这种空洞。

### 3.6 `followup` 与显式 `messageId`（[实测]，回答 R3）

**[实测]** `followup` 接受调用方指定 `id` 的 `UserMessage`，且该 `id` **确实写进了会话日志**：

```json
{"requestedId":"poc_cmd_0001","flushed":true,
 "userMessageIds":["poc_cmd_0001"],"messageIdSurvivesToLog":true}
```

磁盘 artifact 二次确认：`sessions/_no-cwd/<sid>/session.v4.jsonl` 里 `poc_cmd_0001` 出现两次
（`agent/inbox/spliced` 与 `user/message` 各一次）。

**`R3 结论：可行。** `commandId` 可以作为消息 id，重启后能在会话日志里对账。

构造方式（[源码] `@deepseek-ai/dsh-llm` 的 `createUserMessage` 不接受外部 `id`，必须覆盖）：

```ts
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const message = createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})
agent.followup({ ...message, id: 'cmd_<commandId>' })   // 显式覆盖 id
await ctx.sessions.flush(agent.session)
```

> **注意**：`createUserMessage` 的签名里有 `readonly id?: never`，所以**只能**用对象展开覆盖，
> 不能作为参数传入（TS 会报错）。上面这种写法是唯一可行形式，已在 PoC 中实测。

### 3.7 模型调用的归因字段（[实测]，回答 R4）

[源码] `GenerateOptions`：

```ts
interface GenerateOptions {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
  messages: RequestMessage[]
  system?: string
  tools?: ToolSchema[]
  toolHistory?: ToolHistory
  temperature?: number
  maxTokens?: number
  stop?: string[]
  signal?: AbortSignal
  sessionId?: Branded<'SessionId'>         // ← loop 填写，用于归因/重放游标
  purpose?: 'compaction' | 'session-title' // ← 辅助调用分类
}
```

**[实测] 探针 `P2:model-call-carries-sessionId-for-attribution`**：普通对话调用与压缩辅助调用
**都带 `sessionId`**：

```json
{"calls":[
  {"provider":"poc-mock","model":"poc-model","sessionId":"poc_main_…","purpose":null,"messageCount":2},
  {"provider":"poc-mock","model":"poc-model","sessionId":"poc_compact_…","purpose":null,"messageCount":6},
  {"provider":"poc-mock","model":"poc-model","sessionId":"poc_compact_…","purpose":"compaction","messageCount":7}
]}
```

**R4 结论：`sessionId` 在对话与压缩调用上都存在，`myrix-llm-gateway` 可以按它归因。**
[源码] 依据：`dsh-agent-loop` 在组装请求时写 `sessionId: this.session.id`；
`dsh-compaction-basic` 的 summarizer 显式写 `sessionId: agent.session.id, purpose: 'compaction'`。

> **[实测] 但 `compactNow` 本身返回 `null`**：`{"compacted":false,
> "error":"manual compaction could not produce a smaller summary"}`。
> 也就是说**辅助调用确实发出去了（带 `purpose: 'compaction'`）**，只是这条 mock 摘要内容太短、
> 不足以产生更小的结果。这足以验证归因链路，但**没有**验证“真实压缩能成功”。
> 完整压缩路径属于 P1 的“压缩可用”，本轮只验证到“辅助调用带 `sessionId`”。

### 3.8 `ctx.tools.guard()`（[实测]，**含一个必须修正的实现假设**）

```ts
type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined
// 返回 string = 拒绝；undefined = 本 guard 不拒绝
guard(guard: ToolGuard): () => void
```

**[实测]** guard 被调用 1 次，`exec.agent === undefined` 时返回原因字符串。

**但 `execute()` 不抛异常** —— 它返回一个 `isError: true` 的结果：

```json
{"guardCalls":1,"seenAgent":"undefined",
 "resultIsError":true,
 "denialText":"Error: myrix: 会话没有有效身份",
 "errorMessage":"myrix: 会话没有有效身份"}
```

[源码] 确认（`dsh-tools` 的 `execute` 返回 `ToolExecutionResult = ToolExecutionSuccess |
ToolExecutionFailure`）：拒绝路径走 `post-result`，把拒绝原因**物化成模型可见的错误结果**，
而模型上的 `error` 字段承载原因。

> **对 `tech-design-v1.md` §4.2 的修正建议**：`myrix-policy-guard` 返回字符串表示拒绝是对的，
> 但 **P2 的验收判据不能写成“工具调用抛异常”**，必须写成
> “`ctx.tools.execute()` 返回 `isError === true` 且 `error.message` 是拒绝原因”。
> 另外 guard 通过 `ctx.tools.guard()` 注册后，`exec.agent` 在**模型直接调用**路径上确实是
> `undefined`（无 agent 上下文），这正是 fail-closed 要拦的情形。

**[实测] `guard` 与 `exec.agent` 的实际键**：

```text
exec 的键: ["token","callId","rootCallId","name","signal","deferContext","concludeTurn","arguments"]
```

注意：**`exec.agent` 在 `Object.keys` 里不出现**（它是可选属性，未传时不存在），
所以判定必须写 `exec.agent === undefined`，不能写 `'agent' in exec`。

### 3.9 `resume` 与 preset 一致性（[实测]）

**[实测]** 从磁盘恢复的 Agent，其 `session.header.agentPreset` 可读且等于创建时的值；
在 `setup` 里比对不一致并抛错，`resume()` 会失败：

```json
{"fromDiskPreset":"myrix-empty","mountAccepted":true,
 "mismatchRejected":true,"mismatchMessage":"resume: preset 与绑定不一致"}
```

**`platform-plan-v2.md` §3.3 的“resume 时核对磁盘 header 中的 `agentPreset` 与凭证一致”成立。**

### 3.10 dispose 语义（[实测]）

```json
{"stillLive":false,"persistenceFlushed":"flush-after-dispose-threw"}
```

`handle.dispose()` 之后 `ctx.agents.get(sid) === undefined`（已注销）。
对已 dispose 的会话调 `ctx.sessions.flush()` 会抛错（会话已不在 live store 中）。

> **实现提示**：driver 的 `drain()`（`tech-design-v1.md` §4.1）在 dispose 之后**不能**再
> `flush`。顺序必须是“先 flush，再 dispose”。

---

## 4. P1 / P2 逐条判定

| # | P1 验收标准（`platform-plan-v2.md` §8） | 结果 | 证据 |
|---|---|---|---|
| P1-a | 不叠 `dsh-base` 能启动 | ✅ | 两次真实启动，退出码 0；Loader 24 行中无 `dsh-base` |
| P1-b | 对话可用 | ✅ | 一次完整 turn：`user/message` → `assistant/message` → `turn/end`，事件连续 |
| P1-c | preset 切换可用 | ⚠️ **部分** | `setup` 内 `mount` 成功、`headerPreset` 正确；**未测“运行中切换 preset”**（需 `select`/`recompose`） |
| P1-d | `--dump-config` 无禁用插件 | ✅ | 泄漏 0 条（29 个禁用包逐个匹配） |
| P1-e | 压缩可用 | ⚠️ **部分** | 压缩辅助调用发出且带 `purpose: 'compaction'`；但该次 `compactNow` 返回 `null`（摘要不够小），**未证明真实压缩收敛** |

| # | P2 验收标准 | 结果 | 证据 |
|---|---|---|---|
| P2-a | 无凭证 / 过期 / `aud` / `tid` 不符 / `jti` 重放 → 创建恢复成功 0 次 | ⛔ **未验证** | 授权凭证（ES256 验签、`jti` 去重）属于 `myrix-runtime-driver`，本轮**没有实现**；见 §6 范围说明 |
| P2-b | 无身份 Agent 的工具调用 100% 被拒 | ✅ | guard 拒绝，`isError: true`，拒绝原因可见 |
| P2-c | resume 时 preset 不一致被拒 | ✅ | `setup` 抛错 → `resume` 失败 |

**范围说明**：本轮任务是“白名单组合与 API 验证”，因此 P1 是主体；P2 只验证**由 DSH 提供、
runtime 实现必须依赖**的那几个 API 契约（身份安装点、消息 id、flush、seq、归因、guard、resume）。
凭证签发与验签（P2-a）需要 `packages/grant` 与 driver 一起做，**不在本轮范围**，
不能据此认为 P2 已通过。

---

## 5. 风险结论（更新后的 R1–R10）

| # | 原风险 | 现状 | 依据 |
|---|---|---|---|
| **R1** | `setup` 内 `await presets.mount()` | ✅ **消除** | [实测] mount 成功、commit 被调用 |
| **R2** | 白名单能否独立启动 | ✅ **消除** | [实测] 两次启动成功，无 `dsh-base` |
| **R3** | `commandId` 作消息 id 以便重启对账 | ✅ **消除（可行）** | [实测] `poc_cmd_0001` 落盘，磁盘二次确认 |
| **R4** | 辅助模型请求是否带 `sessionId` | ✅ **消除** | [实测] 压缩调用带 `sessionId` + `purpose` |
| **R5** | `assistant-stream` 取会话 id 的字段 | ✅ **消除** | [实测] `payload.agent.id` |
| R6 | 节点级 mTLS | ⛔ 未触及 | 集群问题，本轮不涉及 |
| R7 | 块存储卷上限、冷启动 p95 | ⛔ 未触及 | 需要 K8s |
| R8 | 撤权通知延迟与在途写入竞争 | ⛔ 未触及 | 需要 driver |
| R9 | 开源模型网关 | ⛔ 未触及 | 未联网核实 |
| **R10** | DSH API pre-stable | ⚠️ **仍然成立，且已有实证** | 见 §1.1：本机存在 `0.1.0-rc.6` 与 `0.2.0-rc.2` 两个版本，`agentPresets` 的服务名与 `mount` 语义都不同 |

### 5.1 新增风险（本轮实测发现）

| # | 风险 | 影响 | 处置建议 |
|---|---|---|---|
| **R11** | **`seq` 跨重启有空洞**：未提交收尾标记的会话在恢复时会被补一条合成的 `session/end-seed`，吃掉一个 seq | SSE 若按 `lastSeq + 1` 推断会漏发或错位 | SSE 必须**按 `seq` 去重 + 容忍空洞**；`Last-Event-ID` 只作下界。已写入 §3.5 |
| **R12** | **guard 拒绝不抛异常**，返回 `isError: true` 的结果 | P2 验收脚本若断言“抛异常”会**误判为通过/失败** | 验收判据改为检查 `ToolExecutionResult.isError`。已写入 §3.8 |
| **R13** | **`profile` 内插件必须物理位于 profile 目录**，且 `$DSH_HOME/profiles/node_modules` 必须存在 | 部署镜像若把插件放在别处，启动会 `failed to import`，且**报错信息不含真实原因**（只说 `failed to import`） | 镜像构建时必须把 `myrix-*` 插件复制进 profile 目录并铺设 `profiles/node_modules`。已写入 §1.2 |
| **R14** | **`dsh-agent-loop` 必须单独挂载**，否则 `ctx.agents.create()` 抛 `no agent factory registered (load an agent-loop plugin)` | 漏挂时启动“看起来正常”，第一次建会话才失败 | 已加入白名单；建议 P1 增加一条“`create()` 可用”的启动自检 |
| **R15** | **安装方式强约束**（`node-linker=hoisted` + `auto-install-peers=true`） | 换 pnpm 配置即启动失败，且失败点很靠前、信息晦涩 | 写进镜像构建脚本并加断言。已写入 §1.2 |

---

## 6. 给 P2 / 后续实现的具体输入

1. **身份安装点已确认**：`setup(agentCtx, agent)` 是唯一正确的位置；`commit()` 只能做，
   **同步、无 I/O** 的校验（[源码] `commit(): void`）。`principals.bind(agent, p)` 用
   `WeakMap<Agent, Principal>` 即可 —— 会话 header 没有自定义字段可用。
2. **回执语义**：`await ctx.sessions.flush(session) === true` 表示“已持久接收”，可以回
   `accepted`。不要等 `turn/end`。
3. **消息 id**：用 `{ ...createUserMessage(...), id: commandId }` 覆盖，重启后按 `messageId`
   在日志里对账（R3 已确认可行）。
4. **SSE**：
   - 先订阅 `session/event`（拿到 `event.seq`）与 `agent/assistant-stream`；
   - 持久事件按 `seq` 补发，**必须去重、必须容忍空洞**（R11）；
   - 瞬态 `chunk` 帧不补发；用 `end` 帧的 `outcome.seq` 对齐持久事件。
5. **`drain()` 顺序**：`flush` → 再 `dispose`；dispose 之后 `sessions.flush` 会抛错。
6. **guard**：`exec.agent === undefined` 即拒绝；拒绝方式是**返回字符串**；调用方看到的是
   `isError: true` 的结果而不是异常（R12）。
7. **归因**：`myrix-llm-gateway` 的 `LlmAdapter.stream(options)` 里读 `options.sessionId`；
   辅助调用另有 `options.purpose`（`'compaction'` / `'session-title'`）可区分计费口径。
8. **不要依赖 `ctx.get('sandboxPolicy')`**：白名单里没有它。任何读取都要处理 `undefined`。

---

## 7. 未验证 / 需要后续轮次补的清单

明确列出**没有**验证的东西，避免被误读为已通过：

| 项 | 为什么没做 | 建议 |
|---|---|---|
| 凭证签发/验签（ES256、`jti` 重放、`aud`/`tid` 校验） | 需要 `myrix-runtime-driver` + `packages/grant`，不在本轮范围 | 下一轮：driver 内单测 + 真实 `ctx.agents.create` 负例 |
| 运行中切换 preset（`agentPresets.select` / `recompose`） | P1-c 只验证了挂载 | 补一条探针 |
| 真实压缩收敛（`compactNow` 产出更小 surface） | mock 摘要太短 | 用长会话 + 可控 mock |
| `assistant/attempt`（中断/失败路径）的 `seq` 与 `outcome` | 未构造失败模型调用 | 补 mock 失败分支 |
| SSE 端到端（真实 HTTP 订阅 + `Last-Event-ID` 续传） | 未挂 `dsh-host-webserver`（白名单里没有） | driver 实现时一并做 |
| 多租户隔离（P3）、同租户用户隔离（P4） | 需要两个 cell | 集群阶段 |
| 崩溃/节点故障（P5）、缩到零（P6） | 需要 K8s | 集群阶段 |
| 附件跨会话按 hash 读取路径 | 未触及 | §4.2 的 [PoC] 项 |
| `@deepseek-ai/dsh-agent-presets`（0.1.x）与 `dsh-agent-preset-registry`（0.2.x）的迁移成本 | 只确认了差异存在 | P8 升级测试时量化 |

---

## 8. 本仓库内的文件

| 路径 | 作用 |
|---|---|
| `bundles/myrix-base/package.json` | bundle 清单：`dsh.bundle.patch` 指向白名单 patch，**零依赖** |
| `bundles/myrix-base/cordis.patch.yml` | **白名单本身**：一层 insert，24 行 |
| `bundles/myrix-base/src/index.ts` | 空模块（bundle 的实体是 patch，与 `dsh-sdk-minimal` 同构） |
| `tests/poc/run-poc.mjs` | 编排器：铺临时 `$DSH_HOME`、起真 CLI 两趟、断言、汇总 |
| `tests/poc/plugins/poc-app.mjs` | 16 条探针的实现（在真实 DSH 树内运行） |
| `tests/poc/plugins/poc-mock-llm.mjs` | 唯一替身：无 key 的模型适配器；记录 `sessionId`/`purpose` |
| `tests/poc/DEPENDENCIES.md` | 依赖清单与安装约束 |
| `tests/poc/.dsh-install/package.json` | 锁定 `@deepseek-ai/dsh@0.2.0-rc.2`（精确版本，无范围） |
| `tests/poc/.dsh-install/pnpm-lock.yaml` | **入库**：钉死运行时及全部传递依赖 |
| `tests/poc/.dsh-install/.npmrc` | `node-linker=hoisted` + `auto-install-peers=true`（见 §1.2，两者都不可省） |
| `tests/poc/.work/` | 运行产物（临时 home、report），每次运行重建 |

---

# 第二部分：真实 Myrix 插件的隔离 Cell 组合（Phase 0 P2 续）

> 状态：**实测通过**（2026-10-01，12/12 探针）。范围：把 `plugins/myrix-*` 里**真正的**
> Cordis 插件装进可启动的 `myrix-base`，起**两个隔离 `$DSH_HOME`** 的真实 Cell 进程，
> 用真实 DSH 的持久化 / agent-loop / driver 验证「签名 create/send/subscribe、重启去重」，
> 并验证 **novel 垂直业务的 preset 作用域工具** 与 **Responses-only 模型链路**。
> 标注沿用第一部分：**[实测]** = 本仓库跑出来的结果；**[源码]** = 只读对照 vendor `639ed01`；
> **[替身]** = 只在 PoC 里替代**外部对端**，不替代 DSH 或 Myrix 逻辑。

## 9. 复现方式

```bash
# 前置：隔离的锁定运行时（需要网络；见 §1.2 与 tests/poc/DEPENDENCIES.md）
cd tests/poc/.dsh-install && pnpm install

# 组合检查：两个 Cell 的 profile 装配 + --dump-config
node tests/poc/run-cell.mjs --dump-config

# 完整 E2E：两个真实 Cell 进程、签名命令、SSE、撤权、重启去重、novel 装配
#          与 Responses 负例（12 条探针；生产范围，novel 已挂、requirePolicy: true）
node tests/poc/run-cell.mjs

# PoC 显式退出 novel（只跑 driver/身份链路）：探针报告会写明这是选择的范围
node tests/poc/run-cell.mjs --driver-only

# 确定性工厂/安全测试（不需要 DSH 运行时、不需要网络）
node --test 'tests/poc/tests/*.test.mjs'
```

> 运行产物在 `tests/poc/.work-cell/`（已 gitignore）。它**独立于** `tests/poc/.work/`：
> `run-poc.mjs` 每次会重建 `.work/`，共用目录会静默删掉另一边的证据。

**[实测] 12/12 通过**（2026-10-01），两个 Cell 都成功启动、应答 `/v1/ready`、且各自 `bootId` 不同。
原始逐条 detail 在 `tests/poc/.work-cell/cell-report.json`。
`--driver-only` 范围同样 **12/12 通过**（它显式退出 novel，见 §14.3）。

## 10. 版本事实（与第一部分的区别必须说清）

| 项 | 值 |
|---|---|
| 运行 | npm `@deepseek-ai/dsh@0.2.0-rc.2`（`tests/poc/.dsh-install`，hoisted） |
| 源码基线 | submodule `639ed015397290b3745d163aafe02ffee4aa3f84`（同样是 `0.2.0-rc.2`） |
| 结论 | **npm 版本号与该 git commit 相同，但没有被证明是同一构建**：npm 发布的是打包产物，无法与 commit 逐字节比对。因此第二部分的每条结论都同时给 `[源码]`（在 `639ed01` 读到）与 `[实测]`（真实进程里观察到），不靠版本号推断 |

## 11. Cell 的组成（真实插件，非替身）

profile 布局与真实镜像一致（插件物理位于 profile 内、裸包名解析）：

```text
<home>/
  profiles/node_modules -> <locked install>/node_modules      (symlink)
  profiles/myrix-cell/package.json      dsh.profile.bundles = ['@myrix/dsh-bundle-myrix-base']
  profiles/myrix-cell/cordis.yml        []
  profiles/myrix-cell/cordis.patch.yml  Cell 层（非机密配置）
  profiles/myrix-cell/node_modules/@myrix/<pkg>/index.mjs     编译后的真实插件
  profiles/myrix-cell/plugins/cell-*.mjs                      仅测试的探针行
```

`bundles/myrix-base/cordis.patch.yml`（24 行白名单）**保持不变**；Cell 层是新增的
`bundles/myrix-base/cell.patch.yml`，它**不在** `dsh.bundle.patch` 默认列表里，因此白名单 PoC
一行都不受影响（复测：`run-poc.mjs --dump-config` 仍然「forbidden rows = []」）。

**[实测] Cell 装配后的 Loader 有 29 行**，其中真实 Myrix 插件 5 个 + `dsh-host-webserver`
1 个（Cell 的 HTTP 载体）+ 2 个仅测试行。**[实测] 禁用面为空**：`forbiddenRows = []`，
且 `subprocess/terminal/bash/sandbox/fs/web/jobs/goals/subagents/workflowEngine/skills/
pluginManager/configEditor/settings/hmr/sessionQuery/storage/…` 全部 `ctx.get() === undefined`。

### 11.1 为什么 Cell 需要单独一层

| 行 | 为什么不能进白名单 |
|---|---|
| `webserver` | `dsh-host-webserver` 是**独立**包（peer 只有 cordis），可以从 `dsh-base` 之外单独挂，从而拿到 HTTP 而不引入 `dsh-web-app` 的浏览器 roster（`modules`/`connection`/`ui-*` 全在禁用清单里）。挂进白名单会让**每个** profile 都去开端口 |
| `myrix-*` 五行 | 都需要 per-Cell 值（cellId/tenant/port/works origin/gateway URL）与三份凭据 |
| `cell-route-seam`、`cell-probe` | 仅测试行；见 §13.2 与 §14 |

### 11.2 TS 源码如何变成能加载的插件（[实测] 的装载约束）

插件是 **TypeScript 源码 + 无扩展名相对导入**（`from './types'`）。

* **[实测]** 锁定 CLI 用普通 Node 启动，`node --experimental-transform-types` 对无扩展名
  说明符报 `ERR_MODULE_NOT_FOUND`；`--import tsx` 可以，但那是把第三方 loader 塞进 Cell 运行时，
  不是一个愿意签字的部署形态。
* **[实测]** 用仓库已有的 `esbuild`（vitest 传递依赖，未新增任何依赖、未改 lockfile）把每个插件
  打成单文件 ESM：`@deepseek-ai/*` 保持 **external**（保证**只有一个** Cordis 实例，
  不出现双份类身份），`@myrix/grant` 与 `@myrix/principals` **内联**（纯 TS 库，不引入第二个 Cordis 服务）。
  5/5 插件编译成功，产物 6–100 KB。这正是真实镜像该做的事（编译成 JS 再进 profile）。
* **[实测]** 无扩展名导入只有 esbuild 这一条路可走；`--alias` 必须用**绝对路径**（esbuild 相对 cwd 解析 alias）。

### 11.3 两个「想不到」的装载事实（都会让 profile 静默失败）

1. **[实测] profile 内可解析裸包名，但目录名必须等于包名。** `"@myrix/principals"` 必须落在
   `node_modules/@myrix/principals/`；用源码目录名 `myrix-principals` 会
   `ERR_MODULE_NOT_FOUND: Cannot find package '@myrix/principals'`。
2. **[实测] profile 内的 `.mjs` 文件同样能解析裸 `@deepseek-ai/*`。** 早期版本把它们改写成
   绝对 `file://` URL，结果是每个 DSH 包（含 React）被加载**第二份**，探针以
   `react_cache` 之类的晦涩错误失败。**不要**改写；保持裸包名即可，Cordis 实例因此唯一。

## 12. 真实 / 替身 / 未验收（先看这一节）

### 12.1 真实（无替身）

Cordis、Loader、`myrix-base` 白名单、`dsh-session`、`dsh-session-persistence-jsonl`（真实 JSONL 落盘）、
`dsh-agent-loop`、`dsh-agent`、`dsh-tools`、`dsh-agent-preset-registry`、`dsh-llm`、
`dsh-compaction-basic`、`dsh-token-meter`、`dsh-user-approval`、`dsh-host-webserver`；
`myrix-principals`、`myrix-policy-enforcer`、`myrix-binding-lease`、`myrix-runtime-driver`、
`myrix-llm-gateway`（全部是 `plugins/*/src` 编译出来的真实插件）；
`@myrix/grant` 的 ES256 JWS 签发与严格校验（真正的 JWS、真正的 claim 表、真正的 `jti` 一次性存储）；
HTTP、SSE、`Last-Event-ID`/`seq`、撤权、两台真实进程的崩溃重启。

### 12.2 替身（只替外部对端，不替 DSH/Myrix 逻辑）

| 替身 | 替的是谁 | 生产对应 | 替身做了什么 |
|---|---|---|---|
| 模型网关 stub（loopback HTTP + 真 SSE） | `apps/model-gateway` :8790 | OpenAI 兼容 `/v1/chat/completions`，PG 身份/凭据/额度，上游密钥只在网关 | 有 key 时回真 SSE（并**回显**收到的用户文本，用来证明模型确实收到了那一条）；`hasUpstreamKey:false` 时回 **503 `model_not_configured`** —— 缺密钥就是失败，绝不假成功 |
| 作品服务 stub（loopback HTTP ×2，每 Cell 一个） | `apps/works-service` :8791 | `GET /internal/v1/cells/{cellId}/bindings` | 只服务自己 `cellId` + 自己 token；`bindings()` 每次现读，便于观察创建竞态刷新 |
| 控制面私钥 | KMS/受控 Secret | 控制面签发的 ES256 私钥 | 用 `@myrix/grant` 的 `generateTestKeyPair` 在**运行器进程内**生成；Cell 只拿到公钥 JWKS |
| `cell-route-seam` | 浏览器面的 `installModelSelection` | driver 自带的 `defaultProvider`/`defaultModel` | **本 profile 已关闭**（driver 已支持默认路由，见 §13.1） |

> 模型 stub 的「回显」是刻意的：`assistantEchoedTheSentText: true` 与
> `messageIdIsCommandId: true` 一起，证明「命令 → 真实 agent loop → 真实模型路由 → 真实持久化」
> 这条链上没有一处我们自己在编造内容。

### 12.3 未验收（明确列出，避免被误读为已通过）

| 项 | 为什么没做 |
|---|---|
| 真实模型网关（PG 身份 + 凭据 + 额度） | 属于 `apps/model-gateway`，需要 Postgres；本轮只证明 Cell 侧链路的真实性与 503 失败语义 |
| 真实作品服务（8791） | 同理；`myrix-novel` 尚未完成（§14） |
| mTLS / NetworkPolicy / K8s 探针 | 集群阶段（P3–P6） |
| 缩到零与 drain 后的驱逐 | 需要 Cell 管理器；本轮只验证 `drain` 端口存在与匿名拒绝（§13.4） |
| 证据留存 | 两个 Cell 的 JSONL 在**同一台机器**、只按 `$DSH_HOME` 隔离；跨节点隔离未测 |
| `myrix-llm-gateway` 的完整 SSE 分帧/取消矩阵 | 由该插件自己的 smoke 覆盖；本轮只断言归因头与真实 HTTP 到达 |

## 13. [实测] Cell 端到端结果

### 13.1 启动与路由（探针 1）

两个 Cell 各自 `ready:true`，`bootId` 不同：

```json
{"a":{"ready":true,"bootId":"311cd363-…","draining":false},
 "b":{"ready":true,"bootId":"d12a9559-…","draining":false}}
```

**[实测] 需要 Lead 知晓的改造（B1 已修）**：`myrix-runtime-driver` 现在**必填**
`defaultProvider`/`defaultModel`，并在 `agents.create()/resume()` 时作为 `AgentOptions` 传入。
在此之前它不是——vendor 的 agent loop 在没有 provider/model 时直接抛
`agent "<id>" has no provider/model …`（[源码] `packages/core/agent-loop/src/agent.ts:577-582`），
浏览器面靠 session 级 `agent/request` waterfall 补齐，Cell 侧当时没有任何等价物。
driver 侧补齐后，本 PoC 改用**生产形态**（driver 声明路由），`cell-route-seam` 行关闭。
这消除了 `bundles/myrix-base` 对「测试专用路由接缝」的依赖。

### 13.2 签名 create / send / subscribe（探针 2–6）

* **[实测] create**：`POST /v1/commands` 带 ES256 凭证 → `200 {status:"accepted"}`；
  磁盘 **A 的** `$DSH_HOME/sessions/_no-cwd/<sid>/session.v4.jsonl` 出现，
  **B 的 home 里没有该会话**（`cellBSessions: []`）。
* **[实测] 进程内去重**：同一 `commandId` 重试（**新 jti**）→ `status:"duplicate"`，不重复执行。
* **[实测] send 打通真实 agent loop 与真实模型路由**：
  - 到达网关 stub 的真实 HTTP 请求头：`authorization: Bearer gateway-cell-a-…`、
    `x-myrix-session: cellA_s…`、`x-myrix-revision: 1`、`x-myrix-cell-tenant: t_a`（归因正确）；
  - 持久日志里 `user/message` 的 `id === commandId`（`messageIdIsCommandId: true`，R3 在生产形态下成立）；
  - `assistantEchoedTheSentText: true`（模型确实收到该文本）；
  - `turn/end.reason.kind === "completed"`。
* **[实测] 持久事件流**：SSE 用 `op=subscribe` 凭证连接，`id:` = 日志 `seq`，事件按 seq 严格递增：

  ```text
  frameEvents: turn/start, agent/inbox/spliced, step/start, system/message, user/message,
               request/header, request/context, assistant/message, step/end, turn/end
  ids:         1,2,3,4,5,6,7,8,9,10
  ```

  > 一个与第一部分的差异：`myrix/ready` 横幅只在**实时**订阅上发送；纯由持久日志补发的连接
  > 从第一条已提交事件开始。两者都是合法形状，因此断言只针对稳定契约（订阅被接受、
  > durable 帧带 seq 且严格递增、包含 `user/message`）。

### 13.3 负例（探针 6，全部拒绝且无副作用）

| 用例 | 结果 |
|---|---|
| 无凭证 | `401 grant_missing`（`grant/malformed`） |
| `aud` 错 | `403 grant/audience-mismatch` |
| `tid` 错 | `403 grant/tenant-mismatch` |
| `boot` 错（旧进程的凭证） | `403 grant/boot-mismatch` |
| 正文被换（`bh` 不符） | `403 grant/body-hash-mismatch` |
| 同一 `jti` 用两次 | 第一次 200；第二次 `403 grant/replayed`（`stage:"replay"`） |
| 另一把私钥签的凭证 | `403 grant/unknown-kid`（`stage:"signature"`） |
| 未安装的 `kid` | `403 grant/unknown-kid` |
| 无绑定快照的 `create` | 拒绝，且 `$DSH_HOME` 里**没有**该会话 |
| 发消息给从未创建的会话 | 拒绝，且**没有**创建会话（见 §15.2 的诚实标注） |
| 匿名 `/v1/admin/drain|revoke` | `401`（端点不可无凭证访问） |
| 未知 `commandId` 查回执 | `404 no_receipt`（并说明回执不跨重启保留，请回读日志） |

### 13.4 租户隔离与撤权（探针 7–8）

* **[实测]** A 的 works token 打 B 的 bindings 路径 → `401`；用 B 的 token 打 A 的 cellId 路径 → `404`；
  正确组合 → `200`。即「不能读别的 Cell 的绑定」与「错 token 拿不到同样的数据」都成立。
* **[实测] 撤权**：`POST /v1/admin/revoke`（带 service credential）→
  `{accepted:true, disposed:true, closedStreams:1}`；在途 SSE 连接被关闭；
  之后同一会话的 `send` → `403 session_revoked`。

### 13.5 重启去重（探针 9，**回答 R3 的跨进程形态**）

同一 `$DSH_HOME`，杀掉进程再启动（新 `bootId`），用**新凭证**重发**同一 `commandId`**：

```json
{"preRestartBootId":"…","postRestartBootId":"…",
 "firstDurableCopies":1,"retryStatus":200,
 "retryBody":{"status":"accepted","commandId":"cmd_…","bootId":"<新 bootId>"},
 "durableUserMessageCopies":1,"durableSeqRange":[0,10]}
```

**结论**：进程内回执表此时是空的，但 `send` 先在**权威 JSONL 日志**里按 `commandId` 对账，
因此**没有追加第二份**（`durableUserMessageCopies` 仍为 1）。
`status` 复述为 `accepted` 是刻意的：对「重试」而言，语义是「这条消息已经持久存在」，
与 `duplicate` 不同——**幂等由持久日志保证，而不是由内存表保证**。

### 13.6 Cell 自身的组合与 PEP 行为（探针 10）

**[实测] 真实服务面**：`webServer/principals/bindingLease/sessions/sessionPersistence/agents/
agentLoop/agentPresets/llm/tools/systemPrompt/sessionProjections/tokenMeter/compaction/approval/
attachments` 全部存在；禁用服务 0 泄漏；禁用行 0 泄漏。

**[实测] `myrix-policy-enforcer`（真实 guard，非替身）四态**：

| 场景 | 结果 |
|---|---|
| 无 agent 上下文 | 拒绝：`myrix: 会话没有有效身份（no-agent）：调用没有关联 Agent` |
| 有 agent、未绑定主体 | 拒绝：`…（unbound）：该 Agent 没有绑定授权主体` |
| 已绑定 + 活性有效、工具在 allowlist、**但没有策略快照** | **拒绝**：`myrix: 当前没有可用的策略快照，拒绝` |
| 同上 + 通过 `policySnapshotHolderOf(ctx).install(...)` 装了快照 | 放行（工具真正执行）；同一快照下**未列入 allowlist 的工具仍被拒绝** |

**最后两行是策略快照生产者（R16 策略桥）已经落地的证据**：`myrix-binding-lease`
把同一份绑定快照里的 `policy` 字段安装进 `myrix-policy-enforcer`，因此一个身份合法的
Cell **确实**能调用 allowlist 内的工具。

## 14. `myrix-novel` 已完成，并由 Cell profile 工厂直接装配

**[实测] 本轮状态**：`plugins/myrix-novel` 已是完整实现（`src/index.ts` 的真实
function plugin、`presets.ts` 的三个 preset、`preset-tools.ts` 子插件、`tools.ts`
的执行路径强校验、`tests/smoke` 的真实锁定 DSH 冒烟）。它**不再**通过
`extraRows` 手工装配，而是**工厂的生产行**：

```yaml
- id: myrix-novel
  name: '@myrix/novel'
  config:
    origin: !!js process.env.MYRIX_WORKS_ORIGIN
    credential: !!js process.env.MYRIX_WORKS_TOKEN
```

### 14.1 工具只在 preset 作用域注册（**[实测]**）

根作用域**没有**六个小说工具中的任何一个；每个 preset 的 Agent 只看到自己的掩码：

| preset | 该 Agent 可见的小说工具（实测，与 `PRESET_TOOLS` 逐一相等） |
|---|---|
| `novel-outline` | `get_outline`, `update_outline`, `search_bible` |
| `novel-chapter` | `get_outline`, `get_chapter`, `save_chapter_draft`, `search_bible` |
| `novel-bible` | `get_outline`, `get_chapter`, `search_bible`, `update_bible_entry` |

**「不可见」不是「可见但被劝阻」**：把策略快照放宽到包含 `save_chapter_draft`
之后，`novel-outline` 的 Agent 调用它仍然失败 —— 该 scope 里根本没有这个定义。
根作用域的工具清单只有探针自己注册的测试工具。

### 14.2 子路径必须真的编译出来（**[实测]**）

preset 行的模块说明符是**默认包名** `@myrix/novel/preset-tools`，经 profile 的
`node_modules` 解析。因此 `compilePluginEntries()` 必须：

1. 把 `src/index.ts` 编成 `index.mjs`；
2. 把 `src/preset-tools.ts` **单独**编成 `preset-tools.mjs`（同样的
   `--external:@deepseek-ai/*`，所以全树仍然只有一个 Cordis 实例）；
3. 在生成的 `package.json` 里写
   `exports: { ".": "./index.mjs", "./preset-tools": "./preset-tools.mjs" }`。

只编译根入口会得到一个**自带 preset、但 preset 行加载不起来**的包：`register()`
的子行 import 失败，preset 在 roster 里显示为 damaged。工厂现在对每个声明的子路径
做存在性断言，缺一个就让 profile 创建失败（`tests/poc/tests/factory.test.mjs` 覆盖）。

### 14.3 生产必须挂，PoC 只能显式退出

`createCellProfile()` 默认 `mode: 'production'` 且**永远**装配 `myrix-novel`；
显式 `novel: false` 会抛错。唯一的退出是 `mode: 'poc'` + `novel: false` + 必填的
`novelOptOutReason`，用于**只跑 driver/身份链路**的探针范围
（`node tests/poc/run-cell.mjs --driver-only`），并在探针报告里写明「这是选择的范围」。
`apps/bff/scripts/start-dev.ts`（生产启动器）不传这些字段，因此不会退出。

## 15. 本轮发现的新风险 / 需要 Lead 拍板

| # | 项 | 影响 | 建议 |
|---|---|---|---|
| **R16** | 策略快照生产者 | **已实现**：`myrix-binding-lease` 扩展为「绑定 + 有限策略」，把 `{rev, ttlMs, tools}` 安装进 `ctx.myrixPolicySnapshots`；生产行写死 `requirePolicy: true` | 保留：策略与绑定同源、同 TTL，失败即清空 |
| **R21** | **策略桥的服务装配顺序**（本轮实测并已修复）：`myrix-binding-lease` 原先在 `apply` 里同步 `ctx.get('myrixPolicySnapshots')`，而该服务由 `myrix-policy-enforcer` 提供、且不在 binding-lease 的 `inject` 里 | 修复前：两行在同一激活波次竞争，binding-lease 先跑就抛 `requirePolicy 已启用但缺少 myrixPolicySnapshots 服务` → 插件不激活 → 活性永不安装 → **所有** driver `create` 返回 `403 identity_invalid (liveness-unavailable)`；fail-closed 方向正确但生产 Cell 完全不可用 | **已修复**：`requirePolicy` 开启时改用 `ctx.inject([POLICY_SNAPSHOT_SERVICE], …)`，由 Cordis 等待提供者。复测：生产范围 `node tests/poc/run-cell.mjs` **12/12 通过** |
| **R17** | **`send` 到不存在的会话报 `503 persistence_unavailable`**，而非 404/409 | 路由无法区分「会话不存在」与「持久化真的坏了」；重试策略会不同 | 建议 driver 把「磁盘无该会话」映射为稳定的 404/409，并在响应里保留原因。本轮如实记录，不改他人插件 |
| **R18** | **npm 版本 ≠ git commit 未被证明** | 版本号相同容易让人以为「跑的就是 639ed01」 | 已在 §10 显式标注；升级必须按 P8 跑全部组合测试 |
| **R19** | **Cell 需要 `dsh-host-webserver` 才算可运行**，而它不在白名单里 | 只挂 `myrix-base` 时 driver 的 `inject=['webServer',…]` 永不满足，启动「看起来正常」但没有命令面 | 已加入可选 Cell 层 `cell.patch.yml`；生产镜像必须显式选择该层 |
| **R20** | **插件必须以编译后的 JS 进 profile** | 直接放 TS 源码 + 无扩展名导入会 `failed to import`（报错不含真实原因） | 已提供 `compilePluginEntries()`；镜像构建应复用它（或等价的 esbuild 步骤） |

### 15.1 模型链路只能是 Responses（**[实测] 负例回归**）

`apps/model-gateway` 与 `plugins/myrix-llm-gateway` 都只讲 OpenAI **Responses**：
适配器把 `baseURL` 当**网关 origin**，自己追加 `/responses`，并在配置阶段**拒绝**
指向 `…/chat/completions` 的 `baseURL`（不做静默改写）。PoC 的替身模型网关因此：

* 只服务 `POST /v1/responses`，事件序列为
  `response.created` → `response.output_item.added` → `response.output_text.delta`
  → `response.output_item.done` → `response.completed`（带 `usage`）；
* 请求体是 **Responses 形状**：`input` 数组（不是 `messages`）、**扁平** function
  tools（`{type:'function', name, description, parameters}`，没有嵌套 `function`）、
  恒发 `store: false`，且**没有** `stream_options`；
* 对 `/v1/chat/completions` 一律 **404**，并且探针断言「Cell 从未使用过该路径」。

### 15.2 生产范围实测结果（本轮，**12/12**）

```bash
node tests/poc/run-cell.mjs              # 生产范围：novel 已挂、requirePolicy: true
node tests/poc/run-cell.mjs --driver-only  # PoC 显式退出 novel（仅 driver/身份链路）
node --test 'tests/poc/tests/*.test.mjs'   # 9/9 确定性工厂测试（不需要 DSH 运行时）
```

**[实测]** 生产范围 12/12 通过，关键证据：

| 证据 | 值 |
|---|---|
| 模型请求落点 | `responsesRequests: 2`、`chatRequests: 0`；请求体键恰好 `['input','model','store','stream','tools']` |
| 工具声明形状 | 扁平 function tools（`myrix_probe_echo`…），无嵌套 `function` |
| 旧协议负例 | `POST /v1/chat/completions` → `404`，且 Cell 从未请求过该路径 |
| novel 服务 | `ctx.novelStore` 存在；roster `['myrix-empty','novel-outline','novel-chapter','novel-bible']`，`broken: []` |
| 根作用域 | 只有探针自己的两个测试工具，**零**小说工具 |
| 三个 preset 掩码 | 与 `PRESET_TOOLS` **逐一相等**（见 §14.1 表） |
| 跨 preset 越权 | 策略已被放宽到包含 `save_chapter_draft`，`novel-outline` 的 Agent 仍得到 `UNKNOWN_TOOL`（scope 里没有该定义） |
| 系统提示 | `promptHasWorkId: true`、`promptLeaksCredential: false` |
| 真实作品调用 | `get_outline` 经真 HTTP 打到作品服务替身，带 `sid` 与 `rev`，参数里无任何身份字段 |
| PEP 四态 | 无 agent 拒、未绑定拒、清空快照后拒、装入快照后放行且越界工具仍拒 |

**未做的验收（如实声明）**：本 PoC **不**包含真实 PostgreSQL/RLS 验收，也**不**发起真实上游模型调用；
模型网关与作品服务都是 loopback 替身（`tests/poc/lib/stubs.mjs`），上游 Responses 的真实性由 Lead 另行验证。

## 16. 本部分新增/修改的文件

| 路径 | 作用 |
|---|---|
| `bundles/myrix-base/cell.patch.yml` | **Cell 装配层模板**（可选；不在 `dsh.bundle.patch` 默认列表）。新增 `myrix-novel` 生产行与 `requirePolicy: true`；白名单 `cordis.patch.yml` 未改 |
| `tests/poc/run-cell.mjs` | 两 Cell E2E 编排器：装配、起两个真进程、签名命令、SSE、撤权、重启去重、novel 装配、Responses 负例、汇总（12 探针） |
| `tests/poc/lib/dsh-install.mjs` | 定位锁定安装；显式记录「版本号 ≠ commit」 |
| `tests/poc/lib/compile-plugins.mjs` | 把真实插件源编译成可加载的单文件 ESM（`@deepseek-ai/*` external、`@myrix/*` 库内联），并**按包**产出 `index.mjs` + 子路径模块 + `exports` |
| `tests/poc/lib/cell-profile.mjs` | **profile/config 工厂**：`createCellProfile()`（0600/0700、真实布局、无密钥落盘、路径/符号链接/删除安全、生产强制挂 novel）、`cellEnv()`（默认只继承 OS 白名单，拒绝带密钥的 base）、`SECRET_ENV`、`ROW_HANDLERS`、`setProbeRun()`、`appendExtraRows()` |
| `tests/poc/tests/factory.test.mjs` | **确定性工厂测试**（`node --test`，不需要 DSH 运行时）：novel 行与子路径导出、生产 fail-closed、不安全路径/符号链接在删除前被拒且哨兵文件完好、0600/0700、无密钥落盘、同 home 重装保留 sessions、cellEnv 隔离 |
| `tests/poc/lib/cell-client.mjs` | 控制面客户端：真 `@myrix/grant` 签发 + HTTP/SSE 调用（`post`/`collectEvents`/`admin`/`receipt`） |
| `tests/poc/lib/stubs.mjs` | 两个**外部对端**替身（模型网关、作品服务），均为真 loopback HTTP |
| `tests/poc/probes/cell-probe.mjs` | 进程内探针：组合断言 + 真实 agent turn + PEP 四态 |
| `tests/poc/probes/cell-route-seam.mjs` | 仅测试的 `agent/request` 兜底路由行（本 profile 已关闭） |
| `tests/poc/.gitignore` | 增加 `.work-cell/`（与 `.work/` 分开，避免互相删除证据） |

**未改动**：`bundles/myrix-base/package.json`、`bundles/myrix-base/cordis.patch.yml`、
`bundles/myrix-base/src/index.ts`、`plugins/**`、`packages/**`、`vendor/**`、
根 `pnpm-lock.yaml` / `pnpm-workspace.yaml` / `package.json`、`docs/implementation/` 以外的文档。

### 16.1 给 Lead 的调用方式（profile 工厂 / 启动 API）

```js
import { createCellProfile, cellEnv } from './tests/poc/lib/cell-profile.mjs'

const cell = createCellProfile({
  home: '/var/lib/myrix/cells/cell-1',        // 该 Cell 独占的 $DSH_HOME
  cellId: 'cell-1', tenantId: 't_acme',
  port: 7801,
  worksOrigin: 'http://127.0.0.1:8791',       // 生产填 8791（https 或显式回环 http）
  worksToken: worksServiceCredential,          // >=32 字符
  gatewayBaseURL: 'http://127.0.0.1:8790/v1/chat/completions',
  gatewayToken: modelGatewayCredential,
  models: ['myrix-chat'],
  grantPublicJwks: jwks,                       // 只放公钥；私钥留在 KMS
  drainToken, revokeToken,
  allowedTools: [...],                         // 见 §15.1：还需要一个快照生产者
})
cell.linkBundle()                              // 挂上 @myrix/dsh-bundle-myrix-base
spawn(process.execPath, [cell.install.cli, '--profile', cell.profileName], { env: cellEnv(cell) })
```

* **密钥不进文件**：profile 只写 `!!js process.env.MYRIX_*` 表达式；
  `cellEnv(cell)` 把 `MYRIX_GRANT_JWKS`（公钥）、`MYRIX_WORKS_TOKEN`、`MYRIX_GATEWAY_TOKEN`、
  `MYRIX_DRAIN_TOKEN`、`MYRIX_REVOKE_TOKEN` 通过环境交给子进程。
* **权限**：生成的目录 0700、文件 0600。
* **完全隔离**：`DSH_HOME` 指向自己的目录，绝不触碰 `~/.dsh`（本机存在陈旧安装，见 §1.1）。
* `cell.setProbeRun({run, out})` 供崩溃恢复场景重指探针行（不动 `$DSH_HOME`）。
* **`myrix-novel` 的装配入口已就绪**（[实测] 可用）：`createCellProfile({ extraRows })` 或
  事后 `cell.appendExtraRows(['    - id: …', "      name: '@myrix/novel'"])` 会把 YAML 行原样
  追加到 Cell 层并重写 patch。工具/预设行一经补上即可装配，**不需要改**本工厂的代码。
