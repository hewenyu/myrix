# 路线图

约定：

- 每个里程碑都要有**可核对的验收标准**，未达标不进下一阶段。
- 本文只写"当前状态 + 下一步"，不把历史测试数量当作当前门禁结论；
  历史数字属于各自时间点的记录，见 [模块边界评审](<reviews/module-boundaries-2026-10.md>)。
- 状态标签：【已完成】【进行中】【待验收】【愿景】。
- 当前上线目标是**单台 VPS**；Kubernetes 是另行维护的可选实现，**未证明上线**，
  不计入当前里程碑的完成条件（[ADR 0029](<adr/0029-single-vps-runtime.md>)）。

---

## 已交付：v0.1 小说工作台主线【已完成】

以 `novel-web → BFF/works → 每租户 Cell → Responses 网关 / PostgreSQL` 为主线，
下列能力已在源码中就位；**本地链路的既有验收记录**见
[本地开发指南](<implementation/local-development.md>) 与
[模块边界评审](<reviews/module-boundaries-2026-10.md>)（记录的是当时结论，不等于本次复跑）。

- [x] 持久化 BFF：OIDC/开发登录、Cookie/CSRF/Origin、浏览器 API、SSE 投影
      （[bff-api.md](<implementation/bff-api.md>)、[ADR 0013](<adr/0013-bff-authentication.md>)）。
- [x] 内部 works 服务与平台存储：RLS、所有权、CAS、版本只追加、审计与 outbox
      （[platform-store.md](<implementation/platform-store.md>)、[ADR 0011](<adr/0011-postgres-ownership.md>)）。
- [x] 每租户独立 Cell + 白名单装配，不加载 DSH 核心之外的通用能力
      （[cell.patch.yml](<../bundles/myrix-base/cell.patch.yml>)、[ADR 0014](<adr/0014-cell-lifecycle.md>)）。
- [x] 会话绑定 + 命令幂等 + 短期签名 grant + 恢复
      （[ADR 0019](<adr/0019-cell-binding-leases.md>)、[ADR 0028](<adr/0028-runtime-session-recovery.md>)）。
- [x] 六个小说工具与三个预设，工具只在 preset 作用域注册
      （[business.md](<business.md>)、[ADR 0017](<adr/0017-novel-tools-boundary.md>)）。
- [x] 模型网关只讲 OpenAI Responses，禁止 `chat/completions`，无兼容入口
      （[ADR 0023](<adr/0023-responses-gateway.md>)）。
- [x] 平台授权纯函数化、deny 覆盖、畸形条件 fail-closed、角色按租户分区
      （[ADR 0033](<adr/0033-condition-malformed-and-role-partition.md>)）。
- [x] 模块边界与 lint 门禁进入 CI（[评审](<reviews/module-boundaries-2026-10.md>)）。
- [x] 单机 VPS 编排、迁移/备份脚本与镜像发布契约
      （[单机部署指南](<deployment/self-hosting.md>)、[ADR 0029](<adr/0029-single-vps-runtime.md>)）。

---

## M1：生产上线验收（进行中）

代码与编排已就位，**未完成的是"在正式部署上实测"**。完成标准是下列每一项都有可复查的实跑记录，
而不是文档或单测通过。2026-10-02 已确认现有演示五服务健康、同 SHA 四镜像，并验证新增专用管理员真实 OIDC 登录；未重新部署、验证双架构发布、owner 首次改密或重启恢复，故不能整项勾选：

- [ ] 正式镜像（同一提交、双架构）在目标 VPS 上部署成功，四个组件版本一致。
- [ ] 真实 OIDC 登录 → 首次改密 → 工作台授权，issuer/各端点逐字节匹配。
- [ ] 真实上游 Responses 的六工具回合，落库正文/版本经独立查询确认。
- [ ] 两个 Cell 的进程重启恢复：boot ID 改变、历史重放、旧游标续传。
- [ ] 撤权语义：撤权后 `send` 返回 410，Cell 侧 Agent 被销毁。
- [ ] 备份/恢复演练：业务库 + 认证库 + Cell 家目录 + 配置归档，空库/空卷前置条件成立。
- [ ] 限流、慢消费者、SSE 断线与内部 origin 契约在真实网络下复验。

已知需要先处理的边界（评审中列出的 P1 项）：

- [ ] `apps/works-service` 用例层与 BFF 内的仓储映射存在**重复实现**，需明确唯一来源或正式弃用其一。
- [ ] 旧控制面输入校验、`grantMatches` 的 constraints 语义、shim 的 guard/restrict 偏差
      （仅当 legacy 路线继续开放时才阻塞）。
- [ ] 事务用例归属：delivery/recovery transition + audit 应下沉为 platform-store 用例，
      删除精确到文件的边界例外。

---

## M2：多租户与平台能力（待验收）

- [ ] 超越初始化器的单 Cell / 单租户配置，设计 IdP subject 多租户映射或每租户独立 issuer；同租户运维补员已经可用，不是只能有一个成员。
- [ ] 动态 Cell 目录 / CellManager 路由接入 BFF，替换静态目录（[cell-manager.md](<implementation/cell-manager.md>)）。
- [ ] 平台管理后台的 OIDC 登录与角色（viewer/operator/admin），替代旧 console。
- [ ] 功能裁剪接入主线：目录 + 授权闭包 + profile 渲染 + 运行时掩码（[registry](<../packages/registry/src/index.ts>)）。
- [ ] 知识库联邦落地：至少一个真实 Connector，身份透传、范围只收窄、故障隔离。
- [ ] 策略版本化与灰度：草稿 → 模拟 → 发布 → 回滚；判定可解释性纳入审计检索。
- [ ] 审计归档与分区留存策略。

---

## M3：规模化与演进【愿景】

- [ ] Kubernetes 形态达到与 VPS 对等的验收标准（真实集群、卷故障迁移、drain/idle 凭据与最小 RBAC）。
      当前该实现**未证明上线**，且已知 drain/idle 调用缺凭据（见评审）。
- [ ] 控制面多实例与判定缓存一致性、降级预案演练。
- [ ] 可观测性：判定延迟、缓存命中率、裁剪分布、fail-open 事件应为 0 的告警。
- [ ] 前端按路由/编辑器分包，消除主 chunk 体积告警（不靠提高阈值掩盖）。
- [ ] 策略即代码：Git + CI 校验 + 变更评审。

---

## 明确不做

- 不 fork / 改造 DSH 核心，只做 Cordis 插件与 profile。
- 不重建通用多供应商 LLM 网关或 RAG 引擎；当前模型网关只负责 Responses 转发、身份与额度计量。
- 不复制企业知识库的 ACL 与正文。
- 不保留 `chat/completions` 的任何兼容入口、隐式转换或失败回退。
- 不为通过测试而放宽限流、RLS、撤权或协议校验。

---

## 【历史】M0 内存治理原型（仅背景）

早期的分层治理原型（策略引擎、功能裁剪、知识库联邦、7 页管理后台、内存控制面）
由 `pnpm dev:legacy` 启动，**不是当前小说工作台接口**，其旧测试数量也不代表当前门禁。
保留它是为了迁移参考；`myrix-base` 不加载相关旧插件（[ADR 0018](<adr/0018-legacy-fail-open-retirement.md>)）。
