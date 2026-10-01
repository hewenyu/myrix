/**
 * Kysely 库类型（schema `myrix_gateway`）。
 *
 * 只声明网关自己拥有的表；业务表（session_bindings / members）由
 * `@myrix/platform-store` 拥有，网关通过注入的 AuthorizerPort 读取，
 * 不在这里复制它们的类型定义，避免两处漂移。
 */
import type { ColumnType, Generated } from "kysely";

export type ReservationOutcome = "pending" | "settled" | "unknown" | "released";

export interface QuotaReservationsTable {
  tenant_id: string;
  request_id: string;
  user_id: string;
  session_id: string;
  cell_id: string;
  model: string;
  reserved_tokens: number;
  /** 真实结算量；可以大于 `reserved_tokens`（预占是闸门，不是计费上限）。 */
  consumed_tokens: Generated<number>;
  outcome: Generated<ReservationOutcome>;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  /** 上游声明的 total_tokens（0001 起落库，便于对账超额结算）。 */
  total_tokens: number | null;
  upstream_status: number | null;
  latency_ms: number | null;
  created_at: Generated<Date>;
  settled_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
}

export interface CellCredentialsTable {
  token_hash: string;
  tenant_id: string;
  cell_id: string;
  status: Generated<"active" | "disabled">;
  created_at: Generated<Date>;
  revoked_at: Date | null;
}

export interface SchemaMigrationsTable {
  name: string;
  applied_at: ColumnType<Date, Date | undefined, never>;
  checksum: string;
}

/**
 * `resolve_cell_credential` 不是表，而是 SECURITY DEFINER 函数；这里按 Kysely 的
 * "虚拟表" 形状声明，只为让 `sql` 原生查询有返回类型。**不要**对它调用
 * `selectFrom`（会生成非法 SQL）。
 */
export interface ResolveCellCredentialRow {
  tenant_id: string;
  cell_id: string;
}

export interface GatewayDatabase {
  "myrix_gateway.quota_reservations": QuotaReservationsTable;
  "myrix_gateway.cell_credentials": CellCredentialsTable;
  "myrix_gateway.schema_migrations": SchemaMigrationsTable;
  /** 见上方说明：函数结果形状，仅供原生 SQL 使用 */
  "myrix_gateway.resolve_cell_credential": ResolveCellCredentialRow;
}

/** 迁移运行器与运行期共用同一个库类型；保留别名以免调用方额外适配。 */
export type GatewayMigrationDatabase = GatewayDatabase;
