import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { showPanel } from './restored-ui.helpers.js';

const fixture: Record<string, string> = {
  'meta/project.yaml': 'title: 夜の旅\nsubtitle: 雨の町\n',
  'plot/volumes/v/volume.yaml': 'id: v1\ntype: volume\ntitle: 第一巻\norder: 1\n',
  'plot/volumes/v/chapters/c/chapter.yaml': 'id: c1\ntype: chapter\ntitle: 始まり\nvolume: v1\norder: 1\n',
  'plot/volumes/v/chapters/c/scenes/a.yaml': 'id: s1\ntype: scene\ntitle: 雨の夜\nvolume: v1\nchapter: c1\norder: 1\nmanuscript: manuscript/custom/a.md\n',
  'plot/volumes/v/chapters/c/scenes/b.yaml': 'id: s2\ntype: scene\ntitle: 朝の港\nvolume: v1\nchapter: c1\norder: 2\nmanuscript: manuscript/custom/b.md\n',
  'manuscript/custom/a.md': '---\ntitle: draft\nprivate_note: omit\n---\n｜夜《よる》の町で《《雨》》が降った。\n',
  'manuscript/custom/b.md': '海から朝日が昇った。終わり。\n',
  'meta/publish-episodes.yaml': 'migrationNote: preserve\nepisodes:\n  - id: legacy-episode-1\n    number: 1\n    title: 第一話\n    scope: chapter\n    scopeId: c1\n    futureField: keep\n',
  'meta/scriptorium/modules/publishing/legacy/share-grants.jsonl': `${JSON.stringify({ id: 'legacy-grant-1', projectId: 'old-scriptorium-project', scope: { kind: 'chapter', id: 'c1', extension: 'preserve' }, label: '校正用', tokenHash: 'a'.repeat(64), createdAt: '2025-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:00:00.000Z', safeExtension: { note: 'preserve' } })}\n`,
};

async function install(page: Page, id: string, capabilities: string[]) {
  const manager = page.locator('details.plugin-manager-panel');
  await page.getByRole('button', { name: `${id} v0.1.0 の導入内容と署名を確認` }).click();
  await page.getByRole('button', { name: 'ダウンロードして無効状態でインストール' }).click();
  await expect(manager.getByRole('status')).toContainText('署名とダイジェストを検証し、無効状態でインストールしました');
  const plugin = page.locator(".installed-plugins > li").filter({ hasText: id }).filter({ hasText: 'v0.1.0' });
  for (const capability of capabilities) await plugin.getByRole('checkbox', { name: capability, exact: true }).check();
  await plugin.getByRole('button', { name: '有効化' }).click();
  await expect(manager.getByRole('status')).toContainText(`${id}@0.1.0 is enabled`);
}
async function openPanel(page: Page, name: string) {
  const selected = page.getByRole('tab', { name, exact: true }).first();
  if (await selected.isVisible()) {
    if (await selected.getAttribute('aria-selected') !== 'true') await selected.click();
    return;
  }
  const configuration = page.locator('.st-workspace-configuration');
  if (await configuration.getAttribute('open') === null) await configuration.locator(':scope > summary').click();
  const menu = page.locator('.st-workspace-panel-menu');
  if (await menu.getAttribute('open') === null) await menu.locator(':scope > summary').click();
  const display = page.getByRole('button', { name: `${name}を表示する`, exact: true });
  if (await display.isVisible()) await display.click();
  else {
    const tab = page.getByRole('tab', { name, exact: true }).first();
    if (!(await tab.isVisible())) throw new Error(`The ${name} panel is neither open nor available in the panel menu.`);
    if (await tab.getAttribute('aria-selected') !== 'true') await tab.click();
  }
  if (await configuration.getAttribute('open') !== null) await configuration.locator(':scope > summary').click();
  const tab = page.getByRole('tab', { name, exact: true }).first();
  if (await tab.isVisible() && await tab.getAttribute('aria-selected') !== 'true') await tab.click();
}
async function makeExport(page: Page, panelName: string, scope: 'all' | 'chapter' = 'all') {
  await openPanel(page, panelName);
  const panel = page.getByRole('tabpanel', { name: panelName, exact: true }).first();
  await panel.getByRole('button', { name: '読み込む', exact: true }).click();
  await panel.getByRole('tab', { name: '書き出し', exact: true }).click();
  await panel.getByRole('combobox', { name: '対象', exact: true }).selectOption(scope);
  if (panelName === '書き出し') await panel.getByRole('combobox', { name: '表記', exact: true }).selectOption('raw');
  await panel.getByRole('button', { name: '送信', exact: true }).click();
  const artifact = panel.getByRole('region', { name: 'Host が確認した出力' });
  const alert = panel.getByRole('alert');
  await expect(artifact.or(alert)).toBeVisible({ timeout: 30_000 });
  if (await alert.isVisible()) throw new Error(`Export failed: ${await alert.innerText()}`);
  await expect(artifact).toBeVisible();
  return panel;
}
async function download(page: Page, panel: ReturnType<Page['getByRole']>) {
  await panel.getByRole('button', { name: 'ダウンロード', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '出力前の確認' });
  await expect(dialog).toBeVisible();
  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '未確認の項目を残して続ける' }).click();
  const result = await pending;
  const path = await result.path();
  if (!path) throw new Error('Browser did not provide downloaded artifact bytes');
  return { filename: result.suggestedFilename(), bytes: await readFile(path) };
}
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
function unzipStored(bytes: Buffer): Map<string, Buffer> {
  const result = new Map<string, Buffer>(); const locations = new Map<string, number>(); let offset = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    expect(bytes.readUInt16LE(offset + 8)).toBe(0);
    const crc = bytes.readUInt32LE(offset + 14), size = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28);
    expect(bytes.readUInt32LE(offset + 22)).toBe(size);
    const nameStart = offset + 30, name = bytes.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const start = nameStart + nameLength + extraLength, end = start + size;
    expect(end).toBeLessThanOrEqual(bytes.length); expect(result.has(name)).toBe(false);
    const body = bytes.subarray(start, end); expect(crc32(body)).toBe(crc);
    result.set(name, body); locations.set(name, offset); offset = end;
  }
  const centralOffset = offset; let centralCount = 0;
  while (offset + 46 <= bytes.length && bytes.readUInt32LE(offset) === 0x02014b50) {
    const nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    expect(bytes.readUInt32LE(offset + 42)).toBe(locations.get(name));
    expect(bytes.readUInt32LE(offset + 16)).toBe(crc32(result.get(name)!));
    offset += 46 + nameLength + extraLength + commentLength; centralCount++;
  }
  expect(bytes.readUInt32LE(offset)).toBe(0x06054b50);
  expect(bytes.readUInt16LE(offset + 10)).toBe(centralCount);
  expect(centralCount).toBe(result.size);
  expect(bytes.readUInt32LE(offset + 16)).toBe(centralOffset);
  expect(bytes.readUInt32LE(offset + 12)).toBe(offset - centralOffset);
  expect(offset + 22 + bytes.readUInt16LE(offset + 20)).toBe(bytes.length);
  return result;
}

