// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { PlainTextEditor } from "./PlainTextEditor";
import { ReadingContent } from "./ReadingContent";

/** Reading is presentation only: switching modes never serializes or rewrites text. */
export function Manuscript({ value, onChange, title, label, placeholder, dirty = false }: {
  value: string; onChange: (text: string) => void; title: string; label: string; placeholder: string; dirty?: boolean;
}) {
  const [editing, setEditing] = useState(!value.trim() || dirty);
  const count = Array.from(value.replace(/\s/g, "")).length;
  return <div className="manuscript">
    <div className="manuscript-mode">
      <div className="segmented" role="group" aria-label="文稿显示方式">
        <button type="button" aria-pressed={!editing} onClick={() => setEditing(false)}>阅读</button>
        <button type="button" aria-pressed={editing} onClick={() => setEditing(true)}>编辑原文</button>
      </div>
      <span className="small muted">{count.toLocaleString()} 字符{dirty ? " · 未保存草稿" : ""}</span>
    </div>
    <div className="manuscript-scroll" key={editing ? "edit" : "read"}>
      <header className="manuscript-heading"><h1>{title}</h1></header>
      {editing ? <><p className="editing-note">直接书写，或用 Markdown 排版；切换「阅读」查看效果。保存后才会更新作品。</p><PlainTextEditor value={value} onChange={onChange} placeholder={placeholder} ariaLabel={label} /></>
        : <article className="manuscript-reading" aria-label={`${label}阅读`}><ReadingContent text={value} />{!value.trim() ? <div className="document-empty"><h2>这一页，等你落笔</h2><p>{placeholder}</p><button type="button" className="primary" onClick={() => setEditing(true)}>开始写作</button></div> : null}</article>}
    </div>
  </div>;
}
