# v0.1 本地开发与验收

本文描述当前持久化开发装配，不是历史内存控制面或模型 mock。历史首版记录不能作为当前提交的验收保证；验证层级、复现方法与未验收边界见[验收指南](<../testing/acceptance.md>)。模块测试或单独的供应商探测不能替代整条链路验收。

## 1. 前提与边界

- Node.js 24 系列（根包允许 `^22.19.0 || >=24.0.0`；本轮环境为 24.13.0）、pnpm 10.33.0、Docker Compose。
- 上游源代码只读，锁定提交 `639ed015397290b3745d163aafe02ffee4aa3f84`。实际 CLI 使用 npm `@deepseek-ai/dsh@0.2.0-rc.2`；版本相同**不能证明** npm 产物与该提交逐字节一致。
- PostgreSQL 17 仅绑定 `127.0.0.1:55439`，开发数据库为 `myrix`。不要使用本机其他 PostgreSQL 端口或既有业务数据库。
- 浏览器入口为 `http://127.0.0.1:8787`。不能用 `localhost` 或别的 Origin 混用认证 Cookie/CSRF。
- 这是本机开发模式，不是生产 OIDC 或真实 Kubernetes 部署验收。

## 2. 安装与显式初始化

在仓库根目录运行：

```bash
git submodule update --init --recursive vendor/deepseek-harness
pnpm install --frozen-lockfile
pnpm --dir tests/poc/.dsh-install install --frozen-lockfile

docker compose -f deploy/compose.dev.yml up -d --wait postgres
MYRIX_MIGRATE_DATABASE_URL='postgres://myrix_migrator:myrix_local_migrator@127.0.0.1:55439/myrix' pnpm setup:dev
pnpm build:web
```

锁定 CLI 安装的 hoisted/peer 设置见 [依赖清单](<../development/runtime-dependencies.md>)。开发装配和运行时 PoC 共用这份独立安装，但不能因此把 stub PoC 当成真实模型验收。

`setup:dev` 是唯一显式执行迁移、种子身份和专用 LOGIN/Cell 凭据登记的开发入口。不要在开发栈运行中执行初始化。普通 `pnpm dev` 不需要、更不会运行迁移。

初始化产生本地开发运行配置 `data/dev-runtime.json`（含密钥，不入库、不公开链接），文件权限必须为 `0600`。重复初始化复用其中的签名密钥、独立数据库 LOGIN 和两个 Cell 的令牌；目标数据库或权限不匹配则拒绝覆盖。不要手动删除此文件来“修复”已有数据：重新生成身份凭据不是数据恢复操作。

## 3. 模型配置：仅 Responses

从 [配置模板](<../../.env.example>) 新建本地 `.env`，设置权限 `0600`，填入供应商密钥。不要提交该文件、在命令行参数中粘贴密钥或把密钥发给 Cell。

```dotenv
MYRIX_GATEWAY_UPSTREAM_URL=https://api.example.com/v1/responses
MYRIX_GATEWAY_UPSTREAM_MODEL=your-responses-model
MYRIX_GATEWAY_UPSTREAM_API_KEY=替换为自己的密钥
MYRIX_MODEL_CONTEXT_WINDOW=65536
```

上述地址和模型是占位符，必须换成自己的供应商，并验证 Responses 接口、真实模型 ID 与上下文容量。模型别名不能独立证明底层模型的版本。

两个 URL 的语义不同，不能互换：

| 配置位置 | URL 形状 | 请求目标 |
| --- | --- | --- |
| Cell 适配器 `baseURL` | `http://127.0.0.1:8790/v1` | 适配器追加 `/responses` |
| 网关 `MYRIX_GATEWAY_UPSTREAM_URL` | 完整 `https://供应商/v1/responses` | 网关直接请求该端点 |

**本项目不允许 `chat/completions`，没有兼容入口、协议转换或失败回退。** 路径错误会在配置校验或调用时显式失败。仅能列出模型、或另一个客户端能调用，不能证明该服务实现了 `/v1/responses`。

供应商探测应分别检查非流式、流式终态、函数调用和真实用量字段；单独的 HTTP 200 不是 Myrix 全链路通过的证明。历史供应商探测记录不公开分发，也不能替代你自己的上游验收。

## 4. 启停与数据归属

```bash
pnpm dev
```

启动器先验证私有配置、模型上下文、前端构建、Cell 部署映射和空闲端口，再启动：

