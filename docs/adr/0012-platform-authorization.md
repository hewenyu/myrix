# ADR-0012：首版平台授权（D11 单一所有者）与纯函数判定

- 状态：已接受（首版）
- 日期：2026-09-30
- 相关：ADR-0001（分层治理）、ADR-0002（身份与插件授权）、[业务说明](../business.md)、[架构](../architecture.md)。
  原平台/技术草案已于 2026-10-02 本地归档，见[文档维护、归档与脱密](../documentation-policy.md)。

## 背景

首版（MVP）只有一件事：小说创作。原平台草案的 D11 决策规定**会话与作品都是单一所有者，不做多人协作**（草案已本地归档），
会话创建/恢复/发消息都必须核对"当前用户仍是租户成员且是资源所有者"。

在这之前，仓库里只有三层东西：

- `@myrix/governance` 的 `decide()`：通用 RBAC/ABAC 规则引擎，规则来自数据库；
- `packages/control-plane/src/store.ts`：把主体展开成 `SubjectContext` 再问 `decide()`；
- `packages/registry`：把结论渲染成 DSH profile。

缺的是**平台自身的动作授权**：作品、章节、设定、大纲、会话、成员、审计这些平台概念，
在首版里没有对应的 `PolicyRule`，也没有服务端强制点。谁调用 API、能不能看别人的作品、
管理员能不能进别人的会话，全靠调用方自觉。同时 `decide()` 有两处与仓库硬性规则冲突：

1. 它内部读系统时钟（`new Date()`），判定不可复放，单测无法固定时间；
2. 它支持 `defaultEffect: "allow"`，即"没有规则命中就放行"——策略下发失败等价于全面放开，
   违反 AGENTS.md 硬性规则 1（所有放行路径必须显式、默认 fail-closed）。

## 决策

### 1. 平台动作授权是独立的纯函数 `authorizePlatform`

不把平台动作塞进 `decide()` 的规则表。首版的动作集合、角色矩阵、所有权要求是**固定的**，
写死在 `packages/governance/src/authorize-platform.ts` 里，比"往数据库塞 24 条规则、
每条都可能配错"更可审计、更容易做负例测试。`decide()` 继续服务 DSH 工具/知识库那类
需要按租户热更新的策略。

```ts
// 统一返回 effect + reason，调用方只做分支，不解析 reason
export function authorizePlatform(input: AuthorizePlatformInput): { effect: "allow" | "deny"; reason: string };

interface AuthorizePlatformInput {
  actor: { tenantId: string; userId: string };
  member?: { tenantId: string; userId: string; status: "active" | "disabled"; role: "member" | "admin" | "auditor" };
  action: string;                       // 显式 allowlist，未知即拒绝
  resource?: {
    tenantId: string;
    ownerUserId?: string;               // 资源所有者；members:update 时是目标成员
    status?: string;                    // 会话状态 / 目标成员状态
    revision?: number;                  // 会话撤权版本 / 行版本
    role?: string;                      // members:update 的目标成员角色
  };
  expectedRevision?: number;            // 会话操作必填，与 resource.revision 必须一致
}
```

调用方（控制面/BFF）负责：从数据库读当前成员记录、读资源、读撤权版本。
纯函数不读数据库、不读时钟、不做 I/O。**`member` 未找到时传 `undefined`，不得省略、不得猜测**。

### 2. 动作清单是显式 allowlist

| 类别 | 动作 | 资源要求 |
| --- | --- | --- |
| 作品 | `works:list` `/create` `/read` `/update` `/delete` | 读/改/删必须 `ownerUserId` = 本人；list/create 无单一资源 |
| 会话 | `sessions:list` `/create` `/read` `/send` `/resume` `/cancel` `/subscribe` `/revoke` | `create` **必须带资源**，且"所有者"是**目标作品**的所有者；其余除 list 外必须所有者匹配，已存在会话必须带 `status` 与 `expectedRevision` |
| 成员 | `members:list` `/update` | `update` 仅 admin，且目标必须是同租户**非 admin、非本人**成员 |
| 审计 | `audit:list` | 仅 admin / auditor，只读本租户 |
| 模型 | `models:invoke` | 同租户 active 成员；若带 `ownerUserId` 则必须是本人（不能把用量归因/计费到他人资源）；配额与归因在模型网关执行 |
| 内容 | `chapters:read/write`、`bible:read/write`、`outline:read/write` | 必须所有者匹配 |

无单一目标资源的动作只有：`works:list`、`works:create`、`sessions:list`、`members:list`、
`audit:list`、`models:invoke`。其余动作缺 `resource` 一律拒绝。

不在表内的 action（含空串、`admin:*`、`sessions:impersonate`）一律拒绝。

### 3. 角色矩阵与管理员边界

- `member`：上表中除 `members:update`、`audit:list` 外的全部动作，且只能作用于本人资源。
- `admin`：member 的全部动作 + `members:update` + `audit:list` + `sessions:revoke`（可作用于他人会话）。
- `auditor`：只有 `audit:list`。

管理员**不能**：

- 冒充他人读取/发送/恢复/订阅/取消他人会话（`sessions:read|send|resume|subscribe|cancel` 仍要求所有者匹配）；
- 变更自己的成员状态（自锁与自助提权）；
- 停用其他管理员（首版无 owner 角色，避免管理员互相停用）。

管理员唯一能作用于他人资源的动作是 `sessions:revoke`，其 reason 明确写出"该动作不读取会话内容"。

