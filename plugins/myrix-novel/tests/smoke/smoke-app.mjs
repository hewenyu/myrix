/**
 * `myrix-novel` 冒烟用的 Cell 侧探针插件（**测试专用**）。
 *
 * 它只做真实内核里能做的事：读 `ctx.novelStore`、列 preset、为每个 preset 建
 * Agent、按掩码执行工具，然后把结果写成 JSON 报告。所有断言都是"实测到的状态"，
 * 不是构造出来的结论。
 *
 * @module myrix-novel-smoke-app
 */
import { writeFileSync } from 'node:fs'

export const name = 'myrix-novel-smoke-app'
export const inject = ['appReady', 'agents', 'agentPresets', 'principals', 'tools', 'systemPrompt', 'novelStore']

const WID = 'w_smoke'
const TID = 't_smoke'
const UID = 'u_smoke'
const masks = {
  'novel-assistant': ['get_chapter', 'get_outline', 'save_chapter_draft', 'search_bible', 'update_bible_entry', 'update_outline'],
  'novel-outline': ['get_outline', 'search_bible', 'update_outline'],
  'novel-chapter': ['get_chapter', 'get_outline', 'save_chapter_draft', 'search_bible'],
  'novel-bible': ['get_chapter', 'get_outline', 'search_bible', 'update_bible_entry'],
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx, config) {
  // 首版里"绑定/成员活性"由 myrix-runtime-driver 安装（控制面心跳 + binding lease）。
  // 冒烟不启动 driver，因此这里装一个**显式**的活性替身 —— 缺它时插件会 fail-closed
  // 拒绝一切身份（liveness-unavailable），这正是我们要先验证的行为。
  ctx.effect(() => ctx.principals.setLiveness(() => true), 'smoke: liveness stand-in（替代 runtime-driver）')
  ctx.effect(() => ctx.appReady?.onReady?.(() => { void run() }))

  async function run() {
    const probes = []
    const probe = async (name, fn) => {
      try {
        probes.push({ name, ok: true, detail: await fn() })
      } catch (error) {
        probes.push({ name, ok: false, error: String(error?.message ?? error) })
      }
    }
    const assert = (condition, message) => { if (!condition) throw new Error(message) }

    await probe('novelStore 服务已提供', () => {
      assert(typeof ctx.novelStore?.call === 'function', 'ctx.novelStore 不可用')
      return { call: typeof ctx.novelStore.call }
    })

    await probe('统一助手与三个历史 preset 在 roster 且未损坏', async () => {
      const rows = await ctx.agentPresets.list()
      const ids = rows.map(row => row.id).sort()
      assert(Object.keys(masks).every(preset => ids.includes(preset)), `roster 缺少 preset: ${ids.join(',')}`)
      const broken = rows.filter(row => row.broken !== undefined).map(row => [row.id, row.broken])
      assert(broken.length === 0, `preset 损坏: ${JSON.stringify(broken)}`)
      return { ids, broken }
    })

    await probe('根作用域没有小说工具', () => {
      const global = ctx.tools.schemas().map(s => s.name).filter(n => n.startsWith('get_') || n.startsWith('save_') || n.startsWith('update_') || n.startsWith('search_'))
      assert(!global.includes('save_chapter_draft'), `save_chapter_draft 出现在了根作用域: ${global.join(',')}`)
      return { globalToolCount: ctx.tools.schemas().length }
    })

    const perPreset = {}
    for (const preset of Object.keys(masks)) {
      await probe(`preset ${preset} 的掩码与工具执行`, async () => {
        let seq = 0
        const sid = `session-${preset}`
        const handle = await ctx.agents.create({
          sessionId: sid,
          meta: { agentPreset: preset },
          agentOptions: { provider: 'stub', model: 'stub' },
          setup: async (agentCtx, agent) => {
            await ctx.agentPresets.mount(agentCtx, preset)
            agentCtx.effect(() => ctx.principals.bind(agent, { sid: agent.id, tid: TID, sub: UID, wid: WID, preset, rev: 1 }))
          },
        })
        const agent = handle.agent
        seq += 1
        const visible = ctx.tools.schemas(agent).map(s => s.name).sort()
        perPreset[preset] = visible
        assert(JSON.stringify(visible) === JSON.stringify(masks[preset]), `preset ${preset} 工具掩码不匹配: ${visible.join(',')}`)

        const asm = await ctx.systemPrompt.assemble({ agent, scope: agent })
        const promptText = asm.sections.map(s => s.text).filter(Boolean).join('\n')

        // 该 preset 的工具真的执行：读大纲。
        const outlined = await ctx.tools.execute({
          name: 'get_outline', arguments: {}, agent, callId: `smoke_${preset}_${seq}`, signal: new AbortController().signal,
        })
        assert(outlined.isError !== true && Array.isArray(outlined.content), `get_outline 失败: ${JSON.stringify(outlined.error ?? outlined.content)}`)
        assert(promptText.includes(WID), `提示未注入服务端 workId: ${promptText}`)
        return { visible, worksValue: outlined.value, promptHasWorkId: true, promptMentionsExpectedVersion: promptText.includes('expectedVersion') }
      })
    }

    await probe('掩码互不串台', () => {
      assert(!perPreset['novel-outline'].includes('save_chapter_draft'), '大纲助手不应看到 save_chapter_draft')
      assert(!perPreset['novel-chapter'].includes('update_outline'), '章节助手不应看到 update_outline')
      assert(perPreset['novel-bible'].includes('update_bible_entry'), '设定助手应看到 update_bible_entry')
      return perPreset
    })

    writeFileSync(config.out, `${JSON.stringify({ probes, perPreset }, null, 2)}\n`, { mode: 0o600 })
    ctx.appExit?.(0)
  }
}
