# novel-web：小说工作台

React + Vite + TanStack Query + Tiptap 的工作台，入口路径是**登录 → 书架 → 开书进入三栏工作台**：左栏书内目录（大纲、章节、设定圣经），中栏只显示被选中的大纲/章节正文/设定条目（**阅读优先、显式进入编辑**），右栏统一创作助手（会话、历史与归档）。视觉是暖白底、低饱和绿色强调的简洁样式；≥901px 可切换到“专注写作”，只隐藏目录与助手（不卸载编辑器、草稿与会话流）；≤900px 时三栏改为顶部“目录 / 正文 / 助手”切换，**三个面板保持挂载**，切换只隐藏非活动列，草稿、滚动与会话流不因此重建。组件测试与浏览器验收是两层不同证据：jsdom 测试不能当浏览器验收，本地浏览器跑过的历史记录也不保证当前提交，解读方式见 [验证方法](../testing/acceptance.md)。

## 接口与运行

- 浏览器只请求同源 `/api/v1`，路径对应 [BFF API](./bff-api.md)。不直连 DSH、不传 `tenantId/userId/actor` 身份字段；凭据只用 HttpOnly session cookie。
- 写入使用 `GET /auth/session` 返回的 CSRF token，不落 localStorage。认证模式由公开 `/auth/config` 决定；仅开发模式显示固定种子登录名，生产显示 OIDC 跳转。
- 会话归档/恢复是 `PATCH /sessions/:sessionId { archived }`，只改展示元数据；撤权仍是 `DELETE /sessions/:sessionId`，见 [BFF API](./bff-api.md) 与 [ADR 0034](../adr/0034-novel-assistant-and-session-archive.md)。
- 推荐由 BFF 同源托管前端构建产物。Vite 的 API proxy 仅用于显式配置的开发联调；BFF 的 `MYRIX_ORIGIN` 必须与浏览器实际 origin 完全一致，不能用代理规避 Origin/CSRF 校验。
- 依赖清单见 [前端 package.json](../../apps/novel-web/package.json)；根 [package.json](../../package.json) 已把前端独立 typecheck/test 纳入 `pnpm typecheck` 与 `pnpm test`。无需调整根 TypeScript JSX 配置。

```bash
pnpm --filter @myrix/novel-web typecheck
pnpm --filter @myrix/novel-web test
pnpm --filter @myrix/novel-web build
```

## 书架与书内三栏

- 书架（[WorkListPanel.tsx](../../apps/novel-web/src/panels/WorkListPanel.tsx)）是登录后唯一入口：作品网格、按书名/简介搜索、新建作品弹窗；删除需确认，并写明会撤销关联会话、删除大纲/章节/设定。
- 开书后由 [WorkspacePane.tsx](../../apps/novel-web/src/panels/WorkspacePane.tsx) 组成三栏：`BookNavigation` 常驻三节（大纲；章节列表与收起的新建；设定按人物/设定/时间线分类列表与收起的新增），中栏只显示被选中的内容，右栏是 `AssistantPanel`。
- 响应式（[styles.css](../../apps/novel-web/src/styles.css)）：≥1600px / ≤1150px 调整列宽；≥901px 的“专注写作”只对目录与助手 `display:none`，不卸载组件；≤900px 切为单列加顶部“目录 / 正文 / 助手”切换。切换只改可见性，三栏组件都不卸载（仍按 `workId` 重建），未保存草稿、事件流与滚动位置不会因切换列丢失。≤900px 下在目录里选中章节/条目后会带内容回到“正文”；未保存正文的读取方式仍以已保存版本为准。

## 阅读优先、显式编辑与修改目标

