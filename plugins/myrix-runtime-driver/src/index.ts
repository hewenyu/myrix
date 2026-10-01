/**
 * `myrix-runtime-driver` —— Cell 内的运行时驱动（真实 Cordis function plugin）。
 *
 * 导出形状遵循 DSH 的 `packages/AGENTS.md`：具名导出 `name`/`inject`/`Config`/`apply`，
 * **没有 default export**（混用会让 Loader 丢掉命名空间）。
 *
 * 职责边界（platform-plan-v2 §2.1 / tech-design-v1 §4.1）：
 * - 校验控制面签发的授权凭证，并把身份安装进 Agent 的 setup 事务。
 * - 暴露固定的 6 个 HTTP 端点给会话路由与 Cell 管理器。
 * - 撤权、排空、事件流续传的执行点。
 *
 * **不做的事**：不做策略判定（在 `packages/governance`）、不持有权威绑定
 * （在控制面数据库）、不裁剪会话日志（业务事实的来源）。
 *
 * @module @myrix/runtime-driver
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentSetup, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
// 类型侧导入：只为拉入 webserver 与 preset-registry 对 Context 的模块增强。
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { MessageId, freezeMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { PrincipalRegistry } from '@myrix/principals'
import { createGrantVerifier, type GrantVerifier, type GrantPublicJwk } from '@myrix/grant'
import {
  SessionController,
  type AgentPort,
  type PersistedUserMessagePort,
  type RuntimePorts,
  type SessionPort,
} from './controller'
import { EventHub } from './events'
import { createRouter, type AdminAuth, type Router } from './router'
import type { StreamEvent } from './types'

export { SessionController, CommandError, IdleRejection, subscribeCommandId, receiptCommandId } from './controller'
export type { DrainResult, IdleProofResult, PersistedSessionPort, PersistedUserMessagePort } from './controller'
export { AdmissionGate, GateClosedError } from './gate'
export { ReceiptStore } from './receipts'
export { EventHub } from './events'
export { createRouter, DRIVER_ENDPOINTS } from './router'
export {
  DEFAULT_SSE_MAX_BUFFERED_BYTES,
  EMPTY_BODY_SHA256,
  MAX_BODY_BYTES,
  encodeSseFrame,
  parseJsonObject,
  parseLastEventId,
  readRawBody,
  sha256Hex,
  sseSink,
} from './http'
export type {
  AdminAuth,
  AdminSignatureVerifier,
  CommandReceipt,
  CommandRequest,
  DrainResponse,
  ErrorResponse,
  IdleProofResponse,
  ReadyResponse,
  RevokeResponse,
} from './types'

export const name = 'myrix-runtime-driver'

/**
 * 依赖的 DSH 服务。`principals` 由 `@myrix/principals` 提供；
 * 缺任何一个都不激活 —— 驱动不能在没有身份表的情况下"先跑起来"。
 *
 * `sessionPersistence` 同样是硬依赖：没有持久化后端时 `resume` 直接抛错、
 * `create` 的 flush 必然没有监听者参与，而"已接受到底承诺了什么"必须能被证明。
 * 缺它时驱动宁可不在，也不要一个无法对账的驱动器。
 *
 * `bindingLease`（`@myrix/binding-lease`）**刻意不在 inject 里**：它是可选适配器，
 * 存在与否只改变"打开前是否多刷新一次身份"，不改变任何准入判定。
 */
export const inject = ['webServer', 'agents', 'sessions', 'agentPresets', 'principals', 'sessionPersistence']

/**
 * 驱动配置。
 *
 * 所有 fail-closed 相关的字段都是**必填**：没有 cellId/tenantId 就没有 aud/tid
 * 校验依据，没有 keys 就没有验签依据，此时驱动器应拒绝启动而不是默认放行。
 */
