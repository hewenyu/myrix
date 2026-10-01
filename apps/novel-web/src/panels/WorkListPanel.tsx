import type { Work } from "@myrix/contracts";
import { useState } from "react";

import { Banner, EmptyHint } from "../components/common";

export interface WorkListPanelProps {
  works: Work[];
  isLoading: boolean;
  error: string | null;
  selectedWorkId: string | null;
  onSelect: (workId: string) => void;
  onCreate: (input: { title: string; description: string }) => void;
  createPending: boolean;
  createError: string | null;
  onDelete: (workId: string) => void;
  deletePending: boolean;
  onReload: () => void;
}

/** 左栏：作品列表与创建。删除需二次确认，避免误删业务数据。 */
export function WorkListPanel({
  works,
  isLoading,
  error,
  selectedWorkId,
  onSelect,
  onCreate,
  createPending,
  createError,
  onDelete,
  deletePending,
  onReload,
}: WorkListPanelProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  return (
    <section className="pane" aria-label="作品列表">
      <header className="pane-header">
        <span>作品</span>
        <span className="spacer" />
        <button type="button" onClick={onReload} disabled={isLoading} title="重新读取作品列表">
          {isLoading ? "读取中…" : "刷新"}
        </button>
      </header>
      <div className="pane-body stack">
        {error ? (
          <Banner level="error" actions={<button type="button" onClick={onReload}>重试</button>}>
            {error}
          </Banner>
        ) : null}

        <ul className="list">
          {works.map((work) => (
            <li key={work.id}>
              <button
                type="button"
                className="item"
                aria-current={work.id === selectedWorkId}
                onClick={() => onSelect(work.id)}
              >
                {work.title}
                <span className="item-sub">
                  {work.description.length > 0 ? work.description : "无简介"} · 更新于{" "}
                  {formatTime(work.updatedAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {!isLoading && works.length === 0 && !error ? <EmptyHint>还没有作品，请在下方创建。</EmptyHint> : null}

        {selectedWorkId && confirmingDelete === selectedWorkId ? (
          <Banner
            level="warn"
            actions={
              <>
                <button
                  type="button"
                  className="danger"
                  disabled={deletePending}
                  onClick={() => {
                    onDelete(selectedWorkId);
                    setConfirmingDelete(null);
                  }}
                >
                  {deletePending ? "删除中…" : "确认删除"}
                </button>
                <button type="button" onClick={() => setConfirmingDelete(null)}>
                  取消
                </button>
              </>
            }
          >
            删除作品会先撤销其所有会话，并删除大纲、章节与设定数据。该操作不可撤销。
          </Banner>
        ) : (
          <button
            type="button"
            className="danger"
            disabled={!selectedWorkId}
            onClick={() => selectedWorkId && setConfirmingDelete(selectedWorkId)}
          >
            删除当前作品
          </button>
        )}

        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (title.trim().length === 0) return;
            onCreate({ title: title.trim(), description: description.trim() });
            setTitle("");
            setDescription("");
          }}
        >
          <h3 className="small">新建作品</h3>
          <div className="field">
            <label htmlFor="work-title">标题</label>
            <input
              id="work-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="例如：长夜将尽"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="work-desc">简介</label>
            <input
              id="work-desc"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="一句话简介"
            />
          </div>
          {createError ? <Banner level="error">{createError}</Banner> : null}
          <button type="submit" className="primary" disabled={createPending || title.trim().length === 0}>
            {createPending ? "创建中…" : "创建作品"}
          </button>
        </form>
      </div>
    </section>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", { hour12: false });
}
