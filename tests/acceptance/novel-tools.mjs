/**
 * 真实本地 BFF + 真实 Responses 模型：章节/设定四个写读工具的**公共 HTTP** 验收。
 *
 * 只用 `docs/implementation/bff-api.md` 与 `apps/novel-web/src/api/endpoints.ts` 里的公开路径；
 * 不写 SQL、不读 .env/私有 runtime 配置、不用 mock/私有 API、不启停开发服务、不用 chat/completions、不降低限流。
 * 开发登录 Cookie 与 CSRF 只在内存里，不进报告、不回显上游或原始 body。
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const origin = 'http://127.0.0.1:8787';
const api = `${origin}/api/v1`;

// 显式 opt-in 必须在**任何联网之前**：没有它，本进程不会打开任何 socket。
assert.equal(process.env.MYRIX_ACCEPTANCE_MODEL, '1', 'Explicit real-model opt-in required: MYRIX_ACCEPTANCE_MODEL=1');

const acceptanceRoot = resolve(root, 'data/acceptance');
const directory = resolve(acceptanceRoot, `novel-tools-${Date.now()}`);
assert.match(directory, new RegExp(`^${acceptanceRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/novel-tools-[0-9]+$`));
await mkdir(directory, { recursive: true, mode: 0o700 });

const report = {
  acceptance: 'novel-tools (public HTTP, real model)',
  origin,
  cursorStart: 0,
  assertions: [],
  rounds: [],
  limitations: [
    '这是公共 HTTP 模型工具验收：只证明真实模型经 BFF 调用四个工具后的持久结果，不是 UI 章节上下文验收（不覆盖前端选中章节/编辑器上下文与交互）。',
    '不覆盖运行时内部实现、SQL、私有端点或模型网关协议细节。',
  ],
  passed: false,
};
const users = new Map();

async function login(user) {
  if (users.has(user)) return users.get(user);
  const response = await fetch(`${api}/auth/dev-login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ user }), signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200, `Development login: ${user}`);
  const cookie = response.headers.getSetCookie().find(value => value.startsWith('myrix_session='))?.split(';')[0];
  const body = await response.json();
  assert.ok(cookie && body.csrfToken, 'Development login must return an opaque cookie and CSRF token');
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

const ALLOWED_KEYS = new Set(['type', 'seq', 'text', 'status', 'toolName', 'commandId']);
const TERMINAL_STATUS = /^(interrupted|revoked|session-ended)/;

/** 一轮 SSE：cursor 固定 0；只有 409 session_not_active / 503 session_reopening 有界退避，其余立即失败。 */
async function turn(user, sid, commandId, text) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  let reader;
  try {
    let response;
    let retryDelay = 250;
    for (;;) {
      response = await fetch(`${api}/sessions/${sid}/events`, { headers: { ...await login(user), 'last-event-id': '0' }, signal: controller.signal });
      if (response.status !== 409 && response.status !== 503) break;
      const expected = response.status === 409 ? 'session_not_active' : 'session_reopening';
      assert.equal((await response.json()).error, expected, 'Only documented activation/reopening transients are retryable; 500/403 and generic 503 must fail immediately');
      await delay(retryDelay, undefined, { signal: controller.signal });
      retryDelay = Math.min(retryDelay * 2, 4000);
    }
    assert.equal(response.status, 200, 'Real BFF SSE must open');
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
    reader = response.body.getReader();
    let buffer = '';
    let last = 0;
    const decoder = new TextDecoder();
    const events = [];
    while (true) {
      const item = await reader.read();
      assert.equal(item.done, false, 'Stream must not end before a durable turn-end');
      buffer += decoder.decode(item.value, { stream: true });
      assert.ok(buffer.length < 1000000, 'SSE frame buffer must stay bounded');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const payload = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!payload) continue;
        const event = JSON.parse(payload);
        assert.ok(Object.keys(event).every(key => ALLOWED_KEYS.has(key)), 'Only public fields may cross the BFF');
        assert.notEqual(event.type, 'error', 'Real model turn must not fail');
        if (event.type === 'status') {
          assert.ok(!TERMINAL_STATUS.test(event.status ?? ''), `Terminal status must fail the round: ${event.status}`);
          assert.notEqual(event.status, 'replay-required', 'A truncated durable replay cannot attest a tool round');
        }
        if (event.seq !== undefined) {
          assert.ok(Number.isSafeInteger(event.seq) && event.seq > last, 'Durable sequence must strictly advance, gaps allowed');
          last = event.seq;
        }
        events.push(event);
        if (event.type !== 'turn-end') continue;
        assert.ok(Number.isSafeInteger(event.seq), 'Only a durable turn-end can complete the round');
        const echoes = events.filter(value => value.type === 'user' && value.text === text);
        if (echoes.length === 0) continue; // 订阅前的旧轮次结束：不是本轮完成
        assert.equal(echoes.length, 1, 'Exactly one public echo of the sent user text');
        if (echoes[0].commandId !== undefined) assert.equal(echoes[0].commandId, commandId, 'Public user echo commandId must equal the sent UUID');
        assert.ok(Number.isSafeInteger(echoes[0].seq), 'User echo must be durable');
        assert.ok(events.some(value => value.type === 'assistant' && value.seq > echoes[0].seq && value.seq < event.seq && value.text?.trim()), 'This round needs a durable nonempty assistant after its own user echo and before turn-end');
        return { events, cursor: last };
      }
    }
  } finally { clearTimeout(timeout); controller.abort(); await reader?.cancel().catch(() => undefined); }
}

