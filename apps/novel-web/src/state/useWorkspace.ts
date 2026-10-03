import type { BibleEntry, Chapter, NovelPreset, NovelSession, SaveResult } from "@myrix/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { sessions, works } from "../api/endpoints";
import { describeError } from "../api/errors";
import { workKeys } from "./useWorks";

/**
 * 每个 mutation 都把**调用当时的**目标 identity 冻结进 variables/context。
 *
 * TanStack Query 的 `MutationObserver.setOptions` 会在组件重渲染时把 `pending`
 * mutation 的 options 更新为最新闭包，因此在途 mutation 的 `onSuccess` 若直接读
 * `workId`/`chapterId`，切作品/切章节后会读到**新**目标：晚到的旧作品结果会被
 * 写进新作品的缓存（例如把旧章节塞进新作品列表）。所以：
 *
 * - 网络路由用 variables 里冻结的目标，而不是重渲染后的闭包；
 * - 缓存写入/失效用 variables/context 里冻结的目标；
 * - 对外 `create/save/remove` 的签名保持不变（目标仍是 hook 参数）。
 */

interface ScopedWork {
  workId: string;
}

interface OutlineSaveVars extends ScopedWork {
  text: string;
  expectedVersion: number;
}

interface ChapterCreateVars extends ScopedWork {
  title: string;
}

interface ChapterSaveVars extends ScopedWork {
  chapterId: string;
  text: string;
  expectedVersion: number;
}

interface BibleCreateVars extends ScopedWork {
  kind: BibleEntry["kind"];
  title: string;
  text: string;
}

interface BibleSaveVars extends ScopedWork {
  entryId: string;
  text: string;
  expectedVersion: number;
}

interface SessionCreateVars extends ScopedWork {
  preset: NovelPreset;
}

interface SessionRemoveVars extends ScopedWork {
  sessionId: string;
}

/** 目标 identity 缺失时不允许发请求；调用方在 UI 上已按 workId 门控。 */
function requireTarget(workId: string | null): string {
  if (!workId) throw new Error("尚未选择作品");
  return workId;
}

export function useOutline(workId: string | null) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: workKeys.outline(workId ?? "none"),
    queryFn: ({ signal }) => works.outline.get(workId as string, signal),
    enabled: Boolean(workId),
  });

  const saveMutation = useMutation({
    mutationFn: (variables: OutlineSaveVars) =>
      works.outline.save(variables.workId, {
        text: variables.text,
        expectedVersion: variables.expectedVersion,
      }),
    onSuccess: (_result: SaveResult, variables) => {
      // 一律以服务端为准重新读取：不要用本地文本做乐观写入，
      // 否则编辑器会把刚保存的正文反过来覆盖成服务端的旧文本。
      // 失效的是**提交时的作品**：晚到的结果不会打到切换后的作品上。
      queryClient.invalidateQueries({ queryKey: workKeys.outline(variables.workId) });
    },
  });

  return {
    outline: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error ? describeError(query.error).message : null,
    refetch: query.refetch,
    save: (input: { text: string; expectedVersion: number }) =>
      saveMutation.mutateAsync({ workId: requireTarget(workId), ...input }),
    saving: saveMutation.isPending,
    saveError: saveMutation.error,
  };
}

export function useChapters(workId: string | null) {
  const queryClient = useQueryClient();

  const listQuery = useQuery({
    queryKey: workKeys.chapters(workId ?? "none"),
    queryFn: ({ signal }) => works.chapters.list(workId as string, signal),
    enabled: Boolean(workId),
  });

  const createMutation = useMutation({
    mutationFn: (variables: ChapterCreateVars) => works.chapters.create(variables.workId, { title: variables.title }),
    onSuccess: (chapter, variables) => {
      // 只写入**创建时所属作品**的列表：切换作品后晚到的章节绝不能进新作品缓存。
      queryClient.setQueryData<{ items: Chapter[] }>(workKeys.chapters(variables.workId), (previous) => ({
        items: [...(previous?.items ?? []), chapter],
      }));
      queryClient.invalidateQueries({ queryKey: workKeys.chapters(variables.workId) });
    },
  });

  return {
    items: listQuery.data?.items ?? [],
    isLoading: listQuery.isLoading,
    error: listQuery.error ? describeError(listQuery.error).message : null,
    refetch: listQuery.refetch,
    create: (input: { title: string }) =>
      createMutation.mutateAsync({ workId: requireTarget(workId), ...input }),
    createPending: createMutation.isPending,
    createError: createMutation.error ? describeError(createMutation.error).message : null,
  };
}

