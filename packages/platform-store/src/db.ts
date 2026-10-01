/**
 * 连接与角色。
 *
 * 生产/开发都只用**一个**独立数据库（由调用方通过连接串指定），
 * 并且区分两种角色：
 *
 *   * **迁移角色**（owner，通常是部署时创建的 `myrix_owner` / 本地 `myrix_migrator`）：
 *     建表、建策略、跑迁移；绝不能作为应用运行期连接。
 *   * **应用角色** `myrix_app`：LOGIN + NOBYPASSRLS + NOSUPERUSER + NOCREATEDB + NOCREATEROLE，
 *     且不是任何业务表的 owner。FORCE ROW LEVEL SECURITY 对它一定生效。
 *
 * `createPlatformDatabase` 接受完整连接串（推荐），因此本包不内置任何主机/库名默认值，
 * 也不会误连到别的数据库。
 */

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

import type { PlatformDatabase } from "./schema";

/** 应用角色名固定：迁移里的策略与授权都按这个名字写。 */
export const DEFAULT_APP_ROLE = "myrix_app";

/** 开发库密码从环境变量读，绝不进版本库（见 src/bin/seed.ts） */
export const DEFAULT_APP_PASSWORD_ENV = "MYRIX_APP_PASSWORD";

export interface PlatformPoolOptions {
  /** 例：postgres://myrix_app:***@127.0.0.1:55439/myrix */
  connectionString: string;
  max?: number;
  /** 单条语句超时（毫秒）；防止某个查询把连接池占死 */
  statementTimeoutMs?: number;
  /** 事务空闲超时：本地开发/测试防挂起 */
  idleInTransactionTimeoutMs?: number;
  applicationName?: string;
}

export function createPlatformPool(options: PlatformPoolOptions): Pool {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName ?? "myrix-platform-store",
    ...(options.statementTimeoutMs ? { statement_timeout: options.statementTimeoutMs } : {}),
    ...(options.idleInTransactionTimeoutMs
      ? { idle_in_transaction_session_timeout: options.idleInTransactionTimeoutMs }
      : {}),
  });
  return pool;
}

export function createPlatformDatabase(pool: Pool): Kysely<PlatformDatabase> {
  return new Kysely<PlatformDatabase>({
    dialect: new PostgresDialect({ pool }),
  });
}