async function round(user, sid, text, requiredTools) {
  const commandId = randomUUID();
  await request(user, `/sessions/${sid}/messages`, 'POST', { commandId, text }, 202);
  const { events, cursor } = await turn(user, sid, commandId, text);
  const tools = events.filter(event => event.type === 'tool').map(event => ({ toolName: event.toolName, cursor: event.seq }));
  const firstCursor = name => tools.find(tool => tool.toolName === name)?.cursor;
  for (const name of requiredTools) assert.ok(firstCursor(name) !== undefined, `Real model must call ${name} with a durable seq`);
  // “必须读版本后 CAS 写”：读工具必须先于写工具出现，否则写就只能是猜版本。
  assert.ok(firstCursor(requiredTools[0]) < firstCursor(requiredTools[1]), `Real model must call ${requiredTools[0]} before ${requiredTools[1]}`);
  assert.ok(events.some(event => event.type === 'user' && event.text === text), 'Public user echo must carry the sent text');
  assert.equal(events[events.length - 1]?.type, 'turn-end', 'Round must end on a durable turn-end');
  report.rounds.push({ commandId, cursorStart: 0, cursor, toolCalls: tools, userEchoes: events.filter(event => event.type === 'user' && event.text === text).length, assistantDurableNonempty: true });
  return { cursor, tools };
}

