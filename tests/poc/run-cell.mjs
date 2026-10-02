/**
 * Myrix **isolated Cell** end-to-end PoC.
 *
 * Two real Cells are assembled from the real Myrix plugins and booted as two
 * real DSH processes over two real isolated `$DSH_HOME`s. Everything the
 * platform claims about a Cell is then exercised over real HTTP:
 *
 *   1. both Cells start on their own ports and answer `/v1/ready` with their own `bootId`;
 *   2. `POST /v1/commands` with an ES256 grant creates a session in Cell A only,
 *      and the durable JSONL log lands under **A's** `DSH_HOME`;
 *   3. a `send` writes the real `user/message` into the real agent loop, the
 *      reply comes back through the real model route, and the durable `seq`
 *      stream is observable on the SSE endpoint with `op=subscribe`;
 *   4. identity, binding, audience, body-hash and replay negative cases are all
 *      rejected, none of them creates a session;
 *   5. A's works-service token cannot read B's binding snapshot;
 *   6. after a **process restart** the same `commandId` is deduplicated against
 *      the durable log (the in-process receipt table is empty by then);
 *   7. the novel vertical is really mounted: `ctx.novelStore` exists, the three
 *      presets are in the roster, and each preset's Agent sees exactly its own
 *      tool intersection while the global scope sees none of the six;
 *   8. the model link is **Responses**: every request lands on `/v1/responses`
 *      with `input` + flat function tools + `store: false`, and the legacy
 *      `/v1/chat/completions` route is a 404 (negative regression).
 *
 * Substitutions are declared, never hidden: the model gateway and the works
 * service are loopback stand-ins for `apps/model-gateway` / `apps/works-service`
 * (their production behaviour is described in the report), and the control-plane
 * signing key is generated in-process with the `@myrix/grant` testing helper.
 * Every other component — Cordis, the loader, the whitelist bundle, `dsh-session`,
 * JSONL persistence, `dsh-agent-loop`, `dsh-tools`, the preset registry, all six
 * Myrix plugins, JWS/ES256, HTTP and SSE — is the real thing.
 *
 * Usage:
 *   node tests/poc/run-cell.mjs                # full run
 *   node tests/poc/run-cell.mjs --dump-config  # compose both Cells, no boot
 *
 * @module myrix-poc/run-cell
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compileWorkspaceLibs } from './lib/compile-plugins.mjs'
import { createCellProfile, cellEnv } from './lib/cell-profile.mjs'
import { createCellIssuer, createControlPlaneClient, newCommandId } from './lib/cell-client.mjs'
import { resolveRepoRoot } from './lib/dsh-install.mjs'
import { startModelGatewayStub, startWorksStub } from './lib/stubs.mjs'

const HERE = new URL('.', import.meta.url).pathname
const REPO = resolveRepoRoot(HERE)
// A directory of its own: `run-poc.mjs` wipes `tests/poc/.work` at the start of
// every run, and sharing it would silently delete this run's evidence.
const WORK = join(REPO, 'tests', 'poc', '.work-cell')
const REPORT = join(WORK, 'cell-report.json')
const DUMP_ONLY = process.argv.includes('--dump-config')
/** `--driver-only` runs the PoC scope that deliberately omits the novel vertical. */
const DRIVER_ONLY = process.argv.includes('--driver-only')

/** Cells under test: distinct home, port, tenant, works stub and credentials. */
const CELL_IDS = ['a', 'b']
/**
 * The six business tools, in package order. They are the only names a Cell's
 * policy layer may admit; `myrix-novel` registers them inside preset scopes and
 * `myrix-policy-enforcer` intersects this deployment allowlist with the policy
 * snapshot.
 */
const ALLOWED_TOOLS = ['get_outline', 'update_outline', 'get_chapter', 'save_chapter_draft', 'search_bible', 'update_bible_entry']

/**
 * Create the run's shared inputs: two works stubs, one model gateway stub, and
 * one control-plane key that both Cells trust (the real deployment has ONE
 * control plane signing for every Cell).
 */
async function createWorld() {
  // The signing key exists only in the "control plane" (this runner).
  const libs = compileWorkspaceLibs({ outDir: join(WORK, 'libs'), fresh: true })
  const grant = await import(libs['myrix-grant'])
  const key = grant.generateTestKeyPair('myrix-poc-kid-1')

  /** Bindings registered in each works stub, keyed by cell id. */
  const bindings = Object.fromEntries(CELL_IDS.map((id) => [id, []]))
  const tokens = {
    a: 'cellA-works-token-0123456789abcdef',
    b: 'cellB-works-token-0123456789abcdef',
  }
  const cells = {}
  for (const id of CELL_IDS) {
    cells[id] = await startWorksStub({
      token: tokens[id],
      cellId: `cell-${id}`,
      tenantId: `t_${id}`,
      bindings: () => bindings[id],
      // The R16 policy bridge: a finite, same-tenant snapshot beside the rows.
      // `--driver-only` omits it, which is exactly the PoC opt-out the report
      // documents; a production launcher never runs in that mode. The `rev` is
      // bumped by the probe-independent deployment here; the Cell never invents
      // one.
      policy: DRIVER_ONLY ? undefined : () => ({ rev: 1, tools: ALLOWED_TOOLS }),
    })
  }
  const gateway = await startModelGatewayStub({ hasUpstreamKey: true })

  return {
    grant,
    key,
    bindings,
    worksTokens: tokens,
    works: cells,
    gateway,
    async close() {
      await Promise.all([...Object.values(cells).map((stub) => stub.close()), gateway.close()])
    },
  }
}

/** One booted Cell process plus its handles. */
class CellProcess {
  constructor(cell, label) {
    this.cell = cell
    this.label = label
    this.child = undefined
    this.stdout = ''
    this.stderr = ''
    this.exit = undefined
  }

