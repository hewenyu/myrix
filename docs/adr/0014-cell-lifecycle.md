# ADR-0014：TenantCell 生命周期与 Cell 管理器

状态：**实施中（2026-09-30）**。依据 [platform-plan-v2](../plan/platform-plan-v2.md) D1/D2/D3 与 §2.2、§2.3，以及 [tech-design-v1](../plan/tech-design-v1.md) §0、§3.4、§4.6。
实现：`apps/cell-manager/`；部署：`deploy/helm/myrix/`。

本 ADR 只决定**生命周期归谁管、状态机怎么走、缩容凭什么发生、权限边界在哪**。会话绑定与授权凭证见 ADR 待写（tech-design-v1 §8.2），驱动协议见 §8.3。

## 背景

平台决策 D1/D2/D3 定了运行单元：**一个 Pod = 一个 DSH 进程 = 一个租户 = 一个 `DSH_HOME` = 一个 RWO 卷**。共享档空闲缩到零，独享档常驻。

由此产生三个必须一次定清楚的工程问题：

1. **谁是 cell 状态的权威？** 控制面 Postgres 里再抄一份副本（Astra 初稿）会立刻出现双权威：抄慢了路由会把命令投给正在退出的进程，抄快了会把没起来的进程当成活的。
2. **缩容凭什么发生？** "最近 15 分钟没有命令"是定时器结论，不是空闲证据。一个跑了 40 分钟的长轮次在这条规则下看起来完全空闲。
3. **缩容与唤醒竞争怎么办？** 命令在 draining 窗口到达时，既不能丢，也不能转给正在退出的进程。

## 决策

### 1. CRD 是生命周期的唯一权威；业务绑定不进 CRD

`myrix.io/v1alpha1 TenantCell`（Namespaced）承载且只承载：

| 字段 | 含义 |
|---|---|
| `spec.tenantId` | 归属租户。必须等于 `myrix.io/tenant` 标签，否则控制器什么都不做 |
| `spec.tier` | `shared`（空闲缩到零）/ `dedicated`（常驻） |
| `spec.wantRunning` | 唤醒/睡眠意图，只对 shared 有意义 |
| `spec.runtime` | 镜像、command/args、驱动端口与 base URL、就绪超时、调度约束 |
| `spec.storage` | 卷大小与 StorageClass |
| `status.phase` | `Stopped` / `Starting` / `Ready` / `Draining` / `Sleeping` / `Waking` / `Failed` |
| `status.observedGeneration` | 上述观测对应的 `metadata.generation` |
| `status.bootId` | 当前进程身份，参与授权凭证的 `aud`/`boot` 校验 |
| `status.conditions` | `Ready` / `IdleProof` / `Drained` |

**明确不进 CRD**：租户、成员、会话绑定（`sessionId → cellId`）、命令队列、撤权版本。这些留在控制面 Postgres；CRD 只知道"这个 cell 现在是死是活"。理由：把业务表放进 CRD 会把 K8s etcd 变成业务库，并且让 K8s RBAC 成为业务授权的旁路。

`status.phase` 只由控制器写。其它任何组件想表达意图，只能改 `spec.wantRunning`（会话路由经 Cell 管理器内部接口）或改 `metadata.generation`（控制面改 spec）。

### 2. 两档的生命周期

```
shared:   Stopped ──wake──▶ Starting ──ready──▶ Ready
             ▲                                    │
             │                       空闲超时 / wantRunning=false
             │                                    ▼
          Sleeping ◀──idle proof + drain── Draining
             │
             └──wantRunning=true──▶ Waking ──ready──▶ Ready

dedicated: 常驻。控制器不会把它驱到 0；
           人类若手写 status.phase=Draining，仍必须走完整 drain + idle proof，
           所以不存在绕过证据的缩容路径。
```

- **`Ready` 的判据是 K8s readiness + `observedGeneration`**：`status.phase=Ready` 且 `status.observedGeneration == metadata.generation` 且 `status.readyReplicas ≥ 1` 且 `status.bootId ≠ ""`。四者缺一，条件 `Ready=False`。
- **generation 落后必须重新证明就绪**：`observedGeneration != generation` 时，控制器把 phase 退回 `Starting`、清掉 `readySince`、撤回 `Ready`，等新的观测。**不切 `status.bootId`**：进程还是同一个，撤销的只是就绪结论。这条直接满足"generation stale 不 ready"。
- **replicas 只能是 0/1**：`internal/cell/k8s.StatefulSet()` 会把入参 clamp 到 `[0,1]`，控制器在观测到 `sts.Status.Replicas > 1` 时直接报错而不是静默纠正。

### 3. 缩容必须由明确空闲证明驱动

把 `Draining` 单独设成一个相位，是这条决策的实现方式：**路由看到 `Draining` 就立刻停止投递**，而控制器在同一个相位里等三件事全部成立：

