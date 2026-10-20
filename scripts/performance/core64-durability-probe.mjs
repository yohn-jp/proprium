import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { distribution, save } from './common.mjs';
import { installBrowserProbes } from './browser-probes.mjs';

const [runtimeRootArg, fixtureRootArg, scratchParentArg, outputArg, navigationRepeatsArg = '8'] = process.argv.slice(2);
const expectedRuntimeSource = process.env.SCRIPTORIUM_C64_EXPECTED_RUNTIME_SHA ?? 'ffd02739ab095dfda2854a3ff487434c84f6b536';

function usage() {
  return 'Usage: node scripts/performance/core64-durability-probe.mjs <runtime-repo-root> <canonical-small-fixture> <scratch-parent> <output.json> [navigation-repeats=8] (SCRIPTORIUM_C64_RUNTIME_ROOT and SCRIPTORIUM_C64_RUNTIME_MANIFEST override runtime paths)';
}

if (!runtimeRootArg || runtimeRootArg === '--help') {
  console.log(usage());
  process.exit(runtimeRootArg === '--help' ? 0 : 2);
}
if (process.argv.length < 6) {
  console.error(usage());
  process.exit(2);
}

const runtimeRoot = resolve(process.env.SCRIPTORIUM_C64_RUNTIME_ROOT ?? runtimeRootArg);
const fixtureRoot = resolve(fixtureRootArg);
const scratchParent = resolve(scratchParentArg);
const output = resolve(outputArg);
const navigationRepeats = Number(navigationRepeatsArg);
if (!fixtureRootArg || !scratchParentArg || !outputArg || !Number.isInteger(navigationRepeats) || navigationRepeats < 1 || navigationRepeats > 30) {
  throw new Error(usage());
}

const datasetFile = join(fixtureRoot, 'dataset.json');
const origin = join(fixtureRoot, 'origin.git');
const serverScript = join(runtimeRoot, 'scripts/performance/server.mjs');
const runtimeManifestPath = resolve(process.env.SCRIPTORIUM_C64_RUNTIME_MANIFEST ?? join(runtimeRoot, 'docs/performance/results/core64-resize/runtime-manifest.json'));
for (const required of [
  join(runtimeRoot, 'package.json'),
  join(runtimeRoot, 'app/dist/index.html'),
  join(runtimeRoot, 'packages/api/dist/server.js'),
  join(runtimeRoot, 'packages/core/dist/index.js'),
  datasetFile,
  origin,
]) {
  await readFile(required).catch(async (error) => {
    if (error.code === 'EISDIR') return;
    throw new Error(`Required runtime or canonical fixture file is unavailable: ${required}`);
  });
}
const manifest = JSON.parse(await readFile(datasetFile, 'utf8'));
if (manifest.size !== 'small' || manifest.scenes !== 3 || manifest.syntheticOnly !== true) {
  throw new Error('Durability probe requires the canonical synthetic small three-scene dataset.');
}
if (manifest.documentBytes?.join(',') !== '1024,102400,1048576') {
  throw new Error('The canonical small dataset does not contain the expected 1 KiB / 100 KiB / 1 MiB cohorts.');
}

