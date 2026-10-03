import type { BibleEntry, Chapter, Outline } from "@myrix/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BookNavigation, type BookNavigationProps } from "../src/panels/BookNavigation";

const ISO = "2026-01-01T00:00:00.000Z";

const outline: Outline = { workId: "w1", text: "大纲", version: 3, updatedAt: ISO };
const chapterA: Chapter = { id: "c-a", workId: "w1", title: "第一章", text: "A", version: 1, updatedAt: ISO };
const chapterB: Chapter = { id: "c-b", workId: "w1", title: "第二章", text: "B", version: 4, updatedAt: ISO };
const character: BibleEntry = {
  id: "b-1",
  workId: "w1",
  kind: "character",
  title: "主角",
  text: "人物",
  version: 2,
  updatedAt: ISO,
};
const timeline: BibleEntry = { ...character, id: "b-2", kind: "timeline", title: "年表" };

function navProps(overrides: Partial<BookNavigationProps> = {}): BookNavigationProps {
  return {
    workId: "w1",
    workTitle: "作品一",
    section: "outline",
    onSelectSection: vi.fn(),
    outline: {
      outline,
      isLoading: false,
      error: null,
      selected: true,
      onSelect: vi.fn(),
      onReload: vi.fn(),
    },
    chapters: {
      chapters: [chapterA, chapterB],
      isLoading: false,
      error: null,
      selectedChapterId: null,
      dirtyChapterId: null,
      savingChapterId: null,
      onSelect: vi.fn(),
      onCreate: vi.fn(),
      createPending: false,
      createError: null,
      onReload: vi.fn(),
    },
    bible: {
      query: "",
      onQueryChange: vi.fn(),
      items: [character, timeline],
      isLoading: false,
      error: null,
      selectedEntryId: null,
      dirtyEntryId: null,
      savingEntryId: null,
      onSelect: vi.fn(),
      onCreate: vi.fn(),
      createPending: false,
      createError: null,
      onReload: vi.fn(),
    },
    ...overrides,
  };
}

function renderNav(overrides: Partial<BookNavigationProps> = {}) {
  const props = navProps(overrides);
  return { props, ...render(<BookNavigation {...props} />) };
}

describe("BookNavigation 目录", () => {
  it("常驻大纲/章节/设定圣经三节，当前分区以 aria-pressed 标记", async () => {
    const user = userEvent.setup();
    const { props } = renderNav({ section: "chapters" });

    // 三个分组是具名 region，且始终可见：不是互斥页签，也没有 tab/tabpanel。
    for (const name of ["大纲", "章节", "设定圣经"]) {
      expect(screen.getByRole("region", { name })).toBeVisible();
    }
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("tabpanel")).toBeNull();

    const outlineTitle = screen.getByRole("button", { name: "大纲" });
    const chaptersTitle = screen.getByRole("button", { name: "章节" });
    const bibleTitle = screen.getByRole("button", { name: "设定圣经" });
    expect(outlineTitle).toHaveAttribute("aria-pressed", "false");
    expect(chaptersTitle).toHaveAttribute("aria-pressed", "true");
    expect(bibleTitle).toHaveAttribute("aria-pressed", "false");

    await user.click(outlineTitle);
    expect(props.onSelectSection).toHaveBeenCalledWith("outline");
  });

  it("章节区：一章都没有时新建表单直接展开，提交只调用 onCreate", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    renderNav({ chapters: { ...navProps().chapters, chapters: [], onCreate } });

    expect(screen.getByText("还没有章节。")).toBeDefined();
    await user.type(screen.getByLabelText("新章节标题"), "第一章");
    await user.click(screen.getByRole("button", { name: "新建章节" }));
    expect(onCreate).toHaveBeenCalledWith("第一章");
  });

  it("章节区：已有章节时新建收起，列表标注选中与未保存草稿", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const { props } = renderNav({
      chapters: {
        ...navProps().chapters,
        selectedChapterId: "c-b",
        dirtyChapterId: "c-b",
        onSelect,
      },
    });

    // 收起状态：同名按钮是展开开关，标题输入框不在文档里。
    expect(screen.queryByLabelText("新章节标题")).toBeNull();
    const second = screen.getByRole("button", { name: /第二章[\s\S]*有未保存修改/ });
    expect(second).toHaveAttribute("aria-current", "true");
    await user.click(second);
    expect(onSelect).toHaveBeenCalledWith("c-b");

    await user.click(screen.getByRole("button", { name: "新建章节" }));
    expect(screen.getByLabelText("新章节标题")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "收起" }));
    expect(screen.queryByLabelText("新章节标题")).toBeNull();

    await user.click(screen.getByRole("button", { name: /第一章/ }));
    expect(props.chapters.onSelect).toHaveBeenCalledWith("c-a");
  });

  it("设定区：按人物/时间线分类列出、检索可输入、新增默认折叠", async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    renderNav({ bible: { ...navProps().bible, onQueryChange } });

    expect(screen.getByText("人物（1）")).toBeDefined();
    expect(screen.getByText("时间线（1）")).toBeDefined();
    // 没有该类条目时整组不渲染。
    expect(screen.queryByText(/^设定（/)).toBeNull();

    await user.type(screen.getByLabelText("检索设定"), "年");
    expect(onQueryChange).toHaveBeenCalled();

    // 新增默认收起：表单字段不在文档里，只有展开开关。
    expect(screen.queryByLabelText("新条目内容")).toBeNull();
    expect(screen.getByRole("button", { name: "新增条目" })).toBeDefined();
  });

  it("章节区与设定区各自带加载/错误/空态", () => {
    renderNav({
      chapters: { ...navProps().chapters, chapters: [], isLoading: true, error: "章节读取失败" },
      bible: { ...navProps().bible, items: [], error: "设定读取失败" },
    });

    expect(screen.getByText("正在读取章节…")).toBeDefined();
    expect(screen.getByText("章节读取失败")).toBeDefined();
    expect(screen.getByText("设定读取失败")).toBeDefined();
    expect(screen.getByText("没有匹配的设定条目。")).toBeDefined();
  });

  it("中栏只显示所选内容：目录以外没有正文编辑区", () => {
    renderNav({ section: "chapters" });
    const nav = screen.getByRole("navigation", { name: "书内目录" });
    expect(within(nav).getByRole("button", { name: /第一章/ })).toBeDefined();
    expect(screen.queryByLabelText(/章节正文：/)).toBeNull();
  });
});
