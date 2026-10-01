import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";

import {
  createDenyAllAuthorizer,
  isServiceCapability,
  type Authorizer,
  type PlatformActor,
  type PlatformRequest,
  type ServiceCapability,
} from "./authz";
import { errors, PlatformStoreError } from "./errors";
import type { MigrationDatabase, PlatformDatabase } from "./schema";

/**
 * 租户作用域事务。
 *
 * 为什么必须"每事务 set_config(..., true)"：
 *   * Postgres 连接池里同一个连接会被不同租户复用。如果用 SET SESSION 或 SET LOCAL
 *     写在事务外，上下文会泄漏到下一位使用者，RLS 就会把 A 租户的数据当成 B 租户的放行。
 *   * `set_config('myrix.tenant_id', $1, true)` 的第三个参数 true = is_local = 只在本事务有效，
 *     事务提交或回滚后立刻回到 NULL。未设置时 RLS 策略 `tenant_id = NULL` 恒不成立，
 *     于是"忘了设置"的查询读回 0 行、写入直接违反 WITH CHECK —— fail-closed。
 *
 * 另外：仓储层不做授权判定，只调用 Authorizer（成员请求）或 requireService（系统操作）。
 */

/** 事务内可用的句柄：Kysely 事务 + 已确认的租户/操作者上下文 */
export interface StoreTx {
  readonly trx: Transaction<PlatformDatabase>;
  readonly tenantId: string;
  readonly actorUserId: string | undefined;
}

/** 事务内需要额外读 myrix_internal 时使用（迁移、运维脚本） */
export type StoreTxWithInternal = StoreTx & { readonly trx: Transaction<MigrationDatabase> };

export interface PlatformStoreOptions {
  db: Kysely<PlatformDatabase>;
  /**
   * 成员请求的判定函数。**必须**绑定 `@myrix/governance` 的 `authorizePlatform`
   * （用 `createGovernanceAuthorizer`）。省略时为默认全拒（fail-closed）。
   */
  authorizer?: Authorizer;
  /**
   * 系统能力清单。只有列在这里的能力才能执行对应内部操作；
   * 省略即"没有任何系统能力"，命令队列/outbox/审计写入全部拒绝。
   *
   * 这份清单由服务端装配时决定（投递循环进程、部署脚本），**绝不能**来自 HTTP 请求。
   */
  serviceCapabilities?: readonly ServiceCapability[];
  /** 时钟注入（纯函数测试友好）；默认 Date.now */
  now?: () => Date;
}

export interface TenantContextInput {
  tenantId: string;
  /** 操作者；控制面签发场景下由服务端确定，浏览器不能指定 */
  actorUserId?: string;
}

export class PlatformStore {
  readonly db: Kysely<PlatformDatabase>;
  readonly authorizer: Authorizer;
  private readonly capabilities: ReadonlySet<string>;
  private readonly nowFn: () => Date;

  constructor(options: PlatformStoreOptions) {
    if (!options?.db) {
      throw new Error("myrix: PlatformStore 必须提供 Kysely 连接（缺 db 视为装配错误）");
    }
    this.db = options.db;
    this.authorizer = options.authorizer ?? createDenyAllAuthorizer();
    this.capabilities = new Set(options.serviceCapabilities ?? []);
    this.nowFn = options.now ?? (() => new Date());
  }

  now(): Date {
    return this.nowFn();
  }

  /**
   * 在某个租户上下文里跑一个事务。
   *
   * `set_config` 与业务语句在同一个事务里，因此连接被回收时上下文已经清空；
   * 任何异常都会回滚整个事务（不会留下半套写入）。
   */
  async withTenant<T>(input: TenantContextInput, fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    if (typeof input.tenantId !== "string" || input.tenantId.length === 0) {
      throw errors.invalidInput("withTenant 必须提供 tenantId");
    }

    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('myrix.tenant_id', ${input.tenantId}, true)`.execute(trx);
      await sql`select set_config('myrix.actor_user_id', ${input.actorUserId ?? ""}, true)`.execute(trx);
      const tx: StoreTx = {
        trx,
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
      };
      return fn(tx);
    });
  }

  /**
   * 跨租户的运维事务（部署期装配、迁移脚本）。这是**部署凭据**路径：
   * 调用方必须自己拿迁移/owner 连接，而不是应用连接（myrix_app 连建表权限都没有）。
   * 应用运行期不应调用它，因此这里没有任何"绕过 RLS"的开关。
   */
  async withSystem<T>(fn: (trx: Transaction<MigrationDatabase>) => Promise<T>): Promise<T> {
    return (this.db as unknown as Kysely<MigrationDatabase>).transaction().execute(fn);
  }

  /** 成员请求判定：仓储层的每个成员可见操作都先过这里 */
  authorize(request: PlatformRequest): void {
    const decision = this.authorizer(request);
    if (decision.effect !== "allow") {
      throw errors.forbidden(decision.reason, { action: request.action });
    }
  }

  /** 判定但不抛错：用于"是否放行"影响返回形状的场景（如列表过滤） */
  decide(request: PlatformRequest) {
    return this.authorizer(request);
  }

  /**
   * 系统操作判定。与成员判定完全分开：
   *   * 能力必须由构造方显式列出；
   *   * 未知/未授予的能力 → forbidden，且 reason 明确说明"浏览器不可调用"。
   */
  hasService(capability: ServiceCapability): boolean {
    return this.capabilities.has(capability);
  }

  requireService(capability: ServiceCapability, operation: string): void {
    if (!isServiceCapability(capability)) {
      throw errors.forbidden(`unknown-capability: ${operation} 请求了未定义的系统能力`, { operation });
    }
    if (!this.capabilities.has(capability)) {
      throw errors.forbidden(
        `service-capability-missing: 系统操作 ${operation} 需要能力 ${capability}，当前装配未授予；` +
          "该操作是内部可信调用路径，浏览器与普通成员请求不可调用",
        { capability, operation },
      );
    }
  }

  static actorOf(
    userId: string | undefined,
    tenantId: string,
    membership?: PlatformActor["membership"],
  ): PlatformActor {
    return { userId: userId ?? "", tenantId, membership: membership ?? null };
  }

  /** 把一个普通错误规范化成 PlatformStoreError；未预期错误一律 503，不泄漏 SQL 细节 */
  static toStoreError(error: unknown, fallbackReason: string): PlatformStoreError {
    if (error instanceof PlatformStoreError) return error;
    return errors.storageUnavailable(fallbackReason, error);
  }
}
