# 模块边界与健壮性复盘（2026-10-02）

## 结论与范围

本次基于 `3eb7283`，在 `refactor/module-boundaries-quality-gates` 分支完成架构复盘、限定加固和可执行门禁。
DeepSeek 分别审查/实现治理、registry、SSE、lint，并起草文档；主代理逐项复核 diff、修正遗漏并独立运行验证。
这不是“所有模块已重构完毕”或“生产上线验收通过”：M1/M2 与后续风险明确留在下文。
没有修改 vendor，也没有把 legacy 演示的缺陷夸大为当前生产链路的漏洞。

## 1. 实际链路与职责

```text
novel-web → BFF（OIDC、HTTP/SSE、用例编排）→ tenant Cell（DSH + myrix-*）
                │                                  ├→ works HTTP → platform-store → PostgreSQL/RLS
                └→ platform-store                  └→ myrix-llm-gateway → Responses gateway → 上游 /responses
```

| 模块 | 应负责 | 不应负责 |
| --- | --- | --- |
| [contracts](../../packages/contracts/src/index.ts) | 共享契约 | I/O、运行时实现 |
| [governance](../../packages/governance/src/index.ts) | 纯函数 PDP、平台授权、义务合并 | 数据库、网络、隐式系统时钟 |
| [registry](../../packages/registry/src/index.ts) | 功能目录、授权闭包、profile 中间表示/渲染 | 文件落盘、隐式时钟、DSH 生命周期 |
| [platform-store](../../packages/platform-store/src/index.ts) | RLS、所有权、CAS、事务与持久化用例 | HTTP、Cordis 生命周期 |
| [BFF 装配](../../apps/bff/src/production.ts) | 认证、HTTP 边界、应用用例编排 | 复制授权算法、直接实现 Cell 插件 |
| [网关](../../apps/model-gateway/src/gateway.ts) | Responses 校验、上游调用、额度结算 | 工具级授权、协议隐式回退 |
| [Cell 装配](../../bundles/myrix-base/cell.patch.yml) | 显式白名单插件、租户运行时隔离 | 保存企业授权真相、持有上游模型密钥 |
| [novel-web](../../apps/novel-web/src/api/endpoints.ts) | 交互与前端状态 | 服务端实现、直接访问数据库/DSH |

BFF 与 works 是两个 Fastify 实例/端口，由同一生产装配进程启动，并非两个独立进程。
当前首版部署目标仍是单台 VPS，见 [ADR 0029](../adr/0029-single-vps-runtime.md)。Kubernetes 不属于本次上线验收。

### 与 legacy 分开

`pnpm dev:legacy` 启动的是 [内存治理控制面](../../packages/control-plane/src/store.ts)，不是持久化小说工作台。
[dsh-shim](../../packages/dsh-shim/src/index.ts) 与 [旧 governance 插件](../../plugins/dsh-plugin-governance/src/plugin.ts)、
[旧 entitlement 插件](../../plugins/dsh-plugin-entitlement/src/plugin.ts) 属于该演示路线。
生产 [myrix-base 装配](../../bundles/myrix-base/cell.patch.yml) 不加载 `dsh-plugin-*`。

## 2. 本 PR 已落地的限定修复

1. **条件/规则畸形不再被取反成 allow。** [条件求值](../../packages/governance/src/condition.ts) 先完整校验再求值，区分 malformed 与普通不匹配，限制深度 32；根 `undefined` 仍表示无条件，分组内 `undefined`、空对象、非法运算符/值/正则和循环均拒绝。保留 `all: []` 的既有语义。
2. **deny-overrides 有可读解释。** [decideExplained](../../packages/governance/src/decide.ts) 对可能适用的畸形 deny fail-closed；明确不适用的 tenant/action/resource 不误伤其他请求。畸形 allow 不成为允许，公开 `PolicyDecision.matched` 契约不变。
3. **角色按租户分区并隔离可变引用。** [RoleStore](../../packages/governance/src/roles.ts) 以租户/id 查找，只回退到全局定义；全局分区使用 Symbol，避免字面租户 `"*"` 碰撞；校验字符串数组并复制输入/输出。参见 [回归测试](../../packages/governance/tests/hardening.test.ts)。
4. **义务合并只收紧。** [sandbox 合并](../../packages/governance/src/obligations.ts) 将未知档位归一到 `read-only`，结果与输入顺序无关。
5. **registry 不隐式放行或读时钟。** [授权计算](../../packages/registry/src/entitlement.ts) 对非 active/未知主体状态禁用全部功能，要求注入 `now`；[profile 构建](../../packages/registry/src/profile.ts) 同样要求时钟注入。
6. **冲突裁剪后再次闭合依赖。** [目录闭包](../../packages/registry/src/catalog.ts) 区分首轮与连锁缺失；已被裁掉的冲突对手不再误删可用插件；provider 被禁用后消费者及孙级也禁用，所有层级保留可读原因。参见 [registry 回归](../../packages/registry/tests/registry.test.ts)。
7. **SSE 写出独立且有界。** 新 [writer](../../apps/model-gateway/src/stream.ts) 尊重 `write=false`，等待 drain 时可被 close/error/内部 abort 唤醒；[HTTP 层](../../apps/model-gateway/src/server.ts) 在等待上游响应头前就监听客户端断线。正常读者仍能收到内部 abort 后的一次有界脱敏 error 通知；慢消费者/断线不再等待终态写入。保持未知用量保守结算，未放宽额度或协议。
8. **公开入口替代跨包私有导入。** BFF/gateway 改走已有的 platform-store 公共入口，BFF 使用已有 `@myrix/novel/protocol` 子路径，并补齐 workspace 依赖声明。没有为了消除 lint 发布 raw audit helper。
9. **质量门禁进入 CI。** [Oxlint 配置](../../.oxlintrc.json) 将 correctness/unused/debugger 纳入检查；现有 React 手工状态模型不强制套用编译器专用限制，安全控制字符正则使用局部说明。其余清理主要是未用导入/变量、测试断言与完整 effect 依赖。

