import { counts, gitCommands } from './instrument-node.mjs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { git } from './dataset.mjs';
import { measure, save, distribution } from './common.mjs';
const { CoreStore } = await import('../../packages/core/dist/index.js');
const [datasetPath, output, repeatsArg = '20', workload = 'read'] = process.argv.slice(2);
const dataset = JSON.parse(await readFile(join(datasetPath, 'dataset.json'), 'utf8'));
const runId = randomUUID();
const remote = join(datasetPath, `run-${runId}.git`);
git(datasetPath, 'clone', '--bare', dataset.remote, remote);
const store = new CoreStore({ dataDir: join(datasetPath, `state-${runId}`), allowLocalRemotes: true });
const harness = { source: git(process.cwd(), 'rev-parse', 'HEAD'), scriptSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex') };
const report = { harness, dataset, profile: 'core', node: process.version, workload, samples: [], summaries: {}, gitCommands, status: 'running' };
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
  if (workload === 'mutation' || workload === 'legacy') {
  const repeats = Number(repeatsArg);
  // Keep the author proposal/approval/checkpoint path distinct from legacy saveScene.
  for (let i = 0; i < Math.min(repeats, 5); i++) {
    if (workload === 'legacy') {
      const scene = await store.readScene(project.id, 'scene-1');
      await sample('legacy.saveSceneCheckpoint', () => store.saveScene(project.id, 'scene-1', { revision: scene.revision, text: `${scene.text}\nSynthetic checkpoint ${i}.` }));
    } else {
      const scene = await sample('mutation.prepare', () => store.readSceneSnapshot(project.id, 'scene-1', 'checkpoint'));
      const operation = { id: randomUUID(), generation: 1, repository: scene.snapshot.repository,
        baseRemoteCommit: scene.snapshot.remoteCommit, effect: 'manuscript',
        reads: [{ path: scene.document.path, revision: scene.document.revision }],
        writes: [{ path: scene.document.path, revision: scene.document.revision, content: `${scene.document.content}\nSynthetic checkpoint ${i}.` }],
        message: `Synthetic checkpoint ${i}` };
      const proposal = await sample('proposal', () => store.propose(project.id, { id: `proposal_${operation.id}`, snapshot: scene.snapshot, operations: [operation], source: 'author' }));
      await sample('approval', () => store.approve(project.id, { proposalId: proposal.id, operationIds: [operation.id], authorScope: 'synthetic-benchmark-author' }));
      const receipt = await sample('checkpoint', () => store.checkpoint(project.id, operation));
      if (receipt.operationId !== operation.id) throw new Error('Checkpoint receipt operation mismatch');
    }
    const publication = await sample('publish', () => store.publish(project.id, randomUUID()));
    if (publication.state !== 'confirmed') throw new Error(`Publication state: ${publication.state}`);
  }
  }
  if (workload === 'search') await sample('search.scan', () => store.searchSnapshot(project.id, 'wave0-absent-needle-9f742e', 20));
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
