# Myrix

**面向小说创作的 AI 工作台，支持私有部署。**

[![CI](https://github.com/hewenyu/myrix/actions/workflows/docker.yml/badge.svg?branch=master)](https://github.com/hewenyu/myrix/actions/workflows/docker.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](<LICENSE>)

[在线体验](https://br.zve.ccwu.cc) · [项目文档](<docs/README.md>) · [本地开发](<docs/implementation/local-development.md>) · [自行部署](<docs/deployment/self-hosting.md>)

Myrix 将大纲、章节、人物设定与 AI 创作助手放在同一个工作台中，让构思、写作、修改和版本管理围绕作品展开。项目基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 构建，通过 Cordis 插件与 bundle 扩展 Agent 运行时，由 Myrix 管理身份认证、内容授权、持久化和模型用量。

当前版本为 **v0.1**，聚焦小说创作场景。功能范围与后续计划见[业务说明](<docs/business.md>)和[路线图](<docs/roadmap.md>)。

## 核心功能

- **围绕作品组织内容**：书架管理作品，书内目录统一管理大纲、章节、人物、设定与时间线。
- **阅读与编辑分离**：已保存正文默认以阅读排版展示，可切换到原文编辑；支持桌面专注模式和移动端分栏切换。
- **结合当前内容协作**：一个创作助手处理构思与改稿，默认以当前选中的章节、大纲或设定为修改目标，无需手动复制上下文。
- **保留修改与对话历史**：章节历史版本、显式版本冲突处理、持久会话及对话归档；冲突时保留本地草稿。
- **可控的运行边界**：OIDC 登录、作品属主授权、PostgreSQL 行级安全、租户隔离的 Agent 运行时，以及统一模型网关与额度计量。

助手通过工具读取**已保存内容**。未保存正文不会自动发送；需要处理草稿时，请先保存。章节和设定条目需先在界面中新建，再交给助手修改。

## 在线体验

访问 **[br.zve.ccwu.cc](https://br.zve.ccwu.cc)**，使用以下公开体验账号登录：

| 用户名 | 密码 |
| --- | --- |
| `myrix-demo` | `Myrix-PnWj7g1xngAUZi-T-7a!` |

登录后新建作品与章节，保存正文，再向右侧助手提出修改要求。输入框上方会显示本条消息的默认修改目标。

> **共享演示环境，请勿存放私密内容。** 同一账号下的作品和会话不隔离访客，其他人可能读取、修改或删除内容。该账号仅具有工作台管理员权限，不具有主机、数据库或 Keycloak 管理权限。请勿修改共享密码或批量调用模型；演示数据可能重置，服务和模型额度不保证持续可用。

## 快速开始

### 环境要求

- Node.js **24**（推荐）与 pnpm **10.33.0**。
- Docker Engine / Docker Desktop，包含 Docker Compose v2。
- 支持 **OpenAI Responses** 的模型服务及 API key。Myrix 不支持 `chat/completions`，也不提供协议转换或回退。

### 1. 获取代码并安装依赖

```bash
git clone --recurse-submodules https://github.com/hewenyu/myrix.git
cd myrix
pnpm install --frozen-lockfile
pnpm --dir tests/poc/.dsh-install install --frozen-lockfile
```

DSH CLI 使用独立锁定的依赖安装，详见[运行时依赖](<docs/development/runtime-dependencies.md>)。

### 2. 初始化本地数据库

以下命令只用于专用本地开发数据库，不要指向已有业务库：

```bash
docker compose -f deploy/compose.dev.yml up -d --wait postgres
MYRIX_MIGRATE_DATABASE_URL='postgres://myrix_migrator:myrix_local_migrator@127.0.0.1:55439/myrix' pnpm setup:dev
```

这里的固定口令仅用于绑定在本机回环地址上的开发夹具，不适用于部署环境。

### 3. 配置模型服务

```bash
cp .env.example .env
chmod 600 .env
```

按[配置模板](<.env.example>)填写 Responses **完整端点**、准确的模型 ID、API key 与模型上下文容量。模板中的域名和模型是占位符，必须替换；本地配置包含凭据，不应提交到版本库。

### 4. 构建并启动

```bash
pnpm build:web
pnpm dev
```

打开 **[http://127.0.0.1:8787](http://127.0.0.1:8787)**，选择本机开发身份登录。

开发栈包含 BFF、模型网关与两个隔离的 Cell，启动不会自动迁移或重置数据。前端暂不提供热更新：修改后需停止开发栈、重新构建、再启动并刷新。端口、配置与排障说明见[本地开发指南](<docs/implementation/local-development.md>)。

## 架构概览

```mermaid
flowchart LR
    Web["小说工作台"] --> BFF["BFF / 作品服务"]
    Auth["Keycloak · OIDC"] --> BFF
    BFF --> DB[(PostgreSQL)]
    BFF --> Cell["租户 Cell · DSH"]
    Cell -->|小说工具| BFF
    Cell --> Gateway["模型网关"]
    Gateway -->|Responses| Model["上游模型服务"]
    Gateway --> DB
```

- **工作台与 BFF**：浏览器只访问同源 BFF，由服务端处理认证、内容授权、版本控制和会话路由。
- **租户 Cell**：独立运行 DSH 与 Myrix 白名单插件，通过受授权工具访问作品；不直接持有数据库凭据或上游模型密钥。
- **存储与模型网关**：PostgreSQL 持久化业务数据，模型网关统一调用上游并记录额度与用量。

主线入口位于 [novel-web](<apps/novel-web/>)、[BFF](<apps/bff/>)、[platform-store](<packages/platform-store/>) 和 [model-gateway](<apps/model-gateway/>)；Agent 扩展位于 [plugins](<plugins/>) 与 [myrix-base](<bundles/myrix-base/>)。组件边界和请求流程见[架构文档](<docs/architecture.md>)。

## 自行部署

当前部署方案为**单台 VPS + Docker Compose + PostgreSQL + Keycloak + 宿主 Nginx/TLS**。从[自部署指南](<docs/deployment/self-hosting.md>)开始，按需阅读[认证配置](<docs/deployment/authentication.md>)与[备份恢复](<docs/deployment/backup-restore.md>)。

部署使用独立账号与密钥，不复用公开体验账号或开发口令。四个应用镜像应使用同一完整提交 SHA，并固定不可变摘要；升级前停写并联合备份数据库、Cell 数据与私有配置，不通过重新初始化或删除数据卷完成升级。

早期治理 console、企业知识库联邦及 Kubernetes 路线不属于当前小说工作台的交付承诺；现有单机方案也不代表高可用部署。

## 开发与贡献

提交变更前请阅读[仓库约定](<AGENTS.md>)，执行以下检查：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:ci
pnpm build:web
```

PostgreSQL 集成测试需要专用测试库；未配置时部分测试会跳过。浏览器、真实模型与部署恢复属于独立验收层级，运行方法见[验证指南](<docs/testing/acceptance.md>)。真实模型调用会产生费用。

DSH 上游通过只读子模块引入，扩展应使用 Cordis 插件、bundle 或 patch，不直接修改上游核心。项目提供业务、开发与 UI 设计 skills，使用方式见[skills 指南](<docs/development/skills.md>)；界面贡献遵循[UI 设计标准](<docs/development/ui-design.md>)。

## 文档导航

| 主题 | 入口 |
| --- | --- |
| 产品与规划 | [业务说明](<docs/business.md>) · [路线图](<docs/roadmap.md>) |
| 设计与实现 | [架构](<docs/architecture.md>) · [工作台实现](<docs/implementation/novel-web.md>) · [UI 设计](<docs/development/ui-design.md>) |
| 开发与测试 | [本地开发](<docs/implementation/local-development.md>) · [运行时依赖](<docs/development/runtime-dependencies.md>) · [验证指南](<docs/testing/acceptance.md>) |
| 部署与运维 | [自部署](<docs/deployment/self-hosting.md>) · [认证](<docs/deployment/authentication.md>) · [备份恢复](<docs/deployment/backup-restore.md>) |

完整目录见[文档索引](<docs/README.md>)。

## 许可证

Myrix 采用 **Apache License 2.0**，详见 [LICENSE](<LICENSE>) 与 [NOTICE](<NOTICE>)。上游 DeepSeek Harness 采用 **MIT License**；分发时须保留相应许可与版权声明。本项目不代表上游官方背书。
