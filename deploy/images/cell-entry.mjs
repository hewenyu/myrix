#!/usr/bin/env node
// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0
/**
 * Container entry point for one Myrix Cell (`spec.runtime.command` default).
 *
 * ```
 * node deploy/images/cell-entry.mjs
 * ```
 *
 * The image is assembled by `deploy/images/Dockerfile.node` (target `cell`):
 * `WORKDIR /app`, the full workspace source and its `node_modules`, the locked
 * DSH install at `tests/poc/.dsh-install`, and this file as `CMD`. The container
 * runs as a non-root, read-only-rootfs pod with exactly two writable mounts:
 * `DSH_HOME` (a persistent RWO volume) and `/tmp` (tmpfs). Nothing here ever
 * writes under `/app`; the profile factory's compile output and every temp file
 * go to `$DSH_HOME/.plugins` and `$DSH_HOME/tmp`, both on the persistent volume
 * so a restart reuses them.
 *
 * ## Why a launcher instead of a CLI invocation
 *
 * The driver profile is not static configuration: it must be materialized per
 * pod from the *deployment* environment. This entry therefore calls the one
 * sanctioned factory (`tests/poc/lib/cell-profile.mjs`) and never hand-writes a
 * `cordis.patch.yml`, never registers a plugin itself and never bypasses the
 * factory's fail-closed checks. Everything the factory can prove — legal
 * profile paths, unhandled template rows, secret-free generated files — keeps
 * working because the factory is imported, not reimplemented.
 *
 * ## Configuration is explicit; a missing value is a refusal
 *
 * The environment must carry the Cell's identity, the control-plane grant JWKS
 * (public keys only), the works-service and model-gateway origins, and the four
 * service credentials. There is **no default identity, no generated key and no
 * development fallback**: absent or malformed input aborts the boot before any
 * child process starts. A per-tenant Kubernetes Secret mounted read-only at
 * `/var/run/myrix/credentials` (`MYRIX_CREDENTIALS_DIR`) is an accepted
 * *additional* source for the same names; environment and file must agree.
 *
 * ## The child environment is an allowlist
 *
 * Only `OS_ENV_ALLOWLIST` names survive from the entry process, then the
 * factory's `cellEnv` adds the Cell's non-secret variables and its credentials.
 * Any *known* platform secret in the entry environment (`DATABASE_URL`,
 * `*_UPSTREAM_API_KEY`, signing keys, `NODE_OPTIONS` / `NODE_PATH`) is refused
 * outright rather than silently dropped, so a mis-wired deployment fails loudly
 * instead of starting a Cell next to the coordinator's secrets.
 *
 * ## Binding
 *
 * `MYRIX_CELL_HOST` defaults to `0.0.0.0` because a Cell must be reachable from
 * the pod network. Reachability is not authorization: every driver request is
 * still verified against a signed grant, sessions are tenant-scoped, and the
 * PoC-only probe/route-seam rows are refused here.
 *
 * ## Errors never echo configuration
 *
 * Startup failures print a fixed, redacted message. Token and JWKS values are
 * replaced with `[redacted]` before anything is written to stderr.
 *
 * @module myrix-deploy/cell-entry
 */
import { spawn as spawnChild } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as defaultFactory from '../../tests/poc/lib/cell-profile.mjs'
import { resolveDshInstall } from '../../tests/poc/lib/dsh-install.mjs'
import {
  CELL_ENV,
  FORBIDDEN_ENV_PATTERN,
  SECRET_ENV,
  assertEnvIsLegalBase,
  cellEnv,
  osEnvironment,
} from '../../tests/poc/lib/cell-profile.mjs'

/** Repository root inside the image (`/app/deploy/images/cell-entry.mjs`). */
export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * The sanctioned profile factory.
 *
 * Exported so a regression test can prove the normal path runs the *real*
 * `tests/poc/lib/cell-profile.mjs` rather than a look-alike assembled here.
 */
export const DEFAULT_FACTORY = defaultFactory

/** The only DSH build this image is allowed to run. */
export const LOCKED_DSH_VERSION = '0.2.0-rc.2'

/** Cell service credentials must be at least this long (matches the registry). */
export const TOKEN_MIN_LENGTH = 32