- **三个内容面板共用阅读/编辑组件**：章节、大纲、设定都经由 [Manuscript.tsx](../../apps/novel-web/src/components/Manuscript.tsx) 呈现。已保存且非空的正文默认进入**阅读态**，由 [ReadingContent.tsx](../../apps/novel-web/src/components/ReadingContent.tsx) 做安全语义排版（标题、列表、引用、代码围栏、GFM 表格；无 `rehype-raw`、无 `dangerouslySetInnerHTML`，原始 HTML 只作可见文本，图片只出文字占位，链接只放行 `http(s)://` / `mailto:` / `#锚点`）；作者点“编辑原文”才进入编辑器。空内容或已有未保存草稿（`dirty`）时默认直接进编辑，不存在“空内容只能读”的死角。
- **阅读/编辑不改变文本事实**：两种模式共享同一个 `value`，切换只改呈现，**不序列化、不改写、不触发 `onChange`**；编辑器载入与保存的始终是已存储的纯文本（Tiptap 段落 JSON ↔ 单换行纯文本，见 [PlainTextEditor.tsx](../../apps/novel-web/src/components/PlainTextEditor.tsx)）。
- **历史版本与冲突对照也先阅读**：章节历史版本、409 冲突的本地草稿与服务端版本都用 `ReadingContent` 阅读，并各自提供“查看原文”折叠出**逐字**原始文本，便于核对渲染未改变内容。
- **助手气泡区分正文与执行记录**：助手回复走同一安全排版（[ChatMessageView.tsx](../../apps/novel-web/src/components/ChatMessageView.tsx)）；工具事件默认折叠为执行记录并声明“以文稿及版本为准”，不冒充已保存正文；用户消息里自动追加的修改目标也折叠展示，气泡只保留用户真正说出的内容。
- **默认修改目标自动携带**：当前选中的章节/大纲/设定就是默认修改目标。`WorkspacePane` 把选中元数据（类型、对象 ID、标题、是否有未保存草稿）上报 `App`，再传给 `AssistantPanel`，在输入框上方以 **target chip** 常驻显示（“默认修改当前选中” / 新会话等待期间显示“本条消息目标已锁定”）。发送时由 [withSelectionContext](../../apps/novel-web/src/state/selectionContext.ts) **只**把 `kind/workId/id/title/dirty` 五个字段与“先用现有读取工具读最新已保存内容、写回时使用刚读到的 `expectedVersion`”的指令追加到消息，**绝不附带正文**；目标在 `submit`（新会话则在创建会话之前）冻结，事件流就绪后仍用同一份 frozen payload，在途回合不因切换选中而改变。目标有未保存草稿时 chip 下方提示先保存。
- 手动“章节助手上下文（查看与复制）”面板已从章节面板移除；[ChapterAssistantContext.tsx](../../apps/novel-web/src/components/ChapterAssistantContext.tsx) 独立组件与其单测仍保留在仓库中，但当前没有 UI 消费者。

## 统一创作 Agent 与历史会话

右栏只有一个助手入口（[AssistantPanel.tsx](../../apps/novel-web/src/panels/AssistantPanel.tsx)）：