| 服务 | 本地地址 | 可持有的敏感配置 |
| --- | --- | --- |
| BFF / 浏览器 | `127.0.0.1:8787` | 业务/认证低权限 LOGIN、签名私钥、Cell 管理令牌 |
| works / binding snapshot | `127.0.0.1:8791` | 与 BFF 同进程，验证 Cell 与六字段绑定 |
| 模型网关 | `127.0.0.1:8790` | 业务/计量低权限 LOGIN、上游密钥 |
| Cell 1 / Cell 2 | `127.0.0.1:7801` / `7802` | 各自服务令牌与验证公钥，不含数据库/上游/签名私钥 |

启动器不继承任意父进程环境：只保留操作系统必要项及各服务显式白名单，剔除 `NODE_OPTIONS`/`NODE_PATH` 等注入项。不要在启动器的环境之外用 shell 手工拼接整个环境给 Cell。

- Cell 数据目录位于 `data/cells/cell-dev-1` 和 `data/cells/cell-dev-2`；正常重启必须复用它们，不清空会话。
- 子进程日志位于 `data/dev-logs`，文件为 `0600`。日志可能包含应用内容，只用于本机排障，不应整目录上传。
- 前端不是热更新开发服务器。修改前端后先停止开发栈、执行 `pnpm build:web`、再启动并刷新页面；BFF 在启动时登记构建资源，运行中重建会使新哈希资源未登记而返回 404。
- 使用 Ctrl+C 或 SIGTERM 正常停止。启动阶段取消、健康检查失败或任一子进程异常退出会触发清理；关闭会等待退出，超时才升级为强制终止。
- 独占锁为 `data/dev-runtime.lock`。若上次协调进程被 SIGKILL，先检查锁中 PID、相关子进程和端口，再手动处理残留锁；启动器不会猜测、覆盖锁或停止未知进程。
- 不要执行 `docker compose down -v` 或删除 `data` 来解决普通启动问题；这些操作会损失数据库或运行时历史。

## 5. 工作台使用路径

1. 打开 `http://127.0.0.1:8787`，以“作者 author”登录；只有明确开启的 loopback 开发模式才显示种子身份按钮。登录后先到**书架**，新建并打开一个作品。
2. 开书后是**三栏工作台**：左栏书内目录（大纲 / 章节 / 设定圣经）、中栏阅读/编辑区、右栏统一创作助手。在左目录新建章节与人物/设定/时间线条目；中栏已保存且非空的正文默认**阅读**排版，点“编辑原文”才进入编辑器，空内容或已有未保存草稿时直接进编辑。保存采用版本号 CAS；冲突时保留本地草稿，不静默覆盖服务端新版本，并可展开“查看原文”逐字核对双方原文。宽屏（≥901px）可用“专注写作”只隐藏目录与助手，编辑器与草稿不卸载。
3. 右栏只有一个“新对话”，**不需要选择助手类型**：输入第一句话并发送即创建 `novel-assistant` 会话；首条消息在该会话流连通后才发出。当前选中的章节/大纲/设定就是默认修改目标，输入框上方的 target chip 会常驻显示；发送时只自动追加对象类型、ID、标题与“是否有未保存草稿”，目标在发送瞬间冻结，在途回合不因切换选中而改变。窄屏（≤900px）顶部出现“目录 / 正文 / 助手”切换，三栏保持挂载，草稿与事件流不因切换丢失，在目录里选中条目会带内容回到“正文”。
4. 六个工具**不能新建**作品/章节/设定条目，也不能删除内容或读章节版本历史：需要新对象时先在左目录用 UI 建立，再让 Agent 读取并处理。历史 `novel-outline / novel-chapter / novel-bible` 会话仍可打开，各自保持原有收窄掩码。
5. 历史对话默认收起，可在“最近 / 已归档”间切换。“归档”（`PATCH /sessions/:id`）只是整理记录：不撤权、不停止任务、历史仍可读、取消仍可用，归档期间只拒绝新的发送（409 `session_archived`），恢复后继续；“永久结束对话”（`DELETE`）才是撤权，撤销后发送 410。
6. 模型工具只在所属 preset 的子树注册，且需有效主体、当前作品/成员绑定与未过期授权快照；网络或策略缺失都拒绝执行。“取消”只请求取消本页记住的最近命令，不把刷新后未知的命令假装取消成功。
7. 用独立浏览器上下文登录“编辑 editor”或“其它租户 other-tenant”，不能读取作者作品。管理员也不绕过内容单属主规则。