  /** Start the real DSH CLI against this Cell's isolated home. */
  start() {
    const install = this.cell.install
    this.child = spawn(process.execPath, [install.cli, '--profile', this.cell.profileName], {
      cwd: REPO,
      env: cellEnv(this.cell),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child.stdout.on('data', (chunk) => { this.stdout += String(chunk) })
    this.child.stderr.on('data', (chunk) => { this.stderr += String(chunk) })
    this.exit = new Promise((resolve) => {
      this.child.on('exit', (code, signal) => resolve({ code, signal }))
    })
    return this
  }

  /** Wait until `/v1/ready` answers 200, or fail with the process output. */
  async waitReady(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs
    let lastError = 'no attempt'
    while (Date.now() < deadline) {
      if (this.exit !== undefined && this.child.exitCode !== null) {
        throw new Error(
          `myrix-poc: Cell ${this.label} exited (code ${String(this.child.exitCode)}) before becoming ready.\n`
          + `stdout:\n${this.stdout.slice(-4000)}\nstderr:\n${this.stderr.slice(-4000)}`,
        )
      }
      try {
        const response = await fetch(`${this.cell.cellUrl}/v1/ready`)
        if (response.status === 200) return await response.json()
        lastError = `status ${String(response.status)}`
      } catch (error) {
        lastError = String(error?.cause?.code ?? error?.message ?? error)
      }
      await delay(150)
    }
    throw new Error(
      `myrix-poc: Cell ${this.label} never became ready (${lastError}).\n`
      + `stdout:\n${this.stdout.slice(-4000)}\nstderr:\n${this.stderr.slice(-4000)}`,
    )
  }

  /** Stop the process and wait for it to be gone. */
  async stop() {
    if (this.child === undefined || this.child.exitCode !== null) return
    this.child.kill('SIGTERM')
    const timeout = setTimeout(() => { this.child.kill('SIGKILL') }, 5_000)
    await this.exit
    clearTimeout(timeout)
  }
}

/** Sleep helper. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Read the durable `seq`/`type` pairs a session's JSONL artifact holds.
 *
 * This reads the *artifact on disk* rather than any in-process view: it is the
 * evidence for "the command really persisted into this Cell's own home".
 *
 * @param {string} home - the Cell's `$DSH_HOME`.
 * @param {string} sid - session id.
 * @returns {{ path: string, records: object[] } | undefined} the artifact, or undefined.
 */
function readSessionArtifact(home, sid) {
  const root = join(home, 'sessions')
  if (!existsSync(root)) return undefined
  for (const project of readdirSync(root)) {
    const artifact = join(root, project, sid, 'session.v4.jsonl')
    if (!existsSync(artifact)) continue
    const records = []
    for (const line of readFileSync(artifact, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      try {
        records.push(JSON.parse(line))
      } catch { /* a torn trailing line is the writer's business */ }
    }
    return { path: artifact, records }
  }
  return undefined
}

/** Every session id that has an artifact under a Cell home. */
function sessionIdsOnDisk(home) {
  const root = join(home, 'sessions')
  if (!existsSync(root)) return []
  const ids = []
  for (const project of readdirSync(root)) {
    const projectDir = join(root, project)
    for (const entry of readdirSync(projectDir)) {
      if (existsSync(join(projectDir, entry, 'session.v4.jsonl'))) ids.push(entry)
    }
  }
  return ids
}

/** The public JWK set a Cell installs: the PUBLIC halves only. */
function publicJwks(key) {
  return [key.jwk]
}

/** Ordered probe outcomes; a thrown error becomes a failed entry. */
const results = []
async function probe(name, fn) {
  try {
    results.push({ name, ok: true, detail: await fn() })
  } catch (error) {
    results.push({
      name,
      ok: false,
      error: String(error?.message ?? error),
      stack: String(error?.stack ?? '').split('\n').slice(0, 5).join('\n'),
    })
  }
}

/** Assert inside a probe; the runner converts a throw into a failed probe. */
function assert(condition, message) {
  if (condition !== true) throw new Error(`assertion failed: ${message}`)
}

/**
 * Assemble one Cell descriptor for a given cell letter.
 *
 * @param {object} world - shared stubs and keys.
 * @param {'a'|'b'} id - cell letter.
 * @param {object} ports - `{ a: number, b: number }` Cell listen ports.
 * @param {boolean} withToken - whether the model-gateway credential is present.
 * @returns {object} the Cell descriptor.
 */
function buildCell(world, id, ports, probePrincipal, withToken = true, probeRun) {
  const home = join(WORK, `home-${id}`)
  return createCellProfile({
    home,
    profileName: 'myrix-cell',
    cellId: `cell-${id}`,
    tenantId: `t_${id}`,
    issuer: 'myrix-control-plane',
    grantPublicJwks: publicJwks(world.key),
    port: ports[id],
    worksOrigin: world.works[id].origin,
    worksToken: world.worksTokens[id],
    gatewayBaseURL: world.gateway.origin,
    gatewayToken: withToken ? `gateway-cell-${id}-token-0123456789` : '',
    providers: ['myrix-gateway'],
    models: ['myrix-chat'],
    contextWindow: 100_000,
    drainToken: `drain-${id}-token-0123456789abcdef`,
    revokeToken: `revoke-${id}-token-0123456789abcdef`,
    generation: 1,
    // Production passes the full six-tool deployment allowlist; the PEP
    // intersects it with each preset's own scope, so a preset still cannot call
    // another's tools. The driver-only PoC scope mounts no novel vertical, so
    // its allowlist names the probe's own test tool instead — otherwise there
    // would be no tool left to observe an allow decision on.
    allowedTools: DRIVER_ONLY ? ['myrix_probe_echo'] : ALLOWED_TOOLS,
    // Production shape: the DRIVER declares the route, so the profile needs no
    // seam row. The probe still passes `agentOptions` because it calls
    // `ctx.agents.create()` itself rather than going through the driver.
    routeSeam: 'none',
    probe: true,
    probeOut: join(home, 'probe-report.json'),
    probePrincipal,
    probeRun,
    // The real Cell is the production shape. `--driver-only` is the explicit,
    // documented PoC opt-out used to exercise the driver path alone; it is
    // never what a launcher (`apps/bff/scripts/start-dev.ts`) builds.
    mode: DRIVER_ONLY ? 'poc' : 'production',
    novel: !DRIVER_ONLY,
    novelOptOutReason: DRIVER_ONLY ? '--driver-only: this run exercises the driver/identity path without the novel vertical' : undefined,
    requirePolicy: !DRIVER_ONLY,
    probeMode: DRIVER_ONLY ? 'driver-only' : 'novel',
    fresh: true,
  })
}

/** Everything the two Cell processes need to run concurrently. */
async function main() {
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true, mode: 0o700 })
  const world = await createWorld()
  writeFileSync(REPORT, '{}\n', { mode: 0o600 })

  /** Fresh session id per run so restart checks are unambiguous. */
  const runId = String(Date.now())
  const ports = { a: 7801, b: 7802 }
  // The in-Cell probe runs one agent turn through the COMPLETE identity chain:
  // its principal is registered in the works stub, so the real binding lease
  // proves liveness from a real HTTP snapshot. Nothing about the identity path
  // is bypassed for the probe.
  const probePrincipal = {
    sid: 'cell_probe',
    tid: 't_a',
    sub: 'u_probe',
    wid: 'w_a',
    // The probe's own Agent mounts this preset; the binding row must agree on
    // ALL SIX fields, so the preset is part of the identity the lease checks.
    preset: DRIVER_ONLY ? 'myrix-empty' : 'novel-outline',
    rev: 1,
  }
  /** Register the works-stub row for one boot's probe session. */
  const registerProbeBinding = (runTag) => {
    world.bindings.a.push({ ...probePrincipal, sid: `${probePrincipal.sid}_${runTag}` })
  }
  const cells = {}
  for (const id of CELL_IDS) {
    cells[id] = buildCell(world, id, ports, id === 'a' ? probePrincipal : undefined, true, runId)
    cells[id].linkBundle()
  }
  registerProbeBinding(runId)
  const processes = Object.fromEntries(CELL_IDS.map((id) => [id, new CellProcess(cells[id], id)]))

  // One control-plane issuer per Cell: the `jti` store is per signing process,
  // and the PoC proves replay rejection by reusing a token within one Cell.
  const issuers = Object.fromEntries(CELL_IDS.map((id) => [id, createCellIssuer({
    grant: world.grant,
    privateKey: world.key.privateKey,
    kid: world.key.kid,
    issuer: 'myrix-control-plane',
  })]))
  const clients = Object.fromEntries(CELL_IDS.map((id) => [id, createControlPlaneClient({
    cellUrl: cells[id].cellUrl,
    issuer: issuers[id],
    cellId: `cell-${id}`,
    tenantId: `t_${id}`,
  })]))

  if (DUMP_ONLY) {
    // Composition check only: the profile must compose and name the Cell rows.
    const dump = await dumpConfig(cells.a)
    process.stdout.write(dump.stdout)
    process.stderr.write(dump.stderr)
    const required = ['webserver', 'myrix-principals', 'myrix-policy-enforcer', 'myrix-binding-lease', 'myrix-runtime-driver', 'myrix-llm-gateway']
    if (!DRIVER_ONLY) required.push('myrix-novel')
    const missing = required.filter((id) => !dump.stdout.includes(id))
    process.stdout.write(`\nmyrix-poc: missing Cell rows in dump = ${JSON.stringify(missing)}\n`)
    await world.close()
    process.exit(missing.length === 0 && dump.status === 0 ? 0 : 1)
  }

  const sid = `cellA_s${runId}`
  const claimsFor = (id, overrides = {}) => ({
    aud: `cell-${id}`,
    boot: processes[id].readyBody.bootId,
    tid: `t_${id}`,
    sid,
    sub: `u_owner_${id}`,
    wid: `w_${id}`,
    preset: 'myrix-empty',
    rev: 1,
    ...overrides,
  })

  try {
    // ── boot ────────────────────────────────────────────────────────────────
    await probe('E2E:two-isolated-cells-boot-and-are-ready', async () => {
      for (const id of CELL_IDS) processes[id].start()
      const ready = {}
      for (const id of CELL_IDS) {
        ready[id] = await processes[id].waitReady()
        processes[id].readyBody = ready[id]
      }
      assert(ready.a.ready === true && ready.b.ready === true, 'both cells report ready')
      assert(ready.a.bootId !== ready.b.bootId, 'each cell has its own bootId')
      return { home: Object.fromEntries(CELL_IDS.map((id) => [id, cells[id].home])), ready }
    })

    if (results.at(-1)?.ok !== true) {
      throw new Error(`Cell boot failed, aborting the run: ${JSON.stringify(results.at(-1))}`)
    }

    // Register the binding the Cell's lease will read, for Cell A only.
    world.bindings.a.push({ sid, tid: 't_a', sub: 'u_owner_a', wid: 'w_a', preset: 'myrix-empty', rev: 1 })

    await probe('E2E:signed-create-creates-the-session-in-cell-A-only', async () => {
      const commandId = newCommandId()
      const signed = issuers.a.issue(claimsFor('a', { op: 'create', cmd: commandId }))
      const response = await clients.a.post(signed.rawBody, signed.grant)
      assert(response.status === 200, `expected 200, got ${String(response.status)} ${JSON.stringify(response.body)}`)
      assert(response.body.status === 'accepted', `expected accepted, got ${JSON.stringify(response.body)}`)
      const artifactA = readSessionArtifact(cells.a.home, sid)
      assert(artifactA !== undefined, 'session artifact exists in A')
      assert(!sessionIdsOnDisk(cells.b.home).includes(sid), 'session must NOT exist in B')
      return {
        receipt: response.body,
        artifact: { path: artifactA.path, records: artifactA.records.length },
        cellBSessions: sessionIdsOnDisk(cells.b.home),
        commandId,
      }
    })

    await probe('E2E:create-receipt-is-deduplicated-within-the-process', async () => {
      const commandId = newCommandId()
      const signed = issuers.a.issue(claimsFor('a', { op: 'create', cmd: commandId }))
      const first = await clients.a.post(signed.rawBody, signed.grant)
      assert(first.status === 200 && first.body.status === 'accepted', `first: ${JSON.stringify(first)}`)
      // A retry is a NEW grant (new jti) with the SAME commandId — exactly the
      // retry rule in tech-design-v1 §3.1.
      const retry = issuers.a.issue(claimsFor('a', { op: 'create', cmd: commandId }))
      const second = await clients.a.post(retry.rawBody, retry.grant)
      assert(second.status === 200, `retry status ${String(second.status)} ${JSON.stringify(second.body)}`)
      assert(second.body.status === 'duplicate', `expected duplicate, got ${JSON.stringify(second.body)}`)
      return { first: first.body, second: second.body }
    })

    await probe('E2E:send-runs-a-real-agent-turn-through-the-model-route', async () => {
      // Subscribe BEFORE sending so the durable events are observable live.
      clients.a.prepareSubscribe(claimsFor('a'))
      const streamPromise = clients.a.collectEvents(sid, { lastEventId: 0, windowMs: 6000 })
      await delay(250)
      const commandId = newCommandId()
      const text = '写一句话'
      const signed = issuers.a.issue(claimsFor('a', { op: 'send', cmd: commandId, text }))
      const response = await clients.a.post(signed.rawBody, signed.grant)
      assert(response.status === 200, `send failed: ${String(response.status)} ${JSON.stringify(response.body)}`)
      const stream = await streamPromise
      const durableTypes = stream.frames.filter((frame) => typeof frame.id === 'string').map((frame) => frame.event)
      const artifact = readSessionArtifact(cells.a.home, sid)
      const userMessages = artifact.records.filter((record) => record.type === 'user/message')
      // The gateway stub echoes the message, so the assistant text proves which
      // message actually reached the model through the real loop.
      const assistantText = artifact.records
        .filter((record) => record.type === 'assistant/message')
        .map((record) => JSON.stringify(record.data?.message?.content ?? ''))
        .join('')
      // Responses-only evidence: the request went to the Responses route, in
      // the Responses wire form, and no chat request exists anywhere. The
      // runner's own negative route probe tags itself, so it is never counted
      // as a real chat call.
      const gatewayRequests = world.gateway.requests
      const realRequests = gatewayRequests.filter((entry) => entry.headers['x-myrix-negative-route'] === undefined)
      const responsesRequests = realRequests.filter((entry) => entry.url === '/v1/responses')
      const chatRequests = realRequests.filter((entry) => entry.url.includes('chat/completions'))
      assert(responsesRequests.length > 0, `no Responses request reached the model gateway: ${JSON.stringify(gatewayRequests.map((entry) => entry.url))}`)
      assert(chatRequests.length === 0, `the chat/completions route was used: ${JSON.stringify(chatRequests.map((entry) => entry.url))}`)
      const last = responsesRequests.at(-1)
      assert(last.body?.store === false, `every Responses request must send store:false, got ${JSON.stringify(last.body?.store)}`)
      assert(Array.isArray(last.body?.input) && last.body.input.length > 0, 'the Responses request must carry input items')
      assert(!('messages' in (last.body ?? {})), `the Responses request must not carry chat messages: ${JSON.stringify(Object.keys(last.body ?? {}))}`)
      assert(!('stream_options' in (last.body ?? {})), 'the Responses request must not carry chat stream_options')
      // Flat function tools: Responses has no nested `function` wrapper.
      for (const tool of last.body?.tools ?? []) {
        assert(tool.type === 'function' && typeof tool.name === 'string' && tool.function === undefined,
          `tools must be flat Responses function tools, got ${JSON.stringify(tool)}`)
      }
      return {
        commandId,
        receipt: response.body,
        gatewayRequests: gatewayRequests.length,
        responsesRequests: responsesRequests.length,
        chatRequests: chatRequests.length,
        responsesBodyKeys: Object.keys(last.body ?? {}).sort(),
        responsesToolNames: (last.body?.tools ?? []).map((tool) => tool.name),        durableTypes,
        userMessageIds: userMessages.map((record) => record.data?.id ?? null),
        messageIdIsCommandId: userMessages.some((record) => record.data?.id === commandId),
        assistantEchoedTheSentText: assistantText.includes(text),
        turnEnd: artifact.records.filter((record) => record.type === 'turn/end')
          .map((record) => record.data?.reason?.kind ?? null),
      }
    })

    await probe('E2E:the-legacy-chat-completions-route-is-not-served', async () => {
      // Regression for AGENTS.md rule 6: the old protocol must be a refusal at
      // the transport layer, not a compatibility branch. The stub is the model
      // gateway's stand-in, so this is a route test rather than an upstream call.
      // The marker header keeps this probe's own request out of the "the Cell
      // never used chat" assertion above.
      const marker = 'runner-negative-route'
      const legacy = await fetch(`http://127.0.0.1:${String(world.gateway.port)}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer irrelevant', 'x-myrix-negative-route': marker },
        body: JSON.stringify({ model: 'myrix-chat', messages: [{ role: 'user', content: 'x' }] }),
      })
      const body = await legacy.json()
      assert(legacy.status === 404, `chat/completions must be 404, got ${String(legacy.status)}`)
      const forwarded = world.gateway.requests.filter((entry) => entry.url.includes('chat/completions') && entry.headers['x-myrix-negative-route'] === undefined)
      assert(forwarded.length === 0, `the Cell must never use chat/completions: ${JSON.stringify(forwarded.map((entry) => entry.url))}`)
      return { status: legacy.status, body }
    })

    await probe('E2E:durable-seq-stream-is-observable-with-a-subscribe-grant', async () => {
      clients.a.prepareSubscribe(claimsFor('a'))
      const stream = await clients.a.collectEvents(sid, { lastEventId: 0, windowMs: 2500 })
      assert(stream.status === 200, `subscribe status ${String(stream.status)} ${JSON.stringify(stream.error)}`)
      // The `myrix/ready` banner is only sent on a LIVE subscription; a replay
      // driven purely from the durable log starts at the first persisted event.
      // Both shapes are valid, so the assertion is on the documented contract:
      // the subscription is accepted and every durable frame carries its log seq.
      assert(stream.frames.length > 0, 'the subscription produced frames')
      // The driver frames durable events as `event: <SessionEvent.type>` with the
      // log `seq` in the SSE `id:` field (the ready frame carries no id). That
      // is the contract SSE resume depends on, so assert it literally.
      const durable = stream.frames.filter((frame) => typeof frame.id === 'string' && frame.id.length > 0)
      const seqs = durable.map((frame) => Number(frame.id))
      assert(seqs.length > 0, `no durable frames replayed: ${stream.raw.slice(0, 400)}`)
      assert(seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]), `seqs not strictly increasing: ${seqs.join(',')}`)
      const types = durable.map((frame) => frame.event)
      assert(types.includes('user/message'), `the durable stream must include user/message: ${types.join(',')}`)
      return {
        frameEvents: types,
        ids: seqs,
        readyFrame: stream.frames.find((frame) => frame.data?.type === 'myrix/ready')?.data ?? null,
      }
    })

    await probe('E2E:negative-cases-are-rejected-without-side-effects', async () => {
      const cases = {}
      const base = claimsFor('a', { op: 'send', cmd: newCommandId(), text: 'x' })

      // 1) no credential at all
      const bare = await fetch(`${cells.a.cellUrl}/v1/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'send', sid, commandId: base.cmd, text: 'x' }),
      })
      cases.noCredential = { status: bare.status, body: await bare.json() }

      // 2) wrong audience
      const wrongAud = issuers.a.issue({ ...base, aud: 'cell-other' })
      cases.wrongAudience = await clients.a.post(wrongAud.rawBody, wrongAud.grant)

      // 3) wrong tenant (aud correct)
      const wrongTid = issuers.a.issue({ ...base, tid: 't_other' })
      cases.wrongTenant = await clients.a.post(wrongTid.rawBody, wrongTid.grant)

      // 4) wrong bootId (a credential minted for a previous process)
      const wrongBoot = issuers.a.issue({ ...base, boot: '00000000-0000-4000-8000-000000000000' })
      cases.wrongBoot = await clients.a.post(wrongBoot.rawBody, wrongBoot.grant)

      // 5) body-hash mismatch: sign one body, send another
      const hashBound = issuers.a.issue({ ...base, text: 'signed-text' })
      const tampered = JSON.stringify({ op: 'send', sid, commandId: base.cmd, text: 'tampered-text' })
      cases.bodyHashMismatch = await clients.a.post(tampered, hashBound.grant)

      // 6) replay: same jti used twice
      const replay = issuers.a.issue({ ...base, cmd: newCommandId() })
      cases.replayFirst = await clients.a.post(replay.rawBody, replay.grant)
      cases.replaySecond = await clients.a.post(replay.rawBody, replay.grant)

      // 7) An identity that exists in no binding snapshot at all.
      //    (a) `create` is where the identity chain runs: setup binds, then the
      //        synchronous commit re-checks `principals.lookup`, whose liveness
      //        verdict comes from the real binding lease. A principal with no
      //        snapshot row can never be `alive`, so creation must fail AND the
      //        session must not appear on disk.
      const unboundSid = `cellA_unbound_${runId}`
      const unbound = issuers.a.issue({ ...base, op: 'create', sid: unboundSid, cmd: newCommandId() })
      cases.unboundCreate = await clients.a.post(unbound.rawBody, unbound.grant)
      //    (b) A `send` to a session that was never created. Observed behaviour
      //        (recorded, not asserted as ideal): the driver reports
      //        `503 persistence_unavailable`, because it reconciles against the
      //        authoritative log before anything else and a missing artifact
      //        surfaces as a read failure. It is still a refusal with no side
      //        effect; see the report's known-issues section.
      const neverCreated = `cellA_missing_${runId}`
      const neverCreatedSend = issuers.a.issue({ ...base, sid: neverCreated, cmd: newCommandId() })
      cases.sendToMissingSession = await clients.a.post(neverCreatedSend.rawBody, neverCreatedSend.grant)

      // 8) signature made by a DIFFERENT key (a foreign control plane).
      const foreign = createCellIssuer({
        grant: world.grant,
        privateKey: world.grant.generateTestKeyPair('foreign-kid').privateKey,
        kid: 'foreign-kid',
        issuer: 'myrix-control-plane',
      })
      const foreignSigned = foreign.issue({ ...base, aud: 'cell-a', tid: 't_a', boot: processes.a.readyBody.bootId })
      cases.foreignSignature = await clients.a.post(foreignSigned.rawBody, foreignSigned.grant)

      // 9) admin endpoints without the service credential
      cases.drainAnonymous = await clients.a.admin('/v1/admin/drain', '')
      cases.revokeAnonymous = await clients.a.admin('/v1/admin/revoke', '', { sid, rev: 9, reason: 'x' })

      // 10) receipt lookup for an unknown command
      cases.unknownReceipt = await clients.a.receipt(`cmd_${'0'.repeat(8)}-0000-4000-8000-000000000000`, claimsFor('a'))

      // 11) unknown-kid: a credential signed by a key the Cell does not install
      const unknownKid = createCellIssuer({
        grant: world.grant,
        privateKey: world.grant.generateTestKeyPair('uninstalled-kid').privateKey,
        kid: 'uninstalled-kid',
        issuer: 'myrix-control-plane',
      }).issue({ ...base, aud: 'cell-a', tid: 't_a', boot: processes.a.readyBody.bootId, cmd: newCommandId() })
      cases.unknownKid = await clients.a.post(unknownKid.rawBody, unknownKid.grant)

      for (const [name, value] of Object.entries(cases)) {
        if (name === 'replayFirst') continue
        assert(value.status >= 400, `${name} must be rejected, got ${String(value.status)} ${JSON.stringify(value.body)}`)
      }
      assert(cases.replayFirst.status === 200, 'the first use of a grant must succeed')
      assert(
        cases.replaySecond.body.code === 'grant/replayed',
        `the replay must be reported as grant/replayed, got ${JSON.stringify(cases.replaySecond.body)}`,
      )
      // Reason codes, not just status: the anonymous admin calls carry no
      // credential (401) and the endpoints are unreachable without one.
      assert(
        cases.drainAnonymous.status === 401 || cases.drainAnonymous.status === 503,
        `anonymous drain must be refused (401/503), got ${String(cases.drainAnonymous.status)}`,
      )
      assert(
        !sessionIdsOnDisk(cells.a.home).includes(unboundSid),
        'an identity with no binding snapshot must not create a session',
      )
      assert(
        !sessionIdsOnDisk(cells.a.home).includes(neverCreated),
        'a send to a never-created session must not create one',
      )
      assert(
        cases.unboundCreate.body.code === 'identity_invalid' || cases.unboundCreate.body.code === 'open_failed',
        `the unbound create must fail on identity: ${JSON.stringify(cases.unboundCreate.body)}`,
      )
      return cases
    })

    await probe('E2E:cell-A-token-cannot-read-cell-B-bindings', async () => {
      const wrongCellPath = await fetch(`${world.works.b.origin}/internal/v1/cells/cell-a/bindings`, {
        headers: { authorization: `Bearer ${world.worksTokens.b}` },
      })
      const wrongToken = await fetch(`${world.works.b.origin}/internal/v1/cells/cell-b/bindings`, {
        headers: { authorization: `Bearer ${world.worksTokens.a}` },
      })
      const good = await fetch(`${world.works.b.origin}/internal/v1/cells/cell-b/bindings`, {
        headers: { authorization: `Bearer ${world.worksTokens.b}` },
      })
      return { wrongCellPath: wrongCellPath.status, wrongToken: wrongToken.status, good: good.status }
    })

    // ── restart: the same `$DSH_HOME`, a brand-new process ──────────────────
    await probe('E2E:revoke-closes-the-stream-and-disposes-the-agent', async () => {
      clients.a.prepareSubscribe(claimsFor('a'))
      const streamPromise = clients.a.collectEvents(sid, { lastEventId: 0, windowMs: 4000 })
      await delay(300)
      const revoked = await clients.a.admin('/v1/admin/revoke', cells.a.secrets.MYRIX_REVOKE_TOKEN, {
        sid, rev: 2, reason: 'poc revocation',
      })
      assert(revoked.status === 200, `revoke failed: ${JSON.stringify(revoked)}`)
      assert(revoked.body.accepted === true && revoked.body.disposed === true, `revoke did not dispose: ${JSON.stringify(revoked.body)}`)
      const stream = await streamPromise
      // The stream must have been closed by the Cell, not by the window.
      assert(stream.frames.length > 0, 'the stream had frames before revocation')
      // A subsequent send on the revoked session must be refused, not silently accepted.
      const afterRevoke = newCommandId()
      const signed = issuers.a.issue(claimsFor('a', { op: 'send', cmd: afterRevoke, text: 'after', rev: 2 }))
      const response = await clients.a.post(signed.rawBody, signed.grant)
      assert(response.status >= 400, `send after revoke must fail, got ${String(response.status)}`)
      return { revoke: revoked.body, afterRevoke: { status: response.status, code: response.body.code } }
    })

    await probe('E2E:restart-deduplicates-a-command-against-the-durable-log', async () => {
      // A dedicated session: the revocation probe below must run while ITS agent
      // is still live, and this probe restarts the process underneath itself.
      const restartSid = `cellA_restart_${runId}`
      world.bindings.a.push({
        sid: restartSid, tid: 't_a', sub: 'u_owner_a', wid: 'w_a', preset: 'myrix-empty', rev: 1,
      })
      const createCommandId = newCommandId()
      const createSigned = issuers.a.issue(claimsFor('a', { op: 'create', cmd: createCommandId, sid: restartSid }))
      const createResponse = await clients.a.post(createSigned.rawBody, createSigned.grant)
      assert(createResponse.status === 200, `create failed: ${JSON.stringify(createResponse)}`)

      const restartCommandId = newCommandId()
      const text = 'restart probe'
      const first = issuers.a.issue(claimsFor('a', { op: 'send', cmd: restartCommandId, text, sid: restartSid }))
      const sent = await clients.a.post(first.rawBody, first.grant)
      assert(sent.status === 200, `pre-restart send failed: ${JSON.stringify(sent)}`)
      const before = readSessionArtifact(cells.a.home, restartSid)
      const beforeCount = before.records.filter((record) => record.type === 'user/message' && record.data?.id === restartCommandId).length
      assert(beforeCount === 1, `expected exactly one durable user message, got ${String(beforeCount)}`)

      // Restart: same home, fresh process (empty in-process receipt table).
      await processes.a.stop()
      // The restart's probe report goes to a path of its own. That matters:
      // the first Cell's report is the evidence for THIS probe's assertions, and
      // a restarted Cell that overwrote it would race the read below.
      const restartedRun = `${runId}r`
      const restartedOut = join(cells.a.home, `probe-report-restart.json`)
      // Repoint only the probe row. Rebuilding the whole profile would recreate
      // `$DSH_HOME`, wiping the durable session log — the very state this probe
      // reads back to prove deduplication.
      cells.a.setProbeRun({ run: restartedRun, out: restartedOut })
      registerProbeBinding(restartedRun)
      processes.a = new CellProcess(cells.a, 'a')
      processes.a.start()
      const ready = await processes.a.waitReady()
      processes.a.readyBody = ready
      assert(ready.bootId !== sent.bootId, 'a restart must mint a new bootId')

      // The child was restarted with the SAME environment, so the probe row runs
      // again in the new process; give it a moment to publish before the retry
      // (its report is overwritten, which is expected and reported).
      const retry = issuers.a.issue({
        aud: 'cell-a',
        boot: ready.bootId,
        tid: 't_a',
        sid: restartSid,
        sub: 'u_owner_a',
        wid: 'w_a',
        preset: 'myrix-empty',
        rev: 1,
        op: 'send',
        cmd: restartCommandId,
        text,
      })
      const second = await clients.a.post(retry.rawBody, retry.grant)
      const after = readSessionArtifact(cells.a.home, restartSid)
      const afterCount = after.records.filter((record) => record.type === 'user/message' && record.data?.id === restartCommandId).length
      assert(afterCount === 1, `restart must not append a second copy (got ${String(afterCount)})`)
      return {
        preRestartBootId: sent.bootId,
        postRestartBootId: ready.bootId,
        firstDurableCopies: beforeCount,
        // The receipt table is process-local, so the retry is answered from the
        // DURABLE log: the status is `accepted` again, yet nothing is appended.
        retryStatus: second.status,
        retryBody: second.body,
        durableUserMessageCopies: afterCount,
        durableSeqRange: [
          after.records.find((record) => typeof record.seq === 'number')?.seq ?? null,
          after.records.at(-1)?.seq ?? null,
        ],
      }
    })

    await probe('E2E:probe-reports-cell-composition-and-pep-behaviour', async () => {
      // Cell A restarted earlier in this run, so its ORIGINAL probe report is
      // the artifact for the production-scope assertions; the restart report is
      // read as well to prove the restarted process re-ran its own probe.
      const out = join(cells.a.home, 'probe-report.json')
      assert(existsSync(out), `probe report missing at ${out}`)
      const report = JSON.parse(readFileSync(out, 'utf8'))
      const restartPath = join(cells.a.home, 'probe-report-restart.json')
      const restartReport = existsSync(restartPath) ? JSON.parse(readFileSync(restartPath, 'utf8')) : undefined
      assert(report.ok === true, `probe reported a failure: ${String(report.failure ?? '')}`)
      assert(report.forbiddenRows.length === 0, `forbidden rows mounted: ${report.forbiddenRows.join(', ')}`)
      const leaked = Object.entries(report.forbiddenServicesAbsent).filter(([, absent]) => absent !== true).map(([key]) => key)
      assert(leaked.length === 0, `forbidden services present: ${leaked.join(', ')}`)
      assert(report.turn.turnEnd.join(',') === 'completed', `turn did not complete: ${JSON.stringify(report.turn.turnEnd)}`)
      // The workId-in-prompt guarantee is a property of the novel presets; the
      // driver-only scope mounts no preset of its own, so it is asserted only
      // where those presets actually exist.
      if (!DRIVER_ONLY) {
        assert(report.turn.promptHasWorkId === true, 'the preset prompt must inject the server-bound workId')
        assert(report.turn.promptLeaksCredential !== true, 'the preset prompt must not contain credential material')
      }
      // The PEP: agentless and unbound calls are denied; a bound call to a tool
      // in the allowlist is allowed once a snapshot exists; a tool outside the
      // allowlist is denied.
      assert(report.guardWithoutAgent.isError === true, 'the guard must deny an agentless call')
      assert(report.guardWithoutIdentity.isError === true, 'the guard must deny an unbound agent')
      // Deterministic fail-closed check: the probe clears the holder first, so
      // this is independent of whether the R16 producer already installed one.
      assert(report.policySnapshotAbsentAfterClear === true, 'clearing the snapshot holder must leave it empty')
      assert(
        report.guardWithIdentityAllowedTool.isError === true,
        `without a policy snapshot every call must be denied: ${JSON.stringify(report.guardWithIdentityAllowedTool)}`,
      )
      assert(report.policySnapshotInstalled === true, 'the PEP must expose its documented snapshot assembly point')
      assert(
        report.guardWithSnapshotAllowedTool.isError === false,
        `with a snapshot the allow-listed tool must run: ${JSON.stringify(report.guardWithSnapshotAllowedTool)}`,
      )
      assert(
        report.guardWithSnapshotToolNotInAllowlist.isError === true,
        'the guard must deny a tool outside both the allowlist and the snapshot',
      )
      if (!DRIVER_ONLY) {
        // A novel tool from another preset is not merely discouraged: this
        // Agent's scope does not contain it, so the executor cannot resolve it.
        assert(
          report.guardToolOutOfPresetScope.isError === true,
          `a tool outside the preset scope must be unresolvable: ${JSON.stringify(report.guardToolOutOfPresetScope)}`,
        )
      }
      // The novel vertical, in the production scope.
      const novel = report.novel ?? {}
      if (DRIVER_ONLY) {
        assert(novel.mounted === false, 'a driver-only scope must report the novel vertical as absent')
        assert(typeof novel.optOut === 'string' && novel.optOut.length > 0, 'the driver-only opt-out must be documented')
      } else {
        assert(novel.mounted === true, `ctx.novelStore must exist: ${JSON.stringify(novel)}`)
        assert(
          ['novel-outline', 'novel-chapter', 'novel-bible'].every((id) => novel.presets?.includes(id)),
          `the three novel presets must be in the roster: ${JSON.stringify(novel.presets)}`,
        )
        assert((novel.broken ?? []).length === 0, `no preset may be broken: ${JSON.stringify(novel.broken)}`)
        // No novel tool in the global scope: the registration is scoped.
        const globalLeak = (novel.globalTools ?? []).filter((name) => ALLOWED_TOOLS.includes(name))
        assert(globalLeak.length === 0, `novel tools must not be globally visible: ${globalLeak.join(', ')}`)
        // Per-preset intersections, compared to the package's own mask.
        const expected = {
          'novel-outline': ['get_outline', 'search_bible', 'update_outline'],
          'novel-chapter': ['get_chapter', 'get_outline', 'save_chapter_draft', 'search_bible'],
          'novel-bible': ['get_chapter', 'get_outline', 'search_bible', 'update_bible_entry'],
        }
        for (const [preset, tools] of Object.entries(expected)) {
          const visible = novel.perPreset?.[preset]?.visible
          assert(Array.isArray(visible), `preset ${preset} must report visible tools: ${JSON.stringify(novel.perPreset?.[preset])}`)
          assert(JSON.stringify([...visible].sort()) === JSON.stringify([...tools].sort()),
            `preset ${preset} visible tools must equal its mask, got ${JSON.stringify(visible)}`)
        }
      }
      return {
        rows: report.rows.count,
        services: report.services,
        forbiddenRows: report.forbiddenRows,
        forbiddenServicesLeaked: leaked,
        tools: report.tools,
        novel,
        // The restarted process must have produced its own report (proving the
        // probe row runs on every boot) and reached the same verdict.
        restartProbe: restartReport === undefined
          ? null
          : { ok: restartReport.ok === true, mode: restartReport.mode, finished: restartReport.turn?.turnEnd ?? null },
        turn: {
          turnEnd: report.turn.turnEnd,
          userMessageIds: report.turn.userMessageIds,
          eventTypes: report.turn.eventTypes,
          seqs: report.turn.seqs,
        },
        pep: {
          withoutAgent: report.guardWithoutAgent.errorMessage,
          withoutIdentity: report.guardWithoutIdentity.errorMessage,
          noSnapshotDenial: report.guardWithIdentityAllowedTool.errorMessage,
          snapshotInstalled: report.policySnapshotInstalled,
          withSnapshotAllowed: report.guardWithSnapshotAllowedTool,
          withSnapshotUnlistedDenial: report.guardWithSnapshotToolNotInAllowlist.errorMessage,
        },
      }
    })

    await probe('E2E:novel-tools-cross-the-real-works-service', async () => {
      // The novel vertical over real HTTP: the Cell's own tool execution goes
      // through `myrix-novel`'s client to the works stub, which derives the work
      // from the session binding. Only the six names exist, and each call
      // carries the session id and its rev.
      const calls = world.works.a.toolCalls
      const observed = calls.map((call) => call.tool)
      const unknown = observed.filter((tool) => !ALLOWED_TOOLS.includes(tool))
      assert(unknown.length === 0, `a non-protocol tool reached the works service: ${unknown.join(', ')}`)
      if (!DRIVER_ONLY) {
        assert(calls.length > 0, 'the production Cell must have exercised at least one real novel tool')
        assert(observed.includes('get_outline'), `the probe's allow-path tool must have reached the works service: ${JSON.stringify(observed)}`)
      }
      for (const call of calls) {
        assert(typeof call.sid === 'string' && call.sid.length > 0, `a tool call had no session attribution: ${JSON.stringify(call)}`)
        assert(typeof call.revision === 'string', `a tool call had no revision header: ${JSON.stringify(call)}`)
        const forbidden = ['tenantId', 'userId', 'workId', 'sessionId', 'wid', 'tid', 'sub']
        for (const field of forbidden) {
          assert(!(field in call.args), `tool arguments must not carry identity field ${field}: ${JSON.stringify(call.args)}`)
        }
      }
      return { calls: calls.length, tools: [...new Set(observed)].sort(), attributed: calls.every((call) => call.sid.length > 0) }
    })
  } finally {
    for (const id of CELL_IDS) await processes[id].stop().catch(() => undefined)
    await world.close()
  }

  const passed = results.filter((entry) => entry.ok).length
  const report = {
    generatedAt: new Date().toISOString(),
    dsh: {
      cli: cells.a.install.cli,
      version: cells.a.install.version,
      vendorCommit: '639ed015397290b3745d163aafe02ffee4aa3f84',
      note: 'npm package version equals the pinned submodule version but is not proven to be the same build',
    },
    cells: Object.fromEntries(CELL_IDS.map((id) => [id, {
      home: cells[id].home,
      url: cells[id].cellUrl,
      bootId: processes[id].readyBody?.bootId ?? null,
      compiled: { built: cells[id].compiled.built, reused: cells[id].compiled.reused, skipped: cells[id].compiled.skipped },
    }])),
    standins: {
      modelGateway: {
        // Responses only: the legacy chat/completions route is a 404 by
        // construction and is asserted as a negative case above.
        origin: world.gateway.origin,
        endpoint: world.gateway.url,
        protocol: 'OpenAI Responses (the adapter appends /responses; no chat/completions route exists)',
        upstreamKeyConfigured: true,
        production: 'apps/model-gateway :8790',
      },
      worksService: Object.fromEntries(CELL_IDS.map((id) => [id, { origin: world.works[id].origin, production: 'apps/works-service :8791' }])),
      controlPlaneKey: 'generated in-process with @myrix/grant generateTestKeyPair (production: KMS)',
      // The driver now declares the default route itself, so the PoC runs the
      // production shape and the seam row is disabled in this profile.
      routeSeam: 'disabled (driver owns defaultProvider/defaultModel)',
      policyBridge: DRIVER_ONLY
        ? 'absent: --driver-only PoC scope (no policy snapshot producer)'
        : 'finite same-tenant policy snapshot served beside the six-field binding rows; requirePolicy: true',
    },
    scope: DRIVER_ONLY
      ? 'poc driver-only: the novel vertical is intentionally omitted (documented opt-out)'
      : 'production shape: novel vertical mounted, requirePolicy: true',
    results,
    probeSummary: { total: results.length, passed, failed: results.length - passed },
  }
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })

  process.stdout.write('\n=== Myrix isolated Cell PoC ===\n')
  for (const entry of results) {
    process.stdout.write(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}\n`)
    const detail = JSON.stringify(entry.ok ? entry.detail : entry.error)
    process.stdout.write(`      ${detail.length > 700 ? `${detail.slice(0, 700)}…` : detail}\n`)
  }
  process.stdout.write(`\n${passed}/${results.length} probes passed\nreport: ${REPORT}\n`)
  process.exit(results.length - passed === 0 ? 0 : 2)
}

/** Compose one Cell profile with `--dump-config` and return the raw run. */
function dumpConfig(cell) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cell.install.cli, '--profile', cell.profileName, '--dump-config'], {
      cwd: REPO,
      env: cellEnv(cell),
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('exit', (status) => resolve({ status, stdout, stderr }))
  })
}

main().catch((error) => {
  process.stderr.write(`myrix-poc: run-cell failed: ${String(error?.stack ?? error)}\n`)
  process.exit(1)
})
