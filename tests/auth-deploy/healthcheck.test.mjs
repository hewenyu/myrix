// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'

const compose = readFileSync(new URL('../../deploy/auth/compose.auth.yml', import.meta.url), 'utf8')
const health = JSON.parse(compose.match(/^\s+test: (\[[^\n]+\])$/m)[1])

// This exercises the real shell probe, not a Keycloak instance. Full first-boot
// readiness still requires the official post-merge Actions image acceptance.
for (const [status, body, expected] of [[200, '{"status":"UP"}', 0], [503, '{"status":"DOWN","checks":[{"status":"UP"}]}', 1]]) {
  test(`Keycloak readiness shell requires HTTP 200 (fixture status ${status})`, { timeout: 5000 }, async t => {
    assert.deepEqual(health.slice(0, 3), ['CMD', '/bin/bash', '-ec'])
    assert.ok(health[3].includes('"$$status"'), 'Compose must not interpolate the shell status variable')
    const server = createServer(socket => {
      // The probe intentionally closes after the status line without consuming
      // the response body; macOS can report that close as a peer reset.
      socket.on('error', error => assert.equal(error.code, 'ECONNRESET'))
      socket.once('data', () => socket.end(
        `HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Service Unavailable'}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      ))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    t.after(() => new Promise(resolve => server.close(resolve)))
    const script = health[3].replaceAll('$$', '$').replace('/127.0.0.1/9000', `/127.0.0.1/${server.address().port}`)
    const child = spawn(health[1], [health[2], script], { stdio: 'ignore' })
    const [code] = await once(child, 'exit')
    assert.equal(code, expected)
  })
}