/** Where the per-tenant credential Secret is mounted (k8s contract). */
export const DEFAULT_CREDENTIALS_DIR = '/var/run/myrix/credentials'

/** Kubernetes and Helm DNS-label identifiers (`cellId`, `tenantId`). */
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * Names this entry reads that would otherwise trip {@link FORBIDDEN_ENV_PATTERN}
 * (`MYRIX_CREDENTIALS_DIR` contains "CREDENTIALS").
 *
 * They are our own, non-secret deployment inputs, never platform material.
 */
const OWN_CONFIG_NAMES = Object.freeze(['MYRIX_CREDENTIALS_DIR', 'MYRIX_REPO_ROOT', 'MYRIX_DSH_CLI'])

/** Names carried into the child beyond the OS allowlist and the factory's set. */
const EXTRA_CHILD_ENV = Object.freeze({ NO_COLOR: '1' })

/** A fixed, safe startup error. The message never contains a configuration value. */
export class CellEntryError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CellEntryError'
  }
}

/**
 * Replace every secret value with `[redacted]`.
 *
 * @param {unknown} value - the text to sanitize (coerced to string).
 * @param {readonly string[]} secrets - values that must never be printed.
 * @returns {string} the sanitized text.
 */
export function redact(value, secrets) {
  let text = typeof value === 'string' ? value : String(value)
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) text = text.split(secret).join('[redacted]')
  }
  return text
}

/**
 * Turn any thrown value into a printable, redacted message.
 *
 * @param {unknown} error - the failure.
 * @param {readonly string[]} secrets - values to redact.
 * @returns {string} a single safe line.
 */
export function sanitizeError(error, secrets) {
  const raw = error instanceof Error ? error.message : String(error)
  return redact(raw, secrets)
}

/** Require a non-empty string from an environment object. */
function required(env, name, hint) {
  const value = env[name]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CellEntryError(`myrix-cell-entry: missing ${name}${hint === undefined ? '' : ` (${hint})`}`)
  }
  return value
}

/** Require a DNS-label-safe identity. */
function identifier(env, name) {
  const value = required(env, name, 'tenant/cell identity is never generated')
  if (!ID_PATTERN.test(value)) {
    throw new CellEntryError(`myrix-cell-entry: ${name} is not a DNS label (lowercase letters, digits, dashes)`)
  }
  return value
}

/** Require an absolute path that is not the filesystem root. */
function absolutePath(env, name) {
  const value = required(env, name)
  if (!isAbsolute(value)) throw new CellEntryError(`myrix-cell-entry: ${name} must be an absolute path`)
  return resolve(value)
}

/** True when `candidate` is `root` or lives beneath it. */
function inside(root, candidate) {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * Reject a `DSH_HOME` the container cannot legally persist into.
 *
 * `/app` is read-only and must stay untouched; the filesystem root and `/tmp`
 * are not durable, so a Cell booted there would silently lose its JSONL history
 * on restart. The check is on the resolved string; the factory re-checks the
 * real filesystem objects (symlinks, session-store collisions) itself.
 *
 * @param {string} home - resolved candidate home.
 * @param {string} appRoot - the read-only application root.
 * @throws {CellEntryError} when the path is unsafe.
 */
export function assertDshHome(home, appRoot) {
  if (home === parse(home).root) {
    throw new CellEntryError('myrix-cell-entry: refusing the filesystem root as DSH_HOME')
  }
  if (inside(appRoot, home)) {
    throw new CellEntryError('myrix-cell-entry: DSH_HOME must not live under the read-only application root')
  }
  if (home === resolve('/tmp')) {
    throw new CellEntryError('myrix-cell-entry: DSH_HOME must be the persistent volume, not /tmp')
  }
}

/**
 * Prove the home directory exists and is writable without deleting anything.
 *
 * The probe file is created and removed; the directory itself (and every
 * session log inside it) is never touched.
 *
 * @param {string} home - the Cell home.
 * @returns {string} the created `tmp` directory inside the home.
 * @throws {CellEntryError} when the home is not writable.
 */
export function prepareDshHome(home) {
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 })
    const tmp = join(home, 'tmp')
    mkdirSync(tmp, { recursive: true, mode: 0o700 })
    const probe = join(home, `.write-probe-${String(process.pid)}`)
    writeFileSync(probe, '', { mode: 0o600 })
    rmSync(probe, { force: true })
    return tmp
  } catch {
    throw new CellEntryError('myrix-cell-entry: DSH_HOME is not writable; mount a persistent volume there')
  }
}

