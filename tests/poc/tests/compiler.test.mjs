// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { compileCellPlugins, resolveEsbuild } from '../lib/compile-plugins.mjs'
import { resolveRepoRoot } from '../lib/dsh-install.mjs'

const REPO = resolveRepoRoot()

test('novel compilation explicitly inlines protocol without workspace links and invalidates its cache', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'myrix-compiler-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  // Only source trees and an esbuild launcher: no workspace links or pnpm hoist.
  for (const relative of ['plugins/myrix-novel/src', 'packages/novel-protocol/src', 'packages/grant/src', 'plugins/myrix-principals/src']) {
    cpSync(join(REPO, relative), join(repo, relative), { recursive: true })
  }
  const binary = join(repo, 'node_modules/.bin/esbuild')
  mkdirSync(dirname(binary), { recursive: true })
  writeFileSync(binary, `#!/bin/sh\nexec '${resolveEsbuild(REPO).replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 })
  const options = { repo, outDir: join(repo, 'out'), packages: ['myrix-novel'] }
  const first = compileCellPlugins(options)
  assert.equal(first.built.length, 2)
  assert.equal(first.reused.length, 0)
  assert.equal(compileCellPlugins(options).reused.length, 2)

  const protocol = join(repo, 'packages/novel-protocol/src/index.ts')
  const source = readFileSync(protocol, 'utf8')
  assert.ok(source.includes('get_outline'))
  writeFileSync(protocol, source.replaceAll('get_outline', 'get_outline_cache_regression'))
  // Set an explicit newer time; do not depend on filesystem clock granularity.
  const newer = new Date(statSync(first.bundles['myrix-novel']).mtimeMs + 2000)
  utimesSync(protocol, newer, newer)
  const changed = compileCellPlugins(options)
  assert.equal(changed.built.length, 2)
  assert.equal(changed.reused.length, 0)
  assert.match(readFileSync(changed.bundles['myrix-novel'], 'utf8'), /get_outline_cache_regression/)
})
