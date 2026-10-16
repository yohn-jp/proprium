import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JobRequest, SnapshotId } from "@scriptorium/contracts";
import { installWorkerHandler } from "@scriptorium/module-runtime";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL_ID,
  EMBEDDING_MODEL_VERSION,
  RERANKER_MODEL_ID,
  RERANKER_MODEL_VERSION,
  SEMANTIC_MODULE_VERSION,
  type SemanticPassage,
  type SemanticPassageHit,
} from "./contracts.js";

const INDEX_FORMAT = 2;
const EMBEDDING_BATCH_SIZE = 32;
const RERANK_BATCH_SIZE = 8;
const MAX_PASSAGE_LENGTH = 1_000_000;

interface CachedPassage {
  entityId: string;
  sceneId: string;
  sentenceIndex: number;
  textHash: string;
  modelId: string;
  modelVersion: string;
  dimensions: number;
  embedding: number[];
}

interface SnapshotPassageReference {
  key: string;
  type?: string;
  name?: string;
  filePath?: string;
}

interface SnapshotMembership {
  snapshot: SnapshotId;
  passages: Array<{ entityId: string; sceneId: string; sentenceIndex: number; text: string; reference: SnapshotPassageReference }>;
  updatedAt: string;
}

interface IndexStore {
  format: number;
  model: string;
  modelVersion: string;
  dimensions: number;
  snapshots: Record<string, SnapshotMembership>;
  passages: Record<string, CachedPassage>;
}

interface IndexBuild {
  store: IndexStore;
  snapshotKey: string;
  snapshot: SnapshotId;
  cacheFile: string;
  vectors: Map<string, CachedPassage>;
  liveLocations: Set<string>;
  snapshotPassages: Map<string, SnapshotMembership["passages"][number]>;
  scanned: number;
  embedded: number;
  reused: number;
}

interface FeatureTensor { tolist?: () => number[][] | number[]; data?: ArrayLike<number> }
type FeaturePipeline = (
  text: string | string[],
  options?: { pooling?: string; normalize?: boolean },
) => Promise<FeatureTensor | number[][] | Float32Array>;
type ScorePipeline = (input: unknown) => Promise<{ logits: { data: ArrayLike<number> } }>;

const builds = new Map<string, IndexBuild>();
const storeCache = new Map<string, IndexStore>();
let extractorPromise: Promise<FeaturePipeline> | null = null;
let tokenizerPromise: Promise<((text: string[], options: unknown) => unknown)> | null = null;
let rerankerPromise: Promise<ScorePipeline> | null = null;

