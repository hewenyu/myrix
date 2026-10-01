/**
 * 授权装配：把「服务端凭据 → 绑定租户/cell」与「sessionId+rev → 当前绑定」两步
 * 接到 `@myrix/governance` 的纯函数 `authorizePlatform` 上。
 *
 * 攻击面与对应防线：
 * 1. 客户端自报 tenantId/userId → **一律忽略**；主体只来自凭据绑定 + 数据库绑定行。
 * 2. 客户端自报别的 sessionId → 绑定行的 cellId 必须等于凭据的 cellId，否则拒绝。
 * 3. 撤权后继续用旧 rev 调用 → `expectedRevision` 与数据库当前 rev 不一致即拒绝。
 * 4. 成员被停用 → `loadMember` 返回 disabled，`authorizePlatform` 拒绝。
 * 5. rev 缺失 → fail-closed（不猜"最新版"）。
 */
import { authorizePlatform, type PlatformMember } from "@myrix/governance";
import { forbidden, invalidRequest, unauthorized } from "./errors";
import {
  SESSION_ID_PATTERN,
  type AuthorizationOutcome,
  type AuthorizedRequest,
  type Authorizer,
  type AuthorizerPort,
  type AuthorizeInput,
  type CellCredentialBinding,
  type SessionBindingSnapshot,
} from "./ports";

/** 只有 active 会话可以调模型；creating/closed/未知状态都不行。 */
const INVOKABLE_STATUS = "active";

function snapshotResource(binding: SessionBindingSnapshot) {
  return {
    tenantId: binding.tenantId,
    ownerUserId: binding.ownerUserId,
    status: binding.status,
    revision: binding.revision,
  };
}

export function createAuthorizer(port: AuthorizerPort): Authorizer {
  async function authorize(input: AuthorizeInput): Promise<AuthorizationOutcome> {
    if (typeof input.token !== "string" || input.token.length === 0) {
      return { effect: "deny", statusCode: 401, code: "missing_cell_credential", reason: "缺少服务端 cell 凭据（Authorization: Bearer）" };
    }
    if (typeof input.sessionId !== "string" || !SESSION_ID_PATTERN.test(input.sessionId)) {
      return { effect: "deny", statusCode: 400, code: "invalid_session", reason: "缺少或非法的会话标识：模型调用必须归因到明确的会话" };
    }
    if (input.claimedRevision === undefined) {
      return { effect: "deny", statusCode: 400, code: "missing_revision", reason: "缺少撤权版本 rev：网关不接受无法核对撤权状态的调用" };
    }

    const binding: CellCredentialBinding | undefined = await port.resolveCredential(input.token);
    if (!binding) {
      return { effect: "deny", statusCode: 401, code: "unknown_cell_credential", reason: "无法识别的 cell 服务凭据" };
    }

    const session: SessionBindingSnapshot | undefined = await port.loadSessionBinding(binding.tenantId, input.sessionId);
    if (!session) {
      return { effect: "deny", statusCode: 403, code: "unknown_session", reason: `会话 ${input.sessionId} 没有权威绑定记录，拒绝调用` };
    }
    if (session.tenantId !== binding.tenantId) {
      return { effect: "deny", statusCode: 403, code: "cross_tenant_session", reason: "会话绑定租户与 cell 凭据租户不一致，拒绝调用" };
    }
    if (session.cellId !== binding.cellId) {
      return { effect: "deny", statusCode: 403, code: "wrong_cell", reason: `会话当前放置在 cell ${session.cellId ?? "<未放置>"}，凭据属于 cell ${binding.cellId}` };
    }
    if (session.status !== INVOKABLE_STATUS) {
      return { effect: "deny", statusCode: 403, code: "session_not_active", reason: `会话状态为 ${session.status}，只有 active 会话可以调用模型` };
    }

    // 主体 = 绑定行的所有者；请求里任何用户/租户归因头都不参与。
    const actor = { tenantId: session.tenantId, userId: session.ownerUserId };
    const member: PlatformMember | undefined = await port.loadMember(actor.tenantId, actor.userId);

    const sendDecision = authorizePlatform({
      actor,
      member,
      action: "sessions:send",
      resource: snapshotResource(session),
      expectedRevision: input.claimedRevision,
    });
    if (sendDecision.effect !== "allow") {
      return revoke(sendDecision.reason);
    }

    const invokeDecision = authorizePlatform({
      actor,
      member,
      action: "models:invoke",
      resource: { tenantId: session.tenantId, ownerUserId: session.ownerUserId },
    });
    if (invokeDecision.effect !== "allow") {
      return revoke(invokeDecision.reason);
    }

    return {
      effect: "allow",
      principal: {
        tenantId: session.tenantId,
        cellId: binding.cellId,
        userId: session.ownerUserId,
        sessionId: session.sessionId,
        revision: session.revision,
        reason: `${sendDecision.reason}；${invokeDecision.reason}`,
      },
    };
  }

  function revoke(reason: string): AuthorizationOutcome {
    return { effect: "deny", statusCode: 403, code: "not_authorized", reason };
  }

  async function isStillAuthorized(principal: AuthorizedRequest): Promise<boolean> {
    const session = await port.loadSessionBinding(principal.tenantId, principal.sessionId);
    if (!session) return false;
    if (session.tenantId !== principal.tenantId) return false;
    if (session.cellId !== principal.cellId) return false;
    if (session.status !== INVOKABLE_STATUS) return false;
    if (session.revision !== principal.revision) return false;
    if (session.ownerUserId !== principal.userId) return false;
    const member = await port.loadMember(session.tenantId, session.ownerUserId);
    const decision = authorizePlatform({
      actor: { tenantId: session.tenantId, userId: session.ownerUserId },
      member,
      action: "models:invoke",
      resource: { tenantId: session.tenantId, ownerUserId: session.ownerUserId },
    });
    return decision.effect === "allow";
  }

  return { authorize, isStillAuthorized };
}

