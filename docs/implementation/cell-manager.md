# Cell 管理器与 Helm 安全部署骨架（实施记录）

依据：[ADR-0014](../adr/0014-cell-lifecycle.md)。原平台/技术草案已于 2026-10-02 本地归档（见[文档维护、归档与脱密](../documentation-policy.md)）。当前部署形态见[架构](../architecture.md)：单台 VPS 是现状，Kubernetes 属未证明上线的愿景。

写入范围：`apps/cell-manager/**`、`deploy/helm/myrix/**`、`docs/adr/0014-cell-lifecycle.md`、本文件。未改动其它 deploy 文件、根配置与 `vendor/deepseek-harness`。

## 1. 结论先行

| 项 | 状态 |
|---|---|
| TenantCell CRD + Go controller-runtime 控制器 | **已实现并可编译** |
| 生命周期状态机（含 shared 缩到零、dedicated 常驻） | **已实现**，纯函数 + 负例测试 |
| 缩容的空闲证明门禁 | **已实现**，fail closed |
| leader election、仅 namespaced RBAC、namespace 缓存限定 | **已实现** |
| Helm chart（SaaS / private 同一套，values 注释齐全） | **已实现**，渲染与护栏均可测 |
| Pod 安全基线（cell + 管理器） | **已实现**，逐项断言 |
| 真实集群验证（envtest / kind / 故障演练） | **未执行**，见 §7 |
| 会话路由 ↔ 控制器内部接口 | **契约已定，调用方未接**（BFF 不在本次写入范围） |
| 驱动 `/v1/admin/idle` 端点 | **不存在**，控制器因此宁可停在 `Draining`，见 §6.1 |

## 2. 目录与入口

```text
apps/cell-manager/
├─ go.mod / go.sum                 独立 Go module，不进 pnpm workspace（无 .ts 文件）
├─ api/v1alpha1/                   TenantCell 类型 + 深拷贝（controller-gen 生成）
├─ cmd/cell-manager/main.go        进程入口：manager、leader election、内部 API
├─ config/crd/myrix.io_tenantcells.yaml   生成的 CRD（chart 内是同一份）
├─ hack/boilerplate.go.txt         生成代码的许可证头
├─ internal/
│  ├─ cell/k8s/objects.go          纯函数 manifest 构造：StatefulSet / Service / 卷
│  ├─ controller/reconciler.go     Reconcile：观测 → 决策 → 生效
│  ├─ controller/wantrunning.go    spec.wantRunning 写入器（内部接口用）
│  ├─ driver/                      驱动客户端 + 空闲证明校验（可注入）
│  ├─ state/machine.go             状态机（纯函数）
│  └─ state/validate.go            spec 语义校验（纯函数）
└─ test/chart/chart_test.go        用 Helm Go SDK 渲染 chart 并断言
```

`go.mod` 声明 module `github.com/myrix/apps/cell-manager`，依赖 controller-runtime v0.25.1 / k8s.io v0.37.1 / Helm v3.22.0（Helm 只用于测试）。`go.sum` 已提交。

## 3. 状态机

相位与迁移（`internal/state/machine.go` 的 `Decide`）：

| 当前 | 条件 | 下一步 | replicas |
|---|---|---|---|
| `""` / `Stopped` | `wantRunning`（dedicated 恒真） | `Starting` | 1 |
| `""` / `Stopped` | 不要求运行 | `Stopped` | 0 |
| `Starting` / `Waking` | 超时 | `Failed`（`wakeAttempts++`） | 1 |
| `Starting` / `Waking` | pod ready 且驱动返回 `bootId` | `Ready` | 1 |
| `Starting` / `Waking` | 驱动不可达 / pod 未就绪 | 原地 | 1 |
| `Ready` | 工作负载消失（被手工缩容） | `Starting` 或 `Stopped` | 1 / 0 |
| `Ready` | `observedGeneration != generation` | `Starting`（撤回 Ready，保留 bootId） | 1 |
| `Ready` | `wantRunning=false` | `Draining` | 1 |
| `Ready`（shared） | 静默 ≥ `idleTimeoutSeconds` | `Draining` | 1 |
| `Draining` | 驱动不可达 | 原地（不缩容） | 1 |
| `Draining` | drain 未确认 / 拒绝 | 原地 | 1 |
| `Draining` | drain 已确认 + 空闲证明通过 | `Sleeping` | **0** |
| `Draining` | 进程已不在（replicas=0 且无 pod） | `Sleeping` | 0 |
| `Sleeping` | `wantRunning=true` | `Waking` | 1 |
| `Failed` | 还有重试预算且 `wantRunning` | `Waking` | 1 |
| `Failed` | 预算耗尽 | 原地（60s 退避） | 保持 |

