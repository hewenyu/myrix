/**
 * 配置解析：全部 fail-closed，且**不提供任何"省略即宽松"的默认值**。
 *
 * 这里的每一条校验都对应一个真实的部署事故：
 *
 * - `origin` 必须是显式 HTTPS，或显式回环 HTTP。`http://works.internal` 这类
 *   内网明文地址**必须**写成 HTTPS；只有 `127.0.0.1`/`[::1]`/`localhost`
 *   允许明文，供同 Pod sidecar 或本地集成使用。
 * - 唯一例外是 `internalHttpOrigins`：装配方可以**逐项声明**同机 Docker
 *   服务名 + 端口的规范 HTTP origin（ADR 0030）。默认空列表 = 关闭；声明项
 *   无论本次是否用到都全部校验，且必须是规范 origin（不含凭据/路径/查询/
 *   fragment），只接受单标签 Docker 服务名。这不是"明文总开关"，也不放宽
 *   对外 HTTPS 要求。
 * - `token` 只能来自 Config（部署 Secret 注入），不接受环境变量回退、
 *   不接受从磁盘读第二份、不写日志。
 * - `ttlMs` 上限硬编码 30 秒；`refreshMs` 必须严格小于 `ttlMs / 2`，
 *   否则周期刷新还没走完一轮租约就过期，会让"服务正常但工具全拒"变成
 *   常态，掩盖真正的失效。
 *
 * @module @myrix/binding-lease/config
 */

/** 租约时长硬上限（毫秒）：快照最长只能被信任 30 秒。 */
export const MAX_TTL_MS = 30_000
/** 默认租约时长（毫秒）。 */
export const DEFAULT_TTL_MS = 10_000
/** 默认周期刷新间隔（毫秒）；必须 < ttlMs / 2。 */
export const DEFAULT_REFRESH_MS = 3_000
/** 单次下载超时硬上限（毫秒）。 */
export const MAX_REQUEST_TIMEOUT_MS = 10_000
/** 响应体字节上限硬上限。 */
export const MAX_RESPONSE_BYTES_CAP = 1_048_576
/** 默认响应体字节上限：10,000 行 × ~90 字节 + 元数据，留一倍余量。 */
export const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576
/** `internalHttpOrigins` 的最大声明条数（同机 Compose 服务数量级，与容器入口一致）。 */
export const MAX_INTERNAL_HTTP_ORIGINS = 16
/** 令牌最小长度：与服务端 `CellCredentialRegistry` 的 32 字符要求一致。 */
const MIN_TOKEN_LENGTH = 32

/** `apply(ctx, config)` 的原始配置。 */
export interface Config {
  /** 本 cell id；必须等于作品服务快照里的 `cellId`。 */
  cellId: string
  /** 本 cell 服务租户 id；必须等于作品服务快照里的 `tenantId`。 */
  tenantId: string
  /** 作品服务 origin，例如 `https://works.internal:8443` 或 `http://127.0.0.1:8081`。 */
  origin: string
  /**
   * 显式声明的**同机内部 HTTP origin** 白名单（ADR 0030）。
   *
   * 只用于单机 Docker Compose 部署：容器入口把
   * `MYRIX_CELL_INTERNAL_HTTP_ORIGINS` 解析出的精确 origin 原样传下来。默认
   * `[]` = 关闭，此时非回环明文 HTTP 一律拒绝。每一项都必须是规范 HTTP
   * origin（`http://<单标签服务名>:<端口>`，无凭据/路径/查询/fragment），
   * 且**全部**校验——包括本次 `origin` 没有用到的那几项；通配符、公网域名、
   * IP、多标签域名、非 HTTP 协议一律拒绝。这不是"明文总开关"。
   */
  internalHttpOrigins?: readonly string[]
  /**
   * Cell 服务 token（Config 是唯一来源）。
   *
   * 只作为 `Authorization: Bearer …` 发出；不写日志、不进诊断、不回显。
   */
  token: string
  /**
   * 快照路径模板；默认 `/internal/v1/cells/{cellId}/bindings`。
   *
   * `{cellId}` 会被 URL 编码后替换。**不允许**出现查询串或 fragment，
   * 避免把凭据或参数放进 URL（会进访问日志）。
   */
  path?: string
  /** 租约有效期（毫秒）；默认 10000，最大 30000。 */
  ttlMs?: number
  /** 周期刷新间隔（毫秒）；默认 3000，且必须严格小于 ttlMs / 2。 */
  refreshMs?: number
  /** 单次下载超时（毫秒）；默认取 min(refreshMs, 3000)，最大 10000。 */
  requestTimeoutMs?: number
  /** 响应体上限（字节）；默认 1 MiB，最大 1 MiB。 */
  maxResponseBytes?: number
  /**
   * 是否在 `agent/created`（DSH 的 **serial**、被 `await` 的事件）里同步刷新一次。
   *
   * 默认 **true**：新绑定写入控制面数据库后马上 `driver create`，周期快照还没
   * 包含它，这是唯一的创建竞态；在真正 awaited 的 hook 里刷新一次即可消除，
   * 而**不需要**放宽准入，也**不需要**改 driver。
   *
   * 设为 false 时，装配方必须自己保证在会话可执行之前调用过
   * `ctx.bindingLease.refresh()` —— 否则新会话的第一次工具调用会被拒。
   */
  refreshOnAgentCreated?: boolean
  /**
   * 是否启用**策略桥**：把同一份绑定快照里的 `policy` 字段安装进
   * `ctx.myrixPolicySnapshots`，使策略执行点不再永远拒绝（R16）。
   *
   * 默认 **false**：老装配（只有绑定活性、没有策略生产者）必须继续能启动，
   * 而且此时行为与今天完全一致 —— 工具调用仍然被策略执行点拒绝。这是刻意的：
   * 一个部署不应该因为升级插件就悄悄获得工具执行能力。
   *
   * 设为 true 时（生产 Cell 必须显式设 true）：
   * - 缺少 `ctx.myrixPolicySnapshots` 服务 → 插件**加载失败**，而不是"装了但不生效"；
   * - 快照里缺/非法 `policy` → 整个刷新 `installed:false`（提前失败，而不是只丢策略）；
   * - 策略版本回退/过期/跨租户 → 清空策略并拒绝。
   */
  requirePolicy?: boolean
}

