/**
 * Compile the Myrix Cordis plugins from TypeScript source into single-file ESM
 * bundles that the **locked, unpatched** DSH runtime can import.
 *
 * Why this exists (measured, not assumed):
 *
 *   * The plugins are consumed as TypeScript source and several of them use
 *     extension-less relative imports (`from './types'`, `from './http'`).
 *   * The locked DSH CLI boots with a plain Node process. Measured:
 *     `node --experimental-transform-types` fails on extension-less specifiers
 *     with `ERR_MODULE_NOT_FOUND` — neither strip-only nor transform-types mode
 *     performs extension resolution. `--import tsx` works but installs a
 *     third-party loader inside the Cell runtime, which is not a deployment we
 *     are willing to certify.
 *   * A real image compiles the plugins to JavaScript and ships the output.
 *     This module performs exactly that step, using the `esbuild` binary that
 *     already exists in the repo's toolchain (a vitest/vite transitive
 *     dependency — nothing new is added to any lockfile).
 *
 * The bundling contract:
 *   * `@deepseek-ai/*` stays **external** and resolves from the locked install
 *     (`$DSH_HOME/profiles/node_modules`), so there is exactly one Cordis
 *     instance and one Agent/Session class identity.
 *   * `@myrix/grant`, `@myrix/principals`, and `@myrix/novel-protocol` are
 *     **inlined** from this repo's sources. They are pure TypeScript libraries with no native or DSH state,
 *     so inlining them cannot duplicate a Cordis service — unlike bundling a
 *     plugin package, which would mint a second `Context` class.
 *
 * @module myrix-poc/compile-plugins
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveRepoRoot } from './dsh-install.mjs'

/**
 * The plugin packages that make up a Myrix Cell, in load order.
 *
 * Order is documentation only — Cordis activates rows by service availability —
 * but it mirrors the dependency direction: identity first, then the PEP, then
 * the lease that feeds identity liveness, then the driver, then the model route.
 */
export const CELL_PLUGINS = Object.freeze([
  { pak: 'myrix-principals', specifier: '@myrix/principals' },
  { pak: 'myrix-policy-enforcer', specifier: '@myrix/policy-enforcer' },
  { pak: 'myrix-binding-lease', specifier: '@myrix/binding-lease' },
  { pak: 'myrix-runtime-driver', specifier: '@myrix/runtime-driver' },
  { pak: 'myrix-llm-gateway', specifier: '@myrix/llm-gateway' },
  {
    pak: 'myrix-novel',
    specifier: '@myrix/novel',
    /**
     * A second module the package must ship.
     *
     * `myrix-novel` registers three presets whose child rows load
     * `@myrix/novel/preset-tools`. That specifier resolves through the
     * package's `exports` map, so compiling only `src/index.ts` produces a
     * package that fails at preset-mount time. The subpath is compiled as its
     * own ESM file and declared in the generated `package.json`.
     */
    subpath: { key: 'preset-tools', export: 'preset-tools', file: 'preset-tools.mjs', entry: 'preset-tools.ts' },
  },
])

/** In-repo workspace packages that are safe (and necessary) to inline. */
export const INLINE_ALIASES = Object.freeze({
  '@myrix/grant': 'packages/grant/src/index.ts',
  '@myrix/principals': 'plugins/myrix-principals/src/index.ts',
  '@myrix/novel-protocol': 'packages/novel-protocol/src/index.ts',
})

/**
 * Workspace **libraries** compiled as standalone bundles.
 *
 * `@myrix/grant` is the credential signer/verifier shared by the control plane
 * and the Cell. The PoC runner is the control plane, and it runs as a plain
 * Node module outside the TypeScript toolchain, so it needs the library as
 * JavaScript. Compiling it here keeps one source of truth for the claim table:
 * the runner and the Cell plugin both execute the same code.
 */
export const LIB_TARGETS = Object.freeze([
  { name: 'myrix-grant', entry: 'packages/grant/src/index.ts' },
])

