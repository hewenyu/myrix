import type { NovelPreset, NovelSession } from "@myrix/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Banner, StatusPill } from "../components/common";
import { Icon } from "../components/Icon";
import { visibleMessages } from "../state/chatReducer";
import { describeRunState, describeSessionStatus, looksLikeHtml } from "../state/status";
import type { SessionStreamState } from "../state/useSessionStream";
import { formatTime } from "./format";

export const PRESET_LABELS: Record<NovelPreset, { title: string; hint: string }> = {
  "novel-assistant": { title: "创作 Agent", hint: "一起构思、写作和打磨故事" },
  "novel-outline": { title: "历史大纲对话", hint: "此历史对话仅有大纲工具权限" },
  "novel-chapter": { title: "历史章节对话", hint: "此历史对话仅有章节工具权限" },
  "novel-bible": { title: "历史设定对话", hint: "此历史对话仅有设定工具权限" },
};
export const PRESET_KEYS = ["novel-assistant"] as const;
export function presetLabel(preset: string) { return PRESET_LABELS[preset as NovelPreset] ?? { title: preset, hint: "未知助手类型" }; }

export interface AssistantPanelProps {
  workId: string | null;
  sessions: NovelSession[];
  sessionsLoading: boolean;
  sessionsError: string | null;
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onCreateSession: (preset: NovelPreset) => void | Promise<string | null>;
  onNewConversation?: () => void;
  createPending: boolean;
  createError: string | null;
  onDeleteSession: (sessionId: string) => void;
  deletePending: boolean;
  deleteError?: string | null;
  onArchiveSession?: (sessionId: string, archived: boolean) => void;
  archivePending?: boolean;
  archiveError?: string | null;
  onReloadSessions: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  stream: SessionStreamState;
  runtimeHint: string | null;
}

