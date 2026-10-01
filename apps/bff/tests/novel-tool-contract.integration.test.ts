/**
 * 小说工具输出契约的**真实链路集成测试**。
 *
 * 链路：真实非 owner PostgreSQL → `PostgresNovelRepository`（返回存储层记录）
 *       → 真实 `createWorksExecutor`/`createWorksServer`（真实 Fastify 请求管线）
 *       → 真实 `NovelStoreClient`（真实 `fetch`，仅把传输接到进程内 `inject`）
 *       → 真实 DSH `ToolRuntime`（`ctx.tools.execute()` → 真实
 *         `validateJsonSchemaValue(output.schema, …)`）。
 *
 * 为什么必须这样测：2026-10-01 的真实浏览器 + 上游 Responses 链路里，
 * `update_outline` 在**已经落库**之后被 DSH 判为 `INVALID_TOOL_OUTPUT`：
 *
 * ```
 * "value.contentHash" is not a declared property (additionalProperties: false);
 * "value.updatedAt" is not a declared property (additionalProperties: false);
 * "value.reason" is not a declared property (additionalProperties: false)
 * ```
 *
 * 证据：`data/cells/cell-dev-1/sessions/_no-cwd/4df0b31b-…/session.v4.jsonl` 第 17 行。
 * 旧测试只用手写替身返回"刚好符合 schema"的理想值，因此**漏掉了真实 executor 返回**。
 * 本文件刻意让替身/夹具走真实仓储与真实 executor，并把真实返回喂进真实校验器；
 * 任何"服务端多返回内部字段"都会在这里变成 `isError`，而不是被悄悄回显给模型。
 *
 * 只追加随机夹具到专用验收库；不删表、不改 owner 连接的角色、不碰业务 dev DB。
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { authorizePlatform } from "@myrix/governance";
import type { PlatformIdentity } from "@myrix/contracts";
import { PlatformStore } from "../../../packages/platform-store/src/store";
import { createGovernanceAuthorizer } from "../../../packages/platform-store/src/authz";
import { migrateToLatest } from "../../../packages/platform-store/src/migrate";
import type { MigrationDatabase, PlatformDatabase } from "../../../packages/platform-store/src/schema";
import { PostgresNovelRepository } from "../src/novel-store";
import { CellCredentialRegistry, createWorksExecutor, createWorksServer } from "../src/works-server";
import { apply as applyNovel } from "../../../plugins/myrix-novel/src/index.ts";
import { NOVEL_TOOLS, PRESET_TOOLS, type NovelToolName } from "../../../plugins/myrix-novel/src/protocol.ts";
import { OUTPUT_SCHEMAS } from "../../../plugins/myrix-novel/src/output.ts";
import { createNovelHarness, type NovelHarness } from "../../../plugins/myrix-novel/tests/harness.ts";

const appUrl = process.env.BFF_TEST_DATABASE_URL;
const migrationUrl = process.env.BFF_TEST_MIGRATION_DATABASE_URL;

/** 三个 preset 各一个会话，便于按掩码调用所有六个工具。 */
const PRESETS = ["novel-outline", "novel-chapter", "novel-bible"] as const;
type PresetName = (typeof PRESETS)[number];

