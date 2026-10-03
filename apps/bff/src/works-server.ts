import { createHash } from "node:crypto";
import Fastify, { type FastifyError } from "fastify";
import { sql } from "kysely";
import { authorizePlatform } from "@myrix/governance";
import type { PlatformIdentity } from "@myrix/contracts";
import type { PlatformStore } from "@myrix/platform-store";
import { ApiFailure } from "./ports";
import { PostgresNovelRepository, TransactionBoundStore, throwApiError } from "./novel-store";
import { isNovelTool, parseToolArguments, toolsForPreset, type NovelToolName } from "@myrix/novel-protocol";

export interface CellCredential { tenantId: string; cellId: string; token: string }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Explicit Cell credentials are hashed in process; never accepted as browser login or actor claims. */
export class CellCredentialRegistry {
  private readonly entries = new Map<string, Omit<CellCredential, "token">>();
  constructor(credentials: readonly CellCredential[]) {
    for (const credential of credentials) {
      if (!credential.tenantId || !credential.cellId || credential.token.length < 32) throw new Error("Cell credential requires tenant, cell and at least 32 secret characters");
      const key = hash(credential.token);
      if (this.entries.has(key)) throw new Error("A Cell credential cannot be shared by two bindings");
      this.entries.set(key, { tenantId: credential.tenantId, cellId: credential.cellId });
    }
  }
  resolve(authorization: string | undefined) {
    const match = authorization && /^Bearer ([^\s]+)$/.exec(authorization);
    const credential = match?.[1] && this.entries.get(hash(match[1]));
    if (!credential) throw new ApiFailure(401, "invalid_cell_credential", "Cell 服务凭据无效");
    return credential;
  }
}

/** Uses the same nonowner connection and RLS context as ordinary repository operations. */
export async function loadIdentity(store: PlatformStore, actor: { tenantId: string; userId: string }): Promise<PlatformIdentity | undefined> {
  return store.withTenant({ tenantId: actor.tenantId, actorUserId: actor.userId }, async tx => {
    const row = await tx.trx.selectFrom("members").innerJoin("tenants", "tenants.id", "members.tenant_id")
      .select(["members.role", "members.display_name"]).where("members.user_id", "=", actor.userId)
      .where("members.status", "=", "active").where("tenants.status", "=", "active").executeTakeFirst();
    if (!row || (row.role !== "admin" && row.role !== "member")) return undefined;
    return { ...actor, displayName: row.display_name ?? "用户", role: row.role };
  });
}

export function createWorksExecutor(store: PlatformStore, credentials: CellCredentialRegistry) {
  return async (authorization: string | undefined, sessionId: string, revision: number, tool: NovelToolName, raw: unknown): Promise<unknown> => {
    const cell = credentials.resolve(authorization);
    const args = parseToolArguments(tool, raw);
    try {
      return await store.withTenant({ tenantId: cell.tenantId }, async tx => {
        // Locks remain held through the business write: revoke/disable cannot race past a successful check.
        const binding = await tx.trx.selectFrom("session_bindings").selectAll().where("id", "=", sessionId).forShare().executeTakeFirst();
        if (!binding || binding.cell_id !== cell.cellId || binding.status !== "active") throw new ApiFailure(403, "session_unavailable", "会话不属于此 Cell 或已停止");
        // 归档**不**改工具权限：归档只整理历史，不停止任务。已在执行的回合继续写正文/
        // 大纲/设定，Cell 的工具掩码只看 preset 与所有权，不看 archived_at。
        const member = await tx.trx.selectFrom("members").selectAll().where("user_id", "=", binding.owner_user_id).forShare().executeTakeFirst();
        const tenant = await tx.trx.selectFrom("tenants").selectAll().where("id", "=", cell.tenantId).forShare().executeTakeFirst();
        if (!member || tenant?.status !== "active" || (member.role !== "member" && member.role !== "admin")) throw new ApiFailure(403, "membership_unavailable", "租户或成员访问权限已失效");
        const actor: PlatformIdentity = { tenantId: cell.tenantId, userId: binding.owner_user_id, displayName: member.display_name ?? "用户", role: member.role };
        const decision = authorizePlatform({ actor, member: { tenantId: cell.tenantId, userId: actor.userId, role: member.role, status: member.status },
          action: "sessions:send", resource: { tenantId: cell.tenantId, ownerUserId: actor.userId, status: binding.status, revision: binding.revoked_revision }, expectedRevision: revision });
        if (decision.effect !== "allow") throw new ApiFailure(403, "forbidden", decision.reason);
        // 未知 preset（数据库里的历史值或人为写入）在**执行路径**上必须拒绝，
        // 而不是回退到"全集"：这里直接取掩码，取不到就 403（fail-closed）。
        const presetTools = toolsForPreset(binding.preset);
        if (!presetTools || !presetTools.includes(tool)) throw new ApiFailure(403, "tool_not_allowed", "当前助手无权使用此工具");
        await sql`select set_config('myrix.actor_user_id', ${actor.userId}, true)`.execute(tx.trx);
        const repository = new PostgresNovelRepository(new TransactionBoundStore(store, { ...tx, actorUserId: actor.userId }));
        const wid = binding.work_id;
        const work = await tx.trx.selectFrom("works").select(["owner_user_id", "status"])
          .where("id", "=", wid).forShare().executeTakeFirst();
        if (!work || work.owner_user_id !== actor.userId || work.status !== "active") {
          throw new ApiFailure(403, "work_unavailable", "绑定作品不存在、已停止或不属于当前主体");
        }
        switch (tool) {
          case "get_outline": return repository.getOutline(actor, wid);
          case "update_outline": return repository.saveOutline(actor, wid, { text: args.text!, expectedVersion: args.expectedVersion! });
          case "get_chapter": return repository.getChapter(actor, wid, args.chapterId!);
          case "save_chapter_draft": return repository.saveChapter(actor, wid, args.chapterId!, { text: args.text!, expectedVersion: args.expectedVersion! });
          case "search_bible": return repository.listBible(actor, wid, args.query!);
          case "update_bible_entry": return repository.saveBible(actor, wid, args.entryId!, { text: args.text!, expectedVersion: args.expectedVersion! });
        }
      });
    } catch (error) { return throwApiError(error); }
  };
}

