#!/usr/bin/env node
// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0
/**
 * Auth-schema migration entry point (VPS Compose deployment).
 *
 * The Lead-owned `deploy/images/migrate.mjs` covers the platform business tables
 * and the model-gateway ledger, but the BFF's opaque authentication schema
 * (`myrix_auth.sessions` / `flows` / `subjects`) is created by
 * `migrateAuth()` in `apps/bff/src/auth-store.ts`, which is deliberately *not*
 * run at server startup (ADR-0020/0021). A VPS deployment therefore needs one
 * more explicit one-shot job, otherwise the BFF refuses to start because the
 * runtime check cannot find those three tables.
 *
 * This entry mirrors the conventions of `migrate.mjs`:
 *
 *   * it never seeds and never derives a connection string;
 *   * it runs only as the owner/migration role, named explicitly through
 *     `MYRIX_MIGRATE_DATABASE_URL`;
 *   * it names the application role to grant (`MYRIX_AUTH_ROLE`) instead of
 *     guessing it;
 *   * it redacts passwords from every printed message.
 *
 * `migrateAuth()` itself takes a transaction-level advisory lock, creates the
 * schema, and grants `SELECT/INSERT/DELETE` on sessions/flows plus `SELECT` on
 * subjects to the given role — so it is safe to re-run.
 *
 * @module myrix-deploy/migrate-auth
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Repository root inside the image (`/app/deploy/images/migrate-auth.mjs`). */
export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Owner/migration role connection string. The application URL is ignored. */
export const MIGRATE_URL_ENV = 'MYRIX_MIGRATE_DATABASE_URL'

/** Application role that receives the auth-schema grants. */
export const AUTH_ROLE_ENV = 'MYRIX_AUTH_ROLE'

/**
 * Optional repository-root override.
 *
 * By default the root is two levels above this file, which matches the image
 * layout `/app/deploy/images/migrate-auth.mjs`. An operator whose image places
 * the workspace elsewhere sets `MYRIX_APP_ROOT` instead of editing this file.
 */
export const APP_ROOT_ENV = 'MYRIX_APP_ROOT'

const ROLE_PATTERN = /^[a-z][a-z0-9_]{0,62}$/

export class AuthMigrationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AuthMigrationError'
  }
}

/** Replace any embedded password with `[redacted]` before printing. */
export function redactSecrets(value) {
  const text = typeof value === 'string' ? value : String(value)
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+):[^@\s/]+@/gi, '$1:[redacted]@')
    .replace(/(password|passwd|pwd)\s*=\s*\S+/gi, '$1=[redacted]')
}

export function sanitizeError(error) {
  return redactSecrets(error instanceof Error ? error.message : error)
}

/**
 * Resolve the migration URL and application role from the environment.
 *
 * @param {NodeJS.ProcessEnv} env - the process environment.
 * @returns {{ url: string, role: string }} the validated inputs.
 * @throws {AuthMigrationError} when either value is absent or malformed.
 */
export function resolveInputs(env) {
  const raw = env[MIGRATE_URL_ENV]
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new AuthMigrationError(
      `myrix-migrate-auth: missing ${MIGRATE_URL_ENV}; the auth schema must be migrated with the owner/migration role`,
    )
  }
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new AuthMigrationError(`myrix-migrate-auth: ${MIGRATE_URL_ENV} is not a valid postgres URL`)
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new AuthMigrationError(`myrix-migrate-auth: ${MIGRATE_URL_ENV} must be a postgres URL`)
  }
  if (url.pathname === '' || url.pathname === '/') {
    throw new AuthMigrationError(`myrix-migrate-auth: ${MIGRATE_URL_ENV} must name a database`)
  }
  const role = env[AUTH_ROLE_ENV]
  if (typeof role !== 'string' || role.trim().length === 0) {
    throw new AuthMigrationError(
      `myrix-migrate-auth: missing ${AUTH_ROLE_ENV}; the auth grants must name an explicit application role`,
    )
  }
  if (!ROLE_PATTERN.test(role.trim())) {
    throw new AuthMigrationError(`myrix-migrate-auth: ${AUTH_ROLE_ENV} is not a valid role name`)
  }
  return { url: raw, role: role.trim() }
}

