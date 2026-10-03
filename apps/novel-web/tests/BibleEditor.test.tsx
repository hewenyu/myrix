import type { BibleEntry } from "@myrix/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BibleEditor, BibleNav } from "../src/panels/BiblePanel";
import type { DraftState } from "../src/state/draft";
import type { DraftEditor } from "../src/state/useDraft";

// Tiptap 的 DOM 机制不是本测试的对象；这里核对 Manuscript 是否把纯文本原文交给编辑器。
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

const entry: BibleEntry = {
  id: "b1",
  workId: "w1",
  kind: "character",
  title: "主角",
  text: "服务端旧快照",
  version: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

type State = DraftState<BibleEntry>;

function makeEditor(state: State, overrides: Partial<DraftEditor<BibleEntry>> = {}): DraftEditor<BibleEntry> {
  return {
    draft: state,
    dirty: true,
    serverAhead: false,
    conflict: state.conflict,
    notice: null,
    saving: false,
    error: null,
    setText: vi.fn(),
    save: vi.fn(async () => null),
    reloadServer: vi.fn(async () => undefined),
    takeServer: vi.fn(),
    dismissNotice: vi.fn(),
    clearError: vi.fn(),
    ...overrides,
  };
}

/** 冲突已上报版本 3，但 draft.server 仍是旧基线快照。 */
function stateWithServerSnapshot(serverVersion: number | null, conflictServerVersion = 3): State {
  return {
    base: { ...entry, text: "本地基线", version: 1 },
    server: serverVersion === null ? null : { ...entry, text: `服务端版本 ${serverVersion}`, version: serverVersion },
    text: "我的本地草稿",
    conflict: {
      localText: "我的本地草稿",
      expectedVersion: 1,
      serverVersion: conflictServerVersion,
      detectedAt: 0,
    },
    notice: null,
  };
}

function renderEditor(editor: DraftEditor<BibleEntry>, selectedEntry: BibleEntry | null = entry) {
  return render(
    <BibleEditor editor={editor} selectedEntry={selectedEntry} isLoading={false} error={null} onReload={vi.fn()} />,
  );
}

describe("BibleEditor 冲突处理", () => {
  it("只有旧快照时禁用采用/重试，提示重新读取并保留本地草稿", async () => {
    const editor = makeEditor(stateWithServerSnapshot(1));
    const user = userEvent.setup();

    renderEditor(editor);

    const takeServer = screen.getByRole("button", { name: "采用服务端内容" });
    const saveOverwrite = screen.getByRole("button", { name: "以最新版本提交本地草稿" });
    expect(takeServer).toBeDisabled();
    expect(saveOverwrite).toBeDisabled();
    expect(screen.getByText(/请先点“重新读取”/)).toBeDefined();
    expect(screen.getByText(/低于冲突报告的版本 3/)).toBeDefined();
    // 本地草稿仍在编辑器中，未被覆盖。
    expect((screen.getByLabelText("条目内容（纯文本）") as HTMLTextAreaElement).value).toBe("我的本地草稿");

    await user.click(takeServer);
    await user.click(saveOverwrite);
    expect(editor.takeServer).not.toHaveBeenCalled();
    expect(editor.save).not.toHaveBeenCalled();

    // 重新读取始终可用。
    await user.click(screen.getByRole("button", { name: "重新读取" }));
    expect(editor.reloadServer).toHaveBeenCalledTimes(1);
  });

  it("完全无服务端快照时禁用采用/重试并提示重新读取", () => {
    renderEditor(makeEditor(stateWithServerSnapshot(null)));

    expect(screen.getByRole("button", { name: "采用服务端内容" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "以最新版本提交本地草稿" })).toBeDisabled();
    expect(screen.getByText(/尚未读取到服务端版本 3 的内容/)).toBeDefined();
  });

  it("快照版本等于冲突版本时启用采用/重试", async () => {
    const editor = makeEditor(stateWithServerSnapshot(3));
    const user = userEvent.setup();

    renderEditor(editor);

    const takeServer = screen.getByRole("button", { name: "采用服务端内容" });
    expect(takeServer).toBeEnabled();
    expect(screen.queryByText(/请先点“重新读取”/)).toBeNull();

    await user.click(takeServer);
    expect(editor.takeServer).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "以最新版本提交本地草稿" }));
    expect(editor.save).toHaveBeenCalledWith(3);
  });

  it("快照版本比冲突版本更新时同样允许（已推进到 4）", async () => {
    const editor = makeEditor(stateWithServerSnapshot(4));
    const user = userEvent.setup();

    renderEditor(editor);

    expect(screen.getByRole("button", { name: "采用服务端内容" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "以最新版本提交本地草稿" }));
    expect(editor.save).toHaveBeenCalledWith(4);
  });

  it("检索结果不再包含该条目时仍保留编辑器与本地草稿", () => {
    const editor = makeEditor(stateWithServerSnapshot(null), { conflict: null });

    renderEditor(editor, null);

    expect(screen.getByText(/当前检索结果不再包含该条目/)).toBeDefined();
    expect((screen.getByLabelText("条目内容（纯文本）") as HTMLTextAreaElement).value).toBe("我的本地草稿");
  });

  it("无选中条目且无草稿时给出可选择提示", () => {
    renderEditor(makeEditor({ base: null, server: null, text: "", conflict: null, notice: null }), null);
    expect(screen.getByText("选择一个条目进行编辑。")).toBeDefined();
  });
});

