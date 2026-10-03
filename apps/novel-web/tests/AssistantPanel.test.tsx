import type { NovelSession } from "@myrix/contracts";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AssistantPanel, type AssistantPanelProps } from "../src/panels/AssistantPanel";
import type { SessionStreamState } from "../src/state/useSessionStream";

/**
 * 创作助手面板的真实组件测试。
 *
 * 只替换 `stream`（useSessionStream 的返回）与调用方回调；面板自身的状态机
 * （统一 Agent、Enter/Shift+Enter/IME、首条消息等待连接、草稿保留、历史分组、
 * 归档只读、停止生成门控）是**真实实现**。
 */

const ISO = "2026-01-01T00:00:00.000Z";

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
    send: vi.fn(async () => true),
    cancel: vi.fn(async () => undefined),
    sending: false,
    error: null,
    clearError: vi.fn(),
    reconnect: vi.fn(),
    ...overrides,
  };
}

function session(overrides: Partial<NovelSession> = {}): NovelSession {
  return { id: "s1", workId: "w1", preset: "novel-assistant", status: "active", createdAt: ISO, ...overrides };
}

/** 用 partial stream 覆盖：面板只依赖 SessionStreamState 的字段，测试不必逐个写全。 */
type PanelOverrides = Omit<Partial<AssistantPanelProps>, "stream"> & { stream?: Partial<SessionStreamState> };

function panelProps(overrides: PanelOverrides = {}): AssistantPanelProps {
  const { stream, ...rest } = overrides;
  return {
    workId: "w1",
    sessions: [session()],
    sessionsLoading: false,
    sessionsError: null,
    selectedSessionId: "s1",
    onSelectSession: vi.fn(),
    onCreateSession: vi.fn(async () => "s1"),
    onNewConversation: vi.fn(),
    createPending: false,
    createError: null,
    onDeleteSession: vi.fn(),
    deletePending: false,
    deleteError: null,
    onArchiveSession: vi.fn(),
    archivePending: false,
    archiveError: null,
    onReloadSessions: vi.fn(),
    onDirtyChange: vi.fn(),
    runtimeHint: null,
    ...rest,
    stream: streamState(stream),
  };
}

function renderPanel(overrides: PanelOverrides = {}) {
  const props = panelProps(overrides);
  return { props, ...render(<AssistantPanel {...props} />) };
}

function textarea(): HTMLTextAreaElement {
  return screen.getByLabelText("消息输入") as HTMLTextAreaElement;
}

describe("AssistantPanel 统一 Agent（无 preset 网格 / 无提交-取消）", () => {
  it.each([{ connected: false }, { sessionId: "another-session" }])("连接尚未归属当前会话时 Enter 不发送，输入保留：%j", async (stream) => {
    const { props } = renderPanel({ stream });
    await userEvent.type(textarea(), "暂存输入");
    fireEvent.keyDown(textarea(), { key: "Enter", code: "Enter" });
    expect(props.stream.send).not.toHaveBeenCalled();
    expect(textarea().value).toBe("暂存输入");
  });
  it("只有一个统一 Agent：没有 preset 选项，也没有“提交/取消”按钮", () => {
    const { container } = renderPanel();

    expect(container.querySelectorAll('[data-testid="preset-option"]')).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "提交" })).toBeNull();
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
    expect(screen.getByRole("button", { name: "发送消息" })).toBeDefined();
    expect(screen.getByText("Enter 发送 · Shift + Enter 换行")).toBeDefined();
  });

  it("没有选中会话时发送会新建 novel-assistant，而不是提交到某个会话", async () => {
    const user = userEvent.setup();
    const onCreateSession = vi.fn(async () => "s-new");
    const send = vi.fn(async () => true);
    renderPanel({
      sessions: [],
      selectedSessionId: null,
      onCreateSession,
      stream: streamState({ sessionId: null, connected: false, send }),
    });

    await user.type(textarea(), "给我一个开头");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(onCreateSession).toHaveBeenCalledWith("novel-assistant"));
    expect(send).not.toHaveBeenCalled();
    // 首条消息在会话真正激活前保留在输入框。
    expect(textarea().value).toBe("给我一个开头");
  });

  it("历史 preset 会话只给提示，仍走同一个统一 Agent 输入框", () => {
    renderPanel({ sessions: [session({ preset: "novel-chapter" })] });
    expect(screen.getByText(/仅有章节工具权限/)).toBeDefined();
    expect(screen.queryAllByTestId("preset-option")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "发送消息" })).toBeDefined();
  });
});

