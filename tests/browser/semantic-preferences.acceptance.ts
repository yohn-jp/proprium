import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { showPanel } from './restored-ui.helpers.js';

test('Semantic local preference persists without model or provider requests', async ({ page }) => {
  const registryDir = resolve(process.env.PROPRIUM_OFFICIAL_E2E_DIR ?? process.env.PROPRIUM_PUBLISHING_REGISTRY_DIR!);
  const registryUrl = new URL(process.env.VITE_PROPRIUM_PLUGIN_REGISTRY_URL!);
  const prefix = registryUrl.pathname.slice(0, registryUrl.pathname.lastIndexOf('/') + 1);
  const unexpected: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.includes('/semantic/chunks/') || url.pathname.includes('/semantic/assets/') || /openai|anthropic|googleapis|generativelanguage|huggingface/iu.test(url.hostname)) unexpected.push(url.origin + url.pathname);
  });
  await page.route(`${registryUrl.origin}${prefix}**`, async route => {
    const relative = decodeURIComponent(new URL(route.request().url()).pathname.slice(prefix.length));
    const path = resolve(registryDir, relative);
    if (!path.startsWith(registryDir + sep)) return route.fulfill({ status: 404 });
    try { await route.fulfill({ body: await readFile(path), contentType: path.endsWith('.json') ? 'application/json' : 'application/octet-stream', headers: { 'access-control-allow-origin': '*' } }); }
    catch { await route.fulfill({ status: 404 }); }
  });
  const identity = { provider: 'local' as const, name: 'semantic-preferences', branch: 'main', localWorkspaceId: `semantic-pref-${Date.now()}` };
  async function openWorkspace(files?: Record<string, string>) {
    await page.waitForFunction(() => typeof window.propriumHostTest?.openWorkspace === 'function');
    await page.evaluate(async ({ identity, files }) => window.propriumHostTest!.openWorkspace(identity, files), { identity, files });
    await showPanel(page, 'review');
  }
  await page.goto('/');
  await openWorkspace({ 'manuscript/start.md': '文章。\n' });
  const manager = page.locator('details.plugin-manager-panel');
  await manager.locator('summary').click();
  await page.getByRole('button', { name: '信頼済みカタログを表示' }).click();
  for (const [id, version] of [['proprium.research', '1.0.0'], ['proprium.semantic', '0.1.0']]) {
    await page.getByRole('button', { name: `${id} ${version} の署名済みプレビューを確認` }).click();
    await page.getByRole('button', { name: 'ダウンロードして無効状態でインストール' }).click();
    await expect(manager.getByRole('status')).toContainText('署名とダイジェストを検証し、無効状態でインストールしました');
    const plugin = page.getByRole('listitem').filter({ hasText: id }).filter({ hasText: `v${version}` });
    if (id === 'proprium.semantic') await plugin.getByRole('checkbox', { name: 'plugin.preferences', exact: true }).check();
    await plugin.getByRole('button', { name: 'Enable' }).click();
    await expect(manager.getByRole('status')).toContainText(`${id}@${version} is enabled`);
  }
  async function settings() {
    const section = page.locator('details').filter({ has: page.getByText('Semantic のローカル設定', { exact: true }) });
    await section.locator(':scope > summary').click();
    return section.getByRole('region', { name: 'Semantic 設定' });
  }
  let panel = await settings();
  const toggle = panel.getByRole('checkbox', { name: '再順位付けを有効にする' });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await panel.getByRole('button', { name: '設定を保存' }).click();
  await expect(panel.getByText('このブラウザーの設定を保存しました。')).toBeVisible();
  await page.reload();
  await openWorkspace();
  panel = await settings();
  await expect(panel.getByRole('checkbox', { name: '再順位付けを有効にする' })).toBeChecked();
  expect(unexpected).toEqual([]);
});
