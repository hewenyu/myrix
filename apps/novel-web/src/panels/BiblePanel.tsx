import type { BibleEntry, BibleKind } from "@myrix/contracts";
import { useState } from "react";

import { Banner, EmptyHint } from "../components/common";
import { Icon } from "../components/Icon";
import { Manuscript } from "../components/Manuscript";
import { ReadingContent } from "../components/ReadingContent";
import type { DraftEditor } from "../state/useDraft";
import { formatTime } from "./format";

export const KIND_LABELS: Record<BibleKind, string> = {
  character: "人物",
  setting: "设定",
  timeline: "时间线",
};

/** 目录里设定条目的分类顺序（与“人物 / 设定 / 时间线”一致）。 */
export const BIBLE_KINDS: BibleKind[] = ["character", "setting", "timeline"];

export interface BibleEditorProps {
  editor: DraftEditor<BibleEntry> | null;
  selectedEntry: BibleEntry | null;
  /** 条目快照仍在读取：仅在没有可编辑条目时用于显示加载态。 */
  isLoading: boolean;
  /** 条目快照读取失败：仅在没有可编辑条目时用于显示错误态。 */
  error: string | null;
  onReload: () => void;
}

/**
 * 中栏的设定条目编辑器：纯文本 + 显式 expectedVersion 保存。
 *
 * 目录（检索、按类列表、新增）已移至 BibleNav；这里只显示“当前选中的那一条”。
 * 冲突语义与拆分前完全一致：409 只带来版本号，只有读到不低于 conflict.serverVersion
 * 的快照才允许“采用服务端内容 / 以最新版本提交”，本地草稿始终保留。
 */
export function BibleEditor({ editor, selectedEntry, isLoading, error, onReload }: BibleEditorProps) {
  // 正在编辑的条目：即使当前检索词把它从结果里过滤掉，也不要让编辑器消失，
  // 否则用户会以为草稿丢了（草稿仍在，只是列表不再包含它）。
  const editingEntry = selectedEntry ?? editor?.draft?.base ?? null;

  if (!editingEntry && isLoading) return <EmptyHint>正在读取设定…</EmptyHint>;
  if (!editingEntry && error) {
    return (
      <Banner level="error" actions={<button type="button" onClick={onReload}>重试</button>}>
        {error}
      </Banner>
    );
  }
  if (!editingEntry || !editor) return <EmptyHint>选择一个条目进行编辑。</EmptyHint>;

  // 409 只带来版本号。冲突后 `draft.server` 可能仍是旧基线快照，用它“采用服务端内容”
  // 会取到旧内容，用它“以最新版本提交”又会拿旧版本再撞一次 409。只有读到不低于
  // conflict.serverVersion 的快照（版本更高也算）才允许这两个会改变本地草稿的操作。
  const serverSnapshot = editor.draft?.server ?? null;
  const hasFreshServer =
    serverSnapshot !== null && editor.conflict != null && serverSnapshot.version >= editor.conflict.serverVersion;
  const staleServerHint = editor.conflict
    ? serverSnapshot
      ? `当前服务端快照为版本 ${serverSnapshot.version}，低于冲突报告的版本 ${editor.conflict.serverVersion}。`
      : `尚未读取到服务端版本 ${editor.conflict.serverVersion} 的内容。`
    : "";

  return (
    <div className="editor">
      <div className="toolbar">
        <h3 className="small">
          {editingEntry.title}（{KIND_LABELS[editingEntry.kind]}）· 已保存版本{" "}
          {editor.draft?.base?.version ?? 0}
        </h3>
        <span className="spacer" />
        <button
          type="button"
          className="primary"
          disabled={!editor.dirty || editor.saving}
          onClick={() => void editor.save()}
        >
          {editor.saving ? "保存中…" : "保存条目"}
        </button>
      </div>

      {selectedEntry ? null : (
        <Banner level="warn">
          当前检索结果不再包含该条目；本地草稿仍然保留，保存会照常进行。
        </Banner>
      )}
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

      {editor.conflict && hasFreshServer ? <details className="conflict-comparison" open><summary>对比本地草稿与已保存版本</summary><div className="comparison-grid"><section><h3>本地草稿（未保存）</h3><ReadingContent text={editor.draft?.text ?? ""} /></section><section><h3>服务端版本 {serverSnapshot.version}</h3><ReadingContent text={serverSnapshot.text} /></section></div></details> : null}
      <Manuscript key={editingEntry.id} title={editingEntry.title} label="条目内容（纯文本）" dirty={editor.dirty}
        value={editor.draft?.text ?? ""} onChange={editor.setText} placeholder="写下人物、世界规则或故事时间线，让每一章都有据可循。" />
      <div className="toolbar small muted" style={{ borderTop: "1px solid var(--border)", borderBottom: "none" }}>
        最后更新：{formatTime(editingEntry.updatedAt)}
      </div>
    </div>
  );
}

