import type { BibleEntry, Chapter, NovelSession, Outline, SaveResult } from "@myrix/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  outlineGet: vi.fn(),
  outlineSave: vi.fn(),
  chaptersList: vi.fn(),
  chaptersCreate: vi.fn(),
  chaptersGet: vi.fn(),
  chaptersSave: vi.fn(),
  chaptersVersions: vi.fn(),
  bibleList: vi.fn(),
  bibleCreate: vi.fn(),
  bibleSave: vi.fn(),
  sessionsList: vi.fn(),
  sessionsCreate: vi.fn(),
  sessionsRemove: vi.fn(),
  sessionsArchive: vi.fn(),
}));

// 只替换网络边界：query key 工具、错误分类等保持真实实现。
vi.mock("../src/api/endpoints", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/endpoints")>();
  return {
    ...actual,
    works: {
      ...actual.works,
      outline: { get: mocks.outlineGet, save: mocks.outlineSave },
      chapters: {
        list: mocks.chaptersList,
        create: mocks.chaptersCreate,
        get: mocks.chaptersGet,
        save: mocks.chaptersSave,
        versions: mocks.chaptersVersions,
      },
      bible: { list: mocks.bibleList, create: mocks.bibleCreate, save: mocks.bibleSave },
    },
    sessions: {
      ...actual.sessions,
      list: mocks.sessionsList,
      create: mocks.sessionsCreate,
      remove: mocks.sessionsRemove,
      archive: mocks.sessionsArchive,
    },
  };
});

import { workKeys } from "../src/state/useWorks";
import { useBible, useChapter, useChapters, useOutline, useSessions } from "../src/state/useWorkspace";

