import type {
  BibleEntry, BibleKind, Chapter, NovelPreset, NovelSession, Outline,
  PlatformIdentity, QueuedCommand, SaveResult, SessionStreamEvent, Work,
} from "@myrix/contracts";

/** All implementations must resolve ownership in storage, not trust nested URL relationships. */
export interface NovelRepository {
  listWorks(actor: PlatformIdentity): Promise<Work[]>;
  createWork(actor: PlatformIdentity, input: { title: string; description: string }): Promise<Work>;
  getWork(actor: PlatformIdentity, workId: string): Promise<Work>;
  deleteWork(actor: PlatformIdentity, workId: string): Promise<void>;
  getOutline(actor: PlatformIdentity, workId: string): Promise<Outline>;
  saveOutline(actor: PlatformIdentity, workId: string, input: DraftInput): Promise<SaveResult>;
  listChapters(actor: PlatformIdentity, workId: string): Promise<Chapter[]>;
  createChapter(actor: PlatformIdentity, workId: string, input: { title: string }): Promise<Chapter>;
  getChapter(actor: PlatformIdentity, workId: string, chapterId: string): Promise<Chapter>;
  saveChapter(actor: PlatformIdentity, workId: string, chapterId: string, input: DraftInput): Promise<SaveResult>;
  chapterVersions(actor: PlatformIdentity, workId: string, chapterId: string): Promise<Array<{ version: number; text: string; createdAt: string }>>;
  listBible(actor: PlatformIdentity, workId: string, query: string): Promise<BibleEntry[]>;
  createBible(actor: PlatformIdentity, workId: string, input: { kind: BibleKind; title: string; text: string }): Promise<BibleEntry>;
  saveBible(actor: PlatformIdentity, workId: string, entryId: string, input: DraftInput): Promise<SaveResult>;
  listSessions(actor: PlatformIdentity, workId: string): Promise<NovelSession[]>;
}
export interface DraftInput { text: string; expectedVersion: number }

/** The durable router owns atomic binding/queue creation, grant issuance, retries and live stream authorization. */
export interface RuntimeRouter {
  createSession(actor: PlatformIdentity, workId: string, preset: NovelPreset): Promise<NovelSession>;
  send(actor: PlatformIdentity, sessionId: string, input: { commandId: string; text: string }): Promise<QueuedCommand>;
  cancel(actor: PlatformIdentity, sessionId: string, commandId: string): Promise<QueuedCommand>;
  revoke(actor: PlatformIdentity, sessionId: string): Promise<void>;
  /** Must authorize before resolving, then honor abort and continuously enforce current binding revision. */
  events(actor: PlatformIdentity, sessionId: string, after: number, signal: AbortSignal): Promise<AsyncIterable<SessionStreamEvent>>;
}

export class ApiFailure extends Error {
  constructor(readonly statusCode: number, readonly code: string, readonly reason: string) { super(reason); }
}
