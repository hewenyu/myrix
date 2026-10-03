# 工作台 UI 设计标准

本文件是 `apps/novel-web`（当前唯一现网 UI）与后续作者界面的共享设计标准：**作者任务优先、信息分层、文本保真、状态诚实**。
它约束“怎么做界面”，不重复业务事实与接口契约；业务对象与权限见[业务说明](<../business.md>)，模块与调用链见[novel-web 实现](<../implementation/novel-web.md>)，证据层级见[验证方法](<../testing/acceptance.md>)。
配套操作指引是 [myrix-ui-design skill](<../../.agents/skills/myrix-ui-design/SKILL.md>)。

规范用语：**必须**（违反即缺陷）、**应该**（偏离需在 PR 说明理由）、**可以**（可选）。本文件同时标注“标准”与“当前实现状态”，两者不得混写。

## 0. 规范与实现状态分开

**标准**是长期目标，**实现状态**只描述被检查过的那一次工作区，二者不能互相证明。任何“已实现”结论必须有源码或测试证据；任何没有证据的说法一律写“未实现/未验证”。

当前实现状态：阅读优先改版已做源码、组件测试和真实本地 Chromium 验收（1440px 桌面、390px 手机）。`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm test:ci`、`pnpm build:web` 已执行；具体范围与未执行层级见[验证方法](<../testing/acceptance.md>)。本表不把本地测试等同于真实计费模型、线上部署或灾备恢复：

