# Myrix 首版实施与验收记录

> 本文保留初期实施过程、当时数字与待办，不代表当前状态。**本地 v0.1 已验收通过**；最新证据、完成范围与生产边界见 [最终验收记录](<v0.1-acceptance.md>)，复现步骤见 [本地开发指南](<local-development.md>)。

依据：`docs/plan/platform-plan-v2.md`、`docs/plan/tech-design-v1.md`。不修改锁定的 DSH submodule。实现代理只使用 DeepSeek；Lead 负责集成和验收。

## 交付原则

- 首版不是旧管理台演示：必须能创建作品、维护大纲/章节/设定，创建绑定作品的三个 preset 会话，通过真实 DSH 内核调用小说工具，持久保存并恢复。
- 所有权、成员状态、策略和撤权在服务端判定；浏览器不能指定 actor。未知身份、缺失策略、网络错误均拒绝。
- 默认使用 Postgres 业务存储；测试替身只用于单元测试，不能冒充持久部署。
- 本地开发身份模式须显式开启、仅绑定 loopback，并明显标识；生产走 OIDC，不允许共享 admin token 冒充用户。
- 对尚未具备条件的集群故障/性能/事实准确率实验，记录未验收，不编造 P1–P8 通过结论。

## 分工 / 写入边界

| 工作 | 所有者 | 写入范围 |
|---|---|---|
| ES256 grants | DeepSeek grant 子代理 | packages/grant/；docs/adr/0010-grant-es256.md |
| 真实 DSH 最小组合 PoC | DeepSeek runtime 子代理 | tests/poc/；bundles/myrix-base/；docs/implementation/runtime-poc.md |
| PG 业务存储与 CAS / 命令队列 | DeepSeek storage 子代理 | packages/platform-store/；apps/works-service/；ADR-0011 |
| 纯函数授权 | DeepSeek governance 子代理 | packages/governance/；旧 store / demo 时钟适配；ADR-0012 |
| 小说工作台 | DeepSeek frontend 子代理 | apps/novel-web/；novel-web 实施记录 |
| Cell controller 与 Helm | DeepSeek cell 子代理 | apps/cell-manager/；deploy/helm/myrix/；ADR-0014 |
| 真实 Driver / Principal / PEP | DeepSeek runtime-driver 子代理 | plugins/myrix-runtime-driver/；plugins/myrix-principals/；plugins/myrix-policy-enforcer/；ADR-0016 |
| 模型网关与配额账本 | DeepSeek gateway 子代理 | apps/model-gateway/；ADR-0015 |
| BFF 认证与 API、小说工具、根集成、共享契约、工具链、验收 | Lead | apps/bff/；plugins/myrix-novel/；根配置；packages/contracts/；scripts/；ADR-0013、0017；本记录 |

后续分配写入范围后再启动实现。代理不得改其他范围，不得调用其他模型。

## 接口基线

- 浏览器只访问 BFF `/api/v1/*`，同源 session cookie + CSRF；标准错误 `{ error: string, reason: string }`。
- 列表 `{ items: T[] }`；时间 ISO8601 UTC；标识为不可推测随机值；版本从 0（无内容）开始。
- 作品：`id, tenantId, ownerUserId, title, description, createdAt, updatedAt`。
- 章节：`id, workId, title, text, version, updatedAt`；保存必须 expectedVersion；服务端计算正文哈希，parentVersion + 正文相同才能 duplicate，否则 conflict。
- 大纲和设定同样使用显式 expectedVersion，避免默默覆盖。
- preset ID 固定 `novel-outline`、`novel-chapter`、`novel-bible`。
- 浏览器发送 commandId + text，actor、session binding、cell、grant 均由服务端确定。
- 平台 queued 仅表示 DB 持久入队；cell accepted 仅表示 inbox + session flush；回复通过 SSE 事件表达。
- 生产不得用模拟模型作无提示降级；未配置模型时明确报告配置缺失。

## 初始基线（2026-09-30）

- Node v24.13.0、pnpm 10.33.0、Go go1.26.1，Docker Desktop 可用。
- DSH 锁定 `639ed015397290b3745d163aafe02ffee4aa3f84`。
- `pnpm typecheck && pnpm test` 通过：8 个测试文件、39 项测试。
- 原有控制面为内存 + 单 admin token，只能视为 legacy 演示，不能当新平台认证边界。
- 用户已有未跟踪 `.team/` 与 `docs/plan/`；保留不覆盖。

## 集成进展（尚未完成首版验收）

- BFF 认证/API/内部工具边界单元与 HTTP double 测试：4 文件 / 19 项通过。
- BFF 独立 PostgreSQL 数据库 `myrix_bff_acceptance`：真实 LOGIN `myrix_bff_test` 为非 owner、NOSUPERUSER、NOBYPASSRLS，6 项通过。覆盖 admin 不能读他人正文、跨租户/跨作品拒绝、章节/大纲/设定 CAS、无 tenant GUC 看不到行、preset/revision 拒绝、撤权与成员禁用。
- 上述 PostgreSQL 验收还实际锁住章节，让工具保存等待，再以并行连接尝试撤权；撤权因会话 SHARE 锁触发 lock_timeout，证明授权绑定锁一直覆盖内容提交，而非检查后另开事务写入。随后合法保存完成，再撤权后新请求被拒绝。这不等于已验证所有并发组合。
- PostgreSQL 验收命令（须显式指定独立测试数据库与已授权的真实非 owner 登录；不会删库/清表）：

```sh
BFF_TEST_DATABASE_URL='postgres://myrix_bff_test:myrix_local_bff_test@127.0.0.1:55439/myrix_bff_acceptance' \
BFF_TEST_MIGRATION_DATABASE_URL='postgres://myrix_migrator:myrix_local_migrator@127.0.0.1:55439/myrix_bff_acceptance' \
pnpm exec vitest run apps/bff/tests/postgres.integration.test.ts
```

- 此阶段尚不能声称：运行时插件已装配、真实模型对话可用、浏览器完整闭环、Kubernetes 故障恢复或密度测试通过。全量准入检查待所有模块集成后重跑。

## 验收清单

- [ ] 严格 ES256 claims / 过期 / boot / 重放 / body hash 负例。
- [ ] 真实白名单 DSH loader、setup 身份绑定、flush / 恢复、禁用工具不可见。
- [ ] Postgres 真实非 BYPASSRLS 跨租户/跨用户拒绝、CAS 幂等、事务命令队列。
- [ ] 登录、作品、大纲、章节、设定、三个助手的前后端闭环。
- [ ] 模型归因、限额、取消、撤权与运营审计。
- [ ] Cell 管理状态机、Helm 安全基线和可复现本地启动。
- [ ] `pnpm typecheck && pnpm test`、组合测试、Go 测试、浏览器/HTTP E2E。
- [ ] P1–P8 已测 / 未测项目和限制明确列出。