/**
 * Cell 级策略快照（部署控制，不是绑定修订）。
 *
 * `rev` 是**策略版本**：一次部署/一次策略发布会递增它；它与绑定的撤权版本
 * `revoked_revision` 无关，Cell 侧按策略版本单独做单调拒绝。
 */
export interface BindingSnapshotPolicy {
  readonly rev: number;
  readonly tools: readonly string[];
  readonly ttlMs: number;
}

export interface BindingSnapshot {
  cellId: string;
  tenantId: string;
  bindings: Array<{ sid: string; tid: string; sub: string; wid: string; preset: string; rev: number }>;
  /** 可选策略；缺省表示本 Cell 没有配置策略（老客户端忽略该字段）。 */
  policy?: BindingSnapshotPolicy;
}

/** 策略 `ttlMs` 的硬上限：与 Cell 侧租约的 30 秒上限逐字一致。 */
export const MAX_SNAPSHOT_POLICY_TTL_MS = 30_000;

/**
 * 校验部署下发的策略并**只保留六个已知小说工具**。
 *
 * 这是"合并类操作只能收窄"在服务端的落点：运维配置里多写一个工具名不会
 * 出现在响应里。与拼写错误不同，未知工具名在这里**显式抛错**（启动即失败），
 * 因为一个被静默丢掉的工具会让 Cell 侧表现为"工具莫名被拒"，比启动失败难查。
 * 显式空数组是合法值：它表示"什么都不允许"，会原样下发。
 */
export function resolveSnapshotPolicy(policy: BindingSnapshotPolicy | undefined): BindingSnapshotPolicy | undefined {
  if (policy === undefined) return undefined;
  if (!Number.isSafeInteger(policy.rev) || policy.rev < 0) throw new Error("绑定快照策略 rev 必须是非负安全整数");
  if (!Number.isSafeInteger(policy.ttlMs) || policy.ttlMs <= 0 || policy.ttlMs > MAX_SNAPSHOT_POLICY_TTL_MS) {
    throw new Error(`绑定快照策略 ttlMs 必须是 (0, ${MAX_SNAPSHOT_POLICY_TTL_MS}] 内的安全整数`);
  }
  if (!Array.isArray(policy.tools)) throw new Error("绑定快照策略 tools 必须是数组");
  const tools: NovelToolName[] = [];
  for (const tool of policy.tools) {
    if (!isNovelTool(tool)) throw new Error("绑定快照策略包含未知工具名");
    if (!tools.includes(tool)) tools.push(tool);
  }
  return Object.freeze({ rev: policy.rev, tools: Object.freeze([...tools]), ttlMs: policy.ttlMs });
}

/**
 * 认证并返回当前 Cell 的授权快照。
 *
 * `policy` 是**显式**的第三个参数：省略时响应里没有策略字段，Cell 侧策略执行点
 * 因此没有快照并拒绝一切工具调用（fail-closed）。本函数只回本 Cell 凭据解析出的
 * 租户数据，不回凭据、不回作品正文。
 */
