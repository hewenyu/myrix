import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildChapterAssistantContext,
  ChapterAssistantContext,
  type AssistantChapterRef,
} from "../src/components/ChapterAssistantContext";

const chapterA: AssistantChapterRef = { id: "c-1", workId: "w-1", title: "第一章 出发" };
const chapterB: AssistantChapterRef = { id: "c-2", workId: "w-1", title: "第二章 归来" };
const chapterOtherWork: AssistantChapterRef = { id: "c-1", workId: "w-2", title: "另一个作品的第一章" };

/** 直接替换 navigator.clipboard，并在用例结束时还原原来的属性描述符。 */
function stubClipboard(clipboard: { writeText: (text: string) => Promise<void> } | undefined) {
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, writable: true, value: clipboard });
  return () => {
    if (original) {
      Object.defineProperty(navigator, "clipboard", original);
    } else {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  };
}

const restores: Array<() => void> = [];

afterEach(() => {
  while (restores.length > 0) {
    restores.pop()?.();
  }
});

/** userEvent.setup() 会自行注入剪贴板桩，因此桩必须在 setup 之后再装。 */
function setupClipboard(clipboard: { writeText: (text: string) => Promise<void> } | undefined) {
  const user = userEvent.setup();
  restores.push(stubClipboard(clipboard));
  return user;
}

function contextBox(): HTMLTextAreaElement {
  return screen.getByLabelText("章节助手上下文") as HTMLTextAreaElement;
}

