// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0
//
// 回归：插件测试里直接 import 的 DSH 包，必须在对应 workspace manifest 中
// 显式声明并锁定精确版本。
//
// 背景：本地 node_modules/@deepseek-ai/* 存在指向 .dsh-types 的符号链接，
// 会把未声明的测试依赖“偷偷”解析成功；而干净的 CI 冻结安装只有真实
// workspace 依赖，于是 `tsc` 报 TS2307。这个测试断言真实声明，防止再次回归。
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const pluginDir = fileURLToPath(new URL('../../plugins', import.meta.url));
const lockfilePath = fileURLToPath(new URL('../../pnpm-lock.yaml', import.meta.url));

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const manifestPath = name => `${pluginDir}/${name}/package.json`;

// 六个插件里曾被发现“本地符号链接掩盖未声明测试依赖”的直接依赖。
// 只要求修复清单里的三处：其余插件当前已全部声明，由下方通用扫描守护。
const REQUIRED_TEST_DEV_DEPENDENCIES = {
  'myrix-binding-lease': ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-system-prompt'],
  'myrix-llm-gateway': ['@deepseek-ai/dsh-agent'],
};

const collectTsFiles = dir => {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = `${dir}/${entry}`;
    if (statSync(path).isDirectory()) files.push(...collectTsFiles(path));
    else if (/\.(ts|mts|cts)$/.test(entry)) files.push(path);
  }
  return files;
};

const importedDshPackages = file => {
  const source = readFileSync(file, 'utf8');
  const found = new Set();
  const pattern = /(?:from\s*|import\s*\(\s*)["'](@deepseek-ai\/[^"']+)["']/g;
  for (const match of source.matchAll(pattern)) found.add(match[1]);
  return found;
};

test('reported test-only DSH imports are declared as exact devDependencies', () => {
  for (const [plugin, packages] of Object.entries(REQUIRED_TEST_DEV_DEPENDENCIES)) {
    const manifest = readJson(manifestPath(plugin));
    const dependencies = manifest.dependencies ?? {};
    const devDependencies = manifest.devDependencies ?? {};
    for (const packageName of packages) {
      assert.ok(
        devDependencies[packageName],
        `${plugin} must declare ${packageName} in devDependencies (found: ${devDependencies[packageName] ?? 'nothing'})`,
      );
      assert.ok(
        EXACT_VERSION.test(devDependencies[packageName]),
        `${plugin} ${packageName} must be pinned to an exact version, got "${devDependencies[packageName]}"`,
      );
      assert.ok(
        !dependencies[packageName],
        `${plugin} ${packageName} is test-only and must not be a runtime dependency`,
      );
    }
  }
});

test('all workspace @deepseek-ai/dsh-* pins agree on one prerelease version', () => {
  const versions = new Set();
  for (const plugin of readdirSync(pluginDir)) {
    const manifestFile = manifestPath(plugin);
    if (!existsSync(manifestFile)) continue;
    const manifest = readJson(manifestFile);
    for (const section of [manifest.dependencies ?? {}, manifest.devDependencies ?? {}]) {
      for (const [name, version] of Object.entries(section)) {
        if (name.startsWith('@deepseek-ai/dsh-')) versions.add(version);
      }
    }
  }
  assert.equal(versions.size, 1, `DSH runtime pins drifted across manifests: ${[...versions].join(', ')}`);
});

test('every DSH package imported by plugin tests is declared in that plugin manifest', () => {
  const undeclared = [];
  for (const plugin of readdirSync(pluginDir)) {
    const manifestFile = manifestPath(plugin);
    if (!existsSync(manifestFile)) continue;
    const manifest = readJson(manifestFile);
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ]);
    const testsDir = `${pluginDir}/${plugin}/tests`;
    for (const file of collectTsFiles(testsDir)) {
      for (const packageName of importedDshPackages(file)) {
        if (!declared.has(packageName)) {
          undeclared.push(`${plugin}: ${packageName} (imported by ${file.slice(repoRoot.length)})`);
        }
      }
    }
  }
  assert.deepEqual(
    undeclared,
    [],
    `plugin tests import DSH packages that are not declared in the owning manifest:\n${undeclared.join('\n')}`,
  );
});

test('pnpm lockfile records the test devDependencies under the owning importers', () => {
  const lockfile = readFileSync(lockfilePath, 'utf8');
  const importerBlock = name => {
    const start = lockfile.indexOf(`\n  plugins/${name}:\n`);
    assert.ok(start >= 0, `lockfile is missing importer plugins/${name}`);
    const rest = lockfile.slice(start + 1);
    const nextImporter = rest.slice(1).search(/\n {2}\S/);
    return nextImporter >= 0 ? rest.slice(0, nextImporter + 1) : rest;
  };
  for (const [plugin, packages] of Object.entries(REQUIRED_TEST_DEV_DEPENDENCIES)) {
    const block = importerBlock(plugin);
    assert.match(block, /\n {4}devDependencies:\n/, `lockfile importer plugins/${plugin} is missing devDependencies`);
    for (const packageName of packages) {
      assert.ok(
        block.includes(`'${packageName}':`),
        `lockfile importer plugins/${plugin} is missing ${packageName}`,
      );
    }
  }
});
