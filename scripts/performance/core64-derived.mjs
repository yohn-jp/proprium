// Bounded C32/C33/C34/C36 probe. This is a benchmark-only wrapper around the
// existing Core APIs; it does not duplicate their scan or hierarchy logic.
import childProcess from 'node:child_process';
import inspector from 'node:inspector';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { counts } from './instrument-node.mjs';
import { git } from './dataset.mjs';
import { distribution, measure, save } from './common.mjs';

const [datasetPathArg, outputArg, mode = 'scan'] = process.argv.slice(2);
if (!datasetPathArg || !outputArg || !['scan', 'tree-profile'].includes(mode)) {
  throw new Error('Usage: core64-derived.mjs DATASET_DIR OUTPUT.json scan|tree-profile');
}

const fixtureCommits = {
  small: 'e70bb509cc41b383451335e05af36d78f1cb31db',
  medium: '773d4bb408f333e330e5359d74d43da8fe990554',
  large: '1adbb44980a9ccee009c536c7593fb23503ed86c',
  stress: '86eb03604a68765553c4c89753af459f48c3950c',
};
const datasetPath = resolve(datasetPathArg);
const output = resolve(outputArg);
const dataset = JSON.parse(await readFile(join(datasetPath, 'dataset.json'), 'utf8'));
if (!dataset.syntheticOnly || !dataset.remote || fixtureCommits[dataset.size] !== dataset.commit) {
  throw new Error('Expected an immutable G0 synthetic fixture manifest with its pinned commit');
}

const commandKinds = {
  gitOther: 0,
  gitLsTree: 0,
  gitCatFileBlob: 0,
  gitCatFileBatch: 0,
  gitCatFileBatchCheck: 0,
  gitCatFileOther: 0,
};
const readCounts = {
  snapshotFileCalls: 0,
  documentReadCalls: 0,
  documentReadBytes: 0,
  metadataReadCalls: 0,
  metadataReadBytes: 0,
  missingSnapshotFileCalls: 0,
};

function gitCommand(args) {
  if (!Array.isArray(args)) return '';
  for (let index = 0; index < args.length;) {
    const value = String(args[index]);
    if (value === '-c' || value === '-C' || value === '--git-dir' || value === '--work-tree') {
      index += 2;
      continue;
    }
    if (value.startsWith('-')) {
      index += 1;
      continue;
    }
    return value;
  }
  return '';
}

function countGitCommand(args) {
  const command = gitCommand(args);
  if (command === 'ls-tree') {
    commandKinds.gitLsTree += 1;
    return;
  }
  if (command !== 'cat-file') {
    commandKinds.gitOther += 1;
    return;
  }
  const tail = Array.isArray(args) ? args.slice(args.indexOf('cat-file') + 1).map(String) : [];
  if (tail.includes('--batch')) commandKinds.gitCatFileBatch += 1;
  else if (tail.some((value) => value.startsWith('--batch-check'))) commandKinds.gitCatFileBatchCheck += 1;
  else if (tail[0] === 'blob') commandKinds.gitCatFileBlob += 1;
  else commandKinds.gitCatFileOther += 1;
}

// Add command-kind counts on top of the canonical instrumentation wrapper.
// Copy its custom promisifier so Core's existing execFile path remains intact.
for (const name of ['execFile', 'spawn']) {
  const original = childProcess[name];
  const wrapped = function(file, args, ...rest) {
    if (file === 'git') countGitCommand(args);
    return Reflect.apply(original, this, [file, args, ...rest]);
  };
  const customPromisify = original[Symbol.for('nodejs.util.promisify.custom')];
  if (customPromisify) wrapped[Symbol.for('nodejs.util.promisify.custom')] = customPromisify;
  childProcess[name] = wrapped;
}
syncBuiltinESMExports();

const allCounters = () => ({ ...counts, ...commandKinds, ...readCounts });
const fingerprint = (value) => JSON.stringify(Object.fromEntries(
  Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right)),
));
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isDocumentPath = (filePath) => filePath.startsWith('manuscript/') || filePath.startsWith('meta/scratch/');

function instrumentSnapshotFile(store) {
  const original = store.snapshotFile;
  if (typeof original !== 'function') throw new Error('Core runtime does not expose the expected private snapshotFile method');
  store.snapshotFile = async function(...args) {
    const filePath = String(args[2] ?? '');
    const document = isDocumentPath(filePath);
    readCounts.snapshotFileCalls += 1;
    if (document) readCounts.documentReadCalls += 1;
    else readCounts.metadataReadCalls += 1;
    try {
      const value = await Reflect.apply(original, this, args);
      if (!value) readCounts.missingSnapshotFileCalls += 1;
      else {
        const bytes = Buffer.byteLength(value.content, 'utf8');
        if (document) readCounts.documentReadBytes += bytes;
        else readCounts.metadataReadBytes += bytes;
      }
      return value;
    } catch (error) {
      throw error;
    }
  };
}

