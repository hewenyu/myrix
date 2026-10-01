/**
 * 授权接缝（authorization seam）。
 *
 * 职责只有两件：
 *   1. 把仓储层的请求**逐字段显式映射**成 `@myrix/governance` 的 `authorizePlatform` 入参；
 *   2. 提供默认全拒的 `Authorizer`，并把"成员请求"与"系统操作"分成两条判定路径。
 *
 * 硬性规则（AGENTS.md + ADR-0012 + docs/adr/0011-postgres-ownership.md）：
 *   * 生产路径上**只有** governance 的纯函数能给出 allow；platform-store 不内联任何 allow。
 *   * governance 只有 `{ effect, reason }`，没有 `matched`、也没有 `actor.membership` 这种嵌套字段，
 *     动作名是冒号 + 复数的 `works:read`。所以这里**不做**结构化侥幸赋值，只做显式映射
 *     （见 `toGovernanceInput`）；动作类型直接从 governance 取别名，杜绝两边漂移。
 *   * 系统操作（命令队列 claim/settle、outbox 投递、审计写入、租户装配）**不**能映射成
 *     成员 allow，它们必须由构造方显式授予 `ServiceCapability`（见 storage.requireService）。
 *     浏览器永远拿不到这些能力：能力只在服务端装配 `PlatformStore` 时绑定。
 *   * 默认 fail-closed：没有绑定 authorizer 就是全拒；成员记录缺失是拒绝；未知角色/状态是拒绝。
 *
 * `createTestAuthorizer` **不在**本文件导出（见 `./testing`），以免被误装到生产装配路径上。
 */

import type {
  AuthorizePlatformInput,
  PlatformAction,
  PlatformMemberRole,
  PlatformMemberStatus,
} from "@myrix/governance";

import { errors } from "./errors";

export type { PlatformAction };
/** 成员角色/状态直接取 governance 的定义：admin | member | auditor / active | disabled */
export type MemberRoleName = PlatformMemberRole;
export type MembershipStatusName = PlatformMemberStatus;

/** 判定用的主体。`membership` 必须由调用方从 members 表读出后注入；缺失 = 非成员 = 拒绝。 */
export interface PlatformActor {
  userId: string;
  tenantId: string;
  membership?: { status: MembershipStatusName; role: MemberRoleName } | null;
}

/** 资源种类只用于审计与错误上下文，不参与 governance 判定（governance 按 action 分支）。 */
export type PlatformResourceKind =
  | "tenant"
  | "member"
  | "work"
  | "chapter"
  | "chapter_version"
  | "outline"
  | "bible_entry"
  | "session_binding"
  | "command"
  | "outbox"
  | "audit";

/**
 * 目标资源。字段语义与 governance 的 `PlatformResource` 一一对应：
 *   * `ownerUserId`：单一所有者资源的所有者；`members:update` 时是**被操作的目标成员**；
 *   * `status`：已有会话的状态，或 `members:update` 时目标成员的当前状态；
 *   * `revision`：资源当前版本（会话 = 撤权版本 rev，成员 = 行版本）；
 *   * `role`：仅 `members:update` 使用，目标成员当前角色。
 */
export interface PlatformResourceRef {
  kind: PlatformResourceKind;
  tenantId: string;
  ownerUserId?: string;
  status?: string;
  revision?: number;
  role?: string;
}

export interface PlatformRequest {
  actor: PlatformActor;
  action: PlatformAction;
  resource: PlatformResourceRef;
  /** 调用方持有的版本（会话操作必填）：与 resource.revision 不一致即拒绝 */
  expectedRevision?: number;
}

export interface PlatformDecision {
  effect: "allow" | "deny";
  reason: string;
}

export type Authorizer = (request: PlatformRequest) => PlatformDecision;

/**
 * 默认拒绝：任何未显式绑定 Authorizer 的调用方都拿不到任何数据。
 * 这不是"占位实现"，而是安全默认值（AGENTS.md 硬性规则 1）。
 */
export function createDenyAllAuthorizer(): Authorizer {
  return () => ({
    effect: "deny",
    reason:
      "authorizer-not-bound: 调用方未绑定 @myrix/governance 的 authorizePlatform，按默认拒绝处理",
  });
}

/**
 * `@myrix/governance` 的 `authorizePlatform` 的最小结构化形状。
 * 用结构化注入而不是直接 import 调用：调用方自己 import 并传进来，
 * 于是 platform-store 可以在没有 governance 的单元测试里单独构造。
 */
export interface GovernancePlatformModule {
  authorizePlatform?: ((input: AuthorizePlatformInput) => PlatformDecision) | undefined;
}

