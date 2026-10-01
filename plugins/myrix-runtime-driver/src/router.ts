/**
 * 路由表：把 HTTP 请求映射到控制器与事件中枢。
 *
 * 端点严格按技术方案 §3.2（并补上 Cell 管理器所需的只读空闲证明）：
 *   POST /v1/commands            命令入口（Bearer grant）
 *   GET  /v1/commands/:id        查回执（Bearer grant）
 *   GET  /v1/sessions/:sid/events SSE（Bearer grant, op=subscribe）
 *   POST /v1/admin/drain         排空（service credential）
 *   POST /v1/admin/idle          只读空闲证明（与 drain 同一 credential）
 *   POST /v1/admin/revoke        撤权（签名信封或 service credential）
 *   GET  /v1/ready               就绪探针
 *
 * 这里只做**边界**工作：读原始正文 → 取凭证 → 交给控制器。授权语义全部在
 * 控制器与 `@myrix/grant` 里，路由不做任何"看起来合理就放行"的判断。
 *
 * @module @myrix/runtime-driver/router
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { parseBearerToken, GrantError } from '@myrix/grant'
import type { AdminAuth, AdminSignatureVerdict, AdminSignatureVerifier, CommandReceipt } from './types'
import {
  EMPTY_BODY_SHA256,
  MAX_BODY_BYTES,
  encodeSseFrame,
  parseJsonObject,
  parseLastEventId,
  parseRequestUrl,
  readHeader,
  readRawBody,
  sendError,
  sendJson,
  sseSink,
} from './http'
import type { EventHub } from './events'
import type { SessionController } from './controller'
import { CommandError } from './controller'
import type { CommandRequest } from './types'
import { WRITABLE_OPERATIONS } from './types'

/** 路由配置。 */
export interface RouterConfig {
  /** 本 cell 的租户 id；用于 ready 展示与审计。 */
  readonly tenantId: string
  /** 本进程 bootId。 */
  readonly bootId: string
  /** 本进程声明的 spec generation；未配置时不进任何响应。 */
  readonly generation?: number
  /** 模型/业务工具允许的最大正文（默认 1 MiB）。 */
  readonly maxBodyBytes?: number
  /** SSE 单连接允许积压的最大字节数；超过即断开由 Last-Event-ID 重放。 */
  readonly sseMaxBufferedBytes?: number
  /** drain 允许的认证。**必须显式提供**，否则该端点一律 503。 */
  readonly drainAuth?: AdminAuth
  /** revoke 允许的认证。**必须显式提供**，否则该端点一律 503。 */
  readonly revokeAuth?: AdminAuth
  /** 事件流空闲心跳间隔（毫秒）；0 表示不心跳。 */
  readonly heartbeatMs?: number
}

/** 一条路由的处置函数。 */
type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void

/** 实际注册到 `webServer` 上的路由描述。 */
export interface RouteSpec {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly handler: Handler
}

/** 路由集合：driver 注册的全部端点。 */
export interface Router {
  readonly routes: readonly RouteSpec[]
  /** 停止心跳与全部事件流（卸载/排空时调用）。 */
  dispose(): void
}

const UUID_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/

