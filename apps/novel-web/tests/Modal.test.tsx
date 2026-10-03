import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Modal } from "../src/components/Modal";
import { WorkListPanel, type WorkListPanelProps } from "../src/panels/WorkListPanel";

/**
 * Modal 的焦点契约：打开时把焦点放进 dialog、Tab/Shift+Tab 只在 dialog 内环绕、
 * Escape 触发 onClose 并在卸载时把焦点还给打开它的那个控件。
 *
 * Modal 自己不判断“能不能关”（是否 pending 由调用方在 onClose 里决定），
 * 因此 pending 场景用真实调用方 WorkListPanel 验证：createPending 时 Escape 不关窗。
 */

function ModalHarness({ onClose }: { onClose: () => void }) {
  return (
    <Modal labelledBy="modal-title" onClose={onClose}>
      <h2 id="modal-title">标题</h2>
      <button type="button">第一个</button>
      <button type="button" data-initial-focus>
        初始焦点
      </button>
      <button type="button">最后一个</button>
    </Modal>
  );
}

/** 真实调用方式：外部触发按钮打开 Modal，卸载时 Modal 负责把焦点还给它。 */
function TriggerHarness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
      >
        打开
      </button>
      {open ? (
        <ModalHarness
          onClose={() => {
            setOpen(false);
            onClose();
          }}
        />
      ) : null}
    </>
  );
}

const workPanelProps: WorkListPanelProps = {
  works: [],
  isLoading: false,
  error: null,
  selectedWorkId: null,
  onSelect: vi.fn(),
  onCreate: vi.fn(),
  createPending: false,
  createError: null,
  onDelete: vi.fn(),
  deletePending: false,
  onReload: vi.fn(),
};

describe("Modal 焦点与键盘", () => {
  it("打开时焦点落到 data-initial-focus 的元素，dialog 具名且 aria-modal", async () => {
    const user = userEvent.setup();
    render(<TriggerHarness onClose={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "打开" }));

    const dialog = screen.getByRole("dialog", { name: "标题" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "初始焦点" })).toHaveFocus();
  });

  it("没有 data-initial-focus 时焦点落到 dialog 里第一个可聚焦元素", () => {
    render(
      <Modal labelledBy="modal-title" onClose={vi.fn()}>
        <h2 id="modal-title">标题</h2>
        <button type="button">第一个</button>
        <button type="button">第二个</button>
      </Modal>,
    );

    expect(screen.getByRole("button", { name: "第一个" })).toHaveFocus();
  });

  it("Tab 与 Shift+Tab 在 dialog 内环绕，不逃到触发按钮", async () => {
    const user = userEvent.setup();
    render(<TriggerHarness onClose={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: "打开" });
    await user.click(trigger);

    const first = screen.getByRole("button", { name: "第一个" });
    const initial = screen.getByRole("button", { name: "初始焦点" });
    const last = screen.getByRole("button", { name: "最后一个" });
    expect(initial).toHaveFocus();

    // 中间节点交给浏览器顺序，末节点回卷到首节点，首节点 Shift+Tab 回到末节点。
    await user.tab();
    expect(last).toHaveFocus();

    await user.tab();
    expect(first).toHaveFocus();

    await user.tab({ shift: true });
    expect(last).toHaveFocus();

    expect(trigger).not.toHaveFocus();
  });

  it("Escape 关闭 dialog，并把焦点还原给打开它的按钮", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<TriggerHarness onClose={onClose} />);

    const trigger = screen.getByRole("button", { name: "打开" });
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "标题" })).toBeDefined();

    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("pending 时 Escape 关不掉新建书本 dialog，焦点留在书名输入框；pending 结束后可关", async () => {
    const user = userEvent.setup();
    const view = render(<WorkListPanel {...workPanelProps} />);

    await user.click(screen.getByRole("button", { name: "新建书本" }));
    const title = screen.getByLabelText("书名");
    expect(title).toHaveFocus();
    await user.type(title, "长夜将尽");

    // 真实 pending 状态由父层传入：WorkListPanel 的 onClose 在 pending 期间不关窗。
    view.rerender(<WorkListPanel {...workPanelProps} createPending />);
    await user.keyboard("{Escape}");

    expect(screen.getByRole("dialog", { name: "开启一个新故事" })).toBeDefined();
    expect(screen.getByLabelText("书名")).toHaveFocus();
    expect(screen.getByRole("button", { name: "关闭新建书本" })).toBeDisabled();

    view.rerender(<WorkListPanel {...workPanelProps} />);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
