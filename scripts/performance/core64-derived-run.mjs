// Explicit, sequential launcher for the C64 derived-scan probe.
// Reuses run.mjs's detached process-tree timeout and never generates fixtures.
import { access, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWorker } from './run.mjs';
import { git } from './dataset.mjs';
import { distribution, save } from './common.mjs';

const [datasetRootArg, outputRootArg, coreEntryArg, sizesArg, modesArg, repeatsArg, timeoutArg] = process.argv.slice(2);
if (![datasetRootArg, outputRootArg, coreEntryArg, sizesArg, modesArg, repeatsArg, timeoutArg].every(Boolean)) {
  throw new Error('Usage: core64-derived-run.mjs DATA_ROOT NEW_OUTPUT_ROOT CORE_ENTRY small,medium,large scan,tree-profile REPEATS TIMEOUT_MS');
}

const datasetRoot = resolve(datasetRootArg);
const outputRoot = resolve(outputRootArg);
const coreEntry = resolve(coreEntryArg);
const sizes = sizesArg.split(',');
const modes = modesArg.split(',');
const repeats = Number(repeatsArg);
const timeoutMs = Number(timeoutArg);
const validSizes = new Set(['small', 'medium', 'large', 'stress']);
const validModes = new Set(['scan', 'tree-profile']);
const fixtureCommits = {
  small: 'e70bb509cc41b383451335e05af36d78f1cb31db',
  medium: '773d4bb408f333e330e5359d74d43da8fe990554',
  large: '1adbb44980a9ccee009c536c7593fb23503ed86c',
  stress: '86eb03604a68765553c4c89753af459f48c3950c',
};
if (!sizes.length || sizes.some((size) => !validSizes.has(size)) || !modes.length || modes.some((mode) => !validModes.has(mode)) ||
    !Number.isInteger(repeats) || repeats < 1 || !Number.isInteger(timeoutMs) || timeoutMs < 1000) {
  throw new Error('Invalid size, mode, repeat count, or worker timeout');
}
await access(coreEntry);

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), '../..');
const runtimeSource = git(dirname(coreEntry), 'rev-parse', 'HEAD');
await mkdir(outputRoot);
const resultRoot = join(outputRoot, 'results');
await mkdir(resultRoot);
const environment = {
  timestamp: new Date().toISOString(),
  source: git(repoRoot, 'rev-parse', 'HEAD'),
  sourceStatus: git(repoRoot, 'status', '--short'),
  runtime: { entry: coreEntry, source: runtimeSource },
  node: process.version,
  git: git(repoRoot, '--version'),
  sizes,
  modes,
  repeats,
  timeoutMs,
  fixtureRoot: datasetRoot,
  instrumentation: 'Core public API calls; existing process/I/O measurements; benchmark-only snapshotFile and hierarchySnapshot counters; V8 Node CPU profile for tree-profile mode',
};
await save(join(resultRoot, 'environment.json'), environment);

const workerPath = join(dirname(scriptPath), 'core64-derived.mjs');
const runRecords = [];
for (const size of sizes) {
  const datasetPath = join(datasetRoot, size);
  const dataset = JSON.parse(await readFile(join(datasetPath, 'dataset.json'), 'utf8'));
    if (!dataset.syntheticOnly || !dataset.remote || fixtureCommits[size] !== dataset.commit ||
        git(dataset.remote, 'rev-parse', 'HEAD') !== dataset.commit) {
      throw new Error(`Expected the immutable G0 ${size} fixture at its pinned commit: ${datasetPath}`);
    }
  await access(dataset.remote);
  for (const mode of modes) {
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      const output = join(resultRoot, `${mode}-${size}-r${repeat}.json`);
      const report = await runWorker(workerPath, [datasetPath, output, mode], output, timeoutMs, {
        SCRIPTORIUM_PROFILE: 'core',
        SCRIPTORIUM_CORE64_ENTRY: coreEntry,
      });
      runRecords.push({ size, mode, repeat, output, status: report.status, report });
      process.stdout.write(`${size}/${mode}/r${repeat}: ${report.status}\n`);
    }
  }
}

const groups = {};
for (const size of sizes) for (const mode of modes) {
  const runs = runRecords.filter((record) => record.size === size && record.mode === mode);
  const operationNames = mode === 'scan' ? ['search.scan', 'stats.scan'] : ['tree.cold.profiled'];
  const operations = {};
  for (const name of operationNames) {
    const observations = runs.flatMap(({ report }) => report.samples.filter((sample) => sample.name === name));
    operations[name] = {
      wallMs: distribution(observations.map((sample) => sample.ms)),
      completedWorkers: observations.length,
      statuses: runs.map(({ repeat, status }) => ({ repeat, status })),
    };
  }
  const complete = runs.map(({ report }) => report).filter((report) => report.status === 'complete');
  const group = { operations, completeWorkers: complete.length, requestedWorkers: runs.length };
  if (mode === 'scan') {
    const cumulative = complete.filter((report) => report.samePinnedSnapshot).map((report) => report.cumulative);
    group.samePinnedSnapshotWorkers = cumulative.length;
    group.cumulative = {
      wallMs: distribution(cumulative.map((sample) => sample.wallMs)),
      nodeCpuUs: distribution(cumulative.map((sample) => sample.nodeCpuUs)),
      documentReadCalls: distribution(cumulative.map((sample) => sample.counters.documentReadCalls ?? 0)),
      documentReadBytes: distribution(cumulative.map((sample) => sample.counters.documentReadBytes ?? 0)),
      gitProcesses: distribution(cumulative.map((sample) => sample.counters.gitProcesses ?? 0)),
      gitCatFileBlob: distribution(cumulative.map((sample) => sample.counters.gitCatFileBlob ?? 0)),
      maxRssBytes: distribution(cumulative.map((sample) => sample.maxRssBytes)),
      maxProcessRssKiB: distribution(cumulative.map((sample) => sample.maxProcessRssKiB)),
    };
  } else {
    const profiles = complete.map((report) => report.hierarchyProfile).filter(Boolean);
    group.hierarchyProfile = {
      profiledWorkers: profiles.length,
      hierarchySnapshotWallMs: distribution(profiles.map((profile) => profile.wallMs)),
      readHierarchyYamlWallMs: distribution(profiles.map((profile) => profile.readHierarchyYamlWallMs)),
      postReadGroupingAndAssemblyWallMs: distribution(profiles.map((profile) => profile.postReadGroupingAndAssemblyWallMs)),
      hierarchyCpuSampleMs: distribution(profiles.map((profile) => profile.cpu.hierarchyCpuSampleMs)),
      readHierarchyYamlCpuSampleMs: distribution(profiles.map((profile) => profile.cpu.readHierarchyYamlCpuSampleMs)),
      postReadGroupingCpuSampleMs: distribution(profiles.map((profile) => profile.cpu.postReadGroupingCpuSampleMs)),
    };
  }
  groups[`${size}/${mode}`] = group;
}

await save(join(resultRoot, 'summary.json'), {
  environment,
  groups,
  runs: runRecords.map(({ size, mode, repeat, output, status }) => ({ size, mode, repeat, output, status })),
});
