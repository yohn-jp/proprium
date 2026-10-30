import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

const E5_GROUP_BYTES = 492_423_173;
const E5_GROUP_ID = 'proprium.semantic.embedding.e5-small';
const TARGET_PATH = 'manuscript/lighthouse.md';
const TARGET_TEXT = '霧深い夜、灯台の光が沖を行く船に進む先を示した。';
const QUERY = '暗い海を航行する船に方角を示して安全を支える沿岸の設備';
const HYBRID_QUERY = '沖を進む船を夜の光が導く';
const fixture: Record<string, string> = {
  'meta/project.yaml': 'title: 海辺の記録\n',
  'plot/scenes/lighthouse.yaml': 'id: scene-lighthouse\ntype: scene\nmanuscript: manuscript/lighthouse.md\n',
  [TARGET_PATH]: `${TARGET_TEXT}\n`,
  'manuscript/library.md': '雨音を聞きながら、少女は机に広げた古い地図を読み返した。\n',
  'manuscript/garden.md': '春の朝、庭の梅に白い花がいくつも咲いていた。\n',
  'manuscript/harbor.md': '漁師は波の音を聞き、出港の時刻を確かめた。\n',
  'manuscript/letter.md': '彼女は旅先から届いた手紙を胸にしまった。\n',
  'manuscript/mountain.md': '稜線の向こうから朝日が昇り、山道を明るく照らした。\n',
  'manuscript/river.md': '川辺の小屋では、古い時計が静かに時を刻んでいた。\n',
  'manuscript/station.md': '終電を待つ人々が、駅のホームに並んでいた。\n',
  'manuscript/snow.md': '雪の積もった森で、足跡が小さな小屋へ続いていた。\n',
  'manuscript/cabin.md': '戸棚には古い薬缶が置かれていた。窓辺に小さな鉢植えが並んでいた。壁には旅の写真が掛かっていた。暖炉の火が部屋を暖めていた。\n',
};

interface Transfer { url: string; bytes: number; status: number | null }
interface HostTestWindow extends Window {
  propriumHostTest?: { openWorkspace(identity: { provider: 'local'; name: string; branch: string; localWorkspaceId: string }, files?: Record<string, string>): Promise<void> };
}

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus || page.isClosed()) return;
  const failures = await page.evaluate(() => new Promise<unknown[]>(resolve => {
    const request = indexedDB.open('proprium-authoring-tasks-v1', 1);
    request.onerror = () => resolve([]);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('tasks')) { db.close(); resolve([]); return; }
      const read = db.transaction('tasks', 'readonly').objectStore('tasks').getAll();
      read.onsuccess = () => { db.close(); resolve(read.result.map(row => ({
        state: row.progress?.state, phase: row.progress?.phase, completed: row.progress?.completed,
        total: row.progress?.total, failure_code: row.failure_code,
      }))); };
      read.onerror = () => { db.close(); resolve([]); };
    };
  })).catch(() => []);
  console.log('Host task failure classifications:', JSON.stringify(failures));
  await testInfo.attach('host-task-failures.json', { contentType: 'application/json', body: Buffer.from(JSON.stringify(failures)) });
});

async function showWorkspacePanel(page: Page, panel: 'editor' | 'review'): Promise<void> {
  const desktopName = panel === 'editor' ? 'ワークスペース' : 'レビューとツール';
  const desktop = page.getByRole('button', { name: `パネル：${desktopName}`, exact: true });
  if (await desktop.isVisible()) { await desktop.click(); return; }
  if (await page.locator('.mobile-shell').count()) {
    const navigation = page.getByRole('navigation', { name: 'モバイルの主要画面' });
    if (!(await navigation.isVisible())) {
      const reveal = page.getByRole('button', { name: '画面の切替を表示' });
      if (await reveal.isVisible()) await reveal.click();
    }
    await expect(navigation).toBeVisible();
    const button = navigation.getByRole('button', { name: panel === 'editor' ? '書く' : 'ツール', exact: true });
    await button.click();
    await expect(page.getByRole('tabpanel', { name: panel === 'editor' ? '原稿' : 'レビューとツール', exact: true })).toBeVisible();
    return;
  }
  throw new Error(`Workspace ${panel} panel navigation was not visible`);
}

