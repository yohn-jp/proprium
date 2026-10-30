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
  const registryDir = resolve(process.env.PROPRIUM_OFFICIAL_E2E_DIR ?? process.env.PROPRIUM_PUBLISHING_REGISTRY_DIR!);
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
  await page.goto('/');
  await page.waitForFunction(() => typeof window.propriumHostTest?.openWorkspace === 'function');
  await page.evaluate(async files => window.propriumHostTest!.openWorkspace({ origin: 'https://github.com', repositoryId: 301, owner: 'proprium-test', repository: 'navigation', branch: 'main', localWorkspaceId: `navigation-${crypto.randomUUID()}` }, files), fixture);
  await showPanel(page, 'review');
  const manager = page.locator('details.plugin-manager-panel');
  await manager.locator('summary').click();
  await page.getByRole('button', { name: 'カタログを表示' }).click();
  await page.getByRole('button', { name: 'proprium.narrative v0.1.0 の導入内容と署名を確認' }).click();
  await page.getByRole('button', { name: 'ダウンロードして無効状態でインストール' }).click();
  await expect(manager.getByRole('status')).toContainText('署名とダイジェストを検証し、無効状態でインストールしました');
  const plugin = page.locator(".installed-plugins > li").filter({ hasText: 'proprium.narrative' }).filter({ hasText: 'v0.1.0' });
  for (const capability of ['workspace.change.propose', 'workspace.change.timestamp', 'workspace.file.read', 'workspace.identity.read']) await plugin.getByRole('checkbox', { name: capability, exact: true }).check();
  await plugin.getByRole('button', { name: '有効化' }).click();
  await expect(manager.getByRole('status')).toContainText('proprium.narrative@0.1.0 is enabled');
}
async function openSceneA(page: Page) {
  const configuration = page.locator('.st-workspace-configuration');
  if (await configuration.getAttribute('open') === null) await configuration.locator(':scope > summary').click();
  const menu = page.locator('.st-workspace-panel-menu');
  if (await menu.getAttribute('open') === null) await menu.locator(':scope > summary').click();
  await page.getByRole('button', { name: 'Work outlineを表示する', exact: true }).click();
  if (await configuration.getAttribute('open') !== null) await configuration.locator(':scope > summary').click();
  const tab = page.getByRole('tab', { name: 'Work outline', exact: true }).first();
  if (await tab.isVisible() && await tab.getAttribute('aria-selected') !== 'true') await tab.click();
  const outline = page.getByRole('tabpanel', { name: 'Work outline', exact: true }).first();
  await outline.getByRole('button', { name: '読み込む', exact: true }).click();
  await expect(outline.getByRole('button', { name: '更新', exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(outline.locator('.authoring-surface-body')).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
  await outline.getByRole('tab', { name: '構成', exact: true }).click();
  await outline.getByText('第一巻', { exact: true }).click();
  await outline.getByText('始まり', { exact: true }).click();
  await outline.getByText('雨の夜', { exact: true }).click();
  await showPanel(page, 'editor');
  await expect.poll(() => page.evaluate(() => window.propriumHostEditorText?.() ?? '')).toBe(bodyA);
}

test('next scene opens the pinned next scene and reports the end', async ({ page }) => {
  await setup(page); await openSceneA(page);
  const navigation = page.getByRole('region', { name: '次のシーン' });
  await navigation.getByRole('button', { name: '次のシーンを確認' }).click();
  await navigation.getByRole('button', { name: '次のシーンを開く' }).click();
  await expect.poll(() => page.evaluate(() => window.propriumHostEditorText?.() ?? '')).toBe(bodyB);
  await navigation.getByRole('button', { name: '次のシーンを確認' }).click();
  await expect(navigation.getByRole('status')).toHaveText('最後のシーンです。');
});

test('dirty draft prevents navigation without losing editor text', async ({ page }) => {
  await setup(page); await openSceneA(page);
  await page.evaluate(() => { const view = (document.querySelector('.cm-content') as any)?.cmTile?.root?.view; view.dispatch({ changes: { from: 0, insert: '未保存。' } }); });
  const navigation = page.getByRole('region', { name: '次のシーン' });
  await navigation.getByRole('button', { name: '次のシーンを確認' }).click();
  await navigation.getByRole('button', { name: '次のシーンを開く' }).click();
  await expect(navigation.getByRole('alert')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.propriumHostEditorText?.() ?? '')).toBe('未保存。' + bodyA);
});

test('Mobile quick append writes to the existing editor and keeps the exact text locally', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page); await openSceneA(page);
  const append = page.getByRole('region', { name: 'クイック追記' });
  await expect(append).toContainText('雨の夜。灯台が光る。');
  await append.getByRole('textbox', { name: '追記する文章' }).fill('新しい文章です。');
  await append.getByRole('button', { name: '原稿に追記' }).click();
  await expect(append.getByRole('status')).toContainText('Host の下書き回復記録へ保存しました。', { timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => window.propriumHostEditorText?.() ?? ''), { timeout: 60_000 }).toBe(bodyA + '\n新しい文章です。');
});

test('portable marker validates its saved body and opens the scene', async ({ page }) => {
  await setup(page);
  await showPanel(page, 'review');
  const portable = page.getByRole('region', { name: '端末別の保存位置' });
  await portable.getByRole('button', { name: '端末別の保存位置を確認' }).click();
  await expect(portable).toContainText('portable-test-device');
  await expect(portable).toContainText('ready');
  await portable.getByRole('button', { name: 'この位置を確認' }).click();
  await portable.getByRole('button', { name: '確認した位置を開く' }).click();
  await showPanel(page, 'editor');
  await expect.poll(() => page.evaluate(() => window.propriumHostEditorText?.() ?? '')).toBe(bodyA);
});

test('portable marker creation is reviewed and remains local until explicit publication', async ({ page }) => {
  const outboundWrites: string[] = [];
  page.on('request', request => { if (/github\.com|git-receive-pack/u.test(request.url()) && !['GET', 'HEAD'].includes(request.method())) outboundWrites.push(`${request.method()} ${request.url()}`); });
  await setup(page); await openSceneA(page);
  await page.evaluate(() => {
    const view = (document.querySelector('.cm-content') as any)?.cmTile?.root?.view;
    if (!view) throw new Error('CodeMirror view unavailable');
    view.dispatch({ selection: { anchor: 6, head: 6 } });
    view.focus();
  });
  await showPanel(page, 'review');
  const portable = page.getByRole('region', { name: '端末別の保存位置' });
  await portable.getByRole('button', { name: '現在の位置を共有用に提案' }).click();
  await expect(portable.getByRole('status')).toContainText('変更提案を作成しました。', { timeout: 60_000 });
  const review = page.getByRole('region', { name: 'Authoring proposals' });
  await review.getByRole('button', { name: /proprium\.narrative · proposed/u }).last().click();
  await expect(review).toContainText('resume.v1.yaml');
  await review.getByRole('checkbox').last().check();
  await review.getByRole('button', { name: '選択した単位をローカルへ適用' }).last().click();
  await expect(review.getByRole('button', { name: /proprium\.narrative · applied/u })).toHaveCount(1, { timeout: 60_000 });
  await portable.getByRole('button', { name: '端末別の保存位置を確認' }).click();
  await expect(portable).toContainText('local_only', { timeout: 60_000 });
  expect(outboundWrites).toEqual([]);
});
