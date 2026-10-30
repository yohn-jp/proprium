import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { E5_ASSET_TOTAL_BYTES, E5_MODEL, ensureEmbeddingStep, releaseEmbedding, setInferenceBindings, validateEmbeddingBatch } from './inference.ts';

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

test('model asset reads use the bounded Host transfer ceiling and yield after four chunks', () => {
 let appended = 0;
 setInferenceBindings({
  beginAsset() {}, appendAsset(_group, _path, _offset, bytes) { appended += bytes.length; }, finishAsset() {},
  loadEmbedding() {}, embedPassages: () => [], release() {}, splitSentenceEnds: () => [],
 });
 const host = { *request(operation: string, payload: Record<string, unknown>) { return yield { operation, payload }; } } as any;
 const job = ensureEmbeddingStep(host, 4);
 let state = job.next(); let calls = 0;
 while (!state.done) {
  assert.equal(state.value.operation, 'workspace.asset.read');
  assert.equal(state.value.payload.length, 256 * 1024);
  const offset = state.value.payload.offset as number;
  const length = Math.min(256 * 1024, E5_MODEL.model_bytes - offset);
  assert.equal(state.value.payload.file_path, E5_MODEL.model_path);
  assert.equal(Number.isSafeInteger(offset), true);
  const response = {
   group_id: 'proprium.semantic.embedding.e5-small', file_path: E5_MODEL.model_path,
   offset, total_bytes: E5_MODEL.model_bytes, bytes: Array.from({ length }, () => 0),
   sha256: E5_MODEL.model_sha256, next_offset: offset + length === E5_MODEL.model_bytes ? null : offset + length,
  };
  assert.equal(response.group_id, 'proprium.semantic.embedding.e5-small');
  assert.equal(response.file_path, E5_MODEL.model_path);
  assert.equal(response.offset, offset);
  assert.equal(Number.isSafeInteger(response.total_bytes), true);
  assert.equal(response.bytes.length <= 256 * 1024, true);
  assert.match(response.sha256, /^[a-f0-9]{64}$/u);
  state = job.next(response as any);
  calls += 1;
 }
 assert.equal(calls, 4);
 assert.equal(appended, 4 * 256 * 1024);
 assert.deepEqual(state.value, { ready: false, completed: 4 * 256 * 1024, total: E5_ASSET_TOTAL_BYTES });
 releaseEmbedding();
});
