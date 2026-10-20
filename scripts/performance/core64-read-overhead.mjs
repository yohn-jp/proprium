import { counts } from './instrument-node.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { distribution, measure, save } from './common.mjs';
import { git } from './dataset.mjs';

const [datasetPathArg, workRootArg, outputArg, runtimeRootArg, repeatsArg = '20'] = process.argv.slice(2);
if (!datasetPathArg || !workRootArg || !outputArg || !runtimeRootArg) {
  throw new Error('Usage: node scripts/performance/core64-read-overhead.mjs <dataset-dir> <new-work-dir> <new-output.json> <accepted-core-root> [repeats]');
}

const datasetPath = resolve(datasetPathArg);
const workRoot = resolve(workRootArg);
const outputPath = resolve(outputArg);
const runtimeRoot = resolve(runtimeRootArg);
const repeats = Number(repeatsArg);
if (!Number.isSafeInteger(repeats) || repeats < 5 || repeats > 50) {
  throw new Error('Repeats must be an integer from 5 through 50');
}

const expectedCpuAffinity = [4, 5, 6, 7];
const affinityStatus = await readFile('/proc/self/status', 'utf8');
const affinityLine = affinityStatus.match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1];
if (!affinityLine) throw new Error('Cannot verify Linux Cpus_allowed_list for the requested affinity');
const effectiveCpuAffinity = affinityLine.split(',').flatMap((range) => {
  const [first, last = first] = range.split('-').map(Number);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first) {
    throw new Error(`Invalid Linux Cpus_allowed_list: ${affinityLine}`);
  }
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
});
if (effectiveCpuAffinity.join(',') !== expectedCpuAffinity.join(',')) {
  throw new Error(`Expected CPU affinity 4-7, got ${affinityLine}; invoke under taskset -c 4-7`);
}

const acceptedRuntimeCommit = 'f633da0b3f133ad812953c284aab35a4956d2507';
const acceptedRuntimeIndexSha256 = 'a7b83895e2c239d85a3f4d973cf7458e64cc7415c418a4844ff33f700a52d4a3';
const runtimeIndexPath = join(runtimeRoot, 'packages/core/dist/index.js');
const runtimeIndexSha256 = createHash('sha256').update(await readFile(runtimeIndexPath)).digest('hex');
const runtimeCommit = git(runtimeRoot, 'rev-parse', 'HEAD');
if (runtimeCommit !== acceptedRuntimeCommit || runtimeIndexSha256 !== acceptedRuntimeIndexSha256) {
  throw new Error(`Accepted Core runtime mismatch: commit=${runtimeCommit} indexSha256=${runtimeIndexSha256}`);
}

const dataset = JSON.parse(await readFile(join(datasetPath, 'dataset.json'), 'utf8'));
if (dataset.syntheticOnly !== true || !dataset.remote || !dataset.commit) {
  throw new Error('The dataset manifest must identify a canonical synthetic fixture');
}
await mkdir(workRoot);
await mkdir(dirname(outputPath), { recursive: true });
try {
  await stat(outputPath);
  throw new Error(`Refusing to overwrite existing output: ${outputPath}`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const asyncContext = new AsyncLocalStorage();
const gitCommands = new Set([
  'add', 'branch', 'cat-file', 'checkout', 'clone', 'commit', 'config', 'fetch',
  'for-each-ref', 'ls-remote', 'ls-tree', 'merge-base', 'push', 'reset', 'rev-list',
  'rev-parse', 'show-ref', 'status', 'symbolic-ref', 'update-index', 'update-ref',
]);
const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
const instrumentedExecFile = childProcess.execFile;
const instrumentedExecFilePromise = instrumentedExecFile[promisifyCustom];

function gitCommandName(args) {
  if (!Array.isArray(args)) return 'unknown';
  return args.find((arg) => gitCommands.has(arg)) ?? 'other';
}

function gitCommandRecord(args) {
  const command = gitCommandName(args);
  const commandIndex = Array.isArray(args) ? args.indexOf(command) : -1;
  const ref = command === 'rev-parse' && args[commandIndex + 1] === '--verify'
    ? args[commandIndex + 2] ?? null
    : null;
  return { command, ...(ref ? { ref } : {}) };
}

// Preserve the existing process/read counters and add request-local Git child
// wall time and command attribution for this one bounded probe.
childProcess.execFile = function(file, args, ...rest) {
  const context = asyncContext.getStore();
  if (file !== 'git' || !context) {
    return Reflect.apply(instrumentedExecFile, this, [file, args, ...rest]);
  }
  context.gitCommands.push(gitCommandRecord(args));
  const callbackIndex = rest.findLastIndex((argument) => typeof argument === 'function');
  if (callbackIndex >= 0) {
    const startedAt = performance.now();
    const callback = rest[callbackIndex];
    rest[callbackIndex] = function(...callbackArgs) {
      context.gitWallMs += performance.now() - startedAt;
      return Reflect.apply(callback, this, callbackArgs);
    };
  }
  return Reflect.apply(instrumentedExecFile, this, [file, args, ...rest]);
};
childProcess.execFile[promisifyCustom] = instrumentedExecFilePromise;
syncBuiltinESMExports();

const { CoreStore } = await import(pathToFileURL(runtimeIndexPath));

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolveValue) => { resolvePromise = resolveValue; });
  return { promise, resolve: resolvePromise };
}