/** 构造路由集合。 */
export function createRouter(
  controller: SessionController,
  hub: EventHub,
  config: RouterConfig,
): Router {
  const maxBody = config.maxBodyBytes ?? MAX_BODY_BYTES
  const heartbeatMs = config.heartbeatMs ?? 15000
  const heartbeat = heartbeatMs > 0 ? setInterval(() => hub.heartbeat(), heartbeatMs) : undefined
  heartbeat?.unref?.()

  const routes: RouteSpec[] = [
    {
      kind: 'exact',
      path: '/v1/commands',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendError(res, 405, 'method_not_allowed', 'POST /v1/commands required')
          return
        }
        const bearer = readBearer(req, res)
        if (bearer === undefined) return
        const body = await readRawBody(req, maxBody)
        if (!body.ok) {
          sendBodyFailure(res, body.failure)
          return
        }
        try {
          const receipt = await controller.command(body.raw, body.sha256, bearer)
          sendJson(res, 200, receipt)
        } catch (error) {
          sendCommandError(res, error)
        }
      },
    },
    {
      kind: 'prefix',
      path: '/v1/commands',
      handler: (req, res) => {
        void handleCommandReceipt(req, res, controller)
      },
    },
    {
      kind: 'prefix',
      path: '/v1/sessions',
      handler: (req, res) => {
        void handleEvents(req, res, controller, hub, config)
      },
    },
    {
      kind: 'exact',
      path: '/v1/admin/drain',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendError(res, 405, 'method_not_allowed', 'POST /v1/admin/drain required')
          return
        }
        if (config.drainAuth === undefined) {
          sendError(res, 503, 'admin_unavailable', '未配置 drain 认证，拒绝该端点', { code: 'admin_unavailable' })
          return
        }
        const body = await readRawBody(req, maxBody)
        if (!body.ok) {
          sendBodyFailure(res, body.failure)
          return
        }
        if (!authorizeAdmin(req, res, config.drainAuth, body.raw)) return
        // 先关事件流：排空的前提是"没有持续连接继续产生工作"。
        const closed = hub.closeAll()
        const result = await controller.drain()
        // 一律 200（已认证且可达）：cell-manager 的 `HTTPClient` 把非 2xx 当作
        // "驱动不可达"的硬错误，那样管理器只会看到 DriverUnavailable，永远读不到
        // `rejectionCode` 与三个布尔。`drained:false` 本身就是明确的"未证明空闲"，
        // 不是 ack；把拒绝信息放进正文才让管理器能精确重试。
        sendJson(res, 200, {
          drained: result.drained,
          bootId: config.bootId,
          activeSessions: result.activeSessions,
          waitedMs: result.waitedMs,
          ...(result.reason === undefined ? {} : { reason: result.reason }),
          ...(result.rejectionCode === undefined ? {} : { rejectionCode: result.rejectionCode }),
          readOnly: true,
          noActiveTurns: result.noActiveTurns,
          inboxEmpty: result.inboxEmpty,
          flushed: result.flushed,
          ...(config.generation === undefined ? {} : { generation: config.generation }),
          closedStreams: closed,
        })
      },
    },
    {
      kind: 'exact',
      path: '/v1/admin/idle',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendError(res, 405, 'method_not_allowed', 'POST /v1/admin/idle required')
          return
        }
        // 复用 drain 的 credential：两者都是 Cell 管理器的动作，语义相同、权限相同。
        if (config.drainAuth === undefined) {
          sendError(res, 503, 'admin_unavailable', '未配置 drain 认证，拒绝该端点', { code: 'admin_unavailable' })
          return
        }
        const body = await readRawBody(req, maxBody)
        if (!body.ok) {
          sendBodyFailure(res, body.failure)
          return
        }
        if (!authorizeAdmin(req, res, config.drainAuth, body.raw)) return
        // **只读**：不 closeAll、不 closeAndWait、不 seal。这是一个查询。
        const proof = await controller.idleProof()
        // 同上：200 + 真实字段。`noActiveTurns:false` 就是"没有证明空闲"，
        // 不需要靠 HTTP 状态码表达；状态码一旦非 2xx，Go 客户端就读不到这些字段。
        sendJson(res, 200, {
          proofId: randomUUID(),
          bootId: config.bootId,
          noActiveTurns: proof.noActiveTurns,
          inboxEmpty: proof.inboxEmpty,
          flushed: proof.flushed,
          lastCommandAt: new Date(proof.lastCommandAt).toISOString(),
          observedAt: new Date(proof.observedAt).toISOString(),
          readOnly: true,
          ...(proof.reason === undefined ? {} : { reason: proof.reason }),
          ...(proof.rejectionCode === undefined ? {} : { rejectionCode: proof.rejectionCode }),
          ...(config.generation === undefined ? {} : { generation: config.generation }),
        })
      },
    },
    {
      kind: 'exact',
      path: '/v1/admin/revoke',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendError(res, 405, 'method_not_allowed', 'POST /v1/admin/revoke required')
          return
        }
        if (config.revokeAuth === undefined) {
          sendError(res, 503, 'admin_unavailable', '未配置 revoke 认证，拒绝该端点', { code: 'admin_unavailable' })
          return
        }
        const body = await readRawBody(req, maxBody)
        if (!body.ok) {
          sendBodyFailure(res, body.failure)
          return
        }
        if (!authorizeAdmin(req, res, config.revokeAuth, body.raw)) return
        const parsed = parseJsonObject(body.raw)
        if (!parsed.ok) {
          sendError(res, 400, 'malformed_body', parsed.reason)
          return
        }
        const notice = parseRevokeNotice(parsed.value)
        if (notice === undefined) {
          sendError(res, 400, 'malformed_body', 'revoke 需要 {sid, rev, reason}')
          return
        }
        // 撤权：先关事件流（让在途 SSE 立刻断开），再失效身份、取消、销毁。
        const closed = hub.closeSession(notice.sid)
        hub.dropSession(notice.sid)
        const result = await controller.revoke(notice)
        sendJson(res, 200, {
          accepted: result.accepted,
          sid: notice.sid,
          rev: notice.rev,
          reason: result.reason,
          disposed: result.disposed,
          closedStreams: closed,
        })
      },
    },
    {
      kind: 'exact',
      path: '/v1/ready',
      handler: (_req, res) => {
        const draining = !controller.accepting
        sendJson(res, draining ? 503 : 200, {
          ready: !draining,
          bootId: config.bootId,
          draining,
          ...(draining ? { reason: 'cell 正在排空或已关闭' } : {}),
        })
      },
    },
  ]

  return {
    routes,
    dispose(): void {
      if (heartbeat !== undefined) clearInterval(heartbeat)
      hub.closeAll()
    },
  }
}

