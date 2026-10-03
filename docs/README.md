# 文档索引

当前交付是持久化的 **v0.1 小说创作工作台**。从[项目入口](<../README.md>)开始；历史治理演示、未来路线与现网验证分别标明，不能互相替代。

## 产品与架构

- [业务说明](<business.md>)：对象、权限、统一创作助手与历史 preset、归档语义、冲突与验收条件。
- [总体架构](<architecture.md>)：当前调用链、模块职责、安全边界与 legacy 区分。
- [路线图](<roadmap.md>)：已实现、待现场验证和后续里程碑。
- [本轮项目复盘](<reviews/project-review-2026-10.md>)：代码与文档差异、风险、优先级和本轮验证。
- [模块边界复盘](<reviews/module-boundaries-2026-10.md>)：模块治理历史记录；其中测试数字只描述当时执行。

## 开发与测试

- [本地开发](<implementation/local-development.md>)：初始化、模型配置、启动及编辑体验。
- [工作台 UI 设计标准](<development/ui-design.md>)：作者任务、信息分层、文本保真、安全 Markdown、修改目标、令牌/响应式/专注模式与证据分层；§0 是当前实现状态快照。
- [运行时依赖](<development/runtime-dependencies.md>)：Node/pnpm、子模块与独立 npm CLI 锁定。
- [项目 skills](<development/skills.md>)：业务/开发/界面设计技能与仅本地的部署技能；界面设计 skill 见 [myrix-ui-design](<../.agents/skills/myrix-ui-design/SKILL.md>)。
- [分层验证指南](<testing/acceptance.md>)：默认门禁、真实 PG/DSH/浏览器/模型/恢复的证据边界。
- [小说工具 smoke](<testing/novel-smoke.md>)：真实运行时与替身服务的装配检查。
- [贡献约定](<../AGENTS.md>)：纯函数、默认拒绝、协议与许可要求。

## 实现与集成

详见[实现文档目录](<implementation/>)中的 BFF/存储、小说运行时、前端和绑定租约说明；业务装配最终以源码入口为准。

- [小说工作台（novel-web）](<implementation/novel-web.md>)：书架、书内三栏（阅读优先、显式编辑）、统一创作助手与修改目标元数据、归档与响应式行为。
- [DSH 扩展点](<integration/dsh-seams.md>)：当前 Cell 与历史 shim 的不同边界。
- [历史 DSH shim](<integration/legacy-dsh-shim.md>)：仅用于 legacy，不是当前主链。
- [模型网关运维](<implementation/model-gateway-operations.md>)：Responses 上游、凭据、计量与限流。
- [ADR 目录](<adr/>)：按时间保留决策，旧设计不自动等于当前运行态；优先阅读被当前实现引用的 ADR。与本主线直接相关的是 0013（认证）、0017（工具边界）、0019（绑定租约）、0020（生产装配）、0023（Responses 网关）、0025（部署策略）、0026（写输出投影）、0028（会话恢复）、0029（单机运行时）与 [0034（统一创作助手与会话归档）](<adr/0034-novel-assistant-and-session-archive.md>)。

## 自行部署

- [单机 VPS 指南](<deployment/self-hosting.md>)：Compose、同 SHA 镜像、初始化、Nginx/TLS 和上线验收。
- [认证装配](<deployment/authentication.md>)：Keycloak、公开 issuer、主体预登记与路径隔离。
- [备份与恢复](<deployment/backup-restore.md>)：联合备份、恢复前置和禁止操作。

公开指南不包含维护者 SSH、数据库或 IdP 管理凭据。专用共享体验账号见[在线演示](<../README.md#在线演示>)；其公开授权不适用于其他账号。

## 文档维护

[文档与脱密政策](<documentation-policy.md>)规定公开规范、历史决策、本地档案及运维记录的边界。旧大草案和现场原始证据已本地归档，不作为公开依赖；Git 忽略不等于清除历史或完成密钥轮换。
