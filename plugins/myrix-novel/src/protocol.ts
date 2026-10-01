export const NOVEL_TOOLS = ["get_outline", "update_outline", "get_chapter", "save_chapter_draft", "search_bible", "update_bible_entry"] as const;
export type NovelToolName = typeof NOVEL_TOOLS[number];
export const PRESET_TOOLS = {
  "novel-outline": ["get_outline", "update_outline", "search_bible"],
  "novel-chapter": ["get_outline", "get_chapter", "save_chapter_draft", "search_bible"],
  "novel-bible": ["get_outline", "get_chapter", "search_bible", "update_bible_entry"],
} as const satisfies Record<string, readonly NovelToolName[]>;

export interface ToolArguments {
  chapterId?: string;
  entryId?: string;
  query?: string;
  text?: string;
  expectedVersion?: number;
}
const fields: Record<NovelToolName, readonly (keyof ToolArguments)[]> = {
  get_outline: [], update_outline: ["text", "expectedVersion"], get_chapter: ["chapterId"],
  save_chapter_draft: ["chapterId", "text", "expectedVersion"], search_bible: ["query"],
  update_bible_entry: ["entryId", "text", "expectedVersion"],
};
export function isNovelTool(value: string): value is NovelToolName { return NOVEL_TOOLS.some(name => name === value); }
export function parseToolArguments(name: NovelToolName, raw: unknown): ToolArguments {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("工具参数必须为对象");
  const allowed = fields[name];
  if (Object.keys(raw).some(key => !allowed.some(field => field === key))) throw new Error("工具参数包含不允许的身份或额外字段");
  const values = raw as Record<string, unknown>;
  const result: ToolArguments = {};
  for (const field of allowed) {
    const value = values[field];
    if (field === "expectedVersion") {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("expectedVersion 必须为已读取的非负版本号");
      result.expectedVersion = value;
    } else if (field === "chapterId" || field === "entryId") {
      if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error(`${field} 格式无效`);
      result[field] = value;
    } else {
      const limit = field === "query" ? 1000 : 1_000_000;
      if (typeof value !== "string" || value.length > limit) throw new Error(`${field} 必须为长度不超过 ${limit} 的文本`);
      result[field] = value;
    }
  }
  return result;
}
const propertySchemas = {
  chapterId: { type: "string", description: "当前作品中已经存在的章节 ID" },
  entryId: { type: "string", description: "当前作品中已经存在的设定条目 ID" },
  query: { type: "string", maxLength: 1000, description: "角色、设定或时间线关键词；空串查询全部" },
  text: { type: "string", maxLength: 1_000_000, description: "完整新正文，不是局部 diff" },
  expectedVersion: { type: "integer", minimum: 0, description: "刚读取内容的版本；冲突时保留草稿并先重新读取，不得强制覆盖" },
};
export function toolParameters(name: NovelToolName): Record<string, unknown> {
  return { type: "object", properties: Object.fromEntries(fields[name].map(key => [key, propertySchemas[key]])), required: [...fields[name]], additionalProperties: false };
}
export const TOOL_DESCRIPTIONS: Record<NovelToolName, string> = {
  get_outline: "读取当前作品大纲及版本。大纲与设定是创作事实依据，不从聊天摘要推断不存在的事实。",
  update_outline: "按已读取版本保存当前作品完整大纲。冲突时不得覆盖他人更新；相同重试不会重复创建版本。",
  get_chapter: "读取当前作品指定章节的完整草稿、标题和版本。",
  save_chapter_draft: "按已读取版本保存当前作品指定章节完整草稿并生成新版本。保存成功才能向用户声称已保存；冲突时保留草稿。",
  search_bible: "检索当前作品角色、设定和时间线，返回事实正文及条目版本。查询空字符串可列出设定。",
  update_bible_entry: "按已读取版本更新当前作品既有设定条目的完整正文。先查证已有事实，不要凭空改变人物或时间线。",
};
