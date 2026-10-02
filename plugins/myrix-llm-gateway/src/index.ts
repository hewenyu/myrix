/**
 * `myrix-llm-gateway` —— Cell 侧的 LLM provider adapter（真实 Cordis function plugin）。
 *
 * 导出形状遵循 DSH 的 `packages/AGENTS.md`：具名导出 `name`/`inject`/`Config`/`apply`，
 * **没有 default export**（混用会让 Loader 丢掉命名空间）。
 *
 * 它做什么：
 * - 把 DSH 的普通对话调用与压缩/标题等辅助调用，按**会话归因**转发到
 *   `apps/model-gateway` 的 OpenAI **Responses** 端点（`POST <baseURL>/responses`）；
 * - 每次请求都带上 `Authorization: Bearer <cell 令牌>`、
 *   `x-myrix-session`、`x-myrix-revision`（拒绝时一个字节都不发）；
 * - 忠实翻译流式文本、reasoning 摘要、工具调用分片、真实 `usage`、Responses
 *   终态（completed/incomplete/failed/error），以及调用方取消。
 *
 * 它不做什么：
 * - 不做策略判定（在控制面与 `@myrix/policy-enforcer`）；
 * - 不持有上游模型密钥（只存在于模型网关进程）；
 * - 不提供绕过网关的直连路径，没有"网关不可用时的降级"，也**没有
 *   chat/completions 回退**。
 *
 * @module @myrix/llm-gateway
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PrincipalRegistry } from '@myrix/principals'
import { GatewayAdapter, type GatewayAdapterOptions } from './adapter.ts'
import { DEFAULT_PROVIDER, RESPONSES_PATH, resolveConfig, type ResolvedGatewayConfig } from './config.ts'
import type { Config, GatewayCellTokenResolver } from './types.ts'

export { GatewayAdapter } from './adapter.ts'
export type { GatewayAdapterOptions } from './adapter.ts'
export {
  DEFAULT_PROVIDER,
  MAX_INTERNAL_HTTP_ORIGINS,
  RESPONSES_PATH,
  normalizeInternalHttpOrigin,
  resolveConfig,
  resolveInternalHttpOrigins,
} from './config.ts'
export type { ResolvedGatewayConfig } from './config.ts'
export {
  StreamTranslator,
  classifyStatus,
  classifyUpstreamCode,
  encodeRequest,
  mapUsage,
  parseSse,
  parseSseBounded,
  readBounded,
  redact,
  responsesToChunks,
} from './wire.ts'
export type { Config, GatewayCellTokenResolver, GatewayRequestRecord } from './types.ts'

export const name = 'myrix-llm-gateway'

/** 缺 `llm` 或 `principals` 就不激活：两者都是强制归因的前置条件。 */
export const inject = ['llm', 'principals']

/**
 * 装配一个尚未安装的令牌解析器；返回安装函数。
 *
 * 用途：令牌常常来自 Secret 挂载或密钥管理服务，装配顺序上晚于 profile 加载。
 * 装配方先 `await ctx.plugin(plugin, config)`，再调用返回的 `set(token)`。
 * resolver 一旦安装，后续每次请求都会重新读取（令牌轮转无需重启）。
 * @param initial - 配置里已有的字面量令牌（可选）。
 * @returns 安装函数。
 */
function tokenSlot(initial: string | undefined): { resolve: GatewayCellTokenResolver; set: (token: string) => void } {
  let current = initial
  return {
    resolve: () => current,
    set: (token: string) => {
      if (typeof token !== 'string' || token.trim().length === 0) {
        throw new Error('myrix-llm-gateway: __setCellToken 需要非空令牌')
      }
      current = token
    },
  }
}

/**
 * 安装适配器。
 *
 * 启动即失败（fail-closed）：端点/令牌/模型清单/上下文容量缺失或非法都在这里抛错，
 * 让 profile 加载失败，而不是"带着空缺的归因或容量运行"。
 * @param ctx - 所属 context。
 * @param config - cordis.yml 提供的插件配置。
 * @returns 装配句柄：可注入/轮转 cell 令牌。
 */
export function apply(ctx: Context, config: Config): { setCellToken: (token: string) => void } {
  const slot = tokenSlot(config?.cellToken)
  const resolved: ResolvedGatewayConfig = resolveConfig(config, slot.resolve)

  const principals = ctx.principals as PrincipalRegistry
  const options: GatewayAdapterOptions = {
    principals,
    config: resolved,
    cellToken: slot.resolve,
  }
  const adapter = new GatewayAdapter(options)

  // 注册与卸载：通过 effect，fiber 卸载时路由自动撤销。
  ctx.effect(
    () => ctx.llm.registerAdapter([...resolved.providers], adapter),
    'myrix-llm-gateway: adapter',
  )

  ctx.logger?.info('myrix-llm-gateway 已挂载', {
    providers: resolved.providers,
    models: [...resolved.models],
    endpoint: resolved.endpoint,
    // 只报告"是否有令牌"，绝不回显令牌本身。
    credentialed: slot.resolve() !== undefined,
  })

  return { setCellToken: slot.set }
}

/** 供部署与测试引用：默认 provider route id。 */
export const DEFAULT_PROVIDERS = [DEFAULT_PROVIDER] as const
