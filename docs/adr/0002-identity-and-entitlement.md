# ADR-0002：账号体系、身份注入与插件授权自治理

- 状态：已接受（M0），身份注入路径待 M1 实测
- 日期：2026-09-30
- 相关：ADR-0001、ADR-0005

## 背景

DSH 0.2.0-rc.2 没有企业用户体系，这是事实而非缺陷：

- `packages/identity` 只有 `anonymous-user-id`：纯库、无 service、无 config，仅"每个 Harness home 一个匿名 UUID"，
  用于遥测/反馈（`packages/identity/anonymous-user-id/README.md:34-36,69`）。
- Web 层是**单 operator** 模型：每进程 launch token → 仅 `GET /` 兑换 authority-bound 签名 Cookie；
  请求信任 fence 明确"不建立身份"（`packages/client/connection/src/api-request-trust.ts:11-13,91`）。
- 唯一的主体抽象是 `ctx.connection.operator: PeerScope`，且注释写明"Who the Peer is and what it may do are
  not recorded here"（`packages/typert/protocol/src/types.ts:377-390`）。
- `api-account-controller` 是 DeepSeek 平台账号（登录/额度/赠金），不是企业账号（`packages/api/account-controller/src/index.ts:10-13`）。

## 决策

1. **身份权威在控制面**：企业 IdP（OIDC/LDAP/飞书）→ 归一化为 `Principal`（`tenantId`、`groups`、`department`、
   `attributes`），落 `principals` 表，存 `(idp, external_id)` 映射。
2. **数据面通过配置注入 `principalId`**（v1 形态）：一人一 Harness home / profile 的场景下，
   `myrix-governance` / `myrix-entitlement` 的 `principalId` 由 profile 渲染时写入，运行时不接受模型或用户输入的改写。
3. **插件授权按主体自治理**：`plugin_grants` 的 `grantee` 支持 `u_xxx` / `role:xxx` / `group:xxx` / `tenant:xxx`；
   计算链为 租户基线 → 授权叠加 → 策略 deny 覆盖 → 依赖闭合 → 冲突收敛，且每步产生可读原因。
4. **多用户共进程的路径（M1 决定）**：
   - 方案 B1：自建 Connection provider，让 `PeerScope` 携带企业身份（改 `packages/client/connection` 的
     carrier/loader 行或替换实现）；
   - 方案 B2：DSH 之前放一个**认证 BFF**，由 BFF 完成 SSO 与会话管理，再以"一用户一进程/home"或独立
     WebServer（`cordis:group` + `isolate.webServer`）形态转发。
   倾向 B2：不改上游、风险可控；B1 留作后续优化。

## 理由

- 身份是**治理的前提**：没有可信主体，RBAC/ABAC、审计、配额都无从谈起。
- 把身份注入限制在"启动时由平台写入"而不是"运行时由请求决定"，可以避免在 DSH 尚未具备身份模型时被绕过。
- 授权自治理（谁能用哪些插件）与管理后台天然一体，避免"改配置文件发权限"的暗箱操作。

## 备选方案与为什么拒绝

| 方案 | 拒绝理由 |
| --- | --- |
| 用 `anonymous-user-id` 当用户 ID | 它是 home 级匿名标识，跨 home 不可关联，且不含组织信息 |
| 用 DeepSeek 平台账号体系 | 面向 C 端账号，与企业管理诉求（组织、离职、审计）不匹配 |
| 在 DSH 内直接读 `process.env.USER` / OS 账号 | 不可信、不可审计、无法跨平台统一 |
| 一次性做多租户共进程改造 | 需要改上游连接层，风险与工作量都大；先用 B2 拿到收益 |

## 后果

- 正面：身份、授权、审计闭环；插件授权可解释可回滚。
- 负面：一人一 home 形态资源成本高；B2 的 BFF 需要自己实现会话与 SSO（但这是企业标准做法）。
- 待验证（详见对接清单第 8 节）：
  1. 能否在不 fork 的前提下替换 `PeerScope`（`packages/client/connection/src/rpc-host.ts:81,110-112`）；
  2. `dsh web --host 0.0.0.0` 的实际支持边界（README 说"仍不支持"，config 却接受该值）；
  3. `ctx.settings` 能否作为企业配置下发面。

## 验收标准（M1）

1. 一次 OIDC 登录后，控制面能给出 `Principal`，并渲染出该主体的 profile。
2. 两个不同主体的工具可见性、沙箱档位、知识库可见范围互不相同，且都能在审计里追溯到原因。
3. 撤销授权后，新会话立即不加载对应插件（冷路径），运行中会话在 TTL 内收紧掩码（热路径）。