export interface BibleNavProps {
  query: string;
  onQueryChange: (query: string) => void;
  items: BibleEntry[];
  isLoading: boolean;
  error: string | null;
  selectedEntryId: string | null;
  /** 有未保存草稿的条目。 */
  dirtyEntryId: string | null;
  /** 正在保存的条目。 */
  savingEntryId: string | null;
  onSelect: (entryId: string) => void;
  onCreate: (input: { kind: BibleKind; title: string; text: string }) => void;
  createPending: boolean;
  createError: string | null;
  onReload: () => void;
}

function bibleSubtitle(
  entry: BibleEntry,
  dirtyEntryId: string | null,
  savingEntryId: string | null,
): string {
  if (entry.id === savingEntryId) return "保存中…";
  if (entry.id === dirtyEntryId) return "有未保存修改";
  return "";
}

/**
 * 左侧目录里的设定区：检索 + 按人物/设定/时间线分类列出 + **收起的新增**。
 *
 * 新增表单默认收起（220px 目录里不占用正文空间），点“新增条目”才展开；
 * 展开后按钮只剩提交那一颗，因此同名选择器在两种状态下都只命中唯一的按钮。
 */
export function BibleNav({
  query,
  onQueryChange,
  items,
  isLoading,
  error,
  selectedEntryId,
  dirtyEntryId,
  savingEntryId,
  onSelect,
  onCreate,
  createPending,
  createError,
  onReload,
}: BibleNavProps) {
  const [kind, setKind] = useState<BibleKind>("character");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [creating, setCreating] = useState(false);

  return (
    <div className="stack nav-section" aria-label="设定目录">
      <div className="row">
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="检索人物 / 设定 / 时间线"
          aria-label="检索设定"
        />
        <button type="button" onClick={onReload} disabled={isLoading} title="重新读取设定条目">
          {isLoading ? "检索中…" : "刷新"}
        </button>
      </div>
      {error ? (
        <Banner level="error" actions={<button type="button" onClick={onReload}>重试</button>}>
          {error}
        </Banner>
      ) : null}
      {isLoading ? <EmptyHint>正在检索设定…</EmptyHint> : null}
      {!isLoading && items.length === 0 ? <EmptyHint>没有匹配的设定条目。</EmptyHint> : null}

      {BIBLE_KINDS.map((groupKind) => {
        const entries = items.filter((entry) => entry.kind === groupKind);
        if (entries.length === 0) return null;
        return (
          <div className="nav-subgroup" key={groupKind}>
            <div className="nav-subgroup-title small muted">
              {KIND_LABELS[groupKind]}（{entries.length}）
            </div>
            <ul className="list nav-list">
              {entries.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    className="item"
                    aria-current={entry.id === selectedEntryId}
                    onClick={() => onSelect(entry.id)}
                  >
                    {entry.title}
                    <span className="item-sub">
                      {bibleSubtitle(entry, dirtyEntryId, savingEntryId)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}

      {creating ? (
        <form
          className="stack nav-create"
          aria-label="新增设定条目表单"
          onSubmit={(event) => {
            event.preventDefault();
            const next = title.trim();
            if (next.length === 0) return;
            onCreate({ kind, title: next, text });
            setTitle("");
            setText("");
          }}
        >
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
            className="nav-create-text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="内容（纯文本）"
            aria-label="新条目内容"
          />
          <div className="row">
            <button type="submit" className="primary" disabled={createPending || title.trim().length === 0}>
              {createPending ? "新增中…" : "新增条目"}
            </button>
            <button type="button" onClick={() => setCreating(false)}>
              收起
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="nav-create-toggle" onClick={() => setCreating(true)}>
          <Icon name="plus" size={14} /> 新增条目
        </button>
      )}
      {createError ? <Banner level="error">{createError}</Banner> : null}
    </div>
  );
}
