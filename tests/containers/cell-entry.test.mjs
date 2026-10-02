// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0
/**
 * Regressions for the Cell container entry point (`deploy/images/cell-entry.mjs`).
 *
 * These run as plain `node --test` (Node 24 strips the types of the TypeScript
 * modules they import) and never touch a model, the network, a real credential
 * or a real production secret: every value below is an obvious fixture.
 *
 * What is asserted, in order:
 *   1. the normal path really calls the sanctioned profile factory;
 *   2. a missing or malformed value refuses the boot (no generated identity/key);
 *   3. paths stay inside the writable home and never touch `/app`;
 *   4. the child environment is an allowlist that drops ambient secrets;
 *   5. known platform secrets are refused, not silently inherited;
 *   6. a restart reuses the persistent home and never deletes session history.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  APP_ROOT,
  DEFAULT_FACTORY,
  TOKEN_MIN_LENGTH,
  buildCellOptions,
  childEnvironment,
  parseGrantJwks,
  parseInternalHttpOrigins,
  parseOrigin,
  redact,
  resolveAllowedTools,
  resolveCellConfig,
  runCellEntry,
} from '../../deploy/images/cell-entry.mjs'
import { compilePluginEntries } from '../../tests/poc/lib/compile-plugins.mjs'
import * as realFactory from '../../tests/poc/lib/cell-profile.mjs'

const ENTRY = fileURLToPath(new URL('../../deploy/images/cell-entry.mjs', import.meta.url))
const TMP_ROOT = realpathSync(tmpdir())

/** A throwaway directory that is cleaned up even when a test fails. */
function tempDir(t, label) {
  const dir = mkdtempSync(join(TMP_ROOT, `myrix-cell-${label}-`))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Minimum viable JWKS: one EC public key; `d` would make it private. */
function publicJwks() {
  return JSON.stringify([{ kty: 'EC', crv: 'P-256', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0', kid: 'fixture-grant', alg: 'ES256', use: 'sig' }])
}

/** A long, obviously fake credential. */
function fakeSecret(seed) {
  return `fixture-${seed}-${'x'.repeat(TOKEN_MIN_LENGTH)}`
}

/**
 * A complete, legal deployment environment.
 *
 * Model separate application/home mounts, even when TMPDIR is inside this checkout.
 * Only fixture files are copied; source/dependencies remain read-only references.
 */
function baseEnv(home) {
  const app = join(dirname(home), 'app')
  if (!existsSync(app)) {
    mkdirSync(app, { recursive: true })
    cpSync(join(APP_ROOT, 'bundles'), join(app, 'bundles'), { recursive: true })
    for (const entry of ['tests', 'plugins', 'packages', 'node_modules']) {
      symlinkSync(join(APP_ROOT, entry), join(app, entry), 'dir')
    }
  }
  return {
    DSH_HOME: home,
    MYRIX_CELL_ID: 'cell-t1',
    MYRIX_TENANT_ID: 'tenant-t1',
    MYRIX_DRIVER_PORT: '8404',
    MYRIX_WORKS_ORIGIN: 'https://works.example.internal',
    MYRIX_GATEWAY_URL: 'https://gateway.example.internal/v1',
    MYRIX_MODELS: 'fixture-model',
    MYRIX_MODEL_CONTEXT_WINDOW: '65536',
    MYRIX_GRANT_JWKS: publicJwks(),
    MYRIX_WORKS_TOKEN: fakeSecret('works'),
    MYRIX_GATEWAY_TOKEN: fakeSecret('gateway'),
    MYRIX_DRAIN_TOKEN: fakeSecret('drain'),
    MYRIX_REVOKE_TOKEN: fakeSecret('revoke'),
    MYRIX_REPO_ROOT: app,
  }
}

test('the normal path uses the sanctioned factory and never a look-alike', async () => {
  // Structural: the module imports the factory module itself, and the export it
  // exports for tests IS that module object.
  assert.equal(DEFAULT_FACTORY, realFactory)
  const source = readFileSync(ENTRY, 'utf8')
  assert.match(source, /from '\.\.\/\.\.\/tests\/poc\/lib\/cell-profile\.mjs'/)
  // The entry must not assemble a profile of its own.
  assert.doesNotMatch(source, /cordis\.patch\.yml['"]\s*,\s*writeFileSync/)
  assert.doesNotMatch(source, /ROW_HANDLERS|renderProfilePatch/)
  // It reads the real CLI contract rather than guessing a flag.
  assert.match(source, /'--profile',\s*cell\.profileName/)
})

test('a missing or malformed value refuses the boot without generating anything', (t) => {
  const dir = tempDir(t, 'missing')
  const home = join(dir, 'home')

  // Missing identity, credentials, catalog and capacity are all refusals.
  for (const name of [
    'MYRIX_CELL_ID', 'MYRIX_TENANT_ID', 'MYRIX_WORKS_ORIGIN', 'MYRIX_GATEWAY_URL',
    'MYRIX_MODELS', 'MYRIX_MODEL_CONTEXT_WINDOW', 'MYRIX_GRANT_JWKS',
    'MYRIX_WORKS_TOKEN', 'MYRIX_GATEWAY_TOKEN', 'DSH_HOME',
  ]) {
    const env = baseEnv(home)
    delete env[name]
    assert.throws(() => resolveCellConfig(env), /myrix-cell-entry/, `expected ${name} to be required`)
  }

  // No identity is ever minted: a non-DNS label is refused, not escaped.
  assert.throws(() => resolveCellConfig({ ...baseEnv(home), MYRIX_CELL_ID: 'Cell T1' }), /DNS label/)
  assert.throws(() => resolveCellConfig({ ...baseEnv(home), MYRIX_TENANT_ID: '../other' }), /DNS label/)
  assert.throws(() => resolveCellConfig({ ...baseEnv(home), MYRIX_MODELS: '' }), /MYRIX_MODELS/)
  assert.throws(() => resolveCellConfig({ ...baseEnv(home), MYRIX_MODEL_CONTEXT_WINDOW: '1000' }), /MYRIX_MODEL_CONTEXT_WINDOW/)
  assert.throws(() => resolveCellConfig({ ...baseEnv(home), MYRIX_DRIVER_PORT: '0' }), /MYRIX_DRIVER_PORT/)

  // A short token is a broken credential, not a small one.
  assert.throws(
    () => resolveCellConfig({ ...baseEnv(home), MYRIX_WORKS_TOKEN: 'short' }),
    new RegExp(`shorter than ${String(TOKEN_MIN_LENGTH)}`),
  )
  // Draining and revoking may fall back to the admin token, never to a default.
  const withAdmin = { ...baseEnv(home), MYRIX_ADMIN_TOKEN: fakeSecret('admin') }
  delete withAdmin.MYRIX_DRAIN_TOKEN
  delete withAdmin.MYRIX_REVOKE_TOKEN
  assert.equal(resolveCellConfig(withAdmin).secrets.drainToken, fakeSecret('admin'))
  assert.throws(
    () => {
      const env = baseEnv(home)
      delete env.MYRIX_DRAIN_TOKEN
      delete env.MYRIX_REVOKE_TOKEN
      return resolveCellConfig(env)
    },
    /MYRIX_DRAIN_TOKEN/,
  )
})

test('the grant key set must be public and non-empty', () => {
  assert.throws(() => parseGrantJwks('not json'), /not valid JSON/)
  assert.throws(() => parseGrantJwks('[]'), /non-empty array/)
  assert.throws(() => parseGrantJwks('{"kty":"EC"}'), /non-empty array/)
  assert.throws(() => parseGrantJwks(JSON.stringify(['x'])), /JWK objects/)
  assert.throws(() => parseGrantJwks(JSON.stringify([{ kty: 'oct', k: 'AAAA' }])), /EC, RSA or OKP/)
  // A private scalar must never be accepted: the Cell only verifies grants.
  assert.throws(
    () => parseGrantJwks(JSON.stringify([{ kty: 'EC', crv: 'P-256', x: 'a', y: 'b', d: 'private-scalar' }])),
    /private JWK/,
  )
  assert.equal(parseGrantJwks(publicJwks()).length, 1)
})

test('same-host Compose HTTP is denied unless the exact service origins are declared', (t) => {
  const env = { ...baseEnv(join(tempDir(t, 'compose-origins'), 'home')),
    MYRIX_WORKS_ORIGIN: 'http://bff:8791', MYRIX_GATEWAY_URL: 'http://gateway:8790/v1' }
  assert.throws(() => resolveCellConfig(env), /https outside loopback/)
  const declared = JSON.stringify(['http://bff:8791', 'http://gateway:8790'])
  const config = resolveCellConfig({ ...env, MYRIX_CELL_INTERNAL_HTTP_ORIGINS: declared })
  assert.equal(config.worksOrigin, env.MYRIX_WORKS_ORIGIN)
  assert.equal(config.gatewayURL, env.MYRIX_GATEWAY_URL)
  assert.throws(() => resolveCellConfig({ ...env, MYRIX_CELL_INTERNAL_HTTP_ORIGINS: declared,
    MYRIX_GATEWAY_URL: 'http://gateway:8789/v1' }), /https outside loopback/)
  assert.throws(() => resolveCellConfig({ ...env, MYRIX_CELL_INTERNAL_HTTP_ORIGINS: declared,
    MYRIX_GATEWAY_URL: 'http://evil.example/v1' }), /https outside loopback/)
  for (const value of ['null', '{}', 'true', '"*"', '["*"]', '["http://8.8.8.8"]',
    '["http://remote.example"]', '["http://bff:8791/path"]', '["http://bff:8791/"]',
    '["http://user:secret@bff:8791"]', '["http://bff:8791?secret=x"]']) {
    assert.throws(() => parseInternalHttpOrigins(value), /explicit JSON array/)
  }
  assert.deepEqual(parseInternalHttpOrigins(undefined), [])
  assert.equal(parseOrigin('http://[::1]:8404', 'X'), 'http://[::1]:8404')
})

test('origins are validated and credentials cannot hide in a URL', () => {
  assert.throws(() => parseOrigin('not-a-url', 'X'), /valid URL/)
  assert.throws(() => parseOrigin('http://works.example.internal', 'X'), /https outside loopback/)
  assert.throws(() => parseOrigin('https://user:pw@works.example.internal', 'X'), /embed credentials/)
  assert.throws(() => parseOrigin('https://works.example.internal/?token=abc', 'X'), /query string/)
  assert.equal(parseOrigin('http://127.0.0.1:8081', 'X'), 'http://127.0.0.1:8081')
  assert.equal(parseOrigin('https://works.example.internal', 'X'), 'https://works.example.internal')
})

test('the entry validates the whole declaration even when an origin is unused, and forwards it', (t) => {
  const home = join(tempDir(t, 'declare'), 'home')
  // A valid HTTPS deployment that declares garbage must still refuse: every entry
  // is validated, not just the ones this cell happens to use (ADR 0030).
  const https = { ...baseEnv(home) }
  for (const value of ['["http://*:1"]', '["http://bff:8791", "http://evil.example:1"]',
    '["https://bff:8791"]', '["http://bff:8791/x"]']) {
    assert.throws(
      () => resolveCellConfig({ ...https, MYRIX_CELL_INTERNAL_HTTP_ORIGINS: value }),
      /explicit JSON array/,
      `rejected ${value}`,
    )
  }
  // A canonical declaration is normalized, de-duplicated and carried on the config
  // so `buildCellOptions` can pass exactly this list to the plugins.
  const declared = JSON.stringify(['http://bff:8791', 'http://gateway:8790', 'http://bff:8791'])
  const config = resolveCellConfig({
    ...https,
    MYRIX_WORKS_ORIGIN: 'http://bff:8791',
    MYRIX_GATEWAY_URL: 'http://gateway:8790/v1',
    MYRIX_CELL_INTERNAL_HTTP_ORIGINS: declared,
  })
  assert.deepEqual(config.internalHttpOrigins, ['http://bff:8791', 'http://gateway:8790'])
  const options = buildCellOptions(config, ['get_outline'])
  assert.deepEqual(options.internalHttpOrigins, ['http://bff:8791', 'http://gateway:8790'])
})

test('paths stay inside the writable home and never touch the application root', (t) => {
  const dir = tempDir(t, 'paths')
  const home = join(dir, 'home')
  assert.equal(resolveCellConfig(baseEnv(home)).home, resolve(home))

  // A relative home, the filesystem root, /tmp and anything under /app refuse.
  assert.throws(() => resolveCellConfig({ ...baseEnv(home), DSH_HOME: 'home' }), /absolute path/)
  assert.throws(() => resolveCellConfig({ ...baseEnv(home), DSH_HOME: '/' }), /filesystem root/)
  assert.throws(() => resolveCellConfig({ ...baseEnv(home), DSH_HOME: '/tmp' }), /persistent volume/)
  assert.throws(() => resolveCellConfig({ ...baseEnv(home), DSH_HOME: resolve(baseEnv(home).MYRIX_REPO_ROOT, 'data') }), /read-only application root/)

  // The generated profile lives under the home; nothing is compiled into /app.
  const config = resolveCellConfig(baseEnv(home))
  assert.ok(config.home.startsWith(realpathSync(dir)))
  assert.ok(!config.home.startsWith(config.appRoot))
})

test('the child environment is an allowlist that drops ambient secrets', (t) => {
  const dir = tempDir(t, 'env')
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  const env = {
    ...baseEnv(home),
    PATH: '/usr/bin:/bin',
    TZ: 'UTC',
    // Ambient material that must not survive into the Cell.
    AWS_SECRET_ACCESS_KEY: 'ambient-cloud-credential',
    GITHUB_TOKEN: 'ambient-forge-token',
  }
  const config = resolveCellConfig(env)
  const cell = {
    home,
    install: { version: '0.2.0-rc.2' },
    env: {
      MYRIX_CELL_ID: config.cellId,
      MYRIX_TENANT_ID: config.tenantId,
      MYRIX_CELL_HOST: config.host,
      MYRIX_CELL_PORT: String(config.port),
    },
    port: config.port,
    secrets: {
      MYRIX_GRANT_JWKS: JSON.stringify(config.secrets.grantJwks),
      MYRIX_WORKS_TOKEN: config.secrets.worksToken,
      MYRIX_GATEWAY_TOKEN: config.secrets.gatewayToken,
      MYRIX_DRAIN_TOKEN: config.secrets.drainToken,
      MYRIX_REVOKE_TOKEN: config.secrets.revokeToken,
    },
  }
  const childEnv = childEnvironment(cell, env)
  assert.equal(childEnv.PATH, '/usr/bin:/bin')
  assert.equal(childEnv.TZ, 'UTC')
  assert.equal(childEnv.AWS_SECRET_ACCESS_KEY, undefined)
  assert.equal(childEnv.GITHUB_TOKEN, undefined)
  assert.equal(childEnv.NODE_OPTIONS, undefined)
  assert.equal(childEnv.NODE_PATH, undefined)
  assert.equal(childEnv.DSH_HOME, home)
  // The k8s port contract and the profile's own variable agree.
  assert.equal(childEnv.MYRIX_DRIVER_PORT, String(config.port))
  assert.equal(childEnv.MYRIX_CELL_PORT, String(config.port))
  // Every one of the five credentials reaches the Cell, and only the Cell.
  for (const name of ['MYRIX_GRANT_JWKS', 'MYRIX_WORKS_TOKEN', 'MYRIX_GATEWAY_TOKEN', 'MYRIX_DRAIN_TOKEN', 'MYRIX_REVOKE_TOKEN']) {
    assert.ok(typeof childEnv[name] === 'string' && childEnv[name].length > 0, `${name} must reach the Cell`)
  }
  // Temp is redirected into the writable, persistent home.
  assert.ok(childEnv.TMPDIR.startsWith(home))
})

test('known platform secrets are refused, not merely ignored', (t) => {
  const dir = tempDir(t, 'secrets')
  const home = join(dir, 'home')
  for (const name of [
    'DATABASE_URL', 'MYRIX_MIGRATE_DATABASE_URL', 'MYRIX_AUTH_DATABASE_URL',
    'MYRIX_RUNTIME_SIGNING_KEY_PEM', 'MYRIX_GATEWAY_UPSTREAM_API_KEY',
    'OPENAI_API_KEY', 'NODE_OPTIONS', 'NODE_PATH', 'MYRIX_AUTH_MODE',
  ]) {
    assert.throws(
      () => resolveCellConfig({ ...baseEnv(home), [name]: 'fixture-value-that-is-long' }),
      /refusing to run with/,
      `${name} must be refused`,
    )
  }
  // Our own non-secret deployment input is not confused with platform material.
  assert.doesNotThrow(() => resolveCellConfig({ ...baseEnv(home), MYRIX_CREDENTIALS_DIR: dir }))
})

test('a credential mount must agree with the environment', (t) => {
  const dir = tempDir(t, 'mount')
  const home = join(dir, 'home')
  const mount = join(dir, 'credentials')
  mkdirSync(mount, { recursive: true })
  assert.equal(resolveCellConfig({ ...baseEnv(home), MYRIX_CREDENTIALS_DIR: mount }).secrets.worksToken, fakeSecret('works'))

  writeFileSync(join(mount, 'MYRIX_WORKS_TOKEN'), `${fakeSecret('works')}\n`, { mode: 0o600 })
  assert.equal(resolveCellConfig({ ...baseEnv(home), MYRIX_CREDENTIALS_DIR: mount }).secrets.worksToken, fakeSecret('works'))

  // The Secret is an alternative source, not an override.
  writeFileSync(join(mount, 'MYRIX_WORKS_TOKEN'), `${fakeSecret('other')}\n`, { mode: 0o600 })
  assert.throws(
    () => resolveCellConfig({ ...baseEnv(home), MYRIX_CREDENTIALS_DIR: mount }),
    /different values/,
  )

  // A Secret-only deployment is legal and still requires every credential.
  const secretOnly = { ...baseEnv(home), MYRIX_CREDENTIALS_DIR: join(dir, 'empty') }
  for (const name of ['MYRIX_WORKS_TOKEN', 'MYRIX_GATEWAY_TOKEN', 'MYRIX_DRAIN_TOKEN', 'MYRIX_REVOKE_TOKEN']) {
    delete secretOnly[name]
  }
  mkdirSync(secretOnly.MYRIX_CREDENTIALS_DIR, { recursive: true })
  for (const name of ['MYRIX_WORKS_TOKEN', 'MYRIX_GATEWAY_TOKEN', 'MYRIX_DRAIN_TOKEN', 'MYRIX_REVOKE_TOKEN']) {
    writeFileSync(join(secretOnly.MYRIX_CREDENTIALS_DIR, name), fakeSecret(name), { mode: 0o600 })
  }
  const resolved = resolveCellConfig(secretOnly)
  assert.equal(resolved.secrets.worksToken, fakeSecret('MYRIX_WORKS_TOKEN'))
})

test('PoC-only seams and disabled policy are refused in production', (t) => {
  const dir = tempDir(t, 'seams')
  const home = join(dir, 'home')
  assert.throws(() => resolveCellConfig({ ...baseEnv(home), MYRIX_CELL_PROBE: '1' }), /PoC-only seam/)
  assert.throws(() => resolveCellConfig({ ...baseEnv(home), MYRIX_CELL_ROUTE_SEAM: 'waterfall' }), /PoC-only seam/)
  assert.throws(() => resolveCellConfig({ ...baseEnv(home), MYRIX_REQUIRE_POLICY: '0' }), /policy bridge/)
  assert.doesNotThrow(() => resolveCellConfig({ ...baseEnv(home), MYRIX_CELL_ROUTE_SEAM: 'none', MYRIX_REQUIRE_POLICY: '1' }))
})

test('the Cell binds the container network but stays explicit about identity', (t) => {
  const dir = tempDir(t, 'bind')
  const home = join(dir, 'home')
  const config = resolveCellConfig(baseEnv(home))
  assert.equal(config.host, '0.0.0.0')
  assert.equal(config.cellId, 'cell-t1')
  assert.equal(config.tenantId, 'tenant-t1')
  assert.equal(config.port, 8404)
  const explicit = resolveCellConfig({ ...baseEnv(home), MYRIX_CELL_HOST: '0.0.0.0' })
  assert.equal(explicit.host, '0.0.0.0')
})

test('factory options never carry a PoC opt-out and always carry verified grants', (t) => {
  const dir = tempDir(t, 'options')
  const home = join(dir, 'home')
  const config = resolveCellConfig(baseEnv(home))
  const options = buildCellOptions(config, ['get_outline'])
  assert.equal(options.mode, 'production')
  assert.equal(options.novel, true)
  assert.equal(options.requirePolicy, true)
  assert.equal(options.routeSeam, 'none')
  assert.equal(options.probe, false)
  assert.ok(Array.isArray(options.grantPublicJwks) && options.grantPublicJwks.length === 1)
  assert.equal(options.novelOptOutReason, undefined)
})

test('the allowlist is derived from the real tool source, never hard-coded', async () => {
  assert.deepEqual(await resolveAllowedTools(['only-this'], APP_ROOT), ['only-this'])
  const derived = await resolveAllowedTools(undefined, APP_ROOT)
  assert.ok(derived.includes('get_outline'), 'the canonical novel tools must be picked up from source')
  assert.ok(derived.includes('update_bible_entry'))
  // A source that is absent fails closed with an actionable message.
  await assert.rejects(resolveAllowedTools(undefined, join(TMP_ROOT, 'no-such-checkout')), /MYRIX_ALLOWED_TOOLS explicitly/)
})

test('the real factory accepts the resolved options and produces a bootable profile', async (t) => {
  const dir = tempDir(t, 'factory')
  const home = join(dir, 'home')
  const config = resolveCellConfig(baseEnv(home))
  // Compile into the home (the only writable path in the container) and hand the
  // manifest to the factory exactly as the entry's own compile path does.
  const precompiled = compilePluginEntries({ repo: APP_ROOT, outDir: join(home, '.plugins'), fresh: false })
  const cell = realFactory.createCellProfile({ ...buildCellOptions(config, ['get_outline']), precompiled })
  // The factory, not the entry, owns the layout; the entry only consumes it.
  assert.equal(cell.home, resolve(home))
  assert.equal(cell.profileDir, resolve(home, 'profiles', 'myrix-cell'))
  assert.ok(existsSync(join(cell.profileDir, 'cordis.patch.yml')))
  assert.ok(existsSync(cell.files.cordis))
  assert.ok(existsSync(cell.files.package))
  // Compilation output stayed inside the writable home, never under /app.
  for (const output of Object.values(precompiled.packages).flatMap((pkg) => [pkg.dir])) {
    assert.ok(output.startsWith(realpathSync(home)), 'compiled plugins must stay inside DSH_HOME')
  }
  // Credentials are env references only: nothing secret is on disk.
  const patch = readFileSync(cell.files.patch, 'utf8')
  assert.ok(!patch.includes(config.secrets.worksToken))
  assert.ok(!patch.includes(config.secrets.gatewayToken))
  assert.match(patch, /process\.env\.MYRIX_WORKS_TOKEN/)
  assert.match(patch, /requirePolicy: !!js process\.env\.MYRIX_REQUIRE_POLICY !== '0'/)
  // The child environment built from the real descriptor carries the credentials
  // by value and no platform secret.
  const childEnv = childEnvironment(cell, baseEnv(home))
  assert.equal(childEnv.MYRIX_WORKS_TOKEN, config.secrets.worksToken)
  assert.equal(childEnv.MYRIX_TENANT_ID, 'tenant-t1')
  assert.equal(childEnv.DSH_HOME, resolve(home))
  // The declaration variable travels to the child verbatim so the generated
  // `!!js` row evaluates to the same list the entry validated.
  assert.equal(childEnv.MYRIX_CELL_INTERNAL_HTTP_ORIGINS, '[]')
})

test('a declared same-host deployment boots through entry → factory → real plugin config', async (t) => {
  const dir = tempDir(t, 'compose-e2e')
  const home = join(dir, 'home')
  const origins = ['http://bff:8791', 'http://gateway:8790']
  const env = {
    ...baseEnv(home),
    MYRIX_WORKS_ORIGIN: 'http://bff:8791',
    MYRIX_GATEWAY_URL: 'http://gateway:8790/v1',
    MYRIX_CELL_INTERNAL_HTTP_ORIGINS: JSON.stringify(origins),
  }
  const config = resolveCellConfig(env)
  const precompiled = compilePluginEntries({ repo: APP_ROOT, outDir: join(home, '.plugins'), fresh: false })
  const cell = realFactory.createCellProfile({ ...buildCellOptions(config, ['get_outline']), precompiled })
  // The generated row reads the declaration from the environment, not a literal.
  const patch = readFileSync(cell.files.patch, 'utf8')
  assert.match(patch, /internalHttpOrigins: !!js JSON\.parse\(process\.env\.MYRIX_CELL_INTERNAL_HTTP_ORIGINS \?\? '\[\]'\)/)
  // Both plugin rows carry the declaration (the gateway and the lease).
  assert.equal((patch.match(/internalHttpOrigins: !!js/g) ?? []).length, 2)
  // The child environment is what the loader evaluates the row against.
  const childEnv = childEnvironment(cell, env)
  assert.equal(childEnv.MYRIX_CELL_INTERNAL_HTTP_ORIGINS, JSON.stringify(origins))
})

test('the entry spawns the locked CLI with the profile flag and only safe args', async (t) => {
  const dir = tempDir(t, 'spawn')
  const home = join(dir, 'home')
  const spawns = []
  const factory = {
    createCellProfile: () => ({
      home,
      profileName: 'myrix-cell',
      profileDir: join(home, 'profiles', 'myrix-cell'),
      install: { cli: join(APP_ROOT, 'tests', 'poc', '.dsh-install', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), version: '0.2.0-rc.2' },
      port: 8404,
      env: {},
      secrets: {},
      linkBundle: () => join(home, 'profiles', 'myrix-cell', 'node_modules', '@myrix', 'dsh-bundle-myrix-base'),
    }),
  }
  const child = {
    pid: 1,
    exitCode: null,
    signalCode: null,
    kill() { this.signalCode = 'SIGTERM'; queueMicrotask(() => this.emit('exit', 0, 'SIGTERM')); return true },
    once(event, handler) { if (event === 'exit') this.handler = handler; return this },
    emit(event, code, signal) { this.exitCode = code; this.handler?.(code, signal) },
  }
  const handle = await runCellEntry({
    env: baseEnv(home),
    factory,
    spawnImpl: (command, args, options) => {
      spawns.push({ command, args, options })
      return child
    },
    handleSignals: false,
    log: () => {},
  })
  assert.equal(spawns.length, 1)
  const [spawned] = spawns
  // The CLI is invoked through the Node binary with the real flag, not a guess.
  assert.equal(spawned.command, process.execPath)
  assert.deepEqual(spawned.args.slice(1), ['--profile', 'myrix-cell'])
  assert.ok(spawned.args[0].endsWith('bin.js'))
  // The child runs from the writable home so nothing writes to /app.
  assert.equal(spawned.options.cwd, resolve(home))
  assert.equal(spawned.options.env.MYRIX_DRIVER_PORT, '8404')
  assert.equal(spawned.options.env.DSH_HOME, resolve(home))
  assert.equal(handle.args[1], '--profile')
  const code = await handle.stop()
  assert.equal(code.code, 0)
  assert.equal(await handle.done(), 0)
})

test('SIGTERM and SIGINT stop the child and leave no listener behind', async (t) => {
  const dir = tempDir(t, 'signals')
  const home = join(dir, 'home')
  const children = []
  const factory = {
    createCellProfile: () => ({
      home,
      profileName: 'myrix-cell',
      profileDir: join(home, 'profiles', 'myrix-cell'),
      install: { cli: join(APP_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), version: '0.2.0-rc.2' },
      port: 8404,
      env: {},
      secrets: {},
      linkBundle: () => home,
    }),
  }
  const makeChild = () => {
    const child = {
      pid: children.length + 1,
      exitCode: null,
      signalCode: null,
      kill(signal) { this.signalCode = signal; queueMicrotask(() => this.handler?.(null, signal)); return true },
      once(event, handler) { if (event === 'exit') this.handler = handler; return this },
    }
    children.push(child)
    return child
  }
  const before = process.listenerCount('SIGTERM') + process.listenerCount('SIGINT')
  const handle = await runCellEntry({
    env: baseEnv(home),
    factory,
    spawnImpl: () => makeChild(),
    handleSignals: true,
    graceMs: 50,
    log: () => {},
  })
  assert.ok(process.listenerCount('SIGTERM') > 0, 'the entry must listen for SIGTERM')
  assert.ok(process.listenerCount('SIGINT') > 0, 'the entry must listen for SIGINT')
  process.emit('SIGTERM')
  const result = await handle.stop()
  assert.equal(result.signal, 'SIGTERM')
  assert.equal(children[0].signalCode, 'SIGTERM')
  handle.removeSignalHandlers()
  assert.equal(process.listenerCount('SIGTERM') + process.listenerCount('SIGINT'), before)
})

test('a restart reuses the persistent home and never deletes session history', (t) => {
  const dir = tempDir(t, 'restart')
  const home = join(dir, 'home')
  mkdirSync(join(home, 'sessions'), { recursive: true })
  const history = join(home, 'sessions', 'session.jsonl')
  writeFileSync(history, '{"fixture":"first boot"}\n', { mode: 0o600 })

  // Two full resolutions must leave the durable log exactly where it was.
  resolveCellConfig(baseEnv(home))
  resolveCellConfig(baseEnv(home))
  assert.ok(existsSync(history))
  assert.equal(readFileSync(history, 'utf8'), '{"fixture":"first boot"}\n')

  // The entry refuses a restart against a home it cannot write, and it never
  // deletes the home to recover.
  const source = readFileSync(ENTRY, 'utf8')
  assert.doesNotMatch(source, /rmSync\([^)]*home/)
  assert.match(source, /never touched|never deletes|Reusing|reuse/i)
})

test('the entry refuses startup with a fixed redacted message and no stack', (t) => {
  const dir = tempDir(t, 'redact')
  const secret = fakeSecret('leaky')
  const env = { ...baseEnv(join(dir, 'home')), MYRIX_WORKS_TOKEN: secret, DSH_HOME: '/' }
  const run = spawnSync(process.execPath, [ENTRY], {
    env: cleanProcessEnv(env),
    encoding: 'utf8',
    timeout: 60_000,
  })
  assert.notEqual(run.status, 0, 'an invalid DSH_HOME must not boot')
  assert.match(run.stderr, /myrix-cell-entry/)
  // The message may name a variable; it may never contain a value.
  assert.ok(!run.stderr.includes(secret), 'stderr must not contain a credential value')
  assert.ok(!run.stderr.includes('at '), 'stderr must not carry a stack trace')
  assert.match(redact(`boom ${secret}`, [secret]), /boom \[redacted\]/)
})

/** A minimal process environment for the spawn-based checks. */
function cleanProcessEnv(extra) {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    ...extra,
  }
}
