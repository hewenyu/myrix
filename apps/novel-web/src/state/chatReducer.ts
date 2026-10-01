import type { SessionStreamEvent } from "@myrix/contracts";

/** 会话消息在 UI 中的形态。全部来自真实事件，不生成占位文本。 */
export interface ChatMessage {
  /** 稳定 key：持久事件用 seq，瞬态 delta/待回显用本地键。 */
  key: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  /** 持久事件的序号；瞬态 delta 为 undefined。 */
  seq?: number;
  /** 尚未落定的流式文本。 */
  streaming?: boolean;
  /** 本机提交但还没收到持久回显的命令。 */
  pending?: boolean;
  commandId?: string;
  toolName?: string;
  createdAt: number;
}

/**
 * 本回合的服务端终态。
 *
 * 只有持久事件能给出终态：`turn-end`（完成）、带 `seq` 的 `error`（本轮执行失败）、
 * `interrupted`（被中断）、`session-ended:*`（会话在流中被判定结束）。
 * 瞬态 delta / 工具调用 / stream-start **都不是**终态。
 */
export type TurnOutcome = "completed" | "failed" | "interrupted" | "session-ended";

/** 运行态提示的稳定分类：重连只清除与连接相关的提示，不吞掉回合级警告。 */
export type NoticeCode = "stream-disconnected" | "turn-incomplete" | "runtime";

export interface ChatNotice {
  level: "info" | "warn" | "error";
  text: string;
  code: NoticeCode;
}

export interface ChatState {
  messages: ChatMessage[];
  /** 已应用的最大 seq。 */
  lastSeq: number;
  /** 已应用的持久 seq 集合，用于去重（乱序补发时不能只比较 lastSeq）。 */
  seenSeqs: Set<number>;
  /** 保留的 UI 字段；DSH seq 可以合法跳跃，不能推算缺失编号。 */
  missingSeqs: number[];
  /** 仅由服务器明确的 replay-required/truncated 标记触发。 */
  needsReplay: boolean;
  /** 当前轮次是否仍在进行（由持久 user / delta / 工具推进；只有持久终态事件结束它）。 */
  turnActive: boolean;
  /** 本回合终态；`null` 表示没有观察到终态（未开始、进行中或只有瞬态帧）。 */
  turnOutcome: TurnOutcome | null;
  /** 终态的可读原因（失败文案 / 会话结束原因）。 */
  turnOutcomeReason: string | null;
  /** 本回合是否已收到**公开可显示**的持久助手正文（用于区分"完成"与"空转结束"）。 */
  turnPublicText: boolean;
  /**
   * 最近一次收到的**服务端持久**状态文本（interrupted / session-ended / revoked …）。
   *
   * 只由真实持久事件写入：驱动控制帧（`myrix/assistant-stream` 的 start/abandoned）
   * 不是服务端会话状态，绝不能写进这里去伪造"运行中"。
   */
  serverStatus: string | null;
  /** `serverStatus` 对应持久事件的 seq；`null` = 未由持久事件给出过状态。 */
  serverStatusSeq: number | null;
  /**
   * 已观察到的**持久回合终态**次数（单调递增，仅用于触发业务缓存刷新）。
   *
   * 每个终态事件（turn-end / 带 seq 的 error / interrupted / session-ended）恰好 +1：
   * 刷新因此是"每回合一次"的，而不是"回放每个 event 一次"的。它只表示"这一回合已经
   * 有了权威结论"，不表示一定有工具写入。
   */
  settlements: number;
  /** 最近一次持久终态事件的 seq（`null` = 还没有观察到终态）。 */
  settledSeq: number | null;
  /** 运行态提示，例如运行中断、撤销、模型未配置。 */
  notice: ChatNotice | null;
}

export const emptyChatState: ChatState = {
  messages: [],
  lastSeq: 0,
  seenSeqs: new Set<number>(),
  missingSeqs: [],
  needsReplay: false,
  turnActive: false,
  turnOutcome: null,
  turnOutcomeReason: null,
  turnPublicText: false,
  serverStatus: null,
  serverStatusSeq: null,
  settlements: 0,
  settledSeq: null,
  notice: null,
};

/**
 * **瞬态** status 帧：驱动控制帧与连接级信号。
 *
 * 它们不是服务端会话状态，写进 `ChatState.serverStatus` 会让运行标签永远停在
 * "stream-start"（`turn-end` 之后也不回终态）。因此只用于清理未落定的 delta / 提示，
 * 绝不作为运行态展示。
 */
const TRANSIENT_STATUSES: ReadonlySet<string> = new Set([
  "stream-start",
  "stream-abandoned",
  "stream-interrupted",
  "replay-required",
]);