/**
 * Read one credential file from the mounted per-tenant Secret.
 *
 * @param {string} dir - the credentials directory.
 * @param {string} name - the variable (and file) name.
 * @returns {string | undefined} the trimmed first line, or undefined when absent.
 */
function readCredentialFile(dir, name) {
  const file = join(dir, name)
  if (!existsSync(file)) return undefined
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    throw new CellEntryError(`myrix-cell-entry: cannot read the credential file for ${name}`)
  }
  const value = text.split('\n', 1)[0]?.trim() ?? ''
  if (value.length === 0) throw new CellEntryError(`myrix-cell-entry: the credential file for ${name} is empty`)
  return value
}

/**
 * Resolve one secret from the environment and/or the mounted Secret.
 *
 * Both sources are accepted, but they must agree: two different values for the
 * same identity are a wiring error, not a preference order.
 *
 * @returns {string | undefined} the value, or undefined when neither source has it.
 */
function secretValue(env, credentialsDir, name) {
  const fromEnv = typeof env[name] === 'string' && env[name].length > 0 ? env[name] : undefined
  const fromFile = credentialsDir === undefined ? undefined : readCredentialFile(credentialsDir, name)
  if (fromEnv !== undefined && fromFile !== undefined && fromEnv !== fromFile) {
    throw new CellEntryError(`myrix-cell-entry: ${name} is set both in the environment and in the credential mount, with different values`)
  }
  return fromEnv ?? fromFile
}

/** Require a cell service credential of the registry's minimum length. */
function token(env, credentialsDir, name) {
  const value = secretValue(env, credentialsDir, name)
  if (value === undefined) throw new CellEntryError(`myrix-cell-entry: missing ${name} (no credential is ever generated)`)
  if (value.length < TOKEN_MIN_LENGTH) {
    throw new CellEntryError(`myrix-cell-entry: ${name} is shorter than ${String(TOKEN_MIN_LENGTH)} characters`)
  }
  return value
}

/**
 * Parse the grant JWKS.
 *
 * Only public keys are accepted. A JWK carrying private material (`d`, or RSA's
 * `p`/`q`/`dp`/`dq`/`qi`) is refused: the Cell verifies control-plane grants and
 * must never be able to mint them.
 *
 * @param {string} raw - the JSON document.
 * @returns {readonly object[]} the parsed keys.
 * @throws {CellEntryError} when the document is not a usable public JWKS.
 */
export function parseGrantJwks(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new CellEntryError('myrix-cell-entry: MYRIX_GRANT_JWKS is not valid JSON')
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new CellEntryError('myrix-cell-entry: MYRIX_GRANT_JWKS must be a non-empty array of public JWKs')
  }
  for (const key of parsed) {
    if (key === null || typeof key !== 'object' || Array.isArray(key)) {
      throw new CellEntryError('myrix-cell-entry: MYRIX_GRANT_JWKS entries must be JWK objects')
    }
    if (key.kty !== 'EC' && key.kty !== 'RSA' && key.kty !== 'OKP') {
      throw new CellEntryError('myrix-cell-entry: MYRIX_GRANT_JWKS entries must be EC, RSA or OKP public keys')
    }
    for (const privateField of ['d', 'p', 'q', 'dp', 'dq', 'qi']) {
      if (key[privateField] !== undefined) {
        throw new CellEntryError('myrix-cell-entry: refusing a private JWK; the Cell only ever receives public verification keys')
      }
    }
  }
  return parsed
}

