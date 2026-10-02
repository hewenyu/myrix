import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { authorizePlatform } from "@myrix/governance";
import { NOVEL_TOOLS } from "@myrix/novel-protocol";
import { PlatformStore, assertRuntimeDatabase, createGovernanceAuthorizer, createPlatformDatabase, createPlatformPool } from "@myrix/platform-store";
import { PostgresAuthRepository } from "./auth-store";
import { createOidcAdapter } from "./oidc";
import { PostgresNovelRepository } from "./novel-store";
import { createBffServer } from "./server";
import { createBindingSnapshotReader, createWorksExecutor, createWorksServer, loadIdentity } from "./works-server";
import { assembleRuntime, RUNTIME_SERVICE_CAPABILITIES } from "./runtime-compose";
import type { RuntimeRuntime } from "./runtime-router";
import { readStartupEnvironment } from "./startup-config";

const BUSINESS_TABLES = ["tenants", "members", "works", "chapters", "chapter_versions", "outline_documents", "outline_versions", "bible_entries", "bible_entry_versions", "session_bindings", "commands", "outbox_messages", "audit_events"].map(name => `public.${name}`);

/** Persistent assembly only: never migrates, seeds, switches roles or substitutes an in-memory repository. */
export async function createProductionBff(env: NodeJS.ProcessEnv = process.env) {
  const config = readStartupEnvironment(env);
  const pool = createPlatformPool({ connectionString: config.bff.databaseUrl });
  const authPool = new Pool({ connectionString: config.bff.authDatabaseUrl, max: 5, connectionTimeoutMillis: 10_000, application_name: "myrix-bff-auth" });
  // An idle socket failure must not turn into an uncaught EventEmitter error; do not print raw PG diagnostics.
  pool.on("error", () => console.error("Myrix business database connection failed"));
  authPool.on("error", () => console.error("Myrix authentication database connection failed"));
  const db = createPlatformDatabase(pool);
  const authCheck = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: authPool }) });
  let server: FastifyInstance | undefined;
  let worksServer: FastifyInstance | undefined;
  let runtime: RuntimeRuntime | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    const stopped = await Promise.allSettled([runtime?.dispatcher.stop(), server?.close(), worksServer?.close()]);
    const databases = await Promise.allSettled([db.destroy(), authCheck.destroy()]);
    if ([...stopped, ...databases].some(result => result.status === "rejected")) throw new Error("Myrix BFF resource cleanup failed");
  })();
  try {
    await assertRuntimeDatabase(db, BUSINESS_TABLES, { requireRls: true });
    await assertRuntimeDatabase(authCheck, ["myrix_auth.sessions", "myrix_auth.flows", "myrix_auth.subjects"], { requireRls: false });
    const authorizer = createGovernanceAuthorizer({ authorizePlatform });
    const browserStore = new PlatformStore({ db, authorizer });
    // Service capabilities exist only on the dispatcher instance, never on browser/tool repository objects.
    const dispatcherStore = new PlatformStore({ db, authorizer, serviceCapabilities: RUNTIME_SERVICE_CAPABILITIES });
    runtime = assembleRuntime({ env: config.runtime, store: dispatcherStore, jwksByCell: config.jwksByCell });
    const authRepository = new PostgresAuthRepository(authPool, actor => loadIdentity(browserStore, actor));
    const oidc = config.bff.oidc ? await createOidcAdapter({ ...config.bff.oidc, origin: config.bff.origin }) : undefined;
    server = await createBffServer({
      auth: { mode: config.bff.mode, origin: config.bff.origin, sessionTtlSeconds: config.bff.sessionTtlSeconds,
        repository: authRepository, ...(oidc ? { oidc } : {}),
        ...(config.bff.developmentUsers ? { developmentUsers: config.bff.developmentUsers } : {}) },
      repository: new PostgresNovelRepository(browserStore), runtime,
      ...(config.bff.staticRoot ? { staticRoot: config.bff.staticRoot } : {}),
    });
    // Explicit v0.1 capability publication, not a PEP fallback: membership/owner/binding,
    // preset intersection and current CAS are still independently required for every tool.
    // Any change to this deployed capability policy must increment its policy revision.
    worksServer = await createWorksServer(createWorksExecutor(browserStore, config.registry),
      createBindingSnapshotReader(browserStore, config.registry, { rev: 1, tools: NOVEL_TOOLS, ttlMs: 10_000 }));
    const bff = server, works = worksServer, router = runtime;
    let started: Promise<void> | undefined;
    const start = (): Promise<void> => {
      if (closing) return Promise.reject(new Error("Cannot start a closed BFF assembly"));
      return started ??= (async () => {
        try {
          await works.listen({ host: config.worksHost, port: config.worksPort });
          await bff.listen({ host: config.bff.host, port: config.bff.port });
          router.dispatcher.start();
        } catch {
          await close().catch(() => undefined);
          throw new Error("Myrix BFF listen/start failed; all owned resources were closed");
        }
      })();
    };
    return { server: bff, worksServer: works, runtime: router, start, close,
      diagnostics: { mode: config.bff.mode, bffPort: config.bff.port, worksPort: config.worksPort, cells: config.runtime.cells.length } };
  } catch {
    await close().catch(() => undefined);
    throw new Error("Myrix BFF assembly failed: check low-privilege database roles, migrations and explicit authentication configuration");
  }
}
