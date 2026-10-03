// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
for (const name of ['myrix-business', 'myrix-development', 'myrix-ui-design']) {
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

// UI 规范是界面改动的共享约束；这些字符串一旦丢失，说明安全/证据口径被删改。
// 每条断言带“为什么”：正则匹配失败即该规范项不再可被 Agent 读到。
const UI_STANDARD_REQUIRED = [
  { file: '.agents/skills/myrix-ui-design/SKILL.md', pattern: /不得/, reason: '必须保留强制语气，避免规范退化成建议' },
  { file: 'docs/development/ui-design.md', pattern: /rehype-raw/, reason: '安全 Markdown 必须显式禁止 rehype-raw' },
  { file: 'docs/development/ui-design.md', pattern: /dangerouslySetInnerHTML/, reason: '必须显式禁止 HTML 注入面' },
  { file: 'docs/development/ui-design.md', pattern: /远程图片|远程.*请求/, reason: '必须禁止阅读时自动请求远程图片' },
  { file: 'docs/development/ui-design.md', pattern: /12px/, reason: '次要信息最小可读字号必须写成硬下限' },
  { file: 'docs/development/ui-design.md', pattern: /36px[\s\S]*44px/, reason: '桌面/移动命中尺寸下限必须同时给出' },
  { file: 'docs/development/ui-design.md', pattern: /未保存正文/, reason: '未保存正文不自动发送是内容授权边界' },
  { file: 'docs/development/ui-design.md', pattern: /Ctrl\/Cmd\+S/, reason: '保存快捷键是作者任务的基本要求' },
  { file: 'docs/development/ui-design.md', pattern: /冻结/, reason: '修改目标必须在发送时冻结，含新会话等待' },
  { file: 'docs/development/ui-design.md', pattern: /截图/, reason: '浏览器桌面/移动检查与截图是验收条件' },
  { file: 'docs/development/ui-design.md', pattern: /计费|授权/, reason: '真实模型计费必须事先授权' },
  { file: 'docs/development/ui-design.md', pattern: /未实现/, reason: '规范必须诚实标注尚未实现的条目' },
];

test('ui design standard keeps its safety, sizing, target and evidence contract', async () => {
  for (const { file, pattern, reason } of UI_STANDARD_REQUIRED) {
    const source = await readFile(resolve(root, file), 'utf8');
    assert.match(source, pattern, `${file} 缺少：${reason}`);
  }
});

test('maintainer deployment skill and evidence stay excluded from Git and Docker', async () => {
  const git = await readFile(resolve(root, '.gitignore'), 'utf8');
  const docker = await readFile(resolve(root, '.dockerignore'), 'utf8');
  assert.match(git, /^\/\.agents\/skills\/myrix-deploy\/$/m);
  assert.match(git, /^\/docs\/local\/$/m);
  assert.match(docker, /^\.agents\/skills\/myrix-deploy\/?$/m);
  assert.match(docker, /^docs\/local\/?$/m);
  // Do not require the ignored local skill to exist in a fresh clone/CI checkout.
});
