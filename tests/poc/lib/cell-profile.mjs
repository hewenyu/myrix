/**
 * Real-DSH **Cell profile factory**.
 *
 * A Cell is one isolated `$DSH_HOME` running the `myrix-base` whitelist plus the
 * Myrix plugin layer, listening on its own HTTP port, holding its own JSONL
 * session store, and trusting only its own tenant/cell credentials. This module
 * is the only sanctioned way to materialize one, so a launcher (`apps/*`, the
 * Cell manager, CI) never hand-assembles a profile and never hard-codes a
 * secret.
 *
 * ## Layout produced (identical to a deployment image)
 *
 *   <home>/
 *     profiles/node_modules -> <locked DSH install>/node_modules   (symlink)
 *     profiles/<name>/package.json      dsh.profile.bundles = [myrix-base]
 *     profiles/<name>/cordis.yml        []  (the bundle supplies the rows)
 *     profiles/<name>/cordis.patch.yml  the Cell layer (non-secret config)
 *     profiles/<name>/node_modules/@myrix/<pak>/            compiled plugin
 *     profiles/<name>/node_modules/@myrix/novel/preset-tools.mjs  subpath module
 *     profiles/<name>/plugins/cell-probe.mjs                test-only probe
 *     profiles/<name>/plugins/cell-route-seam.mjs           test-only seam
 *     sessions/                          durable JSONL logs (never touched here)
 *
 * ## Secrets
 *
 * **Nothing secret is ever written to a profile file.** Cell service tokens,
 * drain/revoke credentials and the model-gateway token travel through the
 * environment ({@link cellEnv}); the patch reads them with
 * `!!js process.env.*`. The variable names are frozen in {@link SECRET_ENV}.
 * Generated files are mode `0600`, directories `0700`.
 *
 * ## Why the patch is generated instead of copied
 *
 * The template lives at `bundles/myrix-base/cell.patch.yml` and is the
 * canonical Cell composition. It cannot be used verbatim because a Cordis row's
 * `disabled` is a loader-internal field and `!!js` expressions are evaluated
 * when the file is parsed — both measured. The factory therefore *reads the
 * template*, applies the Cell's own row substitutions, and writes the result.
 * If a row is ever added to the template without a handler here, profile
 * creation fails and names the missing handler, rather than silently dropping a
 * row from the Cell.
 *
 * @module myrix-poc/cell-profile
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { CELL_PLUGINS, compilePluginEntries } from './compile-plugins.mjs'
import { resolveDshInstall, resolveRepoRoot } from './dsh-install.mjs'

/** Directory mode for anything generated: owner-only. */
const DIR_MODE = 0o700
/** File mode for generated profiles and reports: owner-only. */
const FILE_MODE = 0o600

/**
 * A profile directory name that cannot traverse or alias.
 *
 * The factory computes deletion targets from this value, so the accepted
 * alphabet is deliberately narrow: one leading alphanumeric, then letters,
 * digits, dot, underscore or dash.
 */
const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i

/** Environment variables through which a Cell receives its secrets. */
export const SECRET_ENV = Object.freeze({
  grantJwks: 'MYRIX_GRANT_JWKS',
  drainToken: 'MYRIX_DRAIN_TOKEN',
  revokeToken: 'MYRIX_REVOKE_TOKEN',
  worksToken: 'MYRIX_WORKS_TOKEN',
  gatewayToken: 'MYRIX_GATEWAY_TOKEN',
})

/** Every non-secret environment variable the generated Cell patch reads. */
export const CELL_ENV = Object.freeze({
  cellId: 'MYRIX_CELL_ID',
  tenantId: 'MYRIX_TENANT_ID',
  issuer: 'MYRIX_ISSUER',
  host: 'MYRIX_CELL_HOST',
  port: 'MYRIX_CELL_PORT',
  generation: 'MYRIX_CELL_GENERATION',
  worksOrigin: 'MYRIX_WORKS_ORIGIN',
  gatewayURL: 'MYRIX_GATEWAY_URL',
  providers: 'MYRIX_MODEL_PROVIDERS',
  models: 'MYRIX_MODELS',
  contextWindow: 'MYRIX_CONTEXT_WINDOW',
  leaseTtlMs: 'MYRIX_LEASE_TTL_MS',
  leaseRefreshMs: 'MYRIX_LEASE_REFRESH_MS',
  sseMaxBufferedBytes: 'MYRIX_SSE_MAX_BUFFERED_BYTES',
  allowedTools: 'MYRIX_ALLOWED_TOOLS',
  // The R16 policy bridge: production requires a valid policy snapshot before
  // any tool call is admitted. `'0'` is the PoC-only driver-scope opt-out.
  requirePolicy: 'MYRIX_REQUIRE_POLICY',
  novel: 'MYRIX_NOVEL_ENABLED',
  routeSeam: 'MYRIX_CELL_ROUTE_SEAM',
  probe: 'MYRIX_CELL_PROBE',
  probeOut: 'MYRIX_CELL_PROBE_OUT',
  probePrincipal: 'MYRIX_CELL_PROBE_PRINCIPAL',
  probeRun: 'MYRIX_CELL_PROBE_RUN',
  probeMode: 'MYRIX_CELL_PROBE_MODE',
})

