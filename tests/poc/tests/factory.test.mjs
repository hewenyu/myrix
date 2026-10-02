/**
 * Deterministic factory tests for the Cell profile assembler.
 *
 * These run **without** the locked DSH runtime and without any network: they
 * exercise the pure and filesystem-level guarantees that the end-to-end PoC
 * cannot cheaply prove repeatedly:
 *
 *   1. a production Cell mounts `myrix-novel` and the compiled package really
 *      exposes `@myrix/novel/preset-tools` through its `exports` map;
 *   2. a production Cell refuses to omit the novel vertical, while an explicit
 *      PoC opt-out is allowed and must be documented;
 *   3. unsafe paths and profile names are rejected **before** anything is
 *      deleted, with a sentinel file left intact;
 *   4. generated profiles and compiled packages are mode 0600 / 0700 and contain
 *      only `process.env` references — never a secret value;
 *   5. reassembling into the same home preserves an existing `sessions/` tree
 *      (the durable log a restart probe reads back).
 *
 * Run with: node --test tests/poc/tests/
 *
 * @module myrix-poc/factory.test
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { createCellProfile, cellEnv, resolveProfilePaths } from '../lib/cell-profile.mjs'
// The real plugin origin contracts. The cross-layer test below loads the generated
// profile's config and feeds it through these — never a string comparison of the
// YAML — so "the factory emitted something" and "the plugin accepts it" are the
// same assertion.
import { resolveConfig as resolveLeaseConfig } from '../../../plugins/myrix-binding-lease/src/config.ts'
import { resolveConfig as resolveGatewayConfig } from '../../../plugins/myrix-llm-gateway/src/config.ts'
import { compilePluginEntries, CELL_PLUGINS } from '../lib/compile-plugins.mjs'
import { resolveRepoRoot } from '../lib/dsh-install.mjs'

const REPO = resolveRepoRoot()
const TOOLS = ['get_outline', 'update_outline', 'get_chapter', 'save_chapter_draft', 'search_bible', 'update_bible_entry']

/**
 * One shared compile of every Cell plugin, reused by every test.
 *
 * Compiling is the expensive step and it is deterministic, so the suite builds
 * once and passes the manifest in; only the test that checks the compiler's own
 * outputs compiles on its own.
 */
const SHARED_BUILD = mkdtempSync(join(tmpdir(), 'myrix-build-'))
const SHARED = compilePluginEntries({ repo: REPO, outDir: SHARED_BUILD, fresh: true })

/** A complete, valid set of Cell inputs; individual tests override fields. */
function cellOptions(home, overrides = {}) {
  return {
    repo: REPO,
    home,
    profileName: 'myrix-cell',
    cellId: 'cell-test',
    tenantId: 't_test',
    grantPublicJwks: [{ kty: 'EC', crv: 'P-256', x: 'x', y: 'y', kid: 'kid-1' }],
    port: 7899,
    worksOrigin: 'http://127.0.0.1:8791',
    worksToken: 'works-token-0123456789abcdef0123456789',
    gatewayBaseURL: 'http://127.0.0.1:8790/v1/responses',
    gatewayToken: 'gateway-token-0123456789abcdef0123456789',
    drainToken: 'drain-token-0123456789abcdef0123456789',
    revokeToken: 'revoke-token-0123456789abcdef0123456789',
    models: ['myrix-chat'],
    allowedTools: TOOLS,
    precompiled: SHARED,
    fresh: true,
    ...overrides,
  }
}

/** A temporary directory removed when the test ends. */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'myrix-factory-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Assert a file's mode is owner-only (0600) and dirs are 0700. */
function assertOwnerOnly(path, expected) {
  const mode = statSync(path).mode & 0o777
  assert.equal(mode.toString(8), expected.toString(8), `${path} mode ${mode.toString(8)} != ${expected.toString(8)}`)
}

