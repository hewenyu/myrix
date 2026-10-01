# Myrix 平台规划 v2：基于 DSH 的多租户垂直 Agent 平台

> 状态：**定稿**（2026-09-30）。本版取代 [platform-plan.md](platform-plan.md)，旧文件保留不动。
> 标注：**[源码]** 已在 `vendor/deepseek-harness`（锁定 639ed01）读到；**[推论]** 由源码推出；**[PoC]** 必须在 Phase 0 实测确认。

## 0. 一句话定位

Myrix 是一套**垂直 Agent 应用平台**：DSH 作为 Agent 执行内核，业务能力以 DSH 插件（bundle）交付，外层提供企业对接（SSO、租户、计费、审计、业务数据）。首发场景是**小说创作**，以 SaaS 多租户形态开发；私有化部署是“只有一个租户、使用独享档”的同一套制品。

后续垂直业务（报销、医疗……）的做法是：换垂直 bundle、补垂直业务服务、换 UI。平台底座复用。

## 1. 已确定的决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | 按租户分 Runtime，**一个 DSH 进程只服务一个租户** | DSH 是单操作者设计，`DSH_HOME`、凭据、附件、`sessions.list()` 都是进程级的 [源码]；进程是最便宜的可靠边界 |
| D2 | **每个租户至少一个独立的小 Pod**。两档：**共享档**空闲缩到零；**独享档**常驻 | Pod 是 K8s 标准隔离单元，实现简单；缩到零控制空闲成本 |
| D3 | **不做同进程多租户，也不做同 Pod 多租户** | 见 §4.3，现阶段不能有效隔离 |
| D4 | 会话绑定由**控制面写入权威记录并签发授权凭证**，Runtime 驱动插件在 Agent 创建事务内验证并安装身份 | 唯一权威、可撤销、不进模型上下文 |
| D5 | 自建 `myrix-base` bundle，**不叠加 `dsh-base`** | `dsh-base` 带 bash、fs、web 抓取、PTC、plugin-manager、HMR 等 [源码]；白名单式组装比逐行禁用安全 |
| D6 | 第一版**不装任何代码执行、文件系统、网络抓取类插件** | 小说不需要；这些插件会把“提示词注入”升级为“任意代码执行” |
| D7 | 业务数据在平台数据库，DSH 会话日志只存对话 | 会话日志没有删除 API、`list()` 不分页 [源码]，不能当业务库 |
| D8 | 自建前端，不复用 DSH Web UI | DSH Web 认证是单进程 launch token + 本地 Cookie，会话列表是全量的 [源码] |
| D9 | v0.1 会话存储用 DSH 自带 JSONL 后端，放 RWO 块存储，不用 NFS | 已有实现和跨进程锁；NFS 上 `flock` 不可靠 [源码]。Postgres 后端推迟到 v0.2 |
| D10 | **接受节点故障时会话恢复为分钟级** | RWO 卷需要在新节点重新挂载；换取 v0.1 不做分布式租约 |
| D11 | **会话与作品都是单一所有者，不做多人协作** | 只有所有者能创建、恢复、发消息；简化授权与并发 |

## 2. 总体架构

```text
浏览器（小说前端）
   │ OIDC
   ▼
BFF / API 网关（无状态，多副本）
   ├── 控制面：租户、成员、会话绑定、cell 放置、授权凭证签发
   ├── Cell 管理器：唤醒、缩容、健康检查（只有 Runtime 命名空间的扩缩权限）
   ├── 作品服务：作品/章节/角色/设定/版本（Postgres，tenant_id + RLS）
   ├── 计量与配额、审计服务
   └── 会话路由：按 sessionId → cellId 转发；cell 为零副本时排队等待唤醒
          │ mTLS + 授权凭证
          ▼
Runtime Cell（= 一个 Pod = 一个 DSH 进程 = 一个租户）
   profile = [myrix-base, myrix-novel]
   ├── myrix-runtime-driver   对内协议驱动（创建/恢复/发消息/取消/事件流/空闲上报）
   ├── myrix-principal        Agent → 身份 的绑定表
   ├── myrix-policy-guard     无身份/越权即拒绝（同步 guard）
   ├── myrix-llm-gateway      模型统一走平台网关，按租户/用户计量
   ├── myrix-audit            观察 tools/result 等事件并异步外送
   └── novel-*                小说服务、工具、提示词、presets
          │
          ▼
模型网关（配额、内容安全、计量）      作品服务（每次调用再授权）
```

