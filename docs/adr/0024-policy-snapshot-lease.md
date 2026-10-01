# ADR-0024：策略快照由同一份凭证认证绑定快照投递（R16）

- 状态：已实现并接通生产装配（Cell 插件、BFF 策略端点、非 owner PG 集成测试、生产 profile 的 `requirePolicy: true`）。完整开发栈与真实模型工具回合的验收状态以验收记录为准，不由单元测试推定。
- 相关：[ADR-0017](./0017-novel-tools-boundary.md)、[ADR-0019](./0019-cell-binding-leases.md)、[ADR-0020](./0020-production-assembly.md)、[ADR-0021](./0021-bff-startup.md)。

## 背景

`myrix-policy-enforcer` 是同步、fail-closed 的工具执行点：身份缺失、静态 allowlist 缺失、策略快照缺失、快照过期、租户不一致、工具不在快照集合内 —— 六条路径全部拒绝。它**不产生**策略，只读取一个进程内持有者。

问题（记录为 R16）：不存在任何策略快照生产者。`myrix-base`、`myrix-runtime-driver`、`myrix-binding-lease` 都不安装快照，于是**身份完全合法的 Cell 也调不动任何工具**。这是 fail-closed 的正确表现，但功能不可用。

同时已有一条**可用且已被验证**的权威投递通道：`GET /internal/v1/cells/:cellId/bindings`。它用显式 Cell 凭据认证、在非 owner 的事务内租户 RLS 上读取创建/active 绑定、active 租户、active 成员、未删除且同 owner 的作品，只回 `cellId`、`tenantId` 与 `{sid,tid,sub,wid,preset,rev}` 六字段，不含正文与凭据（ADR-0019），并由 `myrix-binding-lease` 变成有限时长、失败即清空的同步活性租约。

因此本 ADR 只做一个**外科式**决策：让策略走**同一份**快照，而不是新建第二套授权子系统、第二个端点或第二份凭据。

## 决策

1. **策略随绑定快照下发。** 绑定响应新增**可选**顶层字段 `policy: { rev, tools, ttlMs }`。老服务端不返回它，老客户端忽略它；六个绑定字段逐字不变。省略该字段是显式的：它表示"本 Cell 没有配置策略"，Cell 侧因此没有快照并继续拒绝一切工具，而不是获得任何默认权限。

2. **策略版本由部署控制，与绑定修订无关。** `policy.rev` 与 `session_bindings.revoked_revision` 是两条独立的单调轴：一次会话撤权不是一次策略发布，反之亦然。有测试锁死"绑定 rev 前进而 policy.rev 不变"。

3. **服务端只做交集收窄。** BFF 的策略校验只保留**六个已知小说工具**；未知工具名在构造快照读取器时**抛错**（启动即失败），而不是被静默丢弃 —— 静默收窄会表现为"某个工具莫名被拒"，比启动失败难查。显式空数组 `tools: []` 是合法值，表示"什么都不允许"，原样下发。`ttlMs` 必须落在 `(0, 30000]`。

4. **`myrix-binding-lease` 是唯一生产者，且能力必须显式开启。** 新配置 `requirePolicy`（默认 `false`）：
   - `false`：行为与今天完全一致 —— 绑定租约照常生效，策略执行点仍无快照、仍拒绝一切工具。升级插件不会悄悄带来工具执行能力。
   - `true`：公开 `apply` 用 `ctx.inject(['myrixPolicySnapshots'], ...)` 创建真正的依赖子 fiber；生产者未出现时**不安装租约**（身份检查拒绝），出现后才激活，消失时卸载并清除活性，替换后重新激活。Loader 并发加载行，不能用行顺序代替依赖；低层 `applyWithIo` 仍同步拒绝缺服务。快照缺/非法 `policy` 时**整次刷新**返回 `installed:false`，不留下一个看起来正常的绑定租约。

5. **绑定与策略必须一起成功或一起失败。** 安装顺序是"先校验并安装策略，再原子替换绑定缓存"；任何一条失败路径（HTTP/重定向/过大/非法 JSON/跨 cell/跨租户/重复 sid/策略缺失/策略非法/策略回退/超时/失效/卸载）都调用同一处 `fail()`，它**同时**清空绑定缓存与策略。留下其中一个都会造成"活性为真但策略是上一版"或"策略为真但活性已失效"的半授权状态。

6. **策略有独立的单调版本高水位，`clear()` 不重置它。** 否则"先失败清空、再灌一份旧快照"就能把已撤销的授权装回来。回退（含清空之后的重放）→ 清空 + 拒绝 + 保留高水位。

7. **到期用两个时限取先到者，且由持有者自己计算。** 生产者只能回答"还剩多久"（`remainingMs`），不能回答"到期是什么时刻"：绑定租约的时钟是 `performance.now()` 单调时基，与 Unix 毫秒根本不在同一个数轴上（早期实现把单调时刻当墙钟传，导致策略装好即"过期"，被组合测试抓出）。持有者用自己的墙钟与单调时钟各算一个截止时刻，两者都参与 `current()`；因此系统时间回拨或 NTP 回拨都不能延长授权。剩余时长取"服务端 `ttlMs`、本地租约剩余、硬上限 30 秒"的最小值再减去请求已耗时。

