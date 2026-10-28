import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseSemanticIndex, startIndexBuild, stepIndexBuild, queryIndex } from './index-operations.ts';
const snapshot = { id: 's', local_commit: null, worktree_generation: 'w', draft_generation: null };
const scope = { workspace_id: 'w', repository_id: 1, branch: 'main', generation: 'g' };
const context: any = { snapshot, scope, idempotency_key: 'op' };
const revision = 'a'.repeat(64);
const files: Record<string,string> = { 'plot/scenes/a.yaml': 'id: scene-a\ntype: scene\nmanuscript: manuscript/custom.md\n', 'manuscript/custom.md': '星が見える。' };
const vector = [1,...Array(383).fill(0)];
function* request(operation: string, payload: any): Generator<any, any, any> { return yield { operation, payload }; }
const host: any = { request };
let stored: any;
const cache = new Map<string, any>();
const previousCache = new Map<string, any>();
let previousSnapshot: any;
function reset() { releaseSemanticIndex(); stored = undefined; cache.clear(); previousCache.clear(); previousSnapshot = undefined; }
function run(generator: Generator<any,any,any>) {
 let state = generator.next();
 while (!state.done) {
   const { operation, payload } = state.value; let value: any;
   if (operation === 'workspace.derived.cache.get') value = cache.has(payload.key.key) ? { found: true, value: cache.get(payload.key.key) } : { found: false };
   else if (operation === 'workspace.derived.cache.get_previous') value = previousCache.has(payload.selector.key) ? { found: true, snapshot: previousSnapshot, value: previousCache.get(payload.selector.key) } : { found: false };
   else if (operation === 'workspace.derived.cache.put') { cache.set(payload.key.key,payload.value); if (payload.key.key === 'semantic-index-v3-manifest') stored = payload.value; value = { stored: true }; }
   else if (operation === 'workspace.derived.cache.evict') { cache.delete(payload.key.key); value = { evicted: true }; }
   else if (operation === 'workspace.derived.cache.evict_prefix') { for (const key of cache.keys()) if (key.startsWith(payload.selector.key_prefix)) cache.delete(key); value = { evicted: true, count: 0 }; }
   else if (operation === 'workspace.derived.cache.evict_previous') { const evicted = previousCache.delete(payload.selector.key); value = { evicted, count: evicted ? 1 : 0 }; }
   else if (operation === 'workspace.derived.cache.evict_previous_prefix') { let count = 0; for (const key of previousCache.keys()) if (key.startsWith(payload.selector.key_prefix)) { previousCache.delete(key); count += 1; } value = { evicted: count > 0, count }; }
   else if (operation === 'workspace.file.list') value = { entries: Object.entries(files).map(([path,text]) => ({path, revision, byte_length: new TextEncoder().encode(text).length, media_type:'text/plain'})), next_cursor:null };
   else if (operation === 'workspace.file.read') { const bytes=[...new TextEncoder().encode(files[payload.path]!)]; value={revision,total_bytes:bytes.length,offset:0,bytes,next_offset:null}; }
   else throw new Error(operation);
   state = generator.next(value);
 }
 return state.value;
}
const engine: any = { *ensure() {}, embed: (texts: string[]) => texts.map(() => vector), model: () => ({ id:'test', revision:'1', role:'embedding', digest:null, byte_length:null, license:'MIT', status:'ready' }) };
function build(taskId: string, selectedEngine: any = engine) {
 const start = run(startIndexBuild({ taskId }, context, host, selectedEngine));
 if (start.state === 'complete') return { ...start, ...start.result };
 let sequence = 0; let result: any;
 do { result = run(stepIndexBuild({ taskId, sequence: sequence++ }, context, host, selectedEngine)); } while (result.state === 'running');
 return { ...result, ...result.result, output: result };
}
function publishedPassages(): any[] {
 const manifest = cache.get('semantic-index-v3-manifest');
 if (!manifest) return [];
 return Array.from({ length: manifest.pageCount }, (_, pageIndex) => cache.get(`semantic-index-v3-page-${manifest.indexChecksum}-${pageIndex}`)?.passages ?? []).flat();
}
test('rebuild starts quickly; bounded steps store only hashed metadata and query re-reads exact pinned evidence', async () => {
 reset(); const accepted = run(startIndexBuild({ taskId:'t' }, context, host, engine));
 assert.equal(accepted.state, 'running');
 assert.equal(accepted.phase, 'source_scan');
 const result = build('t');
 assert.equal(result.embedded, 1); assert.equal(JSON.stringify(stored).includes('星が見える。'), false);
 const query = run(queryIndex({ query:'星', granularity:'sentence', limit:10 }, context, host, engine));
 assert.equal(query.results[0].entityId, 'scene-a'); assert.equal(query.results[0].evidence[0].quote, '星が見える。');
 const { readFile } = await import('node:fs/promises');
 const schemaPath: string = '../../app/src/browser/proprium/authoring/schema.ts';
 const { assertValue } = await import(schemaPath);
 const manifest = JSON.parse(await readFile(new URL('./plugin.json', import.meta.url), 'utf8'));
 assertValue(manifest.actions.find((action: any) => action.action_id === 'proprium.semantic.index.rebuild').output_schema, accepted);
 assertValue(manifest.actions.find((action: any) => action.action_id === 'proprium.semantic.index.step').output_schema, result.output);
 assertValue(manifest.actions.find((action: any) => action.action_id === 'proprium.semantic.passages.query').output_schema, query);
 assert.equal(build('t2').reused, 1);
});
test('a cached index can warm the signed model through bounded scheduler steps after reload', () => {
 reset();
 build('indexed-before-reload');
 let ready = false; let loads = 0;
 const warming: any = { ...engine, model: () => ({ ...engine.model(), status: ready ? 'ready' : 'unavailable' }), *ensureStep() {
  loads += 1; ready = loads === 2; return { ready, completed: loads * 4, total: 8 };
 } };
 const start = run(startIndexBuild({ taskId:'warm' }, context, host, warming));
 assert.equal(start.state, 'running'); assert.equal(start.phase, 'model_loading');
 assert.throws(() => run(queryIndex({ query:'星', granularity:'sentence', limit:10 }, context, host, warming)), (error: any) => error.code === 'provider_unavailable');
 const first = run(stepIndexBuild({ taskId:'warm', sequence:0 }, context, host, warming));
 assert.equal(first.state, 'running'); assert.equal(first.completed, 4);
 const complete = run(stepIndexBuild({ taskId:'warm', sequence:1 }, context, host, warming));
 assert.equal(complete.state, 'complete'); assert.equal(complete.result.reused, 1); assert.equal(ready, true);
});
test('a new Host pin lease reuses an unchanged prior index and starts model warming', () => {
 reset(); build('before-new-pin');
 const originalSnapshot = context.snapshot, originalScope = context.scope;
 for (const [key, value] of cache) previousCache.set(key, value);
 previousSnapshot = originalSnapshot;
 cache.clear();
 context.snapshot = { ...originalSnapshot, id: 'new-pin-id' };
 context.scope = { ...originalScope, generation: 'new-host-activation' };
 let loads = 0; let ready = false;
 const warming: any = { ...engine, model: () => ({ ...engine.model(), status: ready ? 'ready' : 'unavailable' }), *ensureStep() {
  loads += 1; ready = loads === 2; return { ready, completed: loads * 4, total: 8 };
 } };
 try {
  const start = run(startIndexBuild({ taskId:'same-source-warm' }, context, host, warming));
  assert.equal(start.state, 'running'); assert.equal(start.phase, 'model_loading');
  const first = run(stepIndexBuild({ taskId:'same-source-warm', sequence:0 }, context, host, warming));
  assert.equal(first.phase, 'model_loading'); assert.equal(first.completed, 4);
  const complete = run(stepIndexBuild({ taskId:'same-source-warm', sequence:1 }, context, host, warming));
  assert.equal(complete.state, 'complete'); assert.equal(complete.result.reused, 1); assert.equal(ready, true);
 } finally { context.snapshot = originalSnapshot; context.scope = originalScope; }
});
test('cross-snapshot reuse validates previous page hashes and evicts only that previous generation after commit', () => {
 reset();
 build('first-generation');
 for (const [key, value] of cache) previousCache.set(key, value);
 previousSnapshot = context.snapshot;
 cache.clear();
 const oldSnapshot = context.snapshot;
 context.snapshot = { id:'s2', local_commit:null, worktree_generation:'w2', draft_generation:null };
 try {
  const rebuilt = build('second-generation');
  assert.equal(rebuilt.state, 'complete');
  assert.equal(rebuilt.reused, 1);
  assert.equal(rebuilt.embedded, 0);
  assert.equal(publishedPassages().length, 1);
  assert.equal(previousCache.size, 0);
 } finally { context.snapshot = oldSnapshot; }
});
test('a previous cache from another branch is rejected and never reused', () => {
 reset();
 build('scope-source');
 for (const [key, value] of cache) previousCache.set(key, value);
 previousSnapshot = context.snapshot;
 cache.clear();
 const oldScope = context.scope; const oldSnapshot = context.snapshot;
 context.scope = { ...scope, branch:'other-branch' };
 context.snapshot = { id:'other-branch-snapshot', local_commit:null, worktree_generation:'other-worktree', draft_generation:null };
 try {
  const rebuilt = build('scope-target');
  assert.equal(rebuilt.reused, 0);
  assert.equal(rebuilt.embedded, 1);
  assert.equal(publishedPassages().length, 1);
  assert.equal(previousCache.has('semantic-index-v3-manifest'), true);
 } finally { context.scope = oldScope; context.snapshot = oldSnapshot; }
});
test('a fresh worker resumes persisted vectors and a partial page generation before manifest commit', async () => {
 reset();
 const previous = files['manuscript/custom.md']; files['manuscript/custom.md'] = '星を見る。'.repeat(5);
 const worker = async () => await import(`./index-operations.ts?restart=${Math.random()}`);
 try {
  const first = await worker();
  const start = run(first.startIndexBuild({ taskId:'restartable' }, context, host, engine));
  assert.equal(start.state, 'running');
  const slice0 = run(first.stepIndexBuild({ taskId:'restartable', sequence:0 }, context, host, engine));
  assert.equal(slice0.phase, 'embedding'); assert.equal(slice0.completed, 2);
  const second = await worker();
  const slice1 = run(second.stepIndexBuild({ taskId:'restartable', sequence:1 }, context, host, engine));
  assert.equal(slice1.phase, 'embedding'); assert.equal(slice1.completed, 4);
  const third = await worker();
  const slice2 = run(third.stepIndexBuild({ taskId:'restartable', sequence:2 }, context, host, engine));
  assert.equal(slice2.phase, 'cache_publish'); assert.equal(publishedPassages().length, 0);
  const fourth = await worker();
  const complete = run(fourth.stepIndexBuild({ taskId:'restartable', sequence:3 }, context, host, engine));
  assert.equal(complete.state, 'complete'); assert.equal(publishedPassages().length, 5);
 } finally { files['manuscript/custom.md'] = previous!; }
});
test('a new Host pin lease resumes vectors from the prior pin after revalidating source hashes', async () => {
 reset();
 const originalText = files['manuscript/custom.md']; const originalSnapshot = context.snapshot, originalScope = context.scope;
 files['manuscript/custom.md'] = '星を見る。'.repeat(5);
 let embedded = 0;
 const counted: any = { ...engine, embed: (texts: string[]) => { embedded += texts.length; return texts.map(() => vector); } };
 const worker = async () => await import(`./index-operations.ts?pin-restart=${Math.random()}`);
 try {
  const first = await worker();
  run(first.startIndexBuild({ taskId:'pin-resumable' }, context, host, counted));
  const slice0 = run(first.stepIndexBuild({ taskId:'pin-resumable', sequence:0 }, context, host, counted));
  assert.equal(slice0.phase, 'embedding'); assert.equal(slice0.completed, 2); assert.equal(embedded, 2);
  for (const [key, value] of cache) previousCache.set(key, value);
  previousSnapshot = originalSnapshot;
  cache.clear();
  context.snapshot = { ...originalSnapshot, id: 'reloaded-pin-id' };
  context.scope = { ...originalScope, generation: 'reloaded-host-generation' };

  const second = await worker();
  const slice1 = run(second.stepIndexBuild({ taskId:'pin-resumable', sequence:1 }, context, host, counted));
  assert.equal(slice1.phase, 'embedding'); assert.equal(slice1.completed, 4); assert.equal(embedded, 4);
  const slice2 = run(second.stepIndexBuild({ taskId:'pin-resumable', sequence:2 }, context, host, counted));
  assert.equal(slice2.phase, 'cache_publish'); assert.equal(embedded, 5);
  const complete = run(second.stepIndexBuild({ taskId:'pin-resumable', sequence:3 }, context, host, counted));
  assert.equal(complete.state, 'complete'); assert.equal(publishedPassages().length, 5);
  assert.equal(previousCache.has('semantic-index-staging-control-v1'), false);
  assert.equal([...previousCache.keys()].some(key => key.startsWith('semantic-index-staging-chunk-v1-')), false);
 } finally { files['manuscript/custom.md'] = originalText; context.snapshot = originalSnapshot; context.scope = originalScope; }
});
test('query rejects source changes after index construction instead of returning stale evidence', () => {
 reset(); build('t');
 const previous = files['manuscript/custom.md']; files['manuscript/custom.md'] = '月が見える。';
 try { assert.throws(() => run(queryIndex({ query:'星', granularity:'sentence', limit:10 }, context, host, engine)), (error: any) => error.code === 'index_stale'); }
 finally { files['manuscript/custom.md'] = previous!; }
});
test('contradiction page returns source-grounded midband pairs without invoking a model', async () => {
 const { contradictionPage } = await import('./index-operations.ts');
 reset();
 files['bible/characters/a.yaml'] = 'id: character-a\ntype: character\nname: 星乃\n';
 files['plot/scenes/b.yaml'] = 'id: scene-b\ntype: scene\nmanuscript: manuscript/other.md\n';
 files['manuscript/custom.md'] = '星乃は駅にいた。'; files['manuscript/other.md'] = '星乃は海にいた。';
 const second = [0.5, Math.sqrt(0.75), ...Array(382).fill(0)];
 const engine2: any = { ...engine, embed: (texts: string[]) => texts.map((text) => text.includes('海') ? second : vector) };
 try {
   build('t', engine2);
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
 reset();
 const failing: any = { ...engine, embed: () => { throw Object.assign(new Error('model failed'), { code: 'model_unavailable' }); } };
 const start = run(startIndexBuild({ taskId:'failed' }, context, host, engine));
 assert.equal(start.state, 'running');
 assert.throws(() => run(stepIndexBuild({ taskId:'failed', sequence:0 }, context, host, failing)), /model failed/u);
 assert.equal(stored, undefined);
});
test('index progress is split into bounded two-passage steps beyond the former 256-passage cap', () => {
 reset();
 const previous = files['manuscript/custom.md']; files['manuscript/custom.md'] = '星を見る。'.repeat(257);
 const start = run(startIndexBuild({ taskId:'large' }, context, host, engine));
 let sequence = 0; let result: any; let calls = 0;
 try {
  do { result = run(stepIndexBuild({ taskId:'large', sequence:sequence++ }, context, host, engine)); calls += 1; } while (result.state === 'running');
  assert.equal(start.state, 'running');
  assert.equal(result.result.embedded, 257);
  assert.equal(publishedPassages().length, 257);
  assert.equal(calls, Math.ceil(257 / 2) + Math.ceil(Math.ceil(257 / 32) / 4));
 } finally { files['manuscript/custom.md'] = previous!; }
});
test('a 120-passage work fits in the atomic index without caching prose', () => {
 reset();
 const previous = files['manuscript/custom.md']; files['manuscript/custom.md'] = '星を見る。'.repeat(120);
 try {
   const result = build('fixture120');
   assert.equal(result.embedded, 120);
   assert.equal(publishedPassages().length, 120);
   assert.ok(new TextEncoder().encode(JSON.stringify([...cache.values()])).length < 700_000);
   assert.equal(JSON.stringify([...cache.values()]).includes('星を見る。'), false);
 } finally { files['manuscript/custom.md'] = previous!; }
});
test('closing the guest before its first cache write leaves the previous generation intact', () => {
 reset();
 const previousIndex = { sentinel: 'previous complete index' }; stored = previousIndex; cache.set('semantic-index-v2', previousIndex);
 const previous = files['manuscript/custom.md']; files['manuscript/custom.md'] = '星を見る。'.repeat(5);
 try {
  const start = run(startIndexBuild({ taskId:'cancel-me' }, context, host, engine));
  assert.equal(start.state, 'running');
  const generator = stepIndexBuild({ taskId:'cancel-me', sequence:0 }, context, host, engine);
  const first = generator.next();
  assert.equal(first.value.operation, 'workspace.derived.cache.get');
  generator.return(undefined);
  assert.equal(stored, previousIndex);
  const resumed = build('cancel-me');
  assert.equal(resumed.state, 'complete');
  assert.equal(publishedPassages().length, 5);
 } finally { files['manuscript/custom.md'] = previous!; }
});
test('contradiction pages default to 50 and reject cursors from another snapshot', async () => {
 const { contradictionPage } = await import('./index-operations.ts');
 reset();
 files['bible/characters/a.yaml'] = 'id: character-a\ntype: character\nname: 星乃\n';
 const previous = files['manuscript/custom.md'];
 files['manuscript/custom.md'] = Array.from({length: 16}, (_, i) => `星乃は${i % 2 ? '海' : '駅'}にいた。`).join('');
 const second = [0.5, Math.sqrt(0.75), ...Array(382).fill(0)];
 const engine2: any = { ...engine, embed: (texts: string[]) => texts.map((text) => text.includes('海') ? second : vector) };
 try {
   build('page', engine2);
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
