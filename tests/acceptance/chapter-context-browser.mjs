/**
 * 真实本地浏览器验收：章节助手上下文（ChapterAssistantContext）。
 *
 * 覆盖：
 *   - 真实 GUI 开发登录（auth mode 必须为 development）；
 *   - 通过 UI 新建独立作品与两个章节 A/B（A 保存 v1 正文，B 保持空 v0）；
 *   - 展开折叠的“章节助手上下文（查看与复制）”：只读、只含作品/章节 ID + 标题 + 脏提示，
 *     正文绝不进入上下文；dirty 随未保存草稿显隐；切 B 再切 A 后 ID/标题/复制提示均无残留；
 *   - 用户点击“复制章节上下文”：若浏览器支持并显示成功，回读本次剪贴板且**仅当**
 *     与可见 textarea 严格相等时才使用；否则走组件提示的手动选中路径并如实记 manual，
 *     绝不把未知剪贴板内容发给模型或写进报告；
 *   - 最终 prompt 只由当前 A 的可见上下文文本 + 唯一目标正文 marker 组成（不从 HTTP 隐式注入 ID）；
 *   - 真实 Cell + Responses 模型经 GUI 发送：持久带 seq 用户回显恰好一条且无 pending 副本、
 *     持久 completed 终态、非空持久 assistant、get_chapter 与 save_chapter_draft 工具记录；
 *   - 公共 HTTP 独立确认 A 正文精确、版本推进 + 历史、B 文本/版本不变；
 *   - 干净编辑器自动采用服务端新正文/版本且无未保存标记，chapterA GET 刷新 1..3 次有界；
 *   - UI 撤销 204，随后公共 HTTP 发消息 410（CSRF 只从 auth/session 取到内存）。
 *
 * 边界：不读 .env/vendor、不直连 SQL、不 mock 路由或模型、不降低限流、不用 chat/completions、
 * 不把 cookie/CSRF/凭证/私钥写进报告；失败时如实保存 report 并非零退出。
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const origin = process.env.MYRIX_ACCEPTANCE_ORIGIN ?? 'http://127.0.0.1:8787';
const api = `${origin}/api/v1`;

// ---------------------------------------------------------------------------
// 预检：显式 opt-in 与目标 origin 必须在**任何网络 / 建目录 / 浏览器之前**判定。
// 这里刻意不静态 import playwright：拒绝路径不会加载任何浏览器代码。
// ---------------------------------------------------------------------------
assert.equal(
  process.env.MYRIX_ACCEPTANCE_MODEL,
  '1',
  'Explicit real-model opt-in required: run with MYRIX_ACCEPTANCE_MODEL=1 (this acceptance sends a real model turn)',
);
assert.equal(
  origin,
  'http://127.0.0.1:8787',
  'This acceptance runner only targets the explicitly provisioned local Myrix stack at http://127.0.0.1:8787',
);

const run = `chapter-context-browser-${Date.now()}`;
const acceptanceRoot = resolve(root, 'data/acceptance');
const directory = resolve(acceptanceRoot, run);
assert.match(directory, new RegExp(`^${acceptanceRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/chapter-context-browser-[0-9]+$`));
await mkdir(directory, { recursive: true, mode: 0o700 });

const report = {
  acceptance: 'chapter-context-browser (real browser UI + real model, public HTTP verification)',
  run,
  origin,
  checks: [],
  fixtures: {},
  modelRound: null,
  clipboard: null,
  chapterAGetsDuringTurn: null,
  requestCount: null,
  launchError: null,
  screenshots: [],
  limitations: [
    '只覆盖本地开发栈的开发登录、章节助手上下文面板与一次真实模型回合；不代表生产 OIDC/多租户行为。',
    '报告只记录测试 fixture 标识、公开事件摘要与必要截图，不含 cookie / CSRF / 令牌 / 正文草稿内容。',
    '剪贴板若被环境拒绝，则如实记录 manual 模式（使用可见 textarea 文本），不声称剪贴板回读成功。',
  ],
  passed: false,
};

let browserApiRequests = 0;
let directApiRequests = 0;
let mainPage;
const errors = [];

/** 公共 HTTP GET（与浏览器 context 共享 cookie jar），计入请求数。 */
async function apiGet(path) {
  directApiRequests += 1;
  return context.request.get(`${api}${path}`);
}

