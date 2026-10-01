import assert from 'node:assert/strict';

/** Real UI/API only: no request interception, SQL, token extraction or mock responses. */
export async function verifyBusinessEditing({ page, context, workId, title, text, run, api, login, checks }) {
  const outlineUrl = `${api}/works/${workId}/outline`;
  const editor = page.getByLabel('作品大纲', { exact: true }).locator('[contenteditable="true"]');
  const peer = await login('author', '作者 author');
  try {
    await peer.page.getByRole('region', { name: '作品列表' }).getByRole('button').filter({ hasText: title }).click();
    const peerEditor = peer.page.getByLabel('作品大纲').locator('[contenteditable="true"]');
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

  await page.getByRole('tab', { name: '章节', exact: true }).click();
  const chapterTitle = `第一章-${run}`;
  await page.getByLabel('新章节标题').fill(chapterTitle);
  const chapterCreate = page.waitForResponse(r => r.url() === `${api}/works/${workId}/chapters` && r.request().method() === 'POST');
  await page.getByRole('button', { name: '新建章节', exact: true }).click();
  const chapterResponse = await chapterCreate;
  assert.equal(chapterResponse.status(), 201);
  const chapter = await chapterResponse.json();
  const chapterText = `章节验收 ${run}。风暴结束后，守塔者发现了一封迟到的信。`;
  await page.getByLabel(`章节正文：${chapterTitle}`).locator('[contenteditable="true"]').fill(chapterText);
  const chapterSave = page.waitForResponse(r => r.url() === `${api}/works/${workId}/chapters/${chapter.id}` && r.request().method() === 'PUT');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  assert.equal((await chapterSave).status(), 200);
  const persistedChapter = await (await context.request.get(`${api}/works/${workId}/chapters/${chapter.id}`)).json();
  assert.equal(persistedChapter.text, chapterText);
  const versions = await (await context.request.get(`${api}/works/${workId}/chapters/${chapter.id}/versions`)).json();
  assert.ok(versions.items.some(version => version.text === chapterText && version.version === 1));
  checks.push('Chapter creation, plain-text saving and durable version history through the real UI/BFF');

  await page.getByRole('tab', { name: '设定圣经', exact: true }).click();
  for (const kind of ['character', 'setting', 'timeline']) {
    const marker = `${kind}-${run}`;
    await page.getByLabel('条目类型').selectOption(kind);
    await page.getByLabel('条目名称').fill(marker);
    await page.getByLabel('新条目内容').fill(`设定初稿 ${marker}`);
    const createEntry = page.waitForResponse(r => r.url() === `${api}/works/${workId}/bible` && r.request().method() === 'POST');
    await page.getByRole('button', { name: '新增条目', exact: true }).click();
    const entryResponse = await createEntry;
    assert.equal(entryResponse.status(), 201);
    const entry = await entryResponse.json();
    await page.getByRole('button').filter({ hasText: marker }).click();
    await page.getByRole('heading', { name: new RegExp(marker) }).waitFor();
    const entryText = `修订后的纯文本设定 ${marker}`;
    await page.getByLabel('条目内容（纯文本）', { exact: true }).fill(entryText);
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
  await page.getByRole('tab', { name: '大纲', exact: true }).click();
}
