/**
 * Myrix Phase0 P1/P2 real-DSH loader smoke runner.
 *
 * What this does: builds a throwaway `$DSH_HOME` whose only profile bundle is
 * `bundles/myrix-base` (linked from this repo), then boots the **real locked
 * DSH CLI** (`@deepseek-ai/dsh@0.2.0-rc.2`, pinned by package version) against it.
 * Matching the vendor version does not prove an identical checkout/build. No `dsh-base` layer, no shell, no filesystem,
 * no web, no jobs, no goal, no subagent.
 *
 * Why a subprocess: the profile launcher is the only supported way to compose
 * bundle patch layers, and it installs fail-loud guards on the process. Running
 * it in-process would fight the harness we are testing.
 *
 * The DSH installation is located, in order, from `MYRIX_DSH_CLI`, then a
 * `node_modules/@deepseek-ai/dsh` reachable from this repo, then an
 * already-materialized install in `tests/poc/.dsh-install`. It never installs
 * anything: dependency installation is an explicit, reviewed step (see the
 * dependency list in `docs/implementation/runtime-poc.md`), so a missing
 * install fails loudly instead of silently succeeding.
 *
 * Usage:
 *   node tests/poc/run-poc.mjs                 # full run
 *   node tests/poc/run-poc.mjs --dump-config   # composition only, no boot
 * @module myrix-poc-runner
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const BASE_BUNDLE = join(REPO, 'bundles', 'myrix-base')
const POC_PLUGINS = join(HERE, 'plugins')
const WORK = join(HERE, '.work')
const HOME = join(WORK, 'home')
const PROFILE = 'myrix-poc'

/** Every scope directory a `node_modules` lookup from the probe must reach. */
const INSTALL_CANDIDATES = [
  join(HERE, '.dsh-install'),
  join(REPO, 'node_modules'),
  REPO,
]

/**
 * Locate the real `dsh` CLI entry point.
 * @returns {{ cli: string, version: string, nodeModules: string }} the resolved install.
 * @throws when no installation is reachable.
 */