test('a production Cell mounts myrix-novel and points its presets at the packaged subpath', (t) => {
  const home = tempDir(t)
  const cell = createCellProfile(cellOptions(home))
  const patch = readFileSync(cell.files.patch, 'utf8')
  assert.match(patch, /- id: myrix-novel/)
  assert.match(patch, /requirePolicy: true/)
  // The novel row is a real package row, not a literal extra row.
  const novelRow = patch.split('\n').filter((line) => line.includes("'@myrix/novel'"))
  assert.equal(novelRow.length, 1, 'exactly one @myrix/novel row')
  // No global tool registration: the novel plugin owns scoped preset rows, so
  // the profile must not declare any @myrix/novel/preset-tools row itself.
  assert.doesNotMatch(patch, /- id: novel-(outline|chapter|bible)/)
  assert.ok(cell.novel.included)
})

test('the compiled novel package exposes the preset-tools subpath through exports', (t) => {
  const outDir = tempDir(t)
  const compiled = compilePluginEntries({ repo: REPO, outDir, fresh: true })
  const pkg = compiled.packages['@myrix/novel']
  assert.ok(pkg, 'the novel package must compile')
  assert.ok(existsSync(join(pkg.dir, 'index.mjs')), 'root module exists')
  assert.ok(existsSync(join(pkg.dir, 'preset-tools.mjs')), 'preset-tools subpath module exists')
  const manifest = JSON.parse(readFileSync(join(pkg.dir, 'package.json'), 'utf8'))
  assert.equal(manifest.exports['.'], './index.mjs')
  assert.equal(manifest.exports['./preset-tools'], './preset-tools.mjs')
  // Node must be able to resolve the subpath exactly as a preset row would.
  // `realpathSync` folds macOS's `/var` → `/private/var` so the comparison is
  // about resolution success, not about which spelling of the temp dir wins.
  const resolved = execFileSync(process.execPath, [
    '--input-type=module', '-e',
    `import { createRequire } from 'node:module'; const r = createRequire(${JSON.stringify(join(pkg.dir, 'index.mjs'))}); console.log(r.resolve('@myrix/novel/preset-tools'))`,
  ], { cwd: pkg.dir, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } }).trim()
  assert.equal(realpathSync(resolved), realpathSync(join(pkg.dir, 'preset-tools.mjs')))
  // Every Cell plugin except the novel one is root-only.
  for (const entry of CELL_PLUGINS) {
    if (entry.pak === 'myrix-novel') continue
    assert.equal(entry.subpath, undefined, `${entry.pak} must not declare a subpath`)
  }
  assertOwnerOnly(pkg.dir, 0o700)
  assertOwnerOnly(join(pkg.dir, 'index.mjs'), 0o600)
})

test('production refuses to omit the novel vertical; a documented PoC opt-out is allowed', (t) => {
  const home = tempDir(t)
  assert.throws(
    () => createCellProfile(cellOptions(join(home, 'prod'), { novel: false })),
    /refuses to omit the novel vertical in production mode/,
  )
  assert.throws(
    () => createCellProfile(cellOptions(join(home, 'poc'), { mode: 'poc', novel: false })),
    /novelOptOutReason/,
  )
  const poc = createCellProfile(cellOptions(join(home, 'poc-ok'), {
    mode: 'poc',
    novel: false,
    novelOptOutReason: 'driver-only probe scope',
    requirePolicy: false,
  }))
  assert.equal(poc.novel.included, false)
  assert.equal(poc.env.MYRIX_NOVEL_ENABLED, '0')
  assert.equal(poc.env.MYRIX_REQUIRE_POLICY, '0')
  const patch = readFileSync(poc.files.patch, 'utf8')
  assert.doesNotMatch(patch, /- id: myrix-novel/)
  // The opt-out is recorded on the descriptor, not silently dropped.
  assert.match(poc.novel.optOutReason, /driver-only/)
})

test('unsafe profile names and homes are rejected before any deletion', (t) => {
  const home = tempDir(t)
  const sentinel = join(home, 'sentinel.txt')
  writeFileSync(sentinel, 'do-not-delete\n')
  for (const profileName of ['../escape', 'a/b', '.hidden', '', 'x'.repeat(600), '..']) {
    assert.throws(() => createCellProfile(cellOptions(home, { profileName })), /unsafe profile name|absolute/, `rejected ${profileName}`)
  }
  assert.throws(() => createCellProfile(cellOptions('relative/path')), /absolute/)
  assert.throws(() => createCellProfile(cellOptions(resolve('/'))), /filesystem root/)
  assert.throws(() => createCellProfile(cellOptions(join(homedir(), '.dsh'))), /refusing to use/)
  assert.throws(() => createCellProfile(cellOptions(homedir())), /refusing to use/)
  assert.equal(readFileSync(sentinel, 'utf8'), 'do-not-delete\n', 'the sentinel survived every rejected call')
})

