/**
 * Locate the **locked** DSH installation used by every Myrix runtime PoC.
 *
 * There are three distinct installs in play and they must never be confused
 * (see `docs/development/runtime-dependencies.md`):
 *
 *   1. `vendor/deepseek-harness` (submodule, commit `639ed01`) — the read-only
 *      source baseline. Not runnable.
 *   2. `~/.dsh/profiles/node_modules` — an ambient, possibly STALE install
 *      (`0.1.0-rc.6` was observed on this machine). Never used by the PoC.
 *   3. `tests/poc/.dsh-install` — the isolated hoisted install the PoC runs.
 *
 * The npm package version equals the submodule's declared version
 * (`0.2.0-rc.2`) but the two are **not proven to be the same build**: npm
 * publishes a bundle and there is no byte-level comparison against the commit.
 * Every claim in the PoC docs is therefore tagged `[源码]` (read from the
 * submodule at `639ed01`) or `[实测]` (observed in a real process), never
 * inferred from the version string alone.
 *
 * @module myrix-poc/dsh-install
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

/** The commit the PoC is written against. Asserted, not assumed. */
export const LOCKED_VENDOR_COMMIT = '639ed015397290b3745d163aafe02ffee4aa3f84'

/** The package version that commit declares. */
export const LOCKED_DSH_VERSION = '0.2.0-rc.2'

/**
 * Locate the isolated PoC install of the DSH CLI.
 *
 * Resolution order: `MYRIX_DSH_CLI`, then `<repo>/tests/poc/.dsh-install`,
 * then an install reachable from the repo's own `node_modules`. It never
 * installs anything: a missing install fails loudly (see
 * `docs/development/runtime-dependencies.md`).
 *
 * @param {{ repo?: string, explicit?: string }} [options] - search overrides.
 * @returns {{ cli: string, version: string, nodeModules: string, root: string }} the resolved install.
 * @throws when no installation is reachable.
 */
export function resolveDshInstall(options = {}) {
  const repo = options.repo ?? resolveRepoRoot()
  const explicit = options.explicit ?? process.env.MYRIX_DSH_CLI
  const candidates = []
  if (typeof explicit === 'string' && explicit.length > 0) candidates.push(explicit)
  const pocInstall = join(repo, 'tests', 'poc', '.dsh-install')
  candidates.push(join(pocInstall, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  candidates.push(join(repo, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    // …/node_modules/@deepseek-ai/dsh/lib/bin.js → install root is the CLI package dir.
    const cliPackage = dirname(dirname(candidate))
    const manifestPath = join(cliPackage, 'package.json')
    const version = existsSync(manifestPath)
      ? JSON.parse(readFileSync(manifestPath, 'utf8')).version
      : 'unknown'
    // The directory whose `node_modules` holds the full DSH dependency set.
    // A hoisted install puts it beside `@deepseek-ai`; a nested one keeps it
    // inside the CLI package.
    const hoisted = dirname(dirname(cliPackage)) // …/node_modules
    const nodeModules = existsSync(join(cliPackage, 'node_modules'))
      ? join(cliPackage, 'node_modules')
      : hoisted
    return { cli: candidate, version, nodeModules, root: dirname(hoisted) }
  }

  throw new Error(
    'myrix-poc: cannot find the locked DSH CLI.\n'
    + `Expected: ${join(pocInstall, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')}\n`
    + 'Install it once with: cd tests/poc/.dsh-install && pnpm install\n'
    + '(see docs/development/runtime-dependencies.md; node-linker=hoisted + auto-install-peers=true are required)\n'
    + 'or point MYRIX_DSH_CLI at an @deepseek-ai/dsh/lib/bin.js.',
  )
}

/**
 * Resolve the repository root from this module's location.
 * @returns the absolute repository root.
 */
export function resolveRepoRoot() {
  // …/tests/poc/lib/dsh-install.mjs → repo root is three levels up.
  return resolve(dirname(new URL(import.meta.url).pathname), '..', '..', '..')
}

/**
 * Resolve a package from the **locked install** (not the repo's own tree).
 *
 * The profile resolver walks the installation's dependency graph, so a plugin
 * that reaches a package from anywhere else is not testing the real layout.
 *
 * @param {string} specifier - bare package specifier.
 * @param {string} fromFile - a file inside the locked install.
 * @returns {string} the resolved absolute path.
 * @throws when the package is not reachable from the locked install.
 */
export function resolveFromInstall(specifier, fromFile) {
  return createRequire(fromFile).resolve(specifier)
}
