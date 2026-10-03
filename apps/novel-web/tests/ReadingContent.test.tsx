import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ReadingContent } from "../src/components/ReadingContent";

/**
 * ReadingContent 的排版与安全回归：
 * 排版（标题/段落/列表/引用/强调/表格）要替代源文；原始 HTML、危险链接与远程图片
 * 都必须被限制在"可见文本"范围，任何情况下都不产生脚本执行、外部导航或自动网络请求。
 */

function renderReading(text: string, className?: string) {
  const view = render(<ReadingContent text={text} className={className} />);
  const root = view.container.querySelector<HTMLElement>(".reading-content");
  if (root === null) throw new Error("未渲染 reading-content 根容器");
  return { view, root };
}

function paragraphsOf(root: HTMLElement): HTMLParagraphElement[] {
  return Array.from(root.querySelectorAll("p"));
}

describe("ReadingContent 排版", () => {
  it("渲染标题、段落、强调、引用与有序/无序列表，不显示 Markdown 源文", () => {
    const text = [
      "# 第一章 夜行",
      "",
      "他停下脚步，**终于**听见了*回声*，还有~~旧事~~。",
      "",
      "> 引用一句。",
      "",
      "- 第一项",
      "- 第二项",
      "",
      "1. 有序一",
      "2. 有序二",
    ].join("\n");
    const { root } = renderReading(text);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("第一章 夜行");
    expect(root.querySelector("strong")).toHaveTextContent("终于");
    expect(root.querySelector("em")).toHaveTextContent("回声");
    expect(root.querySelector("del")).toHaveTextContent("旧事");
    expect(root.querySelector("blockquote")).toHaveTextContent("引用一句。");
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(root.querySelectorAll("ul > li")).toHaveLength(2);
    expect(root.querySelectorAll("ol > li")).toHaveLength(2);

    // 排版之后不应再看到 Markdown 标记本身。
    expect(root.textContent).not.toContain("**");
    expect(root.textContent).not.toContain("~~");
    expect(root.textContent).not.toContain("# 第一章");
  });

  it("渲染 GFM 表格，并放进可聚焦的横滚容器", () => {
    const text = ["| 角色 | 身份 |", "| --- | --- |", "| 沈砚 | 捕快 |", "| 苏晚 | 医者 |"].join("\n");
    const { root } = renderReading(text);

    const table = screen.getByRole("table");
    expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["角色", "身份"]);
    expect(screen.getAllByRole("row")).toHaveLength(3);

    const scroll = root.querySelector(".reading-content-table-scroll");
    expect(scroll).not.toBeNull();
    expect(scroll).toContainElement(table);
    expect(scroll).toHaveAttribute("tabindex", "0");
    expect(root.textContent).not.toContain("| --- |");
  });

  it("代码块按可读代码渲染，其中的标签不执行", () => {
    const text = ["```html", "<script>window.__dshPwned = true</script>", "```"].join("\n");
    const { root } = renderReading(text);

    const code = root.querySelector("pre > code");
    expect(code).not.toBeNull();
    expect(code?.textContent).toContain("<script>");
    expect(root.querySelector("script")).toBeNull();
    expect((globalThis as { __dshPwned?: unknown }).__dshPwned).toBeUndefined();
  });

  it("纯文本按换行分段并保留行内空白，适配中文正文", () => {
    const text = [
      "\u3000\u3000第一段第一行",
      "第一段第二行",
      "",
      "第二段  中间保留两个空格",
      "",
      "第三段只有一行",
    ].join("\n");
    const { root } = renderReading(text);

    const paragraphs = paragraphsOf(root);
    expect(paragraphs).toHaveLength(3);

    const first = paragraphs[0] as HTMLParagraphElement;
    expect(first.querySelectorAll("br")).toHaveLength(1);
    expect(first.textContent).toBe("\u3000\u3000第一段第一行第一段第二行");

    const second = paragraphs[1] as HTMLParagraphElement;
    expect(second.querySelectorAll("br")).toHaveLength(0);
    expect(second.textContent).toBe("第二段  中间保留两个空格");

    expect(paragraphs[2]?.textContent).toBe("第三段只有一行");

    // 没有 Markdown 块语法时不产生额外块级元素。
    expect(root.querySelector("h1, ul, ol, blockquote, table")).toBeNull();
  });
});

