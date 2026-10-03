/**
 * 真实本地浏览器验收：自动“当前选中对象”目标（SelectionContext）。
 *
 * 覆盖：
 *   - 真实 GUI 开发登录（auth mode 必须为 development）；
 *   - 通过 UI 新建独立作品（书架 → 新建书本 → 书名/简介 → 创建并开始写作）与两个章节 A/B
 *     （A 保存 v1 正文，B 保持空 v0；有章节时“新建章节”表单先展开）；
 *   - 创作助手输入框上方的“当前修改目标”徽标自动显示当前选中章节标题（默认修改当前选中），
 *     不再有折叠的“章节助手上下文（查看与复制）”只读 textarea 或“复制章节上下文”按钮；
 *   - 章节正文采用阅读优先的 Manuscript：编辑器不在时先点“编辑原文”才进入可编辑态，
 *     `getByLabel(..., { exact: true })` 只命中编辑器 label，不会命中 `…阅读` 的 article；
 *   - 有未保存草稿时出现视觉 dirty 警告且目标仍指向当前章节，正文/草稿绝不进入徽标；
 *   - 切 B 再切 A 后目标标题随选中准确更新，无旧标题、无旧脏警告残留；
 *   - composer 只写自然语言指令（不含手动拼进去的 ID/标题）；真正发出的 payload 在内存中检查：
 *     指令 + 追加的【当前选中对象】元数据恰好是 kind/workId/id/title/dirty 五个字段，
 *     dirty=false，且不含已保存正文、未保存草稿或其他章节 ID（请求正文不落盘、不打印）；
 *   - 消息 202 入队后的在途窗口把选中切到 B 再回 A：实时目标徽标跟随新选中，而此前发出的
 *     payload 与带 seq 持久回显仍冻结在 A（不用路由 mock 冻结真实模型）；
 *   - 统一创作 Agent（无 preset grid）：首条消息直接写进“消息输入”，点“发送消息”才新建
 *     novel-assistant 会话；用请求顺序证据断言 create-session → subscribe-events → send-message，
 *     消息 URL 的 sessionId 在点击前未知，因此按 UUID 形状等待；
 *   - 真实 Cell + Responses 模型经 GUI 发送：持久带 seq 用户回显恰好一条且无 pending 副本、
 *     持久 completed 终态、非空持久 assistant、get_chapter 与 save_chapter_draft 工具记录；
 *   - 公共 HTTP 独立确认 A 正文精确、版本推进 + 历史、B 文本/版本不变；
 *   - 干净编辑器自动采用服务端新正文/版本且无未保存标记，chapterA GET 刷新 1..3 次有界；
 *   - UI“永久结束对话”204，随后公共 HTTP 发消息 410（CSRF 只从 auth/session 取到内存）。
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

/**
 * 统一创作 Agent 没有 preset grid：会话在**首条消息发送**时创建，因此 messages 的
 * sessionId 在点击前未知，只能按 UUID 形状等待（绝不先 await 创建再点发送）。
 */
const SESSION_MESSAGE_PATH = /^\/api\/v1\/sessions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/messages$/i;

