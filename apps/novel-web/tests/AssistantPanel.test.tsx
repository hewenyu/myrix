import type { NovelSession } from "@myrix/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AssistantPanel } from "../src/panels/AssistantPanel";
import { emptyChatState } from "../src/state/chatReducer";
import type { SessionStreamState } from "../src/state/useSessionStream";

function streamState(overrides: Partial<SessionStreamState> = {}): SessionStreamState {
  return {
    sessionId: "s1",
    messages: [],
    connected: true,
    turnActive: false,
    turnOutcome: null,
    turnOutcomeReason: null,
    turnPublicText: false,
    serverStatus: null,
    serverStatusSeq: null,
    settlements: 0,
    settledSeq: null,
    notice: null,
    needsReplay: false,
    lastCommandId: null,
    send: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    sending: false,
    error: null,
    clearError: vi.fn(),
    reconnect: vi.fn(),
    ...overrides,
  };
}

const session: NovelSession = {
  id: "s1",
  workId: "w1",
  preset: "novel-chapter",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function renderPanel(overrides: { stream?: Partial<SessionStreamState>; sessions?: NovelSession[] } = {}) {
  return render(
    <AssistantPanel
      workId="w1"
      sessions={overrides.sessions ?? [session]}
      sessionsLoading={false}
      sessionsError={null}
      selectedSessionId="s1"
      onSelectSession={vi.fn()}
      onCreateSession={vi.fn()}
      createPending={false}
      createError={null}
      onDeleteSession={vi.fn()}
      deletePending={false}
      onReloadSessions={vi.fn()}
      stream={streamState(overrides.stream)}
      runtimeHint={null}
    />,
  );
}

describe("AssistantPanel", () => {
  it("展示三个 preset 选项与新建会话按钮", () => {
    render(
      <AssistantPanel
        workId="w1"
        sessions={[]}
        sessionsLoading={false}
        sessionsError={null}
        selectedSessionId={null}
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
        createPending={false}
        createError={null}
        onDeleteSession={vi.fn()}
        deletePending={false}
        onReloadSessions={vi.fn()}
        stream={streamState({ sessionId: null })}
        runtimeHint={null}
      />,
    );

    const presetOptions = screen.getAllByTestId("preset-option");
    expect(presetOptions.map((option) => option.textContent)).toEqual([
      expect.stringContaining("大纲助手"),
      expect.stringContaining("章节写作"),
      expect.stringContaining("设定管理"),
    ]);
    expect(screen.getByRole("button", { name: /新建会话/ })).toBeDefined();
  });

  it("模型输出中的 HTML 只按纯文本渲染，不会注入 DOM", () => {
    const { container } = renderPanel({
      stream: {
        messages: [
          {
            key: "seq-1",
            role: "assistant",
            text: '<img src=x onerror="alert(1)">危险输出',
            seq: 1,
            createdAt: 0,
          },
        ],
      },
    });

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/危险输出/)).toBeDefined();
    expect(screen.getByText(/按纯文本显示/)).toBeDefined();
  });

  it("已入队但未确认的用户命令显示为待确认，不伪装成已完成回复", () => {
    renderPanel({
      stream: {
        messages: [{ key: "pending-1", role: "user", text: "写一段开头", pending: true, commandId: "c1", createdAt: 0 }],
        lastCommandId: "c1",
      },
    });

    expect(screen.getByText("已入队，等待服务端确认")).toBeDefined();
  });

  it("流式输出明确标注未落定", () => {
    renderPanel({
      stream: {
        turnActive: true,
        messages: [{ key: "delta-1", role: "assistant", text: "部分内容", streaming: true, createdAt: 0 }],
      },
    });
    expect(screen.getByText("流式输出中（未落定）")).toBeDefined();
  });

  it("事件流断开时给出明确提示", () => {
    renderPanel({ stream: { connected: false } });
    expect(screen.getByText(/事件流已断开/)).toBeDefined();
  });

  it("选中会话时取消可用；本页没有命令记录时给出明确说明而不是静默失败", async () => {
    const cancel = vi.fn(async () => undefined);
    const user = userEvent.setup();
    renderPanel({ stream: { cancel, lastCommandId: null } });

    const cancelButton = screen.getByRole("button", { name: "取消" });
    expect(cancelButton).toBeEnabled();
    expect(cancelButton.getAttribute("title")).toContain("本页没有记录到命令");

    await user.click(cancelButton);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("没有选中会话时取消按钮不可用", () => {
    render(
      <AssistantPanel
        workId="w1"
        sessions={[]}
        sessionsLoading={false}
        sessionsError={null}
        selectedSessionId={null}
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
        createPending={false}
        createError={null}
        onDeleteSession={vi.fn()}
        deletePending={false}
        onReloadSessions={vi.fn()}
        stream={streamState({ sessionId: null })}
        runtimeHint={null}
      />,
    );
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
  });

  it("提交消息后清空输入框并调用 send", async () => {
    const send = vi.fn(async () => undefined);
    const user = userEvent.setup();
    renderPanel({ stream: { send } });

    const textarea = screen.getByLabelText("消息输入");
    await user.type(textarea, "帮我写第一段");
    await user.click(screen.getByRole("button", { name: "提交" }));

    expect(send).toHaveBeenCalledWith("帮我写第一段");
    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });

  it("服务端报告的状态原样展示（唤醒中 / 中断）", () => {
    renderPanel({ stream: { serverStatus: "waking" } });
    expect(screen.getByText("正在唤醒运行单元")).toBeDefined();
  });

  it("运行标签落到持久终态，不停在瞬态 stream-start", () => {
    // 瞬态控制帧不写 serverStatus（reducer 保证），因此这里 serverStatus 为空。
    const completed = renderPanel({
      stream: { turnOutcome: "completed", settledSeq: 10, turnActive: false, turnPublicText: true },
    });
    expect(completed.container.querySelector(".toolbar")?.textContent).toContain("本轮已完成");
    completed.unmount();

    // 未知持久状态原样展示，不美化。
    renderPanel({ stream: { serverStatus: "something-new", serverStatusSeq: 3 } });
    expect(screen.getByText("something-new")).toBeDefined();
  });

  it("没有选中会话时不允许提交", () => {
    render(
      <AssistantPanel
        workId="w1"
        sessions={[]}
        sessionsLoading={false}
        sessionsError={null}
        selectedSessionId={null}
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
        createPending={false}
        createError={null}
        onDeleteSession={vi.fn()}
        deletePending={false}
        onReloadSessions={vi.fn()}
        stream={streamState({ sessionId: null, messages: emptyChatState.messages })}
        runtimeHint={null}
      />,
    );
    expect(screen.getByRole("button", { name: "提交" })).toBeDisabled();
    expect(screen.getByPlaceholderText("先选择或新建会话")).toBeDefined();
    expect(screen.getByText(/选择或新建一个会话后开始对话/)).toBeDefined();
  });

  it("失败/中断/会话结束的回合给出显式终态横幅而不是静默", () => {
    const failed = renderPanel({ stream: { turnOutcome: "failed", turnOutcomeReason: "本轮执行失败" } });
    expect(screen.getByText(/本回合执行失败：本轮执行失败/)).toBeDefined();
    failed.unmount();

    const interrupted = renderPanel({ stream: { turnOutcome: "interrupted" } });
    expect(screen.getByText(/本回合被中断/)).toBeDefined();
    interrupted.unmount();

    const ended = renderPanel({ stream: { turnOutcome: "session-ended", turnOutcomeReason: "会话状态变为 revoked" } });
    expect(screen.getByText(/会话已结束：会话状态变为 revoked/)).toBeDefined();
  });

  it("回合状态通过 data 属性暴露：进行中不是完成", () => {
    const { container } = renderPanel({
      stream: {
        turnActive: true,
        turnOutcome: null,
        messages: [
          { key: "seq-5", role: "user", text: "读大纲", seq: 5, createdAt: 0 },
          { key: "tool-seq-9", role: "tool", text: "", toolName: "get_outline", seq: 9, createdAt: 0 },
        ],
      },
    });
    const log = container.querySelector('[data-testid="chat-log"]')!;
    expect(log.getAttribute("data-turn-active")).toBe("true");
    expect(log.getAttribute("data-turn-outcome")).toBe("none");
    expect(log.getAttribute("data-turn-public-text")).toBe("false");
    // 工具记录是过程元信息，不是助手正文。
    expect(container.querySelectorAll(".msg.assistant")).toHaveLength(0);
    expect(container.querySelectorAll(".msg.tool")).toHaveLength(1);
  });

  it("没有公开文本的助手气泡不会被渲染", () => {
    const { container } = renderPanel({
      stream: {
        turnOutcome: "completed",
        turnActive: false,
        messages: [
          { key: "seq-5", role: "user", text: "读大纲并保存", seq: 5, createdAt: 0 },
          // 工具步骤投影出的空 assistant 事件：即使泄漏到 state，也不能渲染成泡。
          { key: "seq-8", role: "assistant", text: "", seq: 8, createdAt: 0 },
          { key: "seq-13", role: "assistant", text: "   ", seq: 13, createdAt: 0 },
          { key: "tool-seq-9", role: "tool", text: "", toolName: "get_outline", seq: 9, createdAt: 0 },
          { key: "seq-23", role: "assistant", text: "真实最终正文", seq: 23, createdAt: 0 },
        ],
      },
    });
    const bubbles = [...container.querySelectorAll(".msg.assistant")];
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]!.querySelector(".msg-text")?.textContent).toBe("真实最终正文");
    expect(container.querySelectorAll('[data-seq="8"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-seq="13"]')).toHaveLength(0);
    // 已确认用户消息与工具过程记录仍然可见。
    expect(screen.getByText("读大纲并保存")).toBeDefined();
    expect(container.querySelectorAll(".msg.tool")).toHaveLength(1);
  });
});
