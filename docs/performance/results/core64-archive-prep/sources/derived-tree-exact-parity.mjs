import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [datasetPath, baselineEntry, candidateEntry] = process.argv.slice(2).map((value) => resolve(value));
const dataset = JSON.parse(await (await import('node:fs/promises')).readFile(join(datasetPath, 'dataset.json'), 'utf8'));
assert.equal(dataset.size, 'small');
assert.equal(dataset.files, 10);
assert.equal(dataset.commit, 'e70bb509cc41b383451335e05af36d78f1cb31db');
function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
}
async function treeFor(coreEntry, label) {
  const root = await mkdtemp(join(tmpdir(), `core64-tree-exact-${label}-`));
  try {
    const remote = join(root, 'origin.git');
    git(datasetPath, 'clone', '--bare', dataset.remote, remote);
    const { CoreStore } = await import(pathToFileURL(coreEntry).href);
    const store = new CoreStore({ dataDir: join(root, 'state'), allowLocalRemotes: true });
    try {
      const project = await store.registerProject({ url: remote });
      const result = await store.readTreeSnapshot(project.id);
      const serialized = JSON.stringify(result.tree);
      return { label, tree: result.tree, treeSha256: createHash('sha256').update(serialized).digest('hex') };
    } finally {
      await store.dispose?.();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const baseline = await treeFor(baselineEntry, 'g0');
const candidate = await treeFor(candidateEntry, 'candidate');
assert.deepEqual(candidate.tree, baseline.tree);
process.stdout.write(`${JSON.stringify({ dataset: { size: dataset.size, files: dataset.files, commit: dataset.commit }, baseline, candidate, exactTreeParity: true }, null, 2)}\n`);
