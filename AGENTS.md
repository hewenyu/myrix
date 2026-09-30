# 仓库约定（贡献者与 AI Agent 都适用）

## 定位

Myrix 是"基于 DSH 的企业治理面"。**不要修改 `vendor/deepseek-harness` 里的代码**：
上游通过 submodule 引入，任何 DSH 侧的定制都必须以 Cordis 插件 / bundle / `cordis.patch.yml` 的形式表达。
确需改上游时，先在上游 fork 提交补丁并推进 submodule 指针，同时在 PR 说明里链接上游提交。

## 目录职责

- `packages/contracts`：只放共享类型/契约，不放实现。
- `packages/governance`：纯函数 PDP，禁止 I/O（网络、数据库、时钟都由调用方注入）。
- `packages/registry`：插件目录与授权计算、profile 产物渲染（同样保持纯函数、可单测）。
- `packages/knowledge`：联邦与连接器契约；不实现检索算法本身。
- `packages/control-plane`：HTTP 边界 + 存储边界；所有判定走 governance，不内联策略逻辑。
- `plugins/*`：DSH 侧 PEP，只做"取判定结果 → 翻译成 DSH 配置"，不保存策略。
- `apps/console`：管理后台，只调用控制面 API，不直连 DSH。

## 硬性规则

1. 任何"放行"路径都必须是显式的；默认值一律 fail-closed（网络失败、策略缺失、角色缺失都按拒绝处理）。
2. 合并类操作只能收窄：沙箱取最严、范围取交集、掩码 deny 优先。
3. 新增判定/授权行为必须同时给出：实现、单测、以及"为什么开/关"的可读原因字符串。
4. 涉及身份、授权、审计的改动，必须同步更新 `docs/adr/` 或在 PR 中说明为何不更新。
5. 类型检查与测试是准入条件：`pnpm typecheck && pnpm test`。

## 常用命令

```bash
pnpm bootstrap         # 子模块 + 依赖 + 类型检查 + 测试
pnpm dev               # 启动控制面与管理后台
pnpm demo:decide       # 判定演示
pnpm render:profile u_1001 --out <dir>
pnpm typecheck
pnpm test
```
