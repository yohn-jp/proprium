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
};

async function install(page: Page, id: string, capabilities: string[]) {
  const manager = page.locator('details.plugin-manager-panel');
  await page.getByRole('button', { name: `${id} 0.1.0 の署名済みプレビューを確認` }).click();
  await page.getByRole('button', { name: 'ダウンロードして無効状態でインストール' }).click();
  await expect(manager.getByRole('status')).toContainText('署名とダイジェストを検証し、無効状態でインストールしました');
  const plugin = page.getByRole('listitem').filter({ hasText: id }).filter({ hasText: 'v0.1.0' });
  for (const capability of capabilities) await plugin.getByRole('checkbox', { name: capability, exact: true }).check();
  await plugin.getByRole('button', { name: 'Enable' }).click();
  await expect(manager.getByRole('status')).toContainText(`${id}@0.1.0 is enabled`);
}
async function openPanel(page: Page, name: string) {
  const configuration = page.locator('.st-workspace-configuration');
  if (await configuration.getAttribute('open') === null) await configuration.locator(':scope > summary').click();
  const menu = page.locator('.st-workspace-panel-menu');
  if (await menu.getAttribute('open') === null) await menu.locator(':scope > summary').click();
  await page.getByRole('button', { name: `${name}を表示する`, exact: true }).click();
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
  await page.route(`${registryUrl.origin}${registryPrefix}**`, async route => {
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
  await page.evaluate(async files => window.propriumHostTest!.openWorkspace({ provider: 'local', name: 'publishing-e2e', branch: 'main', localWorkspaceId: `publishing-${crypto.randomUUID()}` }, files), fixture);
  await showPanel(page, 'review');
  const manager = page.locator('details.plugin-manager-panel');
  await manager.locator('summary').click();
  await page.getByRole('button', { name: '信頼済みカタログを表示' }).click();
  await install(page, 'proprium.narrative', ['workspace.change.propose', 'workspace.change.timestamp', 'workspace.file.read', 'workspace.identity.read']);
  await install(page, 'proprium.publishing', ['workspace.file.read', 'workspace.plugin.invoke', 'artifact.create', 'artifact.append', 'artifact.seal', 'artifact.discard']);
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
});
