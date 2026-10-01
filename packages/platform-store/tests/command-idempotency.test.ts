import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { authorizePlatform } from "@myrix/governance";
import { createGovernanceAuthorizer } from "../src/authz";
import { PlatformStore } from "../src/store";
import { migrateToLatest } from "../src/migrate";
import { CommandsRepository, type EnqueueCommandInput } from "../src/repositories/commands";
import type { MigrationDatabase, PlatformDatabase } from "../src/schema";

const appUrl = process.env.BFF_TEST_DATABASE_URL;
const migrationUrl = process.env.BFF_TEST_MIGRATION_DATABASE_URL;
// Append isolated random fixtures only; never delete/reset an existing database.
describe.skipIf(!appUrl || !migrationUrl)("durable command identity on a real nonowner LOGIN", () => {
  const tid = randomUUID(), author = randomUUID(), other = randomUUID();
  const work = randomUUID(), otherWork = randomUUID();
  const sid = randomUUID(), secondSid = randomUUID(), otherSid = randomUUID();
  let migration: Kysely<MigrationDatabase>;
  let db: Kysely<PlatformDatabase>;
  let commands: CommandsRepository;
  beforeAll(async () => {
    migration = new Kysely<MigrationDatabase>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: migrationUrl, max: 1 }) }) });
    db = new Kysely<PlatformDatabase>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: appUrl, max: 4 }) }) });
    await migrateToLatest(migration);
    const roles = await sql<{ login: boolean; rolsuper: boolean; rolbypassrls: boolean; owns: boolean }>`select current_user=session_user as login, r.rolsuper, r.rolbypassrls, c.relowner=r.oid as owns from pg_roles r cross join pg_class c where r.rolname=current_user and c.oid='commands'::regclass`.execute(db);
    expect(roles.rows[0]).toEqual({ login: true, rolsuper: false, rolbypassrls: false, owns: false });
    await migration.insertInto("tenants").values({ id: tid, slug: `commands-${tid}`, name: "Command integration" }).execute();
    await migration.insertInto("members").values([author, other].map(user_id => ({ tenant_id: tid, user_id, role: "member" as const, status: "active" as const }))).execute();
    await migration.insertInto("works").values([
      { tenant_id: tid, id: work, owner_user_id: author, title: "A", description: "" },
      { tenant_id: tid, id: otherWork, owner_user_id: other, title: "B", description: "" },
    ]).execute();
    await migration.insertInto("session_bindings").values([
      { tenant_id: tid, id: sid, owner_user_id: author, work_id: work, preset: "novel-chapter", status: "active", policy_revision: "test-v1", cell_id: "test-cell" },
      { tenant_id: tid, id: secondSid, owner_user_id: author, work_id: work, preset: "novel-chapter", status: "active", policy_revision: "test-v1", cell_id: "test-cell" },
      { tenant_id: tid, id: otherSid, owner_user_id: other, work_id: otherWork, preset: "novel-chapter", status: "active", policy_revision: "test-v1", cell_id: "test-cell" },
    ]).execute();
    commands = new CommandsRepository(new PlatformStore({ db, authorizer: createGovernanceAuthorizer({ authorizePlatform }), serviceCapabilities: ["command.enqueue"] }));
  });
  afterAll(async () => { await db?.destroy(); await migration?.destroy(); });
  const input = (): EnqueueCommandInput => ({ commandId: randomUUID(), bindingId: sid, op: "resume", body: {}, expectedRevision: 1 });

  it("returns the same persisted row only for the same complete identity", async () => {
    const command = input();
    const first = await commands.enqueue(tid, author, command);
    const second = await commands.enqueue(tid, author, command);
    expect(first.created).toBe(true);
    expect(second).toEqual({ command: first.command, created: false });
  });
  it.each(["binding", "operation", "body", "actor"])("rejects reuse with a different %s and preserves the original", async dimension => {
    const command = input();
    const first = await commands.enqueue(tid, author, command);
    const changed = { ...command };
    if (dimension === "binding") changed.bindingId = secondSid;
    if (dimension === "operation") changed.op = "cancel";
    if (dimension === "body") changed.body = { changed: true };
    if (dimension === "actor") changed.bindingId = otherSid;
    await expect(commands.enqueue(tid, dimension === "actor" ? other : author, changed)).rejects.toMatchObject({ code: "duplicate_request", httpStatus: 409 });
    expect(await commands.enqueue(tid, author, command)).toEqual({ command: first.command, created: false });
  });
  it("concurrent different-session/different-actor reuse never returns another caller's command", async () => {
    const command = input();
    const outcomes = await Promise.allSettled([
      commands.enqueue(tid, author, command),
      commands.enqueue(tid, other, { ...command, bindingId: otherSid }),
    ]);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "duplicate_request", httpStatus: 409 } });
    const persisted = await migration.selectFrom("commands").selectAll().where("tenant_id", "=", tid).where("id", "=", command.commandId).execute();
    expect(persisted).toHaveLength(1);
  });
});