/**
 * Validate an origin the Cell will call.
 *
 * Credentials, query strings and fragments are rejected so a token can never be
 * smuggled into a URL that ends up in a log. Plain HTTP requires loopback or
 * an exact origin present in `internalHttpOrigins` (ADR 0029 / ADR 0030).
 *
 * The allowlist is an exact-match set of canonical origins: a declared
 * `http://bff:8791` never admits `http://bff:8792`, a public host, an IP, or a
 * wildcard. The same list is forwarded to the plugins, which repeat the check.
 *
 * @param {string} value - the configured URL.
 * @param {string} name - the variable name (for the message).
 * @param {readonly string[]} internalHttpOrigins - already-validated declarations.
 * @returns {string} the configured URL (callers pass an already-canonical value).
 */
export function parseOrigin(value, name, internalHttpOrigins = []) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new CellEntryError(`myrix-cell-entry: ${name} is not a valid URL`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new CellEntryError(`myrix-cell-entry: ${name} must not embed credentials`)
  }
  if (url.search !== '' || url.hash !== '') {
    throw new CellEntryError(`myrix-cell-entry: ${name} must not carry a query string or fragment`)
  }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback || internalHttpOrigins.includes(url.origin)))) {
    throw new CellEntryError(`myrix-cell-entry: ${name} must be https outside loopback or an explicitly allowed Compose service origin`)
  }
  return value
}

/**
 * Parse `MYRIX_CELL_INTERNAL_HTTP_ORIGINS`: exact same-host Docker DNS origins
 * only; never a blanket insecure-HTTP flag.
 *
 * Validation mirrors `normalizeInternalHttpOrigin` in both plugins (ADR 0030):
 * a JSON array of at most 16 canonical `http://<single-label-service>:<port>`
 * origins. Credentials, paths (including a trailing `/`), query strings,
 * fragments, wildcards, IPs, multi-label names and other protocols are all
 * refused, and the raw value is never echoed in the error.
 *
 * @param {string | undefined} raw - the environment value.
 * @returns {readonly string[]} the distinct declared origins.
 * @throws {CellEntryError} when the value is not such an array.
 */
export function parseInternalHttpOrigins(raw) {
  if (raw === undefined) return []
  try {
    const origins = JSON.parse(raw)
    if (!Array.isArray(origins) || origins.length > 16) throw new Error()
    for (const origin of origins) {
      if (typeof origin !== 'string') throw new Error()
      const url = new URL(origin)
      if (url.protocol !== 'http:' || url.origin !== origin || url.username || url.password
        || !/^[a-z][a-z0-9-]{0,62}$/.test(url.hostname)) throw new Error()
    }
    return [...new Set(origins)]
  } catch {
    throw new CellEntryError('myrix-cell-entry: MYRIX_CELL_INTERNAL_HTTP_ORIGINS must be an explicit JSON array of canonical HTTP origins with single-label Docker service names')
  }
}

/** Require an integer within an inclusive range. */
function integer(env, name, { min, max }) {
  const raw = required(env, name)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new CellEntryError(`myrix-cell-entry: ${name} must be an integer between ${String(min)} and ${String(max)}`)
  }
  return value
}

/** Split a comma-separated list, rejecting empties and duplicates. */
function list(env, name, fallback) {
  const raw = env[name]
  if (raw === undefined || raw === '') return [...fallback]
  const items = raw.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
  if (items.length === 0) throw new CellEntryError(`myrix-cell-entry: ${name} is empty`)
  if (new Set(items).size !== items.length) throw new CellEntryError(`myrix-cell-entry: ${name} contains duplicates`)
  return items
}

/**
 * Refuse a runtime environment that carries platform-only material.
 *
 * @param {NodeJS.ProcessEnv} env - the entry process environment.
 * @throws {CellEntryError} naming the offending variable (a name is not a value).
 */
export function assertNoPlatformSecrets(env) {
  for (const name of Object.keys(env)) {
    if (OWN_CONFIG_NAMES.includes(name)) continue
    if (FORBIDDEN_ENV_PATTERN.test(name)) {
      throw new CellEntryError(
        `myrix-cell-entry: refusing to run with ${name} present; platform-only secrets never enter a Cell container`,
      )
    }
  }
}

