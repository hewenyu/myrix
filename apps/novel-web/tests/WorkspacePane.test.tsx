import type { BibleEntry, Chapter, Outline, SaveResult } from "@myrix/contracts";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * WorkspacePane 的编排测试：目录选择、书内首开建议、未保存草稿保护、异步回包归属。
 *
 * 只替换数据 hook（`state/useWorkspace`）与 Tiptap 编辑器：草稿归属（useDraft）、
 * 目录/中栏分工、确认与代际判定全部是真实实现。绝不替换这些关键逻辑。
 */

const fns = vi.hoisted(() => ({
  outlineSave: vi.fn(),
  outlineRefetch: vi.fn(),
  chaptersCreate: vi.fn(),
  chaptersRefetch: vi.fn(),
  chapterSave: vi.fn(),
  chapterRefetch: vi.fn(),
  bibleCreate: vi.fn(),
  bibleRefetch: vi.fn(),
  bibleSave: vi.fn(),
}));

let outlineData: Outline | null = null;
let outlineLoading = false;
let outlineError: string | null = null;
let chaptersData: Chapter[] = [];
let chaptersLoading = false;
let chaptersError: string | null = null;
let chaptersCreatePending = false;
let chaptersCreateError: string | null = null;
let chapterById: Record<string, Chapter> = {};
let chapterLoading = false;
let chapterError: string | null = null;
let bibleData: BibleEntry[] = [];
let bibleLoading = false;
let bibleError: string | null = null;
let bibleCreatePending = false;
let bibleCreateError: string | null = null;

vi.mock("../src/state/useWorkspace", () => ({
  useOutline: () => ({
    outline: outlineData,
    isLoading: outlineLoading,
    error: outlineError,
    refetch: fns.outlineRefetch,
    save: fns.outlineSave,
    saving: false,
    saveError: null,
  }),
  useChapters: () => ({
    items: chaptersData,
    isLoading: chaptersLoading,
    error: chaptersError,
    refetch: fns.chaptersRefetch,
    create: fns.chaptersCreate,
    createPending: chaptersCreatePending,
    createError: chaptersCreateError,
  }),
  useChapter: (_workId: string | null, chapterId: string | null) => ({
    chapter: chapterId ? (chapterById[chapterId] ?? null) : null,
    isLoading: chapterLoading,
    error: chapterError,
    refetch: fns.chapterRefetch,
    save: fns.chapterSave,
    saving: false,
    saveError: null,
    versions: [],
    versionsLoading: false,
    versionsError: null,
  }),
  useBible: () => ({
    items: bibleData,
    isLoading: bibleLoading,
    error: bibleError,
    refetch: fns.bibleRefetch,
    create: fns.bibleCreate,
    createPending: bibleCreatePending,
    createError: bibleCreateError,
    save: fns.bibleSave,
    saving: false,
    saveError: null,
  }),
}));

