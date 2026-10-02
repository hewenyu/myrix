/**
 * `myrix-novel` —— 小说垂直业务的真实 Cordis function plugin。
 *
 * 导出形状遵循 DSH `packages/AGENTS.md`：具名导出 `name` / `inject` / `Config` / `apply`，
 * **没有 default export**（混用会让 Loader 丢掉整个命名空间）。
 *
 * ## 职责
 *
 * 1. 提供服务 `ctx.novelStore`（`NovelStoreClient`）：**唯一**对作品服务的出口。
 * 2. 注册三个 preset（`novel-outline` / `novel-chapter` / `novel-bible`）。每个
 *    preset 里只装载子插件 `@myrix/novel/preset-tools`，由它按 `PRESET_TOOLS`
 *    掩码把工具注册进**该 preset 的 scope** —— 不属于某助手的工具对该助手
 *    **不可见**，而不是"可见但被劝阻"。
 * 3. 提示段落同样只在 preset 作用域注册，文本里只注入**服务端绑定**的 workId。
 *
 * ## 安全边界（为什么这样写）
 *
 * - 身份只来自 `ToolRunContext.agent` → `principals.require(agent)`（严格路径：
 *   绑定 + 撤权 + 活性，未安装活性提供者即拒）。模型参数里的
 *   `tenantId` / `userId` / `workId` / `sessionId` / URL / 凭据一律拒绝：
 *   `protocol.ts` 的 strict 解析在 `execute` 里对 `additionalProperties:false`
 *   再校验一次（执行路径上的强制，不是说明文字）。
 * - `NovelStoreClient.call({ sessionId: principal.sid, revision: principal.rev }, ...)`
 *   只发这两个值；workId/owner/成员/当前 preset/撤权版本由作品服务在同一事务里查库核验。
 * - 系统提示**不含**凭证、token、URL 或密钥材料。
 * - 装配失败（配置非法、工具名未知、preset 重名或子树装载失败）**抛出**而不是降级。
 *
 * ## 卸载与就绪
 *
 * 所有注册都挂在 `ctx.effect()` / `ctx.provide()` 上，dispose 自动撤销。
 * `apply` 在返回前 `await` 三个 preset 的注册，因此 **`apply` resolve 即服务已就绪**：
 * `ctx.novelStore` 可读、三个 preset 已在 roster 中。装配方仍应按 DSH 的 fiber
 * 语义 `await ctx.plugin(...)`（Loader 的 `resolve` 回调即本 `apply`）。
 * 若宿主把本插件挂在 preset 子树之外的位置，`agentPresets.register()` 会在
 * 装载阶段抛错（不是静默跳过），这就是"明确 driver 挂载发现"失败的方式。
 *
 * @module @myrix/novel
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { NovelStoreClient } from './client.ts'
import { PRESET_TOOLS } from './protocol.ts'
import { NOVEL_PRESETS, novelPresetDefinitions } from './presets.ts'
import { assertKnownTools } from './tools.ts'
import type { NovelStoreService } from './service.ts'

export const name = 'myrix-novel'

/**
 * 依赖的 DSH 服务。
 *
 * - `tools` / `systemPrompt`：由 preset 子插件用来在**作用域内**注册工具与提示。
 * - `agentPresets`：三个 preset 的注册点。
 * - `principals`：可信身份来源（`@myrix/principals`）。
 *
 * 缺任何一个都不激活 —— 本插件没有"没有身份也能跑"的降级形态。
 */
export const inject = ['tools', 'systemPrompt', 'agentPresets', 'principals']

/**
 * 插件配置。
 *
 * `origin` 与 `credential` **必填**（没有默认值）：作品服务地址与 Cell 服务凭据
 * 必须由部署显式提供，避免"忘记配置 = 静默指向某个地址"。
 */
export interface Config {
  /** 作品服务 origin（`http://host:port` 或 `https://host:port`，无路径/查询/凭据）。 */
  origin: string
  /** Cell 服务凭据；只在本进程内作为 `Authorization: Bearer` 使用，不进提示、不回显。 */
  credential: string
  /** 单次工具请求超时（毫秒，100–120000）；默认 15000。 */
  timeoutMs?: number
  /** 单次工具响应体上限（字节，1024–8000000）；默认 1000000。 */
  maxResponseBytes?: number
  /**
   * 覆盖 preset 子插件的模块说明符；默认 `@myrix/novel/preset-tools`。
   * 仅供部署把子插件放到别的解析根（例如 profile 内复制后的相对名）。
   */
  presetPlugin?: string
}