/** Locate the esbuild binary that the repo's toolchain already provides. */
export function resolveEsbuild(repo = resolveRepoRoot()) {
  const candidates = [
    join(repo, 'node_modules', '.bin', 'esbuild'),
    join(repo, 'node_modules', 'esbuild', 'bin', 'esbuild'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    'myrix-poc: cannot find the esbuild binary.\n'
    + `Looked at: ${candidates.join(', ')}\n`
    + 'It ships with the repo toolchain (vitest/vite). Run `pnpm install` at the repo root.',
  )
}

/**
 * Compile the requested Myrix plugins into `outDir`.
 *
 * Idempotent: a bundle whose build stamp matches the current compiler arguments
 * and is newer than every source file it could contain is reused, so repeated
 * runs do not pay esbuild's startup cost. `fresh` forces a rebuild.
 *
 * @param {{
 *   outDir: string,
 *   repo?: string,
 *   packages?: readonly string[],
 *   fresh?: boolean,
 * }} options - build inputs.
 * @returns {{ dir: string, bundles: Record<string, string>, built: string[], reused: string[], skipped: string[], esbuild: string }} the manifest.
 * @throws when a non-optional plugin has no source entry point.
 */
export function compileCellPlugins(options) {
  const repo = options.repo ?? resolveRepoRoot()
  const outDir = options.outDir
  const fresh = options.fresh === true
  const wanted = options.packages ?? CELL_PLUGINS.map((entry) => entry.pak)
  const esbuild = resolveEsbuild(repo)
  mkdirSync(outDir, { recursive: true, mode: 0o700 })

  /** @type {Record<string, string>} */
  const bundles = {}
  const built = []
  const reused = []
  const skipped = []

  /** The files each plugin package contributes, root module first. */
  const outputs = {}

  for (const entry of CELL_PLUGINS) {
    if (!wanted.includes(entry.pak)) continue
    const written = []
    for (const unit of buildUnits(repo, entry)) {
      if (!existsSync(unit.entryPoint)) {
        // A required subpath that is missing is a configuration error, not a
        // reason to ship a package whose own presets cannot load.
        const message = `plugin "${entry.pak}" has no source entry point at ${unit.entryPoint}`
        if (entry.optional === true) {
          skipped.push(`${entry.pak}: no ${unit.entryPoint}`)
          break
        }
        throw new Error(
          `myrix-poc: ${message}.\n`
          + 'A non-optional Cell plugin must exist before a Cell profile can be assembled.',
        )
      }
      const outFile = bundlePathFor(outDir, unit.name)
      const args = esbuildArgs({ repo, outFile })
      // Every explicitly inlined workspace source participates in freshness,
      // including the shared protocol whose plugin-side file is only a re-export.
      const inputs = [
        ...collectTree(join(repo, 'plugins', entry.pak, 'src')),
        ...Object.values(INLINE_ALIASES).flatMap((source) => collectTree(resolve(repo, source, '..'))),
      ]
      if (!fresh && isFresh({ outFile, inputs, args })) {
        reused.push(unit.name)
      } else {
        runEsbuild({ esbuild, repo, entryPoint: unit.entryPoint, outFile, args })
        built.push(unit.name)
      }
      written.push({ name: unit.name, outFile })
    }
    if (written.length === 0) continue
    bundles[entry.pak] = written[0].outFile
    outputs[entry.pak] = written
  }

  return { dir: outDir, bundles, outputs, built, reused, skipped, esbuild }
}

/**
 * The build units one plugin package contributes.
 *
 * Every unit compiles with the same externals and aliases, so a subpath module
 * shares the process's single `@deepseek-ai/*` instance set exactly like the
 * root module.
 *
 * @param {string} repo - repository root.
 * @param {{ pak: string, subpath?: { key: string, file: string, entry: string } }} entry - the plugin entry.
 * @returns {Array<{ name: string, entryPoint: string }>} the units, root first.
 */
function buildUnits(repo, entry) {
  const units = [{ name: entry.pak, entryPoint: pluginEntryPoint(repo, entry.pak) }]
  if (entry.subpath !== undefined) {
    units.push({
      name: entry.subpath.key,
      entryPoint: join(repo, 'plugins', entry.pak, 'src', entry.subpath.entry),
    })
  }
  return units
}

/**
 * Compile one plugin package's modules into a deployable `node_modules` entry.
 *
 * The built files are exactly the package's own public entry points, named as
 * the package's real relative paths (`index.mjs`, `preset-tools.mjs`), and the
 * generated `package.json` declares them in `exports`. Resolving
 * `@myrix/novel/preset-tools` then goes through Node's export map rather than a
 * bare file walk, so a missing build is a hard resolution failure.
 *
 * @param {{
 *   outDir: string,
 *   repo?: string,
 *   packages?: readonly string[],
 *   fresh?: boolean,
 * }} options - build inputs.
 * @returns {{ dir: string, packages: Record<string, { dir: string, files: Record<string, string>, manifest: object }>, built: string[], reused: string[], skipped: string[], esbuild: string }} the manifest.
 * @throws when a required plugin's root or subpath entry point is missing.
 */
export function compilePluginEntries(options) {
  const repo = options.repo ?? resolveRepoRoot()
  const outDir = options.outDir
  const compiled = compileCellPlugins({ repo, outDir, packages: options.packages, fresh: options.fresh === true })
  /** The packages the caller asked for; when omitted, every Cell plugin. */
  const wanted = options.packages === undefined ? undefined : new Set(options.packages)
  /** @type {Record<string, { dir: string, files: Record<string, string>, manifest: object }>} */
  const packages = {}
  for (const entry of CELL_PLUGINS) {
    // A package the caller deliberately excluded is skipped, not required:
    // the driver-only PoC scope excludes `myrix-novel`, and that decision must
    // not be reported as a missing build.
    if (wanted !== undefined && !wanted.has(entry.pak)) continue
    const written = compiled.outputs[entry.pak]
    if (written === undefined) {
      throw new Error(`myrix-poc: plugin "${entry.pak}" was not compiled; cannot assemble a Cell profile`)
    }
    const packageName = entry.specifier.slice('@myrix/'.length)
    const dir = join(outDir, 'packages', packageName)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    /** Relative entry names by the export key they satisfy (`'.'` → `index.mjs`). */
    const files = {}
    const exportMap = {}
    for (const [index, unit] of written.entries()) {
      const key = index === 0 ? '.' : `./${entry.subpath.export}`
      const name = index === 0 ? 'index.mjs' : entry.subpath.file
      files[key] = writePackageFile({ dir, name, source: unit.outFile })
      exportMap[key] = `./${name}`
    }
    const manifest = {
      name: entry.specifier,
      version: '0.1.0',
      private: true,
      type: 'module',
      exports: exportMap,
    }
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    packages[entry.specifier] = { dir, files, manifest }
  }
  return { dir: outDir, packages, built: compiled.built, reused: compiled.reused, skipped: compiled.skipped, esbuild: compiled.esbuild }
}

/** Copy one compiled bundle into a package directory and restore owner-only mode. */
function writePackageFile({ dir, name, source }) {
  const target = join(dir, name)
  writeFileSync(target, readFileSync(source), { mode: 0o600 })
  return target
}

/**
 * Compile one workspace **library** (not a plugin) to a standalone ESM bundle.
 *
 * Unlike a plugin, a library has no Cordis surface to duplicate: `@myrix/grant`
 * is pure `node:crypto` and plain data. Bundling it is how the PoC runner (a
 * plain Node process) gets the exact claim table the Cell verifies against.
 *
 * @param {{ outDir: string, repo?: string, fresh?: boolean }} options - build inputs.
 * @returns {Record<string, string>} library name → bundle path.
 */
export function compileWorkspaceLibs(options) {
  const repo = options.repo ?? resolveRepoRoot()
  const outDir = options.outDir
  const fresh = options.fresh === true
  const esbuild = resolveEsbuild(repo)
  mkdirSync(outDir, { recursive: true, mode: 0o700 })
  const bundles = {}
  for (const target of LIB_TARGETS) {
    const entryPoint = join(repo, target.entry)
    if (!existsSync(entryPoint)) {
      throw new Error(`myrix-poc: workspace library "${target.name}" has no entry point at ${entryPoint}`)
    }
    const outFile = join(outDir, `${target.name}.mjs`)
    const args = libEsbuildArgs(outFile)
    const inputs = collectTree(join(repo, 'packages', 'grant', 'src'))
    if (!fresh && isFresh({ outFile, inputs, args })) {
      bundles[target.name] = outFile
      continue
    }
    execFileSync(esbuild, [...args, entryPoint], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
    writeFileSync(`${outFile}.build.json`, `${JSON.stringify({ args: JSON.stringify(args) })}\n`, { mode: 0o600 })
    bundles[target.name] = outFile
  }
  return bundles
}

/** esbuild arguments for a workspace library: nothing DSH, nothing external. */
function libEsbuildArgs(outFile) {
  return [
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node24',
    `--outfile=${outFile}`,
    '--log-level=warning',
  ]
}

/** List every `.ts` file under `dir`, without depending on any glob library. */
function collectTree(dir) {
  const out = []
  /** @param {string} current */
  const walk = (current) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts')) out.push(full)
    }
  }
  walk(dir)
  return out
}