| 标准条目 | 当前实现状态 | 证据 |
| --- | --- | --- |
| 安全 Markdown 阅读组件（无 HTML 解析、无远程图片） | 已实现：标题/列表/引用/代码围栏/GFM 表格白名单，原始 HTML 只作可见文本，图片只出文字占位，链接 fail-closed | [ReadingContent.tsx](../../apps/novel-web/src/components/ReadingContent.tsx)、[ReadingContent.test.tsx](../../apps/novel-web/tests/ReadingContent.test.tsx) |
| 阅读排版样式 | 已实现并在真实本地浏览器检查：`styles.css` 新增 `manuscript` / `reading-content` / `version-reading` / `comparison-reading` / `tool-activity` / `sent-context` / `composer-target` / `is-focused` 规则 | [styles.css](../../apps/novel-web/src/styles.css) |
| “默认阅读、显式编辑”组件 | 已实现：[Manuscript.tsx](../../apps/novel-web/src/components/Manuscript.tsx) 阅读/编辑切换，空内容或已有未保存草稿默认进编辑，切换只改呈现、不序列化也不触发 `onChange` | [Manuscript.tsx](../../apps/novel-web/src/components/Manuscript.tsx)、[Manuscript.test.tsx](../../apps/novel-web/tests/Manuscript.test.tsx) |
| 章节/大纲/设定面板的阅读态 | 已实现：三面板都改用 `Manuscript`，已保存且非空正文默认阅读 | [ChapterPanel.tsx](../../apps/novel-web/src/panels/ChapterPanel.tsx)、[OutlinePanel.tsx](../../apps/novel-web/src/panels/OutlinePanel.tsx)、[BiblePanel.tsx](../../apps/novel-web/src/panels/BiblePanel.tsx) |
| 空内容仍可编辑 | 已实现：空内容默认进入编辑，保存只受 dirty/saving 约束 | `Manuscript` 初始 `editing` 取“文本为空或有未保存草稿” |
| 随消息追加目标 id/title/dirty、发送时冻结 | 已实现：`withSelectionContext` 只投影 `kind/workId/id/title/dirty`，在 `submit` 时捕获；新会话在创建会话之前冻结 target/payload，事件流就绪后沿用同一份 frozen payload，不含正文 | [selectionContext.ts](../../apps/novel-web/src/state/selectionContext.ts)、[selectionContext.test.ts](../../apps/novel-web/tests/selectionContext.test.ts)、AssistantPanel `submit` / `firstMessage` |
| composer 常驻 target chip | 已实现：输入框上方常驻“默认修改当前选中 / 本条消息目标已锁定”与对象标题，目标 dirty 时提示先保存 | AssistantPanel `composer-target`；[styles.css](../../apps/novel-web/src/styles.css) |
| 工具记录默认折叠 + 诚实状态 | 已实现：`details.tool-activity` 默认折叠，声明“以文稿及版本为准” | [ChatMessageView.tsx](../../apps/novel-web/src/components/ChatMessageView.tsx)、[ChatMessageView.test.tsx](../../apps/novel-web/tests/ChatMessageView.test.tsx) |
| 助手消息、历史版本与冲突对照的安全阅读 | 已实现：助手回复走 `ReadingContent`；历史版本与 409 对照先阅读排版，各自可展开“查看原文”逐字核对 | [ChatMessageView.tsx](../../apps/novel-web/src/components/ChatMessageView.tsx)、[ChapterPanel.tsx](../../apps/novel-web/src/panels/ChapterPanel.tsx)、[ConflictBanner.tsx](../../apps/novel-web/src/components/ConflictBanner.tsx) |
| `Ctrl/Cmd+S` 保存 | 已实现：`WorkspacePane` 监听 keydown，只对当前分区编辑器生效，`isComposing`、保存中、冲突时不触发；组件测试覆盖 clean、dirty、saving、conflict、IME，真实浏览器验证 Ctrl+S 保存原文 | [WorkspacePane.tsx](../../apps/novel-web/src/panels/WorkspacePane.tsx) `saveKey` |
| 字体/命中尺寸下限 | 已实现：`button`/`summary` 桌面 ≥36px、移动 ≥44px，`.icon-button`/`.send-button` 同步；次要文字提升到 ≥12px，文稿正文桌面18px/移动17px、助手15px | [styles.css](../../apps/novel-web/src/styles.css) |
| 移动端切栏不卸载 | 已实现：三栏保持挂载，仅 `display:none`；≤900px 在目录里选中条目后带内容回到“正文” | `styles.css` `data-mobile-pane` 规则、[WorkspacePane.tsx](../../apps/novel-web/src/panels/WorkspacePane.tsx) `onNavigateContent` |
| 专注模式 | 已实现（桌面）：`.is-focused` 只隐藏目录与助手，不卸载编辑器或事件流；≤900px 隐藏“专注写作”开关 | [App.tsx](../../apps/novel-web/src/App.tsx)、[styles.css](../../apps/novel-web/src/styles.css) |
| 助手 IME/Enter 与单飞发送 | 已实现 | AssistantPanel `onKeyDown`、`lock` |
| 未保存正文不自动发送 | 已实现：输入框不读草稿，只自动追加对象类型/ID/标题/dirty 元数据 | [selectionContext.ts](../../apps/novel-web/src/state/selectionContext.ts)；[ChapterAssistantContext.tsx](../../apps/novel-web/src/components/ChapterAssistantContext.tsx) 组件与单测保留但已无 UI 消费者 |
| CAS + 409 保留草稿 | 已实现 | [useDraft.ts](../../apps/novel-web/src/state/useDraft.ts)、[ConflictBanner.tsx](../../apps/novel-web/src/components/ConflictBanner.tsx) |
| 自动保存 / 本地草稿恢复 | **未实现**：不写 `localStorage`/IndexedDB，草稿只在内存中 | `grep localStorage src` 只命中 CSRF 注释 |
| 重命名与富文本格式工具栏 | **未实现** | `grep rename/重命名 src` 无命中；无格式工具栏组件 |

落地新能力必须同时更新本表，不能只在 UI 里加东西而把标准留成过期描述。

## 1. 作者任务与四区流程

### 1.1 作者任务

界面存在的理由是让作者更快完成这些任务；评审界面时先问“它服务哪个任务、代价是多少步”：

1. 找到并打开一本书（书架）。
2. 在一章里继续写、写完保存、确认到底存没存。
3. 读回自己写过的正文（含空章节），需要时才进入编辑。
4. 让创作 Agent 帮忙改**已保存**的内容，并确认它到底改没改。
5. 处理冲突：本地草稿和服务端版本各自是什么，选择保留哪一个。
6. 检查历史版本、归档/恢复会话、离开时不被静默丢弃草稿。

### 1.2 四区流程

