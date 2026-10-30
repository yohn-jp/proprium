import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertAuthoringDeclarations } from '../../scripts/authoring-manifest-schema.mjs';
import { assertValue } from '../../app/src/browser/proprium/authoring/schema.ts';

test('Semantic declarations satisfy the Host manifest contract and indexed task result variants', async () => {
  const manifest = JSON.parse(await readFile(new URL('./plugin.json', import.meta.url), 'utf8'));
  await assertAuthoringDeclarations(manifest.id, manifest.capabilities, manifest.actions, manifest.ui);

  const snapshot = { id: 'pin', local_commit: null, worktree_generation: 'generation', draft_generation: null };
  for (const actionId of ['proprium.semantic.index.rebuild', 'proprium.semantic.index.step']) {
    const schema = manifest.actions.find(action => action.action_id === actionId).output_schema;
    const running = { snapshot, taskId: 'index-task', state: 'running', phase: 'embedding', completed: 2, total: 5 };
    const complete = { snapshot, taskId: 'index-task', state: 'complete', phase: 'complete', completed: 5, total: 5,
      result: { scanned: 2, embedded: 5, reused: 0, removed: 0, indexedGeneration: 'generation' } };
    assertValue(schema, running, `${actionId} running output`);
    assertValue(schema, complete, `${actionId} complete output`);
    assert.throws(() => assertValue(schema, { ...running, result: complete.result }, `${actionId} running output`));
    assert.throws(() => assertValue(schema, { ...complete, result: undefined }, `${actionId} complete output`));
  }

  for (const actionId of ['proprium.semantic.reranker.prepare', 'proprium.semantic.reranker.prepare.step']) {
    const schema = manifest.actions.find(action => action.action_id === actionId).output_schema;
    const running = { snapshot, taskId: 'bge-task', state: 'running', phase: 'load_tensors', completed: 64, total: 8733 };
    const complete = { snapshot, taskId: 'bge-task', state: 'complete', phase: 'complete', completed: 8733, total: 8733,
      modelId: 'mogolloni/bge-reranker-v2-m3-onnx', modelRevision: 'e5023553f6c47f09057da7a19cdd79ef850a4985',
      groupId: 'proprium.semantic.reranker.bge-v2-m3' };
    assertValue(schema, running, `${actionId} running output`);
    assertValue(schema, complete, `${actionId} complete output`);
    assert.throws(() => assertValue(schema, { ...running, total: 2_288_661_281 }, `${actionId} running output`));
    assert.throws(() => assertValue(schema, { ...complete, memoryBytes: 0 }, `${actionId} complete output`));
  }
  const prepare = manifest.actions.find(action => action.action_id === 'proprium.semantic.reranker.prepare');
  assert.equal(prepare.requires_user_gesture, true);
  const step = manifest.actions.find(action => action.action_id === 'proprium.semantic.reranker.prepare.step');
  assert.equal(step.requires_user_gesture, false);
  assert.ok(prepare.required_capabilities.includes('plugin.preferences'));
  assert.ok(step.required_capabilities.includes('workspace.asset.read'));
  const rerank = manifest.actions.find(action => action.action_id === 'proprium.semantic.rerank');
  assert.ok(rerank.required_capabilities.includes('workspace.file.read'), 'reranking must retain the explicit pinned source read grant');
  assert.ok(rerank.required_capabilities.includes('plugin.preferences'));
});
