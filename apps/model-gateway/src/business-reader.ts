import type { PlatformStore } from "@myrix/platform-store";
import type { BusinessReaders } from "./db/credentials";

/** Production business reads use the same nonowner RLS boundary as BFF repositories. */
export function createGatewayBusinessReaders(store: PlatformStore): BusinessReaders {
  return {
    loadSessionBinding(tenantId, sessionId) {
      return store.withTenant({ tenantId }, async tx => {
        const row = await tx.trx.selectFrom("session_bindings as b")
          .innerJoin("tenants as t", "t.id", "b.tenant_id")
          .innerJoin("works as w", join => join.onRef("w.tenant_id", "=", "b.tenant_id")
            .onRef("w.id", "=", "b.work_id").onRef("w.owner_user_id", "=", "b.owner_user_id"))
          .select(["b.id", "b.tenant_id", "b.owner_user_id", "b.cell_id", "b.status", "b.revoked_revision"])
          .where("b.id", "=", sessionId).where("t.status", "=", "active").where("w.status", "=", "active")
          .executeTakeFirst();
        if (!row) return undefined;
        return { sessionId: row.id, tenantId: row.tenant_id, ownerUserId: row.owner_user_id,
          cellId: row.cell_id, status: row.status, revision: row.revoked_revision };
      });
    },
    loadMember(tenantId, userId) {
      return store.withTenant({ tenantId, actorUserId: userId }, async tx => {
        const row = await tx.trx.selectFrom("members as m").innerJoin("tenants as t", "t.id", "m.tenant_id")
          .select(["m.tenant_id", "m.user_id", "m.role", "m.status"])
          .where("m.user_id", "=", userId).where("m.status", "=", "active").where("t.status", "=", "active")
          .executeTakeFirst();
        if (!row) return undefined;
        return { tenantId: row.tenant_id, userId: row.user_id, role: row.role, status: row.status };
      });
    },
  };
}
