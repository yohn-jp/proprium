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
  const identity = { origin: 'https://github.com' as const, repositoryId: 301, owner: 'proprium-test', repository: 'navigation', branch: 'main', localWorkspaceId: `navigation-${crypto.randomUUID()}` };
  await page.evaluate(async ({ identity, files }) => window.propriumHostTest!.openWorkspace(identity, files), { identity, files: fixture });
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
  return identity;
}
async function openSceneA(page: Page) {
  if (await page.locator(".mobile-shell").count()) await showPanel(page, "review");
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
  await expect(outline.getByRole('button', { name: '更新', exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(outline.locator('.authoring-surface-body')).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
  await outline.getByRole('tab', { name: '構成', exact: true }).click();
  await outline.getByText('第一巻', { exact: true }).click();
  await outline.getByText('始まり', { exact: true }).click();
  await outline.getByText('雨の夜', { exact: true }).click();
  await showPanel(page, 'editor');
  await expect.poll(() => page.evaluate(() => window.propriumHostEditorText?.() ?? '')).toBe(bodyA);
}

test('two reviewed reading marks open their saved source ranges', async ({ page }) => {
  const identity = await setup(page); await openSceneA(page);
  const capture = page.getByRole('region', { name: '選択範囲に読書マーク' });
  for (const [offset, length] of [[0, 3], [5, 2]]) {
    const editor = page.getByRole('textbox', { name: '原稿 Markdown' });
    await editor.click();
    await page.keyboard.press('Control+Home');
    for (let index = 0; index < offset!; index++) await page.keyboard.press('ArrowRight');
    for (let index = 0; index < length!; index++) await page.keyboard.press('Shift+ArrowRight');
    await capture.getByRole('button', { name: '選択範囲に読書マークを提案' }).click();
    await expect(capture.getByRole('status')).toContainText('レビューで確認してください。');
    await showPanel(page, 'review');
    const review = page.getByRole('region', { name: 'Authoring proposals' });
    await review.getByRole('button', { name: /proprium.narrative · proposed/ }).last().click();
    await expect(review).toContainText('plot/volumes/v/chapters/c/scenes/a.yaml');
    await expect(review).toContainText('readingMarks');
    await review.getByRole('checkbox').last().check();
    await review.getByRole('button', { name: '選択した単位をローカルへ適用' }).last().click();
    await expect(review.getByRole('button', { name: /proprium.narrative · applied/ })).toHaveCount(offset === 0 ? 1 : 2, { timeout: 60000 });
    await showPanel(page, 'editor');
    await expect.poll(() => page.evaluate(() => window.propriumHostEditorText?.() ?? '')).toBe(bodyA);
  }
  if (await page.locator(".mobile-shell").count()) await showPanel(page, "review");
  const configuration = page.locator('.st-workspace-configuration');
  if (await configuration.getAttribute('open') === null) await configuration.locator(':scope > summary').click();
  const menu = page.locator('.st-workspace-panel-menu');
  if (await menu.getAttribute('open') === null) await menu.locator(':scope > summary').click();
  await page.getByRole('button', { name: '読書マークを表示する', exact: true }).click();
  if (await configuration.getAttribute('open') !== null) await configuration.locator(':scope > summary').click();
  const tab = page.getByRole('tab', { name: '読書マーク', exact: true });
  if (await tab.isVisible()) await tab.click();
  const panel = page.getByRole('tabpanel', { name: '読書マーク', exact: true }).first();
  await panel.getByRole('button', { name: '本文で読書マークを開くを読み込む' }).click();
  await panel.getByText('雨の夜', { exact: true }).click();
  await showPanel(page, 'editor');
  await expect.poll(() => page.evaluate(() => window.propriumHostEditorText?.() ?? '')).toBe(bodyA);
  await expect.poll(() => page.evaluate(() => { const view = (document.querySelector('.cm-content') as any)?.cmTile?.root?.view; if (!view) return null; const selection = view.state.selection.main; return { from: selection.from, to: selection.to, text: view.state.doc.sliceString(selection.from, selection.to) }; })).toEqual({ from: 0, to: 3, text: '雨の夜' });
  await expect(page.getByText(/選択 3 字/u)).toBeVisible();
  await capture.getByRole('button', { name: '選択した読書マークの削除を提案' }).click();
  await expect(capture.getByRole('status')).toContainText('削除提案を作成しました。');
  await showPanel(page, 'review');
  const review = page.getByRole('region', { name: 'Authoring proposals' });
  await review.getByRole('button', { name: /proprium.narrative · proposed/ }).last().click();
  await expect(review).toContainText('readingMarks');
  await review.getByRole('checkbox').last().check();
  await review.getByRole('button', { name: '選択した単位をローカルへ適用' }).last().click();
  await expect(review.getByRole('button', { name: /proprium.narrative · applied/ })).toHaveCount(3, { timeout: 60000 });
  const saved = await page.evaluate(async identity => {
    const { BrowserLocalGit } = await import(/* @vite-ignore */ new URL('/src/browser/proprium/git/index.ts', location.origin).href);
    const git = new BrowserLocalGit(identity); await git.init();
    const metadata = await git.read('plot/volumes/v/chapters/c/scenes/a.yaml');
    const manuscript = await git.read('manuscript/custom/a.md');
    git.close();
    if (!metadata.data || !manuscript.data) throw new Error('Saved Narrative source files are missing');
    return { metadata: new TextDecoder().decode(metadata.data), manuscript: new TextDecoder().decode(manuscript.data) };
  }, identity);
  const savedMarks = saved.metadata.slice(saved.metadata.indexOf('readingMarks:'));
  expect(savedMarks).toContain('台が');
  expect(savedMarks).not.toContain('雨の夜');
  expect(saved.manuscript).toBe(bodyA);
  await showPanel(page, 'editor');
  await expect.poll(() => page.evaluate(() => document.querySelector('.cm-content')?.textContent ?? '')).toContain('雨の夜。灯台が光る。');
  await expect.poll(() => page.evaluate(() => { const view = (document.querySelector('.cm-content') as any)?.cmTile?.root?.view; if (!view) return null; const selection = view.state.selection.main; return { from: selection.from, to: selection.to, text: view.state.doc.sliceString(selection.from, selection.to) }; })).toEqual({ from: 0, to: 3, text: '雨の夜' });
});
