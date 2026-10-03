# ADR-0017：小说工具的作品访问边界

状态：HTTP/客户端边界已实现；运行时插件装配已实现并有可复现冒烟（[novel-runtime.md](../implementation/novel-runtime.md)、[小说工具 smoke](../testing/novel-smoke.md)）。真实模型工具回合与 PostgreSQL 并发验收的方法与证据边界见[验证方法](../testing/acceptance.md)；历史本地通过记录不保证当前提交。

## 决策

1. 对模型只暴露六个工具：get_outline、update_outline、get_chapter、save_chapter_draft、search_bible、update_bible_entry。工具参数中不接受 tenantId/userId/workId/sessionId、URL、凭据或任意附加字段。
2. Principal 来自运行时可信绑定；工具客户端只读取 sessionId 与当前撤权 revision。目标作品与 owner 由作品服务查数据库取得，不能由 Cell 或模型自行声明。chapterId/entryId 仍须属于该作品，而非仅属于同一用户。
3. 内部接口为 `POST /internal/v1/sessions/:sessionId/tools/:tool`，Bearer Cell 服务凭据，`x-myrix-revision` 为撤权版本。请求正文只有工具参数，响应 `{ result }`。CAS 冲突 HTTP 409 仍包含 `{ result: { status: "conflict", version } }`，不得伪装保存成功。
4. 凭据显式绑定单 tenant + cell；至少 32 字符，进程中索引只存 SHA256。凭据无默认值、不接受跨 Cell 共用；本版静态配置由部署生成，轮换需重装配。内部 listener 不发布到公网入口。
5. 每次调用：设置事务本地 tenant → 读取并 share-lock 会话绑定、成员及租户 → 校验 Cell、active 状态与新鲜撤权版本 → governance.authorizePlatform → preset 工具白名单 → 设置数据库 actor → 在**同一事务和同一连接**内执行资源授权与 CAS。禁止“先查权限，再另开事务写内容”。成员禁用/会话撤权需要等待已获锁的合法操作完成，或者先提交后让新操作被拒绝。
6. `TransactionBoundStore` 只复用当前授权事务，任何 tenant/actor 切换都拒绝。它不继承后台服务能力，普通工具不能入队任意命令、激活会话或写系统 outbox。
7. BFF 普通内容访问继续使用相同仓储治理规则：单一所有者，admin 无正文越权。外层工作 ID 与章节/设定的数据库 workId 必须一致。
8. 服务错误只输出明确的业务拒绝原因；未知错误统一 503。客户端禁止重定向、限制请求时间与响应体，传递取消信号，不向模型暴露内部响应错误正文。

## v0.1 适配约定

- 浏览器大纲为纯文本，存入 OutlineDocument.synopsis，chapters 为空；后续引入结构化大纲需升级 API，而不能让 UI 静默丢弃结构化字段。
- 浏览器设定 kind=setting 映射存储 concept；存储其他扩展类目读回 setting。title/text 对应 name/summary。
- 写入必须带刚读到的 expectedVersion；body hash 由作品仓储计算，相同父版本+同内容重试 duplicate，版本不匹配 conflict。客户端不得强制覆盖。
- novel-outline：get_outline/update_outline/search_bible。
- novel-chapter：get_outline/get_chapter/save_chapter_draft/search_bible。
- novel-bible：get_outline/get_chapter/search_bible/update_bible_entry。

## 验证边界

`plugins/myrix-novel/tests/client.test.ts` 覆盖参数注入、版本格式、固定服务地址、凭据/版本传递、冲突保留、输出限额、错误保密；`apps/bff/tests/works-server.test.ts` 覆盖 HTTP 参数、未知工具、版本越界、错误与凭据映射。它们使用 HTTP/executor double，**不证明 RLS、数据库权限或并发撤权安全**；必须追加真实非 owner PostgreSQL 登录的集成测试。

### 运行时装配（本版新增，见 `docs/implementation/novel-runtime.md`）

`plugins/myrix-novel/src/index.ts` 是真实 Cordis function plugin（具名 `name`/`inject`/`apply`，无 default export），
`plugins/myrix-novel/src/preset-tools.ts` 是被三个 preset 各自装载的子插件。已实测（真实锁定 DSH `0.2.0-rc.2` = vendor `639ed01`）：

- `npx tsc -p plugins/myrix-novel/tsconfig.json` 干净；`npx vitest run plugins/myrix-novel` → 4 文件 / 44 项通过（含原有 6 项客户端测试）。
- `node plugins/myrix-novel/tests/smoke/novel-cell-smoke.mjs` → `dsh exit=0`，7/7 探针通过。实测：`ctx.novelStore` 已提供；三个 preset 进 roster 且 `broken` 为空；**根作用域小说工具数为 0**；各 preset 可见工具与 `PRESET_TOOLS` 一致；`get_outline` 经真实 HTTP 到达作品服务（`x-myrix-revision`、`Bearer` 凭据正确）并回传结果；提示注入了服务端绑定的 `workId`。
- 身份只从 `ToolRunContext.agent` 经 `principals.require()` 取得；撤权后同一 Agent 立即被拒；未安装活性提供者时以 `liveness-unavailable` 拒绝（fail-closed）。
- 实测补充：`dsh-tools@0.2.0-rc.2` 的 `register()`/`execute()` **不校验模型实参**（多余字段、`expectedVersion:-5` 均会到达工具），因此决策 1 的"参数不接受附加字段"由 `execute` 内的 `parseToolArguments()` 强制执行，而非依赖 schema。

综上，本 ADR 决策 1、2 的 DSH 侧装配路径**已实现并实测**；决策 3–8 的 HTTP/客户端与作品服务侧仍按其自身测试为准。

尚待验证（不得计为通过）：真实模型的工具回合与归因/限额/取消、浏览器完整闭环、`bundles/myrix-base` 的 `myrix-novel` 行与 `MYRIX_WORKS_TOKEN` 注入、preset 默认路由接入、持久化恢复、凭据轮换与集群 NetworkPolicy。未验证项不得计为 Phase0/P1–P8 通过。
