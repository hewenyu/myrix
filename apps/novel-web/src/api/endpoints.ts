import type {
  BibleEntry,
  BibleKind,
  Chapter,
  NovelPreset,
  NovelSession,
  Outline,
  PlatformIdentity,
  QueuedCommand,
  SaveResult,
  Work,
} from "@myrix/contracts";

import { requestJson } from "./http";

/** 路径严格对齐 docs/implementation/bff-api.md，不新增发明路径。 */

export interface ListEnvelope<T> {
  items: T[];
}

export interface AuthConfig {
  mode: "oidc" | "development";
  loginUrl: string;
}

export interface AuthSession {
  identity: PlatformIdentity;
  csrfToken: string;
  mode: "oidc" | "development";
}

/** 服务端只承认这三种预置测试身份，前端不得提交任意 ID。 */
export type DevUser = "author" | "editor" | "other-tenant";

export interface ChapterVersion {
  version: number;
  text: string;
  createdAt: string;
}

export const auth = {
  config: (signal?: AbortSignal) =>
    requestJson<AuthConfig>("/auth/config", { signal, allowUnauthorized: true }),
  session: (signal?: AbortSignal) =>
    requestJson<AuthSession>("/auth/session", { signal, allowUnauthorized: true }),
  devLogin: (user: DevUser) =>
    requestJson<AuthSession>("/auth/dev-login", { method: "POST", body: { user }, allowUnauthorized: true }),
  logout: () => requestJson<null>("/auth/logout", { method: "POST" }),
};

export const works = {
  list: (signal?: AbortSignal) => requestJson<ListEnvelope<Work>>("/works", { signal }),
  create: (input: { title: string; description: string }) =>
    requestJson<Work>("/works", { method: "POST", body: input }),
  get: (workId: string, signal?: AbortSignal) => requestJson<Work>(`/works/${workId}`, { signal }),
  remove: (workId: string) => requestJson<null>(`/works/${workId}`, { method: "DELETE" }),
  outline: {
    get: (workId: string, signal?: AbortSignal) =>
      requestJson<Outline>(`/works/${workId}/outline`, { signal }),
    save: (workId: string, input: { text: string; expectedVersion: number }) =>
      requestJson<SaveResult>(`/works/${workId}/outline`, { method: "PUT", body: input }),
  },
  chapters: {
    list: (workId: string, signal?: AbortSignal) =>
      requestJson<ListEnvelope<Chapter>>(`/works/${workId}/chapters`, { signal }),
    create: (workId: string, input: { title: string }) =>
      requestJson<Chapter>(`/works/${workId}/chapters`, { method: "POST", body: input }),
    get: (workId: string, chapterId: string, signal?: AbortSignal) =>
      requestJson<Chapter>(`/works/${workId}/chapters/${chapterId}`, { signal }),
    save: (workId: string, chapterId: string, input: { text: string; expectedVersion: number }) =>
      requestJson<SaveResult>(`/works/${workId}/chapters/${chapterId}`, { method: "PUT", body: input }),
    versions: (workId: string, chapterId: string, signal?: AbortSignal) =>
      requestJson<ListEnvelope<ChapterVersion>>(`/works/${workId}/chapters/${chapterId}/versions`, { signal }),
  },
  bible: {
    list: (workId: string, query: string, signal?: AbortSignal) => {
      const suffix = query.trim().length > 0 ? `?query=${encodeURIComponent(query.trim())}` : "";
      return requestJson<ListEnvelope<BibleEntry>>(`/works/${workId}/bible${suffix}`, { signal });
    },
    create: (workId: string, input: { kind: BibleKind; title: string; text: string }) =>
      requestJson<BibleEntry>(`/works/${workId}/bible`, { method: "POST", body: input }),
    save: (workId: string, entryId: string, input: { text: string; expectedVersion: number }) =>
      requestJson<SaveResult>(`/works/${workId}/bible/${entryId}`, { method: "PUT", body: input }),
  },
};

export const sessions = {
  list: (workId: string, signal?: AbortSignal) =>
    requestJson<ListEnvelope<NovelSession>>(`/works/${workId}/sessions`, { signal }),
  create: (workId: string, preset: NovelPreset) =>
    requestJson<NovelSession>(`/works/${workId}/sessions`, { method: "POST", body: { preset } }),
  remove: (sessionId: string) => requestJson<null>(`/sessions/${sessionId}`, { method: "DELETE" }),
  archive: (sessionId: string, archived: boolean) =>
    requestJson<NovelSession>(`/sessions/${sessionId}`, { method: "PATCH", body: { archived } }),
  send: (sessionId: string, input: { commandId: string; text: string }) =>
    requestJson<QueuedCommand>(`/sessions/${sessionId}/messages`, { method: "POST", body: input }),
  cancel: (sessionId: string, commandId: string) =>
    requestJson<QueuedCommand>(`/sessions/${sessionId}/cancel`, { method: "POST", body: { commandId } }),
  eventsPath: (sessionId: string) => `/sessions/${sessionId}/events`,
};