授权语义和兼容性决策见 [ADR 0033](../adr/0033-condition-malformed-and-role-partition.md)。
主体 active 由身份边界确认，PDP 不赋予任意业务属性 `attributes.status` 隐式含义。
普通不匹配仍可能被合法 `none` 取反；属性必须由可信调用方提供，不能用仅依赖 `neq`/`notIn` 的 deny 表达“属性必须存在”。

### 主代理复审补正

- 发现仅用转译结果查依赖会漏掉 `import type`，改为 Oxc 源 AST，并补独立 checker 测试。
- 发现全局角色字符串哨兵会与真实租户 id 碰撞，改为 Symbol；补权限数组元素校验。
- 补齐依赖连锁禁用的原因，跳过失效冲突对；覆盖回归。
- 发现仅监听客户端 abort 会令内部 timeout 无法唤醒 drain，改用合并 signal；再修复合并 abort 吞终态 error 的回退。
- 将临时目录放回项目后暴露容器夹具的路径假设，修改 [测试夹具](../../tests/containers/cell-entry.test.mjs) 模拟分开的应用/home 挂载，**未放宽生产路径校验**。

## 3. 可执行边界与精确迁移债

[检查器](../../scripts/check-boundaries.mjs) 解析各 workspace 的生产 `src`（含声明文件、类型导入、重导出、动态 import、直接 require），检查依赖声明、exports、跨层及跨包相对路径；computed import 必须改为可审查的静态映射。
[七项回归](../../tests/ci/module-boundaries.test.mjs) 覆盖类型边、私有入口、层次约束、解析失败及陈旧例外。

约束：纯域只依赖 contracts/本地代码；共享包不反向依赖 apps/plugins；plugins 不依赖 apps；apps 不互导实现；浏览器不导入服务端 workspace。
这不是安全沙箱，也不证明所有全局 I/O 都被阻止；间接 require、未来别名/构建器解析、第三方依赖行为仍需代码审查。测试夹具允许跨模块组装，未纳入生产边界扫描。

| 迁移债 | 当前限定 | 下一步与完成标准 |
| --- | --- | --- |
| **M1：协议归属（后续打包修复已完成）** | BFF/plugin 共同依赖无外部依赖的 `@myrix/novel-protocol`；原插件子路径仅兼容重导出 | 已删除 apps→plugins 特例；补安装依赖闭包回归与 PR 双架构真实构建。只引用子路径也会安装整个插件闭包，不能作为运行时隔离依据 |
| **M2：事务用例归属** | 仅 [runtime-router](../../apps/bff/src/runtime-router.ts) 与 [runtime-recovery](../../apps/bff/src/runtime-recovery.ts) 可深导入 `insertAuditEvent` | 将 delivery/recovery transition + audit 作为 platform-store 用例，在同一事务中提交；补原子性集成测试并删除两条例外 |

