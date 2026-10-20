// Task-owned, untracked probe for C21/C54. Run only after G0 grants the
// measurement lease. It reads synthetic fixtures only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = process.env.SCRIPTORIUM_REPO ?? '/home/sophia/src/scriptorium-c64-g2';
const [fixtureArg, outputArg, repeatsArg = '20'] = process.argv.slice(2);
if (!fixtureArg || !outputArg) {
  throw new Error('usage: node /tmp/c64-g2-deep-reads-probe.mjs <synthetic-fixture> <output.json> [samples=20]');
}
const fixture = path.resolve(fixtureArg);
const output = path.resolve(outputArg);
const repeats = Number(repeatsArg);
if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error('samples must be a positive integer');
const manifest = JSON.parse(await fs.readFile(path.join(fixture, 'dataset.json'), 'utf8'));
if (!manifest.syntheticOnly || !manifest.remote) throw new Error('fixture must be a generated synthetic dataset');

// Install the existing benchmark's process counters before loading Core.
const localImport = (file) => import(pathToFileURL(path.join(repo, file)).href);
const { counts, gitCommands } = await localImport('scripts/performance/instrument-node.mjs');
const { measure, distribution } = await localImport('scripts/performance/common.mjs');
const { CoreStore } = await localImport('packages/core/dist/index.js');
const { createDocumentSource } = await localImport('packages/contracts/dist/index.js');

const taskDir = await fs.mkdtemp(path.join(os.tmpdir(), 'c64-g2-deep-read-'));
const report = {
  harness: {
    source: execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    node: process.version,
    dataset: manifest.datasetId,
    datasetCommit: manifest.commit,
    workload: 'DocumentSource.readMany(deep-manuscript-paths)',
    samplesPerBatchSize: repeats,
    batchSizes: [1, 10, 100],
  },
  scenarios: [],
};

function commandName(args) {
  for (const name of ['ls-tree', 'cat-file']) if (args.includes(name)) return name;
  return 'other';
}

try {
  const isolatedRemote = path.join(taskDir, 'remote.git');
  execFileSync('git', ['clone', '--bare', '--quiet', manifest.remote, isolatedRemote], { stdio: 'ignore' });
  const store = new CoreStore({ dataDir: path.join(taskDir, 'state'), allowLocalRemotes: true });
  const project = await store.registerProject({ url: isolatedRemote });
  const observed = await store.observe(project.id);
  const reader = await store.reader(project.id, 'remote', observed.snapshot);
  const paths = (await reader.list('manuscript')).filter((item) => item.split('/').length >= 4).sort();
  if (paths.length < 100) throw new Error(`fixture has only ${paths.length} deep manuscript paths`);
  const source = createDocumentSource(reader);

  const expected = new Map();
  for (const relativePath of paths.slice(0, 100)) {
    const bytes = await fs.readFile(path.join(fixture, 'seed', ...relativePath.split('/')));
    expected.set(relativePath, {
      path: relativePath,
      content: bytes.toString('utf8'),
      revision: createHash('sha256').update(bytes).digest('hex'),
    });
  }

  // Warm OS/Git object caches outside the measured samples and prove the
  // harness and the fixture agree before collecting timings.
  const warmup = await source.readMany(paths.slice(0, 100));
  assert.deepEqual(warmup, paths.slice(0, 100).map((relativePath) => expected.get(relativePath)));

  for (const batchSize of [1, 10, 100]) {
    const samples = [];
    for (let index = 0; index < repeats; index += 1) {
      gitCommands.length = 0;
      const result = await measure(`readMany.${batchSize}`, () => source.readMany(paths.slice(0, batchSize)),
        () => ({ ...counts }));
      assert.deepEqual(result.value, paths.slice(0, batchSize).map((relativePath) => expected.get(relativePath)));
      const gitSubcommands = {};
      for (const entry of gitCommands) {
        const name = commandName(entry.args);
        gitSubcommands[name] = (gitSubcommands[name] ?? 0) + 1;
      }
      samples.push({ ...result.sample, gitSubcommands });
    }
    report.scenarios.push({
      batchSize,
      samples,
      elapsedMs: distribution(samples.map((sample) => sample.ms)),
      gitProcesses: distribution(samples.map((sample) => sample.counters.gitProcesses)),
    });
  }
} finally {
  await fs.rm(taskDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
}
