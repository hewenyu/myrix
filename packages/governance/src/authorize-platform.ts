/**
 * 首版平台授权纯函数（platform-plan-v2 D11：会话与作品单一所有者，不做多人协作）。
 *
 * 与 `decide` 的分工：
 * - `decide` 是通用 RBAC/ABAC 策略引擎（规则来自数据库，可热更新）；
 * - `authorizePlatform` 是首版**固定**的平台动作判定：动作、角色、所有权、撤权版本
 *   全部写死在纯函数里，不读数据库、不读时钟、不做 I/O。
 *
 * 硬性规则（与 AGENTS.md 一致）：
 * 1. 只有显式命中允许条件才 allow；未知 action / resource / role / member / status 一律 deny。
 * 2. 成员身份本身不构成对他人资源的访问权：作品/章节/设定/大纲/会话都必须 owner 匹配。
 * 3. 管理员只做控制面动作（停用成员、撤销会话、读审计），不能冒充他人进入会话内容。
 *
 * 返回值统一为 `{ effect, reason }`：effect 供程序分支，reason 是可读、可审计的中文结论。
 * reason 以「允许：」「拒绝：」开头，拒绝原因必须说明是哪一条规则不成立。
 */
import type { Effect } from "@myrix/contracts";

/** 首版允许的平台动作（显式 allowlist；不在此列表内的一律拒绝） */
export const PLATFORM_ACTIONS = [
  // 作品（单一所有者）
  "works:list",
  "works:create",
  "works:read",
  "works:update",
  "works:delete",
  // 会话（单一所有者；内容访问必须带撤权版本）
  "sessions:list",
  "sessions:create",
  "sessions:read",
  "sessions:send",
  "sessions:resume",
  "sessions:cancel",
  "sessions:subscribe",
  "sessions:revoke",
  // 成员与审计
  "members:list",
  "members:update",
  "audit:list",
  // 模型与作品内容
  "models:invoke",
  "chapters:read",
  "chapters:write",
  "bible:read",
  "bible:write",
  "outline:read",
  "outline:write",
] as const;

export type PlatformAction = (typeof PLATFORM_ACTIONS)[number];

/**
 * 首版租户成员角色：
 * - member：只能操作自己名下的作品/会话；
 * - admin：在 member 基础上可停用成员、撤销会话、读审计；
 * - auditor：只读审计，不能读写任何业务内容。
 */
export const PLATFORM_MEMBER_ROLES = ["member", "admin", "auditor"] as const;
export type PlatformMemberRole = (typeof PLATFORM_MEMBER_ROLES)[number];

/** 首版成员状态：只有 active 可执行操作 */
export const PLATFORM_MEMBER_STATUSES = ["active", "disabled"] as const;
export type PlatformMemberStatus = (typeof PLATFORM_MEMBER_STATUSES)[number];

/** 首版会话状态（控制面绑定记录） */
export const SESSION_STATUSES = ["creating", "active", "revoked"] as const;

export interface PlatformActor {
  tenantId: string;
  userId: string;
}

/**
 * 调用方从数据库读到的**当前**成员记录；未找到时传 undefined（不能猜、不能省）。
 * 角色/状态以数据库为权威，纯函数只做判定，不做补齐。
 */
export interface PlatformMember {
  tenantId: string;
  userId: string;
  status: PlatformMemberStatus;
  role: PlatformMemberRole;
}

/**
 * 目标资源。字段含义按动作区分：
 * - 作品/章节/设定/大纲/会话：`ownerUserId` 是资源所有者（D11 单一所有者）；
 * - `members:update`：`ownerUserId` 是**被操作的目标成员** userId；
 * - `status`：已有会话的操作填会话状态；`members:update` 填目标成员当前状态；其余动作不得携带；
 * - `revision`：资源当前版本（会话 = 撤权版本 rev，成员 = 行版本）。
 */
export interface PlatformResource {
  tenantId: string;
  ownerUserId?: string;
  /** members:update 必填：目标成员当前角色 */
  role?: string;
  /** 会话状态 / 目标成员状态，见类型注释 */
  status?: string;
  /** 资源当前版本 */
  revision?: number;
}

