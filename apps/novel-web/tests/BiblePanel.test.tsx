import type { BibleEntry } from "@myrix/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BiblePanel } from "../src/panels/BiblePanel";
import type { DraftState } from "../src/state/draft";
import type { DraftEditor } from "../src/state/useDraft";

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

function renderPanel(editor: DraftEditor<BibleEntry>, selectedEntry: BibleEntry | null = entry) {
  return render(
    <BiblePanel
      query=""
      onQueryChange={vi.fn()}
      items={[entry]}
      isLoading={false}
      error={null}
      selectedEntryId={entry.id}
      onSelect={vi.fn()}
      onCreate={vi.fn()}
      createPending={false}
      createError={null}
      onReload={vi.fn()}
      editor={editor}
      selectedEntry={selectedEntry}
    />,
  );
}

describe("BiblePanel 冲突处理", () => {
  it("只有旧快照时禁用采用/重试，提示重新读取并保留本地草稿", async () => {
    const editor = makeEditor(stateWithServerSnapshot(1));
    const user = userEvent.setup();

    renderPanel(editor);

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
    renderPanel(makeEditor(stateWithServerSnapshot(null)));

    expect(screen.getByRole("button", { name: "采用服务端内容" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "以最新版本提交本地草稿" })).toBeDisabled();
    expect(screen.getByText(/尚未读取到服务端版本 3 的内容/)).toBeDefined();
  });

  it("快照版本等于冲突版本时启用采用/重试", async () => {
    const editor = makeEditor(stateWithServerSnapshot(3));
    const user = userEvent.setup();

    renderPanel(editor);

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

    renderPanel(editor);

    expect(screen.getByRole("button", { name: "采用服务端内容" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "以最新版本提交本地草稿" }));
    expect(editor.save).toHaveBeenCalledWith(4);
  });
});