export interface Config {
  /** 本 cell id；必须等于凭证 `aud`。 */
  cellId: string
  /** 本 cell 租户 id；必须等于凭证 `tenantId`/`tid`。 */
  tenantId: string
  /** 控制面签发方；必须等于凭证 `iss`。 */
  issuer: string
  /** 已安装的验签公钥（JWKS 形态）。空集合 = 拒绝一切命令。 */
  keys: readonly GrantPublicJwk[]
  /**
   * 模型 provider route id（例：`myrix-gateway`），**必填**。
   *
   * 与 `defaultModel` 一起作为 `agentOptions` 传给真实的
   * `ctx.agents.create/resume`。驱动的会话是**按凭证动态创建**的，没有
   * 声明式 Agent 可以承载 provider/model；而 pinned vendor 的 agent loop
   * 在没有 `AgentOptions.provider` + `AgentOptions.model`、且没有
   * `agent/request` waterfall 时**直接抛错**
   * （`dsh-agent-loop`：`agent "…" has no provider/model`）。因此这两项不能靠
   * 默认值猜：不配就拒绝启动，而不是让每个会话在第一次模型请求时失败。
   *
   * 该名字必须与 `myrix-llm-gateway` 的 `providers` 配置一致（默认
   * `myrix-gateway`）。
   */
  defaultProvider: string
  /** 模型 id（由 provider adapter 解释）；必填，与 `defaultProvider` 同时给出。 */
  defaultModel: string
  /** 正文大小上限（字节）；默认 1 MiB。 */
  maxBodyBytes?: number
  /** 事件流心跳间隔（毫秒）；默认 15000，0 表示关闭。 */
  heartbeatMs?: number
  /** SSE 重放窗口（条）；默认 2048。 */
  replayWindow?: number
  /**
   * SSE 单连接允许积压的最大字节数；默认 1 MiB。
   *
   * 超过即断开连接、由客户端带 `Last-Event-ID` 重放。不让 `res.write`
   * 的缓冲无限增长（一个不读的客户端就能吃光进程内存）。
   */
  sseMaxBufferedBytes?: number
  /**
   * 本 cell 的 spec generation（TenantCell `metadata.generation`）。
   *
   * 驱动运行在 Pod 里，看不到 K8s 对象；cell-manager 的当前契约也不校验它。
   * 因此这是**显式声明才发出**的前向一致性字段：不配就不出现在 drain/idle
   * 响应里，绝不猜一个值让管理器误以为证明属于当前 generation。
   */
  generation?: number
  /** drain 的 service credential；与 `drainSignatureVerifier` 二选一。 */
  drainToken?: string
  /** revoke 的 service credential；与 `revokeSignatureVerifier` 二选一。 */
  revokeToken?: string
  /** drain 的签名信封校验器（控制面/cell-manager 签名）。 */
  drainSignatureVerifier?: AdminAuth extends { kind: 'verifier'; verify: infer V } ? V : never
  /** revoke 的签名信封校验器。 */
  revokeSignatureVerifier?: AdminAuth extends { kind: 'verifier'; verify: infer V } ? V : never
}

/**
 * 安装驱动。
 *
 * 启动即失败（fail-closed）：配置缺失、公钥集合非法、没有 admin 认证来源，
 * 都在这里抛错，让 profile 加载失败而不是"带着空缺的校验器运行"。
 */
