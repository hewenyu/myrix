import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { PlatformStore } from "../../../packages/platform-store/src/store";
import { assertRuntimeDatabase } from "../../../packages/platform-store/src/runtime-db";
import type { PlatformDatabase } from "../../../packages/platform-store/src/schema";
import { createGatewayBusinessReaders } from "./business-reader";
import { createPortFromReaders, createPostgresCredentialResolver } from "./db/credentials";
import { createPostgresLedger } from "./db/ledger";
import type { GatewayDatabase } from "./db/schema";
import { resolveGatewayConfig } from "./config";
import { createGatewayRuntime } from "./factory";
import { createModelGatewayServer } from "./server";

function requiredUrl(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} 必须显式配置为独立非 owner LOGIN；网关不回退到内存存储`);
  try {
    const url = new URL(value);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username) throw new Error();
  } catch { throw new Error(`${key} 必须是有效的 PostgreSQL 连接串（值不写入日志）`); }
  return value;
}

/** Executable assembly never uses env identity maps, memory accounting, or migration credentials. */
export async function createProductionGateway(env: NodeJS.ProcessEnv = process.env) {
  const businessUrl = requiredUrl(env, "DATABASE_URL");
  const ledgerUrl = requiredUrl(env, "MYRIX_GATEWAY_DATABASE_URL");
  if (env.MYRIX_GATEWAY_CREDENTIAL_SOURCE && env.MYRIX_GATEWAY_CREDENTIAL_SOURCE !== "port") {
    throw new Error("运行入口只允许 PostgreSQL 凭据解析，不接受 MYRIX_GATEWAY_CREDENTIAL_SOURCE=env");
  }
  const config = resolveGatewayConfig({ ...env, MYRIX_GATEWAY_CREDENTIAL_SOURCE: "port" });
  const businessDb = new Kysely<PlatformDatabase>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: businessUrl, max: 5 }) }) });
  const ledgerDb = new Kysely<GatewayDatabase>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: ledgerUrl, max: 5 }) }) });
  const closeDatabases = async () => { await Promise.all([businessDb.destroy(), ledgerDb.destroy()]); };
  try {
    await assertRuntimeDatabase(businessDb, ["public.tenants", "public.members", "public.works", "public.session_bindings"]);
    await assertRuntimeDatabase(ledgerDb, ["myrix_gateway.quota_reservations"]);
    const runtime = createGatewayRuntime({ config,
      authorizerPort: createPortFromReaders({ credentials: createPostgresCredentialResolver(ledgerDb), business: createGatewayBusinessReaders(new PlatformStore({ db: businessDb })) }),
      ledger: createPostgresLedger(ledgerDb),
    });
    const server = await createModelGatewayServer({ gateway: runtime.gateway, bodyLimitBytes: config.limits.maxBodyBytes,
      logger: env.MYRIX_GATEWAY_LOG === "1" });
    server.addHook("onClose", closeDatabases);
    return { server, runtime, config };
  } catch (error) { await closeDatabases(); throw error; }
}
