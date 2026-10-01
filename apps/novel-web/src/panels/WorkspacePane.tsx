import type { BibleEntry, BibleKind, Chapter, Outline } from "@myrix/contracts";
import { useEffect, useState } from "react";

import { EmptyHint } from "../components/common";
import { useDraft } from "../state/useDraft";
import { useBible, useChapter, useChapters, useOutline } from "../state/useWorkspace";
import { BiblePanel } from "./BiblePanel";
import { ChapterEditor, ChapterList } from "./ChapterPanel";
import { OutlinePanel } from "./OutlinePanel";

export type WorkspaceTab = "outline" | "chapters" | "bible";

const TABS: { id: WorkspaceTab; label: string }[] = [
  { id: "outline", label: "大纲" },
  { id: "chapters", label: "章节" },
  { id: "bible", label: "设定圣经" },
];

export interface WorkspacePaneProps {
  workId: string | null;
  workTitle: string | null;
}

/** 中栏：大纲 / 章节编辑（含历史版本）/ 设定圣经。 */
export function WorkspacePane({ workId, workTitle }: WorkspacePaneProps) {
  const [tab, setTab] = useState<WorkspaceTab>("outline");
  const [chapterId, setChapterId] = useState<string | null>(null);
  const [bibleQuery, setBibleQuery] = useState("");
  const [bibleEntryId, setBibleEntryId] = useState<string | null>(null);

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

  useEffect(() => {
    // 切换作品时清空中栏选择，避免把上一个作品的 id 带到新作品。
    setChapterId(null);
    setBibleEntryId(null);
    setBibleQuery("");
  }, [workId]);

  if (!workId) {
    return (
      <section className="pane" aria-label="作品内容">
        <header className="pane-header">作品内容</header>
        <div className="pane-body">
          <EmptyHint>请选择或创建一个作品。</EmptyHint>
        </div>
      </section>
    );
  }

  return (
    <section className="pane" aria-label="作品内容">
      <header className="pane-header">
        <span>{workTitle ?? workId}</span>
        <span className="spacer" />
        <span className="small muted">作品 ID：{workId}</span>
      </header>

      <div className="tabs" role="tablist" aria-label="作品内容切换">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === "outline" ? (
        <OutlinePanel
          workId={workId}
          outline={outlineState.outline}
          isLoading={outlineState.isLoading}
          loadError={outlineState.error}
          editor={outlineEditor}
          onReload={outlineState.refetch}
        />
      ) : null}

      {tab === "chapters" ? (
        <div className="workspace-column">
          <div className="workspace-column-scroll">
            <ChapterList
              chapters={chapterList.items}
              isLoading={chapterList.isLoading}
              error={chapterList.error}
              selectedChapterId={chapterId}
              onSelect={setChapterId}
              onCreate={(title) => {
                // 失败原因由 createError 承载并由列表面板展示。
                chapterList.create({ title }).then(
                  (chapter) => setChapterId(chapter.id),
                  () => undefined,
                );
              }}
              createPending={chapterList.createPending}
              createError={chapterList.createError}
              onReload={chapterList.refetch}
            />
          </div>
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
        </div>
      ) : null}

      {tab === "bible" ? (
        <div className="pane-body">
          <BiblePanel
            query={bibleQuery}
            onQueryChange={setBibleQuery}
            items={bibleState.items}
            isLoading={bibleState.isLoading}
            error={bibleState.error}
            selectedEntryId={bibleEntryId}
            onSelect={setBibleEntryId}
            onCreate={(input: { kind: BibleKind; title: string; text: string }) => bibleState.create(input)}
            createPending={bibleState.createPending}
            createError={bibleState.createError}
            onReload={bibleState.refetch}
            editor={bibleEditor}
            selectedEntry={selectedBibleEntry}
          />
        </div>
      ) : null}
    </section>
  );
}
