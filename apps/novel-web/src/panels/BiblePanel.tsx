import type { BibleEntry, BibleKind } from "@myrix/contracts";
import { useState } from "react";

import { Banner, EmptyHint } from "../components/common";
import type { DraftEditor } from "../state/useDraft";
import { formatTime } from "./format";

export const KIND_LABELS: Record<BibleKind, string> = {
  character: "人物",
  setting: "设定",
  timeline: "时间线",
};

export interface BiblePanelProps {
  query: string;
  onQueryChange: (query: string) => void;
  items: BibleEntry[];
  isLoading: boolean;
  error: string | null;
  selectedEntryId: string | null;
  onSelect: (entryId: string) => void;
  onCreate: (input: { kind: BibleKind; title: string; text: string }) => void;
  createPending: boolean;
  createError: string | null;
  onReload: () => void;
  editor: DraftEditor<BibleEntry> | null;
  selectedEntry: BibleEntry | null;
}

export function BiblePanel({
  query,
  onQueryChange,
  items,
  isLoading,
  error,
  selectedEntryId,
  onSelect,
  onCreate,
  createPending,
  createError,
  onReload,
  editor,
  selectedEntry,
}: BiblePanelProps) {
  const [kind, setKind] = useState<BibleKind>("character");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");

  // 正在编辑的条目：即使当前检索词把它从结果里过滤掉，也不要让编辑器消失，
  // 否则用户会以为草稿丢了（草稿仍在，只是列表不再包含它）。
  const editingEntry = selectedEntry ?? editor?.draft?.base ?? null;

  // 409 只带来版本号。冲突后 `draft.server` 可能仍是旧基线快照，用它“采用服务端内容”
  // 会取到旧内容，用它“以最新版本提交”又会拿旧版本再撞一次 409。只有读到不低于
  // conflict.serverVersion 的快照（版本更高也算）才允许这两个会改变本地草稿的操作。
  const serverSnapshot = editor?.draft?.server ?? null;
  const hasFreshServer =
    serverSnapshot !== null && editor?.conflict != null && serverSnapshot.version >= editor.conflict.serverVersion;
  const staleServerHint = editor?.conflict
    ? serverSnapshot
      ? `当前服务端快照为版本 ${serverSnapshot.version}，低于冲突报告的版本 ${editor.conflict.serverVersion}。`
      : `尚未读取到服务端版本 ${editor.conflict.serverVersion} 的内容。`
    : "";

  return (
    <div className="stack">
      <div className="row">
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="检索人物 / 设定 / 时间线"
          aria-label="检索设定"
        />
        <button type="button" onClick={onReload} disabled={isLoading}>
          {isLoading ? "检索中…" : "刷新"}
        </button>
      </div>
      {error ? (
        <Banner level="error" actions={<button type="button" onClick={onReload}>重试</button>}>
          {error}
        </Banner>
      ) : null}
      {createError ? <Banner level="error">{createError}</Banner> : null}

      <ul className="list">
        {items.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              className="item"
              aria-current={entry.id === selectedEntryId}
              onClick={() => onSelect(entry.id)}
            >
              {entry.title}
              <span className="item-sub">
                {KIND_LABELS[entry.kind]} · 版本 {entry.version} · {formatTime(entry.updatedAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {!isLoading && items.length === 0 ? <EmptyHint>没有匹配的设定条目。</EmptyHint> : null}

      {editingEntry && editor ? (
        <div className="stack">
          <h3 className="small">
            {editingEntry.title}（{KIND_LABELS[editingEntry.kind]}）· 已保存版本{" "}
            {editor.draft?.base?.version ?? 0}
          </h3>
          {selectedEntry ? null : (
            <Banner level="warn">
              当前检索结果不再包含该条目；本地草稿仍然保留，保存会照常进行。
            </Banner>
          )}
          <div className="field">
            <label htmlFor="bible-text">条目内容（纯文本）</label>
            <textarea
              id="bible-text"
              className="textarea"
              value={editor.draft?.text ?? ""}
              onChange={(event) => editor.setText(event.target.value)}
            />
          </div>
          {editor.serverAhead && !editor.conflict ? (
            <Banner level="warn">
              服务端已有更新的版本 {editor.draft?.server?.version}（本地基线为{" "}
              {editor.draft?.base?.version}）。保存会返回冲突，本地内容不会被覆盖。
            </Banner>
          ) : null}
          {editor.notice ? <Banner level="ok">{editor.notice}</Banner> : null}
          {editor.error ? <Banner level="error">{editor.error}</Banner> : null}
          {editor.conflict ? (
            <>
              <Banner
                level="warn"
                actions={
                  <>
                    <button type="button" onClick={() => void editor.reloadServer()}>
                      重新读取
                    </button>
                    <button type="button" onClick={editor.takeServer} disabled={!hasFreshServer}>
                      采用服务端内容
                    </button>
                    <button
                      type="button"
                      className="primary"
                      disabled={editor.saving || !hasFreshServer}
                      onClick={() => {
                        const version = editor.draft?.server?.version;
                        if (version !== undefined) void editor.save(version);
                      }}
                    >
                      以最新版本提交本地草稿
                    </button>
                  </>
                }
              >
                版本冲突：本地草稿基于版本 {editor.conflict.expectedVersion}，服务端为{" "}
                {editor.conflict.serverVersion}；本地内容已保留，未被覆盖。
              </Banner>
              {hasFreshServer ? null : (
                <Banner level="warn">
                  {staleServerHint}
                  请先点“重新读取”，读取到最新内容后再选择采用服务端内容或重新提交；本地草稿会一直保留。
                </Banner>
              )}
            </>
          ) : null}
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={!editor.dirty || editor.saving}
              onClick={() => void editor.save()}
            >
              {editor.saving ? "保存中…" : "保存条目"}
            </button>
            <span className="small muted">最后更新：{formatTime(editingEntry.updatedAt)}</span>
          </div>
        </div>
      ) : (
        <EmptyHint>选择一个条目进行编辑。</EmptyHint>
      )}

      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (title.trim().length === 0) return;
          onCreate({ kind, title: title.trim(), text });
          setTitle("");
          setText("");
        }}
      >
        <h3 className="small">新增条目</h3>
        <div className="row">
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as BibleKind)}
            aria-label="条目类型"
          >
            <option value="character">人物</option>
            <option value="setting">设定</option>
            <option value="timeline">时间线</option>
          </select>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="名称"
            aria-label="条目名称"
          />
        </div>
        <textarea
          className="textarea"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="内容（纯文本）"
          aria-label="新条目内容"
        />
        <button type="submit" disabled={createPending || title.trim().length === 0}>
          {createPending ? "新增中…" : "新增条目"}
        </button>
      </form>
    </div>
  );
}