describe("BibleEditor 阅读优先", () => {
  function cleanState(text = "已保存的条目正文"): State {
    return {
      base: { ...entry, text, version: 1 },
      server: null,
      text,
      conflict: null,
      notice: null,
    };
  }

  it("已有内容且无草稿时默认阅读，点“编辑原文”才挂载编辑器且不改写原文", async () => {
    const user = userEvent.setup();
    const editor = makeEditor(cleanState(), { dirty: false, conflict: null });
    renderEditor(editor);

    expect(screen.getByRole("button", { name: "阅读" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "编辑原文" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByLabelText("条目内容（纯文本）")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "主角" })).toBeDefined();

    await user.click(screen.getByRole("button", { name: "编辑原文" }));
    expect((screen.getByLabelText("条目内容（纯文本）") as HTMLTextAreaElement).value).toBe(
      "已保存的条目正文",
    );
    expect(editor.setText).not.toHaveBeenCalled();
  });
});

describe("BibleNav 目录（分类列表 + 收起的新增）", () => {
  function renderNav(overrides: Partial<Parameters<typeof BibleNav>[0]> = {}) {
    const props = {
      query: "",
      onQueryChange: vi.fn(),
      items: [] as BibleEntry[],
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
      ...overrides,
    };
    return { props, ...render(<BibleNav {...props} />) };
  }

  it("默认收起新增表单，点“新增条目”后展开并提交", async () => {
    const user = userEvent.setup();
    const { props } = renderNav();

    // 收起状态：同名按钮是展开开关，表单字段不在文档里。
    expect(screen.queryByLabelText("条目类型")).toBeNull();
    expect(screen.queryByLabelText("条目名称")).toBeNull();
    expect(screen.queryByLabelText("新条目内容")).toBeNull();

    await user.click(screen.getByRole("button", { name: "新增条目" }));
    await user.selectOptions(screen.getByLabelText("条目类型"), "timeline");
    await user.type(screen.getByLabelText("条目名称"), "第三章时间线");
    await user.type(screen.getByLabelText("新条目内容"), "正文");
    await user.click(screen.getByRole("button", { name: "新增条目" }));

    expect(props.onCreate).toHaveBeenCalledWith({ kind: "timeline", title: "第三章时间线", text: "正文" });
  });

  it("按人物/设定/时间线分类列出，并标注未保存草稿", () => {
    const items: BibleEntry[] = [
      entry,
      { ...entry, id: "b2", kind: "setting", title: "世界观" },
      { ...entry, id: "b3", kind: "timeline", title: "年表" },
    ];
    renderNav({ items, selectedEntryId: "b2", dirtyEntryId: "b2" });

    expect(screen.getByText("人物（1）")).toBeDefined();
    expect(screen.getByText("设定（1）")).toBeDefined();
    expect(screen.getByText("时间线（1）")).toBeDefined();
    expect(screen.getByRole("button", { name: /世界观[\s\S]*有未保存修改/ })).toBeDefined();
  });

  it("加载失败与空结果给出可重试的错误态与空态", async () => {
    const user = userEvent.setup();
    const { props } = renderNav({ error: "读取失败" });

    expect(screen.getByRole("alert").textContent).toContain("读取失败");
    expect(screen.getByText("没有匹配的设定条目。")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(props.onReload).toHaveBeenCalledTimes(1);
  });
});
