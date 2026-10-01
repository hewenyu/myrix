import type { NovelSession } from "@myrix/contracts";

import type { TurnOutcome } from "./chatReducer";

/** 与样式表里的 `.status-pill.is-*` 保持一致。 */
export type StatusLevel = "info" | "ok" | "progress" | "warn" | "error";

export interface StatusLabel {
  text: string;
  level: StatusLevel;
}

/**
 * 会话运行态文案。取值来自 BFF/事件流（NovelSession.status 与 SessionStreamEvent.status），
 * 未识别的取值原样展示，不猜测、不美化。
 *
 * 注意：这里只映射**服务端持久**状态。驱动控制帧（`myrix/assistant-stream` 的
 * start/abandoned、truncated、上游断开）是瞬态信号，一律不进 `serverStatus`——
 * 否则运行标签会永远停在 "stream-start"，turn-end 之后也没有终态。
 */
const SERVER_STATUS_LABELS: Record<string, StatusLabel> = {
  pending: { text: "排队中（尚未投递）", level: "info" },
  waking: { text: "正在唤醒运行单元", level: "progress" },
  ready: { text: "运行单元已就绪", level: "info" },
  working: { text: "模型正在生成", level: "progress" },
  idle: { text: "空闲", level: "info" },
  interrupted: { text: "上一轮被中断，请重试", level: "warn" },
  revoked: { text: "会话已撤销", level: "error" },
  "model-not-configured": { text: "未配置可用模型，请联系管理员", level: "error" },
  "model_not_configured": { text: "未配置可用模型，请联系管理员", level: "error" },
  disconnected: { text: "事件流已断开", level: "warn" },
  queued: { text: "平台已接收（排队中，不代表模型已回复）", level: "info" },
};

export function describeServerStatus(status: string | null | undefined): StatusLabel | null {
  if (!status) return null;
  const known = SERVER_STATUS_LABELS[status];
  if (known) return known;
  // BFF 的流终止状态带原因（`session-ended: <原因>`）：把它读成"会话已结束 + 原因"，
  // 但**不**猜测原因内容本身，原样附在后面。
  if (status.startsWith("session-ended")) {
    const reason = status.slice("session-ended".length).replace(/^:\s*/, "");
    return { text: reason.length > 0 ? `会话已结束：${reason}` : "会话已结束", level: "warn" };
  }
  return { text: status, level: "info" };
}

const SESSION_STATUS_LABELS: Record<NovelSession["status"], StatusLabel> = {
  creating: { text: "创建中", level: "progress" },
  active: { text: "活跃", level: "info" },
  revoked: { text: "已撤销", level: "error" },
};

export function describeSessionStatus(status: NovelSession["status"]): StatusLabel {
  // 服务端引入新状态时原样展示，不伪装成已知状态。
  return SESSION_STATUS_LABELS[status] ?? { text: status, level: "info" };
}

const TURN_OUTCOME_LABELS: Record<TurnOutcome, StatusLabel> = {
  completed: { text: "本轮已完成", level: "ok" },
  failed: { text: "本轮执行失败", level: "error" },
  interrupted: { text: "本轮被中断", level: "warn" },
  "session-ended": { text: "会话已结束", level: "warn" },
};

export interface RunStateInput {
  /** 是否选中了会话；没有会话就没有运行态可言。 */
  hasSession: boolean;
  /** 事件流是否在线（连接生命周期）。 */
  connected: boolean;
  /** 本回合是否仍在推进（由 stream-start / delta / 工具事件驱动）。 */
  turnActive: boolean;
  /** 已观察到的持久回合终态；`null` = 还没有终态。 */
  turnOutcome: TurnOutcome | null;
  /** 该终态对应事件的 seq（用于与 serverStatus 比较新旧）。 */
  settledSeq: number | null;
  /** 最近一条**持久**服务端状态（interrupted / session-ended / revoked …）。 */
  serverStatus: string | null;
  /** 上述状态对应事件的 seq。 */
  serverStatusSeq: number | null;
}

/**
 * 运行态标签：由**已观察到的持久事实**驱动，不隐藏、不伪造。
 *
 * 优先级（以 seq 判定新旧，最新的持久事实胜出）：
 *   1. 会话级/回合级持久状态（`serverStatus`）；
 *   2. 持久回合终态（`turnOutcome` + `settledSeq`）；
 *   3. 仍在推进中的回合（`turnActive`，来自真实的 start/delta/工具事件）；
 *   4. 连接生命周期（已连接空闲 / 未连接）。
 *
 * 这样 `turn-end` 之后标签会回到"本轮已完成"，而不是停在瞬态的 "stream-start"；
 * 同时**不会**在没有服务端证据时声称模型已配置或运行单元已就绪。
 */
export function describeRunState(input: RunStateInput): StatusLabel | null {
  if (!input.hasSession) return null;

  const serverLabel = describeServerStatus(input.serverStatus);
  const turnLabel = input.turnOutcome ? TURN_OUTCOME_LABELS[input.turnOutcome] : null;
  const turnSeq = input.settledSeq ?? -1;
  const serverSeq = input.serverStatusSeq ?? -1;

  if (turnLabel && turnSeq >= serverSeq) return turnLabel;
  if (serverLabel) return serverLabel;
  if (input.turnActive) return { text: "本轮进行中", level: "progress" };
  if (input.connected) return { text: "空闲（事件流已连接）", level: "info" };
  return { text: "事件流未连接", level: "warn" };
}

/** 文本是否含有 HTML 标签——模型输出一律按纯文本处理，仅用于给出提示。 */
export function looksLikeHtml(text: string): boolean {
  return /<\/?[a-zA-Z][^>]*>/.test(text);
}
