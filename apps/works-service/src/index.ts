/**
 * works-service：把 `@myrix/platform-store` 的仓储组合成 BFF 直接可用的用例。
 *
 * 分工（与 docs/adr/0011-postgres-ownership.md 一致）：
 *   * platform-store 负责"每个方法都在正确租户上下文里、先判定再读写、列表永远 owner 过滤"；
 *   * works-service 负责**线协议映射**（DB 行 → BFF wire 字段），以及把存储层的
 *     结构化错误翻译成 BFF 需要的形状（409 conflict / 403 reason）。
 *
 * 这里**不复制**任何授权、RLS 或 CAS 逻辑：那三件事只有 platform-store 一处实现。
 */

import {
  BibleRepository,
  ChaptersRepository,
  CommandsRepository,
  OutlineRepository,
  PlatformStore,
  PlatformStoreError,
  SessionsRepository,
  WorksRepository,
  errors,
  type BibleEntryKind,
  getCommand,
  type BibleHit,
  type PlatformStoreOptions,
  type SessionPreset,
} from "@myrix/platform-store";
import { createGovernanceAuthorizer } from "@myrix/platform-store";
import * as governance from "@myrix/governance";

import type {
  BibleEntryView,
  Caller,
  ChapterSummaryView,
  ChapterVersionView,
  ChapterView,
  NovelSessionView,
  OutlineView,
  QueuedCommandView,
  SaveOutcome,
  WorkView,
} from "./contracts";

export type * from "./contracts";

/** 契约里只暴露三种对外 kind；DB 侧的 location/faction/item/concept 归到 setting。 */
const WIRE_TO_DB_KIND: Record<BibleEntryView["kind"], BibleEntryKind> = {
  character: "character",
  setting: "faction",
  timeline: "timeline",
};

const DB_TO_WIRE_KIND: Record<BibleEntryKind, BibleEntryView["kind"]> = {
  character: "character",
  location: "setting",
  faction: "setting",
  item: "setting",
  concept: "setting",
  timeline: "timeline",
};

/** 大纲 `text` ↔ `OutlineDocument`：v0.1 用"每行一个章节标题"的最小双向映射。 */
function outlineTextFromDocument(document: { synopsis?: string; chapters: { title: string }[] }): string {
  return document.chapters.map((node) => node.title).join("\n");
}

function outlineDocumentFromText(text: string): { synopsis?: string; chapters: { id: string; title: string }[] } {
  const lines = text.split("\n");
  const chapters = lines
    .map((title) => title.trim())
    .filter((title) => title.length > 0)
    .map((title, index) => ({ id: `ch-${index + 1}`, title }));
  return { chapters };
}

/** 设定条目 `text` ↔ `{name, summary}`：首行为名称，其余为摘要。 */
function bibleTextFromEntry(entry: { name: string; summary: string }): string {
  return entry.summary.length > 0 ? `${entry.name}\n${entry.summary}` : entry.name;
}

function biblePartsFromText(text: string): { name: string; summary: string } {
  const [first = "", ...rest] = text.split("\n");
  const name = first.trim();
  if (name.length === 0) throw errors.invalidInput("设定条目内容的第一行必须是非空名称");
  return { name, summary: rest.join("\n").trim() };
}

/** chapter_versions → wire：只暴露 version/text/createdAt，不泄漏 author/hash。 */
function toChapterVersionView(row: { version: number; text: string; createdAt: string }): ChapterVersionView {
  return { version: row.version, text: row.text, createdAt: row.createdAt };
}

/** 会话状态：`closed` 不属于 wire 三态，按 revoked 暴露（不可再用）。 */
function toSessionStatus(status: string): NovelSessionView["status"] {
  if (status === "creating" || status === "active") return status;
  return "revoked";
}

export interface WorksServiceOptions extends Omit<PlatformStoreOptions, "authorizer"> {
  /** 覆盖默认 authorizer（默认绑定 `@myrix/governance` 的 authorizePlatform） */
  authorizer?: PlatformStoreOptions["authorizer"];
}

/**
 * 服务装配。BFF 只需要 `new WorksService({ db: createPlatformDatabase(pool) })`。
 * 默认 authorizer 是 **governance 的真实实现**（不是测试替身，也不是全拒占位）：
 * 忘记装配 authorizer 时不会是"全拒"这种安全但静默的状态，而是显式绑定生产判定。
 */
export class WorksService {
  readonly store: PlatformStore;
  private readonly works: WorksRepository;
  private readonly chapters: ChaptersRepository;
  private readonly outlines: OutlineRepository;
  private readonly bible: BibleRepository;
  private readonly sessions: SessionsRepository;
  private readonly commands: CommandsRepository;