export function apply(ctx: Context, config: Config): void {
  const cfg = resolveConfig(config)
  const bootId = randomUUID()
  const startedAt = Math.floor(Date.now() / 1000)

  const verifier: GrantVerifier = createGrantVerifier({
    audience: cfg.cellId,
    tenantId: cfg.tenantId,
    bootId,
    startedAt,
    issuer: cfg.issuer,
    keys: cfg.keys,
  })

  const principals = ctx.principals as PrincipalRegistry
  const hub = new EventHub(cfg.replayWindow)
  const ports = createPorts(ctx, { provider: cfg.defaultProvider, model: cfg.defaultModel })
  const controller = new SessionController(ports, createHost(principals), verifier, bootId)

  // 事件流的历史：从 DSH 的权威会话日志读取，而不是从我们自己的缓冲。
  hub.setHistoryProvider((sid) => historyOf(ctx, sid))

  // 持久事件：`session/event` 是 post-commit 的通知，带 seq，可续传。
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    hub.publishDurable(String(session.id), {
      seq: Number(event.seq),
      type: event.type,
      data: event.data,
      time: event.time,
    })
  })

  // 瞬态帧：process-local 的 assistant 流增量，无 seq，断线不补。
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    hub.publishTransient(String(agent.id), {
      type: 'myrix/assistant-stream',
      data: frame,
      time: Date.now(),
    })
  })

  // 会话销毁：丢掉重放缓冲并关闭订阅，避免向已结束的会话继续补发。
  ctx.on('session/disposed', (session: Session) => {
    const sid = String(session.id)
    hub.closeSession(sid)
    hub.dropSession(sid)
  })

  const router: Router = createRouter(controller, hub, {
    tenantId: cfg.tenantId,
    bootId,
    ...(cfg.generation === undefined ? {} : { generation: cfg.generation }),
    ...(cfg.sseMaxBufferedBytes === undefined ? {} : { sseMaxBufferedBytes: cfg.sseMaxBufferedBytes }),
    ...(cfg.maxBodyBytes === undefined ? {} : { maxBodyBytes: cfg.maxBodyBytes }),
    ...(cfg.heartbeatMs === undefined ? {} : { heartbeatMs: cfg.heartbeatMs }),
    ...(cfg.drainAuth === undefined ? {} : { drainAuth: cfg.drainAuth }),
    ...(cfg.revokeAuth === undefined ? {} : { revokeAuth: cfg.revokeAuth }),
  })

  // 路由注册与卸载：全部通过 effect，fiber 卸载时自动反注册。
  ctx.effect(() => {
    const disposers = router.routes.map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
      router.dispose()
    }
  }, 'myrix-runtime-driver: routes')

  // 卸载：先关准入，再销毁活跃 Agent。错误已在控制器内部收敛。
  ctx.effect(
    () => () => {
      void controller.shutdown().catch((error: unknown) => {
        ctx.logger?.warn(
          `myrix-runtime-driver: shutdown 未完全成功：${error instanceof Error ? error.message : 'unknown'}`,
        )
      })
    },
    'myrix-runtime-driver: shutdown',
  )

  ctx.logger?.info('myrix-runtime-driver 已挂载', {
    cellId: cfg.cellId,
    tenantId: cfg.tenantId,
    bootId,
    endpoints: router.routes.length,
    drainAuth: cfg.drainAuth === undefined ? 'missing' : cfg.drainAuth.kind,
    revokeAuth: cfg.revokeAuth === undefined ? 'missing' : cfg.revokeAuth.kind,
  })
}

// ---- 配置解析（fail-closed） ----

interface ResolvedConfig {
  readonly cellId: string
  readonly tenantId: string
  readonly issuer: string
  readonly keys: readonly GrantPublicJwk[]
  readonly defaultProvider: string
  readonly defaultModel: string
  readonly maxBodyBytes?: number
  readonly heartbeatMs?: number
  readonly replayWindow?: number
  readonly sseMaxBufferedBytes?: number
  readonly generation?: number
  readonly drainAuth?: AdminAuth
  readonly revokeAuth?: AdminAuth
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new Error(`myrix-runtime-driver: 配置 ${field} 缺失或非法（必须是非空短字符串）`)
  }
  return value
}

