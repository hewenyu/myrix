/**
 * Test-local stand-ins for the two **external** services a Cell talks to.
 *
 * Both are real loopback HTTP servers, and that is the point: the Cell side of
 * the link is not stubbed at all — the real `myrix-llm-gateway` adapter makes a
 * real HTTP/SSE request, and the real `myrix-binding-lease` makes a real
 * snapshot request with a real bearer token. What is substituted is only the
 * *other end of the wire*, which in production is:
 *
 *   * `apps/model-gateway` (port 8790) — OpenAI **Responses** `/v1/responses`
 *     with PG-backed identity/credential/quota; the upstream model key lives
 *     there and never in a Cell. The repository forbids `chat/completions`
 *     (AGENTS.md rule 6), so these stubs speak Responses only and the old route
 *     is a 404, tested as a negative case.
 *   * `apps/works-service` (port 8791) —
 *     `GET /internal/v1/cells/:cellId/bindings`, whose body carries the binding
 *     rows AND (once the R16 policy bridge lands) the finite policy snapshot
 *     that `myrix-binding-lease` installs.
 *
 * Neither stub ever invents an authorization decision: the model gateway either
 * has a key configured or answers 503 `model_not_configured`, and the works
 * stub answers with exactly the rows its owner registered.
 *
 * @module myrix-poc/stubs
 */
import { createServer } from 'node:http'

/** Read a request body fully. */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/** Resolve once the server is listening; returns the bound port. */
function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

/** Close a server and every connection it holds. */
function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.closeAllConnections()
    server.close((error) => { error === undefined ? resolve() : reject(error) })
  })
}

/** One recorded gateway request, flattened to the facts the PoC asserts. */
function recordGatewayRequest(request, raw, index) {
  let body
  try {
    body = raw.length === 0 ? undefined : JSON.parse(raw)
  } catch {
    body = undefined
  }
  return {
    index,
    method: request.method ?? '',
    url: request.url ?? '',
    headers: request.headers,
    raw,
    body,
    aborted: false,
  }
}

/** The plain text carried by one Responses `input` array. */
function responseInputText(input) {
  if (!Array.isArray(input)) return ''
  const texts = []
  for (const item of input) {
    if (item === null || typeof item !== 'object') continue
    const content = item.content
    if (typeof content === 'string') texts.push(content)
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (part !== null && typeof part === 'object' && typeof part.text === 'string') texts.push(part.text)
      }
    } else if (typeof item.output === 'string') texts.push(item.output)
    else if (typeof item.arguments === 'string') texts.push(item.arguments)
  }
  return texts.join('\n')
}

/**
 * The last user turn's text in a Responses `input` array.
 *
 * `instructions`, `function_call` and `function_call_output` items are skipped:
 * the echo must prove which *user* message the loop actually sent.
 */
