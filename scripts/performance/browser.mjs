import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { chromium, expect } from '@playwright/test';
import { distribution, save } from './common.mjs';
import { installBrowserProbes } from './browser-probes.mjs';
const [datasetPath, output, repeatsArg = '20', idleArg = '35000'] = process.argv.slice(2);
const repeats = Number(repeatsArg), idleMs = Number(idleArg);
const dataset = JSON.parse(await readFile(join(datasetPath, 'dataset.json'), 'utf8'));
let page;
const report = { profile: 'core', dataset, node: process.version, samples: [], phases: [], requests: [], status: 'running', notChecked: [] };
const server = fork(new URL('./server.mjs', import.meta.url), [resolve(datasetPath)], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let browser, cdp, browserCDP;
async function browserRuntime() {
  const { processInfo } = await browserCDP.send('SystemInfo.getProcessInfo');
  return Promise.all(processInfo.map(async info => {
    let rssBytes = null;
    try { rssBytes = Number((await readFile(`/proc/${info.id}/status`, 'utf8')).match(/^VmRSS:\s+(\d+)/m)?.[1]) * 1024; } catch {}
    return { ...info, rssBytes };
  }));
}
async function stats() { const next = once(server, 'message'); server.send('stats'); return (await next)[0]; }
async function phase(name, action) {
  const start = performance.now();
  const value = await action();
  report.samples.push({ name, ms: performance.now() - start });
  await save(output, report); return value;
}
try {
  const [ready] = await once(server, 'message');
  report.serverStartupMs = ready.startupMs;
  browser = await chromium.launch({ headless: true, ...(process.env.SCRIPTORIUM_E2E_CHROMIUM ? { executablePath: process.env.SCRIPTORIUM_E2E_CHROMIUM } : {}) });
  report.browser = browser.version();
  browserCDP = await browser.newBrowserCDPSession();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(installBrowserProbes);
  page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.on('request', request => report.requests.push({ start: performance.now(), method: request.method(), path: new URL(request.url()).pathname, type: request.resourceType() }));
  const base = `http://127.0.0.1:${ready.port}`;
  cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  report.network = { encodedTransferBytes: 0, completed: 0, failed: 0 };
  cdp.on('Network.loadingFinished', e => { report.network.encodedTransferBytes += e.encodedDataLength; report.network.completed++; });
  cdp.on('Network.loadingFailed', () => report.network.failed++);
  await cdp.send('Performance.enable');
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.start');
  await phase('startup.loginReady', async () => { await page.goto(base + '/desktop/'); await page.getByLabel('アクセストークン').waitFor(); });
  await page.getByLabel('アクセストークン').fill('synthetic-benchmark-local-token-000000');
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await page.getByLabel('GitHub リポジトリ URL').fill(pathToFileURL(ready.remote).href);
  await phase('startup.registerToOutline', async () => { await page.getByRole('button', { name: 'リポジトリを登録' }).click(); await page.getByRole('button', { name: 'Chapter One: Scene 1', exact: true }).waitFor(); });
  const editor = page.locator('.cm-content');
  async function openScene(id) {
    await page.getByRole('button', { name: `Chapter One: Scene ${id}`, exact: true }).click();
    await expect(page.getByRole('heading', { name: `Scene ${id}`, exact: true })).toBeVisible();
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await editor.press('Control+Home');
    // Heading can precede the paired snapshot read: verify expected manuscript too.
    await expect(editor).toContainText(`Synthetic scene ${id}`);
  }
  await phase('startup.firstEditor', () => openScene(1));
  report.phases.push({ name: 'startup', server: await stats(), browser: await page.evaluate(() => structuredClone(window.__wave0)), cdp: await cdp.send('Performance.getMetrics'), runtime: await browserRuntime() });
  for (let id = 1; id <= 3; id++) {
    await openScene(id);
    await editor.focus();
    await editor.press('Control+End');
    const start = await page.evaluate(() => performance.now());
    for (let i = 0; i < repeats; i++) {
      await editor.press('a');
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    }
    for (let i = 0; i < repeats; i++) await editor.press('ArrowLeft');
    await editor.press('Control+z'); await editor.press('Control+Shift+z');
    await cdp.send('Input.imeSetComposition', { text: 'にほんご', selectionStart: 4, selectionEnd: 4 });
    await cdp.send('Input.insertText', { text: '日本語' });
    await cdp.send('Input.insertText', { text: '\nSynthetic paste. '.repeat(64) });
    // Wait for the actual strict IDB transaction, then debounce and queued work to settle.
    await page.waitForFunction(at => window.__wave0.transactions.some(tx => tx.start > at && tx.mode === 'readwrite' && tx.status === 'complete'), start);
    await page.waitForTimeout(1000);
    const end = await page.evaluate(() => performance.now());
    report.phases.push({ name: `input.${dataset.documentBytes[id - 1]}`, start, end, server: await stats(),
      browser: await page.evaluate(() => structuredClone(window.__wave0)), cdp: await cdp.send('Performance.getMetrics'), runtime: await browserRuntime() });
    await save(output, report);
  }
  for (let i = 0; i < repeats; i++) await phase('file.switch', () => openScene(i % 3 + 1));
  // Use the UI's existing Checkpoint and Publish contracts on a local synthetic remote only.
  await editor.press('Control+End'); await editor.press('b');
  await page.waitForTimeout(600);
  await phase('ui.checkpoint', async () => {
    const checkpoint = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/checkpoints'));
    await page.getByRole('button', { name: 'Checkpoint', exact: true }).click();
    const receipt = await checkpoint;
    if (!receipt.ok() || !(await receipt.json()).operationId) throw new Error('Checkpoint did not return a receipt');
    await expect(page.locator('.durability-message')).toContainText('ローカルチェックポイント');
  });
  await phase('ui.publish', async () => {
    const publication = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/publish'));
    await page.getByRole('button', { name: 'Save to GitHub', exact: true }).click();
    const receipt = await publication;
    if (!receipt.ok() || (await receipt.json()).state !== 'confirmed') throw new Error('Publication was not confirmed');
    await expect(page.getByText('Saved to GitHub', { exact: true })).toBeVisible();
  });
  async function idle(name) {
    const before = await stats(), requestsBefore = report.requests.length;
    const runtimeBefore = await browserRuntime();
    const metricsBefore = await cdp.send('Performance.getMetrics'), start = performance.now();
    await page.waitForTimeout(idleMs);
    report.phases.push({ name, elapsedMs: performance.now() - start, requests: report.requests.slice(requestsBefore),
      before, after: await stats(), runtimeBefore, runtimeAfter: await browserRuntime(), metricsBefore, metricsAfter: await cdp.send('Performance.getMetrics'),
      visibility: await page.evaluate(() => document.visibilityState) });
  }
  // The status text can become visible before publication refresh requests finish.
  // Exclude that foreground tail before counting background requests.
  await page.waitForLoadState('networkidle');
  await idle('idle.visible');
  const foreground = await context.newPage(); await foreground.bringToFront();
  if (await page.evaluate(() => document.hidden)) await idle('idle.hidden');
  else report.notChecked.push('Hidden idle: headless Chromium did not hide the original page when another tab was foregrounded. No synthetic visibility override.');
  report.storageEstimate = await page.evaluate(() => navigator.storage.estimate());
  report.browserMetrics = await page.evaluate(() => structuredClone(window.__wave0));
  report.server = await stats();
  report.browserRuntime = await browserRuntime();
  report.cdpMetrics = await cdp.send('Performance.getMetrics');
  report.summaries = Object.fromEntries([...new Set(report.samples.map(s => s.name))].map(name => [name, distribution(report.samples.filter(s => s.name === name).map(s => s.ms))]));
  const profile = await cdp.send('Profiler.stop');
  await writeFile(output + '.cpuprofile', JSON.stringify(profile.profile));
  report.notChecked.push('Native OS English/Japanese IME and physical devices; CDP composition is synthetic.', 'React component render durations: production build has commit counts only.', '24-hour idle and network outage/crash load scenarios.');
  report.status = 'complete';
} catch (error) { report.status = 'failed'; report.error = error.stack;
  if (page && !page.isClosed()) {
    report.browserMetrics = await page.evaluate(() => structuredClone(window.__wave0)).catch(() => null);
    report.server = await stats().catch(() => null);
  }
  process.exitCode = 1; }
finally {
  if (browser) await browser.close();
  if (server.connected) { const exited = once(server, 'exit'); server.send('stop'); await exited; }
  await save(output, report);
}
