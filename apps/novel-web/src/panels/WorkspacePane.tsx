import type { BibleEntry, BibleKind, Chapter, Outline } from "@myrix/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { EmptyHint } from "../components/common";
import { useDraft } from "../state/useDraft";
import type { SelectionContext } from "../state/selectionContext";
import { useBible, useChapter, useChapters, useOutline } from "../state/useWorkspace";
import { BibleEditor } from "./BiblePanel";
import { BookNavigation, type BookSection } from "./BookNavigation";
import { ChapterEditor } from "./ChapterPanel";
import { OutlinePanel } from "./OutlinePanel";

export type { BookSection };

export interface WorkspacePaneProps {
  workId: string | null;
  workTitle: string | null;
  /**
   * 书内是否有未保存草稿（大纲/章节/设定任一）。顶层 App 用它决定“返回书架”是否先确认。
   * 卸载时一定会回调 false：草稿随实例消失，顶层不应继续持有过期的 dirty。
   */
  onDirtyChange?: (dirty: boolean) => void;
  onSelectionContextChange?: (context: SelectionContext | null) => void;
  onNavigateContent?: () => void;
}

/**
 * 切换编辑对象会换掉 `useDraft` 的 identity，本地草稿与冲突提示随之消失。
 * 有未保存草稿或正在保存时必须让用户显式确认，绝不静默丢弃。
 */
function confirmDiscardChanges(reason: "dirty" | "saving"): boolean {
  if (typeof window === "undefined" || typeof window.confirm !== "function") return true;
  const message =
    reason === "saving"
      ? "当前内容正在保存，切换后这次保存的结果与冲突提示将不再显示。确定要切换吗？"
      : "当前内容有未保存的修改，切换会丢失本地草稿。确定要切换吗？";
  return window.confirm(message);
}

/**
 * 书内工作区，返回两个并列的 grid 元素（Fragment）：
 * 左：书内目录 `BookNavigation`；中：`studio-main` 只显示所选内容。
 * 顶层 App 负责把它们放进三栏布局，并在“返回书架”时按 `onDirtyChange` 确认。
 */