export function useChapter(workId: string | null, chapterId: string | null) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: workKeys.chapter(workId ?? "none", chapterId ?? "none"),
    queryFn: ({ signal }) => works.chapters.get(workId as string, chapterId as string, signal),
    enabled: Boolean(workId && chapterId),
  });

  const saveMutation = useMutation({
    mutationFn: (variables: ChapterSaveVars) =>
      works.chapters.save(variables.workId, variables.chapterId, {
        text: variables.text,
        expectedVersion: variables.expectedVersion,
      }),
    onSuccess: (result: SaveResult, variables) => {
      const work = variables.workId;
      const chapter = variables.chapterId;
      if (result.status === "conflict") {
        queryClient.invalidateQueries({ queryKey: workKeys.chapter(work, chapter) });
        queryClient.invalidateQueries({ queryKey: workKeys.chapterVersions(work, chapter) });
        return;
      }
      queryClient.invalidateQueries({ queryKey: workKeys.chapters(work) });
      queryClient.invalidateQueries({ queryKey: workKeys.chapterVersions(work, chapter) });
    },
  });

  const versionsQuery = useQuery({
    queryKey: workKeys.chapterVersions(workId ?? "none", chapterId ?? "none"),
    queryFn: ({ signal }) => works.chapters.versions(workId as string, chapterId as string, signal),
    enabled: Boolean(workId && chapterId),
  });

  return {
    chapter: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error ? describeError(query.error).message : null,
    refetch: query.refetch,
    save: (input: { text: string; expectedVersion: number }) =>
      saveMutation.mutateAsync({
        workId: requireTarget(workId),
        chapterId: requireTarget(chapterId),
        ...input,
      }),
    saving: saveMutation.isPending,
    saveError: saveMutation.error,
    versions: versionsQuery.data?.items ?? [],
    versionsLoading: versionsQuery.isLoading,
    versionsError: versionsQuery.error ? describeError(versionsQuery.error).message : null,
  };
}

export function useBible(workId: string | null, query: string) {
  const queryClient = useQueryClient();

  const listQuery = useQuery({
    queryKey: workKeys.bible(workId ?? "none", query),
    queryFn: ({ signal }) => works.bible.list(workId as string, query, signal),
    enabled: Boolean(workId),
    // 检索是查询而不是同步：结果不会用于覆盖编辑中的条目草稿。
    // 条目内容以 GET /works/:id/bible 之外的单条读取为准（本应用用列表结果作为快照），
    // 因此这里显式声明行为，避免被后续“自动同步”改动误伤。
  });

  const createMutation = useMutation({
    mutationFn: (variables: BibleCreateVars) =>
      works.bible.create(variables.workId, {
        kind: variables.kind,
        title: variables.title,
        text: variables.text,
      }),
    onSuccess: (_result, variables) =>
      queryClient.invalidateQueries({ queryKey: ["works", variables.workId, "bible"] }),
  });

  const saveMutation = useMutation({
    mutationFn: (variables: BibleSaveVars) =>
      works.bible.save(variables.workId, variables.entryId, {
        text: variables.text,
        expectedVersion: variables.expectedVersion,
      }),
    onSuccess: (_result: SaveResult, variables) =>
      queryClient.invalidateQueries({ queryKey: ["works", variables.workId, "bible"] }),
  });

  return {
    items: listQuery.data?.items ?? [],
    isLoading: listQuery.isLoading,
    error: listQuery.error ? describeError(listQuery.error).message : null,
    refetch: listQuery.refetch,
    create: (input: { kind: BibleEntry["kind"]; title: string; text: string }) =>
      createMutation.mutateAsync({ workId: requireTarget(workId), ...input }),
    createPending: createMutation.isPending,
    createError: createMutation.error ? describeError(createMutation.error).message : null,
    save: (input: { entryId: string; text: string; expectedVersion: number }) =>
      saveMutation.mutateAsync({ workId: requireTarget(workId), ...input }),
    saving: saveMutation.isPending,
    saveError: saveMutation.error,
  };
}

export function useSessions(workId: string | null) {
  const queryClient = useQueryClient();

  const listQuery = useQuery({
    queryKey: workKeys.sessions(workId ?? "none"),
    queryFn: ({ signal }) => sessions.list(workId as string, signal),
    enabled: Boolean(workId),
  });

  const createMutation = useMutation({
    mutationFn: (variables: SessionCreateVars) => sessions.create(variables.workId, variables.preset),
    onSuccess: (_session, variables) =>
      queryClient.invalidateQueries({ queryKey: workKeys.sessions(variables.workId) }),
  });

  const archiveMutation = useMutation({
    mutationFn: (variables: SessionRemoveVars & { archived: boolean }) => sessions.archive(variables.sessionId, variables.archived),
    onSuccess: (session, variables) => {
      queryClient.setQueryData<{ items: NovelSession[] }>(workKeys.sessions(variables.workId), (previous) =>
        previous ? { items: previous.items.map((item) => item.id === session.id ? session : item) } : previous);
      queryClient.invalidateQueries({ queryKey: workKeys.sessions(variables.workId) });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (variables: SessionRemoveVars) => sessions.remove(variables.sessionId),
    onSuccess: (_result, variables) =>
      queryClient.invalidateQueries({ queryKey: workKeys.sessions(variables.workId) }),
  });

  return {
    items: listQuery.data?.items ?? [],
    isLoading: listQuery.isLoading,
    error: listQuery.error ? describeError(listQuery.error).message : null,
    refetch: listQuery.refetch,
    create: (preset: NovelPreset) => createMutation.mutateAsync({ workId: requireTarget(workId), preset }),
    createPending: createMutation.isPending,
    createError: createMutation.error ? describeError(createMutation.error).message : null,
    archive: (sessionId: string, archived: boolean) => archiveMutation.mutateAsync({ workId: requireTarget(workId), sessionId, archived }),
    archivePending: archiveMutation.isPending,
    archiveError: archiveMutation.error ? describeError(archiveMutation.error).message : null,
    remove: (sessionId: string) => removeMutation.mutateAsync({ workId: requireTarget(workId), sessionId }),
    removePending: removeMutation.isPending,
    removeError: removeMutation.error ? describeError(removeMutation.error).message : null,
  };
}

export type { Chapter, NovelSession };