test('a symlinked profiles directory is refused rather than followed', (t) => {
  const home = tempDir(t)
  const elsewhere = tempDir(t)
  mkdirSync(join(elsewhere, 'profiles'), { recursive: true })
  mkdirSync(home, { recursive: true })
  symlinkSync(join(elsewhere, 'profiles'), join(home, 'profiles'), 'dir')
  const sentinel = join(elsewhere, 'profiles', 'keep.txt')
  writeFileSync(sentinel, 'keep\n')
  assert.throws(
    () => createCellProfile(cellOptions(home)),
    /symbolic link/,
  )
  assert.equal(readFileSync(sentinel, 'utf8'), 'keep\n')
})

test('generated files are owner-only and carry env references, never secret values', (t) => {
  const home = tempDir(t)
  const options = cellOptions(home)
  const cell = createCellProfile(options)
  for (const file of Object.values(cell.files)) assertOwnerOnly(file, 0o600)
  assertOwnerOnly(cell.profileDir, 0o700)
  const text = Object.values(cell.files).map((file) => readFileSync(file, 'utf8')).join('\n')
  for (const secret of [options.worksToken, options.gatewayToken, options.drainToken, options.revokeToken]) {
    assert.equal(text.includes(secret), false, 'no secret value may be persisted')
  }
  assert.match(text, /!!js process\.env\.MYRIX_WORKS_TOKEN/)
})

test('reassembling into the same home preserves the durable session store', (t) => {
  const home = tempDir(t)
  const first = createCellProfile(cellOptions(home))
  const sessionDir = join(home, 'sessions', '_no-cwd', 'cellA_s1')
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(sessionDir, 'session.v4.jsonl'), '{"seq":0,"type":"turn/start"}\n', { mode: 0o600 })
  first.linkBundle()
  // Second assembly: same home, same profile name, different port.
  const second = createCellProfile(cellOptions(home, { port: 7898 }))
  second.linkBundle()
  assert.ok(existsSync(join(sessionDir, 'session.v4.jsonl')), 'the session log survived reassembly')
  assert.match(readFileSync(second.files.patch, 'utf8'), /port: 7898/)
  assert.equal(existsSync(join(home, 'sessions', '_no-cwd', 'cellA_s1')), true)
})

test('cellEnv inherits only the OS allowlist and refuses a secret-bearing base', (t) => {
  const home = tempDir(t)
  const cell = createCellProfile(cellOptions(home))
  // A base that carries platform-only material is rejected outright: silently
  // filtering it would let a caller believe isolation happened when the caller
  // handed over the coordinator's whole environment.
  for (const forbidden of [
    { PATH: '/usr/bin', DATABASE_URL: 'postgres://user:pw@db/myrix' },
    { PATH: '/usr/bin', MYRIX_GATEWAY_UPSTREAM_API_KEY: 'sk-secret' },
    { PATH: '/usr/bin', NODE_OPTIONS: '--require=/tmp/evil.cjs' },
    { PATH: '/usr/bin', NODE_PATH: '/tmp/modules' },
    { PATH: '/usr/bin', MYRIX_RUNTIME_SIGNING_KEY_PEM: '-----BEGIN PRIVATE KEY-----' },
    { PATH: '/usr/bin', MYRIX_GATEWAY_DATABASE_URL: 'postgres://db/gw' },
  ]) {
    assert.throws(() => cellEnv(cell, forbidden), /refusing to pass/, `rejected ${Object.keys(forbidden).join(',')}`)
  }
  // An OS-only base passes and is extended with the Cell's own values.
  const env = cellEnv(cell, { PATH: '/usr/bin', HOME: home })
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.DSH_HOME, cell.home)
  assert.equal(env.MYRIX_CELL_ID, 'cell-test')
  assert.equal(env.MYRIX_WORKS_TOKEN, cell.secrets.MYRIX_WORKS_TOKEN)
  // The default base is the OS allowlist projection of this process, so an
  // ambient DATABASE_URL in the coordinator cannot reach the Cell.
  const defaulted = cellEnv(cell)
  assert.equal('DATABASE_URL' in defaulted, false)
  assert.equal('NODE_OPTIONS' in defaulted, false)
  assert.equal(defaulted.PATH, process.env.PATH)
})

