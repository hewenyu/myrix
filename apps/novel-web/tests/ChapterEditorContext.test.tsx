import type { Chapter } from "@myrix/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChapterEditor, type ChapterEditorProps } from "../src/panels/ChapterPanel";
import { initDraft } from "../src/state/draft";

// This test verifies the real editor's context wiring, not Tiptap's DOM machinery.
vi.mock("../src/components/PlainTextEditor", () => ({
  PlainTextEditor: ({ value, ariaLabel }: { value: string; ariaLabel: string }) => (
    <textarea aria-label={ariaLabel} readOnly value={value} />
  ),
}));

const first: Chapter = {
  id: "chapter-one", workId: "work-one", title: "第一章",
  text: "SAVED_BODY_NOT_IN_CONTEXT", version: 3, updatedAt: "2026-10-01T00:00:00Z",
};

function propsFor(chapter: Chapter | null, dirty = false): ChapterEditorProps {
  return {
    chapter, isLoading: false, loadError: null, versions: [], versionsLoading: false,
    versionsError: null, onReload: vi.fn(),
    editor: {
      draft: chapter ? { ...initDraft(chapter), text: dirty ? "LOCAL_DRAFT_NOT_IN_CONTEXT" : chapter.text } : null,
      dirty, serverAhead: false, conflict: null, notice: null, saving: false, error: null,
      setText: vi.fn(), save: vi.fn(async () => null), reloadServer: vi.fn(async () => undefined),
      takeServer: vi.fn(), dismissNotice: vi.fn(), clearError: vi.fn(),
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("ChapterEditor context integration", () => {
  it("mounts an explicit collapsed context entry for the selected chapter, without copying prose or making requests", async () => {
    const user = userEvent.setup();
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
    const props = propsFor(first, true);
    render(<ChapterEditor {...props} />);
    const summary = screen.getByText("章节助手上下文（查看与复制）");
    expect(summary.closest("details")).not.toHaveAttribute("open");
    await user.click(summary);
    expect(summary.closest("details")).toHaveAttribute("open");
    const context = screen.getByLabelText("章节助手上下文") as HTMLTextAreaElement;
    expect(context).toHaveAttribute("readonly");
    expect(context.value).toContain("作品ID：work-one");
    expect(context.value).toContain("章节ID：chapter-one");
    expect(context.value).toContain("章节标题：第一章");
    expect(context.value).toContain("未保存草稿：有");
    expect(context.value).toContain("先调用get_chapter");
    expect(context.value).toContain("expectedVersion");
    expect(context.value).not.toContain(first.text);
    expect(context.value).not.toContain("LOCAL_DRAFT_NOT_IN_CONTEXT");
    expect(network).not.toHaveBeenCalled();
    expect(props.editor.save).not.toHaveBeenCalled();
  });

  it("replaces work/chapter context and closes the old disclosure when selection changes", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ChapterEditor {...propsFor(first)} />);
    await user.click(screen.getByText("章节助手上下文（查看与复制）"));
    const next: Chapter = { ...first, id: "chapter-two", workId: "work-two", title: "另一个作品的章节" };
    rerender(<ChapterEditor {...propsFor(next)} />);
    expect(screen.getByText("章节助手上下文（查看与复制）").closest("details")).not.toHaveAttribute("open");
    await user.click(screen.getByText("章节助手上下文（查看与复制）"));
    const context = screen.getByLabelText("章节助手上下文") as HTMLTextAreaElement;
    expect(context.value).toContain("work-two");
    expect(context.value).toContain("chapter-two");
    expect(context.value).not.toContain("work-one");
    expect(context.value).not.toContain("chapter-one");
  });

  it("does not expose context when no chapter is selected or the authoritative chapter failed to load", () => {
    const { rerender } = render(<ChapterEditor {...propsFor(null)} />);
    expect(screen.queryByLabelText("章节助手上下文")).toBeNull();
    rerender(<ChapterEditor {...propsFor(first)} loadError="读取失败" />);
    expect(screen.queryByLabelText("章节助手上下文")).toBeNull();
  });
});
