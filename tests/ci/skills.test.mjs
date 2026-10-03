// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
for (const name of ['myrix-business', 'myrix-development']) {
  test(`${name}: discoverable project skill with current frontmatter`, async () => {
    const source = await readFile(resolve(root, '.agents/skills', name, 'SKILL.md'), 'utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source);
    assert.ok(match, 'YAML frontmatter is required');
    assert.match(match[1], new RegExp(`^name: ${name}$`, 'm'));
    assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    const description = /^description: (.+)$/m.exec(match[1])?.[1];
    assert.ok(description && description.length <= 500);
    assert.doesNotMatch(match[1], /^(disableModelInvocation|userInvocable):/m);
    assert.match(source, /Cell/);
    assert.match(source, /chat\/completions/);
    assert.match(source, /Responses/);
  });
}

test('maintainer deployment skill and evidence stay excluded from Git and Docker', async () => {
  const git = await readFile(resolve(root, '.gitignore'), 'utf8');
  const docker = await readFile(resolve(root, '.dockerignore'), 'utf8');
  assert.match(git, /^\/\.agents\/skills\/myrix-deploy\/$/m);
  assert.match(git, /^\/docs\/local\/$/m);
  assert.match(docker, /^\.agents\/skills\/myrix-deploy\/?$/m);
  assert.match(docker, /^docs\/local\/?$/m);
  // Do not require the ignored local skill to exist in a fresh clone/CI checkout.
});