/**
 * Locate the `tsx` ESM loader inside the image's `node_modules`.
 *
 * With Node 24's type stripping this is only a failure hint: the entry itself
 * is plain JavaScript. A missing loader means the image cannot strip the
 * TypeScript `auth-store.ts` schema runner, so the migration fails closed.
 */
function resolveTsxLoader(appRoot) {
  const loader = resolve(appRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')
  if (!existsSync(loader)) {
    throw new AuthMigrationError(
      'myrix-migrate-auth: the TypeScript loader (tsx) is not present in this image; '
      + 'run migrations from an image that ships the workspace toolchain',
    )
  }
  return loader
}

/**
 * Resolve `pg` from the workspace that declares it (`apps/bff/package.json`).
 *
 * The repository deliberately has **no root `pg` dependency**: resolving from
 * the repository root would either find an accidental hoist or fail. The BFF
 * workspace declares `pg`, so its `node_modules` is the only correct source.
 * `pg` is CommonJS, so the `Pool` class lives on the default export.
 *
 * @param {string} appRoot - repository root inside the image.
 * @returns {Promise<typeof import('pg').Pool>} the Pool constructor.
 */
export async function loadPgPool(appRoot) {
  let resolved
  try {
    const requireFromBff = createRequire(resolve(appRoot, 'apps/bff/package.json'))
    resolved = requireFromBff.resolve('pg')
  } catch {
    throw new AuthMigrationError(
      'myrix-migrate-auth: cannot resolve "pg" from apps/bff/package.json; '
      + 'the image must install the BFF workspace dependencies',
    )
  }
  let imported
  try {
    imported = await import(pathToFileURL(resolved).href)
  } catch {
    throw new AuthMigrationError('myrix-migrate-auth: failed to load the "pg" driver from the BFF workspace')
  }
  const Pool = imported.Pool ?? imported.default?.Pool
  if (typeof Pool !== 'function') {
    throw new AuthMigrationError('myrix-migrate-auth: the "pg" driver exposed no Pool constructor')
  }
  return Pool
}

/**
 * Apply the auth-schema migration using the repository's own runner.
 *
 * @param {string} connectionString - owner-role URL.
 * @param {string} appRole - application role to grant.
 * @param {string} appRoot - repository root.
 * @param {{ loadPool?: typeof loadPgPool }} [deps] - injection seam for tests.
 * @returns {Promise<void>} resolves once the schema and grants exist.
 */
export async function migrateAuthSchema(connectionString, appRole, appRoot, deps = {}) {
  const { migrateAuth } = await import(new URL('apps/bff/src/auth-store.ts', `file://${appRoot}/`).href)
  if (typeof migrateAuth !== 'function') {
    throw new AuthMigrationError('myrix-migrate-auth: the auth migration runner exported no migrateAuth')
  }
  const loadPool = deps.loadPool ?? loadPgPool
  const Pool = await loadPool(appRoot)
  const pool = new Pool({ connectionString, max: 1, application_name: 'myrix-migrate-auth' })
  try {
    await migrateAuth(pool, appRole)
  } finally {
    await pool.end()
  }
}

/**
 * Run the auth migration.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   appRoot?: string,
 *   migrate?: typeof migrateAuthSchema,
 * }} [options] - injection seams for tests.
 * @returns {Promise<{ role: string }>} the applied role.
 */
export async function runAuthMigration(options = {}) {
  const env = options.env ?? process.env
  const appRoot = resolve(options.appRoot ?? env[APP_ROOT_ENV] ?? APP_ROOT)
  const { url, role } = resolveInputs(env)
  const run = options.migrate ?? migrateAuthSchema
  await run(url, role, appRoot)
  return { role }
}

/** Entry point. Errors are redacted; the connection string is never printed. */
async function main() {
  const { register } = await import('tsx/esm/api').catch(() => {
    throw new AuthMigrationError('myrix-migrate-auth: the TypeScript loader is unavailable; this image cannot run migrations')
  })
  resolveTsxLoader(APP_ROOT)
  register()
  const { role } = await runAuthMigration({})
  process.stdout.write(`migrate-auth: myrix_auth schema ready (granted to ${role})\n`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${sanitizeError(error)}\n`)
    process.exitCode = 1
  })
}