function resolveConfig(config: Config): ResolvedConfig {
  const cellId = requireNonEmpty(config?.cellId, 'cellId')
  const tenantId = requireNonEmpty(config?.tenantId, 'tenantId')
  const issuer = requireNonEmpty(config?.issuer, 'issuer')
  const keys = config?.keys
  if (!Array.isArray(keys) || keys.length === 0) {
    // 空公钥集合会让 verifier 构造失败，但这里给出更贴近部署的错误信息。
    throw new Error('myrix-runtime-driver: 配置 keys 为空，拒绝启动（拉不到 JWKS 就是拒绝一切命令）')
  }
  const maxBodyBytes = positiveInt(config.maxBodyBytes, 'maxBodyBytes')
  const heartbeatMs = nonNegativeInt(config.heartbeatMs, 'heartbeatMs')
  const replayWindow = positiveInt(config.replayWindow, 'replayWindow')
  const sseMaxBufferedBytes = positiveInt(config.sseMaxBufferedBytes, 'sseMaxBufferedBytes')
  // generation 允许为 0（K8s 的 metadata.generation 从 1 起，但 0 是合法声明）。
  const generation = nonNegativeInt(config.generation, 'generation')

  const drainAuth = resolveAdminAuth(config.drainToken, config.drainSignatureVerifier, 'drain')
  const revokeAuth = resolveAdminAuth(config.revokeToken, config.revokeSignatureVerifier, 'revoke')

  // provider/model 是真实 agents.create/resume 的必要输入：缺任何一个都
  // 让每个新会话在第一次模型请求时才失败，因此在这里（启动期）拒绝。
  const defaultProvider = requireNonEmpty(config?.defaultProvider, 'defaultProvider')
  const defaultModel = requireNonEmpty(config?.defaultModel, 'defaultModel')

  return {
    cellId,
    tenantId,
    issuer,
    keys,
    defaultProvider,
    defaultModel,
    ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
    ...(heartbeatMs === undefined ? {} : { heartbeatMs }),
    ...(replayWindow === undefined ? {} : { replayWindow }),
    ...(sseMaxBufferedBytes === undefined ? {} : { sseMaxBufferedBytes }),
    ...(generation === undefined ? {} : { generation }),
    ...(drainAuth === undefined ? {} : { drainAuth }),
    ...(revokeAuth === undefined ? {} : { revokeAuth }),
  }
}

function positiveInt(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`myrix-runtime-driver: 配置 ${field} 必须是正整数`)
  }
  return value
}

function nonNegativeInt(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`myrix-runtime-driver: 配置 ${field} 必须是非负整数`)
  }
  return value
}

function resolveAdminAuth(
  token: unknown,
  verifier: unknown,
  endpoint: 'drain' | 'revoke',
): AdminAuth | undefined {
  if (token !== undefined && verifier !== undefined) {
    throw new Error(`myrix-runtime-driver: ${endpoint} 同时配置了 token 与签名校验器，请二选一`)
  }
  if (typeof token === 'string' && token.length > 0) {
    return { kind: 'bearer', token }
  }
  if (verifier !== undefined) {
    if (typeof verifier !== 'function') {
      throw new Error(`myrix-runtime-driver: ${endpoint} 的签名校验器必须是函数`)
    }
    return { kind: 'verifier', verify: verifier as Extract<AdminAuth, { kind: 'verifier' }>['verify'] }
  }
  // 未配置：端点保留但一律 503。这是刻意的 fail-closed —— 不允许匿名 admin。
  return undefined
}

// ---- DSH 端口实现 ----

/**
 * 本 cell 的默认模型路由；来自 Config 的 `defaultProvider`/`defaultModel`。
 *
 * 它必须一起传给真实的 `ctx.agents.create/resume`：pinned vendor 的
 * agent loop 在没有这对值时（且没有 `agent/request` waterfall）会拒绝发起
 * 模型请求。驱动**不**注册 waterfall 来补这个值 —— 那是测试专用接缝，
 * 不能当作生产方案（见 `bundles/myrix-base/cell.patch.yml` 的 route seam）。
 */
export interface DriverAgentOptions {
  readonly provider: string
  readonly model: string
}

