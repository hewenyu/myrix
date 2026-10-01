/**
 * Myrix Phase0 P1/P2 runtime PoC — the app plugin that boots inside the real
 * locked DSH and records what actually happened.
 *
 * Everything it asserts is measured against the live tree: the whitelist
 * bundle (`bundles/myrix-base`) with NO `dsh-base`, the real `dsh-session`
 * JSONL store, the real `dsh-agent-loop`, the real `dsh-tools` registry and
 * the real `dsh-agent-preset-registry`. The only substituted piece is the
 * model adapter (`poc-mock-llm.mjs`), because a real provider key is out of
 * scope for the PoC.
 *
 * The report is written as JSON to `config.out` and the process exits 0 even
 * when probes fail, so failures are reported as data rather than as a boot
 * crash. Each probe is tagged `P1` or `P2` to match the Phase 0 gate.
 *
 * The compaction probe below is the one place a probe has to *produce* engine
 * success rather than merely watch it: the app grows a long, genuinely
 * compactable history (the same deterministic filler repeated under distinct
 * per-turn labels, so the summarizer's cache-reusing prefix stays distinct),
 * asks the real `ctx.compaction` engine for a manual compaction, and then reads
 * the durable log back to assert the persisted replacement. The model adapter
 * is still the in-memory `poc-mock-llm` stand-in; nothing from the real engine
 * or the locked persistence backend is substituted or relaxed.
 * @module myrix-poc-app
 */

import { writeFileSync } from 'node:fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { observedCalls } from './poc-mock-llm.mjs'

/** Ordered probe outcomes. */
const results = []

/**
 * Deterministic, highly compressible filler used to give the real engine a
 * history it can actually shrink. The long shared body is what makes the
 * summary smaller; the per-turn label around it keeps every turn distinct so
 * the summarizer's replayed prefix is the real conversation, not one repeated
 * message.
 */
const POC_FILLER_BODY = 'myrix-poc compactable history filler: the sealed governance cell reviews policy decisions, '
  + 'records audit events, and reconciles plugin inventory with the locked runtime. '
const POC_FILLER_REPEAT = 24

/**
 * Build one turn's deterministic user text.
 * @param {number} index - zero-based turn index.
 * @returns distinct, compressible user text for that turn.
 */
function pocTurnText(index) {
  return `poc-turn-${index} ${POC_FILLER_BODY.repeat(POC_FILLER_REPEAT)}`
}

/** Turns appended before the manual compaction attempt. */
const POC_COMPACT_TURNS = 8

/**
 * Run one named probe, capturing a thrown error as a failed outcome.
 * @param {string} name - stable probe label, prefixed with its gate.
 * @param {() => Promise<unknown>} fn - the probe body.
 */
async function probe(name, fn) {
  try {
    results.push({ name, ok: true, detail: await fn() })
  } catch (error) {
    results.push({
      name,
      ok: false,
      error: String(error?.message ?? error),
      stack: String(error?.stack ?? '').split('\n').slice(0, 4).join('\n'),
    })
  }
}

export const name = 'myrix-poc-app'
export const inject = [
  'cmdlineArgs', 'appExit', 'appReady', 'sessions', 'agents', 'agentPresets',
  'llm', 'tools', 'systemPrompt', 'sessionPersistence', 'sessionProjections', 'approval',
]

/**
 * Wire the probes and run them once startup is committed.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the tree context.
 * @param {{ out: string }} config - report destination.
 */
