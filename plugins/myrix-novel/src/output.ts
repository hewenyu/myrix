/**
 * `@myrix/novel` 六个工具的**模型面输出契约**：声明 schema 与窄化投影的唯一来源。
 *
 * ## 为什么需要这一层
 *
 * 声明 schema 用 `additionalProperties: false`，而 DSH 的
 * `tools.execute()` 会在成功返回后**真的**用该 schema 校验 canonical value
 * （`@deepseek-ai/dsh-tools` 的 `createSuccessResult` → `validateJsonSchemaValue`），
 * 不符就抛 `INVALID_TOOL_OUTPUT`。这条校验是好事：它让"服务端多返回了内部字段"
 * 变成可见的失败，而不是悄悄回显给模型。
 *
 * 但作品服务（`PostgresNovelRepository`）返回的是**存储层记录**：
 *   * 保存类返回 `SaveResult = { status, version, contentHash, updatedAt, reason }`；
 *   * `getChapter` 返回 `ChapterRecord + text`，含 `tenantId`/`parentVersion`/
 *     `contentHash`/`createdAt`。
 * 这些字段对模型既无意义，又是内部实现细节（正文哈希、租户 id、审计原因）。
 * 直接把它当工具输出回传，会让三个写工具与 `get_chapter` 全部触发
 * `INVALID_TOOL_OUTPUT`，真实链路直接断在工具返回处（见
 * `docs/adr/0026-novel-write-output.md`）。
 *
 * ## 修复取向：窄化投影，而不是放宽 schema
 *
 * 正确做法是在**模型面边界**上做一次纯投影：只挑出 schema 声明过的字段，
 * 其余一律丢弃；形状不符（缺字段、类型不对、未知 status）则**抛错**，让调用
 * 以工具错误呈现，而不是编一个看似合法的值。放宽 schema（把内部字段写进去）
 * 会把存储实现细节固化成对模型的承诺，是错误的方向。
 *
 * 投影是纯函数：不读时钟、不碰网络、不做 I/O。它同时是"契约的单一事实来源"——
 * schema 与投影在同一文件里成对维护，任何一方新增字段都必须同步另一方。
 *
 * @module @myrix/novel/output
 */
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import type { NovelToolName } from './protocol.ts'

/** 保存类结果的合法三态；与 `@myrix/contracts` 的 `SaveResult` 一致。 */
export const SAVE_STATUSES = ['saved', 'duplicate', 'conflict'] as const
export type SaveStatus = (typeof SAVE_STATUSES)[number]

/** 设定条目对模型暴露的三种 kind；DB 侧的其他类目在作品服务里已归并为 setting。 */
const BIBLE_KINDS = ['character', 'setting', 'timeline'] as const

/** 一次保存类工具的结果 schema（saved/duplicate/conflict 三态都在其中）。 */
function saveResultSchema(): JsonSchemaNode {
  return {
    type: 'object',
    properties: {
      status: { type: 'string', enum: [...SAVE_STATUSES] },
      version: { type: 'integer' },
    },
    required: ['status', 'version'],
    additionalProperties: false,
  }
}

/**
 * 六个工具各自的输出 schema。
 *
 * 与作品服务 `packages/contracts` 的 `Outline` / `Chapter` / `BibleEntry` /
 * `SaveResult` 一一对应；`additionalProperties: false` 让"服务端多返回了内部字段"
 * 变成可见的失败，而不是被悄悄回显给模型。
 */
export const OUTPUT_SCHEMAS: Record<NovelToolName, JsonSchemaNode> = {
  get_outline: {
    type: 'object',
    properties: {
      workId: { type: 'string' },
      text: { type: 'string' },
      version: { type: 'integer' },
      updatedAt: { type: 'string' },
    },
    required: ['workId', 'text', 'version', 'updatedAt'],
    additionalProperties: false,
  },
  update_outline: saveResultSchema(),
  get_chapter: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      workId: { type: 'string' },
      title: { type: 'string' },
      text: { type: 'string' },
      version: { type: 'integer' },
      updatedAt: { type: 'string' },
    },
    required: ['id', 'workId', 'title', 'text', 'version', 'updatedAt'],
    additionalProperties: false,
  },
  save_chapter_draft: saveResultSchema(),
  search_bible: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        workId: { type: 'string' },
        kind: { type: 'string', enum: [...BIBLE_KINDS] },
        title: { type: 'string' },
        text: { type: 'string' },
        version: { type: 'integer' },
        updatedAt: { type: 'string' },
      },
      required: ['id', 'workId', 'kind', 'title', 'text', 'version', 'updatedAt'],
      additionalProperties: false,
    },
  },
  update_bible_entry: saveResultSchema(),
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 形状不符时的失败。
 *
 * 错误文本**不含原始值**：它会进入模型上下文，不能借它泄漏租户 id、正文哈希
 * 或审计 reason。工具只说明"输出不符合契约"，具体内容由服务端日志排查。
 */