/** 服务端凭据解析端口：token → 绑定。实现方只存 token 的 SHA-256，不存明文。 */
export function denyFromOutcome(outcome: AuthorizationOutcome): never {
  if (outcome.effect === "allow") throw new Error("denyFromOutcome 只能处理拒绝结果");
  if (outcome.statusCode === 401) throw unauthorized(outcome.reason);
  if (outcome.statusCode === 400) throw invalidRequest(outcome.reason);
  throw forbidden(`${outcome.code}: ${outcome.reason}`);
}

// ---------------------------------------------------------------------------
// 内存实现：单测 / 本地开发；生产接 Postgres（src/db/）。
// ---------------------------------------------------------------------------

export interface MemoryAuthorizerOptions {
  /** cell 服务令牌 → 绑定 */
  credentials?: Readonly<Record<string, CellCredentialBinding>>;
  sessions?: readonly SessionBindingSnapshot[];
  members?: readonly PlatformMember[];
}

export class MemoryAuthorizerStore implements AuthorizerPort {
  readonly #credentials = new Map<string, CellCredentialBinding>();
  readonly #sessions = new Map<string, SessionBindingSnapshot>();
  readonly #members = new Map<string, PlatformMember>();

  constructor(options: MemoryAuthorizerOptions = {}) {
    for (const [token, binding] of Object.entries(options.credentials ?? {})) {
      this.#credentials.set(token, { ...binding });
    }
    for (const session of options.sessions ?? []) this.#sessions.set(session.sessionId, { ...session });
    for (const member of options.members ?? []) this.#members.set(`${member.tenantId}:${member.userId}`, { ...member });
  }

  async resolveCredential(token: string): Promise<CellCredentialBinding | undefined> {
    const binding = this.#credentials.get(token);
    return binding ? { ...binding } : undefined;
  }

  async loadSessionBinding(tenantId: string, sessionId: string): Promise<SessionBindingSnapshot | undefined> {
    const session = this.#sessions.get(sessionId);
    if (!session || session.tenantId !== tenantId) return undefined;
    return { ...session };
  }

  async loadMember(tenantId: string, userId: string): Promise<PlatformMember | undefined> {
    const member = this.#members.get(`${tenantId}:${userId}`);
    return member ? { ...member } : undefined;
  }

  putSession(session: SessionBindingSnapshot): void {
    this.#sessions.set(session.sessionId, { ...session });
  }

  putMember(member: PlatformMember): void {
    this.#members.set(`${member.tenantId}:${member.userId}`, { ...member });
  }

  revokeSession(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    this.#sessions.set(sessionId, { ...session, status: "revoked", revision: session.revision + 1 });
  }
}
