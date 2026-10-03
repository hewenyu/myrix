# 与 DSH 的集成入口

Myrix 不 fork DSH 核心：上游以**只读 submodule** 引入并锁定提交，
所有定制都以 Cordis 插件 / bundle / `cordis.patch.yml` 的形式表达
（[AGENTS.md](../../AGENTS.md) 的仓库约定）。本文只写**当前入口与边界**；
决策理由见对应 ADR，历史原始调研已本地归档（见
[文档维护、归档与脱密](../documentation-policy.md)）。

## 1. 只读 vendor 边界

| 项 | 当前做法 |
| --- | --- |
| 上游源码 | [`vendor/deepseek-harness`](../../vendor/deepseek-harness/) 是只读 submodule，锁定提交见 `.gitmodules` 与根 [README](../../README.md) |
| 运行本体 | 独立锁定的 npm `@deepseek-ai/dsh@0.2.0-rc.2`（见[运行时依赖](../development/runtime-dependencies.md)）；同版本号不证明 npm 产物与锁定提交逐字节一致 |
| 定制方式 | Cordis 插件（`plugins/myrix-*`）、bundle（`bundles/myrix-base/`）、profile 渲染（[packages/registry/src/dsh-profile.ts](../../packages/registry/src/dsh-profile.ts)） |
| 禁止 | **不直接 patch `vendor/deepseek-harness` 源码，也不从修改过的 vendor 树构建/部署**。上游确需改动时，先在上游 fork 提交补丁、推进 submodule 指针，并在 PR 说明里链接上游提交 |

`vendor/**` 只用于**阅读实现、核对真实 API 与负例**。任何"改 vendor 就好"的方案都不被推荐，
因为它让上游升级成本不可控，且与仓库边界门禁冲突。

## 2. 当前集成入口（`myrix-*`）

Cell 的运行时装配是**逐行显式**的，没有 `dsh-base`、shell、fs、web、jobs 等通用能力：

| 行 | 插件 | 提供 / 作用 | 消费的 DSH seam |
| --- | --- | --- | --- |
| `myrix-principals` | [`@myrix/principals`](../../plugins/myrix-principals/src/index.ts) | `ctx.principals`：Agent → 主体的可信绑定表 + 同步活性判定 | agent 生命周期、`ToolRunContext.agent` |
| `myrix-policy-enforcer` | [`@myrix/policy-enforcer`](../../plugins/myrix-policy-enforcer/src/index.ts) | fail-closed 同步工具守卫（`allowedTools: []` 表示什么都不允许），持有策略快照服务 | `ctx.tools.guard()`、`tools/pre-execute` waterfall、`ctx.effect` 生命周期 |
| `myrix-binding-lease` | [`@myrix/binding-lease`](../../plugins/myrix-binding-lease/src/index.ts) | `ctx.bindingLease`：主体活性租约 + 六工具策略快照的**唯一生产者** | `agent/created`（`ctx.serial`）、`ctx.effect` 生命周期 |
| `myrix-runtime-driver` | [`@myrix/runtime-driver`](../../plugins/myrix-runtime-driver/src/index.ts) | `POST /v1/commands`、SSE、撤权、drain/idle、`GET /v1/ready` | `ctx.webServer.register()`、`ctx.agents.create()/resume()`、`ctx.sessions`、`ctx.agentPresets.mount()`、`ctx.sessionPersistence` |
| `myrix-llm-gateway` | [`@myrix/llm-gateway`](../../plugins/myrix-llm-gateway/src/index.ts) | 模型路由：每次调用都经企业网关并携带会话归因 | `ctx.llm.registerAdapter()`、`ctx.principals.require()` |
| `myrix-novel` | [`@myrix/novel`](../../plugins/myrix-novel/src/index.ts) | 小说纵向能力：`ctx.novelStore` 与三个 preset（工具只在该 preset 作用域内注册） | `ctx.tools.register()`、`ctx.systemPrompt.section()`、`ctx.agentPresets.register()` |

周边入口：

- 核心白名单 bundle：[bundles/myrix-base/cordis.patch.yml](../../bundles/myrix-base/cordis.patch.yml)；
  Cell 第二层 patch：[bundles/myrix-base/cell.patch.yml](../../bundles/myrix-base/cell.patch.yml)，
  由 [tests/poc/lib/cell-profile.mjs](../../tests/poc/lib/cell-profile.mjs) 的 `createCellProfile` 装配。
- 企业模型边界：[apps/model-gateway](../../apps/model-gateway/src/server.ts)（Responses 网关，
  [ADR-0023](../adr/0023-responses-gateway.md)）；Cell 侧适配器见
  [myrix-llm-gateway](../../plugins/myrix-llm-gateway/src/index.ts)。
- BFF 向 Cell 提供的绑定快照端点：`GET /internal/v1/cells/:cellId/bindings`
  （[apps/bff/src/works-server.ts](../../apps/bff/src/works-server.ts)），由
  [myrix-binding-lease](../../plugins/myrix-binding-lease/src/index.ts) 消费。
