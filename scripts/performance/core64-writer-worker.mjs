// Synthetic Core writer probe for C23, C27 and C28. Import the existing process
// instrumentation before Core so every Core-issued Git child process is counted.
import { counts, gitCommands } from './instrument-node.mjs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { git } from './dataset.mjs';
import { measure, save, distribution } from './common.mjs';

const [fixturePathArg, scratchRootArg, outputArg, kind, scaleArg, repeatsArg, runtimeEntryArg, runtimeCommit] = process.argv.slice(2);
const fixturePath = resolve(fixturePathArg ?? '');
const scratchRoot = resolve(scratchRootArg ?? '');
const output = resolve(outputArg ?? '');
const scale = Number(scaleArg);
const repeats = Number(repeatsArg);
const runtimeEntry = resolve(runtimeEntryArg ?? '');
const executionMode = process.env.CORE64_WRITER_RUN_MODE ?? 'unspecified';
const requestedCpuSet = process.env.CORE64_WRITER_REQUESTED_CPUSET ?? null;
let effectiveCpuSet = null;
try {
  const status = await readFile('/proc/self/status', 'utf8');
  effectiveCpuSet = status.match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1] ?? null;
} catch {}
if (executionMode === 'contended' && (!requestedCpuSet || effectiveCpuSet !== requestedCpuSet)) {
  throw new Error(`Contended worker requires matching requested/effective CPU affinity; got ${requestedCpuSet}/${effectiveCpuSet}`);
}
if (!fixturePathArg || !scratchRootArg || !outputArg || !['checkpoint', 'census', 'publish'].includes(kind) ||
    !Number.isSafeInteger(scale) || scale < 1 || !Number.isSafeInteger(repeats) || repeats < 1 ||
    !runtimeEntryArg || !/^[a-f0-9]{40}$/.test(runtimeCommit ?? '')) {
  throw new Error('Usage: worker <immutable-fixture> <scratch-root> <output> <checkpoint|census|publish> <scale> <repeats> <runtime-entry> <runtime-source-commit>');
}

const fixture = JSON.parse(await readFile(join(fixturePath, 'dataset.json'), 'utf8'));
const { CoreStore } = await import(pathToFileURL(runtimeEntry).href);
const report = {
  schemaVersion: 1,
  status: 'running',
  kind,
  scale,
  repeats,
  executionContext: { mode: executionMode, requestedCpuSet, effectiveCpuSet },
  runtime: { entry: runtimeEntry, sourceCommit: runtimeCommit },
  fixture,
  node: process.version,
  startedAt: new Date().toISOString(),
  samples: [],
  summaries: {},
  metricSummaries: {},
  preparations: [],
  integrityChecks: [],
  progress: { phase: 'starting', completed: 0, total: scale },
};
await save(output, report);

function counters() {
  return { gitProcesses: counts.gitProcesses, gitCommandLogDropped: counts.gitCommandLogDropped };
}

function commandName(args) {
  if (!Array.isArray(args)) return '(unknown)';
  let index = 0;
  while (index < args.length) {
    if (args[index] === '--literal-pathspecs') { index += 1; continue; }
    if (args[index] === '-c') { index += 2; continue; }
    break;
  }
  return args[index] ?? '(unknown)';
}

function commandLogSlice(from, droppedBefore, gitProcessCount) {
  const captured = gitCommands.slice(from);
  const dropped = counts.gitCommandLogDropped - droppedBefore;
  const byCommand = {};
  for (const { args } of captured) {
    const name = commandName(args);
    byCommand[name] = (byCommand[name] ?? 0) + 1;
  }
  return {
    captured: captured.length,
    dropped,
    complete: captured.length === gitProcessCount,
    byCommand,
  };
}