function newMetrics(registryBytesPerRead = 0) {
  return {
    gitWallMs: 0,
    gitCommands: [],
    lockWaitMs: 0,
    lockActionMs: 0,
    lockCalls: 0,
    lockKeys: [],
    lockQueued: deferred(),
    registryReads: 0,
    registryBytes: 0,
    registryBytesPerRead,
  };
}

function instrumentStore(store) {
  const originalWithLock = store.withLock.bind(store);
  store.withLock = function(key, action) {
    const context = asyncContext.getStore();
    const requestedAt = performance.now();
    if (context) {
      context.lockCalls++;
      context.lockKeys.push(key === 'registry' ? 'registry' : 'project');
      context.lockQueued.resolve();
    }
    return originalWithLock(key, async () => {
      const enteredAt = performance.now();
      if (!context) return action();
      context.lockWaitMs += enteredAt - requestedAt;
      try { return await action(); }
      finally { context.lockActionMs += performance.now() - enteredAt; }
    });
  };

  const originalReadRegistry = store.readRegistry.bind(store);
  store.readRegistry = async function(...args) {
    const context = asyncContext.getStore();
    if (context) {
      context.registryReads++;
      context.registryBytes += context.registryBytesPerRead;
    }
    return originalReadRegistry(...args);
  };
  return store;
}

function startMeasurement(name, store, action, registryBytesPerRead = 0) {
  const context = newMetrics(registryBytesPerRead);
  const promise = asyncContext.run(context, async () => {
    const measured = await measure(name, action, () => ({ ...counts }));
    return {
      value: measured.value,
      row: {
        ...measured.sample,
        gitWallMs: context.gitWallMs,
        gitCommands: context.gitCommands,
        lockWaitMs: context.lockWaitMs,
        lockActionMs: context.lockActionMs,
        lockCalls: context.lockCalls,
        lockKeys: context.lockKeys,
        registryReads: context.registryReads,
        registryBytes: context.registryBytes,
      },
    };
  });
  return { context, promise };
}

async function measured(name, store, action, registryBytesPerRead = 0) {
  return startMeasurement(name, store, action, registryBytesPerRead).promise;
}

function summarize(rows) {
  const commandTotals = {};
  const refReadTotals = {};
  for (const row of rows) {
    for (const { command, ref } of row.gitCommands) {
      commandTotals[command] = (commandTotals[command] ?? 0) + 1;
      if (ref) refReadTotals[ref] = (refReadTotals[ref] ?? 0) + 1;
    }
  }
  const values = (select) => rows.map(select);
  return {
    n: rows.length,
    latencyMs: distribution(values((row) => row.ms)),
    gitWallMs: distribution(values((row) => row.gitWallMs)),
    lockWaitMs: distribution(values((row) => row.lockWaitMs)),
    lockActionMs: distribution(values((row) => row.lockActionMs)),
    gitProcessesPerRequest: distribution(values((row) => row.counters.gitProcesses)),
    registryReadsPerRequest: distribution(values((row) => row.registryReads)),
    registryBytesPerRequest: distribution(values((row) => row.registryBytes)),
    gitCommandTotals: commandTotals,
    gitRefReadTotals: refReadTotals,
    commandLogComplete: rows.every((row) => row.counters.gitCommandLogDropped === 0),
  };
}