- 会话 preset 路径：BFF 在 `POST /works/:workId/sessions` 选定 `novel-*` preset，写进绑定与凭证，
  驱动在 `setup` 内 `mountPreset`；`agentPresets` 的 `default` 仍是 `myrix-empty`，
  没有会话绑定的一段预设拿不到小说工具。

## 3. 我们依赖的具体 seam

| seam | 用途 | 上游位置（锁定提交，只读参照） |
| --- | --- | --- |
| `tools/pre-execute` waterfall | 工具调用前的判定与拒绝（配合同步 guard） | `packages/core/tools/src/index.ts` |
| `ctx.tools.guard()` | 单调兜底拒绝（只能收紧） | `packages/core/tools/src/index.ts` |
| `ctx.tools.register()` / `ctx.tools.schemas(agent)` | 工具注册与按作用域可见性 | 同文件 |
| `ctx.systemPrompt.section()` | 提示段落（工作区/作品约束） | `packages/core/system-prompt/` |
| `ctx.agentPresets.register()` / `mount()` / `composedPreset()` | 三个助手 preset 的注册与挂载 | `packages/preset/agent-preset-registry/` |
| `agent/created`（serial 事件） | 创建竞态时刷新绑定租约 | `packages/core/agent/src/runtime-types.ts` |
| `ctx.webServer.register()` | Cell HTTP 载体（`dsh-host-webserver`，不是 `dsh-web-app`） | `packages/host/webserver/` |
| `ctx.llm.registerAdapter()` | 模型适配器接入，经企业网关转发 | `packages/llm/` |
| bundle / profile / `cordis.patch.yml` | 功能裁剪的冷路径（关行 / 只加载需要的 bundle） | `packages/boot/app-boot/src/profile.ts`、`packages/util/package-manifest/src/types.ts` |

行号会随上游提交漂移：升级锁定时以源码为准重新核对，不引用已归档调研里的行号。

## 4. 刻意不用的 seam（及原因）

| seam | 为什么不用 |
| --- | --- |
| `packages/catalog/.../connection/request` waterfall | 事件签名不含 peer，无法重绑身份；最多用于二级审计 |
| `packages/hooks`（Claude/Codex shell hooks） | 外部进程桥：`updatedInput` 不生效、`continue:false` 无 run 级阻断；不适合做安全边界 |
| SDK JSON-RPC（`packages/sdk/server`） | 方法少、无 HTTP、无鉴权，面向进程外自动化而非多方后台 |
| 直接 patch `vendor/deepseek-harness` 源码 | 违反仓库约定；上游升级成本不可控（见 §1） |

## 5. Legacy（保留参考，不推荐使用）

以下代码与类型是**历史演示/迁移参考**，不参与当前 `myrix-base` Cell 装配，也不构成安全边界：

| Legacy 物 | 说明 |
| --- | --- |
| [`plugins/dsh-plugin-governance`](../../plugins/dsh-plugin-governance/src/plugin.ts)、[`dsh-plugin-entitlement`](../../plugins/dsh-plugin-entitlement/src/plugin.ts)、[`dsh-plugin-knowledge`](../../plugins/dsh-plugin-knowledge/src/plugin.ts) | 早期基于 shim 结构类型的治理/授权/知识插件；当前等价能力由 `myrix-policy-enforcer` / `myrix-principals` / platform-store + BFF 承担 |
| [`packages/dsh-shim`](../../packages/dsh-shim/src/index.ts) | 与真实 DSH API 不一致的占位类型；当前插件直接依赖真实 `@deepseek-ai/*` 包，见[legacy-dsh-shim.md](legacy-dsh-shim.md) |
| 旧 PolicyClient 的 `failClosed: false` 等放行路径 | 已按 [ADR-0018](../adr/0018-legacy-fail-open-retirement.md) 退役：失败固定为 deny，新 Cell 不装载旧治理插件 |

不要基于这些路径新增功能或把它们当作当前契约；改它们也不会改变生产行为。
退役决策见 [ADR-0016](../adr/0016-runtime-driver.md)、[ADR-0018](../adr/0018-legacy-fail-open-retirement.md)
与[模块评审](../reviews/module-boundaries-2026-10.md)。

## 6. 升级流程

```bash
# 1) 拉取上游新提交并检查差异（不改 vendor 内容）
pnpm submodule:sync
git -C vendor/deepseek-harness log --oneline <old>..<new>

# 2) 重点核查上表 seam 的签名变化（尤其 tools.guard/register、agentPresets、agent/created、webServer、llm.registerAdapter）

# 3) 全量回归
pnpm lint && pnpm typecheck && pnpm test
pnpm test:ci
```

真实浏览器/模型闭环按[验证方法](../testing/acceptance.md)显式 opt-in，不并入默认门禁。
