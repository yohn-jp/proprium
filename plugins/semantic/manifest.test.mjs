import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertAuthoringDeclarations } from '../../scripts/authoring-manifest-schema.mjs';
import { assertValue } from '../../app/src/browser/proprium/authoring/schema.ts';

test('Semantic declarations satisfy the adopted Host manifest contract and index result variants', async () => {
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
});
