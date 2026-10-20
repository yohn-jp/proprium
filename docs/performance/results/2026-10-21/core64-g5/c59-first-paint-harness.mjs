import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium } from '/home/sophia/src/scriptorium-c64-g5/node_modules/@playwright/test/index.mjs';

const [profile, baselineBase, candidateBase, outputPath, samplesArg = '20'] = process.argv.slice(2);
if (!['core', 'full'].includes(profile) || !baselineBase || !candidateBase || !outputPath) {
  throw new Error('Usage: node first-paint-ab.mjs <core|full> <baseline-base-url> <c59-base-url> <output.json> [samples-per-variant=20]');
}
const samplesPerVariant = Number(samplesArg);
if (!Number.isInteger(samplesPerVariant) || samplesPerVariant < 10) throw new Error('samples-per-variant must be an integer >= 10');
const routes = [{ id: 'launcher', path: '/?g5=paint#launcher' }];
if (profile === 'full') routes.push({ id: 'public-reader', path: '/r/publishing/123/e2e-invalid-token?g5=paint#reader' });
const browserPath = process.env.SCRIPTORIUM_E2E_CHROMIUM;
if (!browserPath) throw new Error('Set SCRIPTORIUM_E2E_CHROMIUM to the configured Chromium 155 executable');
const report = {
  schemaVersion: 1,
  harness: { sha256: createHash('sha256').update(await (await import('node:fs/promises')).readFile(new URL(import.meta.url))).digest('hex') },
  environment: { profile, browserPath, baselineBase, candidateBase, samplesPerVariant, node: process.version, capturedAt: new Date().toISOString() },
  samples: [],
  errors: [],
};
const browser = await chromium.launch({ headless: true, executablePath: browserPath });
report.environment.browserVersion = browser.version();

try {
  for (const route of routes) {
    for (let sample = 0; sample < samplesPerVariant; sample++) {
      const variantOrder = sample % 2 === 0 ? ['baseline', 'c59'] : ['c59', 'baseline'];
      for (const variant of variantOrder) {
        const base = variant === 'baseline' ? baselineBase : candidateBase;
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
        const page = await context.newPage();
        const jsResponses = [];
        page.on('response', (response) => {
          const pathname = new URL(response.url()).pathname;
          if (pathname.endsWith('.js')) jsResponses.push({ pathname, status: response.status(), bytes: Number(response.headers()['content-length'] ?? 0) });
        });
        const started = performance.now();
        try {
          const response = await page.goto(new URL(route.path, base).toString(), { waitUntil: 'load', timeout: 30_000 });
          if (!response || response.status() !== 200) throw new Error(`${route.id} navigation returned ${response?.status() ?? 'no response'}`);
          if (route.id === 'launcher') await page.locator('#interface-title').waitFor({ state: 'visible', timeout: 15_000 });
          else {
            await page.getByRole('heading', { name: '共有された原稿' }).waitFor({ state: 'visible', timeout: 15_000 });
            await page.getByRole('alert').waitFor({ state: 'visible', timeout: 15_000 });
          }
          await page.waitForFunction(
            () => performance.getEntriesByName('first-contentful-paint').length > 0,
            null,
            { timeout: 5_000 },
          );
          const metrics = await page.evaluate(() => {
            const navigation = performance.getEntriesByType('navigation')[0];
            const paints = performance.getEntriesByType('paint');
            const fcp = paints.find((entry) => entry.name === 'first-contentful-paint');
            return {
              firstContentfulPaintMs: fcp?.startTime ?? null,
              domContentLoadedMs: navigation?.domContentLoadedEventEnd ?? null,
              loadEventEndMs: navigation?.loadEventEnd ?? null,
              url: location.href,
            };
          });
          if (metrics.firstContentfulPaintMs === null) throw new Error(`${route.id} has no first-contentful-paint entry`);
          await new Promise((resolveFrame) => setTimeout(resolveFrame, 0));
          const readyMs = await page.evaluate(() => performance.now());
          if (!metrics.url.includes(new URL(route.path, base).search) || !metrics.url.includes(new URL(route.path, base).hash)) {
            throw new Error(`${route.id} query/hash changed: ${metrics.url}`);
          }
          if (!jsResponses.some(({ pathname }) => pathname === '/main.js')) throw new Error(`${route.id} did not load the built /main.js entry`);
          report.samples.push({ route: route.id, variant, sample: sample + 1, status: response.status(), firstContentfulPaintMs: metrics.firstContentfulPaintMs, domContentLoadedMs: metrics.domContentLoadedMs, loadEventEndMs: metrics.loadEventEndMs, appReadyMs: readyMs, wallMs: performance.now() - started, finalUrl: metrics.url, jsResponses });
        } catch (error) {
          report.errors.push({ route: route.id, variant, sample: sample + 1, error: error instanceof Error ? error.message : String(error) });
          throw error;
        } finally {
          await context.close();
        }
      }
    }
  }
} finally {
  await browser.close();
  report.actualServedAssets = {};
  for (const [variant, base] of [['baseline', baselineBase], ['c59', candidateBase]]) {
    const paths = new Set(['/main.js']);
    for (const sample of report.samples) if (sample.variant === variant) {
      for (const asset of sample.jsResponses) paths.add(asset.pathname);
    }
    report.actualServedAssets[variant] = {};
    for (const pathname of [...paths].sort()) {
      const response = await fetch(new URL(pathname, base));
      if (!response.ok) throw new Error(`actual served asset ${variant}${pathname} returned ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      report.actualServedAssets[variant][pathname] = {
        status: response.status,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    }
  }
  const byGroup = {};
  for (const sample of report.samples) {
    const key = `${sample.route}/${sample.variant}`;
    (byGroup[key] ??= []).push(sample);
  }
  const percentile = (values, p) => {
    const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
    return sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null;
  };
  report.summary = Object.fromEntries(Object.entries(byGroup).map(([key, rows]) => [key, {
    n: rows.length,
    firstContentfulPaintMs: { p50: percentile(rows.map((row) => row.firstContentfulPaintMs), 0.50), p95: percentile(rows.map((row) => row.firstContentfulPaintMs), 0.95) },
    appReadyMs: { p50: percentile(rows.map((row) => row.appReadyMs), 0.50), p95: percentile(rows.map((row) => row.appReadyMs), 0.95) },
  }]));
  await mkdir(dirname(resolve(outputPath)), { recursive: true });
  await writeFile(resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`);
}
