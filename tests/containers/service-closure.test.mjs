// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const manifests = new Map();
for (const directory of ['', ...['apps', 'packages', 'plugins', 'bundles'].flatMap(group =>
  readdirSync(new URL(`${group}/`, root), { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => `${group}/${entry.name}/`))]) {
  if (!existsSync(new URL(`${directory}package.json`, root))) continue;
  const manifest = JSON.parse(read(`${directory}package.json`));
  manifests.set(manifest.name, manifest);
}
// Read the actual install selectors, so adding a new target cannot bypass this test.
const dockerfile = read('deploy/images/Dockerfile.node');
const install = dockerfile.split('RUN pnpm install ')[1].split('\n#')[0];
const selectors = [...install.matchAll(/--filter (?:"([^"]+)"|(\S+))/g)].map(m => m[1] ?? m[2]);

function assertServiceClosure(packages) {
  assert.equal(selectors.length, 4);
  const visit = (name, chain, recurse) => {
    assert.ok(!name.startsWith('@deepseek-ai/'), `DSH leaked into service closure: ${[...chain, name].join(' -> ')}`);
    const manifest = packages.get(name);
    if (!manifest || chain.includes(name)) return;
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [dependency, version] of Object.entries(manifest[section] ?? {})) {
        if (version.startsWith('workspace:')) assert.ok(packages.has(dependency), `missing workspace ${dependency}`);
        if (recurse || !packages.has(dependency)) visit(dependency, [...chain, name], true);
      }
    }
  };
  for (const selector of selectors) {
    assert.match(selector, /^(myrix|@myrix\/[\w-]+\.\.\.)$/);
    const name = selector.replace(/\.\.\.$/, '');
    assert.ok(packages.has(name), `unknown filter ${selector}`);
    visit(name, [], selector.endsWith('...'));
  }
}

test('the real filtered service install cannot reach any DSH dependency', () => assertServiceClosure(manifests));

test('regression: importing a plugin protocol subpath still pulls its whole package', () => {
  const broken = new Map(manifests);
  const bff = structuredClone(broken.get('@myrix/bff'));
  bff.dependencies['@myrix/novel'] = 'workspace:*';
  broken.set(bff.name, bff);
  assert.throws(() => assertServiceClosure(broken), /DSH leaked.*@myrix\/bff -> @myrix\/novel -> @deepseek-ai\//);
});

test('the shared novel protocol has no external dependency sections', () => {
  const protocol = manifests.get('@myrix/novel-protocol');
  assert.ok(protocol);
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.deepEqual(protocol[section] ?? {}, {});
  }
});

test('both installs clean the checkout-local pnpm store, cache and state in the same layer', () => {
  for (const stage of [dockerfile.split('FROM node-base AS deps')[1].split('FROM deps AS web')[0], dockerfile.split('FROM deps AS cell')[1]]) {
    assert.match(stage, /RUN pnpm[^]*?&& rm -rf \/app\/\.pnpm-store \/app\/\.pnpm-cache \/app\/\.pnpm-state/);
  }
});
