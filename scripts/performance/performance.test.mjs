import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { distribution } from './common.mjs';
import { generate, git } from './dataset.mjs';
import { runWorker } from './run.mjs';

test('nearest-rank quantiles retain missing observations and sample count', () => {
  assert.deepEqual(distribution([]), { n: 0, p50: null, p95: null, p99: null });
  const result = distribution(Array.from({ length: 100 }, (_, i) => 100 - i));
  assert.deepEqual(result, { n: 100, p50: 50, p95: 95, p99: 99, max: 100 });
});
test('synthetic fixture has exact tracked count, document sizes and reproducible Git identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wave0-test-'));
  try {
    const a = await generate(join(root, 'a'), 'small'), b = await generate(join(root, 'b'), 'small');
    assert.equal(a.files, 10); assert.equal(a.commit, b.commit);
    for (let i = 1; i <= 3; i++) assert.equal(Buffer.byteLength(await readFile(join(root, 'a/seed/manuscript/vol-1/ch-1', `scene-${i}.md`))), a.documentBytes[i - 1]);
    assert.equal(git(join(root, 'a/seed'), 'ls-files').split('\n').length, 10);
    await assert.rejects(generate(join(root, 'a'), 'small'), { code: 'EEXIST' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('node interception preserves promisified execFile result and failed process errors', async () => {
  const { counts } = await import('./instrument-node.mjs');
  const cp = await import('node:child_process');
  const run = promisify(cp.execFile), before = counts.gitProcesses;
  assert.match((await run('git', ['--version'])).stdout, /^git version/);
  assert.equal(counts.gitProcesses, before + 1);
  await assert.rejects(run('git', ['--invalid-benchmark-argument']), error => error.code !== 0 && typeof error.stderr === 'string');
});
test('worker timeout retains completed evidence without claiming completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wave0-worker-'));
  try {
    const worker = join(root, 'hang.mjs'), output = join(root, 'result.json');
    await writeFile(worker, `import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], JSON.stringify({status:'running',samples:[{name:'completed',ms:12}]})); setInterval(()=>{},1000);`);
    const result = await runWorker(worker, [output], output, 500);
    assert.equal(result.status, 'NOT_CHECKED'); assert.equal(result.execution.timeout, true);
    assert.equal(result.samples[0].ms, 12);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('browser summaries distinguish completed strict writes from pending or aborted transactions', async () => {
  const { summarizeBrowser } = await import('./summarize.mjs');
  const browser = { inputs: [{ type: 'keydown', key: 'a', start: 2, frameMs: 12 }], reactCommits: [], longTasks: [],
    reads: [{ start: 2, method: 'getAll', records: 3 }], transactions: [
      { start: 2, mode: 'readwrite', durability: 'strict', status: 'complete', ms: 5 },
      { start: 2, mode: 'readwrite', durability: 'strict', status: 'pending' },
      { start: 2, mode: 'readwrite', durability: 'strict', status: 'aborted', ms: 8 },
    ] };
  const result = summarizeBrowser({ status: 'NOT_CHECKED', phases: [{ name: 'input.1024', start: 1, end: 3, browser }], samples: [], requests: [] });
  assert.equal(result.status, 'NOT_CHECKED');
  assert.equal(result.inputs[0].strictWriteMs.n, 1);
  assert.equal(result.inputs[0].strictWriteMs.p95, 5);
  assert.deepEqual(result.inputs[0].transactions, { total: 3, pending: 1, aborted: 1 });
  assert.equal(result.inputs[0].reads.returnedRecords, 3);
});

test('worker timeout also terminates a detached descendant', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'wave0-detached-'));
  try {
    const worker = join(root, 'worker.mjs'), output = join(root, 'result.json');
    await writeFile(worker, `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs'; const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); writeFileSync(process.argv[2],JSON.stringify({status:'running',samples:[],descendantPid:child.pid})); setInterval(()=>{},1000);`);
    const result = await runWorker(worker, [output], output, 500);
    assert.equal(result.status, 'NOT_CHECKED');
    // An exited descendant can remain a zombie briefly until the host reaps it.
    let state = 'missing';
    try { state = (await readFile(`/proc/${result.descendantPid}/stat`, 'utf8')).split(') ')[1].split(' ')[0]; }
    catch (error) { assert.equal(error.code, 'ENOENT'); }
    assert.ok(['missing', 'Z'].includes(state), `Detached child remained live: ${state}`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('current author pipeline records receipts and leaves the generated seed remote immutable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wave0-pipeline-'));
  try {
    const datasetPath = join(root, 'fixture'), output = join(root, 'result.json');
    const fixture = await generate(datasetPath, 'small');
    const result = await runWorker(new URL('./core.mjs', import.meta.url).pathname,
      [datasetPath, output, '1', 'mutation'], output, 30000);
    assert.equal(result.status, 'complete', JSON.stringify(result.error));
    assert.equal(result.execution.code, 0);
    for (const name of ['proposal', 'approval', 'checkpoint', 'publish']) {
      const sample = result.samples.find(row => row.name === name);
      assert.ok(sample && sample.ms > 0 && sample.counters.gitProcesses > 0, name);
    }
    assert.equal(git(root, '--git-dir', fixture.remote, 'rev-parse', 'main'), fixture.commit);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('browser probes retain strict IDB semantics and count document index reads', { skip: !process.env.SCRIPTORIUM_E2E_CHROMIUM }, async () => {
  const { chromium } = await import('@playwright/test');
  const { installBrowserProbes } = await import('./browser-probes.mjs');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.SCRIPTORIUM_E2E_CHROMIUM });
  try {
    const context = await browser.newContext();
    await context.addInitScript(installBrowserProbes);
    const page = await context.newPage();
    await page.route('http://127.0.0.1/benchmark', route => route.fulfill({ contentType: 'text/html', body: '<p>Synthetic probe test</p>' }));
    await page.goto('http://127.0.0.1/benchmark');
    const result = await page.evaluate(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('synthetic-probe', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('operations', { keyPath: 'id' }).createIndex('documentKey', 'documentKey');
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const tx = database.transaction('operations', 'readwrite', { durability: 'strict' });
      const complete = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
      tx.objectStore('operations').put({ id: 'a', documentKey: 'synthetic' });
      const request = tx.objectStore('operations').index('documentKey').getAll('synthetic');
      const rows = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      await complete; database.close();
      return { rows, metrics: structuredClone(window.__wave0) };
    });
    assert.equal(result.rows.length, 1);
    assert.ok(result.metrics.transactions.some(tx => tx.durability === 'strict' && tx.status === 'complete'));
    assert.ok(result.metrics.reads.some(read => read.source === 'index' && read.index === 'documentKey' && read.records === 1 && read.status === 'complete'));
  } finally { await browser.close(); }
});