/** The port the driver binds: `MYRIX_DRIVER_PORT` (k8s) or `MYRIX_CELL_PORT` (profile). */
function resolvePort(env) {
  const driverPort = env.MYRIX_DRIVER_PORT
  const cellPort = env.MYRIX_CELL_PORT
  if (driverPort !== undefined && cellPort !== undefined && driverPort !== '' && cellPort !== '' && driverPort !== cellPort) {
    throw new CellEntryError('myrix-cell-entry: MYRIX_DRIVER_PORT and MYRIX_CELL_PORT disagree')
  }
  const raw = driverPort !== undefined && driverPort !== '' ? driverPort : cellPort
  if (raw === undefined || raw === '') throw new CellEntryError('myrix-cell-entry: missing MYRIX_DRIVER_PORT (the driver port is never defaulted)')
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
    throw new CellEntryError('myrix-cell-entry: MYRIX_DRIVER_PORT must be an integer between 1 and 65535')
  }
  return value
}

/**
 * Parse and validate the whole deployment environment.
 *
 * Pure with respect to the process: it reads the supplied environment object and
 * the credential mount, creates nothing, and spawns nothing.
 *
 * @param {NodeJS.ProcessEnv} env - the entry process environment.
 * @returns {object} the validated configuration, including resolved secrets.
 * @throws {CellEntryError} on any missing or malformed value.
 */
