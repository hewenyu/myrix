import type { BibleEntry, BibleKind, Chapter, Outline } from "@myrix/contracts";

import { Banner } from "../components/common";
import { Icon } from "../components/Icon";
import { BibleNav } from "./BiblePanel";
import { ChapterNav } from "./ChapterPanel";
import { formatTime } from "./format";

/** 书内目录的三大分区。 */
export type BookSection = "outline" | "chapters" | "bible";

export interface OutlineNavProps {
  outline: Outline | null;
  isLoading: boolean;
  error: string | null;
  selected: boolean;
  onSelect: () => void;
  onReload: () => void;
}

export interface BibleNavSectionProps {
  query: string;
  onQueryChange: (query: string) => void;
  items: BibleEntry[];
  isLoading: boolean;
  error: string | null;
  selectedEntryId: string | null;
  dirtyEntryId: string | null;
  savingEntryId: string | null;
  onSelect: (entryId: string) => void;
  onCreate: (input: { kind: BibleKind; title: string; text: string }) => void;
  createPending: boolean;
  createError: string | null;
  onReload: () => void;
}

export interface ChapterNavSectionProps {
  chapters: Chapter[];
  isLoading: boolean;
  error: string | null;
  selectedChapterId: string | null;
  dirtyChapterId: string | null;
  savingChapterId: string | null;
  onSelect: (chapterId: string) => void;
  onCreate: (title: string) => void;
  createPending: boolean;
  createError: string | null;
  onReload: () => void;
}

export interface BookNavigationProps {
  workId: string;
  workTitle: string | null;
  section: BookSection;
  onSelectSection: (section: BookSection) => void;
  outline: OutlineNavProps;
  chapters: ChapterNavSectionProps;
  bible: BibleNavSectionProps;
}

/**
 * 左栏：书内目录（大纲 / 章节 / 设定圣经）。
 *
 * 目录**始终**同时提供三个分区及其条目，中栏只显示“被选中的那一个”：
 * 章节列表、设定检索与新增表单都留在目录里，正文上方不再出现大列表或大表单。
 *
 * 无障碍：三个分组是**常驻且可同时浏览**的目录索引，不是互斥页签，因此不使用
 * `tab` / `tablist` / `tabpanel`。分区标题是普通 `button`，用 `aria-pressed` 表示当前中栏归属；
 * 每个分组是带 `aria-label` 的具名 `<section>`（HTML-AAM 映射为 region），三节始终在文档里可见，
 * 不加 `hidden`——隐藏会违背“目录始终提供三节”。
 */
export function BookNavigation({
  workId,
  workTitle,
  section,
  onSelectSection,
  outline,
  chapters,
  bible,
}: BookNavigationProps) {
  return (
    <nav className="pane book-nav" aria-label="书内目录">
      <header className="pane-header book-nav-header">
        <Icon name="book" size={16} />
        <span className="book-nav-title">{workTitle ?? workId}</span>

      </header>

      <div className="pane-body book-nav-body">
        <section className="nav-group" aria-label="大纲">
          <button
            type="button"
            className="nav-group-title"
            aria-pressed={section === "outline"}
            onClick={() => onSelectSection("outline")}
          >
            大纲
          </button>
          <div className="nav-group-body">
            {outline.error ? (
              <Banner level="error" actions={<button type="button" onClick={outline.onReload}>重试</button>}>
                {outline.error}
              </Banner>
            ) : null}
            <ul className="list nav-list">
              <li>
                <button
                  type="button"
                  className="item"
                  aria-current={outline.selected}
                  onClick={outline.onSelect}
                >
                  故事大纲
                  <span className="item-sub">
                    {outline.isLoading
                      ? "正在读取大纲…"
                      : outline.outline
                        ? `版本 ${outline.outline.version} · ${formatTime(outline.outline.updatedAt)}`
                        : "尚未载入大纲"}
                  </span>
                </button>
              </li>
            </ul>
          </div>
        </section>

        <section className="nav-group" aria-label="章节">
          <button
            type="button"
            className="nav-group-title"
            aria-pressed={section === "chapters"}
            onClick={() => onSelectSection("chapters")}
          >
            章节
          </button>
          <div className="nav-group-body">
            <ChapterNav
              chapters={chapters.chapters}
              isLoading={chapters.isLoading}
              error={chapters.error}
              selectedChapterId={chapters.selectedChapterId}
              dirtyChapterId={chapters.dirtyChapterId}
              savingChapterId={chapters.savingChapterId}
              onSelect={chapters.onSelect}
              onCreate={chapters.onCreate}
              createPending={chapters.createPending}
              createError={chapters.createError}
              onReload={chapters.onReload}
            />
          </div>
        </section>

        <section className="nav-group" aria-label="设定圣经">
          <button
            type="button"
            className="nav-group-title"
            aria-pressed={section === "bible"}
            onClick={() => onSelectSection("bible")}
          >
            设定圣经
          </button>
          <div className="nav-group-body">
            <BibleNav
              query={bible.query}
              onQueryChange={bible.onQueryChange}
              items={bible.items}
              isLoading={bible.isLoading}
              error={bible.error}
              selectedEntryId={bible.selectedEntryId}
              dirtyEntryId={bible.dirtyEntryId}
              savingEntryId={bible.savingEntryId}
              onSelect={bible.onSelect}
              onCreate={bible.onCreate}
              createPending={bible.createPending}
              createError={bible.createError}
              onReload={bible.onReload}
            />
          </div>
        </section>
      </div>
    </nav>
  );
}
