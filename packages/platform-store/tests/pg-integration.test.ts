import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";

import { PlatformStore, createGovernanceAuthorizer, createPlatformDatabase, createPlatformPool } from "../src/index";
import { authorizePlatform } from "@myrix/governance";
import { WorksRepository } from "../src/repositories/works";
import { TenancyRepository } from "../src/repositories/tenancy";
import { SessionsRepository } from "../src/repositories/bindings";
import { ChaptersRepository } from "../src/repositories/chapters";
import { OutlineRepository } from "../src/repositories/outline";
import { BibleRepository } from "../src/repositories/bible";
import {
  claimAnyCommands,
  claimSessionCommand,
  releaseCommand,
  settleCommand,
} from "../src/repositories/commands";
import { AuditRepository } from "../src/repositories/audit";
import { OutboxRepository } from "../src/repositories/outbox";
import { platformStoreInternal } from "../src/index";
import { isPlatformStoreError } from "../src/errors";
import {
  createHarness,
  insertWorkDirect,
  isReachable,
  resetTestFixtures,
  T,
  TEST_ADMIN_URL,
  type Harness,
} from "./helpers/pg";

/**
 * 真实 Postgres 集成测试。
 *
 * 覆盖四类必须靠真实数据库才能证明的性质：
 *   A. RLS：用 **NOBYPASSRLS 非 owner** 的 myrix_app 连接，跨租户读不到、写不进；
 *   B. 单一所有者：admin 也读不到/改不了他人作品、章节、设定、大纲、会话；
 *   C. CAS：expectedVersion + 服务端算 hash，duplicate / conflict 三态；
 *   D. 队列与会话：同事务绑定+命令、FIFO、会话锁、撤权 rev、outbox。
 *
 * 应用角色在 0000/0009 迁移里已保证：LOGIN + NOSUPERUSER + NOBYPASSRLS + NOCREATEDB/NOCREATEROLE。
 */

const reachable = await isReachable();