test('resolveProfilePaths keeps the profile beside, never inside, the session store', (t) => {
  const home = tempDir(t)
  const paths = resolveProfilePaths(home, 'myrix-cell')
  assert.equal(paths.profileDir, join(home, 'profiles', 'myrix-cell'))
  assert.equal(paths.sessionsDir, join(home, 'sessions'))
  assert.equal(paths.profileDir.startsWith(paths.sessionsDir), false)
  // A profile directory that would alias sessions/ is not constructible from a
  // safe name, which is exactly why the name pattern exists.
  assert.throws(() => resolveProfilePaths(home, '../sessions'), /unsafe profile name/)
})

// ---------------------------------------------------------------------------
// Cross-layer origin contract (ADR 0030)
// ---------------------------------------------------------------------------

/**
 * Load a generated `cordis.patch.yml` the way the real loader does.
 *
 * The profile patch is YAML with `!!js` scalars that the loader turns into
 * expression nodes and later evaluates against `{ process }`
 * (`@deepseek-ai/cordis-plugin-loader` config/utils.ts: a `!!js` scalar becomes
 * `{ __jsExpr }`, then `with (ctx) { return eval(expr) }`).
 *
 * Reimplementing the *whole* loader here is not the point and would be a test-only
 * approximation; what this helper must reproduce exactly is the one thing under
 * test: the config object both plugins actually receive. The expression
 * evaluator below is byte-identical to the loader's.
 *
 * @param {string} patchPath - absolute path to the generated patch.
 * @param {NodeJS.ProcessEnv} env - the environment the loader would expose; a Cell
 *   process sees the factory's non-secret variables *and* its credentials
 *   (`cellEnv` merges `cell.secrets` in), so callers pass both.
 * @returns {Map<string, object>} row id → evaluated `config` (or `{}`).
 */
async function evalProfileConfigs(patchPath, env) {
  const yaml = await import('../.dsh-install/node_modules/js-yaml/dist/js-yaml.mjs')
  const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: (data) => typeof data === 'string',
    construct: (data) => ({ __jsExpr: data }),
  })
  const evaluate = new Function('ctx', 'expr', 'with (ctx) { return eval(expr) }')
  const doc = yaml.load(readFileSync(patchPath, 'utf8'), { schema: yaml.DEFAULT_SCHEMA.extend([JsExpr]) })
  const rows = (doc?.[0]?.insert ?? [])
  const configs = new Map()
  for (const row of rows) {
    const config = {}
    for (const [key, value] of Object.entries(row.config ?? {})) {
      config[key] = value !== null && typeof value === 'object' && '__jsExpr' in value
        ? evaluate({ process: { env } }, value.__jsExpr)
        : value
    }
    configs.set(row.id, config)
  }
  return configs
}

/** The minimal `!!js`-free options a cross-layer test needs. */
function composeCellOptions(home, overrides = {}) {
  return cellOptions(home, {
    worksOrigin: 'http://bff:8791',
    // The gateway config is an origin plus adapter-appended /responses, never a
    // full endpoint; passing one would fail the real resolveConfig below.
    gatewayBaseURL: 'http://gateway:8790/v1',
    ...overrides,
  })
}