export function createBindingSnapshotReader(store: PlatformStore, credentials: CellCredentialRegistry, policy?: BindingSnapshotPolicy) {
  const resolved = resolveSnapshotPolicy(policy);
  return async (authorization: string | undefined, cellId: string): Promise<BindingSnapshot> => {
    const cell = credentials.resolve(authorization);
    if (cell.cellId !== cellId) throw new ApiFailure(403, "wrong_cell", "服务凭据不属于此 Cell");
    return store.withTenant({ tenantId: cell.tenantId }, async tx => {
      const rows = await tx.trx.selectFrom("session_bindings as b")
        .innerJoin("members as m", join => join.onRef("m.tenant_id", "=", "b.tenant_id").onRef("m.user_id", "=", "b.owner_user_id"))
        .innerJoin("works as w", join => join.onRef("w.tenant_id", "=", "b.tenant_id").onRef("w.id", "=", "b.work_id").onRef("w.owner_user_id", "=", "b.owner_user_id"))
        .innerJoin("tenants as t", "t.id", "b.tenant_id")
        .select(["b.id", "b.tenant_id", "b.owner_user_id", "b.work_id", "b.preset", "b.revoked_revision", "b.status", "m.role", "m.status as member_status"])
        .where("b.cell_id", "=", cell.cellId).where("b.status", "in", ["creating", "active"])
        // 归档**不**改快照：归档只整理历史，不停止任务，Cell 的工具权限与活性租约
        // 必须保持原样，否则归档会把一条仍在跑的会话从 Cell 的可服务主体里摘掉。
        .where("t.status", "=", "active").where("w.status", "=", "active").limit(10_001).execute();
      if (rows.length > 10_000) throw new ApiFailure(503, "snapshot_too_large", "Cell 会话授权快照超过首版容量限制");
      const bindings = rows.filter(row => authorizePlatform({
        actor: { tenantId: cell.tenantId, userId: row.owner_user_id },
        member: { tenantId: cell.tenantId, userId: row.owner_user_id, role: row.role, status: row.member_status },
        action: "sessions:read",
        resource: { tenantId: row.tenant_id, ownerUserId: row.owner_user_id, status: row.status, revision: row.revoked_revision },
        expectedRevision: row.revoked_revision,
      }).effect === "allow").map(row => ({ sid: row.id, tid: row.tenant_id, sub: row.owner_user_id,
        wid: row.work_id, preset: row.preset, rev: row.revoked_revision }));
      return { cellId, tenantId: cell.tenantId, bindings, ...(resolved === undefined ? {} : { policy: resolved }) };
    });
  };
}

/** Internal-only server. Deployment must keep this listener off the public ingress. */
export async function createWorksServer(execute: ReturnType<typeof createWorksExecutor>, readBindings?: ReturnType<typeof createBindingSnapshotReader>) {
  const app = Fastify({ logger: false, bodyLimit: 2_000_000 });
  app.setErrorHandler<FastifyError>((error, _req, reply) => {
    if (error instanceof ApiFailure) return reply.code(error.statusCode).send({ error: error.code, reason: error.reason });
    if (error.validation) return reply.code(400).send({ error: "invalid_input", reason: "作品操作参数无效" });
    return reply.code(503).send({ error: "service_unavailable", reason: "作品服务暂不可用" });
  });
  app.addHook("onSend", async (_request, reply) => { reply.header("Cache-Control", "no-store"); });
  app.get<{ Params: { cellId: string } }>("/internal/v1/cells/:cellId/bindings", async request => {
    if (!readBindings) throw new ApiFailure(503, "bindings_unavailable", "Cell 授权快照服务未配置");
    return readBindings(request.headers.authorization, request.params.cellId);
  });
  app.post<{ Params: { sessionId: string; tool: string } }>("/internal/v1/sessions/:sessionId/tools/:tool", async (request, reply) => {
    const revision = request.headers["x-myrix-revision"];
    if (typeof revision !== "string" || !/^\d{1,16}$/.test(revision) || !Number.isSafeInteger(Number(revision))) throw new ApiFailure(400, "invalid_revision", "缺少有效会话撤权版本");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.params.sessionId) || !isNovelTool(request.params.tool)) throw new ApiFailure(400, "invalid_tool", "会话或工具名无效");
    let args;
    try { args = parseToolArguments(request.params.tool, request.body); } catch { throw new ApiFailure(400, "invalid_input", "工具参数无效，禁止提供身份或作品字段"); }
    const result = await execute(request.headers.authorization, request.params.sessionId, Number(revision), request.params.tool, args);
    const conflict = result && typeof result === "object" && "status" in result && result.status === "conflict";
    return reply.code(conflict ? 409 : 200).send({ result });
  });
  return app;
}