describe("AssistantPanel 键盘：Enter 发送、Shift+Enter 换行、IME 不误发", () => {
  it("Enter 发送并清空输入", async () => {
    const user = userEvent.setup();
    const send = vi.fn(async () => true);
    renderPanel({ stream: streamState({ send }) });

    await user.type(textarea(), "帮我写第一段");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(send).toHaveBeenCalledWith("帮我写第一段"));
    await waitFor(() => expect(textarea().value).toBe(""));
  });

  it("Shift+Enter 换行不发送", async () => {
    const user = userEvent.setup();
    const send = vi.fn(async () => true);
    renderPanel({ stream: streamState({ send }) });

    await user.type(textarea(), "第一行{Shift>}{Enter}{/Shift}第二行");

    expect(send).not.toHaveBeenCalled();
    expect(textarea().value).toBe("第一行\n第二行");
  });

  it("IME 组合中的 Enter 不发送；同一输入框随后正常 Enter 才发送", async () => {
    const send = vi.fn(async () => true);
    renderPanel({ stream: streamState({ send }) });

    fireEvent.change(textarea(), { target: { value: "正在输入的候选" } });
    fireEvent.keyDown(textarea(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(textarea(), { key: "Enter", keyCode: 229 });
    expect(send).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea(), { key: "Enter" });
    await waitFor(() => expect(send).toHaveBeenCalledWith("正在输入的候选"));
  });

  it("Shift+Enter 且 IME 组合中同样不发送", async () => {
    const send = vi.fn(async () => true);
    renderPanel({ stream: streamState({ send }) });
    fireEvent.change(textarea(), { target: { value: "组合文本" } });
    fireEvent.keyDown(textarea(), { key: "Enter", shiftKey: true, isComposing: true });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("AssistantPanel 停止生成只在 active/pending", () => {
  it("回合进行中显示停止生成，点击调用 cancel", async () => {
    const user = userEvent.setup();
    const cancel = vi.fn(async () => undefined);
    renderPanel({ stream: streamState({ turnActive: true, lastCommandId: "c-1", cancel }) });

    expect(screen.queryByRole("button", { name: "发送消息" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "停止生成" }));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("本页提交正在等待（sending）也显示停止生成", () => {
    renderPanel({ stream: streamState({ sending: true, lastCommandId: "c-1" }) });
    expect(screen.getByRole("button", { name: "停止生成" })).toBeDefined();
  });

  it("已入队待回显的 pending 消息也显示停止生成", () => {
    renderPanel({
      stream: streamState({
        lastCommandId: "c-1",
        messages: [{ key: "p1", role: "user", text: "排队中", pending: true, commandId: "c-1", createdAt: 0 }],
      }),
    });
    expect(screen.getByRole("button", { name: "停止生成" })).toBeDefined();
  });

  it("没有本机命令时停止按钮禁用并说明原因，不静默失败", async () => {
    const user = userEvent.setup();
    const cancel = vi.fn(async () => undefined);
    renderPanel({ stream: streamState({ turnActive: true, lastCommandId: null, cancel }) });

    const stop = screen.getByRole("button", { name: "停止生成" });
    expect(stop).toBeDisabled();
    expect(stop.getAttribute("title")).toContain("无法获取停止目标");
    await user.click(stop);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("回合已完成后回到发送按钮，不再提供停止生成", () => {
    renderPanel({
      stream: streamState({ turnOutcome: "completed", settledSeq: 9, turnActive: false, turnPublicText: true }),
    });
    expect(screen.queryByRole("button", { name: "停止生成" })).toBeNull();
    expect(screen.getByRole("button", { name: "发送消息" })).toBeDefined();
  });
});

describe("AssistantPanel 归档会话只读", () => {
  const archived = session({ archivedAt: ISO });

  it("已归档会话不可发送：输入框与发送按钮禁用、给出说明，并可从操作菜单恢复", async () => {
    const user = userEvent.setup();
    const onArchiveSession = vi.fn();
    const send = vi.fn(async () => true);
    renderPanel({ sessions: [archived], onArchiveSession, stream: streamState({ send }) });

    expect(screen.getByText(/这段对话已归档/)).toBeDefined();
    expect(textarea()).toBeDisabled();
    expect(textarea().getAttribute("placeholder")).toBe("恢复对话后继续聊");
    expect(screen.getByRole("button", { name: "发送消息" })).toBeDisabled();

    await user.click(screen.getByLabelText("当前对话操作"));
    await user.click(screen.getByRole("button", { name: "恢复对话" }));
    expect(onArchiveSession).toHaveBeenCalledWith("s1", false);
    expect(send).not.toHaveBeenCalled();
  });

  it("未归档会话可从操作菜单归档，恢复前后语义互斥", async () => {
    const user = userEvent.setup();
    const onArchiveSession = vi.fn();
    renderPanel({ onArchiveSession });

    await user.click(screen.getByLabelText("当前对话操作"));
    await user.click(screen.getByRole("button", { name: "归档对话" }));
    expect(onArchiveSession).toHaveBeenCalledWith("s1", true);
  });

  it("已撤销（revoked）会话同样终止：不可发送也不可再永久结束", () => {
    renderPanel({ sessions: [session({ status: "revoked" })] });
    expect(textarea()).toBeDisabled();
    expect(screen.getByRole("button", { name: "发送消息" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "永久结束对话" })).toBeDisabled();
  });
});

describe("AssistantPanel 历史默认关闭与归档分组", () => {
  const active = session({ id: "s-active" });
  const archived = session({ id: "s-archived", archivedAt: ISO });

  it("历史默认关闭；打开后默认“最近”，可切到“已归档”", async () => {
    const user = userEvent.setup();
    renderPanel({ sessions: [active, archived], selectedSessionId: null });

    expect(screen.queryByText("对话记录")).toBeNull();

    await user.click(screen.getByRole("button", { name: "历史对话" }));
    expect(screen.getByText("对话记录")).toBeDefined();
    expect(screen.getByRole("button", { name: "最近" })).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByRole("list")).getByText(/创作 Agent · 1/)).toBeDefined();
    expect(screen.queryByText(/创作 Agent · 2/)).toBeNull();

    await user.click(screen.getByRole("button", { name: "已归档" }));
    expect(screen.getByRole("button", { name: "已归档" })).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByRole("list")).getByText(/创作 Agent · 1/)).toBeDefined();
    expect(screen.getByRole("button", { name: "恢复对话" })).toBeDefined();

    await user.click(screen.getByRole("button", { name: "恢复对话" }));
  });

  it("归档分组空态各自独立", async () => {
    const user = userEvent.setup();
    renderPanel({ sessions: [active], selectedSessionId: null });
    await user.click(screen.getByRole("button", { name: "历史对话" }));

    await user.click(screen.getByRole("button", { name: "已归档" }));
    expect(screen.getByText("没有已归档对话。")).toBeDefined();

    await user.click(screen.getByRole("button", { name: "最近" }));
    expect(screen.queryByText("还没有对话，从下面的一句话开始。")).toBeNull();
  });

  it("点历史条目切换会话并关闭历史；有未发送草稿时先确认，拒绝则保留草稿", async () => {
    const user = userEvent.setup();
    const onSelectSession = vi.fn();
    renderPanel({ sessions: [active], selectedSessionId: null, onSelectSession });

    await user.type(textarea(), "还没发出去");
    await user.click(screen.getByRole("button", { name: "历史对话" }));

    const confirmSpy = vi.fn().mockReturnValue(false);
    vi.stubGlobal("confirm", confirmSpy);
    await user.click(screen.getByRole("button", { name: /创作 Agent · 1/ }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(onSelectSession).not.toHaveBeenCalled();
    expect(textarea().value).toBe("还没发出去");
    expect(screen.getByText("对话记录")).toBeDefined();

    confirmSpy.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: /创作 Agent · 1/ }));
    expect(onSelectSession).toHaveBeenCalledWith("s-active");
    expect(screen.queryByText("对话记录")).toBeNull();
    expect(textarea().value).toBe("");
  });

  it("未选中会话时，历史条目的归档/恢复按钮直接归档对应会话", async () => {
    const user = userEvent.setup();
    const onArchiveSession = vi.fn();
    const { rerender } = renderPanel({ sessions: [active], selectedSessionId: null, onArchiveSession });
    await user.click(screen.getByRole("button", { name: "历史对话" }));

    await user.click(screen.getByLabelText("归档对话"));
    expect(onArchiveSession).toHaveBeenCalledWith("s-active", true);

    rerender(<AssistantPanel {...panelProps({ sessions: [archived], selectedSessionId: null, onArchiveSession })} />);
    await user.click(screen.getByRole("button", { name: "已归档" }));
    await user.click(screen.getByLabelText("恢复对话"));
    expect(onArchiveSession).toHaveBeenLastCalledWith("s-archived", false);
  });
});

describe("AssistantPanel 首条消息等待会话流就绪，不串会话", () => {
  it("onCreateSession('novel-assistant') 之后必须等 stream.sessionId 匹配且 connected 才发送", async () => {
    const user = userEvent.setup();
    const send = vi.fn(async () => true);
    const onCreateSession = vi.fn(async () => "s-new");
    const base = panelProps({
      sessions: [],
      selectedSessionId: null,
      onCreateSession,
      stream: streamState({ sessionId: null, connected: false, send }),
    });
    const view = render(<AssistantPanel {...base} />);

    await user.type(textarea(), "第一条消息");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledWith("novel-assistant"));
    expect(send).not.toHaveBeenCalled();

    // 会话已选中，但流的 sessionId 仍是旧的：绝不把首条消息发到旧流。
    view.rerender(
      <AssistantPanel
        {...base}
        selectedSessionId="s-new"
        stream={streamState({ sessionId: "s-old", connected: true, send })}
      />,
    );
    expect(send).not.toHaveBeenCalled();

    // sessionId 已匹配但尚未 connected：仍不发送。
    view.rerender(
      <AssistantPanel
        {...base}
        selectedSessionId="s-new"
        stream={streamState({ sessionId: "s-new", connected: false, send })}
      />,
    );
    expect(send).not.toHaveBeenCalled();

    // 匹配 + 已连接：恰好发送一次，并清空输入。
    view.rerender(
      <AssistantPanel
        {...base}
        selectedSessionId="s-new"
        stream={streamState({ sessionId: "s-new", connected: true, send })}
      />,
    );
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledWith("第一条消息");
    await waitFor(() => expect(textarea().value).toBe(""));
  });

  it("会话选择被切到别的 session 时，首条消息既不发送也不丢草稿", async () => {
    const user = userEvent.setup();
    const send = vi.fn(async () => true);
    const onCreateSession = vi.fn(async () => "s-new");
    const base = panelProps({
      sessions: [],
      selectedSessionId: null,
      onCreateSession,
      stream: streamState({ sessionId: null, connected: false, send }),
    });
    const view = render(<AssistantPanel {...base} />);

    await user.type(textarea(), "不要串会话");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));

    // 用户随后切到了另一条会话（stream 也连着它）。
    view.rerender(
      <AssistantPanel
        {...base}
        sessions={[session({ id: "s-other" })]}
        selectedSessionId="s-other"
        stream={streamState({ sessionId: "s-other", connected: true, send })}
      />,
    );

    expect(send).not.toHaveBeenCalled();
    expect(textarea().value).toBe("不要串会话");
  });

  it("重复点击只创建一次会话、只发送一次", async () => {
    const user = userEvent.setup();
    let resolveCreate!: (value: string | null) => void;
    const onCreateSession = vi.fn(
      () => new Promise<string | null>((resolve) => { resolveCreate = resolve; }),
    );
    renderPanel({
      sessions: [],
      selectedSessionId: null,
      onCreateSession,
      stream: streamState({ sessionId: null, connected: false }),
    });

    await user.type(textarea(), "只发一次");
    const sendButton = screen.getByRole("button", { name: "发送消息" });
    await user.click(sendButton);
    await user.click(sendButton);
    await user.keyboard("{Enter}");

    expect(onCreateSession).toHaveBeenCalledTimes(1);

    resolveCreate("s-new");
    await waitFor(() => expect(textarea().value).toBe("只发一次"));
  });
});

