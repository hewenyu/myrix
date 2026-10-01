import type { BibleEntry, Chapter, NovelSession, PlatformIdentity, SaveResult } from "@myrix/contracts";
import { PlatformStore, type StoreTx, type TenantContextInput } from "../../../packages/platform-store/src/store";
import { PlatformStoreError } from "../../../packages/platform-store/src/errors";
import { WorksRepository } from "../../../packages/platform-store/src/repositories/works";
import { ChaptersRepository } from "../../../packages/platform-store/src/repositories/chapters";
import { OutlineRepository } from "../../../packages/platform-store/src/repositories/outline";
import { BibleRepository, type BibleEntryRecord } from "../../../packages/platform-store/src/repositories/bible";
import { SessionsRepository, type SessionBindingRecord } from "../../../packages/platform-store/src/repositories/bindings";
import { ApiFailure, type DraftInput, type NovelRepository } from "./ports";

/** Reuses a single RLS transaction for nested ownership checks and writes; never opens a second pool lease. */
export class TransactionBoundStore extends PlatformStore {
  constructor(source: PlatformStore, private readonly tx: StoreTx) {
    super({ db: source.db, authorizer: source.authorizer, now: () => source.now() });
  }
  override async withTenant<T>(input: TenantContextInput, fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    if (input.tenantId !== this.tx.tenantId || input.actorUserId !== this.tx.actorUserId) throw new ApiFailure(403, "scope_mismatch", "事务身份不能在操作中切换");
    return fn(this.tx);
  }
}
export function throwApiError(error: unknown): never {
  if (error instanceof PlatformStoreError) throw new ApiFailure(error.httpStatus, error.code, error.reason);
  throw error;
}
export function toNovelSession(row: SessionBindingRecord): NovelSession {
  return { id: row.id, workId: row.workId, preset: row.preset, status: row.status === "closed" ? "revoked" : row.status, createdAt: row.createdAt };
}
function toBible(row: BibleEntryRecord): BibleEntry {
  return { id: row.id, workId: row.workId, kind: row.kind === "character" || row.kind === "timeline" ? row.kind : "setting", title: row.name, text: row.summary, version: row.version, updatedAt: row.updatedAt };
}
function ensureParent(expected: string, actual: string): void {
  if (expected !== actual) throw new ApiFailure(404, "not_found", "资源不属于当前作品");
}
async function cas(fn: () => Promise<SaveResult>): Promise<SaveResult> {
  try { return await fn(); } catch (error) {
    if (error instanceof PlatformStoreError && error.code === "version_conflict" && typeof error.details.currentVersion === "number") {
      return { status: "conflict", version: error.details.currentVersion };
    }
    return throwApiError(error);
  }
}

