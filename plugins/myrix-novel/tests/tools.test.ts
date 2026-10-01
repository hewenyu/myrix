/**
 * `plugins/myrix-novel` 工具定义层的**快速单元测试**（不启动 Cordis）。
 *
 * 这一组把 `execute` 的契约钉死在"没有内核也能验证"的粒度上：
 *   - 身份只从 `exec.agent` 经 `principals.require()` 取；未绑定即拒绝；
 *   - 模型参数在**网络调用之前**被 strict 解析（多余字段、坏版本、坏 UUID）；
 *   - 传给作品服务的只有 `{sessionId, revision}` 与工具参数；
 *   - 保存类结果三态（saved/duplicate/conflict）原样返回，冲突不伪装成功。
 *
 * 这里的 `principals` 与 `store` 都是**显式替身**（最小接口实现），因此本文件
 * 不证明真实身份表或真实作品服务的行为 —— 那分别由
 * `../myrix-principals/tests/principals.test.ts` 与
 * `apps/bff/tests/postgres.integration.test.ts` 覆盖。
 *
 * @module tests/tools.test
 */
import { describe, expect, it, vi } from 'vitest'
import type { Principal } from '@myrix/principals'
import { defineNovelTool, principalFor } from '../src/tools.ts'
import type { NovelCallPrincipal, NovelStoreService } from '../src/service.ts'
import type { NovelToolName } from '../src/protocol.ts'

const SID = '10000000-0000-4000-8000-000000000001'
const CHAPTER_ID = '10000000-0000-4000-8000-0000000000aa'
const BIBLE_ID = '10000000-0000-4000-8000-0000000000bb'

/** 只实现 `require` 的最小身份表替身。 */
function principalsStub(principal: Principal | undefined, error?: Error) {
  return {
    require: vi.fn((agent: unknown) => {
      if (principal === undefined) throw error ?? new Error('myrix: 会话没有有效身份（unbound）')
      if (agent !== AGENT) throw new Error('myrix: 会话没有有效身份（no-agent）')
      return principal
    }),
  }
}

const AGENT = { id: SID }
const PRINCIPAL: Principal = { sid: SID, tid: 't_1', sub: 'u_1', wid: 'w_1', preset: 'novel-chapter', rev: 7 }

/** 作品服务替身：记录调用并返回可编程结果。 */
function storeStub(result: unknown = { status: 'saved', version: 8 }) {
  const calls: { principal: NovelCallPrincipal; tool: NovelToolName; input: unknown }[] = []
  const store: NovelStoreService = {
    async call(principal, tool, input) {
      calls.push({ principal, tool, input })
      return JSON.stringify(result)
    },
  }
  return { store, calls }
}

/** 组装一次 execute 所需的运行上下文。 */
function exec(overrides: Record<string, unknown> = {}) {
  return { agent: AGENT, signal: new AbortController().signal, callId: 'c_1', ...overrides } as never
}

describe('principalFor', () => {
  it('以可信 Agent 为键取身份，并只返回 sid/rev/wid', () => {
    const principals = principalsStub(PRINCIPAL)
    expect(principalFor(principals as never, { agent: AGENT })).toEqual({ sessionId: SID, revision: 7, workId: 'w_1' })
    expect(principals.require).toHaveBeenCalledWith(AGENT)
  })

  it('没有 Agent 时抛错而不是返回空身份', () => {
    const principals = principalsStub(PRINCIPAL)
    expect(() => principalFor(principals as never, {})).toThrow(/没有有效身份/)
  })
})

