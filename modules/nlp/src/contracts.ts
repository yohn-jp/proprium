import type { MorphologyAnalysis } from "./tokenizer/types.js";
import type { SnapshotId } from "@scriptorium/contracts";

export const NLP_MODULE_VERSION = "0.1.0";
export const NLP_TOKENIZER_CAPABILITY = "nlp.tokenizer";
export const NLP_TOKENIZER_CAPABILITY_VERSION = "1.0.0";
export const NLP_TOKEN_COUNTER_CAPABILITY = "nlp.token-counter";
export const NLP_TOKEN_COUNTER_CAPABILITY_VERSION = "1.0.0";
export const NLP_MODEL_ID = "lindera-wasm-nodejs-ipadic";
export const NLP_MODEL_VERSION = "2.0.0";
export const NLP_TOKENIZER_ENGINE_VERSION = "3.8.1";
export const NLP_APPROX_TOKEN_COUNTER_VERSION = "source-approx-v1";

export interface NlpTokenizerCapability {
  model: { id: typeof NLP_MODEL_ID; version: typeof NLP_MODEL_VERSION };
  analyze(text: string, snapshot: import("@scriptorium/contracts").SnapshotId, signal: AbortSignal): Promise<MorphologyAnalysis>;
}

export interface NlpTokenCounterIdentity {
  /** The configured model id, or `approx` when the source fallback is active. */
  modelId: string;
  exact: boolean;
  engine: "huggingface-transformers" | "source-approx";
  engineVersion: typeof NLP_TOKENIZER_ENGINE_VERSION | typeof NLP_APPROX_TOKEN_COUNTER_VERSION;
  requestedModelId?: string;
  fallbackReason?: "backend_approx" | "model_unconfigured" | "tokenizer_unavailable";
}

export interface NlpTokenCountBatch {
  snapshot: SnapshotId;
  counts: number[];
  counter: NlpTokenCounterIdentity;
}

/** Model-specific source token counting, with the source-approved conservative fallback. */
export interface NlpTokenCounterCapability {
  countMany(
    texts: readonly string[],
    snapshot: SnapshotId,
    signal: AbortSignal,
    options?: { modelId?: string },
  ): Promise<NlpTokenCountBatch>;
}
