#!/usr/bin/env node
// Bounded C30/C31/C63 boundary and retained-cache probe. The orchestrator is
// intentionally opt-in: it creates synthetic fixtures only when invoked with
// --run after the campaign's exclusive measurement lease is granted.
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { syncBuiltinESMExports } from 'node:module';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const MAX_BUFFER = 32 * MiB;
const SCRIPT = fileURLToPath(import.meta.url);
const ACCEPTED_RUNTIME_REVISION = 'f633da0b3f133ad812953c284aab35a4956d2507';
const ACCEPTED_CORE_MODULE_SHA256 = 'a7b83895e2c239d85a3f4d973cf7458e64cc7415c418a4844ff33f700a52d4a3';
const WORKER_ADDRESS_SPACE_BYTES = 6 * GiB;
const WORKER_V8_OLD_SPACE_MIB = 2048;
const WORKER_V8_SEMI_SPACE_MIB = 64;
const WORKER_CPU_SECONDS = 180;
const WORKER_TIMEOUT_MS = 180_000;
const CACHE_IDLE_MS = 35_000;
const LARGE_REPOSITORIES = 9;
const STRESS_REPOSITORIES = 2;
const C30_COHORT_TIMEOUT_MS = 6 * 60_000;
const C31_COHORT_TIMEOUT_MS = 12 * 60_000;
const GIT_COMMAND_TIMEOUT_MS = 30_000;
const GIT_COMMAND_CPU_SECONDS = 30;
let cohortDeadlineMs = null;
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Synthetic Core64 Memory Probe',
  GIT_AUTHOR_EMAIL: 'core64-memory@example.invalid',
  GIT_COMMITTER_NAME: 'Synthetic Core64 Memory Probe',
  GIT_COMMITTER_EMAIL: 'core64-memory@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};