async function capture(name, action) {
  report.pending = { name, startedAt: new Date().toISOString() };
  report.progress = { ...report.progress, phase: `measure:${name}` };
  await save(output, report);
  const commandLogFrom = gitCommands.length;
  const droppedBefore = counts.gitCommandLogDropped;
  const result = await measure(name, action, counters);
  const gitProcessCount = result.sample.counters.gitProcesses ?? 0;
  const sample = {
    ...result.sample,
    gitProcessCount,
    gitCommandLog: commandLogSlice(commandLogFrom, droppedBefore, gitProcessCount),
  };
  delete report.pending;
  report.samples.push(sample);
  const cohort = report.samples.filter((item) => item.name === name);
  report.summaries[name] = distribution(cohort.map((item) => item.ms));
  report.metricSummaries[name] = {
    gitProcesses: distribution(cohort.map((item) => item.gitProcessCount)),
    nodeCpuUserUs: distribution(cohort.map((item) => item.cpuUs.user)),
    nodeCpuSystemUs: distribution(cohort.map((item) => item.cpuUs.system)),
    rssBytes: distribution(cohort.map((item) => item.rssBytes)),
    maxRssKiB: distribution(cohort.map((item) => item.maxRssKiB)),
  };
  report.progress = { ...report.progress, phase: 'measured', completed: report.samples.filter((item) => item.name === name).length };
  await save(output, report);
  return result.value;
}

async function createContext(label) {
  const id = randomUUID();
  const remote = join(scratchRoot, `core64-writer-${label}-${id}.git`);
  const dataDir = join(scratchRoot, `core64-writer-state-${label}-${id}`);
  git(fixturePath, 'clone', '--bare', fixture.remote, remote);
  const store = new CoreStore({ dataDir, allowLocalRemotes: true });
  const project = await store.registerProject({ url: remote });
  const observation = await store.observe(project.id);
  return { store, project, snapshot: observation.snapshot, remote, dataDir };
}

function operation(snapshot, id, filePath, content) {
  return {
    id,
    generation: 1,
    repository: snapshot.repository,
    baseRemoteCommit: snapshot.remoteCommit,
    effect: 'manuscript',
    reads: [{ path: filePath, revision: null }],
    writes: [{ path: filePath, revision: null, content }],
    message: `Synthetic Core 64 writer ${id}`,
  };
}

function grouped(values, max = 256) {
  const result = [];
  for (let offset = 0; offset < values.length; offset += max) result.push(values.slice(offset, offset + max));
  return result;
}

async function prepareApprovedCheckpoints(store, projectId, snapshot, operations, progressLabel) {
  const groups = grouped(operations);
  let completed = 0;
  const started = performance.now();
  const preparation = { label: progressLabel, completed, total: operations.length, elapsedMs: 0 };
  report.preparations.push(preparation);
  report.progress = { phase: `prepare:${progressLabel}`, completed, total: operations.length };
  await save(output, report);
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const proposalOperations = groups[groupIndex];
    const proposalId = `proposal_${progressLabel}_${groupIndex + 1}`;
    const proposal = await store.propose(projectId, {
      id: proposalId,
      snapshot,
      operations: proposalOperations,
      source: 'author',
    });
    await store.approve(projectId, {
      proposalId: proposal.id,
      operationIds: proposalOperations.map(({ id }) => id),
      authorScope: 'synthetic-benchmark-author',
    });
    for (const item of proposalOperations) {
      const receipt = await store.checkpoint(projectId, item);
      if (receipt.operationId !== item.id || receipt.revisions.length !== item.writes.length) {
        throw new Error(`Checkpoint receipt did not bind the expected operation: ${item.id}`);
      }
      completed += 1;
      if (completed === operations.length || completed % (operations.length > 1000 ? 100 : 10) === 0) {
        report.progress = { phase: `prepare:${progressLabel}`, completed, total: operations.length };
        preparation.completed = completed;
        preparation.elapsedMs = performance.now() - started;
        await save(output, report);
      }
    }
  }
  preparation.completed = completed;
  preparation.elapsedMs = performance.now() - started;
  report.progress = { phase: `prepared:${progressLabel}`, completed, total: operations.length };
  await save(output, report);
}