- **新对话不需要选 preset**：点“+”或在空状态下直接输入第一句话，发送时才以 `novel-assistant` 创建会话。创建是异步激活的：必须等该会话的事件流真正连通（`sessionId` 匹配且 `connected`）后才发送首条消息，绝不把消息误发到别的会话；30 秒未就绪则清空待发状态、保留输入并提示重试。
- `novel-assistant` 持有现有六个小说工具全集（掩码与三个历史 preset 一样来自 [novel-protocol](../../packages/novel-protocol/src/index.ts)）；由系统提示在自然对话里判断大纲/正文/设定任务，先读后按 `expectedVersion` 保存。
- 历史 `novel-outline / novel-chapter / novel-bible` 会话仍可打开和继续使用，权限保持各自原有掩码；面板只给出“这是历史受限对话”的提示，输入框仍是同一个统一入口。
- 键盘：`Enter` 发送、`Shift+Enter` 换行；中文输入法组合（`isComposing` / `keyCode 229`）中的 `Enter` 不发送。发送在途有单飞锁，避免重复 Enter 双发；发送失败或迟到回调不发送时保留输入并提示，不静默清空。
- 历史默认收起，点历史图标展开；分“最近 / 已归档”两组。
- **归档/恢复**（`PATCH`）只是展示元数据：不撤权、不改 `status`/`rev`、不停止任务。归档期间输入框禁用、新的 send 会被服务端以 409 `session_archived` 拒绝；但历史事件仍可读、`cancel` 仍可用（正在跑的回合能停）、归档前已入队的命令照常执行，恢复后立即可以继续。归档当前会话会回到“新对话”；已归档会话在“已归档”组里可打开、可恢复。
- **永久结束对话**（`DELETE`）才是撤权：销毁运行时 Agent，之后的发送返回 410，不可恢复。
- **未保存正文不会自动发送**：输入框从不读取编辑器草稿。当前选中的章节/大纲/设定就是默认修改目标，由 target chip 常驻显示，发送时只自动追加 `kind/workId/id/title/dirty` 元数据与读取/CAS 指令（见上节“阅读优先、显式编辑与修改目标”），**不含正文**。需要助手处理本地改动时先保存章节，助手只读取服务端已保存内容；若目标有未保存草稿，chip 下方会提示先保存。切换章节不会改写输入框，也不会自动发消息。手动复制上下文的旧入口已移除。
- **工具的能力边界**：六个工具不能新建作品/章节/设定条目，也不能删除内容或读章节版本历史。需要新对象时先在左目录用 UI 建立章节/条目，再让 Agent 读取并处理；助手不得声称已创建。

## 数据与冲突

- 业务值始终是纯文本。Tiptap 使用段落 JSON 文档载入、按单换行导出，禁用富文本格式节点，保留连续空格、空行与行首尾空格。不要重新使用 HTML 字符串装载正文，否则 HTML 解析器会改变空白。阅读态使用安全 Markdown 渲染，但**存储与保存的仍是原文**，阅读/编辑切换不序列化、不改写。
- 没有 `dangerouslySetInnerHTML`；模型/工具输出由 `ReadingContent` 白名单渲染（助手消息）或 React 文本节点展示，HTML 样本按文字显示。
- 保存始终携带 `expectedVersion`。409 保留本地草稿，提供重新读取、显式采用服务端内容、以最新版本提交草稿三种动作，不静默覆盖；冲突对照默认用安全 Markdown 阅读，并可分别展开“查看原文”逐字核对。
- 目录与正文分离：目录常驻三节，中栏只显示被选中的内容，不在正文上方堆列表或表单。切换章节/设定条目会替换草稿 identity，因此有未保存草稿或正在保存时先经用户确认（拒绝即保留草稿与当前对象）；切换分区不替换 identity，草稿原样保留。`onDirtyChange` 上报书内是否有未保存草稿供顶层“返回书架”确认，卸载时归零；输入框里有未发送消息同样阻止静默离开，并在关页前触发浏览器确认。
- 队列回执明确标注“已入队，等待服务端确认”，不把 202 当作模型回复或内容已经落库。

## 流式事件：持久与瞬态分开

实现见 [chatReducer.ts](../../apps/novel-web/src/state/chatReducer.ts) 和 [useSessionStream.ts](../../apps/novel-web/src/state/useSessionStream.ts)。

1. 持久 `seq` 按单调水位去重，而非要求连续。DSH 恢复与内部事件过滤可产生合法跳跃；不枚举所有“缺号”，旧事件也不能因窗口淘汰而重新出现。
2. 只有服务端明确发出 `replay-required` 才要求补放，不由编号跳跃推断丢失。
3. `delta` 仅供临时显示。**只有持久 `assistant` 事件确认最终回复**；它替换瞬态片段，而非再追加一份。
4. 新 attempt 的 `stream-start` 先丢弃旧 attempt 未提交片段，避免重试输出前缀拼接；`stream-abandoned`、`error`、`turn-end` 和断线同样清除未确认片段。
5. 上述清理保留已持久回复及本地待回显用户消息。断线不是完成；UI 显示错误/重连状态，并指数退避重连。
6. 切换会话立即关闭旧 EventSource。取消提交成功只是命令已接受，状态仍以服务端事件为准。
7. 归档不关闭事件流：归档会话仍可订阅与续传（需要时照常触发后台恢复），历史保持可读；只有新的 send 被拒绝。