function lastUserText(input) {
  if (!Array.isArray(input)) return undefined
  let found
  for (const item of input) {
    if (item === null || typeof item !== 'object') continue
    if (item.type !== undefined && item.type !== 'message') continue
    if (item.role !== undefined && item.role !== 'user') continue
    const content = item.content
    if (typeof content === 'string') found = content
    else if (Array.isArray(content)) {
      found = content
        .filter((part) => part !== null && typeof part === 'object' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('')
    }
  }
  return found
}

/**
 * A loopback **Responses** model-gateway stand-in.
 *
 * It emits the real event sequence a Responses stream uses:
 * `response.created` → `response.output_item.added` →
 * `response.output_text.delta` ×n → `response.output_item.done` →
 * `response.completed` (carrying `usage`). `chat/completions` is answered with
 * a 404 by construction: there is no route for it, which is exactly the
 * regression the runner asserts.
 *
 * @param {{
 *   hasUpstreamKey: boolean,
 *   replyText?: string,
 * }} options - `hasUpstreamKey: false` reproduces the production 503
 *   `model_not_configured` answer, which is exactly what "no model key" must
 *   look like: a failure, never a fabricated success.
 * @returns {Promise<object>} the stub handle.
 */
export async function startModelGatewayStub(options) {
  const hasUpstreamKey = options.hasUpstreamKey === true
  const replyText = options.replyText ?? 'myrix-stub-reply'
  /** @type {ReturnType<typeof recordGatewayRequest>[]} */
  const requests = []
  const server = createServer((request, response) => {
    void (async () => {
      const raw = await readBody(request)
      const record = recordGatewayRequest(request, raw, requests.length)
      request.on('aborted', () => { record.aborted = true })
      response.on('close', () => {
        if (!response.writableEnded) record.aborted = true
      })
      requests.push(record)

      const path = (request.url ?? '/').split('?')[0]
      if (path !== '/v1/responses') {
        // No chat/completions route exists, by policy and by construction.
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'unknown route', type: 'invalid_request_error', code: 'not_found' } }))
        return
      }

      if (!hasUpstreamKey) {
        response.writeHead(503, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          error: { message: '未配置上游模型密钥', type: 'service_unavailable', code: 'model_not_configured' },
        }))
        return
      }

      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      // Echo the last user text so the caller can prove which message the loop
      // actually sent (and that `messageId` survived to the durable log).
      const text = lastUserText(record.body?.input)
      const output = typeof text === 'string' && text.length > 0 ? `${replyText}:${text}` : replyText
      const responseId = 'resp_myrix_stub'
      const itemId = 'msg_myrix_stub'
      const event = (name, payload) => {
        response.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`)
      }
      const snapshot = (status) => ({
        id: responseId,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        status,
        model: typeof record.body?.model === 'string' ? record.body.model : 'myrix-stub',
        output: [],
        usage: null,
      })
      event('response.created', { type: 'response.created', response: snapshot('in_progress') })
      event('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
      })
      event('response.output_text.delta', {
        type: 'response.output_text.delta',
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        delta: output,
      })
      event('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: itemId,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: output, annotations: [] }],
        },
      })
      event('response.completed', {
        type: 'response.completed',
        response: {
          ...snapshot('completed'),
          output: [{
            id: itemId,
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: output, annotations: [] }],
          }],
          usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15 },
        },
      })
      response.end()
    })().catch((error) => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
      if (!response.writableEnded) response.end(JSON.stringify({ error: { message: String(error) } }))
    })
  })
  const port = await listen(server)
  return {
    port,
    /**
     * The gateway ORIGIN a Cell configures.
     *
     * `myrix-llm-gateway` appends its own `/responses` and refuses a `baseURL`
     * that already names the endpoint, so the launcher must hand over this
     * origin — exactly like `apps/bff/scripts/start-dev.ts` does in production.
     */
    origin: `http://127.0.0.1:${String(port)}/v1`,
    /** The full Responses endpoint, for direct assertions. */
    url: `http://127.0.0.1:${String(port)}/v1/responses`,
    requests,
    close: () => closeServer(server),
  }
}

/**
 * The canonical results the works stub returns for the six novel tools.
 *
 * They match `packages/contracts` (and the tool output schemas in
 * `plugins/myrix-novel/src/tools.ts`) field for field: `get_outline` carries
 * `workId/text/version/updatedAt`, the save tools carry `status/version`, and
 * `search_bible` is an array of entries. The stub never echoes a field the
 * contract does not define, because the real tool schema would reject it.
 *
 * @param {string} tool - the tool name from the URL.
 * @param {Record<string, unknown>} args - the validated arguments.
 * @param {{ sid: string, wid: string, preset: string, rev: number }} binding - the server-side binding.
 * @returns {unknown} the `result` payload.
 */
function defaultToolResult(tool, args, binding) {
  const version = 3
  const updatedAt = '2026-09-30T00:00:00.000Z'
  switch (tool) {
    case 'get_outline':
      return { workId: binding.wid, text: '冒烟大纲', version, updatedAt }
    case 'get_chapter':
      return {
        id: typeof args.chapterId === 'string' ? args.chapterId : '00000000-0000-4000-8000-000000000000',
        workId: binding.wid,
        title: '第一章',
        text: '章节正文',
        version,
        updatedAt,
      }
    case 'search_bible':
      return [{
        id: '00000000-0000-4000-8000-00000000000b',
        workId: binding.wid,
        kind: 'character',
        title: '主角',
        text: '主角设定',
        version,
        updatedAt,
      }]
    case 'update_outline':
    case 'save_chapter_draft':
    case 'update_bible_entry':
      return { status: 'saved', version: version + 1 }
    default:
      return { status: 'saved', version: version + 1 }
  }
}