// ---- 各端点的处置 ----

async function handleCommandReceipt(
  req: IncomingMessage,
  res: ServerResponse,
  controller: SessionController,
): Promise<void> {
  if (req.method !== 'GET') {
    sendError(res, 405, 'method_not_allowed', 'GET required')
    return
  }
  const parsed = parseRequestUrl(req)
  if (parsed === undefined) {
    sendError(res, 400, 'malformed_request', '无法解析请求 URL')
    return
  }
  const commandId = decodePathSegment(parsed.path.slice('/v1/commands/'.length))
  if (commandId === undefined || commandId.length === 0 || !UUID_PATTERN.test(commandId)) {
    sendError(res, 400, 'malformed_request', 'commandId 形态非法')
    return
  }
  // 查回执同样要凭证，而且**不是** Bearer 语法解析：GET 没有原始正文，
  // 因此控制面必须为这次读取单独签一枚 `op=subscribe` / `cmd=receipt-<id>` /
  // `bh=sha256("")` 的新凭证。`authorizeReceipt` 会真的验签、一次性消费、
  // 核对撤权与六字段身份，并只在该回执确实属于凭证 sid 时返回。
  const bearer = readBearer(req, res)
  if (bearer === undefined) return
  let receipt: CommandReceipt
  try {
    receipt = controller.authorizeReceipt(bearer, commandId)
  } catch (error) {
    sendCommandError(res, error)
    return
  }
  sendJson(res, 200, receipt)
}

async function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
  controller: SessionController,
  hub: EventHub,
  config: RouterConfig,
): Promise<void> {
  if (req.method !== 'GET') {
    sendError(res, 405, 'method_not_allowed', 'GET required')
    return
  }
  const parsed = parseRequestUrl(req)
  if (parsed === undefined) {
    sendError(res, 400, 'malformed_request', '无法解析请求 URL')
    return
  }
  const suffix = parsed.path.slice('/v1/sessions/'.length)
  const match = /^([^/]+)\/events$/.exec(suffix)
  if (match === null || match[1] === undefined) {
    sendError(res, 404, 'not_found', '未知端点')
    return
  }
  const sid = decodePathSegment(match[1])
  if (sid === undefined) {
    sendError(res, 400, 'malformed_request', '会话 id 的百分号编码非法')
    return
  }
  const bearer = readBearer(req, res)
  if (bearer === undefined) return
  // 事件流凭证的 op 必须是 subscribe；这里用空正文摘要做绑定校验。
  const binding = EMPTY_BODY_SHA256
  try {
    controller.authorizeSubscribe(bearer, sid, binding)
  } catch (error) {
    sendCommandError(res, error)
    return
  }

  // 严格解析续传水位：非法值必须显式 400，而不是"当成没带"从当前水位开始
  // ——后者会让一次笔误变成"客户端以为在续传、实际丢了中间所有事件"。
  const lastEventIdHeader = readHeader(req, 'last-event-id')
  const parsedLastEventId = parseLastEventId(lastEventIdHeader)
  if (!parsedLastEventId.ok) {
    sendError(res, 400, 'malformed_request', parsedLastEventId.reason, { code: 'malformed_last_event_id' })
    return
  }
  const lastEventId = parsedLastEventId.value
  const sink = sseSink(res, {
    ...(config.sseMaxBufferedBytes === undefined ? {} : { maxBufferedBytes: config.sseMaxBufferedBytes }),
  })
  // 先写一条 ready 帧，让路由/前端知道"已完成鉴权、正在补发"。
  sink.write(encodeSseFrame({ type: 'myrix/ready', data: { sid, time: Date.now() } }))
  const subscription = hub.subscribe(sid, lastEventId, sink, () => controller.streamAdmitted(sid))
  // 只关闭**这一个**订阅：同一会话可能有第二个连接（第二个标签页、断线重连
  // 的短暂重叠）。撤权时由 `closeSession` 统一关闭该会话的全部订阅。
  req.on('close', () => {
    subscription.close()
  })
}

// ---- 边界工具 ----

/**
 * 解码一个路径段；`decodeURIComponent` 对畸形百分号编码（`%`、`%zz`、孤立
 * 代理项）会抛 `URIError`。这里把它收敛成 `undefined`，由调用方答 400 ——
 * 绝不让一个畸形 URL 变成未处理的异常（500/连接悬挂）。
 */
