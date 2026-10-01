import type { Work } from "@myrix/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { works } from "../api/endpoints";
import { describeError } from "../api/errors";

export const workKeys = {
  all: ["works"] as const,
  detail: (workId: string) => ["works", workId] as const,
  outline: (workId: string) => ["works", workId, "outline"] as const,
  chapters: (workId: string) => ["works", workId, "chapters"] as const,
  chapter: (workId: string, chapterId: string) => ["works", workId, "chapters", chapterId] as const,
  chapterVersions: (workId: string, chapterId: string) =>
    ["works", workId, "chapters", chapterId, "versions"] as const,
  bible: (workId: string, query: string) => ["works", workId, "bible", query] as const,
  sessions: (workId: string) => ["works", workId, "sessions"] as const,
};

export function useWorks() {
  const queryClient = useQueryClient();

  const listQuery = useQuery({
    queryKey: workKeys.all,
    queryFn: ({ signal }) => works.list(signal),
  });

  const createMutation = useMutation({
    mutationFn: (input: { title: string; description: string }) => works.create(input),
    onSuccess: (work) => {
      queryClient.setQueryData<{ items: Work[] }>(workKeys.all, (previous) => ({
        items: [...(previous?.items ?? []), work],
      }));
      queryClient.invalidateQueries({ queryKey: workKeys.all });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (workId: string) => works.remove(workId),
    onSuccess: (_result, workId) => {
      queryClient.removeQueries({ queryKey: workKeys.detail(workId) });
      queryClient.invalidateQueries({ queryKey: workKeys.all });
    },
  });

  return {
    items: listQuery.data?.items ?? [],
    isLoading: listQuery.isLoading,
    error: listQuery.error ? describeError(listQuery.error).message : null,
    refetch: listQuery.refetch,
    create: createMutation.mutateAsync,
    createPending: createMutation.isPending,
    createError: createMutation.error ? describeError(createMutation.error).message : null,
    remove: deleteMutation.mutateAsync,
    removePending: deleteMutation.isPending,
    removeError: deleteMutation.error ? describeError(deleteMutation.error).message : null,
  };
}