1. `POST /v1/admin/drain` 返回 `drained=true`（准入已关、无进行中轮次、inbox 空、已 flush），且 `drain.bootId` 与记录的 `status.bootId` 一致；
2. `POST /v1/admin/idle` 返回的证明通过校验：`noActiveTurns && inboxEmpty && flushed`，`bootId` 一致，`observedAt` 不早于 2 分钟前，且 `observedAt - lastCommandAt ≥ spec.idleTimeoutSeconds`；
3. 证明不是"上一代进程"的，也不是超时重放的。

任一条不成立：**保持 replicas=1**，条件 `IdleProof=False`，reason 用精确的拒绝码（`ActiveTurns` / `InboxNotEmpty` / `NotFlushed` / `BootIDMismatch` / `QuietPeriodNotElapsed` / `StaleProof`），并把 `status.lastIdleProofAt` 刷新为当前时间——拒绝即重置静默计时，避免控制器反复敲一个忙 cell。

驱动不可达时**一律 fail closed**：不缩容、不报 Ready。定时器不能替代证据，所以"15 分钟没命令"只是一个*触发请求证明的条件*，不是缩容理由。

**PVC 永不删除**：`volumeClaimTemplates` 的 `persistentVolumeClaimRetentionPolicy` 两个方向都是 `Retain`，控制器 RBAC 对 PVC 只有 `get/list/watch`，代码里没有任何删除 PVC 的路径。`TenantCell` 被删也不删卷。

### 4. draining 期间到达的命令：等睡眠完成再唤醒

命令在 draining 窗口到达时，路由把 `wantRunning` 置回 `true` 并**继续等**。控制器在这一相位里**不看 `wantRunning`**：它把收尾做完、缩到 0、进入 `Sleeping`。下一轮循环在 `Sleeping` 看到 `wantRunning=true`，才转到 `Waking` 拉起。

这样保证两件事：
- **不丢命令**：命令已经持久入队（控制面 Postgres），且 `drain` 的 `flushed` 证明里面有它的落盘记录；
- **不把命令交给正在退出的进程**：`Draining` 没有任何一条指向 `Ready` 的边。

状态机的"不变量测试"用穷举把这条钉死：`TestDrainingNeverReturnsToReadyInOneStep` 遍历 `DriverReachable/drained/wantRunning/idle` 的全部组合，断言**没有**任何一种能一步回到 `Ready`。

### 5. 唤醒

`wantRunning=true` 且 `/v1/ready` 返回 `bootId` 后，控制器把 `bootId` 写进 `status`；路由**只在 `phase=Ready` 且 `bootId` 与凭证一致时投递**。凭证在就绪之后才签发（tech-design-v1 §4.5/§4.7），所以排队期间不会过期。

唤醒单次有 `readyTimeoutSeconds` 上限，超时进 `Failed` 并 `wakeAttempts++`；达到 `maxWakeAttempts` 后停止重试，等新的 generation 或人工干预（`Failed` 期间 `RequeueAfter` 退到 60s，不打满 API server）。

### 6. leader election 与权限边界

- Cell 管理器是普通 Deployment，`replicaCount > 1` 时用 `coordination.k8s.io/leases` 选主，保证同一 cell 不会有两个实例各调一次副本数。
- **只有 namespaced Role，没有 ClusterRole**。`cache.Options.DefaultNamespaces` 把 informer 缓存限定在 Runtime namespace，Reconciler 另外硬校验 `cell.Namespace == runtimeNamespace`，不一致直接报错。授权范围：

| 资源 | 动词 | 用途 |
|---|---|---|
| `tenantcells` | get/list/watch/create/update/patch | 读状态，写 `wantRunning` |
| `tenantcells/status` | get/update/patch | 写相位与条件 |
| `statefulsets` | get/list/watch/create/update/patch | 调谐副本数与模板 |
| `services` | get/list/watch/create/update/patch | 驱动 headless Service |
| `pods` | get/list/watch | 取 pod IP 与就绪态 |
| `persistentvolumeclaims` | **get/list/watch** | 只读；永不删除租户数据 |
| `secrets` | **get/list/watch** | 只读；校验每租户凭证 Secret 存在 |
| `events` | create/patch | 事件 |
| `leases` | 全部（仅发布 namespace） | 选主 |

没有 `*` 动词，没有 `*` 资源，没有 cluster 级资源。`TestNoClusterScopedRBAC` 和 `TestRBACIsNamespaceScopedAndNarrow` 把这条做成了渲染时的断言。

### 7. 安全基线（cell 与管理器同源）

Cell pod（由 Go 代码生成，见 `internal/cell/k8s`）：

- `runAsNonRoot=true`（uid/gid 65532）、`allowPrivilegeEscalation=false`、`capabilities.drop=[ALL]`、`seccompProfile=RuntimeDefault`；
- `readOnlyRootFilesystem=true`，只有 `DSH_HOME`（RWO PVC）与 `/tmp`（`emptyDir`，256Mi 上限）可写；
- `automountServiceAccountToken=false`、`enableServiceLinks=false`：cell 根本不需要跟 API server 说话；
- 探针用 HTTP `/v1/ready`，**不用 exec**：镜像里没有 shell；
- 每租户独立 Secret（`spec.runtime.credentialsSecret`）以 `0400` 只读挂载到 `/var/run/myrix/credentials`，`optional=false`——凭证缺失时 pod 起不来，而不是匿名运行；
- 禁用 host namespaces 与 hostPath。

