/**
 * Test-local Cell self-check probe.
 *
 * It runs **inside** a real Cell process (locked DSH + `myrix-base` + the Myrix
 * plugin layer) and records what the assembly actually did:
 *
 *   * which Myrix services became available (and that the forbidden ones did not);
 *   * whether the driver registered its HTTP endpoints;
 *   * whether a real agent turn reaches a registered model adapter, and through
 *     which route;
 *   * what the real `myrix-policy-enforcer` guard answers for a real
 *     `ctx.tools.execute()` call with and without an identity, with and without
 *     a policy snapshot;
 *   * whether the mounted novel presets scope their tools correctly.
 *
 * The report is written as JSON so failures are data, not a boot crash. It is
 * disabled unless `MYRIX_CELL_PROBE === '1'`.
 *
 * ## Modes
 *
 * * `novel` — the production shape: `@myrix/novel` is mounted, the probe's own
 *   Agent uses the `novel-outline` preset, and the policy allow-path is
 *   exercised with a REAL novel tool (`get_outline`) through the works service.
 * * `driver-only` — the explicit PoC opt-out: no novel vertical, so the probe
 *   falls back to its own test-only echo tool and records the absence rather
 *   than failing.
 *
 * @module myrix-cell-probe
 */

import { writeFileSync } from 'node:fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { policySnapshotHolderOf } from '@myrix/policy-enforcer'

export const name = 'myrix-cell-probe'

/**
 * Services the probe drives.
 *
 * `cmdlineArgs` is deliberately NOT injected: a Cell profile has no command-line
 * layer, and requiring it would keep this row from ever activating. `appReady`
 * is read optionally so the probe works both with and without an app-boot layer.
 *
 * `principals` is a hard dependency on purpose: the probe installs the binding
 * that makes its own agent turn legal, exactly as `myrix-runtime-driver` does
 * from a verified grant (the probe uses a literal principal because it has no
 * control plane to talk to).
 */
export const inject = ['sessions', 'agents', 'agentLoop', 'agentPresets', 'tools', 'systemPrompt', 'principals']

/** The probe scopes. See the module docs. */
const PROBE_MODES = ['novel', 'driver-only']

/** Forbidden service keys: a Cell must not expose any of them. */
const FORBIDDEN_SERVICES = [
  'subprocess', 'terminal', 'terminals', 'bash', 'sandbox', 'sandboxPolicy',
  'fs', 'web', 'jobs', 'goals', 'subagents', 'workflowEngine', 'skills',
  'pluginManager', 'configEditor', 'settings', 'hmr', 'sessionQuery',
  'storage', 'storageDomain', 'spillStore', 'commands', 'userQuestions',
  'agentTeams', 'webRuntime', 'modules', 'connection',
]

/** Plugin rows a Cell must never mount. */
const FORBIDDEN_ROWS = [
  'dsh-base', 'dsh-tool-bash', 'dsh-tool-pwsh', 'dsh-terminal', 'dsh-subprocess-local',
  'dsh-sandbox-local', 'dsh-sandbox-policy', 'dsh-tool-fs', 'dsh-fs-local', 'dsh-tool-web',
  'dsh-web-fetch-http', 'dsh-web-search', 'dsh-jobs-local', 'dsh-tool-jobs', 'dsh-goal',
  'dsh-subagent', 'dsh-tool-workflow', 'dsh-workflow-ptc', 'dsh-mcp-client', 'dsh-mcp-resources',
  'dsh-plugin-manager', 'dsh-hmr', 'dsh-config-editor', 'dsh-settings', 'dsh-credentials-local',
  'dsh-web-app', 'dsh-client-modules', 'dsh-client-connection', 'dsh-client-ui-', 'dsh-skill',
  'dsh-agent-instructions', 'dsh-ptc-runtime', 'dsh-session-query-sqlite', 'dsh-plan-mode',
]

/** The novel presets, with the tool mask each one must expose. */
const NOVEL_PRESET_TOOLS = {
  'novel-outline': ['get_outline', 'search_bible', 'update_outline'],
  'novel-chapter': ['get_chapter', 'get_outline', 'save_chapter_draft', 'search_bible'],
  'novel-bible': ['get_chapter', 'get_outline', 'search_bible', 'update_bible_entry'],
}

/** The six novel tool names; the only business tools a Cell may expose. */
const NOVEL_TOOL_NAMES = new Set(Object.values(NOVEL_PRESET_TOOLS).flat())

/**
 * Register the probe and run it once the tree is ready.
 *
 * `appReady` is optional: when a profile has no app-boot layer the probe still
 * needs to run, so it falls back to a short timer that lets the loader settle.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning context.
 * @param {{ out: string, provider: string, model: string, mode?: string, principal?: object, run?: string, echoTool?: string }} config - report destination + route.
 */
