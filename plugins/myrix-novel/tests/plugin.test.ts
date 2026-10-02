/**
 * `plugins/myrix-novel` 的真实 Cordis 组合测试。
 *
 * **这不是模型验收**：模型是明确替身（`tests/stub-model.ts`，路由 `stub-model`），
 * 作品服务是进程内 `fetch` 替身。真的部分见 `tests/harness.ts` 的模块头注释：
 * `dsh-tools` 注册表与执行管线、真实 Loader 装载的 preset 子树、
 * `dsh-agent-preset-registry`、`dsh-agent-loop`、`dsh-system-prompt`、
 * 以及 `@myrix/principals` 的严格身份路径。
 *
 * @module tests/plugin.test
 */
import { describe, expect, it } from 'vitest'
import type { Principal } from '@myrix/principals'
import { apply as applyNovel } from '../src/index.ts'
import { PRESET_TOOLS } from '../src/protocol.ts'
import { NOVEL_PRESETS } from '../src/presets.ts'
import { createNovelHarness, type NovelHarness } from './harness.ts'

const ORIGIN = 'http://works.internal:8081'
const CREDENTIAL = 'cell-test-credential'
const SID = '10000000-0000-4000-8000-000000000001'
const CHAPTER_ID = '10000000-0000-4000-8000-0000000000aa'

/** 每个 Agent 需要独立会话（dsh-session 拒绝同 id 重复创建）。 */
let sessionSeq = 0
function nextSid(): string {
  sessionSeq += 1
  return `10000000-0000-4000-8000-${String(sessionSeq).padStart(12, '0')}`
}

/**
 * 装配一次真实插件（真实 preset 注册 + 真实 preset 子树）。
 *
 * 插件装成**独立 fiber**（`ctx.plugin(module, config)`），这样才能只卸载插件
 * 而保留内核，验证 dispose 真的撤销了注册。这是 DSH 里 driver 装载插件行的
 * 等价形态。
 */
async function boot(): Promise<NovelHarness & { uninstall: () => Promise<void> }> {
  const harness = await createNovelHarness()
  const fiber = await harness.ctx.plugin({ name: 'myrix-novel', inject: ['tools', 'systemPrompt', 'agentPresets', 'principals'], apply: applyNovel }, { origin: ORIGIN, credential: CREDENTIAL })
  return Object.assign(harness, { uninstall: () => fiber.dispose() })
}

/** 建一个绑定好身份的 Agent（每次新会话 id）。 */
function agentFor(harness: NovelHarness, preset: string, overrides: Partial<Principal> = {}) {
  const sid = nextSid()
  return harness.createAgent({
    sessionId: sid,
    preset,
    principal: { sid, tid: 't_1', sub: 'u_1', wid: 'w_1', preset, rev: 7, ...overrides },
  })
}

/** 执行一次工具并返回结果（统一 signal）。 */
function run(harness: NovelHarness, name: string, args: unknown, agent?: unknown, callId = 'c_1') {
  return harness.ctx.tools.execute({
    name,
    arguments: args,
    ...(agent === undefined ? {} : { agent: agent as never }),
    callId: callId as never,
    signal: new AbortController().signal,
  })
}