## 验证

[前端测试目录](../../apps/novel-web/tests/) 覆盖：

- HTTP：cookie/CSRF、不发送身份头、401/409/503 分类、Retry-After 与网络错误。
- reducer：持久水位/大跨度跳跃/迟到去重、delta/final、重试开始/废弃/错误/断线边界、本地消息回显与明确截断标记。
- 草稿：CAS 冲突、失败保留、明确覆盖与重提，不静默丢弃。
- 书架与书内目录：登录→书架→开书、首开建议（有章节选第一项，否则留在大纲）、分区/条目切换的确认与草稿保留、新建回包迟到不抢用户选择、`onDirtyChange` 通知。
- Agent：只有一个统一入口（没有 preset 网格）、首条消息等会话流就绪并冻结目标、Enter/`Shift+Enter`/IME、历史默认收起与归档分组、归档只读与恢复、草稿保留与在途修改、安全渲染与持久状态。
- 修改目标：[selectionContext.test.ts](../../apps/novel-web/tests/selectionContext.test.ts) 断言只投影 `kind/workId/id/title/dirty`、不含正文、六个工具名逐字正确、目标不授予任何权限；[ChatMessageView.test.tsx](../../apps/novel-web/tests/ChatMessageView.test.tsx) 断言助手走语义排版、工具默认折叠、目标上下文折叠、用户正文不被上下文污染。
- 阅读/编辑：[Manuscript.test.tsx](../../apps/novel-web/tests/Manuscript.test.tsx) 断言空/脏默认编辑、已保存非空默认阅读、切换不序列化且不触发 `onChange`；[ReadingContent.test.tsx](../../apps/novel-web/tests/ReadingContent.test.tsx) 断言安全 Markdown 白名单与 HTML 只作文本；[ChapterEditorContext.test.tsx](../../apps/novel-web/tests/ChapterEditorContext.test.tsx) 断言不再有手动复制入口、历史版本以阅读排版 + “查看原文”展示。
- 编辑器：纯文本往返、空白保留、HTML 样本不注入、只读与外部同步。

命令见上文“接口与运行”。组件测试的具体数量随代码演进变化，不作为当前版本可用的证明；浏览器与模型闭环见 [验证方法](../testing/acceptance.md) 的“浏览器与模型闭环”。jsdom 固定在 `^29.1.1` 以兼容当前 Node 24.13 基线（见[前端 package.json](../../apps/novel-web/package.json)）。

## 不构成保证的部分

- **本地浏览器不等于线上模型闭环**：本轮已用真实本地 Chromium 检查 1440px/390px 阅读/编辑切换、target chip、专注写作、原文保真、切栏草稿保留与无横向溢出；[作者体验验收](../../tests/acceptance/author-ui.mjs) 和 [业务浏览器验收](../../tests/acceptance/local-browser.mjs) 可复现，不调用模型。计费六工具回合、线上 OIDC、历史归档与恢复仍须在目标发布版本独立验收；不把 jsdom、模型替身 smoke 或本地编辑成功当成公网模型成功，见 [验证方法](../testing/acceptance.md)。
- **未实现的能力**（不要按现状描述）：自动保存与本地草稿恢复（不使用 `localStorage`/IndexedDB 持久化草稿）；章节/条目重命名；富文本格式工具栏；本轮没有运行任何计费的真实模型回合。
- ≥20 万字单文档编辑性能；当前全量加载/替换。
- 编辑器代码分割和大包加载优化。
- 外部 OIDC 身份提供方及真实模型凭据。