const ACTION_PATTERN = /^[a-z]+:[a-z]+$/;

/**
 * 显式映射：platform-store 的请求 → governance 的入参。
 * 任何新增字段都必须在这里出现，不允许把整个 request 直接传下去（那会掩盖字段漂移）。
 */
function toGovernanceInput(request: PlatformRequest): AuthorizePlatformInput {
  const { actor, resource } = request;
  const membership = actor.membership;

  const mapped: AuthorizePlatformInput = {
    actor: { tenantId: actor.tenantId, userId: actor.userId },
    action: request.action,
  };

  // member 缺失必须保持 undefined（governance 按"未知身份"拒绝），不能补一个空壳记录。
  if (membership) {
    mapped.member = {
      tenantId: actor.tenantId,
      userId: actor.userId,
      status: membership.status,
      role: membership.role,
    };
  }

  if (resource) {
    const target: NonNullable<AuthorizePlatformInput["resource"]> = { tenantId: resource.tenantId };
    if (resource.ownerUserId !== undefined) target.ownerUserId = resource.ownerUserId;
    if (resource.status !== undefined) target.status = resource.status;
    if (resource.revision !== undefined) target.revision = resource.revision;
    if (resource.role !== undefined) target.role = resource.role;
    mapped.resource = target;
  }

  if (request.expectedRevision !== undefined) mapped.expectedRevision = request.expectedRevision;
  return mapped;
}

/**
 * 绑定 governance。`authorizePlatform` 缺失时**构造期直接抛错**，
 * 绝不静默放行（也绝不静默拒绝 —— 那会把"忘记绑定"伪装成"策略拒绝"）。
 */
export function createGovernanceAuthorizer(governance: GovernancePlatformModule): Authorizer {
  const fn = governance?.authorizePlatform;
  if (typeof fn !== "function") {
    throw new Error(
      "myrix: @myrix/governance 未导出 authorizePlatform，无法绑定授权接缝；" +
        "不要改用内联策略，先落地 packages/governance/src/authorize-platform.ts（参数见 ADR-0012）。",
    );
  }
  return (request) => {
    const decision = fn(toGovernanceInput(request));
    return { effect: decision.effect, reason: decision.reason };
  };
}

/**
 * 系统能力：**不是**成员权限，也永远不能由 HTTP 请求体指定。
 *
 * 这些是"投递循环 / 审计写入 / 租户装配"这类内部操作的显式授权：
 *   * 它们不经过 `authorizePlatform`（成员判定表里根本没有对应动作）；
 *   * 只有在服务端装配 `PlatformStore` 时列出能力，运行期才可能执行；
 *   * BFF 的路由处理器不得把它们透传给浏览器。
 */
export const SERVICE_CAPABILITIES = [
  /** 读租户本身与"调用者自己的"成员记录（登录态装配，先于业务判定） */
  "tenant.read",
  /** 租户/成员的部署期装配（建租户、建首个 admin、运维补员） */
  "tenant.manage",
  /** 会话绑定创建完成后 cell 回报激活 */
  "session.activate",
  /** 命令入队（由服务端可信生产者调用） */
  "command.enqueue",
  /** 命令领取（投递循环） */
  "command.claim",
  /** 命令结算 / 释放 / 重新入队（投递循环） */
  "command.settle",
  /** 按 actor 读自己的命令回执（查询仍强制 owner 过滤） */
  "command.read",
  /** outbox 入队 */
  "outbox.enqueue",
  /** outbox 领取 / 列出待投递 */
  "outbox.claim",
  /** outbox 结算 / 失败 / 重新激活 */
  "outbox.settle",
  /** 独立事务写审计（业务事务内的审计走内部函数，不需要能力） */
  "audit.write",
] as const;

export type ServiceCapability = (typeof SERVICE_CAPABILITIES)[number];

const SERVICE_CAPABILITY_SET: ReadonlySet<string> = new Set(SERVICE_CAPABILITIES);

export function isServiceCapability(value: unknown): value is ServiceCapability {
  return typeof value === "string" && SERVICE_CAPABILITY_SET.has(value);
}

/** 判定失败时抛 forbidden，并把 reason 原样带出（HTTP 边界只序列化 error + reason） */
export function assertAllowed(decision: PlatformDecision, action: string): PlatformDecision {
  if (decision.effect !== "allow") {
    throw errors.forbidden(decision.reason, { action });
  }
  return decision;
}

/** 暴露给测试：确认动作名形状（`动词:名词`），防止有人把旧的 dot 动作又写回来 */
export function isPlatformActionShape(value: unknown): boolean {
  return typeof value === "string" && ACTION_PATTERN.test(value);
}
