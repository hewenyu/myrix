// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
function markdown(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'local') return [];
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? markdown(path) : entry.name.endsWith('.md') ? [path] : [];
  });
}

test('public documentation links exist and never depend on private local evidence', () => {
  const files = [resolve(root, 'README.md'), resolve(root, 'AGENTS.md'), ...markdown(resolve(root, 'docs')),
    ...['myrix-business', 'myrix-development'].map(name => resolve(root, '.agents/skills', name, 'SKILL.md'))];
  const problems = [];
  for (const file of files) {
    // Inline Markdown links only; fenced shell/config examples are not hyperlinks.
    const text = readFileSync(file, 'utf8').replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
    for (const match of text.matchAll(/\[[^\]\n]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\s*\)/g)) {
      const target = (match[1] ?? match[2]).split('#')[0];
      if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
      const path = resolve(dirname(file), decodeURIComponent(target));
      const local = relative(root, path).split(sep).join('/');
      const location = `${relative(root, file)} → ${target}`;
      if (local.startsWith('../') || /^(?:data\/|docs\/local\/|\.team\/|\.agents\/skills\/myrix-deploy\/)/.test(local)) {
        problems.push(`private/outside link: ${location}`);
      } else if (local.startsWith('vendor/deepseek-harness/')) {
        // CI intentionally does not initialize the optional source submodule.
        // Reject inner-file links even when the developer has it checked out;
        // use a pinned upstream URL instead. The gitlink directory itself is OK.
        problems.push(`optional submodule content link (use a pinned upstream URL): ${location}`);
      } else if (!existsSync(path)) problems.push(`missing: ${location}`);
    }
  }
  assert.deepEqual(problems, []);
});
