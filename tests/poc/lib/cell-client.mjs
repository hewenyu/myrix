/**
 * A minimal, real **control-plane client** for the PoC.
 *
 * In production the session router (BFF) holds the ES256 signing key in a KMS
 * and issues one grant per command; a Cell only ever installs the matching
 * public JWK. The PoC needs the same asymmetry divided across two processes:
 *
 *   * The *runner* (this module) is the "control plane": it holds the private
 *     key, signs grants, and POSTs to the Cell over loopback HTTP.
 *   * Each *Cell* process only ever sees the public JWKS, injected through
 *     `MYRIX_GRANT_JWKS`.
 *
 * Everything here is the real `@myrix/grant` code — the same signer and the
 * same claim table the control plane will use. There is no test-only shortcut
 * in the credential itself.
 *
 * The library is **injected** rather than imported: it is TypeScript in the
 * repo, and this runner is a plain Node module, so `run-cell.mjs` compiles it
 * first (`compileWorkspaceLibs`) and passes the loaded module in. That keeps a
 * single claim table shared by the runner and every Cell.
 *
 * @module myrix-poc/cell-client
 */
import { randomUUID } from 'node:crypto'

/**
 * Create the control-plane side of the driver protocol for one Cell.
 *
 * One instance owns one `jti` store, mirroring the real deployment: replay
 * protection is per control-plane process, and a retry must re-sign with a
 * fresh `jti` rather than reuse a token.
 *
 * @param {{
 *   grant: object,
 *   issuer?: string,
 *   kid?: string,
 *   privateKey: unknown,
 *   clock?: { now: () => number },
 * }} options - signing identity and the compiled `@myrix/grant` module.
 * @returns {object} the issuer (see methods below).
 */
export function createCellIssuer(options) {
  const grant = options.grant
  if (typeof grant?.createGrantSigner !== 'function') {
    throw new Error('myrix-poc: createCellIssuer requires the compiled @myrix/grant module')
  }
  const issuer = options.issuer ?? 'myrix-control-plane'
  const signer = grant.createGrantSigner({
    privateKey: options.privateKey,
    kid: options.kid ?? 'myrix-poc-kid-1',
    issuer,
    ...options.clock === undefined ? {} : { clock: options.clock },
  })
  // A `jti` store needs a clock; the signer's default is wall-clock seconds.
  const jti = grant.createJtiStore({ clock: grant.systemClockSeconds })
  /** Everything the PoC needs to explain a rejected request afterwards. */
  const issued = []

  return {
    issuer,
    /**
     * Sign one grant and return the exact bytes to send as the HTTP body.
     *
     * `body` is serialized **once** and the same string is both hashed into
     * `bh` and sent, because `bh` binds the credential to the literal bytes:
     * re-serializing would silently break the binding.
     *
     * @param {object} input - `{ aud, boot, tid, sid, sub, wid, preset, rev, op, cmd, messageId?, text? }`.
     * @returns {{ grant: string, rawBody: string, commandId: string, claims: object }} the command.
     */
    issue(input) {
      const payload = { op: input.op, sid: input.sid, commandId: input.cmd }
      if (input.text !== undefined) payload.text = input.text
      if (input.messageId !== undefined) payload.messageId = input.messageId
      const rawBody = JSON.stringify(payload)
      const record = signer.issue({
        aud: input.aud,
        boot: input.boot,
        tid: input.tid,
        sid: input.sid,
        sub: input.sub,
        wid: input.wid,
        preset: input.preset,
        rev: input.rev,
        op: input.op,
        cmd: input.cmd,
        rawBody,
      })
      issued.push({ op: input.op, sid: input.sid, commandId: input.cmd, at: Date.now() })
      return { grant: record.token, rawBody, commandId: input.cmd, claims: record.claims }
    },
    /**
     * Sign a subscribe grant for the SSE endpoint.
     *
     * The stream carries no business command id, so the driver derives one:
     * `subscribe-<sid>`, with `bh = sha256("")`. Both are reproduced here by
     * importing the same helper the driver uses.
     *
     * @param {object} input - `{ aud, boot, tid, sid, sub, wid, preset, rev, subscribeCommandId }`.
     * @returns {{ grant: string }} the credential.
     */
    issueSubscribe(input) {
      const record = signer.issue({
        aud: input.aud,
        boot: input.boot,
        tid: input.tid,
        sid: input.sid,
        sub: input.sub,
        wid: input.wid,
        preset: input.preset,
        rev: input.rev,
        op: 'subscribe',
        cmd: input.subscribeCommandId,
        rawBody: '',
      })
      return { grant: record.token }
    },
    /** Diagnostic: one line per issued grant (no token material). */
    issued,
    /** Diagnostic: how many `jti`s were consumed (replay store size). */
    jtiStats: () => jti.stats(),
  }
}

