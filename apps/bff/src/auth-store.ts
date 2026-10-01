import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import type { PlatformIdentity } from "@myrix/contracts";
import type { AuthActor, AuthRepository, AuthSession, LoginFlow } from "./auth";

interface AuthDatabase {
  "myrix_auth.sessions": { token_hash: string; tenant_id: string; user_id: string; csrf_token: string; expires_at: Date };
  "myrix_auth.flows": { token_hash: string; state: string; nonce: string; verifier: string; expires_at: Date };
  "myrix_auth.subjects": { issuer: string; subject: string; tenant_id: string; user_id: string };
}

/** Separate credential store: tenant is unknown until an opaque token has been authenticated. */
export class PostgresAuthRepository implements AuthRepository {
  private readonly db: Kysely<AuthDatabase>;
  constructor(pool: Pool, private readonly loadIdentity: (actor: AuthActor) => Promise<PlatformIdentity | undefined>) {
    this.db = new Kysely<AuthDatabase>({ dialect: new PostgresDialect({ pool }) });
  }
  async createSession(hash: string, session: AuthSession): Promise<void> {
    await this.db.insertInto("myrix_auth.sessions").values({ token_hash: hash, tenant_id: session.actor.tenantId,
      user_id: session.actor.userId, csrf_token: session.csrfToken, expires_at: session.expiresAt }).execute();
  }
  async findSession(hash: string): Promise<AuthSession | undefined> {
    const row = await this.db.selectFrom("myrix_auth.sessions").selectAll().where("token_hash", "=", hash).executeTakeFirst();
    return row && { actor: { tenantId: row.tenant_id, userId: row.user_id }, csrfToken: row.csrf_token, expiresAt: row.expires_at };
  }
  async deleteSession(hash: string): Promise<void> { await this.db.deleteFrom("myrix_auth.sessions").where("token_hash", "=", hash).execute(); }
  async createFlow(hash: string, flow: LoginFlow): Promise<void> {
    await this.db.insertInto("myrix_auth.flows").values({ token_hash: hash, state: flow.state, nonce: flow.nonce,
      verifier: flow.verifier, expires_at: flow.expiresAt }).execute();
  }
  async consumeFlow(hash: string): Promise<LoginFlow | undefined> {
    const row = await this.db.deleteFrom("myrix_auth.flows").where("token_hash", "=", hash).returningAll().executeTakeFirst();
    return row && { state: row.state, nonce: row.nonce, verifier: row.verifier, expiresAt: row.expires_at };
  }
  async resolveSubject(issuer: string, subject: string): Promise<AuthActor | undefined> {
    const row = await this.db.selectFrom("myrix_auth.subjects").select(["tenant_id", "user_id"])
      .where("issuer", "=", issuer).where("subject", "=", subject).executeTakeFirst();
    return row && { tenantId: row.tenant_id, userId: row.user_id };
  }
  identity(actor: AuthActor): Promise<PlatformIdentity | undefined> { return this.loadIdentity(actor); }
  async pruneExpired(now: Date): Promise<void> {
    await this.db.deleteFrom("myrix_auth.sessions").where("expires_at", "<=", now).execute();
    await this.db.deleteFrom("myrix_auth.flows").where("expires_at", "<=", now).execute();
  }
}

/** Run only with the migration credential, never automatically at server startup. */
export async function migrateAuth(pool: Pool, appRole: string): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(appRole)) throw new Error("Invalid application role name");
  const db = new Kysely<AuthDatabase>({ dialect: new PostgresDialect({ pool }) });
  await db.transaction().execute(async tx => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended('myrix:auth-migrations', 0))`.execute(tx);
    await sql`CREATE SCHEMA IF NOT EXISTS myrix_auth`.execute(tx);
    await sql`CREATE TABLE IF NOT EXISTS myrix_auth.sessions (
      token_hash text PRIMARY KEY CHECK (length(token_hash) = 64), tenant_id text NOT NULL, user_id text NOT NULL,
      csrf_token text NOT NULL, expires_at timestamptz NOT NULL
    )`.execute(tx);
    await sql`CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON myrix_auth.sessions (expires_at)`.execute(tx);
    await sql`CREATE TABLE IF NOT EXISTS myrix_auth.flows (
      token_hash text PRIMARY KEY CHECK (length(token_hash) = 64), state text NOT NULL, nonce text NOT NULL,
      verifier text NOT NULL, expires_at timestamptz NOT NULL
    )`.execute(tx);
    await sql`CREATE TABLE IF NOT EXISTS myrix_auth.subjects (
      issuer text NOT NULL, subject text NOT NULL, tenant_id text NOT NULL, user_id text NOT NULL,
      PRIMARY KEY (issuer, subject)
    )`.execute(tx);
    await sql`REVOKE ALL ON SCHEMA myrix_auth FROM PUBLIC`.execute(tx);
    await sql`REVOKE ALL ON ALL TABLES IN SCHEMA myrix_auth FROM PUBLIC`.execute(tx);
    await sql`GRANT USAGE ON SCHEMA myrix_auth TO ${sql.id(appRole)}`.execute(tx);
    await sql`GRANT SELECT, INSERT, DELETE ON myrix_auth.sessions, myrix_auth.flows TO ${sql.id(appRole)}`.execute(tx);
    // Runtime cannot enroll arbitrary IdP subjects; provisioning requires the migration/admin credential.
    await sql`GRANT SELECT ON myrix_auth.subjects TO ${sql.id(appRole)}`.execute(tx);
  });
}
