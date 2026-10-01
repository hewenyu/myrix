// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const workflow = readFileSync(new URL('../../.github/workflows/docker.yml', import.meta.url), 'utf8');
const verify = workflow.split('\n  verify:\n')[1]?.split('\n  images:\n')[0];
const images = workflow.split('\n  images:\n')[1];

test('publication uses only the declared Docker Hub repository and environment credentials', () => {
  assert.match(workflow, /IMAGE: docker\.io\/hewenyulucky\/myrix\n/);
  assert.match(images, /environment: DOCKER\n/);
  assert.match(images, /username: \$\{\{ secrets\.USER \}\}/);
  assert.match(images, /password: \$\{\{ secrets\.TOKEN \}\}/);
  assert.match(images, /if: github\.event_name != 'pull_request' && github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);
  assert.doesNotMatch(workflow, /branches:.*feat|tags: \['v\*'\]/);
  assert.doesNotMatch(verify, /secrets\.|environment: DOCKER/);
  assert.match(images, /needs: verify/);
});

test('VPS runtime and pre-built login components have distinct tag namespaces', () => {
  assert.deepEqual([...images.matchAll(/- component: (\S+)/g)].map(m => m[1]), ['bff', 'gateway', 'cell', 'keycloak']);
  assert.match(images, /file: deploy\/images\/Dockerfile\.keycloak\n\s+target: keycloak/);
  assert.doesNotMatch(images, /component: cell-manager/);
  for (const target of ['bff', 'gateway', 'cell']) {
    assert.ok(images.includes(`target: ${target}\n`));
  }
  assert.match(images, /prefix=\$\{\{ matrix\.component \}\}-sha-/);
  assert.match(images, /flavor: latest=false/);
  assert.match(images, /value=\$\{\{ matrix\.component \}\}-latest,enable=\{\{is_default_branch\}\}/);
});

test('both architectures are built together and their published manifest is checked', () => {
  assert.match(images, /platforms: linux\/amd64,linux\/arm64/);
  assert.match(images, /push: true/);
  assert.match(images, /imagetools inspect "\$IMAGE@\$DIGEST" --raw/);
  assert.ok(images.includes('platforms.has("linux/amd64")'));
  assert.ok(images.includes('platforms.has("linux/arm64")'));
});

test('builds never restore or export caches and always pull the base image', () => {
  assert.match(images, /no-cache: true/);
  assert.match(images, /pull: true/);
  assert.match(images, /cache-image: false/);
  assert.match(images, /cache-binary: false/);
  assert.match(verify, /package-manager-cache: false/);
  assert.match(verify, /cache: false/);
  assert.match(verify, /go test -count=1/);
  assert.doesNotMatch(workflow, /cache-from:|cache-to:|actions\/cache@/);
});

test('all external actions are pinned to exact Git commits', () => {
  const actions = [...workflow.matchAll(/\buses: (\S+)/g)].map(m => m[1]);
  assert.ok(actions.length >= 8);
  for (const action of actions) assert.match(action, /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
  assert.match(workflow, /permissions:\n  contents: read\n/);
  assert.equal([...workflow.matchAll(/persist-credentials: false/g)].length, 2);
});

test('CI installs the locked DSH and runs PostgreSQL-backed gates before publication', () => {
  assert.match(verify, /pnpm install --frozen-lockfile/);
  assert.match(verify, /pnpm --dir tests\/poc\/\.dsh-install install --frozen-lockfile/);
  assert.match(verify, /CREATE ROLE myrix_bff_test LOGIN .* NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS/);
  for (const name of ['MYRIX_TEST_DATABASE_URL', 'BFF_TEST_DATABASE_URL', 'BFF_TEST_MIGRATION_DATABASE_URL', 'MYRIX_GATEWAY_TEST_DATABASE_URL']) {
    assert.match(verify, new RegExp(`${name}: postgres://`));
  }
  assert.match(verify, /pnpm typecheck\n\s+pnpm test/);
  assert.match(verify, /node --test tests\/ci\/\*\.test\.mjs tests\/containers\/\*\.test\.mjs tests\/vps\/\*\.test\.mjs tests\/auth-deploy\/\*\.test\.mjs/);
});

test('the runtime plugin compiler is an explicit frozen root dependency', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.devDependencies.esbuild, '0.28.2');
  const lock = readFileSync(new URL('../../pnpm-lock.yaml', import.meta.url), 'utf8');
  assert.match(lock.split('\n  apps/bff:')[0], /esbuild:\n\s+specifier: 0\.28\.2\n\s+version: 0\.28\.2/);
});

test('Keycloak is optimized at image build time with its fixed public path', () => {
  const dockerfile = readFileSync(new URL('../../deploy/images/Dockerfile.keycloak', import.meta.url), 'utf8');
  assert.match(dockerfile, /FROM quay\.io\/keycloak\/keycloak:26\.8\.0@sha256:[a-f0-9]{64} AS keycloak/);
  assert.match(dockerfile, /KC_HTTP_RELATIVE_PATH=\/auth/);
  assert.match(dockerfile, /KC_HTTP_MANAGEMENT_RELATIVE_PATH=\//);
  assert.match(dockerfile, /RUN \/opt\/keycloak\/bin\/kc\.sh build/);
  assert.match(dockerfile, /CMD \["start", "--optimized", "--import-realm"\]/);
  assert.match(dockerfile, /USER 1000/);
  assert.doesNotMatch(dockerfile, /--mount=type=cache/);
});
