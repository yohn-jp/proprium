import { counts, gitCommands } from './instrument-node.mjs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { git } from './dataset.mjs';
import { measure, save, distribution } from './common.mjs';
const { CoreStore } = await import('../../packages/core/dist/index.js');
const [datasetPath, output, repeatsArg = '20', workload = 'read'] = process.argv.slice(2);
const dataset = JSON.parse(await readFile(join(datasetPath, 'dataset.json'), 'utf8'));
const runId = randomUUID();
const remote = join(datasetPath, `run-${runId}.git`);
git(datasetPath, 'clone', '--bare', dataset.remote, remote);
const store = new CoreStore({ dataDir: join(datasetPath, `state-${runId}`), allowLocalRemotes: true });
const report = { dataset, profile: 'core', node: process.version, workload, samples: [], summaries: {}, gitCommands, status: 'running' };
async function sample(name, action) {
  report.pending = { name, startedAt: new Date().toISOString() }; await save(output, report);
  const result = await measure(name, action, () => ({ ...counts }));
  delete report.pending;
  report.samples.push(result.sample);
  report.summaries[name] = distribution(report.samples.filter(s => s.name === name).map(s => s.ms));
  await save(output, report);
  return result.value;
}
try {
  const project = await sample('register', () => store.registerProject({ url: remote }));
  if (workload === 'read') {
  await sample('tree.cold', () => store.readTreeSnapshot(project.id));
  const repeats = Number(repeatsArg);
  for (let i = 0; i < repeats; i++) {
    await sample('tree.warm', () => store.readTreeSnapshot(project.id));
    await sample('snapshot.scene', () => store.readSceneSnapshot(project.id, `scene-${i % 3 + 1}`));
  }
  }
  if (workload === 'mutation') {
  const repeats = Number(repeatsArg);
  // Use canonical saveScene: this performs the existing revision-fenced checkpoint path.
  for (let i = 0; i < Math.min(repeats, 5); i++) {
    const scene = await store.readScene(project.id, 'scene-1');
    await sample('checkpoint', () => store.saveScene(project.id, 'scene-1', { revision: scene.revision, text: `${scene.text}\nSynthetic checkpoint ${i}.` }));
    const publication = await sample('publish', () => store.publish(project.id, randomUUID()));
    if (publication.state !== 'confirmed') throw new Error(`Publication state: ${publication.state}`);
  }
  }
  if (workload === 'search') await sample('search.scan', () => store.searchSnapshot(project.id, 'Synthetic', 20));
  if (workload === 'stats') await sample('stats.scan', () => store.writingStatsSnapshot(project.id));
  if (workload === 'revisions') {
    const reader = await sample('reader.create', () => store.reader(project.id));
    await sample('reader.list', () => reader.list());
    await sample('reader.listRevisions.cold', () => reader.listRevisions());
    await sample('reader.listRevisions.warm', () => reader.listRevisions());
  }
  report.status = 'complete';
} catch (error) { report.status = 'failed'; report.error = { message: error.message, code: error.code }; process.exitCode = 1; }
await save(resolve(output), report);