三条不变量，测试穷举覆盖：

1. **replicas 只能是 0/1**：`TestReplicasAreAlwaysZeroOrOne` 遍历全部相位 × tiers × wantRunning；`k8s.StatefulSet()` 另外 clamp。
2. **没有空闲证明就不缩容**：`TestBusyCellIsNeverScaledDown`、`TestUnreachableDriverNeverScalesDown`。
3. **`Draining` 没有任何回到 `Ready` 的边**：`TestDrainingNeverReturnsToReadyInOneStep` 穷举 `DriverReachable × drained × wantRunning × idle-present`。

### 3.1 空闲证明的字段契约

`POST {driver}/v1/admin/idle` 必须返回：

```json
{
  "proofId": "可选，用于审计",
  "bootId": "必须等于 GET /v1/ready 返回的当前 bootId",
  "noActiveTurns": true,
  "inboxEmpty": true,
  "flushed": true,
  "lastCommandAt": "RFC3339",
  "observedAt": "RFC3339"
}
```

校验（`driver.IdleProof.Validate`，纯函数）：bootId 一致、三个布尔全真、时间戳存在且合法、`observedAt` 不超前 1 分钟、不落后 2 分钟、`observedAt - lastCommandAt ≥ idleTimeoutSeconds`。任一不满足即拒绝，拒绝码写进条件 reason。

`POST {driver}/v1/admin/drain` 返回 `{drained, bootId, reason, rejectionCode}`；`rejectionCode` 为可选机器可读码（复用同一套：`ActiveTurns`/`InboxNotEmpty`/`NotFlushed`/…）。

`GET {driver}/v1/ready` 返回 `{bootId, status}`；`bootId` 为空视为不可信，不就绪。

## 4. Kubernetes 对象（控制器生成）

| 对象 | 名字 | 关键点 |
|---|---|---|
| StatefulSet | `<cell>` | `replicas` 0/1；`podManagementPolicy: Parallel`；PVC 保留策略双向 `Retain` |
| Service（headless） | `<cell>-driver` | 选择器只含 `myrix.io/cell`，不可能路由到别的租户 |
| PVC（volumeClaimTemplate） | `dsh-home-<cell>-0` | `ReadWriteOnce`，挂到 `/var/lib/myrix/dsh-home` |
| Secret（引用） | `spec.runtime.credentialsSecret` | 每租户一个，`0400` 只读挂载到 `/var/run/myrix/credentials`，`optional=false` |

Cell pod 安全基线（`internal/cell/k8s/objects.go`，逐项断言于 `objects_test.go`）：

- `runAsNonRoot=true`（uid/gid 65532）、`allowPrivilegeEscalation=false`、`capabilities.drop=[ALL]`（无 add）、`seccompProfile=RuntimeDefault`；
- `readOnlyRootFilesystem=true`，可写挂载只有 `DSH_HOME` 与 `/tmp`（`emptyDir` 256Mi 上限）；
- `automountServiceAccountToken=false`、`enableServiceLinks=false`；
- 探针是 HTTP `GET /v1/ready`，**不是 exec**（镜像里没有 shell）；liveness 阈值放宽，避免慢但活着的 cell 被中途杀掉；
- 禁用 host namespace 与 hostPath。

镜像/命令是操作者输入：`spec.runtime.image` 必填，`command`/`args` 可配；**本仓库不发布任何镜像**，chart 在镜像为空时直接 fail。

## 5. RBAC 与内部接口

- **只有 namespaced Role**，没有 ClusterRole/ClusterRoleBinding（`TestNoClusterScopedRBAC` 渲染断言）。
- informer 缓存限定 `runtimeNamespace`（`main.go` 的 `cache.Options.DefaultNamespaces`），Reconciler 另外硬校验 `cell.Namespace`，不一致即报错并记事件（`TestForeignNamespaceIsRefused`）。
- PVC 与 Secret 只读；代码中不存在删 PVC 的路径。
- 跨租户护栏：StatefulSet 已有 label 属于其它租户时**拒绝修改**（`TestExistingWorkloadForAnotherTenantIsNotAdopted`）；`spec.tenantId` 与 `myrix.io/tenant` 不一致时**不创建任何工作负载**（`TestInvalidTenantLabelIsRejectedWithoutWorkload`）。

内部唤醒接口（`internal/apiserver`）：

```text
POST /internal/v1/cells/{cell}/want-running
Authorization: Bearer <MYRIX_INTERNAL_TOKEN>
Body: {"wantRunning": true|false}
→ 202 {"cell":"...","wantRunning":true}
```