- **书架**是登录后的唯一入口：作品网格、检索、新建；删除必须确认并写明连带影响。
- 开书后进入书内**四个内容区**：**大纲**、**章节**、**设定**、**创作助手**（含历史会话）。左栏是目录（导航），中栏是当前对象的文档区，右栏是助手协作区。
- 选中态只有一个权威来源：当前作品 + 当前对象（章节/章节列表/设定条目）+ 当前会话。界面任何位置都不得出现第二个“当前对象”。
- 首开应定位到可继续的位置（有章节则第一项，否则大纲），并且**选中是显式可见的**，不能静默替换中栏。
- 切换对象或作品前，若有未保存草稿或未发送消息，必须点名对象与代价后再确认；取消后草稿与当前选择都不变。

### 1.3 标准

- 必须：任何破坏性动作（删除、永久结束会话、放弃草稿）都有明确文案确认，并说明后果是“可恢复”还是“不可恢复”。
- 必须：空状态回答“下一步做什么”，而不是只显示“暂无数据”。
- 应该：术语统一（作品/章节/设定/大纲/会话），同一对象在所有面板用同一名称。

## 2. 信息层级与渐进披露

### 2.1 首屏必须回答的问题

任何内容区打开后，不展开任何折叠就应能回答：**我在写哪个对象、写了多少、是否已保存、下一步动作是什么、助手在看什么**。这是信息分层的最低验收线。

### 2.2 四层披露

| 层级 | 内容 | 例子 |
| --- | --- | --- |
| 常驻（首屏） | 对象身份、正文/条目内容、字数、草稿状态、主操作、助手输入区 | 章节名、版本 N、保存按钮 |
| 一次点击 | 目录分区、版本历史、助手上下文、历史会话、元数据 | 折叠抽屉 |
| 事件驱动 | 冲突裁决、断线重连、错误、归档/撤权提示 | 409 后自动展开 |
| 可达但永不常驻 | 作品 ID、工具名与参数、版本全量列表、系统状态详情、安全诊断 | 折叠详情 |

- 必须：展开或收起任何抽屉**不改变正文起点**（抽屉不得挤压编辑区）。
- 必须：运行时提示与安全诊断（例如“按纯文本显示（未解析 HTML）”）不占消息主视图，可移入折叠详情。
- 应该：同一事实只在一个位置作为权威（见 §2.3），其他地方只能引用或聚合。

### 2.3 状态词表

状态不得合并容器，也不得互相冒充。至少区分：

| 维度 | 取值 | 权威位置 |
| --- | --- | --- |
| 草稿（内容） | 已同步 · 编辑中 · 保存中 · 未保存（失败） · 冲突 | 文档头 |
| 版本（内容） | `已保存版本 N` | 文档头 + 版本历史 |
| 命令（发送） | `已入队，等待服务端确认` | 消息气泡内 |
| 回合（Agent） | 进行中 · 已完成 · 失败 · 被中断 · 已结束 | 协作区头部单一位置 |
| 会话 | 活跃 · 已归档（可恢复） · 已撤销（不可恢复） | 协作区头部 + 历史列表 |

- 必须：`202 queued` 只表示入队；在回合终态与持久业务数据确认前，界面不得说“已保存”“已完成”。
- 必须：版本号一律带“已保存”语义，不写 `rev`/`revision` 之类内部字段名。
- 必须：归档（可恢复、只拒新 send）与永久结束（不可恢复）在文案与视觉上可区分。

## 3. 文本保真与安全渲染

### 3.1 纯文本是业务事实

- 必须：编辑器业务值始终是纯文本；载入与导出必须可逆，逐字保留连续空格、空行与行首尾空格。不得用 HTML 字符串装载正文（HTML 解析会折叠空白）。
- 必须：章节、大纲、设定编辑器保持纯文本，**不得**因为助手输出要排版就把正文 Markdown 化或富文本化。
- 必须：空内容必须可编辑、可保存（空字符串是合法内容）；不得出现“空内容只能读、无法进入编辑”的死角。
- 实现说明与残留风险：当前三面板的阅读态用同一安全 Markdown 允许集排版**作者正文本身**。存储与保存仍是逐字原文，且“编辑原文”可看到并修改原文；但以 `#`、`-`、`>` 等 Markdown 标记开头的散文行会在阅读态被解释为标题/列表/引用，而不是逐字显示。历史版本与冲突对照另有“查看原文”，正文阅读态目前没有。这是当前取舍，评估时按未闭合风险处理。

