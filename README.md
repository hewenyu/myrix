# Myrix

> 基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的受治理 Agent 应用平台；当前交付是 **v0.1 小说创作工作台**。

Myrix 将作品、大纲、章节、人物/设定/时间线与三个写作助手放在一个工作台里。DSH 提供 Agent 运行时，Myrix 负责身份、授权、业务持久化、会话路由与模型计量；通过 Cordis 插件和 bundle 集成，**不修改上游核心**。

## 在线演示

**体验入口：[https://br.zve.ccwu.cc](https://br.zve.ccwu.cc)**。这套线上实例是演示环境，不是生产数据托管服务。

- **用户名：`myrix-demo`**
- **密码：`Myrix-PnWj7g1xngAUZi-T-7a!`**
- 权限：专用共享的**工作台管理员**；不是主机、数据库或 Keycloak 管理后台账号。这组凭据经维护者授权公开，不能用于其他环境。
- 打开入口后选择登录，进入工作台，新建带自己标识的测试作品，保存大纲或章节，再选择对应助手试写。章节助手需要先保存正文，再通过“章节助手上下文”显式复制并提交章节信息。
- **共享账号不提供访客间隔离**：同一账号的作品和会话可能被其他访客读取、修改或删除。不要上传个人信息、密钥、公司资料或未公开稿件；不要修改共享密码，不要批量调用模型。
- 数据可能重置，服务与模型额度不保证持续可用；需要独立数据、稳定额度和自己的账号体系时请[自行部署](<docs/deployment/self-hosting.md>)。
- 2026-10-02 已用真实浏览器验证 HTTPS 首页、OIDC 密码登录、工作台可见、服务端管理员身份及作品列表 API。**本轮未调用线上模型、未创建作品、未重启服务**，不将登录验证写成模型全链路或恢复验收。

## 能做什么，不能据此推断什么

| 当前能力 | 说明 |
| --- | --- |
| 小说工作台 | 作品、大纲、章节及历史版本、人物/设定/时间线；显式版本冲突处理 |
| 三类助手 | 大纲、章节、设定预设；六个小说工具按预设隔离，先读再按版本写入 |
| 持久会话 | BFF 命令入队、租户 Cell 执行、SSE 重放、撤权与重启恢复机制 |
| 安全与计量 | OIDC + Cookie/CSRF、单属主授权、PostgreSQL RLS、Responses 网关与额度账本 |
| 部署 | 单台 VPS：Docker Compose + PostgreSQL + 同机 Keycloak + 已有宿主 Nginx |

企业知识库联邦、通用插件管理台是早期治理方向，不等于当前工作台已交付的功能。旧内存控制面/console 用 `pnpm dev:legacy` 启动，**不是**当前应用。Kubernetes CellManager/Helm 有实现，但不是当前演示部署或已验收的高可用方案。详见[业务说明](<docs/business.md>)、[架构](<docs/architecture.md>)与[验收边界](<docs/testing/acceptance.md>)。

## 本地开发

前提：Node.js **24 系列**（根包允许 `^22.19.0 || >=24.0.0`；本轮环境为 24.13.0）、pnpm **10.33.0**、Docker Compose v2。以下在仓库根目录执行，使用专用本地数据库，不能指向已有业务库。

```bash
git submodule update --init --recursive vendor/deepseek-harness
pnpm install --frozen-lockfile
pnpm --dir tests/poc/.dsh-install install --frozen-lockfile

# 显式初始化专用本地 PostgreSQL；这个固定口令仅用于 loopback 开发夹具
docker compose -f deploy/compose.dev.yml up -d --wait postgres
MYRIX_MIGRATE_DATABASE_URL='postgres://myrix_migrator:myrix_local_migrator@127.0.0.1:55439/myrix' pnpm setup:dev
pnpm build:web
```

从[配置模板](<.env.example>)创建仅本地的 `.env`（权限 `0600`），填入自己的 **Responses 完整端点、准确模型 ID、API key 和模型上下文容量**；示例域名不能直接调用。然后：

```bash
pnpm dev
```

打开 [http://127.0.0.1:8787](http://127.0.0.1:8787)，使用本机开发登录。`pnpm dev` 启动 BFF/works、网关和两个隔离 Cell，**不会自动迁移或重置数据**。前端改动需要停止开发栈、重新 `pnpm build:web`、重启并刷新。完整操作、端口、启动失败处理见[本地开发指南](<docs/implementation/local-development.md>)。

**模型链路禁止 `chat/completions`**，不提供兼容入口、转换或失败回退；已实现链路为 OpenAI Responses。缺模型密钥会显式失败，不以 mock 冒充在线模型。

## 自行部署

从[单机自部署指南](<docs/deployment/self-hosting.md>)开始；认证细节见[Keycloak / Nginx 装配](<docs/deployment/authentication.md>)，数据保护见[备份与恢复](<docs/deployment/backup-restore.md>)。

- 自备域名、既有 Nginx/TLS、Docker Compose 和已验证的 Responses 上游；不要复用演示账号或本地开发口令。
- BFF、Gateway、Cell、Keycloak 四个镜像必须使用同一完整提交 SHA 的标签，不能混用版本或使用 `latest` 代替验收。
- 初始化生成独立身份、密钥与数据库口令；真实配置、账号、备份和本机运维记录不提交 Git，不进入 Docker 构建上下文。
- 升级前先停写备份；不得用重新初始化、删除卷或 `down -v` 代替升级/恢复。首次登录改密、真实模型回合和恢复必须在自己的环境验收。

公开指南可用于其他人的部署；**维护者这台演示实例的操作记录和部署 skill 仅保留本地**。

## 开发与质量门禁

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:ci
pnpm build:web
```

未配置专用测试数据库时，部分 PostgreSQL 集成测试会跳过；绿灯不能代替数据库、真实 DSH、浏览器、OIDC、公网模型及恢复验收。检查层级与命令见[验证指南](<docs/testing/acceptance.md>)。

| 源码位置 | 职责 |
| --- | --- |
| [novel-web](<apps/novel-web/>) / [BFF](<apps/bff/>) | 工作台与同源 HTTP/SSE、认证、业务装配 |
| [platform-store](<packages/platform-store/>) | 当前 BFF 使用的 PostgreSQL/RLS/CAS/命令队列；[works-service](<apps/works-service/>) 是另一路尚未统一的作品实现，不是当前部署入口 |
| [governance](<packages/governance/>) / [contracts](<packages/contracts/>) | 无 I/O 的授权判定与共享契约 |
| [plugins](<plugins/>) / [myrix-base](<bundles/myrix-base/>) | DSH 身份、授权执行、工具、模型适配与白名单装配 |
| [model-gateway](<apps/model-gateway/>) | Responses、额度预占/真实用量结算与审计 |
| [deploy](<deploy/>) / [cell-manager](<apps/cell-manager/>) | 单机部署脚本；另有 Kubernetes 实现 |

## 文档与项目 skills

**统一入口：[文档索引](<docs/README.md>)**。项目说明、开发、接口、测试、部署、ADR 和复盘统一在文档目录维护；旧草案与含现场证据的原始记录本地归档，不再当作当前规范。[文档与脱密规则](<docs/documentation-policy.md>)说明公开/本地边界及 Git 历史限制。

- [理解业务 skill](<.agents/skills/myrix-business/SKILL.md>)：梳理业务流程、权限、数据归属和需求影响。
- [开发 skill](<.agents/skills/myrix-development/SKILL.md>)：定位模块、实现与测试、安全约束、文档同步。
- 本地部署 skill：仅维护者 checkout 提供，不随 clone 分发；公共部署知识以自部署指南为准。发现方式见[skills 指南](<docs/development/skills.md>)。
- 贡献前阅读[仓库约定](<AGENTS.md>)；项目现状与优先级见[复盘](<docs/reviews/project-review-2026-10.md>)和[路线图](<docs/roadmap.md>)。

## 上游与许可

只读[上游子模块](<vendor/deepseek-harness/>)锁定 `639ed015397290b3745d163aafe02ffee4aa3f84`，运行 CLI 使用独立锁定的 npm `@deepseek-ai/dsh@0.2.0-rc.2`；同版本号不证明两份产物逐字节一致，详见[运行时依赖](<docs/development/runtime-dependencies.md>)。

本仓库采用 **Apache-2.0**（[LICENSE](<LICENSE>)、[NOTICE](<NOTICE>)）；上游 DSH 为 [MIT](<https://github.com/hewenyu/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/LICENSE>)。分发时保留双方许可与版权声明，并标注修改；商标权不在授权范围内，不暗示上游官方背书。
