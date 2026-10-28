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
  'manuscript/custom/a.md': '---\ntitle: draft\nprivate_note: omit\n---\n太郎は言った。「行こう。」彼女は悲しかった。\n',
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

test('signed offline authoring panels read saved context and lint Japanese text', async ({ page }) => {
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
  await page.evaluate(async files => window.propriumHostTest!.openWorkspace({ provider: 'local', name: 'publishing-e2e', branch: 'main', localWorkspaceId: `publishing-${crypto.randomUUID()}` }, files), fixture);
  await showPanel(page, 'review');
  const manager = page.locator('details.plugin-manager-panel');
  await manager.locator('summary').click();
  await page.getByRole('button', { name: '信頼済みカタログを表示' }).click();
  await install(page, 'proprium.narrative', ['workspace.change.propose', 'workspace.change.timestamp', 'workspace.file.read', 'workspace.identity.read']);
  await install(page, 'proprium.knowledge', ['workspace.file.read']);
  await install(page, 'proprium.speaker', ['workspace.file.read', 'workspace.plugin.invoke', 'workspace.derived.cache']);
  await install(page, 'proprium.diagnostics', ['workspace.file.read']);
  await install(page, 'proprium.paired-writing', ['workspace.file.read', 'workspace.plugin.invoke', 'workspace.derived.cache', 'plugin.preferences']);
  await openPanel(page, '文章・場面診断');
  const diagnostics = page.getByRole('tabpanel', { name: '文章・場面診断', exact: true }).first();
  await diagnostics.getByRole('tab', { name: '文章lint' }).click();
  await diagnostics.getByRole('textbox', { name: '文章', exact: true }).fill('彼は…笑った。');
  await diagnostics.getByRole('button', { name: '送信', exact: true }).click();
  await diagnostics.getByRole('tab', { name: '所見' }).click();
  await expect(diagnostics).toContainText('三点リーダー（…）が1つだけ使われています');
  await openPanel(page, 'Paired Writing');
  const paired = page.getByRole('tabpanel', { name: 'Paired Writing', exact: true }).first();
  await paired.getByRole('textbox', { name: 'Scene ID' }).fill('s1');
  await paired.getByRole('button', { name: '送信', exact: true }).click();
  await paired.getByRole('tab', { name: 'Captured context' }).click();
  await expect(paired).toContainText('manuscript/custom/a.md');
  await paired.getByRole('tab', { name: 'Synonym prompt', exact: true }).click();
  await paired.getByRole('textbox', { name: 'Original term' }).fill('悲しかった');
  await paired.getByRole('textbox', { name: 'Sentence' }).fill('彼女は悲しかった。');
  await paired.getByRole('button', { name: '送信', exact: true }).click();
  await paired.getByRole('tab', { name: 'Synonym prompt result' }).click();
  await expect(paired).toContainText('悲しかった');
  await paired.getByRole('tab', { name: 'Model settings', exact: true }).click();
  await paired.getByRole('button', { name: 'Workspace and local settingsを読み込む', exact: true }).click();
  await expect(paired).toContainText('quality-flash');
  await openPanel(page, 'Dialogue attribution');
  const speaker = page.getByRole('tabpanel', { name: 'Dialogue attribution', exact: true }).first();
  await speaker.getByRole('button', { name: 'Choose a sceneを読み込む', exact: true }).click();
  // Preserve the real signed plugin read. Distinguish an action error from an
  // empty or still-loading list instead of reporting an opaque click timeout.
  const scene = speaker.getByRole('button', { name: /雨の夜/ });
  await expect.poll(async () => {
    const error = speaker.locator('.authoring-error');
    if (await error.isVisible()) return `read failed: ${await error.innerText()}`;
    if (await scene.isVisible()) return 'scene ready';
    const stillLoading = await speaker.locator('.authoring-surface-body[aria-busy="true"]').isVisible();
    return stillLoading ? 'loading' : 'scene missing';
  }, { message: 'Signed Speaker must load a scene or expose the actual read error' }).toBe('scene ready');
  await scene.click();
  await speaker.getByRole('tab', { name: 'Attributions' }).click();
  await expect(speaker).toContainText('行こう');
  expect(outboundWrites).toEqual([]);
});