export function resolveCellConfig(env) {
  assertNoPlatformSecrets(env)
  const appRoot = resolve(env.MYRIX_REPO_ROOT && env.MYRIX_REPO_ROOT !== '' ? env.MYRIX_REPO_ROOT : APP_ROOT)
  if (!existsSync(join(appRoot, 'bundles', 'myrix-base', 'cell.patch.yml'))) {
    throw new CellEntryError('myrix-cell-entry: MYRIX_REPO_ROOT does not contain bundles/myrix-base/cell.patch.yml')
  }
  const credentialsDir = env.MYRIX_CREDENTIALS_DIR === undefined || env.MYRIX_CREDENTIALS_DIR === ''
    ? (existsSync(DEFAULT_CREDENTIALS_DIR) ? DEFAULT_CREDENTIALS_DIR : undefined)
    : absolutePath(env, 'MYRIX_CREDENTIALS_DIR')

  const home = absolutePath(env, 'DSH_HOME')
  assertDshHome(home, appRoot)

  // The PoC-only seams are refused here, not merely left unset: a production
  // Cell must never mount the driver-only probe or the route waterfall.
  if (env.MYRIX_CELL_PROBE === '1') throw new CellEntryError('myrix-cell-entry: MYRIX_CELL_PROBE is a PoC-only seam and is refused')
  if (env.MYRIX_CELL_ROUTE_SEAM !== undefined && env.MYRIX_CELL_ROUTE_SEAM !== '' && env.MYRIX_CELL_ROUTE_SEAM !== 'none') {
    throw new CellEntryError('myrix-cell-entry: MYRIX_CELL_ROUTE_SEAM is a PoC-only seam and is refused')
  }
  if (env.MYRIX_REQUIRE_POLICY === '0') {
    throw new CellEntryError('myrix-cell-entry: MYRIX_REQUIRE_POLICY=0 disables the policy bridge and is refused')
  }

  const host = env.MYRIX_CELL_HOST === undefined || env.MYRIX_CELL_HOST === '' ? '0.0.0.0' : env.MYRIX_CELL_HOST

  const grantJwksRaw = secretValue(env, credentialsDir, SECRET_ENV.grantJwks)
  if (grantJwksRaw === undefined) throw new CellEntryError(`myrix-cell-entry: missing ${SECRET_ENV.grantJwks} (public verification keys only)`)

  const adminToken = secretValue(env, credentialsDir, 'MYRIX_ADMIN_TOKEN')
  const drainToken = secretValue(env, credentialsDir, SECRET_ENV.drainToken) ?? adminToken
  const revokeToken = secretValue(env, credentialsDir, SECRET_ENV.revokeToken) ?? adminToken
  if (drainToken === undefined && revokeToken === undefined) {
    throw new CellEntryError(`myrix-cell-entry: missing ${SECRET_ENV.drainToken} and ${SECRET_ENV.revokeToken} (or MYRIX_ADMIN_TOKEN)`)
  }

  const internalHttpOrigins = parseInternalHttpOrigins(env.MYRIX_CELL_INTERNAL_HTTP_ORIGINS)
  const config = {
    appRoot,
    home,
    credentialsDir,
    // The exact, entry-validated same-host declarations. They travel unchanged
    // to the plugins, which validate them again (ADR 0030).
    internalHttpOrigins,
    cellId: identifier(env, CELL_ENV.cellId),
    tenantId: identifier(env, CELL_ENV.tenantId),
    issuer: env[CELL_ENV.issuer] === undefined || env[CELL_ENV.issuer] === '' ? 'myrix-control-plane' : env[CELL_ENV.issuer],
    host,
    port: resolvePort(env),
    worksOrigin: parseOrigin(required(env, CELL_ENV.worksOrigin, 'the works service is where bindings and policy come from'), CELL_ENV.worksOrigin, internalHttpOrigins),
    gatewayURL: parseOrigin(required(env, CELL_ENV.gatewayURL, 'every model call is forwarded to the gateway'), CELL_ENV.gatewayURL, internalHttpOrigins),
    providers: list(env, CELL_ENV.providers, ['myrix-gateway']),
    models: list(env, CELL_ENV.models, []),
    contextWindow: integer(env, 'MYRIX_MODEL_CONTEXT_WINDOW', { min: 4096, max: Number.MAX_SAFE_INTEGER }),
    allowedTools: env[CELL_ENV.allowedTools] === undefined || env[CELL_ENV.allowedTools] === ''
      ? undefined
      : list(env, CELL_ENV.allowedTools, []),
    generation: env[CELL_ENV.generation] === undefined || env[CELL_ENV.generation] === ''
      ? undefined
      : integer(env, CELL_ENV.generation, { min: 0, max: Number.MAX_SAFE_INTEGER }),
    secrets: {},
  }
  if (config.models.length === 0) throw new CellEntryError('myrix-cell-entry: missing MYRIX_MODELS (the model catalog is never defaulted)')
  for (const model of config.models) {
    // A model id ends up in URLs and logs; keep it to an opaque token.
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)) {
      throw new CellEntryError('myrix-cell-entry: MYRIX_MODELS contains an invalid model id')
    }
  }
  if (host.trim().length === 0) throw new CellEntryError('myrix-cell-entry: MYRIX_CELL_HOST is empty')

  config.secrets = {
    grantJwks: parseGrantJwks(grantJwksRaw),
    worksToken: token(env, credentialsDir, SECRET_ENV.worksToken),
    gatewayToken: token(env, credentialsDir, SECRET_ENV.gatewayToken),
    drainToken: drainToken ?? token(env, credentialsDir, SECRET_ENV.drainToken),
    revokeToken: revokeToken ?? token(env, credentialsDir, SECRET_ENV.revokeToken),
  }
  if (typeof config.secrets.drainToken !== 'string' || config.secrets.drainToken.length < TOKEN_MIN_LENGTH) {
    throw new CellEntryError(`myrix-cell-entry: ${SECRET_ENV.drainToken} is shorter than ${String(TOKEN_MIN_LENGTH)} characters`)
  }
  if (typeof config.secrets.revokeToken !== 'string' || config.secrets.revokeToken.length < TOKEN_MIN_LENGTH) {
    throw new CellEntryError(`myrix-cell-entry: ${SECRET_ENV.revokeToken} is shorter than ${String(TOKEN_MIN_LENGTH)} characters`)
  }
  return config
}

/** Every secret value in a resolved configuration, for redaction. */
export function secretValues(config) {
  const { grantJwks, worksToken, gatewayToken, drainToken, revokeToken } = config.secrets
  return [JSON.stringify(grantJwks), worksToken, gatewayToken, drainToken, revokeToken].filter((v) => typeof v === 'string')
}

/**
 * The production allowlist of tools a Cell may expose.
 *
 * When `MYRIX_ALLOWED_TOOLS` is absent it is derived from the canonical
 * `NOVEL_TOOLS` export instead of being hard-coded. Node 24 strips the types of
 * the source module; if that source is not reachable in the image we fail closed
 * and require the operator to state the list rather than guess one.
 *
 * @param {string | undefined} explicit - `MYRIX_ALLOWED_TOOLS`, already parsed.
 * @param {string} repoRoot - the repository root.
 * @returns {Promise<readonly string[]>} the allowlist.
 */
