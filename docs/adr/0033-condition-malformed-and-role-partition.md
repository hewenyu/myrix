# ADR 0033：条件求值的畸形语义、deny 覆盖与角色分区

- 状态：已采用（实现见相应 PR；本 ADR 是决策记录，**不是验证通过证明**）
- 日期：2026-10-02
- 相关：[ADR-0001](./0001-layered-governance.md)（分层治理）、[ADR-0002](./0002-identity-and-entitlement.md)（身份与授权）、[ADR-0012](./0012-platform-authorization.md)（平台授权）、[ADR-0018](./0018-legacy-fail-open-retirement.md)（移除故障放行）
- 实现：`packages/governance/src/{condition.ts,decide.ts,obligations.ts,roles.ts}`、`packages/registry/src/{catalog.ts,entitlement.ts,profile.ts}`
- 测试：`packages/governance/tests/hardening.test.ts`、`packages/registry/tests/registry.test.ts`
- 复盘：[../reviews/module-boundaries-2026-10.md](../reviews/module-boundaries-2026-10.md)
- 不在本决策范围内：`packages/control-plane`（legacy 演示）的 HTTP 输入校验；`vendor/deepseek-harness` 的任何改动

## 背景

一次内部复盘发现三类"看起来拒绝、实际放行"的路径，全部违反 AGENTS.md 硬性规则 1（默认 fail-closed）：

1. **条件树的畸形节点被当成"不匹配"。** 未知运算符落进 `default: return false`；缺 `value` 时 `eq` 用 `undefined` 比较；
   `matches` 吞掉非法正则；`gt/gte/lt/lte` 在无法比较时用 `?? 0` / `?? -1` 兜底出确定结论。
2. **取反语义让畸形变成放行。** 旧实现在属性缺失时直接让 `notIn` 返回 `true`；`none:[<畸形叶子>]` 因为叶子不匹配而被判"该分组要求全部不成立"，于是整树成立。
3. **写坏的 deny 规则被静默丢弃。** 旧 `decide` 先 `rules.filter(ruleMatches)`，畸形 deny 规则匹配为 false 后直接不进候选集，决定权落到 allow 或 default-deny；`effect` 写成非 `allow`/`deny` 时同样被忽略。

同时发现：`RoleStore` 用单一 `Map<roleId, Role>`，同 id 不同租户的角色互相覆盖，后写入者会被别的租户主体解析到 —— 这是真实的跨租户越权面。

## 决策

### 1. 三态求值，畸形显式化而不是"不匹配"