### 2.1 Runtime Cell

**Cell 是最小运行单元**：一个 Pod、一个 DSH 进程、一个租户、一个独立 `DSH_HOME`、一个独立 RWO 卷。

- 每个租户在 K8s 中是一个 `replicas: 0/1` 的 StatefulSet，带自己的 PVC。共享档每个租户一个 cell；独享档可以有多个 cell（分片），新会话由控制面分到负载最低的 cell，**之后固定在该 cell**。
- 每个会话只存在于一个 cell 的卷里，所以**不会有两个进程写同一个会话**。v0.1 不需要分布式租约。
- 迁移会话（升档、搬家）是离线操作：控制面先冻结会话，再拷贝目录、改放置记录。

### 2.2 两档部署

| | 共享档（默认） | 独享档 |
|---|---|---|
| 形态 | 每租户一个小 Pod，**空闲缩到零**；混部在共享节点池 | 每租户一个或多个 Pod，**常驻**（高可用档跨节点 ≥2 个 cell）；可选专用节点池 |
| 隔离边界 | 容器、NetworkPolicy、独立 PVC、独立 Secret | 同左，另可独占节点 |
| 首次请求时延 | 冷启动（Pod 调度 + 卷挂载 + DSH 启动），目标见 P6 | 无冷启动 |
| 适用 | 个人、小团队、试用 | 付费企业、私有化、强隔离合同、敏感数据 |
| 故障影响 | 只影响本租户；节点故障影响同节点的租户 | 只影响本租户 |

**Pod 安全基线**（两档相同）：非 root、只读根文件系统（仅 `DSH_HOME` 卷可写）、去掉全部 capabilities、seccomp `RuntimeDefault`、不挂载 ServiceAccount token、NetworkPolicy 默认拒绝，只允许入站来自会话路由、出站到模型网关和作品服务。共享节点上的 cell 共用内核；因为第一版不装代码执行插件、插件全部是自己审过的代码，这个残余风险可以接受。需要更强隔离的租户升到独享档的专用节点池。

**缩到零的流程**：
1. **判定空闲**：驱动上报“没有进行中的轮次、inbox 为空、已 flush”，且最近 N 分钟（默认 15，可按租户配置）没有命令。第一版不装 jobs、schedule、goal 插件，所以不存在用户不在场时继续运行的工作。
2. **缩容**：Cell 管理器把 cell 标为 draining，路由暂停转发新命令；驱动再次确认空闲并 flush 后，Cell 管理器把副本数设为 0。卷保留。
3. **唤醒**：路由收到发往零副本 cell 的命令，先放入队列，前端显示“正在唤醒”；Cell 管理器把副本数设为 1，等到就绪探针通过（DSH 启动完成、驱动可用）后再转发。
4. 缩容与唤醒竞争时以 Cell 管理器的状态机为准：draining 期间到达的命令等待缩容完成后触发唤醒，不会转发给正在退出的进程。

**升降档**：默认进共享档。满足以下任一条件就升到独享档：合同要求、数据敏感、持续高负载、冷启动不满足体验。升档 = 把该租户的 cell 改为常驻，必要时改调度到专用节点池；不需要迁移数据。

### 2.3 K8s 多副本