function contextDetails(page) {
  return page
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: '章节助手上下文（查看与复制）' }) })
    .first();
}

/** 展开章节助手上下文并返回 textarea；折叠状态由 <details> 控制。 */
async function openContext(page) {
  const details = contextDetails(page);
  await details.waitFor({ state: 'attached' });
  if (!(await details.evaluate(element => element.open))) {
    await details.locator('summary').click();
  }
  const textarea = details.getByLabel('章节助手上下文', { exact: true });
  await textarea.waitFor({ state: 'visible' });
  return { details, textarea };
}

/** 等待上下文文本满足包含/排除条件（React 状态更新是异步的）。 */
async function waitForContext(page, includes, excludes = []) {
  await page.waitForFunction(
    ({ includes: must, excludes: mustNot }) => {
      const details = [...document.querySelectorAll('details')].find(node =>
        node.querySelector('summary')?.textContent?.includes('章节助手上下文（查看与复制）'),
      );
      const value = details?.querySelector('textarea[aria-label="章节助手上下文"]')?.value ?? null;
      if (value === null) return false;
      return must.every(item => value.includes(item)) && mustNot.every(item => !value.includes(item));
    },
    { includes, excludes },
    { timeout: 15_000, polling: 100 },
  );
}

function chapterEditor(page, title) {
  return page.getByLabel(`章节正文：${title}`).locator('[contenteditable="true"]');
}

async function selectChapter(page, title) {
  await page.locator('.workspace-column button.item').filter({ hasText: title }).click();
  await page.getByLabel(`章节正文：${title}`).waitFor();
}

