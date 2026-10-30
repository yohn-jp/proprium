import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

const BGE_GROUP_ID = 'proprium.semantic.reranker.bge-v2-m3';
const BGE_GROUP_BYTES = 2_288_661_281;
const BGE_GROUP_SHA256 = '970674bb1a64e34e9ce5c74bded1b90f85b602700f86344f0e209312163b9447';
const BGE_MODEL_ID = 'mogolloni/bge-reranker-v2-m3-onnx';
const BGE_MODEL_REVISION = 'e5023553f6c47f09057da7a19cdd79ef850a4985';
const E5_GROUP_ID = 'proprium.semantic.embedding.e5-small';
const E5_GROUP_BYTES = 492_423_173;
const TARGET_PATH = 'manuscript/lighthouse.md';
const TARGET_TEXT = '霧深い夜、灯台の光が沖を行く船に進む先を示した。';
const QUERY = '暗い海を航行する船に方角を示して安全を支える沿岸の設備';

const fixture: Record<string, string> = {
  'meta/project.yaml': 'title: 海辺の記録\n',
  'plot/volumes/v/chapters/c/scenes/lighthouse.yaml': 'id: scene-lighthouse\ntype: scene\ntitle: 灯台\nvolume: v\nchapter: c\norder: 1\nmanuscript: manuscript/lighthouse.md\n',
  'plot/volumes/v/chapters/c/scenes/garden.yaml': 'id: scene-garden\ntype: scene\ntitle: 梅の庭\nvolume: v\nchapter: c\norder: 2\nmanuscript: manuscript/garden.md\n',
  'plot/volumes/v/chapters/c/scenes/station.yaml': 'id: scene-station\ntype: scene\ntitle: 終電\nvolume: v\nchapter: c\norder: 3\nmanuscript: manuscript/station.md\n',
  [TARGET_PATH]: `${TARGET_TEXT}\n`,
  'manuscript/garden.md': '春の朝、庭の梅に白い花がいくつも咲いていた。風が枝を揺らし、花びらが石畳に舞った。\n',
  'manuscript/station.md': '終電を待つ人々が、駅のホームに並んでいた。遠くで発車を知らせるベルが鳴った。\n',
};

interface Transfer { url: string; bytes: number; status: number | null }
interface HostTestWindow extends Window {
  propriumHostTest?: { openWorkspace(identity: { provider: 'local'; name: string; branch: string; localWorkspaceId: string }, files?: Record<string, string>): Promise<void> };
}

async function showWorkspacePanel(page: Page, panel: 'editor' | 'review'): Promise<void> {
  const desktopName = panel === 'editor' ? 'ワークスペース' : 'レビューとツール';
  const desktop = page.getByRole('button', { name: `パネル：${desktopName}`, exact: true });
  if (await desktop.isVisible()) { await desktop.click(); return; }
  const navigation = page.getByRole('navigation', { name: 'モバイルの主要画面' });
  if (!(await navigation.isVisible())) await page.getByRole('button', { name: '画面の切替を表示' }).click();
  await expect(navigation).toBeVisible();
  await navigation.getByRole('button', { name: panel === 'editor' ? '書く' : 'ツール', exact: true }).click();
}