async function cloneBare(label, source = dataset.remote) {
  const remote = join(workRoot, 'remotes', `${label}.git`);
  await mkdir(dirname(remote), { recursive: true });
  git(workRoot, 'clone', '--bare', '--', source, remote);
  return remote;
}

async function makeStore(label, projectCount) {
  const dataDir = join(workRoot, 'stores', label);
  const store = instrumentStore(new CoreStore({ dataDir, allowLocalRemotes: true }));
  const projects = [];
  for (let index = 0; index < projectCount; index++) {
    const remote = await cloneBare(`${label}-${index + 1}`);
    projects.push(await store.registerProject({ url: remote }));
  }
  const registryBytesPerRead = (await stat(join(dataDir, 'projects.json'))).size;
  return { store, projects, registryBytesPerRead, dataDir };
}

function assertSameScene(result, expected, label) {
  const scene = result.remote ?? result;
  if (scene.snapshot.remoteCommit !== expected.snapshot.remoteCommit ||
      scene.document.content !== expected.document.content ||
      scene.document.revision !== expected.document.revision) {
    throw new Error(`${label} returned a different pinned scene`);
  }
}

async function readCohort(projectCount) {
  const setup = await makeStore(`read-${projectCount}-projects`, projectCount);
  const project = setup.projects[0];
  const expected = await setup.store.readSceneSnapshot(project.id, 'scene-1', 'remote');
  const snapshotRows = [];
  const viewsRows = [];
  for (let index = 0; index < repeats; index++) {
    const snapshot = await measured('readSceneSnapshot', setup.store,
      () => setup.store.readSceneSnapshot(project.id, 'scene-1', 'remote', expected.snapshot),
      setup.registryBytesPerRead);
    assertSameScene(snapshot.value, expected, 'readSceneSnapshot');
    snapshotRows.push(snapshot.row);

    const views = await measured('readSceneViews', setup.store,
      () => setup.store.readSceneViews(project.id, 'scene-1', expected.snapshot),
      setup.registryBytesPerRead);
    assertSameScene(views.value, expected, 'readSceneViews.remote');
    assertSameScene(views.value.effective, expected, 'readSceneViews.effective');
    viewsRows.push(views.row);
  }
  return {
    projectCount,
    registryBytes: setup.registryBytesPerRead,
    readSceneSnapshot: { summary: summarize(snapshotRows), samples: snapshotRows },
    readSceneViews: { summary: summarize(viewsRows), samples: viewsRows },
  };
}

async function advanceRemote(remote, stagePath) {
  git(workRoot, 'clone', '--quiet', '--', remote, stagePath);
  const metadataPath = join(stagePath, 'meta', 'project.yaml');
  const original = await readFile(metadataPath, 'utf8');
  await writeFile(metadataPath, `${original}\nsyntheticStatusRevision: advanced\n`);
  git(stagePath, 'add', 'meta/project.yaml');
  git(stagePath, 'commit', '--quiet', '-m', 'Synthetic remote status advance');
  git(stagePath, 'push', 'origin', 'main');
  return git(remote, 'rev-parse', 'refs/heads/main');
}