const runtimeRequire = createRequire(join(runtimeRoot, 'package.json'));
const { chromium, expect: playwrightExpect } = runtimeRequire('@playwright/test');
const expect = playwrightExpect.configure({ timeout: 60_000 });
const runtimeSource = await runtimeRequire('node:child_process').execFileSync('git', ['-C', runtimeRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (runtimeSource !== expectedRuntimeSource) {
  throw new Error(`Runtime source mismatch: expected ${expectedRuntimeSource}, received ${runtimeSource}. Set SCRIPTORIUM_C64_EXPECTED_RUNTIME_SHA only for an explicitly approved runtime.`);
}
const runtimeManifestBytes = await readFile(runtimeManifestPath).catch(() => {
  throw new Error(`Shared runtime manifest is unavailable: ${runtimeManifestPath}`);
});
const runtimeManifest = JSON.parse(runtimeManifestBytes.toString('utf8'));
const requiredArtifactRoots = ['packages/core/dist', 'packages/api/dist', 'app/dist', 'profiles/core/generated'];
const expectedComparedPaths = ['app', 'packages', 'modules', 'profiles', 'Dockerfile', 'package.json', 'pnpm-lock.yaml'];
const expectedProductionTrees = {
  'app/src': '6114d95c43649dec93887034cc35a5d3d3b09e96',
  'packages/core/src': 'eee5bb9d8d9cbe811aa04d143ee8d24acae4b28d',
  'packages/api/src': 'bbf7aaf1f5a10a77cbb707447ac54937092cd616',
  'profiles/core': '29f1c8f2ee691be603db1f811b2c5fb61d1a4f40',
};
if (runtimeManifest.schemaVersion !== 1
  || resolve(runtimeManifest.runtimeRoot ?? '') !== runtimeRoot
  || runtimeManifest.sourceCommit !== runtimeSource
  || runtimeManifest.profile !== 'core'
  || runtimeManifest.buildCommand !== 'SCRIPTORIUM_PROFILE=core pnpm build'
  || runtimeManifest.productionIdentity?.referenceCommit !== 'e8aa3ecd7d1e0bfb3d81a003a2bc0320c9cc6d47'
  || runtimeManifest.productionIdentity?.identical !== true
  || !Array.isArray(runtimeManifest.productionIdentity?.comparedPaths)
  || JSON.stringify(runtimeManifest.productionIdentity.comparedPaths) !== JSON.stringify(expectedComparedPaths)
  || JSON.stringify(runtimeManifest.productionIdentity?.trees) !== JSON.stringify(expectedProductionTrees)
  || !Array.isArray(runtimeManifest.dirtyProductionPaths)
  || runtimeManifest.dirtyProductionPaths.length !== 0
  || !Array.isArray(runtimeManifest.artifactRoots)
  || JSON.stringify(runtimeManifest.artifactRoots) !== JSON.stringify(requiredArtifactRoots)) {
  throw new Error(`Shared runtime manifest does not identify the expected clean Core build at ${runtimeSource}.`);
}
if (!Array.isArray(runtimeManifest.files) || runtimeManifest.files.length === 0) {
  throw new Error('Shared runtime manifest contains no artifact file inventory.');
}
const runtimeRootReal = await realpath(runtimeRoot);
const verifiedArtifactPaths = new Set();
let verifiedArtifactBytes = 0;
for (const artifact of runtimeManifest.files) {
  if (typeof artifact.path !== 'string' || artifact.path.includes('\\') || artifact.path.startsWith('/')
    || !requiredArtifactRoots.some((root) => artifact.path.startsWith(`${root}/`))
    || verifiedArtifactPaths.has(artifact.path)
    || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0
    || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
    throw new Error(`Invalid or duplicate artifact entry in shared runtime manifest: ${JSON.stringify(artifact)}`);
  }
  const artifactPath = resolve(runtimeRoot, artifact.path);
  const artifactRelative = relative(runtimeRoot, artifactPath);
  if (!artifactRelative || artifactRelative.startsWith('..')) {
    throw new Error(`Artifact path escapes the shared runtime root: ${artifact.path}`);
  }
  const [artifactStat, artifactRealPath] = await Promise.all([lstat(artifactPath), realpath(artifactPath)]);
  const realRelative = relative(runtimeRootReal, artifactRealPath);
  if (!artifactStat.isFile() || !realRelative || realRelative.startsWith('..')) {
    throw new Error(`Manifest artifact is not a regular file within the shared runtime: ${artifact.path}`);
  }
  const artifactBytes = await readFile(artifactPath);
  const artifactSha256 = createHash('sha256').update(artifactBytes).digest('hex');
  if (artifactBytes.length !== artifact.bytes || artifactSha256 !== artifact.sha256) {
    throw new Error(`Shared runtime artifact failed size or SHA-256 verification: ${artifact.path}`);
  }
  verifiedArtifactPaths.add(artifact.path);
  verifiedArtifactBytes += artifact.bytes;
}
if (runtimeManifest.totals?.fileCount !== runtimeManifest.files.length
  || runtimeManifest.totals?.bytes !== verifiedArtifactBytes
  || requiredArtifactRoots.some((root) => ![...verifiedArtifactPaths].some((path) => path.startsWith(`${root}/`)))) {
  throw new Error('Shared runtime manifest totals do not match its verified artifact inventory.');
}
const scriptHash = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
const datasetHash = createHash('sha256').update(await readFile(datasetFile)).digest('hex');
const runtimeManifestHash = createHash('sha256').update(runtimeManifestBytes).digest('hex');
const report = {
  schemaVersion: 1,
  probe: 'Core 64 bounded browser durability attribution',
  status: 'running',
  runtime: { root: runtimeRoot, source: runtimeSource, expectedSource: expectedRuntimeSource, node: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    artifactManifest: { ...runtimeManifest, path: runtimeManifestPath, sha256: runtimeManifestHash } },
  fixture: { dataset: manifest, datasetSha256: datasetHash },
  harness: { canonicalServer: serverScript, probeScriptSha256: scriptHash },
  scenarios: [],
  notChecked: [
    'Physical IndexedDB fsync count and device-level flush cost.',
    'A successful asynchronous pagehide/beforeunload write is not promised or inferred.',
    'Native force-quit, browser-process kill, OS termination, and power-loss recovery.',
  ],
};

function installDurabilityProbes() {
  const metrics = window.__core64 = { fetches: [], timers350: [] };
  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    const requestUrl = new URL(typeof input === 'string' ? input : input.url, location.href);
    const row = { start: performance.now(), method: init?.method ?? input?.method ?? 'GET', path: requestUrl.pathname, status: null, end: null };
    metrics.fetches.push(row);
    return Reflect.apply(originalFetch, this, [input, init]).then((response) => {
      Object.assign(row, { status: response.status, end: performance.now() });
      return response;
    }, (error) => {
      Object.assign(row, { error: String(error), end: performance.now() });
      throw error;
    });
  };

  const originalTimeout = window.setTimeout;
  const originalClearTimeout = window.clearTimeout;
  const pending = new Map();
  window.setTimeout = function(handler, delay, ...args) {
    if (delay !== 350 || typeof handler !== 'function') return Reflect.apply(originalTimeout, this, [handler, delay, ...args]);
    const row = { scheduledAt: performance.now(), firedAt: null, cancelledAt: null,
      callsite: new Error().stack?.split('\n').slice(2, 4).map((line) => line.trim()) ?? [] };
    metrics.timers350.push(row);
    let timer;
    const wrapped = function(...callbackArgs) {
      row.firedAt = performance.now();
      pending.delete(timer);
      return Reflect.apply(handler, this, callbackArgs);
    };
    timer = Reflect.apply(originalTimeout, this, [wrapped, delay, ...args]);
    pending.set(timer, row);
    return timer;
  };
  window.clearTimeout = function(timer) {
    const row = pending.get(timer);
    if (row && row.firedAt === null) row.cancelledAt = performance.now();
    pending.delete(timer);
    return Reflect.apply(originalClearTimeout, this, [timer]);
  };

  const originalTransaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function(...args) {
    const transaction = Reflect.apply(originalTransaction, this, args);
    const row = window.__wave0.transactions.at(-1);
    if (row) {
      transaction.addEventListener('complete', () => { row.completedAt = performance.now(); }, { once: true });
      transaction.addEventListener('abort', () => { row.abortedAt = performance.now(); }, { once: true });
    }
    return transaction;
  };
}

const injectedProbe = `(${installBrowserProbes.toString()})();(${installDurabilityProbes.toString()})();`;
const scratch = await mkdtemp(join(scratchParent, 'core64-durability-'));
await copyFile(datasetFile, join(scratch, 'dataset.json'));
await symlink(origin, join(scratch, 'origin.git'), 'dir');

let server;
let browser;
let context;
let page;
try {
  await mkdir(resolve(output, '..'), { recursive: true });
  server = fork(serverScript, [scratch], { cwd: runtimeRoot, stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: { ...process.env, SCRIPTORIUM_PROFILE: 'core' } });
  const [ready] = await once(server, 'message');
  if (!ready?.port || !ready?.remote) throw new Error('Canonical local performance server did not become ready.');
  report.serverStartupMs = ready.startupMs;
  report.serverScriptSha256 = createHash('sha256').update(await readFile(serverScript)).digest('hex');

  browser = await chromium.launch({ headless: true,
    ...(process.env.SCRIPTORIUM_E2E_CHROMIUM ? { executablePath: process.env.SCRIPTORIUM_E2E_CHROMIUM } : {}) });
  report.browser = browser.version();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript({ content: injectedProbe });
  page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const base = `http://127.0.0.1:${ready.port}`;
  await page.goto(`${base}/desktop/`);
  await page.getByLabel('アクセストークン').fill('synthetic-benchmark-local-token-000000');
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await page.getByLabel('GitHub リポジトリ URL').fill(pathToFileURL(ready.remote).href);
  await page.getByRole('button', { name: 'リポジトリを登録' }).click();

  const sceneButton = (id) => page.locator('button.scene-button').filter({ hasText: new RegExp(`^Chapter One: Scene ${id}$`) });
  const editor = page.locator('.cm-content');
  async function openScene(id) {
    await sceneButton(id).click();
    await expect(page.locator('.scene-heading h1')).toHaveText(`Scene ${id}`);
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await expect(editor).toContainText(`Synthetic scene ${id}`);
  }
  async function metrics() {
    return page.evaluate(() => ({
      now: performance.now(),
      transactions: structuredClone(window.__wave0.transactions),
      reads: structuredClone(window.__wave0.reads),
      fetches: structuredClone(window.__core64.fetches),
      timers350: structuredClone(window.__core64.timers350),
    }));
  }
  async function serverStats() {
    const response = once(server, 'message');
    server.send('stats');
    return (await response)[0];
  }
  async function readDraft(sceneId, expectedMarker) {
    return page.evaluate(async ({ sceneId, expectedMarker }) => {
      const database = await new Promise((resolveOpen, rejectOpen) => {
        const request = indexedDB.open('scriptorium-recovery', 3);
        request.onsuccess = () => resolveOpen(request.result);
        request.onerror = () => rejectOpen(request.error ?? new Error('IndexedDB open failed'));
      });
      try {
        const transaction = database.transaction('operations', 'readonly');
        const records = await new Promise((resolveRead, rejectRead) => {
          const request = transaction.objectStore('operations').getAll();
          request.onsuccess = () => resolveRead(request.result);
          request.onerror = () => rejectRead(request.error ?? new Error('Journal read failed'));
        });
        const record = records.filter((candidate) => candidate.sceneId === sceneId && candidate.state === 'draft')
          .sort((left, right) => right.operation.generation - left.operation.generation)[0];
        return record ? {
          present: true,
          exactMarkerPresent: record.text.includes(expectedMarker),
          textLength: record.text.length,
          generation: record.operation.generation,
          operationId: record.operation.id,
          state: record.state,
        } : { present: false, exactMarkerPresent: false };
      } finally {
        database.close();
      }
    }, { sceneId, expectedMarker });
  }
  function transactionsIn(snapshot, start, end) {
    return snapshot.transactions.filter((row) => row.start >= start && row.start <= end)
      .map((row) => ({ start: row.start, completedAt: row.completedAt ?? null, ms: row.ms ?? null,
        mode: row.mode, durability: row.durability, stores: row.stores, status: row.status }));
  }
  function readsIn(snapshot, start, end) {
    return snapshot.reads.filter((row) => row.start >= start && row.start <= end)
      .map(({ start: at, ms, source, method, store, index, status, records }) => ({ at, ms, source, method, store, index, status, records }));
  }
  function fetchesIn(snapshot, start, end) {
    return snapshot.fetches.filter((row) => row.start >= start && row.start <= end)
      .map(({ start: at, end: finishedAt, method, path, status, error }) => ({ at, end: finishedAt, method, path, status, error }));
  }
  function timersIn(snapshot, start, end) {
    return snapshot.timers350.filter((row) => row.scheduledAt >= start && row.scheduledAt <= end)
      .map(({ scheduledAt, firedAt, cancelledAt, callsite }) => ({ scheduledAt, firedAt, cancelledAt, callsite }));
  }

  const burstScenarios = [];
  const burstMarker = 'qwer';
  for (const [index, sceneId] of [1, 2, 3].entries()) {
    await openScene(sceneId);
    await editor.focus();
    await editor.press('Control+End');
    const before = await metrics();
    const startedAt = before.now;
    const marker = `${burstMarker}${index}`;
    for (const character of marker) await editor.press(character);
    await page.waitForFunction((since) => window.__wave0.transactions.some((tx) =>
      tx.start >= since && tx.mode === 'readwrite' && tx.durability === 'strict' && tx.status === 'complete' && tx.stores.includes('operations')),
    startedAt, { timeout: 20_000 });
    await page.waitForTimeout(100);
    const after = await metrics();
    const strictWrites = transactionsIn(after, startedAt, after.now).filter((tx) =>
      tx.mode === 'readwrite' && tx.durability === 'strict' && tx.stores.includes('operations'));
    const completedStrictWrites = strictWrites.filter((tx) => tx.status === 'complete');
    const draft = await readDraft(`scene-${sceneId}`, marker);
    const latestWrite = completedStrictWrites.at(-1);
    const firedTimers = timersIn(after, startedAt, after.now).filter((timer) => timer.firedAt !== null && timer.firedAt <= (latestWrite?.start ?? Infinity));
    const queueTimer = firedTimers.at(-1);
    burstScenarios.push({
      name: `autosave-burst.${manifest.documentBytes[index]}`,
      sceneId: `scene-${sceneId}`,
      initialDocumentBytes: manifest.documentBytes[index],
      markerCharacters: marker.length,
      elapsedMs: after.now - startedAt,
      completedStrictOperationsReadwriteTransactions: completedStrictWrites.length,
      pendingStrictOperationsReadwriteTransactions: strictWrites.filter((tx) => tx.status === 'pending').length,
      strictOperationWrites: strictWrites,
      nearest350TimerToTransactionStartMs: latestWrite && queueTimer ? Math.max(0, latestWrite.start - queueTimer.firedAt) : null,
      nearest350TimerCallsite: queueTimer?.callsite ?? [],
      idbReads: readsIn(after, startedAt, after.now),
      recoveredJournal: draft,
    });
    if (!draft.present || !draft.exactMarkerPresent || completedStrictWrites.length === 0) {
      throw new Error(`Strict autosave durability check failed for scene-${sceneId}.`);
    }
  }
  report.scenarios.push({ name: 'autosave-bursts', samples: burstScenarios,
    transactionCountDistribution: distribution(burstScenarios.map((sample) => sample.completedStrictOperationsReadwriteTransactions)),
    transactionDurationMs: distribution(burstScenarios.flatMap((sample) => sample.strictOperationWrites.map((tx) => tx.ms).filter(Number.isFinite))),
    queueWaitProxyMs: distribution(burstScenarios.map((sample) => sample.nearest350TimerToTransactionStartMs).filter(Number.isFinite)),
    note: 'Queue wait is an inferred timer-to-IDB-start interval; raw 350 ms timer callsites and transaction events are retained for attribution.' });

  await openScene(1);
  await editor.focus();
  await editor.press('Control+End');
  const flushMarker = `C64-DURABILITY-NAV-FLUSH-${Date.now()}`;
  const flushEditStartedAt = await page.evaluate(() => performance.now());
  await page.keyboard.insertText(flushMarker);
  await page.waitForTimeout(100);
  const flushServerBefore = await serverStats();
  const navigationStartedAt = await page.evaluate(() => performance.now());
  await sceneButton(2).click();
  await expect(page.locator('.scene-heading h1')).toHaveText('Scene 2');
  await expect(editor).toContainText('Synthetic scene 2');
  const navigationAfter = await metrics();
  const flushServerAfter = await serverStats();
  const navigationEndedAt = navigationAfter.now;
  const navigationDraft = await readDraft('scene-1', flushMarker);
  const navigationTransactions = transactionsIn(navigationAfter, navigationStartedAt, navigationEndedAt);
  const navigationFetches = fetchesIn(navigationAfter, navigationStartedAt, navigationEndedAt);
  const navigationReads = readsIn(navigationAfter, navigationStartedAt, navigationEndedAt);
  if (!navigationDraft.present || !navigationDraft.exactMarkerPresent) throw new Error('Scene navigation did not retain the exact flushed draft in the strict journal.');
  report.scenarios.push({
    name: 'navigation-with-pending-draft',
    from: 'scene-1', to: 'scene-2',
    endToEndMs: navigationEndedAt - navigationStartedAt,
    strictOperationsReadwriteTransactions: navigationTransactions.filter((tx) =>
      tx.mode === 'readwrite' && tx.durability === 'strict' && tx.stores.includes('operations')),
    indexedDbTransactions: navigationTransactions,
    indexedDbReads: navigationReads,
    apiFetches: navigationFetches,
    apiServerRequests: flushServerAfter.requests.slice(flushServerBefore.requests.length),
    firstApiStartAfterNavigationMs: navigationFetches.length ? navigationFetches[0].at - navigationStartedAt : null,
    lastStrictWriteCompleteAfterNavigationMs: Math.max(-1, ...navigationTransactions
      .filter((tx) => tx.mode === 'readwrite' && tx.durability === 'strict' && tx.stores.includes('operations'))
      .map((tx) => (tx.completedAt ?? tx.start + (tx.ms ?? 0)) - navigationStartedAt)),
    recoveredJournal: navigationDraft,
    timers350: timersIn(navigationAfter, flushEditStartedAt, navigationEndedAt),
  });

  const sceneSwitchSamples = [];
  let currentSceneId = 2;
  for (let index = 0; index < navigationRepeats; index++) {
    const targetSceneId = (currentSceneId % 3) + 1;
    const serverBefore = await serverStats();
    const before = await metrics();
    const startedAt = before.now;
    await sceneButton(targetSceneId).click();
    await expect(page.locator('.scene-heading h1')).toHaveText(`Scene ${targetSceneId}`);
    await expect(editor).toContainText(`Synthetic scene ${targetSceneId}`);
    const after = await metrics();
    const serverAfter = await serverStats();
    const endAt = after.now;
    sceneSwitchSamples.push({
      from: `scene-${currentSceneId}`,
      to: `scene-${targetSceneId}`,
      endToEndMs: endAt - startedAt,
      indexedDbTransactions: transactionsIn(after, startedAt, endAt),
      indexedDbReads: readsIn(after, startedAt, endAt),
      apiFetches: fetchesIn(after, startedAt, endAt),
      apiServerRequests: serverAfter.requests.slice(serverBefore.requests.length),
    });
    currentSceneId = targetSceneId;
  }
  report.scenarios.push({ name: 'clean-scene-navigation', samples: sceneSwitchSamples,
    endToEndMs: distribution(sceneSwitchSamples.map((sample) => sample.endToEndMs)),
    apiFetchCount: sceneSwitchSamples.reduce((count, sample) => count + sample.apiFetches.length, 0),
    indexedDbTransactionCount: sceneSwitchSamples.reduce((count, sample) => count + sample.indexedDbTransactions.length, 0) });

  const quickSequence = [2, 1, 3];
  const quickStartedAt = await page.evaluate(() => performance.now());
  for (const targetSceneId of quickSequence) await sceneButton(targetSceneId).click();
  await expect(page.locator('.scene-heading h1')).toHaveText('Scene 3');
  await expect(editor).toContainText('Synthetic scene 3');
  await page.waitForTimeout(500);
  await expect(page.locator('.scene-heading h1')).toHaveText('Scene 3');
  report.scenarios.push({ name: 'rapid-navigation-freshness-smoke', requestedScenes: quickSequence.map((id) => `scene-${id}`),
    finalScene: await page.locator('.scene-heading h1').textContent(),
    elapsedMs: (await page.evaluate(() => performance.now())) - quickStartedAt,
    note: 'A local rapid-switch smoke only; no delayed or reordered network response was injected.' });

  report.status = 'complete';
} catch (error) {
  report.status = 'failed';
  report.error = error.stack ?? String(error);
} finally {
  if (browser) await browser.close();
  if (server?.connected) {
    const exited = once(server, 'exit');
    server.send('stop');
    await exited;
  }
  await save(output, report);
  await rm(scratch, { recursive: true, force: true });
}

if (report.status !== 'complete') process.exitCode = 1;
else console.log(JSON.stringify({ status: report.status, output, scenarios: report.scenarios.map((scenario) => scenario.name) }));
