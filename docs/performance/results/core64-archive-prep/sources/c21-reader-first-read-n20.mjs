import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = process.env.SCRIPTORIUM_REPO;
const [fixtureArg, outputArg, repeatsArg = '20'] = process.argv.slice(2);
if (!repo || !fixtureArg || !outputArg) throw new Error('set SCRIPTORIUM_REPO and pass <fixture> <output.json> [samples=20]');
const fixture = path.resolve(fixtureArg);
const output = path.resolve(outputArg);
const repeats = Number(repeatsArg);
if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error('samples must be a positive integer');
const manifest = JSON.parse(await fs.readFile(path.join(fixture, 'dataset.json'), 'utf8'));
if (!manifest.syntheticOnly || !manifest.remote) throw new Error('fixture must be a generated synthetic dataset');
const localImport = (file) => import(pathToFileURL(path.join(repo, file)).href);
const { counts, gitCommands } = await localImport('scripts/performance/instrument-node.mjs');
const { measure, distribution } = await localImport('scripts/performance/common.mjs');
const { CoreStore } = await localImport('packages/core/dist/index.js');
const { createDocumentSource } = await localImport('packages/contracts/dist/index.js');
const taskDir = await fs.mkdtemp(path.join(os.tmpdir(), 'c64-g2-first-read-n20-'));
const report = {
  harness: {
    source: execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    node: process.version,
    dataset: manifest.datasetId,
    datasetCommit: manifest.commit,
    workload: 'DocumentSource.readMany(one deep manuscript path), first read on a fresh reader',
    samples: repeats,
    readerCreationTimed: false,
  },
  proof: {},
  samples: [],
};

function commandCounts() {
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
  const listingReader = await store.reader(project.id, 'remote', observed.snapshot);
  const deepPaths = (await listingReader.list('manuscript')).filter((item) => item.split('/').length >= 4).sort();
  const filePath = deepPaths[0];
  if (!filePath) throw new Error('fixture has no deep manuscript path');
  const bytes = await fs.readFile(path.join(fixture, 'seed', ...filePath.split('/')));
  const expected = {
    path: filePath,
    content: bytes.toString('utf8'),
    revision: createHash('sha256').update(bytes).digest('hex'),
  };
  report.proof = {
    deepPathCount: deepPaths.length,
    path: filePath,
    byteLength: bytes.byteLength,
    revision: expected.revision,
    exactContentAndRevisionAssertions: repeats,
  };

  for (let index = 0; index < repeats; index += 1) {
    const reader = await store.reader(project.id, 'remote', observed.snapshot);
    const source = createDocumentSource(reader);
    gitCommands.length = 0;
    const result = await measure('fresh-reader-first-read', () => source.readMany([filePath]), () => ({ ...counts }));
    assert.deepEqual(result.value, [expected]);
    report.samples.push({ ...result.sample, gitSubcommands: commandCounts() });
  }
  report.summary = {
    elapsedMs: distribution(report.samples.map((sample) => sample.ms)),
    gitProcesses: distribution(report.samples.map((sample) => sample.counters.gitProcesses)),
    userCpuUs: distribution(report.samples.map((sample) => sample.cpuUs.user)),
    systemCpuUs: distribution(report.samples.map((sample) => sample.cpuUs.system)),
    rssBytes: distribution(report.samples.map((sample) => sample.rssBytes)),
    maxRssKiB: distribution(report.samples.map((sample) => sample.maxRssKiB)),
    gitSubcommands: report.samples[0]?.gitSubcommands ?? {},
  };
} finally {
  await fs.rm(taskDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
}