### 3.2 安全 Markdown 允许集

只读展示层（助手消息、历史版本、冲突对照等）可以结构化渲染 Markdown，但必须 fail-closed：

- **允许**：标题、段落、有序/无序列表、引用、代码围栏、分隔线、GFM 表格与任务列表；行内只保留粗体、斜体、`code`、安全链接。
- **必须禁止**：`rehype-raw`、任何 `dangerouslySetInnerHTML`、任何把原始 HTML 解析成元素的路径。
- **必须**：原始 HTML 只作为**文本节点**显示（作者能看到原文，但不存在执行路径）。
- **必须**：图片一律不加载，渲染为带无障碍名称的文字占位；不得产生远程图片请求。
- **必须**：链接只放行 `http(s)://`、`mailto:` 与 `#锚点`；相对路径、协议相对（`//host`）、`javascript:`、`data:`、`file:` 与含空白/控制字符的目标一律降级为不可点击文本。外链补 `target="_blank"` 与 `rel="noopener noreferrer"`。
- **必须**：不得自定义 `urlTransform` 或链接组件绕过上述白名单（现有 `ReadingContent` 已实现该收敛，见其文件头注释）。
- **应该**：表格与代码块放进可横向滚动容器，窄栏不撑破版面、不产生页面级横向滚动。

### 3.3 默认阅读、显式编辑

- 应该：章节、大纲、设定、历史版本与冲突对照默认以**阅读排版**呈现；用户执行显式编辑动作后才进入编辑器。
- 必须：编辑器载入源必须是**已存储的原始文本**（不是渲染后的 DOM、不是规范化结果），保存时逐字回写该文本。
- 必须：阅读视图不得成为唯一入口；任何对象都必须能从阅读态进入编辑态，且空内容同样可进入。
- 实现说明：三个内容面板用 `Manuscript` 切换阅读/编辑；阅读态与助手消息、历史版本、冲突对照共用同一安全 Markdown 允许集，**存储与保存的始终是纯文本原文**，阅读/编辑切换不序列化、不改写（见 §0 状态表）。

## 4. 修改目标（当前选中的对象）

统一助手需要一个明确、可见、可冻结的**修改目标**，否则“让 Agent 改这一章”会退化成复制粘贴 ID。

- 必须：当前选中的章节 / 大纲 / 设定条目就是默认修改目标；界面用 **target chip** 常驻显示（对象类型 + 标题 [+ 未保存标记]），作者一眼看到 Agent 会改谁。
- 必须：发送消息时把目标标识追加到请求上下文，只包含 **identifier + title + dirty**，**绝不包含正文**。未保存正文永不自动发送。
- 必须：目标在**发送瞬间冻结**，与消息一起提交并贯穿该回合；回合进行中切换选中对象不得改变在途回合的目标。
- 必须：新会话等待期间冻结同样成立——创建会话时先确定目标，等事件流就绪后再用**冻结的**目标发送首条消息，不得在就绪回调里重新读取当前选中。
- 必须：Agent 处理目标时必须先用现有工具读取**最新已保存**内容，再按 `expectedVersion` 执行 CAS 保存；不得凭记忆或旧快照写入。
- 必须：历史 preset（`novel-outline` / `novel-chapter` / `novel-bible`）继续保留各自原有工具掩码限制；新的目标/上下文能力不得放宽它们的权限。
- 必须：不因该能力扩大 Cell 工具白名单——六个小说工具不变；界面不得提供绕过工具边界（如“一键新建章节”）的路径。

> 状态：本条规范已落地。`withSelectionContext` 随消息追加 `kind/workId/id/title/dirty` 并在 `submit` 时冻结，composer 常驻 target chip、三面板阅读态与冻结 payload 均已实现；以最新源码为准，见 §0 与 §12。