describe.skipIf(!appUrl || !migrationUrl)("novel tool output contract over the real executor", () => {
  const tenantId = randomUUID();
  const owner: PlatformIdentity = { tenantId, userId: randomUUID(), role: "member", displayName: "作者" };
  const cellId = "contract-cell";
  const token = `contract-cell-${randomUUID()}`;
  /** principal.rev 必须等于绑定的 revoked_revision，否则 governance 会按拒绝处理。 */
  const REV = 1;

  let migration: Kysely<MigrationDatabase>;
  let db: Kysely<PlatformDatabase>;
  let store: PlatformStore;
  let repository: PostgresNovelRepository;
  let worksApp: FastifyInstance;
  let harness: NovelHarness | undefined;
  let workId: string;
  let chapterId: string;
  let bibleEntryId: string;
  /** preset → 已绑定真实身份的 Agent（真实 ToolRuntime 作用域）。 */
  const agents = new Map<PresetName, unknown>();

  beforeAll(async () => {
    migration = new Kysely<MigrationDatabase>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: migrationUrl, max: 1 }) }) });
    db = new Kysely<PlatformDatabase>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: appUrl, max: 4 }) }) });
    await migrateToLatest(migration);
    const roles = await sql<{ rolsuper: boolean; rolbypassrls: boolean; owns: boolean }>`select r.rolsuper, r.rolbypassrls, (c.relowner = r.oid) as owns from pg_roles r cross join pg_class c where r.rolname=current_user and c.oid='works'::regclass`.execute(db);
    expect(roles.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false, owns: false });

    await migration.insertInto("tenants").values({ id: tenantId, slug: `contract-${tenantId}`, name: "Novel tool contract" }).execute();
    await migration.insertInto("members").values({ tenant_id: tenantId, user_id: owner.userId, role: "member", status: "active", display_name: owner.displayName }).execute();
    store = new PlatformStore({ db, authorizer: createGovernanceAuthorizer({ authorizePlatform }) });
    repository = new PostgresNovelRepository(store);
    workId = (await repository.createWork(owner, { title: "输出契约作品", description: "" })).id;
    chapterId = (await repository.createChapter(owner, workId, { title: "第一章" })).id;
    bibleEntryId = (await repository.createBible(owner, workId, { kind: "character", title: "主角", text: "最初设定" })).id;

    // 每个 preset 一条真实会话绑定；sid 同时用作 Agent 的会话 id。
    const sessionIds = new Map<PresetName, string>();
    for (const preset of PRESETS) sessionIds.set(preset, randomUUID());
    await migration.insertInto("session_bindings").values(PRESETS.map(preset => ({
      tenant_id: tenantId, id: sessionIds.get(preset)!, owner_user_id: owner.userId, work_id: workId,
      preset, policy_revision: "contract-v1", cell_id: cellId, status: "active", revoked_revision: REV,
    }))).execute();

    // 真实作品服务 HTTP（真实 Fastify 管线：参数校验、凭据、revision、executor、错误处理）。
    worksApp = await createWorksServer(createWorksExecutor(store, new CellCredentialRegistry([{ tenantId, cellId, token }])));

    // 真实 Cordis 组合：真实 ToolRuntime + 真实 preset 子树（工具注册在各自 scope）。
    harness = await createNovelHarness();
    await harness.ctx.plugin(
      { name: "myrix-novel", inject: ["tools", "systemPrompt", "agentPresets", "principals"], apply: applyNovel },
      { origin: "http://works.invalid", credential: token },
    );
    // 把客户端的真实 fetch 接到进程内 Fastify `inject`：传输仍是 HTTP 请求/响应，
    // 但不占用 Lead 的开发栈端口（8787/8790/8791/7801/7802）。
    globalThis.fetch = (async (input: string | URL | { url: string }, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
      const response = await worksApp.inject({
        method: "POST", url: url.pathname, headers,
        payload: typeof init?.body === "string" ? init.body : "{}",
      });
      return new Response(response.body, {
        status: response.statusCode,
        headers: { "content-type": String(response.headers["content-type"] ?? "application/json") },
      });
    }) as typeof fetch;

    for (const preset of PRESETS) {
      const sid = sessionIds.get(preset)!;
      agents.set(preset, await harness.createAgent({
        sessionId: sid, preset,
        principal: { sid, tid: tenantId, sub: owner.userId, wid: workId, preset, rev: REV },
      }));
    }
  }, 60_000);

  afterAll(async () => {
    await harness?.dispose();
    await worksApp?.close();
    await db?.destroy();
    await migration?.destroy();
  });

  /** 经真实 `ctx.tools.execute()` 调用一次工具（走真实 DSH 校验管线）。 */
  function run(preset: PresetName, name: NovelToolName, args: unknown, callId: string) {
    return harness!.ctx.tools.execute({
      name, arguments: args,
      agent: agents.get(preset) as never,
      callId: callId as never,
      signal: new AbortController().signal,
    });
  }

  /** 断言一次成功结果：不是错误（真实校验未抛 INVALID_TOOL_OUTPUT），且只含声明字段。 */
  function expectValid(tool: NovelToolName, result: Awaited<ReturnType<typeof run>>, expectedKeys: string[]): void {
    const text = JSON.stringify(result.content);
    expect(text, `${tool} 不得产生 INVALID_TOOL_OUTPUT`).not.toContain("invalid output");
    expect(result.isError, `${tool}: ${text}`).toBe(false);
    expect(Object.keys(result.value as object).sort(), tool).toEqual([...expectedKeys].sort());
  }

  it("get_outline / get_chapter 只回声明字段，丢弃 tenantId/parentVersion/contentHash/createdAt", async () => {
    const outline = await run("novel-outline", "get_outline", {}, "c_outline");
    expectValid("get_outline", outline, ["workId", "text", "version", "updatedAt"]);

    const chapter = await run("novel-chapter", "get_chapter", { chapterId }, "c_chapter");
    expectValid("get_chapter", chapter, ["id", "workId", "title", "text", "version", "updatedAt"]);
    expect(JSON.stringify(chapter.value)).not.toMatch(/tenantId|parentVersion|contentHash|createdAt/);

    const found = await run("novel-bible", "search_bible", { query: "主角" }, "c_bible");
    expect(found.isError, JSON.stringify(found.content)).toBe(false);
    expect(Array.isArray(found.value)).toBe(true);
  });

  it("update_outline：saved → duplicate → conflict 都经真实校验并保留三态", async () => {
    const saved = await run("novel-outline", "update_outline", { text: "大纲 v1", expectedVersion: 0 }, "c_outline_save");
    expectValid("update_outline", saved, ["status", "version"]);
    expect(saved.value).toMatchObject({ status: "saved" });

    // 同内容 + 同 expectedVersion：真实仓储判定为同一次写入的重试。
    const duplicate = await run("novel-outline", "update_outline", { text: "大纲 v1", expectedVersion: 0 }, "c_outline_dup");
    expectValid("update_outline", duplicate, ["status", "version"]);
    expect(duplicate.value).toEqual({ status: "duplicate", version: (saved.value as { version: number }).version });

    // 同 expectedVersion + 不同内容：真实 CAS 冲突，409 → { result: { status:"conflict", version } }。
    const conflict = await run("novel-outline", "update_outline", { text: "大纲 v2", expectedVersion: 0 }, "c_outline_conflict");
    expectValid("update_outline", conflict, ["status", "version"]);
    expect(conflict.value).toMatchObject({ status: "conflict" });
  });

  it("save_chapter_draft：saved → duplicate → conflict 都经真实校验并保留三态", async () => {
    const saved = await run("novel-chapter", "save_chapter_draft", { chapterId, text: "原稿", expectedVersion: 0 }, "c_chapter_save");
    expectValid("save_chapter_draft", saved, ["status", "version"]);
    expect(saved.value).toMatchObject({ status: "saved" });

    const duplicate = await run("novel-chapter", "save_chapter_draft", { chapterId, text: "原稿", expectedVersion: 0 }, "c_chapter_dup");
    expectValid("save_chapter_draft", duplicate, ["status", "version"]);
    expect(duplicate.value).toEqual({ status: "duplicate", version: (saved.value as { version: number }).version });

    const conflict = await run("novel-chapter", "save_chapter_draft", { chapterId, text: "改过的草稿", expectedVersion: 0 }, "c_chapter_conflict");
    expectValid("save_chapter_draft", conflict, ["status", "version"]);
    expect(conflict.value).toMatchObject({ status: "conflict" });
  });

  it("update_bible_entry：saved → duplicate → conflict 都经真实校验并保留三态", async () => {
    const saved = await run("novel-bible", "update_bible_entry", { entryId: bibleEntryId, text: "修订设定", expectedVersion: 0 }, "c_bible_save");
    expectValid("update_bible_entry", saved, ["status", "version"]);
    expect(saved.value).toMatchObject({ status: "saved" });

    const duplicate = await run("novel-bible", "update_bible_entry", { entryId: bibleEntryId, text: "修订设定", expectedVersion: 0 }, "c_bible_dup");
    expectValid("update_bible_entry", duplicate, ["status", "version"]);
    expect(duplicate.value).toEqual({ status: "duplicate", version: (saved.value as { version: number }).version });

    const conflict = await run("novel-bible", "update_bible_entry", { entryId: bibleEntryId, text: "另一种设定", expectedVersion: 0 }, "c_bible_conflict");
    expectValid("update_bible_entry", conflict, ["status", "version"]);
    expect(conflict.value).toMatchObject({ status: "conflict" });
  });

  it("声明 schema 封闭且只列模型面字段；六工具与 preset 掩码保持一致", () => {
    expect(NOVEL_TOOLS).toHaveLength(6);
    for (const preset of PRESETS) expect(PRESET_TOOLS[preset].length).toBeGreaterThan(0);
    // 五个对象 schema 显式封闭；search_bible 是数组，封闭性在 items 上。
    expect(OUTPUT_SCHEMAS.search_bible).toMatchObject({ type: "array", items: { additionalProperties: false } });
    for (const tool of NOVEL_TOOLS.filter(name => name !== "search_bible")) {
      expect(OUTPUT_SCHEMAS[tool], tool).toMatchObject({ additionalProperties: false });
    }
    // 写工具的 schema 只声明 status/version —— 内部字段不是对模型的承诺。
    for (const tool of ["update_outline", "save_chapter_draft", "update_bible_entry"] as const) {
      expect(Object.keys((OUTPUT_SCHEMAS[tool] as { properties: object }).properties).sort(), tool).toEqual(["status", "version"]);
    }
  });

  it("身份隔离仍然成立：另一个 Cell 的凭据不能借本 Cell 的会话调用工具", async () => {
    const wrongCellToken = `contract-other-${randomUUID()}`;
    const otherApp = await createWorksServer(createWorksExecutor(store, new CellCredentialRegistry([
      { tenantId, cellId: "other-cell", token: wrongCellToken },
    ])));
    try {
      const sessionId = (agents.get("novel-outline") as { id: string }).id;
      const denied = await otherApp.inject({
        method: "POST", url: `/internal/v1/sessions/${sessionId}/tools/get_outline`,
        headers: { authorization: `Bearer ${wrongCellToken}`, "x-myrix-revision": String(REV) }, payload: {},
      });
      // 凭据解析出的 cell 与会话绑定的 cell 不一致：在到达工具前拒绝。
      expect(denied.statusCode).toBe(403);
      expect(denied.body).not.toContain(token);
    } finally {
      await otherApp.close();
    }
  });
});