describe('myrix-novel：preset 与作用域', () => {
  it('三个 preset 注册成功，roster 无 broken', async () => {
    const harness = await boot()
    try {
      const rows = await harness.ctx.agentPresets.list()
      expect(rows.map((row) => row.id).sort()).toEqual([...NOVEL_PRESETS].sort())
      for (const row of rows) expect(row.broken, row.id).toBeUndefined()
    } finally {
      await harness.dispose()
    }
  })

  it('工具只在该 preset 作用域可见，根作用域始终为空', async () => {
    const harness = await boot()
    try {
      for (const preset of NOVEL_PRESETS) {
        const agent = await agentFor(harness, preset)
        expect(harness.ctx.tools.schemas(agent).map((schema) => schema.name).sort(), preset)
          .toEqual([...PRESET_TOOLS[preset]].sort())
      }
      expect(harness.ctx.tools.schemas().map((schema) => schema.name)).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  it('掩码生效：大纲助手拿不到 save_chapter_draft（不可见即拒绝）', async () => {
    const harness = await boot()
    try {
      const outline = await agentFor(harness, 'novel-outline')
      const chapter = await agentFor(harness, 'novel-chapter')
      expect(harness.ctx.tools.schemas(outline).map((schema) => schema.name)).not.toContain('save_chapter_draft')
      expect(harness.ctx.tools.schemas(chapter).map((schema) => schema.name)).not.toContain('update_outline')
      // 越权调用得到 UNKNOWN_TOOL 错误，而不是"被劝阻"。
      const denied = await run(harness, 'save_chapter_draft', { chapterId: CHAPTER_ID, text: 'x', expectedVersion: 1 }, outline)
      expect(denied.isError).toBe(true)
      expect(denied.error?.message).toContain('unknown tool')
    } finally {
      await harness.dispose()
    }
  })

  it('掩码写错时 preset 装载失败（不静默少注册工具）', async () => {
    const harness = await createNovelHarness()
    try {
      await expect(
        harness.createAgent({
          sessionId: SID,
          preset: 'novel-outline',
          principal: { sid: SID, tid: 't_1', sub: 'u_1', wid: 'w_1', preset: 'novel-outline', rev: 1 },
          definitionOverride: {
            id: 'novel-outline',
            plugins: [{ id: 'row', name: `cordis:${'myrix-novel-preset-tools'}`, config: { preset: 'novel-outline', tools: ['get_outline', 'save_chapter_draft', 'search_bible'] } }],
          },
        }),
      ).rejects.toThrow()
    } finally {
      await harness.dispose()
    }
  })
})

describe('myrix-novel：工具 execute 契约', () => {
  it('只用可信 Agent 的身份，作品服务只收到 sessionId/revision', async () => {
    const harness = await boot()
    try {
      const agent = await agentFor(harness, 'novel-chapter')
      const ok = await run(harness, 'save_chapter_draft', { chapterId: CHAPTER_ID, text: '正文', expectedVersion: 4 }, agent)
      expect(ok.isError).toBe(false)
      expect(ok.value).toEqual({ status: 'saved', version: 5 })
      expect(harness.works.calls).toEqual([
        {
          sessionId: agent.id,
          tool: 'save_chapter_draft',
          args: { chapterId: CHAPTER_ID, text: '正文', expectedVersion: 4 },
          revisionHeader: 7,
          path: `/internal/v1/sessions/${agent.id}/tools/save_chapter_draft`,
          authorization: `Bearer ${CREDENTIAL}`,
        },
      ])
      // URL 与请求体里都没有 workId。
      expect(JSON.stringify(harness.works.calls[0])).not.toContain('w_1')
    } finally {
      await harness.dispose()
    }
  })

  it('拒绝模型传入的身份字段，且发生在任何网络调用之前', async () => {
    const harness = await boot()
    try {
      const agent = await agentFor(harness, 'novel-chapter')
      for (const field of ['tenantId', 'userId', 'workId', 'sessionId', 'url', 'credential']) {
        const injected = await run(
          harness,
          'save_chapter_draft',
          { chapterId: CHAPTER_ID, text: 'x', expectedVersion: 1, [field]: 'attacker' },
          agent,
          `c_${field}`,
        )
        expect(injected.isError, field).toBe(true)
        expect(injected.error?.message, field).toContain('不允许')
      }
      // 版本与 ID 形状同样在本地拒绝。
      const badVersion = await run(harness, 'update_outline', { text: 'x', expectedVersion: -1 }, agent, 'c_bad_version')
      expect(badVersion.isError).toBe(true)
      const badChapter = await run(harness, 'get_chapter', { chapterId: 'not-a-uuid' }, agent, 'c_bad_chapter')
      expect(badChapter.isError).toBe(true)
      expect(harness.works.calls).toHaveLength(0)
    } finally {
      await harness.dispose()
    }
  })

  it('无 Agent 上下文 / 未安装活性 / 已撤权都拒绝', async () => {
    const harness = await boot()
    try {
      const noAgent = await run(harness, 'get_outline', {})
      expect(noAgent.isError).toBe(true)

      // 未安装活性提供者：require* 一律拒绝（fail-closed）。
      const noLivenessSid = nextSid()
      const noLiveness = await harness.createAgent({
        sessionId: noLivenessSid,
        preset: 'novel-outline',
        principal: { sid: noLivenessSid, tid: 't_1', sub: 'u_1', wid: 'w_1', preset: 'novel-outline', rev: 1 },
        liveness: false,
      })
      const denied = await run(harness, 'get_outline', {}, noLiveness, 'c_no_liveness')
      expect(denied.isError).toBe(true)
      expect(denied.error?.message).toContain('没有有效身份')

      // 撤权后同一 Agent 立即失效。
      const agent = await agentFor(harness, 'novel-chapter')
      harness.principals.setLiveness(() => true)
      const before = await run(harness, 'get_outline', {}, agent, 'c_before')
      expect(before.isError).toBe(false)
      expect(harness.principals.revoke({ sid: agent.id, rev: 8, reason: '组合测试撤权' }).accepted).toBe(true)
      const after = await run(harness, 'get_outline', {}, agent, 'c_after')
      expect(after.isError).toBe(true)
      expect(after.error?.message).toContain('没有有效身份')
    } finally {
      await harness.dispose()
    }
  })

  it('CAS 冲突原样交给模型，不伪装成保存成功', async () => {
    const harness = await boot()
    try {
      const agent = await agentFor(harness, 'novel-chapter')
      harness.works.answer('save_chapter_draft', { status: 'conflict', version: 9 }, 409)
      const conflicted = await run(harness, 'save_chapter_draft', { chapterId: CHAPTER_ID, text: '我的草稿', expectedVersion: 4 }, agent)
      expect(conflicted.isError).toBe(false)
      expect(conflicted.value).toEqual({ status: 'conflict', version: 9 })
    } finally {
      await harness.dispose()
    }
  })

  it('服务错误不外泄内部正文', async () => {
    const harness = await boot()
    try {
      const agent = await agentFor(harness, 'novel-chapter')
      harness.works.fail(503, 'internal postgres dsn=postgres://secret')
      const failed = await run(harness, 'get_outline', {}, agent)
      expect(failed.isError).toBe(true)
      expect(JSON.stringify(failed.content)).not.toContain('secret')
      expect(JSON.stringify(failed.error ?? {})).not.toContain('secret')
    } finally {
      await harness.dispose()
    }
  })

  it('搜索设定返回数组，且形状符合输出 schema', async () => {
    const harness = await boot()
    try {
      const agent = await agentFor(harness, 'novel-bible')
      const found = await run(harness, 'search_bible', { query: '主角' }, agent)
      expect(found.isError).toBe(false)
      expect(Array.isArray(found.value)).toBe(true)
      expect(harness.works.calls.at(-1)?.args).toEqual({ query: '主角' })
    } finally {
      await harness.dispose()
    }
  })
})

describe('myrix-novel：提示与卸载', () => {
  it('提示只注入服务端绑定的 workId；不含凭据/URL/token', async () => {
    const harness = await boot()
    try {
      const agent = await agentFor(harness, 'novel-bible', { wid: 'w_服务器绑定' })
      const assembly = await harness.ctx.systemPrompt.assemble({ agent, scope: agent })
      const text = assembly.sections.map((section) => section.text).join('\n')
      expect(text).toContain('w_服务器绑定')
      expect(text).toContain('expectedVersion')
      expect(text).not.toContain(CREDENTIAL)
      expect(text).not.toContain(ORIGIN)
      expect(text).not.toContain('Bearer')
    } finally {
      await harness.dispose()
    }
  })

  it('身份失效时提示不再回显 workId，而是明说没有绑定', async () => {
    const harness = await boot()
    try {
      const agent = await agentFor(harness, 'novel-outline', { wid: 'w_不该泄漏' })
      harness.principals.revoke({ sid: agent.id, rev: 9, reason: '撤权后提示不回显作品' })
      const assembly = await harness.ctx.systemPrompt.assemble({ agent, scope: agent })
      const text = assembly.sections.map((section) => section.text).join('\n')
      expect(text).not.toContain('w_不该泄漏')
      expect(text).toContain('没有可用的作品绑定')
    } finally {
      await harness.dispose()
    }
  })

  it('卸载插件 fiber 后 preset 与工具注册全部消失', async () => {
    const harness = await boot()
    try {
      const agent = await agentFor(harness, 'novel-chapter')
      expect(harness.ctx.tools.schemas(agent)).toHaveLength(PRESET_TOOLS['novel-chapter'].length)
      await harness.uninstall()
      expect(await harness.ctx.agentPresets.list()).toEqual([])
      expect(harness.ctx.tools.schemas()).toEqual([])
      // 服务也随之撤销：卸载后不再有 novelStore 这个入口（读取抛错或得到 undefined，
      // 两种情况都表示其他插件无法再拿到它；这里两种都接受）。
      const after = (() => { try { return harness.ctx.novelStore } catch { return undefined } })()
      expect(after).toBeUndefined()
    } finally {
      await harness.dispose()
    }
  })
})

describe('myrix-novel：真实模型回合（替身模型，仍非模型验收）', () => {
  it('Agent 真实跑完一个回合：提示进入请求、模型发起工具调用并被真实执行', async () => {
    const harness = await boot()
    try {
      const agent = await agentFor(harness, 'novel-chapter')
      // 替身模型：先要求调用 get_outline，再回一段文本结束。
      let callIndex = 0
      harness.adapter.script(() => {
        callIndex += 1
        return callIndex === 1
          ? [
              { type: 'block-start', index: 0, blockType: 'tool-call' },
              { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'stub_call_1' as never, name: 'get_outline', arguments: '{}' } },
              { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } },
              { type: 'finish', reason: { kind: 'tool-calls' } },
            ]
          : [
              { type: 'block-start', index: 0, blockType: 'text' },
              { type: 'text-delta', index: 0, text: '已读取大纲' },
              { type: 'block-end', index: 0, block: { type: 'text', text: '已读取大纲' } },
              { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } },
              { type: 'finish', reason: { kind: 'stop' } },
            ]
      })
      agent.followup({ id: 'stub_msg_1' as never, role: 'user', content: [{ type: 'text', text: '读一下大纲' }], source: { kind: 'user' } } as never)
      await agent.whenIdle()
      // 工具真的被执行了：作品服务收到了恰好一次 get_outline。
      expect(harness.works.calls.map((call) => call.tool)).toEqual(['get_outline'])
      expect(harness.works.calls[0]?.sessionId).toBe(agent.id)
      // 模型调用携带了会话归因（真实回合，只是 provider 是替身）。
      expect(harness.adapter.calls.length).toBeGreaterThanOrEqual(2)
      expect(harness.adapter.calls[0]?.sessionId).toBe(agent.id)
    } finally {
      await harness.dispose()
    }
  })
})