async function routeSignedRegistry(page: Page): Promise<{ allowedOrigins: Set<string>; registryOrigin: string }> {
  const directory = resolve(process.env.PROPRIUM_OFFICIAL_E2E_DIR ?? process.env.PROPRIUM_PUBLISHING_REGISTRY_DIR ?? '');
  if (!directory || directory === resolve('.')) throw new Error('Signed authoring registry build did not provide its artifact directory');
  const registryUrl = new URL(process.env.VITE_PROPRIUM_PLUGIN_REGISTRY_URL!);
  const prefix = registryUrl.pathname.slice(0, registryUrl.pathname.lastIndexOf('/') + 1);
  const artifactBase = process.env.PROPRIUM_AUTHORING_TEST_ARTIFACT_BASE
    ? new URL(process.env.PROPRIUM_AUTHORING_TEST_ARTIFACT_BASE)
    : registryUrl;
  const allowedOrigins = new Set([registryUrl.origin, artifactBase.origin, new URL(process.env.PROPRIUM_PUBLISHING_E2E_BASE_URL ?? `http://127.0.0.1:${process.env.PROPRIUM_E2E_PORT ?? '4173'}/`).origin]);
  await page.route(url => (url.origin === registryUrl.origin || url.origin === artifactBase.origin) && url.pathname.startsWith(prefix), async route => {
    const relative = decodeURIComponent(new URL(route.request().url()).pathname.slice(prefix.length));
    const path = resolve(directory, relative);
    if (!path.startsWith(directory + sep)) return route.fulfill({ status: 404 });
    try {
      await route.fulfill({ body: await readFile(path), contentType: path.endsWith('.json') ? 'application/json' : 'application/octet-stream', headers: { 'access-control-allow-origin': '*' } });
    } catch { await route.fulfill({ status: 404 }); }
  });
  return { allowedOrigins, registryOrigin: registryUrl.origin };
}

async function openWorkspace(page: Page, identity: { provider: 'local'; name: string; branch: string; localWorkspaceId: string }, files?: Record<string, string>): Promise<void> {
  await page.waitForFunction(() => typeof (window as HostTestWindow).propriumHostTest?.openWorkspace === 'function');
  await page.evaluate(async input => (window as HostTestWindow).propriumHostTest!.openWorkspace(input.identity, input.files), { identity, files });
  await showWorkspacePanel(page, 'review');
}

async function installSignedPlugin(page: Page, id: string, version: string, capabilities: readonly string[]): Promise<void> {
  const manager = page.locator('details.plugin-manager-panel');
  if (await manager.getAttribute('open') === null) await manager.locator('summary').click();
  if (await page.getByRole('button', { name: 'カタログを表示' }).isVisible()) await page.getByRole('button', { name: 'カタログを表示' }).click();
  await page.getByRole('button', { name: `${id} v${version} の導入内容と署名を確認` }).click();
  await page.getByRole('button', { name: 'ダウンロードして無効状態でインストール' }).click();
  await expect(manager.getByRole('status')).toContainText('署名とダイジェストを検証し、無効状態でインストールしました');
  const installed = page.locator('.installed-plugins > li').filter({ hasText: id }).filter({ hasText: `v${version}` });
  for (const capability of capabilities) {
    const grant = installed.getByRole('checkbox', { name: capability, exact: true });
    if (!(await grant.isChecked())) await grant.check();
  }
  await installed.getByRole('button', { name: '有効化' }).click();
  await expect(manager.getByRole('status')).toContainText(`${id}@${version} is enabled`);
}

function watchNetwork(page: Page, allowedOrigins: Set<string>): { forbidden: string[]; unexpectedOrigins: string[]; e5Transfers: Promise<Transfer>[]; offlineRequests: string[]; requestCount: number; markOffline(): void } {
  const forbidden: string[] = [];
  const unexpectedOrigins: string[] = [];
  const offlineRequests: string[] = [];
  const e5Transfers: Promise<Transfer>[] = [];
  let offline = false;
  let requestCount = 0;
  page.on('request', request => {
    requestCount++;
    const url = new URL(request.url());
    if (/openai|anthropic|googleapis|generativelanguage|huggingface/iu.test(url.hostname)) forbidden.push(`${request.method()} ${url.origin}${url.pathname}`);
    if (!allowedOrigins.has(url.origin)) unexpectedOrigins.push(`${request.method()} ${url.origin}${url.pathname}`);
    if (offline && /^https?:$/u.test(url.protocol)) offlineRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
    if (url.pathname.includes('/proprium/semantic/chunks/')) {
      e5Transfers.push(request.response().then(async response => {
        const length = Number(response?.headers()['content-length'] ?? 0);
        return { url: url.origin + url.pathname, bytes: Number.isSafeInteger(length) && length > 0 ? length : 0, status: response?.status() ?? null };
      }));
    }
  });
  return { forbidden, unexpectedOrigins, e5Transfers, offlineRequests, get requestCount() { return requestCount; }, markOffline: () => { offline = true; } };
}