export function AssistantPanel({ workId, sessions, sessionsLoading, sessionsError, selectedSessionId, onSelectSession, onCreateSession, onNewConversation, createPending, createError, onDeleteSession, deletePending, deleteError, onArchiveSession, archivePending, archiveError, onReloadSessions, onDirtyChange, stream, runtimeHint }: AssistantPanelProps) {
  const [draft, setDraft] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [firstMessage, setFirstMessage] = useState<{ sessionId: string; text: string } | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const lock = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const log = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onDirtyChange?.(draft.trim().length > 0); }, [draft, onDirtyChange]);
  useEffect(() => {
    if (textarea.current) { textarea.current.style.height = "auto"; textarea.current.style.height = `${Math.min(180, Math.max(72, textarea.current.scrollHeight))}px`; }
  }, [draft]);
  const selectedSession = sessions.find((item) => item.id === selectedSessionId);
  const archived = Boolean(selectedSession?.archivedAt);
  const messages = visibleMessages(stream.messages);
  const statusLabel = describeRunState({ hasSession: Boolean(selectedSessionId), connected: stream.connected, turnActive: stream.turnActive, turnOutcome: stream.turnOutcome, settledSeq: stream.settledSeq, serverStatus: stream.serverStatus, serverStatusSeq: stream.serverStatusSeq });
  const waiting = stream.turnActive || stream.sending || stream.messages.some((message) => message.pending);
  const terminal = selectedSession?.status === "revoked" || stream.serverStatus === "revoked" || stream.turnOutcome === "session-ended";
  useEffect(() => { if (follow.current && log.current) log.current.scrollTop = log.current.scrollHeight; }, [stream.messages, selectedSessionId]);

  const sendText = useCallback(async (text: string) => {
    const start = generation.current;
    lock.current = true; setSubmitting(true);
    try {
      const result = await stream.send(text);
      if (mounted.current && start === generation.current && result !== false) setDraft((value) => value.trim() === text ? "" : value);
    } catch { if (mounted.current && start === generation.current) setLocalError("消息未发送成功，输入已保留，请重试。"); }
    finally { if (mounted.current && start === generation.current) { lock.current = false; setSubmitting(false); } }
  }, [stream]);
  // 创建是异步激活的：只有该会话流真正连通后才发送首条消息，绝不误发到另一个会话。
  useEffect(() => {
    if (!firstMessage || firstMessage.sessionId !== selectedSessionId || stream.sessionId !== selectedSessionId || !stream.connected || lock.current) return;
    setFirstMessage(null);
    void sendText(firstMessage.text);
  }, [firstMessage, selectedSessionId, stream.sessionId, stream.connected, sendText]);
  useEffect(() => {
    if (!firstMessage) return;
    const timeout = window.setTimeout(() => { setFirstMessage(null); setLocalError("对话连接尚未就绪，消息仍保留在输入框。连接恢复后请再次发送。"); }, 30_000);
    return () => window.clearTimeout(timeout);
  }, [firstMessage]);

  const navigate = (action: () => void) => {
    if ((draft.trim() || firstMessage || submitting) && !window.confirm("当前消息尚未发送完成。切换对话将放弃输入内容，是否继续？")) return;
    generation.current++; lock.current = false; setSubmitting(false); setFirstMessage(null); setDraft(""); setLocalError(null); setHistoryOpen(false); follow.current = true; action();
  };
  const submit = async () => {
    const text = draft.trim();
    if (!workId || !text || lock.current || createPending || firstMessage || waiting || archived || terminal || (selectedSessionId && (!stream.connected || stream.sessionId !== selectedSessionId))) return;
    setLocalError(null);
    if (selectedSessionId) { await sendText(text); return; }
    const start = generation.current;
    lock.current = true; setSubmitting(true);
    try {
      const id = await onCreateSession("novel-assistant");
      if (mounted.current && start === generation.current && id) setFirstMessage({ sessionId: id, text });
    } catch { if (mounted.current && start === generation.current) setLocalError("未能开启对话，请重试。消息已保留。"); }
    finally { if (mounted.current && start === generation.current) { lock.current = false; setSubmitting(false); } }
  };

  return <section className="pane assistant" aria-label="创作助手">
    <header className="pane-header assistant-header"><span className="agent-mark"><Icon name="spark" size={18} /></span><div><strong>创作 Agent</strong><span className="agent-subtitle">陪你把故事写下去</span></div><span className="spacer" /><button type="button" className="icon-button" aria-label="历史对话" title="历史对话" aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}><Icon name="history" /></button><button type="button" className="icon-button" aria-label="新对话" title="新对话" onClick={() => navigate(() => onNewConversation?.())}><Icon name="plus" /></button></header>
    {historyOpen ? <div className="conversation-history"><div className="row"><strong>对话记录</strong><span className="spacer" /><button className="text-button" type="button" onClick={onReloadSessions} disabled={sessionsLoading}>刷新</button></div><div className="history-tabs"><button type="button" aria-pressed={!showArchived} onClick={() => setShowArchived(false)}>最近</button><button type="button" aria-pressed={showArchived} onClick={() => setShowArchived(true)}>已归档</button></div>
      {sessionsLoading ? <p className="small muted">正在读取…</p> : null}
      {sessionsError ? <Banner level="error">{sessionsError}</Banner> : null}
      {!sessionsLoading && !sessions.some((item) => Boolean(item.archivedAt) === showArchived) ? <p className="small muted">{showArchived ? "没有已归档对话。" : "还没有对话，从下面的一句话开始。"}</p> : null}
      <ul className="list">{sessions.filter((item) => Boolean(item.archivedAt) === showArchived).map((item, index) => <li className="history-item" key={item.id} data-session-id={item.id}><button className="item" type="button" aria-current={item.id === selectedSessionId} onClick={() => navigate(() => onSelectSession(item.id))}><span>{presetLabel(item.preset).title} · {index + 1}</span><span className="item-sub">{formatTime(item.createdAt)} · {describeSessionStatus(item.status).text}</span></button>{onArchiveSession ? <button type="button" className="icon-button" disabled={archivePending} aria-label={item.archivedAt ? "恢复对话" : "归档对话"} title={item.archivedAt ? "恢复对话" : "归档对话（不停止正在执行的任务）"} onClick={() => { if (item.id === selectedSessionId && !item.archivedAt) navigate(() => onArchiveSession(item.id, true)); else onArchiveSession(item.id, !item.archivedAt); }}>{item.archivedAt ? "恢复" : <Icon name="archive" size={17} />}</button> : null}</li>)}</ul>
      <p className="small muted">归档只整理记录，不会删除内容或停止任务。</p>
    </div> : null}
    <div className="chat">
      {selectedSessionId ? <div className="toolbar chat-status small"><span className={`connection-dot ${stream.connected ? "connected" : ""}`} />{statusLabel ? <StatusPill label="运行" value={statusLabel.text} level={statusLabel.level} /> : null}<span className="spacer" /><details className="session-options"><summary aria-label="当前对话操作"><Icon name="more" size={18} /></summary><div>{onArchiveSession ? <button type="button" disabled={archivePending} onClick={() => navigate(() => onArchiveSession(selectedSessionId, !archived))}>{archived ? "恢复对话" : "归档对话"}</button> : null}<button type="button" className="danger" disabled={deletePending || terminal} onClick={() => { if (window.confirm("永久结束这段对话？这会撤销权限，无法继续对话。整理记录请使用归档。")) navigate(() => onDeleteSession(selectedSessionId)); }}>永久结束对话</button></div></details></div> : null}
      {selectedSession && selectedSession.preset !== "novel-assistant" ? <Banner level="warn">{presetLabel(selectedSession.preset).hint}。开始新对话可使用统一创作 Agent。</Banner> : null}
      {archived ? <Banner level="warn">这段对话已归档，可查看历史。恢复后可以继续发送消息。</Banner> : null}
      {[createError, archiveError, deleteError, localError, runtimeHint].filter(Boolean).map((error, index) => <Banner key={index} level="error">{error}</Banner>)}
      {stream.notice ? <Banner level={stream.notice.level === "warn" ? "warn" : "error"}>{stream.notice.text}</Banner> : null}
      {stream.turnOutcome === "failed" || stream.turnOutcome === "interrupted" || stream.turnOutcome === "session-ended" ? <Banner level={stream.turnOutcome === "failed" ? "error" : "warn"}>{stream.turnOutcome === "failed" ? `本回合执行失败：${stream.turnOutcomeReason ?? "服务端未给出原因"}` : stream.turnOutcome === "interrupted" ? "本回合被中断；未持久确认的流式内容已移除，已保存的回复保留。" : `会话已结束${stream.turnOutcomeReason ? `：${stream.turnOutcomeReason}` : ""}，请开始新对话。`}</Banner> : null}
      {stream.needsReplay ? <Banner level="warn" actions={<button type="button" onClick={stream.reconnect}>重新连接并补齐</button>}>对话记录可能有缺失，可重新连接补齐，已收到的内容不会被改动。</Banner> : null}
      {selectedSessionId && !stream.connected && !stream.notice ? <Banner level="warn">{firstMessage ? "正在开启对话，连接就绪后会自动发送。" : "事件流已断开，正在自动重连；已保存的回复不会丢失。"}</Banner> : null}
      {stream.error ? <Banner level="error" actions={<button type="button" onClick={stream.clearError}>关闭</button>}>{stream.error}</Banner> : null}
      <div ref={log} className="chat-log" role="log" aria-label="对话内容" aria-live="polite" onScroll={() => { if (log.current) follow.current = log.current.scrollHeight - log.current.scrollTop - log.current.clientHeight < 70; }} data-testid="chat-log" data-turn-active={stream.turnActive ? "true" : "false"} data-turn-outcome={stream.turnOutcome ?? "none"} data-turn-public-text={stream.turnPublicText ? "true" : "false"}>
        {messages.length === 0 ? <div className="chat-welcome"><span className="welcome-mark"><Icon name="spark" size={30} /></span><h2>今天，故事走向哪里？</h2><p>聊聊你的想法，或一起打磨下一页。<br />构思情节、描写人物、修改正文，都可以直接说。</p><div className="prompt-suggestions">{["陪我梳理一下这个故事的主线", "一起设计一个令人难忘的主角", "我有一段文字，想请你帮我润色"].map((text) => <button type="button" key={text} onClick={() => { setDraft(text); textarea.current?.focus(); }}>{text}<span aria-hidden="true">↗</span></button>)}</div></div> : null}
        {messages.map((message) => <article key={message.key} className={`msg ${message.role}${message.streaming ? " streaming" : ""}`} data-role={message.role} data-seq={typeof message.seq === "number" ? String(message.seq) : undefined} data-streaming={message.streaming ? "true" : "false"}>
          <div className="msg-meta"><span>{message.role === "user" ? "你" : message.role === "assistant" ? "Myrix" : message.role === "tool" ? "创作操作" : "系统"}</span>{message.pending ? <span>已入队，等待服务端确认</span> : null}{message.streaming ? <span>流式输出中（未落定）</span> : null}{message.toolName ? <span>{message.toolName}</span> : null}{looksLikeHtml(message.text) ? <span>按纯文本显示（未解析 HTML）</span> : null}</div><div className="msg-text">{message.text}</div>
        </article>)}
      </div>
      <form className="chat-compose" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <textarea ref={textarea} value={draft} onChange={(event) => setDraft(event.target.value)} aria-label="消息输入" placeholder={archived ? "恢复对话后继续聊" : "说说你的想法，或想修改的地方…"} disabled={!workId || archived || terminal || Boolean(firstMessage)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void submit(); } }} />
        <div className="compose-actions"><span className="small muted">{firstMessage || submitting ? "正在准备发送…" : "Enter 发送 · Shift + Enter 换行"}</span><span className="spacer" />{waiting ? <button type="button" className="send-button stop-button" aria-label="停止生成" title={stream.lastCommandId ? "停止生成（已保存内容会保留）" : "此任务不是从本页发出，无法获取停止目标"} disabled={!stream.lastCommandId} onClick={() => void stream.cancel()}><Icon name="stop" size={19} /></button> : <button type="submit" className="send-button" aria-label="发送消息" title="发送消息" disabled={!workId || !draft.trim() || submitting || createPending || Boolean(firstMessage) || archived || terminal || Boolean(selectedSessionId && (!stream.connected || stream.sessionId !== selectedSessionId))}><Icon name="arrow" size={20} /></button>}</div>
      </form><p className="compose-footnote">AI 建议供参考 · 未保存正文不会自动发送</p>
    </div>
  </section>;
}
