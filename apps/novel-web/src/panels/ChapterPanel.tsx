import type { Chapter } from "@myrix/contracts";
import { useState } from "react";

import { Banner, EmptyHint } from "../components/common";
import { ConflictBanner } from "../components/ConflictBanner";
import { ChapterAssistantContext } from "../components/ChapterAssistantContext";
import { Icon } from "../components/Icon";
import { PlainTextEditor } from "../components/PlainTextEditor";
import type { DraftEditor } from "../state/useDraft";
import { formatTime } from "./format";

export interface ChapterNavProps {
  chapters: Chapter[];
  isLoading: boolean;
  error: string | null;
  selectedChapterId: string | null;
  /** 有未保存草稿的章节：目录里显式标注，切换走草稿前用户能看见代价。 */
  dirtyChapterId: string | null;
  /** 正在保存的章节。 */
  savingChapterId: string | null;
  onSelect: (chapterId: string) => void;
  onCreate: (title: string) => void;
  createPending: boolean;
  createError: string | null;
  onReload: () => void;
}

/** 章节条目的副标题：保存中/未保存优先于版本与时间。 */
function chapterSubtitle(
  chapter: Chapter,
  dirtyChapterId: string | null,
  savingChapterId: string | null,
): string {
  if (chapter.id === savingChapterId) return "保存中…";
  if (chapter.id === dirtyChapterId) return "有未保存修改";
  return `版本 ${chapter.version} · ${formatTime(chapter.updatedAt)}`;
}

/**
 * 左侧目录里的章节区：章节列表 + **收起的新建**。
 *
 * 这里只负责“选谁”和“建一个”，正文一律由中栏的 ChapterEditor 显示，
 * 目录里不再出现任何正文或大表单。一章都没有时新建表单直接展开：
 * 空列表下再让用户先点一次“新建章节”没有意义。
 */
export function ChapterNav({
  chapters,
  isLoading,
  error,
  selectedChapterId,
  dirtyChapterId,
  savingChapterId,
  onSelect,
  onCreate,
  createPending,
  createError,
  onReload,
}: ChapterNavProps) {
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const showCreateForm = creating || chapters.length === 0;

  return (
    <div className="stack nav-section" aria-label="章节目录">
      {error ? (
        <Banner level="error" actions={<button type="button" onClick={onReload}>重试</button>}>
          {error}
        </Banner>
      ) : null}
      {isLoading ? <EmptyHint>正在读取章节…</EmptyHint> : null}
      {!isLoading && chapters.length === 0 ? <EmptyHint>还没有章节。</EmptyHint> : null}

      <ul className="list nav-list">
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
                {chapterSubtitle(chapter, dirtyChapterId, savingChapterId)}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {showCreateForm ? (
        <form
          className="stack nav-create"
          aria-label="新建章节表单"
          onSubmit={(event) => {
            event.preventDefault();
            const next = title.trim();
            if (next.length === 0) return;
            onCreate(next);
            setTitle("");
          }}
        >
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="新章节标题"
            aria-label="新章节标题"
          />
          <div className="row">
            <button type="submit" className="primary" disabled={createPending || title.trim().length === 0}>
              {createPending ? "创建中…" : "新建章节"}
            </button>
            {chapters.length > 0 ? (
              <button type="button" onClick={() => setCreating(false)}>
                收起
              </button>
            ) : null}
          </div>
        </form>
      ) : (
        <button type="button" className="nav-create-toggle" onClick={() => setCreating(true)}>
          <Icon name="plus" size={14} /> 新建章节
        </button>
      )}
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