function harness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const chapterA: Chapter = {
  id: "chapter-a",
  workId: "wA",
  title: "A 的章节",
  text: "A 正文",
  version: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const chapterB: Chapter = { ...chapterA, id: "chapter-b", workId: "wB", title: "B 的章节" };
const outlineA: Outline = { workId: "wA", text: "A 大纲", version: 3, updatedAt: "2026-01-01T00:00:00.000Z" };
const entryA: BibleEntry = {
  id: "entry-a",
  workId: "wA",
  kind: "character",
  title: "A 条目",
  text: "A 条目正文",
  version: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const sessionA: NovelSession = {
  id: "session-a",
  workId: "wA",
  preset: "novel-outline",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
};
/** 同一作品的第二条会话：归档只替换目标条目，不能连坐。 */
const sessionA2: NovelSession = { ...sessionA, id: "session-a2", preset: "novel-assistant" };
const sessionB: NovelSession = { ...sessionA, id: "session-b", workId: "wB" };
const ARCHIVED_AT = "2026-02-02T00:00:00.000Z";

/** 章节列表按作品返回：A 空、B 有自己的章节。 */
function stubChapterLists() {
  mocks.chaptersList.mockImplementation((workId: string) =>
    Promise.resolve({ items: workId === "wA" ? [] : [chapterB] }),
  );
}

describe("useWorkspace mutation 目标冻结：切换作品后晚到结果不得写到其它作品缓存", () => {
  it("晚到的 create 章节只写入原作品缓存，绝不进新作品列表（A→B）", async () => {
    stubChapterLists();
    const pending = deferred<Chapter>();
    mocks.chaptersCreate.mockReturnValue(pending.promise);
    const { client, wrapper } = harness();

    const { result, rerender } = renderHook(({ workId }: { workId: string }) => useChapters(workId), {
      wrapper,
      initialProps: { workId: "wA" },
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let createPromise!: Promise<Chapter>;
    act(() => {
      createPromise = result.current.create({ title: "A 的章节" });
    });
    // 切换作品：TanStack 会把 pending mutation 的 options 更新成新闭包。
    rerender({ workId: "wB" });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      pending.resolve(chapterA);
      await createPromise;
    });

    // 网络路由用的是调用时冻结的作品。
    expect(mocks.chaptersCreate).toHaveBeenCalledWith("wA", { title: "A 的章节" });
    // 章节进了原作品缓存。
    expect(
      client.getQueryData<{ items: Chapter[] }>(workKeys.chapters("wA"))?.items.map((item) => item.id),
    ).toContain("chapter-a");
    // 新作品缓存里只有它自己的章节。
    expect(
      client.getQueryData<{ items: Chapter[] }>(workKeys.chapters("wB"))?.items.map((item) => item.id),
    ).toEqual(["chapter-b"]);
  });

  it("A→B→A：切回原作品后，上一代 create 的结果也只会写入原作品缓存", async () => {
    stubChapterLists();
    const pending = deferred<Chapter>();
    mocks.chaptersCreate.mockReturnValue(pending.promise);
    const { client, wrapper } = harness();
    const setQueryData = vi.spyOn(client, "setQueryData");

    const { result, rerender } = renderHook(({ workId }: { workId: string }) => useChapters(workId), {
      wrapper,
      initialProps: { workId: "wA" },
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let createPromise!: Promise<Chapter>;
    act(() => {
      createPromise = result.current.create({ title: "A 的章节" });
    });

    rerender({ workId: "wB" });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    rerender({ workId: "wA" });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      pending.resolve(chapterA);
      await createPromise;
    });

    // 缓存写入的目标始终是创建时的 wA，且恰好写入一次。
    const written = setQueryData.mock.calls.filter(
      ([key]) => JSON.stringify(key) === JSON.stringify(workKeys.chapters("wA")),
    );
    expect(written).toHaveLength(1);
    const updater = written[0]?.[1] as (previous: { items: Chapter[] } | undefined) => { items: Chapter[] };
    expect(updater({ items: [] }).items.map((item) => item.id)).toEqual(["chapter-a"]);
    // 没有任何写入落到 wB。
    expect(
      setQueryData.mock.calls.some(
        ([key]) => JSON.stringify(key) === JSON.stringify(workKeys.chapters("wB")),
      ),
    ).toBe(false);
  });

  it("晚到的大纲保存只失效原作品 query（A→B）", async () => {
    mocks.outlineGet.mockResolvedValue(outlineA);
    const pending = deferred<SaveResult>();
    mocks.outlineSave.mockReturnValue(pending.promise);
    const { client, wrapper } = harness();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    const { result, rerender } = renderHook(({ workId }: { workId: string }) => useOutline(workId), {
      wrapper,
      initialProps: { workId: "wA" },
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let savePromise!: Promise<SaveResult>;
    act(() => {
      savePromise = result.current.save({ text: "新大纲", expectedVersion: 3 });
    });
    rerender({ workId: "wB" });
    await waitFor(() => expect(result.current.outline).toBeNull());

    await act(async () => {
      pending.resolve({ status: "saved", version: 4 });
      await savePromise;
    });

    expect(mocks.outlineSave).toHaveBeenCalledWith("wA", { text: "新大纲", expectedVersion: 3 });
    const keys = invalidate.mock.calls.map(([filters]) => (filters as { queryKey: unknown }).queryKey);
    expect(keys).toContainEqual(workKeys.outline("wA"));
    expect(keys).not.toContainEqual(workKeys.outline("wB"));
  });

  it("晚到的章节保存只失效原作品/原章节，且异常不回写其它作品", async () => {
    mocks.chaptersGet.mockResolvedValue(chapterA);
    mocks.chaptersVersions.mockResolvedValue({ items: [] });
    const pending = deferred<SaveResult>();
    mocks.chaptersSave.mockReturnValue(pending.promise);
    const { client, wrapper } = harness();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    const { result, rerender } = renderHook(
      ({ workId, chapterId }: { workId: string; chapterId: string }) => useChapter(workId, chapterId),
      { wrapper, initialProps: { workId: "wA", chapterId: "chapter-a" } },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let savePromise!: Promise<SaveResult>;
    act(() => {
      savePromise = result.current.save({ text: "A 章节新正文", expectedVersion: 1 });
    });
    rerender({ workId: "wB", chapterId: "chapter-b" });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      pending.resolve({ status: "saved", version: 2 });
      await savePromise;
    });

    expect(mocks.chaptersSave).toHaveBeenCalledWith("wA", "chapter-a", {
      text: "A 章节新正文",
      expectedVersion: 1,
    });
    const keys = invalidate.mock.calls.map(([filters]) => (filters as { queryKey: unknown }).queryKey);
    expect(keys).toContainEqual(workKeys.chapters("wA"));
    expect(keys).toContainEqual(workKeys.chapterVersions("wA", "chapter-a"));
    // chapters 前缀失效包含详情：五秒 staleTime 内切回 A 也必须重新读取，B 则不受影响。
    expect(client.getQueryState(workKeys.chapter("wA", "chapter-a"))?.isInvalidated).toBe(true);
    expect(client.getQueryState(workKeys.chapter("wB", "chapter-b"))?.isInvalidated).toBe(false);
    expect(keys).not.toContainEqual(workKeys.chapters("wB"));
    expect(keys).not.toContainEqual(workKeys.chapterVersions("wB", "chapter-b"));
    // 没有任何跨作品缓存写入。
    expect(client.getQueryData(workKeys.chapter("wA", "chapter-a"))).toEqual(chapterA);
  });

  it("晚到的 create/remove 会话只失效原作品会话列表（A→B）", async () => {
    mocks.sessionsList.mockImplementation((workId: string) =>
      Promise.resolve({ items: workId === "wA" ? [] : [sessionA] }),
    );
    const pendingCreate = deferred<NovelSession>();
    const pendingRemove = deferred<null>();
    mocks.sessionsCreate.mockReturnValue(pendingCreate.promise);
    mocks.sessionsRemove.mockReturnValue(pendingRemove.promise);
    const { client, wrapper } = harness();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    const { result, rerender } = renderHook(({ workId }: { workId: string }) => useSessions(workId), {
      wrapper,
      initialProps: { workId: "wA" },
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let createPromise!: Promise<NovelSession>;
    let removePromise!: Promise<null>;
    act(() => {
      createPromise = result.current.create("novel-outline");
      removePromise = result.current.remove("session-old");
    });
    rerender({ workId: "wB" });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      pendingCreate.resolve(sessionA);
      pendingRemove.resolve(null);
      await Promise.all([createPromise, removePromise]);
    });

    expect(mocks.sessionsCreate).toHaveBeenCalledWith("wA", "novel-outline");
    expect(mocks.sessionsRemove).toHaveBeenCalledWith("session-old");
    const keys = invalidate.mock.calls.map(([filters]) => (filters as { queryKey: unknown }).queryKey);
    expect(keys).toContainEqual(workKeys.sessions("wA"));
    expect(keys).not.toContainEqual(workKeys.sessions("wB"));
    expect(client.getQueryData(workKeys.sessions("wB"))).toEqual({ items: [sessionA] });
  });

  it("晚到的设定条目创建只失效原作品 bible query（A→B）", async () => {
    mocks.bibleList.mockResolvedValue({ items: [] });
    const pending = deferred<BibleEntry>();
    mocks.bibleCreate.mockReturnValue(pending.promise);
    const { client, wrapper } = harness();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    const { result, rerender } = renderHook(
      ({ workId }: { workId: string }) => useBible(workId, ""),
      { wrapper, initialProps: { workId: "wA" } },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let createPromise!: Promise<BibleEntry>;
    act(() => {
      createPromise = result.current.create({ kind: "character", title: "A 条目", text: "正文" });
    });
    rerender({ workId: "wB" });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      pending.resolve(entryA);
      await createPromise;
    });

    expect(mocks.bibleCreate).toHaveBeenCalledWith("wA", { kind: "character", title: "A 条目", text: "正文" });
    const keys = invalidate.mock.calls.map(([filters]) => (filters as { queryKey: unknown }).queryKey);
    expect(keys).toContainEqual(["works", "wA", "bible"]);
    expect(keys).not.toContainEqual(["works", "wB", "bible"]);
  });

  it("晚到的 create 失败不会把章节写进任何作品缓存，也不触发失效", async () => {
    stubChapterLists();
    const pending = deferred<Chapter>();
    mocks.chaptersCreate.mockReturnValue(pending.promise);
    const { client, wrapper } = harness();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    const { result, rerender } = renderHook(({ workId }: { workId: string }) => useChapters(workId), {
      wrapper,
      initialProps: { workId: "wA" },
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let createPromise!: Promise<Chapter>;
    act(() => {
      createPromise = result.current.create({ title: "会失败的章节" });
    });
    rerender({ workId: "wB" });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      pending.reject(new Error("BFF 故障"));
      await expect(createPromise).rejects.toThrow("BFF 故障");
    });

    expect(
      client.getQueryData<{ items: Chapter[] }>(workKeys.chapters("wA"))?.items.map((item) => item.id),
    ).toEqual([]);
    expect(
      client.getQueryData<{ items: Chapter[] }>(workKeys.chapters("wB"))?.items.map((item) => item.id),
    ).toEqual(["chapter-b"]);
    const keys = invalidate.mock.calls.map(([filters]) => (filters as { queryKey: unknown }).queryKey);
    expect(keys).not.toContainEqual(workKeys.chapters("wB"));
  });
});

/**
 * 归档与创建/删除一样，必须把**调用当时的作品 identity** 冻结进 results/cache：
 * 晚到的归档回包只能写回原作品的会话缓存，不能覆盖用户后来切到的作品。
 */
describe("useSessions archive 目标冻结：晚到归档结果不得写到别的作品缓存", () => {
  it("晚到的 archive 只写原作品缓存（A→B），且只替换同 id 条目", async () => {
    mocks.sessionsList.mockImplementation((workId: string) =>
      Promise.resolve({ items: workId === "wA" ? [sessionA, sessionA2] : [sessionB] }),
    );
    const pending = deferred<NovelSession>();
    mocks.sessionsArchive.mockReturnValue(pending.promise);
    const { client, wrapper } = harness();
    const setQueryData = vi.spyOn(client, "setQueryData");
    const invalidate = vi.spyOn(client, "invalidateQueries");

    const { result, rerender } = renderHook(({ workId }: { workId: string }) => useSessions(workId), {
      wrapper,
      initialProps: { workId: "wA" },
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let archivePromise!: Promise<NovelSession>;
    act(() => {
      archivePromise = result.current.archive("session-a", true);
    });
    rerender({ workId: "wB" });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      pending.resolve({ ...sessionA, archivedAt: ARCHIVED_AT });
      await archivePromise;
    });

    expect(mocks.sessionsArchive).toHaveBeenCalledWith("session-a", true);

    const writesToA = setQueryData.mock.calls.filter(
      ([key]) => JSON.stringify(key) === JSON.stringify(workKeys.sessions("wA")),
    );
    expect(writesToA).toHaveLength(1);
    const updater = writesToA[0]?.[1] as (
      previous: { items: NovelSession[] } | undefined,
    ) => { items: NovelSession[] };
    const next = updater({ items: [sessionA, sessionA2] });
    expect(next.items.find((item) => item.id === "session-a")?.archivedAt).toBe(ARCHIVED_AT);
    // 同作品里的其它会话原样保留。
    expect(next.items.find((item) => item.id === "session-a2")?.archivedAt).toBeUndefined();

    // 没有任何写入落到 wB。
    expect(
      setQueryData.mock.calls.some(
        ([key]) => JSON.stringify(key) === JSON.stringify(workKeys.sessions("wB")),
      ),
    ).toBe(false);
    const keys = invalidate.mock.calls.map(([filters]) => (filters as { queryKey: unknown }).queryKey);
    expect(keys).toContainEqual(workKeys.sessions("wA"));
    expect(keys).not.toContainEqual(workKeys.sessions("wB"));
  });

  it("A→B→A：切回原作品后，上一代 archive 的结果也只写原作品缓存且恰好一次", async () => {
    mocks.sessionsList.mockImplementation((workId: string) =>
      Promise.resolve({ items: workId === "wA" ? [sessionA] : [sessionB] }),
    );
    const pending = deferred<NovelSession>();
    mocks.sessionsArchive.mockReturnValue(pending.promise);
    const { client, wrapper } = harness();
    const setQueryData = vi.spyOn(client, "setQueryData");

    const { result, rerender } = renderHook(({ workId }: { workId: string }) => useSessions(workId), {
      wrapper,
      initialProps: { workId: "wA" },
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let archivePromise!: Promise<NovelSession>;
    act(() => {
      archivePromise = result.current.archive("session-a", true);
    });

    rerender({ workId: "wB" });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    rerender({ workId: "wA" });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      pending.resolve({ ...sessionA, archivedAt: ARCHIVED_AT });
      await archivePromise;
    });

    const writesToA = setQueryData.mock.calls.filter(
      ([key]) => JSON.stringify(key) === JSON.stringify(workKeys.sessions("wA")),
    );
    expect(writesToA).toHaveLength(1);
    expect(
      setQueryData.mock.calls.some(
        ([key]) => JSON.stringify(key) === JSON.stringify(workKeys.sessions("wB")),
      ),
    ).toBe(false);
  });

  it("同作品归档：服务端返回的 archivedAt 留在列表里，且不影响相邻会话", async () => {
    let archived = false;
    mocks.sessionsList.mockImplementation((workId: string) =>
      Promise.resolve({ items: workId === "wA" ? (archived ? [{ ...sessionA, archivedAt: ARCHIVED_AT }, sessionA2] : [sessionA, sessionA2]) : [] }),
    );
    mocks.sessionsArchive.mockImplementation(async () => {
      archived = true;
      return { ...sessionA, archivedAt: ARCHIVED_AT };
    });
    const { client, wrapper } = harness();

    const { result } = renderHook(({ workId }: { workId: string }) => useSessions(workId), {
      wrapper,
      initialProps: { workId: "wA" },
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let returned!: NovelSession;
    await act(async () => {
      returned = await result.current.archive("session-a", true);
    });

    expect(returned.archivedAt).toBe(ARCHIVED_AT);
    const items = client.getQueryData<{ items: NovelSession[] }>(workKeys.sessions("wA"))?.items ?? [];
    expect(items.find((item) => item.id === "session-a")?.archivedAt).toBe(ARCHIVED_AT);
    expect(items.find((item) => item.id === "session-a2")?.archivedAt).toBeUndefined();
    // 归档是展示元数据：status 不变，仍然可以恢复。
    expect(items.find((item) => item.id === "session-a")?.status).toBe("active");
  });

  it("晚到 archive 失败：不写任何作品缓存、不失效任何会话列表，并暴露可读错误", async () => {
    mocks.sessionsList.mockImplementation((workId: string) =>
      Promise.resolve({ items: workId === "wA" ? [sessionA] : [sessionB] }),
    );
    const pending = deferred<NovelSession>();
    mocks.sessionsArchive.mockReturnValue(pending.promise);
    const { client, wrapper } = harness();
    const setQueryData = vi.spyOn(client, "setQueryData");
    const invalidate = vi.spyOn(client, "invalidateQueries");

    const { result, rerender } = renderHook(({ workId }: { workId: string }) => useSessions(workId), {
      wrapper,
      initialProps: { workId: "wA" },
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let archivePromise!: Promise<NovelSession>;
    act(() => {
      archivePromise = result.current.archive("session-a", true);
    });
    rerender({ workId: "wB" });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      pending.reject(new Error("归档失败"));
      await expect(archivePromise).rejects.toThrow("归档失败");
    });

    const sessionWrites = setQueryData.mock.calls.filter(([key]) =>
      JSON.stringify(key) === JSON.stringify(workKeys.sessions("wA")) ||
      JSON.stringify(key) === JSON.stringify(workKeys.sessions("wB")),
    );
    expect(sessionWrites).toHaveLength(0);
    const keys = invalidate.mock.calls.map(([filters]) => (filters as { queryKey: unknown }).queryKey);
    expect(keys).not.toContainEqual(workKeys.sessions("wA"));
    expect(keys).not.toContainEqual(workKeys.sessions("wB"));
    await waitFor(() => expect(result.current.archiveError).toBe("归档失败"));
  });
});