async function statusProbe() {
  const setup = await makeStore('status', 1);
  const project = setup.projects[0];
  const unchangedRows = [];
  let latestStatus;
  for (let index = 0; index < repeats; index++) {
    const sample = await measured('status.unchanged', setup.store,
      () => setup.store.status(project.id), setup.registryBytesPerRead);
    latestStatus = sample.value;
    unchangedRows.push(sample.row);
  }
  if (latestStatus?.behind !== 0) throw new Error('Unchanged remote status unexpectedly reports a behind commit');

  const registeredRemote = git(join(setup.dataDir, 'projects', project.id), 'remote', 'get-url', 'origin');
  const expectedHead = await advanceRemote(registeredRemote, join(workRoot, 'status-advance'));
  const changed = await measured('status.changed-head', setup.store,
    () => setup.store.status(project.id), setup.registryBytesPerRead);
  if (changed.value.behind !== 1) throw new Error(`Changed remote status expected behind=1, got ${changed.value.behind}`);
  const trackedHead = git(join(setup.dataDir, 'projects', project.id), 'rev-parse', 'refs/remotes/origin/main');
  if (trackedHead !== expectedHead) throw new Error('Changed remote status did not fetch the authoritative remote head');

  const caughtUpRows = [];
  for (let index = 0; index < repeats; index++) {
    const sample = await measured('status.after-change-unchanged', setup.store,
      () => setup.store.status(project.id), setup.registryBytesPerRead);
    if (sample.value.behind !== 1) throw new Error('Post-fetch status lost the changed remote state');
    caughtUpRows.push(sample.row);
  }
  return {
    unchanged: { summary: summarize(unchangedRows), samples: unchangedRows },
    changedHead: { sample: changed.row, behind: changed.value.behind, expectedRemoteHead: expectedHead },
    afterFetch: { summary: summarize(caughtUpRows), samples: caughtUpRows, behind: 1 },
    remote: { kind: 'local bare Git repository', networkBytesMeasured: false },
  };
}

function makeOperation(scene, suffix) {
  const id = randomUUID();
  return {
    id,
    generation: 1,
    repository: scene.snapshot.repository,
    baseRemoteCommit: scene.snapshot.remoteCommit,
    effect: 'manuscript',
    reads: [{ path: scene.document.path, revision: scene.document.revision }],
    writes: [{
      path: scene.document.path,
      revision: scene.document.revision,
      content: `${scene.document.content}\nSynthetic read-overhead ${suffix}.\n`,
    }],
    message: `Synthetic read-overhead ${suffix}`,
  };
}

