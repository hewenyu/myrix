import type { SessionStreamEvent } from "@myrix/contracts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { sessions } from "../api/endpoints";
import { describeError } from "../api/errors";
import { openEventSource } from "../api/http";
import { newCommandId } from "../api/ids";
import { reportStreamConnected } from "../api/transport";
import {
  type ChatMessage,
  type ChatState,
  type TurnOutcome,
  appendPendingCommand,
  applyStreamEvent,
  emptyChatState,
  markConnected,
  markDisconnected,
} from "./chatReducer";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

/**
 * 每次 `sessionId` 变化就是一个新的**会话代际**。
 *
 * "代际"是 (sessionId, 归属序号) 的合体：A→B→A 时 sessionId 又会相等，只有序号
 * 能区分"这是另一条流"。序号本身属于**已提交的 render 快照**（state），不是
 * render 期的可变引用：并发渲染中被放弃的那一次 render 不 commit，它推进的序号
 * 也随之作废，不会污染实际提交的旧会话。
 */
interface Ownership {
  sessionId: string | null;
  /** 单调递增的归属序号；每次已提交的会话切换 +1。 */
  generation: number;
}

export interface SessionStreamState {
  sessionId: string | null;
  messages: ChatMessage[];
  connected: boolean;
  turnActive: boolean;
  /** 本回合服务端终态；`null` = 未观察到终态（进行中或只有瞬态帧）。 */
  turnOutcome: TurnOutcome | null;
  /** 终态的可读原因（失败文案 / 会话结束原因）。 */
  turnOutcomeReason: string | null;
  /** 本回合是否已有公开可显示的持久助手正文。 */
  turnPublicText: boolean;
  /** 最近一条**持久**服务端状态（interrupted / session-ended / revoked …）。 */
  serverStatus: string | null;
  /** 上述状态对应持久事件的 seq；`null` = 未由持久事件给出过状态。 */
  serverStatusSeq: number | null;
  /**
   * 已观察到的持久回合终态次数（单调递增）。
   *
   * 业务缓存只在它变化时刷新一次：刷新是"每回合一次"的，而不是"回放每个 event 一次"。
   */
  settlements: number;
  /** 最近一次持久终态事件的 seq（用于把终态与更晚的会话级状态排序）。 */
  settledSeq: number | null;
  notice: ChatState["notice"];
  /** 持久事件出现 seq 缺口：内容可能有遗漏，UI 必须显式提示而不是假装完整。 */
  needsReplay: boolean;
  /** 最近一次本机提交的命令，用于取消。 */
  lastCommandId: string | null;
  send: (text: string) => Promise<void>;
  cancel: () => Promise<void>;
  sending: boolean;
  error: string | null;
  clearError: () => void;
  /** 丢弃当前事件缓冲并重建连接（用于缺口后让服务端按 Last-Event-ID 补发）。 */
  reconnect: () => void;
}

function parseEvent(data: string): SessionStreamEvent | null {
  try {
    const parsed = JSON.parse(data) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const event = parsed as SessionStreamEvent;
    if (typeof event.type !== "string") return null;
    return event;
  } catch {
    return null;
  }
}

/**
 * 单个会话的事件流。
 *
 * - 切换 session 时立即关闭旧连接（useEffect 清理），不跨会话复用；
 * - 会话切换在**渲染期**就重置归属状态，切换后的第一帧不会带着旧会话的
 *   messages / connected / 终态 / sending；
 * - 旧会话上发起的 send/cancel 在 await 之后按**会话代际**判定归属（A→B→A
 *   时 sessionId 重新相等，只有代际能识别"这是另一条流"），旧结果一律丢弃；
 * - 持久事件按 seq 去重（applyStreamEvent），原生 EventSource 自动携带 Last-Event-ID；
 * - `delta` 只做瞬时显示，`final/assistant` 文本以持久事件为准；
 * - 断线自动重连（指数退避），重连期间的 UI 明确显示“断开”。
 */