/** Maps the versioned persistence model to the stable browser API without exposing storage-only fields. */
export class PostgresNovelRepository implements NovelRepository {
  constructor(private readonly store: PlatformStore) {}
  private async run<T>(actor: PlatformIdentity, fn: (bound: PlatformStore) => Promise<T>, rawErrors = false): Promise<T> {
    try {
      return await this.store.withTenant({ tenantId: actor.tenantId, actorUserId: actor.userId }, tx => fn(new TransactionBoundStore(this.store, tx)));
    } catch (error) { if (rawErrors) throw error; return throwApiError(error); }
  }
  listWorks(actor: PlatformIdentity) {
    return this.run(actor, store => new WorksRepository(store).list(actor.tenantId, actor.userId));
  }
  createWork(actor: PlatformIdentity, input: { title: string; description: string }) {
    return this.run(actor, store => new WorksRepository(store).create(actor.tenantId, actor.userId, input));
  }
  getWork(actor: PlatformIdentity, workId: string) {
    return this.run(actor, store => new WorksRepository(store).get(actor.tenantId, actor.userId, workId));
  }
  deleteWork(actor: PlatformIdentity, workId: string) {
    return this.run(actor, store => new WorksRepository(store).softDelete(actor.tenantId, actor.userId, workId));
  }
  getOutline(actor: PlatformIdentity, workId: string) {
    return this.run(actor, async store => {
      const row = await new OutlineRepository(store).get(actor.tenantId, actor.userId, workId);
      return { workId, text: row.document.synopsis ?? "", version: row.version, updatedAt: row.updatedAt };
    });
  }
  saveOutline(actor: PlatformIdentity, workId: string, input: DraftInput) {
    return cas(() => this.run(actor, store => new OutlineRepository(store).save(actor.tenantId, actor.userId, {
      workId, document: { synopsis: input.text, chapters: [] }, expectedVersion: input.expectedVersion,
    }), true));
  }
  listChapters(actor: PlatformIdentity, workId: string): Promise<Chapter[]> {
    return this.run(actor, async store => {
      const repo = new ChaptersRepository(store);
      const rows = await repo.list(actor.tenantId, actor.userId, workId);
      // The first-version wire contract includes text. Sequential reads stay on the same transaction.
      const chapters: Chapter[] = [];
      for (const row of rows) chapters.push(await repo.get(actor.tenantId, actor.userId, row.id));
      return chapters;
    });
  }
  createChapter(actor: PlatformIdentity, workId: string, input: { title: string }): Promise<Chapter> {
    return this.run(actor, async store => ({ ...await new ChaptersRepository(store).create(actor.tenantId, actor.userId, workId, input.title), text: "" }));
  }
  getChapter(actor: PlatformIdentity, workId: string, chapterId: string): Promise<Chapter> {
    return this.run(actor, async store => {
      const chapter = await new ChaptersRepository(store).get(actor.tenantId, actor.userId, chapterId);
      ensureParent(workId, chapter.workId);
      return chapter;
    });
  }
  saveChapter(actor: PlatformIdentity, workId: string, chapterId: string, input: DraftInput) {
    return cas(() => this.run(actor, async store => {
      const repo = new ChaptersRepository(store);
      ensureParent(workId, (await repo.get(actor.tenantId, actor.userId, chapterId)).workId);
      return repo.save(actor.tenantId, actor.userId, { chapterId, ...input });
    }, true));
  }
  chapterVersions(actor: PlatformIdentity, workId: string, chapterId: string) {
    return this.run(actor, async store => {
      const repo = new ChaptersRepository(store);
      ensureParent(workId, (await repo.get(actor.tenantId, actor.userId, chapterId)).workId);
      return (await repo.history(actor.tenantId, actor.userId, chapterId)).map(({ version, text, createdAt }) => ({ version, text, createdAt }));
    });
  }
  listBible(actor: PlatformIdentity, workId: string, query: string) {
    return this.run(actor, async store => {
      const repo = new BibleRepository(store);
      if (!query.trim()) return (await repo.listByWork(actor.tenantId, actor.userId, workId)).map(toBible);
      const hits = await repo.search(actor.tenantId, actor.userId, workId, query, 50);
      const result: BibleEntry[] = [];
      for (const hit of hits) result.push(toBible(await repo.get(actor.tenantId, actor.userId, hit.id)));
      return result;
    });
  }
  createBible(actor: PlatformIdentity, workId: string, input: { kind: BibleEntry["kind"]; title: string; text: string }) {
    return this.run(actor, async store => toBible(await new BibleRepository(store).create(actor.tenantId, actor.userId, {
      workId, kind: input.kind === "setting" ? "concept" : input.kind, name: input.title, summary: input.text,
    })));
  }
  saveBible(actor: PlatformIdentity, workId: string, entryId: string, input: DraftInput) {
    return cas(() => this.run(actor, async store => {
      const repo = new BibleRepository(store);
      const current = await repo.get(actor.tenantId, actor.userId, entryId);
      ensureParent(workId, current.workId);
      return repo.save(actor.tenantId, actor.userId, { entryId, name: current.name, summary: input.text, attributes: current.attributes, expectedVersion: input.expectedVersion });
    }, true));
  }
  listSessions(actor: PlatformIdentity, workId: string) {
    return this.run(actor, async store => (await new SessionsRepository(store).listForWork(actor.tenantId, actor.userId, workId)).map(toNovelSession));
  }
}