function profilerPost(session, method, params = {}) {
  return new Promise((resolvePost, rejectPost) => {
    session.post(method, params, (error, result) => error ? rejectPost(error) : resolvePost(result));
  });
}

function profileSummary(profile) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const totals = { hierarchySamples: 0, hierarchyCpuSampleMs: 0, readHierarchyYamlCpuSampleMs: 0, postReadGroupingCpuSampleMs: 0 };
  const frames = new Map();
  for (let index = 0; index < (profile.samples?.length ?? 0); index += 1) {
    const leaf = nodes.get(profile.samples[index]);
    if (!leaf) continue;
    const stack = [];
    let current = leaf;
    while (current) {
      stack.push(current);
      current = nodes.get(parent.get(current.id));
    }
    if (!stack.some((node) => (node.callFrame.functionName ?? '').includes('hierarchySnapshot'))) continue;
    const sampleMs = (profile.timeDeltas?.[index] ?? 1000) / 1000;
    totals.hierarchySamples += 1;
    totals.hierarchyCpuSampleMs += sampleMs;
    if (stack.some((node) => (node.callFrame.functionName ?? '').includes('readHierarchyYaml'))) {
      totals.readHierarchyYamlCpuSampleMs += sampleMs;
    } else {
      totals.postReadGroupingCpuSampleMs += sampleMs;
    }
    const frame = leaf.callFrame;
    const key = `${frame.functionName || '(anonymous)'} @ ${frame.url || '[native]'}:${frame.lineNumber + 1}`;
    frames.set(key, (frames.get(key) ?? 0) + sampleMs);
  }
  const topLeafFrames = [...frames.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 30)
    .map(([frame, sampleMs]) => ({ frame, sampleMs }));
  return { ...totals, topLeafFrames, samplingIntervalUs: 1000 };
}

function instrumentHierarchyProfile(store) {
  const originalHierarchy = store.hierarchySnapshot;
  const originalYaml = store.readHierarchyYaml;
  if (typeof originalHierarchy !== 'function' || typeof originalYaml !== 'function') {
    throw new Error('Core runtime does not expose the expected private hierarchy methods');
  }
  const session = new inspector.Session();
  session.connect();
  const profile = { hierarchySnapshotWallMs: null, readHierarchyYamlWallMs: null, cpu: null };
  store.readHierarchyYaml = async function(...args) {
    const start = performance.now();
    try { return await Reflect.apply(originalYaml, this, args); }
    finally { profile.readHierarchyYamlWallMs = performance.now() - start; }
  };
  store.hierarchySnapshot = async function(...args) {
    await profilerPost(session, 'Profiler.start');
    const start = performance.now();
    try { return await Reflect.apply(originalHierarchy, this, args); }
    finally {
      profile.hierarchySnapshotWallMs = performance.now() - start;
      const stopped = await profilerPost(session, 'Profiler.stop');
      profile.cpu = profileSummary(stopped.profile);
      session.disconnect();
    }
  };
  return profilerPost(session, 'Profiler.enable').then(() => profilerPost(session, 'Profiler.setSamplingInterval', { interval: 1000 })).then(() => profile);
}

function summarizeTree(result) {
  const chapters = result.tree.volumes.flatMap((volume) => volume.chapters);
  return {
    snapshot: fingerprint(result.snapshot),
    volumeCount: result.tree.volumes.length,
    chapterCount: chapters.length,
    sceneCount: chapters.reduce((sum, chapter) => sum + chapter.scenes.length, 0),
    treeSha256: digest(result.tree),
  };
}

function summarizeSearch(result) {
  return {
    snapshot: fingerprint(result.snapshot),
    resultCount: result.results.length,
    resultSha256: digest(result.results),
  };
}

function summarizeStats(result) {
  const chapters = result.stats.volumes.flatMap((volume) => volume.chapters);
  return {
    snapshot: fingerprint(result.snapshot),
    volumeCount: result.stats.volumes.length,
    chapterCount: chapters.length,
    sceneCount: Object.keys(result.stats.sceneById).length,
    totalCharCount: result.stats.totalCharCount,
    totalPages400: result.stats.totalPages400,
    statsSha256: digest(result.stats),
  };
}

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), '../..');
const coreEntry = resolve(process.env.SCRIPTORIUM_CORE64_ENTRY ?? join(repoRoot, 'packages/core/dist/index.js'));
const runtimeSource = git(dirname(coreEntry), 'rev-parse', 'HEAD');
const runId = createHash('sha256').update(`${dataset.commit}\0${mode}\0${Date.now()}\0${process.pid}`).digest('hex').slice(0, 16);
const report = {
  harness: {
    source: git(repoRoot, 'rev-parse', 'HEAD'),
    scriptSha256: createHash('sha256').update(await readFile(scriptPath)).digest('hex'),
    node: process.version,
    mode,
  },
  runtime: { entry: coreEntry, source: runtimeSource },
  dataset: { id: dataset.datasetId, size: dataset.size, files: dataset.files, scenes: dataset.scenes, commit: dataset.commit },
  query: mode === 'scan' ? { text: 'wave0-absent-needle-9f742e', limit: 20 } : undefined,
  samples: [],
  summaries: {},
  status: 'running',
};