async function proposeAndApprove(store, projectId, scene, suffix) {
  const operation = makeOperation(scene, suffix);
  const proposal = await store.propose(projectId, {
    id: `proposal_${operation.id}`,
    snapshot: scene.snapshot,
    operations: [operation],
    source: 'author',
  });
  await store.approve(projectId, {
    proposalId: proposal.id,
    operationIds: [operation.id],
    authorScope: 'synthetic-core64-read-overhead',
  });
  return operation;
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms} ms`)), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function contentionProbe() {
  const setup = await makeStore('contention', 1);
  const project = setup.projects[0];
  const originalScene = await setup.store.readSceneSnapshot(project.id, 'scene-1', 'remote');
  const firstOperation = await proposeAndApprove(setup.store, project.id, originalScene, 'slow checkpoint');
  const staleOperation = await proposeAndApprove(setup.store, project.id, originalScene, 'stale checkpoint');

  const originalCreateCommit = setup.store.createCommit.bind(setup.store);
  const commitEntered = deferred();
  const releaseCommit = deferred();
  let slowCheckpointArmed = true;
  setup.store.createCommit = async function(...args) {
    if (slowCheckpointArmed) {
      slowCheckpointArmed = false;
      commitEntered.resolve(performance.now());
      await releaseCommit.promise;
    }
    return originalCreateCommit(...args);
  };

  const slow = startMeasurement('checkpoint.slow', setup.store,
    () => setup.store.checkpoint(project.id, firstOperation), setup.registryBytesPerRead);
  let read;
  let staleWriter;
  const holdStartedAt = await withTimeout(commitEntered.promise, 30_000, 'Slow checkpoint gate');
  try {
    read = startMeasurement('readSceneSnapshot.pinned.during-checkpoint', setup.store,
      () => setup.store.readSceneSnapshot(project.id, 'scene-1', 'remote', originalScene.snapshot),
      setup.registryBytesPerRead);
    staleWriter = startMeasurement('checkpoint.stale.writer-fence', setup.store, async () => {
      try {
        const receipt = await setup.store.checkpoint(project.id, staleOperation);
        return { accepted: true, localCommit: receipt.localCommit };
      } catch (error) {
        return { accepted: false, code: error.code ?? 'unknown' };
      }
    }, setup.registryBytesPerRead);
    await withTimeout(Promise.all([read.context.lockQueued.promise, staleWriter.context.lockQueued.promise]), 10_000, 'Contending requests to queue');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  } finally {
    releaseCommit.resolve();
  }

  const [slowResult, readResult, staleResult] = await withTimeout(Promise.all([
    slow.promise,
    read.promise,
    staleWriter.promise,
  ]), 60_000, 'Contention scenario');
  if (!readResult.value.snapshot.remoteCommit ||
      readResult.value.snapshot.remoteCommit !== originalScene.snapshot.remoteCommit ||
      readResult.value.document.content !== originalScene.document.content) {
    throw new Error('Pinned remote reader did not retain the original scene snapshot');
  }
  if (staleResult.value.accepted || staleResult.value.code !== 'operation_precondition_conflict') {
    throw new Error(`Stale writer fence failed: ${JSON.stringify(staleResult.value)}`);
  }

  const checkpointHead = git(join(setup.dataDir, 'projects', project.id), 'rev-parse', 'refs/scriptorium/checkpoint-head');
  if (checkpointHead !== slowResult.value.localCommit) throw new Error('Stale writer moved the checkpoint head');
  const currentCheckpointScene = await setup.store.readSceneSnapshot(project.id, 'scene-1', 'checkpoint');
  const expectedCheckpointContent = `${originalScene.document.content}\nSynthetic read-overhead slow checkpoint.\n`;
  if (currentCheckpointScene.document.content !== expectedCheckpointContent) {
    throw new Error('Successful checkpoint content did not remain the current checkpoint view');
  }

  return {
    controlledHoldMs: 250,
    holdStartedAtMonotonicMs: holdStartedAt,
    checkpoint: slowResult.row,
    pinnedRead: readResult.row,
    staleWriter: { ...staleResult.row, result: staleResult.value },
    invariants: {
      checkpointCommitted: checkpointHead === slowResult.value.localCommit,
      pinnedReadKeptOriginalRemoteCommit: readResult.value.snapshot.remoteCommit === originalScene.snapshot.remoteCommit,
      pinnedReadKeptOriginalContent: readResult.value.document.content === originalScene.document.content,
      staleWriterRejected: staleResult.value.code === 'operation_precondition_conflict',
      staleWriterDidNotMoveCheckpointHead: checkpointHead === slowResult.value.localCommit,
      currentCheckpointContainsSuccessfulWrite: currentCheckpointScene.document.content === expectedCheckpointContent,
    },
  };
}

const report = {
  schemaVersion: 1,
  status: 'running',
  source: {
    commit: git(process.cwd(), 'rev-parse', 'HEAD'),
    scriptSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),
  },
  runtime: { root: runtimeRoot, commit: runtimeCommit, indexSha256: runtimeIndexSha256 },
  cpuAffinity: { requested: '4-7', effective: effectiveCpuAffinity },
  dataset: {
    datasetId: dataset.datasetId,
    size: dataset.size,
    files: dataset.files,
    bytes: dataset.bytes,
    commit: dataset.commit,
    syntheticOnly: dataset.syntheticOnly,
  },
  toolchain: { node: process.version, git: git(workRoot, '--version') },
  parameters: {
    repeats,
    projectCounts: [1, 5],
    measuredApiRequests: repeats * 4 + repeats * 2 + 1 + 3,
    statusPhases: ['unchanged', 'changed-head', 'after-fetch'],
  },
  measurements: {},
};

try {
  report.measurements.reads = {
    oneProject: await readCohort(1),
    fiveProjects: await readCohort(5),
  };
  report.measurements.status = await statusProbe();
  report.measurements.contention = await contentionProbe();
  report.status = 'complete';
  await save(outputPath, report);
} catch (error) {
  report.status = 'failed';
  report.error = { message: error.message, code: error.code ?? null };
  await save(outputPath, report);
  process.exitCode = 1;
}

console.log(JSON.stringify({ output: outputPath, status: report.status, dataset: report.dataset.datasetId }));
