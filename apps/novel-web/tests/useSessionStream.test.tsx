import type { QueuedCommand, SessionStreamEvent } from "@myrix/contracts";
import { act, render, renderHook, screen } from "@testing-library/react";
import { type ReactElement, Suspense, useState, useTransition } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn<(sessionId: string, input: { commandId: string; text: string }) => Promise<QueuedCommand>>(),
  cancel: vi.fn<(sessionId: string, commandId: string) => Promise<QueuedCommand>>(),
  openEventSource: vi.fn<(path: string) => EventSource>(),
}));

// 只替换网络/EventSource 边界，其它导出保持真实（requestJson / 错误分类 / transport 都用真实现）。
vi.mock("../src/api/endpoints", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/endpoints")>();
  return {
    ...actual,
    sessions: { ...actual.sessions, send: mocks.send, cancel: mocks.cancel },
  };
});

vi.mock("../src/api/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/http")>();
  return { ...actual, openEventSource: mocks.openEventSource };
});

import { useSessionStream } from "../src/state/useSessionStream";

/**
 * 受控的 EventSource 替身：测试自己决定何时 open / message / error。
 * `new EventSource(...)` 在 hook 里是全局引用，因此这里同时 stub 全局常量
 * （`EventSource.CLOSED` 等），但连接创建走被 mock 的 `openEventSource`。
 */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readyState = FakeEventSource.CONNECTING;
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  emitOpen(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.({});
  }

  emitMessage(event: SessionStreamEvent): void {
    for (const handler of this.listeners.get("message") ?? []) {
      handler({ data: JSON.stringify(event) });
    }
  }
}