/** `withSelectionContext` 追加元数据时使用的固定分隔（只在内存里解析，不打印正文）。 */
const SELECTION_MARKER = '\n\n【当前选中对象】\n';

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
  acceptance: 'chapter-context-browser (automatic current-selection target + real browser UI + real model, public HTTP verification)',
  run,
  origin,
  checks: [],
  fixtures: {},
  modelRound: null,
  targetCapture: null,
  freezeProbe: null,
  chapterAGetsDuringTurn: null,
  requestOrder: null,
  requestCount: null,
  launchError: null,
  screenshots: [],
  limitations: [
    '只覆盖本地开发栈的开发登录、自动“当前选中对象”目标与一次真实模型回合；不代表生产 OIDC/多租户行为。',
    '报告只记录测试 fixture 标识、公开事件摘要、目标元数据（kind/workId/id/title/dirty 五个字段）与必要截图；不含 cookie / CSRF / 令牌 / 正文草稿内容，也不记录发出的请求正文。',
    '界面已无手动复制/剪贴板上下文入口：当前目标由 UI 在发送时自动附加，因此本验收不再授予或验证任何剪贴板能力。',
    '浏览器验收不用路由 mock：在消息 202 入队后的在途窗口把选中切到 B 再回 A，断言实时目标跟随选中、而已发出的 payload 与带 seq 持久回显仍冻结在 A；但“创建会话 / 订阅事件流那几帧里 UI 显示‘本条消息目标已锁定’徽标”这一帧级窗口由单元测试 apps/novel-web/tests/AssistantPanel.test.tsx 确定性覆盖，真实模型回合无法在不 mock 事件流的前提下稳定卡住它。',
    'dirty=true 的元数据投影（有未保存草稿时只附布尔标记、绝不附带草稿正文）由 selectionContext / AssistantPanel 单元测试确定性覆盖；浏览器真实回合为保持可复现采用干净章节发送，只在 UI 上断言脏警告显隐。',
    '统一创作 Agent 没有 preset 选择：会话在首条消息发送时创建为 novel-assistant，因此“等 active 再发送”改由请求顺序证据（create-session → subscribe-events → send-message）与历史对话里的服务端状态共同断言。',
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

/** 读当前目标徽标 / dirty 警告的可见文本（只读文案，不含任何正文）。 */
function readTarget(page) {
  return page.evaluate(() => {
    const chip = document.querySelector('.composer-target');
    return {
      caption: chip?.querySelector('.target-caption')?.textContent?.trim() ?? null,
      title: chip?.querySelector('strong')?.textContent?.trim() ?? null,
      warning: document.querySelector('.target-warning')?.textContent?.trim() ?? null,
    };
  });
}

/** 等待目标徽标显示指定标题（切换选中后 React 状态更新是异步的）。 */
async function waitForTarget(page, title) {
  await page.waitForFunction(
    (expected) => document.querySelector('.composer-target strong')?.textContent?.trim() === expected,
    title,
    { timeout: 15_000, polling: 100 },
  );
}

/** 等待 dirty 警告出现（true）或消失（false）。 */
async function waitForTargetWarning(page, present) {
  await page.waitForFunction(
    (expected) => Boolean(document.querySelector('.target-warning')) === expected,
    present,
    { timeout: 15_000, polling: 100 },
  );
}

/**
 * 阅读优先的 Manuscript：`editing` 初值 = `!value.trim() || dirty`，因此有已保存正文且干净的
 * 章节默认是“阅读”态，中栏没有 contenteditable。这里只在编辑器缺席时点“编辑原文”，
 * 并且 label 必须 exact——`章节正文：X阅读` 是阅读态 article 的 aria-label，前缀相同。
 */
async function openChapterEditor(page, title) {
  await page.locator('.manuscript-heading h1').filter({ hasText: title }).first().waitFor({ state: 'visible' });
  const surface = page.getByLabel(`章节正文：${title}`, { exact: true });
  if ((await surface.count()) === 0) {
    await page.getByRole('button', { name: '编辑原文', exact: true }).click();
  }
  await surface.waitFor({ state: 'visible' });
  const editor = surface.locator('[contenteditable="true"]');
  await editor.waitFor({ state: 'visible' });
  return editor;
}

/** 登录后的唯一入口是书架（`<main aria-label="我的书架">`）。 */
function shelfOf(page) {
  return page.getByRole('main', { name: '我的书架', exact: true });
}

/**
 * 章节新建表单在有章节时默认收起；展开态只渲染提交按钮、收起态只渲染同名开关，
 * 因此“新建章节”在两种状态下都唯一。先看标题输入框在不在，不在就先点开。
 */
async function openChapterCreateForm(page) {
  const input = page.getByLabel('新章节标题', { exact: true });
  if (!(await input.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: '新建章节', exact: true }).click();
  }
  await input.waitFor();
  return input;
}

/**
 * 章节目录：左栏 `nav.book-nav` 里名为“章节”的具名 region（`<section aria-label="章节">`）。
 * 设定条目也在同一目录里，因此章节选择必须限定在章节 region 内，避免同名条目串台。
 * 选中成功的证据用目标徽标标题（与阅读/编辑模式无关）。
 */
async function selectChapter(page, title) {
  await page
    .getByRole('region', { name: '章节', exact: true })
    .getByRole('button')
    .filter({ hasText: title })
    .first()
    .click();
  await waitForTarget(page, title);
}

