import assert from 'node:assert/strict';
import test from 'node:test';
import { makeIndex, validateIndex, rankedIndex } from './index.ts';
const scope = { workspace_id: 'w', repository_id: 1, branch: 'main', generation: 'g' };
const snapshot = { id: 's', local_commit: null, worktree_generation: 'w1', draft_generation: null };
const context: any = { scope, snapshot };
const vector = [1, ...Array(383).fill(0)];
const corpus: any = { scanned: 1, entities: [], passages: [{ entityId: 's1', type: 'manuscript', sourcePath: 'manuscript/s1.md', sourceRevision: 'a'.repeat(64), sentenceIndex: 0, text: '星を見た。', evidence: { path: 'manuscript/s1.md', revision: 'a'.repeat(64), start: 0, end: 5, quote: '星を見た。' } }] };
test('derived index contains vectors and hashed references without author prose', () => {
 const index = makeIndex(context, corpus, [vector]);
 assert.equal(JSON.stringify(index).includes('星を見た。'), false);
 assert.equal(validateIndex(index, context).passages.length, 1);
 assert.equal(rankedIndex(index, vector, 5)[0].entityId, 's1');
});
test('derived index is rejected after snapshot changes or vector corruption', () => {
 const index = makeIndex(context, corpus, [vector]);
 assert.throws(() => validateIndex(index, { ...context, snapshot: { ...snapshot, worktree_generation: 'w2' } }), (error: any) => error.code === 'index_stale');
 assert.throws(() => validateIndex({ ...index, passages: [{ ...index.passages[0], vector: [1] }] }, context), /corrupt/i);
 const changed = [...index.passages[0]!.vector]; changed[0] = 0.25;
 assert.throws(() => validateIndex({ ...index, passages: [{ ...index.passages[0], vector: changed }] }, context), /corrupt/i);
});
test('cosine scores stay within the public schema after floating point rounding', () => {
 const v = Array(384).fill(0); for (let i = 0; i < 11; i++) v[i] = 0.1;
 const index = makeIndex(context, corpus, [v]);
 assert.equal(rankedIndex(index, v, 1)[0]!.cosineScore, 1);
});