/** 解析后的配置；只在本插件内部使用。 */
export interface ResolvedConfig {
  readonly cellId: string
  readonly tenantId: string
  /** 规范化后的 origin（含协议与端口，无路径/凭据/查询）。 */
  readonly origin: string
  /** 通过校验的同机内部 HTTP origin 声明（已去重、已规范化）；默认空数组。 */
  readonly internalHttpOrigins: readonly string[]
  readonly url: string
  readonly token: string
  readonly ttlMs: number
  readonly refreshMs: number
  readonly requestTimeoutMs: number
  readonly maxResponseBytes: number
  readonly refreshOnAgentCreated: boolean
  readonly requirePolicy: boolean
}

/** 配置非法时抛出；消息不含 token 值。 */
export class BindingLeaseConfigError extends Error {
  constructor(message: string) {
    super(`myrix-binding-lease: ${message}`)
    this.name = 'BindingLeaseConfigError'
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', '::1', 'localhost'])

/** 单标签 Docker 服务名：小写字母开头，后续小写字母/数字/连字符，最长 63 字符。 */
const INTERNAL_SERVICE_HOST = /^[a-z][a-z0-9-]{0,62}$/

/**
 * 校验一条 `internalHttpOrigins` 声明并返回规范化 origin。
 *
 * 与容器入口 `parseInternalHttpOrigins` 的语义保持一致：只接受规范 HTTP
 * origin（`url.origin === raw`），主机必须是单标签 Docker 服务名；凭据、路径
 * （含结尾 `/`）、查询串、fragment、通配符、IP、多标签域名、其它协议全部拒绝。
 * 错误信息只描述规则，不回显可能内嵌凭据的原始值。
 */
export function normalizeInternalHttpOrigin(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) {
    throw new BindingLeaseConfigError('internalHttpOrigins 的每一项都必须是非空、不超过 512 字符的字符串')
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new BindingLeaseConfigError('internalHttpOrigins 的每一项都必须是合法 URL')
  }
  if (url.protocol !== 'http:') {
    throw new BindingLeaseConfigError('internalHttpOrigins 只接受 http: 规范 origin（其余协议一律拒绝）')
  }
  // 规范 origin：`new URL()` 会把 `user:pass@`、`/path`、`?q`、`#h`、结尾 `/`
  // 归约掉，因此 `url.origin !== raw` 恰好覆盖"写法不规范/藏了东西"两类输入。
  if (url.username !== '' || url.password !== '' || url.origin !== raw) {
    throw new BindingLeaseConfigError(
      'internalHttpOrigins 的每一项都必须是规范 origin：不得内嵌凭据、路径、查询串或 fragment',
    )
  }
  if (!INTERNAL_SERVICE_HOST.test(url.hostname)) {
    throw new BindingLeaseConfigError(
      'internalHttpOrigins 只接受单标签 Docker 服务名主机（不接受通配符、IP 或多标签域名）',
    )
  }
  return url.origin
}

/**
 * 校验整个 `internalHttpOrigins` 列表（fail-closed，且即使一项没被用到也校验）。
 *
 * @param value - 配置里的原始值；`undefined` 表示关闭（返回空数组）。
 * @returns 去重后的规范化 origin 列表。
 * @throws {BindingLeaseConfigError} 当它不是字符串数组、超长或任一项非法时。
 */
export function resolveInternalHttpOrigins(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new BindingLeaseConfigError('internalHttpOrigins 必须是字符串数组')
  }
  if (value.length > MAX_INTERNAL_HTTP_ORIGINS) {
    throw new BindingLeaseConfigError(`internalHttpOrigins 最多 ${MAX_INTERNAL_HTTP_ORIGINS} 项`)
  }
  const normalized: string[] = []
  for (const entry of value) {
    const origin = normalizeInternalHttpOrigin(entry)
    if (!normalized.includes(origin)) normalized.push(origin)
  }
  return normalized
}