function invalid(tool: NovelToolName): never {
  throw new Error(`作品服务返回的 ${tool} 输出不符合工具契约`)
}

function requiredString(record: Record<string, unknown>, field: string, tool: NovelToolName): string {
  const value = record[field]
  if (typeof value !== 'string') invalid(tool)
  return value
}

/** 版本号：非负安全整数。浮点/负数/字符串一律视为契约违约，不做静默取整。 */
function requiredVersion(record: Record<string, unknown>, tool: NovelToolName): number {
  const value = record['version']
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(tool)
  return value
}

function requiredStatus(record: Record<string, unknown>, tool: NovelToolName): SaveStatus {
  const value = record['status']
  if (value !== 'saved' && value !== 'duplicate' && value !== 'conflict') invalid(tool)
  return value
}

function requiredKind(record: Record<string, unknown>, tool: NovelToolName): (typeof BIBLE_KINDS)[number] {
  const value = record['kind']
  if (value !== 'character' && value !== 'setting' && value !== 'timeline') invalid(tool)
  return value
}

function projectOutline(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) invalid('get_outline')
  return {
    workId: requiredString(raw, 'workId', 'get_outline'),
    text: requiredString(raw, 'text', 'get_outline'),
    version: requiredVersion(raw, 'get_outline'),
    updatedAt: requiredString(raw, 'updatedAt', 'get_outline'),
  }
}

function projectChapter(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) invalid('get_chapter')
  return {
    id: requiredString(raw, 'id', 'get_chapter'),
    workId: requiredString(raw, 'workId', 'get_chapter'),
    title: requiredString(raw, 'title', 'get_chapter'),
    text: requiredString(raw, 'text', 'get_chapter'),
    version: requiredVersion(raw, 'get_chapter'),
    updatedAt: requiredString(raw, 'updatedAt', 'get_chapter'),
  }
}

function projectBibleEntry(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) invalid('search_bible')
  return {
    id: requiredString(raw, 'id', 'search_bible'),
    workId: requiredString(raw, 'workId', 'search_bible'),
    kind: requiredKind(raw, 'search_bible'),
    title: requiredString(raw, 'title', 'search_bible'),
    text: requiredString(raw, 'text', 'search_bible'),
    version: requiredVersion(raw, 'search_bible'),
    updatedAt: requiredString(raw, 'updatedAt', 'search_bible'),
  }
}

function projectBibleList(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) invalid('search_bible')
  return raw.map((entry) => projectBibleEntry(entry))
}

function projectSaveResult(tool: NovelToolName, raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) invalid(tool)
  return { status: requiredStatus(raw, tool), version: requiredVersion(raw, tool) }
}

/**
 * 把作品服务返回的原始值窄化成**只含声明字段**的 canonical value。
 *
 * @param tool - 六个小说工具之一（决定投影形状）。
 * @param raw - 作品服务 `{ result }` 里 `result` 解析后的值（可能是存储层记录）。
 * @returns 满足 `OUTPUT_SCHEMAS[tool]` 的新对象/新数组；调用方不得再修改它。
 * @throws 形状不符时抛出不携带原始值的错误（fail-closed，不编造合法值）。
 */
export function projectToolOutput(tool: NovelToolName, raw: unknown): unknown {
  switch (tool) {
    case 'get_outline':
      return projectOutline(raw)
    case 'get_chapter':
      return projectChapter(raw)
    case 'search_bible':
      return projectBibleList(raw)
    case 'update_outline':
    case 'save_chapter_draft':
    case 'update_bible_entry':
      return projectSaveResult(tool, raw)
  }
}
