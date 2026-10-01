// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0
/**
 * Keycloak image regression: explicit build-time settings must match the
 * runtime environment the deploy factory generates.
 *
 * Background (production startup failure, Keycloak 26.8 `start --optimized`):
 * `KC_METRICS_ENABLED` is a BUILD-TIME option. When the factory exports
 * `KC_METRICS_ENABLED=false` at runtime but the image build never persisted a
 * metrics value, Keycloak aborts on boot with
 *   "The following build time options have values that differ from what is
 *    persisted ... kc.metrics-enabled"
 * We therefore require the Dockerfile to persist the same explicit `false`.
 *
 * These tests are pure `node --test` string assertions: no Docker, no network,
 * no image pull, no service start, and no real secret (fixture values only).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { createAuthConfig } from '../../deploy/auth/auth-config.ts'

const dockerfile = readFileSync(new URL('../../deploy/images/Dockerfile.keycloak', import.meta.url), 'utf8')

/** Build-time options Keycloak persists in the optimized image. */
const BUILD_TIME_OPTIONS = ['KC_DB', 'KC_HEALTH_ENABLED', 'KC_METRICS_ENABLED']

/** Parse the `ENV a=1 \ b=2` block that precedes `kc.sh build` into a map. */
function parseBuildTimeEnv(text) {
  const buildAt = text.search(/^RUN .*kc\.sh build\b/m)
  assert.ok(buildAt > 0, 'Dockerfile must run kc.sh build')
  const before = text.slice(0, buildAt)
  const env = {}
  for (const raw of before.split('\n')) {
    const line = raw.trim().replace(/\\$/, '').replace(/^ENV\s+/, '').trim()
    const entry = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/)
    if (entry) env[entry[1]] = entry[2]
  }
  return env
}

const buildTimeEnv = parseBuildTimeEnv(dockerfile)

/** Runtime env the factory emits for the same build-time options. */
function runtimeEnv() {
  const config = createAuthConfig({
    domain: 'myrix.example.test',
    clientId: 'myrix-bff',
    clientSecret: 'bff-client-secret-value-0001',
    ownerId: '11111111-1111-4111-8111-111111111111',
    ownerUsername: 'owner',
    ownerPassword: 'owner-temporary-password-0001',
    keycloakDbPassword: 'keycloak-db-password-0001',
    keycloakAdminUsername: 'kcadmin',
    keycloakAdminPassword: 'keycloak-admin-password-0001',
    images: {
      keycloak: `docker.io/hewenyulucky/myrix:keycloak-sha-${'a'.repeat(40)}`,
      postgres: 'postgres:17.6-alpine',
    },
  })
  return config.keycloakPublicEnv
}

test('every explicit build-time option is persisted before kc.sh build', () => {
  for (const option of BUILD_TIME_OPTIONS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(buildTimeEnv, option),
      `Dockerfile.keycloak must persist build-time ${option}; an omitted value is what breaks start --optimized`,
    )
    assert.notEqual(buildTimeEnv[option], '', `${option} must not be empty`)
  }
})

test('explicit build-time settings match generated runtime defaults exactly', () => {
  const runtime = runtimeEnv()
  for (const option of BUILD_TIME_OPTIONS) {
    assert.equal(
      buildTimeEnv[option],
      runtime[option],
      `${option} differs between image build (${buildTimeEnv[option]}) and generated runtime env (${runtime[option]})`,
    )
  }
})

test('metrics stay explicitly disabled: build false, runtime false, never true', () => {
  // The regression that caused the VPS restart: runtime false with an unset
  // build value. Require the exact false on both sides.
  assert.equal(buildTimeEnv.KC_METRICS_ENABLED, 'false')
  assert.equal(runtimeEnv().KC_METRICS_ENABLED, 'false')
  assert.doesNotMatch(dockerfile, /KC_METRICS_ENABLED=(true|"true")/, 'metrics must never be enabled in the image')
})

test('the image is optimized at build time and startup never rebuilds', () => {
  assert.match(dockerfile, /^RUN \/opt\/keycloak\/bin\/kc\.sh build\b/m)
  assert.equal((dockerfile.match(/^RUN .*kc\.sh build\b/gm) ?? []).length, 1, 'build must run exactly once, at image build')
  assert.match(dockerfile, /CMD \["start", "--optimized", "--import-realm"\]/)
  const runtimeCommand = `${dockerfile}\n${JSON.stringify(runtimeEnv())}`
  assert.doesNotMatch(runtimeCommand, /(start|run).*\bbuild\b/, 'no container may run kc.sh build at startup')
})
