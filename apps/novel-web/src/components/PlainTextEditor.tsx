import { Placeholder } from "@tiptap/extensions";
import { EditorContent, type JSONContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef } from "react";

/** 段落之间用单个换行对应，保证纯文本 ↔ 文档结构一一可逆。 */
export const BLOCK_SEPARATOR = "\n";

/**
 * 纯文本 → Tiptap JSON 文档。
 *
 * 刻意**不生成 HTML 字符串**：直接构造 JSON 文本节点，既避免任何 HTML 解析，
 * 也避免 HTML 的空白折叠（连续空格、行首行尾空格）导致内容被悄悄改写。
 */
export function toPlainTextDocument(text: string): JSONContent {
  const lines = text.split("\n");
  return {
    type: "doc",
    content: lines.map((line) =>
      line.length === 0
        ? { type: "paragraph" }
        : { type: "paragraph", content: [{ type: "text", text: line }] },
    ),
  };
}

export interface PlainTextEditorProps {
  /** 纯文本内容（业务存储格式）。 */
  value: string;
  onChange: (text: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  ariaLabel: string;
}

/**
 * Tiptap 编辑器，但业务数据始终是**纯文本**：
 *
 * - 载入时构造 JSON 文档（不经 HTML 解析），换行与空格原样保留；
 * - 导出时用 `editor.getText({ blockSeparator: "\n" })`，与载入互逆；
 * - 模型返回的任何标签都只是普通字符，不存在被解析成标记或脚本的路径。
 */
export function PlainTextEditor({
  value,
  onChange,
  placeholder,
  readOnly = false,
  ariaLabel,
}: PlainTextEditorProps) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const applyingExternalRef = useRef(false);
  /**
   * 最近一次已知的文本（外部写入或已上报给父组件的值）。
   * Tiptap 在建立文档时会补发一次 update 事件，内容与初始值相同；
   * 若不忽略，父组件会收到一次“假编辑”，可能把未保存状态标错。
   */
  const seenTextRef = useRef(value);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // 业务存储是纯文本，所有格式（标记、标题、列表、链接）在保存后都会丢失。
        // 与其让用户做完排版再静默丢掉，不如根本不提供这些能力：
        // 编辑器里看到的就是将要保存的纯文本。
        blockquote: false,
        bold: false,
        bulletList: false,
        code: false,
        codeBlock: false,
        dropcursor: false,
        gapcursor: false,
        hardBreak: false,
        heading: false,
        horizontalRule: false,
        italic: false,
        link: false,
        listItem: false,
        listKeymap: false,
        orderedList: false,
        strike: false,
        trailingNode: false,
        underline: false,
      }),
      Placeholder.configure({ placeholder: placeholder ?? "" }),
    ],
    content: toPlainTextDocument(value),
    editable: !readOnly,
    onUpdate: ({ editor: instance }) => {
      if (applyingExternalRef.current) return;
      const text = instance.getText({ blockSeparator: BLOCK_SEPARATOR });
      if (text === seenTextRef.current) return;
      seenTextRef.current = text;
      onChangeRef.current(text);
    },
  });

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!readOnly);
  }, [editor, readOnly]);

  useEffect(() => {
    if (!editor) return;
    // 只有在没有本地编辑（编辑器内容与业务值已一致）时才允许外部写回；
    // 否则用户正在输入的内容会被重新渲染/覆盖。
    if (editor.isFocused) return;
    const current = editor.getText({ blockSeparator: BLOCK_SEPARATOR });
    if (current === value) return;
    // 外部内容变化（重新读取/切换对象/冲突后采用服务端版本）才写回编辑器。
    applyingExternalRef.current = true;
    editor.commands.setContent(toPlainTextDocument(value), { emitUpdate: false });
    applyingExternalRef.current = false;
    seenTextRef.current = value;
  }, [editor, value]);

  return (
    <div className="editor">
      <EditorContent
        editor={editor}
        className="editor-surface"
        aria-label={ariaLabel}
        data-testid="tiptap-editor"
      />
    </div>
  );
}
