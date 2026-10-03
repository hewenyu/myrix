// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0
// Extracted unchanged from the runtime plugin to keep service installs DSH-free.
export const NOVEL_TOOLS = ["get_outline", "update_outline", "get_chapter", "save_chapter_draft", "search_bible", "update_bible_entry"] as const;
export type NovelToolName = typeof NOVEL_TOOLS[number];

/**
 * 统一创作助手 ID（唯一"全工具"preset，BFF 与 Cell 的默认值）。
 * 用户的"不需要选 preset"由服务端默认值表达，浏览器仍可显式指定历史 preset。
 */
export const NOVEL_ASSISTANT_PRESET = "novel-assistant";

/** 历史三 preset：各自只做一类创作任务，掩码必须保持收窄（不得扩大）。 */
export const LEGACY_NOVEL_PRESETS = ["novel-outline", "novel-chapter", "novel-bible"] as const;

/**
 * preset → 工具掩码。**这是唯一的真相来源**：
 *   * `novel-assistant` = 现有六个工具全集（一个助手在自然对话中自行判断
 *     大纲/正文/设定任务），不新增任何通用工具；
 *   * 三个历史 preset 保持原掩码逐字不变 —— 历史会话重放时其中任何一个都
 *     拿不到超出原有范围的工具（掩码只收窄，不扩大）。
 */
export const PRESET_TOOLS = {
  "novel-assistant": NOVEL_TOOLS,
  "novel-outline": ["get_outline", "update_outline", "search_bible"],
  "novel-chapter": ["get_outline", "get_chapter", "save_chapter_draft", "search_bible"],
  "novel-bible": ["get_outline", "get_chapter", "search_bible", "update_bible_entry"],
} as const satisfies Record<string, readonly NovelToolName[]>;

/** 全部已登记 preset ID（统一助手在前，历史 preset 顺序不变）。 */
export const PRESET_IDS = [NOVEL_ASSISTANT_PRESET, ...LEGACY_NOVEL_PRESETS] as const;
export type NovelPresetId = typeof PRESET_IDS[number];

const PRESET_TOOL_SETS: Record<string, ReadonlySet<string>> = Object.fromEntries(
  Object.entries(PRESET_TOOLS).map(([preset, tools]) => [preset, new Set<string>(tools)]),
);

export function isNovelPreset(value: unknown): value is NovelPresetId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PRESET_TOOL_SETS, value);
}

/**
 * 未知 preset 得到 `undefined`（调用方必须 fail-closed 拒绝）。
 * 绝不回退到"全集"或"默认助手"——那是权限扩大。
 */
export function toolsForPreset(preset: string): readonly NovelToolName[] | undefined {
  if (!isNovelPreset(preset)) return undefined;
  return [...PRESET_TOOLS[preset]];
}

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