export function WorkspacePane({ workId, workTitle, onDirtyChange, onSelectionContextChange, onNavigateContent }: WorkspacePaneProps) {
  const [section, setSection] = useState<BookSection>("outline");
  const [chapterId, setChapterId] = useState<string | null>(null);
  const [bibleEntryId, setBibleEntryId] = useState<string | null>(null);
  const [bibleQuery, setBibleQuery] = useState("");

  const outlineState = useOutline(workId);
  const chapterList = useChapters(workId);
  const chapterState = useChapter(workId, chapterId);
  const bibleState = useBible(workId, bibleQuery);

  const outlineEditor = useDraft<Outline>({
    identity: `outline:${workId ?? "none"}`,
    server: outlineState.outline,
    save: (input) => outlineState.save(input),
    reload: outlineState.refetch,
  });

  const chapterEditor = useDraft<Chapter>({
    identity: `chapter:${workId ?? "none"}:${chapterId ?? "none"}`,
    server: chapterState.chapter,
    save: (input) => chapterState.save(input),
    reload: chapterState.refetch,
  });

  const selectedBibleEntry = bibleState.items.find((entry) => entry.id === bibleEntryId) ?? null;
  const bibleEditor = useDraft<BibleEntry>({
    identity: `bible:${workId ?? "none"}:${bibleEntryId ?? "none"}`,
    server: selectedBibleEntry,
    save: (input) =>
      bibleState.save({
        entryId: bibleEntryId as string,
        text: input.text,
        expectedVersion: input.expectedVersion,
      }),
    reload: bibleState.refetch,
  });

  const dirty = outlineEditor.dirty || chapterEditor.dirty || bibleEditor.dirty;
  const activeEditor = section === "outline" ? outlineEditor : section === "chapters" ? chapterEditor : bibleEditor;
  const targetId = section === "outline" ? workId : section === "chapters" ? chapterId : bibleEntryId;
  const targetTitle = section === "outline" ? "故事大纲" : section === "chapters"
    ? chapterList.items.find((item) => item.id === chapterId)?.title ?? "当前章节"
    : selectedBibleEntry?.title ?? bibleEditor.draft?.base?.title ?? "当前设定";
  useLayoutEffect(() => {
    onSelectionContextChange?.(workId && targetId ? {
      kind: section === "chapters" ? "chapter" : section === "bible" ? "bible" : "outline",
      workId, id: targetId, title: targetTitle, dirty: activeEditor.dirty,
    } : null);
  }, [workId, section, targetId, targetTitle, activeEditor.dirty, onSelectionContextChange]);
  useEffect(() => {
    const saveKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      if (activeEditor.dirty && !activeEditor.saving && !activeEditor.conflict) void activeEditor.save();
    };
    window.addEventListener("keydown", saveKey);
    return () => window.removeEventListener("keydown", saveKey);
  }, [activeEditor]);

  /** 最新的草稿状态：异步回包（新建章节/条目）必须按“此刻”判断，而不是发起时的闭包。 */
  const chapterDirtyRef = useRef(chapterEditor.dirty);
  const chapterSavingRef = useRef(chapterEditor.saving);
  const bibleDirtyRef = useRef(bibleEditor.dirty);
  const bibleSavingRef = useRef(bibleEditor.saving);
  /** 用户（或已落地的新建回包）是否已经显式选过：书内首开建议不得覆盖它。 */
  const userSelectedRef = useRef(false);
  /** 每次显式选择推进代际；晚到的异步回包只在代际未变时落地。 */
  const selectionTokenRef = useRef(0);
  /** 书内首开建议每个作品只做一次。 */
  const autoSelectedWorkRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  useLayoutEffect(() => {
    chapterDirtyRef.current = chapterEditor.dirty;
    chapterSavingRef.current = chapterEditor.saving;
    bibleDirtyRef.current = bibleEditor.dirty;
    bibleSavingRef.current = bibleEditor.saving;
    mountedRef.current = true;
  });

  useLayoutEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const onDirtyChangeRef = useRef(onDirtyChange);
  useLayoutEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  });
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);
  useEffect(
    () => () => {
      onDirtyChangeRef.current?.(false);
    },
    [],
  );

  useEffect(() => {
    // 切换作品时清空选择并作废在途回包。WorkspacePane 已按 workId 加 key 重建，
    // 这里是同一实例被复用时（例如顶层改装配）的兜底。
    setSection("outline");
    setChapterId(null);
    setBibleEntryId(null);
    setBibleQuery("");
    userSelectedRef.current = false;
    selectionTokenRef.current += 1;
    autoSelectedWorkRef.current = null;
  }, [workId]);

  useEffect(() => {
    // 书内首开建议：章节列表第一次读完后，有章节就选第一项，没有就留在大纲。
    // 用户已先点过目录、或已有未保存草稿时绝不抢选择。这里只读取，不保存、不调用模型。
    if (!workId) return;
    if (autoSelectedWorkRef.current === workId) return;
    if (chapterList.isLoading) return;
    autoSelectedWorkRef.current = workId;
    if (userSelectedRef.current) return;
    if (chapterDirtyRef.current || chapterSavingRef.current) return;
    const first = chapterList.items[0];
    if (!first) {
      setSection("outline");
      return;
    }
    setChapterId(first.id);
    setSection("chapters");
  }, [workId, chapterList.isLoading, chapterList.items]);

  function selectSection(next: BookSection) {
    // 切换分区不会替换草稿 identity：章节/设定草稿都留在 WorkspacePane 状态里，不丢内容。
    userSelectedRef.current = true;
    selectionTokenRef.current += 1;
    setSection(next);
    onNavigateContent?.();
  }

  function selectOutline() {
    userSelectedRef.current = true;
    selectionTokenRef.current += 1;
    setSection("outline");
    onNavigateContent?.();
  }

  function selectChapter(nextChapterId: string) {
    if (nextChapterId === chapterId) {
      userSelectedRef.current = true;
      selectionTokenRef.current += 1;
      setSection("chapters");
      onNavigateContent?.();
      return;
    }
    // 换章节会重置章节草稿：有未保存内容时必须先确认。
    if (chapterSavingRef.current) {
      if (!confirmDiscardChanges("saving")) return;
    } else if (chapterDirtyRef.current) {
      if (!confirmDiscardChanges("dirty")) return;
    }
    userSelectedRef.current = true;
    selectionTokenRef.current += 1;
    setChapterId(nextChapterId);
    setSection("chapters");
    onNavigateContent?.();
  }

  function selectBibleEntry(nextEntryId: string) {
    if (nextEntryId === bibleEntryId) {
      userSelectedRef.current = true;
      selectionTokenRef.current += 1;
      setSection("bible");
      onNavigateContent?.();
      return;
    }
    if (bibleSavingRef.current) {
      if (!confirmDiscardChanges("saving")) return;
    } else if (bibleDirtyRef.current) {
      if (!confirmDiscardChanges("dirty")) return;
    }
    userSelectedRef.current = true;
    selectionTokenRef.current += 1;
    setBibleEntryId(nextEntryId);
    setSection("bible");
    onNavigateContent?.();
  }

  function createChapter(title: string) {
    // 发起新建本身也是一次显式选择：更早的在途新建回包不得再抢选择。
    selectionTokenRef.current += 1;
    const token = selectionTokenRef.current;
    chapterList.create({ title }).then(
      (chapter) => {
        // 迟到的回包绝不抢回用户在此期间的选择；已有未保存草稿时保留草稿、不切换编辑器。
        if (!mountedRef.current || selectionTokenRef.current !== token) return;
        if (chapterDirtyRef.current || chapterSavingRef.current) return;
        userSelectedRef.current = true;
        setChapterId(chapter.id);
        setSection("chapters");
        onNavigateContent?.();
      },
      () => undefined, // 失败原因由 createError 承载并由目录展示
    );
  }

  function createBibleEntry(input: { kind: BibleKind; title: string; text: string }) {
    selectionTokenRef.current += 1;
    const token = selectionTokenRef.current;
    bibleState.create(input).then(
      (entry) => {
        if (!mountedRef.current || selectionTokenRef.current !== token) return;
        if (bibleDirtyRef.current || bibleSavingRef.current) return;
        userSelectedRef.current = true;
        // 清掉检索词，保证刚创建的条目一定出现在目录里、中栏能立刻显示它。
        setBibleQuery("");
        setBibleEntryId(entry.id);
        setSection("bible");
        onNavigateContent?.();
      },
      () => undefined,
    );
  }

  if (!workId) {
    return (
      <>
        <nav className="pane book-nav" aria-label="书内目录">
          <header className="pane-header book-nav-header">书内目录</header>
          <div className="pane-body">
            <EmptyHint>请先选择或创建一个作品。</EmptyHint>
          </div>
        </nav>
        <section className="pane studio-main" aria-label="作品内容">
          <header className="pane-header studio-main-header">作品内容</header>
          <div className="pane-body">
            <EmptyHint>选择作品后，这里显示大纲、章节正文或设定条目。</EmptyHint>
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      <BookNavigation
        workId={workId}
        workTitle={workTitle}
        section={section}
        onSelectSection={selectSection}
        outline={{
          outline: outlineState.outline,
          isLoading: outlineState.isLoading,
          error: outlineState.error,
          selected: section === "outline",
          onSelect: selectOutline,
          onReload: outlineState.refetch,
        }}
        chapters={{
          chapters: chapterList.items,
          isLoading: chapterList.isLoading,
          error: chapterList.error,
          selectedChapterId: section === "chapters" ? chapterId : null,
          dirtyChapterId: chapterEditor.dirty ? chapterId : null,
          savingChapterId: chapterEditor.saving ? chapterId : null,
          onSelect: selectChapter,
          onCreate: createChapter,
          createPending: chapterList.createPending,
          createError: chapterList.createError,
          onReload: chapterList.refetch,
        }}
        bible={{
          query: bibleQuery,
          onQueryChange: setBibleQuery,
          items: bibleState.items,
          isLoading: bibleState.isLoading,
          error: bibleState.error,
          selectedEntryId: section === "bible" ? bibleEntryId : null,
          dirtyEntryId: bibleEditor.dirty ? bibleEntryId : null,
          savingEntryId: bibleEditor.saving ? bibleEntryId : null,
          onSelect: selectBibleEntry,
          onCreate: createBibleEntry,
          createPending: bibleState.createPending,
          createError: bibleState.createError,
          onReload: bibleState.refetch,
        }}
      />

      <section className="pane studio-main" aria-label="作品内容">
        {dirty && !activeEditor.dirty ? <div className="other-draft-notice" role="status">其他文稿有未保存修改，切换分区不会丢失草稿。</div> : null}

        {section === "outline" ? (
          <OutlinePanel
            workId={workId}
            outline={outlineState.outline}
            isLoading={outlineState.isLoading}
            loadError={outlineState.error}
            editor={outlineEditor}
            onReload={outlineState.refetch}
          />
        ) : null}

        {section === "chapters" ? (
          <ChapterEditor
            chapter={chapterState.chapter}
            isLoading={chapterState.isLoading}
            loadError={chapterState.error}
            editor={chapterEditor}
            versions={chapterState.versions}
            versionsLoading={chapterState.versionsLoading}
            versionsError={chapterState.versionsError}
            onReload={chapterState.refetch}
          />
        ) : null}

        {section === "bible" ? (
          <BibleEditor
            editor={bibleEditor}
            selectedEntry={selectedBibleEntry}
            isLoading={bibleState.isLoading}
            error={bibleState.error}
            onReload={bibleState.refetch}
          />
        ) : null}
      </section>
    </>
  );
}