delete GIT_ENV.SCRIPTORIUM_GITHUB_TOKEN;
for (const name of ['GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) {
  delete GIT_ENV[name];
}
GIT_ENV.GIT_TERMINAL_PROMPT = '0';

function git(cwd, args, input) {
  const remainingMs = cohortDeadlineMs === null ? GIT_COMMAND_TIMEOUT_MS : cohortDeadlineMs - Date.now();
  if (remainingMs <= 0) throw new Error('Memory probe cohort wall-time budget expired');
  const result = execFileSync('prlimit', [
    `--as=${WORKER_ADDRESS_SPACE_BYTES}`,
    `--cpu=${GIT_COMMAND_CPU_SECONDS}`,
    '--', 'git', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args,
  ], {
    cwd,
    env: GIT_ENV,
    input,
    encoding: 'buffer',
    maxBuffer: 4 * MiB,
    timeout: Math.min(GIT_COMMAND_TIMEOUT_MS, remainingMs),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return result;
}

function gitText(cwd, args, input) {
  return git(cwd, args, input).toString('utf8').trim();
}

function gitTree(cwd, entries) {
  return gitText(cwd, ['mktree', '-z'], Buffer.concat(entries)).trim();
}

function treeEntry(mode, type, oid, name) {
  return Buffer.from(`${mode} ${type} ${oid}\t${name}\0`, 'utf8');
}

function deterministicBlob(size) {
  const bytes = Buffer.alloc(size, 0x41);
  let nulBytes = 0;
  for (let offset = 0; offset < bytes.length; offset += 257) {
    bytes[offset] = 0;
    nulBytes += 1;
  }
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    nulBytes,
  };
}

async function prepareBlobFixture(g0Root, fixtureRoot) {
  const source = join(g0Root, 'small', 'origin.git');
  await stat(source);
  const remote = join(fixtureRoot, 'blob-boundary.git');
  const working = join(fixtureRoot, 'blob-boundary-work');
  await mkdir(fixtureRoot, { recursive: true });
  git(undefined, ['clone', '--bare', '--shared', source, remote]);
  git(undefined, ['clone', remote, working]);

  const exactSize = MAX_BUFFER;
  const batchHeaderBytes = 40 + Buffer.byteLength(' blob ') + String(MAX_BUFFER - 56).length + 1;
  const batchExactSize = MAX_BUFFER - batchHeaderBytes - 1;
  const cases = [
    { key: 'blobExact', path: 'attachments/blob-exact-32mib.bin', size: exactSize },
    { key: 'blobPlusOne', path: 'attachments/blob-plus-one.bin', size: exactSize + 1 },
    { key: 'batchExact', path: 'attachments/batch-response-exact.bin', size: batchExactSize },
    { key: 'batchPlusOne', path: 'attachments/batch-response-plus-one.bin', size: batchExactSize + 1 },
  ];
  const manifest = { schemaVersion: 1, syntheticOnly: true, source: resolve(source), cases: {} };
  for (const item of cases) {
    const generated = deterministicBlob(item.size);
    const file = join(working, item.path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, generated.bytes);
    const gitObject = gitText(working, ['hash-object', file]);
    if (gitObject.length !== 40) throw new Error(`Expected a SHA-1 Git object for ${item.key}`);
    manifest.cases[item.key] = {
      path: item.path,
      bytes: item.size,
      sha256: generated.sha256,
      nulBytes: generated.nulBytes,
      gitObject,
    };
  }
  git(working, ['add', '--', 'attachments']);
  git(working, ['commit', '--quiet', '-m', 'Synthetic Core64 output boundary']);
  git(working, ['push', '--quiet', 'origin', 'main']);
  manifest.remote = remote;
  manifest.batchResponseTargetBytes = MAX_BUFFER;
  manifest.batchResponseExpectedBytes = {
    exact: batchHeaderBytes + batchExactSize + 1,
    plusOne: batchHeaderBytes + batchExactSize + 2,
  };
  await writeFile(join(fixtureRoot, 'blob-boundary.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function treeOutputCase(extraBytes) {
  const targetBytes = MAX_BUFFER;
  const bucketPrefix = 'bucket-0000';
  const middleA = 'a'.repeat(90);
  const middleB = 'b'.repeat(90);
  const firstLeaf = `entry-${'0'.repeat(12)}.bin`;
  const pathBytes = Buffer.byteLength(`${bucketPrefix}/${middleA}/${middleB}/${firstLeaf}`);
  const bytesPerEntry = 54 + pathBytes;
  const count = Math.floor(targetBytes / bytesPerEntry);
  const remainder = targetBytes % bytesPerEntry;
  return { targetBytes, bucketPrefix, middleA, middleB, firstLeaf, pathBytes, bytesPerEntry,
    count, exactExtraBytes: remainder, plusOneExtraBytes: remainder + 1 + extraBytes };
}

async function buildTreeCommit(scratch, blobId, config, extraBytes) {
  const entriesPerBucket = 2048;
  const bucketTrees = [];
  for (let first = 0; first < config.count; first += entriesPerBucket) {
    const bucketIndex = Math.floor(first / entriesPerBucket);
    const bucketName = `bucket-${String(bucketIndex).padStart(4, '0')}`;
    const fileEntries = [];
    const end = Math.min(config.count, first + entriesPerBucket);
    for (let index = first; index < end; index += 1) {
      let leaf = `entry-${String(index).padStart(12, '0')}.bin`;
      if (index === config.count - 1) leaf += 'x'.repeat(extraBytes);
      fileEntries.push(treeEntry('100644', 'blob', blobId, leaf));
    }
    const leafTree = gitTree(scratch, fileEntries);
    const middleTree = gitTree(scratch, [treeEntry('040000', 'tree', leafTree, config.middleB)]);
    const bucketTree = gitTree(scratch, [treeEntry('040000', 'tree', middleTree, config.middleA)]);
    bucketTrees.push(treeEntry('040000', 'tree', bucketTree, bucketName));
  }
  const rootTree = gitTree(scratch, bucketTrees);
  return gitText(scratch, ['commit-tree', rootTree, '-m', `Synthetic tree output ${extraBytes}`]);
}

async function prepareTreeFixtures(fixtureRoot) {
  const scratch = join(fixtureRoot, 'tree-output-scratch.git');
  await mkdir(fixtureRoot, { recursive: true });
  git(undefined, ['init', '--quiet', '--bare', '--object-format=sha1', '--initial-branch=main', scratch]);
  const blobId = gitText(scratch, ['hash-object', '-w', '--stdin'], Buffer.from('synthetic tree boundary leaf\n'));
  const config = treeOutputCase(0);
  if (config.firstLeaf.length + config.plusOneExtraBytes > 255) {
    throw new Error('Tree boundary leaf would exceed Git component length');
  }
  const exactCommit = await buildTreeCommit(scratch, blobId, config, config.exactExtraBytes);
  const plusCommit = await buildTreeCommit(scratch, blobId, config, config.plusOneExtraBytes);
  git(scratch, ['update-ref', 'refs/heads/main', plusCommit]);
  const remotes = {};
  for (const [name, commit] of [['exact', exactCommit], ['plusOne', plusCommit]]) {
    const remote = join(fixtureRoot, `tree-${name}.git`);
    git(undefined, ['clone', '--bare', '--shared', scratch, remote]);
    git(remote, ['update-ref', 'refs/heads/main', commit]);
    git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    remotes[name] = remote;
  }
  const manifest = { schemaVersion: 1, syntheticOnly: true, remotes, blobId, ...config,
    expectedOutputBytes: { exact: MAX_BUFFER, plusOne: MAX_BUFFER + 1 } };
  await writeFile(join(fixtureRoot, 'tree-output.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function prepareCacheRemotes(g0Root, fixtureRoot) {
  const settings = [
    { size: 'large', expectedFiles: 10_000, repos: LARGE_REPOSITORIES,
      budgetRationale: 'Nine project-scoped hierarchy entries exceed the fixed eight-entry hierarchyCache count cap; this tier also exercises revisions below the 16,384-entry fileRevisionCache cap.' },
    { size: 'stress', expectedFiles: 100_000, repos: STRESS_REPOSITORIES,
      budgetRationale: 'Each 100k repository exceeds the 16,384-entry fileRevisionCache cap; the second shared-object project measures cross-project reuse after the first project churns the bounded cache.' },
  ];
  const result = [];
  for (const setting of settings) {
    const datasetRoot = join(g0Root, setting.size);
    const manifestPath = join(datasetRoot, 'dataset.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.files !== setting.expectedFiles || manifest.syntheticOnly !== true) {
      throw new Error(`G0 ${setting.size} fixture manifest mismatch: expected ${setting.expectedFiles} synthetic files`);
    }
    const source = join(datasetRoot, 'origin.git');
    await stat(source);
    const remotes = [];
    const alternates = [];
    const remoteDir = join(fixtureRoot, `cache-${setting.size}`);
    await mkdir(remoteDir, { recursive: true });
    for (let index = 0; index < setting.repos; index += 1) {
      const remote = join(remoteDir, `repo-${String(index + 1).padStart(2, '0')}.git`);
      git(undefined, ['clone', '--bare', '--shared', source, remote]);
      const alternateFile = join(remote, 'objects', 'info', 'alternates');
      const alternateObjects = resolve(dirname(alternateFile), (await readFile(alternateFile, 'utf8')).trim());
      if (alternateObjects !== resolve(source, 'objects')) {
        throw new Error(`Shared clone ${remote} does not point to the immutable G0 object store`);
      }
      remotes.push(remote);
      alternates.push({ remote, alternateFile, alternateObjects });
    }
    result.push({ ...setting, source, remotes, alternates, objectStorage: 'bare clones use Git alternates into the immutable G0 object store; no object copy', dataset: manifest });
  }
  return result;
}

async function spawnWorker(mode, args, output, timeoutMs) {
  const remainingMs = cohortDeadlineMs === null ? timeoutMs : cohortDeadlineMs - Date.now();
  if (remainingMs <= 0) throw new Error('Memory probe cohort wall-time budget expired before worker launch');
  const boundedTimeoutMs = Math.min(timeoutMs, remainingMs);
  const workerEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  delete workerEnv.SCRIPTORIUM_GITHUB_TOKEN;
  delete workerEnv.NODE_OPTIONS;
  for (const name of ['GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) {
    delete workerEnv[name];
  }
  workerEnv.GIT_TERMINAL_PROMPT = '0';
  const child = spawn('prlimit', [
    `--as=${WORKER_ADDRESS_SPACE_BYTES}`,
    `--cpu=${WORKER_CPU_SECONDS}`,
    '--', process.execPath,
    `--max-old-space-size=${WORKER_V8_OLD_SPACE_MIB}`,
    `--max-semi-space-size=${WORKER_V8_SEMI_SPACE_MIB}`,
    SCRIPT, '--worker', mode, ...args, output,
  ], {
    stdio: 'ignore', detached: process.platform !== 'win32',
    env: workerEnv,
  });
  let timedOut = false;
  let timer;
  const exit = new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  timer = setTimeout(() => {
    timedOut = true;
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch { /* The process may have exited on the deadline. */ }
    setTimeout(() => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* The process may already be gone. */ }
    }, 5_000).unref();
  }, boundedTimeoutMs);
  timer.unref();
  let exited;
  try { exited = await exit; }
  catch (error) { exited = { code: null, signal: null, error: String(error) }; }
  clearTimeout(timer);
  let report = null;
  try { report = JSON.parse(await readFile(output, 'utf8')); } catch { /* Preserve absent/partial evidence below. */ }
  return { mode, output, timeoutMs: boundedTimeoutMs, timedOut, ...exited, report };
}

async function orchestrate(argv) {
  if (argv[0] !== '--run' || argv.length !== 11 || argv[3] !== '--phase' ||
      argv[5] !== '--runtime-root' || argv[7] !== '--runtime-revision' || argv[9] !== '--core-index-sha256') {
    throw new Error('Usage: node scripts/performance/core64-memory.mjs --run <g0-synthetic-root> <new-output-root> --phase <c30|c31> --runtime-root <accepted-core-worktree> --runtime-revision <accepted-git-revision> --core-index-sha256 <accepted-dist-hash>');
  }
  if (!['c30', 'c31'].includes(argv[4])) throw new Error(`Unknown memory probe phase: ${argv[4]}`);
  const phase = argv[4];
  const g0Root = resolve(argv[1]);
  const outputRoot = resolve(argv[2]);
  const runtimeRoot = resolve(argv[6]);
  const expectedRuntimeRevision = argv[8];
  const expectedCoreModuleSha256 = argv[10];
  if (process.platform !== 'linux') throw new Error('The bounded memory probe requires Linux RLIMIT_AS and /proc/self/io');
  execFileSync('prlimit', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 });
  if (expectedRuntimeRevision !== ACCEPTED_RUNTIME_REVISION) {
    throw new Error(`Runtime revision must be the accepted Core source ${ACCEPTED_RUNTIME_REVISION}`);
  }
  if (expectedCoreModuleSha256 !== ACCEPTED_CORE_MODULE_SHA256) {
    throw new Error(`Compiled Core entry hash must match the accepted artifact ${ACCEPTED_CORE_MODULE_SHA256}`);
  }
  const coreSource = join(runtimeRoot, 'packages', 'core', 'src', 'index.ts');
  const coreModule = join(runtimeRoot, 'packages', 'core', 'dist', 'index.js');
  const timeoutMs = WORKER_TIMEOUT_MS;
  const cohortTimeoutMs = phase === 'c30' ? C30_COHORT_TIMEOUT_MS : C31_COHORT_TIMEOUT_MS;
  const workerCount = phase === 'c30' ? 8 : 2;
  const runtimeRevision = gitText(runtimeRoot, ['rev-parse', 'HEAD']);
  if (runtimeRevision !== expectedRuntimeRevision) {
    throw new Error(`Runtime checkout revision mismatch: expected ${expectedRuntimeRevision}, got ${runtimeRevision}`);
  }
  const dirtyCoreSource = gitText(runtimeRoot, ['status', '--porcelain', '--', 'packages/core/src/index.ts']);
  if (dirtyCoreSource) throw new Error(`Accepted Core source must be clean at the pinned runtime: ${dirtyCoreSource}`);
  const coreSourceBytes = await readFile(coreSource);
  const coreModuleBytes = await readFile(coreModule);
  const coreModuleSha256 = createHash('sha256').update(coreModuleBytes).digest('hex');
  if (coreModuleSha256 !== expectedCoreModuleSha256) {
    throw new Error(`Compiled Core entry hash mismatch: expected ${expectedCoreModuleSha256}, got ${coreModuleSha256}`);
  }
  await stat(join(g0Root, 'results', 'environment.json'));
  if (phase === 'c30') await stat(join(g0Root, 'small', 'origin.git'));
  const requiredDatasets = phase === 'c31' ? [['large', 10_000], ['stress', 100_000]] : [];
  for (const [size, expectedFiles] of requiredDatasets) {
    const datasetRoot = join(g0Root, size);
    const dataset = JSON.parse(await readFile(join(datasetRoot, 'dataset.json'), 'utf8'));
    if (dataset.files !== expectedFiles || dataset.syntheticOnly !== true) {
      throw new Error(`G0 ${size} fixture is not ready: expected ${expectedFiles} synthetic files`);
    }
    await stat(join(datasetRoot, 'origin.git'));
  }
  const cohortStartedAtMs = Date.now();
  cohortDeadlineMs = cohortStartedAtMs + cohortTimeoutMs;
  await mkdir(dirname(outputRoot), { recursive: true });
  await mkdir(outputRoot, { recursive: false });
  const fixtureRoot = join(outputRoot, 'fixtures');
  const dataRoot = join(outputRoot, 'worker-data');
  const rawRoot = join(outputRoot, 'raw');
  await Promise.all([mkdir(fixtureRoot), mkdir(dataRoot), mkdir(rawRoot)]);
  const manifest = {
    schemaVersion: 1,
    phase,
    status: 'running',
    startedAt: new Date().toISOString(),
    g0Root,
    g0SourceRevision: JSON.parse(await readFile(join(g0Root, 'results', 'environment.json'), 'utf8')).source,
    runtime: {
      root: runtimeRoot,
      revision: runtimeRevision,
      coreSource,
      coreSourceSha256: createHash('sha256').update(coreSourceBytes).digest('hex'),
      coreModule,
      coreModuleSha256,
    },
    coreModule,
    coreModuleSha256,
    host: { node: process.version, platform: process.platform, arch: process.arch },
    rules: {
      onlySyntheticData: true,
      maxBufferBytes: MAX_BUFFER,
      processMemory: 'Node process RSS endpoints, sampled operation peak, and process-lifetime high-water mark; Git child RSS is not added',
      cacheBytes: 'Explicit Core byte counters plus labeled shallow payload estimates; never equated with process RSS',
      timeoutMs,
      cohortCaps: {
        workerCount,
        perWorkerAddressSpaceBytes: WORKER_ADDRESS_SPACE_BYTES,
        perWorkerV8OldSpaceMiB: WORKER_V8_OLD_SPACE_MIB,
        perWorkerV8SemiSpaceMiB: WORKER_V8_SEMI_SPACE_MIB,
        perWorkerCpuSeconds: WORKER_CPU_SECONDS,
        perWorkerWallTimeoutMs: timeoutMs,
        cohortWallTimeoutMs: cohortTimeoutMs,
        gitCommandTimeoutMs: GIT_COMMAND_TIMEOUT_MS,
        gitCommandAddressSpaceBytes: WORKER_ADDRESS_SPACE_BYTES,
        gitCommandCpuSeconds: GIT_COMMAND_CPU_SECONDS,
        cacheIdleMs: phase === 'c31' ? CACHE_IDLE_MS : null,
        largeRepositoryCount: phase === 'c31' ? LARGE_REPOSITORIES : null,
        stressRepositoryCount: phase === 'c31' ? STRESS_REPOSITORIES : null,
        cacheRepositoryTotal: phase === 'c31' ? LARGE_REPOSITORIES + STRESS_REPOSITORIES : null,
        note: 'Each worker and its Git subprocesses inherit per-process RLIMIT_AS/CPU limits; this is not an aggregate cgroup memory cap.',
      },
    },
    workers: [],
  };
  await saveRaw(join(outputRoot, 'manifest.json'), manifest);
  try {
    const cases = [];
    if (phase === 'c30') {
      const blob = await prepareBlobFixture(g0Root, fixtureRoot);
      const tree = await prepareTreeFixtures(fixtureRoot);
      manifest.fixtures = { blob: join(fixtureRoot, 'blob-boundary.json'), tree: join(fixtureRoot, 'tree-output.json') };
      await saveRaw(join(outputRoot, 'manifest.json'), manifest);
      for (const [key, method, expectedOutcome] of [
        ['blobExact', 'read', 'success'], ['blobPlusOne', 'read', 'error'],
        ['blobExact', 'revision', 'success'], ['blobPlusOne', 'revision', 'error'],
      ]) {
        const item = blob.cases[key];
        const output = join(rawRoot, `${method}-${key}.json`);
        cases.push(await spawnWorker('boundary', [coreModule, join(dataRoot, `boundary-${method}-${key}`), blob.remote,
          method, item.path, String(item.bytes), item.sha256, String(item.nulBytes), expectedOutcome], output, timeoutMs));
        manifest.workers = cases;
        await saveRaw(join(outputRoot, 'manifest.json'), manifest);
      }
      for (const name of ['exact', 'plusOne']) {
        const output = join(rawRoot, `tree-${name}.json`);
        const expected = name === 'exact' ? 'success' : 'error';
        cases.push(await spawnWorker('tree', [coreModule, join(dataRoot, `tree-${name}`), tree.remotes[name], expected], output, timeoutMs));
        manifest.workers = cases;
        await saveRaw(join(outputRoot, 'manifest.json'), manifest);
      }
      for (const name of ['batchExact', 'batchPlusOne']) {
        const item = blob.cases[name];
        const expected = name === 'batchExact' ? 'success' : 'error';
        const output = join(rawRoot, `batch-${name}.json`);
        cases.push(await spawnWorker('batch', [blob.remote, item.gitObject, String(MAX_BUFFER), expected], output, timeoutMs));
        manifest.workers = cases;
        await saveRaw(join(outputRoot, 'manifest.json'), manifest);
      }
    } else {
      const cache = await prepareCacheRemotes(g0Root, fixtureRoot);
      manifest.fixtures = {
        cache: cache.map(({ size, expectedFiles, repos, remotes, source, alternates, objectStorage, budgetRationale }) =>
          ({ size, expectedFiles, repos, source, sourceObjects: resolve(source, 'objects'), remotes, alternates, objectStorage, budgetRationale })),
      };
      await saveRaw(join(outputRoot, 'manifest.json'), manifest);
      for (const setting of cache) {
        const output = join(rawRoot, `cache-${setting.size}.json`);
        cases.push(await spawnWorker('cache', [coreModule, join(dataRoot, `cache-${setting.size}`),
          JSON.stringify(setting.remotes), String(CACHE_IDLE_MS)], output, timeoutMs));
        manifest.workers = cases;
        await saveRaw(join(outputRoot, 'manifest.json'), manifest);
      }
    }
    if (Date.now() > cohortDeadlineMs) throw new Error('Memory probe phase exceeded its wall-time budget');
    manifest.status = cases.every((entry) => entry.code === 0 && !entry.timedOut && entry.report?.status === 'complete')
      ? 'complete' : 'partial';
    manifest.conclusionStatus = manifest.status === 'complete' ? 'PENDING_REVIEW' : 'NOT_CHECKED';
    if (manifest.status !== 'complete') {
      const incomplete = cases.filter((entry) => entry.code !== 0 || entry.timedOut || entry.report?.status !== 'complete');
      manifest.notCheckedReason = 'At least one task worker failed, timed out, hit a resource cap, or was ended at the phase deadline.';
      manifest.notCheckedWorkers = incomplete.map((entry) => ({ mode: entry.mode, output: entry.output, timeoutMs: entry.timeoutMs,
        timedOut: entry.timedOut, code: entry.code, signal: entry.signal, error: entry.error ?? null,
        reportStatus: entry.report?.status ?? null, reportFailure: entry.report?.failure ?? entry.report?.sample?.error ?? null }));
    }
    manifest.finishedAt = new Date().toISOString();
    manifest.cohortElapsedMs = Date.now() - cohortStartedAtMs;
    await saveRaw(join(outputRoot, 'manifest.json'), manifest);
    process.exitCode = manifest.status === 'complete' ? 0 : 1;
  } catch (error) {
    manifest.status = 'failed';
    manifest.conclusionStatus = 'NOT_CHECKED';
    manifest.notCheckedReason = 'The phase failed during fixture preparation or exceeded its cohort budget.';
    manifest.failure = { name: error?.name, code: error?.code ?? null, signal: error?.signal ?? null,
      message: String(error?.message ?? error) };
    manifest.finishedAt = new Date().toISOString();
    manifest.cohortElapsedMs = Date.now() - cohortStartedAtMs;
    await saveRaw(join(outputRoot, 'manifest.json'), manifest);
    throw error;
  }
}

async function saveRaw(file, data) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`);
  await rename(temporary, file);
}

function byteLength(value) {
  return Buffer.isBuffer(value) ? value.length : Buffer.byteLength(value ?? '');
}

const outputGroups = new Map();
function commandGroup(args) {
  if (args.includes('ls-tree')) return 'treeList';
  if (args.includes('cat-file') && args.includes('--batch-check=%(objectname) %(objecttype) %(objectsize)')) return 'batchCheck';
  if (args.includes('cat-file') && args.includes('--batch')) return 'batchContent';
  if (args.includes('cat-file') && args.includes('blob')) return 'blobRead';
  return 'otherGit';
}

function recordGitOutput(args, error, stdout, stderr) {
  const name = commandGroup(args);
  const current = outputGroups.get(name) ?? { calls: 0, failures: 0, stdoutBytes: 0, stderrBytes: 0, maxStdoutBytes: 0, lastStdoutBytes: 0, lastErrorCode: null, lastErrorMessage: null };
  const outputBytes = byteLength(stdout);
  current.calls += 1;
  current.failures += error ? 1 : 0;
  current.stdoutBytes += outputBytes;
  current.stderrBytes += byteLength(stderr);
  current.maxStdoutBytes = Math.max(current.maxStdoutBytes, outputBytes);
  current.lastStdoutBytes = outputBytes;
  current.lastErrorCode = error?.code ?? null;
  current.lastErrorMessage = error ? String(error.message).slice(0, 500) : null;
  outputGroups.set(name, current);
}

function outputSnapshot() {
  return Object.fromEntries([...outputGroups.entries()].map(([key, value]) => [key, { ...value }]));
}

function outputDelta(before, after) {
  const result = {};
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const prior = before[name] ?? {};
    const current = after[name] ?? {};
    result[name] = {
      calls: (current.calls ?? 0) - (prior.calls ?? 0),
      failures: (current.failures ?? 0) - (prior.failures ?? 0),
      stdoutBytes: (current.stdoutBytes ?? 0) - (prior.stdoutBytes ?? 0),
      stderrBytes: (current.stderrBytes ?? 0) - (prior.stderrBytes ?? 0),
      maxStdoutBytes: current.calls === prior.calls ? 0 : current.maxStdoutBytes,
      lastStdoutBytes: current.calls === prior.calls ? 0 : current.lastStdoutBytes,
      lastErrorCode: current.calls === prior.calls ? null : current.lastErrorCode,
      lastErrorMessage: current.calls === prior.calls ? null : current.lastErrorMessage,
    };
  }
  return result;
}

let instrumentedCounters;
let commonHelpers;
function installGitOutputProbe(childProcess) {
  const original = childProcess.execFile;
  const customPromisify = original[Symbol.for('nodejs.util.promisify.custom')];
  childProcess.execFile = function(file, args, ...rest) {
    const callbackIndex = rest.length - 1;
    const callback = rest[callbackIndex];
    if (file !== 'git' || typeof callback !== 'function') return Reflect.apply(original, this, [file, args, ...rest]);
    const wrapped = function(error, stdout, stderr) {
      recordGitOutput(Array.isArray(args) ? args.map(String) : [], error, stdout, stderr);
      return Reflect.apply(callback, this, [error, stdout, stderr]);
    };
    return Reflect.apply(original, this, [...rest.slice(0, callbackIndex), wrapped]);
  };
  if (customPromisify) childProcess.execFile[Symbol.for('nodejs.util.promisify.custom')] = customPromisify;
  syncBuiltinESMExports();
}

function rssHighWaterBytes() {
  const value = process.resourceUsage().maxRSS;
  return process.platform === 'darwin' ? value : value * 1024;
}

function safeError(error) {
  return {
    name: error?.name ?? 'Error',
    code: error?.code ?? null,
    signal: error?.signal ?? null,
    killed: error?.killed ?? false,
    message: String(error?.message ?? error).slice(0, 2000),
    partialOutputBytes: error?.partialOutputBytes ?? null,
  };
}

async function measured(name, action) {
  const beforeRssBytes = process.memoryUsage().rss;
  const beforePeakRssBytes = rssHighWaterBytes();
  outputGroups.clear();
  const beforeOutputs = {};
  const beforeCounts = { ...instrumentedCounters };
  let sampledPeakRssBytes = beforeRssBytes;
  let rssSamples = 0;
  const sampleTimer = setInterval(() => {
    sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage().rss);
    rssSamples += 1;
  }, 20);
  sampleTimer.unref();
  const start = performance.now();
  let result;
  let failure;
  let sample = null;
  try {
    const measuredResult = await commonHelpers.measure(name, action, () => ({ ...instrumentedCounters }));
    result = measuredResult.value;
    sample = measuredResult.sample;
  } catch (error) {
    failure = error;
  } finally {
    clearInterval(sampleTimer);
  }
  const afterRssBytes = process.memoryUsage().rss;
  const lifetimePeakRssBytes = rssHighWaterBytes();
  const deltaCounters = Object.fromEntries(Object.keys(instrumentedCounters).map((key) => [key,
    instrumentedCounters[key] - (beforeCounts[key] ?? 0)]));
  const output = outputSnapshot();
  return {
    name,
    status: failure ? 'error' : 'success',
    ms: sample?.ms ?? Number((performance.now() - start).toFixed(3)),
    cpuUs: sample?.cpuUs ?? null,
    io: sample?.io ?? null,
    rssBeforeBytes: beforeRssBytes,
    rssAfterBytes: afterRssBytes,
    rssBytes: sample?.rssBytes ?? afterRssBytes,
    sampledPeakRssBytes,
    sampledRssSamples: rssSamples,
    processPeakRssBeforeBytes: beforePeakRssBytes,
    processPeakRssAfterBytes: lifetimePeakRssBytes,
    maxRssKiB: sample?.maxRssKiB ?? null,
    instrumentationCounters: deltaCounters,
    gitOutputs: outputDelta(beforeOutputs, output),
    ...(failure ? { error: safeError(failure), partialOutputReturnedToCore: false } : { value: result }),
  };
}

function shallowMapBytes(map, estimateValue) {
  let bytes = 0;
  for (const [key, value] of map) {
    bytes += Buffer.byteLength(String(key), 'utf8') + estimateValue(value) + 64;
  }
  return bytes;
}

function boundedJsonBytes(root, maxBytes = 64 * MiB, maxNodes = 500_000) {
  const stack = [root];
  let bytes = 0;
  let nodes = 0;
  while (stack.length && bytes < maxBytes && nodes < maxNodes) {
    const value = stack.pop();
    nodes += 1;
    if (typeof value === 'string') bytes += Buffer.byteLength(value, 'utf8') + 2;
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) bytes += 16;
    else if (Array.isArray(value)) {
      bytes += 2;
      for (const item of value) stack.push(item);
    } else if (value && typeof value === 'object') {
      bytes += 2;
      for (const [key, child] of Object.entries(value)) {
        bytes += Buffer.byteLength(key, 'utf8') + 3;
        stack.push(child);
        if (bytes >= maxBytes || nodes >= maxNodes) break;
      }
    }
  }
  return { bytes: Math.min(bytes, maxBytes), complete: stack.length === 0 && nodes < maxNodes, nodes };
}

function cacheSnapshot(store) {
  const anyStore = store;
  const maps = {
    fileRevisionCache: anyStore.fileRevisionCache,
    hierarchyCache: anyStore.hierarchyCache,
    historicalMetadataCache: anyStore.historicalMetadataCache,
    reconciliationCache: anyStore.reconciliationCache,
  };
  const available = Object.values(maps).every((map) => map instanceof Map);
  if (!available) return { probe: 'unavailable', derivedCaches: null };
  const revisionBytes = shallowMapBytes(maps.fileRevisionCache, (value) => Buffer.byteLength(String(value), 'utf8'));
  const reconciliationEntries = [...maps.reconciliationCache.entries()].map(([key, value]) => ({
    keyBytes: Buffer.byteLength(key, 'utf8'),
    ...boundedJsonBytes(value?.result),
  }));
  const reconciliationBytes = reconciliationEntries.reduce((sum, entry) => sum + entry.keyBytes + entry.bytes + 64, 0);
  return {
    probe: 'runtime-private-fields-accessible',
    derivedCaches: {
      fileRevision: { entries: maps.fileRevisionCache.size, shallowPayloadEstimateBytes: revisionBytes, model: 'UTF-8 key/value bytes + 64 bytes per Map entry; excludes V8 overhead' },
      hierarchy: { entries: maps.hierarchyCache.size, explicitBytes: Number(anyStore.hierarchyCacheBytes) || 0,
        entryBytes: [...maps.hierarchyCache.entries()].map(([key, value]) => ({ keyBytes: Buffer.byteLength(key, 'utf8'), explicitBytes: value.bytes })) },
      historicalMetadata: { entries: maps.historicalMetadataCache.size, explicitBytes: Number(anyStore.historicalMetadataCacheBytes) || 0,
        entryBytes: [...maps.historicalMetadataCache.entries()].map(([key, value]) => ({ keyBytes: Buffer.byteLength(key, 'utf8'), explicitBytes: value.bytes })) },
      reconciliation: { entries: maps.reconciliationCache.size, boundedJsonPayloadEstimateBytes: reconciliationBytes,
        entryBytes: reconciliationEntries },
      estimatedOrAccountedTotalBytes: revisionBytes + (Number(anyStore.hierarchyCacheBytes) || 0) +
        (Number(anyStore.historicalMetadataCacheBytes) || 0) + reconciliationBytes,
      totalSemantics: 'Mixed explicit Core estimates and labeled shallow payload estimates; not retained heap or process RSS',
    },
    authorityState: {
      readObservations: anyStore.readObservations?.size ?? null,
      observationRefKeys: anyStore.observationRefKeys?.size ?? null,
      proposalsByProject: anyStore.proposals?.size ?? null,
      durableProposalIdsByProject: anyStore.durableProposalIds?.size ?? null,
      approvalsByProject: anyStore.approvals?.size ?? null,
      writerQueues: anyStore.queueTails?.size ?? null,
      semantics: 'Lifecycle and authority state; excluded from reconstructible-cache byte totals and any eviction recommendation',
    },
  };
}

function installCacheProbes(store) {
  const counters = {
    fileRevision: { hits: 0, evictionCandidates: 0 },
    hierarchy: { hits: 0, evictions: 0, oversizeNotRetained: 0 },
    historicalMetadata: { hits: 0, evictions: 0, oversizeNotRetained: 0 },
  };
  const revisionMap = store.fileRevisionCache;
  if (revisionMap instanceof Map) {
    const originalGet = revisionMap.get.bind(revisionMap);
    revisionMap.get = (key) => { const value = originalGet(key); if (value !== undefined) counters.fileRevision.hits += 1; return value; };
    const originalCache = store.cacheFileRevision;
    if (typeof originalCache === 'function') {
      store.cacheFileRevision = function(blobId, revision) {
        if (!this.fileRevisionCache.has(blobId) && this.fileRevisionCache.size >= 16_384) counters.fileRevision.evictionCandidates += 1;
        return Reflect.apply(originalCache, this, [blobId, revision]);
      };
    }
  }
  const originalHierarchy = store.hierarchySnapshot;
  if (typeof originalHierarchy === 'function' && store.hierarchyCache instanceof Map) {
    store.hierarchySnapshot = async function(root, commit, repositoryUrl) {
      const key = `${resolve(root)}\0${commit}`;
      const wasHit = this.hierarchyCache.has(key);
      if (wasHit) counters.hierarchy.hits += 1;
      const before = this.hierarchyCache.size;
      const result = await Reflect.apply(originalHierarchy, this, [root, commit, repositoryUrl]);
      if (!wasHit) {
        if (this.hierarchyCache.has(key)) counters.hierarchy.evictions += Math.max(0, before + 1 - this.hierarchyCache.size);
        else counters.hierarchy.oversizeNotRetained += 1;
      }
      return result;
    };
  }
  const originalHistorical = store.cacheHistoricalMetadata;
  if (typeof originalHistorical === 'function' && store.historicalMetadataCache instanceof Map) {
    store.cacheHistoricalMetadata = function(key, records) {
      const before = this.historicalMetadataCache.size;
      const exists = this.historicalMetadataCache.has(key);
      const bytes = records.reduce((total, record) => total + Buffer.byteLength(record.content, 'utf8') + record.path.length + record.commit.length + 128, 0);
      const result = Reflect.apply(originalHistorical, this, [key, records]);
      if (!exists) {
        if (this.historicalMetadataCache.has(key)) counters.historicalMetadata.evictions += Math.max(0, before + 1 - this.historicalMetadataCache.size);
        else if (bytes > 64 * MiB) counters.historicalMetadata.oversizeNotRetained += 1;
      }
      return result;
    };
    const originalGet = store.historicalMetadataCache.get.bind(store.historicalMetadataCache);
    store.historicalMetadataCache.get = (key) => { const value = originalGet(key); if (value !== undefined) counters.historicalMetadata.hits += 1; return value; };
  }
  return counters;
}

async function hashBase64InChunks(content, chunkCharacters = 256 * 1024) {
  const hash = createHash('sha256');
  let nulBytes = 0;
  let decodedBytes = 0;
  const chunkSize = Math.floor(chunkCharacters / 4) * 4;
  for (let offset = 0; offset < content.length; offset += chunkSize) {
    const decoded = Buffer.from(content.slice(offset, offset + chunkSize), 'base64');
    hash.update(decoded);
    decodedBytes += decoded.length;
    for (const byte of decoded) if (byte === 0) nulBytes += 1;
  }
  return { sha256: hash.digest('hex'), nulBytes, decodedBytes, base64Characters: content.length };
}

async function loadWorkerRuntime(coreModule) {
  delete process.env.SCRIPTORIUM_GITHUB_TOKEN;
  const instrumentation = await import('./instrument-node.mjs');
  instrumentedCounters = instrumentation.counts;
  commonHelpers = await import('./common.mjs');
  const childProcess = await import('node:child_process');
  installGitOutputProbe(childProcess.default ?? childProcess);
  const core = await import(pathToFileURL(coreModule).href);
  return core.CoreStore;
}

async function workerBoundary(args, output) {
  const [coreModule, dataDir, remote, method, filePath, sizeText, expectedHash, nulText, expectedOutcome] = args;
  const expectedBytes = Number(sizeText);
  const expectedNuls = Number(nulText);
  const CoreStore = await loadWorkerRuntime(coreModule);
  const store = new CoreStore({ dataDir, allowLocalRemotes: true });
  const project = await store.registerProject({ url: remote });
  const reader = await store.reader(project.id);
  const report = { schemaVersion: 1, status: 'running', mode: 'boundary', method, filePath, expectedBytes,
    expectedSha256: expectedHash, expectedNulBytes: expectedNuls, expectedOutcome, source: 'synthetic-only', samples: [] };
  await saveRaw(output, report);
  const sample = await measured(`${method}.${expectedBytes}`, async () => {
    if (method === 'read') {
      const result = await reader.read(filePath, 'base64');
      if (!result) throw new Error('Snapshot blob was unexpectedly absent');
      const verified = await hashBase64InChunks(result.content);
      if (verified.decodedBytes !== expectedBytes || verified.sha256 !== expectedHash || verified.nulBytes !== expectedNuls) {
        throw new Error(`Binary read verification mismatch: ${JSON.stringify(verified)}`);
      }
      return { present: true, encoding: 'base64', ...verified };
    }
    if (method === 'revision') {
      const result = await reader.listRevisions(filePath);
      if (result.length !== 1 || result[0]?.path !== filePath || result[0]?.revision !== expectedHash) {
        throw new Error(`Revision verification mismatch: ${JSON.stringify({ count: result.length, first: result[0] })}`);
      }
      return { count: result.length, revision: result[0].revision, matchesExpectedSha256: true };
    }
    throw new Error(`Unknown boundary method: ${method}`);
  });
  sample.expectedOutcome = expectedOutcome;
  if (sample.status === 'error') sample.error = { ...sample.error, maxBufferRelated: /maxBuffer|buffer length/i.test(sample.error.message) };
  const actualGitBytes = sample.gitOutputs?.blobRead?.maxStdoutBytes ?? 0;
  sample.outputBytesMatchExpected = sample.status === 'success' ? actualGitBytes === expectedBytes : null;
  sample.outcomeMatched = sample.status === expectedOutcome && (expectedOutcome === 'success'
    ? sample.outputBytesMatchExpected
    : sample.error?.maxBufferRelated === true && actualGitBytes >= MAX_BUFFER);
  report.samples.push(sample);
  report.cacheAfter = cacheSnapshot(store);
  report.status = sample.outcomeMatched ? 'complete' : 'failed';
  report.finishedAt = new Date().toISOString();
  await saveRaw(output, report);
  if (report.status !== 'complete') process.exitCode = 1;
}

async function workerTree(args, output) {
  const [coreModule, dataDir, remote, expectedOutcome] = args;
  const CoreStore = await loadWorkerRuntime(coreModule);
  const store = new CoreStore({ dataDir, allowLocalRemotes: true });
  const project = await store.registerProject({ url: remote });
  const reader = await store.reader(project.id);
  const sample = await measured('reader.list.all', async () => {
    const files = await reader.list('');
    return { files: files.length, firstPath: files[0] ?? null, lastPath: files.at(-1) ?? null };
  });
  sample.expectedOutcome = expectedOutcome;
  if (sample.status === 'error') sample.error = { ...sample.error, maxBufferRelated: /maxBuffer|buffer length/i.test(sample.error.message) };
  const actualGitBytes = sample.gitOutputs?.treeList?.maxStdoutBytes ?? 0;
  sample.outputBytesMatchExpected = sample.status === 'success' ? actualGitBytes === MAX_BUFFER : null;
  sample.outcomeMatched = sample.status === expectedOutcome && (expectedOutcome === 'success'
    ? sample.outputBytesMatchExpected
    : sample.error?.maxBufferRelated === true && actualGitBytes >= MAX_BUFFER);
  const report = { schemaVersion: 1, status: sample.outcomeMatched ? 'complete' : 'failed', mode: 'tree-output', expectedOutputBytes: MAX_BUFFER + (expectedOutcome === 'error' ? 1 : 0), sample,
    cacheAfter: cacheSnapshot(store), finishedAt: new Date().toISOString() };
  await saveRaw(output, report);
  if (report.status !== 'complete') process.exitCode = 1;
}

async function workerBatch(args, output) {
  const [repository, objectId, expectedBufferText, expectedOutcome] = args;
  const expectedBufferBytes = Number(expectedBufferText);
  await import('./instrument-node.mjs').then((module) => { instrumentedCounters = module.counts; });
  commonHelpers = await import('./common.mjs');
  const childProcessModule = await import('node:child_process');
  const childProcess = childProcessModule.default ?? childProcessModule;
  installGitOutputProbe(childProcess);
  const sample = await measured('git.cat-file.batch.response', async () => new Promise((resolveResult, rejectResult) => {
    const child = childProcess.execFile('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', 'cat-file', '--batch'], {
      cwd: repository, env: GIT_ENV, encoding: 'buffer', maxBuffer: MAX_BUFFER,
    }, (error, stdout) => {
      const partialOutputBytes = byteLength(stdout);
      if (error) {
        error.partialOutputBytes = partialOutputBytes;
        rejectResult(error);
        return;
      }
      resolveResult({ responseBytes: partialOutputBytes });
    });
    child.stdin.end(`${objectId}\n`);
  }));
  sample.expectedOutcome = expectedOutcome;
  const returnedBytes = sample.value?.responseBytes ?? sample.error?.partialOutputBytes;
  sample.returnedBytes = returnedBytes ?? null;
  sample.outputByteCountMatchesTarget = expectedOutcome === 'success' ? returnedBytes === expectedBufferBytes : null;
  sample.expectedResponseBytes = expectedBufferBytes + (expectedOutcome === 'error' ? 1 : 0);
  if (sample.status === 'error') sample.error = { ...sample.error, maxBufferRelated: /maxBuffer|buffer length/i.test(sample.error.message) };
  sample.outcomeMatched = sample.status === expectedOutcome && (expectedOutcome === 'success'
    ? sample.outputByteCountMatchesTarget
    : sample.error?.maxBufferRelated === true && (returnedBytes ?? 0) >= expectedBufferBytes);
  const report = { schemaVersion: 1, status: sample.outcomeMatched ? 'complete' : 'failed', mode: 'batch-output', sample, finishedAt: new Date().toISOString(),
    note: 'Raw cat-file --batch output exercises the same Node maxBuffer boundary. Core revision batches remain bounded to 24 MiB of blob bodies and 4,096 objects; their observed stdout lengths are captured separately during cache workers.' };
  await saveRaw(output, report);
  if (report.status !== 'complete') process.exitCode = 1;
}

async function workerCache(args, output) {
  const [coreModule, dataDir, remoteList, idleText] = args;
  const remotes = JSON.parse(remoteList);
  const idleMs = Number(idleText);
  const CoreStore = await loadWorkerRuntime(coreModule);
  const store = new CoreStore({ dataDir, allowLocalRemotes: true });
  const counters = installCacheProbes(store);
  const report = { schemaVersion: 1, status: 'running', mode: 'cache-pressure', repositoryCount: remotes.length,
    idleMs, memory: { rssBeforeBytes: process.memoryUsage().rss, processPeakRssBeforeBytes: rssHighWaterBytes() }, events: [], cacheCounters: counters,
    interpretation: 'Derived-cache estimates are reported separately from authority state and process RSS.' };
  await saveRaw(output, report);
  const projects = [];
  for (let index = 0; index < remotes.length; index += 1) {
    const project = await store.registerProject({ url: remotes[index] });
    const reader = await store.reader(project.id);
    projects.push({ project, reader });
    report.events.push({ phase: 'registered', repository: index + 1, cache: cacheSnapshot(store), rssBytes: process.memoryUsage().rss });
    await saveRaw(output, report);
  }
  for (let index = 0; index < projects.length; index += 1) {
    const { project, reader } = projects[index];
    for (const [phase, action] of [
      ['revisions', () => reader.listRevisions('')],
      ['tree.cold', () => store.readTreeSnapshot(project.id)],
      ['tree.warm', () => store.readTreeSnapshot(project.id)],
    ]) {
      const sample = await measured(`${phase}.repo-${index + 1}`, action);
      if (phase === 'revisions' && sample.status === 'success') sample.value = { revisions: sample.value.length };
      if (phase.startsWith('tree.') && sample.status === 'success') sample.value = { volumes: sample.value.tree.volumes.length };
      report.events.push({ phase, repository: index + 1, sample, cache: cacheSnapshot(store), rssBytes: process.memoryUsage().rss,
        cacheCounters: structuredClone(counters) });
      await saveRaw(output, report);
      if (sample.status !== 'success') {
        report.status = 'failed';
        report.failure = sample.error;
        report.finishedAt = new Date().toISOString();
        await saveRaw(output, report);
        process.exitCode = 1;
        return;
      }
    }
  }
  const idleBefore = { rssBytes: process.memoryUsage().rss, processPeakRssBytes: rssHighWaterBytes(), cache: cacheSnapshot(store) };
  let idleMinRssBytes = idleBefore.rssBytes;
  let idleMaxRssBytes = idleBefore.rssBytes;
  let idleSamples = 0;
  const sampler = setInterval(() => {
    const rss = process.memoryUsage().rss;
    idleMinRssBytes = Math.min(idleMinRssBytes, rss);
    idleMaxRssBytes = Math.max(idleMaxRssBytes, rss);
    idleSamples += 1;
  }, 100);
  await new Promise((resolveWait) => setTimeout(resolveWait, idleMs));
  clearInterval(sampler);
  report.idle = {
    durationMs: idleMs,
    samples: idleSamples,
    rssBeforeBytes: idleBefore.rssBytes,
    rssAfterBytes: process.memoryUsage().rss,
    rssMinBytes: idleMinRssBytes,
    rssSampledMaxBytes: idleMaxRssBytes,
    processPeakRssBeforeBytes: idleBefore.processPeakRssBytes,
    processPeakRssAfterBytes: rssHighWaterBytes(),
    cacheBefore: idleBefore.cache,
    cacheAfter: cacheSnapshot(store),
    cacheCounters: structuredClone(counters),
    autoEvictionObserved: JSON.stringify(idleBefore.cache.derivedCaches) !== JSON.stringify(cacheSnapshot(store).derivedCaches),
  };
  report.memory.rssAfterBytes = process.memoryUsage().rss;
  report.memory.processPeakRssAfterBytes = rssHighWaterBytes();
  report.finalCache = cacheSnapshot(store);
  report.status = 'complete';
  report.finishedAt = new Date().toISOString();
  await saveRaw(output, report);
}

async function workerMain(argv) {
  const mode = argv[0];
  const output = argv.at(-1);
  const args = argv.slice(1, -1);
  if (!output) throw new Error('Worker output path is required');
  await mkdir(dirname(output), { recursive: true });
  if (mode === 'boundary') return workerBoundary(args, output);
  if (mode === 'tree') return workerTree(args, output);
  if (mode === 'batch') return workerBatch(args, output);
  if (mode === 'cache') return workerCache(args, output);
  throw new Error(`Unknown worker mode: ${mode}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === '--worker') await workerMain(process.argv.slice(3));
    else await orchestrate(process.argv.slice(2));
  } catch (error) {
    if (process.argv[2] === '--worker') {
      const output = process.argv.at(-1);
      if (output) {
        await saveRaw(output, { schemaVersion: 1, status: 'failed', mode: process.argv[3],
          failure: { name: error?.name ?? 'Error', code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 2000) },
          finishedAt: new Date().toISOString() }).catch(() => undefined);
      }
    }
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
