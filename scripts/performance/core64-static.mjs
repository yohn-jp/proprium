import { execFileSync, fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { distribution, io, save } from './common.mjs';
import { git } from './dataset.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const requestCount = 1000;
const serverMode = process.argv[2] === '--server';

function pathIsUnder(root, path) {
  if (typeof path !== 'string') return false;
  const candidate = resolve(path);
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function runServer(dataDir, staticDir) {
  const counts = { lstatCalls: 0, realpathCalls: 0, readFileCalls: 0, readFileBytes: 0 };
  for (const name of ['lstat', 'realpath', 'readFile']) {
    const original = fsPromises[name];
    fsPromises[name] = async function(path, ...args) {
      if (!pathIsUnder(staticDir, path)) return Reflect.apply(original, this, [path, ...args]);
      counts[`${name}Calls`] += 1;
      const result = await Reflect.apply(original, this, [path, ...args]);
      if (name === 'readFile') {
        counts.readFileBytes += Buffer.isBuffer(result) ? result.byteLength : Buffer.byteLength(result);
      }
      return result;
    };
  }
  syncBuiltinESMExports();

  const { CoreStore } = await import('../../packages/core/dist/index.js');
  const { createServer } = await import('../../packages/api/dist/server.js');
  const store = new CoreStore({ dataDir, allowLocalRemotes: true });
  const server = createServer({
    store,
    authToken: 'synthetic-core64-static-probe-token-000000',
    profile: 'core',
    staticDir,
    usageDirectory: join(dataDir, 'usage'),
  });
  const requests = [];
  server.prependListener('request', (request, response) => {
    const startedAt = performance.now();
    response.once('finish', () => requests.push({
      method: request.method,
      path: request.url.split('?')[0],
      ms: performance.now() - startedAt,
      status: response.statusCode,
      contentLength: Number(response.getHeader('content-length') ?? 0),
    }));
  });

  const snapshot = async () => ({
    requests: [...requests],
    fsCalls: { ...counts },
    cpu: process.cpuUsage(),
    memory: process.memoryUsage(),
    maxRssBytes: process.resourceUsage().maxRSS * 1024,
    io: await io(),
  });
  server.listen(0, '127.0.0.1', () => {
    process.send?.({ type: 'ready', port: server.address().port });
  });
  process.on('message', async (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'reset') {
      requests.length = 0;
      for (const key of Object.keys(counts)) counts[key] = 0;
    }
    if (message.type === 'stats' || message.type === 'reset') {
      process.send?.({ id: message.id, snapshot: await snapshot() });
    }
    if (message.type === 'stop') {
      server.close((error) => {
        process.send?.({ id: message.id, stopped: true, error: error?.message });
        process.exitCode = error ? 1 : 0;
      });
    }
  });
}

function rpc(child, type) {
  const id = randomUUID();
  return new Promise((resolveRpc, rejectRpc) => {
    const onMessage = (message) => {
      if (message?.id !== id) return;
      child.off('message', onMessage);
      resolveRpc(message);
    };
    const onError = (error) => {
      child.off('message', onMessage);
      rejectRpc(error);
    };
    child.once('error', onError);
    child.on('message', onMessage);
    child.send({ id, type });
  });
}

function metricDelta(before, after) {
  const newRequests = after.requests.slice(before.requests.length);
  return {
    fsCalls: Object.fromEntries(Object.keys(after.fsCalls).map((key) => [key, after.fsCalls[key] - before.fsCalls[key]])),
    cpuUs: { user: after.cpu.user - before.cpu.user, system: after.cpu.system - before.cpu.system },
    rssBytes: {
      before: before.memory.rss,
      after: after.memory.rss,
      peakBefore: before.maxRssBytes,
      peakAfter: after.maxRssBytes,
      peakGrowth: Math.max(0, after.maxRssBytes - before.maxRssBytes),
    },
    io: before.io && after.io
      ? Object.fromEntries(Object.keys(after.io).map((key) => [key, after.io[key] - before.io[key]]))
      : null,
    serverRequestMs: distribution(newRequests.map((request) => request.ms)),
  };
}

function scriptEntry(html) {
  const entry = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+\.js(?:\?[^"']*)?)["'][^>]*>/giu)]
    .map((match) => match[1])
    .find(Boolean);
  if (!entry) throw new Error('Built index.html has no JavaScript entry script');
  const url = new URL(entry, 'http://scriptorium.invalid/');
  if (url.origin !== 'http://scriptorium.invalid' || !url.pathname.startsWith('/')) {
    throw new Error('Built JavaScript entry is not same-origin');
  }
  return url.pathname;
}

async function fileIdentity(root, path) {
  const bytes = await readFile(join(root, path));
  return { path, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function inspectUiArtifacts(staticDir, profile, sourceSha) {
  const archivePath = resolve('evidence/performance/static-artifact-hashes.json');
  const archivedRows = JSON.parse(await readFile(archivePath, 'utf8'));
  const expectedRows = archivedRows.filter((row) => row.source === 'baseline' && row.sourceSha === sourceSha && row.profile === profile);
  const mustMatchG5Baseline = sourceSha === '9f801061d1cc40c4719988b5e1aef17d3ff60e74';
  if (mustMatchG5Baseline && expectedRows.length !== 3) throw new Error(`G5 baseline artifact binding is incomplete for ${profile}`);
  const uiNames = ['launcher', 'desktop', 'mobile'];
  const uiArtifacts = [];
  for (const ui of uiNames) {
    const uiRoot = ui === 'launcher' ? staticDir : join(staticDir, ui);
    const manifestPath = '.vite/manifest.json';
    const manifestBytes = await readFile(join(uiRoot, manifestPath));
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const entry = manifest['index.html'];
    if (!entry || typeof entry.file !== 'string') throw new Error(`${ui} manifest has no index.html entry`);
    const html = await readFile(join(uiRoot, 'index.html'), 'utf8');
    const uiBase = ui === 'launcher' ? 'http://scriptorium.invalid/' : `http://scriptorium.invalid/${ui}/`;
    const htmlCssFiles = [...html.matchAll(/<link\b[^>]*>/giu)].flatMap(([tag]) => {
      const rel = /\brel=["']([^"']+)["']/iu.exec(tag)?.[1];
      const href = /\bhref=["']([^"']+\.css(?:\?[^"']*)?)["']/iu.exec(tag)?.[1];
      if (!rel?.split(/\s+/u).includes('stylesheet') || !href) return [];
      const url = new URL(href, uiBase);
      if (url.origin !== 'http://scriptorium.invalid') throw new Error(`${ui} stylesheet must be same-origin`);
      let path = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      if (ui !== 'launcher' && path.startsWith(`${ui}/`)) path = path.slice(ui.length + 1);
      return [path];
    });
    const emittedCssFiles = [...new Set([...(Array.isArray(entry.css) ? entry.css : []), ...htmlCssFiles])];
    const files = await Promise.all([
      fileIdentity(uiRoot, 'index.html'),
      fileIdentity(uiRoot, entry.file),
      ...emittedCssFiles.map((file) => fileIdentity(uiRoot, file)),
    ]);
    const row = expectedRows.find((candidate) => candidate.ui === ui);
    if (mustMatchG5Baseline) {
      const entryFile = files.find((file) => file.path === row.main.file);
      const cssFiles = new Map(files.map((file) => [file.path, file]));
      if (createHash('sha256').update(manifestBytes).digest('hex') !== row.manifestSha256 ||
          !entryFile || entryFile.bytes !== row.main.bytes || entryFile.sha256 !== row.main.sha256 ||
          row.css.some((css) => cssFiles.get(css.file)?.sha256 !== css.sha256 || cssFiles.get(css.file)?.bytes !== css.bytes)) {
        throw new Error(`G5 archived baseline hash mismatch for ${profile}/${ui}`);
      }
    }
    uiArtifacts.push({
      ui,
      directory: uiRoot,
      manifest: { path: manifestPath, sha256: createHash('sha256').update(manifestBytes).digest('hex') },
      entry: entry.file,
      files,
      ...(row ? { archivedBaseline: { sourceSha: row.sourceSha, main: row.main, css: row.css } } : {}),
    });
  }
  return { profile, sourceSha, verifiedArchivedG5Baseline: mustMatchG5Baseline, archivePath, uis: uiArtifacts };
}

async function measureBrowser(base) {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.SCRIPTORIUM_E2E_CHROMIUM ? { executablePath: process.env.SCRIPTORIUM_E2E_CHROMIUM } : {}),
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const loads = [];
    for (const route of ['/', '/desktop/', '/mobile/']) {
      const pair = [];
      for (const repeat of [false, true]) {
        await page.evaluate(() => performance.clearResourceTimings());
        const response = await page.goto(`${base}${route}`, { waitUntil: 'load', timeout: 60000 });
        if (!response || response.status() !== 200) throw new Error(`Static shell ${route} returned ${response?.status() ?? 'no response'}`);
        const values = await page.evaluate(() => {
          const navigation = performance.getEntriesByType('navigation')[0];
          const resources = performance.getEntriesByType('resource').map((entry) => ({
            name: entry.name,
            transferBytes: entry.transferSize,
            encodedBodyBytes: entry.encodedBodySize,
            decodedBodyBytes: entry.decodedBodySize,
          }));
          const assets = resources.filter(({ name }) => /\.(?:js|css|svg|png|jpe?g|webp|avif|gif|woff2?|ttf|otf)(?:\?|$)/iu.test(name));
          return {
            nonce: document.querySelector('meta[name="scriptorium-style-nonce"]')?.getAttribute('content') ?? null,
            document: {
              transferBytes: navigation?.transferSize ?? null,
              encodedBodyBytes: navigation?.encodedBodySize ?? null,
              decodedBodyBytes: navigation?.decodedBodySize ?? null,
            },
            assets,
          };
        });
        const assetTransferBytes = values.assets.reduce((sum, asset) => sum + asset.transferBytes, 0);
        pair.push({
          kind: repeat ? 'repeat' : 'first',
          status: response.status(),
          cacheControl: response.headers()['cache-control'] ?? null,
          csp: response.headers()['content-security-policy'] ?? null,
          ...values,
          totalTransferBytes: (values.document.transferBytes ?? 0) + assetTransferBytes,
        });
      }
      loads.push({
        route,
        first: pair[0],
        repeat: pair[1],
        savedTransferBytes: pair[0].totalTransferBytes - pair[1].totalTransferBytes,
        freshNonce: Boolean(pair[0].nonce && pair[1].nonce && pair[0].nonce !== pair[1].nonce),
      });
    }
    await context.close();
    return { status: 'complete', browser: browser.version(), loads };
  } finally {
    await browser.close();
  }
}

async function runProbe(outputDir, staticDir, profile, uiSourceSha) {
  const outputPath = resolve(outputDir);
  const worktree = resolve(process.cwd());
  if (outputPath === worktree || outputPath.startsWith(`${worktree}${sep}`)) {
    throw new Error('Write probe output outside the worktree, preferably under /data');
  }
  await mkdir(outputPath, { recursive: false });
  const dataDir = join(outputPath, 'server-state');
  const appDir = resolve(staticDir);
  const html = await readFile(join(appDir, 'index.html'), 'utf8');
  const assetPath = scriptEntry(html);
  const expectedBytes = await readFile(join(appDir, decodeURIComponent(assetPath.slice(1))));
  const uiArtifact = await inspectUiArtifacts(appDir, profile, uiSourceSha);
  const source = git(worktree, 'rev-parse', 'HEAD');
  const buildFiles = await Promise.all(['packages/api/dist/server.js', 'packages/core/dist/index.js', 'packages/module-runtime/dist/index.js']
    .map(async (path) => fileIdentity(worktree, path)));
  const reportPath = join(outputPath, 'static.json');
  const report = {
    status: 'running',
    harness: {
      source,
      scriptSha256: createHash('sha256').update(await readFile(scriptPath)).digest('hex'),
      node: process.version,
      platform: os.platform(),
      release: os.release(),
      architecture: os.arch(),
      cpus: os.cpus().map(({ model, speed }) => ({ model, speed })),
      totalMemoryBytes: os.totalmem(),
      freeMemoryBytes: os.freemem(),
      loadAverage: os.loadavg(),
      cpuAffinity: await readFile('/proc/self/status', 'utf8').then((status) => /^Cpus_allowed_list:\s*(.+)$/mu.exec(status)?.[1] ?? null),
      pnpm: execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim(),
      lockfileSha256: createHash('sha256').update(await readFile('pnpm-lock.yaml')).digest('hex'),
      serverBuild: buildFiles,
    },
    staticDir: appDir,
    uiArtifact,
    measuredAsset: { path: assetPath, bytes: expectedBytes.byteLength, sha256: createHash('sha256').update(expectedBytes).digest('hex') },
    requests: requestCount,
    server: null,
    browser: { status: 'NOT_CHECKED', reason: 'Browser pass has not started.' },
  };
  await save(reportPath, report);
  const child = fork(scriptPath, ['--server', dataDir, appDir], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  let browserCompleted = false;
  try {
    const ready = await new Promise((resolveReady, rejectReady) => {
      const onMessage = (message) => {
        if (message?.type !== 'ready') return;
        child.off('message', onMessage);
        resolveReady(message);
      };
      child.once('error', rejectReady);
      child.on('message', onMessage);
    });
    const base = `http://127.0.0.1:${ready.port}`;
    const warm = await fetch(`${base}${assetPath}`);
    if (!warm.ok || Buffer.byteLength(await warm.arrayBuffer()) !== expectedBytes.byteLength) {
      throw new Error(`Static warm-up did not return the current entry asset: ${warm.status}`);
    }
    const reset = await rpc(child, 'reset');
    const before = reset.snapshot;
    const ttfbMs = [];
    const fullResponseMs = [];
    const statuses = {};
    let bodyBytes = 0;
    for (let index = 0; index < requestCount; index += 1) {
      const startedAt = performance.now();
      const response = await fetch(`${base}${assetPath}`);
      const headersAt = performance.now();
      statuses[response.status] = (statuses[response.status] ?? 0) + 1;
      if (response.status !== 200) throw new Error(`Static asset GET ${index + 1} returned ${response.status}`);
      const body = Buffer.from(await response.arrayBuffer());
      if (body.byteLength !== expectedBytes.byteLength) throw new Error(`Static asset bytes changed during request ${index + 1}`);
      ttfbMs.push(headersAt - startedAt);
      fullResponseMs.push(performance.now() - startedAt);
      bodyBytes += body.byteLength;
    }
    const after = (await rpc(child, 'stats')).snapshot;
    report.server = {
      base,
      assetPath,
      requestCount,
      statusCounts: statuses,
      ttfbMs: distribution(ttfbMs),
      fullResponseMs: distribution(fullResponseMs),
      totalBodyBytes: bodyBytes,
      bytesPerResponse: expectedBytes.byteLength,
      measured: metricDelta(before, after),
      rawTtfbMs: ttfbMs,
      rawServerRequestMs: after.requests.map((request) => request.ms),
      serverRequestCount: after.requests.length,
    };
    await save(reportPath, report);

    const browserBefore = (await rpc(child, 'stats')).snapshot;
    try {
      report.browser = await measureBrowser(base);
      browserCompleted = true;
    } catch (error) {
      report.browser = { status: 'NOT_CHECKED', reason: error instanceof Error ? error.message : String(error) };
    }
    const browserAfter = (await rpc(child, 'stats')).snapshot;
    report.browser.server = metricDelta(browserBefore, browserAfter);
    report.browser.serverRequestCount = browserAfter.requests.length - browserBefore.requests.length;
    report.status = 'complete';
    await save(reportPath, report);
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error ? error.stack : String(error);
    await save(reportPath, report);
    throw error;
  } finally {
    await rpc(child, 'stop').catch(() => undefined);
    child.disconnect();
    if (child.exitCode === null) await new Promise((resolveExit) => child.once('exit', resolveExit));
    await rm(dataDir, { recursive: true, force: true });
    if (!browserCompleted && report.browser.status === 'NOT_CHECKED') await save(reportPath, report);
  }
}

if (serverMode) {
  await runServer(resolve(process.argv[3]), resolve(process.argv[4]));
} else {
  const outputDir = process.argv[2] ?? join('/data', `scriptorium-core64-static-${Date.now()}-${randomUUID().slice(0, 8)}`);
  const staticDir = process.argv[3] ?? resolve('app/dist');
  const profile = process.argv[4] ?? 'core';
  const uiSourceSha = process.argv[5] ?? git(process.cwd(), 'rev-parse', 'HEAD');
  if (profile !== 'core' && profile !== 'full') throw new Error('Profile must be core or full');
  await runProbe(outputDir, staticDir, profile, uiSourceSha);
}
