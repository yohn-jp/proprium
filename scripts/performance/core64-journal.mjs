import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [outputPath, repeatsArgument = '20', modeArgument] = process.argv.slice(2);
const repeats = Number(repeatsArgument);
const scopedOnly = modeArgument === '--scoped-only';
if (!outputPath || !Number.isInteger(repeats) || repeats < 5 || repeats > 50 || (modeArgument !== undefined && !scopedOnly)) {
  throw new Error('Usage: SCRIPTORIUM_CORE64_RUNTIME_ROOT=<frozen-root> node scripts/performance/core64-journal.mjs <output.json> [5..50 repeats] [--scoped-only]');
}

const runtimeRoot = resolve(process.env.SCRIPTORIUM_CORE64_RUNTIME_ROOT ?? process.cwd());
const worktreeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const requireFromRuntime = createRequire(resolve(runtimeRoot, 'package.json'));
const requireFromApp = createRequire(resolve(runtimeRoot, 'app/package.json'));
const { chromium } = requireFromRuntime('@playwright/test');
const { createServer } = await import(pathToFileURL(requireFromApp.resolve('vite')).href);
const chromiumPath = process.env.SCRIPTORIUM_E2E_CHROMIUM;
if (!chromiumPath) throw new Error('Set SCRIPTORIUM_E2E_CHROMIUM to the accepted Chromium executable.');

const probeHtmlPath = resolve(worktreeRoot, 'scripts/performance/core64-journal-probe.html');
const probeScriptPath = fileURLToPath(import.meta.url);
const outputFile = resolve(outputPath);
const probeHtml = await readFile(probeHtmlPath, 'utf8');
const journalModuleSource = await readFile(resolve(runtimeRoot, 'app/src/storage/journal.ts'));

function distribution(samples, field) {
  const values = samples.map((sample) => sample[field]).filter(Number.isFinite).sort((left, right) => left - right);
  const percentile = (value) => values[Math.max(0, Math.ceil(value * values.length) - 1)] ?? null;
  return { n: values.length, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: values.at(-1) ?? null };
}

function summarize(reportValue) {
  return {
    nearestRankPercentiles: { rule: 'ceil(p*n)', samples: repeats, p95IsMaximum: Math.ceil(0.95 * repeats) === repeats },
    recordRestore: Object.fromEntries(reportValue.recordPayloads.map((payload) => [payload.targetTextUtf8Bytes, {
      endToEndMs: distribution(payload.getDocumentSamples, 'elapsedMs'),
      indexedRequestMs: distribution(payload.getDocumentSamples, 'requestMs'),
      transactionMs: distribution(payload.getDocumentSamples, 'transactionMs'),
    }])),
    putLatestDraft: Object.fromEntries(Object.entries(reportValue.putLatestDraft).map(([count, samples]) => [count, {
      endToEndMs: distribution(samples, 'elapsedMs'),
      strictTransactionMs: distribution(samples, 'strictTransactionMs'),
    }])),
    inventory: reportValue.inventory ? {
      getAllEntries: {
        endToEndMs: distribution(reportValue.inventory.getAllEntriesSamples, 'elapsedMs'),
        indexedRequestMs: distribution(reportValue.inventory.getAllEntriesSamples, 'requestMs'),
        transactionMs: distribution(reportValue.inventory.getAllEntriesSamples, 'transactionMs'),
      },
      getAllProposals: {
        endToEndMs: distribution(reportValue.inventory.getAllProposalsSamples, 'elapsedMs'),
        indexedRequestMs: distribution(reportValue.inventory.getAllProposalsSamples, 'requestMs'),
        transactionMs: distribution(reportValue.inventory.getAllProposalsSamples, 'transactionMs'),
      },
    } : null,
  };
}

function installJournalMetrics() {
  const metrics = {
    transactions: [],
    reads: [],
    reset() { this.transactions.length = 0; this.reads.length = 0; },
  };
  window.__core64JournalMetrics = metrics;
  const transaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function(...args) {
    const start = performance.now();
    const result = Reflect.apply(transaction, this, args);
    const row = { start, mode: result.mode, durability: result.durability,
      stores: Array.from(result.objectStoreNames), status: 'pending' };
    metrics.transactions.push(row);
    result.addEventListener('complete', () => Object.assign(row, { ms: performance.now() - start, status: 'complete' }));
    result.addEventListener('abort', () => Object.assign(row, { ms: performance.now() - start, status: 'aborted' }));
    return result;
  };
  for (const [source, prototype] of [['store', IDBObjectStore.prototype], ['index', IDBIndex.prototype]]) {
    for (const method of ['get', 'getAll', 'count']) {
      const original = prototype[method];
      prototype[method] = function(...args) {
        const start = performance.now();
        const request = Reflect.apply(original, this, args);
        const row = { start, source, method, store: source === 'index' ? this.objectStore.name : this.name,
          ...(source === 'index' ? { index: this.name } : {}), status: 'pending' };
        metrics.reads.push(row);
        request.addEventListener('success', () => Object.assign(row, { ms: performance.now() - start,
          status: 'complete', records: method === 'count' ? request.result : Array.isArray(request.result) ? request.result.length : request.result == null ? 0 : 1 }));
        request.addEventListener('error', () => Object.assign(row, { ms: performance.now() - start, status: 'failed' }));
        return request;
      };
    }
  }
}

