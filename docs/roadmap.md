# 路线图

约定：每个里程碑都有可验证的验收标准；未达标不进下一阶段。

## M0（已完成）骨架与治理内核

- [x] DSH 作为 submodule 引入并锁定提交
- [x] 契约层（Principal / Policy / Entitlement / Knowledge / Audit）
- [x] PDP：RBAC 继承 + ABAC 条件 + deny-overrides + 义务合并（沙箱取最严、范围取交）
- [x] 功能裁剪：插件目录 + 依赖闭合 + 按主体授权 + profile 产物渲染
- [x] 知识库联邦：连接器契约、可见性收窄、故障隔离
- [x] 控制面 API（Bearer 鉴权、fail-closed）+ 管理后台 7 个页面
- [x] 单元测试 39 项、`tsc` 严格类型检查通过
- [x] 文档：架构 + 5 篇 ADR + DSH 对接清单 + 原始调研证据

## M1 打通 DSH 数据面（下一阶段，需要先确认第八节的 8 个问题）

- [ ] 在 `vendor/deepseek-harness` 上构建，替换 `packages/dsh-shim` 为真实类型
- [ ] 跑通 `tools/pre-execute` / `ctx.tools.guard` / `ctx.tools.restrict` / `permissionPresets.set`
- [ ] 确认工具注册 API，落地 `myrix_kb_search`
- [ ] 身份注入：OIDC 登录 + profile 渲染（一人一 home 形态）
- [ ] 控制面持久化切换 Postgres（迁移已就绪）
- [ ] 端到端验收：deny 工具不可执行、沙箱档位与义务一致、控制面停机时 fail-closed
- [ ] CI：`typecheck + test + 子模块构建`

## M2 企业级能力补齐

- [ ] 管理后台 OIDC 登录 + `console_operators` 角色（viewer/operator/admin）
- [ ] 策略版本化与灰度：草稿 → 模拟 → 发布 → 回滚
- [ ] 审批对接企业工单/审批流（替换 `approval/request` answerer）
- [ ] 网关契约落地：`traceId` 聚合视图、`rateLimit`/`modelScope` 实际下发
- [ ] 知识库 Connector 实现：至少两个真实后端（如 ES/向量库 + Confluence/语雀类）
- [ ] 审计落库 + 归档策略（`audit_events` 分区与留存）
- [ ] 多租户运维视图：租户配额、用量、异常检测

## M3 规模化与形态演进

- [ ] 多用户共进程形态（BFF 或自建 Connection provider，ADR-0002）
- [ ] 会话/工作区租户隔离
- [ ] 策略即代码：Git 仓库 + CI 校验 + 变更评审
- [ ] 高可用：控制面多实例、判定缓存一致性、降级预案演练
- [ ] 可观测性：判定延迟、缓存命中率、裁剪分布、fail-open 事件告警（应为 0）

## 明确不做

- 不 fork/改造 DSH 核心（只做插件与 profile）
- 不在平台内重建 LLM 网关或 RAG 引擎
- 不复制企业知识库的 ACL 与正文
