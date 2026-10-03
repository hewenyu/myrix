/**
 * `plugins/myrix-novel` 的协议/装配元数据单元测试。
 *
 * 这一组不启动 Cordis（真正的作用域行为在 `plugin.test.ts`），只锁死几件
 * 容易被"重构掉"的契约：
 *   1. 每个 preset 的**默认行模块名**是 `@myrix/novel/preset-tools`
 *      （真实部署靠 profile 的 node_modules 解析它；组合测试用 `cordis:` 替身，
 *      因此这里单独断言，避免默认值被悄悄改成测试用的说明符）。
 *   2. 掩码与 `PRESET_TOOLS` 完全一致（不多不少），且**统一 preset 掩码**是
 *      六个工具全集、三个历史 preset 掩码逐字不变（只收窄，不扩大）。
 *   3. 未知 preset 在协议层就没有工具集（`toolsForPreset` 返回 undefined），
 *      调用方必须 fail-closed，绝不回退到全集或默认助手。
 *   4. 提示文本包含安全约束（不可信正文、expectedVersion、冲突先读、不可创建
 *      无工具对象），且不含任何凭据占位符。
 *
 * @module tests/preset-module.test
 */
import { describe, expect, it } from 'vitest'
import {
  LEGACY_NOVEL_PRESETS,
  NOVEL_ASSISTANT_PRESET,
  NOVEL_TOOLS,
  PRESET_IDS,
  PRESET_TOOLS,
  TOOL_DESCRIPTIONS,
  isNovelPreset,
  toolParameters,
  toolsForPreset,
} from '../src/protocol.ts'
import { NOVEL_PRESETS as PLUGIN_PRESETS, PRESET_META, PRESET_TOOLS_PLUGIN, novelPresetDefinitions, presetPromptText, presetRows } from '../src/presets.ts'

describe('preset 装配元数据', () => {
  it('默认行模块名是包名，供 profile node_modules 解析', () => {
    expect(PRESET_TOOLS_PLUGIN).toBe('@myrix/novel/preset-tools')
    for (const row of presetRows()) expect(row.name).toBe(PRESET_TOOLS_PLUGIN)
  })

  it('四个 preset 各一行，掩码与 PRESET_TOOLS 完全一致', () => {
    const rows = presetRows()
    expect(rows.map((row) => row.id)).toEqual([...PRESET_IDS])
    expect(rows).toHaveLength(4)
    for (const preset of PRESET_IDS) {
      const row = rows.find((candidate) => candidate.id === preset)
      expect(row?.config['preset']).toBe(preset)
      expect(row?.config['tools']).toEqual([...PRESET_TOOLS[preset]])
    }
  })

  it('统一助手掩码是六个工具全集，历史 preset 掩码逐字不变', () => {
    // 统一 preset：全集，且顺序与 NOVEL_TOOLS 一致。
    expect([...PRESET_TOOLS['novel-assistant']]).toEqual([...NOVEL_TOOLS])
    expect(toolsForPreset('novel-assistant')).toEqual([...NOVEL_TOOLS])
    // 历史掩码：首版基线，禁止扩大。
    expect([...PRESET_TOOLS['novel-outline']]).toEqual(['get_outline', 'update_outline', 'search_bible'])
    expect([...PRESET_TOOLS['novel-chapter']]).toEqual(['get_outline', 'get_chapter', 'save_chapter_draft', 'search_bible'])
    expect([...PRESET_TOOLS['novel-bible']]).toEqual(['get_outline', 'get_chapter', 'search_bible', 'update_bible_entry'])
    expect(PRESET_IDS).toEqual([NOVEL_ASSISTANT_PRESET, ...LEGACY_NOVEL_PRESETS])
    expect(PLUGIN_PRESETS).toEqual(PRESET_IDS)
    // 历史 preset 的每一项都必须是六个已知工具之一：不允许出现"新工具被顺带加进旧 preset"。
    for (const preset of LEGACY_NOVEL_PRESETS) {
      for (const tool of PRESET_TOOLS[preset]) expect(NOVEL_TOOLS).toContain(tool)
    }
  })

  it('未知 preset 没有工具集，isNovelPreset 拒绝一切未登记值', () => {
    for (const unknown of ['novel-unknown', 'novel-assistant ', 'NOVEL-ASSISTANT', '', 'novel-assistant\n', '__proto__', 'constructor', 'toString']) {
      expect(toolsForPreset(unknown), unknown).toBeUndefined()
      expect(isNovelPreset(unknown), unknown).toBe(false)
    }
    for (const known of PRESET_IDS) {
      expect(isNovelPreset(known), known).toBe(true)
      expect(toolsForPreset(known), known).toHaveLength(PRESET_TOOLS[known].length)
    }
  })

  it('novelPresetDefinitions 暴露 id/name/description/order 与单个 plugins 行', () => {
    const definitions = novelPresetDefinitions()
    expect(definitions.map((definition) => definition.id)).toEqual([...PRESET_IDS])
    for (const preset of PRESET_IDS) {
      const definition = definitions.find((candidate) => candidate.id === preset)
      const meta = PRESET_META[preset]
      expect(definition?.name).toBe(meta.name)
      expect(definition?.description.length).toBeGreaterThan(0)
      expect(definition?.plugins).toHaveLength(1)
      expect(definition?.order).toBe(meta.order)
    }
  })

  it('提示包含不可信正文、expectedVersion 与冲突后重读，且不含凭据占位', () => {
    for (const preset of PRESET_IDS) {
      const withWork = presetPromptText(preset, 'w_123')
      const withoutWork = presetPromptText(preset, undefined)
      expect(withWork).toContain('w_123')
      expect(withWork).toContain('expectedVersion')
      expect(withWork).toContain('数据')
      expect(withWork).toContain('conflict')
      expect(withWork).not.toContain('Bearer')
      expect(withWork).not.toContain('token')
      expect(withoutWork).not.toContain('w_123')
      expect(withoutWork).toContain('没有可用的作品绑定')
    }
  })

  it('统一助手提示：自然判断任务、不谎称可创建无工具对象、先读后写', () => {
    const text = presetPromptText('novel-assistant', 'w_123')
    expect(text).toContain('用户不会也不需要在开始时选择助手类型')
    for (const task of ['大纲任务', '正文任务', '设定任务']) expect(text, task).toContain(task)
    expect(text).toContain('你只有六个工具')
    expect(text).toContain('新建作品、新建章节、新建设定条目')
    expect(text).toContain('绝不假装已经创建')
    expect(text).toContain('不要覆盖')
    expect(text).toContain('没有先读到版本就不要写')
    // 不得要求用户先做选择：提示要明确"从自然语言直接判断"。
    expect(text).toContain('用户不会也不需要在开始时选择助手类型')
    expect(text).toContain('直接从自然语言判断')
    expect(text).not.toContain('请选择')
  })

  it('参数 schema 是 strict 对象，且六个工具都有描述', () => {
    for (const tool of NOVEL_TOOLS) {
      expect(toolParameters(tool)).toMatchObject({ type: 'object', additionalProperties: false })
      expect(TOOL_DESCRIPTIONS[tool].length).toBeGreaterThan(0)
    }
  })
})
