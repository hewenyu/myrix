import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * Manuscript 是"阅读优先、编辑显式"的唯一入口：
 * - 已有正文且没有未保存草稿时**默认阅读**，只做语义排版；
 * - 空内容或已有未保存草稿时默认进入编辑器；
 * - 两种模式共享同一个 `value`，切换只改可见性，**绝不序列化/改写原文**，
 *   也绝不触发 `onChange`（否则切换阅读就会伪造一次编辑）。
 *
 * Tiptap 的 DOM 机制由 PlainTextEditor.test 覆盖；这里用等价受控 textarea 代替，
 * 以便逐字核对传给编辑器的载入源。
 */
vi.mock("../src/components/PlainTextEditor", () => ({
  PlainTextEditor: ({
    value,
    onChange,
    ariaLabel,
    placeholder,
  }: {
    value: string;
    onChange: (text: string) => void;
    ariaLabel: string;
    placeholder?: string;
  }) => (
    <textarea
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

import { Manuscript } from "../src/components/Manuscript";

const TITLE = "第一章 夜行";
const LABEL = "章节正文：第一章 夜行";

function renderManuscript(overrides: Partial<Parameters<typeof Manuscript>[0]> = {}) {
  const onChange = vi.fn();
  const props = {
    value: "# 夜行\n\n他停下脚步，**终于**听见了回声。",
    onChange,
    title: TITLE,
    label: LABEL,
    placeholder: "写点什么",
    dirty: false,
    ...overrides,
  };
  return { onChange, props, ...render(<Manuscript {...props} />) };
}

function editingButton(): HTMLElement {
  return screen.getByRole("button", { name: "编辑原文" });
}

function readingButton(): HTMLElement {
  return screen.getByRole("button", { name: "阅读" });
}

/** 阅读态的正文容器：aria-label 带“阅读”后缀，编辑器的 aria-label 不带。 */
function readingArticle(label = LABEL): HTMLElement {
  return screen.getByLabelText(`${label}阅读`);
}

describe("Manuscript 阅读优先", () => {
  it("已有正文且无草稿时默认阅读：只渲染语义排版，不挂载编辑器，不回调 onChange", () => {
    const { onChange } = renderManuscript();

    expect(readingButton()).toHaveAttribute("aria-pressed", "true");
    expect(editingButton()).toHaveAttribute("aria-pressed", "false");

    const article = readingArticle();
    expect(within(article).getByRole("heading", { level: 1, name: "夜行" })).toBeDefined();
    expect(article.querySelector("strong")).toHaveTextContent("终于");
    // 源文标记只作排版输入，不再以字面出现在阅读态。
    expect(article.textContent).not.toContain("**");
    expect(article.textContent).not.toContain("# 夜行");

    // 编辑器不存在：阅读态不是“隐藏的 textarea”。
    expect(screen.queryByLabelText(LABEL)).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("标题与占位文案在两种模式下都稳定渲染", () => {
    renderManuscript({ value: "", dirty: false });

    // 空内容默认编辑：标题仍在，占位提示交给编辑器。
    expect(screen.getByRole("heading", { level: 1, name: TITLE })).toBeDefined();
    expect(screen.getByLabelText(LABEL)).toHaveAttribute("placeholder", "写点什么");
    expect(editingButton()).toHaveAttribute("aria-pressed", "true");
  });

  it("切换阅读/编辑原文不改写原文：载入源与展示源始终逐字一致", async () => {
    const user = userEvent.setup();
    // 连续空格、空行、Markdown 标记与原始 HTML 都必须原样保留。
    const source = "首行  中间两个空格\n\n**标记**与<img src=x>标签\n  行首行尾  ";
    const { onChange } = renderManuscript({ value: source });

    await user.click(editingButton());
    const field = screen.getByLabelText(LABEL) as HTMLTextAreaElement;
    expect(field.value).toBe(source);

    await user.click(readingButton());
    // 阅读态把标记排版掉，但不写回任何内容。
    expect(readingArticle().querySelector("strong")).toHaveTextContent("标记");
    expect(readingArticle().querySelector("img")).toBeNull();
    expect(readingArticle().textContent).toContain("<img src=x>");

    await user.click(editingButton());
    expect((screen.getByLabelText(LABEL) as HTMLTextAreaElement).value).toBe(source);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("编辑器输入只把纯文本交给 onChange，不夹带序列化格式", async () => {
    const user = userEvent.setup();
    // 受控宿主：Editor 的 value 由 onChange 回灌，模拟真实草稿状态。
    const onChange = vi.fn();
    function Live() {
      const [value, setValue] = useState("");
      return (
        <Manuscript
          value={value}
          onChange={(text) => {
            onChange(text);
            setValue(text);
          }}
          title={TITLE}
          label={LABEL}
          placeholder="写点什么"
        />
      );
    }
    render(<Live />);
    await user.type(screen.getByLabelText(LABEL), "新的一段");

    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls.at(-1)?.[0]).toBe("新的一段");
    expect((screen.getByLabelText(LABEL) as HTMLTextAreaElement).value).toBe("新的一段");
  });
});

describe("Manuscript 进入编辑的条件", () => {
  it("空内容（含只有空白）默认进入编辑，并可保存空内容", () => {
    const { onChange } = renderManuscript({ value: "   \n  " });

    expect(editingButton()).toHaveAttribute("aria-pressed", "true");
    expect(readingButton()).toHaveAttribute("aria-pressed", "false");
    expect((screen.getByLabelText(LABEL) as HTMLTextAreaElement).value).toBe("   \n  ");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("有未保存草稿时即使已有正文也默认进入编辑，并显式标注草稿", () => {
    renderManuscript({ value: "已保存的正文", dirty: true });

    expect(editingButton()).toHaveAttribute("aria-pressed", "true");
    expect((screen.getByLabelText(LABEL) as HTMLTextAreaElement).value).toBe("已保存的正文");
    expect(screen.getByText(/未保存草稿/)).toBeDefined();
  });

  it("阅读态的空文档给出“开始写作”，点击后进入编辑", async () => {
    const user = userEvent.setup();
    // 用户从编辑态显式切回阅读后，空文档仍要能从阅读态走回编辑。
    renderManuscript({ value: "", dirty: false });
    await user.click(readingButton());

    expect(screen.getByRole("button", { name: "开始写作" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "开始写作" }));
    expect(editingButton()).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText(LABEL)).toBeDefined();
  });
});
