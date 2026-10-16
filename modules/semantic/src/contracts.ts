import type { SnapshotId } from "@scriptorium/contracts";

export const SEMANTIC_MODULE_VERSION = "0.1.0";
export const SEMANTIC_EMBEDDING_CAPABILITY = "semantic.embedding";
export const SEMANTIC_EMBEDDING_CAPABILITY_VERSION = "1.0.0";

/** Source model identity, pinned to the artifacts verified by the P13 preflight. */
export const EMBEDDING_MODEL_ID = "Xenova/multilingual-e5-small";
export const EMBEDDING_MODEL_VERSION = "761b726dd34fb83930e26aab4e9ac3899aa1fa78";
export const EMBEDDING_DIMENSIONS = 384;

export const RERANKER_MODEL_ID = "mogolloni/bge-reranker-v2-m3-onnx";
export const RERANKER_MODEL_VERSION = "e5023553f6c47f09057da7a19cdd79ef850a4985";

export interface SemanticPassage {
  entityId: string;
  /** Source `NearestHit.sceneId`; retained as an alias for downstream source APIs. */
  sceneId: string;
  sentenceIndex: number;
  text: string;
  type?: string;
  name?: string;
  filePath?: string;
}

export interface SemanticPassageHit {
  entityId: string;
  sceneId: string;
  sentenceIndex: number;
  text: string;
  score: number;
  type?: string;
  name?: string;
  filePath?: string;
}

export interface SemanticIndexResult {
  snapshot: SnapshotId;
  model: string;
  modelVersion: string;
  dimensions: number;
  scanned: number;
  embedded: number;
  reused: number;
  removed: number;
}

export interface SemanticNearestResult {
  snapshot: SnapshotId;
  model: string;
  modelVersion: string;
  dimensions: number;
  hits: SemanticPassageHit[];
}

export interface SemanticMentionPair {
  entityId: string;
  evidenceA: { sceneId: string; sentenceIndex: number; text: string };
  evidenceB: { sceneId: string; sentenceIndex: number; text: string };
  score: number;
}

export interface SemanticIndexStatus {
  snapshot: SnapshotId;
  model: string;
  modelVersion: string;
  dimensions: number;
  indexAvailable: boolean;
  passageCount: number;
  modelLoaded: boolean;
  rerankerLoaded: boolean;
  indexUpdatedAt: string | null;
}

export interface SemanticEmbeddingCapability {
  readonly model: { id: typeof EMBEDDING_MODEL_ID; version: typeof EMBEDDING_MODEL_VERSION; dimensions: typeof EMBEDDING_DIMENSIONS };
  index(
    passages: readonly SemanticPassage[],
    snapshot: SnapshotId,
    signal: AbortSignal,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<SemanticIndexResult>;
  nearest(
    query: string,
    snapshot: SnapshotId,
    options: { limit?: number; excludeSceneIds?: readonly string[] },
    signal: AbortSignal,
  ): Promise<SemanticNearestResult>;
  status(snapshot: SnapshotId, signal: AbortSignal): Promise<SemanticIndexStatus>;
  contradictionPairs(
    groups: readonly { entityId: string; anchors: readonly { sceneId: string; sentenceIndex: number }[] }[],
    snapshot: SnapshotId,
    options: { minimum: number; maximum: number },
    signal: AbortSignal,
  ): Promise<{ snapshot: SnapshotId; model: string; modelVersion: string; dimensions: number; pairs: SemanticMentionPair[] }>;
  embed(texts: readonly string[], snapshot: SnapshotId, signal: AbortSignal): Promise<{
    snapshot: SnapshotId;
    model: string;
    modelVersion: string;
    dimensions: number;
    vectors: number[][];
  }>;
  rerank(query: string, texts: readonly string[], snapshot: SnapshotId, signal: AbortSignal): Promise<{
    snapshot: SnapshotId;
    model: string;
    modelVersion: string;
    scores: number[];
  }>;
}