/**
 * 校验并规范化 origin。
 *
 * 规则：显式 `https:` 一律可以；`http:` 仅在主机是**显式回环**时允许，
 * 或在 `internalHttpOrigins` 里被**逐项声明**时允许（ADR 0030）；
 * 其余协议（file/data/ws/…）、带用户名密码、带路径/查询/fragment 的 URL 全部拒绝。
 *
 * @param raw - 配置里的 origin。
 * @param internalHttpOrigins - 已校验的同机内部 HTTP 声明；默认空（只允许回环）。
 */
export function normalizeOrigin(raw: string, internalHttpOrigins: readonly string[] = []): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new BindingLeaseConfigError('origin 不是合法 URL')
  }
  if (url.username !== '' || url.password !== '') {
    throw new BindingLeaseConfigError('origin 不得内嵌凭据')
  }
  if (url.search !== '' || url.hash !== '') {
    throw new BindingLeaseConfigError('origin 不得包含查询串或 fragment')
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new BindingLeaseConfigError(`origin 不得包含路径（收到 ${url.pathname}），路径请用 path 字段`)
  }
  if (url.protocol === 'https:') return url.origin
  if (url.protocol === 'http:') {
    if (LOOPBACK_HOSTS.has(url.hostname)) return url.origin
    // 端口不匹配、公网域名、IP、通配符都不在声明里；`includes` 是精确匹配，
    // 因此"声明了 bff:8791 却连 bff:8792"仍然拒绝。
    if (internalHttpOrigins.includes(url.origin)) return url.origin
    throw new BindingLeaseConfigError(
      `明文 HTTP 只允许显式回环地址或已声明的同机内部 origin（收到 ${url.hostname}）；内网地址必须使用 HTTPS`,
    )
  }
  throw new BindingLeaseConfigError(`origin 协议必须是 https:，或回环 http:（收到 ${url.protocol}）`)
}

/**
 * 校验路径模板并渲染出最终 URL。
 *
 * 拒绝查询串/fragment/协议相对写法，避免"配置里塞了一个外站"。
 */
export function renderPath(template: string, cellId: string): string {
  if (!template.startsWith('/')) {
    throw new BindingLeaseConfigError('path 必须以 / 开头')
  }
  if (template.includes('?') || template.includes('#')) {
    throw new BindingLeaseConfigError('path 不得包含查询串或 fragment')
  }
  if (!template.includes('{cellId}')) {
    throw new BindingLeaseConfigError('path 必须包含 {cellId} 占位符')
  }
  // 先看模板本身：替换之前就拒绝 `.`/`..` 段（替换之后再看会被编码后的
  // cellId 误伤，也会漏掉模板里真正危险的写法）。
  for (const segment of template.split('/')) {
    if (segment === '.' || segment === '..') {
      throw new BindingLeaseConfigError('path 不得包含 . 或 .. 段')
    }
  }
  const rendered = template.replaceAll('{cellId}', encodeURIComponent(cellId))
  // encodeURIComponent 不会产生 "/"，因此渲染后不应凭空多出路径段。
  if (rendered.split('/').length !== template.split('/').length) {
    throw new BindingLeaseConfigError('path 渲染后多出路径段')
  }
  return rendered
}