try {
  const config = await fetch(`${api}/auth/config`, { signal: AbortSignal.timeout(5000) });
  assert.equal(config.status, 200, 'Local development stack must be reachable');
  assert.equal((await config.json()).mode, 'development', 'Refusing to run against any non-development auth mode');
  report.assertions.push('auth/config 明确为 development；未读取 .env 或私有 runtime 配置');
  await login('author');
  report.assertions.push('author 开发登录（Cookie/Origin/CSRF 仅存内存，不进报告）；未调用 chat/completions、未降低限流');

  const work = await request('author', '/works', 'POST', { title: `工具验收 ${Date.now()}`, description: '公共 HTTP 真实模型工具验收 fixture；保留供人工检查，不删除。' }, 201);
  report.workId = work.id;
  const chapter = await request('author', `/works/${work.id}/chapters`, 'POST', { title: `验收章节 ${Date.now()}` }, 201);
  const bible = await request('author', `/works/${work.id}/bible`, 'POST', { kind: 'character', title: `验收角色-${randomUUID()}`, text: '初始设定正文' }, 201);
  assert.equal(chapter.version, 0, 'New chapter starts at version 0');
  assert.equal(bible.version, 0, 'New bible entry starts at version 0');
  report.chapter = { id: chapter.id, title: chapter.title, initialVersion: chapter.version };
  report.bible = { id: bible.id, kind: bible.kind, title: bible.title, initialVersion: bible.version };
  report.assertions.push('保留 author 作品、章节与 character 设定（kind/title/text），初始版本已记录为 0');

  const chapterSession = await request('author', `/works/${work.id}/sessions`, 'POST', { preset: 'novel-chapter' }, 201);
  const bibleSession = await request('author', `/works/${work.id}/sessions`, 'POST', { preset: 'novel-bible' }, 201);
  assert.equal(chapterSession.preset, 'novel-chapter');
  assert.equal(bibleSession.preset, 'novel-bible');
  report.sessions = { chapter: { id: chapterSession.id, preset: chapterSession.preset }, bible: { id: bibleSession.id, preset: bibleSession.preset } };
  report.assertions.push('两个预设会话已创建：novel-chapter 与 novel-bible');

  // 1) get_chapter -> save_chapter_draft，纯文本唯一 marker，CAS 由模型先读版本
  const chapterMarker = `CHAPTER-MARKER-${randomUUID()}`;
  const chapterText = [
    '请在本作品内完成一次章节保存，必须按顺序调用工具：',
    `1. 调用 get_chapter，chapterId 必须是 ${chapter.id}；`,
    `2. 调用 save_chapter_draft，chapterId 必须是 ${chapter.id}，expectedVersion 必须用第 1 步读到的 version，text 必须**恰好**是下面这一行纯文本（唯一内容就是一个标记，前后不要有空格、标题或换行）：`,
    chapterMarker,
    '保存成功后只用一句话回复已保存的版本号。',
  ].join('\n');
  const chapterRound = await round('author', chapterSession.id, chapterText, ['get_chapter', 'save_chapter_draft']);
  report.assertions.push('chapter 回合：真实模型先 get_chapter 再 save_chapter_draft；公开用户回显恰好一条；持久 assistant 非空；以持久 turn-end 结束（工具事件不算完成）');

  const persisted = await request('author', `/works/${work.id}/chapters/${chapter.id}`);
  const versions = await request('author', `/works/${work.id}/chapters/${chapter.id}/versions`);
  assert.equal(persisted.id, chapter.id);
  assert.equal(persisted.text, chapterMarker, 'Persisted chapter text must be exactly the marker');
  assert.equal(persisted.version, chapter.version + 1, 'Persisted chapter version must be initial + 1');
  const matching = versions.items.filter(item => item.text === chapterMarker);
  assert.equal(matching.length, 1, 'Exactly one chapter history version must match the marker');
  assert.equal(matching[0].version, chapter.version + 1);
  report.chapter.savedVersion = persisted.version;
  report.chapter.matchingHistoryVersions = matching.length;
  report.chapter.toolCalls = chapterRound.tools;
  report.assertions.push('chapter 独立确认：BFF GET 文本精确等于 marker、版本 = 初始 + 1；versions 历史仅一条匹配');

  // 2) search_bible（唯一 title 标记）-> update_bible_entry
  const bibleMarker = `BIBLE-MARKER-${randomUUID()}`;
  const bibleText = [
    '请在本作品内更新一条既有设定，必须按顺序调用工具：',
    `1. 调用 search_bible，query 必须是 ${bible.title}；`,
    `2. 从检索结果里找到 title 等于 ${bible.title} 的那一条，记住它的 id 和 version；`,
    `3. 调用 update_bible_entry，entryId 用第 2 步的 id，expectedVersion 用第 2 步的 version，text 必须是下面两行（第一行是条目名称，必须原样保留、不得改名；第二行是标记，不得增删其他字符）：`,
    bible.title,
    bibleMarker,
    '保存成功后只用一句话回复已保存的版本号。',
  ].join('\n');
  const bibleRound = await round('author', bibleSession.id, bibleText, ['search_bible', 'update_bible_entry']);
  report.assertions.push('bible 回合：真实模型先 search_bible（唯一 title）再 update_bible_entry；公开用户回显恰好一条；持久 assistant 非空；以持久 turn-end 结束');

  const found = await request('author', `/works/${work.id}/bible?query=${encodeURIComponent(bible.title)}`);
  const entry = found.items.find(item => item.id === bible.id);
  assert.ok(entry, 'Search by the unique title must return the same entry id');
  assert.equal(entry.title, bible.title, 'Entry title must be preserved (first line of the saved text)');
  assert.equal(entry.kind, bible.kind);
  assert.equal(entry.text, `${bible.title}\n${bibleMarker}`, 'Entry text must exactly match the requested two lines');
  assert.equal(entry.version, bible.version + 1, 'Entry version must be initial + 1');
  report.bible.savedVersion = entry.version;
  report.bible.toolCalls = bibleRound.tools;
  report.assertions.push('bible 独立确认：bible?query=唯一 title 命中同一 id、文本含 marker、版本 = 初始 + 1');

  for (const session of [chapterSession, bibleSession]) {
    await request('author', `/sessions/${session.id}`, 'DELETE', undefined, 204);
    await request('author', `/sessions/${session.id}/messages`, 'POST', { commandId: randomUUID(), text: 'must not run after revoke' }, 410);
  }
  report.assertions.push('两个新建会话 DELETE 204；撤销后再发消息 410（不删除业务作品或既有数据）');
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? `${error.name}: ${error.message}` : 'Acceptance failure';
  process.exitCode = 1;
} finally {
  for (const user of users.keys()) await request(user, '/auth/logout', 'POST', undefined, 204).catch(() => undefined);
  report.finishedAt = new Date().toISOString();
  const path = resolve(directory, 'report.json');
  await writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ ...report, reportPath: path }, null, 2));
}
