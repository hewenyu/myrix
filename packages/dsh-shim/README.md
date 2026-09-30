# @myrix/dsh-shim

DSH Cordis 扩展点的`最小结构子集`，供本仓库的 `plugins/*` 在没有安装 DSH 包的情况下也能独立类型检查与单测。

**这是临时占位**：接入 `vendor/deepseek-harness` 构建后，应改为直接引用 `@deepseek-ai/dsh-*` 的真实类型，
并在此过程中核对下列 API 的精确签名（我们只覆盖实际用到的成员）：

| 成员 | DSH 位置 | 用途 |
| --- | --- | --- |
| `tools/pre-execute` waterfall | `packages/core/tools/src/index.ts:142-153` | allow / deny / ask / cancel 决策 |
| `ctx.tools.guard()` | 同文件 `1126-1142` | 单调兜底拒绝（只能收紧） |
| `ctx.tools.restrict()` | 同文件 `1097` | 工具可见性掩码（功能裁剪） |
| `ctx.permissionPresets.set()` | `docs/subsystems/permission-presets.md:73` | 把义务里的沙箱模式落到 session |
