# 验证方法与证据边界

## 如何解读状态

历史本地 v0.1 记录报告过：真实 Responses 六工具、双租户 Cell 进程重启与持久重放、浏览器编辑/CAS/章节上下文闭环。原始日志和报告已本地归档，**不是当前提交或公网演示的保证**。本次文档整理的实际检查结果在[项目复盘](<../reviews/project-review-2026-10.md>)中区分记录；不要抄旧测试数量作为当前结果。

| 层级 | 运行方式 | 能证明 / 不能证明 |
| --- | --- | --- |
| 静态与模块测试 | `pnpm lint && pnpm typecheck && pnpm test` | 类型、边界、单元与 HTTP fixture；PG 可选项可能跳过 |
| 装配契约 | `pnpm test:ci` | CI、容器、VPS、认证工厂、profile 契约；不是启动线上容器 |
| Web 构建 | `pnpm build:web` | 前端可构建；不是浏览器功能验收 |
| 真实 PG | 专用库与真实低权限 LOGIN | RLS、事务、幂等、迁移；不能由超级用户代替应用账号 |
| 真实 DSH + stub | 下方运行时 smoke | 真实装配与执行；作品/模型替身不是真实供应商 |
| 真实浏览器 + 模型 | 显式 opt-in、先启动开发栈 | 持久终态、工具写入与 UI；不能代替生产 OIDC |
| 部署/恢复 | 自部署现场操作 | 须在目标环境单独验收，不能由 mock 推断 |

## 默认门禁

在仓库根目录运行：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:ci
pnpm build:web
```

Go 路线另外运行 `go -C apps/cell-manager test ./...` 和 `go -C apps/cell-manager vet ./...`；这也不是 Kubernetes 集群验收。缓存/临时目录策略见[模块评审](<../reviews/module-boundaries-2026-10.md>)。

### 本轮执行结果（2026-10-02）

| 门禁 | 实际结果 |
| --- | --- |
| `pnpm lint` | 0 warning / 0 error；边界检查188源码、2个已记录迁移例外 |
| `pnpm typecheck` | 根项目与 novel-web 均通过 |
| 根 Vitest | 67文件通过、9文件跳过；1086项通过、101项跳过 |
| novel-web Vitest | 16文件、181项全部通过 |
| `pnpm test:ci` | 240项通过，0失败、0跳过；包含文档/skills回归4项 |
| `pnpm build:web` | 142模块构建成功；JS约707.45kB / gzip221.27kB，CSS约7.35kB；保留 >500kB chunk 告警 |
| 文档与私有边界 | 链接检查、Git空白检查通过；私有资料无已跟踪文件，Git/Docker排除回归通过；61份归档 SHA-256 一致 |

根测试跳过涉及可选 BFF/Gateway PostgreSQL 集成及部分存储前置；本机 platform-store 的 PG 集成32项已运行通过，不把局部 PG 成功描述为所有数据库集成都已执行。根套件已运行网关适配器的真实 DSH + 模型替身 smoke（3项通过）；独立 PoC/完整 Cell/小说六工具 smoke 脚本、Go/Helm/真实集群以及真实模型/恢复未在本轮重跑。

一次完整门禁中，日志保护用的 `umask 077` 使备份负例所创建的 `0755` 目录实际变为 `0700`，导致“宽权限输出应拒绝”断言不成立。恢复正常测试环境 `umask 022` 后完整 CI 240项通过；未修改生产备份逻辑或该安全测试。日志文件仍单独保持 `0600`。

### PostgreSQL

使用独立验收 PostgreSQL，不指向开发业务库、演示或生产库。按[CI 配置](<../../.github/workflows/docker.yml>)和相应测试准备库、角色及授权：

- `BFF_TEST_DATABASE_URL`：真实非 owner、NOSUPERUSER、NOBYPASSRLS 的应用 LOGIN。
- `BFF_TEST_MIGRATION_DATABASE_URL`：只供验收建表的迁移连接。
- `MYRIX_GATEWAY_TEST_DATABASE_URL`：网关专用验收连接；相关测试需要创建和清理随机测试库/角色的权限。
- platform-store 的固定 loopback 测试夹具可能在本机 PG 存在时运行，不能将所有数据库测试都理解为由上述变量统一控制。

缺少前置时明确报告跳过，不关闭 RLS、不把管理员连接传给运行服务来“跑绿”。具体夹具以[存储测试](<../../packages/platform-store/tests/>)、[BFF 测试](<../../apps/bff/tests/>)和[网关 PG 测试](<../../apps/model-gateway/tests/pg/>)为准。

### 真实运行时，但模型是替身

先安装[独立锁定运行时](<../development/runtime-dependencies.md>)，再串行运行：

```bash
node tests/poc/run-poc.mjs
node tests/poc/run-cell.mjs
node plugins/myrix-novel/tests/smoke/novel-cell-smoke.mjs
```

后者见[小说工具 smoke](<novel-smoke.md>)。不要把私有 Cell home、编译临时文件或带内容的 JSONL 当作公共文档提交。

## 浏览器与模型闭环

先按[本地指南](<../implementation/local-development.md>)启动真实栈，再安装测试浏览器：

```bash
pnpm exec playwright install chromium --only-shell
pnpm test:browser

# 下列命令会调用真实模型并产生费用；需操作者明确同意，逐个运行
MYRIX_ACCEPTANCE_MODEL=1 pnpm test:browser
MYRIX_ACCEPTANCE_MODEL=1 node tests/acceptance/chapter-context-browser.mjs
MYRIX_ACCEPTANCE_MODEL=1 node tests/acceptance/novel-tools.mjs
```

验收必须独立读取业务数据确认保存，同时看到持久助手正文及 `turn-end`；HTTP 202、工具气泡、模型声称“已保存”都不够。冲突保留草稿，跨租户/非属主拒绝，撤权后不能继续发送。未保存章节不会自动发送给模型。

跨进程恢复用[生命周期脚本](<../../tests/acceptance/session-lifecycle.mjs>)：先 `prepare`，记录私有输出目录；正常停止并重启开发栈后 `verify <manifest路径>`。必须证明两个 Cell boot ID 已改变、旧历史可重放、旧游标可续传并能撤权，不以刷新浏览器代替重启。

以上脚本各自创建测试作品并保留证据，默认不删除已有作品。串行运行，遵守限流响应头，不提高/关闭安全阈值。报告位于忽略的运行数据目录，不保存 Cookie、密钥或浏览器 storageState；对外只给脱敏摘要。

## 公网演示和自部署

[README 的演示地址与专用公开账号](<../../README.md#在线演示>)由维护者授权。2026-10-02 通过既有 SSH 确认目标后新增专用工作台管理员、OIDC 主体映射及审计；保留既有账号和服务配置。随后真实浏览器通过 HTTPS 首页、OIDC 密码登录、工作台可见、服务端 `admin` 身份和作品列表 API 检查。**未创建作品、未调用模型、未重启服务、未演练恢复**。此前通用网页抓取工具受限不构成成功证据；本结论来自随后独立执行的浏览器检查。现场脚本与原始证据仅本地留存。

自部署必须逐项验证 TLS/Nginx、OIDC discovery/首次改密、身份预登记、真实模型工具写入、重启持久化、额度拒绝和联合恢复。备份脚本的 mock 回归、局部数据库恢复夹具不是完整 Keycloak + 数据库 + Cell 卷恢复验收。步骤见[自部署](<../deployment/self-hosting.md>)与[备份恢复](<../deployment/backup-restore.md>)。