function createPorts(ctx: Context, agentOptions: DriverAgentOptions): RuntimePorts {
  return {
    create(options: { readonly sessionId: string; readonly meta: { readonly agentPreset: string }; readonly setup: AgentSetup }) {
      return ctx.agents.create({
        sessionId: options.sessionId as SessionId,
        meta: { agentPreset: options.meta.agentPreset },
        agentOptions: { provider: agentOptions.provider, model: agentOptions.model },
        setup: options.setup,
      } satisfies CreateAgentOptions)
    },
    resume(options: { readonly resumeSessionId: string; readonly setup: AgentSetup }) {
      return ctx.agents.resume({
        resumeSessionId: options.resumeSessionId as SessionId,
        agentOptions: { provider: agentOptions.provider, model: agentOptions.model },
        setup: options.setup,
      } satisfies ResumeAgentOptions)
    },
    flush(session) {
      return ctx.sessions.flush(session as unknown as Session)
    },
    async mountPreset(agentCtx, presetId) {
      const preset = await ctx.agentPresets.mount(agentCtx as Context, presetId)
      return preset.id
    },
    bindPrincipal(agent, principal) {
      return ctx.principals.bind(agent as unknown as Agent, principal)
    },
    composedPreset(agentCtx) {
      return ctx.agentPresets.composedPreset(agentCtx as Context)
    },
    createUserMessage(text: string, messageId: string): UserMessage {
      // `messageId = commandId`：崩溃后可回读持久日志对账。
      return freezeMessage<UserMessage>({
        id: MessageId(messageId),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      })
    },
    now() {
      return Date.now()
    },
    // 创建竞态：`myrix-binding-lease` 存在时，打开会话前真的重新拉一次快照。
    // 用 `ctx.get` 而不是 import：两端各自演进，驱动不因它的缺失而无法激活。
    async refreshIdentity() {
      const lease = ctx.get('bindingLease' as never) as unknown as BindingLeasePort | undefined
      if (lease === undefined) return
      // `bindingLease.refresh()` **永不抛出**：失败时返回
      // `{installed:false, rejection, detail}` 并已清空缓存。因此只看
      // "没有抛错"等于把一次刷新失败当成成功 —— 必须显式检查 `installed`。
      const outcome = await lease.refresh()
      if (outcome === null || typeof outcome !== 'object' || (outcome as { installed?: unknown }).installed !== true) {
        // 固定、非秘密的错误：不拼接 rejection/detail（可能含上游响应正文）。
        throw new Error('myrix-runtime-driver: 绑定租约刷新未安装新快照（installed !== true）')
      }
    },
    async persistedSession(sid: string) {
      const persistence = sessionPersistenceOf(ctx)
      if (persistence === undefined) return undefined
      const snapshot = await persistence.stat(sid as SessionId)
      if (snapshot === undefined) return undefined
      const preset = snapshot.header.agentPreset
      return { sid, ...(preset === undefined ? {} : { agentPreset: preset }) }
    },
    async persistedUserMessages(sid: string) {
      const persistence = sessionPersistenceOf(ctx)
      if (persistence === undefined) return []
      // `read` 访问不需要写所有权：在别的进程持有 write 时也能观察。
      const handle = await persistence.open(sid as SessionId, 'read')
      try {
        const result = await handle.read(0)
        return userMessagesFrom(result.events)
      } finally {
        await handle.close().catch(() => undefined)
      }
    },
  } as RuntimePorts
}

/**
 * `ctx.bindingLease` 的结构面：只用到 `refresh`，避免对适配器产生编译期依赖。
 *
 * `refresh()` 永不抛出；失败以 `installed:false` 表达，调用方必须检查它。
 */
interface BindingLeasePort {
  refresh(): Promise<unknown>
}