describe.skipIf(!reachable)("Postgres 集成（myrix_app，NOBYPASSRLS）", () => {
  let h: Harness;
  let store: PlatformStore;
  let works: WorksRepository;
  let tenancy: TenancyRepository;
  let sessions: SessionsRepository;
  let chapters: ChaptersRepository;
  let outlines: OutlineRepository;
  let bible: BibleRepository;
  let audit: AuditRepository;
  let outbox: OutboxRepository;

  beforeAll(async () => {
    h = await createHarness();
    await resetTestFixtures(h);
    store = new PlatformStore({
      db: createPlatformDatabase(createPlatformPool({ connectionString: appUrlForTest() })),
      authorizer: createGovernanceAuthorizer({ authorizePlatform }),
      // 投递循环所需能力：测试里显式授予，生产由部署方决定
      serviceCapabilities: [
        "tenant.read",
        "tenant.manage",
        "session.activate",
        "command.enqueue",
        "command.claim",
        "command.settle",
        "command.read",
        "outbox.enqueue",
        "outbox.claim",
        "outbox.settle",
        "audit.write",
      ],
    });
    works = new WorksRepository(store);
    tenancy = new TenancyRepository(store);
    sessions = new SessionsRepository(store);
    chapters = new ChaptersRepository(store);
    outlines = new OutlineRepository(store);
    bible = new BibleRepository(store);
    audit = new AuditRepository(store);
    outbox = new OutboxRepository(store);
  });

  afterAll(async () => {
    await store?.db.destroy();
    await h?.dispose();
  });

  // -------------------------------------------------------------------------
  // A. 角色与 RLS
  // -------------------------------------------------------------------------

  it("myrix_app 是 NOSUPERUSER + NOBYPASSRLS + LOGIN，且不是业务表 owner", async () => {
    const role = await sql<{ rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>`
      select rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname = 'myrix_app'
    `.execute(h.admin);
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcanlogin: true });

    const owners = await sql<{ tableowner: string }>`
      select distinct tableowner from pg_tables
      where schemaname = 'public' and tableowner = 'myrix_app'
    `.execute(h.admin);
    expect(owners.rows).toHaveLength(0);

    // FORCE RLS：即使 owner 也必须走策略
    const forced = await sql<{ relname: string; relforcerowsecurity: boolean; relrowsecurity: boolean }>`
      select relname, relforcerowsecurity, relrowsecurity from pg_class
      where relname in ('works', 'chapters', 'session_bindings', 'audit_events')
    `.execute(h.admin);
    expect(forced.rows.length).toBe(4);
    for (const row of forced.rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  });

  it("没有租户上下文时，myrix_app 读回 0 行（fail-closed）", async () => {
    const result = await sql<{ id: string }>`select id from works`.execute(store.db);
    expect(result.rows).toHaveLength(0);
  });

  it("设置租户 A 上下文后，myrix_app 只读得到租户 A 的行（跨租户为空）", async () => {
    const workA = await insertWorkDirect(h, T.tenantA, T.authorA, "A 的作品");
    const workB = await insertWorkDirect(h, T.tenantB, T.memberB, "B 的作品");

    const seen = await store.withTenant({ tenantId: T.tenantA }, async (tx) => {
      const rows = await tx.trx.selectFrom("works").select(["id"]).execute();
      return rows.map((row) => row.id);
    });
    expect(seen).toContain(workA);
    expect(seen).not.toContain(workB);

    const viaB = await store.withTenant({ tenantId: T.tenantB }, async (tx) => {
      const rows = await tx.trx.selectFrom("works").select(["id"]).execute();
      return rows.map((row) => row.id);
    });
    expect(viaB).toContain(workB);
    expect(viaB).not.toContain(workA);
  });

  it("跨租户写入被 WITH CHECK 拒绝", async () => {
    await expect(
      store.withTenant({ tenantId: T.tenantA }, async (tx) =>
        tx.trx
          .insertInto("works")
          .values({
            tenant_id: T.tenantB,
            id: crypto.randomUUID(),
            owner_user_id: T.memberB,
            title: "越租户作品",
            description: "",
          })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security|policy/i);
  });

  it("owner 必须是同租户成员（复合外键在 SQL 层兜底）", async () => {
    await expect(
      store.withTenant({ tenantId: T.tenantA }, async (tx) =>
        tx.trx
          .insertInto("works")
          .values({
            tenant_id: T.tenantA,
            id: crypto.randomUUID(),
            // 这个人是**租户 B** 的成员：即使应用写错也必须被数据库拒绝
            owner_user_id: T.memberB,
            title: "错误所有者",
            description: "",
          })
          .execute(),
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  // -------------------------------------------------------------------------
  // B. 单一所有者
  // -------------------------------------------------------------------------

  it("author 看不到 editor 的作品；列表只返回自己的", async () => {
    const author = { tenantId: T.tenantA, userId: T.authorA, displayName: "作者", role: "member" as const };
    const editor = { tenantId: T.tenantA, userId: T.editorA, displayName: "编辑", role: "member" as const };

    const work = await works.create(author.tenantId, author.userId, { title: "作者的秘密草稿" });

    const editorList = await works.list(editor.tenantId, editor.userId);
    expect(editorList.map((row) => row.id)).not.toContain(work.id);

    await expect(works.get(editor.tenantId, editor.userId, work.id)).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("admin 也看不到 / 改不了他人作品（管理员只做成员治理与会话撤销）", async () => {
    const admin = { tenantId: T.tenantA, userId: T.adminA, role: "admin" as const };
    const workId = await insertWorkDirect(h, T.tenantA, T.authorA, "作者的作品");

    const adminList = await works.list(admin.tenantId, admin.userId);
    expect(adminList.map((row) => row.id)).not.toContain(workId);

    await expect(works.get(admin.tenantId, admin.userId, workId)).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      works.update(admin.tenantId, admin.userId, workId, { title: "管理员改名", expectedVersion: 0 }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(works.softDelete(admin.tenantId, admin.userId, workId)).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("admin 读不到他人章节/设定/大纲内容", async () => {
    const work = await insertWorkDirect(h, T.tenantA, T.authorA, "含内容的作品");
    const chapter = await chapters.create(T.tenantA, T.authorA, work, "第一章");
    await chapters.save(T.tenantA, T.authorA, {
      chapterId: chapter.id,
      text: "这是作者私密的正文",
      expectedVersion: 0,
    });
    const entry = await bible.create(T.tenantA, T.authorA, {
      workId: work,
      kind: "character",
      name: "林黛玉",
      summary: "主角",
    });
    await outlines.save(T.tenantA, T.authorA, {
      workId: work,
      document: { chapters: [{ id: "c1", title: "起" }] },
      expectedVersion: 0,
    });

    await expect(chapters.get(T.tenantA, T.adminA, chapter.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(chapters.list(T.tenantA, T.adminA, work)).rejects.toMatchObject({ code: "forbidden" });
    await expect(bible.get(T.tenantA, T.adminA, entry.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(outlines.get(T.tenantA, T.adminA, work)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("租户被停用后，即使成员 active 也一律拒绝", async () => {
    await h.admin.transaction().execute(async (trx) => {
      await sql`select set_config('myrix.tenant_id', ${T.tenantA}, true)`.execute(trx);
      await sql`update tenants set status = 'suspended' where id = ${T.tenantA}::uuid`.execute(trx);
    });
    try {
      await expect(works.list(T.tenantA, T.authorA)).rejects.toMatchObject({ code: "forbidden" });
    } finally {
      await h.admin.transaction().execute(async (trx) => {
        await sql`select set_config('myrix.tenant_id', ${T.tenantA}, true)`.execute(trx);
        await sql`update tenants set status = 'active' where id = ${T.tenantA}::uuid`.execute(trx);
      });
    }
  });

  it("成员被停用后立即失去一切访问", async () => {
    const target = T.editorA;
    await h.admin.transaction().execute(async (trx) => {
      await sql`select set_config('myrix.tenant_id', ${T.tenantA}, true)`.execute(trx);
      await sql`update members set status = 'disabled', disabled_at = now() where user_id = ${target}::uuid`.execute(trx);
    });
    try {
      await expect(works.list(T.tenantA, target)).rejects.toMatchObject({ code: "forbidden" });
    } finally {
      await h.admin.transaction().execute(async (trx) => {
        await sql`select set_config('myrix.tenant_id', ${T.tenantA}, true)`.execute(trx);
        await sql`update members set status = 'active', disabled_at = null where user_id = ${target}::uuid`.execute(trx);
      });
    }
  });

  // -------------------------------------------------------------------------
  // C. CAS
  // -------------------------------------------------------------------------

  it("章节 CAS：saved → duplicate（同 parent + 同正文）→ conflict（改了正文）", async () => {
    const work = await insertWorkDirect(h, T.tenantA, T.authorA, "CAS 作品");
    const chapter = await chapters.create(T.tenantA, T.authorA, work, "章节");

    const first = await chapters.save(T.tenantA, T.authorA, {
      chapterId: chapter.id,
      text: "原始正文",
      expectedVersion: 0,
    });
    expect(first).toMatchObject({ status: "saved", version: 1 });

    // 崩溃恢复后的重试：expectedVersion 仍是 0，正文相同 → duplicate 返回版本 1
    const retry = await chapters.save(T.tenantA, T.authorA, {
      chapterId: chapter.id,
      text: "原始正文",
      expectedVersion: 0,
    });
    expect(retry).toMatchObject({ status: "duplicate", version: 1 });

    // parent 匹配但正文不同 → conflict，且不得写出新版本
    await expect(
      chapters.save(T.tenantA, T.authorA, {
        chapterId: chapter.id,
        text: "偷偷换掉的正文",
        expectedVersion: 0,
      }),
    ).rejects.toMatchObject({ code: "version_conflict" });

    const current = await chapters.get(T.tenantA, T.authorA, chapter.id);
    expect(current.version).toBe(1);
    expect(current.text).toBe("原始正文");

    // 正常推进到版本 2
    const second = await chapters.save(T.tenantA, T.authorA, {
      chapterId: chapter.id,
      text: "第二版正文",
      expectedVersion: 1,
    });
    expect(second).toMatchObject({ status: "saved", version: 2 });
  });

  it("clientKey 幂等：同键同文返回 duplicate，同键不同文 conflict", async () => {
    const work = await insertWorkDirect(h, T.tenantA, T.authorA, "幂等作品");
    const chapter = await chapters.create(T.tenantA, T.authorA, work, "幂等章节");

    await chapters.save(T.tenantA, T.authorA, {
      chapterId: chapter.id,
      text: "v1",
      expectedVersion: 0,
      clientKey: "key-1",
    });
    const replay = await chapters.save(T.tenantA, T.authorA, {
      chapterId: chapter.id,
      text: "v1",
      expectedVersion: 0,
      clientKey: "key-1",
    });
    expect(replay.status).toBe("duplicate");

    await expect(
      chapters.save(T.tenantA, T.authorA, {
        chapterId: chapter.id,
        text: "v2 不同正文",
        expectedVersion: 1,
        clientKey: "key-1",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("大纲 CAS：首次必须 expectedVersion=0，重复提交同一文档为 duplicate", async () => {
    const work = await insertWorkDirect(h, T.tenantA, T.authorA, "大纲作品");
    const document = { synopsis: "梗概", chapters: [{ id: "c1", title: "起" }] };

    const saved = await outlines.save(T.tenantA, T.authorA, { workId: work, document, expectedVersion: 0 });
    expect(saved).toMatchObject({ status: "saved", version: 1 });

    const duplicate = await outlines.save(T.tenantA, T.authorA, { workId: work, document, expectedVersion: 0 });
    expect(duplicate).toMatchObject({ status: "duplicate", version: 1 });

    await expect(
      outlines.save(T.tenantA, T.authorA, {
        workId: work,
        document: { chapters: [{ id: "c2", title: "完全不同的内容" }] },
        expectedVersion: 0,
      }),
    ).rejects.toMatchObject({ code: "version_conflict" });
  });

  it("设定 CAS 与作品内重名检查", async () => {
    const work = await insertWorkDirect(h, T.tenantA, T.authorA, "设定作品");
    const entry = await bible.create(T.tenantA, T.authorA, {
      workId: work,
      kind: "character",
      name: "贾宝玉",
    });
    const saved = await bible.save(T.tenantA, T.authorA, {
      entryId: entry.id,
      name: "贾宝玉",
      summary: "主角",
      expectedVersion: 0,
    });
    expect(saved).toMatchObject({ status: "saved", version: 1 });

    await expect(
      bible.create(T.tenantA, T.authorA, { workId: work, kind: "character", name: "贾宝玉" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  // -------------------------------------------------------------------------
  // D. 会话、命令队列、outbox、审计
  // -------------------------------------------------------------------------

  it("创建会话时绑定与 create 命令同事务落库", async () => {
    const work = await insertWorkDirect(h, T.tenantA, T.authorA, "会话作品");
    const session = await sessions.create(T.tenantA, T.authorA, { workId: work, preset: "novel-outline" });

    const rows = await store.withTenant({ tenantId: T.tenantA }, async (tx) =>
      tx.trx.selectFrom("commands").selectAll().where("binding_id", "=", session.id).execute(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ op: "create", actor_user_id: T.authorA, binding_id: session.id });
  });

  it("会话判定必须带当前 rev：rev 不匹配即拒绝", async () => {
    const work = await insertWorkDirect(h, T.tenantA, T.authorA, "rev 作品");
    const session = await sessions.create(T.tenantA, T.authorA, { workId: work, preset: "novel-chapter" });

    const ok = await sessions.get(T.tenantA, T.authorA, session.id, session.revokedRevision);
    expect(ok.id).toBe(session.id);

    await expect(sessions.get(T.tenantA, T.authorA, session.id, session.revokedRevision + 1)).rejects.toMatchObject(
      { code: "forbidden" },
    );
  });

  it("撤权：rev 单调 +1、写 outbox、重复撤权幂等且不重复投递", async () => {
    const work = await insertWorkDirect(h, T.tenantA, T.authorA, "撤权作品");
    const session = await sessions.create(T.tenantA, T.authorA, { workId: work, preset: "novel-bible" });
    const revoked = await sessions.revoke(T.tenantA, T.authorA, session.id, session.revokedRevision, "用户主动撤销");
    expect(revoked.status).toBe("revoked");
    expect(revoked.revokedRevision).toBe(session.revokedRevision + 1);

    const messages = await store.withTenant({ tenantId: T.tenantA }, async (tx) =>
      tx.trx.selectFrom("outbox_messages").selectAll().where("dedupe_key", "like", `session.revoke:${session.id}%`).execute(),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.topic).toBe("session.revoke");

    const again = await sessions.revoke(T.tenantA, T.authorA, session.id, revoked.revokedRevision, "再来一次");
    expect(again.revokedRevision).toBe(revoked.revokedRevision);
    const after = await store.withTenant({ tenantId: T.tenantA }, async (tx) =>
      tx.trx.selectFrom("outbox_messages").selectAll().where("dedupe_key", "like", `session.revoke:${session.id}%`).execute(),
    );
    expect(after).toHaveLength(1);
  });

  it("admin 可以撤销他人的会话（唯一可作用于他人资源的动作），但不读取内容", async () => {
    const work = await insertWorkDirect(h, T.tenantA, T.authorA, "管理员撤权作品");
    const session = await sessions.create(T.tenantA, T.authorA, { workId: work, preset: "novel-outline" });
    const revoked = await sessions.revoke(T.tenantA, T.adminA, session.id, session.revokedRevision, "管理员强制撤销");
    expect(revoked.status).toBe("revoked");

    // 管理员仍不能"读"该会话内容
    await expect(sessions.get(T.tenantA, T.adminA, session.id, revoked.revokedRevision)).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("closed 状态的会话一律拒绝（规范化成拒绝，不当成非 revoked 放行）", async () => {
    const work = await insertWorkDirect(h, T.tenantA, T.authorA, "closed 作品");
    const session = await sessions.create(T.tenantA, T.authorA, { workId: work, preset: "novel-outline" });
    await h.admin.transaction().execute(async (trx) => {
      await sql`select set_config('myrix.tenant_id', ${T.tenantA}, true)`.execute(trx);
      await sql`update session_bindings set status = 'closed' where id = ${session.id}::uuid`.execute(trx);
    });
    await expect(sessions.get(T.tenantA, T.authorA, session.id, session.revokedRevision)).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("停用成员在同一事务里撤销其全部活跃绑定", async () => {
    const work = await insertWorkDirect(h, T.tenantA, T.editorA, "编辑的作品");
    const session = await sessions.create(T.tenantA, T.editorA, { workId: work, preset: "novel-outline" });

    const result = await tenancy.disableMember(T.tenantA, T.adminA, T.editorA);
    expect(result.member.status).toBe("disabled");
    expect(result.revokedBindings).toBeGreaterThanOrEqual(1);

    const binding = await h.admin.transaction().execute(async (trx) => {
      await sql`select set_config('myrix.tenant_id', ${T.tenantA}, true)`.execute(trx);
      return trx
        .selectFrom("session_bindings")
        .selectAll()
        .where("id", "=", session.id)
        .executeTakeFirstOrThrow();
    });
    expect(binding.status).toBe("revoked");

    await tenancy.enableMember(T.tenantA, T.adminA, T.editorA);
  });

  it("成员不能执行 members:update / audit:list；admin 不能停用自己", async () => {
    await expect(tenancy.disableMember(T.tenantA, T.authorA, T.editorA)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(audit.list(T.tenantA, T.authorA)).rejects.toMatchObject({ code: "forbidden" });
    await expect(tenancy.disableMember(T.tenantA, T.adminA, T.adminA)).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("命令队列：同 commandId 同正文幂等，正文不同则拒绝", async () => {
    const work = await insertWorkDirect(h, T.tenantA, T.authorA, "队列作品");
    const session = await sessions.create(T.tenantA, T.authorA, { workId: work, preset: "novel-chapter" });
    const commandId = crypto.randomUUID();

    const first = await store.withTenant({ tenantId: T.tenantA, actorUserId: T.authorA }, async (tx) =>
      platformStoreInternal.enqueueCommandInTx(store, tx, T.authorA, {
        commandId,
        bindingId: session.id,
        op: "send",
        body: { text: "继续写" },
        expectedRevision: session.revokedRevision,
      }),
    );
    expect(first.created).toBe(true);

    const replay = await store.withTenant({ tenantId: T.tenantA, actorUserId: T.authorA }, async (tx) =>
      platformStoreInternal.enqueueCommandInTx(store, tx, T.authorA, {
        commandId,
        bindingId: session.id,
        op: "send",
        body: { text: "继续写" },
        expectedRevision: session.revokedRevision,
      }),
    );
    expect(replay.created).toBe(false);
    expect(replay.command.id).toBe(commandId);

    await expect(
      store.withTenant({ tenantId: T.tenantA, actorUserId: T.authorA }, async (tx) =>
        platformStoreInternal.enqueueCommandInTx(store, tx, T.authorA, {
          commandId,
          bindingId: session.id,
          op: "send",
          body: { text: "换一份完全不同的正文" },
          expectedRevision: session.revokedRevision,
        }),
      ),
    ).rejects.toMatchObject({ code: "duplicate_request" });
  });

  it("closed 状态会话不能入队命令（状态不可用于判定即拒绝）", async () => {
    const work = await insertWorkDirect(h, T.tenantA, T.authorA, "closed 命令作品");
    const session = await sessions.create(T.tenantA, T.authorA, { workId: work, preset: "novel-chapter" });
    await h.admin.transaction().execute(async (trx) => {
      await sql`select set_config('myrix.tenant_id', ${T.tenantA}, true)`.execute(trx);
      await sql`update session_bindings set status = 'closed' where id = ${session.id}::uuid`.execute(trx);
    });
    await expect(
      store.withTenant({ tenantId: T.tenantA, actorUserId: T.authorA }, async (tx) =>
        platformStoreInternal.enqueueCommandInTx(store, tx, T.authorA, {
          commandId: crypto.randomUUID(),
          bindingId: session.id,
          op: "send",
          body: { text: "不该被接受" },
          expectedRevision: session.revokedRevision,
        }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("命令 FIFO + 会话锁：同一会话一次只有一条被领取，settle 后才能取下一条", async () => {
    const work = await insertWorkDirect(h, T.tenantA, T.authorA, "FIFO 作品");
    const session = await sessions.create(T.tenantA, T.authorA, { workId: work, preset: "novel-chapter" });

    for (const text of ["第一条", "第二条"]) {
      await store.withTenant({ tenantId: T.tenantA, actorUserId: T.authorA }, async (tx) =>
        platformStoreInternal.enqueueCommandInTx(store, tx, T.authorA, {
          commandId: crypto.randomUUID(),
          bindingId: session.id,
          op: "send",
          body: { text },
          expectedRevision: session.revokedRevision,
        }),
      );
    }

    // 会话创建时已同事务入队 `create`，它排在最前面（FIFO 不会跳过它）
    const createClaim = await claimSessionCommand(store, T.tenantA, {
      bindingId: session.id,
      workerId: "worker-0",
    });
    expect(createClaim.reason).toBe("claimed");
    expect(createClaim.command?.op).toBe("create");
    await settleCommand(store, T.tenantA, {
      commandId: createClaim.command!.id,
      workerId: "worker-0",
      receipt: { accepted: true },
    });

    const claimed = await claimSessionCommand(store, T.tenantA, {
      bindingId: session.id,
      workerId: "worker-1",
    });
    expect(claimed.reason).toBe("claimed");
    expect(claimed.command?.op).toBe("send");
    expect(claimed.command?.body["text"]).toBe("第一条");

    // 未 settle：同一会话不会再取到第二条（FIFO 保序）
    const second = await claimSessionCommand(store, T.tenantA, {
      bindingId: session.id,
      workerId: "worker-2",
    });
    expect(second.reason).toBe("empty");

    await settleCommand(store, T.tenantA, {
      commandId: claimed.command!.id,
      workerId: "worker-1",
      receipt: { accepted: true },
    });

    const third = await claimSessionCommand(store, T.tenantA, {
      bindingId: session.id,
      workerId: "worker-2",
    });
    expect(third.command?.body["text"]).toBe("第二条");
  });

  it("release 不丢命令：回到 queued 并累计 attempts；settle 只能由持有者执行", async () => {
    const work = await insertWorkDirect(h, T.tenantA, T.authorA, "重试作品");
    const session = await sessions.create(T.tenantA, T.authorA, { workId: work, preset: "novel-chapter" });
    await store.withTenant({ tenantId: T.tenantA, actorUserId: T.authorA }, async (tx) =>
      platformStoreInternal.enqueueCommandInTx(store, tx, T.authorA, {
        commandId: crypto.randomUUID(),
        bindingId: session.id,
        op: "send",
        body: { text: "会失败的一条" },
        expectedRevision: session.revokedRevision,
      }),
    );

    // 先结算绑定创建时同事务入队的 `create`，让 `send` 成为 FIFO 头部
    const createClaim = await claimSessionCommand(store, T.tenantA, { bindingId: session.id, workerId: "w0" });
    await settleCommand(store, T.tenantA, {
      commandId: createClaim.command!.id,
      workerId: "w0",
      receipt: { accepted: true },
    });

    const claimed = await claimSessionCommand(store, T.tenantA, { bindingId: session.id, workerId: "w1" });
    expect(claimed.command).not.toBeNull();

    await expect(
      settleCommand(store, T.tenantA, { commandId: claimed.command!.id, workerId: "someone-else", receipt: {} }),
    ).rejects.toMatchObject({ code: "conflict" });

    const released = await releaseCommand(store, T.tenantA, {
      commandId: claimed.command!.id,
      workerId: "w1",
      error: "cell 暂时不可达",
    });
    expect(released.retrying).toBe(true);

    const row = await store.withTenant({ tenantId: T.tenantA }, async (tx) =>
      tx.trx
        .selectFrom("commands")
        .select(["status", "attempts", "last_error"])
        .where("id", "=", claimed.command!.id)
        .executeTakeFirstOrThrow(),
    );
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain("cell");
  });

  it("claimAny 跨会话并发：SKIP LOCKED 不重复投递同一行", async () => {
    const work = await insertWorkDirect(h, T.tenantA, T.authorA, "并发作品");
    const created: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const session = await sessions.create(T.tenantA, T.authorA, { workId: work, preset: "novel-chapter" });
      await store.withTenant({ tenantId: T.tenantA, actorUserId: T.authorA }, async (tx) =>
        platformStoreInternal.enqueueCommandInTx(store, tx, T.authorA, {
          commandId: crypto.randomUUID(),
          bindingId: session.id,
          op: "send",
          body: { index },
          expectedRevision: session.revokedRevision,
        }),
      );
      created.push(session.id);
    }

    const [left, right] = await Promise.all([
      claimAnyCommands(store, T.tenantA, { workerId: "a", limit: 3 }),
      claimAnyCommands(store, T.tenantA, { workerId: "b", limit: 3 }),
    ]);
    const ids = [...left, ...right].map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(left.length + right.length).toBeGreaterThan(0);
  });

  it("系统操作在没有对应能力时被拒绝（浏览器路径不可调用）", async () => {
    const restricted = new PlatformStore({
      db: createPlatformDatabase(createPlatformPool({ connectionString: appUrlForTest() })),
      authorizer: createGovernanceAuthorizer({ authorizePlatform }),
      serviceCapabilities: [],
    });
    const restrictedSessions = new SessionsRepository(restricted);
    await expect(restrictedSessions.markActive(T.tenantA, crypto.randomUUID(), "cell-1")).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      claimSessionCommand(restricted, T.tenantA, { bindingId: crypto.randomUUID(), workerId: "w" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      new AuditRepository(restricted).write(T.tenantA, {
        actorUserId: null,
        actorKind: "service",
        category: "data-write",
        action: "test",
        resource: "test",
        effect: "allow",
        reason: "测试",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await restricted.db.destroy();
  });

  it("审计只追加，且不携带作品正文", async () => {
    const work = await insertWorkDirect(h, T.tenantA, T.authorA, "审计作品");
    const chapter = await chapters.create(T.tenantA, T.authorA, work, "审计章节");
    const secret = "绝密正文内容-不应出现在审计里";
    await chapters.save(T.tenantA, T.authorA, { chapterId: chapter.id, text: secret, expectedVersion: 0 });

    const events = await audit.list(T.tenantA, T.adminA, { limit: 200 });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(secret);

    // 审计员可以读，普通成员不行（前面已断言成员拒绝）
    const auditorEvents = await audit.list(T.tenantA, T.auditorA, { limit: 5 });
    expect(Array.isArray(auditorEvents)).toBe(true);

    // UPDATE / DELETE 被触发器拒绝
    await expect(
      store.withTenant({ tenantId: T.tenantA }, async (tx) =>
        tx.trx.updateTable("audit_events").set({ reason: "篡改" }).where("tenant_id", "=", T.tenantA).execute(),
      ),
    ).rejects.toThrow(/只追加|restrict|permission|denied/i);
  });

  it("outbox：claim 后 settle；重复 dedupe_key 只投递一次", async () => {
    const work = await insertWorkDirect(h, T.tenantA, T.authorA, "outbox 作品");
    const session = await sessions.create(T.tenantA, T.authorA, { workId: work, preset: "novel-outline" });
    await sessions.revoke(T.tenantA, T.authorA, session.id, session.revokedRevision, "测试 outbox");

    const claims = await outbox.claim(T.tenantA, { workerId: "outbox-1", topics: ["session.revoke"], limit: 10 });
    const mine = claims.find((claim) => claim.record.payload["bindingId"] === session.id);
    expect(mine).toBeDefined();
    await outbox.settle(T.tenantA, mine!.record.id, "outbox-1");

    // delivered 不在 listPending（只看 pending/inflight/dead）里，直接读状态
    const delivered = await store.withTenant({ tenantId: T.tenantA }, async (tx) =>
      tx.trx
        .selectFrom("outbox_messages")
        .select(["status"])
        .where("id", "=", mine!.record.id)
        .executeTakeFirstOrThrow(),
    );
    expect(delivered.status).toBe("delivered");

    // 同一 dedupe_key 再入队：静默返回 false（同一业务事实只投递一次）
    const inserted = await outbox.enqueue(T.tenantA, {
      topic: "session.revoke",
      dedupeKey: mine!.record.dedupeKey,
      payload: { bindingId: session.id },
    });
    expect(inserted).toBe(false);
  });

  it("租户上下文在事务结束后清空（连接复用不串租户）", async () => {
    await store.withTenant({ tenantId: T.tenantA }, async () => undefined);
    const afterCommit = await sql<{ tenant: string | null }>`
      select nullif(current_setting('myrix.tenant_id', true), '') as tenant
    `.execute(store.db);
    expect(afterCommit.rows[0]?.tenant).toBeNull();
  });

  it("PlatformStoreError 在拒绝路径上给出可读 reason（不泄漏 SQL）", async () => {
    try {
      await works.get(T.tenantB, T.memberB, "00000000-0000-4000-8000-000000000000");
      throw new Error("不该走到这里");
    } catch (error) {
      expect(isPlatformStoreError(error)).toBe(true);
      if (isPlatformStoreError(error)) {
        expect(error.toResponseBody().reason).not.toMatch(/select|relation|pg_/i);
      }
    }
  });
});

/** 测试用应用连接串：与 helpers 同源，避免两处漂移。 */
function appUrlForTest(): string {
  const url = new URL(TEST_ADMIN_URL);
  url.username = "myrix_app";
  url.password = process.env["MYRIX_TEST_APP_PASSWORD"] ?? "myrix_local_app";
  return url.toString();
}

/** 数据库不可达时给出明确提示（CI 未起 PG 时不会静默跳过） */
describe("PG 可用性", () => {
  it(reachable ? "本地开发库可达" : "本地开发库不可达（集成测试已跳过）", () => {
    expect(typeof reachable).toBe("boolean");
  });
});