export interface AuthorizePlatformInput {
  actor: { tenantId: string; userId: string };
  /** 数据库中的当前成员记录；缺失即拒绝（fail-closed） */
  member?: PlatformMember | undefined;
  action: string;
  resource?: PlatformResource | undefined;
  /** 调用方持有的撤权版本（会话操作必填），与 resource.revision 不一致即拒绝 */
  expectedRevision?: number;
}

export interface PlatformAuthorization {
  effect: Effect;
  reason: string;
}

const ALL_ACTIONS: ReadonlySet<string> = new Set(PLATFORM_ACTIONS);
const ROLES: ReadonlySet<string> = new Set(PLATFORM_MEMBER_ROLES);
const MEMBER_STATUSES: ReadonlySet<string> = new Set(PLATFORM_MEMBER_STATUSES);
const SESSION_STATUS: ReadonlySet<string> = new Set(SESSION_STATUSES);

/**
 * 只能操作本人名下资源的动作（D11 单一所有者）。
 *
 * 注意 `sessions:create`：它的目标资源是**作品**而不是会话，没有会话状态可查，
 * 所以不带 status/revision 校验，但所有者校验照旧——必须有资源且所有者是本人。
 */
const OWNER_SCOPED_ACTIONS: ReadonlySet<string> = new Set([
  "works:read",
  "works:update",
  "works:delete",
  "sessions:create",
  "sessions:read",
  "sessions:send",
  "sessions:resume",
  "sessions:cancel",
  "sessions:subscribe",
  "sessions:revoke",
  "chapters:read",
  "chapters:write",
  "bible:read",
  "bible:write",
  "outline:read",
  "outline:write",
]);

/**
 * 资源是可选的：这些动作没有单一目标资源（列举/创建作品/计量/审计）。
 *
 * `sessions:create` **不在**此列：创建会话必须指名一个自己拥有的作品，
 * 否则"是成员"就等于"可以在任何人作品上开会话"，这正是首版要避免的越权。
 */
const OPTIONAL_RESOURCE_ACTIONS: ReadonlySet<string> = new Set([
  "works:list",
  "works:create",
  "sessions:list",
  "members:list",
  "audit:list",
  "models:invoke",
]);

/** 针对**已存在会话**的动作：必须有会话状态，且必须核对撤权版本 */
const SESSION_BINDING_ACTIONS: ReadonlySet<string> = new Set([
  "sessions:read",
  "sessions:send",
  "sessions:resume",
  "sessions:cancel",
  "sessions:subscribe",
  "sessions:revoke",
]);

const MEMBER_ACTIONS: readonly PlatformAction[] = [
  "works:list",
  "works:create",
  "works:read",
  "works:update",
  "works:delete",
  "sessions:list",
  "sessions:create",
  "sessions:read",
  "sessions:send",
  "sessions:resume",
  "sessions:cancel",
  "sessions:subscribe",
  "sessions:revoke",
  "members:list",
  "models:invoke",
  "chapters:read",
  "chapters:write",
  "bible:read",
  "bible:write",
  "outline:read",
  "outline:write",
];

/** 角色 → 动作白名单。只加不减，加动作必须同时补测试与 ADR。 */
const ROLE_ACTIONS: Record<PlatformMemberRole, ReadonlySet<PlatformAction>> = {
  member: new Set(MEMBER_ACTIONS),
  admin: new Set<PlatformAction>([...MEMBER_ACTIONS, "members:update", "audit:list"]),
  auditor: new Set<PlatformAction>(["audit:list"]),
};

