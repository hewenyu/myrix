/**
 * 配置解析与**启动即失败**的 fail-closed 校验。
 *
 * 规则（AGENTS.md 硬性规则 1）：
 * * 缺 `baseURL`、缺 cell 令牌、缺模型清单/上下文容量、端点不是 http(s)
 *   或非 loopback 的明文 http → 抛错，插件不激活。
 *   **绝不**退化成"直连上游"、"无鉴权调用"或"猜一个上下文窗口"。
 * * 唯一例外是 `internalHttpOrigins`：装配方可以逐项声明同机 Docker 服务名 +
 *   端口的规范 HTTP origin（ADR 0030）。默认空列表 = 关闭；声明项无论是否被
 *   本次 `baseURL` 用到都全部校验。这不是"明文总开关"。
 * * 端点必须是**网关 origin**（可带 `/v1` 之类的路径前缀），适配器自己追加
 *   `/responses`；写死 `chat/completions` 的旧配置在这里被显式拒绝。
 * * 缺会话归因 / 模型不在清单的请求在运行期拒绝（见 `adapter.ts`）。
 *
 * @module @myrix/llm-gateway/config
 */

import type { Config, GatewayCellTokenResolver, GatewayRequestRecord } from './types.ts'

/** 解析后的运行期配置。 */
export interface ResolvedGatewayConfig {
  /** 网关 origin（可带路径前缀，例如 `https://gw.internal/v1`）。 */
  readonly baseURL: string
  /** 通过校验的同机内部 HTTP origin 声明（已去重、已规范化）；默认空数组。 */
  readonly internalHttpOrigins: readonly string[]
  /** 实际请求的 Responses 端点（`baseURL` + `/responses`）。 */
  readonly endpoint: string
  readonly providers: readonly string[]
  readonly models: ReadonlySet<string>
  readonly isModelAllowed?: (model: string) => boolean
  readonly contextWindows: ReadonlyMap<string, number>
  readonly sessionHeader: string
  readonly revisionHeader: string
  readonly purposeHeader: string
  readonly tenantHeader: string
  readonly modelAliases: Readonly<Record<string, string>>
  readonly requestTimeoutMs: number
  readonly streamIdleTimeoutMs: number
  readonly maxResponseBytes: number
  readonly defaultMaxTokens?: number
  /** 是否给 function 工具声明加 `strict: true`（网关/上游支持时才开）。 */
  readonly toolStrict: boolean
  readonly onRequest?: (record: GatewayRequestRecord) => void
}

/** 默认的 provider route id。DSH 会话 header 与配置面板都会显示这个名字。 */
export const DEFAULT_PROVIDER = 'myrix-gateway'

/** Responses 端点相对 `baseURL` 的固定后缀。 */
export const RESPONSES_PATH = '/responses'

const DEFAULT_REQUEST_TIMEOUT_MS = 600_000
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
/** `internalHttpOrigins` 的最大声明条数（与容器入口保持一致）。 */
export const MAX_INTERNAL_HTTP_ORIGINS = 16
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '[::1]'])
/** 单标签 Docker 服务名：小写字母开头，后续小写字母/数字/连字符，最长 63 字符。 */
const INTERNAL_SERVICE_HOST = /^[a-z][a-z0-9-]{0,62}$/

/**
 * 校验并规范化一条同机内部 HTTP origin 声明。
 *
 * 语义与容器入口 `parseInternalHttpOrigins` 及 `@myrix/binding-lease` 的同名
 * 校验保持一致：只接受规范 HTTP origin（`url.origin === raw`），主机必须是
 * 单标签 Docker 服务名；凭据、路径（含结尾 `/`）、查询串、fragment、通配符、
 * IP、多标签域名、其它协议全部拒绝。错误信息不回显原始值。
 */
export function normalizeInternalHttpOrigin(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) {
    throw new Error('myrix-llm-gateway: 配置 internalHttpOrigins 的每一项都必须是非空、不超过 512 字符的字符串')
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('myrix-llm-gateway: 配置 internalHttpOrigins 的每一项都必须是合法 URL')
  }
  if (url.protocol !== 'http:') {
    throw new Error('myrix-llm-gateway: 配置 internalHttpOrigins 只接受 http: 规范 origin')
  }
  if (url.username !== '' || url.password !== '' || url.origin !== raw) {
    throw new Error(
      'myrix-llm-gateway: 配置 internalHttpOrigins 的每一项都必须是规范 origin：'
      + '不得内嵌凭据、路径、查询串或 fragment',
    )
  }
  if (!INTERNAL_SERVICE_HOST.test(url.hostname)) {
    throw new Error(
      'myrix-llm-gateway: 配置 internalHttpOrigins 只接受单标签 Docker 服务名主机'
      + '（不接受通配符、IP 或多标签域名）',
    )
  }
  return url.origin
}