async function routeSignedRegistry(page: Page): Promise<Set<string>> {
  const directory = resolve(process.env.PROPRIUM_OFFICIAL_E2E_DIR ?? process.env.PROPRIUM_PUBLISHING_REGISTRY_DIR ?? '');
  if (!directory || directory === resolve('.')) throw new Error('The signed BGE authoring registry build did not provide its artifact directory');
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
  return allowedOrigins;
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

function watchNetwork(page: Page, allowedOrigins: Set<string>) {
  const forbidden: string[] = [];
  const unexpectedOrigins: string[] = [];
  const offlineRequests: string[] = [];
  const chunks: Promise<Transfer>[] = [];
  let offline = false;
  page.on('request', request => {
    const url = new URL(request.url());
    if (/openai|anthropic|googleapis|generativelanguage|huggingface/iu.test(url.hostname)) forbidden.push(`${request.method()} ${url.origin}${url.pathname}`);
    if (!allowedOrigins.has(url.origin)) unexpectedOrigins.push(`${request.method()} ${url.origin}${url.pathname}`);
    if (offline && /^https?:$/u.test(url.protocol)) offlineRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
    if (url.pathname.includes('/proprium/semantic/chunks/')) {
      chunks.push(request.response().then(async response => {
        const length = Number(response?.headers()['content-length'] ?? 0);
        return { url: url.origin + url.pathname, bytes: Number.isSafeInteger(length) && length > 0 ? length : 0, status: response?.status() ?? null };
      }));
    }
  });
  return { forbidden, unexpectedOrigins, offlineRequests, chunks, markOffline: () => { offline = true; } };
}

function uniqueTransferBytes(transfers: readonly Transfer[]): number {
  return [...new Map(transfers.map(item => [item.url, item.bytes])).values()].reduce((sum, bytes) => sum + bytes, 0);
}

async function openAssets(page: Page) {
  const assets = page.locator('details.authoring-assets');
  await expect(assets).toBeVisible();
  if (await assets.getAttribute('open') === null) await assets.locator('summary').click();
  return assets;
}

async function inspectGroup(page: Page, groupId: string) {
  const assets = await openAssets(page);
  const group = assets.locator('li').filter({ hasText: groupId });
  await expect(group).toBeVisible();
  await group.getByRole('button', { name: '配布データと容量を確認' }).click();
  const preview = assets.getByRole('region', { name: '追加データの容量確認' });
  await expect(preview).toBeVisible({ timeout: 90_000 });
  await expect(preview).toContainText(groupId);
  return { assets, preview };
}

async function admitGroup(preview: Locator, expectedBytes: number): Promise<void> {
  await expect(preview).toContainText(`${expectedBytes.toLocaleString()} bytes`);
  const consent = preview.getByRole('checkbox', { name: '表示された転送量・保存容量を確認した' });
  await expect(consent).not.toBeChecked();
  const start = preview.getByRole('button', { name: '確認したデータの取得を開始' });
  await expect(start).toBeDisabled();
  await consent.check();
  await start.click();
  await expect(preview.locator('..').getByRole('status').last()).toContainText('取得中', { timeout: 90_000 });
  await expect(preview.locator('..').getByRole('status').last()).toContainText('署名・全チャンク・ファイルのダイジェストを検証して、このブラウザーに保存しました', { timeout: 30 * 60_000 });
}

/** Observe only the signed Semantic Worker result fields needed by acceptance. The message is never changed or replayed. */
async function installReadOnlyBgeResultObserver(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type BgeObservation = { modelId: unknown; modelRevision: unknown; rows: Array<{ score: unknown; rank: unknown }> };
    const key = '__propriumBgeResultObservations';
    Object.defineProperty(window, key, { configurable: false, enumerable: false, writable: false, value: [] as BgeObservation[] });
    const nativeWorker = window.Worker;
    const observedWorker = new Proxy(nativeWorker, {
      construct(target, argumentsList, newTarget) {
        const worker = Reflect.construct(target, argumentsList, newTarget) as Worker;
        worker.addEventListener('message', event => {
          const message = (event as MessageEvent).data as {
            pluginId?: unknown; type?: unknown; result?: { ok?: unknown; value?: unknown };
          } | null;
          if (!message || message.pluginId !== 'proprium.semantic' || message.type !== 'result' || message.result?.ok !== true ||
              !message.result.value || typeof message.result.value !== 'object') return;
          const value = message.result.value as { model?: { id?: unknown; revision?: unknown }; results?: unknown };
          if (value.model?.id !== 'mogolloni/bge-reranker-v2-m3-onnx') return;
          const rows = Array.isArray(value.results) ? value.results.map(row => {
            const item = row && typeof row === 'object' ? row as { score?: unknown; rank?: unknown } : {};
            return { score: item.score, rank: item.rank };
          }) : [];
          ((window as unknown as Record<string, BgeObservation[]>)[key]).push({
            modelId: value.model.id,
            modelRevision: value.model.revision,
            rows,
          });
        });
        return worker;
      },
    });
    Object.defineProperty(window, 'Worker', { configurable: true, value: observedWorker });
  });
}

async function bgeObservations(page: Page): Promise<Array<{ modelId: unknown; modelRevision: unknown; rows: Array<{ score: unknown; rank: unknown }> }>> {
  return page.evaluate(() => ((window as unknown as Record<string, unknown>)['__propriumBgeResultObservations'] ?? []) as
    Array<{ modelId: unknown; modelRevision: unknown; rows: Array<{ score: unknown; rank: unknown }> }>);
}

