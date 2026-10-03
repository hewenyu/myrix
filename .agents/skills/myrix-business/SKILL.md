---
name: myrix-business
description: 理解 Myrix 小说创作工作台的业务流程、对象、权限和需求影响；用于需求分析、产品说明与验收设计。
---

# Myrix 业务分析

## 先读

从仓库根目录阅读 [业务说明](../../../docs/business.md)、[架构](../../../docs/architecture.md)、[路线图](../../../docs/roadmap.md) 与 [项目复盘](../../../docs/reviews/project-review-2026-10.md)。文档与实现冲突时以源码和当前测试为证据，明确记录差异，不把路线图当交付承诺。

## 分析步骤

1. 确认讨论当前持久化小说工作台，还是历史治理 console。当前主链为 novel-web → BFF/works → PostgreSQL、DSH Cell 和 Responses 网关；不要混为一套应用。
2. 用租户、成员、作品、大纲、章节/版本、设定条目、会话绑定、命令和审计描述需求，区分业务对象版本与命令执行状态。
3. 对每个读写列出 actor、tenant、owner、role、资源、动作、失败原因及撤权行为。管理员不是跨租户或跨属主阅读权；共享演示账号不隔离访客。
4. 写入携带 `expectedVersion`，冲突必须保留用户草稿并显式处理；模型说“已保存”、HTTP 202 或工具气泡不算持久化验收。
5. 三个预设 `novel-outline` / `novel-chapter` / `novel-bible` 只开放相应工具。工具全集为 `get_outline`、`update_outline`、`get_chapter`、`save_chapter_draft`、`search_bible`、`update_bible_entry`。
6. 章节上下文由用户显式复制、提交；不自动发送未保存内容。模型链路禁止 `chat/completions`，当前只实现 Responses。
7. 输出用户流程、允许/拒绝矩阵、正常/冲突/撤权/恢复验收条件、涉及模块、文档更新点和未验证项。

## 不可突破的边界

默认拒绝、约束只能收窄、身份和 Cell 绑定由服务端决定；浏览器字段不能赋权。不得为演示省略真实 RLS、CSRF、OIDC 或用 mock 冒充线上模型。企业知识库、通用插件市场、Kubernetes 高可用不是当前已验收产品能力。

本 skill 只供开发者 Harness 使用，不启用小说 Cell 的 skill 插件或工具。涉及实现转用 `myrix-development`；涉及真实部署使用公开自部署指南，维护者部署 skill 不随仓库分发。