function latestSource(): FakeEventSource {
  const source = FakeEventSource.instances.at(-1);
  if (!source) throw new Error("没有创建任何 EventSource");
  return source;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function firstSendInput(): { commandId: string; text: string } {
  const call = mocks.send.mock.calls[0];
  if (!call) throw new Error("sessions.send 未被调用");
  return call[1];
}

/**
 * 所有 hook 测试都在**真实 StrictMode**下渲染：
 * React 会双调用 render / effect（mount → cleanup → mount），这正是生产
 * `main.tsx` 的挂载方式；不传 `reactStrictMode` 的旧写法等于在非 Strict 模式下
 * 自证，覆盖不到 effect 重放与"被放弃渲染"的真实现象。
 */
function renderStream(initialSession: string | null) {
  return renderHook(({ sessionId }: { sessionId: string | null }) => useSessionStream(sessionId), {
    initialProps: { sessionId: initialSession },
    reactStrictMode: true,
  });
}

/**
 * 受控的 Suspense 边界：`s-B` 在"挂起开关"打开时抛出 **同一个** never-resolving
 * promise（重试时不能每次新建，否则永远无法完成任务），**不依赖 sleep/计时器**，
 * 由测试显式决定何时放行。
 */
let suspendSession = false;
let suspensePromise: Promise<void> | null = null;
let suspenseSettled = false;
let releaseSuspense: (() => void) | null = null;

function SuspendingChild({ sessionId }: { sessionId: string | null }): ReactElement {
  // 放行后必须停止挂起：React 会在 promise resolve 后重试渲染，
  // 若仍然抛出同一个已 resolve 的 promise 会变成同步死循环。
  if (suspendSession && sessionId === "s-B" && !suspenseSettled) {
    if (!suspensePromise) {
      suspensePromise = new Promise<void>((resolve) => {
        releaseSuspense = () => {
          suspenseSettled = true;
          resolve();
        };
      });
    }
    throw suspensePromise;
  }
  return <span data-testid="child">{sessionId}</span>;
}

/**
 * 真实并发场景：把 hook 挂在带 Suspense 的树里，会话切换走 `startTransition`。
 *
 * 通过 Suspense 让"切到 B"的这次 render **挂起并被放弃**，React 不 commit 它，
 * 保留 A 的已提交 UI；此时 hook 在 render 期自增的 `generationRef` 已经变了。
 * 这正是"被放弃的并发 render 污染 ref"的最小受控复现。
 */
function ConcurrentHarness({ initialSession }: { initialSession: string | null }): ReactElement {
  const [sessionId, setSessionId] = useState(initialSession);
  const [isPending, startTransition] = useTransition();
  (globalThis as { __myrixSetSession?: (next: string | null) => void }).__myrixSetSession = setSessionId;
  (globalThis as { __myrixStartTransition?: (callback: () => void) => void }).__myrixStartTransition =
    startTransition;
  const stream = useSessionStream(sessionId);
  (globalThis as { __myrixSend?: (text: string) => Promise<void> }).__myrixSend = stream.send;
  return (
    <div>
      <span data-testid="pending">{isPending ? "pending" : "idle"}</span>
      <span data-testid="session">{stream.sessionId ?? "none"}</span>
      <span data-testid="sending">{stream.sending ? "sending" : "idle"}</span>
      <span data-testid="messages">{stream.messages.length}</span>
      <span data-testid="last-command">{stream.lastCommandId ?? "none"}</span>
      <span data-testid="error">{stream.error ?? "none"}</span>
      <span data-testid="send-result">{stream.messages[0]?.text ?? "none"}</span>
      <Suspense fallback={<span data-testid="fallback">loading</span>}>
        <SuspendingChild sessionId={sessionId} />
      </Suspense>
    </div>
  );
}

function setHarnessSession(next: string | null, transition: boolean): void {
  const setter = (globalThis as { __myrixSetSession?: (next: string | null) => void }).__myrixSetSession;
  const start = (globalThis as { __myrixStartTransition?: (callback: () => void) => void })
    .__myrixStartTransition;
  if (!setter || !start) throw new Error("并发测试宿主尚未挂载");
  if (transition) start(() => setter(next));
  else setter(next);
}

function harnessSend(text: string): Promise<void> {
  const send = (globalThis as { __myrixSend?: (text: string) => Promise<void> }).__myrixSend;
  if (!send) throw new Error("并发测试宿主尚未挂载");
  return send(text);
}


beforeEach(() => {
  FakeEventSource.instances = [];
  mocks.send.mockReset();
  mocks.cancel.mockReset();
  mocks.openEventSource.mockReset();
  mocks.openEventSource.mockImplementation((path) => new FakeEventSource(path) as unknown as EventSource);
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
  suspendSession = false;
  suspensePromise = null;
  suspenseSettled = false;
  releaseSuspense = null;
});

describe("useSessionStream", () => {
  it("切换会话当帧就返回新会话的空/未连接状态，不把旧会话内容挂在 B 上", () => {
    const { result, rerender } = renderStream("s-A");
    const aSource = latestSource();
    act(() => aSource.emitOpen());
    act(() => aSource.emitMessage({ type: "user", seq: 1, text: "A 的消息", commandId: "c-A" }));
    act(() => aSource.emitMessage({ type: "turn-end", seq: 2 }));

    expect(result.current.sessionId).toBe("s-A");
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.connected).toBe(true);
    expect(result.current.turnOutcome).toBe("completed");
    expect(result.current.settlements).toBe(1);

    // 切到 B：即便旧流的 effect 清理还没跑，返回值也必须已经是 B 自己的空状态。
    rerender({ sessionId: "s-B" });
    expect(result.current.sessionId).toBe("s-B");
    expect(result.current.messages).toHaveLength(0);
    expect(result.current.connected).toBe(false);
    expect(result.current.turnOutcome).toBeNull();
    expect(result.current.turnOutcomeReason).toBeNull();
    expect(result.current.settlements).toBe(0);
    expect(result.current.lastCommandId).toBeNull();
    expect(result.current.sending).toBe(false);
    expect(result.current.error).toBeNull();

    // B 建立了自己的连接，旧 source 已被关闭。
    const bSource = latestSource();
    expect(bSource).not.toBe(aSource);
    expect(bSource.url).toContain("s-B");
    expect(aSource.closed).toBe(true);
  });

  it("旧 source 迟到的持久/瞬态帧不进入新会话", () => {
    const { result, rerender } = renderStream("s-A");
    const aSource = latestSource();
    act(() => aSource.emitOpen());

    rerender({ sessionId: "s-B" });
    const bSource = latestSource();
    expect(bSource).not.toBe(aSource);

    // 旧 A 的迟到帧（持久 + 瞬态 + 连接信号）全部丢弃。
    act(() => aSource.emitMessage({ type: "user", seq: 1, text: "迟到的旧 A 消息" }));
    act(() => aSource.emitMessage({ type: "delta", text: "迟到的旧增量" }));
    act(() => aSource.emitMessage({ type: "status", seq: 3, status: "interrupted" }));
    act(() => {
      aSource.readyState = FakeEventSource.CONNECTING;
      aSource.onerror?.({});
    });

    expect(result.current.messages).toHaveLength(0);
    expect(result.current.connected).toBe(false);
    expect(result.current.serverStatus).toBeNull();
    expect(result.current.settlements).toBe(0);

    // 新 source 的帧正常归属 B。
    act(() => bSource.emitMessage({ type: "user", seq: 1, text: "B 的消息", commandId: "c-B" }));
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]?.text).toBe("B 的消息");
  });

  it("send 的 202 迟到跨会话：不写新会话的 messages/lastCommandId/sending", async () => {
    const { result, rerender } = renderStream("s-A");
    const pending = deferred<QueuedCommand>();
    mocks.send.mockReturnValue(pending.promise);

    let sending!: Promise<void>;
    act(() => {
      sending = result.current.send("准备提交给 A");
    });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0]?.[0]).toBe("s-A");
    const { commandId } = firstSendInput();
    expect(result.current.sending).toBe(true);

    rerender({ sessionId: "s-B" });
    expect(result.current.sending).toBe(false);

    await act(async () => {
      pending.resolve({ commandId, status: "queued" });
      await sending;
    });

    expect(result.current.sessionId).toBe("s-B");
    expect(result.current.messages).toHaveLength(0);
    expect(result.current.lastCommandId).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.sending).toBe(false);
  });

  it("send 失败迟到跨会话：不把旧会话的错误写到新会话", async () => {
    const { result, rerender } = renderStream("s-A");
    const pending = deferred<QueuedCommand>();
    mocks.send.mockReturnValue(pending.promise);

    let sending!: Promise<void>;
    act(() => {
      sending = result.current.send("会失败的提交");
    });

    rerender({ sessionId: "s-B" });
    await act(async () => {
      pending.reject(new Error("会话已不可用"));
      await sending;
    });

    expect(result.current.sessionId).toBe("s-B");
    expect(result.current.error).toBeNull();
    expect(result.current.sending).toBe(false);
    expect(result.current.messages).toHaveLength(0);
  });

  it("A→B→A：回到 A 也不能接收上一条 A 流的 202（按代际而非 sid 相等判定）", async () => {
    const { result, rerender } = renderStream("s-A");
    const pending = deferred<QueuedCommand>();
    mocks.send.mockReturnValue(pending.promise);

    let sending!: Promise<void>;
    act(() => {
      sending = result.current.send("第一次选择 A 时提交");
    });
    const { commandId } = firstSendInput();

    rerender({ sessionId: "s-B" });
    rerender({ sessionId: "s-A" });
    expect(result.current.sessionId).toBe("s-A");

    await act(async () => {
      pending.resolve({ commandId, status: "queued" });
      await sending;
    });

    // sessionId 又等于 A，但这仍旧是上一条流的请求：本地结果丢弃。
    expect(result.current.sessionId).toBe("s-A");
    expect(result.current.messages).toHaveLength(0);
    expect(result.current.lastCommandId).toBeNull();
    expect(result.current.sending).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("旧会话 cancel 迟到失败不污染新会话；同会话失败仍然可见", async () => {
    const { result, rerender } = renderStream("s-A");
    mocks.send.mockResolvedValue({ commandId: "c-A", status: "queued" });
    await act(async () => {
      await result.current.send("给 A 的命令");
    });
    expect(result.current.lastCommandId).toBe("c-A");

    const failing = deferred<QueuedCommand>();
    mocks.cancel.mockReturnValue(failing.promise);
    let canceling!: Promise<void>;
    act(() => {
      canceling = result.current.cancel();
    });
    expect(mocks.cancel).toHaveBeenCalledWith("s-A", "c-A");

    rerender({ sessionId: "s-B" });
    await act(async () => {
      failing.reject(new Error("取消失败"));
      await canceling;
    });
    expect(result.current.error).toBeNull();

    // 同会话的 cancel 失败仍然要显示（既有契约不变）。
    mocks.cancel.mockRejectedValue(new Error("取消失败"));
    mocks.send.mockResolvedValue({ commandId: "c-B", status: "queued" });
    await act(async () => {
      await result.current.send("给 B 的命令");
    });
    expect(result.current.lastCommandId).toBe("c-B");
    await act(async () => {
      await result.current.cancel();
    });
    expect(result.current.error).toBe("取消失败");
  });

  it("卸载后迟到的 send 结果不再写状态，旧连接被关闭", async () => {
    const { result, unmount } = renderStream("s-A");
    const source = latestSource();
    const pending = deferred<QueuedCommand>();
    mocks.send.mockReturnValue(pending.promise);

    let sending!: Promise<void>;
    act(() => {
      sending = result.current.send("卸载前提交");
    });
    const { commandId } = firstSendInput();

    unmount();
    expect(source.closed).toBe(true);

    // resolve 之后不得抛错，也不得触发任何卸载后状态写入（React 会在此报警）。
    await act(async () => {
      pending.resolve({ commandId, status: "queued" });
      await sending;
    });
  });

  it("正常同会话 202：插入一条待回显占位并记录 lastCommandId", async () => {
    const { result } = renderStream("s-A");
    mocks.send.mockImplementation(async (_sessionId, input) => ({ commandId: input.commandId, status: "queued" }));

    await act(async () => {
      await result.current.send("  写一段开头  ");
    });

    expect(mocks.send.mock.calls[0]?.[1].text).toBe("写一段开头");
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({ role: "user", text: "写一段开头", pending: true });
    expect(result.current.messages[0]?.commandId).toBe(result.current.lastCommandId);
    expect(result.current.sending).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("快 SSE 先于 202：持久 user 已按 commandId 落定，202 不再追加第二条", async () => {
    const { result } = renderStream("s-A");
    const source = latestSource();
    const pending = deferred<QueuedCommand>();
    mocks.send.mockReturnValue(pending.promise);

    let sending!: Promise<void>;
    act(() => {
      sending = result.current.send("极快回复");
    });
    const { commandId } = firstSendInput();

    // 持久 user 事件先于 POST 的 202 到达。
    act(() => source.emitMessage({ type: "user", seq: 7, text: "极快回复", commandId }));
    expect(result.current.messages).toHaveLength(1);

    await act(async () => {
      pending.resolve({ commandId, status: "queued" });
      await sending;
    });

    const users = result.current.messages.filter((message) => message.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0]?.pending).toBeUndefined();
    expect(users[0]?.seq).toBe(7);
    expect(result.current.lastCommandId).toBe(commandId);
  });

  it("同会话 send 失败仍然显示错误并复位 sending（保留既有行为）", async () => {
    const { result } = renderStream("s-A");
    mocks.send.mockRejectedValue(new Error("无法连接 Myrix BFF"));

    await act(async () => {
      await result.current.send("会失败");
    });

    expect(result.current.error).toBe("无法连接 Myrix BFF");
    expect(result.current.sending).toBe(false);
    expect(result.current.messages).toHaveLength(0);
  });

  it("没有会话或空文本时不发请求；无命令时 cancel 给出明确错误", async () => {
    const { result, rerender } = renderStream(null);
    await act(async () => {
      await result.current.send("没有会话");
    });
    expect(mocks.send).not.toHaveBeenCalled();

    rerender({ sessionId: "s-A" });
    await act(async () => {
      await result.current.send("   ");
    });
    expect(mocks.send).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.cancel();
    });
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(result.current.error).toBe("当前没有可取消的命令");
  });

  it("并发渲染被放弃时不污染代际：A 的 202/finally 仍然落定，sending 不卡死", async () => {
    const pending = deferred<QueuedCommand>();
    mocks.send.mockReturnValue(pending.promise);

    suspendSession = true;
    suspensePromise = null;
    suspenseSettled = false;
    releaseSuspense = null;
    render(<ConcurrentHarness initialSession="s-A" />);
    expect(screen.getByTestId("session").textContent).toBe("s-A");
    const aSource = latestSource();
    expect(aSource.url).toContain("s-A");

    // A 上的 send 正在等待 202。
    let sending!: Promise<void>;
    act(() => {
      sending = harnessSend("提交给 A");
    });
    expect(screen.getByTestId("sending").textContent).toBe("sending");
    const { commandId } = firstSendInput();
    expect(mocks.send.mock.calls[0]?.[0]).toBe("s-A");

    // 并发尝试切到 B：这次 render 抛挂起，React 放弃它并保留 A 的已提交 UI。
    // 旧实现在 render 期自增 generationRef，导致后续 A 的真实 202 被误判为旧代际。
    await act(async () => {
      setHarnessSession("s-B", true);
      await Promise.resolve();
    });
    expect(screen.getByTestId("session").textContent).toBe("s-A");
    expect(screen.getByTestId("pending").textContent).toBe("pending");
    expect(screen.getByTestId("child").textContent).toBe("s-A");

    // A 的 202 此刻到达：它属于**当前已提交**的 A 会话，必须落定。
    await act(async () => {
      pending.resolve({ commandId, status: "queued" });
      await sending;
    });

    expect(screen.getByTestId("session").textContent).toBe("s-A");
    expect(screen.getByTestId("sending").textContent).toBe("idle");
    expect(screen.getByTestId("last-command").textContent).toBe(commandId);
    expect(screen.getByTestId("messages").textContent).toBe("1");
    expect(screen.getByTestId("send-result").textContent).toBe("提交给 A");
    expect(screen.getByTestId("error").textContent).toBe("none");

    // 放行挂起的切换：B 这次才真正 commit，代际在 commit 阶段推进。
    await act(async () => {
      releaseSuspense?.();
      await Promise.resolve();
    });
    expect(screen.getByTestId("session").textContent).toBe("s-B");
    expect(screen.getByTestId("messages").textContent).toBe("0");
    expect(screen.getByTestId("last-command").textContent).toBe("none");
    expect(screen.getByTestId("sending").textContent).toBe("idle");

    // B 已 commit 之后，旧 A source 的迟到帧必须被连接归属拒绝（不能写进 B）。
    act(() => aSource.emitMessage({ type: "user", seq: 1, text: "迟到的旧 A 消息" }));
    act(() => {
      aSource.readyState = FakeEventSource.CONNECTING;
      aSource.onerror?.({});
    });
    expect(screen.getByTestId("messages").textContent).toBe("0");
    suspendSession = false;
  });

  it("卸载后延迟调用已捕获的 send/cancel 不再发送网络请求", async () => {
    mocks.send.mockResolvedValue({ commandId: "c-before-unmount", status: "queued" });
    mocks.cancel.mockResolvedValue({ commandId: "c-before-unmount", status: "queued" });
    const { result, unmount } = renderStream("s-A");
    await act(async () => { await result.current.send("卸载前的正常提交"); });
    const lateSend = result.current.send;
    const lateCancel = result.current.cancel;
    mocks.send.mockClear();
    unmount();
    await act(async () => {
      await lateSend("卸载后的迟到调用");
      await lateCancel();
    });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("A→B→A 之后调用 A 的旧 send/cancel 回调：整体拒绝，不发往旧 sid 也不写新状态", async () => {
    const { result, rerender } = renderStream("s-A");
    // 记下 A 这一代的回调（后续 rerender 会生成新回调，但这里持有旧引用）。
    const staleSendA = result.current.send;
    const staleCancelA = result.current.cancel;

    rerender({ sessionId: "s-B" });
    rerender({ sessionId: "s-A" });

    // 语义上"同一会话"（sid 又是 s-A），但这是被替换掉的旧回调：
    // 若它被延迟调用后才读 ref，就会误发往已被替换的旧 A 流。
    mocks.send.mockResolvedValue({ commandId: "c-late", status: "queued" });
    await act(async () => {
      await staleSendA("迟到的旧 A 提交");
    });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(result.current.messages).toHaveLength(0);
    expect(result.current.lastCommandId).toBeNull();
    expect(result.current.sending).toBe(false);
    expect(result.current.error).toBeNull();

    // 旧的 cancel 回调同样整体拒绝：不能拿新代际去取消旧会话的 commandId。
    await act(async () => {
      await staleCancelA();
    });
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();

    // 当前回调仍按正常同会话行为工作（public 接口不变）。
    await act(async () => {
      await result.current.send("当前 A 的提交");
    });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0]?.[0]).toBe("s-A");
    expect(result.current.lastCommandId).toBe("c-late");
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.sending).toBe(false);
  });
});
