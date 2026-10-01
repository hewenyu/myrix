/**
 * R16 的策略投递链路：真实非 owner PostgreSQL → 真实 HTTP 响应 → Cell 侧真实解析
 * → 真实策略快照持有者。
 *
 * 为什么放在 BFF 测试里：这条链路的**权威端**是 BFF 的绑定快照端点，而它的安全属性
 * （只回本 Cell 租户、只回六个已知工具、不含正文与凭据、策略版本由部署控制）只有在
 * 真实 RLS + 真实凭据下才有意义。Cell 侧那一半用**插件源码**（相对路径导入）而不是
 * 复制品来跑，因此这里断言的确实是"Cell 会看到什么"。
 *
 * 真实的 Cordis 组合（执行点的 guard 与租约分属两个 fiber 仍共享同一份策略）在
 * `plugins/myrix-policy-enforcer/tests/composition.test.ts`，本文件不重复它。
 *
 * 只追加随机夹具到专用验收库；不删表、不改 owner 连接的角色。
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { authorizePlatform } from "@myrix/governance";
import type { PlatformIdentity } from "@myrix/contracts";
import { PlatformStore } from "../../../packages/platform-store/src/store";
import { createGovernanceAuthorizer } from "../../../packages/platform-store/src/authz";
import { migrateToLatest } from "../../../packages/platform-store/src/migrate";
import type { MigrationDatabase, PlatformDatabase } from "../../../packages/platform-store/src/schema";
import { parseSnapshot, toWireSnapshot } from "../../../plugins/myrix-binding-lease/src/index";
import { PolicySnapshotHolder } from "../../../plugins/myrix-policy-enforcer/src/index";
import { PRESET_TOOLS } from "../../../plugins/myrix-novel/src/protocol";
import { PostgresNovelRepository } from "../src/novel-store";
import { CellCredentialRegistry, createBindingSnapshotReader, createWorksExecutor, resolveSnapshotPolicy, type BindingSnapshotPolicy } from "../src/works-server";

const appUrl = process.env.BFF_TEST_DATABASE_URL;
const migrationUrl = process.env.BFF_TEST_MIGRATION_DATABASE_URL;
/** 与六个小说工具逐字一致；服务端只允许在这个集合里收窄。 */
const NOVEL_TOOL_NAMES = [...new Set(Object.values(PRESET_TOOLS).flat())];