/**
 * A loopback works-service stand-in.
 *
 * Two internal endpoints are served, exactly as the production works service
 * exposes them:
 *
 *   * `GET /internal/v1/cells/:cellId/bindings` — the authorization snapshot
 *     (six-field binding rows, plus an optional finite policy);
 *   * `POST /internal/v1/sessions/:sessionId/tools/:tool` — one novel tool call,
 *     where the SERVER derives the work from the session binding rather than
 *     trusting the model. Any session not in the current binding list is a 403,
 *     so a tool call cannot reach a work the caller has no row for.
 *
 * The response is exactly `{ cellId, tenantId, bindings: [...], policy? }` with
 * the six wire fields `sid/tid/sub/wid/preset/rev` per row. The real lease
 * compares ALL SIX, so a stub that omitted one would let a real bug through.
 *
 * `bindings` is read from a caller-supplied function on every request, so a
 * test can add a row and then observe the create-race refresh picking it up.
 * `policy` is likewise a thunk. Its wire fields are exactly `{ rev, ttlMs,
 * tools }`: the lease parses that shape, rejects unknown fields outright and
 * clamps `ttlMs` to the remaining lease life and a 30 s ceiling. The TTL is
 * therefore FINITE by construction, and an infinite or cross-tenant policy
 * would be a fabricated authorization rather than something this stub can emit.
 *
 * @param {{
 *   token: string,
 *   cellId: string,
 *   tenantId: string,
 *   bindings: () => readonly object[],
 *   policy?: () => { rev: number, tools: readonly string[], ttlMs?: number } | undefined,
 *   policyTtlMs?: number,
 *   toolResult?: (tool: string, args: Record<string, unknown>, binding: object) => unknown,
 * }} options - the authority this stub speaks for.
 * @returns {Promise<object>} the stub handle.
 */
export async function startWorksStub(options) {
  /** Every request, flattened: proves which Cell/token called and when. */
  const requests = []
  /** Every tool call the Cell actually made (path, revision, tool, args). */
  const toolCalls = []
  const policyTtlMs = options.policyTtlMs ?? 30_000
  const toolResult = options.toolResult ?? defaultToolResult
  const server = createServer((request, response) => {
    void (async () => {
      const raw = await readBody(request)
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const record = {
        method: request.method ?? '',
        path: url.pathname,
        authorization: request.headers.authorization,
        at: Date.now(),
      }
      requests.push(record)

      if (request.headers.authorization !== `Bearer ${options.token}`) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }

      const expected = `/internal/v1/cells/${encodeURIComponent(options.cellId)}/bindings`
      const toolMatch = /^\/internal\/v1\/sessions\/([^/]+)\/tools\/([^/]+)$/.exec(url.pathname)
      if (url.pathname === expected) {
        const body = {
          cellId: options.cellId,
          tenantId: options.tenantId,
          bindings: options.bindings(),
        }
        const policy = options.policy?.()
        if (policy !== undefined) {
          // Exact wire shape the lease parses: `{ rev, ttlMs, tools }`. A
          // finite TTL is required (`(0, 30_000]`); the lease clamps it further
          // to the remaining lease life.
          body.policy = {
            rev: policy.rev,
            ttlMs: Math.min(policy.ttlMs ?? policyTtlMs, 30_000),
            tools: [...policy.tools],
          }
        }
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        response.end(JSON.stringify(body))
        return
      }
      if (toolMatch !== null) {
        if (request.method !== 'POST') {
          response.writeHead(405, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'method_not_allowed' }))
          return
        }
        const sid = decodeURIComponent(toolMatch[1])
        const tool = decodeURIComponent(toolMatch[2])
        const revision = request.headers['x-myrix-revision']
        let args = {}
        try {
          args = raw.length === 0 ? {} : JSON.parse(raw)
        } catch {
          response.writeHead(400, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'invalid_input' }))
          return
        }
        toolCalls.push({ sid, tool, revision, args })
        // Server-side authorization, from the binding table only.
        const binding = options.bindings().find((row) => row.sid === sid)
        if (binding === undefined || String(binding.rev) !== String(revision)) {
          response.writeHead(403, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'session_unavailable' }))
          return
        }
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        response.end(JSON.stringify({ result: toolResult(tool, args, binding) }))
        return
      }
      // A Cell must not be able to read another Cell's bindings, and a wrong
      // path must not be served the same data. Both are 404/401, never a 200.
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'not_found' }))
    })().catch((error) => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
      if (!response.writableEnded) response.end(JSON.stringify({ error: String(error) }))
    })
  })
  const port = await listen(server)
  return {
    port,
    origin: `http://127.0.0.1:${String(port)}`,
    requests,
    toolCalls,
    close: () => closeServer(server),
  }
}

/** Exported for the deterministic tests: the echo text one request would produce. */
export const __internal = { lastUserText, responseInputText }