/** True when `outFile` was built with these exact arguments and is up to date. */
function isFresh({ outFile, inputs, args }) {
  if (!existsSync(outFile)) return false
  const stampFile = `${outFile}.build.json`
  if (!existsSync(stampFile)) return false
  try {
    if (JSON.parse(readFileSync(stampFile, 'utf8')).args !== JSON.stringify(args)) return false
  } catch {
    return false
  }
  const outTime = statSync(outFile).mtimeMs
  for (const input of inputs) {
    if (existsSync(input) && statSync(input).mtimeMs > outTime) return false
  }
  return true
}

/**
 * The exact esbuild argument vector for one bundle.
 *
 * Aliases are absolute because esbuild resolves alias targets against the
 * process cwd, which is not guaranteed to be the repository root. Keeping this
 * a pure function of `{repo, outFile}` is what makes the build stamp meaningful.
 */
function esbuildArgs({ repo, outFile }) {
  return [
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node24',
    '--external:@deepseek-ai/*',
    ...Object.entries(INLINE_ALIASES).map(([from, to]) => `--alias:${from}=${resolve(repo, to)}`),
    `--outfile=${outFile}`,
    '--log-level=warning',
  ]
}

/** Run one esbuild invocation and write the build stamp. */
function runEsbuild({ esbuild, repo, entryPoint, outFile, args }) {
  execFileSync(esbuild, [...args, entryPoint], {
    cwd: repo,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  writeFileSync(`${outFile}.build.json`, `${JSON.stringify({ args: JSON.stringify(args) })}\n`, { mode: 0o600 })
}

/** The absolute path a compiled plugin will have. */
export function bundlePathFor(outDir, pak) {
  return join(outDir, `${pak}.mjs`)
}

/** The TypeScript entry point of a plugin package. */
export function pluginEntryPoint(repo, pak) {
  return join(repo, 'plugins', pak, 'src', 'index.ts')
}
