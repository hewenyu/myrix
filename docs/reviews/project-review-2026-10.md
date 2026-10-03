# 项目全面复盘（2026-10）

## 0. 范围与证据

本轮以仓库源码、配置、ADR、测试入口及当前部署记录交叉核对文档，集中公开说明、归档原始过程资料、脱敏并补齐开发者 skills。静态审查由独立审阅协助，最终编辑、检查与结果由主执行者负责。

另经维护者明确授权，在既有演示实例新增专用工作台管理员并验证真实浏览器 OIDC 登录。**未改产品业务逻辑、未改 vendor、未重置既有账号、未重启/升级服务、未调用线上模型、未做恢复演练。** 源码变化仅为文档路径/提示修正、示例夹具脱敏及文档回归测试。

历史验收数字只描述当时执行；本轮结果单列在 §6。公开演示 URL/专用账号是经授权的例外，真实上游 key、数据库串、SSH、IdP 管理凭据、会话日志与部署现场仅本地保留。公开供应链来源和镜像仓库不是秘密，不以占位符破坏可部署性。边界见[文档政策](<../documentation-policy.md>)。

## 1. 当前主线核对

| 结论 | 实现证据 |
| --- | --- |
| 当前交付为持久化小说工作台：novel-web → BFF/works → 租户 Cell → Responses / PostgreSQL | [production.ts](<../../apps/bff/src/production.ts>)、[bin.ts](<../../apps/bff/src/bin.ts>) |
| BFF 与内部 works 为同一进程的两个 listener，不是独立 works-service 应用 | [production.ts](<../../apps/bff/src/production.ts>) |
| 一 Cell 一租户，当前静态目录拒绝重复/跨租户选择 | [runtime-cells.ts](<../../apps/bff/src/runtime-cells.ts>) |
| Cell 白名单装配已包含 myrix-novel；不启用通用 shell/fs/web/skill | [cell.patch.yml](<../../bundles/myrix-base/cell.patch.yml>) |
| 三个 preset、六个工具，掩码统一来自 novel-protocol | [协议包](<../../packages/novel-protocol/src/index.ts>)、[preset-tools.ts](<../../plugins/myrix-novel/src/preset-tools.ts>) |
| 工具请求逐层验证 Cell 凭据、binding、成员/租户/作品、治理与 preset | [works-server.ts](<../../apps/bff/src/works-server.ts>) |
| expectedVersion + CAS；持久命令有幂等键、正文哈希、租约与状态机 | [cas.ts](<../../packages/platform-store/src/cas.ts>)、[commands.ts](<../../packages/platform-store/src/repositories/commands.ts>) |
| 撤权、rev递增、outbox与审计同事务；主体活性有限期、失败清空 | [bindings.ts](<../../packages/platform-store/src/repositories/bindings.ts>)、[binding-lease](<../../plugins/myrix-binding-lease/src/index.ts>) |
| 业务表 FORCE RLS，运行低权 LOGIN 非 owner；admin 不绕过单属主内容权限 | [迁移目录](<../../packages/platform-store/src/migrations/>)、[works.ts](<../../packages/platform-store/src/repositories/works.ts>) |
| OIDC/回环开发认证 + Cookie/Origin/CSRF，每次重读身份 | [auth.ts](<../../apps/bff/src/auth.ts>) |
| 模型链路只实现 Responses，旧协议拒绝且无兼容回退 | [网关路由](<../../apps/model-gateway/src/server.ts>)、[配置](<../../apps/model-gateway/src/config.ts>) |
| 当前部署为单 VPS；Kubernetes 另有代码但不等于上线 | [ADR0029](<../adr/0029-single-vps-runtime.md>)、[自部署指南](<../deployment/self-hosting.md>) |

## 2. 本轮发现与处置

### 已修复：产品定位与实际装配相反

原入口/架构/路线图以 M0 内存治理骨架为主；小说运行时文档还称未装配，依赖文档保留临时类型目录和错误 Node 最低版本。已统一为当前持久化工作台，legacy console/control-plane/shim 单列历史。明确 npm CLI 与只读 submodule 独立锁定，版本相同不证明构建相同。

对应：[README](<../../README.md>)、[架构](<../architecture.md>)、[路线图](<../roadmap.md>)、[小说运行时](<../implementation/novel-runtime.md>)、[运行时依赖](<../development/runtime-dependencies.md>)。

### 已修复：文档散落、退役链接和不可分发证据

部署、认证、备份、网关运维、shim、smoke与依赖说明集中到 docs；三个早期计划、原始调研和长篇过程验收归档本地。保留迁移前61份已跟踪 Markdown 的 SHA-256 基线，不另建公开“第二套规范”。更新 ADR、测试读取位置、CLI提示和源码注释。公开页面不链接被忽略的私有报告；新增 CI 本地链接与私有依赖检查。

对应：[索引](<../README.md>)、[文档政策](<../documentation-policy.md>)、[链接测试](<../../tests/ci/documentation.test.mjs>)。

### 已修复：维护者部署信息与通用自部署知识混在一起

对外保留完整自部署、认证补员、同 SHA 镜像、宿主 Nginx、RLS及联合备份/恢复方法。维护者 SSH、release路径、原始证据和部署 skill 放在 Git/Docker 忽略目录；模型供应商示例改为保留域名。公开专用体验账号不等于公开 owner/IdP/基础设施秘密。

对应：[自部署](<../deployment/self-hosting.md>)、[认证](<../deployment/authentication.md>)、[备份恢复](<../deployment/backup-restore.md>)。

### 已修复：缺少可复用的业务/开发操作入口