test('generated Cell config is accepted by the REAL plugin resolveConfig functions', async (t) => {
  const home = tempDir(t)
  const approved = ['http://bff:8791', 'http://gateway:8790']
  const cell = createCellProfile(composeCellOptions(home, { internalHttpOrigins: approved }))
  const configs = await evalProfileConfigs(cell.files.patch, cellEnv(cell))
  const lease = configs.get('myrix-binding-lease')
  const gateway = configs.get('myrix-llm-gateway')
  assert.ok(lease, 'the profile must declare the binding lease row')
  assert.ok(gateway, 'the profile must declare the gateway row')
  // The factory forwarded the declarations as an actual array, not a string.
  assert.deepEqual(lease.internalHttpOrigins, approved)
  assert.deepEqual(gateway.internalHttpOrigins, approved)
  // The REAL parsers accept the generated config: no string matching.
  const leaseResolved = resolveLeaseConfig({ ...lease, token: 'works-token-0123456789abcdef0123456789' })
  const gatewayResolved = resolveGatewayConfig({ ...gateway, cellToken: 'gateway-token-0123456789abcdef0123456789' }, () => 'gateway-token-0123456789abcdef0123456789')
  assert.equal(leaseResolved.origin, 'http://bff:8791')
  assert.equal(gatewayResolved.baseURL, 'http://gateway:8790/v1')
  // Preserved: Responses-only endpoint construction, no chat/completions fallback.
  assert.equal(gatewayResolved.endpoint, 'http://gateway:8790/v1/responses')
})

test('the generated config is DENIED by the real plugins when the declaration is absent or wrong', async (t) => {
  // (a) No declaration at all: the same Compose origins must fail activation.
  const undeclaredHome = tempDir(t)
  const undeclared = createCellProfile(composeCellOptions(undeclaredHome))
  const undeclaredConfigs = await evalProfileConfigs(undeclared.files.patch, cellEnv(undeclared))
  const undeclaredLease = undeclaredConfigs.get('myrix-binding-lease')
  assert.deepEqual(undeclaredLease.internalHttpOrigins, [])
  assert.throws(
    () => resolveLeaseConfig({ ...undeclaredLease, token: 'works-token-0123456789abcdef0123456789' }),
    /回环/,
  )
  assert.throws(
    () => resolveGatewayConfig({ ...undeclaredConfigs.get('myrix-llm-gateway') }, () => 'gateway-token-0123456789abcdef0123456789'),
    /必须是 https/,
  )

  // (b) A declared list that does not match the actual origin (wrong port):
  //     the plugin still denies, so a mismatched deployment fails closed.
  const mismatchedHome = tempDir(t)
  const mismatched = createCellProfile(composeCellOptions(mismatchedHome, {
    internalHttpOrigins: ['http://bff:9999', 'http://gateway:8790'],
  }))
  const mismatchedConfigs = await evalProfileConfigs(mismatched.files.patch, cellEnv(mismatched))
  assert.throws(
    () => resolveLeaseConfig({
      ...mismatchedConfigs.get('myrix-binding-lease'),
      token: 'works-token-0123456789abcdef0123456789',
    }),
    /回环/,
  )
  // The gateway origin is in that list, so it ACTIVATES; the denial is per-origin,
  // not "one bad entry disables everything" (the entry parser already rejected
  // malformed entries before the factory ever sees them).
  assert.doesNotThrow(() => resolveGatewayConfig(
    { ...mismatchedConfigs.get('myrix-llm-gateway') },
    () => 'gateway-token-0123456789abcdef0123456789',
  ))

  // (c) A malformed declaration the entry would have refused is refused again by
  //     BOTH plugins, even though the row's own origin is approved.
  const hostileHome = tempDir(t)
  const hostile = createCellProfile(composeCellOptions(hostileHome, {
    internalHttpOrigins: ['http://bff:8791', 'http://*:1'],
  }))
  const hostileConfigs = await evalProfileConfigs(hostile.files.patch, cellEnv(hostile))
  assert.throws(
    () => resolveLeaseConfig({ ...hostileConfigs.get('myrix-binding-lease'), token: 'works-token-0123456789abcdef0123456789' }),
    /internalHttpOrigins/,
  )
  assert.throws(
    () => resolveGatewayConfig({ ...hostileConfigs.get('myrix-llm-gateway') }, () => 'gateway-token-0123456789abcdef0123456789'),
    /internalHttpOrigins/,
  )
})

test('the factory refuses a non-array internalHttpOrigins instead of silently denying', (t) => {
  const home = tempDir(t)
  for (const bad of ['http://bff:8791', 7, [1], [null]]) {
    assert.throws(
      () => createCellProfile(composeCellOptions(join(home, `bad-${String(bad).replace(/\W/g, '')}`), { internalHttpOrigins: bad })),
      /internalHttpOrigins/,
      `rejected ${JSON.stringify(bad)}`,
    )
  }
})
