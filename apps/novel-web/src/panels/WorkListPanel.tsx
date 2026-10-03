import type { Work } from "@myrix/contracts";
import { useState } from "react";

import { Banner } from "../components/common";
import { Icon } from "../components/Icon";
import { Modal } from "../components/Modal";
import { formatTime } from "./format";

export interface WorkListPanelProps {
  works: Work[];
  isLoading: boolean;
  error: string | null;
  selectedWorkId: string | null;
  onSelect: (workId: string) => void;
  onCreate: (input: { title: string; description: string }) => void | Promise<unknown>;
  createPending: boolean;
  createError: string | null;
  onDelete: (workId: string) => void;
  deletePending: boolean;
  onReload: () => void;
}

/** 登录后的唯一入口：书架。创建与危险操作按需展开，不占据创作空间。 */
export function WorkListPanel({ works, isLoading, error, onSelect, onCreate, createPending, createError, onDelete, deletePending, onReload }: WorkListPanelProps) {
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [query, setQuery] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const filtered = works.filter((work) => `${work.title} ${work.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  return <main className="bookshelf" aria-label="我的书架">
    <div className="shelf-heading">
      <div><p className="eyebrow">你的故事，从这里开始</p><h1>我的书架<span className="shelf-count">{works.length}</span></h1><p className="muted">拾起一个故事，继续写下去。</p></div>
      <button className="primary shelf-create" type="button" onClick={() => setCreating(true)}><Icon name="plus" size={18} /> 新建书本</button>
    </div>
    <div className="shelf-tools">
      <span className="shelf-tab">全部书本</span><span className="spacer" />
      <label className="search-field"><Icon name="search" size={17} /><input aria-label="搜索书本" placeholder="搜索书名或简介" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <button className="text-button" type="button" onClick={onReload} disabled={isLoading}>刷新</button>
    </div>
    {error ? <Banner level="error" actions={<button type="button" onClick={onReload}>重试</button>}>{error}</Banner> : null}
    {isLoading ? <div className="shelf-empty" role="status">正在整理你的书架…</div> : null}
    {!isLoading && !error && works.length === 0 ? <div className="shelf-empty"><div className="empty-art"><Icon name="book" size={42} /></div><h2>每个故事，都始于一个想法</h2><p className="muted">给你的第一本书起个名字。情节、人物和下一句话，我们一起慢慢写。</p><button className="primary" type="button" onClick={() => setCreating(true)}>创建第一本书</button></div> : null}
    {!isLoading && works.length > 0 && filtered.length === 0 ? <p className="shelf-empty">没有找到这本书，试试其他关键词。</p> : null}
    <div className="book-grid">
      {filtered.map((work, index) => <article className="book-card" key={work.id}>
        <button type="button" className={`book-cover cover-${index % 5}`} onClick={() => onSelect(work.id)} aria-label={`打开书本：${work.title}`}>
          <span className="cover-top">MYRIX · 原创作品</span><span className="cover-title">{work.title}</span><span className="cover-rule" /><span className="cover-bottom"><Icon name="book" size={20} />继续创作 <span aria-hidden="true">↗</span></span>
        </button>
        <div className="book-info"><h2>{work.title}</h2><p>{work.description || "故事还在生长，下一页由你书写。"}</p><div className="book-meta"><span>更新于 {formatTime(work.updatedAt)}</span><details className="book-menu"><summary aria-label={`管理书本：${work.title}`}><Icon name="more" size={18} /></summary><button type="button" className="danger" onClick={() => setConfirmingDelete(work.id)}>删除书本</button></details></div></div>
      </article>)}
    </div>
    {creating ? <Modal labelledBy="create-book-title" onClose={() => { if (!createPending) setCreating(false); }}>
      <header className="row"><h2 id="create-book-title">开启一个新故事</h2><span className="spacer" /><button className="icon-button" type="button" aria-label="关闭新建书本" disabled={createPending} onClick={() => setCreating(false)}><Icon name="close" /></button></header>
      <p className="muted">先有一个名字就好，其他的可以边写边想。</p>
      <form className="stack" onSubmit={(event) => { event.preventDefault(); if (title.trim() && !createPending) void onCreate({ title: title.trim(), description: description.trim() }); }}>
        <label className="field">书名<input data-initial-focus value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} placeholder="例如：长夜将尽" required /></label>
        <label className="field">简介 <span className="muted small">选填</span><textarea rows={3} value={description} maxLength={2000} onChange={(event) => setDescription(event.target.value)} placeholder="一个人、一座城，或一个还没讲完的念头…" /></label>
        {createError ? <Banner level="error">{createError}</Banner> : null}
        <button className="primary" type="submit" disabled={!title.trim() || createPending}>{createPending ? "正在创建…" : "创建并开始写作"}</button>
      </form>
    </Modal> : null}
    {confirmingDelete ? <Modal alert labelledBy="delete-book-title" onClose={() => { if (!deletePending) setConfirmingDelete(null); }}><h2 id="delete-book-title">删除这本书？</h2><p>这会撤销所有关联对话，并删除大纲、章节与设定。无法撤销，请谨慎操作。</p><div className="row"><button type="button" onClick={() => setConfirmingDelete(null)}>保留书本</button><button className="danger" type="button" disabled={deletePending} onClick={() => { onDelete(confirmingDelete); setConfirmingDelete(null); }}>确认删除</button></div></Modal> : null}
  </main>;
}
