import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ChatMessageView } from "../src/components/ChatMessageView";
import type { ChatMessage } from "../src/state/chatReducer";

/**
 * 对话气泡的渲染边界（AssistantPanel 之外的组件级回归）：
 * - 助手正文走 ReadingContent 语义排版，原始 HTML 只作可见文本；
 * - 工具事件是**执行记录**，默认折叠，不被误读成已保存的正文；
 * - 用户消息里的“当前选中对象”上下文折叠展示，正文只保留用户真正说出的内容。
 */

function message(overrides: Partial<ChatMessage> & Pick<ChatMessage, "role" | "text">): ChatMessage {
  return { key: "k-1", createdAt: 0, ...overrides };
}

describe("ChatMessageView 助手正文", () => {
  it("按语义排版渲染 Markdown，不把标记当正文", () => {
    const { container } = render(
      <ChatMessageView
        message={message({ role: "assistant", text: "# 夜行\n\n- 第一项\n- 第二项", seq: 4 })}
      />,
    );

    const body = container.querySelector(".msg.assistant .msg-text") as HTMLElement;
    expect(body).toHaveClass("reading-content");
    expect(within(body).getByRole("heading", { level: 1, name: "夜行" })).toBeDefined();
    expect(within(body).getAllByRole("listitem")).toHaveLength(2);
    expect(body.textContent).not.toContain("# 夜行");
  });

  it("原始 HTML 只按字面文本显示，不产生可执行元素，并显式标注", () => {
    const { container } = render(
      <ChatMessageView
        message={message({
          role: "assistant",
          text: '<img src=x onerror="alert(1)">危险输出',
          seq: 7,
        })}
      />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
    const body = container.querySelector(".msg.assistant .msg-text") as HTMLElement;
    expect(body.textContent).toContain('<img src=x onerror="alert(1)">危险输出');
    expect(screen.getByText("按纯文本显示（未解析 HTML）")).toBeDefined();
  });

  it("流式内容标注未落定，终态消息不冒充已确认回复", () => {
    const { container, rerender } = render(
      <ChatMessageView message={message({ role: "assistant", text: "部分内容", streaming: true })} />,
    );
    expect(screen.getByText("正在生成 · 尚未确认")).toBeDefined();
    expect(container.querySelector(".msg.assistant")).toHaveAttribute("data-streaming", "true");

    rerender(<ChatMessageView message={message({ role: "assistant", text: "部分内容", seq: 9 })} />);
    expect(screen.queryByText("正在生成 · 尚未确认")).toBeNull();
    expect(container.querySelector(".msg.assistant")).toHaveAttribute("data-streaming", "false");
  });
});

describe("ChatMessageView 工具执行记录", () => {
  it("工具事件默认折叠为 details，摘要用可读名称并保留原始工具名", () => {
    const { container } = render(
      <ChatMessageView
        message={message({ role: "tool", text: "{}", toolName: "get_chapter", seq: 9 })}
      />,
    );

    const details = container.querySelector("details.tool-activity") as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);

    const summary = details.querySelector("summary") as HTMLElement;
    expect(summary.textContent).toContain("读取章节");
    expect(summary.textContent).toContain("查看记录");
    expect(details.querySelector("pre.code")?.textContent).toBe("{}");
    // 记录了真实工具名，便于核对执行证据。
    expect(details.querySelector(".msg-meta")?.textContent).toBe("get_chapter");
    expect(details.textContent).toContain("这是执行记录");
    // 工具记录不应渲染成助手正文气泡。
    expect(container.querySelector(".msg.assistant")).toBeNull();
  });

  it("未知工具名回退到中性标题，仍保持 collapsed", () => {
    const { container } = render(
      <ChatMessageView message={message({ role: "tool", text: "raw", toolName: "some_new_tool" })} />,
    );
    const details = container.querySelector("details.tool-activity") as HTMLDetailsElement;
    expect(details.querySelector("summary")?.textContent).toContain("创作操作");
    expect(details.open).toBe(false);
  });
});

describe("ChatMessageView 用户消息的选中对象", () => {
  const contextJson = '{"kind":"chapter","workId":"w1","id":"c1","title":"第一章","dirty":true}';
  const withContext = `把这一段改得更克制\n\n【当前选中对象】\n${contextJson}\n先用 get_chapter 读取。`;

  it("正文只显示用户真正输入的内容，选中对象放进折叠的 details", () => {
    const { container } = render(
      <ChatMessageView message={message({ role: "user", text: withContext, seq: 2 })} />,
    );

    const body = container.querySelector(".msg.user .msg-text") as HTMLElement;
    expect(body.textContent).toBe("把这一段改得更克制");

    const details = container.querySelector("details.sent-context") as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toContain("本条消息的修改目标");
    expect(details.querySelector("pre.code")?.textContent).toContain(contextJson);
  });

  it("没有上下文追加时只有正文，不渲染空的 details", () => {
    const { container } = render(
      <ChatMessageView message={message({ role: "user", text: "普通消息", seq: 1 })} />,
    );
    expect(container.querySelector(".msg.user .msg-text")?.textContent).toBe("普通消息");
    expect(container.querySelector("details.sent-context")).toBeNull();
  });

  it("待服务端确认的用户命令显式标注入队，不伪装成已完成", () => {
    const { container } = render(
      <ChatMessageView
        message={message({ role: "user", text: "写一段开头", pending: true, commandId: "c1" })}
      />,
    );
    expect(screen.getByText("已入队，等待服务端确认")).toBeDefined();
    expect(container.querySelector(".msg.user")).toHaveAttribute("data-role", "user");
    expect(container.querySelector(".msg.user .msg-text")?.textContent).toBe("写一段开头");
  });
});
