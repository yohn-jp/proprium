import type { ActionRequest } from '../../app/src/browser/proprium/authoring/types.js';
import type { GuestHost, HostCall } from '../shared/guest.js';
import { HOST_OPERATIONS, readFileVersioned } from '../shared/operations.ts';
import { collectSemanticCorpus } from './corpus.ts';
import { collectMentionGroups, embeddingContradictions } from './core.ts';
import { E5_MODEL, E5_ASSET_TOTAL_BYTES } from './inference.ts';
import { makeIndexFromReferences, rankedIndex, validateIndex, decodeVector, encodeVector, type IndexedReference, type SemanticIndex } from './index.ts';
import { sha256Text } from './sha256.ts';
import { parseSemanticSourceFile } from './source.ts';
import { assertSemanticTaskActive, beginSemanticTask, endSemanticTask, updateSemanticTask, type SemanticTaskPhase } from './tasks.ts';

export interface SemanticEngine {
 ensure(host: GuestHost): Generator<HostCall, void, unknown>;
 ensureStep?(host: GuestHost, maxChunks: number): Generator<HostCall, { ready: boolean; completed: number; total: number }, unknown>;
 embed(texts: readonly string[]): number[][];
 model(): Record<string, unknown>;
}
function failure(code: string, message: string): Error { return Object.assign(new Error(message), { code, retryable: false }); }
const PLUGIN_ID = 'proprium.semantic';
const CACHE_GET_PREVIOUS = 'workspace.derived.cache.get_previous';
const STAGING_CONTROL_KEY = 'semantic-index-staging-control-v1';
const STAGING_CHUNK_PREFIX = 'semantic-index-staging-chunk-v1-';
const INDEX_MANIFEST_KEY = 'semantic-index-v3-manifest';
const INDEX_PAGE_PREFIX = 'semantic-index-v3-page-';
const INDEX_PASSAGE_LIMIT = 20_000;
const INDEX_EMBED_BATCH = 2;
const INDEX_PAGE_PASSAGES = 32;
const INDEX_PUBLISH_PAGES_PER_STEP = 4;
const INDEX_PAGE_CALL_BUDGET = 850_000;
const INDEX_GENERATION_BYTE_LIMIT = 60 * 1024 * 1024;
const INDEX_CHECKPOINT_BYTE_LIMIT = 1024 * 1024;
const INDEX_CONFIG_DIGEST = sha256Text('proprium.semantic/index-v3/arcadia-source-v1/japanese-sentence-boundaries-v1/f32le384-v1');
interface IndexBuildCheckpoint {
 version: 1;
 mode: 'build' | 'warm';
 taskId: string;
 scope: ActionRequest['scope'];
 snapshot: ActionRequest['snapshot'];
 modelDigest: string;
 scanned: number;
 total: number;
 stagedBytes: number;
 modelCompleted?: number;
 chunkSequences: number[];
 nextSequence: number;
 phase: 'source_scan' | 'model_loading' | 'embedding' | 'cache_publish';
 publishChecksum?: string;
 publishPageCount?: number;
 nextPage?: number;
}
interface StagedChunk { version: 1; sequence: number; items: Array<{ index: number; reference: IndexedReference }> }
interface SemanticIndexManifest {
 version: 1;
 scope: ActionRequest['scope'];
 snapshot: ActionRequest['snapshot'];
 modelDigest: string;
 indexChecksum: string;
 passageCount: number;
 pageCount: number;
 pageCounts: number[];
 pageChecksums: string[];
}
interface SemanticIndexPage { version: 1; indexChecksum: string; pageIndex: number; pageCount: number; passages: IndexedReference[]; checksum: string }
interface ActiveIndexBuild {
 taskId: string;
 scopeKey: string;
 snapshotKey: string;
 corpus: import('./corpus.ts').SemanticCorpus;
 references: Array<IndexedReference | undefined>;
 pending: number[];
 pendingSet: Set<number>;
 pendingCursor: number;
 reused: number;
 removed: number;
 nextSequence: number;
 chunkSequences: number[];
 scanned: number;
 stagedBytes: number;
 publishingIndex?: SemanticIndex;
 publishingPages?: SemanticIndexPage[];
 nextPage: number;
}
let activeIndexBuild: ActiveIndexBuild | undefined;
let residentIndex: { scopeKey: string; snapshotKey: string; index: SemanticIndex } | undefined;
function key(request: ActionRequest, cacheKey = INDEX_MANIFEST_KEY) { return { plugin_id: PLUGIN_ID, snapshot: request.snapshot, schema_version: 1, config_digest: INDEX_CONFIG_DIGEST, model_digest: E5_MODEL.model_sha256, key: cacheKey }; }
function rememberIndex(request: ActionRequest, index: SemanticIndex): SemanticIndex {
 residentIndex = { scopeKey: scopeKey(request), snapshotKey: snapshotKey(request), index };
 return index;
}
export function releaseSemanticIndex(): void { residentIndex = undefined; activeIndexBuild = undefined; }
export function* loadIndex(request: ActionRequest, host: GuestHost): Generator<HostCall, SemanticIndex | undefined, unknown> {
 if (residentIndex?.scopeKey === scopeKey(request) && residentIndex.snapshotKey === snapshotKey(request)) return residentIndex.index;
 const current = yield* cacheGet<unknown>(request, host, INDEX_MANIFEST_KEY);
 if (current.found) return rememberIndex(request, yield* readManifestIndex(request, host, current.value));
 const legacy = yield* cacheGet<unknown>(request, host, 'semantic-index-v2');
 return legacy.found ? rememberIndex(request, validateIndex(legacy.value, request)) : undefined;
}
function canonical(value: unknown): string {
 if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
 if (value && typeof value === 'object') {
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(name => `${JSON.stringify(name)}:${canonical(record[name])}`).join(',')}}`;
 }
 return JSON.stringify(value);
}
function pageCacheKey(checksum: string, pageIndex: number): string { return `${INDEX_PAGE_PREFIX}${checksum}-${pageIndex}`; }
function pageChecksum(page: Omit<SemanticIndexPage, 'checksum'>): string { return sha256Text(canonical(page)); }
function serializedBytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
function makeIndexPages(index: SemanticIndex): SemanticIndexPage[] {
 const groups: IndexedReference[][] = [];
 for (let start = 0; start < index.passages.length; start += INDEX_PAGE_PASSAGES) groups.push(index.passages.slice(start, start + INDEX_PAGE_PASSAGES));
 const pages = groups.map((passages, pageIndex): SemanticIndexPage => {
  const base = { version: 1 as const, indexChecksum: index.checksum, pageIndex, pageCount: groups.length, passages };
  return { ...base, checksum: pageChecksum(base) };
 });
 if (pages.some(page => serializedBytes(page) > INDEX_PAGE_CALL_BUDGET)) throw failure('capacity', 'A Semantic index page exceeds the Host cache-call budget');
 if (serializedBytes(index) > INDEX_GENERATION_BYTE_LIMIT || pages.reduce((sum, page) => sum + serializedBytes(page), 0) > INDEX_GENERATION_BYTE_LIMIT) {
  throw failure('capacity', 'Semantic index generation exceeds the bounded 60 MiB cache limit');
 }
 return pages;
}
function validManifest(value: unknown, request: ActionRequest): value is SemanticIndexManifest {
 if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
 const row = value as SemanticIndexManifest;
 return Object.keys(row).every(name => ['version','scope','snapshot','modelDigest','indexChecksum','passageCount','pageCount','pageCounts','pageChecksums'].includes(name)) &&
  row.version === 1 && canonical(row.scope) === scopeKey(request) && canonical(row.snapshot) === snapshotKey(request) &&
  row.modelDigest === E5_MODEL.model_sha256 && typeof row.indexChecksum === 'string' && /^[a-f0-9]{64}$/u.test(row.indexChecksum) &&
  Number.isSafeInteger(row.passageCount) && row.passageCount >= 0 && row.passageCount <= INDEX_PASSAGE_LIMIT &&
  Number.isSafeInteger(row.pageCount) && row.pageCount >= 0 && row.pageCount <= Math.ceil(INDEX_PASSAGE_LIMIT / INDEX_PAGE_PASSAGES) &&
  Array.isArray(row.pageCounts) && row.pageCounts.length === row.pageCount && row.pageCounts.every(count => Number.isSafeInteger(count) && count > 0 && count <= INDEX_PAGE_PASSAGES) &&
  Array.isArray(row.pageChecksums) && row.pageChecksums.length === row.pageCount && row.pageChecksums.every(digest => typeof digest === 'string' && /^[a-f0-9]{64}$/u.test(digest)) &&
  row.pageCounts.reduce((total, count) => total + count, 0) === row.passageCount &&
  ((row.passageCount === 0 && row.pageCount === 0) || (row.passageCount > 0 && row.pageCount > 0));
}
function* readManifestIndex(request: ActionRequest, host: GuestHost, rawManifest: unknown): Generator<HostCall, SemanticIndex, unknown> {
 if (!validManifest(rawManifest, request)) throw failure('cache_corrupt', 'Semantic index manifest is corrupt');
 const manifest = rawManifest;
 const passages: IndexedReference[] = [];
 for (let pageIndex = 0; pageIndex < manifest.pageCount; pageIndex++) {
  const name = pageCacheKey(manifest.indexChecksum, pageIndex);
  const found = yield* cacheGet<unknown>(request, host, name);
  if (!found.found || !found.value || typeof found.value !== 'object' || Array.isArray(found.value)) throw failure('cache_corrupt', 'Semantic index page is missing');
  const page = found.value as SemanticIndexPage;
  const base = { version: page.version, indexChecksum: page.indexChecksum, pageIndex: page.pageIndex, pageCount: page.pageCount, passages: page.passages };
  if (!Object.keys(page).every(name => ['version','indexChecksum','pageIndex','pageCount','passages','checksum'].includes(name)) ||
      page.version !== 1 || page.indexChecksum !== manifest.indexChecksum || page.pageIndex !== pageIndex || page.pageCount !== manifest.pageCount ||
      !Array.isArray(page.passages) || page.passages.length !== manifest.pageCounts[pageIndex] || page.checksum !== manifest.pageChecksums[pageIndex] ||
      page.checksum !== pageChecksum(base)) throw failure('cache_corrupt', 'Semantic index page is corrupt');
  passages.push(...page.passages);
 }
 return validateIndex({ version: 2, scope: manifest.scope, snapshot: manifest.snapshot, modelDigest: manifest.modelDigest,
  passages, checksum: manifest.indexChecksum }, request);
}
function* getPreviousCache<T>(request: ActionRequest, host: GuestHost, cacheKey: string): Generator<HostCall, { found: boolean; snapshot?: ActionRequest['snapshot']; value?: T }, unknown> {
 const selector = { plugin_id: PLUGIN_ID, schema_version: 1, config_digest: INDEX_CONFIG_DIGEST, model_digest: E5_MODEL.model_sha256, key: cacheKey };
 const result = yield* host.request<{ found: boolean; snapshot?: ActionRequest['snapshot']; value?: T }>(CACHE_GET_PREVIOUS, { selector });
 if (!result || typeof result.found !== 'boolean') throw failure('storage_unknown', 'Invalid previous Semantic cache response');
 return result;
}
function* readPreviousManifest(request: ActionRequest, host: GuestHost, rawManifest: unknown, snapshot: ActionRequest['snapshot']): Generator<HostCall, SemanticIndex, unknown> {
 const previousRequest = { ...request, snapshot };
 if (!validManifest(rawManifest, previousRequest)) throw failure('cache_corrupt', 'Previous Semantic index manifest is corrupt');
 const manifest = rawManifest;
 const passages: IndexedReference[] = [];
 for (let pageIndex = 0; pageIndex < manifest.pageCount; pageIndex++) {
  const previous = yield* getPreviousCache<unknown>(request, host, pageCacheKey(manifest.indexChecksum, pageIndex));
  if (!previous.found || !previous.value || !previous.snapshot || canonical(previous.snapshot) !== canonical(snapshot) || typeof previous.value !== 'object' || Array.isArray(previous.value)) throw failure('cache_corrupt', 'Previous Semantic index page is missing or belongs to another generation');
  const page = previous.value as SemanticIndexPage;
  const base = { version: page.version, indexChecksum: page.indexChecksum, pageIndex: page.pageIndex, pageCount: page.pageCount, passages: page.passages };
  if (!Object.keys(page).every(name => ['version','indexChecksum','pageIndex','pageCount','passages','checksum'].includes(name)) ||
      page.version !== 1 || page.indexChecksum !== manifest.indexChecksum || page.pageIndex !== pageIndex || page.pageCount !== manifest.pageCount ||
      !Array.isArray(page.passages) || page.passages.length !== manifest.pageCounts[pageIndex] || page.checksum !== manifest.pageChecksums[pageIndex] ||
      page.checksum !== pageChecksum(base)) throw failure('cache_corrupt', 'Previous Semantic index page is corrupt');
  passages.push(...page.passages);
 }
 return validateIndex({ version: 2, scope: manifest.scope, snapshot: manifest.snapshot, modelDigest: manifest.modelDigest,
  passages, checksum: manifest.indexChecksum }, previousRequest);
}
function scopeKey(request: ActionRequest): string { return canonical(request.scope); }
function snapshotKey(request: ActionRequest): string { return canonical(request.snapshot); }
function sourceKey(reference: Pick<IndexedReference, 'sourcePath' | 'entityId' | 'sentenceIndex'>): string {
 return JSON.stringify([reference.sourcePath, reference.entityId, reference.sentenceIndex]);
}
function referenceFor(passage: import('./source.ts').SemanticSourcePassage, vector: readonly number[]): IndexedReference {
 return { entityId: passage.entityId, type: passage.type, sourcePath: passage.sourcePath, sourceRevision: passage.sourceRevision,
  sentenceIndex: passage.sentenceIndex, textHash: sha256Text(passage.text), vector: encodeVector(vector) };
}
function completeResult(request: ActionRequest, taskId: string, result: { scanned: number; embedded: number; reused: number; removed: number; total: number }) {
 return { snapshot: request.snapshot, taskId, state: 'complete', phase: 'complete', completed: result.total, total: result.total,
  result: { scanned: result.scanned, embedded: result.embedded, reused: result.reused, removed: result.removed, indexedGeneration: request.snapshot.worktree_generation } };
}
function runningResult(request: ActionRequest, taskId: string, phase: SemanticTaskPhase, completed: number, total: number) {
 return { snapshot: request.snapshot, taskId, state: 'running', phase, completed, total };
}
function* cacheGet<T>(request: ActionRequest, host: GuestHost, name: string): Generator<HostCall, { found: boolean; value?: T }, unknown> {
 const result = yield* host.request<{ found: boolean; value?: T }>(HOST_OPERATIONS.cacheGet, { key: key(request, name) });
 if (!result || typeof result.found !== 'boolean') throw failure('storage_unknown', 'Invalid Semantic staging cache response');
 return result;
}
function* cachePut<T>(request: ActionRequest, host: GuestHost, name: string, value: T): Generator<HostCall, void, unknown> {
 const result = yield* host.request<{ stored: boolean }>(HOST_OPERATIONS.cachePut, { key: key(request, name), value });
 if (!result || result.stored !== true) throw failure('storage_unknown', 'Host did not confirm Semantic staging storage');
}
function* cacheEvict(request: ActionRequest, host: GuestHost, name: string): Generator<HostCall, void, unknown> {
 yield* host.request(HOST_OPERATIONS.cacheEvict, { key: key(request, name) });
}
function* cacheEvictPrefix(request: ActionRequest, host: GuestHost, prefix: string): Generator<HostCall, void, unknown> {
 yield* host.request('workspace.derived.cache.evict_prefix', { selector: { schema_version: 1, config_digest: INDEX_CONFIG_DIGEST, model_digest: E5_MODEL.model_sha256, key_prefix: prefix } });
}
function* cacheEvictPrevious(request: ActionRequest, host: GuestHost, name: string): Generator<HostCall, void, unknown> {
 yield* host.request('workspace.derived.cache.evict_previous', { selector: { schema_version: 1, config_digest: INDEX_CONFIG_DIGEST, model_digest: E5_MODEL.model_sha256, key: name } });
}
function* cacheEvictPreviousPrefix(request: ActionRequest, host: GuestHost, prefix: string): Generator<HostCall, void, unknown> {
 yield* host.request('workspace.derived.cache.evict_previous_prefix', { selector: { schema_version: 1, config_digest: INDEX_CONFIG_DIGEST, model_digest: E5_MODEL.model_sha256, key_prefix: prefix } });
}
function validCheckpoint(value: unknown, request: ActionRequest): value is IndexBuildCheckpoint {
 if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
 const row = value as IndexBuildCheckpoint;
 const uniqueChunks = Array.isArray(row.chunkSequences) && new Set(row.chunkSequences).size === row.chunkSequences.length;
 return Object.keys(row).every(name => ['version','mode','taskId','scope','snapshot','modelDigest','scanned','total','stagedBytes','modelCompleted','chunkSequences','nextSequence','phase','publishChecksum','publishPageCount','nextPage'].includes(name)) &&
  row.version === 1 && (row.mode === 'build' || row.mode === 'warm') && typeof row.taskId === 'string' && row.taskId.length <= 128 && canonical(row.scope) === scopeKey(request) &&
  canonical(row.snapshot) === snapshotKey(request) && row.modelDigest === E5_MODEL.model_sha256 &&
  Number.isSafeInteger(row.scanned) && row.scanned >= 0 && Number.isSafeInteger(row.total) && row.total >= 0 && row.total <= INDEX_PASSAGE_LIMIT &&
  Number.isSafeInteger(row.stagedBytes) && row.stagedBytes >= 0 && row.stagedBytes <= INDEX_GENERATION_BYTE_LIMIT &&
  (row.modelCompleted === undefined || (Number.isSafeInteger(row.modelCompleted) && row.modelCompleted >= 0 && row.modelCompleted <= E5_ASSET_TOTAL_BYTES)) &&
  serializedBytes(row) <= INDEX_CHECKPOINT_BYTE_LIMIT &&
  Array.isArray(row.chunkSequences) && row.chunkSequences.length <= INDEX_PASSAGE_LIMIT && uniqueChunks &&
  row.chunkSequences.every(item => Number.isSafeInteger(item) && item >= 0) &&
  Number.isSafeInteger(row.nextSequence) && row.nextSequence >= 0 &&
  ['source_scan','model_loading','embedding','cache_publish'].includes(row.phase) &&
  (row.mode !== 'warm' || (row.phase === 'model_loading' && row.chunkSequences.length === 0 && row.stagedBytes === 0)) &&
  (row.phase !== 'cache_publish' || (typeof row.publishChecksum === 'string' && /^[a-f0-9]{64}$/u.test(row.publishChecksum) &&
   Number.isSafeInteger(row.publishPageCount) && row.publishPageCount! >= 0 && row.publishPageCount! <= Math.ceil(INDEX_PASSAGE_LIMIT / INDEX_PAGE_PASSAGES) &&
   Number.isSafeInteger(row.nextPage) && row.nextPage! >= 0 && row.nextPage! <= row.publishPageCount!)) &&
  (row.phase === 'cache_publish' || (row.publishChecksum === undefined && row.publishPageCount === undefined && row.nextPage === undefined));
}
function* loadPreviousIndex(request: ActionRequest, host: GuestHost): Generator<HostCall, SemanticIndex | undefined, unknown> {
 const manifest = yield* getPreviousCache<unknown>(request, host, INDEX_MANIFEST_KEY);
 if (manifest.found) {
  if (!manifest.snapshot || canonical(manifest.snapshot) === snapshotKey(request)) throw failure('storage_unknown', 'Host returned an invalid previous Semantic snapshot');
  try { return yield* readPreviousManifest(request, host, manifest.value, manifest.snapshot); }
  catch (error) {
   if (['cache_corrupt','index_stale'].includes(String((error as { code?: string })?.code))) return undefined;
   throw error;
  }
 }
 const legacy = yield* getPreviousCache<unknown>(request, host, 'semantic-index-v2');
 if (!legacy.found) return undefined;
 if (!legacy.snapshot || canonical(legacy.snapshot) === snapshotKey(request)) throw failure('storage_unknown', 'Host returned an invalid previous Semantic snapshot');
 try { return validateIndex(legacy.value, { ...request, snapshot: legacy.snapshot }); }
 catch (error) {
  if (['cache_corrupt','index_stale'].includes(String((error as { code?: string })?.code))) return undefined;
  throw error;
 }
}
function* readStageChunk(request: ActionRequest, host: GuestHost, sequence: number): Generator<HostCall, StagedChunk, unknown> {
 const response = yield* cacheGet<unknown>(request, host, STAGING_CHUNK_PREFIX + sequence);
 if (!response.found || !response.value || typeof response.value !== 'object' || Array.isArray(response.value)) throw failure('cache_corrupt', 'Semantic staging vector chunk is missing');
 const chunk = response.value as StagedChunk;
 if (chunk.version !== 1 || chunk.sequence !== sequence || !Array.isArray(chunk.items) || chunk.items.length < 1 || chunk.items.length > INDEX_EMBED_BATCH) throw failure('cache_corrupt', 'Semantic staging vector chunk is corrupt');
 return chunk;
}
function* persistCheckpoint(request: ActionRequest, host: GuestHost, checkpoint: IndexBuildCheckpoint): Generator<HostCall, void, unknown> {
 if (serializedBytes(checkpoint) > INDEX_CHECKPOINT_BYTE_LIMIT) throw failure('capacity', 'Semantic indexing checkpoint exceeds the bounded 1 MiB limit');
 yield* cachePut(request, host, STAGING_CONTROL_KEY, checkpoint);
}
function isSamePassage(reference: IndexedReference | undefined, passage: import('./source.ts').SemanticSourcePassage): reference is IndexedReference {
 return !!reference && reference.entityId === passage.entityId && reference.type === passage.type && reference.sourcePath === passage.sourcePath &&
  reference.sourceRevision === passage.sourceRevision && reference.sentenceIndex === passage.sentenceIndex && reference.textHash === sha256Text(passage.text);
}
function hydrateBuild(taskId: string, request: ActionRequest, corpus: import('./corpus.ts').SemanticCorpus, previous: SemanticIndex | undefined): ActiveIndexBuild {
 const old = new Map((previous?.passages ?? []).map(reference => [sourceKey(reference), reference]));
 const references: Array<IndexedReference | undefined> = new Array(corpus.passages.length);
 const pending: number[] = [];
 let reused = 0;
 for (let index = 0; index < corpus.passages.length; index++) {
  const passage = corpus.passages[index]!;
  const reference = old.get(sourceKey(passage));
  if (isSamePassage(reference, passage)) { references[index] = reference; reused += 1; }
  else pending.push(index);
 }
 return { taskId, scopeKey: scopeKey(request), snapshotKey: snapshotKey(request), corpus, references, pending,
  pendingSet: new Set(pending), pendingCursor: 0, reused,
  removed: Math.max(0, (previous?.passages.length ?? 0) - reused), nextSequence: 0, chunkSequences: [], scanned: corpus.scanned,
  stagedBytes: 0, nextPage: 0 };
}
function applyStagedChunk(active: ActiveIndexBuild, chunk: StagedChunk): void {
 const seen = new Set<number>();
 for (const item of chunk.items) {
  const passage = active.corpus.passages[item.index];
  if (!Number.isSafeInteger(item.index) || item.index < 0 || !passage || seen.has(item.index) || !active.pendingSet.has(item.index) || !isSamePassage(item.reference, passage)) throw failure('cache_corrupt', 'Semantic staging vector chunk does not match pinned source');
  decodeVector(item.reference.vector);
  active.references[item.index] = item.reference;
  active.pendingSet.delete(item.index);
  seen.add(item.index);
 }
}
function validActiveBuild(active: ActiveIndexBuild | undefined, taskId: string, request: ActionRequest): active is ActiveIndexBuild {
 return !!active && active.taskId === taskId && active.scopeKey === scopeKey(request) && active.snapshotKey === snapshotKey(request);
}
function* prepareBuild(input: { taskId: string; sequence: number }, request: ActionRequest, host: GuestHost): Generator<HostCall, { active: ActiveIndexBuild; checkpoint: IndexBuildCheckpoint }, unknown> {
 const stored = yield* cacheGet<unknown>(request, host, STAGING_CONTROL_KEY);
 let checkpoint: IndexBuildCheckpoint | undefined;
 if (stored.found && validCheckpoint(stored.value, request)) checkpoint = stored.value;
 else if (stored.found) {
  yield* cacheEvict(request, host, STAGING_CONTROL_KEY);
  yield* cacheEvictPrefix(request, host, STAGING_CHUNK_PREFIX);
 }
 if (checkpoint?.mode === 'warm') {
  yield* cacheEvict(request, host, STAGING_CONTROL_KEY);
  yield* cacheEvictPrefix(request, host, STAGING_CHUNK_PREFIX);
  checkpoint = undefined;
 }
 if (checkpoint?.mode === 'build' && checkpoint.taskId !== input.taskId) {
  yield* cacheEvict(request, host, STAGING_CONTROL_KEY);
  yield* cacheEvictPrefix(request, host, STAGING_CHUNK_PREFIX);
  checkpoint = undefined;
 }
 if (validActiveBuild(activeIndexBuild, input.taskId, request)) {
  return { active: activeIndexBuild, checkpoint: checkpoint ?? { version: 1, mode: 'build', taskId: input.taskId, scope: request.scope, snapshot: request.snapshot,
   modelDigest: E5_MODEL.model_sha256, scanned: activeIndexBuild.scanned, total: activeIndexBuild.corpus.passages.length,
   stagedBytes: activeIndexBuild.stagedBytes, chunkSequences: activeIndexBuild.chunkSequences, nextSequence: input.sequence, phase: 'source_scan' } };
 }
 const corpus = yield* collectSemanticCorpus(host, request);
 if (corpus.passages.length > INDEX_PASSAGE_LIMIT) throw failure('capacity', 'Semantic passage count exceeds the configured bounded index limit');
 const previous = yield* loadPreviousIndex(request, host);
 const active = hydrateBuild(input.taskId, request, corpus, previous);
 if (checkpoint && checkpoint.total === corpus.passages.length && checkpoint.scanned === corpus.scanned) {
  for (const sequence of checkpoint.chunkSequences) {
   const chunk = yield* readStageChunk(request, host, sequence);
   active.stagedBytes += serializedBytes(chunk);
   if (active.stagedBytes > INDEX_GENERATION_BYTE_LIMIT) throw failure('capacity', 'Semantic staged vectors exceed the bounded 60 MiB cache limit');
   applyStagedChunk(active, chunk);
  }
  if (active.stagedBytes !== checkpoint.stagedBytes) throw failure('cache_corrupt', 'Semantic staging byte count does not match its checkpoint');
  active.taskId = input.taskId;
  active.nextSequence = checkpoint.nextSequence;
  active.chunkSequences = [...checkpoint.chunkSequences];
  if (checkpoint.phase === 'cache_publish') {
   if (active.pendingSet.size !== 0) throw failure('cache_corrupt', 'Semantic publish checkpoint has missing vectors');
   active.publishingIndex = makeIndexFromReferences(request, active.references as IndexedReference[]);
   active.publishingPages = makeIndexPages(active.publishingIndex);
   if (active.publishingIndex.checksum !== checkpoint.publishChecksum || active.publishingPages.length !== checkpoint.publishPageCount) throw failure('cache_corrupt', 'Semantic publish checkpoint does not match staged vectors');
   active.nextPage = checkpoint.nextPage!;
  }
 } else {
  if (checkpoint) yield* cacheEvictPrefix(request, host, STAGING_CHUNK_PREFIX);
  checkpoint = { version: 1, mode: 'build', taskId: input.taskId, scope: request.scope, snapshot: request.snapshot, modelDigest: E5_MODEL.model_sha256,
   scanned: corpus.scanned, total: corpus.passages.length, stagedBytes: 0, chunkSequences: [], nextSequence: input.sequence, phase: 'source_scan' };
 }
 activeIndexBuild = active;
  checkpoint = { version: 1, mode: 'build', taskId: input.taskId, scope: request.scope, snapshot: request.snapshot, modelDigest: E5_MODEL.model_sha256,
  scanned: corpus.scanned, total: corpus.passages.length, stagedBytes: active.stagedBytes, chunkSequences: active.chunkSequences, nextSequence: active.nextSequence,
  phase: checkpoint?.phase ?? 'source_scan', ...(checkpoint?.phase === 'cache_publish' ? { publishChecksum: checkpoint.publishChecksum,
   publishPageCount: checkpoint.publishPageCount, nextPage: checkpoint.nextPage } : {}) };
 yield* persistCheckpoint(request, host, checkpoint);
 return { active, checkpoint };
}
function* publishBuild(request: ActionRequest, host: GuestHost, active: ActiveIndexBuild, input: { taskId: string; sequence: number }, checkpoint: IndexBuildCheckpoint): Generator<HostCall, unknown, unknown> {
 if (!active.publishingIndex || !active.publishingPages) {
  const references = active.references.map(reference => {
   if (!reference) throw failure('cache_corrupt', 'Semantic index has an unfinished vector');
   return reference;
  });
  active.publishingIndex = makeIndexFromReferences(request, references);
  active.publishingPages = makeIndexPages(active.publishingIndex);
  active.nextPage = 0;
 }
 const index = active.publishingIndex;
 const pages = active.publishingPages;
 updateSemanticTask('cache_publish', active.references.length, active.corpus.passages.length);
 if (checkpoint.phase !== 'cache_publish') {
  checkpoint = { ...checkpoint, taskId: input.taskId, phase: 'cache_publish', nextSequence: input.sequence,
   publishChecksum: index.checksum, publishPageCount: pages.length, nextPage: 0 };
  yield* persistCheckpoint(request, host, checkpoint);
 }
 if (checkpoint.publishChecksum !== index.checksum || checkpoint.publishPageCount !== pages.length || checkpoint.nextPage !== active.nextPage) {
  throw failure('cache_corrupt', 'Semantic publish cursor does not match its manifest');
 }
 if (active.nextPage < pages.length) {
  const end = Math.min(pages.length, active.nextPage + INDEX_PUBLISH_PAGES_PER_STEP);
  for (let pageIndex = active.nextPage; pageIndex < end; pageIndex++) {
   const page = pages[pageIndex]!;
   const result = yield* host.request<{ stored: boolean }>(HOST_OPERATIONS.cachePut, { key: key(request, pageCacheKey(index.checksum, pageIndex)), value: page });
   if (!result || result.stored !== true) throw failure('storage_unknown', 'Host did not confirm Semantic index page storage');
  }
  active.nextPage = end;
  const next = { ...checkpoint, taskId: input.taskId, nextSequence: input.sequence + 1, nextPage: end };
  yield* persistCheckpoint(request, host, next);
  return runningResult(request, input.taskId, 'cache_publish', active.references.length, active.corpus.passages.length);
 }
 const previous = yield* getPreviousCache<unknown>(request, host, INDEX_MANIFEST_KEY);
 const manifest: SemanticIndexManifest = { version: 1, scope: request.scope, snapshot: request.snapshot, modelDigest: E5_MODEL.model_sha256,
  indexChecksum: index.checksum, passageCount: index.passages.length, pageCount: pages.length,
  pageCounts: pages.map(page => page.passages.length), pageChecksums: pages.map(page => page.checksum) };
 const stored = yield* host.request<{ stored: boolean }>(HOST_OPERATIONS.cachePut, { key: key(request), value: manifest });
 if (!stored || stored.stored !== true) throw failure('storage_unknown', 'Host did not confirm Semantic index manifest storage');
 rememberIndex(request, index);
 yield* cacheEvictPrefix(request, host, STAGING_CHUNK_PREFIX);
 yield* cacheEvict(request, host, STAGING_CONTROL_KEY);
 if (previous.found && previous.snapshot && canonical(previous.snapshot) !== snapshotKey(request) && validManifest(previous.value, { ...request, snapshot: previous.snapshot })) {
  const old = previous.value as SemanticIndexManifest;
  yield* cacheEvictPreviousPrefix(request, host, `${INDEX_PAGE_PREFIX}${old.indexChecksum}-`);
  yield* cacheEvictPrevious(request, host, INDEX_MANIFEST_KEY);
 } else if (!previous.found) {
  const legacy = yield* getPreviousCache<unknown>(request, host, 'semantic-index-v2');
  if (legacy.found) yield* cacheEvictPrevious(request, host, 'semantic-index-v2');
 }
 activeIndexBuild = undefined;
 return completeResult(request, input.taskId, { scanned: active.scanned, embedded: active.corpus.passages.length - active.reused, reused: active.reused,
  removed: active.removed, total: active.corpus.passages.length });
}
export function* startIndexBuild(input: { taskId: string }, request: ActionRequest, host: GuestHost, engine: SemanticEngine): Generator<HostCall, unknown, unknown> {
 if (!request.idempotency_key) throw failure('invalid_input', 'Host idempotency key is required for indexing');
 let existing: SemanticIndex | undefined;
 try { existing = yield* loadIndex(request, host); }
 catch (error) { if (!['cache_corrupt','index_stale'].includes(String((error as { code?: string })?.code))) throw error; }
 if (existing && engine.model().status === 'ready') return completeResult(request, input.taskId, { scanned: 0, embedded: 0, reused: existing.passages.length, removed: 0, total: existing.passages.length });
 if (existing) return runningResult(request, input.taskId, 'model_loading', 0, E5_ASSET_TOTAL_BYTES);
 return runningResult(request, input.taskId, 'source_scan', 0, 0);
}
function* warmModelStep(input: { taskId: string; sequence: number }, request: ActionRequest, host: GuestHost, engine: SemanticEngine, index: SemanticIndex): Generator<HostCall, unknown, unknown> {
 const stored = yield* cacheGet<unknown>(request, host, STAGING_CONTROL_KEY);
 let checkpoint = stored.found && validCheckpoint(stored.value, request) && stored.value.mode === 'warm' ? stored.value : undefined;
 if (checkpoint && checkpoint.taskId !== input.taskId) throw failure('capacity', 'A different Semantic model-load task is already checkpointed');
 if (!checkpoint) {
  if (stored.found) yield* cacheEvict(request, host, STAGING_CONTROL_KEY);
  yield* cacheEvictPrefix(request, host, STAGING_CHUNK_PREFIX);
  checkpoint = { version: 1, mode: 'warm', taskId: input.taskId, scope: request.scope, snapshot: request.snapshot, modelDigest: E5_MODEL.model_sha256,
   scanned: 0, total: index.passages.length, stagedBytes: 0, modelCompleted: 0, chunkSequences: [], nextSequence: input.sequence, phase: 'model_loading' };
  yield* persistCheckpoint(request, host, checkpoint);
 }
 if (input.sequence < checkpoint.nextSequence) return runningResult(request, input.taskId, 'model_loading', checkpoint.modelCompleted ?? 0, E5_ASSET_TOTAL_BYTES);
 if (input.sequence > checkpoint.nextSequence) throw failure('snapshot_stale', 'Semantic model-load sequence skipped a checkpoint');
 assertSemanticTaskActive();
 if (engine.model().status === 'ready') {
  yield* cacheEvict(request, host, STAGING_CONTROL_KEY);
  return completeResult(request, input.taskId, { scanned: 0, embedded: 0, reused: index.passages.length, removed: 0, total: index.passages.length });
 }
 let loaded: { ready: boolean; completed: number; total: number };
 if (engine.ensureStep) loaded = yield* engine.ensureStep(host, 4);
 else { yield* engine.ensure(host); loaded = { ready: true, completed: E5_ASSET_TOTAL_BYTES, total: E5_ASSET_TOTAL_BYTES }; }
 checkpoint = { ...checkpoint, nextSequence: input.sequence + 1, modelCompleted: loaded.completed };
 updateSemanticTask('model_loading', loaded.completed, loaded.total);
 if (loaded.ready || engine.model().status === 'ready') {
  yield* cacheEvict(request, host, STAGING_CONTROL_KEY);
  return completeResult(request, input.taskId, { scanned: 0, embedded: 0, reused: index.passages.length, removed: 0, total: index.passages.length });
 }
 yield* persistCheckpoint(request, host, checkpoint);
 return runningResult(request, input.taskId, 'model_loading', loaded.completed, loaded.total);
}
export function* stepIndexBuild(input: { taskId: string; sequence: number }, request: ActionRequest, host: GuestHost, engine: SemanticEngine): Generator<HostCall, unknown, unknown> {
 if (!request.idempotency_key) throw failure('invalid_input', 'Host job step needs an idempotency key');
 if (!Number.isSafeInteger(input.sequence) || input.sequence < 0 || input.sequence > 1_000_000) throw failure('invalid_input', 'Semantic job sequence is invalid');
 beginSemanticTask(input.taskId);
 try {
  let existing: SemanticIndex | undefined;
  try { existing = yield* loadIndex(request, host); }
  catch (error) { if (!['cache_corrupt','index_stale'].includes(String((error as { code?: string })?.code))) throw error; }
  if (existing) {
   if (engine.model().status === 'ready') return completeResult(request, input.taskId, { scanned: 0, embedded: 0, reused: existing.passages.length, removed: 0, total: existing.passages.length });
   return yield* warmModelStep(input, request, host, engine, existing);
  }
  const prepared = yield* prepareBuild(input, request, host);
  const active = prepared.active;
  let checkpoint = prepared.checkpoint;
  updateSemanticTask(checkpoint.phase, checkpoint.phase === 'model_loading' ? checkpoint.modelCompleted ?? 0 : active.references.filter(Boolean).length,
   checkpoint.phase === 'model_loading' ? E5_ASSET_TOTAL_BYTES : checkpoint.total);
  if (input.sequence < checkpoint.nextSequence) return runningResult(request, input.taskId, checkpoint.phase, active.references.filter(Boolean).length, checkpoint.phase === 'model_loading' ? E5_ASSET_TOTAL_BYTES : checkpoint.total);
  if (input.sequence > checkpoint.nextSequence) throw failure('snapshot_stale', 'Semantic job sequence skipped a checkpoint');
  assertSemanticTaskActive();
  if (active.pendingSet.size > 0 && engine.model().status !== 'ready') {
   let loaded: { ready: boolean; completed: number; total: number };
   if (engine.ensureStep) loaded = yield* engine.ensureStep(host, 4);
   else { yield* engine.ensure(host); loaded = { ready: true, completed: E5_ASSET_TOTAL_BYTES, total: E5_ASSET_TOTAL_BYTES }; }
   checkpoint = { ...checkpoint, taskId: input.taskId, phase: 'model_loading', modelCompleted: loaded.completed, nextSequence: input.sequence + 1 };
   updateSemanticTask('model_loading', loaded.completed, loaded.total);
   yield* persistCheckpoint(request, host, checkpoint);
   return runningResult(request, input.taskId, 'model_loading', loaded.completed, loaded.total);
  }
  if (active.pendingSet.size) {
   const indices: number[] = [];
   let nextCursor = active.pendingCursor;
   while (nextCursor < active.pending.length && indices.length < INDEX_EMBED_BATCH) {
    const candidate = active.pending[nextCursor++]!;
    if (active.pendingSet.has(candidate)) indices.push(candidate);
   }
   const vectors = engine.embed(indices.map(index => active.corpus.passages[index]!.text));
   if (vectors.length !== indices.length) throw failure('model_unavailable', 'Embedding count differs from the requested Semantic batch');
   const items = indices.map((index, vector) => ({ index, reference: referenceFor(active.corpus.passages[index]!, vectors[vector]!) }));
   const chunk: StagedChunk = { version: 1, sequence: input.sequence, items };
   const stagedBytes = active.stagedBytes + serializedBytes(chunk);
   if (stagedBytes > INDEX_GENERATION_BYTE_LIMIT) throw failure('capacity', 'Semantic staged vectors exceed the bounded 60 MiB cache limit');
   yield* cachePut(request, host, STAGING_CHUNK_PREFIX + input.sequence, chunk);
   const nextChunkSequences = [...active.chunkSequences, input.sequence];
   checkpoint = { ...checkpoint, taskId: input.taskId, phase: 'embedding', stagedBytes, chunkSequences: nextChunkSequences,
    nextSequence: input.sequence + 1 };
   yield* persistCheckpoint(request, host, checkpoint);
   for (const item of items) { active.references[item.index] = item.reference; active.pendingSet.delete(item.index); }
   active.pendingCursor = nextCursor;
   active.chunkSequences = nextChunkSequences;
   active.stagedBytes = stagedBytes;
   active.nextSequence = input.sequence + 1;
   updateSemanticTask('embedding', active.references.filter(Boolean).length, active.corpus.passages.length);
   if (active.pendingSet.size) return runningResult(request, input.taskId, 'embedding', active.references.filter(Boolean).length, active.corpus.passages.length);
  }
  return yield* publishBuild(request, host, active, input, checkpoint);
 } finally { endSemanticTask(); }
}
export function* queryIndex(input: { query: string; granularity: 'scene' | 'sentence'; limit: number; excludeSceneIds?: string[] }, request: ActionRequest, host: GuestHost, engine: SemanticEngine): Generator<HostCall, unknown, unknown> {
 if (!input.query.trim()) return { snapshot: request.snapshot, model: engine.model(), results: [] };
 const index = yield* loadIndex(request, host); if (!index) throw failure('index_missing', 'No verified Semantic index exists for this snapshot');
 if (engine.model().status !== 'ready') throw failure('provider_unavailable', 'Load the pinned local model through Semantic index controls before querying');
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
   if (!match || match[1] !== digest || !Number.isSafeInteger(Number(match[2]))) throw failure('snapshot_stale', 'Semantic candidate cursor does not match this snapshot');
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
 if (offset > candidates.length) throw failure('snapshot_stale', 'Semantic candidate cursor is outside this generation');
 const limit = input.limit ?? 50; const page = candidates.slice(offset, offset + limit); const next = offset + page.length;
 return { snapshot: request.snapshot, model: engine.model(), indexAvailable: true, candidates: page, nextCursor: next < candidates.length ? `semantic1.${digest}.${next}` : null, complete: next >= candidates.length };
}
