# ADR-0001：分层治理——企业授权与 DSH 权限解耦

- 状态：已接受（M0）
- 日期：2026-09-30
- 相关：ADR-0002（身份与插件授权）、[integration/dsh-seams.md](../integration/dsh-seams.md)

## 背景

DSH 原生提供三级沙箱权限（`read-only` / `workspace-write` / `danger-full-access`）与审批机制
（`approval.policy = ask | never`、`permissionPresets`、工具级 ask）。这些是**执行机制**：

- `packages/sandbox/sandbox-policy/src/index.ts:71-79`（`mode` 默认 read-only、`workspaceRoot`）
- `packages/bundle/base/cordis.patch.yml:226-248`（profile 行与 `DSH_PERMISSION_MODE` 表达式）
- `docs/subsystems/approval.md:33,152-164`（审批语义与 answerer 注册点）

企业需要的却是另一件事：**"谁、在什么条件下、能用哪些能力、以什么方式用"**，并且要与组织架构、工单审批、
数据分级、合规审计挂钩。把它塞进沙箱模式是维度错配。

## 决策

采用**分层治理**：

1. **控制面是唯一授权来源（PDP）**。判定 = RBAC（角色权限点，决定"能不能用某类能力"）+ ABAC
   （条件与义务，决定"在什么条件下、以什么方式用"），算法为 deny-overrides + fail-closed。
2. **DSH 侧只做 PEP**。挂载 `@myrix/dsh-plugin-governance`：
   - `tools/pre-execute` waterfall 返回 `allow | deny | ask`（`packages/core/tools/src/index.ts:142-153`）
   - `ctx.tools.guard()` 作为**单调兜底**（同文件 `1126-1142`，只能 deny，不能被后续 listener 反转）
   - allow 时把 `sandbox` 义务落到 session 的 permission preset（`docs/subsystems/permission-presets.md:73`）
3. **义务翻译表**（治理结论 → DSH 原生旋钮）：

   | 义务 | DSH 侧落地 |
   | --- | --- |
   | `sandbox: read-only / workspace-write / danger-full-access` | `permissionPresets.set` 或 profile 的 `sandbox-policy.mode` |
   | `approval: required` | `tools/pre-execute` 返回 `ask`；企业审批可替换 `approval/request` answerer |
   | `rateLimit` / `modelScope` | 透传给 LLM 网关（见 ADR-0004） |
   | `knowledgeScope` | 知识库联邦的检索范围收窄（见 ADR-0003） |
   | `audit: full/metadata` | 治理审计级别 + 网关审计级别 |

4. **不改上游**：不 fork 判定逻辑、不在 DSH 内建 RBAC。

## 理由

- 判定逻辑集中在控制面，策略热更新不需要重启 DSH；DSH 升级不用重写授权代码。
- `guard` 的单调性给了"即使别的插件接线出错也不能放行"的结构性保证。
- 义务模型让"允许但受限"成为一等公民：allow 不等于无约束。

## 备选方案与为什么拒绝

| 方案 | 拒绝理由 |
| --- | --- |
| Fork DSH，在 `packages/core/tools` 里加 RBAC | 与上游强耦合，每次升级都是大手术；且把企业逻辑塞进通用运行时 |
| 只用 DSH 的 `permissionPresets` 表达权限 | 表达力不足：无用户/组织/条件维度，无法审计"为什么" |
| 用 `connection/request` waterfall 做鉴权 | 该事件签名里没有 peer，无法重绑身份（`packages/client/connection/src/index.ts:67`） |
| 用 Claude/Codex shell hooks 做拦截 | `packages/hooks/hook-protocol/README.md:127-129`：`updatedInput` 不生效、无 run 级阻断，且是外部进程桥 |

## 后果

- 正面：治理可解释、可审计、可热更新；上游升级风险低。
- 负面：**判定调用在关键路径上**，必须 fail-closed 并做短 TTL 缓存（默认 15s），否则控制面抖动会放大为可用性事故。
- 负面：需要额外维护"义务 → DSH 配置"的映射表，DSH 配置项改名时要同步（用单测+对接清单兜住）。
- 待验证：`ctx.tools` 的真实注册与 guard 签名、`permissionPresets` 是否支持 `read-only` preset
  （DSH base 只自带 workspace-write / danger-full-access 两个，见 `packages/bundle/base/cordis.patch.yml:250-262`）。

## 验收标准（M1）

1. 在 `vendor/deepseek-harness` 上跑通：deny 的工具无法执行（含 MCP 工具与 PTC 子调用）。
2. allow + sandbox 义务时，session 的实际沙箱档位与控制面下发的模式一致。
3. 控制面停机时，所有受管工具调用被拒绝，且 DSH 侧给出可读原因。
