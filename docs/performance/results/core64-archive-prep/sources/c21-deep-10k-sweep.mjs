import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const repo = process.env.SCRIPTORIUM_REPO;
const [fixtureArg, outputArg, budgetArg = '180000'] = process.argv.slice(2);
if (!repo || !fixtureArg || !outputArg) throw new Error('set SCRIPTORIUM_REPO and pass <fixture> <output.json> [budgetMs=180000]');
const fixture = path.resolve(fixtureArg);
const output = path.resolve(outputArg);
const budgetMs = Number(budgetArg);
if (!Number.isSafeInteger(budgetMs) || budgetMs < 1000 || budgetMs > 180000) throw new Error('budget must be 1000..180000ms');
const manifest = JSON.parse(await fs.readFile(path.join(fixture, 'dataset.json'), 'utf8'));
if (!manifest.syntheticOnly || !manifest.remote) throw new Error('fixture must be a generated synthetic dataset');
const localImport = (file) => import(pathToFileURL(path.join(repo, file)).href);
const { counts, gitCommands } = await localImport('scripts/performance/instrument-node.mjs');
const { measure, distribution } = await localImport('scripts/performance/common.mjs');
const { CoreStore } = await localImport('packages/core/dist/index.js');
const { createDocumentSource } = await localImport('packages/contracts/dist/index.js');
const taskDir = await fs.mkdtemp(path.join(os.tmpdir(), 'c64-g2-deep-10k-'));
const progressPath = `${output}.progress.json`;
const report = {
  harness: {
    source: execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    node: process.version,
    dataset: manifest.datasetId,
    datasetCommit: manifest.commit,
    workload: 'DocumentSource.readMany(all available deep paths; 32-path contract batches)',
    requestedPaths: 10000,
    chunkSize: 32,
    budgetMs,
  },
  completedPaths: 0,
  completedBatches: 0,
  expectedDeepPaths: 0,
  expectedPaths: 0,
  expectedBytes: 0,
  completedBytes: 0,
  exactRevisionAssertions: 0,
  expectedRevisionListSha256: null,
  completedRevisionListSha256: null,
  totalGitProcesses: 0,
  gitSubcommands: {},
  userCpuUs: 0,
  systemCpuUs: 0,
  peakRssBytes: 0,
  maxRssKiB: 0,
  completedBatchElapsedMs: [],
  stopReason: null,
};

async function saveJson(filePath, data) {
  const temporary = `${filePath}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`);
  await fs.rename(temporary, filePath);
}

function commandCountsSinceReset() {
  const commands = {};
  for (const entry of gitCommands) {
    const command = ['ls-tree', 'cat-file'].find((name) => entry.args.includes(name)) ?? 'other';
    commands[command] = (commands[command] ?? 0) + 1;
  }
  return commands;
}

try {
  const remote = path.join(taskDir, 'remote.git');
  execFileSync('git', ['clone', '--bare', '--quiet', manifest.remote, remote], { stdio: 'ignore' });
  const store = new CoreStore({ dataDir: path.join(taskDir, 'state'), allowLocalRemotes: true });
  const project = await store.registerProject({ url: remote });
  const observed = await store.observe(project.id);
  const reader = await store.reader(project.id, 'remote', observed.snapshot);
  const source = createDocumentSource(reader);
  const paths = (await reader.list('')).sort().slice(0, 10000);
  if (paths.length < 10000) throw new Error(`fixture exposes only ${paths.length} readable paths`);
  const expected = [];
  const expectedRevisionDigest = createHash('sha256');
  const completedRevisionDigest = createHash('sha256');
  const expectedByteLengths = [];
  for (const filePath of paths) {
    const bytes = await fs.readFile(path.join(fixture, 'seed', ...filePath.split('/')));
    const revision = createHash('sha256').update(bytes).digest('hex');
    expected.push({ path: filePath, content: bytes.toString('utf8'), revision });
    expectedByteLengths.push(bytes.byteLength);
    if (filePath.split('/').length >= 4) report.expectedDeepPaths += 1;
    report.expectedBytes += bytes.byteLength;
    expectedRevisionDigest.update(`${filePath}\0${revision}\n`);
  }
  report.expectedPaths = paths.length;
  report.expectedRevisionListSha256 = expectedRevisionDigest.digest('hex');

  const start = performance.now();
  const stopBeforeMs = Math.max(0, budgetMs - 5_000);
  for (let offset = 0; offset < paths.length; offset += report.harness.chunkSize) {
    if (performance.now() - start >= stopBeforeMs) {
      report.stopReason = 'time budget reached before next complete 32-path batch';
      break;
    }
    const batchPaths = paths.slice(offset, offset + report.harness.chunkSize);
    const expectedBatch = expected.slice(offset, offset + report.harness.chunkSize);
    gitCommands.length = 0;
    const result = await measure('readMany.10k-sweep.batch', () => source.readMany(batchPaths), () => ({ ...counts }));
    assert.deepEqual(result.value, expectedBatch);
    report.completedPaths += result.value.length;
    report.completedBatches += 1;
    report.exactRevisionAssertions += result.value.length;
    for (let index = 0; index < result.value.length; index += 1) {
      const item = result.value[index];
      report.completedBytes += expectedByteLengths[offset + index];
      completedRevisionDigest.update(`${item.path}\0${item.revision}\n`);
    }
    report.completedRevisionListSha256 = completedRevisionDigest.copy().digest('hex');
    report.totalGitProcesses += result.sample.counters.gitProcesses;
    report.userCpuUs += result.sample.cpuUs.user;
    report.systemCpuUs += result.sample.cpuUs.system;
    report.peakRssBytes = Math.max(report.peakRssBytes, result.sample.rssBytes);
    report.maxRssKiB = Math.max(report.maxRssKiB, result.sample.maxRssKiB);
    report.completedBatchElapsedMs.push(result.sample.ms);
    for (const [command, count] of Object.entries(commandCountsSinceReset())) {
      report.gitSubcommands[command] = (report.gitSubcommands[command] ?? 0) + count;
    }
    if (report.completedBatches % 8 === 0) {
      report.elapsedMs = performance.now() - start;
      await saveJson(progressPath, report);
    }
  }
  report.elapsedMs = performance.now() - start;
  if (!report.stopReason && report.completedPaths === report.expectedPaths) report.stopReason = 'completed all 10,000 paths';
  else if (!report.stopReason) report.stopReason = 'stopped before all requested paths completed';
  report.batchElapsedMs = distribution(report.completedBatchElapsedMs);
  await saveJson(output, report);
} finally {
  await fs.rm(taskDir, { recursive: true, force: true });
}