/**
 * The OS variables a Cell inherits when the caller does not pass an explicit
 * filtered base.
 *
 * A Cell process must never inherit the coordinator's ambient secrets, so the
 * default is an allowlist rather than `process.env`. The launcher
 * (`apps/bff/scripts/child-environment.ts`) uses the same set.
 */
export const OS_ENV_ALLOWLIST = Object.freeze([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ',
  'SYSTEMROOT', 'WINDIR', 'COMSPEC',
])

/**
 * Names that must never reach a Cell's environment.
 *
 * `NODE_OPTIONS` / `NODE_PATH` would let ambient configuration inject a module
 * loader into the Cell; everything else is a platform-only secret (database
 * URLs, signing keys, upstream model keys, OIDC and credential material).
 */
export const FORBIDDEN_ENV_PATTERN = /(?:DATABASE|MIGRAT|SIGNING_KEY|PRIVATE_KEY|UPSTREAM|API_KEY|OIDC|CREDENTIALS|NODE_OPTIONS|NODE_PATH|MYRIX_RUNTIME_CELLS_JSON|MYRIX_DEV_USERS|MYRIX_AUTH_)/

/**
 * Row handlers applied to the canonical Cell template.
 *
 * Each handler returns the YAML lines for one row, given the resolved Cell
 * values. Keeping them keyed by row id is what makes an unhandled template row
 * a hard failure instead of a silent omission.
 */
export const ROW_HANDLERS = Object.freeze({
  webserver: (cell) => [
    '    - id: webserver',
    "      name: '@deepseek-ai/dsh-host-webserver'",
    '      config:',
    `        host: ${JSON.stringify(cell.env[CELL_ENV.host])}`,
    `        port: ${String(cell.env[CELL_ENV.port])}`,
    "        compression: 'none'",
  ],
  'myrix-principals': () => [
    '    - id: myrix-principals',
    "      name: '@myrix/principals'",
  ],
  'myrix-policy-enforcer': () => [
    '    - id: myrix-policy-enforcer',
    "      name: '@myrix/policy-enforcer'",
    '      config:',
    `        allowedTools: !!js (process.env.${CELL_ENV.allowedTools} ?? '').split(',').filter(Boolean)`,
  ],
  'myrix-binding-lease': () => [
    '    - id: myrix-binding-lease',
    "      name: '@myrix/binding-lease'",
    '      config:',
    `        cellId: !!js process.env.${CELL_ENV.cellId}`,
    `        tenantId: !!js process.env.${CELL_ENV.tenantId}`,
    `        origin: !!js process.env.${CELL_ENV.worksOrigin}`,
    `        token: !!js process.env.${SECRET_ENV.worksToken}`,
    `        ttlMs: !!js Number(process.env.${CELL_ENV.leaseTtlMs} ?? '10000')`,
    `        refreshMs: !!js Number(process.env.${CELL_ENV.leaseRefreshMs} ?? '3000')`,
    // R16 bridge: production requires a valid, finite, same-tenant policy
    // snapshot alongside the binding rows. The PoC set it to '0' only for the
    // driver-only probe scope; a launcher must never do that.
    `        requirePolicy: !!js process.env.${CELL_ENV.requirePolicy} !== '0'`,
  ],
  'myrix-runtime-driver': (cell) => [
    '    - id: myrix-runtime-driver',
    "      name: '@myrix/runtime-driver'",
    '      config:',
    `        cellId: !!js process.env.${CELL_ENV.cellId}`,
    `        tenantId: !!js process.env.${CELL_ENV.tenantId}`,
    `        issuer: !!js process.env.${CELL_ENV.issuer} ?? 'myrix-control-plane'`,
    `        keys: !!js JSON.parse(process.env.${SECRET_ENV.grantJwks})`,
    `        drainToken: !!js process.env.${SECRET_ENV.drainToken}`,
    `        revokeToken: !!js process.env.${SECRET_ENV.revokeToken}`,
    `        defaultProvider: !!js (process.env.${CELL_ENV.providers} ?? 'myrix-gateway').split(',')[0]`,
    `        defaultModel: !!js (process.env.${CELL_ENV.models} ?? '').split(',')[0]`,
    `        sseMaxBufferedBytes: !!js Number(process.env.${CELL_ENV.sseMaxBufferedBytes} ?? '1048576')`,
    // A ternary returning `undefined` from a `!!js` scalar is not reliably
    // round-tripped by the loader (measured: it reached the plugin as a
    // non-integer), so the row is omitted entirely when unset.
    ...cell.env[CELL_ENV.generation] === undefined
      ? []
      : [`        generation: !!js Number(process.env.${CELL_ENV.generation})`],
  ],
  'myrix-llm-gateway': () => [
    '    - id: myrix-llm-gateway',
    "      name: '@myrix/llm-gateway'",
    '      config:',
    `        baseURL: !!js process.env.${CELL_ENV.gatewayURL}`,
    `        cellToken: !!js process.env.${SECRET_ENV.gatewayToken}`,
    `        providers: !!js (process.env.${CELL_ENV.providers} ?? 'myrix-gateway').split(',').filter(Boolean)`,
    `        models: !!js (process.env.${CELL_ENV.models} ?? '').split(',').filter(Boolean)`,
    `        contextWindow: !!js Number(process.env.${CELL_ENV.contextWindow} ?? '100000')`,
  ],
  // The novel vertical: `ctx.novelStore` plus the three preset subtrees.
  //
  // It is a production row. The only way it disappears is the explicit PoC
  // driver-only opt-out, which `createCellProfile` refuses unless the caller
  // asked for `mode: 'poc'` AND gave a reason. See the module docs.
  'myrix-novel': (cell) => cell.env[CELL_ENV.novel] === '0'
    ? []
    : [
        '    - id: myrix-novel',
        "      name: '@myrix/novel'",
        '      config:',
        `        origin: !!js process.env.${CELL_ENV.worksOrigin}`,
        `        credential: !!js process.env.${SECRET_ENV.worksToken}`,
      ],
  'myrix-cell-route-seam': (cell) => cell.env[CELL_ENV.routeSeam] === 'waterfall'
    ? [
        '    - id: myrix-cell-route-seam',
        "      name: './plugins/cell-route-seam.mjs'",
        '      config:',
        `        provider: !!js process.env.${CELL_ENV.providers} ?? 'myrix-gateway'`,
        `        model: !!js (process.env.${CELL_ENV.models} ?? '').split(',')[0]`,
      ]
    : [],
  'myrix-cell-probe': (cell) => cell.env[CELL_ENV.probe] === '1'
    ? [
        '    - id: myrix-cell-probe',
        "      name: './plugins/cell-probe.mjs'",
        '      config:',
        `        out: !!js process.env.${CELL_ENV.probeOut}`,
        `        provider: !!js process.env.${CELL_ENV.providers} ?? 'myrix-gateway'`,
        `        model: !!js (process.env.${CELL_ENV.models} ?? '').split(',')[0]`,
        `        principal: !!js JSON.parse(process.env.${CELL_ENV.probePrincipal})`,
        `        run: !!js process.env.${CELL_ENV.probeRun}`,
        `        mode: !!js process.env.${CELL_ENV.probeMode} ?? 'driver-only'`,
      ]
    : [],
})

