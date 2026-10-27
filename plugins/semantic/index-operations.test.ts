import assert from 'node:assert/strict';
import test from 'node:test';
import { rebuildIndex, queryIndex } from './index-operations.ts';
const snapshot = { id: 's', local_commit: null, worktree_generation: 'w', draft_generation: null };
const scope = { workspace_id: 'w', repository_id: 1, branch: 'main', generation: 'g' };
const context: any = { snapshot, scope, idempotency_key: 'op' };
const revision = 'a'.repeat(64);
const files: Record<string,string> = { 'plot/scenes/a.yaml': 'id: scene-a\ntype: scene\nmanuscript: manuscript/custom.md\n', 'manuscript/custom.md': '星が見える。' };
const vector = [1,...Array(383).fill(0)];
function* request(operation: string, payload: any): Generator<any, any, any> { return yield { operation, payload }; }
const host: any = { request };
let stored: any;
function run(generator: Generator<any,any,any>) {
 let state = generator.next();
 while (!state.done) {
   const { operation, payload } = state.value; let value: any;
   if (operation === 'workspace.derived.cache.get') value = stored ? { found: true, value: stored } : { found: false };
   else if (operation === 'workspace.derived.cache.put') { if (payload.key.key === 'semantic-index-v2') stored = payload.value; value = { stored: true }; }
   else if (operation === 'workspace.file.list') value = { entries: Object.entries(files).map(([path,text]) => ({path, revision, byte_length: new TextEncoder().encode(text).length, media_type:'text/plain'})), next_cursor:null };
   else if (operation === 'workspace.file.read') { const bytes=[...new TextEncoder().encode(files[payload.path]!)]; value={revision,total_bytes:bytes.length,offset:0,bytes,next_offset:null}; }
   else throw new Error(operation);
   state = generator.next(value);
 }
 return state.value;
}
const engine: any = { *ensure() {}, embed: (texts: string[]) => texts.map(() => vector), model: () => ({ id:'test', revision:'1', role:'embedding', digest:null, byte_length:null, license:'MIT', status:'ready' }) };
test('rebuild stores only hashed metadata and query re-reads exact pinned evidence', async () => {
 stored = undefined; const result = run(rebuildIndex({ taskId:'t' }, context, host, engine));
 assert.equal(result.embedded, 1); assert.equal(JSON.stringify(stored).includes('星が見える。'), false);
 const query = run(queryIndex({ query:'星', granularity:'sentence', limit:10 }, context, host, engine));
 assert.equal(query.results[0].entityId, 'scene-a'); assert.equal(query.results[0].evidence[0].quote, '星が見える。');
 const { readFile } = await import('node:fs/promises');
 const schemaPath: string = '../../app/src/browser/proprium/authoring/schema.ts';
 const { assertValue } = await import(schemaPath);
 const manifest = JSON.parse(await readFile(new URL('./plugin.json', import.meta.url), 'utf8'));
 assertValue(manifest.actions.find((action: any) => action.action_id === 'proprium.semantic.index.rebuild').output_schema, result);
 assertValue(manifest.actions.find((action: any) => action.action_id === 'proprium.semantic.passages.query').output_schema, query);
 assert.equal(run(rebuildIndex({ taskId:'t2' }, context, host, engine)).reused, 1);
});
test('query rejects source changes after index construction instead of returning stale evidence', () => {
 stored = undefined; run(rebuildIndex({ taskId:'t' }, context, host, engine));
 const previous = files['manuscript/custom.md']; files['manuscript/custom.md'] = '月が見える。';
 try { assert.throws(() => run(queryIndex({ query:'星', granularity:'sentence', limit:10 }, context, host, engine)), (error: any) => error.code === 'index_stale'); }
 finally { files['manuscript/custom.md'] = previous!; }
});
test('contradiction page returns source-grounded midband pairs without invoking a model', async () => {
 const { contradictionPage } = await import('./index-operations.ts');
 stored = undefined;
 files['bible/characters/a.yaml'] = 'id: character-a\ntype: character\nname: 星乃\n';
 files['plot/scenes/b.yaml'] = 'id: scene-b\ntype: scene\nmanuscript: manuscript/other.md\n';
 files['manuscript/custom.md'] = '星乃は駅にいた。'; files['manuscript/other.md'] = '星乃は海にいた。';
 const second = [0.5, Math.sqrt(0.75), ...Array(382).fill(0)];
 const engine2: any = { ...engine, embed: (texts: string[]) => texts.map((text) => text.includes('海') ? second : vector) };
 try {
   run(rebuildIndex({ taskId: 't' }, context, host, engine2));
   const result = run(contradictionPage({ limit: 1 }, context, host, engine2));
   assert.equal(result.indexAvailable, true);
   assert.equal(result.candidates.length, 1);
   assert.equal(result.candidates[0].entityId, 'character-a');
   const { readFile } = await import('node:fs/promises');
   const schemaPath: string = '../../app/src/browser/proprium/authoring/schema.ts';
   const { assertValue } = await import(schemaPath);
   const manifest = JSON.parse(await readFile(new URL('./plugin.json', import.meta.url), 'utf8'));
   assertValue(manifest.actions.find((action: any) => action.action_id === 'proprium.semantic.contradictions.candidates').output_schema, result);
   assert.match(result.candidates[0].evidenceA.quote, /星乃/u);
   assert.match(result.candidates[0].evidenceB.quote, /星乃/u);
 } finally {
   delete files['bible/characters/a.yaml']; delete files['plot/scenes/b.yaml']; delete files['manuscript/other.md']; files['manuscript/custom.md'] = '星が見える。';
 }
});
test('failed embedding leaves the previous cache untouched', () => {
 stored = undefined;
 const failing: any = { ...engine, embed: () => { throw Object.assign(new Error('model failed'), { code: 'model_unavailable' }); } };
 assert.throws(() => run(rebuildIndex({ taskId: 'failed' }, context, host, failing)), /model failed/u);
 assert.equal(stored, undefined);
});
test('oversized atomic index fails before loading the model or publishing a partial index', () => {
 stored = undefined;
 const previous = files['manuscript/custom.md']; files['manuscript/custom.md'] = '星を見る。'.repeat(257);
 let loaded = false;
 const bounded: any = { ...engine, *ensure() { loaded = true; } };
 try {
   assert.throws(() => run(rebuildIndex({ taskId:'large' }, context, host, bounded)), (error: any) => error.code === 'capacity');
   assert.equal(loaded, false); assert.equal(stored, undefined);
 } finally { files['manuscript/custom.md'] = previous!; }
});
test('a 120-passage work fits in the atomic index without caching prose', () => {
 stored = undefined;
 const previous = files['manuscript/custom.md']; files['manuscript/custom.md'] = '星を見る。'.repeat(120);
 try {
   const result = run(rebuildIndex({ taskId:'fixture120' }, context, host, engine));
   assert.equal(result.embedded, 120);
   assert.equal(stored.passages.length, 120);
   assert.ok(new TextEncoder().encode(JSON.stringify(stored)).length < 700_000);
   assert.equal(JSON.stringify(stored).includes('星を見る。'), false);
 } finally { files['manuscript/custom.md'] = previous!; }
});
test('active rebuild reports progress, supports cooperative cancellation and leaves the complete index alone', async () => {
 const { semanticTasks, cancelSemanticTask } = await import('./tasks.ts');
 const previous = { sentinel: 'previous complete index' }; stored = previous;
 const generator = rebuildIndex({ taskId: 'cancel-me' }, context, host, engine);
 const first = generator.next();
 assert.equal(first.value.operation, 'workspace.derived.cache.put');
 assert.deepEqual(first.value.payload.value, { taskId: 'cancel-me', phase: 'cache_validation', completed: 0, total: 1 });
 assert.deepEqual(semanticTasks(), [first.value.payload.value]);
 assert.equal(cancelSemanticTask('other'), false);
 assert.equal(cancelSemanticTask('cancel-me'), true);
 assert.equal(cancelSemanticTask('cancel-me'), false);
 assert.throws(() => generator.next({ stored: true }), (error: any) => error.code === 'cancelled');
 assert.equal(stored, previous);
 assert.deepEqual(semanticTasks(), []);
 assert.equal(cancelSemanticTask('cancel-me'), false);
});
test('a second active task is rejected and disposing a generator clears its task', async () => {
 const { semanticTasks } = await import('./tasks.ts');
 const first = rebuildIndex({ taskId: 'first' }, context, host, engine);
 first.next();
 const second = rebuildIndex({ taskId: 'second' }, context, host, engine);
 assert.throws(() => second.next(), (error: any) => error.code === 'capacity');
 assert.equal(semanticTasks()[0]?.taskId, 'first');
 first.return(undefined);
 assert.deepEqual(semanticTasks(), []);
});
test('contradiction pages default to 50 and reject cursors from another snapshot', async () => {
 const { contradictionPage } = await import('./index-operations.ts');
 stored = undefined;
 files['bible/characters/a.yaml'] = 'id: character-a\ntype: character\nname: 星乃\n';
 const previous = files['manuscript/custom.md'];
 files['manuscript/custom.md'] = Array.from({length: 16}, (_, i) => `星乃は${i % 2 ? '海' : '駅'}にいた。`).join('');
 const second = [0.5, Math.sqrt(0.75), ...Array(382).fill(0)];
 const engine2: any = { ...engine, embed: (texts: string[]) => texts.map((text) => text.includes('海') ? second : vector) };
 try {
   run(rebuildIndex({ taskId: 'page' }, context, host, engine2));
   const first = run(contradictionPage({}, context, host, engine2));
   assert.equal(first.candidates.length, 50);
   assert.equal(first.complete, false);
   const next = run(contradictionPage({ cursor: first.nextCursor }, context, host, engine2));
   assert.equal(next.candidates.length, 14);
   assert.equal(next.complete, true);
   assert.throws(() => run(contradictionPage({ cursor: 'semantic1.' + 'f'.repeat(64) + '.0' }, context, host, engine2)), (error: any) => error.code === 'snapshot_stale');
 } finally {
   delete files['bible/characters/a.yaml']; files['manuscript/custom.md'] = previous!;
 }
});
