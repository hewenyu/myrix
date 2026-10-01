import { useEffect, useRef, useState } from "react";

/**
 * 章节助手的手动上下文入口：把“当前选中的章节是谁”变成一段用户可见、可复制的文本，
 * 由用户自己粘贴到同一作品的章节助手输入框。
 *
 * 边界（刻意为之）：
 * - 显式投影 `id/workId/title`，不序列化传入对象的其余属性；正文与凭证不会被带入上下文；
 * - 只调用 `navigator.clipboard.writeText`，不调用 `document.execCommand`、不发任何网络请求；
 * - 不自动发送消息、不改变任何授权状态，复制只是把文本放进系统剪贴板。
 */
export interface AssistantChapterRef {
  id: string;
  workId: string;
  title: string;
}

export interface ChapterAssistantContextProps {
  /** 当前选中的章节；只包含标识与标题，不包含正文。 */
  chapter: AssistantChapterRef;
  /** 编辑器里是否有未保存草稿。只影响提示文案，不会自动发送任何内容。 */
  dirty?: boolean;
}

type CopyStatus =
  | { kind: "idle" }
  | { kind: "ok"; chapterId: string; workId: string }
  | { kind: "error"; chapterId: string; workId: string; message: string };

/**
 * 写死给助手的指令：必须先读最新已保存内容与版本，再用读到的 expectedVersion 写回，
 * 避免助手拿过期版本覆盖用户刚保存的内容。
 */
const VERSION_INSTRUCTION =
  "先调用get_chapter读取当前已保存内容及版本，再按我的要求修改；写入使用刚读到的expectedVersion";

const MISSING_CLIPBOARD_HINT =
  "当前环境没有可用的剪贴板 API。请手动选中上方文本框中的全部上下文（点击文本框后按 Ctrl/Cmd+A），再按 Ctrl/Cmd+C 复制。";

const DENIED_CLIPBOARD_HINT =
  "浏览器拒绝了剪贴板写入（可能未授权）。请手动选中上方文本框中的全部上下文（点击文本框后按 Ctrl/Cmd+A），再按 Ctrl/Cmd+C 复制。";

/** 生成可复制的上下文文本。纯函数，便于在别处复用或断言，且永不包含正文。 */
export function buildChapterAssistantContext(chapter: AssistantChapterRef, dirty = false): string {
  return [
    "【章节助手上下文】",
    `作品ID：${chapter.workId}`,
    `章节ID：${chapter.id}`,
    `章节标题：${chapter.title}`,
    `未保存草稿：${dirty ? "有（不会自动发送；请先在编辑器保存，或由我另行提供草稿内容）" : "无"}`,
    "",
    "操作要求：",
    `- ${VERSION_INSTRUCTION}`,
    "- 只处理上面的作品与章节，不要改动其他章节。",
  ].join("\n");
}

export function ChapterAssistantContext({ chapter, dirty = false }: ChapterAssistantContextProps) {
  const { id, workId, title } = chapter;
  const [status, setStatus] = useState<CopyStatus>({ kind: "idle" });
  // 内容变化、组件卸载或再次复制都会作废旧请求；只有最新代际的结果能落地。
  const generationRef = useRef(0);
  const contextText = buildChapterAssistantContext({ id, workId, title }, dirty);

  useEffect(() => {
    generationRef.current += 1;
    setStatus((previous) => (previous.kind === "idle" ? previous : { kind: "idle" }));
    return () => { generationRef.current += 1; };
  }, [contextText]);

  async function handleCopy() {
    const generation = (generationRef.current += 1);
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== "function") {
      // 同步失败：身份没有变化，直接给出可手动复制的提示。
      setStatus({ kind: "error", chapterId: id, workId, message: MISSING_CLIPBOARD_HINT });
      return;
    }
    try {
      await clipboard.writeText(contextText);
    } catch {
      if (generationRef.current !== generation) {
        return;
      }
      setStatus({ kind: "error", chapterId: id, workId, message: DENIED_CLIPBOARD_HINT });
      return;
    }
    if (generationRef.current !== generation) {
      return;
    }
    setStatus({ kind: "ok", chapterId: id, workId });
  }

  // 结果只在“请求时的章节/作品仍是当前对象”时展示，双重保险。
  const visibleStatus =
    status.kind !== "idle" && status.chapterId === id && status.workId === workId ? status : null;

  return (
    <div className="stack">
      <div>
        <strong>章节助手上下文</strong>
        <div className="small muted" role="note">
          把这段上下文复制到同一作品的章节助手输入框后再发送；未保存草稿不会自动发送。
        </div>
      </div>
      <div className="small" role="group" aria-label="章节助手上下文详情">
        <div>作品ID：{workId}</div>
        <div>章节ID：{id}</div>
        <div>章节标题：{title}</div>
        <div>{dirty ? "未保存草稿：有（不会自动发送，请先在编辑器保存）" : "未保存草稿：无"}</div>
      </div>
      <textarea
        aria-label="章节助手上下文"
        className="textarea"
        rows={12}
        readOnly
        value={contextText}
      />
      <div className="row">
        <button type="button" onClick={handleCopy}>
          复制章节上下文
        </button>
      </div>
      {visibleStatus ? (
        <div className="small" role="status">
          {visibleStatus.kind === "ok" ? "已复制，请粘贴到同一作品的章节助手输入框。" : visibleStatus.message}
        </div>
      ) : null}
    </div>
  );
}