## 5. 设计令牌、排版与控件

颜色、圆角与阴影必须走 CSS 变量；排版与间距应有稳定尺度，禁止到处硬编码。

### 5.1 令牌

`:root` 必须定义并只在此处定义颜色值：背景（`--bg` / `--bg-elevated` / `--bg-sunken`）、描边（`--border` / `--border-strong`）、文字（`--text` / `--text-muted`）、强调（`--accent` / `--accent-soft`）、语义（`--ok` / `--warn` / `--danger`）、`--radius`、`--shadow`。
应该补充间距与字号令牌（例如 `--space-1..6`、`--text-xs..2xl`），新增控件不得再写魔法数值。所有声明必须是浏览器可解析的有效值（历史上出现过被丢弃的混合大小写颜色值）。

### 5.2 排版尺度

| 用途 | 最小要求 |
| --- | --- |
| 正文阅读（中文） | ≥ 15px，行高 ≥ 1.9；编辑器沿用现有 17px/2.1 衬线体系 |
| 助手消息 | ≥ 14px，行高 ≥ 1.8 |
| 次要信息（元数据、副标题、时间、状态） | **≥ 12px**，且不得承担主要信息 |
| 说明性脚注 | 可以更小，但不得承载唯一的关键状态 |

- 必须：任何处于 12px 以下的文字都不构成“唯一权威”；关键状态（草稿/冲突/失败）必须在 ≥ 12px 处可辨。
- 应该：正文列宽控制在 45–75 字符；助手消息与编辑器各自成体系，不互相套用字号。

### 5.3 控件与命中尺寸

- 必须：常用可点击控件（按钮、图标按钮、下拉触发、切换页签）桌面命中区 **≥ 36px**，移动端 **≥ 44px**。可用内边距或 `min-height`/`min-width` 达成，不必放大视觉字号。
- 必须：聚焦可见（`:focus-visible` 有清晰 outline），禁用态与可用态可区分，不能只靠颜色。
- 应该：同一区域的按钮高度一致，避免 1–3px 错位。

## 6. 响应式、专注模式与保留挂载

- 必须：≤900px 的三区切换（目录 / 正文 / 助手）只改变可见性，**不得卸载**编辑器、草稿或事件流；切回内容区必须保留输入内容、滚动位置与会话状态。
- 必须：移动端“目录 → 选中条目 → 返回正文”后应回到内容区并带内容，不能停在空白或丢失选中。
- 必须：专注模式（若提供）只隐藏周边界面（目录、助手、顶栏装饰），**不得卸载**编辑器或事件流，不得重置草稿；退出后恢复原状态。
- 必须：桌面与移动端使用同一套命名与术语；窄屏不产生横向溢出。

## 7. 键盘与安全交互

- 必须：`Ctrl/Cmd+S` 与主保存按钮等价；输入法组合（`isComposing` 或 `keyCode 229`）期间不得触发保存或发送；不得劫持浏览器保留快捷键。
- 必须：助手 `Enter` 发送、`Shift+Enter` 换行，组合输入中的 `Enter` 不发送；发送有单飞锁，重复按键不双发。
- 必须：发送失败/迟到回调不清空输入；错误就近可见、可重试；只有 401 才回到登录态。
- 必须：CAS — 所有内容写入带 `expectedVersion`；409 必须逐字保留本地草稿，提供重新读取、显式采用服务端版本、以最新版本重提三条显式路径，不静默覆盖；“采用服务端版本”在有本地改动时必须确认，且只在读到不低于冲突版本的快照后可用。
- 必须：未保存草稿不得自动持久化到 localStorage/IndexedDB，也不得自动发送模型；离开/切换/关页必须显式确认并保留草稿。
- 必须：归档不等于撤权，撤权不等于删除内容；文案不得把三者混为一谈。

## 8. 无障碍基线

- 必须：区域、按钮、输入有可访问名称；状态变化不逐 delta 触发 `aria-live` 播报。
- 必须：下拉/抽屉具备 `aria-expanded`，并在可行时提供 `aria-controls` 关联；键盘可完整操作。
- 应该：主要流程可用键盘完成；焦点顺序符合阅读顺序。

