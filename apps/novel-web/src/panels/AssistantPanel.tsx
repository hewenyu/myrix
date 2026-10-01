import type { NovelPreset, NovelSession } from "@myrix/contracts";
import { useState } from "react";

import { Banner, EmptyHint, StatusPill } from "../components/common";
import { visibleMessages } from "../state/chatReducer";
import { describeRunState, describeSessionStatus, looksLikeHtml } from "../state/status";
import type { SessionStreamState } from "../state/useSessionStream";

export const PRESET_LABELS: Record<NovelPreset, { title: string; hint: string }> = {
  "novel-outline": { title: "大纲助手", hint: "整理故事线、结构与节奏" },
  "novel-chapter": { title: "章节写作", hint: "起草与修改章节正文" },
  "novel-bible": { title: "设定管理", hint: "维护人物、设定与时间线" },
};

export const PRESET_KEYS = ["novel-outline", "novel-chapter", "novel-bible"] as const satisfies readonly NovelPreset[];

/** preset 展示信息；服务端若下发未知 preset，原样回显而不是假装是已知助手。 */
export function presetLabel(preset: string): { title: string; hint: string } {
  const known = PRESET_LABELS[preset as NovelPreset] as { title: string; hint: string } | undefined;
  return known ?? { title: preset, hint: "未知助手类型" };
}

export interface AssistantPanelProps {
  workId: string | null;
  sessions: NovelSession[];
  sessionsLoading: boolean;
  sessionsError: string | null;
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onCreateSession: (preset: NovelPreset) => void;
  createPending: boolean;
  createError: string | null;
  onDeleteSession: (sessionId: string) => void;
  deletePending: boolean;
  onReloadSessions: () => void;
  stream: SessionStreamState;
  /** 运行单元是否可用（用于“唤醒中/未配置模型”等提示的上下文）。 */
  runtimeHint: string | null;
}

/**
 * 右栏助手：preset 选择、会话列表、消息流与取消。
 *
 * 关键约束：
 * - 消息全部来自真实 SSE 事件或本机已确认入队的命令，绝不生成占位正文；
 * - 模型文本一律按纯文本渲染，不使用 dangerouslySetInnerHTML；
 * - “已入队”与“已完成”在 UI 上是两种状态。
 */
