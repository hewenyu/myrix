/**
 * `plugins/myrix-novel` 六个工具的**真实 ToolRuntime 输出契约**回归。
 *
 * ## 这个文件防的是什么
 *
 * 2026-10-01 的真实浏览器 + 上游 Responses 链路里，`get_outline` 成功，但紧接着的
 * `update_outline` 在保存**已经落库**之后返回 DSH 错误：
 *
 * ```
 * Error: tool "update_outline" returned invalid output:
 *   "value.contentHash" is not a declared property (additionalProperties: false);
 *   "value.updatedAt" is not a declared property (additionalProperties: false);
 *   "value.reason" is not a declared property (additionalProperties: false)
 *   → ToolOutputError / INVALID_TOOL_OUTPUT
 * ```
 *
 * 根因：作品服务返回**存储层记录**（`SaveResult` 含 contentHash/updatedAt/reason，
 * `getChapter` 含 tenantId/parentVersion/contentHash/createdAt），而工具的
 * `output.schema` 用 `additionalProperties: false` 声明了模型面契约；DSH 的
 * `tools.execute()` 会真的按该 schema 校验 canonical value。
 *
 * ## 为什么必须走真实 ToolRuntime
 *
 * 旧的 `harness.ts` 替身只回"刚好符合 schema"的理想值，于是"真实执行器返回触发
 * `INVALID_TOOL_OUTPUT`"被完全掩盖。本文件因此：
 *   1. 让作品服务替身返回**真实仓储形状**（见 harness 的 `defaultAnswer`）；
 *   2. 通过真实 `ctx.tools.execute()`（而不是直接调 `tool.execute()`）执行，
 *       让 DSH 的 `createSuccessResult → validateJsonSchemaValue` 真的跑一遍；
 *   3. 既断言"不报 INVALID_TOOL_OUTPUT"，也断言返回值**恰好**只含声明字段
 *       —— 窄化投影必须真的丢弃内部字段，而不是碰巧通过。
 *
 * 真实 PostgreSQL 上的同一契约另见
 * `apps/bff/tests/novel-tool-contract.integration.test.ts`。
 *
 * @module tests/output-contract.test
 */
import { describe, expect, it } from 'vitest'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { Principal } from '@myrix/principals'
import { apply as applyNovel } from '../src/index.ts'
import { OUTPUT_SCHEMAS } from '../src/output.ts'
import { NOVEL_TOOLS, type NovelToolName } from '../src/protocol.ts'
import { createNovelHarness, type NovelHarness } from './harness.ts'

const ORIGIN = 'http://works.internal:8081'
const CREDENTIAL = 'cell-test-credential'
const CHAPTER_ID = '10000000-0000-4000-8000-0000000000aa'
const BIBLE_ID = '10000000-0000-4000-8000-0000000000bb'

let sessionSeq = 0
function nextSid(): string {
  sessionSeq += 1
  return `20000000-0000-4000-8000-${String(sessionSeq).padStart(12, '0')}`
}

/** 装配真实插件（真实 preset 子树 + 真实 ToolRuntime）。 */
async function boot(): Promise<NovelHarness> {
  const harness = await createNovelHarness()
  await harness.ctx.plugin(
    { name: 'myrix-novel', inject: ['tools', 'systemPrompt', 'agentPresets', 'principals'], apply: applyNovel },
    { origin: ORIGIN, credential: CREDENTIAL },
  )
  return harness
}

/** 建一个绑定真实身份的 Agent；preset 决定该 Agent 可见的工具。 */
function agentFor(harness: NovelHarness, preset: string) {
  const sid = nextSid()
  const principal: Principal = { sid, tid: 't_1', sub: 'u_1', wid: 'w_1', preset, rev: 7 }
  return harness.createAgent({ sessionId: sid, preset, principal })
}

/** 经**真实** `ctx.tools.execute()` 执行一次工具（不是直调 `tool.execute`）。 */
function run(harness: NovelHarness, name: NovelToolName, args: unknown, agent: unknown, callId = 'c_1') {
  return harness.ctx.tools.execute({
    name,
    arguments: args,
    agent: agent as never,
    callId: callId as never,
    signal: new AbortController().signal,
  })
}

