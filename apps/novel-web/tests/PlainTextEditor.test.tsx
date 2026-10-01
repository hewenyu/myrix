import { BLOCK_SEPARATOR, PlainTextEditor, toPlainTextDocument } from "../src/components/PlainTextEditor";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

function textFromDocument(content: ReturnType<typeof toPlainTextDocument>): string {
  return (content.content ?? [])
    .map((node) => (node.content ?? []).map((child) => child.text ?? "").join(""))
    .join(BLOCK_SEPARATOR);
}

describe("toPlainTextDocument", () => {
  it("构造 JSON 文档而不是 HTML 字符串，模型文本不会被当作标记", () => {
    const content = toPlainTextDocument('<img src=x onerror="alert(1)">你好');
    expect(content.type).toBe("doc");
    // 文本被放在 text 节点里，而不是被当作可解析的 HTML 标记。
    expect(content.content?.[0]?.type).toBe("paragraph");
    expect(content.content?.[0]?.attrs).toBeUndefined();
    expect(content.content).toHaveLength(1);
    expect(content.content?.[0]?.content?.[0]?.text).toBe('<img src=x onerror="alert(1)">你好');
  });

  it("空行是空段落，与 getText 的 blockSeparator 往返一致", () => {
    const samples = ["a\n\nb", "", "单行", "首行\n\n\n尾行", "行内 多个   空格", "  行首行尾  "];
    for (const sample of samples) {
      expect(textFromDocument(toPlainTextDocument(sample))).toBe(sample);
    }
  });
});

describe("PlainTextEditor", () => {
  it("包含 HTML 的纯文本按字面显示，不产生可执行元素", () => {
    const raw = '<script>alert("xss")</script>\n\n<b>加粗</b>';
    const { container } = render(
      <PlainTextEditor value={raw} onChange={() => undefined} ariaLabel="测试编辑器" />,
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain('<script>alert("xss")</script>');
    expect(container.textContent).toContain("<b>加粗</b>");
  });

  it("编辑后以纯文本回调，输入的内容不会被解析成标签", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(
      <PlainTextEditor value="" onChange={onChange} ariaLabel="测试编辑器" />,
    );

    const editable = container.querySelector(".tiptap") as HTMLElement;
    expect(editable).not.toBeNull();
    await user.click(editable);
    await user.keyboard("第一段");

    expect(onChange).toHaveBeenCalled();
    const first = onChange.mock.calls.at(-1)?.[0] as string;
    expect(first).toContain("第一段");

    await user.keyboard("<b>不是标签</b>");
    const afterHtml = onChange.mock.calls.at(-1)?.[0] as string;
    expect(afterHtml).toContain("<b>不是标签</b>");
    expect(container.querySelector(".tiptap b")).toBeNull();
  });

  it("外部值变化时同步进编辑器内容而不触发 onChange", () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <PlainTextEditor value="初始" onChange={onChange} ariaLabel="测试编辑器" />,
    );
    expect(container.querySelector(".tiptap")?.textContent).toContain("初始");

    rerender(<PlainTextEditor value="重新读取的内容" onChange={onChange} ariaLabel="测试编辑器" />);
    expect(container.querySelector(".tiptap")?.textContent).toContain("重新读取的内容");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("保留行内连续空格与空行（不会被 HTML 解析改写）", () => {
    const raw = "前  后\n\n尾";
    const { container } = render(
      <PlainTextEditor value={raw} onChange={() => undefined} ariaLabel="测试编辑器" />,
    );
    const editor = container.querySelector(".tiptap") as HTMLElement;
    const paragraphs = editor.querySelectorAll("p");
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[0]?.textContent).toBe("前  后");
    expect(paragraphs[1]?.textContent).toBe("");
    expect(paragraphs[2]?.textContent).toBe("尾");
  });

  it("readOnly 时不可编辑", () => {
    const { container } = render(
      <PlainTextEditor value="只读" onChange={() => undefined} readOnly ariaLabel="只读编辑器" />,
    );
    const editable = container.querySelector(".tiptap") as HTMLElement;
    expect(editable.getAttribute("contenteditable")).toBe("false");
    expect(screen.getByLabelText("只读编辑器")).toBeDefined();
  });
});
