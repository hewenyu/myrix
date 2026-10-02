// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkEdge, checkWorkspace, importSpecifiers } from '../../scripts/check-boundaries.mjs';

const contracts = { name: '@myrix/contracts', directory: 'packages/contracts', exports: { '.': './src/index.ts' } };
const store = { name: '@myrix/platform-store', directory: 'packages/platform-store', exports: { '.': './src/index.ts', './internal': null } };
const novel = { name: '@myrix/novel', directory: 'plugins/myrix-novel', exports: { '.': './src/index.ts', './protocol': './src/protocol.ts' } };
const gateway = { name: '@myrix/model-gateway', directory: 'apps/model-gateway' };
const protocol = { name: '@myrix/novel-protocol', directory: 'packages/novel-protocol', exports: { '.': './src/index.ts' } };
const packages = new Map([contracts, store, novel, protocol, gateway].map(pkg => [pkg.name, pkg]));
const bff = { name: '@myrix/bff', directory: 'apps/bff', dependencies: { '@myrix/platform-store': 'workspace:*', '@myrix/novel': 'workspace:*', '@myrix/novel-protocol': 'workspace:*', '@myrix/model-gateway': 'workspace:*' } };
const check = (owner, specifier, target = '') => checkEdge(owner, specifier, target, packages);

test('public exports and the standalone BFF protocol are allowed', () => {
  assert.equal(check(bff, '@myrix/platform-store'), undefined);
  assert.equal(check(bff, '@myrix/novel-protocol'), undefined);
  assert.match(check(bff, '@myrix/novel/protocol'), /Cordis/);
  assert.equal(check(bff, './local', 'apps/bff/src/local'), undefined);
});

test('deep imports, undeclared dependencies and private exports fail', () => {
  assert.match(check(bff, '../../../packages/platform-store/src/index', 'packages/platform-store/src/index'), /cross-package/);
  assert.match(check(bff, '@myrix/platform-store/src/index'), /export/);
  assert.match(check(bff, '@myrix/platform-store/internal'), /export/);
  assert.match(check({ ...bff, dependencies: {} }, '@myrix/platform-store'), /not declared/);
  assert.match(check(store, '@myrix/platform-store/src/index'), /export/);
  assert.match(check(bff, '../bff-copy/file', 'apps/bff-copy/file'), /cross-package/);
});

test('layers prohibit browser/server, app/app, app/plugin and reverse edges', () => {
  assert.match(check(bff, '@myrix/novel'), /Cordis/);
  assert.match(check(bff, '@myrix/model-gateway'), /applications communicate/);
  assert.match(check({ ...bff, name: '@myrix/novel-web' }, '@myrix/platform-store'), /browser/);
  assert.match(check({ ...store, dependencies: bff.dependencies }, '@myrix/novel'), /shared packages/);
  assert.match(check({ ...novel, dependencies: bff.dependencies }, '@myrix/model-gateway'), /runtime plugins/);
});

test('pure domains prohibit external I/O dependencies, but allow contracts', () => {
  const domain = { name: '@myrix/governance', directory: 'packages/governance', dependencies: { '@myrix/contracts': 'workspace:*' } };
  assert.equal(check(domain, '@myrix/contracts'), undefined);
  for (const specifier of ['node:fs', 'fs', 'pg', '@myrix/platform-store']) {
    assert.match(check(domain, specifier), /pure domain/);
  }
  for (const specifier of ['/outside/code.ts', 'file:///outside/code.ts', '#hidden']) {
    assert.match(check(bff, specifier), /bypass/);
  }
});

test('source parser retains type imports, re-exports, import types, require and dynamic imports', () => {
  const source = `
    // import type { Fake } from 'comment';
    const prose = "import('not-code')";
    import type { A } from 'a';
    export type { B } from 'b';
    export * from 'c';
    type D = import('d').D;
    import E = require('e');
    const f = import('f');
    const g = require('g');
    const h = import(\`h\`);
  `;
  assert.deepEqual(importSpecifiers('fixture.ts', source), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  for (const source of ["import(name)", "require(name)", "import(`./${name}`)"]) {
    assert.throws(() => importSpecifiers('fixture.ts', source), /static mapping/);
  }
  assert.throws(() => importSpecifiers('fixture.ts', 'import {'), /fixture.ts/);
});

test('type-only boundary violations cannot be erased by transpilation', () => {
  const [specifier] = importSpecifiers('fixture.ts', "import type { Internal } from '@myrix/platform-store/src/schema';");
  assert.match(check(bff, specifier), /export/);
});

test('all production source edges pass and migration exceptions are not stale', checkWorkspace);