describe("ReadingContent 安全边界", () => {
  it("原始 HTML 只作为文本显示，既不执行也不进入 DOM", () => {
    const text = [
      "<script>window.__dshPwned = true</script>",
      "",
      '<img src="https://tracker.example/raw.png" onerror="window.__dshPwned = true">',
      "",
      '<div onclick="window.__dshPwned = true">正文</div>',
    ].join("\n");
    const { root } = renderReading(text);

    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("[onclick], [onerror]")).toBeNull();
    expect((globalThis as { __dshPwned?: unknown }).__dshPwned).toBeUndefined();

    // 原文仍然可读，但只是文字。
    expect(root.textContent).toContain("<script>");
    expect(root.textContent).toContain('onerror="window.__dshPwned = true"');
    expect(root.textContent).toContain("正文");
    expect(root.innerHTML).not.toContain("<script");
  });

  it("拒绝 javascript/data/file、协议相对与相对路径链接，不生成可点击锚点", () => {
    const text = [
      "[脚本](javascript:alert(1))",
      "[大小写](JaVaScRiPt:alert(1))",
      "[实体](&#106;avascript:alert(1))",
      "[数据](data:text/html;base64,PHNjcmlwdD4=)",
      "[协议相对](//evil.example/steal)",
      "[文件](file:///etc/passwd)",
      "[相对](./chapter-2.md)",
      "[绝对](/internal/chapter)",
      "[空]()",
    ].join("\n\n");
    const { root } = renderReading(text);

    expect(root.querySelector("a")).toBeNull();
    expect(root.querySelector("[href]")).toBeNull();
    expect(root.innerHTML).not.toContain("javascript:");

    const rejectedLabels = Array.from(root.querySelectorAll(".reading-content-link-rejected")).map(
      (node) => node.textContent,
    );
    expect(rejectedLabels).toEqual([
      "脚本",
      "大小写",
      "实体",
      "数据",
      "协议相对",
      "文件",
      "相对",
      "绝对",
      "空",
    ]);
  });

  it("被拒绝的链接降级为文本时仍保留内部行内格式", () => {
    const { root } = renderReading("[**粗体**标签](javascript:alert(1))");

    const rejected = root.querySelector(".reading-content-link-rejected");
    expect(rejected).not.toBeNull();
    expect(rejected?.querySelector("strong")).toHaveTextContent("粗体");
    expect(root.querySelector("a")).toBeNull();
  });

  it("只放行 http/https、mailto 与 #锚点；外链新窗口打开且带 noopener noreferrer", () => {
    const text = [
      "[外链](https://example.com/chapter?from=reader)",
      "[明文](http://example.com/plain)",
      "[邮件](mailto:editor@myrix.example)",
      "[锚点](#第二章)",
    ].join("\n\n");
    renderReading(text);

    const external = screen.getByRole("link", { name: "外链" });
    expect(external).toHaveAttribute("href", "https://example.com/chapter?from=reader");
    expect(external).toHaveAttribute("target", "_blank");
    expect(external).toHaveAttribute("rel", "noopener noreferrer");

    const plain = screen.getByRole("link", { name: "明文" });
    expect(plain).toHaveAttribute("href", "http://example.com/plain");
    expect(plain).toHaveAttribute("target", "_blank");
    expect(plain).toHaveAttribute("rel", "noopener noreferrer");

    // 邮件与页内锚点保持当前上下文，不应被强制新窗口。
    const mail = screen.getByRole("link", { name: "邮件" });
    expect(mail).toHaveAttribute("href", "mailto:editor@myrix.example");
    expect(mail).not.toHaveAttribute("target");
    expect(mail).not.toHaveAttribute("rel");

    const anchor = screen.getByRole("link", { name: "锚点" });
    // micromark 会对非 ASCII 片段做百分号编码，但仍是同页锚点。
    const anchorHref = anchor.getAttribute("href") ?? "";
    expect(anchorHref.startsWith("#")).toBe(true);
    expect(decodeURIComponent(anchorHref)).toBe("#第二章");
    expect(anchor).not.toHaveAttribute("target");
    expect(anchor).not.toHaveAttribute("rel");
  });

  it("远程图片不自动加载，改为可访问文字占位且不产生网络请求", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const openSpy = vi.spyOn(XMLHttpRequest.prototype, "open");

    const text = [
      '![封面图](https://tracker.example/pixel.png "封面")',
      "",
      "![](https://tracker.example/beacon.png)",
    ].join("\n");
    const { root } = renderReading(text);

    // 不输出 <img>，也不留下任何 src/srcset 属性。
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("[src], [srcset]")).toBeNull();

    const placeholders = Array.from(root.querySelectorAll('[role="img"]'));
    expect(placeholders).toHaveLength(2);
    expect(placeholders[0]).toHaveAttribute("aria-label", "封面图");
    expect(placeholders[0]?.textContent).toContain("封面图");
    expect(placeholders[1]).toHaveAttribute("aria-label", "图片");
    expect(placeholders[1]?.textContent).toContain("[图片]");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });
});

describe("ReadingContent 根容器", () => {
  it("始终带 reading-content，并把调用方 className 追加在后面", () => {
    const { view, root } = renderReading("正文", "novel-body");
    expect(root).toHaveClass("reading-content", "novel-body");

    view.rerender(<ReadingContent text="正文" />);
    const rerendered = view.container.querySelector(".reading-content");
    expect(rerendered).toHaveClass("reading-content");
    expect(rerendered).not.toHaveClass("novel-body");
  });

  it("空文本仍渲染稳定容器且不产生块级标记", () => {
    const { root } = renderReading("");

    expect(root).toHaveClass("reading-content");
    expect(root.textContent).toBe("");
    expect(root.querySelector("p, h1, ul, ol, blockquote, table")).toBeNull();
  });
});
