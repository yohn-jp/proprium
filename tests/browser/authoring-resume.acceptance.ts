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
  'manuscript/custom/a.md': Array.from({ length: 140 }, (_, i) => `第${i + 1}行。🌙雨の夜に灯台が光る。`).join('\r\n') + '\r\n',
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

test('saved scene resumes the exact Japanese selection and viewport after reopen', async ({ page }) => {
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
  const identity = { provider: 'local' as const, name: 'resume-e2e', branch: 'main', localWorkspaceId: `resume-${crypto.randomUUID()}` };
  await page.evaluate(async ({ identity, files }) => window.propriumHostTest!.openWorkspace(identity, files), { identity, files: fixture });
  await showPanel(page, 'review');
  const manager = page.locator('details.plugin-manager-panel');
  await manager.locator('summary').click();
  await page.getByRole('button', { name: '信頼済みカタログを表示' }).click();
  await install(page, 'proprium.narrative', ['workspace.change.propose', 'workspace.change.timestamp', 'workspace.file.read', 'workspace.identity.read']);
  await openPanel(page, 'Work outline');
  const outline = page.getByRole('tabpanel', { name: 'Work outline', exact: true }).first();
  await outline.getByRole('button', { name: '読み込む', exact: true }).click();
  await outline.getByText('第一巻', { exact: true }).click();
  await outline.getByText('始まり', { exact: true }).click();
  await outline.getByText('雨の夜', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.propriumHostEditorText?.() ?? ''), { timeout: 60_000 }).toContain('第140行');
  await showPanel(page, 'editor');
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const saved = await page.evaluate(() => {
    const node = document.querySelector('.cm-content') as any;
    const view = node?.cmTile?.root?.view;
    if (!view) throw new Error('CodeMirror view unavailable');
    const text = view.state.doc.toString();
    const head = text.indexOf('第80行'), anchor = head + 9;
    view.dispatch({ selection: { anchor, head } });
    view.focus();
    const scrollOwner = view.scrollDOM.closest('.st-workspace-panel-body, .st-workspace-mobile-pane') as HTMLElement | null;
    if (!scrollOwner) throw new Error('Workspace scroll container unavailable');
    scrollOwner.scrollTop = Math.floor((scrollOwner.scrollHeight - scrollOwner.clientHeight) / 2);
    scrollOwner.dispatchEvent(new Event('scroll'));
    return { text, anchor, head, scroll: scrollOwner.scrollTop };
  });
  expect(saved.anchor).toBeGreaterThan(saved.head);
  expect(saved.scroll).toBeGreaterThan(0);
  // CodeMirror layout may adjust the outer pane after the initial scroll assignment.
  // Wait until the persisted value matches the actual settled pane and selection.
  let settledScroll = 0;
  await expect.poll(async () => {
    const result = await page.evaluate(({ anchor, head }) => {
      const node = document.querySelector('.cm-content') as any; const view = node?.cmTile?.root?.view;
      const outer = view?.scrollDOM.closest('.st-workspace-panel-body, .st-workspace-mobile-pane') as HTMLElement | null;
      if (!view || !outer || view.state.selection.main.anchor !== anchor || view.state.selection.main.head !== head) return null;
      const scroll = outer.scrollTop;
      const saved = Object.values(localStorage).some(raw => {
        try { const record = JSON.parse(raw); return record.schema === 'proprium.writing-resume/v1' && record.value?.selection?.anchor === anchor && record.value?.selection?.head === head && record.value?.position?.scroll_top === scroll; }
        catch { return false; }
      });
      return saved ? scroll : null;
    }, saved);
    if (result !== null) settledScroll = result;
    return result !== null;
  }, { timeout: 30_000 }).toBe(true);
  saved.scroll = settledScroll;
  const originalBytes = await page.evaluate(async ({ identity }) => {
    const { BrowserLocalGit } = await import(/* @vite-ignore */ new URL('/src/browser/proprium/git/index.ts', location.origin).href);
    const git = new BrowserLocalGit(identity); await git.init(); const file = await git.read('manuscript/custom/a.md'); git.close();
    return Array.from(file.data ?? []);
  }, { identity });
  expect(Buffer.from(originalBytes).toString('utf8')).toBe(fixture['manuscript/custom/a.md']);
  await page.reload();
  await page.waitForFunction(() => typeof window.propriumHostTest?.openWorkspace === 'function');
  await page.evaluate(async identity => window.propriumHostTest!.openWorkspace(identity), identity);
  await showPanel(page, 'review');
  await page.getByRole('button', { name: /Continue writing proprium.narrative/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Resume status' }).click();
  await dialog.getByRole('button', { name: 'Check saved positionを読み込む' }).click();
  await expect(dialog).toContainText('A current resume position is available');
  await dialog.getByRole('tab', { name: 'Open saved scene' }).click();
  await dialog.getByRole('button', { name: '送信', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => page.evaluate(() => {
    const view = (document.querySelector('.cm-content') as any)?.cmTile?.root?.view;
    const owner = view?.scrollDOM.closest('.st-workspace-panel-body, .st-workspace-mobile-pane') as HTMLElement | null;
    return view && owner ? { text: view.state.doc.toString(), anchor: view.state.selection.main.anchor, head: view.state.selection.main.head, scroll: owner.scrollTop } : null;
  }), { timeout: 60_000 }).toEqual(saved);
  const afterBytes = await page.evaluate(async ({ identity }) => {
    const { BrowserLocalGit } = await import(/* @vite-ignore */ new URL('/src/browser/proprium/git/index.ts', location.origin).href);
    const git = new BrowserLocalGit(identity); await git.init(); const file = await git.read('manuscript/custom/a.md'); git.close();
    return Array.from(file.data ?? []);
  }, { identity });
  expect(afterBytes).toEqual(originalBytes);
});

for (const variant of ['stale', 'foreign'] as const) {
  test(`resume ${variant} workspace does not move an unrelated editor selection`, async ({ page }) => {
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
  const identity = { provider: 'local' as const, name: 'resume-e2e', branch: 'main', localWorkspaceId: `resume-${crypto.randomUUID()}` };
  await page.evaluate(async ({ identity, files }) => window.propriumHostTest!.openWorkspace(identity, files), { identity, files: fixture });
  await showPanel(page, 'review');
  const manager = page.locator('details.plugin-manager-panel');
  await manager.locator('summary').click();
  await page.getByRole('button', { name: '信頼済みカタログを表示' }).click();
    await install(page, 'proprium.narrative', ['workspace.change.propose', 'workspace.change.timestamp', 'workspace.file.read', 'workspace.identity.read']);
    await openPanel(page, 'Work outline');
    const outline = page.getByRole('tabpanel', { name: 'Work outline', exact: true }).first();
    await outline.getByRole('button', { name: '読み込む', exact: true }).click();
    await outline.getByText('第一巻', { exact: true }).click();
    await outline.getByText('始まり', { exact: true }).click();
    await outline.getByText('雨の夜', { exact: true }).click();
    await showPanel(page, 'editor');
    await expect.poll(() => page.evaluate(() => window.propriumHostEditorText?.() ?? '')).toContain('第140行');
    await page.evaluate(() => { const view = (document.querySelector('.cm-content') as any)?.cmTile?.root?.view; const at = view.state.doc.toString().indexOf('第80行'); view.dispatch({ selection: { anchor: at + 5, head: at } }); view.focus(); });
    await page.reload();
    await page.waitForFunction(() => typeof window.propriumHostTest?.openWorkspace === 'function');
    if (variant === 'stale') {
      await page.evaluate(async identity => {
        const { BrowserLocalGit } = await import(/* @vite-ignore */ new URL('/src/browser/proprium/git/index.ts', location.origin).href);
        const git = new BrowserLocalGit(identity); await git.init(); const before = await git.read('manuscript/custom/a.md');
        await git.write('manuscript/custom/a.md', new TextEncoder().encode('保存後に変更した原稿。\r\n'), before.revision); git.close();
      }, identity);
      await page.evaluate(async identity => window.propriumHostTest!.openWorkspace(identity), identity);
    } else {
      const foreign = { ...identity, localWorkspaceId: `${identity.localWorkspaceId}-foreign` };
      await page.evaluate(async ({ identity, files }) => window.propriumHostTest!.openWorkspace(identity, files), { identity: foreign, files: fixture });
    }
    await showPanel(page, 'outline');
    await page.getByRole('list', { name: 'Repository files' }).getByRole('button', { name: 'manuscript/custom/b.md' }).click();
    await showPanel(page, 'editor');
    const before = await page.evaluate(() => {
      const view = (document.querySelector('.cm-content') as any)?.cmTile?.root?.view;
      view.dispatch({ selection: { anchor: 4, head: 2 } }); view.focus();
      return { text: view.state.doc.toString(), anchor: view.state.selection.main.anchor, head: view.state.selection.main.head };
    });
    await showPanel(page, 'review');
    await page.getByRole('button', { name: /Continue writing proprium.narrative/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Resume status' }).click();
    await dialog.getByRole('button', { name: 'Check saved positionを読み込む' }).click();
    await expect(dialog).toContainText(variant === 'stale' ? 'saved position needs a manual scene choice' : 'There is no saved local scene position');
    await dialog.getByRole('tab', { name: 'Open saved scene' }).click();
    await expect(dialog.getByRole('button', { name: '送信', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Continue writingを閉じる' }).click();
    await showPanel(page, 'editor');
    const after = await page.evaluate(() => { const view = (document.querySelector('.cm-content') as any)?.cmTile?.root?.view; return { text: view.state.doc.toString(), anchor: view.state.selection.main.anchor, head: view.state.selection.main.head }; });
    expect(after).toEqual(before);
  });
}
