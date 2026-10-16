import { randomUUID } from "node:crypto";
import { snapshotKey, type CapabilityDefinition, type JobRequest, type ModuleContext, type SnapshotId, type WorkerService } from "@scriptorium/contracts";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL_ID,
  EMBEDDING_MODEL_VERSION,
  RERANKER_MODEL_ID,
  RERANKER_MODEL_VERSION,
  SEMANTIC_EMBEDDING_CAPABILITY,
  SEMANTIC_EMBEDDING_CAPABILITY_VERSION,
  SEMANTIC_MODULE_VERSION,
  type SemanticEmbeddingCapability,
  type SemanticIndexResult,
  type SemanticIndexStatus,
  type SemanticMentionPair,
  type SemanticPassage,
  type SemanticNearestResult,
} from "./contracts.js";

export * from "./contracts.js";

const MAX_TEXT_LENGTH = 1_000_000;
const INDEX_CHUNK_BYTES = 512 * 1024;

type WorkerInput = Record<string, unknown>;

function codeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function validatePassage(value: SemanticPassage): SemanticPassage {
  if (!value || typeof value !== "object" || typeof value.entityId !== "string" || !value.entityId ||
      typeof value.sceneId !== "string" || !value.sceneId || value.sceneId !== value.entityId ||
      !Number.isSafeInteger(value.sentenceIndex) || value.sentenceIndex < 0 ||
      typeof value.text !== "string" || !value.text.trim() || value.text.length > MAX_TEXT_LENGTH) {
    throw codeError("invalid_semantic_passage", "A passage needs matching entity/scene IDs, a non-negative sentence index, and non-empty text under one million characters");
  }
  return {
    entityId: value.entityId,
    sceneId: value.sceneId,
    sentenceIndex: value.sentenceIndex,
    text: value.text,
    ...(typeof value.type === "string" ? { type: value.type } : {}),
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.filePath === "string" ? { filePath: value.filePath } : {}),
  };
}