export function AssistantPanel({
  workId,
  sessions,
  sessionsLoading,
  sessionsError,
  selectedSessionId,
  onSelectSession,
  onCreateSession,
  createPending,
  createError,
  onDeleteSession,
  deletePending,
  onReloadSessions,
  stream,
  runtimeHint,
}: AssistantPanelProps) {
  const [preset, setPreset] = useState<NovelPreset>("novel-chapter");
  const [draft, setDraft] = useState("");

  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null;
  // 运行标签由持久事实推导：终态 / 进行中 / 连接生命周期，绝不停在瞬态 stream-start。
  const statusLabel = describeRunState({
    hasSession: Boolean(selectedSessionId),
    connected: stream.connected,
    turnActive: stream.turnActive,
    turnOutcome: stream.turnOutcome,
    settledSeq: stream.settledSeq,
    serverStatus: stream.serverStatus,
    serverStatusSeq: stream.serverStatusSeq,
  });
  // 渲染层只显示有公开内容的消息：空助手泡/空工具泡一律不出现。
  const messages = visibleMessages(stream.messages);

  return (
    <section className="pane assistant" aria-label="创作助手">
      <header className="pane-header">
        <span>创作助手</span>
        <span className="spacer" />
        <button type="button" onClick={onReloadSessions} disabled={sessionsLoading || !workId}>
          {sessionsLoading ? "读取中…" : "刷新会话"}
        </button>
      </header>

      <div className="pane-body stack" style={{ flex: "0 0 auto", maxHeight: "42vh" }}>
        {runtimeHint ? <Banner level="warn">{runtimeHint}</Banner> : null}
        {sessionsError ? (
          <Banner level="error" actions={<button type="button" onClick={onReloadSessions}>重试</button>}>
            {sessionsError}
          </Banner>
        ) : null}

        <div className="preset-grid">
          {PRESET_KEYS.map((key) => {
            const info = presetLabel(key);
            return (
              <button
                key={key}
                type="button"
                data-testid="preset-option"
                aria-pressed={preset === key}
                onClick={() => setPreset(key)}
                title={info.hint}
              >
                {preset === key ? "● " : "○ "}
                {info.title}
                <span className="item-sub">{info.hint}</span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="primary"
          disabled={!workId || createPending}
          onClick={() => onCreateSession(preset)}
        >
          {createPending ? "创建中…" : `新建会话（${presetLabel(preset).title}）`}
        </button>
        {createError ? <Banner level="error">{createError}</Banner> : null}

        <ul className="list">
          {sessions.map((session) => {
            const label = describeSessionStatus(session.status);
            return (
              <li key={session.id}>
                <button
                  type="button"
                  className="item"
                  aria-current={session.id === selectedSessionId}
                  onClick={() => onSelectSession(session.id)}
                >
                  {presetLabel(session.preset).title}
                  <span className="item-sub">
                    {label.text} · {new Date(session.createdAt).toLocaleString("zh-CN", { hour12: false })}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {!sessionsLoading && workId && sessions.length === 0 ? (
          <EmptyHint>该作品还没有助手会话，选择 preset 后新建。</EmptyHint>
        ) : null}
        {!workId ? <EmptyHint>请先在左侧选择或创建作品。</EmptyHint> : null}
      </div>

      <div className="chat">
        {selectedSession ? (
          <div className="toolbar small">
            <span className="muted">{presetLabel(selectedSession.preset).title}</span>
            <StatusPill
              label="连接"
              value={stream.connected ? "已连接" : "已断开"}
              level={stream.connected ? "ok" : "warn"}
            />
            {statusLabel ? <StatusPill label="运行" value={statusLabel.text} level={statusLabel.level} /> : null}
            <span className="spacer" />
            <button
              type="button"
              className="danger"
              disabled={deletePending}
              onClick={() => onDeleteSession(selectedSession.id)}
              title="撤销该会话并销毁运行时 Agent"
            >
              {deletePending ? "撤销中…" : "撤销会话"}
            </button>
          </div>
        ) : null}

        {stream.notice ? <Banner level={stream.notice.level === "warn" ? "warn" : "error"}>{stream.notice.text}</Banner> : null}
        {stream.turnOutcome === "failed" || stream.turnOutcome === "interrupted" || stream.turnOutcome === "session-ended" ? (
          <Banner level={stream.turnOutcome === "failed" ? "error" : "warn"}>
            {stream.turnOutcome === "failed"
              ? `本回合执行失败：${stream.turnOutcomeReason ?? "服务端未给出原因"}`
              : stream.turnOutcome === "interrupted"
                ? "本回合被中断；未持久确认的流式内容已移除，已保存的回复保留。"
                : `会话已结束${stream.turnOutcomeReason ? `：${stream.turnOutcomeReason}` : ""}，请新建或重新选择会话。`}
          </Banner>
        ) : null}
        {stream.needsReplay ? (
          <Banner
            level="warn"
            actions={
              <button type="button" onClick={stream.reconnect}>
                重新连接并补齐
              </button>
            }
          >
            持久事件出现序号缺口，可能有内容缺失。已收到的内容保持不变，可重新连接让服务端按
            Last-Event-ID 补发。
          </Banner>
        ) : null}
        {selectedSessionId && !stream.connected && !stream.notice ? (
          <Banner level="warn">
            事件流已断开，正在自动重连；重连后以持久事件（seq）为准，期间不展示任何未确认内容。
          </Banner>
        ) : null}
        {stream.error ? (
          <Banner level="error" actions={<button type="button" onClick={stream.clearError}>关闭</button>}>
            {stream.error}
          </Banner>
        ) : null}

        <div className="chat-log" data-testid="chat-log" data-turn-active={stream.turnActive ? "true" : "false"} data-turn-outcome={stream.turnOutcome ?? "none"} data-turn-public-text={stream.turnPublicText ? "true" : "false"}>
          {!selectedSessionId ? <EmptyHint>选择或新建一个会话后开始对话。</EmptyHint> : null}
          {selectedSessionId && messages.length === 0 ? (
            <EmptyHint>还没有消息。提交后先在平台入队，模型回复通过事件流到达。</EmptyHint>
          ) : null}
          {messages.map((message) => (
            <article
              key={message.key}
              className={`msg ${message.role}${message.streaming ? " streaming" : ""}`}
              data-role={message.role}
              data-seq={typeof message.seq === "number" ? String(message.seq) : undefined}
              data-streaming={message.streaming ? "true" : "false"}
            >
              <div className="msg-meta">
                <span>
                  {message.role === "user"
                    ? "用户"
                    : message.role === "assistant"
                      ? "助手"
                      : message.role === "tool"
                        ? "工具"
                        : "系统"}
                </span>
                {message.pending ? <span>已入队，等待服务端确认</span> : null}
                {message.streaming ? <span>流式输出中（未落定）</span> : null}
                {typeof message.seq === "number" ? <span>seq {message.seq}</span> : null}
                {message.toolName ? <span>{message.toolName}</span> : null}
                {looksLikeHtml(message.text) ? <span>按纯文本显示（未解析 HTML）</span> : null}
              </div>
              <div className="msg-text">{message.text}</div>
            </article>
          ))}
        </div>

        <form
          className="chat-compose"
          onSubmit={(event) => {
            event.preventDefault();
            const text = draft.trim();
            if (text.length === 0 || !selectedSessionId) return;
            void stream.send(text);
            setDraft("");
          }}
        >
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={selectedSessionId ? "描述你的需求，提交后由助手处理" : "先选择或新建会话"}
            disabled={!selectedSessionId}
            aria-label="消息输入"
          />
          <div className="row">
            <button type="submit" className="primary" disabled={!selectedSessionId || stream.sending || draft.trim().length === 0}>
              {stream.sending ? "提交中…" : "提交"}
            </button>
            <button
              type="button"
              className="danger"
              disabled={!selectedSessionId}
              onClick={() => void stream.cancel()}
              title={
                stream.lastCommandId
                  ? "请求取消最近一次提交的命令"
                  : "本页没有记录到命令；刷新页面后需重新提交或改用撤销会话"
              }
            >
              取消
            </button>
            {stream.turnActive ? <span className="small muted">模型正在生成…</span> : null}
          </div>
        </form>
      </div>
    </section>
  );
}