export async function resolveAllowedTools(explicit, repoRoot) {
  if (explicit !== undefined) return explicit
  const source = join(repoRoot, 'plugins', 'myrix-novel', 'src', 'protocol.ts')
  if (!existsSync(source)) {
    throw new CellEntryError('myrix-cell-entry: set MYRIX_ALLOWED_TOOLS explicitly; the tool source is not in this image')
  }
  let loaded
  try {
    loaded = await import(pathToFileURL(source).href)
  } catch {
    throw new CellEntryError('myrix-cell-entry: set MYRIX_ALLOWED_TOOLS explicitly; this runtime cannot read the tool source')
  }
  if (!Array.isArray(loaded.NOVEL_TOOLS) || loaded.NOVEL_TOOLS.length === 0) {
    throw new CellEntryError('myrix-cell-entry: the tool source exposed no tool list; set MYRIX_ALLOWED_TOOLS explicitly')
  }
  return [...loaded.NOVEL_TOOLS]
}

/**
 * Translate the validated environment into `createCellProfile` options.
 *
 * Secrets are only ever passed as options (the factory puts them in the child
 * environment and refuses to persist them).
 *
 * @param {object} config - from {@link resolveCellConfig}.
 * @param {readonly string[]} allowedTools - from {@link resolveAllowedTools}.
 * @returns {object} the factory options.
 */
export function buildCellOptions(config, allowedTools) {
  return {
    repo: config.appRoot,
    home: config.home,
    profileName: 'myrix-cell',
    mode: 'production',
    cellId: config.cellId,
    tenantId: config.tenantId,
    issuer: config.issuer,
    grantPublicJwks: config.secrets.grantJwks,
    host: config.host,
    port: config.port,
    worksOrigin: config.worksOrigin,
    worksToken: config.secrets.worksToken,
    gatewayBaseURL: config.gatewayURL,
    gatewayToken: config.secrets.gatewayToken,
    internalHttpOrigins: config.internalHttpOrigins,
    providers: config.providers,
    models: config.models,
    contextWindow: config.contextWindow,
    drainToken: config.secrets.drainToken,
    revokeToken: config.secrets.revokeToken,
    allowedTools,
    // Deployment invariants, asserted here as well as refused above.
    requirePolicy: true,
    novel: true,
    routeSeam: 'none',
    probe: false,
    compile: true,
    fresh: false,
    ...config.generation === undefined ? {} : { generation: config.generation },
  }
}

/**
 * Assemble the child environment.
 *
 * The base is the OS allowlist, never `process.env`; the factory then adds the
 * Cell's own variables and credentials. `HOME` and the temp variables are
 * pointed inside the writable home so nothing reaches for `/app` or an
 * unwritable user home.
 *
 * @param {object} cell - the factory's Cell descriptor.
 * @param {NodeJS.ProcessEnv} env - the entry environment.
 * @returns {NodeJS.ProcessEnv} the child environment.
 */
export function childEnvironment(cell, env) {
  const tmp = join(cell.home, 'tmp')
  mkdirSync(tmp, { recursive: true, mode: 0o700 })
  const childEnv = {
    ...cellEnv(cell, osEnvironment(env)),
    ...EXTRA_CHILD_ENV,
    HOME: cell.home,
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
    // The k8s contract names the port MYRIX_DRIVER_PORT; the profile reads
    // MYRIX_CELL_PORT. Both are set to the same validated value.
    MYRIX_DRIVER_PORT: String(cell.port),
  }
  if (childEnv.PATH === undefined) childEnv.PATH = '/usr/local/bin:/usr/bin:/bin'
  assertEnvIsLegalBase(childEnv)
  return childEnv
}

/**
 * Boot one Cell: materialize the profile, then run the locked DSH CLI.
 *
 * Nothing is spawned until the profile exists and the install version matches.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   factory?: object,
 *   spawnImpl?: typeof spawnChild,
 *   handleSignals?: boolean,
 *   graceMs?: number,
 *   log?: (line: string) => void,
 * }} [options] - injection seams for tests; production uses the defaults.
 * @returns {Promise<object>} the running Cell handle.
 */
