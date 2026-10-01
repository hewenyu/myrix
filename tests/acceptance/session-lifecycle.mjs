/** Real local BFF + both Cells + real Responses. No SQL, runtime credentials or mock endpoints. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const origin = 'http://127.0.0.1:8787';
const api = `${origin}/api/v1`;
const mode = process.argv[2];
assert.ok(['prepare', 'verify'].includes(mode), 'Use prepare, then restart pnpm dev, then verify <manifest>');
assert.equal(process.env.MYRIX_ACCEPTANCE_MODEL, '1', 'Explicit real-model opt-in required');
const config = await fetch(`${api}/auth/config`, { signal: AbortSignal.timeout(5000) });
assert.equal(config.status, 200);
assert.equal((await config.json()).mode, 'development');
const users = new Map();
async function login(user) {
  if (users.has(user)) return users.get(user);
  const response = await fetch(`${api}/auth/dev-login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ user }), signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200, `Development login: ${user}`);
  const cookie = response.headers.getSetCookie().find(value => value.startsWith('myrix_session='))?.split(';')[0];
  const body = await response.json();
  assert.ok(cookie && body.csrfToken);
  const credentials = { cookie, 'x-csrf-token': body.csrfToken, origin };
  users.set(user, credentials);
  return credentials;
}
async function request(user, path, method = 'GET', body, status = 200) {
  const response = await fetch(`${api}${path}`, { method, headers: { ...await login(user), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, status, `${user} ${method} ${path}`);
  if (response.status === 204) return;
  return response.json();
}
async function turn(user, sid, cursor = 0) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  let reader;
  try {
    let response;
    let retryDelay = 250;
    let reopeningRetries = 0;
    for (;;) {
      response = await fetch(`${api}/sessions/${sid}/events`, { headers: { ...await login(user), 'last-event-id': String(cursor) }, signal: controller.signal });
      if (response.status !== 409 && response.status !== 503) break;
      const expected = response.status === 409 ? 'session_not_active' : 'session_reopening';
      assert.equal((await response.json()).error, expected, 'Only documented creation/reopening states are retryable; generic 503/permission failures must fail');
      if (response.status === 503) reopeningRetries += 1;
      // Respect the original 180s deadline without hammering the per-IP limiter.
      await delay(retryDelay, undefined, { signal: controller.signal });
      retryDelay = Math.min(retryDelay * 2, 4000);
    }
    assert.equal(response.status, 200, 'Real BFF SSE');
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
    reader = response.body.getReader();
    let buffer = '', last = cursor;
    const decoder = new TextDecoder();
    const events = [];
    while (true) {
      const item = await reader.read();
      assert.equal(item.done, false, 'Stream must not end before a durable turn-end');
      buffer += decoder.decode(item.value, { stream: true });
      assert.ok(buffer.length < 1000000);
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const payload = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!payload) continue;
        const event = JSON.parse(payload);
        const allowedKeys = new Set(['type', 'seq', 'text', 'status', 'toolName', 'commandId']);
        assert.ok(Object.keys(event).every(key => allowedKeys.has(key)), 'Only public fields may cross BFF');
        assert.notEqual(event.type, 'error', 'Real model turn must not fail');
        if (event.seq !== undefined) {
          assert.ok(Number.isSafeInteger(event.seq) && event.seq > last, 'Durable sequence must advance, allowing gaps');
          last = event.seq;
        }
        events.push(event);
        if (event.type === 'turn-end') {
          assert.ok(events.some(value => value.type === 'assistant' && value.seq !== undefined && value.text?.trim()), 'A durable nonempty assistant message is required');
          return { events, cursor: last, reopeningRetries };
        }
      }
    }
  } finally { clearTimeout(timeout); controller.abort(); await reader?.cancel().catch(() => undefined); }
}
async function send(user, sid, text) {
  return request(user, `/sessions/${sid}/messages`, 'POST', { commandId: randomUUID(), text }, 202);
}
const directory = mode === 'prepare' ? resolve(root, 'data/acceptance', `sessions-${Date.now()}`) : dirname(resolve(process.argv[3] ?? ''));
assert.match(directory, new RegExp(`^${resolve(root, 'data/acceptance').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/sessions-[0-9]+$`));
await mkdir(directory, { recursive: true, mode: 0o700 });
const report = { mode, checks: [], fixtures: [], passed: false };
try {
  const bootIds = await Promise.all([7801, 7802].map(async port => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/ready`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    const ready = await response.json();
    assert.equal(ready.ready, true);
    assert.match(ready.bootId, /^[a-f0-9-]{36}$/);
    return ready.bootId;
  }));
  assert.notEqual(bootIds[0], bootIds[1], 'Independent Cell boots');
  report.bootIds = bootIds;
  if (mode === 'prepare') {
    const fixtures = [];
    for (const user of ['author', 'other-tenant']) {
      const work = await request(user, '/works', 'POST', { title: `会话恢复验收 ${user} ${Date.now()}`, description: 'Independent durable lifecycle fixture; real model opt-in.' }, 201);
      const sessions = [];
      for (const preset of ['novel-outline', 'novel-chapter', 'novel-bible']) {
        const session = await request(user, `/works/${work.id}/sessions`, 'POST', { preset }, 201);
        assert.equal(session.preset, preset);
        sessions.push({ id: session.id, preset });
      }
      const sid = sessions[0].id;
      report.fixtures.push({ user, workId: work.id, sessions });
      const marker = `resume-${randomUUID()}`;
      const text = `请仅回复 ${marker}，不要调用工具。`;
      await send(user, sid, text);
      const completed = await turn(user, sid);
      assert.ok(completed.events.some(event => event.type === 'assistant' && event.text?.includes(marker)));
      assert.equal(completed.events.filter(event => event.type === 'user' && event.text === text).length, 1);
      fixtures.push({ user, workId: work.id, sessions, sid, marker, text, cursor: completed.cursor });
      report.checks.push(`${user}: three presets persisted; actual Responses turn completed in its own Cell`);
    }
    for (const fixture of fixtures) {
      const outsider = fixture.user === 'author' ? 'other-tenant' : 'author';
      await request(outsider, `/works/${fixture.workId}/sessions`, 'GET', undefined, 404);
      await request(outsider, `/sessions/${fixture.sid}/messages`, 'POST', { commandId: randomUUID(), text: 'must not run' }, 404);
      if (fixture.user === 'author') for (const sameTenant of ['editor', 'admin']) {
        await request(sameTenant, `/works/${fixture.workId}/sessions`, 'GET', undefined, 403);
        await request(sameTenant, `/sessions/${fixture.sid}/messages`, 'POST', { commandId: randomUUID(), text: 'must not run' }, 404);
      }
    }
    report.checks.push('Cross-tenant 404; same-tenant editor AND admin work-list 403 and private session 404; no admin impersonation bypass');
    await writeFile(resolve(directory, 'manifest.json'), JSON.stringify({ bootIds, fixtures }, null, 2), { mode: 0o600, flag: 'wx' });
  } else {
    assert.equal(resolve(process.argv[3]), resolve(directory, 'manifest.json'));
    const { bootIds: previousBoots, fixtures } = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
    assert.equal(previousBoots.length, bootIds.length);
    bootIds.forEach((bootId, index) => assert.notEqual(bootId, previousBoots[index], 'Must actually restart both Cells before verify'));
    report.checks.push('Both Cell boot IDs changed; this is a real process restart, not another live replay');
    for (const fixture of fixtures) {
      report.fixtures.push({ user: fixture.user, workId: fixture.workId, sessions: fixture.sessions });
      const listed = await request(fixture.user, `/works/${fixture.workId}/sessions`);
      for (const session of fixture.sessions) assert.ok(listed.items.some(value => value.id === session.id && value.preset === session.preset));
      const replay = await turn(fixture.user, fixture.sid);
      assert.equal(replay.cursor, fixture.cursor, 'Same original durable cursor after runtime restart');
      assert.equal(replay.events.filter(event => event.type === 'user' && event.text === fixture.text).length, 1);
      assert.ok(replay.events.some(event => event.type === 'assistant' && event.text?.includes(fixture.marker)));
      const next = `after-restart-${randomUUID()}`;
      await send(fixture.user, fixture.sid, `请仅回复 ${next}，不要调用工具。`);
      const resumed = await turn(fixture.user, fixture.sid, fixture.cursor);
      assert.ok(resumed.events.every(event => event.seq === undefined || event.seq > fixture.cursor));
      assert.ok(resumed.events.some(event => event.type === 'assistant' && event.text?.includes(next)));
      report.checks.push(`${fixture.user}: presets, original replay, cursor continuity and real model turn after restart; ${replay.reopeningRetries} explicit reopening wait response(s)`);
      for (const session of fixture.sessions) {
        await request(fixture.user, `/sessions/${session.id}`, 'DELETE', undefined, 204);
        await request(fixture.user, `/sessions/${session.id}/messages`, 'POST', { commandId: randomUUID(), text: 'must not run after revoke' }, 410);
      }
      report.checks.push(`${fixture.user}: every preset revoked; subsequent message denied`);
    }
  }
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : 'Acceptance failure';
  process.exitCode = 1;
} finally {
  for (const user of users.keys()) await request(user, '/auth/logout', 'POST', undefined, 204).catch(() => undefined);
  const path = resolve(directory, `${mode}-report-${Date.now()}.json`);
  await writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ ...report, directory }, null, 2));
}
