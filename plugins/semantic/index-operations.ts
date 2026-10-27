import type { ActionRequest } from '../../app/src/browser/proprium/authoring/types.js';
import type { GuestHost, HostCall } from '../shared/guest.js';
import { HOST_OPERATIONS, readFileVersioned } from '../shared/operations.ts';
import { collectSemanticCorpus } from './corpus.ts';
import { collectMentionGroups, embeddingContradictions } from './core.ts';
import { E5_MODEL } from './inference.ts';
import { makeIndex, rankedIndex, validateIndex, decodeVector, type SemanticIndex } from './index.ts';
import { sha256Text } from './sha256.ts';
import { parseSemanticSourceFile } from './source.ts';

export interface SemanticEngine { ensure(host: GuestHost): Generator<HostCall, void, unknown>; embed(texts: readonly string[]): number[][]; model(): Record<string, unknown> }
function failure(code: string, message: string): Error { return Object.assign(new Error(message), { code, retryable: false }); }
function key(request: ActionRequest) { return { plugin_id: 'proprium.semantic', snapshot: request.snapshot, schema_version: 1, config_digest: sha256Text(JSON.stringify(request.scope)), model_digest: E5_MODEL.model_sha256, key: 'semantic-index-v2' }; }
export function* loadIndex(request: ActionRequest, host: GuestHost): Generator<HostCall, SemanticIndex | undefined, unknown> {
 const result = yield* host.request<{ found: boolean; value?: unknown }>(HOST_OPERATIONS.cacheGet, { key: key(request) });
 if (!result || typeof result.found !== 'boolean') throw failure('storage_unknown', 'Invalid Semantic cache response');
 return result.found ? validateIndex(result.value, request) : undefined;
}
export function* rebuildIndex(input: { taskId: string }, request: ActionRequest, host: GuestHost, engine: SemanticEngine): Generator<HostCall, unknown, unknown> {
 if (!request.idempotency_key) throw failure('invalid_input', 'Host idempotency key is required for indexing');
 let existing: SemanticIndex | undefined;
 try { existing = yield* loadIndex(request, host); }
 catch (error) { if (!["cache_corrupt", "index_stale"].includes(String((error as { code?: string })?.code))) throw error; }
 if (existing) return { snapshot: request.snapshot, taskId: input.taskId, scanned: 0, embedded: 0, reused: existing.passages.length, removed: 0, indexedGeneration: request.snapshot.worktree_generation };
 const corpus = yield* collectSemanticCorpus(host, request);
 // A single atomic record preserves the previous generation on cancellation;
 // the Host continuation limit bounds this implementation to small corpora.
 if (corpus.passages.length > 256) throw failure('capacity', 'Semantic index exceeds the current 256-passage atomic cache limit');
 yield* engine.ensure(host);
 const vectors: number[][] = [];
 for (let offset = 0; offset < corpus.passages.length; offset += 32) vectors.push(...engine.embed(corpus.passages.slice(offset, offset + 32).map(item => item.text)));
 const index = makeIndex(request, corpus, vectors);
 if (new TextEncoder().encode(JSON.stringify(index)).length > 700_000) throw failure('capacity', 'Semantic index exceeds the bounded Host continuation limit');
 const result = yield* host.request<{ stored: boolean }>(HOST_OPERATIONS.cachePut, { key: key(request), value: index });
 if (!result || result.stored !== true) throw failure('storage_unknown', 'Host did not confirm Semantic index storage');
 return { snapshot: request.snapshot, taskId: input.taskId, scanned: corpus.scanned, embedded: corpus.passages.length, reused: 0, removed: 0, indexedGeneration: request.snapshot.worktree_generation };
}
export function* queryIndex(input: { query: string; granularity: 'scene' | 'sentence'; limit: number; excludeSceneIds?: string[] }, request: ActionRequest, host: GuestHost, engine: SemanticEngine): Generator<HostCall, unknown, unknown> {
 if (!input.query.trim()) return { snapshot: request.snapshot, model: engine.model(), results: [] };
 const index = yield* loadIndex(request, host); if (!index) throw failure('index_missing', 'No verified Semantic index exists for this snapshot');
 yield* engine.ensure(host);
 const [vector] = engine.embed([input.query]);
 if (!vector) throw failure('model_unavailable', 'Embedding model returned no query vector');
 const ranked = rankedIndex(index, vector, index.passages.length, input.excludeSceneIds);
 const selected = input.granularity === 'scene' ? ranked.filter((item, i) => ranked.findIndex(other => other.entityId === item.entityId) === i).slice(0, input.limit) : ranked.slice(0, input.limit);
 const sources = new Map<string, string>(); const results: Record<string, unknown>[] = [];
 for (const item of selected) {
   const cacheKey = `${item.sourcePath}\n${item.sourceRevision}`;
   let text = sources.get(cacheKey);
   if (text === undefined) {
     const file = yield* readFileVersioned(host, request.snapshot, item.sourcePath, item.sourceRevision);
     try { text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes); } catch { throw failure('unsupported_format', `Invalid UTF-8: ${item.sourcePath}`); }
     sources.set(cacheKey, text);
   }
   const parsed = parseSemanticSourceFile(item.sourcePath, item.sourceRevision, text, item.type === 'manuscript' ? { entityId: item.entityId, type: 'manuscript' } : undefined);
   const passage = parsed?.passages.find(row => row.entityId === item.entityId && row.sentenceIndex === item.sentenceIndex);
   if (!passage || sha256Text(passage.text) !== item.textHash) throw failure('index_stale', `Semantic source changed: ${item.sourcePath}`);
   results.push({ entityId: item.entityId, sourcePath: item.sourcePath, sourceRevision: item.sourceRevision, ...(input.granularity === 'sentence' ? { sentenceIndex: item.sentenceIndex } : {}), quote: passage.evidence.quote, cosineScore: item.cosineScore, rank: results.length + 1, indexCoverage: 1, evidence: [passage.evidence] });
 }
 return { snapshot: request.snapshot, model: engine.model(), results };
}