### 修改目标：自动携带元数据，不自动发送正文

在中栏选中章节/大纲/设定后，输入框上方的 **target chip** 会显示“默认修改当前选中”和对象标题；若该对象有未保存草稿，chip 下方提示助手只读已保存版本。

1. 需要助手处理本地改动时，先正常保存。未保存草稿不会被读取或发送，助手只能读取服务端已保存内容；发送时自动追加的只有 `kind/workId/id/title/dirty` 五个字段与“先读最新已保存内容、再用刚读到的 `expectedVersion` 写回”的指令。
2. 目标在**发送瞬间冻结**：点发送（新对话则在创建会话之前）就固定本次目标，事件流就绪后仍用同一份 payload；在途回合中切换章节/条目不会改变它的修改目标。
3. 参数说明：目标只在发送时随消息上下文进入该次请求，不是授权，也不会扩大六个工具的权限；Agent 仍须先用现有工具读取最新已保存内容，再按 `expectedVersion` CAS 写回，不能凭记忆或旧快照写入。
4. 中栏换章节/条目不会改写输入框，也不会自动发消息；若在发送前换了对象，chip 会随之更新为新目标。
5. 工具完成后，干净编辑器从服务端刷新已保存正文与版本；如果本地已有未保存修改，会保留草稿并提示服务端有更新，不用模型回复正文直接替换编辑器。

旧的“章节助手上下文（查看与复制）”手动复制面板已从界面移除；其独立组件与单测仍保留在源码中，但当前没有 UI 消费者。

上述入口已通过真实本地 Chromium 的 1440px/390px 阅读/编辑切换、target chip、专注模式与切栏草稿保留验收。组件测试、浏览器与真实模型的证明边界见 [验收指南](<../testing/acceptance.md>)；不把源码或 jsdom 结果当作浏览器验收。

## 6. 自动检查与真实浏览器验收

**脚本状态**：[business-journey.mjs](<../../tests/acceptance/business-journey.mjs>)、[local-browser.mjs](<../../tests/acceptance/local-browser.mjs>) 已适配阅读优先流程；新增 [author-ui.mjs](<../../tests/acceptance/author-ui.mjs>) 覆盖语义阅读、原文保真、快捷保存、目标提示和桌面/手机草稿保留。本轮真实本地无模型浏览器已通过；生产 OIDC 和真实计费模型须分别验收。

```bash
pnpm typecheck
pnpm test
pnpm build:web
pnpm exec playwright install chromium --only-shell

# 先启动真实开发栈，再运行；不会拦截 HTTP 或替换模型
pnpm test:browser
pnpm test:browser:ui # 1440px/390px 作者体验与截图，不发送模型请求

# 显式启用一次模型创作回合（可产生多次工具往返/供应商计费）
MYRIX_ACCEPTANCE_MODEL=1 pnpm test:browser
```

[浏览器验收脚本](<../../tests/acceptance/local-browser.mjs>) 用独立 Cookie jar 检查登录、创建作品、大纲保存/刷新持久化（保存后先断言阅读排版返回值，再点“编辑原文”核对原文）、双窗口 CAS 409 与草稿保留、章节正文及版本历史、人物/设定/时间线三类条目的创建修改检索，以及同租户非属主 403 和跨租户 404。这是脚本覆盖范围，不代表当前修订已经运行通过；实际成功范围及仍待验证事项见 [验收指南](<../testing/acceptance.md>)。开启模型模式后，要求真实模型调用 `get_outline` / `update_outline`，等待非空持久助手正文与持久 `turn-end`，随后直接读取 BFF 数据确认保存；工具调用消息、空助手泡或助手声称“已保存”都不能替代这些证据。

结果和截图保存到 `data/acceptance/browser-*/`，不会保存 Cookie/浏览器 storageState、上游密钥或抓包文件。每次新建单独的验收作品并保留供检查，不删除已有业务作品。

### 无跳过的 PostgreSQL 门禁

不配置数据库变量的 `pnpm test` 会跳过可选的 PG 集成测试，不能据此声称完整门禁通过。以下使用独立的预配置验收库与两个账号：迁移账号负责建表，应用账号必须为真实 LOGIN、非 owner、NOSUPERUSER、NOBYPASSRLS，且已获测试表所需权限。不能把 URL 指向正常使用的 `myrix` 业务库。网关的迁移连接还需有创建/清理专用随机测试库与角色的权限；只允许用于专用本地测试 PostgreSQL。