/** 已注册 preset 的定义 disposer；dispose 后 roster 中不再出现该 preset。 */
export type NovelPresetDisposer = () => Promise<void>

/** 默认超时与体积上限；与 `NovelStoreClient` 的校验区间一致。 */
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000

/**
 * 安装小说垂直插件。
 *
 * @param ctx - 装配根（或 profile）context。
 * @param config - 作品服务地址、凭据与请求限制。
 * @throws 当配置缺失/非法、工具名未知、或 preset 注册被拒（重名、子树装载失败）。
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = resolveConfig(config)

  // 服务先于 preset 注册：preset 子插件的 `inject` 里就有 `novelStore`，
  // 若先注册 preset，子行会停在 pending 直到服务出现。
  const store = new NovelStoreClient(resolved)
  ctx.effect(() => ctx.provide('novelStore', store as unknown as NovelStoreService), 'myrix-novel: novelStore')

  // 工具掩码在装配时就校验：写错的工具名让进程起不来，而不是安静地少注册一个工具。
  for (const preset of NOVEL_PRESETS) assertKnownTools(PRESET_TOOLS[preset])

  const disposers: NovelPresetDisposer[] = []
  ctx.effect(() => async () => {
    // 逆序释放；registry 的 disposer 幂等。
    for (const dispose of [...disposers].reverse()) await dispose()
    disposers.length = 0
  }, 'myrix-novel: presets')

  // 三个 preset 的注册全部完成后再让 apply resolve：装配方 await 之后即可用。
  for (const definition of novelPresetDefinitions()) {
    const dispose = await ctx.agentPresets.register({
      id: definition.id,
      name: definition.name,
      description: definition.description,
      order: definition.order,
      plugins: definition.plugins.map((row) => ({
        id: row.id,
        name: resolved.presetPlugin ?? row.name,
        config: row.config,
      })),
    })
    disposers.push(dispose)
  }
}

export { NovelStoreClient } from './client.ts'
export { NOVEL_TOOLS, PRESET_TOOLS, TOOL_DESCRIPTIONS, isNovelTool, parseToolArguments, toolParameters } from './protocol.ts'
export type { NovelToolName, ToolArguments } from './protocol.ts'
export { NOVEL_PRESETS, PRESET_META, PRESET_TOOLS_PLUGIN, novelPresetDefinitions, presetPromptText, presetRows } from './presets.ts'
export type { NovelPresetDefinition, NovelPresetId, PresetRow } from './presets.ts'
export { assertKnownTools, defineNovelTool, defineNovelTools, principalFor } from './tools.ts'
export type { NovelToolDeps } from './tools.ts'
export { OUTPUT_SCHEMAS, SAVE_STATUSES, projectToolOutput } from './output.ts'
export type { SaveStatus } from './output.ts'
export type { NovelCallPrincipal, NovelStoreService } from './service.ts'
export { PROMPT_ORDER, apply as applyPresetTools } from './preset-tools.ts'
export type { PresetToolsConfig } from './preset-tools.ts'

/** 归一化并校验配置；非法输入抛错（fail-closed），不做静默兜底。 */
function resolveConfig(config: Config) {
  if (config === null || typeof config !== 'object') throw new Error('myrix-novel: 缺少插件配置')
  if (typeof config.origin !== 'string' || config.origin.length === 0) throw new Error('myrix-novel: 必须显式配置作品服务 origin')
  if (typeof config.credential !== 'string' || config.credential.length === 0) throw new Error('myrix-novel: 必须显式配置 Cell 服务凭据')
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  if (!Number.isSafeInteger(timeoutMs)) throw new Error('myrix-novel: timeoutMs 必须是整数')
  if (!Number.isSafeInteger(maxResponseBytes)) throw new Error('myrix-novel: maxResponseBytes 必须是整数')
  if (config.presetPlugin !== undefined && (typeof config.presetPlugin !== 'string' || config.presetPlugin.length === 0)) {
    throw new Error('myrix-novel: presetPlugin 必须是非空字符串')
  }
  // NovelStoreClient 自己再校验区间与 origin 形状；它抛出的错误就是装配错误。
  return { origin: config.origin, credential: config.credential, timeoutMs, maxResponseBytes, presetPlugin: config.presetPlugin }
}