新增公开 `myrix-business`、`myrix-development`，仅本地 `myrix-deploy`。按真实 Harness 发现规则使用 kebab-case frontmatter；测试覆盖名称、描述、旧字段拒绝与忽略边界。当前会话是否已加载仍以 skill catalog 为准，不能由文件存在推断；不改变 Cell 白名单。

对应：[skills 指南](<../development/skills.md>)、[skills 测试](<../../tests/ci/skills.test.mjs>)。

### 仍待决策：作品业务实现重复且已分叉（P1）

生产浏览器 API 使用 BFF 的[novel-store.ts](<../../apps/bff/src/novel-store.ts>)，内部工具使用[works-server.ts](<../../apps/bff/src/works-server.ts>)。另一路 [WorksService](<../../apps/works-service/src/index.ts>) 在当前生产链无消费者，且把大纲按行映射为 chapters，而 BFF 路径保存 synopsis、chapters为空。

不能因为名字“更像领域服务”就直接改依赖，否则会改变数据语义。本轮只明确文档定位；下一轮应决定删除/归档重复实现，或设计迁移并用差异回归收敛。

## 3. 现状、历史与愿景

| 范围 | 定性 |
| --- | --- |
| novel-web/BFF/works/Cell/Responses/PostgreSQL | 当前产品主线 |
| console/control-plane/dsh-shim/dsh-plugin-* | 历史治理演示，由 dev:legacy 启动；不当作当前入口 |
| Helm/TenantCell/Go CellManager | 另有实现，真实集群、drain/idle 凭据与网络/RBAC仍需验收 |
| registry高级授权与知识库联邦 | 部分纯契约/原型，未接入当前产品主线 |
| tests/poc 的锁定 CLI 与工具 | 名称虽含 PoC，仍是当前开发/真实 DSH smoke 的依赖；只归档旧文档，不删除运行依赖 |
| 单租户/单 Cell 的初始化 | 不等于永远只能有一个成员；同租户可运维补员，多租户切换仍未交付 |

## 4. 风险与后续优先级

| 优先级 | 风险 | 下一步 |
| --- | --- | --- |
| P1 | 重复作品实现及大纲映射差异 | 确立唯一实现，补差异与迁移回归后再切换 |
| P1 | 完整业务库 + Keycloak + Cell home 联合灾备未证明 | 隔离目标演练全套恢复，验证实际角色/权限/登录/历史，安排加密异地副本 |
| P1 | 共享演示管理员可以改同账号数据及获授权的管理状态 | 明确不存私密资料，定期核对配额/成员；本轮未设置自动清理或重置 |
| P2 | 默认测试仍有可选 BFF/Gateway PG 集成跳过 | 使用专用低权 LOGIN 与独立迁移连接单独跑齐，不拿默认绿灯声称零跳过 |
| P2 | 前端主 chunk 超500kB | 后续按路由/编辑器分包并测时延，不提高阈值掩盖告警 |
| P2 | legacy registry constraints 与旧 HTTP 输入校验边界 | 不开放未验证功能；若复用则补 schema、约束执行和负例 |
| P2 | 源码边界检查不覆盖依赖运行时行为 | 结合代码审查、运行沙箱和最小能力；不得把静态脚本当安全证明 |

## 5. 线上操作与验证（本轮）

2026-10-02 以已有 SSH 目标只读预检五服务健康、公开 origin/OIDC 与现行镜像版本，然后**仅新增**专用 Keycloak 用户、业务 admin 成员、subjects映射及审计。既有 owner、内容和服务配置不变。

真实浏览器于 `2026-10-02T23:41:38.768Z` 验证：HTTPS首页200、真实 OIDC 密码登录、工作台可见、BFF返回该独立用户和 `admin`、作品列表API200。公开账号见[在线演示](<../../README.md#在线演示>)。

初轮数据库预检因缺少 SCRAM 认证失败（无写入），改为容器内部读取既有密码文件后通过；首轮浏览器的 roles数组断言不符合实际 role字段，修正验证器后通过。没有修改服务来迎合测试，失败过程留在本地证据中。

**未执行**：线上模型/计费回合、作品写入、既有 owner 首次改密、服务重启恢复、镜像升级、schema迁移、完整灾备、Kubernetes。登录成功不能替代这些验收。

## 6. 本轮质量门禁

- `pnpm lint`：通过，0 warning/0 error；源码边界检查通过，188源码文件、2个已记录迁移例外。
- `pnpm typecheck`：根与前端通过。
- `pnpm test`：根1086项通过、101项跳过（67文件通过/9文件跳过）；前端181项全部通过（16文件）。
- `pnpm test:ci`：240项通过，零失败/跳过。首次复验遇到 `umask 077` 改变备份安全负例目录权限；恢复 `umask 022` 后完整通过，未改安全逻辑。
- `pnpm build:web`：通过；主 JS chunk约707.45kB（gzip约221.27kB），保留体积告警。
- 文档链接/skills专用回归4项通过；Git diff空白检查通过，本地资料/部署skill命中Git忽略，已跟踪私有目录为空。

最终门禁记录以[验收指南](<../testing/acceptance.md>)为统一更新处。门禁不额外启动线上服务或计费模型；本轮没有宣称全环境、零跳过或生产恢复验收通过。

## 7. 导航

[业务说明](<../business.md>) · [架构](<../architecture.md>) · [路线图](<../roadmap.md>) · [本地开发](<../implementation/local-development.md>) · [模块边界历史复盘](<module-boundaries-2026-10.md>) · [全部文档](<../README.md>)