### 4. 成员身份本身不构成内容访问权

"是同一个租户的成员"只决定 `works:list`、`works:create`、`sessions:list`、`members:list`、
`models:invoke` 这类**无单一目标资源**的动作。任何指向具体作品/章节/设定/大纲/会话的动作，
都必须 `resource.ownerUserId === actor.userId`。特别地，`sessions:create` 的授权对象是**作品**：
有成员身份不等于有在别人作品上创建会话的权利。

### 5. `decide()` 的时钟必须注入，默认放行被删除

- `DecideOptions.now` 变为**必填**（`string | Date`），`evaluatedAt` 直接取注入值。
  控制面在 `GovernanceStore` 构造时注入时钟（`options.now`，缺省 `() => new Date()`），
  这也是控制面唯一允许读时钟的地方；`GovernanceStore.decide()` 的 `input.at` 可逐次覆盖。
- `defaultEffect` 的类型收窄为 `"deny"`，运行分支固定返回 `matched: "default-deny"`。
  仍写 `defaultEffect: "allow"` 的调用方在**编译期**报错，而不是运行期静默放行。

## 判定顺序（任一步不成立即拒绝）

1. `action` 在 allowlist 内；
2. `actor.tenantId` / `actor.userId` 非空；
3. `member` 存在、与 actor 同租户同用户、`status === "active"`、角色在 `member|admin|auditor` 内；
4. 角色白名单覆盖该 action；
5. `expectedRevision` 合法（非负整数）；
6. 资源存在性：无资源的 action 仅限第 4 节列出的那几个；
7. `resource.tenantId` 与主体租户一致（跨租户直接拒绝）；
8. `resource.status` / `resource.role` / `resource.revision` 合法性与动作适配；
9. 会话操作：状态不是 `revoked`，且必须提供 `expectedRevision`；
10. `expectedRevision` 与 `resource.revision` 一致（撤权版本不匹配 = 拒绝）；
11. 所有者类动作：`ownerUserId === actor.userId`，唯一例外是 admin 的 `sessions:revoke`；
12. 同租户能力动作按 `TENANT_SCOPED_REASONS` 放行。

## 拒绝原因字符串

`reason` 以"允许："/"拒绝："开头，写清是哪一条不成立（含具体租户/用户/版本号），
直接进审计事件，便于事后复现。它是**可读文本而非稳定枚举**：调用方必须按 `effect` 分支，
不得解析 `reason` 做逻辑判断。稳定枚举留给后续版本（见"未决"）。

## 为什么不用其他方案

| 方案 | 拒绝理由 |
| --- | --- |
| 把平台动作写成 `PolicyRule` 存库 | 首版动作固定，规则化只会把"配错策略"变成新的越权面；且需要额外的规则校验器 |
| 在 BFF/控制面各处内联 `if (owner === actor)` | 与 AGENTS.md 冲突（控制面不内联策略逻辑），且负例无法集中测试 |
| 用现有 `RoleStore` 权限点表达所有权 | 权限点是"能不能用某类能力"，表达不了"这一行数据是不是你的"（D11） |
| 保留 `defaultEffect: "allow"` 但文档警告 | 硬性规则 1 要求默认 fail-closed，可配置的默认放行迟早会被打开 |

## 后果

- 正面：平台动作判定集中在一处、无 I/O、可穷举负例；`decide()` 可复放；默认放行从类型上消失。
- 负面：动作与角色矩阵写死，加动作要改代码 + 补测试 + 改本 ADR；首版没有多人协作语义。
- 边界：本函数只回答"这个 actor 能不能对该资源做该动作"，**不**负责：
  数据库行级过滤（`works:list` 的列表必须由查询按 `owner_user_id` 过滤）、
  会话绑定/授权凭证签发、DSH 侧 PEP 的执行（见 ADR-0001）。
- 未接入：`GovernanceStore` 仍是 legacy 内存演示，尚未调用 `authorizePlatform`；
  接 Postgres 的平台存储（`packages/platform-store`）与 BFF 时统一以本接口为准。

## 负例清单（`packages/governance/tests/authorize-platform.test.ts`）

跨租户资源 / 成员记录属于别的租户 / 同租户他人作品、章节、设定、大纲、会话 /
`works:list` 请求他人 ownerUserId / `sessions:create` 不带资源或指向他人作品 /
`models:invoke` 归因到他人资源 / 缺失成员记录 / 成员被禁用 / 未知成员状态 / 缺失或未知角色 /
成员记录与 actor 不一致（冒充）/ 缺失 tenantId 或 userId / 缺失资源所有者 /
撤销后的会话 / 撤权版本不匹配 / 会话缺 `expectedRevision` / 缺会话 `status` / 未知会话状态 /
资源缺 `revision` 却被要求校验 / 非法 `expectedRevision` / 未知 action（多种形态）/
成员执行 `members:update` 或 `audit:list` / 管理员停用自己或停用其他管理员 /
动作携带不适配的 `status` 字段。

## 未决

- 稳定拒绝码：当前 `{ effect, reason }` 之外是否加 `code`，等 BFF 需要按码做前端提示时定。
- `auditor` 角色：`@myrix/contracts` 的 `MemberRole` 目前只有 `admin | member`，
  PG 存储的类型需要同步补 `auditor`，否则该分支不会被真实数据触发。
- 转让所有权、多人协作、委托（OBO）留到 v0.2 之后，届时本 ADR 需要重写。