function splitBatches(passages: readonly SemanticPassage[]): SemanticPassage[][] {
  const batches: SemanticPassage[][] = [];
  let batch: SemanticPassage[] = [];
  let size = 0;
  for (const passage of passages) {
    const passageSize = Buffer.byteLength(JSON.stringify(passage), "utf8");
    if (passageSize > INDEX_CHUNK_BYTES) {
      if (batch.length) batches.push(batch);
      batches.push([passage]);
      batch = [];
      size = 0;
      continue;
    }
    if (batch.length > 0 && size + passageSize > INDEX_CHUNK_BYTES) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(passage);
    size += passageSize;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function identity(snapshot: SnapshotId, requestId?: string, model = EMBEDDING_MODEL_ID, modelVersion = EMBEDDING_MODEL_VERSION): Pick<JobRequest, "id" | "module" | "snapshot" | "model" | "modelVersion" | "moduleVersion" | "deadline"> {
  return {
    id: requestId ?? randomUUID(),
    module: "semantic",
    snapshot,
    model,
    modelVersion,
    moduleVersion: SEMANTIC_MODULE_VERSION,
    deadline: Date.now() + 10 * 60_000,
  };
}

function throwOutcomeError(outcome: Awaited<ReturnType<WorkerService["request"]>>): never {
  if (outcome.ok) throw new Error("Invalid worker outcome handling");
  throw codeError(outcome.error.code, outcome.error.message);
}

async function request<T>(worker: WorkerService, snapshot: SnapshotId, task: string, input: WorkerInput, signal: AbortSignal, requestId?: string, model = EMBEDDING_MODEL_ID, modelVersion = EMBEDDING_MODEL_VERSION): Promise<T> {
  if (signal.aborted) throw signal.reason ?? codeError("job_cancelled", "Semantic action was cancelled");
  const outcome = await worker.request<T>({ ...identity(snapshot, requestId, model, modelVersion), task, input }, signal);
  if (!outcome.ok) throwOutcomeError(outcome);
  return outcome.result.output;
}

function createCapability(context: ModuleContext): Promise<SemanticEmbeddingCapability & { dispose(): Promise<void> }> {
  return context.createWorkerService().then((worker) => {
    let indexTail: Promise<unknown> = Promise.resolve();
    const serializeIndex = <T,>(fn: () => Promise<T>): Promise<T> => {
      const result = indexTail.then(fn, fn);
      indexTail = result.then(() => undefined, () => undefined);
      return result;
    };
    const cacheDirectory = context.cacheDirectory;
    const common = { cacheDirectory };

    const capability: SemanticEmbeddingCapability & { dispose(): Promise<void> } = {
      model: { id: EMBEDDING_MODEL_ID, version: EMBEDDING_MODEL_VERSION, dimensions: EMBEDDING_DIMENSIONS },
      async index(inputPassages, snapshot, signal, onProgress): Promise<SemanticIndexResult> {
        return serializeIndex(async () => {
          const passages = inputPassages.map(validatePassage);
          const indexId = randomUUID();
          const key = snapshotKey(snapshot);
          await request<{ scanned: number; reused: number }>(worker, snapshot, "semantic.index.begin", {
            ...common, indexId, key, total: passages.length,
          }, signal);
          let completed = 0;
          let committed = false;
          try {
            for (const batch of splitBatches(passages)) {
              if (signal.aborted) throw signal.reason ?? codeError("job_cancelled", "Semantic index rebuild was cancelled");
              const result = await request<{ embedded: number; reused: number }>(worker, snapshot, "semantic.index.batch", {
                ...common, indexId, passages: batch,
              }, signal);
              completed += result.embedded + result.reused;
              onProgress?.(completed, passages.length);
            }
            if (signal.aborted) throw signal.reason ?? codeError("job_cancelled", "Semantic index rebuild was cancelled");
            const result = await request<{ scanned: number; embedded: number; reused: number; removed: number }>(worker, snapshot, "semantic.index.commit", {
              ...common, indexId,
            }, signal);
            committed = true;
            return {
              snapshot, model: EMBEDDING_MODEL_ID, modelVersion: EMBEDDING_MODEL_VERSION,
              dimensions: EMBEDDING_DIMENSIONS, scanned: result.scanned, embedded: result.embedded,
              reused: result.reused, removed: result.removed,
            };
          } catch (error) {
            if (!committed) {
              const cleanupSignal = new AbortController().signal;
              await request(worker, snapshot, "semantic.index.abort", { ...common, indexId }, cleanupSignal).catch(() => undefined);
            }
            throw error;
          }
        });
      },
      async nearest(query, snapshot, options, signal): Promise<SemanticNearestResult> {
        if (typeof query !== "string" || query.length > MAX_TEXT_LENGTH) throw codeError("invalid_semantic_query", "Query must be under one million characters");
        const limit = options.limit ?? 10;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw codeError("invalid_semantic_limit", "Nearest limit must be between 1 and 100");
        const data = await request<Omit<SemanticNearestResult, "snapshot" | "model" | "modelVersion" | "dimensions">>(worker, snapshot, "semantic.nearest", {
          ...common, key: snapshotKey(snapshot), query, limit,
          excludeSceneIds: options.excludeSceneIds ?? [],
        }, signal);
        return { snapshot, model: EMBEDDING_MODEL_ID, modelVersion: EMBEDDING_MODEL_VERSION, dimensions: EMBEDDING_DIMENSIONS, ...data };
      },
      async status(snapshot, signal): Promise<SemanticIndexStatus> {
        const data = await request<Omit<SemanticIndexStatus, "snapshot" | "model" | "modelVersion" | "dimensions">>(worker, snapshot, "semantic.status", {
          ...common, key: snapshotKey(snapshot),
        }, signal);
        return { snapshot, model: EMBEDDING_MODEL_ID, modelVersion: EMBEDDING_MODEL_VERSION, dimensions: EMBEDDING_DIMENSIONS, ...data };
      },
      async contradictionPairs(groups, snapshot, options, signal) {
        if (!Number.isFinite(options.minimum) || !Number.isFinite(options.maximum) || options.minimum > options.maximum) throw codeError("invalid_contradiction_threshold", "Contradiction similarity thresholds are invalid");
        const pairResults: SemanticMentionPair[] = [];
        let groupBatch: typeof groups[number][] = [];
        let bytes = 0;
        const flush = async () => {
          if (!groupBatch.length) return;
          const result = await request<{ pairs: SemanticMentionPair[] }>(worker, snapshot, "semantic.contradiction-pairs", {
            ...common, key: snapshotKey(snapshot), groups: groupBatch,
            minimum: options.minimum, maximum: options.maximum,
          }, signal);
          pairResults.push(...result.pairs);
          groupBatch = [];
          bytes = 0;
        };
        for (const group of groups) {
          const size = Buffer.byteLength(JSON.stringify(group), "utf8");
          if (size > 6 * 1024 * 1024) throw codeError("semantic_contradiction_group_too_large", "One entity has too many sentence mentions to compare in a single bounded job");
          if (groupBatch.length > 0 && bytes + size > INDEX_CHUNK_BYTES) await flush();
          groupBatch.push(group);
          bytes += size;
        }
        await flush();
        return { snapshot, model: EMBEDDING_MODEL_ID, modelVersion: EMBEDDING_MODEL_VERSION, dimensions: EMBEDDING_DIMENSIONS, pairs: pairResults };
      },
      async embed(texts, snapshot, signal) {
        if (texts.length > 32 || texts.some((text) => typeof text !== "string" || text.length > MAX_TEXT_LENGTH)) throw codeError("invalid_semantic_texts", "Embedding accepts up to 32 texts, each at most one million characters");
        const data = await request<{ vectors: number[][] }>(worker, snapshot, "semantic.embed", { ...common, texts }, signal);
        return { snapshot, model: EMBEDDING_MODEL_ID, modelVersion: EMBEDDING_MODEL_VERSION, dimensions: EMBEDDING_DIMENSIONS, vectors: data.vectors };
      },
      async rerank(query, texts, snapshot, signal) {
        if (texts.length > 30 || query.length > 8192 || texts.some((text) => typeof text !== "string" || text.length > MAX_TEXT_LENGTH)) throw codeError("invalid_rerank_input", "Reranking accepts up to 30 documents and text up to the configured limits");
        const data = await request<{ scores: number[] }>(worker, snapshot, "semantic.rerank", {
          ...common, query, texts,
        }, signal, undefined, RERANKER_MODEL_ID, RERANKER_MODEL_VERSION);
        return { snapshot, model: RERANKER_MODEL_ID, modelVersion: RERANKER_MODEL_VERSION, scores: data.scores };
      },
      async dispose() { await worker.dispose(); },
    };
    return capability;
  });
}

export const semanticEmbeddingCapability: CapabilityDefinition<SemanticEmbeddingCapability & { dispose(): Promise<void> }> = {
  id: SEMANTIC_EMBEDDING_CAPABILITY,
  version: SEMANTIC_EMBEDDING_CAPABILITY_VERSION,
  create: createCapability,
  async dispose(value) { await value.dispose(); },
};
