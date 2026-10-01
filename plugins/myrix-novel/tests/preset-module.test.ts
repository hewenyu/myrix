/**
 * `plugins/myrix-novel` 的协议/装配元数据单元测试。
 *
 * 这一组不启动 Cordis（真正的作用域行为在 `plugin.test.ts`），只锁死三件
 * 容易被"重构掉"的契约：
 *   1. 三个 preset 的**默认行模块名**是 `@myrix/novel/preset-tools`
 *      （真实部署靠 profile 的 node_modules 解析它；组合测试用 `cordis:` 替身，
 *      因此这里单独断言，避免默认值被悄悄改成测试用的说明符）。
 *   2. 每个 preset 的掩码与 `PRESET_TOOLS` 完全一致（不多不少）。
 *   3. 提示文本包含安全约束（不可信正文、expectedVersion、冲突先读），
 *      且不含任何凭据占位符。
 *
 * @module tests/preset-module.test
 */
import { describe, expect, it } from 'vitest'
import { NOVEL_TOOLS, PRESET_TOOLS, TOOL_DESCRIPTIONS, toolParameters } from '../src/protocol.ts'
import { NOVEL_PRESETS, PRESET_META, PRESET_TOOLS_PLUGIN, novelPresetDefinitions, presetPromptText, presetRows } from '../src/presets.ts'

describe('preset 装配元数据', () => {
  it('默认行模块名是包名，供 profile node_modules 解析', () => {
    expect(PRESET_TOOLS_PLUGIN).toBe('@myrix/novel/preset-tools')
    for (const row of presetRows()) expect(row.name).toBe(PRESET_TOOLS_PLUGIN)
  })

  it('三个 preset 各一行，掩码与 PRESET_TOOLS 完全一致', () => {
    const rows = presetRows()
    expect(rows.map((row) => row.id)).toEqual([...NOVEL_PRESETS])
    for (const preset of NOVEL_PRESETS) {
      const row = rows.find((candidate) => candidate.id === preset)
      expect(row?.config['preset']).toBe(preset)
      expect(row?.config['tools']).toEqual([...PRESET_TOOLS[preset]])
    }
  })

  it('novelPresetDefinitions 暴露 id/name/description/order 与单个 plugins 行', () => {
    const definitions = novelPresetDefinitions()
    expect(definitions.map((definition) => definition.id)).toEqual([...NOVEL_PRESETS])
    for (const preset of NOVEL_PRESETS) {
      const definition = definitions.find((candidate) => candidate.id === preset)
      const meta = PRESET_META[preset]
      expect(definition?.name).toBe(meta.name)
      expect(definition?.description.length).toBeGreaterThan(0)
      expect(definition?.plugins).toHaveLength(1)
      expect(definition?.order).toBe(meta.order)
    }
  })

  it('提示包含不可信正文、expectedVersion 与冲突后重读，且不含凭据占位', () => {
    for (const preset of NOVEL_PRESETS) {
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

  it('参数 schema 是 strict 对象，且六个工具都有描述', () => {
    for (const tool of NOVEL_TOOLS) {
      expect(toolParameters(tool)).toMatchObject({ type: 'object', additionalProperties: false })
      expect(TOOL_DESCRIPTIONS[tool].length).toBeGreaterThan(0)
    }
  })
})