export async function runCellEntry(options = {}) {
  const env = options.env ?? process.env
  const factory = options.factory ?? defaultFactory
  const spawnImpl = options.spawnImpl ?? spawnChild
  const graceMs = options.graceMs ?? 20_000
  const log = options.log ?? ((line) => process.stdout.write(`${line}\n`))

  const config = resolveCellConfig(env)
  const secrets = secretValues(config)
  let cell
  try {
    const allowedTools = await resolveAllowedTools(config.allowedTools, config.appRoot)
    prepareDshHome(config.home)
    const install = resolveDshInstall({ repo: config.appRoot, explicit: env.MYRIX_DSH_CLI })
    if (install.version !== LOCKED_DSH_VERSION) {
      throw new CellEntryError(`myrix-cell-entry: the DSH install is ${install.version}, not the locked ${LOCKED_DSH_VERSION}`)
    }
    cell = factory.createCellProfile({ ...buildCellOptions(config, allowedTools), dshInstall: install })
    if (cell.install.version !== LOCKED_DSH_VERSION) {
      throw new CellEntryError(`myrix-cell-entry: the Cell was built against DSH ${cell.install.version}, not ${LOCKED_DSH_VERSION}`)
    }
    // The factory links `@myrix/*` packages; the base bundle is linked here so
    // the profile never depends on a hand-placed symlink.
    cell.linkBundle()
  } catch (error) {
    // Secrets and the home path are scrubbed: a failure names the *class* of
    // problem, never a configuration value.
    throw new CellEntryError(`myrix-cell-entry: refusing to start: ${sanitizeError(error, [...secrets, config.home])}`)
  }

  const childEnv = childEnvironment(cell, env)
  const args = [cell.install.cli, '--profile', cell.profileName]
  const child = spawnImpl(process.execPath, args, {
    cwd: cell.home,
    env: childEnv,
    stdio: ['ignore', 'inherit', 'inherit'],
  })

  const exited = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
    child.once('error', () => resolveExit({ code: 1, signal: null }))
  })
  log(`myrix-cell: ${config.cellId} readying on ${config.host}:${String(config.port)}`)

  let stopping
  /** Ask the child to stop, escalating to SIGKILL after the grace period. */
  const stop = () => {
    if (stopping !== undefined) return stopping
    stopping = (async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, graceMs)
      timer.unref()
      const result = await exited
      clearTimeout(timer)
      return result
    })()
    return stopping
  }

  const handle = {
    config,
    cell,
    child,
    childEnv,
    args,
    exited,
    stop,
    /** Resolve once the process is gone; 0 on a clean exit or our own stop. */
    async done() {
      const result = await exited
      if (typeof result.code === 'number') return result.code
      // A signal we sent ourselves (SIGTERM/SIGINT propagation) is a graceful
      // shutdown, not a crash; an unexpected signal is a failure.
      return stopping !== undefined ? 0 : 1
    },
  }

  if (options.handleSignals === true) {
    // The handler only asks the child to stop. The exit code belongs to the
    // caller (`main`), so importing this module never changes a host's status.
    const onSignal = () => { void stop() }
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, onSignal)
    handle.removeSignalHandlers = () => {
      for (const signal of ['SIGTERM', 'SIGINT']) process.off(signal, onSignal)
    }
  }
  return handle
}

/** Entry point used by the container `CMD`. */
async function main() {
  let handle
  let secrets = []
  let stopping = false
  // Registered before the profile is assembled: a SIGTERM during compilation
  // must not orphan a child that is about to be spawned.
  const stop = () => {
    stopping = true
    if (handle !== undefined) void handle.stop()
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  try {
    const config = resolveCellConfig(process.env)
    secrets = secretValues(config)
    handle = await runCellEntry({ env: process.env, handleSignals: false })
    if (stopping) await handle.stop()
    process.exitCode = await handle.done()
  } catch (error) {
    // Fixed, redacted output: a name may appear, a value never does.
    const fallback = Object.values(process.env).filter((value) => typeof value === 'string' && value.length >= 32)
    process.stderr.write(`${sanitizeError(error, secrets.length > 0 ? secrets : fallback)}\n`)
    process.exitCode = 1
  } finally {
    process.off('SIGTERM', stop)
    process.off('SIGINT', stop)
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