/** A fresh command id. Retries must reuse it; new commands must not. */
export function newCommandId() {
  return `cmd_${randomUUID()}`
}

/**
 * Issue + POST a command to a Cell and return the parsed response.
 *
 * @param {object} client - `{ cellUrl, issuer, ... }` from {@link createControlPlaneClient}.
 * @param {object} input - issue input plus one of `grant`/`issue`.
 * @returns {Promise<{ status: number, body: object }>} the Cell's answer.
 */
export async function postCommand(client, input) {
  const signed = client.issuer.issue(input)
  return client.post(signed.rawBody, signed.grant)
}

/**
 * Build the "control plane" facade a test talks to.
 *
 * @param {{
 *   cellUrl: string,
 *   issuer: ReturnType<typeof createCellIssuer>,
 *   cellId: string,
 *   tenantId: string,
 *   token?: string,
 * }} options - wiring.
 * @returns {object} the client.
 */
export function createControlPlaneClient(options) {
  const base = options.cellUrl.replace(/\/$/, '')
  /** A subscribe-credential cache, keyed by session: grants are single-use. */
  const subscribeGrants = new Map()

  return {
    cellUrl: base,
    issuer: options.issuer,
    /**
     * POST one already-signed command body.
     * @param {string} rawBody - the exact bytes that were hashed into `bh`.
     * @param {string} grant - the bearer credential.
     * @returns {Promise<{ status: number, body: object }>} the response.
     */
    async post(rawBody, grant) {
      const response = await fetch(`${base}/v1/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${grant}` },
        body: rawBody,
      })
      return { status: response.status, body: await readJson(response) }
    },
    /**
     * POST one already-signed subscribe credential (used for negative cases).
     * @param {object} input - `{ sid }` plus grant overrides.
     * @returns {Promise<{ status: number, body: object }>} the response.
     */
    async subscribe(sid) {
      const grant = this.subscribeGrant(sid)
      const response = await fetch(`${base}/v1/sessions/${encodeURIComponent(sid)}/events`, {
        headers: { authorization: `Bearer ${grant}` },
      })
      return { status: response.status, body: await readJson(response) }
    },
    /**
     * Open one SSE subscription and collect frames for `windowMs`.
     *
     * @param {string} sid - session to subscribe to.
     * @param {{ lastEventId?: number, windowMs?: number }} [options] - resume watermark and window.
     * @returns {Promise<{ status: number, frames: object[], raw: string, error?: object }>} collected frames.
     */
    async collectEvents(sid, options = {}) {
      const grant = this.subscribeGrant(sid)
      const headers = { authorization: `Bearer ${grant}`, accept: 'text/event-stream' }
      if (options.lastEventId !== undefined) headers['last-event-id'] = String(options.lastEventId)
      const controller = new AbortController()
      const response = await fetch(`${base}/v1/sessions/${encodeURIComponent(sid)}/events`, {
        headers,
        signal: controller.signal,
      })
      if (response.status !== 200) {
        return { status: response.status, frames: [], raw: '', error: await readJson(response) }
      }
      const frames = []
      const decoder = new TextDecoder()
      let buffer = ''
      let raw = ''
      const windowMs = options.windowMs ?? 1500
      const deadline = Date.now() + windowMs
      try {
        for await (const chunk of response.body) {
          const text = decoder.decode(chunk, { stream: true })
          raw += text
          buffer += text
          let boundary = buffer.indexOf('\n\n')
          while (boundary !== -1) {
            const block = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const frame = parseSseBlock(block)
            if (frame !== undefined) frames.push(frame)
            boundary = buffer.indexOf('\n\n')
          }
          if (Date.now() > deadline) break
        }
      } catch (error) {
        if (error?.name !== 'AbortError') throw error
      } finally {
        controller.abort()
      }
      return { status: 200, frames, raw }
    },
    /**
     * Fetch a command receipt (`GET /v1/commands/:id`).
     * @param {string} commandId - the command to look up.
     * @param {object} claims - the grant claims for the same session, to sign the lookup.
     * @returns {Promise<{ status: number, body: object }>} the response.
     */
    async receipt(commandId, claims) {
      const signed = this.issuer.issue({
        aud: claims.aud,
        boot: claims.boot,
        tid: claims.tid,
        sid: claims.sid,
        sub: claims.sub,
        wid: claims.wid,
        preset: claims.preset,
        rev: claims.rev,
        op: 'create',
        cmd: commandId,
      })
      const response = await fetch(`${base}/v1/commands/${encodeURIComponent(commandId)}`, {
        headers: { authorization: `Bearer ${signed.grant}` },
      })
      return { status: response.status, body: await readJson(response) }
    },
    /** The derived subscribe command id for one session (must match the driver). */
    subscribeCommandId(sid) {
      return `subscribe-${sid}`
    },
    /** Get (or mint) the single-use subscribe credential for a session. */
    subscribeGrant(sid) {
      const cached = subscribeGrants.get(sid)
      if (cached !== undefined) {
        subscribeGrants.delete(sid)
        return cached
      }
      throw new Error(`myrix-poc: no prepared subscribe grant for ${sid}`)
    },
    /**
     * Prepare a subscribe grant for a session (single use, like the real one).
     * @param {object} claims - the session's grant claims.
     */
    prepareSubscribe(claims) {
      subscribeGrants.set(claims.sid, this.issuer.issueSubscribe({
        ...claims,
        subscribeCommandId: this.subscribeCommandId(claims.sid),
      }).grant)
    },
    /**
     * Admin call with the Cell service credential.
     * @param {string} path - absolute path.
     * @param {string} token - service credential.
     * @param {object} [body] - JSON body.
     * @returns {Promise<{ status: number, body: object }>} the response.
     */
    async admin(path, token, body = {}) {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...token === '' ? {} : { authorization: `Bearer ${token}` } },
        body: JSON.stringify(body),
      })
      return { status: response.status, body: await readJson(response) }
    },
    /**
     * Readiness probe.
     * @returns {Promise<{ status: number, body: object }>} the response.
     */
    async ready() {
      const response = await fetch(`${base}/v1/ready`)
      return { status: response.status, body: await readJson(response) }
    },
  }
}

/** Parse a JSON response body, tolerating an empty or non-JSON body. */
async function readJson(response) {
  const text = await response.text()
  if (text.length === 0) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { error: 'non_json_body', raw: text.slice(0, 400) }
  }
}

/** Parse one SSE block into `{ event, id, data }`. */
function parseSseBlock(block) {
  const trimmed = block.trim()
  if (trimmed.length === 0 || trimmed.startsWith(':')) return undefined
  let event
  let id
  const dataLines = []
  for (const line of trimmed.split('\n')) {
    const separator = line.indexOf(':')
    const field = separator === -1 ? line : line.slice(0, separator)
    const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '')
    if (field === 'event') event = value
    else if (field === 'id') id = value
    else if (field === 'data') dataLines.push(value)
  }
  const data = dataLines.join('\n')
  let parsed = data
  try {
    parsed = JSON.parse(data)
  } catch { /* keep the raw text */ }
  return { event, id, data: parsed }
}
