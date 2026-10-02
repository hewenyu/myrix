// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const node = read('deploy/images/Dockerfile.node').replace(/^\s*#.*$/gm, '')
const manager = read('deploy/images/Dockerfile.cell-manager').replace(/^\s*#.*$/gm, '')
const ignore = new Set(read('.dockerignore').split('\n').map(x => x.trim()).filter(x => x && !x.startsWith('#')))

// Guard the explicit patterns as well as runtime contracts: Docker does not
// consult .gitignore, including when private initialization has run locally.
test('image contexts exclude private generated state at every supported location', () => {
  for (const pattern of [
    '.git', '.team', 'data', 'vendor', '**/node_modules', '**/dist',
    '**/.env', '**/.env.*', '**/secrets', '**/.ssh', '**/.aws', '**/*.pem', '**/*.key',
    '**/.dsh', '**/.dsh-home', '**/.pnpm-store', '**/.pnpm-cache', '**/.pnpm-state', '**/.cache',
    'deploy/auth/generated', 'deploy/vps/auth', 'deploy/vps/*.env', 'deploy/vps/sql/*.sql',
    '**/*.dump', '**/*.sql.gz', '**/backups', '**/*.tgz', '**/*.tar.gz',
    '**/*.log', '**/.work', '**/.work-*',
  ]) assert.ok(ignore.has(pattern), `missing private/reproducible context exclusion: ${pattern}`)
  for (const required of ['LICENSE', 'NOTICE', 'tests/poc/.dsh-install', 'tests/poc/lib', 'plugins']) {
    assert.ok(!ignore.has(required), `must preserve runtime source/license: ${required}`)
  }
})

test('each Node image reinstalls its frozen target-platform dependency closure', () => {
  assert.match(node, /ARG NODE_VERSION=24\.13\.0/)
  assert.match(node, /ARG PNPM_VERSION=10\.33\.0/)
  assert.match(node, /FROM node:\$\{NODE_VERSION\}-bookworm-slim AS node-base/)
  assert.match(node, /pnpm install --frozen-lockfile --ignore-scripts/)
  for (const name of ['bff', 'model-gateway', 'novel-web']) {
    assert.ok(node.includes(`--filter "@myrix/${name}..."`))
  }
  assert.doesNotMatch(node, /--platform=\$BUILDPLATFORM|--mount=type=cache|cache-from|cache-to|public-hoist-pattern/)
  assert.match(node, /test -x \/app\/node_modules\/\.bin\/esbuild/)
})

test('BFF and gateway run real source entries without embedding DSH', () => {
  assert.match(node, /test ! -e \/app\/node_modules\/@deepseek-ai/)
  assert.match(node, /test ! -e \/app\/node_modules\/\.pnpm\/node_modules\/@deepseek-ai/)
  assert.match(node, /FROM deps AS bff/)
  assert.match(node, /FROM deps AS gateway/)
  for (const name of ['bff', 'model-gateway']) assert.ok(node.includes(`CMD ["apps/${name}/src/bin.ts"]`))
  assert.equal((node.match(/ENTRYPOINT \["node", "--import", "tsx"\]/g) ?? []).length, 2)
  assert.match(node, /RUN pnpm build:web/)
  assert.match(node, /COPY --from=web \/app\/apps\/novel-web\/dist \/app\/apps\/novel-web\/dist/)
  assert.match(node, /MYRIX_STATIC_ROOT=\/app\/apps\/novel-web\/dist/)
})

test('Cell uses the locked CLI, preserves its license, and shares the runtime UID/home contract', () => {
  const cell = node.split('FROM deps AS cell')[1]
  assert.ok(cell)
  assert.match(cell, /pnpm --dir tests\/poc\/\.dsh-install install --frozen-lockfile/)
  assert.match(cell, /test -x \/app\/tests\/poc\/\.dsh-install\/node_modules\/@deepseek-ai\/dsh\/lib\/bin\.js/)
  assert.match(cell, /test -f \/app\/tests\/poc\/\.dsh-install\/node_modules\/@deepseek-ai\/dsh\/LICENSE/)
  assert.match(cell, /install -d -o 65532 -g 65532 -m 0700 \/var\/lib\/myrix\/dsh-home/)
  assert.match(cell, /DSH_HOME=\/var\/lib\/myrix\/dsh-home/)
  assert.match(cell, /USER 65532:65532/)
  assert.match(cell, /CMD \["deploy\/images\/cell-entry\.mjs"\]/)
  assert.equal((node.match(/USER 65532:65532/g) ?? []).length, 3)
})

test('future Kubernetes controller cross-compiles statically without entering the VPS runtime', () => {
  assert.match(manager, /FROM --platform=\$BUILDPLATFORM golang:/)
  assert.match(manager, /CGO_ENABLED=0/)
  assert.ok(manager.includes('GOOS="${TARGETOS}"'))
  assert.ok(manager.includes('GOARCH="${TARGETARCH}"'))
  assert.match(manager, /AS cell-manager/)
  assert.match(manager, /COPY LICENSE NOTICE/)
  assert.doesNotMatch(manager, /--mount=type=cache|cache-from|cache-to/)
})
