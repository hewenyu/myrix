/**
 * `@myrix/novel/preset-tools` —— 被三个 preset 各自装载的**子插件**。
 *
 * 它只做一件事：在**当前 preset 的 scope** 里注册该助手的工具与提示段落。
 * 之所以单独成模块（而不是复用根插件的 `apply`）：
 *
 * - preset 子树由 Loader 按模块说明符装配，行的插件必须是**自包含**的；
 *   根插件的 `apply` 需要作品服务地址与凭据，那是部署级配置，不该进 preset 行。
 * - 一个模块 = 一个 Loader 插件身份；同名模块被三个 preset 装载会得到三个
 *   **独立实例**（各自的 scope、各自的 effect 生命周期），这正是我们要的：
 *   每个助手的工具注册互相不可见，dispose 一个 preset 不影响另外两个。
 *
 * 安全要点与根插件一致：身份只来自 `principals.require(exec.agent)`；
 * 提示里只注入服务端绑定的 workId；工具掩码在装配时双重校验。
 *
 * @module @myrix/novel/preset-tools
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { PrincipalRegistry } from '@myrix/principals'
import { PRESET_TOOLS, type NovelToolName } from './protocol.ts'
import { NOVEL_PRESETS, presetPromptText, type NovelPresetId } from './presets.ts'
import { assertKnownTools, defineNovelTool, principalFor } from './tools.ts'
import type { NovelStoreService } from './service.ts'

/** Loader 插件名（也是 preset 行的模块说明符基名）。 */
export const name = 'myrix-novel-preset-tools'

/** 子插件依赖：工具注册点、提示段落注册点、可信身份表、作品服务客户端。 */
export const inject = ['tools', 'systemPrompt', 'principals', 'novelStore']

/** 提示段落的排序位置：落在 persona 之后、工具说明之前。 */
export const PROMPT_ORDER = 100

/** preset 行的配置形状（由 `presets.ts` 的 `presetRows()` 生成）。 */
export interface PresetToolsConfig {
  readonly preset: NovelPresetId
  readonly tools: readonly NovelToolName[]
}

/**
 * 在 preset 作用域内装好工具与提示。
 *
 * @param presetCtx - preset 子树里的 context（scope 标签即该 preset）。
 * @param config - `{ preset, tools }`；`tools` 必须与 `PRESET_TOOLS[preset]` 完全一致。
 * @throws 当 preset 未知、工具名未知、或掩码与协议不一致（配置错误不应静默）。
 */
export function apply(presetCtx: Context, config: PresetToolsConfig): void {
  const preset = assertPreset(config.preset)
  const allowlist = config.tools
  assertKnownTools(allowlist)
  const expected: readonly NovelToolName[] = PRESET_TOOLS[preset]
  const declared = allowlist as readonly NovelToolName[]
  if (declared.length !== expected.length || declared.some((tool) => !expected.includes(tool))) {
    throw new Error(`myrix-novel: preset ${preset} 的工具掩码与协议不一致`)
  }

  const principals = presetCtx.principals as PrincipalRegistry
  const store: NovelStoreService = presetCtx.novelStore

  // 工具只在 preset scope 注册：`tools.schemas(agent)` 可见，`tools.schemas()` 不可见。
  for (const toolName of expected) {
    const definition = defineNovelTool({ store, principals }, toolName)
    presetCtx.effect(() => presetCtx.tools.register(definition), `myrix-novel: tools.register(${toolName})`)
  }

  presetCtx.effect(
    () =>
      presetCtx.systemPrompt.section({
        name: `myrix-novel:${preset}`,
        order: PROMPT_ORDER,
        // 动态文本在每次装配时求值。workId 只能来自服务端绑定；
        // 身份缺失/撤权/活性未知时渲染"没有可用绑定"，绝不猜一个作品。
        text: (assembly) => {
          let workId: string | undefined
          try {
            workId = principalFor(principals, { agent: assembly.agent }).workId
          } catch {
            workId = undefined
          }
          return presetPromptText(preset, workId)
        },
      }),
    `myrix-novel: systemPrompt.section(${preset})`,
  )
}

function assertPreset(value: unknown): NovelPresetId {
  if (typeof value !== 'string' || !NOVEL_PRESETS.some((preset) => preset === value)) {
    throw new Error(`myrix-novel: 未知的 preset ${String(value)}`)
  }
  return value as NovelPresetId
}
