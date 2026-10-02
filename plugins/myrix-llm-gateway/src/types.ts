/**
 * `@myrix/llm-gateway` 的公开类型：插件配置、归因头、诊断记录。
 *
 * 这里只放类型；运行期装配在 `index.ts`，线协议转换在 `wire.ts`。
 *
 * @module @myrix/llm-gateway/types
 */

/**
 * Cell 服务令牌（模型网关的 `Authorization: Bearer`）的解析器。
 *
 * **同步**：解析必须是一次进程内查表或环境读取，不允许 I/O。异步取值会在
 * 每次模型调用上引入一个新的失败点，而适配器只需要一个已就绪的令牌。
 *
 * 返回 `undefined` 或空字符串 = 未配置 → 插件**启动即失败**（见 `resolveConfig`）。
 * 返回值**永远不会**进入错误信息、日志或模型上下文；网关拒绝时也只回可读原因。
 */
export type GatewayCellTokenResolver = () => string | undefined

/**
 * 插件配置（cordis.yml / patch 的 `config:` 段）。
 *
 * `baseURL`、`cellToken`（或其解析器）、`models`、`contextWindow` 缺失时插件
 * **不激活**（fail-closed），而不是"以匿名/本机假设跑起来"。
 */
export interface Config {
  /**
   * 模型网关的 **origin**（可带路径前缀，例如 `https://gw.acme.example/v1`）。
   * 适配器会自己追加 `/responses`，因此**不要**写完整端点，也不要指向
   * `chat/completions`（本仓库禁止该协议，配置成它会启动失败）。只允许
   * http(s)；非 loopback 的 http 会被拒绝（明文承载 cell 令牌），除非其
   * origin 被 `internalHttpOrigins` 逐项声明（ADR 0030）。
   */
  baseURL: string
  /**
   * 显式声明的**同机内部 HTTP origin** 白名单（ADR 0030）。
   *
   * 只用于单机 Docker Compose 部署：容器入口把
   * `MYRIX_CELL_INTERNAL_HTTP_ORIGINS` 解析出的精确 origin 原样传下来。默认
   * `[]` = 关闭，此时非回环明文 HTTP 一律拒绝。每一项都必须是规范 HTTP
   * origin（`http://<单标签服务名>:<端口>`，无凭据/路径/查询/fragment），
   * 且**全部**校验——包括本次 `baseURL` 没有用到的那几项；通配符、公网域名、
   * IP、多标签域名、非 HTTP 协议一律拒绝。这不是"明文总开关"。
   */
  internalHttpOrigins?: readonly string[]
  /**
   * Cell 服务令牌。可以给字面量（由 `!!js` 从环境读取），也可以由装配方在
   * 加载后调用 `__setCellToken()` 注入。**不要**把令牌写进 cordis.yml。
   */
  cellToken?: string
  /**
   * 注册到 DSH 的 provider route id 列表；缺省 `['myrix-gateway']`。
   * 这些 id 会出现在会话的 `request/header` 与 `GenerateOptions.provider` 里。
   */
  providers?: readonly string[]
  /**
   * 允许的模型名清单（同时作为 `listModels()` 的目录）。**不允许为空**：
   * 空清单表示"没有允许项"，此时任何请求都被拒绝 —— 这是刻意的。
   */
  models?: readonly string[]
  /** 单个模型 id 是否被允许；给定后优先于 `models` 的静态集合。 */
  isModelAllowed?: (model: string) => boolean
  /**
   * 未在 `modelContextWindows` 里单独指定的模型的上下文容量（token）。
   * **必填**：`dsh-compaction-basic` 在 `resolveModel().context` 缺失时直接抛错，
   * 适配器不为部署猜容量。
   */
  contextWindow?: number
  /** 按模型覆盖上下文容量；未列出的模型用 `contextWindow`。 */
  modelContextWindows?: Readonly<Record<string, number>>
  /** 请求头名：会话归因（默认 `x-myrix-session`，与网关一致）。 */
  sessionHeader?: string
  /** 请求头名：撤权版本（默认 `x-myrix-revision`，与网关一致）。 */
  revisionHeader?: string
  /** 请求头名：辅助调用分类（默认 `x-myrix-purpose`）。 */
  purposeHeader?: string
  /** 请求头名：本适配器归属的租户（默认 `x-myrix-cell-tenant`，仅诊断用）。 */
  tenantHeader?: string
  /** 上游模型名映射；未列出的模型按同名转发。 */
  modelAliases?: Readonly<Record<string, string>>
  /** 整次请求（含流式读取）的超时毫秒数，默认 600000；超时产生 `TIMEOUT`。 */
  requestTimeoutMs?: number
  /**
   * 空闲看门狗（毫秒），默认 60000：两次上游 SSE 事件之间的最长间隔，
   * 超过即中止读取并产生 `TIMEOUT`（防止"连上了但永不说话"）。
   */
  streamIdleTimeoutMs?: number
  /** 非流式响应体的字节上限，默认 8 MiB；超过按 `TRANSPORT` 失败。 */
  maxResponseBytes?: number
  /** 单次请求的 `max_output_tokens` 默认值；未配置且调用方也没给时不发送该字段。 */
  defaultMaxTokens?: number
  /**
   * 是否给 function 工具声明加 `strict: true`。默认 `false`（不发该字段），
   * 因为网关/上游不一定支持严格模式；开启前需确认上游能力。
   */
  toolStrict?: boolean
  /** 诊断：结构化记录每次网关请求（不含正文、令牌、提示词）。 */
  onRequest?: (record: GatewayRequestRecord) => void
}

/** 诊断记录：只有可安全外发的元数据。 */
export interface GatewayRequestRecord {
  readonly provider: string
  readonly model: string
  /** 转发给网关的上游模型名（别名解析后）。 */
  readonly upstreamModel: string
  /** 已归因到的会话 id；无归因的请求不会走到这里。 */
  readonly sessionId: string
  readonly revision: number
  readonly tenantId: string
  /** `'compaction'` / `'session-title'`；普通对话为 `undefined`。 */
  readonly purpose?: 'compaction' | 'session-title'
  readonly stream: boolean
  readonly status: number
  /** 网关 `x-request-id`（若有）。 */
  readonly requestId?: string
  readonly latencyMs: number
}
