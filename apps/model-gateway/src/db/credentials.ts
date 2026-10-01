/**
 * AuthorizerPort 的生产装配件。
 *
 * 网关自己拥有的只有 `myrix_gateway.cell_credentials`（令牌 SHA-256 → 租户/cell）。
 * 会话绑定与成员记录属于业务存储（`myrix.session_bindings` / `members`，由
 * `@myrix/platform-store` 或业务服务拥有，另一个子任务在开发中），
 * 因此这里只定义最小的**读取端口**并做组合，不在网关里复制业务 SQL。
 *
 * Lead 接入方式（二选一）：
 *   1. `createPortFromReaders({ credentials, sessions, members })` —— 直接注入已有 store 的读取函数；
 *   2. 实现 `AuthorizerPort` 三个方法后直接交给 `createAuthorizer`。
 * 两种方式都必须保证：读取解析出来的 tenantId 来自**凭据绑定**，不是请求头。
 */
import { sql, type Kysely } from "kysely";
import type {
  AuthorizerPort,
  CellCredentialBinding,
  SessionBindingSnapshot,
} from "../ports";
import type { PlatformMember } from "@myrix/governance";
import { sha256Hex } from "../util";
import type { CellCredentialsTable, GatewayDatabase } from "./schema";

/**
 * 令牌摘要解析端口（运行期路径，用**应用角色**连接即可）。
 *
 * 只做一件事：`sha256(token)` → `resolve_cell_credential()` → `(tenantId, cellId)`。
 * 应用角色没有 `cell_credentials` 表权限，读不到明文、也列举不了别的租户。
 */
export interface CellCredentialResolver {
  resolve(token: string): Promise<CellCredentialBinding | undefined>;
}

export function createPostgresCredentialResolver(db: Kysely<GatewayDatabase>): CellCredentialResolver {
  return {
    async resolve(token: string): Promise<CellCredentialBinding | undefined> {
      if (typeof token !== "string" || token.length === 0) return undefined;
      const rows = await sql<{ tenant_id: string; cell_id: string }>`
        select tenant_id, cell_id
        from myrix_gateway.resolve_cell_credential(${sha256Hex(token)})
      `.execute(db);
      const row = rows.rows[0];
      return row ? { tenantId: row.tenant_id, cellId: row.cell_id } : undefined;
    },
  };
}

/**
 * 凭据登记/撤销（**必须用 owner/迁移角色连接**，不能用应用角色）。
 *
 * 为什么分开：`cell_credentials` 故意不授予应用角色任何权限（只能走 SECURITY DEFINER
 * 精确查询）。运行期服务要是能登记凭据，就等于"被攻破的 gateway 实例可以给自己发新 cell 凭据"。
 * 因此本工厂的调用方是运维脚本/管理作业，不是请求路径。
 */
export interface CellCredentialAdmin {
  /** 登记或轮换（只存摘要；同摘要再次登记会重新置为 active） */
  upsert(input: { token: string; tenantId: string; cellId: string }): Promise<void>;
  /** 撤销：status='disabled'，保留审计轨迹；返回是否真的改动了行 */
  revoke(token: string): Promise<boolean>;
}

export function createPostgresCredentialAdmin(db: Kysely<GatewayDatabase>): CellCredentialAdmin {
  return {
    async upsert(input: { token: string; tenantId: string; cellId: string }): Promise<void> {
      if (typeof input.token !== "string" || input.token.length < 16) {
        throw new Error("cell 凭据至少 16 个字符，避免误配成弱口令");
      }
      await db.transaction().execute(async (tx) => {
        await sql`select set_config('myrix_gateway.tenant_id', ${input.tenantId}, true)`.execute(tx);
        const registered = await tx
          .insertInto("myrix_gateway.cell_credentials")
          .values({
            token_hash: sha256Hex(input.token),
            tenant_id: input.tenantId,
            cell_id: input.cellId,
            status: "active",
            revoked_at: null,
          })
          .onConflict((oc) =>
            oc.column("token_hash").doUpdateSet({ status: "active", revoked_at: null })
              .where("myrix_gateway.cell_credentials.tenant_id", "=", input.tenantId)
              .where("myrix_gateway.cell_credentials.cell_id", "=", input.cellId),
          )
          .returning("token_hash")
          .executeTakeFirst();
        if (!registered) throw new Error("Cell 凭据已绑定其他租户或 Cell；禁止通过重复登记改变凭据归属");
      });
    },
    async revoke(token: string): Promise<boolean> {
      const result = await sql`
        update myrix_gateway.cell_credentials
        set status = 'disabled', revoked_at = now()
        where token_hash = ${sha256Hex(token)} and status = 'active'
      `.execute(db);
      return (result.numAffectedRows ?? 0n) > 0n;
    },
  };
}

/** 业务存储读取端口：由业务 store 实现（它掌握 RLS 上下文与连接池）。 */
export interface BusinessReaders {
  loadSessionBinding(tenantId: string, sessionId: string): Promise<SessionBindingSnapshot | undefined>;
  loadMember(tenantId: string, userId: string): Promise<PlatformMember | undefined>;
}

/** 把凭据解析器与业务读取器组合成 AuthorizerPort。 */
export function createPortFromReaders(input: {
  credentials: CellCredentialResolver;
  business: BusinessReaders;
}): AuthorizerPort {
  return {
    resolveCredential: (token: string) => input.credentials.resolve(token),
    loadSessionBinding: (tenantId: string, sessionId: string) => input.business.loadSessionBinding(tenantId, sessionId),
    loadMember: (tenantId: string, userId: string) => input.business.loadMember(tenantId, userId),
  };
}

/** 表类型导出，便于实现方对齐列名（网关不改业务表）。 */
export type { CellCredentialsTable };