/**
 * 校验整个 `internalHttpOrigins` 列表（fail-closed，且未用到的项也校验）。
 *
 * @param value - 配置里的原始值；`undefined` 表示关闭（返回空数组）。
 * @returns 去重后的规范化 origin 列表。
 */
export function resolveInternalHttpOrigins(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new Error('myrix-llm-gateway: 配置 internalHttpOrigins 必须是字符串数组')
  }
  if (value.length > MAX_INTERNAL_HTTP_ORIGINS) {
    throw new Error(`myrix-llm-gateway: 配置 internalHttpOrigins 最多 ${MAX_INTERNAL_HTTP_ORIGINS} 项`)
  }
  const normalized: string[] = []
  for (const entry of value) {
    const origin = normalizeInternalHttpOrigin(entry)
    if (!normalized.includes(origin)) normalized.push(origin)
  }
  return normalized
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`myrix-llm-gateway: 配置 ${field} 缺失或为空`)
  }
  return value.trim()
}

/**
 * 解析网关 origin 并拼出 Responses 端点。
 *
 * `baseURL` 是**网关 origin**（例如 `https://gw.acme.example/v1`），适配器追加
 * `/responses`。旧配置里的完整 `…/v1/chat/completions` 会被显式拒绝：本仓库
 * 禁止 chat/completions 协议，不做静默改写。
 *
 * 明文 `http:` 只在 loopback，或 `url.origin` 被 `internalHttpOrigins` **逐项
 * 精确声明**时允许（ADR 0030）；端口不匹配仍然拒绝。
 */
function resolveEndpoint(raw: unknown, internalHttpOrigins: readonly string[]): { baseURL: string; endpoint: string } {
  const value = nonEmpty(raw, 'baseURL')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('myrix-llm-gateway: 配置 baseURL 不是合法 URL')
  }
  if (url.search.length > 0 || url.hash.length > 0 || url.username.length > 0 || url.password.length > 0) {
    throw new Error('myrix-llm-gateway: 配置 baseURL 不能带凭据、查询串或片段')
  }
  if (url.protocol !== 'https:'
    && !(url.protocol === 'http:'
      && (LOOPBACK_HOSTS.has(url.hostname) || internalHttpOrigins.includes(url.origin)))) {
    throw new Error(
      'myrix-llm-gateway: 配置 baseURL 必须是 https（仅 loopback 或已声明的同机内部 origin 允许 http）；'
      + 'cell 令牌不能走明文通道',
    )
  }
  const path = url.pathname.replace(/\/+$/, '')
  if (path.endsWith('/chat/completions') || path.endsWith('/completions')) {
    throw new Error(
      'myrix-llm-gateway: 配置 baseURL 指向 chat/completions；本适配器只使用 OpenAI Responses'
      + `（网关 origin + ${RESPONSES_PATH}），不做协议回退`,
    )
  }
  if (path.endsWith(RESPONSES_PATH)) {
    throw new Error(
      `myrix-llm-gateway: 配置 baseURL 请给网关 origin（例如 https://gw.internal/v1），`
      + `适配器会自己追加 ${RESPONSES_PATH}；不要写完整端点`,
    )
  }
  const origin = `${url.origin}${path}`
  return { baseURL: origin, endpoint: `${origin}${RESPONSES_PATH}` }
}

function positiveInt(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`myrix-llm-gateway: 配置 ${field} 必须是正整数`)
  }
  return value
}

/** 允许 `0` 表示"关闭"的非负整数（空闲看门狗用）。 */
function nonNegativeInt(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`myrix-llm-gateway: 配置 ${field} 必须是非负整数（0 表示关闭）`)
  }
  return value
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`myrix-llm-gateway: 配置 ${field} 必须是字符串数组`)
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new Error(`myrix-llm-gateway: 配置 ${field}[${String(index)}] 必须是非空字符串`)
    }
    return entry.trim()
  })
}

function headerName(value: unknown, field: string, fallback: string): string {
  if (value === undefined) return fallback
  const name = nonEmpty(value, field).toLowerCase()
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new Error(`myrix-llm-gateway: 配置 ${field} 不是合法的 HTTP 头名`)
  }
  return name
}

/**
 * 解析并校验插件配置。
 * @param config - cordis.yml 提供的原始配置。
 * @param resolveToken - cell 令牌解析器（同步）；用于启动时断言令牌存在。
 * @returns 运行期配置。
 * @throws 当端点、令牌、模型清单或上下文容量缺失/非法时。
 */