8. **在途请求不能恢复已撤销的授权。** 缓存带一个世代号，`invalidate()`/`dispose()`/任何失败都递增它并 abort 在途请求；刷新在安装前比对**发起时**的世代，不一致就不安装。于是"请求发出后才撤权，响应随后到达"不会把策略装回来。

9. **服务面是真实 Cordis 服务，不是模块单例。** 执行点 `ctx.provide('myrixPolicySnapshots', holder)`；租约用 `ctx.get` 结构类型查它。插件可能被 esbuild 各自打成独立 bundle，模块级 WeakMap 会变成两份状态、表现为"租约装了、执行点看不到"的静默全拒。`policySnapshotHolderOf(ctx)` 保留为兼容退路，但优先走服务查找。

10. **不引入任何宽松默认值。** 没有"本地默认策略"、没有静态无限策略、没有角色绕过、没有用户级旁路；`tools.guard` 仍然同步、不做 I/O；preset 掩码与作品执行器的 preset 白名单**不因策略存在而放宽** —— 策略只能收窄，两个集合（静态 allowlist ∩ 策略 ∩ preset）都必须包含该工具。

## 代价与替代方案

- **代价**：策略与绑定共享同一条刷新路径，因此一次策略问题会让整次刷新失败（`installed:false`）。这是刻意的：`driver.refreshIdentity()` 已经只在 `installed === true` 时继续，失败会在会话首次工具调用**之前**暴露。
- **代价**：策略版本由部署控制，意味着"发布一次策略"需要重启/重配 Cell（或推送新的策略版本后等待下一次刷新）。当前版本没有独立的热更新通道。
- **不采用**"driver 直接拉控制面策略下发"：driver 刻意不持有权威绑定数据，且它的 `inject` 里没有策略执行点；新增一条并行的凭据/端点会把授权面从 1 个扩到 2 个。
- **不采用**"策略执行点回退到静态 allowlist 当没有快照"：那正是 R16 要避免的"静默放行"。
- **不采用**"策略过期后沿用上一版"：与 ADR-0019 的有限时长承诺冲突。

## 验证与边界

- [执行点与租约的真实 Cordis 组合](../../plugins/myrix-policy-enforcer/tests/composition.test.ts)：真实 `ToolRuntime` + 真实 `PrincipalRegistry` + 两个插件各加载在**独立 fiber**；断言两个子上下文解析到**同一个**服务实例、租约安装后白名单内工具放行、失败后同一工具被拒、策略只收窄到服务端子集、卸载后服务与策略一起消失。
- [策略桥](../../plugins/myrix-binding-lease/tests/policy-bridge.test.ts)：安装与清空的原子性、`requirePolicy` 缺服务时加载失败、缺策略字段、非法策略、版本回退（含清空后重放）、TTL 裁剪、墙钟回拨、`invalidate()`/`dispose()`、在途请求与撤销的竞态、不泄漏 token。
- [快照解析](../../plugins/myrix-binding-lease/tests/snapshot.test.ts)：`policy` 字段白名单、六个工具名白名单、空数组语义、顶层未知字段、六个绑定字段逐字不变。
- [策略持有者](../../plugins/myrix-policy-enforcer/tests/enforcer.test.ts)：`installOrClear` 的内容校验、30 秒硬截断、高水位、双时限、服务装配与卸载。
- [真实 PG 集成](../../apps/bff/tests/policy-snapshot.integration.test.ts)：真实非 owner LOGIN 上验证"省略第三参数 ⇒ 无 policy 字段"、"六字段逐字不变"、"只回六个已知工具"、"空数组合法"、"只认证匹配 Cell 且不含跨租户/跨 cell 行"、真实响应 → 真实 Cell 解析 → 真实持有者安装、绑定 rev 前进不影响 policy rev、作品删除使快照收缩而策略不变、preset 白名单仍不被策略放宽。

- [公开入口依赖生命周期](../../plugins/myrix-binding-lease/tests/activation-order.test.ts)：真实 Cordis 验证生产者延迟出现、并发激活、生产者卸载/重挂，以及显式 lease-only PoC 无此依赖；不再假定 profile 行顺序。
- [生产策略部署决策](./0025-novel-deployment-policy.md)：生产 BFF 显式下发六工具、策略 rev 1、TTL 10 秒；生产 profile 强制 `requirePolicy: true`。这不是角色或作品授权的替代品。

**不由本 ADR 推定通过**：真实上游模型工具回合、凭据轮换、K8s 装配；双 Cell 与真实开发栈的最终运行证据见 [v0.1 验收记录](../implementation/v0.1-acceptance.md)。