function errorWithCode(code: string, message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

function assertRequest(request: JobRequest, signal: AbortSignal): void {
  if (request.module !== "semantic" || request.moduleVersion !== SEMANTIC_MODULE_VERSION) {
    throw errorWithCode("unsupported_semantic_version", "Unsupported semantic module identity");
  }
  if (request.task === "semantic.rerank") {
    if (request.model !== RERANKER_MODEL_ID || request.modelVersion !== RERANKER_MODEL_VERSION) {
      throw errorWithCode("unsupported_semantic_model", "Unsupported semantic reranker model identity");
    }
  } else if (request.model !== EMBEDDING_MODEL_ID || request.modelVersion !== EMBEDDING_MODEL_VERSION) {
    throw errorWithCode("unsupported_semantic_model", "Unsupported semantic embedding model identity");
  }
  if (signal.aborted) throw errorWithCode("job_cancelled", "Semantic worker request was cancelled");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw errorWithCode("invalid_semantic_input", `${label} must be an object`);
  return value as Record<string, unknown>;
}

function fnv1aHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stableKey(entityId: string, sentenceIndex: number): string {
  return `${entityId}\0${sentenceIndex}`;
}

function vectorKey(passage: Pick<SemanticPassage, "entityId" | "sentenceIndex" | "text">, textHash = fnv1aHash(passage.text)): string {
  return `${stableKey(passage.entityId, passage.sentenceIndex)}\0${textHash}`;
}

function safePathPart(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function cacheFileFor(cacheDirectory: string, repository: SnapshotId["repository"]): string {
  const modelPart = safePathPart(`${EMBEDDING_MODEL_ID}@${EMBEDDING_MODEL_VERSION}`).slice(0, 24);
  const repositoryPart = safePathPart(JSON.stringify([repository.provider, repository.ownerScope, repository.repositoryId, repository.defaultBranch]));
  return path.join(path.resolve(cacheDirectory), "semantic", "indexes", `${repositoryPart}-${modelPart}.json`);
}

function emptyStore(): IndexStore {
  return { format: INDEX_FORMAT, model: EMBEDDING_MODEL_ID, modelVersion: EMBEDDING_MODEL_VERSION, dimensions: EMBEDDING_DIMENSIONS, snapshots: {}, passages: {} };
}

async function loadStore(cacheFile: string): Promise<IndexStore> {
  const cached = storeCache.get(cacheFile);
  if (cached) {
    try { await access(cacheFile); return structuredClone(cached); }
    catch { storeCache.delete(cacheFile); }
  }
  try {
    const parsed = JSON.parse(await readFile(cacheFile, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyStore();
    const candidate = parsed as Partial<IndexStore>;
    if (candidate.format !== INDEX_FORMAT || candidate.model !== EMBEDDING_MODEL_ID || candidate.modelVersion !== EMBEDDING_MODEL_VERSION ||
        candidate.dimensions !== EMBEDDING_DIMENSIONS || !candidate.snapshots || typeof candidate.snapshots !== "object" ||
        !candidate.passages || typeof candidate.passages !== "object") return emptyStore();
    const store: IndexStore = {
      format: INDEX_FORMAT, model: EMBEDDING_MODEL_ID, modelVersion: EMBEDDING_MODEL_VERSION,
      dimensions: EMBEDDING_DIMENSIONS, snapshots: candidate.snapshots, passages: candidate.passages,
    };
    storeCache.set(cacheFile, store);
    return structuredClone(store);
  } catch {
    return emptyStore();
  }
}

async function saveStore(cacheFile: string, store: IndexStore): Promise<void> {
  const directory = path.dirname(cacheFile);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const staging = `${cacheFile}.${randomUUID()}.tmp`;
  await writeFile(staging, `${JSON.stringify(store)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(staging, cacheFile);
  storeCache.set(cacheFile, structuredClone(store));
}

function validatePassage(value: unknown): SemanticPassage {
  const item = record(value, "passage");
  if (typeof item.entityId !== "string" || !item.entityId || typeof item.sceneId !== "string" || item.sceneId !== item.entityId ||
      !Number.isSafeInteger(item.sentenceIndex) || (item.sentenceIndex as number) < 0 ||
      typeof item.text !== "string" || !item.text.trim() || item.text.length > MAX_PASSAGE_LENGTH) {
    throw errorWithCode("invalid_semantic_passage", "Passage identity, sentence index, or text is invalid");
  }
  return {
    entityId: item.entityId,
    sceneId: item.sceneId,
    sentenceIndex: item.sentenceIndex as number,
    text: item.text,
    ...(typeof item.type === "string" ? { type: item.type } : {}),
    ...(typeof item.name === "string" ? { name: item.name } : {}),
    ...(typeof item.filePath === "string" ? { filePath: item.filePath } : {}),
  };
}

async function getFeatureExtractor(cacheDirectory: string): Promise<FeaturePipeline> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      try {
        const transformers = await import("@huggingface/transformers");
        transformers.env.cacheDir = path.join(path.resolve(cacheDirectory), "semantic", "models");
        transformers.env.allowLocalModels = true;
        const extractor = await transformers.pipeline("feature-extraction", EMBEDDING_MODEL_ID, {
          revision: EMBEDDING_MODEL_VERSION,
        });
        return extractor as unknown as FeaturePipeline;
      } catch (error) {
        extractorPromise = null;
        throw errorWithCode("semantic_model_unavailable", `Could not load ${EMBEDDING_MODEL_ID}@${EMBEDDING_MODEL_VERSION}: ${error instanceof Error ? error.message : String(error)}`, error);
      }
    })();
  }
  return extractorPromise;
}

function vectorsFrom(output: FeatureTensor | number[][] | Float32Array, count: number): number[][] {
  if (output instanceof Float32Array) {
    if (count === 1) return [Array.from(output)];
    const rows: number[][] = [];
    for (let i = 0; i < count; i++) rows.push(Array.from(output.slice(i * EMBEDDING_DIMENSIONS, (i + 1) * EMBEDDING_DIMENSIONS)));
    return rows;
  }
  const list = typeof (output as FeatureTensor).tolist === "function"
    ? (output as FeatureTensor).tolist!()
    : output as number[][];
  if (!Array.isArray(list)) throw errorWithCode("semantic_invalid_model_output", "Embedding model returned an unsupported tensor");
  if (list.length > 0 && typeof list[0] === "number") return [list as number[]];
  return list as number[][];
}

async function embedPassages(texts: readonly string[], cacheDirectory: string, signal: AbortSignal): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (signal.aborted) throw errorWithCode("job_cancelled", "Semantic embedding was cancelled");
  const extractor = await getFeatureExtractor(cacheDirectory);
  // Preserve the actual source behavior: createOnnxEmbedder prefixes every text, including queries, as passage.
  const output = await extractor(texts.map((text) => `passage: ${text}`), { pooling: "mean", normalize: true });
  if (signal.aborted) throw errorWithCode("job_cancelled", "Semantic embedding was cancelled");
  const vectors = vectorsFrom(output, texts.length);
  if (vectors.length !== texts.length || vectors.some((vector) => vector.length !== EMBEDDING_DIMENSIONS || vector.some((value) => !Number.isFinite(value)))) {
    throw errorWithCode("semantic_invalid_model_output", `Embedding model must return ${texts.length} finite ${EMBEDDING_DIMENSIONS}-dimensional vectors`);
  }
  return vectors;
}

async function beginIndex(request: JobRequest, input: Record<string, unknown>): Promise<{ scanned: number; reused: number }> {
  if (typeof input.cacheDirectory !== "string" || typeof input.indexId !== "string" || typeof input.key !== "string" ||
      typeof input.total !== "number" || !Number.isSafeInteger(input.total) || input.total < 0) {
    throw errorWithCode("invalid_semantic_index_request", "Index begin request is invalid");
  }
  const cacheFile = cacheFileFor(input.cacheDirectory, request.snapshot.repository);
  const store = await loadStore(cacheFile);
  const build: IndexBuild = {
    store,
    snapshotKey: input.key,
    snapshot: request.snapshot,
    cacheFile,
    vectors: new Map(),
    liveLocations: new Set(),
    snapshotPassages: new Map(),
    scanned: input.total,
    embedded: 0,
    reused: 0,
  };
  builds.set(input.indexId, build);
  return { scanned: build.scanned, reused: 0 };
}

async function indexBatch(input: Record<string, unknown>, signal: AbortSignal): Promise<{ embedded: number; reused: number }> {
  if (typeof input.indexId !== "string" || !Array.isArray(input.passages)) throw errorWithCode("invalid_semantic_index_request", "Index batch request is invalid");
  const build = builds.get(input.indexId);
  if (!build) throw errorWithCode("semantic_index_build_missing", "Index build session expired");
  const passages = input.passages.map(validatePassage);
  const pending: Array<{ key: string; passage: SemanticPassage; textHash: string }> = [];
  for (const passage of passages) {
    if (signal.aborted) throw errorWithCode("job_cancelled", "Semantic index rebuild was cancelled");
    const location = stableKey(passage.entityId, passage.sentenceIndex);
    if (build.liveLocations.has(location)) throw errorWithCode("duplicate_semantic_passage", `Duplicate passage key: ${passage.entityId}:${passage.sentenceIndex}`);
    build.liveLocations.add(location);
    const textHash = fnv1aHash(passage.text);
    const key = vectorKey(passage, textHash);
    build.snapshotPassages.set(location, {
      entityId: passage.entityId,
      sceneId: passage.sceneId,
      sentenceIndex: passage.sentenceIndex,
      text: passage.text,
      reference: { key, ...(passage.type ? { type: passage.type } : {}), ...(passage.name ? { name: passage.name } : {}), ...(passage.filePath ? { filePath: passage.filePath } : {}) },
    });
    const cached = build.store.passages[key];
    if (cached && cached.textHash === textHash && cached.modelId === EMBEDDING_MODEL_ID && cached.modelVersion === EMBEDDING_MODEL_VERSION &&
        cached.dimensions === EMBEDDING_DIMENSIONS && cached.embedding.length === EMBEDDING_DIMENSIONS) {
      build.vectors.set(key, { entityId: passage.entityId, sceneId: passage.sceneId, sentenceIndex: passage.sentenceIndex, textHash, modelId: EMBEDDING_MODEL_ID, modelVersion: EMBEDDING_MODEL_VERSION, dimensions: EMBEDDING_DIMENSIONS, embedding: cached.embedding });
      build.reused++;
    } else pending.push({ key, passage, textHash });
  }
  for (let offset = 0; offset < pending.length; offset += EMBEDDING_BATCH_SIZE) {
    if (signal.aborted) throw errorWithCode("job_cancelled", "Semantic index rebuild was cancelled");
    const batch = pending.slice(offset, offset + EMBEDDING_BATCH_SIZE);
    const vectors = await embedPassages(batch.map((entry) => entry.passage.text), String(input.cacheDirectory), signal);
    for (let index = 0; index < batch.length; index++) {
      const entry = batch[index]!;
      build.vectors.set(entry.key, {
        entityId: entry.passage.entityId,
        sceneId: entry.passage.sceneId,
        sentenceIndex: entry.passage.sentenceIndex,
        textHash: entry.textHash,
        modelId: EMBEDDING_MODEL_ID,
        modelVersion: EMBEDDING_MODEL_VERSION,
        dimensions: EMBEDDING_DIMENSIONS,
        embedding: vectors[index]!,
      });
    }
    build.embedded += batch.length;
  }
  return { embedded: pending.length, reused: passages.length - pending.length };
}

function abortIndex(input: Record<string, unknown>): { aborted: boolean } {
  if (typeof input.indexId !== "string") throw errorWithCode("invalid_semantic_index_request", "Index abort request is invalid");
  return { aborted: builds.delete(input.indexId) };
}

async function commitIndex(input: Record<string, unknown>): Promise<{ scanned: number; embedded: number; reused: number; removed: number }> {
  if (typeof input.indexId !== "string") throw errorWithCode("invalid_semantic_index_request", "Index commit request is invalid");
  const build = builds.get(input.indexId);
  if (!build) throw errorWithCode("semantic_index_build_missing", "Index build session expired");
  try {
    const previous = build.store.snapshots[build.snapshotKey]?.passages ?? [];
    const removed = previous.filter((passage) => !build.liveLocations.has(stableKey(passage.entityId, passage.sentenceIndex))).length;
    for (const [key, entry] of build.vectors) build.store.passages[key] = entry;
    build.store.snapshots[build.snapshotKey] = {
      snapshot: build.snapshot,
      passages: [...build.snapshotPassages.values()],
      updatedAt: new Date().toISOString(),
    };
    const retained = new Set(Object.values(build.store.snapshots).flatMap((snapshot) => snapshot.passages.map(({ reference }) => reference.key)));
    for (const key of Object.keys(build.store.passages)) if (!retained.has(key)) delete build.store.passages[key];
    await saveStore(build.cacheFile, build.store);
    return { scanned: build.scanned, embedded: build.embedded, reused: build.reused, removed };
  } finally {
    builds.delete(input.indexId);
  }
}

function cosineSimilarityDense(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function nearest(request: JobRequest, input: Record<string, unknown>, signal: AbortSignal): Promise<{ hits: SemanticPassageHit[] }> {
  if (typeof input.cacheDirectory !== "string" || typeof input.key !== "string" || typeof input.query !== "string" ||
      !Number.isSafeInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 100 ||
      !Array.isArray(input.excludeSceneIds) || input.excludeSceneIds.some((id) => typeof id !== "string")) {
    throw errorWithCode("invalid_semantic_query", "Nearest search request is invalid");
  }
  if (!input.query.trim()) return { hits: [] };
  const cacheFile = cacheFileFor(input.cacheDirectory, request.snapshot.repository);
  const store = await loadStore(cacheFile);
  const membership = store.snapshots[input.key];
  if (!membership) throw errorWithCode("semantic_index_missing", "No semantic passage index exists for this snapshot; rebuild the index first");
  const vectors = await embedPassages([input.query], input.cacheDirectory, signal);
  const query = vectors[0]!;
  const excluded = new Set(input.excludeSceneIds as string[]);
  const hits: SemanticPassageHit[] = [];
  for (const passage of membership.passages) {
    if (signal.aborted) throw errorWithCode("job_cancelled", "Semantic nearest-neighbor query was cancelled");
    const item = store.passages[passage.reference.key];
    if (!item || item.entityId !== passage.entityId || item.sceneId !== passage.sceneId || item.sentenceIndex !== passage.sentenceIndex ||
        item.textHash !== fnv1aHash(passage.text) || item.modelId !== EMBEDDING_MODEL_ID || item.modelVersion !== EMBEDDING_MODEL_VERSION || item.dimensions !== EMBEDDING_DIMENSIONS) {
      throw errorWithCode("semantic_index_stale", "Semantic index has missing or mismatched passage vectors; rebuild the index");
    }
    if (excluded.has(passage.sceneId)) continue;
    hits.push({
      entityId: passage.entityId,
      sceneId: passage.sceneId,
      sentenceIndex: passage.sentenceIndex,
      text: passage.text,
      score: cosineSimilarityDense(query, item.embedding),
      ...(passage.reference.type ? { type: passage.reference.type } : {}),
      ...(passage.reference.name ? { name: passage.reference.name } : {}),
      ...(passage.reference.filePath ? { filePath: passage.reference.filePath } : {}),
    });
  }
  hits.sort((a, b) => b.score - a.score || a.entityId.localeCompare(b.entityId) || a.sentenceIndex - b.sentenceIndex);
  return { hits: hits.slice(0, input.limit as number) };
}

async function contradictionPairs(request: JobRequest, input: Record<string, unknown>, signal: AbortSignal): Promise<{ pairs: Array<{ entityId: string; evidenceA: { sceneId: string; sentenceIndex: number; text: string }; evidenceB: { sceneId: string; sentenceIndex: number; text: string }; score: number }> }> {
  if (typeof input.cacheDirectory !== "string" || typeof input.key !== "string" || !Array.isArray(input.groups) ||
      typeof input.minimum !== "number" || typeof input.maximum !== "number" || input.minimum > input.maximum) {
    throw errorWithCode("invalid_contradiction_pair_request", "Contradiction pair request is invalid");
  }
  const store = await loadStore(cacheFileFor(input.cacheDirectory, request.snapshot.repository));
  const membership = store.snapshots[input.key];
  if (!membership) throw errorWithCode("semantic_index_missing", "No semantic passage index exists for this snapshot");
  const memberByLocation = new Map(membership.passages.map((passage) => [stableKey(passage.entityId, passage.sentenceIndex), passage]));
  const output: Array<{ entityId: string; evidenceA: { sceneId: string; sentenceIndex: number; text: string }; evidenceB: { sceneId: string; sentenceIndex: number; text: string }; score: number }> = [];
  for (const groupValue of input.groups) {
    if (signal.aborted) throw errorWithCode("job_cancelled", "Contradiction candidate generation was cancelled");
    const group = record(groupValue, "mention group");
    if (typeof group.entityId !== "string" || !group.entityId || !Array.isArray(group.anchors)) throw errorWithCode("invalid_contradiction_pair_request", "Mention group is invalid");
    // The source collector writes each scene+sentence key into a Map; the last duplicate wins.
    const unique = new Map<string, { sceneId: string; sentenceIndex: number }>();
    for (const value of group.anchors) {
      const anchor = record(value, "mention anchor");
      if (typeof anchor.sceneId !== "string" || !Number.isSafeInteger(anchor.sentenceIndex) || (anchor.sentenceIndex as number) < 0) continue;
      unique.set(`${anchor.sceneId}:${anchor.sentenceIndex}`, { sceneId: anchor.sceneId, sentenceIndex: anchor.sentenceIndex as number });
    }
    const items: Array<{ sceneId: string; sentenceIndex: number; text: string; embedding: number[] }> = [];
    for (const anchor of unique.values()) {
      const passage = memberByLocation.get(stableKey(anchor.sceneId, anchor.sentenceIndex));
      if (!passage) continue;
      const vector = store.passages[passage.reference.key];
      if (!vector || vector.textHash !== fnv1aHash(passage.text) || vector.modelId !== EMBEDDING_MODEL_ID || vector.modelVersion !== EMBEDDING_MODEL_VERSION || vector.dimensions !== EMBEDDING_DIMENSIONS) {
        throw errorWithCode("semantic_index_stale", "Semantic index has missing or mismatched passage vectors; rebuild the index");
      }
      items.push({ sceneId: anchor.sceneId, sentenceIndex: anchor.sentenceIndex, text: passage.text, embedding: vector.embedding });
    }
    for (let left = 0; left < items.length; left++) for (let right = left + 1; right < items.length; right++) {
      const a = items[left]!;
      const b = items[right]!;
      if (a.sceneId === b.sceneId && a.sentenceIndex === b.sentenceIndex) continue;
      const score = cosineSimilarityDense(a.embedding, b.embedding);
      if (score < (input.minimum as number) || score >= (input.maximum as number)) continue;
      output.push({
        entityId: group.entityId,
        evidenceA: { sceneId: a.sceneId, sentenceIndex: a.sentenceIndex, text: a.text },
        evidenceB: { sceneId: b.sceneId, sentenceIndex: b.sentenceIndex, text: b.text },
        score,
      });
    }
  }
  return { pairs: output };
}

async function getReranker(cacheDirectory: string): Promise<ScorePipeline> {
  if (!rerankerPromise) {
    rerankerPromise = (async () => {
      try {
        const transformers = await import("@huggingface/transformers");
        transformers.env.cacheDir = path.join(path.resolve(cacheDirectory), "semantic", "models");
        transformers.env.allowLocalModels = true;
        const [tokenizer, model] = await Promise.all([
          transformers.AutoTokenizer.from_pretrained(RERANKER_MODEL_ID, { revision: RERANKER_MODEL_VERSION }),
          transformers.AutoModelForSequenceClassification.from_pretrained(RERANKER_MODEL_ID, {
            revision: RERANKER_MODEL_VERSION,
            dtype: "fp32",
            use_external_data_format: true,
          }),
        ]);
        tokenizerPromise = Promise.resolve(tokenizer as unknown as (text: string[], options: unknown) => unknown);
        return async (input) => await model(input as never) as unknown as { logits: { data: ArrayLike<number> } };
      } catch (error) {
        rerankerPromise = null;
        throw errorWithCode("semantic_reranker_unavailable", `Could not load ${RERANKER_MODEL_ID}@${RERANKER_MODEL_VERSION}: ${error instanceof Error ? error.message : String(error)}`, error);
      }
    })();
  }
  return rerankerPromise;
}

async function rerank(query: string, texts: unknown, cacheDirectory: string, signal: AbortSignal): Promise<{ scores: number[] }> {
  if (!Array.isArray(texts) || texts.length > 30 || texts.some((text) => typeof text !== "string" || text.length > MAX_PASSAGE_LENGTH) || query.length > 8192) {
    throw errorWithCode("invalid_rerank_input", "Rerank request is outside the configured bounds");
  }
  if (texts.length === 0) return { scores: [] };
  const model = await getReranker(cacheDirectory);
  if (!tokenizerPromise) throw errorWithCode("semantic_reranker_unavailable", "Reranker tokenizer was not initialized");
  const tokenizer = await tokenizerPromise;
  const scores: number[] = [];
  for (let offset = 0; offset < texts.length; offset += RERANK_BATCH_SIZE) {
    if (signal.aborted) throw errorWithCode("job_cancelled", "Semantic reranking was cancelled");
    const batch = texts.slice(offset, offset + RERANK_BATCH_SIZE) as string[];
    const input = tokenizer(batch.map(() => query), { text_pair: batch, padding: true, truncation: true });
    const output = await model(input);
    const logits = output.logits.data;
    const perDoc = logits.length / batch.length;
    if (!Number.isInteger(perDoc) || perDoc < 1) throw errorWithCode("semantic_invalid_model_output", "Reranker returned malformed logits");
    for (let index = 0; index < batch.length; index++) {
      const score = 1 / (1 + Math.exp(-Number(logits[index * perDoc])));
      if (!Number.isFinite(score)) throw errorWithCode("semantic_invalid_model_output", "Reranker returned a non-finite score");
      scores.push(score);
    }
  }
  return { scores };
}

async function status(input: Record<string, unknown>, request: JobRequest): Promise<unknown> {
  if (typeof input.cacheDirectory !== "string") throw errorWithCode("invalid_semantic_status_request", "Status request has no cache directory");
  const cacheFile = cacheFileFor(input.cacheDirectory, request.snapshot.repository);
  const store = await loadStore(cacheFile);
  if (typeof input.key !== "string") throw errorWithCode("invalid_semantic_status_request", "Status request has no snapshot key");
  const key = input.key;
  const membership = store.snapshots[key];
  return {
    indexAvailable: Boolean(membership),
    passageCount: membership?.passages.length ?? 0,
    modelLoaded: Boolean(extractorPromise),
    rerankerLoaded: Boolean(rerankerPromise),
    indexUpdatedAt: membership?.updatedAt ?? null,
  };
}

installWorkerHandler<unknown, unknown>(async (request: JobRequest, signal) => {
  assertRequest(request, signal);
  const input = record(request.input, "worker input");
  try {
    if (request.task === "semantic.index.begin") return await beginIndex(request, input);
    if (request.task === "semantic.index.batch") return await indexBatch(input, signal);
    if (request.task === "semantic.index.commit") return await commitIndex(input);
    if (request.task === "semantic.index.abort") return abortIndex(input);
    if (request.task === "semantic.nearest") return await nearest(request, input, signal);
    if (request.task === "semantic.contradiction-pairs") return await contradictionPairs(request, input, signal);
    if (request.task === "semantic.embed") {
      if (typeof input.cacheDirectory !== "string" || !Array.isArray(input.texts) || input.texts.length > 32 || input.texts.some((text) => typeof text !== "string" || text.length > MAX_PASSAGE_LENGTH)) {
        throw errorWithCode("invalid_semantic_texts", "Embedding request is invalid");
      }
      return { vectors: await embedPassages(input.texts as string[], input.cacheDirectory, signal) };
    }
    if (request.task === "semantic.rerank") {
      if (typeof input.cacheDirectory !== "string" || typeof input.query !== "string") throw errorWithCode("invalid_rerank_input", "Rerank request is invalid");
      return await rerank(input.query, input.texts, input.cacheDirectory, signal);
    }
    if (request.task === "semantic.status") return await status(input, request);
    throw errorWithCode("unsupported_semantic_task", `Unsupported semantic worker task: ${request.task}`);
  } catch (error) {
    if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") throw error;
    throw errorWithCode("semantic_worker_failed", error instanceof Error ? error.message : String(error), error);
  }
});