## 9. 验证与证据

### 9.1 必须的检查

```bash
pnpm --filter @myrix/novel-web typecheck
pnpm --filter @myrix/novel-web test
pnpm lint
pnpm build:web
```

- 必须：安全渲染、纯文本往返、CAS/冲突、草稿保留、IME、移动端切栏保留草稿等**语义不变量**有自动化回归；文案可以变，行为不能静默变。
- 必须：除 jsdom 组件测试外，在**真实浏览器**做桌面（约 1440px）与移动（约 390px）检查，并留存截图；截图与运行数据放在被 Git 忽略的运行目录，不提交到公开文档。
- 必须：浏览器检查至少覆盖登录→书架→开书→阅读/编辑→保存→冲突→切换栏位，并确认窄屏无横向溢出。

### 9.2 证据分层（不得越级）

| 层级 | 能证明 | 不能证明 |
| --- | --- | --- |
| jsdom 组件测试 | 行为与安全不变量 | 真实渲染、布局与滚动 |
| `pnpm build:web` | 可构建 | 功能可用 |
| 本地真实浏览器（无模型） | 交互与布局、截图 | 模型链路与计费回合 |
| 真实模型闭环 | 持久终态与工具写入 | 生产 OIDC、线上容量 |
| 线上部署/恢复 | 现场结论 | 由 mock 推断 |

- 必须：报告写清“实际执行/未执行/跳过”，历史截图与历史测试数量不替代本次证据。
- 必须：调用真实 Responses 模型会**产生费用**，未获操作者明确授权不得运行；线上部署、重启、迁移与凭据轮换须单独授权。
- 必须：不得用模拟结果冒充真实模型或线上验收。

## 10. 协议与 Cell 边界（UI 不得突破）

- 必须：模型链路只使用已实现的 **Responses**；本项目禁止 `chat/completions`，界面、网关与开发装配不得为其保留兼容入口、隐式转换或失败回退。回归测试见[验证方法](<../testing/acceptance.md>)与网关测试。
- 必须：当前 **Cell** 不装配 skill 插件或 `skill` 工具；本设计标准与 [myrix-ui-design skill](<../../.agents/skills/myrix-ui-design/SKILL.md>) 都是开发者指引，不进入 Cell，也不作为扩大白名单的理由。
- 必须：六个小说工具集合不变；界面不得新增绕过工具边界的写路径（见[业务说明](<../business.md>)与 [novel-protocol](../../packages/novel-protocol/src/index.ts)）。

## 11. 变更流程

1. 改界面前先定位对应作者任务与所在区（§1），再决定信息层级（§2）。
2. 触及文本渲染、目标/上下文、CAS、会话状态、工具记录时，同步更新本文件的规范与 §0 状态表。
3. 行为变更必须带回归测试；文案与可访问名称变更需评审，不能“顺手改”。
4. 涉及身份、授权、审计的界面调整按 [AGENTS.md](../../AGENTS.md) 第 4 条同步 ADR 或说明为何不更新。
5. 文档链接与脱密遵循[文档政策](<../documentation-policy.md>)；不写入凭据、Cookie 或生产连接串。

## 12. 未验证边界

- 本次真实本地浏览器验收由 [author-ui.mjs](<../../tests/acceptance/author-ui.mjs>) 复现：1440px/390px、语义阅读、字节保真、Ctrl+S、目标提示、切栏/专注保留草稿、不自动保存或发送、无横向溢出。结果不等同于线上 OIDC 或计费模型。
- `Ctrl/Cmd+S` 的保存中/冲突/IME 护栏、创建会话前与连接等待时的目标冻结，由组件测试覆盖；浏览器不靠拦截请求制造这些窗口。
- 新提交仍须重跑目标版本的门禁与浏览器检查，不能复用历史通过结论。
- 自动保存、本地草稿恢复、章节/条目重命名与富文本格式工具栏均未实现，不得写入现状。
- 真实模型回合不在本次范围内（本轮未运行任何计费模型验收），须在目标版本独立记录。
- ≥20 万字单文档编辑性能与当前全量加载/替换策略的体验上限尚未验证。
