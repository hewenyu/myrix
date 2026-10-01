// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0
/**
 * Regressions for the explicit migration entry (`deploy/images/migrate.mjs`).
 *
 * The migration path must never be reachable implicitly, must never seed and
 * must never print a connection string. Every runner is injected here: no test
 * opens a database, and no test touches a real production secret.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  BUSINESS_URL_ENV,
  GATEWAY_URL_ENV,
  MigrationError,
  TARGETS,
  assertNoSeeding,
  loadGatewayDatabaseDependencies,
  parseArgs,
  redactSecrets,
  resolveMigrationUrl,
  runMigrations,
  sanitizeError,
} from '../../deploy/images/migrate.mjs'

const ENTRY = fileURLToPath(new URL('../../deploy/images/migrate.mjs', import.meta.url))

/** Drop comments so documentation that names a hazard is not read as the hazard. */
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** An obviously fake, non-production connection string. */
const BUSINESS_URL = 'postgres://fixture-owner:fixture-password@127.0.0.1:5432/fixture_business'
const GATEWAY_URL = 'postgres://fixture-owner:fixture-password@127.0.0.1:5432/fixture_gateway'

test('migrations are an explicit, named operation', () => {
  assert.deepEqual(TARGETS, ['business', 'gateway'])
  // No target means no work: migrations never run implicitly.
  assert.throws(() => parseArgs([]), /--target is required/)
  assert.throws(() => parseArgs(['--target']), /needs a value/)
  assert.throws(() => parseArgs(['--target', 'everything']), /unknown target/)
  assert.throws(() => parseArgs(['--all']), /unknown argument/)
  assert.deepEqual(parseArgs(['--target', 'business,gateway']).targets, ['business', 'gateway'])
  assert.deepEqual(parseArgs(['--target=gateway']).targets, ['gateway'])
  // De-duplication keeps a repeated target from running a migration twice.
  assert.deepEqual(parseArgs(['--target', 'gateway,gateway']).targets, ['gateway'])
})

test('the connection string must be an explicit owner-role postgres URL', () => {
  assert.throws(() => resolveMigrationUrl({}, 'business'), new RegExp(BUSINESS_URL_ENV))
  assert.throws(() => resolveMigrationUrl({}, 'gateway'), new RegExp(GATEWAY_URL_ENV))
  // The application URL is deliberately not accepted as a migration URL.
  assert.throws(
    () => resolveMigrationUrl({ DATABASE_URL: BUSINESS_URL, MYRIX_GATEWAY_DATABASE_URL: GATEWAY_URL }, 'business'),
    new RegExp(BUSINESS_URL_ENV),
  )
  assert.throws(() => resolveMigrationUrl({ [BUSINESS_URL_ENV]: 'sqlite:///tmp/x.db' }, 'business'), /postgres URL/)
  assert.throws(() => resolveMigrationUrl({ [BUSINESS_URL_ENV]: 'postgres://owner@host' }, 'business'), /name a database/)
  assert.throws(() => resolveMigrationUrl({ [BUSINESS_URL_ENV]: 'not a url' }, 'business'), /valid postgres URL/)
  assert.equal(resolveMigrationUrl({ [BUSINESS_URL_ENV]: BUSINESS_URL }, 'business'), BUSINESS_URL)
})

test('the entry never seeds or creates development identities', () => {
  for (const name of ['MYRIX_SEED', 'MYRIX_SEED_DEV', 'MYRIX_DEV_SEED']) {
    assert.throws(() => assertNoSeeding({ [name]: '1' }), /refusing to seed/)
  }
  assert.doesNotThrow(() => assertNoSeeding({}))

  const source = code(readFileSync(ENTRY, 'utf8'))
  // The seeding module and its development identities must not be reachable.
  assert.doesNotMatch(source, /import\(\s*[^)]*seed/)
  assert.doesNotMatch(source, /from\s+'[^']*seed/)
  assert.doesNotMatch(source, /DEV_IDENTITIES/)
  assert.doesNotMatch(source, /runSeed/)
  // The real migration runners are imported rather than re-implemented.
  assert.match(source, /packages\/platform-store\/src\/bin\/migrate\.ts/)
  assert.match(source, /apps\/model-gateway\/src\/db\/migrate\.ts/)
})