/** 历史对话面板默认收起；会话条目（标题 + 序号 + 时间）只在这里出现。 */
async function openHistoryPanel(page) {
  const toggle = page.getByRole('button', { name: '历史对话', exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await page.locator('.conversation-history').waitFor();
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
/** 本节流请求的公开顺序（只存固定标签，不存 URL/正文）。 */
const requestOrder = [];

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

  // 目标徽标由 UI 自动生成，不再需要任何剪贴板权限。
  context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    locale: 'zh-CN',
  });
  const page = await context.newPage();
  mainPage = page;
  page.setDefaultTimeout(20_000);
  page.on('pageerror', () => errors.push('Uncaught browser application error'));
  page.on('request', request => {
    if (request.url().startsWith(api)) browserApiRequests += 1;
    // 统一 Agent 的发送顺序证据：create-session → subscribe-events → send-message。
    // 只记录形状匹配的公开路径，不记录任何正文/查询串。
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'POST' && workId && pathname === `/api/v1/works/${workId}/sessions`) requestOrder.push('create-session');
    if (request.method() === 'GET' && /^\/api\/v1\/sessions\/[0-9a-f-]{36}\/events$/.test(pathname)) requestOrder.push('subscribe-events');
    if (request.method() === 'POST' && SESSION_MESSAGE_PATH.test(pathname)) requestOrder.push('send-message');
  });

  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '作者 author', exact: true }).click();
  await shelfOf(page).waitFor();
  const sessionResponse = await apiGet('/auth/session');
  assert.equal(sessionResponse.status(), 200, 'Real GUI development login must establish an opaque server session');
  assert.equal((await sessionResponse.json()).mode, 'development', 'Refusing to continue without development auth mode');
  report.checks.push('真实 GUI 开发登录成功；auth/session 明确为 development（cookie/CSRF 只存内存）');

  // 2) 通过 UI 新建独立作品：书架 → 新建书本 → dialog（书名 + 简介，简介 label 含“选填”）→ 创建并开始写作 → 直接进入 studio。
  await shelfOf(page).getByRole('button', { name: '新建书本', exact: true }).click();
  const createDialog = page.getByRole('dialog');
  await createDialog.getByLabel('书名', { exact: true }).fill(workTitle);
  await createDialog.getByLabel('简介').fill('自动当前选中目标独立验收 fixture；保留供人工检查，不删除。');
  const createdWork = page.waitForResponse(response => response.url() === `${api}/works` && response.request().method() === 'POST');
  await createDialog.getByRole('button', { name: '创建并开始写作', exact: true }).click();
  const workResponse = await createdWork;
  assert.equal(workResponse.status(), 201);
  workId = (await workResponse.json()).id;
  assert.match(workId, /^[a-f0-9-]{36}$/);
  report.fixtures.work = { id: workId, title: workTitle };
  report.checks.push('通过真实 UI 新建独立作品并进入书内 studio');

  // 3) 章节 A：UI 新建并保存 v1 正文（无章节时新建表单默认展开）。
  await page.getByRole('button', { name: '章节', exact: true }).click();
  const chapterAInput = await openChapterCreateForm(page);
  await chapterAInput.fill(chapterATitle);
  const createdChapterA = page.waitForResponse(response => response.url() === `${api}/works/${workId}/chapters` && response.request().method() === 'POST');
  await page.getByRole('button', { name: '新建章节', exact: true }).click();
  const chapterAResponse = await createdChapterA;
  assert.equal(chapterAResponse.status(), 201);
  chapterA = await chapterAResponse.json();
  assert.equal(chapterA.version, 0, 'A new chapter must start at version 0');
  const editorA = await openChapterEditor(page, chapterATitle);
  await editorA.fill(savedBodyA);
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

  // 4) 自动目标：徽标显示当前章节标题；旧的手动复制上下文入口已从 UI 移除。
  await waitForTarget(page, chapterATitle);
  let target = await readTarget(page);
  assert.equal(target.title, chapterATitle, 'The composer target chip must name the currently selected chapter');
  assert.equal(target.caption, '默认修改当前选中', 'A selected non-dirty chapter is the automatic default target');
  assert.equal(target.warning, null, 'A clean chapter must not show the unsaved-draft warning');
  assert.equal(
    await page.locator('textarea[aria-label="章节助手上下文"]').count(),
    0,
    'The obsolete manual context textarea must be gone from the UI',
  );
  assert.equal(
    await page.getByRole('button', { name: '复制章节上下文', exact: true }).count(),
    0,
    'The obsolete manual copy button must be gone from the UI',
  );
  assert.equal(
    await page.locator('details').filter({ has: page.locator('summary', { hasText: '章节助手上下文' }) }).count(),
    0,
    'The obsolete collapsible manual context panel must be gone from the UI',
  );
  await screenshot(page, 'auto-target');
  report.checks.push('创作助手上方“当前修改目标”自动显示当前章节标题（默认修改当前选中）；旧的手动复制/剪贴板上下文入口已不存在');

  // 5) dirty 警告：有未保存文本时出现且目标不变；恢复已保存文本后消失。
  await editorA.fill(`${savedBodyA}\n${draftLineA}`);
  await waitForTargetWarning(page, true);
  target = await readTarget(page);
  assert.equal(target.title, chapterATitle, 'A dirty draft must not change the automatic target');
  assert.ok(target.warning.includes('未保存修改'), `The dirty warning must explain the unsaved state: ${JSON.stringify(target.warning)}`);
  assert.ok(!target.warning.includes(draftLineA), 'The unsaved draft text must never appear in the target area');
  assert.ok(!target.warning.includes(savedBodyA), 'The saved body must never appear in the target area either');
  await editorA.fill(savedBodyA);
  await waitForTargetWarning(page, false);
  report.checks.push('未保存草稿时出现 dirty 警告且目标仍是当前章节（正文/草稿不入徽标）；恢复已保存文本后警告消失');

  // 6) 新建 B 并切 B 再切 A：目标徽标随选中准确更新，无旧标题 / 无旧脏警告残留。
  //    A 之后已有章节，B 的新建表单默认收起，必须先点开同名开关再填标题、点提交。
  const chapterBInput = await openChapterCreateForm(page);
  await chapterBInput.fill(chapterBTitle);
  const createdChapterB = page.waitForResponse(response => response.url() === `${api}/works/${workId}/chapters` && response.request().method() === 'POST');
  await page.getByRole('button', { name: '新建章节', exact: true }).click();
  const chapterBResponse = await createdChapterB;
  assert.equal(chapterBResponse.status(), 201);
  chapterB = await chapterBResponse.json();
  assert.equal(chapterB.version, 0, 'B must start at empty v0');
  assert.equal(chapterB.text, '', 'B must start with empty text');
  report.fixtures.chapterB = { id: chapterB.id, title: chapterBTitle, initialVersion: chapterB.version };
  report.checks.push('通过真实 UI 新建章节 B，保持空正文 v0');

  await openChapterEditor(page, chapterBTitle);
  await waitForTarget(page, chapterBTitle);
  target = await readTarget(page);
  assert.equal(target.title, chapterBTitle, 'Switching to B must move the automatic target to B');
  assert.ok(!target.title.includes(chapterATitle), 'Switching to B must not leave A title in the target chip');
  assert.equal(target.warning, null, 'An empty clean chapter must not show the unsaved-draft warning');
  const editorB = await openChapterEditor(page, chapterBTitle);
  assert.equal((await editorB.innerText()).trim(), '', 'B editor must be empty');

  await selectChapter(page, chapterATitle);
  await waitForTargetWarning(page, false);
  target = await readTarget(page);
  assert.equal(target.title, chapterATitle, 'Switching back to A must move the automatic target back to A');
  assert.ok(!target.title.includes(chapterBTitle), 'Switching back to A must not leave B title in the target chip');
  assert.equal(target.caption, '默认修改当前选中', 'The caption must still describe the live automatic target');
  const editorBackA = await openChapterEditor(page, chapterATitle);
  assert.equal((await editorBackA.innerText()).trim(), savedBodyA, 'Switching back must restore saved A v1, not the old empty v0 cache');
  report.checks.push('切 B 再切 A 后目标标题随选中准确更新，无旧标题、无旧脏警告残留；A 显示已保存 v1 正文且仍为干净状态');

  // 7) 真实模型回合：composer 只写自然语言指令，目标元数据由 UI 自动附加。
  //    统一创作 Agent 没有 preset grid：首条消息直接写进“消息输入”，点“发送消息”才会
  //    新建 novel-assistant 会话，并等事件流真正连上后再投递消息。
  target = await readTarget(page);
  assert.equal(target.title, chapterATitle, 'The real turn must target the currently selected chapter A');
  const targetText = `A-TARGET-BODY-${randomUUID()}`;
  const instruction = [
    '请只处理本条消息自动附加的当前选中对象（其中 kind=chapter 的那一个），不要改动其他章节。',
    '把它的正文完整替换为下面这一行纯文本（唯一内容就是一个标记，前后不要有空格、标题或换行）：',
    targetText,
    '要求：必须先调用 get_chapter 读取该章节当前已保存内容与版本，再用刚读到的 expectedVersion 调用 save_chapter_draft 保存上面的完整正文；保存成功后只用一句话回复已保存的版本号。',
  ].join('\n');
  // 自然语言指令里绝不能出现手动拼进去的作品/章节标识或标题。
  assert.ok(
    !instruction.includes(workId) && !instruction.includes(chapterA.id) && !instruction.includes(chapterATitle),
    'The composer instruction must be natural text without manual work/chapter id or title injection',
  );
  report.fixtures.targetMarker = targetText;

  await page.getByLabel('消息输入', { exact: true }).fill(instruction);
  const selectionAtSend = (await readTarget(page)).title;
  assert.equal(selectionAtSend, chapterATitle, 'The chip must still name A right before sending');

  // 只统计本轮触发的 chapterA GET（精确匹配，排除 /versions）：刷新必须有界。
  let chapterAGets = 0;
  const countChapterAGet = response => {
    if (response.request().method() === 'GET' && response.url() === `${api}/works/${workId}/chapters/${chapterA.id}`) chapterAGets += 1;
  };
  page.on('response', countChapterAGet);

  // 会话 id 在点击前未知：messages 的 URL 只能用 UUID 形状等待；
  // create 与 send 两个 waiter 都必须在 click 之前建立，绝不先 await 创建再点发送。
  const createdSession = page.waitForResponse(response => response.url() === `${api}/works/${workId}/sessions` && response.request().method() === 'POST', { timeout: 60_000 });
  const queued = page.waitForResponse(response => response.request().method() === 'POST' && SESSION_MESSAGE_PATH.test(new URL(response.url()).pathname), { timeout: 60_000 });
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const sessionCreateResponse = await createdSession;
  assert.equal(sessionCreateResponse.status(), 201);
  const created = await sessionCreateResponse.json();
  assert.equal(created.preset, 'novel-assistant', 'The unified Agent session must be created as novel-assistant');
  sessionId = created.id;
  assert.match(sessionId, /^[0-9a-f-]{36}$/);
  report.fixtures.session = { id: sessionId, preset: created.preset };

  const queuedResponse = await queued;
  assert.equal(queuedResponse.status(), 202, 'The BFF must accept the queued command');
  assert.match((await queuedResponse.json()).commandId, /^[0-9a-f-]{36}$/);

  // 真正发出的 payload 只在内存里检查（不写报告、不打印）：自然语言指令 + 自动附加的
  // 五字段目标元数据；正文/草稿/其他章节 ID 一律不得出现。
  let sentBody = null;
  try {
    sentBody = queuedResponse.request().postDataJSON();
  } catch {
    sentBody = null;
  }
  assert.ok(sentBody && typeof sentBody.text === 'string', 'The outgoing message body must be inspectable in memory');
  assert.match(sentBody.commandId, /^[0-9a-f-]{36}$/);
  const sentText = sentBody.text;
  assert.ok(sentText.startsWith(instruction), 'The outgoing payload must start with the user natural instruction unchanged');
  const markerIndex = sentText.indexOf(SELECTION_MARKER);
  assert.ok(markerIndex > 0, 'The automatic selection context must be appended after the user instruction');
  const metadata = JSON.parse(sentText.slice(markerIndex + SELECTION_MARKER.length).split('\n')[0]);
  assert.deepEqual(
    metadata,
    { kind: 'chapter', workId, id: chapterA.id, title: chapterATitle, dirty: false },
    'The frozen target metadata must name exactly the selected chapter with its live dirty flag',
  );
  assert.deepEqual(
    Object.keys(metadata).sort(),
    ['dirty', 'id', 'kind', 'title', 'workId'],
    'Only the five projected selection fields may be attached to the outgoing payload',
  );
  assert.ok(!sentText.includes(savedBodyA) && !sentText.includes(draftLineA), 'Neither the saved body nor the unsaved draft may enter the outgoing payload');
  assert.ok(!sentText.includes(chapterB.id), 'The outgoing payload must not mention another chapter id');
  assert.ok(!sentText.includes('【章节助手上下文】') && !sentText.includes('作品ID：'), 'The obsolete manual context format must not reappear');
  report.targetCapture = {
    selectionAtSend,
    metadata,
    fields: Object.keys(metadata).sort(),
    startsWithInstruction: sentText.startsWith(instruction),
    carriesSavedBody: false,
    carriesDraftBody: false,
    carriesOtherChapterId: false,
  };
  report.checks.push('在内存中检查真实发出的消息：自然语言指令 + 仅五字段（kind/workId/id/title/dirty=false）的当前选中元数据，不含已保存正文、未保存草稿或其他章节 ID');

  // 在途冻结（刻意不用路由 mock）：消息已 202 入队后，把 UI 选中切到 B 再切回 A。
  // 已发出的 payload 与持久回显必须仍冻结在 A（见下方带 seq 回显断言）；实时徽标则跟随新选中。
  // 切回 A 后重新进入编辑态，供后面的“干净编辑器采纳服务端正文”断言使用。
  const turnActiveAtProbe = await page.evaluate(() =>
    document.querySelector('[data-testid="chat-log"]')?.getAttribute('data-turn-active') === 'true',
  );
  await selectChapter(page, chapterBTitle);
  const chipWhileProbe = (await readTarget(page)).title;
  await selectChapter(page, chapterATitle);
  await openChapterEditor(page, chapterATitle);
  const chipAfterProbe = (await readTarget(page)).title;
  assert.equal(chipWhileProbe, chapterBTitle, 'While the turn is queued the live target must follow a UI selection change');
  assert.equal(chipAfterProbe, chapterATitle, 'Returning to A must restore the automatic target to A');
  report.freezeProbe = { turnActiveAtProbe, chipWhileProbe, chipAfterProbe };
  report.checks.push('在途（202 入队后）切换选中 B 再回 A：实时目标随选中变化，而此前发出的 payload/持久回显仍冻结在 A（未使用路由 mock）');

  // 统一 Agent 的发送顺序是真实证据：先建会话、再订阅事件流、连上后才投递消息。
  const firstIndex = kind => requestOrder.indexOf(kind);
  assert.ok(
    firstIndex('create-session') !== -1 &&
      firstIndex('subscribe-events') > firstIndex('create-session') &&
      firstIndex('send-message') > firstIndex('subscribe-events'),
    `The first message must be sent only after the created session's event stream connected: ${JSON.stringify(requestOrder)}`,
  );
  report.requestOrder = requestOrder;

  // 会话卡离开“创建中”= 事件流订阅成功 = 服务端绑定已 active（历史对话面板默认收起）。
  await openHistoryPanel(page);
  const sessionActive = await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll('.conversation-history .item .item-sub')].some(item =>
          (item.textContent ?? '').includes('活跃'),
        ),
      undefined,
      { timeout: 60_000, polling: 250 },
    )
    .then(() => true, () => false);
  assert.ok(sessionActive, 'The session card must leave "创建中" once the stream is live (server-observed active binding)');

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
  assert.equal(markerBubbles.length, 1, `The persisted user message must appear exactly once: ${JSON.stringify(userBubbles?.map(bubble => ({ seq: bubble.seq, pending: bubble.pending, chars: bubble.text.length })))}`);
  assert.equal(markerBubbles[0].pending, false, 'A confirmed user message must not keep its local pending copy');
  assert.ok(markerBubbles[0].seq !== null && markerBubbles[0].seq !== '', 'The single user message must be the durable one (with seq)');
  assert.equal((userBubbles ?? []).filter(bubble => bubble.pending).length, 0, 'No pending placeholder may survive the durable echo');
  // 持久回显必须携带冻结在发送瞬间的目标：A 的 id 在，其他章节的 id 不在。
  assert.ok(markerBubbles[0].text.includes(`"id":"${chapterA.id}"`), 'The durable echo must carry the frozen target metadata for chapter A');
  assert.ok(!markerBubbles[0].text.includes(`"id":"${chapterB.id}"`), 'The durable echo must not carry another chapter id');
  report.checks.push('持久带 seq 用户回显恰好一条且无 pending 副本（由 commandId 替换，不靠正文去重），且回显里的冻结目标元数据仍指向 A');

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

  // 8) 公共 HTTP 独立确认：A 精确正文、版本推进 + 历史；B 文本/版本不变。
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

  // 9) 干净编辑器自动采用服务端新正文/版本，且本轮 chapterA GET 有界（1..3）。
  //     中栏是 `section[aria-label="作品内容"]`，不再有旧的 `.workspace-column` 包装层。
  const editorText = () => page.evaluate(() => document.querySelector('[aria-label="作品内容"] [aria-label^="章节正文"] [contenteditable="true"]')?.innerText ?? null);
  const editorAdopted = await page
    .waitForFunction(
      expected => {
        const shown = document.querySelector('[aria-label="作品内容"] [aria-label^="章节正文"] [contenteditable="true"]')?.innerText ?? null;
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
  const shownToolbar = await page.evaluate(() => document.querySelector('[aria-label="作品内容"] .editor .toolbar .small.muted')?.textContent ?? '');
  assert.ok(shownToolbar.includes(`已保存版本 ${chapterAfterJson.version}`), `Editor must show the server version: ${JSON.stringify(shownToolbar)}`);
  assert.ok(!shownToolbar.includes('有未保存修改'), `A clean editor that adopted server text must not be dirty: ${JSON.stringify(shownToolbar)}`);
  page.off('response', countChapterAGet);
  report.chapterAGetsDuringTurn = chapterAGets;
  assert.ok(chapterAGets >= 1, 'A durable turn end must trigger a bounded refresh of chapter A');
  assert.ok(chapterAGets <= 3, `Chapter A refresh must stay bounded per turn, got ${chapterAGets} GETs`);
  report.checks.push(`持久终态后干净编辑器自动显示服务端正文 v${chapterAfterJson.version} 且无未保存标记；本轮 chapterA GET ${chapterAGets} 次（1..3 有界，不含 versions）`);

  // 回合结束后目标徽标仍指向当前选中章节（自动目标不因回合改变）。
  target = await readTarget(page);
  assert.equal(target.title, chapterATitle, 'The automatic target must still name the selected chapter after the turn');

  await openHistoryPanel(page);
  const sessionStillActive = await page.evaluate(() =>
    [...document.querySelectorAll('.conversation-history .item .item-sub')].some(item =>
      (item.textContent ?? '').includes('活跃'),
    ),
  );
  assert.ok(sessionStillActive, 'The session card must still report the server-observed active binding after the turn');

  // 断言完成后再截图（model 回合后：编辑器与自动目标一致）。
  await screenshot(page, 'model-roundtrip');

  // 10) UI“永久结束对话”→ DELETE 204；随后公共 HTTP 发消息必须 410。
  //     会话操作默认收起，且永久结束带 window.confirm，必须先展开再确认。
  const sessionOptions = page.locator('.session-options');
  if (!(await sessionOptions.evaluate(node => node.open))) await sessionOptions.locator('summary').click();
  page.once('dialog', dialog => dialog.accept());
  const revoked = page.waitForResponse(response => response.url() === `${api}/sessions/${sessionId}` && response.request().method() === 'DELETE');
  await page.getByRole('button', { name: '永久结束对话', exact: true }).click();
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
  report.checks.push('GUI“永久结束对话”返回 204；随后公共 HTTP（CSRF 仅内存）发消息得到 410');
  await screenshot(page, 'after-revocations');

  // 11) 整套请求数保持在一个 120/min 窗口以内。
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
  // 账户菜单（含“退出登录”）在顶栏默认收起，先展开再点。
  try {
    if (mainPage && !mainPage.isClosed()) {
      const accountMenu = mainPage.locator('.account-menu');
      if ((await accountMenu.count()) > 0 && !(await accountMenu.evaluate(node => node.open))) {
        await accountMenu.locator('summary').click({ timeout: 3000 }).catch(() => undefined);
      }
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
