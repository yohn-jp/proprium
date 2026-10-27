import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { validateEmbeddingBatch } from './inference.ts';

test('accepts cross-realm Float32Array vectors from composed WASM', () => {
 const vector = runInNewContext('new Float32Array(384).fill(0.25)');
 assert.equal(vector instanceof Float32Array, false);
 const result = validateEmbeddingBatch([vector], 1);
 assert.equal(result[0]!.length, 384);
 assert.equal(result[0]![0], 0.25);
});

test('rejects corrupt or wrong-size inference vectors', () => {
 assert.throws(() => validateEmbeddingBatch([new Float32Array([1])], 1), (error: any) => error.code === 'model_unavailable');
});