export function apply(ctx, config) {
  const echoTool = typeof config?.echoTool === 'string' && config.echoTool.length > 0
    ? config.echoTool
    : 'myrix_probe_echo'
  /** A second tool that the Cell's allowlist deliberately does NOT contain. */
  const deniedTool = `${echoTool}_denied`
  const probePrincipal = readPrincipal(config)
  /**
   * Which composition this probe reports on.
   *
   * `driver-only` is the explicit PoC opt-out from the novel vertical; it is
   * recorded in the report so a missing preset roster reads as a chosen scope,
   * never as an unexplained absence.
   */
  const mode = PROBE_MODES.includes(config?.mode) ? config.mode : 'driver-only'
  /** The preset the probe's own Agent mounts. */
  const preset = mode === 'novel' ? 'novel-outline' : 'myrix-empty'
  /**
   * The tool whose ALLOW path is observed.
   *
   * In `novel` mode it is a real novel tool, so the deployment allowlist can
   * stay exactly the six business tools. It is only visible because the Agent
   * mounts the `novel-outline` preset, which is itself part of what is proven.
   */
  const allowedTool = mode === 'novel' ? 'get_outline' : echoTool
  /** Everything the probe observed, written out as JSON at the end. */
  const report = { started: Date.now(), ok: false, mode, preset, allowedTool }

  // `run` makes each boot's report unique. Without it a restart (the crash-
  // recovery probe) would try to re-create the same session id and the probe
  // would report `SessionAlreadyExistsError` instead of a clean turn.
  const runTag = typeof config?.run === 'string' && config.run.length > 0 ? config.run : String(Date.now())
  const sid = `${probePrincipal.sid}_${runTag}`
  const boundPrincipal = { ...probePrincipal, sid, preset }

  /**
   * Bind an agent to the probe principal.
   *
   * Liveness is NOT installed here when a binding lease is present: the real
   * lease owns `principals.setLiveness` in a Cell, and the probe must be judged
   * by it. Without a lease (standalone use) a literal verdict is installed so the
   * guard still has a defined answer — never "no liveness installed" silently
   * becoming an allow.
   */
  function bind(agent) {
    return ctx.principals.bind(agent, boundPrincipal)
  }

  // Two trivial tools so the guard has something real to decide about when the
  // novel vertical is absent. They are registered in the *global* layer, exactly
  // like business tools would be; in `novel` mode NEITHER is in the deployment
  // allowlist, which is what proves the allowlist — not mere registration —
  // decides.
  for (const name of [echoTool, deniedTool]) {
    ctx.effect(() => ctx.tools.register({
      name,
      description: `Myrix probe tool ${name} (test only).`,
      parameters: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
      output: {
        schema: { type: 'object', properties: { echo: { type: 'string' } }, required: ['echo'], additionalProperties: false },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        const text = args !== null && typeof args === 'object' && typeof args.text === 'string' ? args.text : ''
        return { echo: text }
      },
    }), `myrix-cell-probe: ${name}`)
  }

  const run = () => { void collect() }

  if (ctx.get('appReady') !== undefined) {
    ctx.effect(() => ctx.appReady.onReady(() => { run() }), 'myrix-cell-probe: onReady')
  } else {
    // No app-boot layer in this profile: run after the current activation wave.
    ctx.effect(() => {
      const handle = setTimeout(run, 50)
      return () => clearTimeout(handle)
    }, 'myrix-cell-probe: timer')
  }

  /** Drive the real pipeline and write the report. */
  async function collect() {
    try {
      const loader = ctx.get('loader')
      const rows = loader === undefined ? [] : [...loader.entries()].map((entry) => String(entry.options?.name ?? ''))
      report.services = Object.fromEntries(
        [
          'webServer', 'principals', 'bindingLease', 'sessions', 'sessionPersistence',
          'agents', 'agentLoop', 'agentPresets', 'llm', 'tools', 'systemPrompt',
          'sessionProjections', 'tokenMeter', 'compaction', 'approval', 'attachments',
        ].map((key) => [key, ctx.get(key) !== undefined]),
      )
      report.forbiddenServicesAbsent = Object.fromEntries(
        FORBIDDEN_SERVICES.map((key) => [key, ctx.get(key) === undefined]),
      )
      report.rows = { count: rows.length, names: rows }
      report.forbiddenRows = FORBIDDEN_ROWS.filter((needle) => rows.some((name) => name.includes(needle)))
      report.tools = ctx.tools.schemas().map((schema) => schema.name)

      // 1) Guard/identity negative case: no agent scope at all.
      report.guardWithoutAgent = await executeTool(undefined, allowedTool, 'no-agent')

      // 1b) With an agent but no bound principal.
      report.guardWithoutIdentity = await executeTool({ id: 'probe_unbound_agent' }, allowedTool, 'no-identity')

      // 2) Real agent turn through the real loop, under the probe's preset.
      const handle = await ctx.agents.create({
        sessionId: sid,
        meta: { agentPreset: preset },
        agentOptions: { provider: config.provider, model: config.model },
        setup: async (agentCtx, agent) => {
          const unbind = bind(agent)
          agentCtx.effect(() => unbind)
          await ctx.agentPresets.mount(agentCtx, preset)
        },
      })
      report.agent = { created: true, id: String(handle.agent.id) }
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'probe' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      const flushed = await ctx.sessions.flush(handle.agent.session)
      const events = handle.agent.session.snapshotEvents()
      report.turn = {
        flushed: flushed === true,
        eventTypes: events.map((event) => event.type),
        seqs: events.map((event) => Number(event.seq)),
        turnEnd: events.filter((event) => event.type === 'turn/end')
          .map((event) => event.data?.reason?.kind ?? null),
        attempts: events.filter((event) => event.type === 'assistant/attempt')
          .map((event) => String(event.data?.failure?.code ?? event.data?.failure?.message ?? '')),
        userMessageIds: events.filter((event) => event.type === 'user/message')
          .map((event) => String(event.data?.id ?? '')),
      }
      // The Agent's scope view: the evidence that tools are scoped, not global.
      report.turn.visibleTools = ctx.tools.schemas(handle.agent).map((schema) => schema.name).sort()
      // The preset prompt must inject the SERVER-bound workId and nothing else.
      const assembly = await ctx.systemPrompt.assemble({ agent: handle.agent, scope: handle.agent })
      const promptText = assembly.sections.map((section) => section.text).filter(Boolean).join('\n')
      report.turn.promptHasWorkId = promptText.includes(boundPrincipal.wid)
      report.turn.promptLeaksCredential = promptText.includes(config.credential ?? '\u0000')

      // 3) The PEP, exercised against a real bound agent with a REAL lease.
      const holder = policySnapshotHolderOf(ctx)
      //    (a) No snapshot installed: denied. The probe holds the snapshot
      //        itself, so it CLEARS first and then observes the denial — that is
      //        a deterministic test of the documented fail-closed requirement,
      //        independent of whether a producer has already installed one.
      holder?.clear()
      report.guardWithIdentityAllowedTool = await executeTool(handle.agent, allowedTool, 'bound-allowed')
      report.policySnapshotAbsentAfterClear = holder?.current() === undefined
      report.policySnapshotInstalled = holder !== undefined
      report.policySnapshotPresentFromProducer = holder !== undefined && report.guardWithIdentityAllowedTool.snapshotWasPresent === true

      //    (b) With the snapshot installed through the documented assembly point
      //        (`policySnapshotHolderOf(ctx).install`): the allow-listed tool
      //        runs (through the works service in `novel` mode), while a tool
      //        outside the allowlist is still denied.
      //
      //        The rev is deliberately the SAME rev the producer uses. The
      //        holder keeps a monotonically non-decreasing high-water mark and
      //        the binding lease re-installs from every snapshot refresh, so a
      //        probe that installed a HIGHER rev would make the producer's next
      //        refresh look like a version regression, clear the whole lease and
      //        break every later command. A probe must never out-rank its
      //        producer.
      const probeTools = mode === 'novel'
        ? [...new Set([allowedTool, ...Object.values(NOVEL_PRESET_TOOLS).flat()])]
        : [allowedTool]
      holder?.install({
        rev: 1,
        tid: boundPrincipal.tid,
        expiresAt: Date.now() + 60_000,
        tools: probeTools,
      })
      report.guardWithSnapshotAllowedTool = await executeTool(handle.agent, allowedTool, 'bound-with-snapshot')
      report.guardWithSnapshotToolNotInAllowlist = await executeTool(handle.agent, deniedTool, 'bound-unlisted')
      //    (c) In `novel` mode, a real novel tool that belongs to a DIFFERENT
      //        preset must be invisible to this Agent — scoping, not persuasion.
      //        The snapshot above already includes it, so the ONLY remaining
      //        reason for the denial is that this Agent's scope does not carry
      //        the definition. A policy denial would prove nothing about scope.
      if (mode === 'novel') {
        report.guardToolOutOfPresetScope = await executeTool(handle.agent, 'save_chapter_draft', 'out-of-preset-scope')
        report.guardToolOutOfPresetScope.policyAllowed = probeTools.includes('save_chapter_draft')
      } else {
        report.guardToolOutOfPresetScope = { skipped: 'driver-only: no novel presets are mounted' }
      }

      // 4) The novel vertical's composition (roster, masks, global visibility).
      report.novel = await reportNovel()
      await handle.dispose()
      report.ok = true
    } catch (error) {
      report.failure = String(error?.stack ?? error)
    } finally {
      writeFileSync(config.out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    }
  }

  /**
   * Report the novel vertical's composition.
   *
   * In `driver-only` mode this is a recorded, deliberate absence. In `novel`
   * mode it drives each preset to a real Agent and captures what that Agent can
   * see, plus the global scope's tool list for the "no global registration"
   * claim. It never asserts on the works service: that is the runner's job.
   */
  async function reportNovel() {
    if (mode !== 'novel') {
      return { mounted: false, optOut: 'driver-only: the PoC scope exercises the driver/identity path only' }
    }
    const store = ctx.get('novelStore')
    const roster = await ctx.agentPresets.list()
    const presets = roster.map((row) => row.id)
    const globalTools = ctx.tools.schemas().map((schema) => schema.name)
    const perPreset = {}
    for (const id of Object.keys(NOVEL_PRESET_TOOLS)) {
      if (!presets.includes(id)) {
        perPreset[id] = { error: 'preset not in roster' }
        continue
      }      let handle
      try {
        // `principals.bind` requires the credential `sid` to equal the Agent
        // id, so each preset Agent gets a session id that is also its bound sid.
        const presetSid = `${boundPrincipal.sid}_${id}`
        handle = await ctx.agents.create({
          sessionId: presetSid,
          meta: { agentPreset: id },
          agentOptions: { provider: config.provider, model: config.model },
          setup: async (agentCtx, agent) => {
            const unbind = ctx.principals.bind(agent, { ...boundPrincipal, sid: presetSid, preset: id })
            agentCtx.effect(() => unbind)
            await ctx.agentPresets.mount(agentCtx, id)
          },
        })
        const visible = ctx.tools.schemas(handle.agent).map((schema) => schema.name)
        perPreset[id] = {
          visible: visible.filter((name) => NOVEL_TOOL_NAMES.has(name)).sort(),
          allVisible: visible.sort(),
          broken: roster.find((row) => row.id === id)?.broken ?? null,
          expected: [...NOVEL_PRESET_TOOLS[id]].sort(),
        }
      } catch (error) {
        perPreset[id] = { error: String(error?.message ?? error) }
      } finally {
        await handle?.dispose().catch(() => undefined)
      }
    }
    return {
      mounted: store !== undefined,
      presets,
      broken: roster.filter((row) => row.broken !== undefined).map((row) => [row.id, row.broken]),
      globalTools,
      perPreset,
    }
  }

  /** Execute one tool with the given agent scope and flatten the result. */
  async function executeTool(agent, name, label) {
    const result = await ctx.tools.execute({
      callId: `probe_${label}`,
      name,
      arguments: name === 'get_outline' ? {} : { text: label },
      ...agent === undefined ? {} : { agent },
      signal: new AbortController().signal,
    })
    return {
      label,
      tool: name,
      isError: result.isError === true,
      value: result.isError === true ? null : result.value,
      errorMessage: result.isError === true ? String(result.error?.message ?? '') : null,
      errorCode: result.isError === true ? String(result.error?.info?.code ?? '') : null,
      content: result.content,
      snapshotWasPresent: policySnapshotHolderOf(ctx)?.current() !== undefined,
    }
  }

  /** Read the launcher-supplied principal, or derive a standalone one. */
  function readPrincipal(cfg) {
    const raw = cfg?.principal
    if (raw !== null && typeof raw === 'object'
      && typeof raw.sid === 'string' && raw.sid.length > 0
      && typeof raw.tid === 'string' && raw.tid.length > 0) {
      return {
        sid: raw.sid,
        tid: raw.tid,
        sub: String(raw.sub ?? 'u_probe'),
        wid: String(raw.wid ?? 'w_probe'),
        preset: String(raw.preset ?? 'myrix-empty'),
        rev: Number(raw.rev ?? 0),
      }
    }
    return {
      sid: `cell_probe_${String(Date.now())}`,
      tid: 't_probe',
      sub: 'u_probe',
      wid: 'w_probe',
      preset: 'myrix-empty',
      rev: 0,
    }
  }

  /** Expose the probe principal so the launcher can register a matching binding row. */
  report.principal = boundPrincipal
}