async function screenshot(page, name) {
  const path = resolve(directory, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  report.screenshots.push(`${run}/${name}.png`);
  return path;
}

const workTitle = `章节上下文验收-${run}`;
const chapterATitle = `甲章-${run}`;
const chapterBTitle = `乙章-${run}`;
const savedBodyA = `A-已保存正文-${run}`;
const draftLineA = `A-未保存草稿-${run}`;

let context;
let browser = null;
let workId = null;
let chapterA = null;
let chapterB = null;
let sessionId = null;

try {
  // 只有预检全部通过、目录已建并 opt-in 后，才加载 Playwright 与启动浏览器。
  const { chromium } = await import('playwright');
  // 浏览器只继承白名单 OS 环境；上游模型 key/凭证不会被带入浏览器进程。
  const osKeys = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ', 'SYSTEMROOT', 'WINDIR'];
  const env = Object.fromEntries(osKeys.flatMap(key => (process.env[key] === undefined ? [] : [[key, process.env[key]]])));
  try {
    browser = await chromium.launch({ headless: true, env });
  } catch (error) {
    // 浏览器本身装不起来也是诚实失败：保存 report 并非零退出，不假装通过。
    report.launchError = String(error?.message ?? 'Playwright launch failed').slice(0, 500);
    throw error;
  }

  // 1) 真实开发登录：先看公开 config，再从真实 GUI 点开发身份按钮。
  const config = await fetch(`${api}/auth/config`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  assert.equal(config.status, 200, 'Local development stack must be reachable');
  assert.equal((await config.json()).mode, 'development', 'Refusing to run against any non-development auth mode');

  context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    locale: 'zh-CN',
    // 真实浏览器权限授予（不是 mock）：用于验证“复制章节上下文”的剪贴板回读路径。
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  mainPage = page;
  page.setDefaultTimeout(20_000);
  page.on('pageerror', () => errors.push('Uncaught browser application error'));
  page.on('request', request => {
    if (request.url().startsWith(api)) browserApiRequests += 1;
  });

  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '作者 author', exact: true }).click();
  await page.getByRole('region', { name: '作品列表', exact: true }).waitFor();
  const sessionResponse = await apiGet('/auth/session');
  assert.equal(sessionResponse.status(), 200, 'Real GUI development login must establish an opaque server session');
  assert.equal((await sessionResponse.json()).mode, 'development', 'Refusing to continue without development auth mode');
  report.checks.push('真实 GUI 开发登录成功；auth/session 明确为 development（cookie/CSRF 只存内存）');

  // 2) 通过 UI 新建独立作品。
  const list = page.getByRole('region', { name: '作品列表', exact: true });
  await list.getByLabel('标题', { exact: true }).fill(workTitle);
  await list.getByLabel('简介', { exact: true }).fill('章节助手上下文独立验收 fixture；保留供人工检查，不删除。');
  const createdWork = page.waitForResponse(response => response.url() === `${api}/works` && response.request().method() === 'POST');
  await list.getByRole('button', { name: '创建作品', exact: true }).click();
  const workResponse = await createdWork;
  assert.equal(workResponse.status(), 201);
  workId = (await workResponse.json()).id;
  assert.match(workId, /^[a-f0-9-]{36}$/);
  report.fixtures.work = { id: workId, title: workTitle };
  report.checks.push('通过真实 UI 新建独立作品');

  // 3) 章节 A：UI 新建并保存 v1 正文。
  await page.getByRole('tab', { name: '章节', exact: true }).click();
  await page.getByLabel('新章节标题').fill(chapterATitle);
  const createdChapterA = page.waitForResponse(response => response.url() === `${api}/works/${workId}/chapters` && response.request().method() === 'POST');
  await page.getByRole('button', { name: '新建章节', exact: true }).click();
  const chapterAResponse = await createdChapterA;
  assert.equal(chapterAResponse.status(), 201);
  chapterA = await chapterAResponse.json();
  assert.equal(chapterA.version, 0, 'A new chapter must start at version 0');
  await chapterEditor(page, chapterATitle).waitFor();
  await chapterEditor(page, chapterATitle).fill(savedBodyA);
  const savedChapterA = page.waitForResponse(response => response.url() === `${api}/works/${workId}/chapters/${chapterA.id}` && response.request().method() === 'PUT');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  assert.equal((await savedChapterA).status(), 200);
  const persistedA = await apiGet(`/works/${workId}/chapters/${chapterA.id}`);
  assert.equal(persistedA.status(), 200);
  const persistedAJson = await persistedA.json();
  assert.equal(persistedAJson.text, savedBodyA, 'A must be persisted at v1 with the saved body');
  assert.equal(persistedAJson.version, 1);
  report.fixtures.chapterA = { id: chapterA.id, title: chapterATitle, initialVersion: chapterA.version, savedVersion: persistedAJson.version };
  report.checks.push('通过真实 UI 新建章节 A 并保存已保存正文 v1（随后由公共 HTTP 独立确认）');

  // 4) 展开上下文：只读、ID/标题正确、不含正文、dirty=无。
  let { details, textarea } = await openContext(page);
  assert.equal(await textarea.evaluate(element => element.readOnly), true, 'The context textarea must be readOnly');
  let contextValue = await textarea.inputValue();
  assert.match(contextValue, /【章节助手上下文】/);
  assert.ok(contextValue.includes(`作品ID：${workId}`), 'Visible context must carry the real work id');
  assert.ok(contextValue.includes(`章节ID：${chapterA.id}`), 'Visible context must carry the real chapter id');
  assert.ok(contextValue.includes(`章节标题：${chapterATitle}`), 'Visible context must carry the chapter title');
  assert.ok(!contextValue.includes(savedBodyA), 'Chapter body must never enter the assistant context');
  assert.ok(contextValue.includes('未保存草稿：无'), 'A clean editor must report no unsaved draft');
  const detailGroup = await details.locator('[role="group"]').innerText();
  assert.ok(detailGroup.includes(workId) && detailGroup.includes(chapterA.id) && detailGroup.includes(chapterATitle));
  report.checks.push('展开折叠面板：只读 textarea 含作品ID/章节ID/标题，明确不含正文，干净状态显示“未保存草稿：无”');

  // 5) dirty 提示：有未保存文本时变“有”且不含草稿；恢复已保存文本后回到“无”。
  await chapterEditor(page, chapterATitle).fill(`${savedBodyA}\n${draftLineA}`);
  await waitForContext(page, ['未保存草稿：有'], [draftLineA]);
  contextValue = await textarea.inputValue();
  assert.ok(contextValue.includes('未保存草稿：有'));
  assert.ok(!contextValue.includes(draftLineA), 'The unsaved draft text must not be copied into the context');
  assert.ok(!contextValue.includes(savedBodyA), 'The saved body must not be copied into the context either');
  await chapterEditor(page, chapterATitle).fill(savedBodyA);
  await waitForContext(page, ['未保存草稿：无'], [draftLineA]);
  report.checks.push('未保存草稿时 dirty 提示为“有”且上下文不含草稿/正文；恢复已保存文本后 dirty 回到“无”');

  // 6) 复制动作由用户点击触发：仅当成功且回读与可见文本严格相等时才采用剪贴板内容。
  await details.getByRole('button', { name: '复制章节上下文', exact: true }).click();
  const status = details.getByRole('status');
  await status.waitFor({ state: 'visible', timeout: 5000 });
  const statusText = await status.innerText();
  // 复制结果落定后重新读取**当前可见** textarea：剪贴板内容只有与它严格相等才可信。
  const visibleContext = await textarea.inputValue();
  let copyMode = 'manual';
  let copyNote = 'component-informed-manual-selection';
  let capturedContext = null;
  if (statusText !== null && statusText.includes('已复制')) {
    const clipboardText = await page
      .evaluate(async () => {
        try {
          return await navigator.clipboard.readText();
        } catch {
          return null;
        }
      })
      .catch(() => null);
    if (typeof clipboardText === 'string') {
      // 错误复制不能伪装为环境降级；仅断言布尔值，绝不把未知剪贴板正文写进错误报告。
      assert.ok(clipboardText === visibleContext, 'Successful clipboard readback must equal the visible context');
      copyMode = 'clipboard';
      copyNote = 'clipboard-readback-equals-visible-textarea';
      capturedContext = clipboardText;
    } else {
      copyNote = 'clipboard-readback-unavailable';
    }
  } else {
    assert.ok(statusText.includes('手动选中') && statusText.includes('复制'), 'Clipboard rejection must show an explicit manual-copy hint');
    copyNote = 'component-manual-selection-hint';
  }
  if (copyMode === 'manual') {
    // 走组件给出的显式手动选中路径：全选可见文本（不声称剪贴板成功）。
    const selected = await textarea.evaluate(element => {
      element.focus();
      element.select();
      return element.value.slice(element.selectionStart, element.selectionEnd);
    });
    assert.equal(selected, visibleContext, 'Manual path must be able to select exactly the visible context text');
    capturedContext = selected;
  } else {
    assert.equal(capturedContext, visibleContext);
  }
  report.clipboard = { mode: copyMode, note: copyNote };
  report.checks.push(
    copyMode === 'clipboard'
      ? '用户点击复制后回读本次剪贴板，内容与可见 textarea 严格相等才采用'
      : `复制回读不可用：如实走手动选中路径（mode=${copyMode}），未声称剪贴板成功，也未记录任何未知剪贴板内容`,
  );

  // 7) 切 B 再切 A：上下文准确更新，旧 ID 与复制提示均无残留。
  await page.getByLabel('新章节标题').fill(chapterBTitle);
  const createdChapterB = page.waitForResponse(response => response.url() === `${api}/works/${workId}/chapters` && response.request().method() === 'POST');
  await page.getByRole('button', { name: '新建章节', exact: true }).click();
  const chapterBResponse = await createdChapterB;
  assert.equal(chapterBResponse.status(), 201);
  chapterB = await chapterBResponse.json();
  assert.equal(chapterB.version, 0, 'B must start at empty v0');
  assert.equal(chapterB.text, '', 'B must start with empty text');
  await chapterEditor(page, chapterBTitle).waitFor();
  report.fixtures.chapterB = { id: chapterB.id, title: chapterBTitle, initialVersion: chapterB.version };
  report.checks.push('通过真实 UI 新建章节 B，保持空正文 v0');

  ({ details, textarea } = await openContext(page));
  let bContext = await textarea.inputValue();
  assert.ok(bContext.includes(`章节ID：${chapterB.id}`) && bContext.includes(`章节标题：${chapterBTitle}`));
  assert.ok(!bContext.includes(chapterA.id), 'Switching to B must not leave A chapter id in the context');
  assert.equal(await details.getByRole('status').count(), 0, 'A fresh chapter context must not show a stale copy status');
  assert.equal((await chapterEditor(page, chapterBTitle).innerText()).trim(), '', 'B editor must be empty');

  await selectChapter(page, chapterATitle);
  ({ details, textarea } = await openContext(page));
  const aContext = await textarea.inputValue();
  assert.ok(aContext.includes(`章节ID：${chapterA.id}`) && aContext.includes(`章节标题：${chapterATitle}`));
  assert.ok(!aContext.includes(chapterB.id), 'Switching back to A must not leave B chapter id in the context');
  assert.equal(await details.getByRole('status').count(), 0, 'The copy status must not survive a chapter switch (no stale hint)');
  assert.ok(aContext.includes('未保存草稿：无'), 'A restored to the saved body must be clean again');
  await chapterEditor(page, chapterATitle).filter({ hasText: savedBodyA }).waitFor();
  assert.equal((await chapterEditor(page, chapterATitle).innerText()).trim(), savedBodyA, 'Switching back must restore saved A v1, not the old empty v0 cache');
  report.checks.push('切 B 再切 A 后上下文 ID/标题准确更新，无旧 ID、无旧复制提示残留；A 显示已保存 v1 正文且仍为干净状态');

  // 8) 真实模型回合：prompt 只由当前 A 的可见上下文文本 + 唯一目标正文 marker 组成。
  assert.equal(aContext, capturedContext, 'After returning to A, the visible context must still match the explicitly copied/selected context');
  const targetText = `A-TARGET-BODY-${randomUUID()}`;
  const prompt = [
    capturedContext,
    '',
    '请只处理上面这个章节：把它的正文完整替换为下面这一行纯文本（唯一内容就是一个标记，前后不要有空格、标题或换行）：',
    targetText,
    '要求：必须先调用 get_chapter 读取该章节当前已保存内容与版本，再用刚读到的 expectedVersion 调用 save_chapter_draft 保存上面的完整正文；不要改动其他章节。保存成功后只用一句话回复已保存的版本号。',
  ].join('\n');
  report.fixtures.targetMarker = targetText;

  await page.getByTestId('preset-option').filter({ hasText: '章节写作' }).click();
  const createdSession = page.waitForResponse(response => response.url() === `${api}/works/${workId}/sessions` && response.request().method() === 'POST');
  await page.getByRole('button', { name: '新建会话（章节写作）', exact: true }).click();
  const sessionCreateResponse = await createdSession;
  assert.equal(sessionCreateResponse.status(), 201);
  const created = await sessionCreateResponse.json();
  assert.equal(created.preset, 'novel-chapter');
  sessionId = created.id;
  report.fixtures.session = { id: sessionId, preset: created.preset };

  // 会话卡离开“创建中”= 事件流订阅成功 = 服务端绑定已 active（真实证据，不是猜测）。
  const sessionActive = await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll('[aria-label="创作助手"] .list .item')].some(item =>
          (item.querySelector('.item-sub')?.textContent ?? '').includes('活跃'),
        ),
      undefined,
      { timeout: 60_000, polling: 250 },
    )
    .then(() => true, () => false);
  assert.ok(sessionActive, 'The session card must leave "创建中" before the turn is sent (server-observed active binding)');

  await page.getByLabel('消息输入', { exact: true }).fill(prompt);

  // 只统计本轮触发的 chapterA GET（精确匹配，排除 /versions）：刷新必须有界。
  let chapterAGets = 0;
  const countChapterAGet = response => {
    if (response.request().method() === 'GET' && response.url() === `${api}/works/${workId}/chapters/${chapterA.id}`) chapterAGets += 1;
  };
  page.on('response', countChapterAGet);

  const queued = page.waitForResponse(response => response.url() === `${api}/sessions/${sessionId}/messages` && response.request().method() === 'POST');
  await page.getByRole('button', { name: '提交', exact: true }).click();
  const queuedResponse = await queued;
  assert.equal(queuedResponse.status(), 202, 'The BFF must accept the queued command');
  assert.match((await queuedResponse.json()).commandId, /^[0-9a-f-]{36}$/);

  // 只认带 data-seq 的持久用户回显；不断言瞬态 none 窗口（快速模型可能跳过它）。
  await page
    .locator('[data-testid="chat-log"] .msg.user[data-seq] .msg-text')
    .filter({ hasText: targetText })
    .first()
    .waitFor({ timeout: 60_000 });

  const readUserBubbles = () => page.evaluate(() => {
    const log = document.querySelector('[data-testid="chat-log"]');
    if (!log) return null;
    return [...log.querySelectorAll('.msg.user')].map(node => ({
      text: (node.querySelector('.msg-text')?.textContent ?? '').trim(),
      seq: node.getAttribute('data-seq'),
      pending: (node.querySelector('.msg-meta')?.textContent ?? '').includes('已入队'),
    }));
  });
  const userBubbles = await readUserBubbles();
  const markerBubbles = (userBubbles ?? []).filter(bubble => bubble.text.includes(targetText));
  assert.equal(markerBubbles.length, 1, `The persisted user message must appear exactly once: ${JSON.stringify(userBubbles)}`);
  assert.equal(markerBubbles[0].pending, false, 'A confirmed user message must not keep its local pending copy');
  assert.ok(markerBubbles[0].seq !== null && markerBubbles[0].seq !== '', 'The single user message must be the durable one (with seq)');
  assert.equal((userBubbles ?? []).filter(bubble => bubble.pending).length, 0, 'No pending placeholder may survive the durable echo');
  report.checks.push('持久带 seq 用户回显恰好一条且无 pending 副本（由 commandId 替换，不靠正文去重）');

  const readRound = () => page.evaluate(() => {
    const log = document.querySelector('[data-testid="chat-log"]');
    if (!log) return null;
    const assistants = [...log.querySelectorAll('.msg.assistant:not(.streaming)')];
    const texts = assistants.map(node => (node.querySelector('.msg-text')?.textContent ?? '').trim());
    const toolNodes = [...log.querySelectorAll('.msg.tool')];
    return {
      outcome: log.getAttribute('data-turn-outcome'),
      turnActive: log.getAttribute('data-turn-active') === 'true',
      turnPublicText: log.getAttribute('data-turn-public-text') === 'true',
      streaming: log.querySelectorAll('.msg.assistant.streaming').length,
      toolMessages: toolNodes.length,
      toolNames: toolNodes.map(node => ({
        text: (node.querySelector('.msg-meta')?.textContent ?? '').trim(),
        seq: node.getAttribute('data-seq'),
      })),
      assistantMessages: assistants.length,
      emptyAssistantMessages: texts.filter(text => text.length === 0).length,
      finalTexts: texts.filter(text => text.length > 0),
    };
  });

  const settled = await page
    .waitForFunction(
      () => {
        const log = document.querySelector('[data-testid="chat-log"]');
        if (!log) return false;
        const outcome = log.getAttribute('data-turn-outcome');
        return outcome !== null && outcome !== 'none';
      },
      undefined,
      { timeout: 180_000, polling: 250 },
    )
    .then(() => true, () => false);
  const round = await readRound();
  report.modelRound = {
    outcome: round?.outcome ?? null,
    turnActive: round?.turnActive ?? null,
    toolMessages: round?.toolMessages ?? null,
    toolNames: (round?.toolNames ?? []).map(entry => entry.text),
    assistantMessages: round?.assistantMessages ?? null,
    emptyAssistantMessages: round?.emptyAssistantMessages ?? null,
    publicTextMessages: round?.finalTexts.length ?? null,
    maxAssistantChars: round?.finalTexts.length ? Math.max(...round.finalTexts.map(text => text.length)) : 0,
  };
  if (!settled) {
    throw new Error(`Timed out after 180s waiting for a durable turn terminal state: ${JSON.stringify(report.modelRound)}`);
  }
  // 空助手泡/仅工具记录都不算完成：必须持久 completed + 非空公开 assistant。
  assert.equal(round.emptyAssistantMessages, 0, 'UI must not render an assistant bubble without public text');
  if (round.outcome !== 'completed') {
    throw new Error(`Model round did not complete normally: ${round.outcome} (still generating: ${round.turnActive})`);
  }
  assert.equal(round.turnActive, false, 'A completed turn must not still be marked as generating');
  assert.ok(round.finalTexts.length > 0, 'A completed turn must carry at least one non-empty public assistant message');
  assert.equal(round.turnPublicText, true, 'A completed turn must have committed public assistant text');
  const toolText = (round.toolNames ?? []).map(entry => entry.text).join('\n');
  assert.ok(toolText.includes('get_chapter'), `The round must record a get_chapter tool call: ${JSON.stringify(round.toolNames)}`);
  assert.ok(toolText.includes('save_chapter_draft'), `The round must record a save_chapter_draft tool call: ${JSON.stringify(round.toolNames)}`);
  const firstToolSeq = name => {
    const sequences = round.toolNames.filter(entry => entry.text.includes(name)).map(entry => Number(entry.seq));
    assert.ok(sequences.length > 0 && sequences.every(seq => Number.isSafeInteger(seq) && seq > 0), 'Tool evidence must carry durable positive sequence numbers');
    return Math.min(...sequences);
  };
  const readSeq = firstToolSeq('get_chapter');
  const writeSeq = firstToolSeq('save_chapter_draft');
  assert.ok(readSeq > Number(markerBubbles[0].seq) && writeSeq > readSeq, 'Durable tool evidence must show user -> get_chapter -> save_chapter_draft order');
  report.modelRound.readSeq = readSeq;
  report.modelRound.writeSeq = writeSeq;
  const finalUsers = await readUserBubbles();
  assert.equal(finalUsers?.length, 1, 'The completed round must still have exactly one user bubble');
  assert.ok(finalUsers[0].text.includes(targetText) && finalUsers[0].seq !== null && !finalUsers[0].pending, 'A late 202 must not recreate a pending duplicate after durable completion');
  report.checks.push(
    `真实模型回合持久 completed，${round.finalTexts.length} 条非空 assistant，${round.toolMessages} 条工具记录含 get_chapter + save_chapter_draft（工具记录不被当作完成）`,
  );

  // 运行态标签必须落到持久终态“本轮已完成”。
  const runStatus = await page.evaluate(() => {
    const pills = [...document.querySelectorAll('.statusbar .status-pill')];
    const runPill = pills.find(pill => (pill.querySelector('strong')?.textContent ?? '') === '运行');
    return runPill?.querySelector('span:last-child')?.textContent ?? null;
  });
  assert.ok(
    typeof runStatus === 'string' && /本轮已完成/.test(runStatus),
    `The run pill must settle on the durable terminal state: ${JSON.stringify(runStatus)}`,
  );
  report.runStatus = runStatus;

  // 9) 公共 HTTP 独立确认：A 精确正文、版本推进 + 历史；B 文本/版本不变。
  const chapterAfter = await apiGet(`/works/${workId}/chapters/${chapterA.id}`);
  assert.equal(chapterAfter.status(), 200);
  const chapterAfterJson = await chapterAfter.json();
  assert.equal(chapterAfterJson.text, targetText, 'Persisted A text must be exactly the target marker');
  assert.equal(chapterAfterJson.version, persistedAJson.version + 1, 'A version must advance by exactly one');
  const versions = await apiGet(`/works/${workId}/chapters/${chapterA.id}/versions`);
  assert.equal(versions.status(), 200);
  const versionItems = (await versions.json()).items;
  assert.ok(versionItems.some(item => item.version === persistedAJson.version && item.text === savedBodyA), 'History must keep the saved v1 body');
  assert.ok(versionItems.some(item => item.version === chapterAfterJson.version && item.text === targetText), 'History must carry the new target body');
  const chapterBAfter = await apiGet(`/works/${workId}/chapters/${chapterB.id}`);
  assert.equal(chapterBAfter.status(), 200);
  const chapterBAfterJson = await chapterBAfter.json();
  assert.equal(chapterBAfterJson.text, '', 'B must remain empty');
  assert.equal(chapterBAfterJson.version, 0, 'B version must not change');
  report.fixtures.chapterA.finalVersion = chapterAfterJson.version;
  report.fixtures.chapterB.finalVersion = chapterBAfterJson.version;
  report.checks.push('公共 HTTP 独立确认：A 正文精确等于 marker、版本 +1、历史含 v1 与新版本；B 文本/版本不变');

  // 10) 干净编辑器自动采用服务端新正文/版本，且本轮 chapterA GET 有界（1..3）。
  const editorText = () => page.evaluate(() => document.querySelector('.workspace-column .editor [aria-label^="章节正文"] [contenteditable="true"]')?.innerText ?? null);
  const editorAdopted = await page
    .waitForFunction(
      expected => {
        const shown = document.querySelector('.workspace-column .editor [contenteditable="true"]')?.innerText ?? null;
        if (shown === null) return false;
        const normalize = value => value.replace(/\n+$/, '');
        return normalize(shown) === normalize(expected);
      },
      targetText,
      { timeout: 30_000, polling: 250 },
    )
    .then(() => true, () => false);
  if (!editorAdopted) {
    throw new Error(`Clean chapter editor did not adopt the server body after the durable tool write: ${JSON.stringify(await editorText())}`);
  }
  const shownToolbar = await page.evaluate(() => document.querySelector('.workspace-column .editor .toolbar .small.muted')?.textContent ?? '');
  assert.ok(shownToolbar.includes(`已保存版本 ${chapterAfterJson.version}`), `Editor must show the server version: ${JSON.stringify(shownToolbar)}`);
  assert.ok(!shownToolbar.includes('有未保存修改'), `A clean editor that adopted server text must not be dirty: ${JSON.stringify(shownToolbar)}`);
  page.off('response', countChapterAGet);
  report.chapterAGetsDuringTurn = chapterAGets;
  assert.ok(chapterAGets >= 1, 'A durable turn end must trigger a bounded refresh of chapter A');
  assert.ok(chapterAGets <= 3, `Chapter A refresh must stay bounded per turn, got ${chapterAGets} GETs`);
  report.checks.push(`持久终态后干净编辑器自动显示服务端正文 v${chapterAfterJson.version} 且无未保存标记；本轮 chapterA GET ${chapterAGets} 次（1..3 有界，不含 versions）`);

  const sessionStillActive = await page.evaluate(() =>
    [...document.querySelectorAll('[aria-label="创作助手"] .list .item')].some(item =>
      (item.querySelector('.item-sub')?.textContent ?? '').includes('活跃'),
    ),
  );
  assert.ok(sessionStillActive, 'The session card must still report the server-observed active binding after the turn');

  // 断言完成后再截图（model 回合后：编辑器与上下文一致）。
  await screenshot(page, 'model-roundtrip');

  // 11) UI 撤销会话 204；随后公共 HTTP 发消息必须 410。
  const revoked = page.waitForResponse(response => response.url() === `${api}/sessions/${sessionId}` && response.request().method() === 'DELETE');
  await page.getByRole('button', { name: '撤销会话', exact: true }).click();
  assert.equal((await revoked).status(), 204, 'UI session revocation must be accepted by the real BFF');

  const authSession = await apiGet('/auth/session');
  assert.equal(authSession.status(), 200);
  const { csrfToken } = await authSession.json();
  assert.ok(typeof csrfToken === 'string' && csrfToken.length > 0);
  directApiRequests += 1;
  const denied = await context.request.post(`${api}/sessions/${sessionId}/messages`, {
    headers: { origin, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    data: { commandId: randomUUID(), text: '撤销后不得再投递' },
  });
  assert.equal(denied.status(), 410, 'A revoked session must reject new messages with 410');
  report.checks.push('GUI 撤销会话返回 204；随后公共 HTTP（CSRF 仅内存）发消息得到 410');
  await screenshot(page, 'after-revocations');

  // 12) 整套请求数保持在一个 120/min 窗口以内。
  const total = browserApiRequests + directApiRequests;
  report.requestCount = { browser: browserApiRequests, direct: directApiRequests, total };
  assert.ok(total <= 80, `Whole acceptance must stay under the 120/min window with margin, got ${total} API requests`);

  assert.equal(errors.length, 0, 'Browser application raised uncaught errors');
  report.passed = true;
} catch (error) {
  report.error = String(error?.message ?? 'Chapter context browser acceptance failed').slice(0, 1500);
  if (mainPage && !mainPage.isClosed()) await screenshot(mainPage, 'failure').catch(() => undefined);
  process.exitCode = 1;
} finally {
  // 尽力通过 GUI 正常登出；绝不读取/记录任何令牌。浏览器无论如何都会关闭。
  try {
    if (mainPage && !mainPage.isClosed()) {
      const logout = mainPage.getByRole('button', { name: '退出登录', exact: true });
      if (await logout.isVisible().catch(() => false)) {
        await logout.click({ timeout: 3000 }).catch(() => undefined);
      }
    }
  } catch {
    // 登出失败不影响验收结论：cookie jar 随 context/browser 关闭而销毁。
  }
  await context?.close().catch(() => undefined);
  await browser?.close();
  await writeFile(resolve(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