vi.mock("../src/components/PlainTextEditor", () => ({
  PlainTextEditor: ({
    value,
    onChange,
    ariaLabel,
  }: {
    value: string;
    onChange: (text: string) => void;
    ariaLabel: string;
  }) => (
    <textarea aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));

import { WorkspacePane } from "../src/panels/WorkspacePane";

const ISO = "2026-01-01T00:00:00.000Z";
const outline: Outline = { workId: "w1", text: "大纲正文", version: 3, updatedAt: ISO };
const chapterA: Chapter = { id: "c-a", workId: "w1", title: "第一章", text: "A 正文", version: 1, updatedAt: ISO };
const chapterB: Chapter = { ...chapterA, id: "c-b", title: "第二章" };
const chapterC: Chapter = { ...chapterA, id: "c-c", title: "迟到的章节" };
const character: BibleEntry = {
  id: "b-1",
  workId: "w1",
  kind: "character",
  title: "主角",
  text: "人物正文",
  version: 1,
  updatedAt: ISO,
};
const setting: BibleEntry = { ...character, id: "b-2", kind: "setting", title: "世界观" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderPane(props: { workId?: string | null; workTitle?: string | null; onDirtyChange?: (dirty: boolean) => void } = {}) {
  return render(<WorkspacePane workId="w1" workTitle="作品一" {...props} />);
}

function textValue(label: string | RegExp): string {
  return (screen.getByLabelText(label) as HTMLTextAreaElement).value;
}

beforeEach(() => {
  vi.clearAllMocks();
  outlineData = null;
  outlineLoading = false;
  outlineError = null;
  chaptersData = [];
  chaptersLoading = false;
  chaptersError = null;
  chaptersCreatePending = false;
  chaptersCreateError = null;
  chapterById = {};
  chapterLoading = false;
  chapterError = null;
  bibleData = [];
  bibleLoading = false;
  bibleError = null;
  bibleCreatePending = false;
  bibleCreateError = null;

  fns.outlineRefetch.mockResolvedValue(undefined);
  fns.chaptersRefetch.mockResolvedValue(undefined);
  fns.chapterRefetch.mockResolvedValue(undefined);
  fns.bibleRefetch.mockResolvedValue(undefined);
  fns.outlineSave.mockResolvedValue({ status: "saved", version: 4 });
  fns.chapterSave.mockResolvedValue({ status: "saved", version: 2 });
  fns.bibleSave.mockResolvedValue({ status: "saved", version: 2 });
});

describe("WorkspacePane 书内首开建议", () => {
  it("有章节时选中第一项：目录标记当前章节，中栏显示其正文", async () => {
    chaptersData = [chapterA, chapterB];
    chapterById = { "c-a": chapterA, "c-b": chapterB };
    outlineData = outline;
    renderPane();

    await waitFor(() => expect(screen.getByLabelText("章节正文：第一章")).toBeDefined());
    expect(screen.getByRole("button", { name: "章节" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /第一章/ })).toHaveAttribute("aria-current", "true");
  });

  it("没有章节时留在大纲，不自动保存也不调用任何写接口", async () => {
    chaptersData = [];
    outlineData = outline;
    renderPane();

    await waitFor(() => expect(screen.getByLabelText("作品大纲")).toBeDefined());
    expect(screen.getByRole("button", { name: "大纲" })).toHaveAttribute("aria-pressed", "true");
    expect(fns.outlineSave).not.toHaveBeenCalled();
    expect(fns.chapterSave).not.toHaveBeenCalled();
    expect(fns.chaptersCreate).not.toHaveBeenCalled();
    expect(fns.bibleCreate).not.toHaveBeenCalled();
  });

  it("用户先点了章节分区，晚到的章节列表不会把中栏抢到第一项", async () => {
    const user = userEvent.setup();
    chaptersData = [];
    chaptersLoading = true;
    outlineData = outline;
    const view = renderPane();

    await user.click(screen.getByRole("button", { name: "章节" }));
    expect(screen.getByText("请选择或新建一个章节。")).toBeDefined();

    chaptersLoading = false;
    chaptersData = [chapterA, chapterB];
    chapterById = { "c-a": chapterA, "c-b": chapterB };
    view.rerender(<WorkspacePane workId="w1" workTitle="作品一" />);
    await waitFor(() => expect(screen.getByRole("button", { name: /第一章/ })).toBeDefined());

    // 用户已经显式选了分区：首开建议不得替他选中第一章。
    expect(screen.getByText("请选择或新建一个章节。")).toBeDefined();
    expect(screen.queryByLabelText("章节正文：第一章")).toBeNull();
    expect(screen.getByRole("button", { name: "章节" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("WorkspacePane 目录与中栏分工", () => {
  it("中栏只显示所选章节正文：目录的章节列表与新建表单不在正文区", async () => {
    chaptersData = [chapterA, chapterB];
    chapterById = { "c-a": chapterA, "c-b": chapterB };
    renderPane();
    await waitFor(() => expect(screen.getByLabelText("章节正文：第一章")).toBeDefined());

    const nav = screen.getByRole("navigation", { name: "书内目录" });
    const main = screen.getByRole("region", { name: "作品内容" });
    expect(within(nav).getByRole("button", { name: /第二章/ })).toBeDefined();
    expect(within(main).queryByRole("button", { name: /第二章/ })).toBeNull();
    expect(within(main).queryByLabelText("新章节标题")).toBeNull();
    expect(within(main).getByLabelText("章节正文：第一章")).toBeDefined();
  });

  it("点击目录里的设定条目，中栏切换到该条目编辑器", async () => {
    const user = userEvent.setup();
    chaptersData = [chapterA];
    chapterById = { "c-a": chapterA };
    bibleData = [character, setting];
    renderPane();
    await waitFor(() => expect(screen.getByLabelText("章节正文：第一章")).toBeDefined());

    await user.click(screen.getByRole("button", { name: /世界观/ }));
    expect(screen.getByRole("button", { name: "设定圣经" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: /世界观/ })).toBeDefined();
    expect(textValue("条目内容（纯文本）")).toBe(setting.text);
  });
});

describe("WorkspacePane 未保存草稿保护", () => {
  it("切换章节有未保存草稿时先确认：拒绝则留在原章节并保留草稿", async () => {
    const user = userEvent.setup();
    chaptersData = [chapterA, chapterB];
    chapterById = { "c-a": chapterA, "c-b": chapterB };
    renderPane();
    await waitFor(() => expect(screen.getByLabelText("章节正文：第一章")).toBeDefined());

    await user.type(screen.getByLabelText("章节正文：第一章"), "未保存草稿");
    const draft = textValue("章节正文：第一章");
    expect(draft).not.toBe(chapterA.text);

    const confirmSpy = vi.fn().mockReturnValue(false);
    vi.stubGlobal("confirm", confirmSpy);

    await user.click(screen.getByRole("button", { name: /第二章/ }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0]?.[0]).toContain("未保存");
    expect(textValue("章节正文：第一章")).toBe(draft);
    expect(screen.getByRole("button", { name: /第一章/ })).toHaveAttribute("aria-current", "true");

    confirmSpy.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: /第二章/ }));
    await waitFor(() => expect(screen.getByLabelText("章节正文：第二章")).toBeDefined());
    expect(screen.getByRole("button", { name: /第二章/ })).toHaveAttribute("aria-current", "true");
  });

  it("保存进行中切换章节同样先确认；拒绝时不切换也不丢在途保存", async () => {
    const user = userEvent.setup();
    chaptersData = [chapterA, chapterB];
    chapterById = { "c-a": chapterA, "c-b": chapterB };
    const gate = deferred<SaveResult>();
    fns.chapterSave.mockReturnValueOnce(gate.promise);
    renderPane();
    await waitFor(() => expect(screen.getByLabelText("章节正文：第一章")).toBeDefined());

    await user.type(screen.getByLabelText("章节正文：第一章"), "草稿");
    await user.click(screen.getByRole("button", { name: "保存" }));

    const confirmSpy = vi.fn().mockReturnValue(false);
    vi.stubGlobal("confirm", confirmSpy);
    await user.click(screen.getByRole("button", { name: /第二章/ }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0]?.[0]).toContain("正在保存");
    expect(screen.queryByLabelText("章节正文：第二章")).toBeNull();

    await act(async () => {
      gate.resolve({ status: "saved", version: 2 });
      await Promise.resolve();
    });
    // 在途保存照常落地，章节没有被切走。
    expect(screen.getByLabelText("章节正文：第一章")).toBeDefined();
  });

  it("切换分区不丢章节草稿也不弹确认：去大纲再回来草稿仍在", async () => {
    const user = userEvent.setup();
    chaptersData = [chapterA];
    chapterById = { "c-a": chapterA };
    outlineData = outline;
    renderPane();
    await waitFor(() => expect(screen.getByLabelText("章节正文：第一章")).toBeDefined());

    await user.type(screen.getByLabelText("章节正文：第一章"), "分区切换草稿");
    const draft = textValue("章节正文：第一章");

    const confirmSpy = vi.fn().mockReturnValue(false);
    vi.stubGlobal("confirm", confirmSpy);

    await user.click(screen.getByRole("button", { name: "大纲" }));
    expect(screen.getByLabelText("作品大纲")).toBeDefined();
    expect(confirmSpy).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "章节" }));
    expect(textValue("章节正文：第一章")).toBe(draft);
    // 目录里也显式标注这一章有未保存草稿。
    expect(screen.getByRole("button", { name: /第一章[\s\S]*有未保存修改/ })).toBeDefined();
  });
});

describe("WorkspacePane 异步选择归属", () => {
  it("新建章节的迟到回包不抢回用户随后选中的分区", async () => {
    const user = userEvent.setup();
    chaptersData = [chapterA];
    chapterById = { "c-a": chapterA, "c-c": chapterC };
    outlineData = outline;
    const gate = deferred<Chapter>();
    fns.chaptersCreate.mockReturnValueOnce(gate.promise);
    renderPane();
    await waitFor(() => expect(screen.getByLabelText("章节正文：第一章")).toBeDefined());

    await user.click(screen.getByRole("button", { name: "新建章节" }));
    await user.type(screen.getByLabelText("新章节标题"), "迟到的章节");
    await user.click(screen.getByRole("button", { name: "新建章节" }));
    expect(fns.chaptersCreate).toHaveBeenCalledWith({ title: "迟到的章节" });

    // 用户在保存/创建期间显式回到大纲。
    await user.click(screen.getByRole("button", { name: "大纲" }));
    expect(screen.getByLabelText("作品大纲")).toBeDefined();

    await act(async () => {
      gate.resolve(chapterC);
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "大纲" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByLabelText("章节正文：迟到的章节")).toBeNull();
  });

  it("新建设定条目的迟到回包不抢回用户随后选中的条目", async () => {
    const user = userEvent.setup();
    bibleData = [character, setting];
    chaptersData = [chapterA];
    chapterById = { "c-a": chapterA };
    const gate = deferred<BibleEntry>();
    fns.bibleCreate.mockReturnValueOnce(gate.promise);
    renderPane();
    await waitFor(() => expect(screen.getByLabelText("章节正文：第一章")).toBeDefined());

    await user.click(screen.getByRole("button", { name: "设定圣经" }));
    await user.click(screen.getByRole("button", { name: "新增条目" }));
    await user.type(screen.getByLabelText("条目名称"), "迟到的条目");
    await user.click(screen.getByRole("button", { name: "新增条目" }));
    expect(fns.bibleCreate).toHaveBeenCalledWith({ kind: "character", title: "迟到的条目", text: "" });

    // 创建期间用户显式改选了另一个条目。
    await user.click(screen.getByRole("button", { name: /世界观/ }));
    expect(textValue("条目内容（纯文本）")).toBe(setting.text);

    await act(async () => {
      gate.resolve({ ...character, id: "b-3", title: "迟到的条目" });
      await Promise.resolve();
    });

    expect(textValue("条目内容（纯文本）")).toBe(setting.text);
    expect(screen.queryByRole("heading", { name: /迟到的条目/ })).toBeNull();
  });
});

describe("WorkspacePane dirty 通知", () => {
  it("草稿出现/消失时上报顶层，卸载时归零", async () => {
    const user = userEvent.setup();
    chaptersData = [chapterA];
    chapterById = { "c-a": chapterA };
    const onDirtyChange = vi.fn();
    const { unmount } = renderPane({ onDirtyChange });
    await waitFor(() => expect(screen.getByLabelText("章节正文：第一章")).toBeDefined());
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    await user.type(screen.getByLabelText("章节正文：第一章"), "草稿");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    unmount();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("同一实例换作品时清空本地选择与草稿，dirty 归零", async () => {
    const user = userEvent.setup();
    chaptersData = [chapterA];
    chapterById = { "c-a": chapterA };
    const onDirtyChange = vi.fn();
    const view = renderPane({ onDirtyChange });
    await waitFor(() => expect(screen.getByLabelText("章节正文：第一章")).toBeDefined());
    await user.type(screen.getByLabelText("章节正文：第一章"), "草稿");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    // 新作品没有任何章节：中栏不得继续显示上一个作品的章节草稿。
    chaptersData = [];
    chapterById = {};
    outlineData = outline;
    view.rerender(<WorkspacePane workId="w2" workTitle="作品二" onDirtyChange={onDirtyChange} />);

    await waitFor(() => expect(screen.queryByLabelText("章节正文：第一章")).toBeNull());
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole("button", { name: "大纲" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("WorkspacePane 空态", () => {
  it("未选择作品时给出目录与正文的引导空态", () => {
    renderPane({ workId: null, workTitle: null });
    expect(screen.getByText("请先选择或创建一个作品。")).toBeDefined();
    expect(screen.getByText("选择作品后，这里显示大纲、章节正文或设定条目。")).toBeDefined();
  });

  it("目录的错误态可重试", async () => {
    const user = userEvent.setup();
    chaptersError = "章节读取失败";
    outlineError = "大纲读取失败";
    renderPane();

    expect(screen.getByText("章节读取失败")).toBeDefined();
    // 大纲错误同时出现在目录与中栏，这里只核对目录里的那一处。
    expect(within(screen.getByRole("navigation", { name: "书内目录" })).getByText("大纲读取失败")).toBeDefined();
    const retries = screen.getAllByRole("button", { name: "重试" });
    await user.click(retries[0] as HTMLElement);
    expect(fns.outlineRefetch.mock.calls.length + fns.chaptersRefetch.mock.calls.length).toBeGreaterThan(0);
  });
});