test('the real migration runners are reachable through the image loader', async () => {
  // No database is opened: this only proves the two hard-coded module paths
  // exist and export the functions the entry calls.
  const { register } = await import('tsx/esm/api')
  register()
  const business = await import(new URL('../../packages/platform-store/src/bin/migrate.ts', import.meta.url).href)
  const gateway = await import(new URL('../../apps/model-gateway/src/db/migrate.ts', import.meta.url).href)
  assert.equal(typeof business.runMigrate, 'function')
  assert.equal(typeof gateway.migrateToLatest, 'function')
})

test('gateway migration dependencies resolve from their declaring workspace on a clean install', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'myrix-migration-deps-')))
  t.after(() => {
    assert.equal(realpathSync(root), root, 'only remove the generated fixture directory')
    rmSync(root, { recursive: true, force: true })
  })
  for (const [name, exports] of [['kysely', ['Kysely', 'PostgresDialect']], ['pg', ['Pool']]]) {
    const dir = join(root, 'apps/model-gateway/node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, type: 'module', main: 'index.mjs' }))
    writeFileSync(join(dir, 'index.mjs'), exports.map(x => `export class ${x} { static marker = 'gateway-only' }`).join('\n'))
  }
  const deps = await loadGatewayDatabaseDependencies(root)
  for (const name of ['Kysely', 'PostgresDialect', 'Pool']) assert.equal(deps[name].marker, 'gateway-only')
})

test('every printed error is redacted', () => {
  assert.equal(
    redactSecrets('connect failed for postgres://owner:s3cret@db.internal:5432/myrix'),
    'connect failed for postgres://owner:[redacted]@db.internal:5432/myrix',
  )
  assert.equal(redactSecrets('password=hunter2 host=db'), 'password=[redacted] host=db')
  const message = sanitizeError(new Error(`no pg_hba.conf entry for ${BUSINESS_URL}`))
  assert.ok(!message.includes('fixture-password'))
  assert.match(message, /\[redacted\]/)
})

test('each target runs only its own runner, with its own URL', async (t) => {
  const calls = []
  const migrate = {
    business: async (url) => {
      calls.push(['business', url])
      return { applied: ['0000_roles.sql'], skipped: [] }
    },
    gateway: async (url) => {
      calls.push(['gateway', url])
      return { applied: ['0000_gateway.sql'], skipped: ['0001_honest_settlement.sql'] }
    },
  }
  const env = { [BUSINESS_URL_ENV]: BUSINESS_URL, [GATEWAY_URL_ENV]: GATEWAY_URL }

  const businessOnly = await runMigrations({ argv: ['--target', 'business'], env, migrate })
  assert.deepEqual(calls, [['business', BUSINESS_URL]])
  assert.deepEqual(businessOnly.targets, ['business'])
  assert.deepEqual(businessOnly.applied, ['0000_roles.sql'])

  calls.length = 0
  const both = await runMigrations({ argv: ['--target', 'business,gateway'], env, migrate })
  assert.deepEqual(calls, [['business', BUSINESS_URL], ['gateway', GATEWAY_URL]])
  assert.deepEqual(both.applied, ['0000_roles.sql', '0000_gateway.sql'])
  assert.deepEqual(both.skipped, ['0001_honest_settlement.sql'])
})

test('a configuration error fails before any runner is called', async () => {
  let called = false
  const migrate = { business: async () => { called = true; return { applied: [], skipped: [] } } }
  // No target, and a target whose URL is missing, both stop at validation.
  await assert.rejects(runMigrations({ argv: [], env: {}, migrate }), MigrationError)
  await assert.rejects(runMigrations({ argv: ['--target', 'business'], env: {}, migrate }), new RegExp(BUSINESS_URL_ENV))
  await assert.rejects(runMigrations({ argv: ['--target', 'gateway'], env: { [GATEWAY_URL_ENV]: 'sqlite:///x' }, migrate }), /postgres URL/)
  await assert.rejects(runMigrations({ argv: ['--target', 'business'], env: { MYRIX_SEED: '1' }, migrate }), /refusing to seed/)
  assert.equal(called, false)
})

test('the entry refuses to run without an explicit target, printing no URL', () => {
  const run = spawnSync(process.execPath, [ENTRY], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      [BUSINESS_URL_ENV]: BUSINESS_URL,
      [GATEWAY_URL_ENV]: GATEWAY_URL,
    },
    encoding: 'utf8',
    timeout: 60_000,
  })
  assert.notEqual(run.status, 0)
  assert.match(run.stderr, /--target is required/)
  assert.ok(!run.stderr.includes('fixture-password'), 'stderr must not contain a credential')
  assert.ok(!run.stdout.includes('fixture-password'), 'stdout must not contain a credential')
})