const TENANT_SCOPED_REASONS: Record<string, string> = {
  "works:list": "同租户成员可列举作品，但调用方必须按 ownerUserId 过滤为本人作品",
  "works:create": "同租户 active 成员可在本租户创建作品，创建者即所有者",
  "sessions:list": "同租户成员可列举会话，但调用方必须按所有者过滤为本人会话",
  "members:list": "同租户成员可查看成员目录",
  "models:invoke": "同租户 active 成员可经平台模型网关调用模型，配额与归因由网关执行",
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function deny(reason: string): PlatformAuthorization {
  return { effect: "deny", reason: "拒绝：" + reason };
}

function allow(reason: string): PlatformAuthorization {
  return { effect: "allow", reason: "允许：" + reason };
}

function describe(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

/**
 * 判定一个平台动作。
 *
 * 判定顺序（任一步不成立即拒绝，绝不因为后续步骤"看起来正常"而放行）：
 * 1. action 在允许列表内；
 * 2. actor 完整（tenantId + userId）；
 * 3. 成员记录存在、与 actor 同一租户同一用户、active、角色已知；
 * 4. 角色白名单覆盖该 action；
 * 5. 资源租户与主体租户一致；status/revision 字段合法；
 * 6. 会话操作：状态未撤销 + expectedRevision 与 resource.revision 一致；
 * 7. 所有者类动作：resource.ownerUserId 必须等于 actor.userId（管理员仅对 sessions:revoke 有覆盖权）；
 * 8. 其余动作按同租户能力放行。
 */
export function authorizePlatform(input: AuthorizePlatformInput): PlatformAuthorization {
  const action = typeof input?.action === "string" ? input.action : "";
  if (!ALL_ACTIONS.has(action)) {
    return deny(`未知操作 ${describe(input?.action ?? null)}，不在首版 D11 动作清单内`);
  }

  const actor = input.actor;
  if (!actor || !isNonEmptyString(actor.tenantId) || !isNonEmptyString(actor.userId)) {
    return deny("执行主体缺少 tenantId/userId，按未认证处理");
  }

  const member = input.member;
  if (!member) {
    return deny(`未知身份：租户 ${actor.tenantId} 下没有 ${actor.userId} 的成员记录`);
  }
  if (!isNonEmptyString(member.tenantId) || !isNonEmptyString(member.userId)) {
    return deny("成员记录缺少 tenantId/userId");
  }
  if (member.tenantId !== actor.tenantId) {
    return deny(
      `成员不属于该租户：member.tenantId=${member.tenantId}，actor.tenantId=${actor.tenantId}`,
    );
  }
  if (member.userId !== actor.userId) {
    return deny(
      `成员记录与执行主体不一致（疑似冒充他人）：member.userId=${member.userId}，actor.userId=${actor.userId}`,
    );
  }
  if (member.status !== "active") {
    return deny(`成员状态为 ${describe(member.status)}，只有 active 成员可执行操作`);
  }
  if (!ROLES.has(member.role)) {
    return deny(`未知成员角色 ${describe(member.role)}，按拒绝处理`);
  }
  const role = member.role as PlatformMemberRole;

  const roleActions = ROLE_ACTIONS[role];
  if (!roleActions.has(action as PlatformAction)) {
    return deny(`角色 ${role} 的白名单不包含动作 ${action}`);
  }

  const expectedRevision = input.expectedRevision;
  if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) {
    return deny(`expectedRevision 非法：${describe(expectedRevision)}`);
  }

  const resource = input.resource;
  if (resource === undefined) {
    if (!OPTIONAL_RESOURCE_ACTIONS.has(action)) {
      return deny(`动作 ${action} 必须指定目标资源，缺少资源按拒绝处理`);
    }
    if (expectedRevision !== undefined) {
      return deny(`动作 ${action} 提供了 expectedRevision 但没有目标资源，无法校验版本`);
    }
    if (action === "audit:list") {
      return allow(
        role === "auditor"
          ? "审计员只读本租户审计事件"
          : "管理员只读本租户审计事件",
      );
    }
    return allow(
      `${TENANT_SCOPED_REASONS[action] ?? "同租户 active 成员可执行该动作"}（actor=${actor.userId}）`,
    );
  }

  if (!isNonEmptyString(resource.tenantId)) {
    return deny(`目标资源缺少 tenantId，无法确认租户归属（动作 ${action}）`);
  }
  if (resource.tenantId !== actor.tenantId) {
    return deny(
      `跨租户访问：资源租户 ${resource.tenantId} ≠ 主体租户 ${actor.tenantId}（动作 ${action}）`,
    );
  }

  if (resource.role !== undefined && !ROLES.has(resource.role)) {
    return deny(`目标资源携带未知角色 ${describe(resource.role)}，按拒绝处理`);
  }

  if (resource.revision !== undefined && (!Number.isInteger(resource.revision) || resource.revision < 0)) {
    return deny(`资源 revision 非法：${describe(resource.revision)}`);
  }

  if (
    resource.status !== undefined &&
    !SESSION_BINDING_ACTIONS.has(action) &&
    action !== "members:update"
  ) {
    return deny(`动作 ${action} 不支持在资源上携带 status 字段`);
  }

  if (SESSION_BINDING_ACTIONS.has(action)) {
    if (resource.status === undefined) {
      return deny(`动作 ${action} 必须提供会话状态 status，否则无法确认是否已撤销`);
    }
    if (!SESSION_STATUS.has(resource.status)) {
      return deny(`未知会话状态 ${describe(resource.status)}，按拒绝处理`);
    }
    if (resource.status === "revoked") {
      return deny(`会话已撤销（status=revoked），拒绝 ${action}`);
    }
    if (expectedRevision === undefined) {
      return deny(`动作 ${action} 必须提供 expectedRevision（撤权版本 rev）`);
    }
  }

  if (action === "members:update") {
    if (resource.ownerUserId === undefined) {
      return deny("members:update 必须提供目标成员 userId（resource.ownerUserId）");
    }
    if (!isNonEmptyString(resource.ownerUserId)) {
      return deny("members:update 的目标成员 userId 非法");
    }
    if (resource.role === undefined) {
      return deny("members:update 必须提供目标成员角色（resource.role），否则无法判断是否可停用");
    }
    if (resource.status === undefined) {
      return deny("members:update 必须提供目标成员当前状态（resource.status）");
    }
    if (!MEMBER_STATUSES.has(resource.status)) {
      if (resource.status === "removed") {
        return deny("目标成员已被移除，不能再变更其成员状态");
      }
      return deny(`未知成员状态 ${describe(resource.status)}，按拒绝处理`);
    }
  }

  if (expectedRevision !== undefined) {
    if (resource.revision === undefined) {
      return deny(`资源缺少 revision，无法校验 expectedRevision=${expectedRevision}（动作 ${action}）`);
    }
    if (resource.revision !== expectedRevision) {
      return deny(
        `撤权版本不匹配：期望 ${expectedRevision}，实际 ${resource.revision}（动作 ${action}，疑似凭据过期或已撤权）`,
      );
    }
  }

  if (OWNER_SCOPED_ACTIONS.has(action)) {
    if (!isNonEmptyString(resource.ownerUserId)) {
      return deny(`动作 ${action} 必须提供资源所有者 ownerUserId，缺失按拒绝处理`);
    }
    if (resource.ownerUserId === actor.userId) {
      return allow(
        `资源所有者本人操作：ownerUserId=${resource.ownerUserId}，动作 ${action}（D11 单一所有者）`,
      );
    }
    if (action === "sessions:revoke" && role === "admin") {
      return allow(
        `管理员可撤销本租户任意会话：资源所有者 ${resource.ownerUserId}，执行人 ${actor.userId}；该动作不读取会话内容`,
      );
    }
    return deny(
      `非资源所有者：资源属于 ${resource.ownerUserId}，执行主体是 ${actor.userId}（动作 ${action}）；首版禁止访问他人作品与会话`,
    );
  }

  if (action === "members:update") {
    if (resource.ownerUserId === actor.userId) {
      return deny("管理员不能变更自己的成员状态，避免自锁与自助提权");
    }
    if (resource.role === "admin") {
      return deny("首版不允许管理员停用其他管理员（暂无所有者角色，避免互相停用）");
    }
    return allow(
      `管理员可停用/恢复同租户 role=${resource.role} 的成员 ${resource.ownerUserId}；该能力不附带其作品或会话内容访问权`,
    );
  }

  if (
    (action === "works:list" || action === "sessions:list") &&
    resource.ownerUserId !== undefined &&
    resource.ownerUserId !== actor.userId
  ) {
    return deny(
      `列举动作只能作用于本人资源：请求 ownerUserId=${resource.ownerUserId}，执行主体是 ${actor.userId}`,
    );
  }

  if (action === "models:invoke") {
    // 模型调用必须归因到本人：调用方可带 ownerUserId（作品/会话所有者）做一次显式校验。
    if (resource.ownerUserId !== undefined && resource.ownerUserId !== actor.userId) {
      return deny(
        `模型调用不能归因到他人资源：请求 ownerUserId=${resource.ownerUserId}，执行主体是 ${actor.userId}`,
      );
    }
  }

  if (action === "audit:list") {
    return allow(role === "auditor" ? "审计员只读本租户审计事件" : "管理员只读本租户审计事件");
  }

  return allow(
    `${TENANT_SCOPED_REASONS[action] ?? "同租户 active 成员可执行该动作"}（actor=${actor.userId}，role=${role}）`,
  );
}
