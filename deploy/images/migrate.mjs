#!/usr/bin/env node
// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0
/**
 * Explicit operational migration entry point for Myrix containers.
 *
 * ```
 * node deploy/images/migrate.mjs --target business
 * node deploy/images/migrate.mjs --target gateway
 * node deploy/images/migrate.mjs --target business,gateway
 * ```
 *
 * This is an **operator override**, never a startup hook: it is not referenced
 * by any `CMD`, it is not imported by `cell-entry.mjs`, and it refuses to run
 * without an explicitly named target. A Cell container boots without it, and a
 * platform rollout invokes it as a separate Job.
 *
 * ## What it will not do
 *
 *   * It never seeds. `packages/platform-store/src/bin/seed.ts` and its
 *     `DEV_IDENTITIES` are not imported, and no development identity, tenant or
 *     credential is ever created here. The only exported behaviour is
 *     `migrateToLatest` against the two real migration runners.
 *   * It never derives a connection string. `DATABASE_URL` and any application
 *     role URL are ignored: migrations must run as the owner/migration role, and
 *     the operator has to say so with `MYRIX_MIGRATE_DATABASE_URL` (business) or
 *     `MYRIX_GATEWAY_MIGRATE_DATABASE_URL` (gateway ledger).
 *   * It never prints a connection string, a password or a driver error verbatim.
 *
 * ## Why `tsx` is loaded here
 *
 * The migration runners are TypeScript (`packages/platform-store/src/bin/migrate.ts`,
 * `apps/model-gateway/src/db/migrate.ts`) and read their `.sql` files relative to
 * their own module URL, so they must be imported in place rather than copied or
 * bundled. The image ships the workspace sources and `node_modules`, and the
 * migration command is a one-shot operator process — the runtime does not load
 * `tsx`. If `tsx` is unavailable the entry fails closed instead of falling back
 * to a re-implementation that could drift from the real migration set.
 *
 * @module myrix-deploy/migrate
 */
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Repository root inside the image (`/app/deploy/images/migrate.mjs`). */
export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Environment variable holding the business (platform-store) migration URL. */
export const BUSINESS_URL_ENV = 'MYRIX_MIGRATE_DATABASE_URL'

/** Environment variable holding the model-gateway ledger migration URL. */
export const GATEWAY_URL_ENV = 'MYRIX_GATEWAY_MIGRATE_DATABASE_URL'

/** The targets this entry can act on, in dependency order. */
export const TARGETS = Object.freeze(['business', 'gateway'])

/** A safe migration error. The message never contains a connection string. */
export class MigrationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'MigrationError'
  }
}

/**
 * Remove credentials embedded in any URL-like text.
 *
 * `postgres://user:secret@host/db` becomes `postgres://user:[redacted]@host/db`.
 * Used on every message before it is printed, including driver errors.
 *
 * @param {unknown} value - the text to sanitize.
 * @returns {string} the sanitized text.
 */
export function redactSecrets(value) {
  const text = typeof value === 'string' ? value : String(value)
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+):[^@\s/]+@/gi, '$1:[redacted]@')
    .replace(/(password|passwd|pwd)\s*=\s*\S+/gi, '$1=[redacted]')
}

/**
 * Turn any thrown value into a single printable, redacted line.
 *
 * @param {unknown} error - the failure.
 * @returns {string} the safe message.
 */
export function sanitizeError(error) {
  return redactSecrets(error instanceof Error ? error.message : error)
}

/**
 * Parse the command line.
 *
 * There is no default target: an operator asking for a migration must name it.
 *
 * @param {readonly string[]} argv - arguments after the script path.
 * @returns {{ targets: string[] }} the requested targets, de-duplicated in order.
 * @throws {MigrationError} on an unknown flag or an unspecified/invalid target.
 */
export function parseArgs(argv) {
  const requested = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--target') {
      const value = argv[index + 1]
      if (value === undefined) throw new MigrationError('myrix-migrate: --target needs a value (business or gateway)')
      requested.push(...value.split(','))
      index += 1
    } else if (arg.startsWith('--target=')) {
      requested.push(...arg.slice('--target='.length).split(','))
    } else {
      throw new MigrationError('myrix-migrate: unknown argument; only --target is supported')
    }
  }
  const targets = requested.map((target) => target.trim()).filter((target) => target.length > 0)
  if (targets.length === 0) {
    throw new MigrationError('myrix-migrate: --target is required (business, gateway, or both); migrations never run implicitly')
  }
  for (const target of targets) {
    if (!TARGETS.includes(target)) {
      throw new MigrationError('myrix-migrate: unknown target; expected business or gateway')
    }
  }
  return { targets: [...new Set(targets)] }
}

/**
 * Read the migration URL for one target.
 *
 * The application URL (`DATABASE_URL`) is deliberately ignored: a migration run
 * as the application role would either fail or, worse, be granted rights it must
 * not have.
 *
 * @param {NodeJS.ProcessEnv} env - the environment.
 * @param {string} target - `business` or `gateway`.
 * @returns {string} the connection string.
 * @throws {MigrationError} when it is missing or not a postgres URL.
 */
export function resolveMigrationUrl(env, target) {
  const name = target === 'business' ? BUSINESS_URL_ENV : GATEWAY_URL_ENV
  const value = env[name]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MigrationError(`myrix-migrate: missing ${name}; migrations require the owner/migration role connection string explicitly`)
  }
  let url
  try {
    url = new URL(value)
  } catch {
    throw new MigrationError(`myrix-migrate: ${name} is not a valid postgres URL`)
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new MigrationError(`myrix-migrate: ${name} must be a postgres URL`)
  }
  if (url.pathname === '' || url.pathname === '/') {
    throw new MigrationError(`myrix-migrate: ${name} must name a database`)
  }
  return value
}