function seqOf(event: SessionStreamEvent): number | null {
  return typeof event.seq === "number" ? event.seq : null;
}

/**
 * 记录一次**持久终态**（每回合恰好一次），供业务缓存刷新使用。
 *
 * `settlements` 是单调计数而不是布尔：同一个回合里 turn-end 与随后的持久 error
 * 都算终态，但它们发生在同一次 409/中断处置中，刷新两次是无害的幂等读取；
 * 反过来说，回放历史时每个终态事件各 +1 也只是有限次数的读取，不会对每个 event 都发 GET。
 */
function settle(state: ChatState): number {
  return state.settlements + 1;
}

/**
 * **回合级**的持久状态：只描述刚刚结束的那一轮。
 *
 * 新的持久 `user/message` 开启新回合时要把它们清掉，否则运行标签会显示
 * "上一轮被中断"而实际新回合正在跑。会话级状态（`session-ended: …`）不清：
 * 它描述的是整个会话，不随新回合失效。
 */
const ROUND_SCOPED_STATUSES: ReadonlySet<string> = new Set(["interrupted"]);

/** 新回合开始（持久 user 事件）：重置**全部**回合级字段，保留已持久内容。 */
function startTurn(state: ChatState): ChatState {
  const clearRoundStatus = state.serverStatus !== null && ROUND_SCOPED_STATUSES.has(state.serverStatus);
  return {
    ...state,
    turnActive: true,
    turnOutcome: null,
    turnOutcomeReason: null,
    turnPublicText: false,
    ...(clearRoundStatus ? { serverStatus: null, serverStatusSeq: null } : {}),
  };
}

/**
 * 观察到本回合仍在推进（增量 / 工具调用 / stream-start）。
 *
 * 只把回合标记为进行中并清掉上一回合终态；**不**改动 `turnPublicText`
 * ——同回合内先出现的持久正文不会因为随后的工具调用被抹掉。
 */
function markActive(state: ChatState): ChatState {
  return { ...state, turnActive: true, turnOutcome: null, turnOutcomeReason: null };
}

/**
 * 助手消息是否包含**公开可显示**的正文。
 *
 * BFF 的白名单投影只拼接 `type:'text'` 块（见 apps/bff/src/runtime-stream.ts 的
 * `textOfContent`）：只含 reasoning / tool-call 块的 assistant/message 会投影成
 * `text:""`。这样的消息是"某个工具步骤结束"，不是本回合的公开回复，
 * 不能落成一个空助手泡，也不能据此认定助手已完成。
 */
export function hasPublicAssistantText(text: string): boolean {
  return text.trim().length > 0;
}

/**
 * UI 渲染用的消息过滤（渲染层第二道防线，不依赖上游一定干净）。
 *
 * - 没有公开正文的 `assistant` 消息（工具调用/推理步骤投影出的空文本）不渲染：
 *   否则会出现"空助手泡"，让用户误以为助手已经回复或本回合已完成；
 * - 工具记录只有在有工具名或公开文本时才渲染，避免纯空的白泡；
 * - 用户/系统消息保留（已确认用户消息必须始终可见）。
 */
export function visibleMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => {
    if (message.role === "assistant") return hasPublicAssistantText(message.text);
    if (message.role === "tool") return hasPublicAssistantText(message.text) || (message.toolName?.length ?? 0) > 0;
    return true;
  });
}

/** 已应用 seq 的保留窗口：只用于乱序补发去重，不必无限增长。 */
const SEEN_WINDOW = 500;

interface SeqProgress {
  state: ChatState;
  /** 该事件是否已被处理过（重复投递）。 */
  duplicate: boolean;
}

/**
 * 服务端按 seq 有序补发；序号只用于水位与去重，不代表连续计数。
 * DSH 恢复种子和 BFF 过滤的内部事件都可以造成合法跳跃。
 */
function advanceSeq(state: ChatState, seq: number): SeqProgress {
  if (!Number.isSafeInteger(seq) || seq < 0 || (state.seenSeqs.size > 0 && seq <= state.lastSeq)) {
    return { state, duplicate: true };
  }
  const seenSeqs = new Set(state.seenSeqs);
  seenSeqs.add(seq);
  for (const item of seenSeqs) if (item < seq - SEEN_WINDOW) seenSeqs.delete(item);
  return {
    state: { ...state, seenSeqs, lastSeq: seq, missingSeqs: [] },
    duplicate: false,
  };
}