describe('defineNovelTool.execute', () => {
  it('把 {sessionId, revision} 与校验后的参数交给作品服务', async () => {
    const { store, calls } = storeStub()
    const tool = defineNovelTool({ store, principals: principalsStub(PRINCIPAL) as never }, 'save_chapter_draft')
    expect(tool.name).toBe('save_chapter_draft')
    expect(tool.output?.schema).toMatchObject({ type: 'object', additionalProperties: false })
    const value = await tool.execute!({ chapterId: CHAPTER_ID, text: '正文', expectedVersion: 4 }, exec())
    expect(value).toEqual({ status: 'saved', version: 8 })
    expect(calls).toEqual([
      { principal: { sessionId: SID, revision: 7 }, tool: 'save_chapter_draft', input: { chapterId: CHAPTER_ID, text: '正文', expectedVersion: 4 } },
    ])
  })

  it.each(['tenantId', 'userId', 'workId', 'sessionId', 'url', 'credential', 'extra'])(
    '拒绝模型参数里的 %s，且不发起任何调用',
    async (field) => {
      const { store, calls } = storeStub()
      const tool = defineNovelTool({ store, principals: principalsStub(PRINCIPAL) as never }, 'save_chapter_draft')
      await expect(
        tool.execute!({ chapterId: CHAPTER_ID, text: 'x', expectedVersion: 1, [field]: 'attacker' }, exec()),
      ).rejects.toThrow(/不允许/)
      expect(calls).toHaveLength(0)
    },
  )

  it.each([
    ['expectedVersion 缺失', { chapterId: CHAPTER_ID, text: 'x' }],
    ['expectedVersion 为负', { chapterId: CHAPTER_ID, text: 'x', expectedVersion: -1 }],
    ['expectedVersion 非整数', { chapterId: CHAPTER_ID, text: 'x', expectedVersion: 1.5 }],
    ['chapterId 非 UUID', { chapterId: 'nope', text: 'x', expectedVersion: 1 }],
    ['非对象参数', 'not-an-object'],
  ])('本地拒绝 %s', async (_label, args) => {
    const { store, calls } = storeStub()
    const tool = defineNovelTool({ store, principals: principalsStub(PRINCIPAL) as never }, 'save_chapter_draft')
    await expect(tool.execute!(args, exec())).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  it('身份缺失时先拒绝，不进入参数解析与网络', async () => {
    const { store, calls } = storeStub()
    const tool = defineNovelTool({ store, principals: principalsStub(undefined) as never }, 'get_outline')
    await expect(tool.execute!({}, exec())).rejects.toThrow(/没有有效身份/)
    expect(calls).toHaveLength(0)
  })

  it('冲突与重复原样返回，不伪装成 saved', async () => {
    const conflict = storeStub({ status: 'conflict', version: 12 })
    const tool = defineNovelTool({ store: conflict.store, principals: principalsStub(PRINCIPAL) as never }, 'update_outline')
    await expect(tool.execute!({ text: '新大纲', expectedVersion: 3 }, exec())).resolves.toEqual({ status: 'conflict', version: 12 })

    const duplicate = storeStub({ status: 'duplicate', version: 12 })
    const rerun = defineNovelTool({ store: duplicate.store, principals: principalsStub(PRINCIPAL) as never }, 'update_outline')
    await expect(rerun.execute!({ text: '新大纲', expectedVersion: 3 }, exec())).resolves.toEqual({ status: 'duplicate', version: 12 })
  })

  it('只读工具不需要 expectedVersion，但仍校验 ID 与查询长度', async () => {
    const { store, calls } = storeStub([{ id: BIBLE_ID, workId: 'w_1', kind: 'character', title: 'a', text: 'b', version: 1, updatedAt: 'x' }])
    const tool = defineNovelTool({ store, principals: principalsStub(PRINCIPAL) as never }, 'search_bible')
    await expect(tool.execute!({ query: '主角' }, exec())).resolves.toHaveLength(1)
    await expect(tool.execute!({ query: 'x'.repeat(1001) }, exec())).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })

  it('六个工具都能构造，且参数 schema 声明 additionalProperties:false', () => {
    const { store } = storeStub()
    const principals = principalsStub(PRINCIPAL)
    for (const name of ['get_outline', 'update_outline', 'get_chapter', 'save_chapter_draft', 'search_bible', 'update_bible_entry'] as const) {
      const tool = defineNovelTool({ store, principals: principals as never }, name)
      expect(tool.parameters).toMatchObject({ type: 'object', additionalProperties: false })
      expect(typeof tool.description).toBe('string')
    }
  })
})