`evaluateConditionDetailed` 返回 `{ matched, malformed, reason }`（[condition.ts:308](../../packages/governance/src/condition.ts#L308)）。
畸形节点的判定是：未知 `op` / 未知叶子键、`value` 类型与运算符不符、分组内混入 `undefined`/`null`、
分组键未知或字段非数组、空对象 `{}`、非对象节点、超过最大深度。畸形一律 `matched: false`，且**永远不进入取反语义**。

### 2. 校验先于取值

形态与 `value` 类型校验在读取 `actual` **之前**完成（[validate():129](../../packages/governance/src/condition.ts#L129)、
[evaluateSingle():208](../../packages/governance/src/condition.ts#L208)）。
这样"属性恰好缺失"不能把一条畸形条件降级成普通的 notMatched。`compare()` 只接受数字/字符串，
不再用 `Number()`/`String()` 把布尔、数组强转成结论（[compare():64](../../packages/governance/src/condition.ts#L64-L71)）。

### 3. `notMatched` 与 fail-closed 是两件事，不能混为一谈

本 ADR 明确限定：条件结构/运算类型无法解释时为 `malformed`（包括实际值与运算符无法比较）；合法条件在数据上不成立，则是普通的 `notMatched`。
以下是本次明确保留的策略语义与调用方责任：

- 属性缺失时 `neq` / `notIn` 一律 `notMatched`（[condition.ts:216-221](../../packages/governance/src/condition.ts#L216-L221)）。
  这意味着**一条 `neq`/`notIn` 的 deny 规则在属性被删掉时不会触发**。本轮不引入 `required` / "属性必填"语义 ——
  需要该语义时应新增显式运算符或规则字段，并同步 `@myrix/contracts`。
- 分组语义保持既有语义：`all` 全部成立、`any` 任一成立、`none` 任一成立即整体不成立；根表达式 `undefined` 仍表示"无约束"，
  但**分组内**的 `undefined` 是畸形（否则 `any:[undefined]` 会匹配一切）。`all: []` 保持空集上全称为真；空对象 `{}` 非法。
- 最大嵌套深度限制为 **32**（[MAX_CONDITION_DEPTH:53](../../packages/governance/src/condition.ts#L53)），超深/循环引用判畸形而不是栈溢出。
- 为了不漏检畸形分支，分组内子节点**全部求值**、不做短路；这是本决策接受的性能代价。

### 4. deny 覆盖：畸形 deny 规则必须显式生效

`decideExplained` 返回 `reasonKind`（[decide.ts:34](../../packages/governance/src/decide.ts#L34)），并在 deny 时区分：

- `explicit-deny`：良构 deny 规则命中；
- `malformed-policy`：**作用域本可能命中**的 deny 规则因字段/条件畸形无法判定 → fail-closed 拒绝（[decide.ts:328-337](../../packages/governance/src/decide.ts#L328-L337)）；
- `invalid-request`：请求本身不可定位；
- `explicit-allow` / `default-deny`。

契约兼容是硬约束：`PolicyDecision.matched` 仍只能取 `explicit-deny` | `explicit-allow` | `default-deny`
（[contracts/policy.ts:82](../../packages/contracts/src/policy.ts#L82)），因此 `malformed-policy` 映射到 `matched: "explicit-deny"`，
`invalid-request` 映射到 `matched: "default-deny"`，新信息只通过 `decideExplained` 暴露，不改公开审计契约。

**不夸大成"deny 覆盖一切"**：只有当规则的 tenant/action/resource 作用域**不能被确定排除**时才升级为 fail-closed；
若作用域明确不匹配（如别的租户、别的动作），即使后面的字段畸形也不升级 ——
否则一条写错作用域的 deny 规则会把全租户流量打死（[decide.ts:174](../../packages/governance/src/decide.ts#L174)，测试见 hardening 的"作用域本就不命中的畸形 deny 不会误伤"）。

同理，**畸形 allow 规则只允许"不匹配"，绝不能反过来伪装成允许**，也不能被升级成 deny 去误伤。

### 5. 未知 sandbox 档位失败到最严格

`mergeObligations` 把未知档位归一为 `read-only`，且合并结果只取决于集合内容、与输入顺序无关
（[obligations.ts:18](../../packages/governance/src/obligations.ts#L18)、[strictestSandboxMode():23](../../packages/governance/src/obligations.ts#L23)）。
旧实现下未知档位得到 `undefined`，比较恒 false，是否放宽取决于它恰好是不是数组首元素。

### 6. 外部 HTTP 入参仍需 schema 校验

本决策只覆盖**已经在类型系统内**的调用方（如 platform-store 的授权接缝）。
legacy 控制面的 `/api/v1/decisions` 直接把请求体断言成 `PolicyRequest`（[server.ts:104-118](../../packages/control-plane/src/server.ts#L104-L118)），
`context` 是任意 JSON。因此：

- 畸形检测按**JSON 标量/数组**语义实现，不依赖对象原型；
- 但**必须在 HTTP 边界加 schema 校验**：条件路径支持任意 getter/原型链，PDP 不负责替外部输入做反序列化安全。
  该工作登记在复盘 §4.1，未在本轮完成。

### 7. 主体 active 事实由身份边界负责，PDP 不做 status 魔法

`SubjectContext` 契约里**没有** `status` 字段（[contracts/principal.ts:47](../../packages/contracts/src/principal.ts#L47)），
`Principal.status` 是身份层事实。本决策明确：

- `subjectValidationError` 只校验 `principalId` / `tenantId` 非空、`groups` 为字符串数组、`attributes` 为对象
  （[decide.ts:77](../../packages/governance/src/decide.ts#L77)）；
- 不把 `attributes.status` 当成隐式开关来验证（复审已移除草稿中这个不属于契约的假设）；
- 主体是否 active 由认证/授权边界保证：平台路径走 `authorizePlatform`（未知状态即 deny）、
  entitlement 路径走 `computeEntitlement` 的 `principal.status` 门禁（[entitlement.ts:29](../../packages/registry/src/entitlement.ts#L29-L34)）。

若后续希望 PDP 强制 active，应当**先改契约**（给 `SubjectContext` 加必填 `status`），而不是继续读 `attributes.status`。

### 8. 角色按租户分区，全局分区用 Symbol

`RoleStore` 以 `(tenantId, id)` 为键分区（[roles.ts:43](../../packages/governance/src/roles.ts#L43-L45)）：

- `role.tenantId === undefined` 表示全局角色，分区键是 `Symbol("global roles")`（[roles.ts:6](../../packages/governance/src/roles.ts#L6)）；
- 解析先查本租户分区，再退化到全局分区，**绝不**查看其他租户；
- 绑定引用的角色若只存在于别的租户 → `unresolvedRoles`（fail-closed 且显式暴露）；
- 写入与读出都做深拷贝，调用方改返回值/改原对象都碰不到目录内部（[copyRole():22](../../packages/governance/src/roles.ts#L22)）。

**为什么用 Symbol 而不是 `"*"` 字符串**：`"*"` 是**合法的租户 id 形态**（绑定里 `binding.tenantId === "*"` 表示通配）。
若全局分区也用 `"*"`，一个真的叫 `"*"` 的租户就会与全局角色共享同一分区，产生隐蔽的权限合并。
Symbol 与任何字符串都不相等，从类型上消除这个碰撞面。

## 后果

- 写坏的条件/规则不再静默失效；故障表现为"拒绝 + 可读原因"，而不是"悄悄放行"。
- 判定结果多出 `malformedRules` 与逐条 `details`，排障与审计能回答"为什么拒"。
- 条件树不再短路，深树求值成本上升（上限 32 层，且是判定路径而非批量路径，接受）。
- 角色目录从"全局扁平"变为"分区 + 副本"，管理后台 `list(tenantId)` 的语义需要按"本租户覆盖全局、同 id 只出现一次"理解（[roles.ts:79](../../packages/governance/src/roles.ts#L79-L90)）。
- 调用方必须提供可信属性；不能用仅依赖 `neq`/`notIn` 的 deny 表达“属性必须存在”（见决策 3）。

## 验证要求（实际执行结果见复盘的验证记录）

1. `pnpm test` 通过，且 `packages/governance/tests/hardening.test.ts` 覆盖：缺 `value`、取反不成立、`none` 内的畸形叶子、
   `any` 混入畸形叶子、后置畸形叶子（无短路）、超深/循环引用、空分组/未知键/非对象、`in`/`notIn` 的标量历史写法、
   空字符串标量对 `eq` 合法、`gt` 等无法比较时不伪造结论。
2. 畸形 deny 规则必须 deny 且 `reasonKind === "malformed-policy"`；作用域不命中的畸形 deny 不得误伤；
   畸形 allow 不得放行；`effect` 非 `allow`/`deny` 按 deny 意图处理。
3. 未知 sandbox 档位在任意输入位置都归一 `read-only`；已知档位合并与顺序无关。
4. 角色：同 id 跨租户解析到本租户定义、只存在于他租户的角色为 unresolved、
   全局角色对所有租户可见且被本租户同名遮蔽、`get`/`list` 返回副本、畸形角色写入被拒。
5. entitlement：非 active / 未知状态全量禁用；固定 `now` 下重复计算与 `generatedAt` 稳定；
   冲突裁剪 provider 后 consumer 与孙级一并禁用，且无冲突时不改写原有原因。
6. 契约不变式：`PolicyDecision.matched` 仍然只出现三个既有取值；`packages/governance/src` 与
   `packages/registry/src` 不出现 `node:` / 数据库导入（边界门禁 `pnpm lint` 覆盖）。

## 边界

- 本 ADR 不声称已通过上述任何测试。
- 本 ADR 不改变 `authorizePlatform`（平台成员授权）的动作/角色白名单，也不改变 RLS 与 CAS。
- 本 ADR 不覆盖 legacy 控制面的 HTTP 校验、不覆盖 `dsh-plugin-*` 的 Cordis shim 契约漂移（见复盘 §4.1 / §4.2）。
- 本 ADR 不改变模型链路协议（仓库仍禁止 `chat/completions`）。