async function checkpointWorkload() {
  const files = Array.from({ length: scale }, (_, index) => {
    const path = `manuscript/core64-writer/checkpoint/write-${String(index + 1).padStart(3, '0')}.md`;
    return { path, content: `Synthetic checkpoint file ${index + 1}.\n` };
  });
  report.progress = { phase: 'prepare', completed: 0, total: repeats };
  await save(output, report);
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    const context = await createContext(`checkpoint-${scale}-${repeat}`);
    const id = `c64w_checkpoint_${scale}_${repeat}`;
    const op = {
      id,
      generation: 1,
      repository: context.snapshot.repository,
      baseRemoteCommit: context.snapshot.remoteCommit,
      effect: 'manuscript',
      reads: files.map(({ path }) => ({ path, revision: null })),
      writes: files.map(({ path, content }) => ({ path, revision: null, content })),
      message: `Synthetic checkpoint with ${scale} files`,
    };
    const proposal = await context.store.propose(context.project.id, {
      id: `proposal_${id}`,
      snapshot: context.snapshot,
      operations: [op],
      source: 'author',
    });
    await context.store.approve(context.project.id, {
      proposalId: proposal.id,
      operationIds: [id],
      authorScope: 'synthetic-benchmark-author',
    });
    const receipt = await capture('checkpoint', () => context.store.checkpoint(context.project.id, op));
    if (receipt.operationId !== id || receipt.revisions.length !== scale) {
      throw new Error(`C23 checkpoint receipt did not contain ${scale} writes`);
    }
    const census = await context.store.localDurabilityCensus(context.project.id);
    if (census.pendingCheckpoints.length !== 1 || !census.pendingCheckpoints.some(({ operationId }) => operationId === id)) {
      throw new Error('C23 local durability census did not preserve the pending checkpoint receipt');
    }
    report.integrityChecks.push({ repeat, receiptOperationId: receipt.operationId,
      receiptRevisionCount: receipt.revisions.length, pendingCheckpointCount: census.pendingCheckpoints.length,
      localWorkspaceDirty: census.localWorkspaceDirty });
    report.progress = { phase: 'prepare', completed: repeat, total: repeats };
    await save(output, report);
  }
}

async function censusWorkload() {
  const context = await createContext(`census-${scale}`);
  const operations = Array.from({ length: scale }, (_, index) => {
    const number = index + 1;
    const id = `c64w_census_${scale}_${number}`;
    const path = `manuscript/core64-writer/census/op-${String(number).padStart(5, '0')}.md`;
    return operation(context.snapshot, id, path, `Synthetic census history operation ${number}.\n`);
  });
  await prepareApprovedCheckpoints(context.store, context.project.id, context.snapshot, operations, `census_${scale}`);
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    const census = await capture('census', () => context.store.localDurabilityCensus(context.project.id));
    const ids = new Set(census.pendingCheckpoints.map(({ operationId }) => operationId));
    if (ids.size !== scale || operations.some(({ id }) => !ids.has(id))) {
      throw new Error(`C27 census did not retain all ${scale} pending checkpoint receipts`);
    }
    report.integrityChecks.push({ repeat, pendingCheckpointCount: census.pendingCheckpoints.length,
      pendingProposalCount: census.pendingProposals, localWorkspaceDirty: census.localWorkspaceDirty });
    await save(output, report);
  }
}

async function publishWorkload() {
  report.progress = { phase: 'prepare', completed: 0, total: repeats };
  await save(output, report);
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    const context = await createContext(`publish-${scale}-${repeat}`);
    const batch = `c64w_publish_${scale}_${repeat}`;
    const operations = Array.from({ length: scale }, (_, index) => {
      const number = index + 1;
      const id = `c64w_publish_${scale}_${repeat}_${number}`;
      const path = `manuscript/core64-writer/publish/${batch}/op-${String(number).padStart(3, '0')}.md`;
      return operation(context.snapshot, id, path, `Synthetic pending publish operation ${number}.\n`);
    });
    await prepareApprovedCheckpoints(context.store, context.project.id, context.snapshot, operations, `publish_${scale}_${repeat}`);
    const receipt = await capture('publish', () => context.store.publish(context.project.id, batch));
    const acknowledged = new Set(receipt.acknowledged.map(({ operationId }) => operationId));
    if (receipt.state !== 'confirmed' || acknowledged.size !== scale || operations.some(({ id }) => !acknowledged.has(id))) {
      throw new Error(`C28 publication did not confirm exactly ${scale} pending operations`);
    }
    report.integrityChecks.push({ repeat, state: receipt.state, acknowledgedCount: acknowledged.size,
      remoteCommit: receipt.remoteCommit });
    report.progress = { phase: 'prepare', completed: repeat, total: repeats };
    await save(output, report);
  }
}

try {
  if (kind === 'checkpoint') await checkpointWorkload();
  else if (kind === 'census') await censusWorkload();
  else await publishWorkload();
  report.status = 'complete';
} catch (error) {
  report.status = 'failed';
  report.error = { name: error.name, message: error.message, code: error.code };
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await save(output, report);
}