/**
 * `sessionPersistence` 的结构面：只声明驱动真正用到的三个方法。
 *
 * 刻意用结构类型 + `ctx.get` 而不是模块增强：`@deepseek-ai/dsh-session-persistence`
 * 的类型在装配方式确定前不一定在当前仓库的解析路径里，而**声明合并**一旦与
 * 上游声明同名会直接编译失败。结构类型只描述我们依赖的契约，不复制上游类型。
 */
interface SessionPersistencePort {
  stat(id: SessionId): Promise<SessionPersistenceSnapshotPort | undefined>
  open(id: SessionId, access: 'read' | 'write'): Promise<SessionHandlePort2>
}

/** 磁盘会话的元数据快照（`SessionPersistenceSnapshot` 的结构子集）。 */
interface SessionPersistenceSnapshotPort {
  readonly header: { readonly agentPreset?: string | undefined }
}

/** 一个已打开的持久会话句柄（`SessionHandle` 的结构子集）。 */
interface SessionHandlePort2 {
  read(offset?: number, length?: number): Promise<{ readonly events: readonly SessionEvent[] }>
  close(): Promise<void>
}

/** 读取可选的持久化服务；`inject` 已保证激活顺序，这里只做结构取值。 */
function sessionPersistenceOf(ctx: Context): SessionPersistencePort | undefined {
  return ctx.get('sessionPersistence' as never) as SessionPersistencePort | undefined
}

/**
 * 从持久事件里抽出用户消息（`id` + 文本 + seq）。
 *
 * 只认 `user/message`：它是模型真正看到的那条消息。`agent/inbox/spliced`
 * 是待处理投影，命令可能在"已入 inbox 但还没进轮次"时崩溃，因此两者都算
 * 已接受 —— 但对账要能区分"用户消息已落盘"与"只是排队"。
 */
function userMessagesFrom(events: readonly SessionEvent[]): readonly PersistedUserMessagePort[] {
  const messages: PersistedUserMessagePort[] = []
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const data = event.data as { readonly id?: unknown; readonly content?: unknown } | null
    if (data === null || typeof data !== 'object') continue
    if (typeof data.id !== 'string') continue
    messages.push({ id: data.id, text: textOf(data.content), seq: Number(event.seq) })
  }
  return messages
}

/** 把消息内容拼成可比对的一段文本；非文本块（图片等）不参与比较。 */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const record = block as { readonly type?: unknown; readonly text?: unknown }
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('\n')
}

function createHost(principals: PrincipalRegistry) {
  return {
    lookupPrincipal(agent: AgentPort | undefined) {
      const result = principals.lookup(agent as unknown as Agent | undefined)
      return result.ok
        ? { ok: true as const, principal: result.principal }
        : { ok: false as const, reason: result.reason, detail: result.detail }
    },
    lookupPrincipalBySession(sid: string) {
      const result = principals.lookupBySession(sid)
      return result.ok
        ? { ok: true as const, principal: result.principal }
        : { ok: false as const, reason: result.reason, detail: result.detail }
    },
    revoke(request: { sid: string; rev: number; reason: string }) {
      return principals.revoke(request)
    },
    isRevoked(sid: string) {
      return principals.isRevoked(sid)
    },
    highWaterRev(sid: string) {
      return principals.highWaterRev(sid)
    },
  }
}

/**
 * 从权威会话日志取持久事件（用于 SSE 续传）。
 *
 * 只返回会话中**已提交**的事件，且带 seq；瞬态帧从不进这里。
 */
function historyOf(ctx: Context, sid: string): readonly StreamEvent[] {
  const session = ctx.sessions.get(sid as SessionId)
  if (session === undefined) return []
  // `snapshotEvents()` 返回只读切片；按 seq 升序即日志顺序。
  return session.snapshotEvents().map((event) => ({
    seq: Number(event.seq),
    type: event.type,
    data: event.data,
    time: event.time,
  }))
}

/** 便于测试与外部装配：暴露端口构造器（不导出 default）。 */
export { createPorts as __createPorts, createHost as __createHost }