/**
 * Refuse an environment that would pull development seeding into a migration.
 *
 * @param {NodeJS.ProcessEnv} env - the environment.
 * @returns {void}
 * @throws {MigrationError} when a seeding signal is present.
 */
export function assertNoSeeding(env) {
  for (const name of ['MYRIX_SEED', 'MYRIX_SEED_DEV', 'MYRIX_DEV_SEED']) {
    if (env[name] === '1' || env[name] === 'true') {
      throw new MigrationError(`myrix-migrate: refusing to seed (${name} is set); this entry only applies migrations`)
    }
  }
}

/** Locate the `tsx` ESM loader inside the image's `node_modules`. */
function resolveTsxLoader(appRoot) {
  const loader = resolve(appRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')
  if (!existsSync(loader)) {
    throw new MigrationError(
      'myrix-migrate: the TypeScript loader (tsx) is not present in this image; '
      + 'run migrations from an image that ships the workspace toolchain',
    )
  }
  return loader
}

/**
 * Apply the business (platform-store) migrations.
 *
 * Imports the real runner so the SQL set and its checksums are the repository's,
 * never a copy.
 *
 * @param {string} connectionString - owner-role URL.
 * @param {string} appRoot - repository root.
 * @returns {Promise<{ applied: string[], skipped: string[] }>} the result.
 */
export async function migrateBusiness(connectionString, appRoot) {
  const { runMigrate } = await import(pathToFileURL(resolve(appRoot, 'packages/platform-store/src/bin/migrate.ts')).href)
  if (typeof runMigrate !== 'function') throw new MigrationError('myrix-migrate: the business migration runner exported no runMigrate')
  await runMigrate(connectionString)
  return { applied: [], skipped: [] }
}

/**
 * Apply the model-gateway ledger migrations.
 *
 * The ledger is a separate schema with its own migration table, so it has its
 * own URL and its own Kysely instance.
 *
 * @param {string} connectionString - owner-role URL.
 * @param {string} appRoot - repository root.
 * @returns {Promise<{ applied: string[], skipped: string[] }>} the result.
 */
export async function migrateGateway(connectionString, appRoot) {
  const { migrateToLatest } = await import(pathToFileURL(resolve(appRoot, 'apps/model-gateway/src/db/migrate.ts')).href)
  if (typeof migrateToLatest !== 'function') throw new MigrationError('myrix-migrate: the gateway migration runner exported no migrateToLatest')
  const { Kysely, PostgresDialect, Pool } = await loadGatewayDatabaseDependencies(appRoot)
  const pool = new Pool({ connectionString, max: 1, application_name: 'myrix-migrate-gateway' })
  const db = new Kysely({ dialect: new PostgresDialect({ pool }) })
  try {
    const result = await migrateToLatest(db)
    for (const name of result.skipped) process.stdout.write(`skip    ${name}\n`)
    for (const name of result.applied) process.stdout.write(`applied ${name}\n`)
    return result
  } finally {
    await db.destroy()
  }
}

/** Resolve from the owning workspace, not accidental root-level hoisting. */
export async function loadGatewayDatabaseDependencies(appRoot) {
  const fromGateway = createRequire(resolve(appRoot, 'apps/model-gateway/package.json'))
  const { Kysely, PostgresDialect } = await import(pathToFileURL(fromGateway.resolve('kysely')).href)
  const pg = await import(pathToFileURL(fromGateway.resolve('pg')).href)
  return { Kysely, PostgresDialect, Pool: pg.Pool ?? pg.default?.Pool }
}

/**
 * Run the requested migrations in order.
 *
 * @param {{
 *   argv?: readonly string[],
 *   env?: NodeJS.ProcessEnv,
 *   appRoot?: string,
 *   migrate?: { business?: typeof migrateBusiness, gateway?: typeof migrateGateway },
 * }} [options] - injection seams for tests.
 * @returns {Promise<{ targets: string[], applied: string[], skipped: string[] }>} the summary.
 */
export async function runMigrations(options = {}) {
  const env = options.env ?? process.env
  const appRoot = resolve(options.appRoot ?? APP_ROOT)
  assertNoSeeding(env)
  const { targets } = parseArgs(options.argv ?? process.argv.slice(2))
  const runners = options.migrate ?? {}
  const applied = []
  const skipped = []
  for (const target of targets) {
    const connectionString = resolveMigrationUrl(env, target)
    const injected = target === 'business' ? runners.business : runners.gateway
    const run = injected ?? ((url, root) => (target === 'business' ? migrateBusiness(url, root) : migrateGateway(url, root)))
    const result = await run(connectionString, appRoot)
    applied.push(...result.applied)
    skipped.push(...result.skipped)
    process.stdout.write(`migrate: ${target} done\n`)
  }
  return { targets, applied, skipped }
}

/** Entry point. Errors are redacted; the connection string is never printed. */
async function main() {
  const { register } = await import('tsx/esm/api').catch(() => {
    throw new MigrationError('myrix-migrate: the TypeScript loader is unavailable; this image cannot run migrations')
  })
  resolveTsxLoader(resolve(APP_ROOT))
  register()
  const summary = await runMigrations({})
  process.stdout.write(`migrate: ${String(summary.applied.length)} applied, ${String(summary.skipped.length)} already present\n`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${sanitizeError(error)}\n`)
    process.exitCode = 1
  })
}