  constructor(options: WorksServiceOptions) {
    this.store = new PlatformStore({
      ...options,
      authorizer: options.authorizer ?? createGovernanceAuthorizer(governance),
    });
    this.works = new WorksRepository(this.store);
    this.chapters = new ChaptersRepository(this.store);
    this.outlines = new OutlineRepository(this.store);
    this.bible = new BibleRepository(this.store);
    this.sessions = new SessionsRepository(this.store);
    this.commands = new CommandsRepository(this.store);
  }

  // -------------------------------------------------------------------------
  // 作品
  // -------------------------------------------------------------------------

  async listWorks(caller: Caller): Promise<WorkView[]> {
    const rows = await this.works.list(caller.tenantId, caller.userId);
    return rows.map(toWorkView);
  }

  async createWork(caller: Caller, input: { title: string; description?: string }): Promise<WorkView> {
    const row = await this.works.create(caller.tenantId, caller.userId, input);
    return toWorkView(row);
  }

  async getWork(caller: Caller, workId: string): Promise<WorkView> {
    const row = await this.works.get(caller.tenantId, caller.userId, workId);
    return toWorkView(row);
  }

  async deleteWork(caller: Caller, workId: string): Promise<void> {
    await this.works.softDelete(caller.tenantId, caller.userId, workId);
  }

  // -------------------------------------------------------------------------
  // 大纲
  // -------------------------------------------------------------------------

  async getOutline(caller: Caller, workId: string): Promise<OutlineView> {
    const snapshot = await this.outlines.get(caller.tenantId, caller.userId, workId);
    return {
      workId,
      text: outlineTextFromDocument(snapshot.document),
      version: snapshot.version,
      updatedAt: snapshot.updatedAt,
    };
  }

  async saveOutline(
    caller: Caller,
    workId: string,
    input: { text: string; expectedVersion: number },
  ): Promise<SaveOutcome> {
    const result = await this.outlines.save(caller.tenantId, caller.userId, {
      workId,
      document: outlineDocumentFromText(input.text),
      expectedVersion: input.expectedVersion,
    });
    return { status: result.status, version: result.version };
  }

  // -------------------------------------------------------------------------
  // 章节
  // -------------------------------------------------------------------------

  async listChapters(caller: Caller, workId: string): Promise<ChapterSummaryView[]> {
    const rows = await this.chapters.list(caller.tenantId, caller.userId, workId);
    return rows.map((row) => ({
      id: row.id,
      workId: row.workId,
      title: row.title,
      version: row.version,
      updatedAt: row.updatedAt,
    }));
  }

  async createChapter(caller: Caller, workId: string, input: { title: string }): Promise<ChapterView> {
    const row = await this.chapters.create(caller.tenantId, caller.userId, workId, input.title);
    return {
      id: row.id,
      workId: row.workId,
      title: row.title,
      text: "",
      version: row.version,
      updatedAt: row.updatedAt,
    };
  }

  async getChapter(caller: Caller, chapterId: string): Promise<ChapterView> {
    const row = await this.chapters.get(caller.tenantId, caller.userId, chapterId);
    return {
      id: row.id,
      workId: row.workId,
      title: row.title,
      text: row.text,
      version: row.version,
      updatedAt: row.updatedAt,
    };
  }

  async saveChapter(
    caller: Caller,
    chapterId: string,
    input: { text: string; expectedVersion: number; title?: string },
  ): Promise<SaveOutcome> {
    const result = await this.chapters.save(caller.tenantId, caller.userId, {
      chapterId,
      text: input.text,
      expectedVersion: input.expectedVersion,
      ...(input.title !== undefined ? { title: input.title } : {}),
    });
    return { status: result.status, version: result.version };
  }

  async listChapterVersions(caller: Caller, chapterId: string): Promise<ChapterVersionView[]> {
    const rows = await this.chapters.history(caller.tenantId, caller.userId, chapterId);
    return rows.map(toChapterVersionView);
  }

  // -------------------------------------------------------------------------
  // 设定
  // -------------------------------------------------------------------------

  async listBible(
    caller: Caller,
    workId: string,
    query?: string,
  ): Promise<BibleEntryView[]> {
    if (query && query.trim().length > 0) {
      const hits: BibleHit[] = await this.bible.search(caller.tenantId, caller.userId, workId, query);
      return hits.map((hit) => ({
        id: hit.id,
        workId,
        kind: DB_TO_WIRE_KIND[hit.kind],
        title: hit.name,
        text: bibleTextFromEntry(hit),
        version: hit.version,
        updatedAt: this.store.now().toISOString(),
      }));
    }
    const rows = await this.bible.listByWork(caller.tenantId, caller.userId, workId);
    return rows.map((row) => ({
      id: row.id,
      workId: row.workId,
      kind: DB_TO_WIRE_KIND[row.kind],
      title: row.name,
      text: bibleTextFromEntry(row),
      version: row.version,
      updatedAt: row.updatedAt,
    }));
  }