/**
 * 断言一次成功结果同时满足两件事：
 *   * 真实 DSH 校验不再抛 `INVALID_TOOL_OUTPUT`（`isError === false`）；
 *   * canonical value 只含声明字段（窄化投影真的生效）。
 */
function expectDeclaredShape<T>(harness: NovelHarness, tool: NovelToolName, value: T): void {
  const violations = validateJsonSchemaValue(OUTPUT_SCHEMAS[tool], value, 'value')
  expect(violations, `${tool} 输出必须满足声明 schema`).toEqual([])
}

describe('myrix-novel：真实 ToolRuntime 输出契约（六工具）', () => {
  it('六工具都用真实仓储形状跑通，不产生 INVALID_TOOL_OUTPUT', async () => {
    const harness = await boot()
    try {
      const chapter = await agentFor(harness, 'novel-chapter')
      const bible = await agentFor(harness, 'novel-bible')
      const outline = await agentFor(harness, 'novel-outline')

      const outlineRead = await run(harness, 'get_outline', {}, outline, 'c_outline_read')
      expect(outlineRead.isError, JSON.stringify(outlineRead.content)).toBe(false)
      expectDeclaredShape(harness, 'get_outline', outlineRead.value)

      const chapterRead = await run(harness, 'get_chapter', { chapterId: CHAPTER_ID }, chapter, 'c_chapter_read')
      expect(chapterRead.isError, JSON.stringify(chapterRead.content)).toBe(false)
      expectDeclaredShape(harness, 'get_chapter', chapterRead.value)
      // ChapterRecord 的 tenantId/parentVersion/contentHash/createdAt 必须被丢弃。
      expect(Object.keys(chapterRead.value as object).sort()).toEqual(['id', 'text', 'title', 'updatedAt', 'version', 'workId'])

      const found = await run(harness, 'search_bible', { query: '主角' }, bible, 'c_bible_search')
      expect(found.isError, JSON.stringify(found.content)).toBe(false)
      expectDeclaredShape(harness, 'search_bible', found.value)

      const savedOutline = await run(harness, 'update_outline', { text: '大纲', expectedVersion: 3 }, outline, 'c_outline_write')
      expect(savedOutline.isError, JSON.stringify(savedOutline.content)).toBe(false)
      expectDeclaredShape(harness, 'update_outline', savedOutline.value)
      expect(savedOutline.value).toEqual({ status: 'saved', version: 4 })

      const savedChapter = await run(harness, 'save_chapter_draft', { chapterId: CHAPTER_ID, text: '正文', expectedVersion: 4 }, chapter, 'c_chapter_write')
      expect(savedChapter.isError, JSON.stringify(savedChapter.content)).toBe(false)
      expectDeclaredShape(harness, 'save_chapter_draft', savedChapter.value)

      const savedBible = await run(harness, 'update_bible_entry', { entryId: BIBLE_ID, text: '设定', expectedVersion: 1 }, bible, 'c_bible_write')
      expect(savedBible.isError, JSON.stringify(savedBible.content)).toBe(false)
      expectDeclaredShape(harness, 'update_bible_entry', savedBible.value)
    } finally {
      await harness.dispose()
    }
  })

  it('三个写工具丢弃 contentHash/updatedAt/reason，只回 { status, version }', async () => {
    const harness = await boot()
    try {
      const chapter = await agentFor(harness, 'novel-chapter')
      const bible = await agentFor(harness, 'novel-bible')
      const outline = await agentFor(harness, 'novel-outline')
      const cases: Array<[NovelToolName, unknown, unknown]> = [
        ['update_outline', { text: '大纲', expectedVersion: 3 }, outline],
        ['save_chapter_draft', { chapterId: CHAPTER_ID, text: '正文', expectedVersion: 4 }, chapter],
        ['update_bible_entry', { entryId: BIBLE_ID, text: '设定', expectedVersion: 1 }, bible],
      ]
      for (const [tool, args, agent] of cases) {
        const result = await run(harness, tool, args, agent, `c_${tool}`)
        expect(result.isError, `${tool}: ${JSON.stringify(result.content)}`).toBe(false)
        expect(Object.keys(result.value as object).sort(), tool).toEqual(['status', 'version'])
        expect(JSON.stringify(result.value), tool).not.toMatch(/contentHash|updatedAt|reason/)
      }
    } finally {
      await harness.dispose()
    }
  })

  it('同内容重试（duplicate）与 CAS 冲突（conflict）都经真实校验并保留语义', async () => {
    const harness = await boot()
    try {
      const chapter = await agentFor(harness, 'novel-chapter')
      // 真实 duplicate：SaveResult 同样带 contentHash/updatedAt/reason。
      harness.works.answer('save_chapter_draft', {
        status: 'duplicate',
        version: 4,
        contentHash: 'c'.repeat(64),
        updatedAt: '2026-09-30T00:00:00.000Z',
        reason: '当前版本 4 的父版本等于 expectedVersion(3) 且正文哈希一致，判定为同一次写入的重试，返回已有版本',
      })
      const duplicate = await run(harness, 'save_chapter_draft', { chapterId: CHAPTER_ID, text: '正文', expectedVersion: 3 }, chapter, 'c_duplicate')
      expect(duplicate.isError, JSON.stringify(duplicate.content)).toBe(false)
      expect(duplicate.value).toEqual({ status: 'duplicate', version: 4 })
      expectDeclaredShape(harness, 'save_chapter_draft', duplicate.value)

      // 真实 CAS 冲突：BFF 以 409 + { result: { status:"conflict", version } } 返回。
      harness.works.answer('save_chapter_draft', { status: 'conflict', version: 9 }, 409)
      const conflicted = await run(harness, 'save_chapter_draft', { chapterId: CHAPTER_ID, text: '我的草稿', expectedVersion: 4 }, chapter, 'c_conflict')
      expect(conflicted.isError, JSON.stringify(conflicted.content)).toBe(false)
      expect(conflicted.value).toEqual({ status: 'conflict', version: 9 })
      expectDeclaredShape(harness, 'save_chapter_draft', conflicted.value)
    } finally {
      await harness.dispose()
    }
  })

  it('形状不符（缺字段/未知 status/坏版本）以工具错误呈现，不编造合法值', async () => {
    const harness = await boot()
    try {
      const outline = await agentFor(harness, 'novel-outline')
      const chapter = await agentFor(harness, 'novel-chapter')
      const cases: Array<[NovelToolName, unknown, unknown, string]> = [
        ['update_outline', { status: 'saved' }, outline, '缺 version'],
        ['update_outline', { status: 'ok', version: 1 }, outline, '未知 status'],
        ['update_outline', { status: 'saved', version: 1.5 }, outline, '非整数 version'],
        ['get_chapter', { id: CHAPTER_ID, workId: 'w_1', title: 't', text: 'x', version: 1 }, chapter, '缺 updatedAt'],
      ]
      for (const [tool, answer, agent, label] of cases) {
        harness.works.answer(tool, answer)
        const result = await run(harness, tool, tool === 'get_chapter' ? { chapterId: CHAPTER_ID } : { text: 'x', expectedVersion: 0 }, agent, `c_bad_${label}`)
        expect(result.isError, label).toBe(true)
      }
    } finally {
      await harness.dispose()
    }
  })

  it('六个工具的声明 schema 全部可被真实 DSH 校验器接受（additionalProperties:false）', () => {
    // 五个对象 schema 显式封闭；search_bible 是数组，封闭性在 items 上。
    expect(OUTPUT_SCHEMAS.search_bible).toMatchObject({ type: 'array', items: { additionalProperties: false } })
    for (const tool of NOVEL_TOOLS.filter((name) => name !== 'search_bible')) {
      expect(OUTPUT_SCHEMAS[tool], tool).toMatchObject({ additionalProperties: false })
    }
    // schema 是封闭的：多一个字段就是违规 —— 这正是投影必须存在的理由。
    expect(validateJsonSchemaValue(OUTPUT_SCHEMAS.update_outline, { status: 'saved', version: 1, contentHash: 'x' })).not.toEqual([])
  })
})
