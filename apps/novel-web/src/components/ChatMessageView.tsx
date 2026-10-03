// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0
import type { ChatMessage } from "../state/chatReducer";
import { looksLikeHtml } from "../state/status";
import { ReadingContent } from "./ReadingContent";

const toolLabels: Record<string, string> = {
  get_outline: "读取故事大纲", update_outline: "更新故事大纲", get_chapter: "读取章节",
  save_chapter_draft: "保存章节草稿", search_bible: "查阅设定", update_bible_entry: "更新设定",
};

/** Tool events are activity evidence, not proof that the manuscript was saved. */
export function ChatMessageView({ message }: { message: ChatMessage }) {
  const marker = message.role === "user" ? message.text.lastIndexOf("\n\n【当前选中对象】\n") : -1;
  const text = marker < 0 ? message.text : message.text.slice(0, marker);
  return <article className={`msg ${message.role}${message.streaming ? " streaming" : ""}`} data-role={message.role}
    data-seq={typeof message.seq === "number" ? String(message.seq) : undefined} data-streaming={message.streaming ? "true" : "false"}>
    {message.role === "tool" ? <details className="tool-activity"><summary>{toolLabels[message.toolName ?? ""] ?? "创作操作"}<span>查看记录</span></summary><p className="small muted">这是执行记录；作品是否更新，请以文稿及版本为准。</p><div className="msg-meta">{message.toolName}</div><pre className="code">{message.text}</pre></details> : <>
      <div className="msg-meta"><span>{message.role === "user" ? "你" : message.role === "assistant" ? "Myrix" : "系统"}</span>{message.pending ? <span>已入队，等待服务端确认</span> : null}{message.streaming ? <span>正在生成 · 尚未确认</span> : null}{looksLikeHtml(text) ? <span>按纯文本显示（未解析 HTML）</span> : null}</div>
      {message.role === "assistant" ? <ReadingContent className="msg-text" text={text} /> : <div className="msg-text">{text}</div>}
      {marker >= 0 ? <details className="sent-context"><summary>本条消息的修改目标</summary><pre className="code">{message.text.slice(marker + 2)}</pre></details> : null}
    </>}
  </article>;
}
