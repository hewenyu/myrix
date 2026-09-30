# DSH 扩展点对接清单

上游：`vendor/deepseek-harness`（fork 自 `deepseek-ai/deepseek-harness`），锁定提交见 `.gitmodules` 与 README。
原始证据（逐条 `路径:行号`）见 [../research/dsh-seams-raw.md](../research/dsh-seams-raw.md)。本文只写**我们怎么用**。

## 1. 我们用到的扩展点

| # | 扩展点 | 用途 | 本项目落点 | 依据（上游） |
| --- | --- | --- | --- | --- |
| 1 | `tools/pre-execute` waterfall | 工具调用前判定 allow/deny/ask/cancel | `plugins/dsh-plugin-governance/src/plugin.ts` | `packages/core/tools/src/index.ts:142-153` |
| 2 | `ctx.tools.guard()` | 单调兜底拒绝（只能收紧） | 同上 | 同文件 `1126-1142` |
| 3 | `ctx.tools.restrict()` | 按授权做工具掩码（功能裁剪热路径） | `plugins/dsh-plugin-entitlement/src/plugin.ts` | 同文件 `1097` |
| 4 | `ctx.permissionPresets.set()` | 把 sandbox 义务落到 session | `plugins/dsh-plugin-governance` | `docs/subsystems/permission-presets.md:73`；默认 preset `packages/bundle/base/cordis.patch.yml:250-262` |
| 5 | `sandbox-policy.mode` / `workspaceRoot` | 冷路径默认档位（profile 渲染） | `packages/registry/src/dsh-profile.ts` | `packages/sandbox/sandbox-policy/src/index.ts:71-79` |
| 6 | `approval.policy = ask\|never` + `approval/request` | 人工/企业审批 | profile 行 + 后续替换 answerer | `packages/interaction/user-approval/src/index.ts:135-153`、`docs/subsystems/approval.md:152-164` |
| 7 | profile / bundle / `cordis.patch.yml` | 功能裁剪的冷路径（关行 / 只加载需要的 bundle） | `packages/registry/src/dsh-profile.ts`、`deploy/dsh/profiles/enterprise/` | `packages/boot/app-boot/src/profile.ts:37-71`、`packages/util/package-manifest/src/types.ts:30-94` |
| 8 | `dsh plugin`（转发 pnpm） | 安装/管理 out-of-tree 插件 | `deploy/` 与运维文档 | `packages/boot/plugin-manager/README.md:14,77-81`、`apps/cli/src/args.ts:187-198` |
| 9 | `@deepseek-ai/dsh-mcp-client` | 知识库 MCP 路线（路线 B） | `plugins/dsh-plugin-knowledge/cordis.patch.yml`（注释示例） | `packages/mcp/mcp-client/README.md:34-67`、`75` |
| 10 | `ctx.connection.operator: PeerScope` | 未来承载企业身份（多用户共进程） | 待 M1（ADR-0002 B1/B2） | `packages/typert/protocol/src/types.ts:377-390,406` |
| 11 | `cordis:group` + `isolate.webServer` | 可选：企业入站/后台独立 WebServer | 备选形态（ADR-0005） | `apps/cli/config/examples/github-review/cordis.yml:17-34` |

## 2. 刻意不用的扩展点（及原因）

| 扩展点 | 为什么不用 |
| --- | --- |
| `packages/catalog/.../connection/request` waterfall | 事件签名不含 peer，无法重绑身份；最多用于二级审计 |
| `packages/hooks`（Claude/Codex shell hooks） | 外部进程桥：`updatedInput` 不生效、`continue:false` 无 run 级阻断；不适合做安全边界 |
| SDK JSON-RPC（`packages/sdk/server`） | 仅 3 个方法、无 HTTP、无鉴权，面向进程外自动化而非多方后台 |
| 直接 patch `vendor/deepseek-harness` 源码 | 违反仓库约定；上游升级成本不可控 |

## 3. 最小可用 profile（与 seed 数据一致）

```yaml
# $DSH_HOME/profiles/enterprise/cordis.patch.yml（由 pnpm render:profile 生成同类产物）
- id: computer-use
  disabled: true
- insert:
    - id: myrix-governance
      name: "@myrix/dsh-plugin-governance"
      config:
        controlPlaneUrl: http://127.0.0.1:8787
        token: !!js process.env.MYRIX_AGENT_TOKEN
        principalId: !!js process.env.MYRIX_PRINCIPAL_ID
        failClosed: true
- id: sandbox-policy
  config:
    mode: workspace-write
```

profile 的 `package.json` 用 `dsh.profile.bundles` 声明堆叠的 bundle；bundle 包用 `dsh.bundle.patch` 指向自己的
`cordis.patch.yml`（`packages/util/package-manifest/src/types.ts:30-94`）。

## 4. 类型对接的临时措施

`plugins/*` 目前不依赖已发布的 DSH 包（包名/版本仍在演进），而是引用 `packages/dsh-shim` 中的**结构类型子集**。
M1 必须做两件事：

1. 在 CI 中从 `vendor/deepseek-harness` 构建并解析真实 `@deepseek-ai/dsh-*` 类型；
2. 逐个核对并替换 shim：`tools/pre-execute` 的入参与返回、`ctx.tools.guard/restrict` 签名、
   `ctx.tools.register`（**目前 DSH 未见公开的工具注册 API 形态**，见第 5 节风险）、`ctx.permissionPresets.set`。

## 5. 风险与待验证项

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| `ctx.tools` 的工具注册 API 未确认 | 知识库平台工具无法注册 | 先用 MCP 路线；M1 在源码中确认注册入口（`packages/core/tools` + MCP/工具包实现） |
| `PeerScope` 无公开替换接口 | 多用户共进程身份注入受阻 | 采用 BFF 方案（ADR-0002 B2），B1 作为后续优化 |
| `dsh web --host 0.0.0.0` 支持边界不清 | 内网集中部署形态受限 | 实测 CLI 与 webserver 行为后决定是否需要 BFF 前置 |
| MCP 凭据静态 | per-user 知识库检索无法走纯 MCP | 知识库场景走路线 A（平台工具带身份） |
| `permissionPresets` 只自带两个 preset | `read-only` 义务可能无 preset 可用 | 部署方在 `permission-presets.presets` 中补充；`presetMapping` 可配置 |
| `ctx.sessions` 无租户命名空间 | 共进程形态的会话隔离需自行实现 | 与 ADR-0002 的形态决策一起解决 |

## 6. 升级流程

```bash
# 1) 拉取上游新提交并检查差异
pnpm submodule:sync
git -C vendor/deepseek-harness log --oneline <old>..<new>

# 2) 重点核查上述 11 个扩展点是否有签名变化（尤其 tools/pre-execute、guard、restrict、permissionPresets）

# 3) 全量回归
pnpm typecheck && pnpm test
```
