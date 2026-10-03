import type { Outline } from "@myrix/contracts";

import { Banner, EmptyHint } from "../components/common";
import { ConflictBanner } from "../components/ConflictBanner";
import { PlainTextEditor } from "../components/PlainTextEditor";
import type { DraftEditor } from "../state/useDraft";
import { formatTime } from "./format";

export interface OutlinePanelProps {
  workId: string;
  outline: Outline | null;
  isLoading: boolean;
  loadError: string | null;
  editor: DraftEditor<Outline>;
  onReload: () => void;
}

/** 大纲编辑：纯文本 + 显式 expectedVersion 保存，冲突时保留本地草稿。 */
export function OutlinePanel({ outline, isLoading, loadError, editor, onReload }: OutlinePanelProps) {
  if (isLoading) return <EmptyHint>正在读取大纲…</EmptyHint>;
  if (loadError) {
    return (
      <Banner level="error" actions={<button type="button" onClick={onReload}>重试</button>}>
        {loadError}
      </Banner>
    );
  }
  if (!outline || !editor.draft) return <EmptyHint>尚未载入大纲。</EmptyHint>;

  return (
    <div className="editor">
      <div className="toolbar">
        <span className="small muted">
          故事大纲 · 已保存版本 {editor.draft.base?.version ?? 0}
          {editor.dirty ? " · 有未保存修改" : " · 无未保存修改"}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="primary"
          disabled={editor.saving || !editor.dirty}
          onClick={() => void editor.save()}
        >
          {editor.saving ? "保存中…" : "保存"}
        </button>
      </div>

      {editor.notice ? (
        <Banner level="ok" actions={<button type="button" onClick={editor.dismissNotice}>知道了</button>}>
          {editor.notice}
        </Banner>
      ) : null}
      {editor.error ? (
        <Banner level="error" actions={<button type="button" onClick={editor.clearError}>关闭</button>}>
          {editor.error}
        </Banner>
      ) : null}
      {editor.serverAhead && !editor.conflict ? (
        <Banner level="warn">
          服务端已有更新的版本 {editor.draft.server?.version}（本地基线为 {editor.draft.base?.version}）。
          保存会返回冲突，本地内容不会被覆盖。
        </Banner>
      ) : null}
      {editor.conflict ? (
        <ConflictBanner
          conflict={editor.conflict}
          serverText={editor.draft.server?.text ?? null}
          serverVersion={editor.draft.server?.version ?? null}
          reloading={isLoading}
          saving={editor.saving}
          onReload={() => {
            onReload();
            void editor.reloadServer();
          }}
          onTakeServer={editor.takeServer}
          onSaveOverwrite={() => {
            const version = editor.draft?.server?.version;
            if (version !== undefined) void editor.save(version);
          }}
        />
      ) : null}

      <PlainTextEditor
        value={editor.draft.text}
        onChange={editor.setText}
        placeholder="在这里写故事大纲。纯文本保存，不使用富文本标记。"
        ariaLabel="作品大纲"
      />
      <div className="toolbar small muted" style={{ borderTop: "1px solid var(--border)", borderBottom: "none" }}>
        最后更新：{formatTime(outline.updatedAt)}
      </div>
    </div>
  );
}