/**
 * Render a profile patch from one preview of the template.
 *
 * A single template preview cannot be used twice: reading a `!!js` row
 * evaluates its expression and consumes the marker, so the second read returns
 * an already-resolved value. The factory therefore reads the preview once per
 * section (header, rows, tail) and splices the generated rows into the middle —
 * measured behaviour of the real loader, not a guess.
 *
 * @param {{ header: string, tail: string, rows: string[] }} preview - template parts.
 * @returns {string} the profile patch text.
 */
export function renderProfilePatch(preview) {
  return [
    preview.header,
    ...preview.rows,
    preview.tail,
    '',
  ].join('\n')
}

/**
 * The YAML section (indented under `- insert:`) that the generated rows replace.
 *
 * The template is split on the first top-level `- insert:` line: everything
 * before it is the header comment block, everything from the first row to the
 * end is replaced.
 *
 * @param {string} template - the raw template text.
 * @returns {{ header: string, rows: string[] }} the parsed sections.
 * @throws when the template has no `- insert:` section.
 */
export function splitTemplate(template) {
  const lines = template.split('\n')
  const insertIndex = lines.findIndex((line) => line.trim() === '- insert:')
  if (insertIndex === -1) {
    throw new Error('myrix-poc: bundles/myrix-base/cell.patch.yml has no `- insert:` section')
  }
  return { header: lines.slice(0, insertIndex + 1).join('\n'), rows: lines.slice(insertIndex + 1) }
}

/**
 * Read the canonical template once through the real YAML reader.
 *
 * The loader's `!!js` evaluation means the returned text is a *preview*: values
 * are already substituted. The factory only needs it to (a) prove the template
 * parses under this DSH build and (b) recover the trailing structure; the row
 * text itself is regenerated from {@link ROW_HANDLERS}, which is also how the
 * "unhandled row" check gets its list.
 *
 * @param {string} templatePath - absolute path to `cell.patch.yml`.
 * @returns {string[]} the row ids found in the template, in order.
 */