async function openSearch(page: Page) {
  await showWorkspacePanel(page, 'review');
  const search = page.getByRole('region', { name: 'Research 検索' });
  await expect(search).toBeVisible({ timeout: 90_000 });
  return search;
}

async function searchSemantic(page: Page) {
  const search = await openSearch(page);
  await search.getByRole('textbox', { name: '検索語' }).fill(QUERY);
  await search.getByRole('combobox', { name: '検索方法' }).selectOption('semantic');
  await search.getByRole('button', { name: '検索', exact: true }).click();
  await expect(search.getByRole('status').last()).toHaveText('検索結果を表示しています。', { timeout: 12 * 60_000 });
  return search;
}

async function assertTargetAndOpenSource(page: Page, search: Awaited<ReturnType<typeof openSearch>>): Promise<string[]> {
  const results = search.getByRole('list', { name: '検索結果' });
  await expect(results.locator('li')).toHaveCount(3);
  const rows = await results.locator('li').allTextContents();
  const target = results.locator('li').filter({ hasText: TARGET_PATH }).first();
  await expect(target).toContainText(TARGET_TEXT);
  await target.getByRole('button', { name: '原文を開く' }).click();
  await showWorkspacePanel(page, 'editor');
  await expect.poll(() => page.locator('.cm-content').first().evaluate(element => {
    const content = element as HTMLElement & { cmTile?: { root?: { view?: { state: { doc: { toString(): string } } } } } };
    return content.cmTile?.root?.view?.state.doc.toString() ?? null;
  })).toBe(`${TARGET_TEXT}\n`);
  return rows;
}

async function attach(testInfo: TestInfo, stage: string, value: Record<string, unknown>): Promise<void> {
  await testInfo.attach(`semantic-bge-real-${stage}.json`, { body: Buffer.from(JSON.stringify(value, null, 2)), contentType: 'application/json' });
}

