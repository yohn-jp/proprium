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