describe("AssistantPanel 草稿保留与在途修改", () => {
  it("send 返回 false 时保留草稿，用户不用重打", async () => {
    const user = userEvent.setup();
    const send = vi.fn(async () => false);
    renderPanel({ stream: streamState({ send }) });

    await user.type(textarea(), "没发出去的原稿");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(textarea().value).toBe("没发出去的原稿");
  });

  it("send 抛错时保留草稿并给出可读提示", async () => {
    const user = userEvent.setup();
    const send = vi.fn(async () => { throw new Error("网络中断"); });
    renderPanel({ stream: streamState({ send }) });

    await user.type(textarea(), "会失败的原稿");
    await user.keyboard("{Enter}");

    expect(await screen.findByText(/消息未发送成功，输入已保留/)).toBeDefined();
    expect(textarea().value).toBe("会失败的原稿");
  });

  it("发送在途时用户继续改字：成功后也不覆盖用户的新输入", async () => {
    const user = userEvent.setup();
    let resolveSend!: (value: boolean) => void;
    const send = vi.fn(() => new Promise<boolean>((resolve) => { resolveSend = resolve; }));
    renderPanel({ stream: streamState({ send }) });

    await user.type(textarea(), "初稿");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(send).toHaveBeenCalledWith("初稿"));

    await user.type(textarea(), "补充");
    resolveSend(true);

    await waitFor(() => expect(textarea().value).toBe("初稿补充"));
  });

  it("重复 Enter 不会双发（本页提交锁）", async () => {
    const user = userEvent.setup();
    let resolveSend!: (value: boolean) => void;
    const send = vi.fn(() => new Promise<boolean>((resolve) => { resolveSend = resolve; }));
    renderPanel({ stream: streamState({ send }) });

    await user.type(textarea(), "只发一次{Enter}{Enter}");

    expect(send).toHaveBeenCalledTimes(1);
    resolveSend(true);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });

  it("草稿出现/清空时通过 onDirtyChange 上报顶层", async () => {
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();
    renderPanel({ onDirtyChange });

    await user.type(textarea(), "草稿");
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));

    await user.clear(textarea());
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });
});