token 为空时**服务器不启动**（fail closed）；未知路径 404、非 POST 405、缺字段 400、写入失败 409；比较用 `subtle.ConstantTimeCompare`。调用方是会话路由（BFF），路由自己不需要 K8s 权限——这正是原技术草案 §4.6 的分工（草案已本地归档）。

## 6. Helm chart

```text
deploy/helm/myrix/
├─ Chart.yaml
├─ values.yaml                 全部字段带注释
├─ values-saas.yaml            多租户、shared、管理器多副本选主
├─ values-private.yaml         单租户、dedicated、单副本、内置一个 TenantCell 示例
├─ crds/tenantcell-crd.yaml    与 apps/cell-manager/config/crd 同一份
└─ templates/
   ├─ _helpers.tpl             命名/标签/镜像/内部 token Secret 名
   ├─ _validate.tpl            渲染期护栏（被 cell-contract.yaml include 一次）
   ├─ cell-contract.yaml       契约 ConfigMap（驱动路径、默认值、replicas 0/1）
   ├─ runtime-namespace.yaml    可选创建 Runtime namespace（默认关，带 keep）
   ├─ rbac.yaml                ServiceAccount + 两个 Role/RoleBinding
   ├─ deployment.yaml          管理器 Deployment
   ├─ service.yaml             Service + PDB + 可选 cert-manager Certificate
   ├─ monitoring.yaml          可选 ServiceMonitor + 管理器 NetworkPolicy
   ├─ networkpolicy-runtime.yaml  双向 default deny + BFF 入站 + 网关/作品/DNS 出站
   └─ tenantcells.yaml         ResourceQuota（可选）+ 显式列出的 TenantCell
```

要点：

- **CRD 放 `crds/`**：Helm 只 install，不 upgrade、不 delete。改 CRD 必须人工 `kubectl apply`。
- **Runtime namespace 默认不由 chart 创建**：租户数据（PVC）在那里，`helm uninstall` 不能有删数据的可能。显式开启时对象带 `helm.sh/resource-policy: keep` 与 PSA `restricted` 标签。
- **NetworkPolicy**：Runtime namespace 上 `podSelector: {}` 双向 default deny，新租户自动继承；入站只放 BFF namespace 到驱动端口，出站只放模型网关、作品服务、集群 DNS。cell 之间没有放行规则 → 被 default deny 覆盖；cell 也到不了 API server 与公网。
- **渲染期护栏**拒绝：空 `cellManager.image.repository`、`profile=private` 配明文 token、`replicaCount>1` 却不选主、`networkPolicy.runtime.bff.namespace` 为空、非法 tier、dedicated 且 `wantRunning=false`、`tenantCells.*.runtime.image` 为空。
- **内部 token Secret**：`existingSecret` 优先；否则随机生成并用 `lookup` 在 upgrade 时保留；`internal.token` 仅供开发，private 档会被拒绝。

## 7. 验证方式与结果

### 已执行

```bash
cd apps/cell-manager
go build ./...
go vet ./...
go test ./... -count=1
```

结果：`go build` 与 `go vet` 无输出（通过）；**105 个测试用例全部 PASS**，覆盖 7 个包。chart 测试用 Helm Go SDK 渲染，**不需要集群也不需要 helm CLI**。

重新生成 CRD 与深拷贝：

```bash
cd apps/cell-manager
controller-gen object:headerFile="hack/boilerplate.go.txt" paths="./api/..."
controller-gen crd paths="./api/..." output:crd:artifacts:config=config/crd
cp config/crd/myrix.io_tenantcells.yaml ../deploy/helm/myrix/crds/tenantcell-crd.yaml
```

（本次用 controller-gen v0.19.0 生成。）

### 验证环境边界

历史验证仅覆盖 Go 测试和 Helm 渲染，**没有真实集群级验证**：未 apply CRD、未起 pod、未跑故障演练或缩容/唤醒的实机竞态。上文“已实现”仅指代码与渲染层面。本轮未重跑 Go/Helm/envtest；使用者须准备专用集群及兼容的 Go、Helm、kubectl 与 envtest 二进制，不能依赖维护者机器的临时工具路径。

### 负例清单（要求项 → 测试）

