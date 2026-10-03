/** Real local browser acceptance. No request interception, fake model, direct SQL or credential files. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { openBook, shelfOf, verifyBusinessEditing } from './business-journey.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const origin = process.env.MYRIX_ACCEPTANCE_ORIGIN ?? 'http://127.0.0.1:8787';
assert.equal(origin, 'http://127.0.0.1:8787', 'This acceptance runner only targets the explicitly provisioned local Myrix stack');
const api = `${origin}/api/v1`;
const withModel = process.env.MYRIX_ACCEPTANCE_MODEL === '1';
/** 统一 Agent 没有 preset 选择；会话在首条消息发送时创建，因此 messages 的 sessionId 只能按 UUID 形状等待。 */
const SESSION_MESSAGE_PATH = /^\/api\/v1\/sessions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/messages$/i;
const run = `browser-${Date.now()}`;
const directory = resolve(root, 'data/acceptance', run);
await mkdir(directory, { recursive: true, mode: 0o700 });
const osKeys = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ', 'SYSTEMROOT', 'WINDIR'];
const env = Object.fromEntries(osKeys.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
const browser = await chromium.launch({ headless: true, env });
const result = { run, origin, withModel, checks: [], screenshots: [], workId: null, sessionId: null, passed: false };
let mainPage;
const errors = [];
async function login(user, label) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'zh-CN' });
  const page = await context.newPage();
  if (!mainPage) mainPage = page;
  page.setDefaultTimeout(20_000);
  page.on('pageerror', () => errors.push('Uncaught browser application error'));
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: label, exact: true }).click();
  await shelfOf(page).waitFor();
  const session = await context.request.get(`${api}/auth/session`);
  assert.equal(session.status(), 200, `Login failed for ${user}`);
  assert.equal((await session.json()).mode, 'development');
  return { context, page };
}
async function screenshot(page, name) {
  const path = resolve(directory, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  result.screenshots.push(path);
}
try {
  const health = await fetch(`${api}/auth/config`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).mode, 'development', 'Refusing to test another authentication mode');
  const { context, page } = await login('author', '作者 author');
  mainPage = page;
  result.checks.push('Real browser development login and opaque server session');
  const title = `浏览器验收-${run}`;
  // 登录后唯一入口是书架：新建书本 → dialog（书名 + 简介，简介 label 含“选填”）→ 创建并开始写作 → 直接进入书内 studio。
  await shelfOf(page).getByRole('button', { name: '新建书本', exact: true }).click();
  const createDialog = page.getByRole('dialog');
  await createDialog.getByLabel('书名', { exact: true }).fill(title);
  await createDialog.getByLabel('简介').fill('独立验收作品；保留供人工检查。');
  const created = page.waitForResponse(response => response.url() === `${api}/works` && response.request().method() === 'POST');
  await createDialog.getByRole('button', { name: '创建并开始写作', exact: true }).click();
  const createResponse = await created;
  assert.equal(createResponse.status(), 201);
  result.workId = (await createResponse.json()).id;
  assert.match(result.workId, /^[a-f0-9-]{36}$/);
  const outlineUrl = `${api}/works/${result.workId}/outline`;
  await page.getByRole('button', { name: '大纲', exact: true }).click();
  const editor = page.getByLabel('作品大纲', { exact: true }).locator('[contenteditable="true"]');
  const text = `验收大纲 ${run}。灯塔守护者在风暴中寻找失踪的航船。`;
  await editor.fill(text);
  const saved = page.waitForResponse(response => response.url() === outlineUrl && response.request().method() === 'PUT');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  assert.equal((await saved).status(), 200);
  const persisted = await context.request.get(outlineUrl);
  assert.equal((await persisted.json()).text, text);
  result.checks.push('Create work and save plain-text outline through UI into the real BFF');
  // 刷新后回到书架（书内选择不持久化），再显式打开书本。
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openBook(page, title);
  await page.getByRole('button', { name: '大纲', exact: true }).click();
  await page.getByRole('article', { name: '作品大纲阅读', exact: true }).waitFor();
  assert.equal(await page.getByRole('article', { name: '作品大纲阅读', exact: true }).innerText(), text);
  await page.getByRole('button', { name: '编辑原文', exact: true }).click();
  await editor.waitFor();
  assert.equal(await editor.innerText(), text);
  result.checks.push('Reload preserves the authenticated session and stored outline');
  await verifyBusinessEditing({ page, context, workId: result.workId, title, text, run, api, login, checks: result.checks });

  for (const [user, label] of [['editor', '编辑 editor'], ['other-tenant', '其它租户 other-tenant']]) {
    const isolated = await login(user, label);
    const response = await isolated.context.request.get(`${api}/works/${result.workId}`);
    const expectedStatus = user === 'editor' ? 403 : 404;
    assert.equal(response.status(), expectedStatus, `${user} must not read the author's work`);
    const denied = await response.text();
    assert.ok(!denied.includes(title) && !denied.includes(text), 'Denied response must not contain work content');
    const listing = await isolated.context.request.get(`${api}/works`);
    assert.equal(listing.status(), 200);
    assert.ok(!(await listing.json()).items.some(work => work.id === result.workId));
    result.checks.push(`${user}: independent browser cookie jar, hidden work and direct GET ${expectedStatus} without content`);
    await isolated.context.close();
  }

  if (withModel) {
    const marker = `模型工具落库-${run}`;
    const targetText = `${marker}：灯塔守护者救回了失踪的航船。`;
    const commandText = `请调用 get_outline 读取当前作品大纲及版本，再调用 update_outline 将大纲完整替换为“${targetText}”。必须实际保存到作品，不能只在回复中给草稿。不要调用其他工具，保存后简短确认。`;
    await page.getByLabel('消息输入', { exact: true }).fill(commandText);

    // 统计本轮触发的 outline GET：业务缓存刷新必须是"每回合有限次"，
    // 而不是历史回放里每条持久事件各刷一次。
    let outlineGets = 0;
    const countOutlineGet = response => {
      if (response.url() === outlineUrl && response.request().method() === 'GET') outlineGets += 1;
    };
    page.on('response', countOutlineGet);

    // 统一 Agent：没有 preset grid，首条消息直接进输入框；**发送按钮**才会新建
    // novel-assistant 会话，并等事件流真正连上后再投递消息。
    // 会话 id 在点击前未知，因此 messages 的 URL 只能用 UUID 形状等待；
    // create 与 send 两个 waiter 都必须在 click 之前建立，绝不先 await 创建再点发送。
    const sessionCreated = page.waitForResponse(response => response.url() === `${api}/works/${result.workId}/sessions` && response.request().method() === 'POST', { timeout: 60_000 });
    const queued = page.waitForResponse(response => response.request().method() === 'POST' && SESSION_MESSAGE_PATH.test(new URL(response.url()).pathname), { timeout: 60_000 });
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const sessionResponse = await sessionCreated;
    assert.equal(sessionResponse.status(), 201);
    const createdSession = await sessionResponse.json();
    assert.equal(createdSession.preset, 'novel-assistant', 'The unified Agent session must be created as novel-assistant');
    result.sessionId = createdSession.id;
    assert.match(result.sessionId, /^[a-f0-9-]{36}$/);
    const queuedResponse = await queued;
    assert.equal(queuedResponse.status(), 202);
    const commandId = (await queuedResponse.json()).commandId;
    assert.match(commandId, /^[0-9a-f-]{36}$/);

    // 等**持久**（带 seq）的用户消息出现。
    //
    // 这里**不**断言 `data-turn-outcome` 必须先观察到 'none'：极快的模型可能在
    // 202 响应落地后立刻完成整个回合，瞬态 none 窗口根本不出现（竞态）。
    // 新建会话不存在"上一轮残留"，"本轮从 none 开始"因此由单元测试
    // （chatReducer：appendPendingCommand/持久 user 开启新回合）保证，
    // 而不是靠真实验收里一次可被竞态跳过的采样。
    //
    // 等待时只认带 `data-seq` 的持久气泡：本机 pending 占位没有 seq，
    // 若先等 pending 再断言"恰好一条"就会把正常的替换过程误判成重复。
    await page.locator('[data-testid="chat-log"] .msg.user[data-seq] .msg-text').filter({ hasText: marker }).first().waitFor({ timeout: 20_000 });

    /**
     * 持久用户消息恰好一条、且没有本机 pending 副本。
     *
     * BFF 把 driver `user/message` 的 `data.id` 投影成公开 `commandId`，
     * 前端据此按 commandId 精确替换（不是靠正文匹配去重）。若投影缺失，
     * 同一句话会同时以"已入队等待服务端确认"与持久 seq 两种形态出现。
     */
    const userBubbles = await page.evaluate(() => {
      const log = document.querySelector('[data-testid="chat-log"]');
      if (!log) return null;
      return [...log.querySelectorAll('.msg.user')].map(node => ({
        text: (node.querySelector('.msg-text')?.textContent ?? '').trim(),
        seq: node.getAttribute('data-seq'),
        pending: (node.querySelector('.msg-meta')?.textContent ?? '').includes('已入队'),
      }));
    });
    result.userMessages = userBubbles;
    const markerBubbles = (userBubbles ?? []).filter(bubble => bubble.text.includes(marker));
    assert.equal(markerBubbles.length, 1, `The persisted user message must appear exactly once: ${JSON.stringify(userBubbles)}`);
    assert.equal(markerBubbles[0].pending, false, 'A confirmed user message must not keep its local pending copy');
    assert.ok(markerBubbles[0].seq !== null && markerBubbles[0].seq !== '', 'The single user message must be the durable one (with seq)');
    assert.equal((userBubbles ?? []).filter(bubble => bubble.pending).length, 0, 'No pending placeholder may survive the durable echo');
    result.checks.push('Exactly one durable user message in the chat log; the local pending placeholder is replaced by commandId, not by text matching');

    /**
     * 严格等待**服务端终态**，再断言"真实非空最终正文"。
     *
     * - `data-turn-outcome` 只由持久终态驱动：`turn/end` → completed、
     *   带 seq 的 error → failed、interrupted / session-ended 同理。
     *   stream-start / chunk / 工具调用一律不产生终态（保持 `none`），
     *   因此**不可能**在工具执行中就被当成完成——这正是上一轮验收的缺陷。
     * - 终态与它的消息在 React 里是同一次提交：一旦 outcome 出现，
     *   该回合已持久化的正文都已落定，因此不需要额外 sleep。
     * - completed 但正文为空是明确失败（失败得快、信息精确），
     *   而不是熬到 180 秒超时把中间态掩盖过去。
     * - 180 秒是服务端边界；超时后打印当次快照。
     */
    const readRound = () => page.evaluate(() => {
      const log = document.querySelector('[data-testid="chat-log"]');
      if (!log) return null;
      const texts = [...log.querySelectorAll('.msg.assistant:not(.streaming) .msg-text')]
        .map(node => (node.textContent ?? '').trim());
      return {
        outcome: log.getAttribute('data-turn-outcome'),
        turnActive: log.getAttribute('data-turn-active') === 'true',
        turnPublicText: log.getAttribute('data-turn-public-text') === 'true',
        streaming: log.querySelectorAll('.msg.assistant.streaming').length,
        toolMessages: log.querySelectorAll('.msg.tool').length,
        assistantMessages: log.querySelectorAll('.msg.assistant:not(.streaming)').length,
        emptyAssistantMessages: texts.filter(text => text.length === 0).length,
        finalTexts: texts.filter(text => text.length > 0),
      };
    });
    const settled = await page.waitForFunction(() => {
      const log = document.querySelector('[data-testid="chat-log"]');
      if (!log) return false;
      const outcome = log.getAttribute('data-turn-outcome');
      return outcome !== null && outcome !== 'none';
    }, undefined, { timeout: 180_000, polling: 250 }).then(() => true, () => false);
    const round = await readRound();
    result.modelRound = {
      outcome: round?.outcome ?? null,
      turnActive: round?.turnActive ?? null,
      toolMessages: round?.toolMessages ?? null,
      assistantMessages: round?.assistantMessages ?? null,
      emptyAssistantMessages: round?.emptyAssistantMessages ?? null,
      publicTextMessages: round?.finalTexts.length ?? null,
    };
    if (!settled) {
      throw new Error(`Timed out after 180s waiting for a durable turn terminal state: ${JSON.stringify(result.modelRound)}`);
    }
    // 工具调用只作为过程记录展示；它既不是助手正文，也不代表本回合完成。
    assert.equal(round.emptyAssistantMessages, 0, 'UI must not render an assistant bubble without public text');
    if (round.outcome !== 'completed') {
      throw new Error(`Model round did not complete normally: ${round.outcome} (still generating: ${round.turnActive})`);
    }
    assert.equal(round.turnActive, false, 'A completed turn must not still be marked as generating');
    assert.ok(round.finalTexts.length > 0, 'A completed turn must carry at least one non-empty public assistant message');
    assert.equal(round.turnPublicText, true, 'A completed turn must have committed public assistant text');
    // 运行标签必须离开瞬态的 stream-start，落到持久终态。
    result.runStatus = await page.evaluate(() => {
      const pills = [...document.querySelectorAll('.statusbar .status-pill')];
      const run = pills.find(pill => (pill.querySelector('strong')?.textContent ?? '') === '运行');
      return run?.querySelector('span:last-child')?.textContent ?? null;
    });
    assert.ok(
      typeof result.runStatus === 'string' && /本轮已完成/.test(result.runStatus),
      `The run pill must settle on the durable terminal state, not a transient stream-start: ${JSON.stringify(result.runStatus)}`,
    );
    result.checks.push(`Model round settled on durable turn-end with ${round.finalTexts.length} public assistant message(s) and ${round.toolMessages} tool record(s)`);

    /**
     * 模型通过真实工具写入了大纲（版本推进），编辑器必须读取**服务端**新文本。
     *
     * 关键约束：
     *   - 编辑器内容来自 `GET /works/:id/outline`，绝不用模型回复正文去填；
     *   - 干净编辑器（本轮没有未保存草稿）应显示新的目标文本与新版本；
     *   - 刷新是有界的（每回合有限次），因此顺带断言本轮 outline GET 次数很少。
     */
    const modelSaved = await context.request.get(outlineUrl);
    assert.equal(modelSaved.status(), 200);
    const savedOutline = await modelSaved.json();
    assert.ok(savedOutline.text.includes(marker), 'Assistant text alone is not proof of a successful tool write');
    result.checks.push('Real Cell + Responses model + get_outline/update_outline + works/PostgreSQL + durable assistant SSE');

    const editorText = () => page.evaluate(() => document.querySelector('[aria-label="作品大纲"] [contenteditable="true"]')?.innerText ?? null);
    const editorShowsTarget = await page.waitForFunction(
      // innerText 用换行分隔 ProseMirror 的段落，与 PlainTextEditor 的
      // `getText({ blockSeparator: '\n' })` 约定一致；只容忍结尾空行差异。
      expected => {
        const shown = document.querySelector('[aria-label="作品大纲"] [contenteditable="true"]')?.innerText ?? null;
        return shown === expected || (shown !== null && shown.replace(/\n+$/, '') === expected.replace(/\n+$/, ''));
      },
      savedOutline.text,
      { timeout: 30_000, polling: 250 },
    ).then(() => true, () => false);
    if (!editorShowsTarget) {
      throw new Error(`Editor did not adopt the server outline after a durable tool write: ${JSON.stringify(await editorText())}`);
    }
    const shownVersion = await page.evaluate(() => {
      const toolbar = document.querySelector('.editor .toolbar .small.muted')?.textContent ?? '';
      return toolbar;
    });
    assert.ok(
      shownVersion.includes(`已保存版本 ${savedOutline.version}`),
      `Editor must show the server version after refresh: ${JSON.stringify(shownVersion)}`,
    );
    assert.ok(
      !shownVersion.includes('有未保存修改'),
      `A clean editor that adopted the server text must not be marked dirty: ${JSON.stringify(shownVersion)}`,
    );
    result.editorAfterModel = { text: await editorText(), version: savedOutline.version, toolbar: shownVersion, outlineGets };
    // 有界刷新：一次终态 = 一次合并后的读取（绝不是"每条事件一次 GET"）。
    assert.ok(outlineGets >= 1, 'A durable turn end must trigger exactly one bounded refresh of the work outline');
    assert.ok(outlineGets <= 3, `Refreshing must stay bounded per turn, got ${outlineGets} outline GETs`);
    result.checks.push(`Persisted turn-end refreshed the work outline exactly ${outlineGets} time(s); the clean editor then showed server text v${savedOutline.version} (never model reply text)`);

    // 会话卡不能一直停在"创建中"：历史对话面板默认收起，先点开再读会话条目的服务端状态。
    const historyToggle = page.getByRole('button', { name: '历史对话', exact: true });
    if ((await historyToggle.getAttribute('aria-expanded')) !== 'true') await historyToggle.click();
    await page.locator('.conversation-history').waitFor();
    const sessionShowsActive = await page.waitForFunction(
      () => [...document.querySelectorAll('.conversation-history .item .item-sub')]
        .some(item => (item.textContent ?? '').includes('活跃')),
      undefined,
      { timeout: 20_000, polling: 250 },
    ).then(() => true, () => false);
    assert.ok(sessionShowsActive, 'The session card must leave the transient "创建中" state once the stream is live');
    result.checks.push('Session card reflects the server-observed active binding instead of staying on "创建中"');

    // 截图必须准确：此时编辑器已显示服务器新文本，用户消息恰好一条。
    await screenshot(page, 'model-tool-roundtrip');
    page.off('response', countOutlineGet);

    // 会话操作默认收起：展开当前对话操作，确认“永久结束对话”的 window.confirm，再等 DELETE 204。
    const sessionOptions = page.locator('.session-options');
    if (!(await sessionOptions.evaluate(node => node.open))) await sessionOptions.locator('summary').click();
    page.once('dialog', dialog => dialog.accept());
    const revoked = page.waitForResponse(response => response.url() === `${api}/sessions/${result.sessionId}` && response.request().method() === 'DELETE');
    await page.getByRole('button', { name: '永久结束对话', exact: true }).click();
    assert.equal((await revoked).status(), 204);
    result.checks.push('Browser session revocation accepted by the real BFF');
  }
  await screenshot(page, 'workbench');
  assert.equal(errors.length, 0, 'Browser application raised uncaught errors');
  result.passed = true;
} catch (error) {
  result.error = String(error?.message ?? 'Browser acceptance failed').slice(0, 1200);
  if (mainPage && !mainPage.isClosed()) await screenshot(mainPage, 'failure').catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(resolve(directory, 'report.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
}
