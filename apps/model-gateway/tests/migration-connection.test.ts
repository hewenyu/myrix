import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../src/db/migrate";
import type { GatewayMigrationDatabase } from "../src/db/schema";

/** Deterministic pool seam: each connect() leases a different physical-session identity. */
function rotatingPool(failDdl = false) {
  const statements: { connection: number; sql: string }[] = [];
  let leases = 0;
  let releases = 0;
  const locks = new Set<number>();
  const pool = {
    async connect() {
      const connection = ++leases;
      return {
        async query(text: string) {
          statements.push({ connection, sql: text });
          if (text.includes("pg_advisory_lock(")) locks.add(connection);
          if (text.includes("pg_advisory_unlock(")) {
            const unlocked = locks.delete(connection);
            return { command: "SELECT", rowCount: 1, rows: [{ pg_advisory_unlock: unlocked }] };
          }
          if (failDdl && text.includes("create schema if not exists")) throw new Error("injected migration DDL failure");
          return { command: "SELECT", rowCount: 0, rows: [] };
        },
        release() { releases++; },
      };
    },
    async end() {},
  } as unknown as PostgresPool;
  const db = new Kysely<GatewayMigrationDatabase>({ dialect: new PostgresDialect({ pool }) });
  return { db, statements, locks, counts: () => ({ leases, releases }) };
}

describe("gateway migration session advisory lock lifetime", () => {
  it("pins lock, DDL, each migration transaction and unlock to one leased connection", async () => {
    const fixture = rotatingPool();
    try {
      const result = await migrateToLatest(fixture.db);
      expect(result.applied.length).toBeGreaterThan(0);
      expect(new Set(fixture.statements.map(s => s.connection)).size).toBe(1);
      expect(fixture.counts()).toEqual({ leases: 1, releases: 1 });
      expect(fixture.statements.some(s => s.sql === "begin")).toBe(true);
      expect(fixture.statements.some(s => s.sql === "commit")).toBe(true);
      expect(fixture.statements.at(-1)?.sql).toContain("pg_advisory_unlock");
      expect(fixture.locks.size).toBe(0);
    } finally { await fixture.db.destroy(); }
  });
  it("also unlocks on the owning connection when DDL throws", async () => {
    const fixture = rotatingPool(true);
    try {
      await expect(migrateToLatest(fixture.db)).rejects.toThrow("injected migration DDL failure");
      expect(fixture.counts()).toEqual({ leases: 1, releases: 1 });
      expect(fixture.statements.at(-1)?.sql).toContain("pg_advisory_unlock");
      expect(fixture.locks.size).toBe(0);
    } finally { await fixture.db.destroy(); }
  });
});