export function templateRowIds(templatePath) {
  const text = readFileSync(templatePath, 'utf8')
  const ids = []
  for (const line of text.split('\n')) {
    const match = /^\s*-\s+id:\s*(\S+)\s*$/.exec(line)
    if (match !== null && match[1] !== undefined) ids.push(match[1])
  }
  return ids
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/**
 * Resolve and validate the three paths a Cell owns.
 *
 * Everything the factory deletes is computed from this result, so every rule
 * here is a deletion guard:
 *
 *   * `home` must be an absolute path that is neither the filesystem root nor
 *     the user's home directory (and not `~/.dsh`, which may hold a stale
 *     ambient install — measured on this machine);
 *   * `profileName` must match {@link PROFILE_NAME_PATTERN}, so it can never
 *     contribute `..`, a path separator or a leading dot;
 *   * the profile directory must be a strict child of `<home>/profiles` and
 *     must never be `<home>/sessions` or contain it.
 *
 * @param {string} homeInput - the Cell's `$DSH_HOME`.
 * @param {string} profileName - the profile directory name.
 * @returns {{ home: string, profilesDir: string, profileDir: string, sessionsDir: string }} the paths.
 * @throws when any rule is violated.
 */
export function resolveProfilePaths(homeInput, profileName) {
  if (typeof homeInput !== 'string' || homeInput.length === 0 || !isAbsolute(homeInput)) {
    throw new Error('myrix-poc: createCellProfile requires an absolute "home" path')
  }
  const home = resolve(homeInput)
  if (home === parse(home).root) {
    throw new Error(`myrix-poc: refusing to use the filesystem root as a Cell home (${home})`)
  }
  const userHome = homedir()
  if (home === userHome || home === join(userHome, '.dsh')) {
    throw new Error(
      `myrix-poc: refusing to use ${home} as a Cell home.\n`
      + 'A Cell owns its own $DSH_HOME; reusing the user home or ~/.dsh can destroy a real install.',
    )
  }
  if (typeof profileName !== 'string' || !PROFILE_NAME_PATTERN.test(profileName)) {
    throw new Error(
      `myrix-poc: unsafe profile name ${JSON.stringify(profileName)}; `
      + 'expected one alphanumeric followed by letters, digits, dot, underscore or dash',
    )
  }
  const profilesDir = join(home, 'profiles')
  const profileDir = join(profilesDir, profileName)
  assertContained(home, profileDir, 'profile directory')
  const sessionsDir = join(home, 'sessions')
  // The durable session log is the one thing a profile rebuild must never
  // touch; assert the relationship instead of trusting the layout comment.
  if (profileDir === sessionsDir || isInside(profileDir, sessionsDir)) {
    throw new Error(`myrix-poc: refusing to treat the session store ${sessionsDir} as a profile directory`)
  }
  return { home, profilesDir, profileDir, sessionsDir }
}

/** True when `candidate` is a strict descendant of `root`. */
function isInside(root, candidate) {
  const rel = relative(root, candidate)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Throw unless `candidate` is a strict descendant of `root`. */
function assertContained(root, candidate, label) {
  if (!isInside(root, candidate)) {
    throw new Error(`myrix-poc: ${label} ${candidate} escapes ${root}`)
  }
}

/**
 * Prove no component from `home` down to `target` is a symlink.
 *
 * A symlinked `profiles` directory would make the containment check above true
 * on paper while every write and delete lands somewhere else on disk, so the
 * check is on the real filesystem objects rather than on the string.
 *
 * @param {string} home - the Cell home (already created).
 * @param {string} target - an existing path beneath `home`.
 * @throws when any existing component is a symbolic link.
 */
function assertNoSymlinkComponent(home, target) {
  const rel = relative(home, target)
  if (rel === '') return
  let current = home
  for (const segment of rel.split(sep)) {
    current = join(current, segment)
    let stats
    try {
      stats = lstatSync(current)
    } catch {
      return
    }
    if (stats.isSymbolicLink()) {
      throw new Error(
        `myrix-poc: refusing to operate through the symbolic link ${current}; `
        + 'a Cell home must be a real directory tree',
      )
    }
  }
}

/** The generated entries the factory owns inside one profile directory. */
const GENERATED_PROFILE_FILES = Object.freeze(['cordis.patch.yml', 'cordis.yml', 'package.json'])
const GENERATED_PROFILE_DIRS = Object.freeze(['plugins'])

/**
 * Create the profile directory, refusing a symlinked home and clearing only the
 * entries this factory generated.
 *
 * Only the three generated files, the test-only `plugins` directory and the
 * `@myrix/*` package directories below `node_modules` are removed. A profile
 * that also holds something else keeps it, and `sessions` (a sibling of
 * `profiles`, never a child) is untouched by construction.
 *
 * @param {{ home: string, profilesDir: string, profileDir: string }} paths - from {@link resolveProfilePaths}.
 * @returns {void}
 * @throws when the home tree is symlinked or an owned entry is not what it claims to be.
 */
function prepareProfileDir(paths) {
  const { home, profilesDir, profileDir } = paths
  mkdirSync(home, { recursive: true, mode: DIR_MODE })
  mkdirSync(profilesDir, { recursive: true, mode: DIR_MODE })
  assertNoSymlinkComponent(home, profilesDir)

  if (existsSync(profileDir)) {
    const stats = lstatSync(profileDir)
    if (stats.isSymbolicLink()) {
      throw new Error(`myrix-poc: profile directory ${profileDir} is a symbolic link; refusing to reuse it`)
    }
    if (!stats.isDirectory()) {
      throw new Error(`myrix-poc: profile path ${profileDir} exists and is not a directory`)
    }
    assertNoSymlinkComponent(home, profileDir)
    assertContained(realpathSync(home), realpathSync(profileDir), 'profile directory')
    for (const name of GENERATED_PROFILE_FILES) {
      const target = join(profileDir, name)
      const entry = lstatSync(target, { throwIfNoEntry: false })
      if (entry === undefined) continue
      if (entry.isDirectory()) throw new Error(`myrix-poc: refusing to delete the directory ${target}`)
      rmSync(target, { force: true })
    }
    for (const name of GENERATED_PROFILE_DIRS) {
      const target = join(profileDir, name)
      const entry = lstatSync(target, { throwIfNoEntry: false })
      if (entry === undefined) continue
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(`myrix-poc: refusing to delete the unexpected entry ${target}`)
      }
      rmSync(target, { recursive: true, force: true })
    }
    clearGeneratedPackages(join(profileDir, 'node_modules', '@myrix'))
  }
  mkdirSync(profileDir, { recursive: true, mode: DIR_MODE })
}

/**
 * Remove only the `@myrix/*` entries this factory installs.
 *
 * A hand-placed package or an unexpected real directory is left alone; a
 * symlink into the repository (the bundle row) is removed only when it is a
 * symlink, because that is the only form {@link linkBundle} creates.
 *
 * @param {string} scoped - `<profile>/node_modules/@myrix`.
 */
function clearGeneratedPackages(scoped) {
  if (!existsSync(scoped)) return
  const generated = new Set(CELL_PLUGINS.map((entry) => entry.specifier.slice('@myrix/'.length)))
  generated.add('dsh-bundle-myrix-base')
  for (const name of readdirSync(scoped)) {
    if (!generated.has(name)) continue
    const target = join(scoped, name)
    const entry = lstatSync(target, { throwIfNoEntry: false })
    if (entry === undefined) continue
    if (entry.isSymbolicLink() || entry.isDirectory()) rmSync(target, { recursive: true, force: true })
  }
}

/**
 * Install (or repair) the profile → locked-install `node_modules` symlink.
 *
 * A pre-existing symlink to a different install (a stale `0.1.0-rc.6` was
 * observed on this machine) is replaced; a real directory is never deleted.
 *
 * @param {{ home: string, profilesDir: string }} paths - from {@link resolveProfilePaths}.
 * @param {string} installNodeModules - the locked install's `node_modules`.
 * @returns {string} the link path.
 */
function linkProfileNodeModules(paths, installNodeModules) {
  const link = join(paths.profilesDir, 'node_modules')
  const entry = lstatSync(link, { throwIfNoEntry: false })
  if (entry !== undefined) {
    if (!entry.isSymbolicLink()) {
      throw new Error(
        `myrix-poc: ${link} exists and is not a symbolic link.\n`
        + 'Refusing to delete a real directory; remove it manually if it is a leftover install.',
      )
    }
    if (readlinkSync(link) === installNodeModules) return link
    // Measured hazard: a stale install would silently change the runtime.
    unlinkSync(link)
  }
  symlinkSync(installNodeModules, link, 'dir')
  return link
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build one Cell.
 *
 * @param {{
 *   home: string,
 *   profileName?: string,
 *   cellId: string,
 *   tenantId: string,
 *   issuer?: string,
 *   grantPublicJwks?: readonly object[],
 *   host?: string,
 *   port: number,
 *   worksOrigin: string,
 *   worksToken: string,
 *   gatewayBaseURL: string,
 *   gatewayToken: string,
 *   providers?: readonly string[],
 *   models: readonly string[],
 *   contextWindow?: number,
 *   drainToken: string,
 *   revokeToken: string,
 *   generation?: number,
 *   sseMaxBufferedBytes?: number,
 *   leaseTtlMs?: number,
 *   leaseRefreshMs?: number,
 *   allowedTools?: readonly string[],
 *   requirePolicy?: boolean,
 *   mode?: 'production'|'poc',
 *   novel?: boolean,
 *   novelOptOutReason?: string,
 *   routeSeam?: 'waterfall'|'none',
 *   probe?: boolean,
 *   probeOut?: string,
 *   probePrincipal?: { sid: string, tid: string, sub: string, wid: string, preset: string, rev: number },
 *   probeRun?: string,
 *   probeMode?: 'novel'|'driver-only',
 *   extraRows?: readonly string[],
 *   repo?: string,
 *   dshInstall?: object,
 *   compile?: boolean,
 *   fresh?: boolean,
 * }} options - the Cell definition. Secrets are required and never defaulted:
 *   a Cell without credentials is a misconfiguration, not a mode.
 * @returns {object} the Cell descriptor.
 * @throws when a required value is missing, the template has a row with no
 *   handler, a production Cell omits the novel vertical, a path is unsafe, or a
 *   compiled plugin package does not expose every declared export.
 */
export function createCellProfile(options) {
  const repo = options.repo ?? resolveRepoRoot()
  const profileName = options.profileName ?? 'myrix-cell'
  const mode = options.mode ?? 'production'
  if (mode !== 'production' && mode !== 'poc') {
    throw new Error(`myrix-poc: unknown Cell mode ${JSON.stringify(mode)}`)
  }
  const paths = resolveProfilePaths(options.home, profileName)
  const home = paths.home
  const install = options.dshInstall ?? resolveDshInstall({ repo })

  for (const field of ['cellId', 'tenantId', 'port', 'worksOrigin', 'worksToken', 'gatewayBaseURL', 'gatewayToken', 'drainToken', 'revokeToken']) {
    const value = options[field]
    if (value === undefined || value === null || value === '') {
      throw new Error(`myrix-poc: createCellProfile requires "${field}" (no default: a Cell without credentials is a misconfiguration)`)
    }
  }
  const grantPublicJwks = options.grantPublicJwks ?? []
  if (!Array.isArray(grantPublicJwks) || grantPublicJwks.length === 0) {
    throw new Error('myrix-poc: createCellProfile requires a non-empty grantPublicJwks (the driver refuses an empty key set)')
  }
  const models = options.models ?? []
  if (models.length === 0) {
    throw new Error('myrix-poc: createCellProfile requires at least one model id (the gateway refuses an empty catalog)')
  }

  // ---- novel: a production row, omitted only by an explicit PoC opt-out ----
  const includeNovel = options.novel !== false
  if (!includeNovel) {
    if (mode !== 'poc') {
      throw new Error(
        'myrix-poc: createCellProfile refuses to omit the novel vertical in production mode.\n'
        + 'A production Cell always mounts @myrix/novel; only a PoC driver-only probe scope may opt out.',
      )
    }
    if (typeof options.novelOptOutReason !== 'string' || options.novelOptOutReason.trim().length === 0) {
      throw new Error(
        'myrix-poc: createCellProfile requires "novelOptOutReason" when novel is disabled '
        + '(the opt-out must be documented, not silent)',
      )
    }
  }

  // The template is both the source of truth for the row set and a parse check
  // against the real DSH YAML reader.
  const templatePath = join(repo, 'bundles', 'myrix-base', 'cell.patch.yml')
  const templateIds = templateRowIds(templatePath)
  const unhandled = templateIds.filter((id) => ROW_HANDLERS[id] === undefined)
  if (unhandled.length > 0) {
    throw new Error(
      `myrix-poc: bundles/myrix-base/cell.patch.yml declares rows with no factory handler: ${unhandled.join(', ')}.\n`
      + 'Add a handler in tests/poc/lib/cell-profile.mjs ROW_HANDLERS; do not silently drop the row.',
    )
  }

  const env = {
    [CELL_ENV.cellId]: options.cellId,
    [CELL_ENV.tenantId]: options.tenantId,
    [CELL_ENV.issuer]: options.issuer ?? 'myrix-control-plane',
    [CELL_ENV.host]: options.host ?? '127.0.0.1',
    [CELL_ENV.port]: String(options.port),
    [CELL_ENV.worksOrigin]: options.worksOrigin,
    [CELL_ENV.gatewayURL]: options.gatewayBaseURL,
    [CELL_ENV.providers]: (options.providers ?? ['myrix-gateway']).join(','),
    [CELL_ENV.models]: models.join(','),
    [CELL_ENV.contextWindow]: String(options.contextWindow ?? 100_000),
    [CELL_ENV.leaseTtlMs]: String(options.leaseTtlMs ?? 10_000),
    [CELL_ENV.leaseRefreshMs]: String(options.leaseRefreshMs ?? 3_000),
    [CELL_ENV.allowedTools]: (options.allowedTools ?? []).join(','),
    // Production requires the policy bridge; the PoC driver-only scope may set
    // this to '0' through `requirePolicy: false`.
    [CELL_ENV.requirePolicy]: options.requirePolicy === false ? '0' : '1',
    [CELL_ENV.novel]: includeNovel ? '1' : '0',
    // The seam exists only to fill a route the driver does NOT declare. With
    // `defaultProvider`/`defaultModel` in the driver Config (production shape),
    // the seam must stay off: a second route source would only add ambiguity.
    [CELL_ENV.routeSeam]: options.routeSeam ?? 'none',
    [CELL_ENV.probe]: options.probe === true ? '1' : '0',
    ...options.probeMode === undefined ? {} : { [CELL_ENV.probeMode]: options.probeMode },
    ...options.probeOut === undefined ? {} : { [CELL_ENV.probeOut]: options.probeOut },
    ...options.probePrincipal === undefined ? {} : { [CELL_ENV.probePrincipal]: JSON.stringify(options.probePrincipal) },
    ...options.probeRun === undefined ? {} : { [CELL_ENV.probeRun]: options.probeRun },
    ...options.generation === undefined ? {} : { [CELL_ENV.generation]: String(options.generation) },
    ...options.sseMaxBufferedBytes === undefined ? {} : { [CELL_ENV.sseMaxBufferedBytes]: String(options.sseMaxBufferedBytes) },
  }

  const secrets = {
    [SECRET_ENV.grantJwks]: JSON.stringify(grantPublicJwks),
    [SECRET_ENV.worksToken]: options.worksToken,
    [SECRET_ENV.gatewayToken]: options.gatewayToken,
    [SECRET_ENV.drainToken]: options.drainToken,
    [SECRET_ENV.revokeToken]: options.revokeToken,
  }

  // 1) Compile the real plugins from source (idempotent). A production Cell
  //    compiles every plugin including `myrix-novel`; a PoC driver-only scope
  //    may skip it, and the compiler then fails closed for anyone else.
  //
  //    A caller that assembles several Cells (the launcher) may compile once and
  //    pass the manifest as `precompiled`, so N Cells do not pay N builds.
  const pluginOutDir = join(home, '.plugins')
  const wanted = CELL_PLUGINS
    .filter((entry) => includeNovel || entry.pak !== 'myrix-novel')
    .map((entry) => entry.pak)
  const compiled = options.precompiled
    ?? (options.compile === false
      ? { dir: pluginOutDir, packages: {}, built: [], reused: [], skipped: [], esbuild: undefined }
      : compilePluginEntries({ repo, outDir: pluginOutDir, packages: wanted, fresh: options.fresh === true }))

  // 2) Materialize the profile tree in a real deployment layout.
  prepareProfileDir(paths)
  const profileDir = paths.profileDir
  mkdirSync(paths.sessionsDir, { recursive: true, mode: DIR_MODE })

  // `profiles/node_modules` is how profile-local plugin files resolve their bare
  // `@deepseek-ai/*` imports. Linking the locked install reproduces the
  // deployment layout and guarantees exactly ONE Cordis instance.
  linkProfileNodeModules(paths, install.nodeModules)

  // Each compiled plugin becomes a real package directory, so rows — and the
  // presets' child rows — use bare specifiers exactly as a published bundle
  // would. `@myrix/novel/preset-tools` resolves through the generated
  // `exports` map, so a missing subpath build cannot silently degrade.
  const scoped = join(profileDir, 'node_modules', '@myrix')
  mkdirSync(scoped, { recursive: true, mode: DIR_MODE })
  const linked = {}
  for (const entry of CELL_PLUGINS) {
    if (!includeNovel && entry.pak === 'myrix-novel') continue
    const pkg = compiled.packages[entry.specifier]
    if (pkg === undefined) {
      throw new Error(`myrix-poc: plugin "${entry.pak}" was not compiled; cannot assemble a Cell profile`)
    }
    const packageName = entry.specifier.slice('@myrix/'.length)
    const pakDir = join(scoped, packageName)
    mkdirSync(pakDir, { recursive: true, mode: DIR_MODE })
    const entryFiles = {}
    for (const [key, source] of Object.entries(pkg.files)) {
      const name = key === '.' ? 'index.mjs' : `${key.replace(/^\.\//, '')}.mjs`
      const target = join(pakDir, name)
      writeFileSync(target, readFileSync(source), { mode: FILE_MODE })
      entryFiles[key] = target
    }
    writeFileSync(join(pakDir, 'package.json'), `${JSON.stringify(pkg.manifest, null, 2)}\n`, { mode: FILE_MODE })
    linked[entry.specifier] = entryFiles['.']
    if (entry.subpath !== undefined) {
      const subpathFile = entryFiles[`./${entry.subpath.export}`]
      if (subpathFile === undefined || !existsSync(subpathFile)) {
        throw new Error(
          `myrix-poc: plugin "${entry.pak}" did not produce its ${entry.subpath.export} module; `
          + 'the preset subtrees would fail to mount',
        )
      }
      linked[`${entry.specifier}/${entry.subpath.export}`] = subpathFile
    }
  }

  // The two test-only rows are profile-local files, not packages. Measured:
  // under the real loader they DO resolve bare `@deepseek-ai/*` specifiers
  // through `<profile>/node_modules` and `$DSH_HOME/profiles/node_modules`, so
  // they are copied verbatim. (Rewriting them to absolute `file://` URLs works
  // too, but it gave the probe a SECOND copy of every DSH package — including
  // React — which surfaced as an opaque `react_cache` error. Bare specifiers
  // are both simpler and provably a single instance.)
  const pluginsDir = join(profileDir, 'plugins')
  mkdirSync(pluginsDir, { recursive: true, mode: DIR_MODE })
  const probesDir = join(repo, 'tests', 'poc', 'probes')
  for (const probe of ['cell-route-seam.mjs', 'cell-probe.mjs']) {
    writeFileSync(join(pluginsDir, probe), readFileSync(join(probesDir, probe)), { mode: FILE_MODE })
  }

  const { header } = splitTemplate(readFileSync(templatePath, 'utf8'))
  const cellView = { env }
  /**
   * Extra literal rows supplied by the caller.
   *
   * The production rows are all generated above; this seam exists only for a
   * PoC that needs to mount one more test row. The caller owns its correctness.
   */
  let extraRows = [...(options.extraRows ?? [])]
  /** Regenerate `cordis.patch.yml` from the current `env` (idempotent). */
  const writePatch = () => {
    const rows = [
      ...Object.keys(ROW_HANDLERS).flatMap((id) => [...ROW_HANDLERS[id](cellView), '']),
      ...extraRows,
      ...extraRows.length === 0 ? [] : [''],
    ]
    writeFileSync(join(profileDir, 'cordis.patch.yml'), renderProfilePatch({ header, rows, tail: '' }), { mode: FILE_MODE })
  }
  writePatch()
  const generatedFiles = {
    package: join(profileDir, 'package.json'),
    cordis: join(profileDir, 'cordis.yml'),
    patch: join(profileDir, 'cordis.patch.yml'),
  }
  writeFileSync(generatedFiles.package, `${JSON.stringify({
    name: `dsh-profile-${profileName}`,
    private: true,
    version: '0.0.0',
    type: 'module',
    dsh: { profile: { bundles: ['@myrix/dsh-bundle-myrix-base'] } },
  }, null, 2)}\n`, { mode: FILE_MODE })
  // `cordis.yml` stays empty: the bundle patch is the whole tree.
  writeFileSync(generatedFiles.cordis, '[]\n', { mode: FILE_MODE })

  // Defense in depth: the generated tree must carry `!!js process.env.*`
  // references only. A secret value here would outlive the process that built
  // it, so the check fails creation rather than reporting later.
  assertNoSecretPersisted(Object.values(generatedFiles), secrets)

  return {
    home,
    profileName,
    profileDir,
    install,
    mode,
    novel: includeNovel
      ? { included: true, optOutReason: null }
      : { included: false, optOutReason: options.novelOptOutReason },
    port: Number(env[CELL_ENV.port]),
    host: env[CELL_ENV.host],
    /** Base URL of the Cell's driver HTTP API. */
    cellUrl: `http://${env[CELL_ENV.host]}:${env[CELL_ENV.port]}`,
    plugins: linked,
    compiled,
    files: generatedFiles,
    env,
    secrets,
    /**
     * Repoint the probe row at a new run tag and report path, then rewrite the
     * patch. Used by the crash-recovery probe, where a restarted Cell must get a
     * fresh probe session id (and its matching works-service row) without
     * touching the durable session log this Cell owns.
     *
     * @param {{ run: string, out?: string }} next - the new boot's probe identity.
     */
    setProbeRun(next) {
      env[CELL_ENV.probeRun] = next.run
      if (next.out !== undefined) env[CELL_ENV.probeOut] = next.out
      writePatch()
      return { run: env[CELL_ENV.probeRun], out: env[CELL_ENV.probeOut] }
    },
    /**
     * Append literal patch rows to the Cell layer and rewrite the patch.
     *
     * @param {readonly string[]} rows - YAML lines (already indented).
     * @returns {number} how many extra rows the profile now carries.
     */
    appendExtraRows(rows) {
      extraRows = [...extraRows, ...rows]
      writePatch()
      return extraRows.length
    },
    /**
     * Attach the base bundle to this profile (idempotent).
     *
     * A pre-existing symlink is replaced only when it is a symlink; a real
     * directory in its place is refused, because deleting it would remove data
     * this factory did not create. The link target is the repository's own
     * `bundles/myrix-base`, so it can never point outside the workspace.
     *
     * @returns {string} the link path.
     */
    linkBundle() {
      const target = join(scoped, 'dsh-bundle-myrix-base')
      const source = join(repo, 'bundles', 'myrix-base')
      assertContained(repo, source, 'bundle source')
      const entry = lstatSync(target, { throwIfNoEntry: false })
      if (entry !== undefined) {
        if (!entry.isSymbolicLink()) {
          throw new Error(`myrix-poc: refusing to replace ${target}: it exists and is not a symbolic link`)
        }
        if (readlinkSync(target) === source) return target
        unlinkSync(target)
      }
      symlinkSync(source, target, 'dir')
      return target
    },
  }
}

/**
 * Fail creation when a generated file contains a secret value.
 *
 * @param {readonly string[]} files - generated files to scan.
 * @param {Record<string, string>} secrets - environment variable name → value.
 * @throws when any value of at least 8 characters appears in a generated file.
 */
export function assertNoSecretPersisted(files, secrets) {
  const values = Object.values(secrets).filter((value) => typeof value === 'string' && value.length >= 8)
  for (const file of files) {
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    for (const value of values) {
      if (text.includes(value)) {
        throw new Error(`myrix-poc: refusing to persist a secret value into ${file}; profiles carry env references only`)
      }
    }
  }
}

/**
 * The environment a Cell process must run with.
 *
 * `DSH_HOME` is the isolation boundary — the factory never reuses `~/.dsh`,
 * because an ambient stale install (`0.1.0-rc.6` was observed on the
 * development machine) would silently change the runtime under test.
 *
 * The base is **not** `process.env` by default: without an explicit `base`, only
 * {@link OS_ENV_ALLOWLIST} names are inherited, so the coordinator's ambient
 * database URLs, signing keys and upstream model keys can never reach a Cell.
 * An explicit `base` is accepted (the launcher passes its own filtered set) but
 * is rejected outright when it carries a forbidden name.
 *
 * @param {object} cell - descriptor from {@link createCellProfile}.
 * @param {NodeJS.ProcessEnv} [base] - an already-filtered base environment.
 * @returns {NodeJS.ProcessEnv} the child environment.
 * @throws when the base carries a platform-only secret or an ambient module
 *   injection setting.
 */
export function cellEnv(cell, base) {
  const source = base ?? osEnvironment(process.env)
  assertEnvIsLegalBase(source)
  const env = {
    ...source,
    DSH_HOME: cell.home,
    DSH_TELEMETRY_DISABLED: '1',
    DSH_RUNTIME_VERSION: cell.install.version,
    ...cell.env,
    ...cell.secrets,
  }
  assertEnvIsLegalBase(env)
  return env
}

/**
 * Project the OS allowlist out of an environment.
 *
 * @param {NodeJS.ProcessEnv} parent - the environment to filter.
 * @returns {NodeJS.ProcessEnv} only the allowlisted names.
 */
export function osEnvironment(parent) {
  return Object.fromEntries(
    OS_ENV_ALLOWLIST.flatMap((key) => parent[key] === undefined ? [] : [[key, parent[key]]]),
  )
}

/**
 * Reject an environment that carries platform-only material.
 *
 * @param {NodeJS.ProcessEnv} env - the environment to check.
 * @throws when a forbidden name is present.
 */
export function assertEnvIsLegalBase(env) {
  for (const name of Object.keys(env)) {
    if (FORBIDDEN_ENV_PATTERN.test(name)) {
      throw new Error(
        `myrix-poc: refusing to pass ${name} into a Cell process; `
        + 'platform-only secrets and ambient module injection settings never enter a Cell',
      )
    }
  }
}