export function useSessionStream(sessionId: string | null): SessionStreamState {
  const [chat, setChat] = useState<ChatState>(emptyChatState);
  const [connected, setConnected] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastCommandId, setLastCommandId] = useState<string | null>(null);

  const attemptRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const reconnectRef = useRef<() => void>(() => undefined);
  const mountedRef = useRef(true);

  /**
   * `generationRef` 保存"当前已提交归属"的代际序号，**只在 commit 阶段**
   * （render 之后的 useLayoutEffect）推进，异步回调据此判断自己是否仍属于当前流。
   *
   * 代际在 `sessionId` 每次变化时 +1；**不能**只用 `sessionId` 相等来判断归属：
   * A→B→A 时旧 A 请求的 `sessionId` 又等于当前值，但它是上一条流的请求。
   *
   * 绝不能在 render 期间自增：并发渲染可能先渲染 B（代际 +1）、随后放弃该次
   * render 回到 A，实际提交的仍旧是 A，但 ref 已被污染——A 真实的 202/finally
   * 会被误判为旧代际而丢弃，`sending` 永远卡在 true。
   */
  const generationRef = useRef(0);
  /** 已提交归属的快照：序列号随被放弃的 render 一起作废，不体现为任何副作用。 */
  const [ownership, setOwnership] = useState<Ownership>({ sessionId, generation: 0 });

  // 会话切换时的**归属状态**修正。必须在**本次渲染**完成，而不是等 useEffect：
  // useEffect 晚一轮，切换后的第一帧会把旧会话的消息/连接/终态挂在新的 sessionId 上。
  // setState-during-render 只在归属确实变化时触发一次，随后的重渲染条件不再成立。
  // 这里只重置 state；代际引用留到 commit（useLayoutEffect），避免放弃的 render 污染它。
  if (ownership.sessionId !== sessionId) {
    setOwnership({ sessionId, generation: ownership.generation + 1 });
    setChat(emptyChatState);
    setConnected(false);
    setSending(false);
    setError(null);
    setLastCommandId(null);
  }

  // 只有已提交的 render 才能推进代际引用；被放弃的并发 render 不会执行到这里。
  useLayoutEffect(() => {
    generationRef.current = ownership.generation;
  }, [ownership.generation]);

  useEffect(() => {
    attemptRef.current = 0;

    if (!sessionId) return undefined;

    // 本连接所属的**已提交**归属代际（effect 只在 commit 后运行，捕捉到的一定是
    // 已提交快照）。回调一律与 `generationRef`（同样只在 commit 后更新的当前代际）
    // 核对：新会话一旦 commit，旧 source 的迟到 onopen/message/onerror 立刻被拒绝，
    // 不会在"B 已 commit、旧 A passive cleanup 还没跑"的窗口里把帧写进新会话。
    const effectGeneration = ownership.generation;

    let disposed = false;

    /** 本连接是否仍属于当前已提交的会话代际。 */
    const owned = (): boolean =>
      mountedRef.current && !disposed && generationRef.current === effectGeneration;

    const clearTimer = (): void => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const closeSource = (): void => {
      if (sourceRef.current) {
        sourceRef.current.close();
        sourceRef.current = null;
      }
    };

    const scheduleReconnect = (): void => {
      if (disposed) return;
      clearTimer();
      const attempt = attemptRef.current;
      attemptRef.current = attempt + 1;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
      timerRef.current = setTimeout(() => {
        if (!disposed) connect();
      }, delay);
    };

    const connect = (): void => {
      if (!owned()) return;
      closeSource();
      const source = openEventSource(sessions.eventsPath(sessionId));
      sourceRef.current = source;

      source.onopen = () => {
        if (!owned()) return;
        attemptRef.current = 0;
        setConnected(true);
        reportStreamConnected(true);
        setChat((state) => markConnected(state));
      };

      source.addEventListener("message", (raw) => {
        if (!owned()) return;
        const message = raw as MessageEvent<string>;
        const event = parseEvent(message.data);
        if (!event) return;
        setChat((state) => applyStreamEvent(state, event));
      });

      source.onerror = () => {
        if (!owned()) return;
        setConnected(false);
        reportStreamConnected(false, "事件流已断开");
        setChat((state) => markDisconnected(state));
        // readyState=CONNECTING 表示浏览器会自行按 Last-Event-ID 重连；
        // CLOSED 表示服务端拒绝或流已关闭，需要我们自己重建。
        if (source.readyState === EventSource.CLOSED) {
          closeSource();
          scheduleReconnect();
        }
      };
    };

    connect();
    reconnectRef.current = () => {
      if (!owned()) return;
      closeSource();
      setConnected(false);
      connect();
    };

    return () => {
      disposed = true;
      // 旧 source 之后所有迟到的 onopen/message/onerror 都会因为 owned() 为假而被
      // 拒绝；即便 cleanup 还没跑到，generationRef 一旦前进也会立即拒绝。
      reconnectRef.current = () => undefined;
      clearTimer();
      closeSource();
      reportStreamConnected(false);
      setConnected(false);
    };
    // effect 捕获所属代际，因此显式跟踪它；代际只随会话归属变化递增。
  }, [ownership.generation, sessionId]);

  // 提交卸载时立即失效：迟到的请求结果和延迟调用的旧回调都不得继续写入或发请求。
  // layout 生命周期先于连接的 passive effect，StrictMode 重放时也会先恢复 mounted。
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reconnect = useCallback(() => reconnectRef.current(), []);

  // 回调所属的代际：绑定在**回调创建时**的已提交归属快照上（useCallback 依赖），
  // 而不是在回调真正被调用时再去读 `generationRef`。否则一个在 A 创建、等到
  // A→B→A 之后才被触发的旧回调，会因为"sessionId 又相等 + ref 已是新代际"而
  // 误以为自己是当前回调，把请求发往旧的 sid。
  const callbackGeneration = ownership.generation;

  const send = useCallback(
    async (text: string) => {
      if (!sessionId) return;
      // 该回调绑定的是创建时的归属代际。若它被延迟到会话切换之后才调用，
      // 必须整体拒绝：既不发往旧 sid，也不写当前会话的状态。
      if (!mountedRef.current || generationRef.current !== callbackGeneration) return;
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      const commandId = newCommandId();
      const isCurrent = (): boolean =>
        mountedRef.current && generationRef.current === callbackGeneration;
      setSending(true);
      setError(null);
      try {
        const queued = await sessions.send(sessionId, { commandId, text: trimmed });
        // 旧代际：请求可能已被服务端接受，但本地结果不再属于当前会话，直接丢弃。
        if (!isCurrent()) return;
        setLastCommandId(queued.commandId);
        // 202 只表示平台已持久入队，不代表模型已回复——先本地标记为待回显。
        setChat((state) => appendPendingCommand(state, queued.commandId, trimmed));
      } catch (caught) {
        if (!isCurrent()) return;
        setError(describeError(caught).message);
      } finally {
        if (isCurrent()) setSending(false);
      }
    },
    [callbackGeneration, sessionId],
  );

  const cancel = useCallback(async () => {
    if (!sessionId) return;
    // 同上：旧的 cancel 回调一旦晚于会话切换被调用就整体拒绝，
    // 不能拿新代际去取消旧会话的 commandId。
    if (!mountedRef.current || generationRef.current !== callbackGeneration) return;
    if (!lastCommandId) {
      setError("当前没有可取消的命令");
      return;
    }
    setError(null);
    try {
      await sessions.cancel(sessionId, lastCommandId);
    } catch (caught) {
      if (!mountedRef.current || generationRef.current !== callbackGeneration) return;
      setError(describeError(caught).message);
    }
  }, [callbackGeneration, lastCommandId, sessionId]);

  const clearError = useCallback(() => setError(null), []);

  return useMemo(
    () => ({
      sessionId,
      messages: chat.messages,
      connected,
      turnActive: chat.turnActive,
      turnOutcome: chat.turnOutcome,
      turnOutcomeReason: chat.turnOutcomeReason,
      turnPublicText: chat.turnPublicText,
      serverStatus: chat.serverStatus,
      serverStatusSeq: chat.serverStatusSeq,
      settlements: chat.settlements,
      settledSeq: chat.settledSeq,
      notice: chat.notice,
      needsReplay: chat.needsReplay,
      lastCommandId,
      send,
      cancel,
      sending,
      error,
      clearError,
      reconnect,
    }),
    [
      cancel,
      chat.messages,
      chat.needsReplay,
      chat.notice,
      chat.serverStatus,
      chat.serverStatusSeq,
      chat.settledSeq,
      chat.settlements,
      chat.turnActive,
      chat.turnOutcome,
      chat.turnOutcomeReason,
      chat.turnPublicText,
      clearError,
      connected,
      error,
      lastCommandId,
      reconnect,
      send,
      sending,
      sessionId,
    ],
  );
}
