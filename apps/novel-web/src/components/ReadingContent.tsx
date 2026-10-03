import { Children, Fragment, memo, type ComponentPropsWithoutRef, type JSX, type ReactNode } from "react";
import Markdown, { type Components, type ExtraProps, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * 只读的 Markdown 阅读视图：把作者/模型的 Markdown 渲染成排版，而不是源文。
 *
 * 安全边界（fail-closed，全部在渲染层收口）：
 * - 不引入 `rehype-raw`，也不使用 `dangerouslySetInnerHTML`，因此不存在 HTML 解析/执行路径；
 * - 原始 HTML 节点在 remark 阶段被改写成**普通文本节点**，作者仍能看到原文，但只是文字；
 * - 链接只放行 `http(s)://`、`mailto:` 与 `#锚点`；协议相对（`//host`）、相对路径、`javascript:`、
 *   `data:`、`file:` 等一律降级为不可点击的纯文本；
 * - 外链补 `target="_blank"` 与 `rel="noopener noreferrer"`；`#锚点` 与 `mailto:` 保持本页/本应用行为；
 * - 图片一律替换为可访问的文字占位，绝不输出 `<img src>`，避免阅读时自动请求远程资源造成外泄；
 * - 组件不写内联样式，排版由宿主针对 `reading-content` 的全局 CSS 提供。
 */

/** 根容器 class：宿主全局样式与测试的统一锚点。 */
const ROOT_CLASS = "reading-content";
/** 表格横滚外层 class：窄屏下由 CSS 提供 `overflow-x: auto`。 */
const TABLE_SCROLL_CLASS = "reading-content-table-scroll";
/** 远程图片文字占位 class。 */
const IMAGE_PLACEHOLDER_CLASS = "reading-content-image-placeholder";
/** 被拒绝链接降级后的纯文本 class。 */
const REJECTED_LINK_CLASS = "reading-content-link-rejected";

const IMAGE_FALLBACK_LABEL = "图片";

type MarkdownElementProps<Tag extends keyof JSX.IntrinsicElements> = ComponentPropsWithoutRef<Tag> &
  ExtraProps;

interface SafeLink {
  kind: "web" | "mailto" | "anchor";
  href: string;
}

/** 控制字符与空白：出现在链接目标里就一律拒绝（可挡住 `java\tscript:` 之类的混淆）。 */
const DISALLOWED_IN_URL = /[\s\p{Cc}]/u;
/** 必须带协议与主机名，挡掉 `http:javascript:...` 这类非 URL。 */
const SAFE_WEB_URL = /^https?:\/\/[^\s]+$/i;
const SAFE_MAILTO_URL = /^mailto:[^\s]+$/i;

/**
 * 把链接目标收敛到允许集合：
 * 允许 `http(s)://…`、`mailto:…`、`#…`；其余（相对路径、协议相对、危险 scheme、空值）返回 null。
 */
function normalizeSafeLink(raw: string | null | undefined): SafeLink | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length === 0) return null;
  if (DISALLOWED_IN_URL.test(value)) return null;
  if (value.startsWith("#")) return { kind: "anchor", href: value };
  if (value.startsWith("//")) return null;
  if (SAFE_WEB_URL.test(value)) return { kind: "web", href: value };
  if (SAFE_MAILTO_URL.test(value)) return { kind: "mailto", href: value };
  return null;
}

/** 纵深防御：即使组件映射将来被改动，非白名单 URL 也不会以属性形式落到 DOM。 */
const safeUrlTransform: NonNullable<Options["urlTransform"]> = (url) =>
  normalizeSafeLink(url) === null ? "" : url;