| 要求 | 测试 |
|---|---|
| busy 不缩 | `TestBusyCellIsNeverScaledDown`（8 个子例）、`TestBusyCellIsNotScaledToZero`（控制器层） |
| drain 竞态 | `TestCommandDuringDrainWaitsForSleepThenWakes`、`TestDrainingNeverReturnsToReadyInOneStep`、`TestDrainRefusalKeepsCellRunning` |
| invalid tenant | `TestInvalidTenantLabelIsRejectedWithoutWorkload`、`TestExistingWorkloadForAnotherTenantIsNotAdopted` |
| invalid cell | `TestInvalidTierIsRejected`、`TestMissingCellLabelIsAccepted`、`TestForeignNamespaceIsRefused` |
| generation stale 不 ready | `TestStaleGenerationIsNotReady`（控制器层）、`TestStaleGenerationIsNotReady`/`TestReadyRequiresReadyReplicaAndBootID`（状态机层） |
| PVC 保留 | `TestIdleProvenCellIsScaledToZeroAndPvcKept`、`TestPerTenantVolumeIsRWOPreservedAndNeverShared` |
| 驱动不可达不缩容/不就绪 | `TestUnreachableDriverNeverScalesDown`、`TestBootWithUnreachableDriverIsNotReady`、`TestHTTPClientUnreachableDriver` |
| 权限只用 namespaced Role | `TestNoClusterScopedRBAC`、`TestRBACIsNamespaceScopedAndNarrow` |
| 安全基线 | `TestSecurityBaseline`、`TestManagerSecurityBaseline`、`TestPerTenantSecretIsMountedReadOnly`、`TestRuntimeNetworkPolicyDefaultsToDeny`、`TestRuntimeEgressOnlyReachesGatewayAndWorks`、`TestRuntimeIngressOnlyFromBFF` |
| 内部接口鉴权 | `TestDisabledWithoutToken`、`TestAuthorisationAndRouting`、`TestWriteFailureIsReported` |
| chart 安全护栏 | `TestChartRefusesUnsafeValues`（7 个子例）、`TestChartRendersBothProfiles` |

## 8. 当前阻断项与未完成范围

1. **drain/idle 已有 driver 端点，控制器凭据链未闭合**：[driver router](<../../plugins/myrix-runtime-driver/src/router.ts>)已实现两个认证端点；[Go客户端](<../../apps/cell-manager/internal/driver/client.go>)尚未携带相应凭据。不能把端点存在当作 Kubernetes 缩容可用；须补齐凭据与真实集群验证，不得放宽 `Draining` 的证据条件。
2. **内部接口的真实路径已写进文档与 chart**（`/internal/v1/cells/{cell}/want-running`，Bearer token）。BFF 侧的调用、跨 namespace 的网络放行与凭证轮换尚未实现；`networkPolicy.cellManager.internalNamespaces` 是为此预留的开关。
3. **每租户凭证 Secret 的写入方未定**：控制面渲染还是平台作业。当前只约定"每租户一个、`0400` 只读、缺失即不启动"。
4. **内部接口 TLS**：chart 支持 cert-manager 或自带 Secret；[main.go](<../../apps/cell-manager/cmd/cell-manager/main.go>)已支持证书/私钥参数和 HTTPS 监听，二者只填其一即拒绝启动。未提供时是明文 HTTP；服务端 TLS 不等于已验证双向认证，客户端证书校验、BFF 接线及真实网络边界仍须单独验收。
5. **资源配额与密度参数**：`runtimeQuota` 默认关闭，等待 Phase 0 P6 实测数字，不预设。
6. **节点级 mTLS 与冷启动指标**（P6）未测。
7. **`spec.runtime.driverBaseURL` 的网格寻址**：默认走 pod IP + 端口；若改用 Service/mesh，需要通过该字段注入，尚未与 BFF/基础设施对齐命名。

## 9. 后续集群验收（有集群后按此执行）

```bash
# 1) CRD
kubectl apply -f deploy/helm/myrix/crds/tenantcell-crd.yaml

# 2) 安装（镜像必须由操作者提供）
helm install myrix deploy/helm/myrix \
  -f deploy/helm/myrix/values-saas.yaml \
  --set cellManager.image.repository=<registry>/myrix/cell-manager \
  --set cellManager.image.tag=<tag>

# 3) 观察
kubectl -n myrix-runtime get tenantcells -w
kubectl -n myrix-runtime get sts,pvc,pod

# 4) 缩到零：置 wantRunning=false，确认状态在 Draining 停住直到驱动给出空闲证明
kubectl -n myrix-runtime patch tenantcell cell-t1 --type=merge -p '{"spec":{"wantRunning":false}}'

# 5) 唤醒：置回 true，确认 Waking → Ready 且 bootId 变化
```

预期：`Draining` 不会被跳过（除非驱动实现并返回了合法证明）；缩到 0 后 `dsh-home-cell-t1-0` 这个 PVC **仍然存在**。