- BFF、控制面、Cell 管理器、作品服务、模型网关：普通无状态 Deployment，HPA 扩缩。Cell 管理器多副本时用 leader election，避免对同一 cell 重复扩缩。
- Runtime：每租户一个 StatefulSet + RWO PVC，由 Cell 管理器通过 K8s API 扩缩。v0.1 不引入 KEDA 之类的通用缩零组件，因为唤醒需要和会话路由、凭证签发配合。
- cell 进程崩溃：K8s 在同一卷上重启。DSH 恢复会话时，会用合成的 closer 关闭被中断的轮次，不会接着跑 [源码]。前端提示“上一轮被中断，请重试”。
- **节点故障**：RWO 卷需要在新节点重新挂载，恢复时间为分钟级，已按 D10 接受。如果以后 SLO 不允许，v0.2 换 Postgres 会话后端，加租约和 epoch 防双写，做跨节点快速接管。
- 进程卡死但不退出：会一直持有 JSONL 锁 [源码]，需要用 liveness 检查杀掉。
- **容量约束** [推论]：每个节点能挂载的块存储卷数量有上限（由云厂商和机型决定），这会限制单节点同时运行的 cell 数，规划节点池时按“卷挂载上限”和“内存”两者取小。PVC 在缩到零时仍然计费。

## 3. 会话绑定：谁写、怎么写

### 3.1 创建

1. 用户在前端点击“新建会话（作品 W，助手：章节写作）”。BFF 完成 OIDC 认证。
2. 控制面在**一个事务**里：
   - 校验用户是租户成员，且是作品 W 的所有者（D11）；
   - 生成随机 `sessionId`（不编码任何业务含义）；
   - 选定 `cellId`；
   - 写入绑定记录：`{sessionId, tenantId, ownerUserId, workId, preset, policyRevision, cellId, status: creating}`。
3. 控制面签发**一次性授权凭证**：`aud=cellId`，内容包含 `sid`、`tid`、`sub`、`wid`、`preset`、`rev`、`jti`，有效期 60 秒，用控制面私钥签名。cell 处于零副本时，凭证在唤醒完成后签发，避免排队时过期。
4. 路由把“创建”命令和凭证转发给目标 cell。
5. cell 的 `myrix-runtime-driver` 依次校验：签名、`aud` 是否等于自己、`tid` 是否等于本 cell 的租户、`jti` 是否用过。然后调用：
   ```ts
   ctx.agents.create({
     sessionId: grant.sid,
     meta: { agentPreset: grant.preset },
     setup(agentCtx, agent) {
       principals.bind(agent, principalFrom(grant))   // WeakMap<Agent, Principal>
       return { commit() { assertGrantStillValid(grant) } }
     },
   })
   ```
   DSH 保证：setup 和 commit 在会话与 Agent 发布**之前**执行，任何一步抛错就整体回滚，不会发布 [源码]。
6. 驱动回报“已创建”，控制面把状态改为 `active`。这一步按 `sessionId` 幂等。

身份不写进会话 header：header 只有固定字段，没有自定义 meta [源码]。权威记录永远在控制面数据库。`jti` 去重表存在驱动内存中即可：凭证有效期只有 60 秒，进程重启后签名时间早于启动时间的凭证一律拒绝。

### 3.2 为什么不用其他方案

| 方案 | 问题 |
|---|---|
| Runtime 自己写绑定 | 会出现多个权威来源，cell 被攻破就能伪造 |
| 把租户编码进 sessionId | 只能辅助路由，不是凭据 |
| 写在会话 header | 没有自定义字段，而且 resume 时 header 来自磁盘，可能已过期 |
| 模型或工具传入 tenantId | 可被提示注入操纵 |

### 3.3 恢复、发消息、撤权

- **恢复**：控制面重新检查**当前**用户仍是租户成员且是会话所有者，再签发 `type=resume` 的凭证。驱动在 `ctx.agents.resume` 的 setup 里重新安装身份，并核对磁盘 header 中的 `agentPreset` 与凭证一致 [源码：resume 走同一个 setup 流程]。cell 刚被唤醒时，所有会话都走这条路径。
- **发消息**：每条命令都带短期凭证；驱动只接受 `sid` 匹配、`sub` 等于已绑定所有者的命令。
- **撤权**（成员被移除、会话被删除）：控制面把绑定标为 revoked，并通知驱动取消、销毁 Agent；作品服务同时校验撤销版本。不只依赖凭证过期。cell 处于零副本时不需要通知，下次恢复会被控制面拒绝。
- **租户管理员**：可以停用成员、删除数据，但不能以其他用户的身份进入会话。
- **子 Agent**：v0.1 不装。v0.2 在 `agent/created`（serial 事件，失败会回滚创建 [源码]）中让子 Agent 继承父 Agent 的身份，权限取交集；没有身份也没有父 Agent 的，一律销毁。[PoC] 确认从子 Agent 取得父 Agent 的方法。