function MarkdownLink({ href, title, children }: MarkdownElementProps<"a">) {
  const target = normalizeSafeLink(href);
  if (target === null) {
    // 拒绝即降级：只保留可读文字，不生成任何可导航元素。
    return <span className={REJECTED_LINK_CLASS}>{children}</span>;
  }
  if (target.kind === "web") {
    return (
      <a href={target.href} title={title} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }
  return (
    <a href={target.href} title={title}>
      {children}
    </a>
  );
}

/**
 * 图片一律不加载：渲染成带无障碍名称的文字占位。
 * 远程 `src` 既不进入 DOM，也不进入任何请求。
 */
function MarkdownImage({ alt, title }: MarkdownElementProps<"img">) {
  const label = typeof alt === "string" && alt.trim().length > 0 ? alt.trim() : IMAGE_FALLBACK_LABEL;
  const visible = label === IMAGE_FALLBACK_LABEL ? "[图片]" : `[图片：${label}]`;
  return (
    <span
      className={IMAGE_PLACEHOLDER_CLASS}
      role="img"
      aria-label={label}
      title={typeof title === "string" && title.length > 0 ? title : undefined}
    >
      {visible}
    </span>
  );
}

/** 表格放进可聚焦的横滚容器，窄屏阅读时不会撑破版面。 */
function MarkdownTable({ children }: MarkdownElementProps<"table">) {
  return (
    <div className={TABLE_SCROLL_CLASS} role="region" aria-label="表格" tabIndex={0}>
      <table>{children}</table>
    </div>
  );
}

/**
 * 把文本里真正的换行渲染成 `<br>`：Markdown 的软换行在正文里只是 `\n`，
 * 中文小说按行书写时若折叠成空格会丢段落节奏。
 */
function withLineBreaks(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child !== "string" || !child.includes("\n")) return child;
    const lines = child.split("\n");
    return lines.map((line, index) => (
      <Fragment key={index}>
        {index > 0 ? <br /> : null}
        {line}
      </Fragment>
    ));
  });
}

function MarkdownParagraph({ children }: MarkdownElementProps<"p">) {
  return <p>{withLineBreaks(children)}</p>;
}

function MarkdownListItem({ children, className }: MarkdownElementProps<"li">) {
  // 保留 GFM 任务列表等由 react-markdown 附加的 class。
  return <li className={className}>{withLineBreaks(children)}</li>;
}

const COMPONENTS: Components = {
  a: MarkdownLink,
  img: MarkdownImage,
  li: MarkdownListItem,
  p: MarkdownParagraph,
  table: MarkdownTable,
};

/** 块级容器：其中的原始 HTML 需要包成段落；其余位置（行内）直接当文本。 */
const BLOCK_CONTAINERS = new Set([
  "root",
  "blockquote",
  "list",
  "listItem",
  "footnoteDefinition",
  "table",
  "tableHead",
  "tableBody",
  "tableRow",
]);

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
}

function htmlToTextNode(parentType: string, literal: string): MarkdownNode {
  if (BLOCK_CONTAINERS.has(parentType)) {
    return { type: "paragraph", children: [{ type: "text", value: literal }] };
  }
  return { type: "text", value: literal };
}

function rewriteHtmlNodes(node: MarkdownNode): void {
  const children = node.children;
  if (children === undefined || children.length === 0) return;
  node.children = children.map((child) => {
    if (child.type === "html") {
      // react-markdown 默认会**丢弃**原始 HTML（既不执行也不显示）；
      // 改写为文本节点后，作者能看到 `<div>` 原文，但不存在被解析成标记的路径。
      return htmlToTextNode(node.type, child.value ?? "");
    }
    rewriteHtmlNodes(child);
    return child;
  });
}

/** remark 插件：原始 HTML → 可见文本。纯函数式遍历，不依赖任何额外包。 */
function remarkHtmlAsText() {
  return (tree: MarkdownNode): void => {
    rewriteHtmlNodes(tree);
  };
}

const REMARK_PLUGINS: NonNullable<Options["remarkPlugins"]> = [remarkGfm, remarkHtmlAsText];

/**
 * 正文文本未变时不重复解析：阅读区常因选中态、滚动等无关状态重渲染，
 * 而 Markdown 解析对整章正文并不便宜。props 与所有插件/组件映射都是稳定常量。
 */
const MemoMarkdown = memo(Markdown);

export interface ReadingContentProps {
  /** Markdown 源文（作者正文或模型输出）。 */
  text: string;
  /** 追加到根容器的 class，便于宿主在特定上下文覆盖排版。 */
  className?: string;
}

/**
 * 只读 Markdown 阅读组件。公开接口只有 `text` 与可选 `className`。
 */
export function ReadingContent({ text, className }: ReadingContentProps) {
  const extra = typeof className === "string" ? className.trim() : "";
  const rootClassName = extra.length > 0 ? `${ROOT_CLASS} ${extra}` : ROOT_CLASS;
  return (
    <div className={rootClassName}>
      <MemoMarkdown
        remarkPlugins={REMARK_PLUGINS}
        components={COMPONENTS}
        urlTransform={safeUrlTransform}
      >
        {typeof text === "string" ? text : ""}
      </MemoMarkdown>
    </div>
  );
}