```bash
pnpm typecheck
BFF_TEST_DATABASE_URL='postgres://myrix_bff_test:myrix_local_bff_test@127.0.0.1:55439/myrix_bff_acceptance' \
BFF_TEST_MIGRATION_DATABASE_URL='postgres://myrix_migrator:myrix_local_migrator@127.0.0.1:55439/myrix_bff_acceptance' \
MYRIX_GATEWAY_TEST_DATABASE_URL='postgres://myrix_migrator:myrix_local_migrator@127.0.0.1:55439/myrix_bff_acceptance' \
pnpm test
```

以上连接仅示范专用本地夹具，账号和库必须事先按测试要求建立，不能据此假定初始化器已经创建它们。每次记录实际通过/失败/跳过数量；历史测试数字不作为当前门禁保证。

### 修改目标的真实模型验收（显式 opt-in）

[chapter-context-browser.mjs](<../../tests/acceptance/chapter-context-browser.mjs>) 已移除旧的手动复制路径，适配当前 target chip、阅读优先和自动追加的五字段元数据；保留原文不外传、持久回显、读后 CAS 写回、独立 GET 与非目标章节不变检查。已做语法与 opt-in 拒绝检查，**本轮未运行计费模型闭环**，不能把历史结果当作本轮通过证据。

获明确授权后，在真实本地开发栈运行 `MYRIX_ACCEPTANCE_MODEL=1 node tests/acceptance/chapter-context-browser.mjs`。与其他模型验收串行、各用独立限流窗口，会产生供应商费用。创建会话和等待连接期间的冻结由确定性组件测试覆盖，不以请求拦截伪造真实事件流。

### 章节与设定公共 HTTP 验收

另外串行运行章节与设定的真实模型工具验收（需要新的限流窗口，也会产生供应商费用）：

```bash
MYRIX_ACCEPTANCE_MODEL=1 node tests/acceptance/novel-tools.mjs
```

[章节/设定验收脚本](<../../tests/acceptance/novel-tools.mjs>) 要求模型先读取再 CAS 写入，独立查询正文、版本和章节历史，并确认撤权 204 / 撤权后发送 410。没有显式 opt-in 时在联网前退出。报告保存在 `data/acceptance/novel-tools-*/`；这是 HTTP 工具验收，不代替前端选择章节和传递上下文的体验验证。

验收层级应分别报告：纯函数/HTTP mock 测试、真实低权限 PostgreSQL LOGIN、真实 DSH + 外部 stub、供应商 API 探测、完整真实模型浏览器链路。Kubernetes、生产 OIDC 和运行时进程重启恢复需另外验收，不能由浏览器刷新推断。

## 7. 双租户会话与真正的进程重启

[会话生命周期验收](<../../tests/acceptance/session-lifecycle.mjs>) 使用真实开发认证、BFF、两个 Cell 和模型；不读私有配置，不直写 SQL。显式开启会产生供应商费用。它为两个租户各创建预设会话（脚本当前仍用历史三 preset），不删除已有作品。

```bash
# 开发栈正在运行时：保存两个真实模型回合及原始持久游标
MYRIX_ACCEPTANCE_MODEL=1 node tests/acceptance/session-lifecycle.mjs prepare

# 记下输出目录；正常停止 pnpm dev 后重新 pnpm dev，再验证：
MYRIX_ACCEPTANCE_MODEL=1 node tests/acceptance/session-lifecycle.mjs verify data/acceptance/sessions-实际运行号/manifest.json
```

两套验收不要并行运行：BFF 保留每 IP 每分钟 120 次的限流；若上一套请求尚在同一窗口，应按 `Retry-After` / `X-RateLimit-Reset` 等响应头等待窗口恢复，不要提高或关闭安全限制来让测试通过。

生命周期脚本仅对明确的 `409 session_not_active` 和 `503 session_reopening` 进行有界退避，整个订阅仍受 180 秒期限约束；普通 503、403 或 502 必须失败，不能借重试掩盖故障。

第二阶段要求两个 Cell 的 boot ID 均已改变，重放原来的用户/助手消息，使用旧游标续传新的模型回合，最后撤销全部验收会话并断言后续消息返回 410。单靠再次调用实时 API、浏览器刷新或伪造 boot ID 不能通过。报告不保存 Cookie、CSRF 值或模型密钥；当前实际通过状态以 [验收指南](<../testing/acceptance.md>) 为准。
