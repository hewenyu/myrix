/**
 * Runtime Driver 的线上契约（wire contract）。
 *
 * 这些类型就是 HTTP 边界上的事实定义；`docs/implementation/runtime-driver.md`
 * 与它们必须逐字一致。**不导出任何 DSH 内部类型**，因为这份契约同时被
 * 路由（BFF/控制面）与 Go Cell 管理器消费。
 *
 * @module @myrix/runtime-driver/types
 */

/** 命令操作；与 `@myrix/grant` 的 `GrantOperation` 逐项一致。 */
export const COMMAND_OPERATIONS = ['create', 'resume', 'send', 'cancel', 'subscribe'] as const
export type CommandOperation = (typeof COMMAND_OPERATIONS)[number]

/** 驱动接受的两种传播操作（non-admin）。 */
export const WRITABLE_OPERATIONS = ['create', 'resume', 'send', 'cancel'] as const
export type WritableOperation = (typeof WRITABLE_OPERATIONS)[number]

/**
 * `POST /v1/commands` 的请求体。
 *
 * 正文是 `bh` claim 的唯一输入：路由签发凭证时对**这些原始字节**算 SHA-256，
 * 因此这里每个字段的形状都是契约的一部分，不能靠默认值补齐。
 */
export interface CommandRequest {
  /** 授权操作；必须与凭证 `op` 一致。 */
  op: CommandOperation
  /** 会话 id；必须与凭证 `sid` 一致。 */
  sid: string
  /** 用户消息正文；仅 `op=send` 出现。 */
  text?: string
  /**
   * 客户端消息 id。
   *
   * **只允许省略或等于 `commandId`**：消息 id 就是崩溃恢复对账的键，
   * 允许调用方自带一个不同的 id，等于让它绕开"按 `commandId` 回读权威日志"
   * 的幂等判定。出现但不等于 `commandId` 时驱动答 400。
   */
  messageId?: string
}

/** 命令回执状态。`accepted` 表示"已持久接收"，不表示模型已回复。 */
export type ReceiptStatus = 'accepted' | 'duplicate'

/** `POST /v1/commands` 的响应；也用于 `GET /v1/commands/:id`（未找到时 404）。 */
export interface CommandReceipt {
  status: ReceiptStatus
  commandId: string
  bootId: string
  /** 重复命令与原始命令不一致时给出原因；仅供日志与前端提示。 */
  note?: string
}

/** `GET /v1/ready` 的响应。 */
export interface ReadyResponse {
  ready: boolean
  bootId: string
  /** `ready=false` 的可读原因。 */
  reason?: string
  /** 当前是否处于 draining；drain 期间 ready 必须为 false。 */
  draining: boolean
}

/** `POST /v1/admin/drain` 的响应：`drained=true` 即空闲证明。 */
export interface DrainResponse {
  drained: boolean
  bootId: string
  /** 排空时仍然活跃的会话数（应为 0）。 */
  activeSessions: number
  /** 从收到请求到空闲的耗时（毫秒）。 */
  waitedMs: number
  reason?: string
  /**
   * `drained=false` 时的稳定机器可读拒绝码；与 cell-manager 的
   * `IdleProof` 拒绝码同一套（`ActiveTurns`/`InboxNotEmpty`/`NotFlushed`/…）。
   * 不满足的每一项都要如实给出，绝不用一个笼统的 ack 掩盖。
   */
  rejectionCode?: string
  /** 本进程现在是/曾经是只读排空状态；drain 一旦成功即 true。 */
  readOnly?: boolean
  /** 每个活跃会话的 `whenIdle` 与 inbox 检查是否都通过。 */
  noActiveTurns?: boolean
  /** 准入闸门与每会话队列是否都为空。 */
  inboxEmpty?: boolean
  /** 每个活跃会话是否都成功 `flush`（至少一个持久化监听者参与）。 */
  flushed?: boolean
  /** 本进程声明的 spec generation；未配置时不出现。 */
  generation?: number
}

/**
 * `POST /v1/admin/idle` 的响应：显式的空闲证明，字段与 cell-manager
 * `internal/driver.IdleProof` 逐项一致。
 *
 * 与 drain 的关键差别：**这是只读查询，不关闭准入**。cell-manager 先用它
 * 判断"现在缩容安不安全"，只有决定缩容时才调用 drain 关门。
 */
export interface IdleProofResponse {
  /** 本次证明的 id；用于审计与去重，不含任何会话内容。 */
  proofId: string
  bootId: string
  noActiveTurns: boolean
  inboxEmpty: boolean
  /** 每个活跃会话都成功 `flush`。没有活跃会话时为 true（没有待落盘的东西）。 */
  flushed: boolean
  /** 驱动最后一次接受命令的时刻（Unix 毫秒）。 */
  lastCommandAt: number
  /** 产生本证明的时刻（Unix 毫秒）。 */
  observedAt: number
  /** 恒为 true：本端点绝不关闭准入。 */
  readOnly: true
  reason?: string
  rejectionCode?: string
  /** 本进程声明的 spec generation；未配置时不出现。 */
  generation?: number
}

/** `POST /v1/admin/revoke` 的响应。 */
export interface RevokeResponse {
  accepted: boolean
  sid: string
  rev: number
  reason: string
  /** 被撤销时是否找到并销毁了活跃 Agent。 */
  disposed: boolean
}

/** 统一的错误响应；与 BFF 的 `{ error, reason }` 约定同源。 */
export interface ErrorResponse {
  error: string
  reason: string
  /** 稳定的机器可读细分码；不携带凭证内容。 */
  code?: string
  stage?: string
}

/** SSE 事件信封：持久事件带 `seq`，瞬态增量没有 `seq`。 */
export interface StreamEvent {
  /** 持久事件的日志序号；仅仅瞬态帧省略。 */
  seq?: number
  /** 事件种类：DSH 的 `SessionEvent.type`，或驱动自己的 `myrix/*`。 */
  type: string
  /** 事件负载（原样转发，驱动不解释）。 */
  data: unknown
  /** 服务器时间（Unix 毫秒）。 */
  time: number
}

// ---- admin 端点认证 ----

/** 签名信封校验结论；`reason` 会进 HTTP 响应，不得包含签名原文。 */
export type AdminSignatureVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

/**
 * 签名信封校验器。
 *
 * 入参是**实际收到的原始字节**与信封头；返回 `ok` 表示"控制面/cell-manager
 * 确实为这份正文签了名"。撤销与排空必须走这里或 service credential，
 * 不允许匿名。
 */
export type AdminSignatureVerifier = (
  rawBody: Buffer,
  header: string | undefined,
) => AdminSignatureVerdict

/** admin 端点的认证方式；两者都不配置时端点保留但一律 503（fail-closed）。 */
export type AdminAuth =
  | {
      /** 静态 bearer service credential。 */
      readonly kind: 'bearer'
      readonly token: string
    }
  | {
      /** 签名信封：正文与信封头一起交给外部校验器。 */
      readonly kind: 'verifier'
      readonly verify: AdminSignatureVerifier
      /** 承载信封的请求头名；默认 `x-myrix-admin-signature`。 */
      readonly header?: string
    }

/** 会话保留策略：会话日志是业务事实的来源，驱动不裁剪。 */
export interface PrincipalRecord {
  readonly sid: string
  readonly tid: string
  readonly sub: string
  readonly wid: string
  readonly preset: string
  readonly rev: number
}
