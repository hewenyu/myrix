import type { Chapter } from "@myrix/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChapterEditor, type ChapterEditorProps } from "../src/panels/ChapterPanel";
import { initDraft } from "../src/state/draft";

// 本测试核对 ChapterEditor 的模式切换与历史版本展示，不核对 Tiptap 的 DOM 机制。
vi.mock("../src/components/PlainTextEditor", () => ({
  PlainTextEditor: ({ value, ariaLabel }: { value: string; ariaLabel: string }) => (
    <textarea aria-label={ariaLabel} readOnly value={value} />
  ),
}));

const first: Chapter = {
  id: "chapter-one", workId: "work-one", title: "第一章",
  text: "SAVED_BODY_NOT_IN_CONTEXT", version: 3, updatedAt: "2026-10-01T00:00:00Z",
};

const blank: Chapter = { ...first, text: "" };

const rich: Chapter = { ...first, text: "# 夜行\n\n他停下脚步，**终于**听见了回声。" };

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

/** 阅读态正文容器：aria-label 带“阅读”后缀；编辑器的 aria-label 不带后缀。 */
function readingArticle(label: string): HTMLElement {
  return screen.getByLabelText(`${label}阅读`);
}

afterEach(() => vi.restoreAllMocks());

describe("ChapterEditor 阅读优先", () => {
  it("已有正文且无草稿时默认阅读：显示标题与语义排版，不挂载编辑器", () => {
    const props = propsFor(rich, false);
    render(<ChapterEditor {...props} />);

    expect(screen.getByRole("button", { name: "阅读" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "编辑原文" })).toHaveAttribute("aria-pressed", "false");

    const article = readingArticle("章节正文：第一章");
    expect(within(article).getByRole("heading", { level: 1, name: "夜行" })).toBeDefined();
    expect(article.querySelector("strong")).toHaveTextContent("终于");
    expect(article.textContent).not.toContain("**");

    // 阅读态没有编辑器，也没有触发任何保存或改写。
    expect(screen.queryByLabelText("章节正文：第一章")).toBeNull();
    expect(props.editor.save).not.toHaveBeenCalled();
    expect(props.editor.setText).not.toHaveBeenCalled();
  });

  it("点“编辑原文”进入编辑器，载入源逐字等于已存储原文；切回阅读不改写也不回调", async () => {
    const user = userEvent.setup();
    const props = propsFor(first, false);
    render(<ChapterEditor {...props} />);

    await user.click(screen.getByRole("button", { name: "编辑原文" }));
    expect((screen.getByLabelText("章节正文：第一章") as HTMLTextAreaElement).value).toBe(first.text);

    await user.click(screen.getByRole("button", { name: "阅读" }));
    expect(readingArticle("章节正文：第一章")).toBeDefined();
    expect(screen.queryByLabelText("章节正文：第一章")).toBeNull();
    expect(props.editor.setText).not.toHaveBeenCalled();
  });

  it("空正文或已有未保存草稿时默认进入编辑，草稿文本不被当作已保存正文", () => {
    const blankView = render(<ChapterEditor {...propsFor(blank, false)} />);
    expect(screen.getByRole("button", { name: "编辑原文" })).toHaveAttribute("aria-pressed", "true");
    expect((screen.getByLabelText("章节正文：第一章") as HTMLTextAreaElement).value).toBe("");
    blankView.unmount();

    const draftView = render(<ChapterEditor {...propsFor(first, true)} />);
    expect((screen.getByLabelText("章节正文：第一章") as HTMLTextAreaElement).value).toBe(
      "LOCAL_DRAFT_NOT_IN_CONTEXT",
    );
    expect(screen.queryByLabelText("章节正文：第一章阅读")).toBeNull();
    draftView.unmount();
  });

  it("不再要求用户手动复制上下文：没有“章节助手上下文”入口，也不发任何请求", () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
    render(<ChapterEditor {...propsFor(first, true)} />);

    expect(screen.queryByText(/章节助手上下文/)).toBeNull();
    expect(screen.queryByLabelText("章节助手上下文")).toBeNull();
    expect(screen.queryByRole("button", { name: /复制章节/ })).toBeNull();
    expect(network).not.toHaveBeenCalled();
  });

  it("没有章节或权威章节读取失败时给出空态/错误态，不伪造编辑器", () => {
    const view = render(<ChapterEditor {...propsFor(null)} />);
    expect(screen.getByText("请选择或新建一个章节。")).toBeDefined();
    expect(screen.queryByLabelText(/章节正文：/)).toBeNull();

    view.rerender(<ChapterEditor {...propsFor(first)} loadError="读取失败" />);
    expect(screen.getByText("读取失败")).toBeDefined();
    expect(screen.queryByLabelText(/章节正文：/)).toBeNull();
  });
});

describe("ChapterEditor 历史版本", () => {
  it("历史版本以阅读排版展示，并可展开“查看原文”逐字核对源文", () => {
    const versionText = "# 早期版本\n\n他还没有停下脚步。";
    const { container } = render(
      <ChapterEditor
        {...propsFor(first, true)}
        versions={[{ version: 2, text: versionText, createdAt: "2026-01-02T00:00:00.000Z" }]}
      />,
    );

    // 历史版本不再只给人看 <pre>：先给语义排版。
    const reading = container.querySelector(".version-reading") as HTMLElement;
    expect(reading).not.toBeNull();
    expect(within(reading).getByRole("heading", { level: 1, name: "早期版本" })).toBeDefined();
    expect(reading.textContent).not.toContain("# 早期版本");

    // 源文逐字保留在默认折叠的“查看原文”里，供作者核对。
    const source = reading.parentElement?.querySelector("details.source-details") as HTMLDetailsElement;
    expect(source).not.toBeNull();
    expect(source.open).toBe(false);
    expect(source.querySelector("summary")?.textContent).toBe("查看原文");
    expect(source.querySelector("pre.code")?.textContent).toBe(versionText);
  });

  it("没有历史版本时给出空态，不渲染版本阅读区", () => {
    const { container } = render(<ChapterEditor {...propsFor(first, true)} />);
    expect(screen.getByText("暂无历史版本。")).toBeDefined();
    expect(container.querySelector(".version-reading")).toBeNull();
    expect(container.querySelector("details.source-details")).toBeNull();
  });
});