  async createBibleEntry(
    caller: Caller,
    workId: string,
    input: { kind: BibleEntryView["kind"]; title: string; text?: string },
  ): Promise<BibleEntryView> {
    const dbKind = WIRE_TO_DB_KIND[input.kind];
    if (dbKind === undefined) throw errors.invalidInput(`未知设定类别 ${String(input.kind)}`);
    const row = await this.bible.create(caller.tenantId, caller.userId, {
      workId,
      kind: dbKind,
      name: input.title,
      summary: input.text ?? "",
    });
    return {
      id: row.id,
      workId: row.workId,
      kind: DB_TO_WIRE_KIND[row.kind],
      title: row.name,
      text: bibleTextFromEntry(row),
      version: row.version,
      updatedAt: row.updatedAt,
    };
  }

  async saveBibleEntry(
    caller: Caller,
    entryId: string,
    input: { text: string; expectedVersion: number },
  ): Promise<SaveOutcome> {
    const { name, summary } = biblePartsFromText(input.text);
    const result = await this.bible.save(caller.tenantId, caller.userId, {
      entryId,
      name,
      summary,
      expectedVersion: input.expectedVersion,
    });
    return { status: result.status, version: result.version };
  }

  // -------------------------------------------------------------------------
  // 会话
  // -------------------------------------------------------------------------

  async listSessions(caller: Caller, workId: string): Promise<NovelSessionView[]> {
    const rows = await this.sessions.listForWork(caller.tenantId, caller.userId, workId);
    return rows.map(toSessionView);
  }

  async createSession(caller: Caller, workId: string, input: { preset: SessionPreset }): Promise<NovelSessionView> {
    const row = await this.sessions.create(caller.tenantId, caller.userId, {
      workId,
      preset: input.preset,
    });
    return toSessionView(row);
  }

  /**
   * 发送/取消命令。BFF 已从库读到当前 rev 后传入 `expectedRev`；
   * 撤权竞态会以 `version_conflict` 浮出，BFF 转成 409。
   */
  async enqueueSessionCommand(
    caller: Caller,
    input: {
      sessionId: string;
      commandId: string;
      op: "send" | "cancel" | "resume" | "subscribe";
      body: Record<string, unknown>;
      expectedRev: number;
    },
  ): Promise<QueuedCommandView> {
    const result = await this.commands.enqueue(caller.tenantId, caller.userId, {
      commandId: input.commandId,
      bindingId: input.sessionId,
      op: input.op,
      body: input.body,
      expectedRevision: input.expectedRev,
    });
    return {
      commandId: result.command.id,
      status: "queued",
      rev: result.command.grantRevision,
    };
  }

  async revokeSession(
    caller: Caller,
    sessionId: string,
    expectedRev: number,
    reason: string,
  ): Promise<NovelSessionView> {
    const row = await this.sessions.revoke(caller.tenantId, caller.userId, sessionId, expectedRev, reason);
    return toSessionView(row);
  }

  /** 命令回执查询（超时后先查再重发）。仍强制按 actor 过滤，读不到别人的命令。 */
  async getCommand(caller: Caller, commandId: string): Promise<QueuedCommandView & { status: "queued" }> {
    const record = await getCommand(this.store, caller.tenantId, caller.userId, commandId);
    return { commandId: record.id, status: "queued", rev: record.grantRevision };
  }
}

function toWorkView(row: {
  id: string;
  tenantId: string;
  ownerUserId: string;
  title: string;
  description: string;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}): WorkView {
  return {
    id: row.id,
    tenantId: row.tenantId,
    ownerUserId: row.ownerUserId,
    title: row.title,
    description: row.description,
    // wire 只有 active/archived：deleted 的作品根本读不到（存储层已按 not_found 处理）
    status: row.status === "archived" ? "archived" : "active",
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toSessionView(row: {
  id: string;
  workId: string;
  preset: SessionPreset;
  status: string;
  revokedRevision: number;
  createdAt: string;
}): NovelSessionView {
  return {
    id: row.id,
    workId: row.workId,
    preset: row.preset,
    status: toSessionStatus(row.status),
    rev: row.revokedRevision,
    createdAt: row.createdAt,
  };
}

/** 供 BFF 的 HTTP 边界使用：把 PlatformStoreError 映射成 `{ status, body }`，不泄漏 SQL。 */
export function toHttpError(error: unknown): { status: number; body: { error: string; reason: string } } {
  if (error instanceof PlatformStoreError) {
    return { status: error.httpStatus, body: error.toResponseBody() };
  }
  // 未预期错误一律 500，**不带**原始 message（可能是 SQL 片段或正文）
  return { status: 500, body: { error: "internal", reason: "服务端内部错误" } };
}