### 3.4 工具里如何用身份

- `myrix-principal` 提供 `principals.get(agent)`。不要用 `ctx.provide` 为每个 Agent 注册同名服务，同名服务会在进程级冲突 [源码]。
- `myrix-policy-guard` 注册一个同步 `ctx.tools.guard()`：`exec.agent` 没有绑定身份就拒绝。默认拒绝，没有例外。
- 业务工具从 `principals.get(exec.agent)` 取身份，**参数里不出现 tenantId、userId**。
- 作品服务不盲信 cell：cell 的服务凭证只属于一个租户，作品服务检查“主体的租户 = 凭证的租户”，再按所有者做行级授权。

## 4. 隔离

### 4.1 租户之间

由 cell 保证：独立 Pod、进程、`DSH_HOME`、PVC、Secret、模型网关凭证，NetworkPolicy 禁止 cell 之间互访。作品服务用 `tenant_id` + Postgres RLS 隔离数据。

### 4.2 同一租户内的用户之间

同一 cell 里有同一租户不同用户的会话，所以要做应用层隔离：

- **cell 不暴露任何列举接口**：不装 DSH Web、session-controller、workspace、schedule、file-reference 这类会扫描全部会话的插件 [源码：这些插件会遍历所有 root Agent 或持久化列表]。会话列表由控制面按所有者过滤后提供。
- 驱动只接受带凭证的命令，凭证决定能操作哪个会话。
- 工具只访问当前所有者的作品。
- 附件：同租户内按内容哈希去重存放 [源码]，只能通过本会话的引用读取。[PoC] 确认没有跨会话按 hash 读附件的路径。

### 4.3 为什么不做同进程、同 Pod 多租户

同进程的源码阻碍：
- `DSH_HOME` 是进程级单例，一个进程无法有第二套凭据、设置、附件和存储根。
- `ctx.sessions.list()`、`ctx.agents.list()` 和持久化 `list()` 都不按调用方过滤。
- 附件、spill、storage-domain 都是全局目录或全局实例。
- 任何未处理的 Promise rejection 都会让进程 `exit(1)`，一个租户出错会拖垮所有租户。

要做到有效隔离，需要为每个租户在进程内单独实例化会话存储、附件、spill 和存储，并摘除所有列举接口。这已经是在重构上游，不是配置能解决的。**结论：同进程多租户现阶段不能有效隔离会话。**

同 Pod 多进程（每进程独立系统用户）在技术上可行，但需要 supervisor 持有切换用户的能力、自行管理 Unix socket 和目录权限，安全评审和运维都比“每租户一个 Pod”复杂。在缩到零可用的前提下，它省下的成本不值得这些复杂度，因此不采用。只有当 Phase 0 实测证明“每个 Pod 的固定开销或冷启动”不可接受时才重新评估。

## 5. 插件与 bundle

### 5.1 `myrix-base`（平台底座，所有垂直业务共用）

DSH 核心（白名单，参考 `sdk-minimal` 的写法，但去掉其中的 shell、终端、沙箱）：
`cordis-plugin-timer`、`dsh-llm`、`dsh-session`、`dsh-session-projection`、`dsh-system-prompt`、`dsh-tools`、`dsh-agent`、`dsh-agent-loop`、`dsh-llm-retry`、`dsh-session-persistence-jsonl`、`dsh-attachment-local`、`dsh-token-meter`、`dsh-compaction-basic`、`dsh-agent-preset-registry`、`dsh-user-approval`、invariants 系列。[PoC] 确认这组插件能独立启动且功能完整。