describe("AssistantPanel 安全渲染与持久状态（保留旧安全测试）", () => {
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

  it("服务端报告的状态原样展示（唤醒中 / 中断 / 未知状态）", () => {
    const waking = renderPanel({ stream: { serverStatus: "waking" } });
    expect(screen.getByText("正在唤醒运行单元")).toBeDefined();
    waking.unmount();

    renderPanel({ stream: { serverStatus: "something-new", serverStatusSeq: 3 } });
    expect(screen.getByText("something-new")).toBeDefined();
  });

  it("运行标签落到持久终态，不停在瞬态 stream-start", () => {
    const { container } = renderPanel({
      stream: { turnOutcome: "completed", settledSeq: 10, turnActive: false, turnPublicText: true },
    });
    expect(container.querySelector(".toolbar")?.textContent).toContain("本轮已完成");
  });

  it("失败/中断/会话结束的回合给出显式终态横幅而不是静默", () => {
    const failed = renderPanel({ stream: { turnOutcome: "failed", turnOutcomeReason: "本轮执行失败" } });
    expect(screen.getByText(/本回合执行失败：本轮执行失败/)).toBeDefined();
    failed.unmount();

    const interrupted = renderPanel({ stream: { turnOutcome: "interrupted" } });
    expect(screen.getByText(/本回合被中断/)).toBeDefined();
    interrupted.unmount();

    renderPanel({ stream: { turnOutcome: "session-ended", turnOutcomeReason: "会话状态变为 revoked" } });
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
    expect(screen.getByText("读大纲并保存")).toBeDefined();
    expect(container.querySelectorAll(".msg.tool")).toHaveLength(1);
  });

  it("缺口提示与 runtimeHint 都以可读横幅呈现", () => {
    const replay = renderPanel({ stream: { needsReplay: true } });
    expect(screen.getByText(/对话记录可能有缺失/)).toBeDefined();
    replay.unmount();

    renderPanel({ runtimeHint: "服务端尚未配置可用模型。" });
    expect(screen.getByText("服务端尚未配置可用模型。")).toBeDefined();
  });

  it("流错误可关闭：clearError 只由用户显式触发", async () => {
    const user = userEvent.setup();
    const clearError = vi.fn();
    renderPanel({ stream: { error: "事件流读取失败", clearError } });

    await user.click(screen.getByRole("button", { name: "关闭" }));
    expect(clearError).toHaveBeenCalledTimes(1);
  });
});
