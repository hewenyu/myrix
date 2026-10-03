# 仓库约定（贡献者与 AI Agent 都适用）

## 定位

Myrix 是基于 DSH 的受治理 Agent 应用平台，当前交付为 **v0.1 持久化小说创作工作台**；企业治理 console 是历史链路，不是当前主入口。**不要修改 `vendor/deepseek-harness` 里的代码**：
上游通过 submodule 引入，任何 DSH 侧的定制都必须以 Cordis 插件 / bundle / `cordis.patch.yml` 的形式表达。
确需改上游时，先在上游 fork 提交补丁并推进 submodule 指针，同时在 PR 说明里链接上游提交。

## 目录职责

- `packages/contracts`：只放共享类型/契约，不放实现。
- `packages/governance`：纯函数 PDP，禁止 I/O（网络、数据库、时钟都由调用方注入）。
- `packages/registry`：插件目录与授权计算、profile 产物渲染（同样保持纯函数、可单测）。
- `packages/knowledge`：联邦与连接器契约；不实现检索算法本身。
- `apps/novel-web`：当前工作台 UI，只访问同源 BFF，不直连 DSH 或数据库。
- `apps/bff`：当前认证、作品/会话路由与 runtime 装配；不要仅因名字误将 `apps/works-service` 当作现网入口。
- `packages/platform-store`：PostgreSQL 事务、FORCE RLS、CAS、命令队列与审计；应用使用低权 LOGIN。
- `apps/model-gateway`：Responses 转发、额度预占与真实用量结算。
- `plugins/*` / `bundles/myrix-base`：DSH 侧执行、六个小说工具与白名单装配；不保存治理策略。
- `packages/control-plane` / `apps/console` / `packages/dsh-shim`：历史治理演示；仍保持 HTTP/存储/纯判定边界，不内联策略。

## 硬性规则

1. 任何"放行"路径都必须是显式的；默认值一律 fail-closed（网络失败、策略缺失、角色缺失都按拒绝处理）。
2. 合并类操作只能收窄：沙箱取最严、范围取交集、掩码 deny 优先。
3. 新增判定/授权行为必须同时给出：实现、单测、以及"为什么开/关"的可读原因字符串。
4. 涉及身份、授权、审计的改动，必须同步更新 `docs/adr/` 或在 PR 中说明为何不更新。
5. 类型检查与测试是准入条件：`pnpm typecheck && pnpm test`。
6. **本项目禁止 `chat/completions` 协议**：Cell、模型网关、上游调用、开发装配和验收不得使用该协议，不得保留兼容入口、隐式转换或失败回退。模型链路使用 OpenAI Responses（或显式实现并验证的 Messages）；必须有拒绝旧协议的回归测试。只读 vendor 中的上游实现与负例测试不属于启用该协议。

## 文档与 skills

- 公开说明集中在 [文档索引](<docs/README.md>)，遵循[文档政策](<docs/documentation-policy.md>)；不要添加第二份过时部署 README。
- 需求分析使用 [myrix-business](<.agents/skills/myrix-business/SKILL.md>)，实现与评审使用 [myrix-development](<.agents/skills/myrix-development/SKILL.md>)；发现规则见 [skills 指南](<docs/development/skills.md>)。
- 部署 skill 和维护者实例记录只留本地并被 Git/Docker 忽略；不得 `git add -f`。专用公开体验账号之外的任何凭据不进入文档、日志或构建上下文。
- 当前 Cell 不启用 skill 插件/工具。开发者 skill 的存在不是扩大 Cell 白名单的理由。
- 管理员不绕过单属主内容授权；未保存章节不得自动发送模型；版本冲突保留草稿。真实模型、线上部署、重启与恢复须明确授权，报告执行和未执行的层级。

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