export function resolveConfig(
  config: Config,
  resolveToken: GatewayCellTokenResolver,
): ResolvedGatewayConfig {
  if (config === null || typeof config !== 'object') {
    throw new Error('myrix-llm-gateway: 缺少插件配置')
  }
  // 先校验整份声明，再解析端点：非法声明不能因为本次没被用到就蒙混过关。
  const internalHttpOrigins = resolveInternalHttpOrigins(config.internalHttpOrigins)
  const { baseURL, endpoint } = resolveEndpoint(config.baseURL, internalHttpOrigins)

  // 令牌存在性是**启动条件**：没有它就只会在第一次模型调用上失败，
  // 而那时的错误会以"模型不可用"的面貌出现，掩盖真正的部署错误。
  const token = resolveToken()
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new Error(
      'myrix-llm-gateway: 没有可用的 cell 服务令牌（配置 cellToken 或加载后调用 __setCellToken）；'
      + '模型网关不接受无凭据调用，拒绝启动',
    )
  }

  const providers = stringList(config.providers, 'providers')
  const resolvedProviders = providers.length === 0 ? [DEFAULT_PROVIDER] : providers
  if (new Set(resolvedProviders).size !== resolvedProviders.length) {
    throw new Error('myrix-llm-gateway: 配置 providers 不能包含重复项')
  }

  const models = stringList(config.models, 'models')
  if (models.length === 0) {
    throw new Error(
      'myrix-llm-gateway: 配置 models 为空；网关的模型清单必须由部署显式给定，适配器不提供默认模型',
    )
  }
  if (new Set(models).size !== models.length) {
    throw new Error('myrix-llm-gateway: 配置 models 不能包含重复项')
  }

  // 上下文容量是 DSH 的硬需求：`dsh-compaction-basic` 在没有
  // `resolveModel().context` 时直接抛 `TargetPressureConfigError`（见
  // compaction-basic/src/index.ts）。所以它也是启动条件，而不是运行期回退。
  const wide = positiveInt(config.contextWindow, 'contextWindow', 0)
  if (wide === 0) {
    throw new Error(
      'myrix-llm-gateway: 配置 contextWindow 缺失；DSH 的压缩需要每个模型的确切上下文容量，'
      + '适配器不会猜一个默认值',
    )
  }
  const contextWindows = new Map<string, number>()
  for (const [model, value] of Object.entries(config.modelContextWindows ?? {})) {
    contextWindows.set(nonEmpty(model, 'modelContextWindows 的键'), positiveInt(value, `modelContextWindows["${model}"]`, 0) || wide)
  }
  for (const model of models) {
    if (!contextWindows.has(model)) contextWindows.set(model, wide)
  }

  const modelAliases: Record<string, string> = {}
  for (const [from, to] of Object.entries(config.modelAliases ?? {})) {
    modelAliases[nonEmpty(from, 'modelAliases 的键')] = nonEmpty(to, `modelAliases["${from}"]`)
  }

  if (config.onRequest !== undefined && typeof config.onRequest !== 'function') {
    throw new Error('myrix-llm-gateway: 配置 onRequest 必须是函数')
  }

  return {
    baseURL,
    internalHttpOrigins,
    endpoint,
    providers: resolvedProviders,
    models: new Set(models),
    ...config.isModelAllowed === undefined ? {} : { isModelAllowed: config.isModelAllowed },
    contextWindows,
    sessionHeader: headerName(config.sessionHeader, 'sessionHeader', 'x-myrix-session'),
    revisionHeader: headerName(config.revisionHeader, 'revisionHeader', 'x-myrix-revision'),
    purposeHeader: headerName(config.purposeHeader, 'purposeHeader', 'x-myrix-purpose'),
    tenantHeader: headerName(config.tenantHeader, 'tenantHeader', 'x-myrix-cell-tenant'),
    modelAliases,
    requestTimeoutMs: positiveInt(config.requestTimeoutMs, 'requestTimeoutMs', DEFAULT_REQUEST_TIMEOUT_MS),
    streamIdleTimeoutMs: nonNegativeInt(
      config.streamIdleTimeoutMs,
      'streamIdleTimeoutMs',
      DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    ),
    maxResponseBytes: positiveInt(config.maxResponseBytes, 'maxResponseBytes', DEFAULT_MAX_RESPONSE_BYTES),
    ...config.defaultMaxTokens === undefined
      ? {}
      : { defaultMaxTokens: positiveInt(config.defaultMaxTokens, 'defaultMaxTokens', 1) },
    toolStrict: config.toolStrict === true,
    ...config.onRequest === undefined ? {} : { onRequest: config.onRequest },
  }
}