/**
 * 事件流的状态归约。
 *
 * 规则来源 docs/implementation/bff-api.md 与 tech-design-v1 §3.3：
 * - 持久事件带 `seq`，按 seq 去重，重放是权威来源；
 * - `delta` 是瞬态流式块，不补发、不落定为最终文本；
 * - 队列回执只表示“已持久接收”，不等于模型已回复。
 */
export function applyStreamEvent(state: ChatState, event: SessionStreamEvent): ChatState {
  let base = state;
  if (typeof event.seq === "number") {
    const advanced = advanceSeq(state, event.seq);
    if (advanced.duplicate) return state;
    base = advanced.state;
  }

  switch (event.type) {
    case "user": {
      const seq = event.seq;
      // 服务端的持久 user 事件替换本机的待回显占位（按 commandId 匹配）。
      const messages = base.messages.filter(
        (m) => !(m.pending && event.commandId !== undefined && m.commandId === event.commandId),
      );
      // 持久 user 事件是"新回合开始"的权威信号：重置上一回合终态与公开正文标记。
      return {
        ...startTurn(base),
        messages: [
          ...messages,
          {
            key: seq === undefined ? `user-local-${base.messages.length}` : `seq-${seq}`,
            role: "user",
            text: event.text ?? "",
            ...(seq === undefined ? {} : { seq }),
            ...(event.commandId === undefined ? {} : { commandId: event.commandId }),
            createdAt: Date.now(),
          },
        ],
      };
    }

    case "assistant": {
      const seq = event.seq;
      const text = event.text ?? "";
      // 持久 assistant 事件替换掉流式占位；但**只含 reasoning/tool-call 块**的消息
      // 投影为空文本，它不是本回合的公开回复——不得落成空助手泡。
      const messages = base.messages.filter((m) => !m.streaming);
      // 收到持久 assistant 事件说明本轮仍在推进；只有 turn-end/失败才是终态。
      // 空文本（只有 reasoning/tool-call 块）不产生气泡，只刷新回合活动状态。
      return hasPublicAssistantText(text)
        ? {
            ...markActive(base),
            messages: [
              ...messages,
              {
                key: seq === undefined ? `assistant-local-${base.messages.length}` : `seq-${seq}`,
                role: "assistant",
                text,
                ...(seq === undefined ? {} : { seq }),
                createdAt: Date.now(),
              },
            ],
            turnPublicText: true,
          }
        : { ...markActive({ ...base, messages }) };
    }
    case "delta": {
      const text = event.text ?? "";
      if (text.length === 0) return base;
      const index = [...base.messages].reverse().findIndex((m) => m.streaming);
      const messages = [...base.messages];
      if (index >= 0) {
        const realIndex = messages.length - 1 - index;
        const current = messages[realIndex]!;
        messages[realIndex] = { ...current, text: current.text + text };
      } else {
        messages.push({
          key: `delta-${base.messages.length}-${Date.now()}`,
          role: "assistant",
          text,
          streaming: true,
          createdAt: Date.now(),
        });
      }
      // 瞬态增量只表示"正在生成"，不产生终态、也不等于公开持久正文。
      return { ...markActive(base), messages };
    }
    case "tool": {
      const seq = event.seq;
      const toolName = event.toolName;
      const text = event.text ?? "";
      // 既无工具名也无文本的工具事件没有可显示内容：不造空元数据泡，但仍记为回合活动。
      if ((toolName === undefined || toolName.length === 0) && !hasPublicAssistantText(text)) {
        return markActive(base);
      }
      return {
        ...markActive(base),
        messages: [
          ...base.messages,
          {
            key: seq === undefined ? `tool-local-${base.messages.length}` : `tool-seq-${seq}`,
            role: "tool",
            text,
            ...(toolName === undefined ? {} : { toolName }),
            ...(seq === undefined ? {} : { seq }),
            createdAt: Date.now(),
          },
        ],
      };
    }
    case "status": {
      const status = event.status ?? "";
      // 驱动控制帧（`myrix/assistant-stream` 的 start / abandoned、truncated、
      // 上游断开）是**瞬态**信号，不是服务端会话状态。写进 `serverStatus` 会让
      // 运行标签永远停在 "stream-start"（turn-end 之后也不回到终态）。
      const transient = TRANSIENT_STATUSES.has(status);
      const next: ChatState = {
        ...base,
        serverStatus: !transient && status.length > 0 ? status : base.serverStatus,
        serverStatusSeq: !transient && status.length > 0 ? seqOf(event) : base.serverStatusSeq,
        // Attempts may retry without a turn-end. Never splice a new attempt onto old deltas.
        messages: status === "stream-start" || status === "stream-abandoned"
          ? base.messages.filter((m) => !m.streaming) : base.messages,
        needsReplay: status === "replay-required" ? true : base.needsReplay,
      };
      if (status === "stream-start" || status === "working" || status === "waking") {
        // 新尝试开始：清掉上一回合终态，回到"进行中"。这不是完成信号。
        return markActive(next);
      }
      if (status === "interrupted") {
        return {
          ...next,
          turnActive: false,
          turnOutcome: "interrupted",
          turnOutcomeReason: null,
          settledSeq: seqOf(event),
          settlements: settle(base),
        };
      }
      if (status.startsWith("session-ended")) {
        return {
          ...next,
          turnActive: false,
          turnOutcome: "session-ended",
          turnOutcomeReason: status.slice("session-ended".length).replace(/^:\s*/, "") || null,
          settledSeq: seqOf(event),
          settlements: settle(base),
        };
      }
      return next;
    }
    case "turn-end": {
      // 只有持久 assistant 事件能落定正文；中断轮次不能把 delta 冒充已保存回复。
      const droppedStreaming = base.messages.some((m) => m.streaming);
      return {
        ...base,
        messages: base.messages.filter((m) => !m.streaming),
        turnActive: false,
        turnOutcome: "completed",
        turnOutcomeReason: null,
        // 持久 turn-end 是唯一的"本回合完成"信号：运行态与业务缓存据此回到终态。
        settledSeq: seqOf(event),
        settlements: settle(base),
        // 完成但没有任何公开正文：明确提示，避免把"只调用了工具"当成助手已回复。
        ...(droppedStreaming || !base.turnPublicText
          ? {
              notice: {
                level: "warn" as const,
                code: "turn-incomplete" as const,
                text: droppedStreaming
                  ? "本轮未确认的流式内容已移除；已持久化的回复保留。"
                  : "本轮已结束，但没有可显示的助手正文（可能只执行了工具调用）；请查看工具记录或重试。",
              },
            }
          : {}),
      };
    }
    case "error": {
      const seq = event.seq;
      const text = event.text ?? event.status ?? "会话发生错误";
      if (seq === undefined) {
        // 无 seq 的错误是流级瞬态提示（例如连接中断）：不得据此判定本回合失败。
        return {
          ...base,
          notice: { level: "error", code: "runtime", text },
          messages: base.messages.filter((m) => !m.streaming),
        };
      }
      return {
        ...base,
        notice: { level: "error", code: "runtime", text },
        messages: base.messages.filter((m) => !m.streaming),
        turnActive: false,
        turnOutcome: "failed",
        turnOutcomeReason: text,
        serverStatus: "failed",
        settledSeq: seq,
        settlements: settle(base),
      };
    }
    default:
      return base;
  }
}