async function recordSample(name, action, summarize = (value) => value) {
  report.pending = { name, startedAt: new Date().toISOString() };
  await save(output, report);
  const measured = await measure(name, action, allCounters);
  const value = summarize(measured.value);
  report.samples.push({ ...measured.sample, value });
  report.summaries[name] = distribution(report.samples.filter((sample) => sample.name === name).map((sample) => sample.ms));
  delete report.pending;
  await save(output, report);
  return measured.value;
}

function addCounters(samples) {
  const totals = {};
  for (const sample of samples) for (const [key, value] of Object.entries(sample.counters ?? {})) {
    if (typeof value === 'number') totals[key] = (totals[key] ?? 0) + value;
  }
  return totals;
}

const temporaryRoot = await mkdtemp(join(tmpdir(), `scriptorium-core64-derived-${runId}-`));
let store;
await save(output, report);
try {
  const remote = join(temporaryRoot, 'origin.git');
  git(datasetPath, 'clone', '--bare', dataset.remote, remote);
  const { CoreStore } = await import(pathToFileURL(coreEntry).href);
  store = new CoreStore({ dataDir: join(temporaryRoot, 'state'), allowLocalRemotes: true });
  instrumentSnapshotFile(store);
  const project = await recordSample('register', () => store.registerProject({ url: remote }), (value) => ({ projectId: value.id }));

  if (mode === 'scan') {
    const reader = await recordSample('snapshot.pin', () => store.reader(project.id), (value) => ({ snapshot: fingerprint(value.snapshot) }));
    const pinned = reader.snapshot;
    const search = await recordSample('search.scan',
      () => store.searchSnapshot(project.id, report.query.text, report.query.limit, 'remote', pinned), summarizeSearch);
    const stats = await recordSample('stats.scan',
      () => store.writingStatsSnapshot(project.id, 'remote', pinned), summarizeStats);
    const searchSnapshot = fingerprint(search.snapshot);
    const statsSnapshot = fingerprint(stats.snapshot);
    report.samePinnedSnapshot = searchSnapshot === fingerprint(pinned) && statsSnapshot === fingerprint(pinned);
    const scanSamples = report.samples.filter((sample) => ['search.scan', 'stats.scan'].includes(sample.name));
    report.cumulative = {
      operations: ['search.scan', 'stats.scan'],
      samePinnedSnapshot: report.samePinnedSnapshot,
      snapshot: fingerprint(pinned),
      wallMs: scanSamples.reduce((sum, sample) => sum + sample.ms, 0),
      nodeCpuUs: scanSamples.reduce((sum, sample) => sum + sample.cpuUs.user + sample.cpuUs.system, 0),
      maxRssBytes: Math.max(...scanSamples.map((sample) => sample.rssBytes)),
      maxProcessRssKiB: Math.max(...scanSamples.map((sample) => sample.maxRssKiB)),
      counters: addCounters(scanSamples),
    };
    if (!report.samePinnedSnapshot) throw new Error('Search or statistics escaped the pinned snapshot');
  } else {
    const profile = await instrumentHierarchyProfile(store);
    const tree = await recordSample('tree.cold.profiled', () => store.readTreeSnapshot(project.id), summarizeTree);
    const treeSample = report.samples.at(-1);
    report.hierarchyProfile = {
      wallMs: profile.hierarchySnapshotWallMs,
      readHierarchyYamlWallMs: profile.readHierarchyYamlWallMs,
      postReadGroupingAndAssemblyWallMs: profile.hierarchySnapshotWallMs - profile.readHierarchyYamlWallMs,
      cpu: profile.cpu,
      calls: {
        topLevelGitCommands: treeSample.counters.gitProcesses,
        lsTree: treeSample.counters.gitLsTree,
        catFileBatch: treeSample.counters.gitCatFileBatch,
        catFileBatchCheck: treeSample.counters.gitCatFileBatchCheck,
      },
      treeSnapshot: fingerprint(tree.snapshot),
    };
    report.profileNote = 'V8 samples are Node-only estimates. readHierarchyYaml is the tree/object/YAML phase; the residual hierarchySnapshot phase is grouping, ordering, and tree materialization, not an exact per-loop timer.';
  }
  report.status = 'complete';
} catch (error) {
  report.status = 'failed';
  report.error = { message: error.message, code: error.code };
  process.exitCode = 1;
} finally {
  await save(output, report);
  if (store?.dispose) await store.dispose().catch(() => {});
  await rm(temporaryRoot, { recursive: true, force: true });
}