function resolveDshCli() {
  const explicit = process.env.MYRIX_DSH_CLI
  const candidates = explicit === undefined ? [] : [explicit]
  for (const root of INSTALL_CANDIDATES) {
    candidates.push(join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
    candidates.push(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const installRoot = dirname(dirname(candidate))
    const manifestPath = join(installRoot, 'package.json')
    const version = existsSync(manifestPath)
      ? JSON.parse(readFileSync(manifestPath, 'utf8')).version
      : 'unknown'
    // The directory whose `node_modules` holds the full DSH dependency set. A
    // hoisted install puts it one level above the scope directory; a nested
    // pnpm store keeps it as the package's own `node_modules`.
    const scopedRoot = dirname(installRoot) // …/<root>/node_modules/@deepseek-ai
    const nodeModules = existsSync(join(installRoot, 'node_modules'))
      ? join(installRoot, 'node_modules')
      : dirname(scopedRoot)
    return { cli: candidate, version, nodeModules }
  }
  throw new Error(
    'myrix-poc: cannot find the DSH CLI.\n'
    + 'Install the locked runtime into tests/poc/.dsh-install (see docs/implementation/runtime-poc.md)\n'
    + 'or point MYRIX_DSH_CLI at an @deepseek-ai/dsh/lib/bin.js.',
  )
}

/**
 * Materialize the throwaway Harness home and profile.
 * @param {{ nodeModules: string }} install - the resolved DSH installation.
 * @param {string} outPath - absolute report path baked into the app row.
 * @param {{ fresh?: boolean, resumeTarget?: string, resumePreviousFinalSeq?: number }} [options] -
 *   `fresh` wipes the whole home (pass 1); otherwise only the profile directory
 *   is rewritten so the JSONL sessions written by the previous process survive
 *   (pass 2, the restart check).
 */
function prepareHome(install, outPath, options = {}) {
  const { fresh = false, resumeTarget, resumePreviousFinalSeq } = options
  if (fresh) {
    rmSync(WORK, { recursive: true, force: true })
  } else {
    // Keep `$DSH_HOME/sessions` from the previous process: that durable state
    // is exactly what the restart pass resumes from.
    rmSync(join(HOME, 'profiles'), { recursive: true, force: true })
  }
  const profileDir = join(HOME, 'profiles', PROFILE)
  const scoped = join(profileDir, 'node_modules', '@myrix')
  mkdirSync(scoped, { recursive: true })
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  mkdirSync(join(HOME, 'profiles'), { recursive: true })

  // A real deployment materializes the whole DSH dependency set at
  // `$DSH_HOME/profiles/node_modules`; profile-local plugin files (and the
  // PoC's own probe plugins) resolve their bare `@deepseek-ai/dsh-*` imports
  // from there. Linking the locked install reproduces that layout exactly
  // instead of giving the PoC a private resolution path.
  symlinkSync(install.nodeModules, join(HOME, 'profiles', 'node_modules'), 'dir')

  // The bundle's plugin rows resolve from the dsh installation first and the
  // profile directory second, so linking it under the profile is sufficient.
  symlinkSync(BASE_BUNDLE, join(scoped, 'dsh-bundle-myrix-base'), 'dir')

  // Profile-local plugin files must live *inside* the profile: their bare
  // `@deepseek-ai/dsh-*` imports resolve through the profile tree
  // (`$DSH_HOME/profiles/node_modules` and the profile's own `node_modules`),
  // not through whatever directory the repo happens to reference them from.
  // Copying them here is what a deployment image does.
  const pluginDir = join(profileDir, 'plugins')
  cpSync(POC_PLUGINS, pluginDir, { recursive: true })

  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${PROFILE}`,
    private: true,
    version: '0.0.0',
    dsh: { profile: { bundles: ['@myrix/dsh-bundle-myrix-base'] } },
  }, null, 2)}\n`)
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n')
  writeFileSync(join(profileDir, 'cordis.patch.yml'), [
    '# Generated by tests/poc/run-poc.mjs — do not edit.',
    '- insert:',
    '    - id: myrix-poc-mock-llm',
    '      name: ./plugins/poc-mock-llm.mjs',
    '    - id: myrix-poc-app',
    '      name: ./plugins/poc-app.mjs',
    '      config:',
    `        out: ${JSON.stringify(outPath)}`,
    ...resumeTarget === undefined ? [] : [
      `        resumeTarget: ${JSON.stringify(resumeTarget)}`,
      `        resumePreviousFinalSeq: ${JSON.stringify(resumePreviousFinalSeq ?? null)}`,
    ],
    '',
  ].join('\n'))
  return profileDir
}

const cli = resolveDshCli()
const args = process.argv.slice(2)
const dumpOnly = args.includes('--dump-config')
const outPath = join(WORK, 'poc-report.json')
const firstReport = join(WORK, 'poc-report-first.json')

process.stdout.write(`myrix-poc: dsh ${cli.version} @ ${cli.cli}\n`)
process.stdout.write(`myrix-poc: DSH_HOME=${HOME} profile=${PROFILE}\n\n`)

/**
 * Boot the real CLI once against the prepared home.
 * @returns {import('node:child_process').SpawnSyncReturns<string>} the raw run.
 */
function bootOnce() {
  return spawnSync(process.execPath, [cli.cli, '--profile', PROFILE], {
    cwd: REPO,
    env: {
      ...process.env,
      DSH_HOME: HOME,
      // Keep the PoC hermetic: no product telemetry, no ambient user patches.
      DSH_TELEMETRY_DISABLED: '1',
      DSH_RUNTIME_VERSION: cli.version,
    },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180_000,
  })
}

if (dumpOnly) {
  prepareHome(cli, outPath, { fresh: true })
  // A white-list bundle is only proven by the absence of the forbidden rows.
  const dumped = spawnSync(process.execPath, [cli.cli, '--profile', PROFILE, '--dump-config'], {
    cwd: REPO,
    env: { ...process.env, DSH_HOME: HOME, DSH_TELEMETRY_DISABLED: '1' },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180_000,
  })
  if (dumped.stdout) process.stdout.write(dumped.stdout)
  if (dumped.stderr) process.stderr.write(dumped.stderr)
  if (dumped.status !== 0) {
    process.stderr.write(`myrix-poc: --dump-config failed with status ${String(dumped.status)}\n`)
    process.exit(dumped.status ?? 1)
  }
  const dump = dumped.stdout ?? ''
  const forbidden = [
    'dsh-base', 'dsh-tool-bash', 'dsh-tool-pwsh', 'dsh-terminal', 'dsh-subprocess-local',
    'dsh-sandbox-local', 'dsh-sandbox-policy', 'dsh-tool-fs', 'dsh-tool-web',
    'dsh-web-fetch-http', 'dsh-web-search', 'dsh-jobs-local', 'dsh-tool-jobs',
    'dsh-goal', 'dsh-subagent', 'dsh-tool-workflow', 'dsh-workflow-ptc',
    'dsh-mcp-client', 'dsh-mcp-resources', 'dsh-plugin-manager', 'dsh-hmr',
    'dsh-config-editor', 'dsh-settings', 'dsh-credentials-local', 'dsh-web-app',
    'dsh-skill', 'dsh-agent-instructions', 'dsh-ptc-runtime', 'dsh-session-query-sqlite',
  ]
  const leaked = forbidden.filter(row => dump.includes(`name: '@deepseek-ai/${row}`) || dump.includes(`name: '@deepseek-ai/${row}/`))
  process.stdout.write(`\nmyrix-poc: forbidden rows in dump = ${JSON.stringify(leaked)}\n`)
  process.exit(leaked.length === 0 ? 0 : 1)
}

/** Read one report, or undefined when the pass produced none. */
function readReport(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
}

/**
 * Read the highest durable `seq` a session's JSONL artifact committed.
 * @param {string} sessionId - the session whose artifact to scan.
 * @returns {number | undefined} the last committed seq, or undefined when no artifact exists.
 */
function lastSeqOnDisk(sessionId) {
  const sessionsRoot = join(HOME, 'sessions')
  if (!existsSync(sessionsRoot)) return undefined
  for (const project of readdirSync(sessionsRoot)) {
    const artifact = join(sessionsRoot, project, sessionId, 'session.v4.jsonl')
    if (!existsSync(artifact)) continue
    let last
    for (const line of readFileSync(artifact, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      try {
        const record = JSON.parse(line)
        if (typeof record.seq === 'number') last = record.seq
      } catch { /* a torn trailing line is the writer's business, not ours */ }
    }
    return last
  }
  return undefined
}

// Pass 1: cold boot, full probe suite.
prepareHome(cli, firstReport, { fresh: true })
const first = bootOnce()
if (first.stdout) process.stdout.write(first.stdout)
if (first.stderr) process.stderr.write(first.stderr)
const coldReport = readReport(firstReport)
if (coldReport === undefined) {
  process.stderr.write(`myrix-poc: pass 1 produced no report (dsh exited ${String(first.status)})\n`)
  process.exit(1)
}

// Pass 2: same `$DSH_HOME`, so the JSONL written by pass 1 is reloaded by a
// brand-new process. This is the crash-recovery / seq-continuation check.
//
// The boundary is read from the *artifact on disk*, not from the in-process
// report: the report is written before the tree is disposed, and disposal
// itself appends a durable `session/end-seed` event.
const resumeTarget = coldReport.resumeTarget ?? null
const finalSeq = resumeTarget === null ? undefined : lastSeqOnDisk(resumeTarget)
prepareHome(cli, outPath, { resumeTarget, resumePreviousFinalSeq: finalSeq })
const second = bootOnce()
if (second.stdout) process.stdout.write(second.stdout)
if (second.stderr) process.stderr.write(second.stderr)
const report = readReport(outPath) ?? coldReport

if (!existsSync(outPath)) {
  process.stderr.write(`myrix-poc: no report at ${outPath} (dsh exited ${String(second.status)})\n`)
  process.exit(1)
}

process.stdout.write('\n=== Myrix Phase0 P1/P2 PoC report ===\n')
for (const entry of report.results) {
  const mark = entry.ok ? 'PASS' : 'FAIL'
  process.stdout.write(`${mark}  ${entry.name}\n`)
  const detail = JSON.stringify(entry.detail ?? entry.error)
  process.stdout.write(`      ${detail.length > 900 ? `${detail.slice(0, 900)}…` : detail}\n`)
}
process.stdout.write(`\n${report.probeSummary.passed}/${report.probeSummary.total} probes passed\n`)
process.stdout.write(`report: ${outPath}\n`)
process.exit(report.probeSummary.failed === 0 ? 0 : 2)
