import assert from 'node:assert/strict';

/** Real UI/API only: no request interception, SQL, token extraction or mock responses. */

/**
 * 登录后的唯一入口是书架：`<main class="bookshelf" aria-label="我的书架">`。
 * 角色按 HTML-AAM 映射为 `main`，不是 `region`（region 只对应带名字的 section）。
 */
export function shelfOf(page) {
  return page.getByRole('main', { name: '我的书架', exact: true });
}

/** 书架卡片的显式打开动作：`aria-label="打开书本：<title>"`，不与卡片里的删除/管理按钮混淆。 */
export async function openBook(page, bookTitle) {
  await shelfOf(page).getByRole('button', { name: `打开书本：${bookTitle}`, exact: true }).click();
}

/**
 * 章节新建表单在有章节时默认收起、无章节时直接展开。
 *
 * 展开态只渲染提交按钮（`新建章节`），收起态只渲染同名开关，因此同名按钮在两种状态下
 * 都只命中唯一一颗：先看标题输入框在不在，不在就先点开关。
 */
export async function openChapterCreateForm(page) {
  const input = page.getByLabel('新章节标题', { exact: true });
  if (!(await input.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: '新建章节', exact: true }).click();
  }
  await input.waitFor();
  return input;
}

/**
 * 设定新增表单**默认收起**，且提交成功后仍保持展开（只清空字段）。
 * 因此同样按“类型选择框是否可见”决定要不要先点开开关。
 */
export async function openBibleCreateForm(page) {
  const kind = page.getByLabel('条目类型', { exact: true });
  if (!(await kind.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: '新增条目', exact: true }).click();
  }
  await kind.waitFor();
  return kind;
}

/** 书内目录 nav：设定条目与新增开关都在这里。 */
export function bookNavOf(page) {
  return page.getByRole('navigation', { name: '书内目录', exact: true });
}