export function apply(ctx, config) {
  /** Durable session events observed through `session/event`. */
  const durable = []
  /** Transient assistant-stream publications observed through `agent/assistant-stream`. */
  const transient = []

  ctx.on('session/event', (session, event) => {
    durable.push({
      sid: session.id,
      type: event.type,
      seq: event.seq,
      // `user/message` carries the UserMessage itself, so the explicit
      // identity is `event.data.id` — this is what R3 depends on.
      dataId: event.data?.id ?? null,
      hasOwnId: event.data !== null && typeof event.data === 'object' && Object.hasOwn(event.data, 'id'),
    })
  })
  ctx.on('agent/assistant-stream', payload => {
    transient.push({ keys: Object.keys(payload).sort(), agentId: payload.agent?.id ?? null, frame: payload.frame?.type ?? null })
  })

  ctx.effect(() => ctx.appReady?.onReady?.(() => { void run() }))

  async function run() {
    const forbiddenServices = [
      'subprocess', 'terminal', 'terminals', 'bash', 'sandbox', 'sandboxPolicy',
      'fs', 'web', 'jobs', 'goals', 'subagents', 'workflowEngine', 'skills',
      'pluginManager', 'configEditor', 'settings', 'hmr', 'sessionQuery',
      'storage', 'storageDomain', 'spillStore', 'commands', 'userQuestions',
      'agentTeams',
    ]
    const forbiddenRows = [
      'dsh-base', 'dsh-tool-bash', 'dsh-tool-pwsh', 'dsh-tool-bash-persistent',
      'dsh-terminal', 'dsh-subprocess-local', 'dsh-sandbox-local', 'dsh-sandbox-policy',
      'dsh-tool-fs', 'dsh-tool-fs-search', 'dsh-fs-local', 'dsh-tool-web',
      'dsh-web-fetch-http', 'dsh-web-search-deepseek', 'dsh-jobs-local', 'dsh-tool-jobs',
      'dsh-goal', 'dsh-tool-goal', 'dsh-subagent', 'dsh-tool-subagent',
      'dsh-tool-workflow', 'dsh-workflow-ptc', 'dsh-mcp-client', 'dsh-mcp-resources',
      'dsh-plugin-manager', 'dsh-hmr', 'dsh-config-editor', 'dsh-settings',
      'dsh-credentials-local', 'dsh-web-app', 'dsh-api-session-controller',
      'dsh-skill-filesystem', 'dsh-agent-instructions', 'dsh-ptc-runtime-node',
      'dsh-session-query-sqlite', 'dsh-plan-mode',
    ]

    const sid = `poc_main_${Date.now()}`
    let handle

    await probe('P1:whitelist-boots-without-dsh-base', async () => ({
      servicesPresent: Object.fromEntries(
        ['sessions', 'agents', 'agentPresets', 'llm', 'tools', 'systemPrompt', 'sessionPersistence',
          'sessionProjections', 'tokenMeter', 'compaction', 'approval', 'attachments']
          .map(key => [key, ctx.get(key) !== undefined])),
      forbiddenServicesAbsent: Object.fromEntries(
        forbiddenServices.map(key => [key, ctx.get(key) === undefined])),
    }))

    await probe('P1:no-forbidden-plugin-rows-mounted', async () => {
      // The Loader service materializes during the first `loader.create()`, so
      // read it lazily here rather than assuming it exists at apply() time.
      const loader = ctx.get('loader')
      if (loader === undefined) return { loaderPresent: false, leaked: forbiddenRows, names: [] }
      const names = [...loader.entries()].map(entry => String(entry.options?.name ?? ''))
      const leaked = forbiddenRows.filter(row => names.some(name => name.includes(row)))
      // `dsh-base` is a dependency of the dsh CLI, so it is always *installed*.
      // What the whitelist controls is whether its patch layer ever mounts.
      // Distinguish the two explicitly so "we don't ship dsh-base" is never
      // mistaken for a statement about node_modules.
      let dshBaseResolvable = false
      try {
        const { createRequire } = await import('node:module')
        createRequire(import.meta.url).resolve('@deepseek-ai/dsh-base/package.json')
        dshBaseResolvable = true
      } catch { dshBaseResolvable = false }
      return {
        loaderPresent: true,
        rowCount: names.length,
        leaked,
        dshBaseInstalledButNotMounted: { resolvableInNodeModules: dshBaseResolvable, mountedAsRow: names.some(name => name.includes('dsh-base')) },
        names,
      }
    })

    await probe('P1:tool-surface-is-empty', async () => ({
      schemas: ctx.tools.schemas().map(schema => schema.name),
      presetCount: (await ctx.agentPresets.list()).map(preset => preset.id),
    }))

    await probe('P1:create-await-preset-mount-and-commit', async () => {
      let setupRan = false
      let commitRan = false
      let mountedPreset = null
      handle = await ctx.agents.create({
        sessionId: sid,
        meta: { agentPreset: 'myrix-empty' },
        agentOptions: { provider: 'poc-mock', model: 'poc-model' },
        setup: async (agentCtx, agent) => {
          setupRan = true
          // A7 decision: `await presets.mount()` inside setup.
          const preset = await ctx.agentPresets.mount(agentCtx, 'myrix-empty')
          mountedPreset = preset?.id ?? null
          return { commit() { commitRan = true } }
        },
      })
      return {
        setupRan,
        commitRan,
        mountedPreset,
        headerPreset: handle.agent.session.header.agentPreset,
        headerKeys: Object.keys(handle.agent.session.header),
      }
    })

    await probe('P1:setup-commit-throw-rolls-back-without-publishing', async () => {
      const badSid = `poc_rollback_${Date.now()}`
      let failed = false
      let message = ''
      try {
        await ctx.agents.create({
          sessionId: badSid,
          setup: () => { throw new Error('myrix-poc: deliberately failing setup') },
        })
      } catch (error) { failed = true; message = String(error?.message ?? error) }
      return { failed, message, published: ctx.agents.get(badSid) !== undefined }
    })

    await probe('P2:followup-accepts-explicit-messageId', async () => {
      const message = createUserMessage({ content: [{ type: 'text', text: 'poc turn' }], source: { kind: 'user' } })
      const forced = { ...message, id: 'poc_cmd_0001' }
      handle.agent.followup(forced)
      const flushed = await ctx.sessions.flush(handle.agent.session)
      return { requestedId: forced.id, flushed, inboxNextTurn: handle.agent.inbox.nextTurn.length }
    })

    await probe('P2:durable-events-carry-contiguous-seq-and-messageId', async () => {
      await handle.agent.whenIdle()
      await ctx.sessions.flush(handle.agent.session)
      const mine = durable.filter(entry => entry.sid === sid)
      const userEvents = mine.filter(entry => entry.type === 'user/message')
      return {
        eventTypes: mine.map(entry => entry.type),
        seqs: mine.map(entry => entry.seq),
        seqIsZeroBasedContiguous: mine.every((entry, index) => entry.seq === index),
        userMessageIds: userEvents.map(entry => entry.dataId),
        messageIdSurvivesToLog: userEvents.some(entry => entry.dataId === 'poc_cmd_0001'),
        lastSeq: mine.at(-1)?.seq ?? null,
      }
    })

    await probe('P2:restart-resume-reuses-the-same-seq-space', async () => {
      // `config.resumeTarget` is written by the runner on the second pass: it
      // names a session id whose JSONL already exists on disk from a previous
      // process. Resuming it proves the log reloads and that `seq` continues
      // from the stored boundary, which is what SSE `Last-Event-ID` relies on.
      const target = config.resumeTarget
      if (typeof target !== 'string' || target === '') {
        return { skipped: 'no resumeTarget configured for this pass' }
      }
      const previousFinalSeq = config.resumePreviousFinalSeq
      const resumed = await ctx.agents.resume({
        resumeSessionId: target,
        setup: async (agentCtx, agent) => {
          await ctx.agentPresets.mount(agentCtx, agent.session.header.agentPreset ?? 'myrix-empty')
        },
      })
      // Every durable event this process emits for the resumed session,
      // including anything `resume` itself appended before the setup ran.
      const onResume = durable.filter(entry => entry.sid === target).map(entry => ({ type: entry.type, seq: entry.seq }))
      await new Promise(resolve => setImmediate(resolve))
      const afterResumeSettled = durable.filter(entry => entry.sid === target).map(entry => ({ type: entry.type, seq: entry.seq }))

      // One more user turn continues the sequence without renumbering.
      resumed.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'after restart' }], source: { kind: 'user' } }))
      await resumed.agent.whenIdle()
      await ctx.sessions.flush(resumed.agent.session)
      const all = durable.filter(entry => entry.sid === target)
      const afterTurn = all.map(entry => ({ type: entry.type, seq: entry.seq }))
      await resumed.dispose()
      const firstNewSeq = afterTurn[0]?.seq ?? null
      const delta = firstNewSeq === null || previousFinalSeq === null ? null : firstNewSeq - previousFinalSeq
      return {
        previousProcessFinalSeqOnDisk: previousFinalSeq ?? null,
        eventsEmittedByResumeItself: onResume.length === 0 ? afterResumeSettled : onResume,
        allEventsThisProcess: afterTurn,
        firstNewSeq,
        seqDeltaAcrossRestart: delta,
        seqStrictlyIncreases: afterTurn.every((entry, index) => index === 0 || entry.seq > afterTurn[index - 1].seq),
        // The load-bearing SSE invariant: a resumed session continues the same
        // seq space, so `Last-Event-ID` stays meaningful and no committed seq
        // is ever reused for different content.
        //
        // The observed delta is 2, not 1, and that is a design input rather
        // than noise: when a process stops without committing its teardown
        // marker, DSH repairs the log on resume by appending a synthetic
        // `session/end-seed` closer, which consumes the intervening seq. An
        // SSE resume must therefore dedupe by `seq` and tolerate a gap; it
        // must never assume `lastCommittedSeq + 1` is the next seq.
        seqContinuesWithoutReuse: firstNewSeq !== null && previousFinalSeq !== null && firstNewSeq > previousFinalSeq,
        seqDeltaIsOneOnlyWhenTeardownMarkerCommitted: delta === 1,
      }
    })

    await probe('P1:assistant-stream-payload-shape', async () => {
      const rows = transient.filter(entry => entry.agentId === sid)
      const first = transient.at(-1)
      return {
        payloadKeys: first?.keys ?? null,
        sessionIdFieldIsPayloadAgentId: rows.length > 0 && rows.every(entry => entry.agentId === sid),
        frameTypes: rows.map(entry => entry.frame),
        chunkFramesTransient: rows.filter(entry => entry.frame === 'chunk').length,
      }
    })

    await probe('P2:model-call-carries-sessionId-for-attribution', async () => ({
      calls: observedCalls(),
      conversationCallHasSessionId: observedCalls().some(call => call.purpose === null && call.sessionId === sid),
    }))

    await probe('P2:assistant-stream-agent-field-is-the-session-id', async () => ({
      note: 'agent/assistant-stream payload is { agent, frame }; payload.agent.id === sessionId',
      observedAgentIds: [...new Set(transient.map(entry => entry.agentId))],
    }))

    await probe('P2:resume-from-disk-and-preset-mismatch', async () => {
      const resumeSid = `poc_resume_${Date.now()}`
      const first = await ctx.agents.create({
        sessionId: resumeSid,
        meta: { agentPreset: 'myrix-empty' },
        agentOptions: { provider: 'poc-mock', model: 'poc-model' },
      })
      first.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'persist me' }], source: { kind: 'user' } }))
      await first.agent.whenIdle()
      await ctx.sessions.flush(first.agent.session)
      await first.dispose()

      let presetSeenInSetup = null
      let mountAccepted = false
      const resumed = await ctx.agents.resume({
        resumeSessionId: resumeSid,
        setup: async (agentCtx, agent) => {
          presetSeenInSetup = agent.session.header.agentPreset
          if (presetSeenInSetup !== 'myrix-empty') throw new Error('resume: preset 与绑定不一致')
          await ctx.agentPresets.mount(agentCtx, presetSeenInSetup)
          mountAccepted = true
        },
      })
      const fromDiskPreset = presetSeenInSetup
      await resumed.dispose()

      let mismatchRejected = false
      let mismatchMessage = ''
      try {
        await ctx.agents.resume({
          resumeSessionId: resumeSid,
          setup: (_agentCtx, agent) => {
            if (agent.session.header.agentPreset !== 'WRONG-PRESET') {
              throw new Error('resume: preset 与绑定不一致')
            }
          },
        })
      } catch (error) { mismatchRejected = true; mismatchMessage = String(error?.message ?? error) }
      return { fromDiskPreset, mountAccepted, mismatchRejected, mismatchMessage }
    })

    await probe('P2:guard-denies-an-identity-less-call', async () => {
      let guardCalls = 0
      let seenAgent
      const disposeGuard = ctx.tools.guard((exec) => {
        guardCalls += 1
        seenAgent = exec.agent === undefined ? 'undefined' : typeof exec.agent
        return exec.agent === undefined ? 'myrix: 会话没有有效身份' : undefined
      })
      ctx.tools.register({
        name: 'poc_probe',
        description: 'PoC probe tool that must never run without an identity.',
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'null' }, render: () => [{ type: 'text', text: 'ran' }] },
        execute: async () => ({ value: null }),
      })
      const result = await ctx.tools.execute({
        name: 'poc_probe',
        arguments: {},
        callId: 'poc_call_1',
        signal: new AbortController().signal,
      })
      disposeGuard()
      return {
        guardCalls,
        seenAgent,
        // IMPORTANT: a guard denial is an *error result*, not a thrown
        // exception. Callers must inspect `isError`.
        resultIsError: result.isError,
        denialText: result.content.map(block => block.text ?? '').join(''),
        errorMessage: result.error?.message ?? null,
      }
    })

    await probe('P2:cancel-with-disposed-cause-and-dispose', async () => {
      const cancelSid = `poc_cancel_${Date.now()}`
      const h = await ctx.agents.create({
        sessionId: cancelSid,
        agentOptions: { provider: 'poc-mock', model: 'poc-model' },
      })
      h.agent.cancel({ kind: 'user' })
      await h.dispose()
      return { cancelled: true, stillLive: ctx.agents.get(cancelSid) !== undefined }
    })

    await probe('P2:dispose-unregisters-the-agent', async () => {
      await handle.dispose()
      return { stillLive: ctx.agents.get(sid) !== undefined, persistenceFlushed: await ctx.sessions.flush(handle.agent.session).catch(() => 'flush-after-dispose-threw') }
    })

    await probe('P2:compaction-auxiliary-call-attribution', async () => {
      const compactSid = `poc_compact_${Date.now()}`
      const h = await ctx.agents.create({
        sessionId: compactSid,
        agentOptions: { provider: 'poc-mock', model: 'poc-model' },
      })
      // A real, genuinely compactable history: every turn is distinct text that
      // shares one long compressible body, so the replayed conversation is real
      // and the summarizer's replacement is measurably smaller than the span it
      // shadows. This is what makes the engine commit instead of refusing.
      for (let index = 0; index < POC_COMPACT_TURNS; index += 1) {
        h.agent.followup(createUserMessage({ content: [{ type: 'text', text: pocTurnText(index) }], source: { kind: 'user' } }))
        await h.agent.whenIdle()
      }
      // Read the meter optionally: `poc-app` does not inject `tokenMeter`, and
      // `ctx.get` is the documented optional-access form.
      const meter = ctx.get('tokenMeter')
      if (meter === undefined) throw new Error('myrix-poc: ctx.tokenMeter is not mounted')
      const beforeMeasure = meter.measure(h.agent.session)
      const before = observedCalls().length
      let compacted = false
      let error = null
      let outcome = null
      let resultShape = null
      try {
        // `ctx.get('compaction')` returns the configured engine; `compactNow`
        // runs a real auxiliary summarization call through the same adapter.
        const engine = ctx.get('compaction')
        outcome = await engine.compactNow(h.agent, new AbortController().signal)
        compacted = outcome !== null
        if (outcome !== null) {
          resultShape = {
            compactionId: outcome.compactionId,
            startSeq: outcome.startSeq,
            summarySeq: outcome.summarySeq,
            endSeq: outcome.endSeq,
            shadowedRange: outcome.shadowedRange,
            shadowedSeqs: outcome.shadowedSeqs,
            shadowedTokenCount: outcome.shadowedTokenCount,
            summaryBlocks: outcome.summary.map(block => block.type),
          }
        }
      } catch (caught) { error = String(caught?.message ?? caught) }
      const auxCalls = observedCalls().slice(before)

      // Read the persisted log back through the locked persistence backend, so
      // the assertion is about durable storage and not about in-memory state.
      await ctx.sessions.flush(h.agent.session)
      let persisted = null
      let persistenceError = null
      try {
        const handle = await ctx.sessionPersistence.open(compactSid, 'read')
        try {
          const slice = await handle.read()
          persisted = slice.events
        } finally { await handle.close() }
      } catch (caught) { persistenceError = String(caught?.message ?? caught) }

      const afterMeasure = meter.measure(h.agent.session)
      const persistedCheckpoints = (persisted ?? []).filter(event => event.type === 'user/message'
        && event.data?.source?.kind === 'compact-checkpoint')
      const persistedSummaries = (persisted ?? []).filter(event => event.type === 'compaction/summary')
      const checkpoint = persistedCheckpoints.at(-1) ?? null
      const summaryEvent = persistedSummaries.at(-1) ?? null
      const checkpointSurfaceOp = checkpoint?.surfaceOp ?? null

      await h.dispose()
      const detail = {
        compacted,
        error,
        auxiliaryCallCount: auxCalls.length,
        auxiliaryPurposes: auxCalls.map(call => call.purpose),
        auxiliarySessionIds: auxCalls.map(call => call.sessionId),
        // R4: an auxiliary (compaction) request must still name its session,
        // otherwise the gateway cannot attribute it.
        auxiliaryCallsCarrySessionId: auxCalls.length > 0 && auxCalls.every(call => typeof call.sessionId === 'string'),
        turnsBeforeCompaction: POC_COMPACT_TURNS,
        // The engine's own result, not a relaxed reading of a thrown error.
        result: resultShape,
        tokenTotals: { before: beforeMeasure.totalTokens, after: afterMeasure.totalTokens },
        totalTokensShrank: afterMeasure.totalTokens < beforeMeasure.totalTokens,
        compactedNodeCount: outcome === null ? 0 : outcome.shadowedSeqs.length,
        // Durable proof: the persisted surface carries one truncated-summary
        // node, marked as a compaction checkpoint, replacing the shadowed span.
        persistenceError,
        persistedEventCount: persisted === null ? null : persisted.length,
        persistedCompactionStart: (persisted ?? []).some(event => event.type === 'compaction/start'),
        persistedCompactionSummary: summaryEvent !== null,
        persistedCheckpointSourceKind: checkpoint?.data?.source?.kind ?? null,
        persistedCheckpointCompactionIdMatches: checkpoint !== null && outcome !== null
          && checkpoint.data.source.compactionId === outcome.compactionId,
        persistedCheckpointReplacesShadowedRange: checkpointSurfaceOp !== null && outcome !== null
          && checkpointSurfaceOp.op === 'replace'
          && checkpointSurfaceOp.startSeq === outcome.shadowedRange.start
          && checkpointSurfaceOp.endSeq === outcome.shadowedRange.end,
        persistedSummaryShadowedSeqsMatch: summaryEvent !== null && outcome !== null
          && JSON.stringify(summaryEvent.data.shadowedSeqs) === JSON.stringify(outcome.shadowedSeqs),
        persistedSummaryIsSmaller: summaryEvent !== null && outcome !== null
          && summaryEvent.data.shadowedTokenCount === outcome.shadowedTokenCount
          && summaryEvent.data.shadowedTokenCount > 0,
      }
      // The probe only passes when the real engine actually committed AND the
      // durable log proves it. This is deliberately an assertion rather than a
      // report field: a future regression must turn 16/16 red, not quietly
      // return `compacted: false` as an acceptable outcome.
      const durableInvariants = {
        persistedCompactionStart: detail.persistedCompactionStart,
        persistedCompactionSummary: detail.persistedCompactionSummary,
        persistedCheckpointSourceKind: detail.persistedCheckpointSourceKind === 'compact-checkpoint',
        persistedCheckpointCompactionIdMatches: detail.persistedCheckpointCompactionIdMatches,
        persistedCheckpointReplacesShadowedRange: detail.persistedCheckpointReplacesShadowedRange,
        persistedSummaryShadowedSeqsMatch: detail.persistedSummaryShadowedSeqsMatch,
        persistedSummaryIsSmaller: detail.persistedSummaryIsSmaller,
      }
      const unmet = Object.entries(durableInvariants).filter(([, value]) => value !== true).map(([key]) => key)
      if (persistenceError !== null) throw new Error(`myrix-poc: reading the persisted compaction log failed: ${persistenceError}`)
      if (!compacted) throw new Error(`myrix-poc: manual compaction did not commit: ${error ?? 'compactNow returned null'}`)
      if (unmet.length > 0) throw new Error(`myrix-poc: persisted compaction is incomplete: ${unmet.join(', ')}`)
      if (detail.compactedNodeCount === 0) throw new Error('myrix-poc: compaction replaced no surface node')
      if (!detail.totalTokensShrank) throw new Error('myrix-poc: compaction did not reduce measured request pressure')
      if (detail.auxiliaryPurposes.length === 0 || detail.auxiliaryPurposes.some(purpose => purpose !== 'compaction')) {
        throw new Error(`myrix-poc: expected only compaction auxiliary calls, saw ${JSON.stringify(detail.auxiliaryPurposes)}`)
      }
      return detail
    })

    writeFileSync(config.out, JSON.stringify({
      dsh: {
        runtimeVersion: process.env.DSH_RUNTIME_VERSION ?? 'unknown',
        dshHome: process.env.DSH_HOME ?? null,
        cwd: process.cwd(),
      },
      // The runner reads these back to configure the restart pass. The map is
      // computed here, after every probe (including disposal) has run, because
      // teardown itself appends a durable `session/end-seed` event and
      // therefore advances the final seq of a session.
      resumeTarget: config.resumeTarget ?? sid,
      finalLastSeqBySession: Object.fromEntries(
        [...new Set(durable.map(entry => entry.sid))]
          .map(sessionId => [sessionId, Math.max(...durable.filter(entry => entry.sid === sessionId).map(entry => entry.seq))]),
      ),
      probeSummary: {
        total: results.length,
        passed: results.filter(entry => entry.ok).length,
        failed: results.filter(entry => !entry.ok).length,
      },
      results,
    }, null, 2))
    ctx.appExit(0)
  }
}