async function openSearch(page: Page) {
  await showWorkspacePanel(page, 'review');
  const search = page.getByRole('region', { name: 'Research 検索' });
  await expect(search).toBeVisible({ timeout: 90_000 });
  return search;
}

async function search(page: Page, mode: 'lexical' | 'hybrid' | 'semantic', query: string) {
  const panel = await openSearch(page);
  await panel.getByRole('textbox', { name: '検索語' }).fill(query);
  await panel.getByRole('combobox', { name: '検索方法' }).selectOption(mode);
  await panel.getByRole('button', { name: '検索', exact: true }).click();
  await expect(panel.getByRole('status').last()).toHaveText('検索結果を表示しています。', { timeout: 90_000 });
  return panel;
}

async function assertSourceNavigation(page: Page, searchPanel: Awaited<ReturnType<typeof openSearch>>, expectedPath: string, expectedText: string): Promise<void> {
  const results = searchPanel.getByRole('list', { name: '検索結果' });
  const row = results.locator('li').filter({ hasText: expectedPath }).first();
  await expect(row).toContainText(expectedText);
  await row.getByRole('button', { name: '原文を開く' }).click();
  await showWorkspacePanel(page, 'editor');
  await expect.poll(() => page.locator('.cm-content').first().evaluate(element => {
    const content = element as HTMLElement & { cmTile?: { root?: { view?: { state: { doc: { toString(): string } } } } } };
    return content.cmTile?.root?.view?.state.doc.toString() ?? null;
  })).toBe(`${expectedText}\n`);
}

async function attachMetrics(testInfo: TestInfo, stage: string, value: Record<string, unknown>): Promise<void> {
  await testInfo.attach(`semantic-real-${stage}.json`, { body: Buffer.from(JSON.stringify(value, null, 2)), contentType: 'application/json' });
}