describe.skipIf(!appUrl || !migrationUrl)("Cell policy snapshot over the real nonowner boundary", () => {
  const tenantId = randomUUID();
  const foreignTenantId = randomUUID();
  const ownerUserId = randomUUID();
  const foreignUserId = randomUUID();
  const cellId = "policy-cell";
  const token = `policy-cell-${randomUUID()}`;
  const otherCellToken = `policy-other-${randomUUID()}`;
  const novelSid = randomUUID();
  const outlineSid = randomUUID();
  let migration: Kysely<MigrationDatabase>;
  let db: Kysely<PlatformDatabase>;
  let store: PlatformStore;
  let workId: string;
  let foreignWorkId: string;
  let foreignSid: string;

  beforeAll(async () => {
    migration = new Kysely<MigrationDatabase>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: migrationUrl, max: 1 }) }) });
    db = new Kysely<PlatformDatabase>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: appUrl, max: 3 }) }) });
    await migrateToLatest(migration);
    await migration.insertInto("tenants").values([
      { id: tenantId, slug: `policy-${tenantId}`, name: "Policy snapshot A" },
      { id: foreignTenantId, slug: `policy-${foreignTenantId}`, name: "Policy snapshot B" },
    ]).execute();
    await migration.insertInto("members").values([
      { tenant_id: tenantId, user_id: ownerUserId, role: "member" as const, status: "active" as const, display_name: "作者" },
      { tenant_id: foreignTenantId, user_id: foreignUserId, role: "member" as const, status: "active" as const, display_name: "别租户作者" },
    ]).execute();
    store = new PlatformStore({ db, authorizer: createGovernanceAuthorizer({ authorizePlatform }) });
    const repository = new PostgresNovelRepository(store);
    const owner: PlatformIdentity = { tenantId, userId: ownerUserId, role: "member", displayName: "作者" };
    const foreign: PlatformIdentity = { tenantId: foreignTenantId, userId: foreignUserId, role: "member", displayName: "别租户作者" };
    workId = (await repository.createWork(owner, { title: "作品 A", description: "" })).id;
    foreignWorkId = (await repository.createWork(foreign, { title: "作品 B", description: "" })).id;
    foreignSid = randomUUID();
    await migration.insertInto("session_bindings").values([
      { tenant_id: tenantId, id: novelSid, owner_user_id: ownerUserId, work_id: workId, preset: "novel-chapter", policy_revision: "deploy-v1", cell_id: cellId, status: "active", revoked_revision: 3 },
      { tenant_id: tenantId, id: outlineSid, owner_user_id: ownerUserId, work_id: workId, preset: "novel-outline", policy_revision: "deploy-v1", cell_id: cellId, status: "active", revoked_revision: 3 },
      // 另一个 Cell 的同租户绑定：绝不能出现在本 Cell 的快照里。
      { tenant_id: tenantId, id: randomUUID(), owner_user_id: ownerUserId, work_id: workId, preset: "novel-bible", policy_revision: "deploy-v1", cell_id: "another-cell", status: "active", revoked_revision: 1 },
      { tenant_id: foreignTenantId, id: foreignSid, owner_user_id: foreignUserId, work_id: foreignWorkId, preset: "novel-chapter", policy_revision: "deploy-v1", cell_id: cellId, status: "active", revoked_revision: 1 },
    ]).execute();
  }, 30_000);
  afterAll(async () => { await db?.destroy(); await migration?.destroy(); });

  const registry = () => new CellCredentialRegistry([
    { tenantId, cellId, token },
    { tenantId: foreignTenantId, cellId: "another-cell", token: otherCellToken },
  ]);

  function reader(policy?: BindingSnapshotPolicy) {
    return createBindingSnapshotReader(store, registry(), policy);
  }

  it("omitting the third argument is explicit: the six binding fields travel but no policy does", async () => {
    const snapshot = await reader()(`Bearer ${token}`, cellId);
    expect(snapshot).not.toHaveProperty("policy");
    expect(Object.keys(snapshot).sort()).toEqual(["bindings", "cellId", "tenantId"]);
    const parsed = parseSnapshot(new TextEncoder().encode(JSON.stringify(snapshot)), { cellId, tenantId });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.snapshot.policy).toBeUndefined();
  });

  it("keeps the six binding fields byte-identical for old consumers", async () => {
    const snapshot = await reader()(`Bearer ${token}`, cellId);
    const row = snapshot.bindings.find(binding => binding.sid === novelSid);
    expect(row).toEqual({ sid: novelSid, tid: tenantId, sub: ownerUserId, wid: workId, preset: "novel-chapter", rev: 3 });
    expect(Object.keys(row!).sort()).toEqual(["preset", "rev", "sid", "sub", "tid", "wid"]);
  });

  it("emits only the intersection of the deployment tools and the six known novel tools", async () => {
    const policy = resolveSnapshotPolicy({ rev: 7, ttlMs: 10_000, tools: [...NOVEL_TOOL_NAMES] });
    const snapshot = await reader(policy)(`Bearer ${token}`, cellId);
    expect(snapshot.policy).toEqual({ rev: 7, ttlMs: 10_000, tools: NOVEL_TOOL_NAMES });
    // 策略里出现的名字只能是六个已知工具，且不重复。
    expect([...snapshot.policy!.tools].sort()).toEqual([...NOVEL_TOOL_NAMES].sort());
    expect(new Set(snapshot.policy!.tools).size).toBe(snapshot.policy!.tools.length);
  });

  it("an explicit empty tools array reaches the Cell unchanged: deny-all, not 'no policy'", async () => {
    const snapshot = await reader(resolveSnapshotPolicy({ rev: 1, ttlMs: 5_000, tools: [] }))(`Bearer ${token}`, cellId);
    expect(snapshot.policy?.tools).toEqual([]);
    const parsed = parseSnapshot(new TextEncoder().encode(JSON.stringify(snapshot)), { cellId, tenantId });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.snapshot.policy).toMatchObject({ rev: 1, tools: [] });
  });

  it("serves the policy only to the authenticated matching Cell, and never another tenant's rows", async () => {
    const policy = resolveSnapshotPolicy({ rev: 2, ttlMs: 10_000, tools: NOVEL_TOOL_NAMES });
    await expect(reader(policy)(undefined, cellId)).rejects.toMatchObject({ statusCode: 401 });
    await expect(reader(policy)(`Bearer ${token}`, "another-cell")).rejects.toMatchObject({ statusCode: 403 });
    const snapshot = await reader(policy)(`Bearer ${token}`, cellId);
    expect(snapshot.tenantId).toBe(tenantId);
    expect(snapshot.bindings.map(binding => binding.sid).sort()).toEqual([novelSid, outlineSid].sort());
    // 别的租户、别的 cell 的绑定都不在响应里；响应里也不含凭据或正文。
    expect(JSON.stringify(snapshot)).not.toContain(foreignSid);
    expect(JSON.stringify(snapshot)).not.toContain(token);
    expect(JSON.stringify(snapshot)).not.toContain("another-cell");
  });

  it("real response body → real Cell parser → real policy holder installs exactly the served intersection", async () => {
    const policy = resolveSnapshotPolicy({ rev: 11, ttlMs: 10_000, tools: ["get_outline", "search_bible"] });
    const snapshot = await reader(policy)(`Bearer ${token}`, cellId);
    const body = new TextEncoder().encode(JSON.stringify(snapshot));
    const parsed = parseSnapshot(body, { cellId, tenantId });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const holder = new PolicySnapshotHolder();
    // Cell 的剩余时长是"服务端 ttl、本地租约剩余、30 秒上限"的最小值再减去下载耗时。
    const outcome = holder.installOrClear(
      { rev: parsed.snapshot.policy!.rev, tid: tenantId, tools: parsed.snapshot.policy!.tools },
      { remainingMs: Math.min(parsed.snapshot.policy!.ttlMs, 10_000, 30_000) },
    );
    expect(outcome).toMatchObject({ installed: true, rev: 11 });
    expect(holder.current()).toMatchObject({ tid: tenantId, rev: 11, tools: ["get_outline", "search_bible"] });
    // 六个工具里未被服务端下发的仍然不允许（只收窄，不放宽）。
    expect(holder.current()?.tools).not.toContain("update_outline");
  });

  it("narrows a preset's tool set to the intersection, so the executor and the policy agree", async () => {
    // 服务端只允许 get_outline；novel-chapter preset 本来还有 get_chapter/save_chapter_draft/search_bible。
    const policy = resolveSnapshotPolicy({ rev: 3, ttlMs: 10_000, tools: ["get_outline"] });
    const snapshot = await reader(policy)(`Bearer ${token}`, cellId);
    const served = new Set(snapshot.policy!.tools);
    const presetTools = PRESET_TOOLS["novel-chapter"];
    const intersection = presetTools.filter(tool => served.has(tool));
    expect(intersection).toEqual(["get_outline"]);
    // 交集之外的 preset 工具即使 preset 允许也不能用：两个集合都必须包含。
    expect(presetTools.filter(tool => !served.has(tool)).length).toBeGreaterThan(0);
  });

  it("keeps policy rev deployment-controlled: binding revocation does not change it", async () => {
    const policy = resolveSnapshotPolicy({ rev: 42, ttlMs: 10_000, tools: ["get_outline"] });
    const before = await reader(policy)(`Bearer ${token}`, cellId);
    await migration.updateTable("session_bindings").set({ revoked_revision: 9 }).where("id", "=", outlineSid).execute();
    try {
      const after = await reader(policy)(`Bearer ${token}`, cellId);
      expect(after.policy).toEqual(before.policy);
      // 绑定修订确实前进了 —— 但它没有能力影响策略版本。
      expect(after.bindings.find(binding => binding.sid === outlineSid)?.rev).toBe(9);
      expect(before.bindings.find(binding => binding.sid === outlineSid)?.rev).toBe(3);
    } finally {
      await migration.updateTable("session_bindings").set({ revoked_revision: 3 }).where("id", "=", outlineSid).execute();
    }
  });

  it("shrinks the snapshot when a work is deleted, while the policy stays the same", async () => {
    const policy = resolveSnapshotPolicy({ rev: 5, ttlMs: 10_000, tools: NOVEL_TOOL_NAMES });
    expect((await reader(policy)(`Bearer ${token}`, cellId)).bindings).toHaveLength(2);
    await migration.updateTable("works").set({ status: "deleted" }).where("id", "=", workId).execute();
    try {
      const snapshot = await reader(policy)(`Bearer ${token}`, cellId);
      expect(snapshot.bindings).toEqual([]);
      // 策略仍在：撤销的是作品访问，不是策略发布。
      expect(snapshot.policy).toMatchObject({ rev: 5 });
    } finally {
      await migration.updateTable("works").set({ status: "active" }).where("id", "=", workId).execute();
    }
  });

  it("the executor still enforces the preset allowlist, so the policy cannot widen it", async () => {
    const execute = createWorksExecutor(store, registry());
    const snapshot = await reader(resolveSnapshotPolicy({ rev: 1, ttlMs: 10_000, tools: NOVEL_TOOL_NAMES }))(`Bearer ${token}`, cellId);
    // 服务端策略给了全部六个，但 novel-chapter 的 preset 不含 update_outline。
    expect(snapshot.policy!.tools).toContain("update_outline");
    expect(PRESET_TOOLS["novel-chapter"]).not.toContain("update_outline");
    await expect(execute(`Bearer ${token}`, novelSid, 3, "update_outline", { text: "x", expectedVersion: 0 }))
      .rejects.toMatchObject({ statusCode: 403, code: "tool_not_allowed" });
  });

  it("toWireSnapshot round-trips the optional policy without inventing one", async () => {
    const snapshot = await reader(resolveSnapshotPolicy({ rev: 8, ttlMs: 10_000, tools: [] }))(`Bearer ${token}`, cellId);
    const parsed = parseSnapshot(new TextEncoder().encode(JSON.stringify(snapshot)), { cellId, tenantId });
    if (!parsed.ok) throw new Error("应当解析成功");
    expect(toWireSnapshot(parsed.snapshot, { cellId, tenantId })).toMatchObject({ cellId, tenantId, policy: { rev: 8, tools: [] } });
    const plain = await reader()(`Bearer ${token}`, cellId);
    const plainParsed = parseSnapshot(new TextEncoder().encode(JSON.stringify(plain)), { cellId, tenantId });
    if (!plainParsed.ok) throw new Error("应当解析成功");
    expect(toWireSnapshot(plainParsed.snapshot, { cellId, tenantId })).not.toHaveProperty("policy");
  });
});
