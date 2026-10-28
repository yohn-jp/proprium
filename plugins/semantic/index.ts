import type { ActionRequest } from '../../app/src/browser/proprium/authoring/types.js';
import { cosineSimilarityDense } from './core.ts';
import { E5_MODEL } from './inference.ts';
import { sha256Text } from './sha256.ts';
import type { SemanticCorpus } from './corpus.ts';

export interface IndexedReference { entityId: string; type: string; sourcePath: string; sourceRevision: string; sentenceIndex: number; textHash: string; vector: string }
export interface SemanticIndex { version: 2; scope: ActionRequest['scope']; snapshot: ActionRequest['snapshot']; modelDigest: string; passages: IndexedReference[]; checksum: string }
function failure(code: string, message: string): Error { return Object.assign(new Error(message), { code, retryable: false }); }
function identity(value: unknown): string { return JSON.stringify(value, Object.keys(value as object).sort()); }
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Serialize the E5 model's 384 f32 values as fixed little-endian bytes. */
export function encodeVector(vector: readonly number[]): string {
  if (vector.length !== 384 || vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw failure('model_unavailable', 'Invalid embedding vector');
  const bytes = new Uint8Array(1536); const view = new DataView(bytes.buffer);
  for (let i = 0; i < vector.length; i++) { view.setFloat32(i * 4, vector[i]!, true); if (!Number.isFinite(view.getFloat32(i * 4, true))) throw failure('model_unavailable', 'Embedding exceeds float32 range'); }
  let output = '';
  for (let i = 0; i < bytes.length; i += 3) { const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!; output += BASE64[(n >>> 18) & 63]! + BASE64[(n >>> 12) & 63]! + BASE64[(n >>> 6) & 63]! + BASE64[n & 63]!; }
  return output;
}
export function decodeVector(encoded: unknown): number[] {
  if (typeof encoded !== 'string' || encoded.length !== 2048 || !/^[A-Za-z0-9+/]+$/u.test(encoded)) throw failure('cache_corrupt', 'Semantic vector encoding is corrupt');
  const bytes = new Uint8Array(1536);
  for (let i = 0, j = 0; i < encoded.length; i += 4, j += 3) { const n = (BASE64.indexOf(encoded[i]!) << 18) | (BASE64.indexOf(encoded[i + 1]!) << 12) | (BASE64.indexOf(encoded[i + 2]!) << 6) | BASE64.indexOf(encoded[i + 3]!); bytes[j] = n >>> 16; bytes[j + 1] = (n >>> 8) & 255; bytes[j + 2] = n & 255; }
  const view = new DataView(bytes.buffer); const vector = Array.from({ length: 384 }, (_, i) => view.getFloat32(i * 4, true));
  if (vector.some(value => !Number.isFinite(value))) throw failure('cache_corrupt', 'Semantic vector contains non-finite values');
  return vector;
}
function checksum(index: Omit<SemanticIndex, 'checksum'>): string {
  const s = index.scope, n = index.snapshot;
  return sha256Text(JSON.stringify([index.version, [s.workspace_id, s.repository_id, s.branch, s.generation], [n.id, n.local_commit, n.worktree_generation, n.draft_generation, n.remote_commit ?? null], index.modelDigest,
    index.passages.map(item => [item.entityId, item.type, item.sourcePath, item.sourceRevision, item.sentenceIndex, item.textHash, item.vector])]));
}
export function makeIndex(request: ActionRequest, corpus: SemanticCorpus, vectors: number[][]): SemanticIndex {
  if (vectors.length !== corpus.passages.length) throw failure('model_unavailable', 'Embedding count differs from source passages');
  const passages = corpus.passages.map((passage, i) => ({ entityId: passage.entityId, type: passage.type, sourcePath: passage.sourcePath, sourceRevision: passage.sourceRevision, sentenceIndex: passage.sentenceIndex, textHash: sha256Text(passage.text), vector: encodeVector(vectors[i]!) }));
  return makeIndexFromReferences(request, passages);
}
export function makeIndexFromReferences(request: ActionRequest, passages: IndexedReference[]): SemanticIndex {
  const base = { version: 2 as const, scope: request.scope, snapshot: request.snapshot, modelDigest: E5_MODEL.model_sha256, passages };
  return validateIndex({ ...base, checksum: checksum(base) }, request);
}
export function validateIndex(raw: unknown, request: ActionRequest): SemanticIndex {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw failure('cache_corrupt', 'Semantic index is corrupt');
  const index = raw as SemanticIndex;
  if (Object.keys(index).some(key => !['version', 'scope', 'snapshot', 'modelDigest', 'passages', 'checksum'].includes(key)) || index.version !== 2 || index.modelDigest !== E5_MODEL.model_sha256 || !Array.isArray(index.passages) || index.passages.length > 20_000) throw failure('cache_corrupt', 'Semantic index is corrupt');
  if (!index.scope || !index.snapshot || identity(index.scope) !== identity(request.scope) || identity(index.snapshot) !== identity(request.snapshot)) throw failure('index_stale', 'Semantic index belongs to a different snapshot');
  const seen = new Set<string>();
  for (const item of index.passages) {
    if (!item || Object.keys(item).some(key => !['entityId', 'type', 'sourcePath', 'sourceRevision', 'sentenceIndex', 'textHash', 'vector'].includes(key)) || typeof item.entityId !== 'string' || !item.entityId || item.entityId.length > 256 || typeof item.type !== 'string' || !['scene','manuscript','character','location','item','faction','event','thread','lore'].includes(item.type) || typeof item.sourcePath !== 'string' || !item.sourcePath || item.sourcePath.length > 4096 || item.sourcePath.startsWith('/') || item.sourcePath.includes('\\') || item.sourcePath.includes('\0') || item.sourcePath.split('/').some(part => !part || part === '.' || part === '..') || typeof item.sourceRevision !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sourceRevision) || !Number.isSafeInteger(item.sentenceIndex) || item.sentenceIndex < 0 || typeof item.textHash !== 'string' || !/^[a-f0-9]{64}$/u.test(item.textHash) || typeof item.vector !== 'string' || item.vector.length !== 2048) throw failure('cache_corrupt', 'Semantic index passage is corrupt');
    decodeVector(item.vector);
    const key = JSON.stringify([item.sourcePath, item.entityId, item.sentenceIndex]); if (seen.has(key)) throw failure('cache_corrupt', 'Semantic index has duplicate passages'); seen.add(key);
  }
  if (typeof index.checksum !== 'string' || index.checksum !== checksum(index)) throw failure('cache_corrupt', 'Semantic index checksum is corrupt');
  return index;
}
export function rankedIndex(index: SemanticIndex, query: number[], limit: number, exclude: string[] = []): Array<Omit<IndexedReference, 'vector'> & { vector: number[]; cosineScore: number }> {
  if (query.length !== 384 || query.some(value => !Number.isFinite(value))) throw failure('model_unavailable', 'Invalid query embedding');
  const excluded = new Set(exclude);
  return index.passages.filter(item => !excluded.has(item.entityId)).map(item => { const vector = decodeVector(item.vector); return { ...item, vector, cosineScore: Math.max(-1, Math.min(1, cosineSimilarityDense(query, vector))) }; })
    .sort((a, b) => b.cosineScore - a.cosineScore || (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0) || a.sentenceIndex - b.sentenceIndex).slice(0, limit);
}