test('signed E5 admission gates by real device capacity; semantic search works locally and WebKit keeps lexical fallback', async ({ page, browserName }, testInfo) => {
  const metrics: Record<string, unknown> = { project: testInfo.project.name, browserName, startedAt: new Date().toISOString() };
  const transferProbe = process.env.PROPRIUM_SEMANTIC_TRANSFER_PROBE === '1';
  const { allowedOrigins } = await routeSignedRegistry(page);
  const network = watchNetwork(page, allowedOrigins);
  const identity = { provider: 'local' as const, name: 'semantic-real', branch: 'main', localWorkspaceId: `semantic-real-${Date.now()}` };
  await page.goto('/');
  await openWorkspace(page, identity, fixture);
  await installSignedPlugin(page, 'proprium.research', '1.0.0', ['workspace.file.read', 'workspace.derived.cache']);
  await installSignedPlugin(page, 'proprium.semantic', '0.1.0', ['workspace.file.read', 'workspace.asset.read', 'workspace.derived.cache', 'plugin.preferences']);
  await openWorkspace(page, identity);

  const device = await page.evaluate(() => ({ userAgent: navigator.userAgent, deviceMemoryGiB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null, hardwareConcurrency: navigator.hardwareConcurrency, mobile: (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile ?? null }));
  metrics.device = device;
  const assets = page.locator('details.authoring-assets');
  await expect(assets).toBeVisible();
  if (await assets.getAttribute('open') === null) await assets.locator('summary').click();
  const embedding = assets.locator('li').filter({ hasText: E5_GROUP_ID });
  await embedding.getByRole('button', { name: '配布データと容量を確認' }).click();
  const preview = assets.getByRole('region', { name: '追加データの容量確認' });
  await expect(preview).toBeVisible({ timeout: 90_000 });
  await expect(preview).toContainText(E5_GROUP_ID);
  const previewText = await preview.innerText();
  metrics.assetPreview = previewText;
  expect(previewText).toMatch(/492[,. ]?423[,. ]?173 bytes/u);
  expect(previewText).toContain('E5 fp32');
  expect(previewText).toContain('3 GiB');
  await attachMetrics(testInfo, 'device-preview', metrics);
  const unsupported = preview.getByRole('status');

  if (browserName !== 'chromium') {
    await expect(unsupported).toContainText('この環境では利用できません');
    expect(previewText).toContain('語句検索を利用できます');
    const admissionConsent = preview.getByRole('checkbox', { name: '表示された転送量・保存容量を確認した' });
    const admissionButton = preview.getByRole('button', { name: '確認したデータの取得を開始' });
    await expect(admissionConsent).toBeDisabled();
    await expect(admissionButton).toBeDisabled();
    await expect.poll(() => network.e5Transfers.length).toBe(0);
    const lexical = await search(page, 'lexical', '灯台');
    await expect(lexical.getByRole('list', { name: '検索結果' })).toContainText(TARGET_PATH);
    await assertSourceNavigation(page, lexical, TARGET_PATH, TARGET_TEXT);
    metrics.modelChunkRequestCount = network.e5Transfers.length;
    metrics.browserRequestCount = network.requestCount;
    expect(network.forbidden).toEqual([]);
    expect(network.unexpectedOrigins).toEqual([]);
    await attachMetrics(testInfo, 'mobile-fallback', metrics);
    return;
  }

  expect(await unsupported.count(), `Real browser capacity rejected E5 admission: ${JSON.stringify(device)}\n${previewText}`).toBe(0);
  const admissionConsent = preview.getByRole('checkbox', { name: '表示された転送量・保存容量を確認した' });
  await admissionConsent.check();
  const admissionStart = Date.now();
  await preview.getByRole('button', { name: '確認したデータの取得を開始' }).click();
  await expect(assets.getByRole('status').last()).toContainText('署名・全チャンク・ファイルのダイジェストを検証して、このブラウザーに保存しました', { timeout: 12 * 60_000 });
  metrics.assetAdmissionMs = Date.now() - admissionStart;
  const transfers = await Promise.all(network.e5Transfers);
  metrics.assetTransfers = { count: transfers.length, bytes: transfers.reduce((sum, item) => sum + item.bytes, 0), responses: transfers.map(item => item.status) };
  metrics.browserRequestCount = network.requestCount;
  await attachMetrics(testInfo, 'asset-admitted', metrics);
  expect(transfers.length).toBeGreaterThan(0);
  expect(transfers.every(item => item.status === 200)).toBe(true);
  expect([...new Map(transfers.map(item => [item.url, item.bytes])).values()].reduce((sum, bytes) => sum + bytes, 0)).toBe(E5_GROUP_BYTES);

  const tasks = page.getByRole('region', { name: 'Semantic タスク' });
  await expect(tasks).toBeVisible();
  const rebuild = tasks.getByRole('button', { name: /モデルを準備|インデックスを(作成|再構築|構築)/u });
  await expect(rebuild).toBeVisible();
  const buildStart = Date.now();
  if (transferProbe) {
    page.on('console', message => {
      if (message.text().startsWith('SEMANTIC_TASK_PULSE ')) console.log(message.text());
    });
    await page.evaluate(startedAt => {
      window.setInterval(() => {
        const region = document.querySelector("section[aria-label='Semantic タスク']");
        const progress = region?.querySelector('progress');
        const status = region?.textContent?.replace(/\s+/gu, ' ').trim() ?? 'none';
        console.log(`SEMANTIC_TASK_PULSE ${Date.now() - startedAt}ms ${progress?.value ?? 0}/${progress?.max ?? 0} ${status.slice(0, 200)}`);
      }, 30_000);
    }, buildStart);
  }
  await rebuild.click();
  const progress = tasks.getByRole('progressbar').first();
  await expect(progress).toBeVisible({ timeout: 90_000 });
  await page.waitForFunction(threshold => {
    const region = document.querySelector("section[aria-label='Semantic タスク']");
    return region && (/:\s*failed\b/u.test(region.textContent ?? '') ||
      Array.from(region.querySelectorAll('progress')).some(element => element.value >= threshold));
  }, transferProbe ? 8 * 1024 * 1024 : 1, { timeout: 90_000 });
  expect(await tasks.innerText()).not.toMatch(/:\s*failed\b/u);
  expect(await progress.evaluate(element => (element as HTMLProgressElement).value)).toBeGreaterThan(0);
  const transferProbeCompleted = await progress.evaluate(element => (element as HTMLProgressElement).value);
  const transferProbeTotal = await progress.evaluate(element => (element as HTMLProgressElement).max);
  const cancel = tasks.getByRole('button', { name: 'キャンセル', exact: true });
  await expect(cancel).toBeVisible();
  await cancel.click();
  const cancelledTask = tasks.getByRole('status').filter({ hasText: /:\s*cancelled\b/u });
  await expect(cancelledTask).toBeVisible({ timeout: 90_000 });
  if (transferProbe) {
    const elapsedMs = Date.now() - buildStart;
    metrics.modelLoadProbe = { completedBytes: transferProbeCompleted, totalBytes: transferProbeTotal, elapsedMs,
      bytesPerSecond: elapsedMs > 0 ? Math.round(transferProbeCompleted * 1000 / elapsedMs) : null };
    await attachMetrics(testInfo, 'model-load-probe', metrics);
    return;
  }
  const resume = tasks.getByRole('button', { name: /再開/u });
  await expect(resume).toBeVisible({ timeout: 90_000 });
  await resume.click();
  const completedTask = tasks.getByRole('status').filter({ hasText: /:\s*complete\b/u });
  await expect(completedTask).toBeVisible({ timeout: 12 * 60_000 });
  await expect(completedTask).toContainText(/complete · complete \([1-9]\d*\/[1-9]\d*\)/u);
  metrics.indexBuildAndResumeMs = Date.now() - buildStart;
  await attachMetrics(testInfo, 'index-complete', metrics);

  const coldStart = Date.now();
  const first = await search(page, 'semantic', QUERY);
  await assertSourceNavigation(page, first, TARGET_PATH, TARGET_TEXT);
  metrics.coldSearchMs = Date.now() - coldStart;
  const warmStart = Date.now();
  const second = await search(page, 'semantic', QUERY);
  await assertSourceNavigation(page, second, TARGET_PATH, TARGET_TEXT);
  metrics.warmSearchMs = Date.now() - warmStart;
  const hybridStart = Date.now();
  const hybrid = await search(page, 'hybrid', HYBRID_QUERY);
  await assertSourceNavigation(page, hybrid, TARGET_PATH, TARGET_TEXT);
  metrics.hybridSearchMs = Date.now() - hybridStart;
  expect(network.forbidden).toEqual([]);

  await page.reload();
  await openWorkspace(page, identity);
  await page.context().setOffline(true);
  network.markOffline();
  const offlineTasks = page.getByRole('region', { name: 'Semantic タスク' });
  await expect(offlineTasks).toBeVisible();
  await expect(offlineTasks.getByRole('status').first()).toBeVisible({ timeout: 90_000 });
  const priorOfflineTask = await offlineTasks.getByRole('status').first().innerText();
  const priorOfflineTaskId = /^([A-Za-z0-9_-]+):/u.exec(priorOfflineTask)?.[1];
  expect(priorOfflineTaskId, 'Completed online Semantic task should be available after reload').toBeTruthy();
  const prepareOffline = offlineTasks.getByRole('button', { name: 'インデックスを構築・検索モデルを準備', exact: true });
  await expect(prepareOffline).toBeVisible({ timeout: 90_000 });
  const offlineWarmStart = Date.now();
  await prepareOffline.click();
  await expect(offlineTasks.getByRole('status').first()).not.toContainText(priorOfflineTaskId!, { timeout: 90_000 });
  const offlineWarm = offlineTasks.getByRole('status').filter({ hasText: /:\s*complete\b/u });
  await expect(offlineWarm).toBeVisible({ timeout: 12 * 60_000 });
  await expect(offlineWarm).toContainText(/complete · complete \([1-9]\d*\/[1-9]\d*\)/u);
  metrics.offlineWarmMs = Date.now() - offlineWarmStart;
  const offlineStart = Date.now();
  const offlineSearch = await search(page, 'semantic', QUERY);
  await assertSourceNavigation(page, offlineSearch, TARGET_PATH, TARGET_TEXT);
  metrics.offlineCachedSearchMs = Date.now() - offlineStart;
  metrics.offlineRequests = network.offlineRequests;
  metrics.browserRequestCountAfterOfflineQuery = network.requestCount;
  metrics.offlineModelChunkRequestCount = network.e5Transfers.length - transfers.length;
  expect(network.offlineRequests).toEqual([]);
  expect(network.forbidden).toEqual([]);
  expect(network.unexpectedOrigins).toEqual([]);
  await page.context().setOffline(false);
  await attachMetrics(testInfo, 'offline-complete', metrics);
});