Namespace 级（Helm）：`pod-security.kubernetes.io/enforce=restricted`。

NetworkPolicy：Runtime namespace **双向 default deny**（`podSelector: {}`，所以新租户自动继承），唯一的开口是

- 入站：只允许 `networkPolicy.runtime.bff.namespace`（会话路由）访问驱动端口；
- 出站：只允许模型网关、作品服务、集群 DNS。

cell 之间的互访没有被任何规则放行，因此被 default deny 覆盖；cell 也到不了 API server 和外网。

### 8. 部署与 chart

`deploy/helm/myrix/` 一套 chart 覆盖 SaaS 与私有化，差别只在 values（`values-saas.yaml` / `values-private.yaml`）：

- **CRD 放 `crds/`**：Helm 只在 install 时装，绝不 upgrade/delete。CRD 改了必须人工 `kubectl apply`——生命周期契约的变更不该被一次 `helm upgrade` 静默带过。
- **Runtime namespace 不由 chart 创建**（默认 `runtime.createNamespace=false`）。那个 namespace 里装的是租户数据，`helm uninstall` 不能有删掉 PVC 的可能。显式打开时也带 `helm.sh/resource-policy: keep`。
- **镜像必须操作者提供**：`cellManager.image.repository` 为空时 chart 直接 `fail`。本仓库不发布任何 runtime/profile 镜像，也没有"默认镜像"可回退。runtime 容器的 `command`/`args` 都可配。
- **内部唤醒接口**：`POST /internal/v1/cells/{cell}/want-running`，`Authorization: Bearer <token>`，token 来自每 release 的 Secret（缺失则服务器不启动）。这是给会话路由用的窄接口——路由自己没有 K8s 权限。
- 渲染期护栏（`_validate.tpl`）拒绝：空镜像、私有化档配明文 token、多副本却不选主、default deny 却没有允许的 peer、非法 tier、dedicated 却要求停止。

## 与旧方案的差异

| 议题 | 曾考虑 | 现在 | 原因 |
|---|---|---|---|
| 状态权威 | Postgres CAS 记录 cell 状态 | CRD + controller | 抄一份观测态必然出现双权威与窗口期 |
| 缩容判据 | 最近 N 分钟无命令 | 显式 idle proof（含 bootId 一致性） | 长轮次在定时器下看起来空闲 |
| 驱动不可达 | 按上一次已知状态继续 | 一律 fail closed | 网络失败不能变成"缩容"或"就绪" |
| 唤醒竞争 | 直接转回 Ready | Draining 无回到 Ready 的边 | 不把命令交给正在退出的进程 |
| 权限 | ClusterRole 省事 | 仅 namespaced Role + 缓存限定 | 一个 cell 管理器不该能碰别的 namespace |

## 未决 / 需要 Lead 对齐

1. **驱动的 `/v1/admin/idle` 还不存在**。tech-design-v1 §3.2 只有 `/v1/admin/drain`。控制器要求 drain **和** idle 两份证据。在驱动实现这个端点之前，共享档 cell 会停在 `Draining` 而不是缩容——这是刻意的，但 Lead 需要决定：驱动补端点，还是把 `drain` 的语义扩展为包含空闲证明。接口形状已冻结在 `internal/driver.IdleProof`。
2. **每租户凭证 Secret 的写入方与内容**未定：控制面渲染、还是平台作业。当前只约定"每租户一个、以 0400 只读挂载、缺失即不启动"。
3. **内部唤醒接口的 mTLS**：chart 支持 cert-manager 签发或 `cellManager.tls.secretName` 自带 Secret，管理器也能自持 HTTPS 监听（`--internal-tls-cert-file/--internal-tls-key-file`，由 chart 注入）；但会话路由侧的调用约定（跨 namespace、凭证轮换）还没与 BFF 对齐，默认仍是明文 HTTP。
4. **资源配额与密度参数**来自 Phase 0 P6 实测，当前 chart 的 `runtimeQuota` 默认关闭，不预设数字。
5. **集群级验证（envtest、kind、故障演练）未执行**：本机 `kubectl` 存在但没有可用集群上下文，`helm` 也不在系统 PATH（渲染验证用 Go SDK 完成）。相关验收项在 `docs/implementation/cell-manager.md` 标为"未验收"。

## 验收

`apps/cell-manager` 内 `go test ./...` 与 `go vet ./...` 必须通过。状态机负例（busy 不缩、drain 竞态、非法 tenant/cell、generation 落后不就绪、PVC 保留）见 `docs/implementation/cell-manager.md` 的清单与对应测试名。
