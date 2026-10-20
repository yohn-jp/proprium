// Bounded, sequential launcher for synthetic G2 writer checkpoints. It reads
// the immutable Wave 0 seed and imports the accepted frozen Core build without
// rebuilding production code.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git as datasetGit } from './dataset.mjs';
import { runWorker } from './run.mjs';
import { save } from './common.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outputRootArg = process.argv[2];
if (!outputRootArg) throw new Error('Usage: node scripts/performance/core64-writer.mjs <new-output-root>');
const outputRoot = resolve(outputRootArg);
const resultsRoot = join(outputRoot, 'results');
const scratchRoot = join(outputRoot, 'scratch');
const fixtureRoot = resolve(process.env.CORE64_WRITER_G0_FIXTURE ?? '/tmp/scriptorium-wave0-baseline-20261020/small');
const runtimeRoot = resolve(process.env.CORE64_WRITER_RUNTIME_ROOT ?? '/home/sophia/src/scriptorium-c64-derived');
const runtimeEntry = join(runtimeRoot, 'packages/core/dist/index.js');
const runtimeSourceCommit = 'f633da0b3f133ad812953c284aab35a4956d2507';
const runtimeIndexSha256 = 'a7b83895e2c239d85a3f4d973cf7458e64cc7415c418a4844ff33f700a52d4a3';
const contractsIndexSha256 = 'b33421f57a9ba54adebdf06fee5c298ed2cdd65ea0a710d885d87d0f974b15be';
const acceptedCoreSourceSha256 = 'dd05006e97a4dd471fd3555b852d1ad4166de53a4ec41b80d8a0c52d3ab929c5';
const expectedFixtureCommit = 'e70bb509cc41b383451335e05af36d78f1cb31db';

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`));
}

for (const protectedPath of [repoRoot, fixtureRoot, runtimeRoot]) {
  if (isWithin(protectedPath, outputRoot)) throw new Error(`Output root must be outside protected path ${protectedPath}`);
}

const command = (...args) => datasetGit(repoRoot, ...args);
const runtimeCommand = (...args) => datasetGit(runtimeRoot, ...args);
const hashFile = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
async function effectiveCpuSet() {
  try {
    const status = await readFile('/proc/self/status', 'utf8');
    return status.match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1] ?? null;
  } catch { return null; }
}

async function treeDigest(directory) {
  const hash = createHash('sha256');
  async function visit(current, prefix = '') {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(current, entry.name);
      if (entry.isDirectory()) await visit(full, relative);
      else if (entry.isFile()) hash.update(relative).update('\0').update(await readFile(full)).update('\0');
      else throw new Error(`Unexpected non-file entry in frozen runtime: ${full}`);
    }
  }
  await visit(directory);
  return hash.digest('hex');
}

const manifestPath = join(fixtureRoot, 'dataset.json');
const fixture = JSON.parse(await readFile(manifestPath, 'utf8'));
const fixtureManifestSha256 = await hashFile(manifestPath);
const fixtureRemote = resolve(fixture.remote);
if (fixture.size !== 'small' || fixture.files !== 10 || fixture.syntheticOnly !== true ||
    fixture.commit !== expectedFixtureCommit || fixture.historyCommits !== 1 ||
    fixtureRemote !== join(fixtureRoot, 'origin.git')) {
  throw new Error('Expected the immutable 10-file G0 synthetic fixture and its original local bare remote');
}
const fixtureRemoteHead = datasetGit(repoRoot, '--git-dir', fixtureRemote, 'rev-parse', 'main');
if (fixtureRemoteHead !== expectedFixtureCommit) throw new Error('G0 seed remote HEAD does not match its accepted manifest');

if (!(await stat(runtimeEntry)).isFile()) throw new Error(`Accepted Core runtime entry does not exist: ${runtimeEntry}`);
if (runtimeCommand('rev-parse', 'HEAD') !== runtimeSourceCommit) {
  throw new Error(`Expected accepted frozen Core runtime ${runtimeSourceCommit}`);
}
if (runtimeCommand('status', '--porcelain') !== '') throw new Error('Accepted frozen runtime checkout is not clean');
const runtimeCoreSourceSha256 = await hashFile(join(runtimeRoot, 'packages/core/src/index.ts'));
const currentCoreSourceSha256 = await hashFile(join(repoRoot, 'packages/core/src/index.ts'));
if (runtimeCoreSourceSha256 !== acceptedCoreSourceSha256 || currentCoreSourceSha256 !== acceptedCoreSourceSha256 ||
    runtimeCoreSourceSha256 !== currentCoreSourceSha256) {
  throw new Error('Accepted runtime Core source does not exactly match the current source under measurement');
}
const runtimeCoreDistSha256 = await treeDigest(join(runtimeRoot, 'packages/core/dist'));
const actualRuntimeIndexSha256 = await hashFile(runtimeEntry);
const runtimeContractsDistSha256 = await treeDigest(join(runtimeRoot, 'packages/contracts/dist'));
const actualContractsIndexSha256 = await hashFile(join(runtimeRoot, 'packages/contracts/dist/index.js'));
if (actualRuntimeIndexSha256 !== runtimeIndexSha256 || actualContractsIndexSha256 !== contractsIndexSha256) {
  throw new Error('Accepted compiled Core or contracts entry does not match its pinned SHA-256');
}
const executionMode = process.env.CORE64_WRITER_RUN_MODE ?? 'unspecified';
const requestedCpuSet = process.env.CORE64_WRITER_REQUESTED_CPUSET ?? null;
const effectiveCpuSetAtStart = await effectiveCpuSet();
if (executionMode === 'contended' && (!requestedCpuSet || effectiveCpuSetAtStart !== requestedCpuSet)) {
  throw new Error(`Contended writer cohort requires matching requested/effective CPU affinity; got ${requestedCpuSet}/${effectiveCpuSetAtStart}`);
}

// A fresh output root keeps all benchmark clones and Core state away from the
// immutable G0 fixture and from any other probe result.
await mkdir(outputRoot);
await mkdir(resultsRoot);
await mkdir(scratchRoot);

const sourceCommit = command('rev-parse', 'HEAD');
const coreSourceCommit = command('log', '-1', '--format=%H', '--', 'packages/core/src/index.ts');
const cases = [
  { kind: 'checkpoint', scale: 1, repeats: 5, timeoutMs: 90_000 },
  { kind: 'checkpoint', scale: 10, repeats: 5, timeoutMs: 90_000 },
  { kind: 'checkpoint', scale: 100, repeats: 5, timeoutMs: 90_000 },
  { kind: 'census', scale: 1, repeats: 3, timeoutMs: 30_000 },
  { kind: 'census', scale: 100, repeats: 3, timeoutMs: 60_000 },
  { kind: 'census', scale: 1000, repeats: 3, timeoutMs: 90_000 },
  { kind: 'census', scale: 10000, repeats: 3, timeoutMs: 120_000 },
  { kind: 'publish', scale: 1, repeats: 5, timeoutMs: 60_000 },
  { kind: 'publish', scale: 10, repeats: 5, timeoutMs: 120_000 },
  { kind: 'publish', scale: 100, repeats: 3, timeoutMs: 180_000 },
];
const runtime = {
  root: runtimeRoot,
  entry: runtimeEntry,
  sourceCommit: runtimeSourceCommit,
  coreSourceSha256: runtimeCoreSourceSha256,
  coreIndexSha256: actualRuntimeIndexSha256,
  coreDistSha256: runtimeCoreDistSha256,
  contractsIndexSha256: actualContractsIndexSha256,
  contractsDistSha256: runtimeContractsDistSha256,
};
const run = {
  schemaVersion: 1,
  status: 'running',
  startedAt: new Date().toISOString(),
  sourceCommit,
  coreSourceCommit,
  coreSourceSha256: currentCoreSourceSha256,
  sourceStatus: command('status', '--short'),
  node: process.version,
  os: { platform: os.platform(), release: os.release(), arch: os.arch() },
  cpus: os.cpus(),
  totalMemoryBytes: os.totalmem(),
  freeMemoryBytesAtStart: os.freemem(),
  loadAverageAtStart: os.loadavg(),
  execution: { mode: executionMode, requestedCpuSet, effectiveCpuSet: effectiveCpuSetAtStart },
  runtime,
  fixture: { ...fixture, manifestSha256: fixtureManifestSha256, remoteHead: fixtureRemoteHead },
  scratchRoot,
  cases,
  results: [],
};
const runPath = join(resultsRoot, 'run.json');
await save(runPath, run);

const worker = fileURLToPath(new URL('./core64-writer-worker.mjs', import.meta.url));
for (const item of cases) {
  const name = `${item.kind}-${item.scale}`;
  const output = join(resultsRoot, `${name}.json`);
  const result = await runWorker(worker,
    [fixtureRoot, scratchRoot, output, item.kind, String(item.scale), String(item.repeats), runtimeEntry, runtimeSourceCommit],
    output,
    item.timeoutMs,
    { SCRIPTORIUM_PROFILE: 'core', GITHUB_TOKEN: '', GH_TOKEN: '', SCRIPTORIUM_GITHUB_TOKEN: '' });
  run.results.push({ name, status: result.status, timeout: result.execution?.timeout ?? false,
    completedSamples: result.samples?.length ?? 0, output: `${name}.json` });
  run.status = run.results.every(({ status }) => status === 'complete') ? 'complete' : 'NOT_CHECKED';
  run.lastFinishedAt = new Date().toISOString();
  await save(runPath, run);
}

run.fixtureManifestSha256After = await hashFile(manifestPath);
run.fixtureRemoteHeadAfter = datasetGit(repoRoot, '--git-dir', fixtureRemote, 'rev-parse', 'main');
run.runtimeCoreDistSha256After = await treeDigest(join(runtimeRoot, 'packages/core/dist'));
run.runtimeContractsDistSha256After = await treeDigest(join(runtimeRoot, 'packages/contracts/dist'));
run.runtimeCheckoutCleanAfter = runtimeCommand('status', '--porcelain') === '';
run.effectiveCpuSetAfter = await effectiveCpuSet();
run.affinityUnchanged = executionMode !== 'contended' || run.effectiveCpuSetAfter === requestedCpuSet;
run.fixtureUnchanged = run.fixtureManifestSha256After === fixtureManifestSha256 &&
  run.fixtureRemoteHeadAfter === fixtureRemoteHead;
run.runtimeUnchanged = run.runtimeCheckoutCleanAfter &&
  run.runtimeCoreDistSha256After === runtimeCoreDistSha256 &&
  run.runtimeContractsDistSha256After === runtimeContractsDistSha256;
if (!run.fixtureUnchanged || !run.runtimeUnchanged || !run.affinityUnchanged) {
  run.status = 'failed';
  run.error = 'Immutable G0 fixture, accepted frozen runtime or requested CPU affinity changed during the probe';
}
run.finishedAt = new Date().toISOString();
await save(runPath, run);

console.log(JSON.stringify({ status: run.status, output: resultsRoot, cases: run.results }, null, 2));