/** 断线保留持久事件；瞬态内容不能跨连接拼接（丢失部分等待持久正文确认）。 */
export function markDisconnected(state: ChatState): ChatState {
  return {
    ...state,
    messages: state.messages.filter((m) => !m.streaming),
    notice: { level: "warn", code: "stream-disconnected", text: "事件流已断开，正在重连；已收到的持久事件保留。" },
  };
}

export function markConnected(state: ChatState): ChatState {
  // 只清除"连接恢复"能解释的提示；回合级警告（例如完成但没有公开正文）必须保留。
  if (state.notice?.code !== "stream-disconnected") return state;
  return { ...state, notice: null };
}

/**
 * 本机提交成功后插入"已入队、等待服务端确认"的占位。
 *
 * 反向顺序（极快 SSE：持久 `user/message` 在 `POST /messages` 的 202 返回**之前**
 * 就已到达）必须处理：那时 reducer 已经落下 `commandId` 相同的持久消息，这里
 * **不能**再追加一条 pending，否则同一条用户消息会显示两次。因此除了 pending
 * 占位，还要检查已确认消息的 commandId。
 *
 * 命中的两种情况：
 *   * 已确认的持久消息存在 → 什么都不用做（本轮已由持久事件开启）；
 *   * 完全没见过该 commandId → 正常插入占位，并把回合标记为进行中。
 */
export function appendPendingCommand(state: ChatState, commandId: string, text: string): ChatState {
  if (state.messages.some((message) => message.commandId === commandId)) return state;
  return {
    // 平台已持久接收该命令：这是新回合的开始，必须清掉上一回合终态，
    // 否则 UI（与验收脚本）会把"上一轮已完成"误当成"本轮已完成"。
    ...startTurn(state),
    messages: [
      ...state.messages,
      { key: `pending-${commandId}`, role: "user", text, pending: true, commandId, createdAt: Date.now() },
    ],
  };
}