Myrix 插件：`myrix-runtime-driver`、`myrix-principal`、`myrix-policy-guard`、`myrix-llm-gateway`、`myrix-audit`。

明确不装：`dsh-base` 整体，以及 bash/pwsh/terminal/subprocess/sandbox、tool-fs、tool-web、web-fetch、PTC/run_code、workflow、subagent、jobs、MCP、hooks、extensions、plugin-manager、HMR、config-editor、settings、credentials-local、web-app、session-controller、workspace、schedule、goal、agent-instructions（会读 `$DSH_HOME/AGENTS.md`）、skill-filesystem。

运行约束：配置随镜像只读交付，禁止热重载，锁定 DSH 精确版本。

### 5.2 `myrix-novel`（第一个垂直 bundle）

- **服务** `ctx.novelStore`：调用作品服务 API。
- **工具**：`get_outline`、`update_outline`、`get_chapter`、`save_chapter_draft`（每次保存生成新版本）、`search_bible`（角色/设定/时间线检索）、`update_bible_entry`。
- **提示词段落**：文风、创作守则、当前作品摘要。
- **presets**：大纲助手、章节写作、设定管理。不同 preset 挂不同工具。
- **记忆**：事实以作品服务里的“设定圣经”为准，模型按需检索；不把压缩后的聊天记录当成唯一记忆。

### 5.3 垂直插件开发约定（以后做报销、医疗也照此）

1. 只能写：领域服务、领域工具、提示词段落、presets、前端组件。
2. 不能：自己做认证、直连外部系统、在 DSH 存储里放共享业务数据、从参数里接收租户或用户身份。
3. 写操作（例如报销提交、订酒店）必须带业务幂等键，超时后先查询结果，审批绑定金额和参数摘要，补偿走业务服务，不交给模型。
4. 插件只依赖 `myrix-base` 提供的服务和 DSH 文档化的扩展点，减少对 DSH 内部类型的耦合（DSH 公开 API 仍处于 pre-stable [源码]）。

## 6. 数据与审计

| 数据 | 位置 | 删除方式 |
|---|---|---|
| 作品、章节、设定、版本 | 作品服务 Postgres | 业务删除 + 备份过期 |
| 会话日志（含模型看到的作品片段） | cell 的 PVC | DSH 没有删除 API [源码]：控制面先关闭会话，再由平台作业删除目录；租户注销时删除整个 PVC |
| 附件 | cell 的 PVC | 随会话清理作业或 PVC 删除 |
| 卷快照/备份 | 存储侧 | 按留存期过期；删除承诺需包含备份过期时间 |
| 审计事件 | 审计服务 | 按租户留存期 |

审计第一版定位为**运营审计**（谁、何时、哪个会话、调用了什么工具、用了多少 token），不宣称是合规级、不可抵赖的审计。

## 7. 模型与成本

- 所有模型调用经过平台模型网关：按租户和用户计量，预占额度后结算，限制并发和速率，内容安全也在这里做。
- cell 只持有本租户的网关凭证，不持有上游模型密钥。
- [PoC] 确认模型适配器能拿到会话标识，从而按用户归因。如果不行，退回为按会话 → 用户在网关侧查表。

**Runtime 成本** ≈ 独享档常驻 Pod 数 × 单价 + 共享档活跃 Pod 小时 × 单价 + 所有租户 PVC 存储。共享档的关键参数是单 cell 内存、冷启动时间和每节点可同时运行的 cell 数，由 Phase 0 实测得出，不预设。

## 8. 路线图

### Phase 0（4 周）：PoC，全部通过才进入 MVP