describe("ChapterAssistantContext", () => {
  it("展示所选章节的标题、作品ID、章节ID，并给出可复制的上下文文本", () => {
    render(<ChapterAssistantContext chapter={chapterA} dirty />);

    const details = screen.getByRole("group", { name: "章节助手上下文详情" });
    expect(details.textContent).toContain("作品ID：w-1");
    expect(details.textContent).toContain("章节ID：c-1");
    // title 走 React 文本节点渲染。
    expect(details.textContent).toContain("章节标题：第一章 出发");
    expect(details.textContent).toContain("未保存草稿：有");

    const box = contextBox();
    expect(box).toHaveAttribute("readonly");
    expect(box.value).toContain("w-1");
    expect(box.value).toContain("c-1");
    expect(box.value).toContain("第一章 出发");
    expect(box.value).toContain(
      "先调用get_chapter读取当前已保存内容及版本，再按我的要求修改；写入使用刚读到的expectedVersion",
    );

    // 文案明确：复制到同一作品的助手输入框，且草稿不会自动发送。
    const note = screen.getByRole("note");
    expect(note.textContent).toContain("复制到同一作品的章节助手输入框");
    expect(note.textContent).toContain("未保存草稿不会自动发送");
  });

  it("上下文不包含章节正文，也不自行提交任何消息", () => {
    const secret = "服务端刚保存的正文片段-绝不应出现在上下文里";
    const chapterWithText: AssistantChapterRef & { text: string; version: number } = {
      ...chapterA,
      text: secret,
      version: 7,
    };

    render(<ChapterAssistantContext chapter={chapterWithText} />);

    const box = contextBox();
    expect(box.value).not.toContain(secret);
    expect(box.value).not.toContain("text");
    // 组件不接收也不渲染任何发送/提交入口。
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "复制章节上下文" })).toBeDefined();
    expect(screen.queryByRole("textbox", { name: /输入/ })).toBeNull();
  });

  it("点击复制时用用户手势调用 navigator.clipboard.writeText 并给出成功提示", async () => {
    const writeText = vi.fn(async () => undefined);
    const user = setupClipboard({ writeText });

    render(<ChapterAssistantContext chapter={chapterA} />);
    await user.click(screen.getByRole("button", { name: "复制章节上下文" }));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(buildChapterAssistantContext(chapterA));
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("已复制");
  });

  it("没有剪贴板 API 时给出可操作提示，且上下文仍可手动选中复制", async () => {
    const user = setupClipboard(undefined);

    render(<ChapterAssistantContext chapter={chapterA} />);
    const box = contextBox();
    await user.click(screen.getByRole("button", { name: "复制章节上下文" }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("手动选中");
    expect(status.textContent).toContain("Ctrl/Cmd+C");

    // 提示指向的“可手动选中”确实成立。
    await user.click(box);
    await user.keyboard("{Control>}a{/Control}");
    expect(box.selectionStart).toBe(0);
    expect(box.selectionEnd).toBe(box.value.length);
    expect(box.value.length).toBeGreaterThan(0);
  });

  it("剪贴板写入被拒绝时给出可操作提示，文本仍可手动选中", async () => {
    const writeText = vi.fn(() => Promise.reject(new Error("NotAllowedError")));
    const user = setupClipboard({ writeText });

    render(<ChapterAssistantContext chapter={chapterA} />);
    const box = contextBox();
    await user.click(screen.getByRole("button", { name: "复制章节上下文" }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("手动选中");
    expect(status.textContent).not.toContain("已复制");

    await user.click(box);
    await user.keyboard("{Control>}a{/Control}");
    expect(box.selectionEnd).toBe(box.value.length);
  });

  it("切换章节后展示新上下文，且旧的“已复制”提示不残留", async () => {
    const writeText = vi.fn(async () => undefined);
    const user = setupClipboard({ writeText });

    const { rerender } = render(<ChapterAssistantContext chapter={chapterA} />);
    await user.click(screen.getByRole("button", { name: "复制章节上下文" }));
    expect((await screen.findByRole("status")).textContent).toContain("已复制");

    rerender(<ChapterAssistantContext chapter={chapterB} />);

    expect(screen.queryByRole("status")).toBeNull();
    const box = contextBox();
    expect(box.value).toContain("c-2");
    expect(box.value).toContain("第二章 归来");
    expect(box.value).not.toContain("c-1");
  });

  it("切换作品（章节ID相同）同样清除旧提示并换上新上下文", async () => {
    const writeText = vi.fn(async () => undefined);
    const user = setupClipboard({ writeText });

    const { rerender } = render(<ChapterAssistantContext chapter={chapterA} />);
    await user.click(screen.getByRole("button", { name: "复制章节上下文" }));
    expect((await screen.findByRole("status")).textContent).toContain("已复制");

    rerender(<ChapterAssistantContext chapter={chapterOtherWork} />);

    expect(screen.queryByRole("status")).toBeNull();
    const box = contextBox();
    expect(box.value).toContain("w-2");
    expect(box.value).not.toContain("w-1");
  });

  it("为旧章节发起的异步复制晚到时，不会在新章节上显示成功", async () => {
    let resolveWrite: (() => void) | undefined;
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    const user = setupClipboard({ writeText });

    const { rerender } = render(<ChapterAssistantContext chapter={chapterA} />);
    await user.click(screen.getByRole("button", { name: "复制章节上下文" }));
    expect(writeText).toHaveBeenCalledTimes(1);

    // 复制尚未完成就切到新章节。
    rerender(<ChapterAssistantContext chapter={chapterB} />);

    await act(async () => {
      resolveWrite?.();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(contextBox().value).toContain("c-2");
  });

  it("同一章节的标题或草稿提示变化后，也作废旧复制结果", async () => {
    let resolveWrite: (() => void) | undefined;
    const user = setupClipboard({ writeText: vi.fn(() => new Promise<void>((resolve) => { resolveWrite = resolve; })) });
    const { rerender } = render(<ChapterAssistantContext chapter={chapterA} />);
    await user.click(screen.getByRole("button", { name: "复制章节上下文" }));
    rerender(<ChapterAssistantContext chapter={{ ...chapterA, title: "更新后的标题" }} dirty />);
    await act(async () => { resolveWrite?.(); });
    expect(screen.queryByRole("status")).toBeNull();
    expect(contextBox().value).toContain("更新后的标题");
    expect(contextBox().value).toContain("未保存草稿：有");
  });

  it("卸载后旧复制结果不会污染新挂载的同一章节", async () => {
    let rejectWrite: ((error: Error) => void) | undefined;
    const user = setupClipboard({ writeText: vi.fn(() => new Promise<void>((_resolve, reject) => { rejectWrite = reject; })) });
    const first = render(<ChapterAssistantContext chapter={chapterA} />);
    await user.click(screen.getByRole("button", { name: "复制章节上下文" }));
    first.unmount();
    render(<ChapterAssistantContext chapter={chapterA} />);
    await act(async () => { rejectWrite?.(new Error("Late clipboard rejection")); });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("旧章节的异步失败晚到时，也不会在新章节上显示失败", async () => {
    let rejectWrite: ((error: Error) => void) | undefined;
    const writeText = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectWrite = reject;
        }),
    );
    const user = setupClipboard({ writeText });

    const { rerender } = render(<ChapterAssistantContext chapter={chapterA} />);
    await user.click(screen.getByRole("button", { name: "复制章节上下文" }));

    rerender(<ChapterAssistantContext chapter={chapterB} />);

    await act(async () => {
      rejectWrite?.(new Error("NotAllowedError"));
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });
});
