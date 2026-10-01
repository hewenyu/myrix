#!/usr/bin/env tsx
/**
 * 端到端冒烟：用**应用角色 myrix_app** 连接本地开发库，走一遍 works-service 的
 * 全部用例（作品 → 大纲 → 章节 → 设定 → 会话 → 命令 → 撤权），并顺带验证
 * 单一所有者与跨租户拒绝。
 *
 *   MYRIX_MIGRATE_DATABASE_URL=... pnpm --filter @myrix/works-service exec tsx src/bin/smoke.ts
 *
 * 这是"是否真的能跑"的证据，不是单元测试的替代品：
 * 所有连接都使用 NOBYPASSRLS 的非 owner 角色。
 */

import { createPlatformDatabase, createPlatformPool } from "@myrix/platform-store";
import type { PlatformIdentity } from "@myrix/contracts";

import { WorksService, toHttpError } from "../index";

function appUrl(): string {
  const raw = process.env["MYRIX_MIGRATE_DATABASE_URL"];
  if (!raw) throw new Error("缺少 MYRIX_MIGRATE_DATABASE_URL（用于推导应用连接串）");
  const url = new URL(raw);
  url.username = "myrix_app";
  url.password = process.env["MYRIX_APP_PASSWORD"] ?? "myrix_local_app";
  return url.toString();
}

const AUTHOR: PlatformIdentity = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "a0000000-0000-4000-8000-000000000002",
  displayName: "开发作者",
  role: "member",
};
const EDITOR: PlatformIdentity = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "a0000000-0000-4000-8000-000000000003",
  displayName: "开发编辑",
  role: "member",
};
const OTHER_TENANT: PlatformIdentity = {
  tenantId: "22222222-2222-4222-8222-222222222222",
  userId: "b0000000-0000-4000-8000-000000000001",
  displayName: "异租户成员",
  role: "member",
};

async function main(): Promise<void> {
  const pool = createPlatformPool({ connectionString: appUrl(), max: 4 });
  const service = new WorksService({
    db: createPlatformDatabase(pool),
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

  const results: string[] = [];
  const check = (label: string, ok: boolean): void => {
    results.push(`${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) throw new Error(`冒烟失败：${label}`);
  };

  const work = await service.createWork(AUTHOR, { title: "冒烟作品", description: "由 smoke 脚本创建" });
  check("创建作品（owner=author）", work.ownerUserId === AUTHOR.userId);

  const authorWorks = await service.listWorks(AUTHOR);
  check("作者能看到自己的作品", authorWorks.some((item) => item.id === work.id));

  const editorWorks = await service.listWorks(EDITOR);
  check("同租户编辑看不到作者的作品", !editorWorks.some((item) => item.id === work.id));

  const outline = await service.getOutline(AUTHOR, work.id);
  check("新作品大纲 version=0 且为空", outline.version === 0 && outline.text === "");
  const savedOutline = await service.saveOutline(AUTHOR, work.id, {
    text: "第一章 起风\n第二章 落雨",
    expectedVersion: 0,
  });
  check("保存大纲 → saved v1", savedOutline.status === "saved" && savedOutline.version === 1);
  const reread = await service.getOutline(AUTHOR, work.id);
  check("回读大纲内容一致", reread.text.split("\n").length === 2 && reread.version === 1);

  const chapter = await service.createChapter(AUTHOR, work.id, { title: "第一章" });
  check("创建章节 version=0", chapter.version === 0);
  const savedChapter = await service.saveChapter(AUTHOR, chapter.id, {
    text: "第一章正文……",
    expectedVersion: 0,
  });
  check("保存章节 → saved v1", savedChapter.status === "saved" && savedChapter.version === 1);
  const duplicate = await service.saveChapter(AUTHOR, chapter.id, {
    text: "第一章正文……",
    expectedVersion: 0,
  });
  check("同 parent + 同正文重试 → duplicate v1", duplicate.status === "duplicate" && duplicate.version === 1);
  try {
    await service.saveChapter(AUTHOR, chapter.id, { text: "换了正文", expectedVersion: 0 });
    check("改正文的旧版本写入必须冲突", false);
  } catch (error) {
    const mapped = toHttpError(error);
    check("冲突映射成 409", mapped.status === 409);
  }
  const versions = await service.listChapterVersions(AUTHOR, chapter.id);
  check("章节版本历史可读", versions.length === 1 && versions[0]?.text === "第一章正文……");

  const entry = await service.createBibleEntry(AUTHOR, work.id, {
    kind: "character",
    title: "林黛玉",
    text: "主角，体弱多病",
  });
  check("创建设定条目 version=0", entry.version === 0);
  const bibleHits = await service.listBible(AUTHOR, work.id, "黛玉");
  check("设定检索命中", bibleHits.some((item) => item.id === entry.id));

  const session = await service.createSession(AUTHOR, work.id, { preset: "novel-outline" });
  check("创建会话（creating + rev=1）", session.status === "creating" && session.rev === 1);

  const queued = await service.enqueueSessionCommand(AUTHOR, {
    sessionId: session.id,
    commandId: crypto.randomUUID(),
    op: "send",
    body: { text: "继续写下一章" },
    expectedRev: session.rev,
  });
  check("入队 send 命令返回 queued", queued.status === "queued");

  try {
    await service.enqueueSessionCommand(AUTHOR, {
      sessionId: session.id,
      commandId: crypto.randomUUID(),
      op: "send",
      body: { text: "用过期 rev 发命令" },
      expectedRev: session.rev + 5,
    });
    check("过期 rev 必须被拒绝", false);
  } catch (error) {
    const mapped = toHttpError(error);
    check("rev 不匹配映射成 409", mapped.status === 409);
  }

  const revoked = await service.revokeSession(AUTHOR, session.id, session.rev, "冒烟结束");
  check("撤权后 rev+1", revoked.status === "revoked" && revoked.rev === session.rev + 1);

  try {
    await service.getWork(OTHER_TENANT, work.id);
    check("异租户读作品必须被拒绝", false);
  } catch (error) {
    const mapped = toHttpError(error);
    check("跨租户映射成 404/403 且不泄漏细节", mapped.status === 404 || mapped.status === 403);
    check("错误体不含 SQL 片段", !mapped.body.reason.match(/select|relation|pg_/i));
  }

  const sessions = await service.listSessions(AUTHOR, work.id);
  check("会话列表默认不含已撤权会话", sessions.length === 0);

  console.log(results.join("\n"));
  console.log(`\nsmoke: ${results.length} checks passed`);

  await service.store.db.destroy();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
