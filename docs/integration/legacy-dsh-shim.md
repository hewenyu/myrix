# `@myrix/dsh-shim`（legacy 参考）

> **状态：legacy。** 当前 Cell 装配不使用这些类型，也不建在其上；
> 现行入口见[与 DSH 的集成入口](dsh-seams.md)与 [cell.patch.yml](../../bundles/myrix-base/cell.patch.yml)。
> 本文件只保留历史对照，供阅读旧 `plugins/dsh-plugin-*` 时理解当时的结构假设。

[`packages/dsh-shim`](../../packages/dsh-shim/src/index.ts) 是早期为 `plugins/dsh-plugin-governance`
/ `dsh-plugin-entitlement` / `dsh-plugin-knowledge` 准备的 **DSH Cordis 扩展点最小结构子集**，
让它们在未安装 DSH 包时也能独立类型检查与单测。

它与真实 DSH API 并不一致（因此 [ADR-0016](../adr/0016-runtime-driver.md) 拒绝用它充当契约）。
当前 `myrix-*` 插件直接依赖真实 `@deepseek-ai/*` 包，真实 API 以
[只读 vendor](../../vendor/deepseek-harness/) 的锁定提交为准；**不要**基于本 shim 或旧的
`dsh-plugin-*` 路径新增功能，也不要为了替换它去改 vendor 源码或从修改后的 vendor 构建。

历史对照表（旧 shim 覆盖的成员，仅作阅读线索，行号会随上游漂移）：

| 成员 | 用途 |
| --- | --- |
| `tools/pre-execute` waterfall | allow / deny / ask / cancel 决策 |
| `ctx.tools.guard()` | 单调兜底拒绝（只能收紧） |
| `ctx.tools.restrict()` | 工具可见性掩码（功能裁剪） |
| `ctx.permissionPresets.set()` | 把义务里的沙箱模式落到 session |

退役与降级路径的决策见 [ADR-0018](../adr/0018-legacy-fail-open-retirement.md)。
