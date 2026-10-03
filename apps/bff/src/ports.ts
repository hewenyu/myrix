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
  /**
   * 归档 / 恢复一条**本人**会话（展示元数据，不是撤权）。
   *
   * 归档只整理历史：不停止任务、不改 `status`/`rev`、不发 outbox、不使凭证失效。
   * 唯一新增的边界是拒绝**新的 send**（409 `session_archived`，提示恢复）；cancel、
   * 事件流（含为订阅触发的必要 resume）、Cell 工具调用与已入队命令都不受影响。
   * 授权与审计在存储层同一事务内完成；返回更新后的会话（含 archivedAt）。
   */
  archive(actor: PlatformIdentity, sessionId: string, archived: boolean): Promise<NovelSession>;
  /** Must authorize before resolving, then honor abort and continuously enforce current binding revision. */
  events(actor: PlatformIdentity, sessionId: string, after: number, signal: AbortSignal): Promise<AsyncIterable<SessionStreamEvent>>;
}

export class ApiFailure extends Error {
  constructor(readonly statusCode: number, readonly code: string, readonly reason: string) { super(reason); }
}