M2 不能简单替换成另开事务的 `AuditRepository.write`，否则业务状态与审计会失去原子性。
[两条例外](../../scripts/check-boundaries.mjs#L9-L14) 精确到源文件→目标文件，失效后门禁要求删除，不允许泛化为目录豁免。

## 4. 后续计划（未在本 PR 声称完成）

| 优先级/边界 | 已识别问题 | 建议动作与验收 |
| --- | --- | --- |
| P1：持续开发前 | M1/M2 仍由特例维持边界 | 优先迁出协议与事务用例，再拆编排层；不以扩大 exports 掩盖耦合 |
| P1：legacy 对外开放前 | [控制面 HTTP](../../packages/control-plane/src/server.ts) 输入校验浅、错误透传；[store](../../packages/control-plane/src/store.ts) 用手写过滤重复解释 plugin deny | 加 schema/错误脱敏，统一策略入口；负例覆盖错误布尔值、tenant/action/wildcard、非法 baseIds |
| P1：legacy 功能授权用于生产前 | [grantMatches](../../packages/registry/src/entitlement.ts) 未执行契约中的 constraints | 定义可执行语义或显式拒绝非空约束，不能 UI 承诺而计算忽略 |
| P1：启用旧插件前 | [shim](../../packages/dsh-shim/src/index.ts) 的 guard/restrict、scope/disposer 与真实 Cordis 有偏差，旧插件缺卸载清理 | 对齐实际同步 guard、scoped restrict、disposer/timer；补加载/卸载测试，或正式弃用 legacy 路线 |
| P2：profile 渲染 | [quote](../../packages/registry/src/profile.ts) 未转义换行/控制字符 | 正确 YAML 转义并加 round-trip 测试 |
| P2：契约单一来源 | [平台角色](../../packages/governance/src/authorize-platform.ts) 与 [store 角色](../../packages/platform-store/src/domain.ts) 常量重复（目前语义一致） | 共享来源并用测试核对 SQL check，避免将顺序不同误报成权限缺陷 |
| K8s 启用阻断项 | [driver client](../../apps/cell-manager/internal/driver/client.go) drain/idle 调用缺少凭据，但 [driver router](../../plugins/myrix-runtime-driver/src/router.ts) 要求认证 | 补 token 的 Secret 引用、注入、最小 RBAC 与真实 HTTP/chart 测试；当前 VPS 不依赖此链路 |
| P2：按用例模块化 | [runtime-router](../../apps/bff/src/runtime-router.ts)、[controller](../../plugins/myrix-runtime-driver/src/controller.ts)、[wire](../../plugins/myrix-llm-gateway/src/wire.ts) 仍偏大 | 按投递/恢复/复核、create/resume/send/cancel、协议事件族拆分，保留事务、结算、授权不变量；不做单纯按行数切文件 |
| P2：前端构建 | 生产 JS chunk 约 707 kB，Vite 提示超过 500 kB | 做路由/编辑器按需分包，单独测交互时延与产物，不提高阈值掩盖 |

正面控制仍保留：BFF OIDC/origin/CSRF、Responses-only/store:false、平台 RLS/所有权/CAS、账本预占/幂等结算、Cell 白名单与命名空间约束、前端会话代际隔离。
Cell 可以持有自己的 works/gateway/drain/revoke 凭据，但不应持有上游模型密钥、数据库凭据、平台签名私钥或 OIDC secret。

## 5. 主代理验证记录（2026-10-02）

| 检查 | 实际结果 |
| --- | --- |
| `pnpm install --frozen-lockfile --ignore-scripts` | 通过，lockfile 无需解析更新 |
| `pnpm lint` | 0 warnings / 0 errors；187 个生产源文件、2 条精确事务例外通过 |
| `pnpm typecheck` | 根项目及 novel-web 均通过 |
| `pnpm test` 后端 | **1086 passed / 101 skipped**，67 个测试文件通过、9 个全量跳过 |
| `pnpm test` 前端 | **181 passed**，16 个文件通过 |
| `pnpm test:ci` | **229 passed / 0 skipped**（边界、容器、VPS、认证装配、profile 工厂） |
| `pnpm build:web` | 通过；仍有上文 bundle size warning |
| `go test -count=1 ./...` / `go vet ./...`（cell-manager） | 通过，6 个有测试的 Go package |
| `git diff --check` | 通过 |

跳过的 101 项主要是需要显式数据库连接的 BFF/gateway 集成、runtime recovery/router、command idempotency；不能把总测试命令成功解释成这些路径已验收。
platform-store 的 32 项真实 PostgreSQL 集成与 4 项迁移测试在本机通过。
未执行真实浏览器/公网模型/生产 OIDC/Kubernetes/镜像发布验收；现有 CI 仍负责配置专用 PostgreSQL 后运行完整数据库门禁。

### 项目内缓存与临时目录

[.npmrc](../../.npmrc) 把 pnpm store/cache/state 固定在项目内；[Git 忽略](../../.gitignore) 与 [Docker 忽略](../../.dockerignore) 防止提交/打包缓存。
本轮 Go/临时文件也仅写入 checkout，未为验证新建项目外工作目录：

```bash
mkdir -p .cache/quality/{tmp,go-cache,go-mod,go-path}
export TMPDIR="$PWD/.cache/quality/tmp"
export GOCACHE="$PWD/.cache/quality/go-cache"
export GOMODCACHE="$PWD/.cache/quality/go-mod"
export GOPATH="$PWD/.cache/quality/go-path"
export GOTELEMETRY=off
pnpm lint && pnpm typecheck && pnpm test && pnpm test:ci && pnpm build:web
go -C apps/cell-manager test -count=1 ./...
go -C apps/cell-manager vet ./...
```

入口见 [README](../../README.md) 与 [CI](../../.github/workflows/docker.yml)。日志留在本地忽略目录，不把机器路径、依赖缓存或用户原有临时材料提交进 PR。
