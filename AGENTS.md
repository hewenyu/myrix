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
6. **本项目禁止 `chat/completions` 协议**：Cell、模型网关、上游调用、开发装配和验收不得使用该协议，不得保留兼容入口、隐式转换或失败回退。模型链路使用 OpenAI Responses（或显式实现并验证的 Messages）；必须有拒绝旧协议的回归测试。只读 vendor 中的上游实现与负例测试不属于启用该协议。

## 许可

- 本仓库采用 **Apache License 2.0**（见 `LICENSE`），新增文件默认遵循同一许可。
- 分发衍生作品时必须保留 `LICENSE` 与 `NOTICE`，并对修改过的文件作出声明。
- 上游 DSH 为 MIT（`vendor/deepseek-harness/LICENSE`），版权与许可声明必须原样保留，不得删除或改写。
- Apache-2.0 不授予商标权：不要在文档或界面上使用上游/企业商标暗示官方背书。

## 常用命令

```bash
pnpm bootstrap         # 子模块 + 依赖 + 类型检查 + 测试
pnpm setup:dev         # 显式初始化专用本地 PostgreSQL（需要迁移连接）
pnpm build:web         # 构建小说工作台
pnpm dev               # 启动持久化 BFF/works、模型网关与两个隔离 Cell
pnpm dev:legacy        # 历史治理演示（不要与 dev 同时运行）
pnpm test:browser      # 验收已启动的真实本地工作台
pnpm demo:decide       # 判定演示
pnpm render:profile u_1001 --out <dir>
pnpm typecheck
pnpm test
```