const appRoot = resolve(runtimeRoot, 'app');
const appConfig = resolve(appRoot, 'vite.config.ts');
const probeHtmlSource = await readFile(probeHtmlPath);
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: runtimeRoot, encoding: 'utf8' }).trim();
const report = {
  schemaVersion: 1,
  source: {
    gitHead: sourceCommit,
    journalSourceSha256: createHash('sha256').update(journalModuleSource).digest('hex'),
    probeScriptSha256: createHash('sha256').update(await readFile(probeScriptPath)).digest('hex'),
    probeHtmlSha256: createHash('sha256').update(probeHtmlSource).digest('hex'),
    runtimeRoot,
    probeRoot: worktreeRoot,
  },
  browserExecutable: chromiumPath,
  node: process.version,
  mode: scopedOnly ? 'scoped-author-filter-only' : 'full',
  repeats: scopedOnly ? 1 : repeats,
  physicalIndexedDbBytes: 'not exposed by the browser; logical UTF-8 fields, JSON serialization bytes, and origin usage estimates are reported separately',
  status: 'running',
  recordPayloads: [],
  putLatestDraft: {},
  isolation: null,
  inventory: null,
  scopedAuthorFilter: null,
  probeStartupDiagnostics: [],
};

const probePlugin = {
  name: 'core64-journal-probe-entry',
  configureServer(server) {
    server.middlewares.use('/__core64-journal-probe.html', async (_request, response, next) => {
      try {
        const transformedHtml = await server.transformIndexHtml('/__core64-journal-probe.html', probeHtml);
        response.statusCode = 200;
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(transformedHtml);
      } catch (error) {
        next(error);
      }
    });
  },
};

let vite;
let browser;
try {
  vite = await createServer({
    root: appRoot,
    configFile: appConfig,
    cacheDir: resolve(process.env.SCRIPTORIUM_CORE64_CACHE_DIR ?? '/tmp/scriptorium-core64-journal-vite-cache'),
    mode: 'development',
    clearScreen: false,
    server: { host: '127.0.0.1', port: Number(process.env.SCRIPTORIUM_CORE64_PORT ?? 30000 + (process.pid % 20000)), strictPort: false, hmr: false, open: false },
    plugins: [probePlugin],
  });
  await vite.listen();
  const address = vite.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not expose a TCP listener.');
  report.origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, executablePath: chromiumPath });
  report.browser = browser.version();

  async function openProbePage() {
    const context = await browser.newContext();
    await context.addInitScript(installJournalMetrics);
    const page = await context.newPage();
    const diagnostics = [];
    page.on('console', (message) => diagnostics.push({ kind: 'console', type: message.type(), text: message.text() }));
    page.on('pageerror', (error) => diagnostics.push({ kind: 'pageerror', message: error.message, stack: error.stack ?? null }));
    page.on('requestfailed', (request) => diagnostics.push({ kind: 'requestfailed', url: request.url(), error: request.failure()?.errorText ?? null }));
    page.on('response', (response) => {
      if (response.status() >= 400) diagnostics.push({ kind: 'http', status: response.status(), url: response.url() });
    });
    try {
      await page.goto(`${report.origin}/__core64-journal-probe.html`);
      await page.waitForFunction(() => window.__core64JournalProbe?.ready === true);
    } catch (error) {
      const pageText = await page.locator('body').innerText().catch(() => '');
      const detail = { message: error.message, diagnostics, pageText: pageText.slice(0, 2000) };
      report.probeStartupDiagnostics.push(detail);
      throw new Error(`Probe page startup failed: ${JSON.stringify(detail)}`);
    }
    return { context, page };
  }

  if (scopedOnly) {
    const { context, page } = await openProbePage();
    try {
      report.scopedAuthorFilter = await page.evaluate(() => window.__core64JournalProbe.measureScopedAuthorFilter());
    } finally {
      await context.close();
    }
  } else {
    for (const bytes of [102400, 1048576]) {
      const { context, page } = await openProbePage();
      try {
        report.recordPayloads.push(await page.evaluate((input) => window.__core64JournalProbe.measurePayload(input), { bytes, repeats }));
      } finally {
        await context.close();
      }
    }

    const { context, page } = await openProbePage();
    try {
      for (const count of [1, 100, 1000]) {
        const samples = await page.evaluate(({ count: occupancy, repeats: sampleCount }) =>
          window.__core64JournalProbe.measureC15(occupancy, sampleCount), { count, repeats });
        report.putLatestDraft[count] = samples;
      }
      report.isolation = await page.evaluate(() => window.__core64JournalProbe.measureC15Isolation());
    } finally {
      await context.close();
    }

    const inventoryProbe = await openProbePage();
    try {
      report.inventory = await inventoryProbe.page.evaluate((input) => window.__core64JournalProbe.measureInventory(input), { count: 1000, repeats });
    } finally {
      await inventoryProbe.context.close();
    }
  }

  report.status = 'complete';
} catch (error) {
  report.status = 'failed';
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (vite) await vite.close();
  report.summary = scopedOnly ? null : summarize(report);
  await mkdir(dirname(resolve(outputPath)), { recursive: true });
  await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`);
}