test('signed BGE has separate consent and preference, prepares with resumable progress, reranks source-quoted candidates, and reloads offline', async ({ page, browserName }, testInfo) => {
  testInfo.setTimeout(55 * 60_000);
  expect(browserName).toBe('chromium');
  const metrics: Record<string, unknown> = {
    sourceRevision: process.env.PROPRIUM_TEST_SOURCE_REVISION ?? 'e9f06bd',
    modelId: BGE_MODEL_ID,
    modelRevision: BGE_MODEL_REVISION,
    modelGroup: BGE_GROUP_ID,
    modelGroupSha256: BGE_GROUP_SHA256,
    startedAt: new Date().toISOString(),
  };
  const allowedOrigins = await routeSignedRegistry(page);
  const network = watchNetwork(page, allowedOrigins);
  await installReadOnlyBgeResultObserver(page);
  const identity = { provider: 'local' as const, name: 'semantic-bge-real', branch: 'main', localWorkspaceId: `semantic-bge-real-${Date.now()}` };

  await page.goto('/');
  await openWorkspace(page, identity, fixture);
  await installSignedPlugin(page, 'proprium.research', '1.0.0', ['workspace.file.read', 'workspace.derived.cache']);
  await installSignedPlugin(page, 'proprium.semantic', '0.1.0', ['workspace.file.read', 'workspace.asset.read', 'workspace.derived.cache', 'plugin.preferences']);
  await openWorkspace(page, identity);

  const device = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    deviceMemoryGiB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
    hardwareConcurrency: navigator.hardwareConcurrency,
    mobile: (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile ?? null,
    storageAvailable: Boolean(navigator.storage),
  }));
  metrics.device = device;

  const e5 = await inspectGroup(page, E5_GROUP_ID);
  await expect(e5.preview).toContainText(`${E5_GROUP_BYTES.toLocaleString()} bytes`);
  const e5BytesFrom = network.chunks.length;
  await admitGroup(e5.preview, E5_GROUP_BYTES);
  const e5Transfers = await Promise.all(network.chunks.slice(e5BytesFrom));
  metrics.e5Admission = { transferCount: e5Transfers.length, uniqueBytes: uniqueTransferBytes(e5Transfers), statuses: [...new Set(e5Transfers.map(item => item.status))] };
  expect(e5Transfers.length).toBeGreaterThan(0);
  expect(e5Transfers.every(item => item.status === 200)).toBe(true);
  expect(uniqueTransferBytes(e5Transfers)).toBe(E5_GROUP_BYTES);
  await attach(testInfo, 'e5-admitted', metrics);

  if (process.env.PROPRIUM_RUN_BGE_FULL_INFERENCE === '1') {
    const indexTasks = page.getByRole('region', { name: 'Semantic タスク' });
    await expect(indexTasks).toBeVisible();
    await indexTasks.getByRole('button', { name: 'インデックスを構築・検索モデルを準備' }).click();
    await expect(indexTasks.getByRole('status').filter({ hasText: /:\s*complete\b/u })).toBeVisible({ timeout: 15 * 60_000 });

    // Capture a user-visible baseline before the separate BGE preference is enabled.
    const baselineSearch = await searchSemantic(page);
    const baselineOrder = await assertTargetAndOpenSource(page, baselineSearch);
    metrics.semanticBaselineOrder = baselineOrder;
  } else {
    metrics.semanticIndexAndBaseline = 'NOT_CHECKED: deferred to the separately gated BGE full-inference run.';
  }

  const bge = await inspectGroup(page, BGE_GROUP_ID);
  const previewText = await bge.preview.innerText();
  metrics.bgeAssetPreview = previewText;
  expect(previewText).toContain(`${BGE_GROUP_BYTES.toLocaleString()} bytes`);
  expect(previewText).toContain(BGE_GROUP_SHA256);
  expect(previewText).toContain('Apache-2.0');
  expect(previewText).toContain('4,294,967,296 bytes');
  const bgeConsent = bge.preview.getByRole('checkbox', { name: '表示された転送量・保存容量を確認した' });
  const bgeAdmission = bge.preview.getByRole('button', { name: '確認したデータの取得を開始' });
  await expect(bgeConsent).not.toBeChecked();
  await expect(bgeAdmission).toBeDisabled();
  // E5's independently completed consent did not start any BGE transfer.
  expect(network.chunks.length).toBe(e5BytesFrom + e5Transfers.length);

  const settingsDisclosure = page.locator('details').filter({ has: page.getByText('Semantic のローカル設定', { exact: true }) });
  const bgeTasks = page.getByRole('region', { name: 'BGE 再順位付けモデルの準備' });
  await expect(bgeTasks).toBeVisible();
  const prepareBeforePreference = bgeTasks.getByRole('button', { name: 'BGE モデルをこの端末で準備' });
  await expect(prepareBeforePreference).toBeDisabled();
  if (await settingsDisclosure.getAttribute('open') === null) await settingsDisclosure.locator(':scope > summary').click();
  const settings = settingsDisclosure.getByRole('region', { name: 'Semantic 設定' });
  const preference = settings.getByRole('checkbox', { name: '再順位付けを有効にする' });
  await expect(preference).not.toBeChecked();
  await preference.check();
  await settings.getByRole('button', { name: '設定を保存' }).click();
  await expect(settings.getByText('このブラウザーの設定を保存しました。')).toBeVisible();
  await bgeTasks.getByRole('button', { name: '状態を更新' }).click();
  await expect(prepareBeforePreference).toBeEnabled();

  const bgeChunkStart = network.chunks.length;
  await admitGroup(bge.preview, BGE_GROUP_BYTES);
  const bgeTransfers = await Promise.all(network.chunks.slice(bgeChunkStart));
  metrics.bgeAdmission = { transferCount: bgeTransfers.length, uniqueBytes: uniqueTransferBytes(bgeTransfers), statuses: [...new Set(bgeTransfers.map(item => item.status))] };
  expect(bgeTransfers.length).toBeGreaterThan(0);
  expect(bgeTransfers.every(item => item.status === 200)).toBe(true);
  expect(uniqueTransferBytes(bgeTransfers)).toBe(BGE_GROUP_BYTES);
  await attach(testInfo, 'bge-admitted', metrics);

  await expect(bgeTasks).toBeVisible();
  const prepare = bgeTasks.getByRole('button', { name: 'BGE モデルをこの端末で準備' });
  await expect(prepare).toBeEnabled();
  const prepareStarted = Date.now();
  await prepare.click();
  const progress = bgeTasks.getByRole('progressbar').first();
  await expect(progress).toBeVisible({ timeout: 90_000 });
  await expect.poll(() => progress.evaluate(element => (element as HTMLProgressElement).value), { timeout: 5 * 60_000, intervals: [250, 500, 1_000, 2_000] }).toBeGreaterThan(0);
  const cancelledAt = await progress.evaluate(element => ({ value: (element as HTMLProgressElement).value, max: (element as HTMLProgressElement).max }));
  metrics.bgeFirstProgress = cancelledAt;
  await bgeTasks.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await expect(bgeTasks.getByRole('status').filter({ hasText: /:\s*cancelled\b/u })).toBeVisible({ timeout: 90_000 });

  if (process.env.PROPRIUM_RUN_BGE_FULL_INFERENCE !== '1') {
    metrics.fullBgePreparation = 'NOT_CHECKED: large tensor loading, resume-to-complete, E5 indexing, BGE inference/rerank, and offline reprepare are deferred pending measured resource estimate.';
    metrics.bgeCancelledAfter = cancelledAt;
    metrics.bgePartialAcceptanceMs = Date.now() - prepareStarted;
    testInfo.annotations.push({ type: 'acceptance-status', description: 'NOT_CHECKED: full BGE tensor loading, resume, inference, rerank and offline reprepare are separately gated until resource and runtime estimates are reviewed.' });
    await attach(testInfo, 'bge-admitted-cancelled', metrics);
    expect(network.forbidden).toEqual([]);
    expect(network.unexpectedOrigins).toEqual([]);
    return;
  }

  await bgeTasks.getByRole('button', { name: '再開', exact: true }).click();
  await expect(bgeTasks.getByRole('status').filter({ hasText: /:\s*complete\b/u })).toBeVisible({ timeout: 30 * 60_000 });
  metrics.bgePreparationAndResumeMs = Date.now() - prepareStarted;
  await attach(testInfo, 'bge-prepared', metrics);

  const rerankedSearch = await searchSemantic(page);
  const rerankedOrder = await assertTargetAndOpenSource(page, rerankedSearch);
  metrics.rerankedSemanticOrder = rerankedOrder;
  const warningText = await rerankedSearch.getByRole('list', { name: '検索の注意' }).allTextContents().catch(() => []);
  metrics.rerankWarnings = warningText;
  expect(warningText.join('\n')).not.toMatch(/再順位付けを利用できません|再順位付けできる意味検索候補がありません|原文候補を検証できず/u);
  const modelObservations = await bgeObservations(page);
  expect(modelObservations.length).toBeGreaterThan(0);
  for (const observation of modelObservations) {
    expect(observation.modelId).toBe(BGE_MODEL_ID);
    expect(observation.modelRevision).toBe(BGE_MODEL_REVISION);
    expect(observation.rows.length).toBeGreaterThanOrEqual(2);
    const scores = observation.rows.map(row => row.score);
    const ranks = observation.rows.map(row => row.rank);
    expect(scores.every(score => typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1)).toBe(true);
    expect(ranks.every(rank => Number.isSafeInteger(rank) && Number(rank) >= 1 && Number(rank) <= ranks.length)).toBe(true);
    expect(new Set(ranks).size).toBe(ranks.length);
  }
  metrics.bgeWorkerObservations = modelObservations;
  await attach(testInfo, 'reranked-search', metrics);

  // Reload destroys the live WASM model state. Reprepare and search again from already verified local assets while offline.
  await page.reload();
  await openWorkspace(page, identity);
  await page.context().setOffline(true);
  network.markOffline();
  const offlineTasks = page.getByRole('region', { name: 'BGE 再順位付けモデルの準備' });
  await expect(offlineTasks).toBeVisible({ timeout: 90_000 });
  const reprepare = offlineTasks.getByRole('button', { name: /BGE モデルをこの(実行環境で確認・再準備|端末で準備)/u });
  await expect(reprepare).toBeEnabled();
  await reprepare.click();
  await expect(offlineTasks.getByRole('status').filter({ hasText: /:\s*complete\b/u })).toBeVisible({ timeout: 30 * 60_000 });
  const offlineSearch = await searchSemantic(page);
  const offlineOrder = await assertTargetAndOpenSource(page, offlineSearch);
  metrics.offlineRerankedSemanticOrder = offlineOrder;
  metrics.offlineRequests = network.offlineRequests;
  expect(network.offlineRequests).toEqual([]);
  expect(network.forbidden).toEqual([]);
  expect(network.unexpectedOrigins).toEqual([]);
  await page.context().setOffline(false);
  await attach(testInfo, 'offline-reranked-search', metrics);
});