function decodePathSegment(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw)
  } catch {
    return undefined
  }
}

function readBearer(req: IncomingMessage, res: ServerResponse): string | undefined {
  try {
    return parseBearerToken(readHeader(req, 'authorization'))
  } catch (error) {
    if (error instanceof GrantError) {
      sendError(res, 401, 'grant_missing', error.reason, { code: error.code, stage: error.stage })
      return undefined
    }
    sendError(res, 401, 'grant_missing', '缺少 Authorization 头')
    return undefined
  }
}

function authorizeAdmin(req: IncomingMessage, res: ServerResponse, auth: AdminAuth, rawBody: Buffer): boolean {
  if (auth.kind === 'verifier') {
    const headerName = auth.header ?? 'x-myrix-admin-signature'
    const outcome = auth.verify(rawBody, readHeader(req, headerName))
    if (!outcome.ok) {
      sendError(res, 403, 'admin_denied', outcome.reason, { code: 'admin_denied' })
      return false
    }
    return true
  }
  const header = readHeader(req, 'authorization')
  if (header === undefined) {
    sendError(res, 401, 'admin_denied', '缺少 service credential', { code: 'admin_denied' })
    return false
  }
  const expected = Buffer.from(`Bearer ${auth.token}`, 'utf8')
  const actual = Buffer.from(header, 'utf8')
  // 长度不等时 timingSafeEqual 会抛错，因此先比长度（长度本身不是秘密）。
  const ok = expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual)
  if (!ok) {
    sendError(res, 403, 'admin_denied', 'service credential 不正确', { code: 'admin_denied' })
    return false
  }
  return true
}

function parseRevokeNotice(value: Record<string, unknown>): { sid: string; rev: number; reason: string } | undefined {
  const sid = value['sid']
  const rev = value['rev']
  const reason = value['reason']
  if (typeof sid !== 'string' || sid.length === 0) return undefined
  if (typeof rev !== 'number' || !Number.isSafeInteger(rev) || rev < 0) return undefined
  if (reason !== undefined && typeof reason !== 'string') return undefined
  return { sid, rev, reason: reason ?? 'revoked' }
}

function sendBodyFailure(
  res: ServerResponse,
  failure: { kind: string; limit?: number; seen?: number; detail?: string },
): void {
  if (failure.kind === 'too-large') {
    sendError(res, 413, 'body_too_large', `请求体超过上限 ${String(failure.limit ?? 0)} 字节`, {
      code: 'body_too_large',
    })
    return
  }
  if (failure.kind === 'aborted') {
    sendError(res, 400, 'body_aborted', '请求体传输中断', { code: 'body_aborted' })
    return
  }
  sendError(res, 400, 'body_read_error', `读取请求体失败（${failure.detail ?? 'unknown'}）`, {
    code: 'body_read_error',
  })
}

/** 把控制器/凭证错误翻译成 HTTP；绝不回显 token 或正文。 */
function sendCommandError(res: ServerResponse, error: unknown): void {
  if (error instanceof CommandError) {
    sendError(res, error.status, error.code, error.message, {
      code: error.code,
      ...(error.stage === undefined ? {} : { stage: error.stage }),
    })
    return
  }
  if (error instanceof GrantError) {
    sendError(res, 403, 'grant_rejected', error.reason, { code: error.code, stage: error.stage })
    return
  }
  sendError(res, 500, 'internal_error', '内部错误', { code: 'internal_error' })
}

/** 供实现文档与测试引用的端点清单。 */
export const DRIVER_ENDPOINTS: readonly { method: string; path: string; auth: string }[] = Object.freeze([
  { method: 'POST', path: '/v1/commands', auth: 'Bearer <grant op=create|resume|send|cancel>' },
  {
    method: 'GET',
    path: '/v1/commands/:commandId',
    auth: 'Bearer <grant op=subscribe cmd=receipt-:commandId bh=sha256("")>',
  },
  { method: 'GET', path: '/v1/sessions/:sid/events', auth: 'Bearer <grant op=subscribe>' },
  { method: 'POST', path: '/v1/admin/drain', auth: 'service credential 或签名信封' },
  { method: 'POST', path: '/v1/admin/idle', auth: '与 drain 同一 service credential' },
  { method: 'POST', path: '/v1/admin/revoke', auth: 'service credential 或签名信封' },
  { method: 'GET', path: '/v1/ready', auth: '无（探针）' },
])

export { WRITABLE_OPERATIONS }
export type { AdminAuth, AdminSignatureVerifier, AdminSignatureVerdict, CommandRequest }