| # | 验证内容 | 通过标准 |
|---|---|---|
| P1 | `myrix-base` 最小插件树 | 不叠 `dsh-base` 能启动；对话、压缩、preset 切换可用；`--dump-config` 中没有任何 §5.1 禁用插件 |
| P2 | 会话绑定 | 无凭证、凭证过期、`aud` 或 `tid` 不符、`jti` 重放时，创建和恢复成功次数为 0；无身份 Agent 的工具调用 100% 被拒；resume 时 preset 不一致被拒 |
| P3 | 租户间隔离 | 两个租户 cell 互相访问网络、卷、会话、附件 1000 次，成功 0 次；一个 cell 崩溃，另一个不受影响 |
| P4 | 同租户用户隔离 | 用户 A 通过 BFF 或驱动列举、打开、恢复 B 的会话，成功 0 次 |
| P5 | 崩溃与节点故障 | kill -9 cell 100 次：已 flush 事件丢失 0、双写 0、重启 p95 ≤ 30 秒；节点故障演练记录卷重新挂载后的实际恢复时间，目标 ≤ 10 分钟 |
| P6 | 缩到零与唤醒 | 缩容与唤醒竞争 100 次无命令丢失、无转发给退出中的进程；冷启动 p95 实测，初始目标 ≤ 15 秒（按实测修订）；测出单 cell 空闲与活跃内存、每节点可运行 cell 数 |
| P7 | 小说价值 | 20 万字测试作品、100 个角色和情节问题，事实准确率 ≥ 90%；每章成本不超过预先批准的预算 |
| P8 | 升级 | 换一个 DSH 版本后，历史会话回放和插件契约测试 100% 通过 |

### MVP（第 2–4 个月）

SSO、租户与成员管理、作品管理、三个小说 presets、共享档（缩到零）+ 独享档、Cell 管理器、计量与配额、运营审计、前端。

### Beta（第 5–6 个月）

内容安全完善、导出（EPUB/PDF）、升降档工具、监控告警、私有化安装包（单租户 + 独享档）。

### v0.2 之后

Postgres 会话后端 + 租约/epoch（跨节点快速接管）、子 Agent、MCP 连接器网关、第二个垂直业务（建议报销，用来检验连接器、审批、幂等这一层）。

**人力**：以 5–6 人为预算假设，Phase 0 结束后按实测重新估算，不预先承诺工期。

## 9. 现有代码去留

| 模块 | 处理 |
|---|---|
| `packages/governance` | 保留。去掉内部读系统时钟（[decide.ts:45](../../packages/governance/src/decide.ts)），生产配置禁用 `defaultEffect: "allow"` |
| `packages/contracts` | 保留并扩展：租户、会话绑定、授权凭证、小说领域类型 |
| `packages/registry` | 保留，用来按租户渲染 profile（启用哪些垂直 bundle） |
| `packages/control-plane` | 重构：单一 admin token、从请求体取主体都要去掉；新增绑定、放置、凭证签发、Cell 管理器 |
| `packages/knowledge` | 降级为连接器契约之一，v0.1 不用 |
| `packages/dsh-shim` | 删除，类型与真实 DSH API 不一致 |
| `plugins/dsh-plugin-governance` | 重写为 `myrix-policy-guard`：guard 必须同步，waterfall 必须调用 `next()` |
| `deploy/docker-compose.yml` | 仅作本地开发；新增 Helm chart |

需要新写的 ADR：Runtime Cell 与两档部署（含缩到零）、会话绑定与授权凭证、Runtime 驱动协议、v0.1 会话存储（JSONL）与节点故障恢复、数据生命周期与删除。

## 10. 拍板记录

| 日期 | 问题 | 结论 |
|---|---|---|
| 2026-09-30 | 运行单元 | 按租户分 Runtime；不做同进程多租户 |
| 2026-09-30 | 会话绑定写入方 | 控制面写权威记录并签发凭证，Runtime 在创建事务内安装身份 |
| 2026-09-30 | 共享档实现 | 每个租户一个小 Pod，空闲缩到零；不做同 Pod 多进程 |
| 2026-09-30 | 节点故障恢复 | 接受分钟级 |
| 2026-09-30 | 多人协作 | 不做；会话与作品单一所有者 |

留给 Phase 0 实测后再定的参数：默认空闲超时、冷启动目标、每节点 cell 密度、独享档的升档阈值。