export async function verifyBusinessEditing({ page, context, workId, title, text, run, api, login, checks }) {
  const outlineUrl = `${api}/works/${workId}/outline`;
  const editor = page.getByLabel('作品大纲', { exact: true }).locator('[contenteditable="true"]');
  const peer = await login('author', '作者 author');
  try {
    await openBook(peer.page, title);
    await peer.page.getByRole('button', { name: '编辑原文', exact: true }).click();
    const peerEditor = peer.page.getByLabel('作品大纲', { exact: true }).locator('[contenteditable="true"]');
    await peerEditor.waitFor();
    await peer.page.waitForFunction(expected => document.querySelector('[aria-label="作品大纲"] [contenteditable="true"]')?.textContent === expected, text);
    assert.equal(await peerEditor.innerText(), text);
    const localDraft = `${text}\n本地保留草稿 ${run}`;
    const remoteDraft = `${text}\n另一窗口已保存 ${run}`;
    await editor.fill(localDraft);
    await peerEditor.fill(remoteDraft);
    const peerSave = peer.page.waitForResponse(r => r.url() === outlineUrl && r.request().method() === 'PUT');
    await peer.page.getByRole('button', { name: '保存', exact: true }).click();
    assert.equal((await peerSave).status(), 200);
    const conflictSave = page.waitForResponse(r => r.url() === outlineUrl && r.request().method() === 'PUT');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    assert.equal((await conflictSave).status(), 409);
    await page.getByRole('button', { name: '重新读取服务端', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '采用服务端内容', exact: true }).isEnabled(), false, 'A stale snapshot must not be adopted as the latest version');
    assert.equal(await page.getByRole('button', { name: '以最新版本提交本地草稿', exact: true }).isEnabled(), false, 'A stale snapshot must not enable latest-version resubmission');
    assert.deepEqual(await editor.locator('p').allTextContents(), localDraft.split('\n'));
    assert.equal((await (await context.request.get(outlineUrl)).json()).text, remoteDraft);
    const reread = page.waitForResponse(r => r.url() === outlineUrl && r.request().method() === 'GET');
    await page.getByRole('button', { name: '重新读取服务端', exact: true }).click();
    assert.equal((await reread).status(), 200);
    const explicitSave = page.waitForResponse(r => r.url() === outlineUrl && r.request().method() === 'PUT');
    await page.getByRole('button', { name: '以最新版本提交本地草稿', exact: true }).click();
    assert.equal((await explicitSave).status(), 200);
    const resolved = await (await context.request.get(outlineUrl)).json();
    assert.equal(resolved.text, localDraft);
    assert.equal(resolved.version, 3);
    checks.push('Concurrent author windows return CAS 409, preserve the local draft and require explicit resubmission against the latest version');
  } finally {
    await peer.context.close();
  }

  await page.getByRole('button', { name: '章节', exact: true }).click();
  const chapterTitle = `第一章-${run}`;
  const chapterInput = await openChapterCreateForm(page);
  await chapterInput.fill(chapterTitle);
  const chapterCreate = page.waitForResponse(r => r.url() === `${api}/works/${workId}/chapters` && r.request().method() === 'POST');
  await page.getByRole('button', { name: '新建章节', exact: true }).click();
  const chapterResponse = await chapterCreate;
  assert.equal(chapterResponse.status(), 201);
  const chapter = await chapterResponse.json();
  const chapterText = `章节验收 ${run}。风暴结束后，守塔者发现了一封迟到的信。`;
  const chapterEditor = page.getByLabel(`章节正文：${chapterTitle}`).locator('[contenteditable="true"]');
  await chapterEditor.waitFor();
  await chapterEditor.fill(chapterText);
  const chapterSave = page.waitForResponse(r => r.url() === `${api}/works/${workId}/chapters/${chapter.id}` && r.request().method() === 'PUT');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  assert.equal((await chapterSave).status(), 200);
  const persistedChapter = await (await context.request.get(`${api}/works/${workId}/chapters/${chapter.id}`)).json();
  assert.equal(persistedChapter.text, chapterText);
  const versions = await (await context.request.get(`${api}/works/${workId}/chapters/${chapter.id}/versions`)).json();
  assert.ok(versions.items.some(version => version.text === chapterText && version.version === 1));
  checks.push('Chapter creation, plain-text saving and durable version history through the real UI/BFF');

  await page.getByRole('button', { name: '设定圣经', exact: true }).click();
  for (const kind of ['character', 'setting', 'timeline']) {
    const marker = `${kind}-${run}`;
    const kindSelect = await openBibleCreateForm(page);
    await kindSelect.selectOption(kind);
    await page.getByLabel('条目名称', { exact: true }).fill(marker);
    await page.getByLabel('新条目内容', { exact: true }).fill(`设定初稿 ${marker}`);
    const createEntry = page.waitForResponse(r => r.url() === `${api}/works/${workId}/bible` && r.request().method() === 'POST');
    await page.getByRole('button', { name: '新增条目', exact: true }).click();
    const entryResponse = await createEntry;
    assert.equal(entryResponse.status(), 201);
    const entry = await entryResponse.json();
    await bookNavOf(page).getByRole('button').filter({ hasText: marker }).first().click();
    await page.getByRole('heading', { name: marker, exact: true }).waitFor();
    await page.getByRole('button', { name: '编辑原文', exact: true }).click();
    const entryText = `修订后的纯文本设定 ${marker}`;
    await page.getByLabel('条目内容（纯文本）', { exact: true }).locator('[contenteditable="true"]').fill(entryText);
    const saveEntry = page.waitForResponse(r => r.url() === `${api}/works/${workId}/bible/${entry.id}` && r.request().method() === 'PUT');
    await page.getByRole('button', { name: '保存条目', exact: true }).click();
    assert.equal((await saveEntry).status(), 200);
    const entries = await (await context.request.get(`${api}/works/${workId}/bible?query=${encodeURIComponent(marker)}`)).json();
    assert.ok(entries.items.some(item => item.id === entry.id && item.kind === kind && item.text === entryText && item.version === 1));
  }
  const searchMarker = `timeline-${run}`;
  const search = page.waitForResponse(r => new URL(r.url()).pathname === `/api/v1/works/${workId}/bible` && new URL(r.url()).searchParams.get('query') === searchMarker);
  await page.getByLabel('检索设定').fill(searchMarker);
  assert.equal((await search).status(), 200);
  checks.push('Character, setting and timeline creation/editing plus real server-side search');
  await page.getByRole('button', { name: '大纲', exact: true }).click();
}
