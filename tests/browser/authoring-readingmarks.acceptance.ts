import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { showPanel } from './restored-ui.helpers.js';

const bodyA = '雨の夜。灯台が光る。\n';
const bodyB = '海から朝日が昇った。終わり。\n';
const revisionA = createHash('sha256').update(bodyA).digest('hex');
const fixture: Record<string, string> = {
  'meta/project.yaml': 'title: 夜の旅\n',
  'plot/volumes/v/volume.yaml': 'id: v1\ntype: volume\ntitle: 第一巻\norder: 1\n',
  'plot/volumes/v/chapters/c/chapter.yaml': 'id: c1\ntype: chapter\ntitle: 始まり\nvolume: v1\norder: 1\n',
  'plot/volumes/v/chapters/c/scenes/a.yaml': 'id: s1\ntype: scene\ntitle: 雨の夜\nvolume: v1\nchapter: c1\norder: 1\nmanuscript: manuscript/custom/a.md\n',
  'plot/volumes/v/chapters/c/scenes/b.yaml': 'id: s2\ntype: scene\ntitle: 朝の港\nvolume: v1\nchapter: c1\norder: 2\nmanuscript: manuscript/custom/b.md\n',
  'manuscript/custom/a.md': bodyA, 'manuscript/custom/b.md': bodyB,
  'meta/proprium/plugins/proprium.narrative/resume.v1.yaml': `schemaVersion: 1\npositions:\n  - deviceId: portable-test-device\n    repositoryId: 301\n    branch: main\n    sceneId: s1\n    manuscriptPath: manuscript/custom/a.md\n    manuscriptRevision: ${revisionA}\n    sentenceIndex: 1\n    scrollTop: 0\n    updatedAt: 2026-01-01T00:00:00Z\n`,
};
async function setup(page: Page) {
  const registryDir = resolve(process.env.PROPRIUM_PUBLISHING_REGISTRY_DIR!);
  const registryUrl = new URL(process.env.VITE_PROPRIUM_PLUGIN_REGISTRY_URL!);
  const registryPrefix = registryUrl.pathname.slice(0, registryUrl.pathname.lastIndexOf('/') + 1);
  await page.route(`${registryUrl.origin}${registryPrefix}**`, async route => {
    const relative = decodeURIComponent(new URL(route.request().url()).pathname.slice(registryPrefix.length));
    const path = resolve(registryDir, relative);
    if (!path.startsWith(registryDir + sep)) return route.fulfill({ status: 404 });
    try { await route.fulfill({ body: await readFile(path), contentType: path.endsWith('.json') ? 'application/json' : 'application/octet-stream', headers: { 'access-control-allow-origin': '*' } }); }
    catch { await route.fulfill({ status: 404 }); }
  });
  await page.goto('/');
  await page.waitForFunction(() => typeof window.propriumHostTest?.openWorkspace === 'function');
  await page.evaluate(async files => window.propriumHostTest!.openWorkspace({ origin: 'https://github.com', repositoryId: 301, owner: 'proprium-test', repository: 'navigation', branch: 'main', localWorkspaceId: `navigation-${crypto.randomUUID()}` }, files), fixture);
  await showPanel(page, 'review');
  const manager = page.locator('details.plugin-manager-panel');
  await manager.locator('summary').click();
  await page.getByRole('button', { name: '信頼済みカタログを表示' }).click();
  await page.getByRole('button', { name: 'proprium.narrative 0.1.0 の署名済みプレビューを確認' }).click();
  await page.getByRole('button', { name: 'ダウンロードして無効状態でインストール' }).click();
  await expect(manager.getByRole('status')).toContainText('署名とダイジェストを検証し、無効状態でインストールしました');
  const plugin = page.getByRole('listitem').filter({ hasText: 'proprium.narrative' }).filter({ hasText: 'v0.1.0' });
  for (const capability of ['workspace.change.propose', 'workspace.change.timestamp', 'workspace.file.read', 'workspace.identity.read']) await plugin.getByRole('checkbox', { name: capability, exact: true }).check();
  await plugin.getByRole('button', { name: 'Enable' }).click();
  await expect(manager.getByRole('status')).toContainText('proprium.narrative@0.1.0 is enabled');
}
async function openSceneA(page: Page) {
  const configuration = page.locator('.st-workspace-configuration');
  if (await configuration.getAttribute('open') === null) await configuration.locator(':scope > summary').click();
  const menu = page.locator('.st-workspace-panel-menu');
  if (await menu.getAttribute('open') === null) await menu.locator(':scope > summary').click();
  await page.getByRole('button', { name: 'Work outlineを表示する', exact: true }).click();
  if (await configuration.getAttribute('open') !== null) await configuration.locator(':scope > summary').click();
  const outlineTab = page.getByRole('tab', { name: 'Work outline', exact: true });
  if (await outlineTab.isVisible()) await outlineTab.click();
  const outline = page.getByRole('tabpanel', { name: 'Work outline', exact: true }).first();
  await outline.getByRole('button', { name: '読み込む', exact: true }).click();
  await outline.getByText('第一巻', { exact: true }).click();
  await outline.getByText('始まり', { exact: true }).click();
  await outline.getByText('雨の夜', { exact: true }).click();
  await showPanel(page, 'editor');
  await expect.poll(() => page.evaluate(() => window.propriumHostEditorText?.() ?? '')).toBe(bodyA);
}

test('saved selection becomes a reviewed reading mark without changing manuscript text', async ({ page }) => {
  await setup(page); await openSceneA(page);
  const editor = page.getByRole('textbox', { name: '原稿 Markdown' });
  await editor.click();
  await page.keyboard.press('Control+Home');
  for (let index = 0; index < 3; index++) await page.keyboard.press('Shift+ArrowRight');
  const capture = page.getByRole('region', { name: '選択範囲に読書マーク' });
  await capture.getByRole('button', { name: '選択範囲に読書マークを提案' }).click();
  await expect(capture.getByRole('status')).toContainText('レビューで確認してください。');
  await showPanel(page, 'review');
  const review = page.getByRole('region', { name: 'Authoring proposals' });
  await review.getByRole('button').first().click();
  await expect(review).toContainText('plot/volumes/v/chapters/c/scenes/a.yaml');
  await expect(review).toContainText('readingMarks');
  await review.getByRole('checkbox').first().check();
  await review.getByRole('button', { name: '選択した単位をローカルへ適用' }).click();
  await expect(review.getByRole('button', { name: /proprium.narrative · applied/ })).toBeVisible({ timeout: 60000 });
  await showPanel(page, 'editor');
  await expect.poll(() => page.evaluate(() => window.propriumHostEditorText?.() ?? '')).toBe(bodyA);
});
