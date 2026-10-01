import type { Chapter } from "@myrix/contracts";
import { useState } from "react";

import { Banner, EmptyHint } from "../components/common";
import { ConflictBanner } from "../components/ConflictBanner";
import { ChapterAssistantContext } from "../components/ChapterAssistantContext";
import { PlainTextEditor } from "../components/PlainTextEditor";
import type { DraftEditor } from "../state/useDraft";
import { formatTime } from "./format";

export interface ChapterListProps {
  chapters: Chapter[];
  isLoading: boolean;
  error: string | null;
  selectedChapterId: string | null;
  onSelect: (chapterId: string) => void;
  onCreate: (title: string) => void;
  createPending: boolean;
  createError: string | null;
  onReload: () => void;
}

export function ChapterList({
  chapters,
  isLoading,
  error,
  selectedChapterId,
  onSelect,
  onCreate,
  createPending,
  createError,
  onReload,
}: ChapterListProps) {
  const [title, setTitle] = useState("");

  return (
    <div className="stack">
      {error ? (
        <Banner level="error" actions={<button type="button" onClick={onReload}>重试</button>}>
          {error}
        </Banner>
      ) : null}
      <ul className="list">
        {chapters.map((chapter) => (
          <li key={chapter.id}>
            <button
              type="button"
              className="item"
              aria-current={chapter.id === selectedChapterId}
              onClick={() => onSelect(chapter.id)}
            >
              {chapter.title}
              <span className="item-sub">
                版本 {chapter.version} · {formatTime(chapter.updatedAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {!isLoading && chapters.length === 0 ? <EmptyHint>还没有章节。</EmptyHint> : null}

      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          if (title.trim().length === 0) return;
          onCreate(title.trim());
          setTitle("");
        }}
      >
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="新章节标题"
          aria-label="新章节标题"
        />
        <button type="submit" disabled={createPending || title.trim().length === 0}>
          {createPending ? "创建中…" : "新建章节"}
        </button>
      </form>
      {createError ? <Banner level="error">{createError}</Banner> : null}
    </div>
  );
}

export interface ChapterEditorProps {
  chapter: Chapter | null;
  isLoading: boolean;
  loadError: string | null;
  editor: DraftEditor<Chapter>;
  versions: { version: number; text: string; createdAt: string }[];
  versionsLoading: boolean;
  versionsError: string | null;
  onReload: () => void;
}

/** 章节正文编辑 + 历史版本 + 冲突处理。 */
export function ChapterEditor({
  chapter,
  isLoading,
  loadError,
  editor,
  versions,
  versionsLoading,
  versionsError,
  onReload,
}: ChapterEditorProps) {
  if (isLoading) return <EmptyHint>正在读取章节…</EmptyHint>;
  if (loadError) {
    return (
      <Banner level="error" actions={<button type="button" onClick={onReload}>重试</button>}>
        {loadError}
      </Banner>
    );
  }
  if (!chapter || !editor.draft) return <EmptyHint>请选择或新建一个章节。</EmptyHint>;

  return (
    <div className="editor">
      <div className="toolbar">
        <span className="small muted">
          {chapter.title} · 已保存版本 {editor.draft.base?.version ?? 0}
          {editor.dirty ? " · 有未保存修改" : " · 无未保存修改"}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="primary"
          disabled={editor.saving || !editor.dirty}
          onClick={() => void editor.save()}
        >
          {editor.saving ? "保存中…" : "保存"}
        </button>
      </div>

      {editor.notice ? (
        <Banner level="ok" actions={<button type="button" onClick={editor.dismissNotice}>知道了</button>}>
          {editor.notice}
        </Banner>
      ) : null}
      {editor.error ? (
        <Banner level="error" actions={<button type="button" onClick={editor.clearError}>关闭</button>}>
          {editor.error}
        </Banner>
      ) : null}
      {editor.serverAhead && !editor.conflict ? (
        <Banner level="warn">
          服务端已有更新的版本 {editor.draft.server?.version}（本地基线为 {editor.draft.base?.version}）。
          保存会返回冲突，本地内容不会被覆盖。
        </Banner>
      ) : null}
      {editor.conflict ? (
        <ConflictBanner
          conflict={editor.conflict}
          serverText={editor.draft.server?.text ?? null}
          serverVersion={editor.draft.server?.version ?? null}
          reloading={isLoading}
          saving={editor.saving}
          onReload={() => {
            onReload();
            void editor.reloadServer();
          }}
          onTakeServer={editor.takeServer}
          onSaveOverwrite={() => {
            const version = editor.draft?.server?.version;
            if (version !== undefined) void editor.save(version);
          }}
        />
      ) : null}

      <details className="versions" key={`${chapter.workId}:${chapter.id}`}>
        <summary className="small">章节助手上下文（查看与复制）</summary>
        <ChapterAssistantContext
          chapter={{ id: chapter.id, workId: chapter.workId, title: chapter.title }}
          dirty={editor.dirty}
        />
      </details>

      <PlainTextEditor
        value={editor.draft.text}
        onChange={editor.setText}
        placeholder="在这里写章节正文。纯文本保存。"
        ariaLabel={`章节正文：${chapter.title}`}
      />

      <details className="versions">
        <summary className="small">历史版本（{versions.length}）</summary>
        {versionsLoading ? <EmptyHint>正在读取版本…</EmptyHint> : null}
        {versionsError ? <Banner level="error">{versionsError}</Banner> : null}
        {!versionsLoading && versions.length === 0 ? <EmptyHint>暂无历史版本。</EmptyHint> : null}
        <ul className="list">
          {versions.map((version) => (
            <li key={version.version}>
              <details>
                <summary className="small">
                  版本 {version.version} · {formatTime(version.createdAt)}
                </summary>
                <pre className="code">{version.text}</pre>
              </details>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