function requireShortString(value: unknown, field: string, max = 128): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new BindingLeaseConfigError(`配置 ${field} 缺失或非法（必须是非空、不超过 ${max} 字符的字符串）`)
  }
  return value
}

function requireSecret(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length < MIN_TOKEN_LENGTH) {
    // 刻意不回显长度或前缀：只说明要求。
    throw new BindingLeaseConfigError(`配置 ${field} 缺失或过短（至少 ${MIN_TOKEN_LENGTH} 个字符）`)
  }
  return value
}

function safeInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new BindingLeaseConfigError(`配置 ${field} 必须是 [${min}, ${max}] 内的安全整数`)
  }
  return value
}

/**
 * 解析配置；任何缺失/越界都抛错让 profile 加载失败，而不是"带着空缺运行"。
 *
 * 这是刻意的：本插件存在的唯一意义就是让 `principals` 的严格查询能放行；
 * 一个配错的租约插件如果静默启动，表现是"所有工具都拒绝"，
 * 与"没装这个插件"完全一样，却更难排查。
 */
export function resolveConfig(config: Config | undefined): ResolvedConfig {
  if (config === undefined || config === null || typeof config !== 'object') {
    throw new BindingLeaseConfigError('缺少配置对象')
  }
  const cellId = requireShortString(config.cellId, 'cellId')
  const tenantId = requireShortString(config.tenantId, 'tenantId')
  // 先把整份声明校验完，再校验本 cell 的 origin：这样"声明里混进一条非法项"
  // 永远在启动时失败，而不是因为本次没用到就被静默忽略。
  const internalHttpOrigins = resolveInternalHttpOrigins(config.internalHttpOrigins)
  const origin = normalizeOrigin(requireShortString(config.origin, 'origin', 512), internalHttpOrigins)
  const token = requireSecret(config.token, 'token')

  const ttlMs = config.ttlMs === undefined ? DEFAULT_TTL_MS : safeInt(config.ttlMs, 'ttlMs', 1_000, MAX_TTL_MS)
  const refreshMs =
    config.refreshMs === undefined ? DEFAULT_REFRESH_MS : safeInt(config.refreshMs, 'refreshMs', 100, ttlMs)
  if (refreshMs * 2 >= ttlMs) {
    throw new BindingLeaseConfigError(
      `配置 refreshMs(${refreshMs}) 必须严格小于 ttlMs/2(${Math.floor(ttlMs / 2)})，否则周期快照永远追不上租约过期`,
    )
  }

  const defaultTimeout = Math.max(100, Math.min(refreshMs, 3_000))
  const requestTimeoutMs =
    config.requestTimeoutMs === undefined
      ? defaultTimeout
      : safeInt(config.requestTimeoutMs, 'requestTimeoutMs', 100, MAX_REQUEST_TIMEOUT_MS)

  const maxResponseBytes =
    config.maxResponseBytes === undefined
      ? DEFAULT_MAX_RESPONSE_BYTES
      : safeInt(config.maxResponseBytes, 'maxResponseBytes', 1_024, MAX_RESPONSE_BYTES_CAP)

  const path = renderPath(
    config.path === undefined ? '/internal/v1/cells/{cellId}/bindings' : requireShortString(config.path, 'path', 512),
    cellId,
  )

  if (config.refreshOnAgentCreated !== undefined && typeof config.refreshOnAgentCreated !== 'boolean') {
    throw new BindingLeaseConfigError('配置 refreshOnAgentCreated 必须是布尔值')
  }
  if (config.requirePolicy !== undefined && typeof config.requirePolicy !== 'boolean') {
    throw new BindingLeaseConfigError('配置 requirePolicy 必须是布尔值')
  }

  return {
    cellId,
    tenantId,
    origin,
    internalHttpOrigins,
    url: `${origin}${path}`,
    token,
    ttlMs,
    refreshMs,
    requestTimeoutMs,
    maxResponseBytes,
    refreshOnAgentCreated: config.refreshOnAgentCreated ?? true,
    requirePolicy: config.requirePolicy ?? false,
  }
}

/**
 * 脱敏：把 token 从任意字符串里抹掉，供日志/错误信息兜底使用。
 *
 * 正常情况下我们根本不把 token 放进消息；这个函数是纵深防御，
 * 防止将来有人把上游错误文本直接拼进日志。
 */
export function redact(text: string, token: string): string {
  if (token.length === 0) return text
  return text.split(token).join('[redacted]')
}
