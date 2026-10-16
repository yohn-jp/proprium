import type { MorphologyAnalysis } from "./tokenizer/types.js";

export const NLP_MODULE_VERSION = "0.1.0";
export const NLP_TOKENIZER_CAPABILITY = "nlp.tokenizer";
export const NLP_TOKENIZER_CAPABILITY_VERSION = "1.0.0";
export const NLP_MODEL_ID = "lindera-wasm-nodejs-ipadic";
export const NLP_MODEL_VERSION = "2.0.0";

export interface NlpTokenizerCapability {
  model: { id: typeof NLP_MODEL_ID; version: typeof NLP_MODEL_VERSION };
  analyze(text: string, snapshot: import("@scriptorium/contracts").SnapshotId, signal: AbortSignal): Promise<MorphologyAnalysis>;
}
