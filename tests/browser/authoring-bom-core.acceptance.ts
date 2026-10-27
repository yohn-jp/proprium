import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { chooseFile, expectEditorText } from './restored-ui.helpers.js';

const original = '\uFEFF雨の夜🌙。\r\n朝の港。\r\n';
const suffix = '追記。\r\n';
test('Core preserves BOM, Japanese, supplementary characters and CRLF through save and export', async ({ page }) => {
  await page.goto('/?e2e=1');
  await page.waitForFunction(() => typeof window.propriumHostTest?.openWorkspace === 'function');
  await page.evaluate(async text => window.propriumHostTest!.openWorkspace({ provider: 'local', name: 'bom-core', branch: 'main', localWorkspaceId: `bom-${crypto.randomUUID()}` }, { 'manuscript/bom.md': text }), original);
  await chooseFile(page, 'manuscript/bom.md');
  await expectEditorText(page, original);
  await page.evaluate(text => {
    const view = (document.querySelector('.cm-content') as any)?.cmTile?.root?.view;
    if (!view) throw new Error('CodeMirror view unavailable');
    view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
  }, suffix);
  await expectEditorText(page, original + suffix);
  await page.getByRole('button', { name: '端末に保存', exact: true }).click();
  await expect(page.locator('.host-message[role="status"]')).toContainText('saved to this browser\'s local Git worktree');
  const menu = page.locator('details.host-document-menu');
  await menu.locator('summary').click();
  const pending = page.waitForEvent('download');
  await menu.getByRole('button', { name: 'この文書を書き出す' }).click();
  const download = await pending;
  const path = await download.path();
  if (!path) throw new Error('Downloaded document is unavailable');
  expect(await readFile(path)).toEqual(Buffer.from(original + suffix, 'utf8'));
});
