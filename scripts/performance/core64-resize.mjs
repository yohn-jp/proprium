import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { arch, platform, release } from 'node:os';
import { chromium, expect as playwrightExpect } from '@playwright/test';
import { git } from './dataset.mjs';
import { installBrowserProbes } from './browser-probes.mjs';

const [datasetArg, outputArg] = process.argv.slice(2);
if (!datasetArg || !outputArg) {
  throw new Error('Usage: node scripts/performance/core64-resize.mjs <existing-small-synthetic-fixture> <new-output.json>');
}

const seedPath = resolve(datasetArg);
const output = resolve(outputArg);
const runtimeRoot = resolve(process.env.SCRIPTORIUM_PERF_RUNTIME_ROOT ?? process.cwd());
const runtimeCommit = git(runtimeRoot, 'rev-parse', 'HEAD');
const expectedRuntimeCommit = process.env.SCRIPTORIUM_PERF_EXPECTED_RUNTIME_COMMIT;
if (expectedRuntimeCommit && !runtimeCommit.startsWith(expectedRuntimeCommit)) {
  throw new Error(`Expected Core runtime ${expectedRuntimeCommit}, found ${runtimeCommit} in ${runtimeRoot}`);
}
const dataset = JSON.parse(await readFile(join(seedPath, 'dataset.json'), 'utf8'));
if (dataset.syntheticOnly !== true || dataset.size !== 'small' || dataset.scenes < 1) {
  throw new Error('C09 requires the existing small synthetic Core fixture with at least one scene');
}
try {
  await access(output);
  throw new Error(`Refusing to overwrite existing resize evidence: ${output}`);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
await mkdir(dirname(output), { recursive: true });
const scratchBase = resolve(process.env.SCRIPTORIUM_PERF_TMPDIR ?? process.env.TMPDIR ?? '/data/tmp');
await mkdir(scratchBase, { recursive: true });
const scratchRoot = await mkdtemp(join(scratchBase, 'c64-rz-'));
const datasetPath = join(scratchRoot, 'small');
await mkdir(datasetPath);
await Promise.all([
  cp(join(seedPath, 'dataset.json'), join(datasetPath, 'dataset.json')),
  cp(join(seedPath, 'origin.git'), join(datasetPath, 'origin.git'), { recursive: true }),
]);

const expect = playwrightExpect.configure({ timeout: 60000 });
const harnessSource = await readFile(new URL(import.meta.url));
const report = {
  status: 'running',
  contract: 'C09',
  source: { commit: git(process.cwd(), 'rev-parse', 'HEAD'), probeSha256: createHash('sha256').update(harnessSource).digest('hex') },
  runtime: { root: runtimeRoot, commit: runtimeCommit, appDist: join(runtimeRoot, 'app/dist') },
  host: { platform: platform(), release: release(), arch: arch(), node: process.version },
  fixture: {
    immutableSeed: seedPath,
    size: dataset.size,
    commit: dataset.commit,
    files: dataset.files,
    scenes: dataset.scenes,
    documentBytes: dataset.documentBytes,
    disposableCopy: 'created under the short temporary directory; removed after the run',
  },
  browser: null,
  desktop: {},
  mobile: {},
  notChecked: [],
};
let server;
let browser;
let page;
let desktopContext;

function installResizeProbes() {
  const resizeMetrics = window.__c64Resize = {
    rafRequests: 0,
    storageCalls: [],
    current: null,
  };
  const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
  window.__c64NativeRequestAnimationFrame = nativeRequestAnimationFrame;
  window.requestAnimationFrame = callback => {
    resizeMetrics.rafRequests++;
    return nativeRequestAnimationFrame(callback);
  };

  for (const method of ['getItem', 'setItem', 'removeItem', 'clear']) {
    const original = Storage.prototype[method];
    Storage.prototype[method] = function(...args) {
      let store = 'storage';
      try {
        if (this === window.localStorage) store = 'localStorage';
        else if (this === window.sessionStorage) store = 'sessionStorage';
      } catch {}
      resizeMetrics.storageCalls.push({
        at: performance.now(),
        method,
        store,
        key: typeof args[0] === 'string' ? args[0] : null,
      });
      return Reflect.apply(original, this, args);
    };
  }

  function workspaceWidths() {
    const widths = {};
    for (const panelId of ['editor', 'outline']) {
      const content = document.querySelector(`[data-workspace-panel="${panelId}"]`);
      const panel = content?.closest('[data-panel]') ?? content;
      const rect = panel?.getBoundingClientRect();
      if (rect) widths[panelId] = { width: rect.width, height: rect.height };
    }
    return widths;
  }

  resizeMetrics.begin = label => {
    if (resizeMetrics.current) throw new Error('A C09 capture is already active');
    const startedAt = performance.now();
    const wave0 = window.__wave0;
    const capture = {
      label,
      startedAt,
      frames: [],
      resizeNotifications: [],
      panelSizeChanges: [],
      panelStyleMutations: [],
      trustedPointerEvents: [],
      trustedKeyboardEvents: [],
      counterStart: {
        rafRequests: resizeMetrics.rafRequests,
        transactions: wave0.transactions.length,
        reads: wave0.reads.length,
        reactCommits: wave0.reactCommits.length,
        longTasks: wave0.longTasks.length,
        storageCalls: resizeMetrics.storageCalls.length,
      },
      active: true,
    };
    resizeMetrics.current = capture;

    const panels = Array.from(document.querySelectorAll('.st-workspace-resizable-panel'));
    const lastWidths = new Map();
    const sizeObserver = new ResizeObserver(entries => {
      if (!capture.active) return;
      for (const entry of entries) {
        const id = entry.target.querySelector('[data-workspace-panel]')?.getAttribute('data-workspace-panel') ??
          entry.target.getAttribute('data-panel-id') ?? 'unknown';
        const width = entry.contentRect.width;
        capture.resizeNotifications.push({ at: performance.now(), panelId: id, width });
        const previous = lastWidths.get(id);
        if (previous === undefined || Math.abs(previous - width) > 0.1) {
          capture.panelSizeChanges.push({ at: performance.now(), panelId: id, from: previous ?? null, to: width });
          lastWidths.set(id, width);
        }
      }
    });
    panels.forEach(panel => sizeObserver.observe(panel));

    const styleObserver = new MutationObserver(records => {
      if (!capture.active) return;
      for (const record of records) {
        capture.panelStyleMutations.push({
          at: performance.now(),
          panelId: record.target.querySelector('[data-workspace-panel]')?.getAttribute('data-workspace-panel') ??
            record.target.getAttribute('data-panel-id') ?? 'unknown',
          style: record.target.getAttribute('style'),
        });
      }
    });
    panels.forEach(panel => styleObserver.observe(panel, { attributes: true, attributeFilter: ['style'] }));

    const pointerHandler = event => {
      if (!event.isTrusted || !event.target.closest?.('.st-workspace-resize-handle')) return;
      capture.trustedPointerEvents.push({ at: performance.now(), type: event.type, pointerType: event.pointerType });
    };
    const keyboardHandler = event => {
      if (!event.isTrusted || !event.target.closest?.('.st-workspace-resize-handle')) return;
      capture.trustedKeyboardEvents.push({ at: performance.now(), type: event.type, key: event.key });
    };
    document.addEventListener('pointerdown', pointerHandler, true);
    document.addEventListener('pointermove', pointerHandler, true);
    document.addEventListener('pointerup', pointerHandler, true);
    document.addEventListener('keydown', keyboardHandler, true);

    const sampleFrame = timestamp => {
      if (!capture.active) return;
      capture.frames.push({ at: timestamp, widths: workspaceWidths() });
      nativeRequestAnimationFrame(sampleFrame);
    };
    nativeRequestAnimationFrame(sampleFrame);

    capture.stop = () => {
      capture.active = false;
      capture.endedAt = performance.now();
      sizeObserver.disconnect();
      styleObserver.disconnect();
      document.removeEventListener('pointerdown', pointerHandler, true);
      document.removeEventListener('pointermove', pointerHandler, true);
      document.removeEventListener('pointerup', pointerHandler, true);
      document.removeEventListener('keydown', keyboardHandler, true);
      resizeMetrics.current = null;
      const end = capture.endedAt;
      const wave0Now = window.__wave0;
      const intervals = capture.frames.slice(1).map((frame, index) => frame.at - capture.frames[index].at);
      const sortedIntervals = [...intervals].sort((left, right) => left - right);
      const quantile = q => sortedIntervals.length
        ? sortedIntervals[Math.max(0, Math.ceil(q * sortedIntervals.length) - 1)]
        : null;
      const inWindow = (row, field = 'at') => row[field] >= startedAt && row[field] <= end;
      return {
        label,
        startedAt,
        endedAt: end,
        elapsedMs: end - startedAt,
        frames: capture.frames,
        frameSummary: {
          sampledFrames: capture.frames.length,
          intervalCount: intervals.length,
          intervalMs: { p50: quantile(0.5), p95: quantile(0.95), max: sortedIntervals.at(-1) ?? null },
          gapsOver50ms: intervals.filter(interval => interval > 50).length,
        },
        counts: {
          requestAnimationFrameCalls: resizeMetrics.rafRequests - capture.counterStart.rafRequests,
          reactCommits: wave0Now.reactCommits.filter(row => row.at >= startedAt && row.at <= end).length,
          longTasks: wave0Now.longTasks.filter(row => row.start <= end && row.start + row.ms >= startedAt),
          indexedDbTransactions: wave0Now.transactions.filter(row => row.start >= startedAt && row.start <= end),
          indexedDbReads: wave0Now.reads.filter(row => row.start >= startedAt && row.start <= end),
          localStorageCalls: resizeMetrics.storageCalls.filter(row => row.store === 'localStorage' && inWindow(row)),
          sessionStorageCalls: resizeMetrics.storageCalls.filter(row => row.store === 'sessionStorage' && inWindow(row)),
          panelResizeObserverNotifications: capture.resizeNotifications,
          panelWidthChanges: capture.panelSizeChanges,
          panelStyleMutations: capture.panelStyleMutations,
          trustedPointerEvents: capture.trustedPointerEvents,
          trustedKeyboardEvents: capture.trustedKeyboardEvents,
        },
      };
    };
    return { label, startedAt };
  };

  resizeMetrics.end = () => {
    const current = resizeMetrics.current;
    if (!current?.stop) throw new Error('No C09 capture is active');
    return current.stop();
  };
}

const injectedProbes = `(${installBrowserProbes.toString()})();\n(${installResizeProbes.toString()})();`;

async function saveReport() {
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
}

async function readWorkspaceState(targetPage, mode = 'desktop') {
  return targetPage.evaluate(expectedMode => {
    const workspace = document.querySelector('.st-workspace');
    const split = document.querySelector('.st-workspace-split-horizontal');
    const box = element => {
      const rect = element?.getBoundingClientRect();
      return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
    };
    const panel = panelId => {
      const content = document.querySelector(`[data-workspace-panel="${panelId}"]`);
      return box(content?.closest('[data-panel]') ?? content);
    };
    const keys = Object.keys(localStorage).filter(key => key.startsWith('scriptorium:workspace:v1:'));
    const layoutKey = keys.find(key => key.endsWith(`:${expectedMode}`)) ?? null;
    const rawLayout = layoutKey ? localStorage.getItem(layoutKey) : null;
    return {
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      workspaceMode: workspace?.classList.contains('st-workspace-desktop') ? 'desktop' :
        workspace?.classList.contains('st-workspace-mobile') ? 'mobile' : 'unknown',
      workspace: box(workspace),
      split: split ? {
        box: box(split),
        groupId: split.getAttribute('data-panel-group-id'),
        resizeHandleCount: split.querySelectorAll('.st-workspace-resize-handle').length,
      } : null,
      panels: { editor: panel('editor'), outline: panel('outline') },
      storedLayout: rawLayout,
      storedLayoutKey: layoutKey,
    };
  }, mode);
}

function findSplit(root, splitId = null) {
  if (!root || typeof root !== 'object') return null;
  if (root.type === 'split' && (splitId === null || root.id === splitId)) return root;
  for (const child of root.children ?? []) {
    const found = findSplit(child, splitId);
    if (found) return found;
  }
  return null;
}

function summarizeCapture(capture) {
  return {
    ...capture,
    frames: undefined,
    counts: {
      ...capture.counts,
      indexedDbTransactions: capture.counts.indexedDbTransactions.map(row => ({ mode: row.mode, stores: row.stores, status: row.status, ms: row.ms ?? null })),
      indexedDbReads: capture.counts.indexedDbReads.map(row => ({ source: row.source, method: row.method, store: row.store, status: row.status, ms: row.ms ?? null })),
      localStorageCalls: capture.counts.localStorageCalls.map(({ at, method, key }) => ({ at, method, key })),
      sessionStorageCalls: capture.counts.sessionStorageCalls.map(({ at, method, key }) => ({ at, method, key })),
    },
  };
}

function projectLabel(value) {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname.replace(/\.git$/u, '').replace(/\/$/u, '')}`;
  } catch {
    return value;
  }
}

async function launchFixturePage(context, base, mode, repositoryUrl, existingPage = null) {
  const fixturePage = existingPage ?? await context.newPage();
  fixturePage.setDefaultTimeout(60000);
  await fixturePage.goto(`${base}/${mode}/`);
  await fixturePage.getByLabel('アクセストークン').fill('synthetic-benchmark-local-token-000000');
  await fixturePage.getByRole('button', { name: 'ログイン', exact: true }).click();
  if (mode === 'mobile') {
    await fixturePage.getByRole('navigation', { name: 'モバイル画面' }).getByRole('button', { name: '作品', exact: true }).click();
  }
  const existingProject = fixturePage.getByRole('button', { name: projectLabel(repositoryUrl), exact: true });
  if (await existingProject.isVisible().catch(() => false)) {
    await existingProject.click();
  } else {
    await fixturePage.getByLabel('GitHub リポジトリ URL').fill(repositoryUrl);
    await fixturePage.getByRole('button', { name: 'リポジトリを登録' }).click();
  }
  const sceneButton = fixturePage.locator('button.scene-button').filter({ hasText: /^Chapter One: Scene 1$/ });
  await sceneButton.waitFor();
  await sceneButton.click();
  if (mode === 'mobile') {
    await fixturePage.getByRole('navigation', { name: 'モバイル画面' }).getByRole('button', { name: '書く', exact: true }).click();
    await fixturePage.getByRole('tablist', { name: 'Workspace panels' }).getByRole('tab', { name: 'Editor', exact: true }).click();
  }
  await expect(fixturePage.locator('.st-workspace')).toBeVisible();
  await expect(fixturePage.locator('[data-workspace-panel="editor"]')).toBeVisible();
  return fixturePage;
}

try {
  server = fork(pathToFileURL(join(runtimeRoot, 'scripts/performance/server.mjs')), [datasetPath], {
    cwd: runtimeRoot,
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const [ready] = await once(server, 'message');
  report.serverStartupMs = ready.startupMs;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.SCRIPTORIUM_E2E_CHROMIUM ? { executablePath: process.env.SCRIPTORIUM_E2E_CHROMIUM } : {}),
  });
  report.browser = { version: browser.version(), executable: process.env.SCRIPTORIUM_E2E_CHROMIUM ?? 'Playwright default' };
  const base = `http://127.0.0.1:${ready.port}`;
  const repositoryUrl = pathToFileURL(ready.remote).href;
  const workspaceKeyPrefix = 'scriptorium:workspace:v1:';

  desktopContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await desktopContext.addInitScript({ content: injectedProbes });
  page = await launchFixturePage(desktopContext, base, 'desktop', repositoryUrl);
  const desktopBefore = await readWorkspaceState(page);
  if (!desktopBefore.split?.resizeHandleCount || !desktopBefore.panels.editor || !desktopBefore.panels.outline) {
    throw new Error('The small synthetic desktop fixture did not render the expected editor/outline split');
  }
  report.desktop.before = desktopBefore;
  await saveReport();

  const resizeHandle = page.getByRole('separator', { name: 'Resize horizontal workspace panels' }).first();
  await expect(resizeHandle).toBeVisible();
  const handleBox = await resizeHandle.boundingBox();
  const splitBox = await page.locator('.st-workspace-split-horizontal').first().boundingBox();
  if (!handleBox || !splitBox) throw new Error('The horizontal resize handle has no production DOM bounds');
  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  const deltaX = Math.min(112, Math.floor(splitBox.width * 0.08));
  if (deltaX < 24) throw new Error(`Resize split is too narrow for a meaningful pointer drag: ${splitBox.width}px`);
  await page.mouse.move(startX, startY);
  await page.evaluate(() => window.__c64Resize.begin('pointer-drag'));
  const pointerStart = performance.now();
  await page.mouse.down();
  for (let step = 1; step <= 40; step++) {
    await page.mouse.move(startX + deltaX * step / 40, startY);
    await page.waitForTimeout(8);
  }
  await page.mouse.up();
  await page.waitForTimeout(100);
  const pointerCapture = await page.evaluate(() => window.__c64Resize.end());
  const afterPointer = await readWorkspaceState(page);
  if (!(afterPointer.panels.editor.width > desktopBefore.panels.editor.width + 1 &&
      afterPointer.panels.outline.width < desktopBefore.panels.outline.width - 1)) {
    throw new Error('A trusted pointer drag did not resize the rendered editor and outline panels');
  }
  const gestureStorageCalls = pointerCapture.counts.localStorageCalls.filter(row => row.key?.startsWith(workspaceKeyPrefix));
  if (gestureStorageCalls.length) throw new Error('Workspace layout persisted during the pointer drag without an explicit save');
  report.desktop.pointerDrag = {
    automationElapsedMs: performance.now() - pointerStart,
    requestedDeltaPx: deltaX,
    capture: summarizeCapture(pointerCapture),
    after: afterPointer,
  };
  await saveReport();

  await resizeHandle.focus();
  await page.evaluate(() => window.__c64Resize.begin('keyboard-arrow-right'));
  await resizeHandle.press('ArrowRight');
  await page.waitForTimeout(100);
  const keyboardCapture = await page.evaluate(() => window.__c64Resize.end());
  const afterKeyboard = await readWorkspaceState(page);
  const keyboardChanged = Math.abs(afterKeyboard.panels.editor.width - afterPointer.panels.editor.width) > 0.1 ||
    Math.abs(afterKeyboard.panels.outline.width - afterPointer.panels.outline.width) > 0.1;
  if (!keyboardChanged) throw new Error('ArrowRight did not change the rendered split width');
  const allGestureStorageCalls = [
    ...pointerCapture.counts.localStorageCalls,
    ...keyboardCapture.counts.localStorageCalls,
  ].filter(row => row.key?.startsWith(workspaceKeyPrefix));
  if (allGestureStorageCalls.length) throw new Error('Workspace layout persisted during resize without an explicit save');
  report.desktop.keyboardResize = { key: 'ArrowRight', capture: summarizeCapture(keyboardCapture), after: afterKeyboard };
  await saveReport();

  const writesBeforeSave = await page.evaluate(() => window.__c64Resize.storageCalls.length);
  await page.getByRole('button', { name: 'Save layout', exact: true }).click();
  await expect(page.locator('.st-workspace-message[role="status"]')).toContainText('Layout saved on this device.');
  const afterSave = await readWorkspaceState(page);
  if (!afterSave.storedLayout || !afterSave.storedLayoutKey) throw new Error('Save layout did not write a workspace record');
  const savedLayout = JSON.parse(afterSave.storedLayout);
  const savedSplit = findSplit(savedLayout.root, 'split-preset-main');
  if (!savedSplit || savedSplit.sizes.length !== 2) throw new Error('The saved layout has no two-panel resize value');
  const writesAfterSave = await page.evaluate(() => window.__c64Resize.storageCalls.length);
  const workspaceWrites = await page.evaluate(({ from, prefix }) => window.__c64Resize.storageCalls
    .slice(from)
    .filter(row => row.store === 'localStorage' && row.method === 'setItem' && row.key?.startsWith(prefix)),
  { from: writesBeforeSave, prefix: workspaceKeyPrefix });
  if (workspaceWrites.length !== 1) throw new Error(`Expected one explicit workspace save, observed ${workspaceWrites.length}`);
  report.desktop.saved = {
    key: afterSave.storedLayoutKey,
    raw: afterSave.storedLayout,
    layout: savedLayout,
    split: savedSplit,
    actualPanelWidthsPx: { editor: afterSave.panels.editor.width, outline: afterSave.panels.outline.width },
    localStorageCallsSinceBeforeSave: await page.evaluate(from => window.__c64Resize.storageCalls.slice(from), writesBeforeSave),
    workspaceWriteCount: workspaceWrites.length,
    allStorageCallCountSinceBeforeSave: writesAfterSave - writesBeforeSave,
  };
  await saveReport();

  await page.reload();
  await expect(page.locator('.st-workspace')).toBeVisible();
  const afterReload = await readWorkspaceState(page);
  if (afterReload.storedLayout !== afterSave.storedLayout) throw new Error('Reload changed the exact persisted workspace layout JSON');
  const editorWidthRatio = afterReload.panels.editor.width /
    (afterReload.panels.editor.width + afterReload.panels.outline.width) * 100;
  if (Math.abs(editorWidthRatio - savedSplit.sizes[0]) > 0.75) {
    throw new Error(`Restored panel geometry (${editorWidthRatio.toFixed(3)}%) differs from saved layout (${savedSplit.sizes[0]}%)`);
  }
  report.desktop.afterReload = {
    ...afterReload,
    restoredSplit: savedSplit,
    actualPanelWidthsPx: { editor: afterReload.panels.editor.width, outline: afterReload.panels.outline.width },
    editorSharePercent: editorWidthRatio,
    exactLayoutJsonRestored: afterReload.storedLayout === afterSave.storedLayout,
  };
  await saveReport();

  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  });
  await mobileContext.addInitScript({ content: injectedProbes });
  const mobilePage = await mobileContext.newPage();
  const mobileCdp = await mobileContext.newCDPSession(mobilePage);
  try {
    await mobileCdp.send('Emulation.setSafeAreaInsetsOverride', {
      insets: { top: 30, right: 0, bottom: 24, left: 0 },
    });
    report.mobile.safeAreaOverride = { supported: true, requestedInsetsCssPx: { top: 30, right: 0, bottom: 24, left: 0 } };
  } catch (error) {
    report.mobile.safeAreaOverride = { supported: false, error: error.message };
    report.notChecked.push('Chromium CDP safe-area inset override was unavailable; mobile safe-area CSS was still inspected at the emulated viewport.');
  }
  const mobile = await launchFixturePage(mobileContext, base, 'mobile', repositoryUrl, mobilePage);
  report.mobile.viewport = await mobile.evaluate(() => {
    const viewportMeta = document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? null;
    const safeProbe = document.createElement('div');
    safeProbe.setAttribute('aria-hidden', 'true');
    safeProbe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top, 0px);padding-bottom:env(safe-area-inset-bottom, 0px);';
    document.body.append(safeProbe);
    const safeStyle = getComputedStyle(safeProbe);
    const header = document.querySelector('.mobile-shell-ion-header');
    const footer = document.querySelector('.mobile-shell-footer');
    const shell = document.querySelector('.mobile-shell');
    const workspace = document.querySelector('.st-workspace');
    const body = document.body;
    const result = {
      viewportMeta,
      viewport: { width: innerWidth, height: innerHeight, visualWidth: visualViewport?.width ?? null, visualHeight: visualViewport?.height ?? null },
      safeAreaEnvCssPx: { top: parseFloat(safeStyle.paddingTop), bottom: parseFloat(safeStyle.paddingBottom) },
      headerPaddingTop: header ? getComputedStyle(header).paddingTop : null,
      footerPaddingBottom: footer ? getComputedStyle(footer).paddingBottom : null,
      shellWidth: shell?.getBoundingClientRect().width ?? null,
      workspaceWidth: workspace?.getBoundingClientRect().width ?? null,
      bodyScrollWidth: body.scrollWidth,
      bodyClientWidth: body.clientWidth,
      visibleResizeHandleCount: document.querySelectorAll('.st-workspace-resize-handle').length,
      workspaceMode: workspace?.classList.contains('st-workspace-mobile') ? 'mobile' : 'unknown',
    };
    safeProbe.remove();
    return result;
  });
  if (report.mobile.viewport.workspaceMode !== 'mobile' || report.mobile.viewport.visibleResizeHandleCount !== 0) {
    throw new Error('The mobile workspace unexpectedly rendered desktop split resize handles');
  }
  if (report.mobile.viewport.bodyScrollWidth > report.mobile.viewport.bodyClientWidth + 1) {
    throw new Error('The mobile synthetic workspace has horizontal page overflow');
  }
  report.mobile.safeAreaApplied = report.mobile.safeAreaOverride.supported &&
    report.mobile.viewport.safeAreaEnvCssPx.top >= 30 && report.mobile.viewport.safeAreaEnvCssPx.bottom >= 24 &&
    report.mobile.viewport.headerPaddingTop === `${report.mobile.viewport.safeAreaEnvCssPx.top}px` &&
    report.mobile.viewport.footerPaddingBottom === `${report.mobile.viewport.safeAreaEnvCssPx.bottom}px`;
  if (report.mobile.safeAreaOverride.supported && !report.mobile.safeAreaApplied) {
    throw new Error('Mobile safe-area emulation did not reach the production header/footer CSS');
  }
  report.mobile.storage = await readWorkspaceState(mobile, 'mobile');
  report.status = 'complete';
  await saveReport();
} catch (error) {
  report.status = 'failed';
  report.error = error.stack ?? String(error);
  if (page && !page.isClosed()) {
    report.desktop.partialState = await readWorkspaceState(page).catch(() => null);
    report.desktop.browserMetrics = await page.evaluate(() => ({
      resize: {
        rafRequests: window.__c64Resize?.rafRequests ?? null,
        storageCalls: window.__c64Resize?.storageCalls.length ?? null,
        activeCapture: window.__c64Resize?.current?.label ?? null,
      },
      wave0: {
        transactions: window.__wave0?.transactions.length ?? null,
        reads: window.__wave0?.reads.length ?? null,
        reactCommits: window.__wave0?.reactCommits.length ?? null,
        longTasks: window.__wave0?.longTasks.length ?? null,
      },
    })).catch(() => null);
  }
  await saveReport();
  process.exitCode = 1;
} finally {
  if (desktopContext) await desktopContext.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (server?.connected) {
    const exited = once(server, 'exit');
    server.send('stop');
    await exited;
  }
  await rm(scratchRoot, { recursive: true, force: true });
  await saveReport();
}