export function* contradictionPage(input: { cursor?: string; limit?: number }, request: ActionRequest, host: GuestHost, engine: SemanticEngine): Generator<HostCall, unknown, unknown> {
 const index = yield* loadIndex(request, host);
 if (!index) return { snapshot: request.snapshot, model: engine.model(), indexAvailable: false, candidates: [], nextCursor: null, complete: true };
 const digest = sha256Text(JSON.stringify([request.snapshot.id, index.checksum]));
 let offset = 0;
 if (input.cursor !== undefined) {
   const match = /^semantic1\.([a-f0-9]{64})\.(0|[1-9][0-9]*)$/u.exec(input.cursor);
   if (!match || match[1] !== digest || !Number.isSafeInteger(Number(match[2]))) throw failure('index_stale', 'Semantic candidate cursor does not match this snapshot');
   offset = Number(match[2]);
 }
 const corpus = yield* collectSemanticCorpus(host, request);
 if (corpus.passages.length !== index.passages.length) throw failure('index_stale', 'Semantic corpus membership changed');
 const byKey = new Map(index.passages.map(item => [JSON.stringify([item.sourcePath, item.entityId, item.sentenceIndex]), item]));
 const passages = corpus.passages.map(row => {
   const item = byKey.get(JSON.stringify([row.sourcePath, row.entityId, row.sentenceIndex]));
   if (!item || item.sourceRevision !== row.sourceRevision || item.textHash !== sha256Text(row.text)) throw failure('index_stale', `Semantic source changed: ${row.sourcePath}`);
   return { entityId: row.entityId, sceneId: row.entityId, sentenceIndex: row.sentenceIndex, sourcePath: row.sourcePath, sourceRevision: row.sourceRevision, quote: row.evidence.quote, type: row.type, evidence: row.evidence, vector: decodeVector(item.vector) };
 });
 const entities = corpus.entities.map(row => ({ id: row.id, type: row.type, ...(row.name ? { name: row.name } : {}), aliases: row.aliases }));
 const candidates = embeddingContradictions(collectMentionGroups(entities, passages));
 if (offset > candidates.length) throw failure('index_stale', 'Semantic candidate cursor is outside this generation');
 const limit = input.limit ?? 100; const page = candidates.slice(offset, offset + limit); const next = offset + page.length;
 return { snapshot: request.snapshot, model: engine.model(), indexAvailable: true, candidates: page, nextCursor: next < candidates.length ? `semantic1.${digest}.${next}` : null, complete: next >= candidates.length };
}
