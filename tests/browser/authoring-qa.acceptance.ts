import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { showPanel } from './restored-ui.helpers.js';

const fixture: Record<string, string> = {
  'bible/characters/taro.yaml': 'id: char-taro\nname: 太郎\n',
  'meta/project.yaml': 'title: 夜の旅\nsubtitle: 雨の町\n',
  'plot/volumes/v/volume.yaml': 'id: v1\ntype: volume\ntitle: 第一巻\norder: 1\n',
  'plot/volumes/v/chapters/c/chapter.yaml': 'id: c1\ntype: chapter\ntitle: 始まり\nvolume: v1\norder: 1\n',
  'plot/volumes/v/chapters/c/scenes/a.yaml': 'id: s1\ntype: scene\ntitle: 雨の夜\nvolume: v1\nchapter: c1\norder: 1\nmanuscript: manuscript/custom/a.md\nappears: [char-taro]\n',
  'plot/volumes/v/chapters/c/scenes/b.yaml': 'id: s2\ntype: scene\ntitle: 朝の港\nvolume: v1\nchapter: c1\norder: 2\nmanuscript: manuscript/custom/b.md\n',
  'manuscript/custom/a.md': '---\ntitle: draft\n---\n青い灯台は雨の港に立つ。太郎は言った。「行こう。」\n',
  'manuscript/custom/b.md': '海から朝日が昇った。終わり。\n',
};

async function install(page: Page, id: string, capabilities: string[], version = '0.1.0') {
  const manager = page.locator('details.plugin-manager-panel');
  await page.getByRole('button', { name: `${id} v${version} の導入内容と署名を確認` }).click();
  await page.getByRole('button', { name: 'ダウンロードして無効状態でインストール' }).click();
  await expect(manager.getByRole('status')).toContainText('署名とダイジェストを検証し、無効状態でインストールしました');
  const plugin = page.locator(".installed-plugins > li").filter({ hasText: id }).filter({ hasText: `v${version}` });
  for (const capability of capabilities) await plugin.getByRole('checkbox', { name: capability, exact: true }).check();
  await plugin.getByRole('button', { name: '有効化' }).click();
  await expect(manager.getByRole('status')).toContainText(`${id}@${version} is enabled`);
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

for (const research of [false, true]) {
  test(`signed Paired questions with ${research ? 'Research' : 'local fallback'}`, async ({ page }) => {
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
  const unexpectedRequests: string[] = [];
  page.on('request', request => { const url = new URL(request.url()); if (/github\.com|git-receive-pack/u.test(request.url()) && !['GET', 'HEAD'].includes(request.method())) outboundWrites.push(`${request.method()} ${request.url()}`); if (['http:', 'https:'].includes(url.protocol) && !['127.0.0.1', 'localhost', registryUrl.hostname].includes(url.hostname)) unexpectedRequests.push(request.url()); });
  await page.goto('/');
  await page.waitForFunction(() => typeof window.propriumHostTest?.openWorkspace === 'function');
  await page.evaluate(async files => window.propriumHostTest!.openWorkspace({ provider: 'local', name: 'publishing-e2e', branch: 'main', localWorkspaceId: `publishing-${crypto.randomUUID()}` }, files), fixture);
  await showPanel(page, 'review');
  const manager = page.locator('details.plugin-manager-panel');
  await manager.locator('summary').click();
  await page.getByRole('button', { name: 'カタログを表示' }).click();
    await install(page, 'proprium.narrative', ['workspace.file.read']);
    if (research) await install(page, 'proprium.research', ['workspace.file.read', 'workspace.derived.cache'], '1.0.0');
    await install(page, 'proprium.paired-writing', ['workspace.file.read', 'workspace.plugin.invoke', 'workspace.capabilities.query']);
    await openPanel(page, 'Paired Writing');
    const paired = page.getByRole('tabpanel', { name: 'Paired Writing', exact: true }).first();
    await paired.getByRole('tab', { name: 'Provider availability' }).click();
    await paired.getByRole('button', { name: 'Optional provider availabilityを読み込む' }).click();
    await expect(paired.getByRole('alert')).toContainText('外部プロバイダーは設定されていません');
    await expect(paired.getByRole('alert')).toContainText('QA・類義語のプレビューは利用できます');
    await paired.getByRole('tab', { name: 'Questions', exact: true }).click();
    const question = `灯台について${'詳しく'.repeat(180)}末尾まで確認`;
    await paired.getByRole('textbox', { name: 'Question', exact: true }).fill(question);
    await paired.getByRole('textbox', { name: 'Scene ID (optional)', exact: true }).fill('s1');
    await paired.getByRole('button', { name: '送信', exact: true }).click();
    await paired.getByRole('tab', { name: 'QA prompt result' }).click();
    await expect(paired).toContainText(question);
    await expect(paired).toContainText('青い灯台は雨の港に立つ');
    await expect(paired).toContainText('setting-qa.v1');
    await paired.getByRole('tab', { name: 'Setting question' }).click();
    await paired.getByRole('textbox', { name: 'Question', exact: true }).fill('灯台');
    await paired.getByRole('textbox', { name: 'Scene ID (optional)', exact: true }).fill('s1');
    await paired.getByRole('button', { name: '送信', exact: true }).click();
    await paired.getByRole('tab', { name: 'Question result' }).click();
    await expect(paired).toContainText('灯台');
    await expect(paired).toContainText('low');
    await expect(paired).toContainText(research ? 'research.query' : 'local.lexical');
    if (!research) await expect(paired).toContainText('partial');
    await paired.getByRole('tab', { name: 'Question sources' }).click();
    await paired.getByRole('button', { name: /灯台/ }).click();
    await expect(page.getByRole('textbox', { name: '原稿 Markdown' })).toContainText('青い灯台は雨の港に立つ');
    expect(outboundWrites).toEqual([]);
    expect(unexpectedRequests).toEqual([]);
  });
}