test('signed Publishing locally exports TXT and EPUB and opens vertical print with source text', async ({ page }) => {
  const directory = process.env.PROPRIUM_PUBLISHING_REGISTRY_DIR ?? process.env.PROPRIUM_OFFICIAL_E2E_DIR;
  if (!directory) throw new Error('The signed registry setup did not provide its output directory');
  const registryDir = resolve(directory);
  const registryUrl = new URL(process.env.VITE_PROPRIUM_PLUGIN_REGISTRY_URL!);
  const registryPrefix = registryUrl.pathname.slice(0, registryUrl.pathname.lastIndexOf('/') + 1);
  // Serve only the signed fixture's registry and pinned artifact origins.
  // In CI they may use different ports when browser suites run concurrently.
  const artifactOrigin = process.env.PROPRIUM_AUTHORING_TEST_ARTIFACT_BASE
    ? new URL(process.env.PROPRIUM_AUTHORING_TEST_ARTIFACT_BASE).origin
    : registryUrl.origin;
  await page.route(url =>
    (url.origin === registryUrl.origin || url.origin === artifactOrigin) &&
    url.pathname.startsWith(registryPrefix), async route => {
    const relative = decodeURIComponent(new URL(route.request().url()).pathname.slice(registryPrefix.length));
    const path = resolve(registryDir, relative);
    if (!path.startsWith(registryDir + sep)) return route.fulfill({ status: 404 });
    try { await route.fulfill({ body: await readFile(path), contentType: path.endsWith('.json') ? 'application/json' : 'application/octet-stream', headers: { 'access-control-allow-origin': '*' } }); }
    catch { await route.fulfill({ status: 404 }); }
  });
  const outboundWrites: string[] = [];
  page.on('request', request => { if (/github\.com|git-receive-pack/u.test(request.url()) && !['GET', 'HEAD'].includes(request.method())) outboundWrites.push(`${request.method()} ${request.url()}`); });
  await page.goto('/');
  await page.waitForFunction(() => typeof window.propriumHostTest?.openWorkspace === 'function');
  const workspace = { origin: 'https://github.com', repositoryId: 301, owner: 'proprium-test', repository: 'publishing-e2e', branch: 'main', localWorkspaceId: `publishing-${crypto.randomUUID()}` };
  await page.evaluate(async ({ identity, files }) => window.propriumHostTest!.openWorkspace(identity, files), { identity: workspace, files: fixture });
  await showPanel(page, 'review');
  const manager = page.locator('details.plugin-manager-panel');
  await manager.locator('summary').click();
  await page.getByRole('button', { name: 'カタログを表示' }).click();
  await install(page, 'proprium.narrative', ['workspace.change.propose', 'workspace.change.timestamp', 'workspace.file.read', 'workspace.identity.read']);
  await install(page, 'proprium.publishing', ['workspace.file.read', 'workspace.plugin.invoke', 'workspace.change.propose', 'artifact.create', 'artifact.append', 'artifact.seal', 'artifact.discard']);
  const txtPanel = await makeExport(page, '書き出し');
  const txt = await download(page, txtPanel);
  expect(txt.filename).toMatch(/\.txt$/u);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(txt.bytes);
  expect(text).toContain('｜夜《よる》の町で《《雨》》が降った。');
  expect(text).toContain('海から朝日が昇った。終わり。');
  expect(text).not.toContain('private_note');
  const epubPanel = await makeExport(page, 'EPUB 書き出し');
  const epub = await download(page, epubPanel);
  expect(epub.filename).toMatch(/\.epub$/u);
  const zip = unzipStored(epub.bytes);
  expect(zip.get('mimetype')?.toString()).toBe('application/epub+zip');
  expect(zip.has('META-INF/container.xml')).toBe(true);
  const xhtml = [...zip].filter(([name]) => name.endsWith('.xhtml')).map(([, value]) => value.toString('utf8')).join('\n');
  expect(xhtml).toContain('<ruby>夜<rt>よる</rt></ruby>');
  expect(xhtml).toContain('海から朝日が昇った。終わり。');
  const vertical = await makeExport(page, '縦書き PDF');
  await vertical.getByRole('button', { name: 'テキストプレビュー' }).click();
  const preview = vertical.getByRole('region', { name: '出力テキストプレビュー' });
  await expect(preview).toContainText('海から朝日が昇った。終わり。');
  await vertical.getByRole('button', { name: '印刷 / PDF' }).click();
  const dialog = page.getByRole('dialog', { name: '出力前の確認' });
  const popupPromise = page.waitForEvent('popup');
  await dialog.getByRole('button', { name: '未確認の項目を残して続ける' }).click();
  const popup = await popupPromise;
  await expect(popup.locator('pre')).toContainText('｜夜《よる》の町で《《雨》》が降った。');
  await expect(popup.locator('pre')).toContainText('海から朝日が昇った。終わり。');
  expect(await popup.locator('pre').evaluate(element => getComputedStyle(element).writingMode)).toBe('vertical-rl');
  expect(outboundWrites).toEqual([]);

  await openPanel(page, '公開回マッピング');
  const episodePanel = page.getByRole('tabpanel', { name: '公開回マッピング', exact: true }).first();
  await episodePanel.getByRole('button', { name: '読み込む', exact: true }).click();
  await episodePanel.getByRole('tab', { name: '旧データの復旧', exact: true }).click();
  await episodePanel.getByRole('button', { name: '旧データの復旧を読み込む', exact: true }).click();
  const recoveryTab = episodePanel.getByRole('tabpanel', { name: '旧データの復旧', exact: true });
  const recoverySurface = episodePanel.locator('.authoring-surface-body');
  await expect(recoverySurface).toHaveAttribute('aria-busy', 'true', { timeout: 60_000 });
  await expect(recoverySurface).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
  await recoveryTab.getByRole('tab', { name: '復旧候補', exact: true }).click();
  await expect(recoveryTab.getByRole('table')).toContainText('ready');
  await expect(recoveryTab.getByRole('table')).toContainText('meta/publish-episodes.yaml');
  await recoveryTab.getByRole('tab', { name: '復旧提案', exact: true }).click();
  await recoveryTab.getByRole('combobox', { name: '復旧元', exact: true }).selectOption('meta/publish-episodes.yaml');
  await recoveryTab.getByRole('button', { name: '送信', exact: true }).click();
  const recoveryConfirmation = page.getByRole('dialog', { name: '公開回マップの復旧を提案' });
  await recoveryConfirmation.getByRole('button', { name: '復旧提案を作成' }).click();
  await expect(recoveryTab.getByRole('alert')).toHaveCount(0);
  await showPanel(page, 'review');
  const review = page.getByRole('region', { name: 'Authoring proposals' });
  await expect(review.getByRole('button').first()).toBeVisible({ timeout: 30_000 });
  await review.getByRole('button').first().click();
  await expect(review).toContainText('meta/scriptorium/modules/publishing/episodes.yaml');
  await expect(review).toContainText('futureField: keep');
  await expect(review).toContainText('第一話');
  await review.getByRole('checkbox', { name: '公開回マップを復旧', exact: true }).check();
  await review.getByRole('button', { name: '選択した単位をローカルへ適用' }).click();
  await expect(review.getByRole('button', { name: /proprium\.publishing · applied/ })).toBeVisible({ timeout: 30_000 });

  await openPanel(page, '公開回マッピング');
  const episodePanelAgain = page.getByRole('tabpanel', { name: '公開回マッピング', exact: true }).first();
  await episodePanelAgain.getByRole('tab', { name: '旧データの復旧', exact: true }).click();
  const recoveryTabAgain = episodePanelAgain.getByRole('tabpanel', { name: '旧データの復旧', exact: true });
  // Applying the episode proposal advances the workspace generation. Refresh
  // the recovery snapshot before inspecting the independent grant source.
  await recoveryTabAgain.getByRole('button', { name: '旧データの復旧を読み込む', exact: true }).click();
  await expect(recoverySurface).toHaveAttribute('aria-busy', 'true', { timeout: 60_000 });
  await expect(recoverySurface).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
  await recoveryTabAgain.getByRole('tab', { name: '共有権限', exact: true }).click();
  const grantsTab = recoveryTabAgain.getByRole('tabpanel', { name: '共有権限', exact: true });
  await grantsTab.getByRole('tab', { name: '保管された権限', exact: true }).click();
  await expect(grantsTab.getByRole('table')).toContainText('mapping_required');
  await expect(grantsTab.getByRole('table')).toContainText('301');
  await expect(grantsTab.getByRole('table')).toContainText('main');
  await grantsTab.getByRole('tab', { name: '明示対応と提案', exact: true }).click();
  const grantForm = grantsTab.getByRole('tabpanel', { name: '明示対応と提案', exact: true });
  await grantForm.getByRole('combobox', { name: '復旧元', exact: true }).selectOption('meta/scriptorium/modules/publishing/legacy/share-grants.jsonl');
  const legacyProject = grantForm.getByRole('combobox', { name: '旧 projectId', exact: true });
  await expect(legacyProject.getByRole('option', { name: 'old-scriptorium-project (1)', exact: true })).toHaveCount(1);
  await legacyProject.selectOption('old-scriptorium-project');
  await grantForm.getByRole('spinbutton', { name: 'Host repository ID を再入力', exact: true }).fill('301');
  await grantForm.getByRole('textbox', { name: 'Host branch を再入力', exact: true }).fill('main');
  await grantForm.getByRole('button', { name: '送信', exact: true }).click();
  const grantConfirmation = page.getByRole('dialog', { name: '旧共有権限の復旧を提案' });
  await grantConfirmation.getByRole('button', { name: '復旧提案を作成' }).click();
  await expect(grantForm.getByRole('alert')).toHaveCount(0);
  await showPanel(page, 'review');
  const grantReview = page.getByRole('region', { name: 'Authoring proposals' });
  await expect(grantReview.getByRole('button', { name: /proprium\.publishing · proposed/ }).last()).toBeVisible({ timeout: 30_000 });
  await grantReview.getByRole('button', { name: /proprium\.publishing · proposed/ }).last().click();
  await expect(grantReview).toContainText('meta/scriptorium/modules/publishing/share-grants.jsonl');
  await expect(grantReview).toContainText('legacy-grant-1');
  await expect(grantReview).not.toContainText('share_');
  await grantReview.getByRole('checkbox', { name: '旧共有権限を復旧', exact: true }).check();
  await grantReview.getByRole('button', { name: '選択した単位をローカルへ適用' }).click();
  await expect(grantReview.getByRole('button', { name: /proprium\.publishing · applied/ }).last()).toBeVisible({ timeout: 30_000 });

  await page.reload();
  await page.waitForFunction(() => typeof window.propriumHostTest?.openWorkspace === 'function');
  await page.evaluate(async identity => window.propriumHostTest!.openWorkspace(identity), workspace);
  await showPanel(page, 'review');
  const reloadedReview = page.getByRole('region', { name: 'Authoring proposals' });
  await expect(reloadedReview.getByRole('button', { name: /proprium\.publishing · applied/ })).toHaveCount(2);
});
