import type { GuestHost, HostCall } from "../shared/guest.ts";
import type { AssetReadResult } from "../shared/operations.ts";

export const BGE_ASSET_GROUP_ID = "proprium.semantic.reranker.bge-v2-m3";
export const BGE_MODEL = {
  id: "mogolloni/bge-reranker-v2-m3-onnx",
  revision: "e5023553f6c47f09057da7a19cdd79ef850a4985",
  graph_path: "proprium/semantic/reranker/bge-reranker-v2-m3/onnx/model.onnx",
  graph_bytes: 489_245,
  graph_sha256: "ed283424d9a40dbd6fe2f3081386848a88cc8057b7ab43e02d84077d6b69ba42",
  data_path: "proprium/semantic/reranker/bge-reranker-v2-m3/onnx/model.onnx_data",
  data_bytes: 2_271_088_656,
  data_sha256: "9a748c82efb2079d24650c489e053dbb3c71d8acbbcf04d7b2340db66f2748f7",
  tokenizer_path: "proprium/semantic/reranker/bge-reranker-v2-m3/tokenizer.json",
  tokenizer_bytes: 17_082_900,
  tokenizer_sha256: "8bf8afbfd11306bd872018c53bfdf2e160a56f8edbcf49933324404791c148d3",
  license: "Apache-2.0",
  group_bytes: 2_288_661_281,
  group_sha256: "970674bb1a64e34e9ce5c74bded1b90f85b602700f86344f0e209312163b9447",
} as const;

const RANGE_BYTES = 256 * 1024;
const READS_PER_STEP = 64;
const GRAPH_READS = Math.ceil(BGE_MODEL.graph_bytes / RANGE_BYTES);
const DATA_READS = Math.ceil(BGE_MODEL.data_bytes / RANGE_BYTES);
const TOKENIZER_READS = Math.ceil(BGE_MODEL.tokenizer_bytes / RANGE_BYTES);
export const BGE_PREPARATION_TOTAL = GRAPH_READS + DATA_READS + TOKENIZER_READS + 1;
const ASSET_READ = "workspace.asset.read";

export interface BgeTensorRange { readonly index: number; readonly name: string; readonly offset: number; readonly bytes: number }
export type BgePreparationPhase = "inspect_graph" | "load_tensors" | "load_tokenizer" | "compile" | "complete";
export interface BgePreparationProgress {
  readonly taskId: string;
  readonly state: "running" | "complete";
  readonly phase: BgePreparationPhase;
  readonly completed: number;
  readonly total: number;
  readonly modelId?: string;
  readonly modelRevision?: string;
  readonly groupId?: string;
}

export interface BgeRerankerBindings {
  inspectGraph(graph: Uint8Array, sha256: string): BgeTensorRange[];
  beginData(totalBytes: number, sha256: string): void;
  beginTensor(index: number): void;
  appendTensor(index: number, offset: number, bytes: Uint8Array): void;
  finishTensor(index: number): void;
  finishData(): void;
  beginTokenizer(totalBytes: number, sha256: string): void;
  appendTokenizer(offset: number, bytes: Uint8Array): void;
  finishTokenizer(): void;
  loadModel(): void;
  /** Returns the raw BGE relevance logit; the guest maps it to the action's bounded ranking score. */
  scorePair(query: string, passage: string): number;
  modelId(): string;
  modelRevision(): string;
  memoryBytes(): bigint | number;
  release(): void;
}

interface PreparationState {
  readonly taskId: string;
  nextSequence: number | undefined;
  completed: number;
  phase: BgePreparationPhase;
  graphOffset: number;
  graph?: Uint8Array;
  ranges: BgeTensorRange[];
  tensorIndex: number;
  tensorOffset: number;
  dataOffset: number;
  tensorStarted: boolean;
  tokenizerOffset: number;
  tokenizerStarted: boolean;
  lastProgress: BgePreparationProgress;
}

let bindings: BgeRerankerBindings | undefined;
let prepared = false;
let preparation: PreparationState | undefined;

export function setBgeRerankerBindings(value: BgeRerankerBindings): void {
  if (bindings) throw new Error("BGE reranker inference bindings are already installed");
  bindings = value;
}

function fail(code: string, message: string): Error { return Object.assign(new Error(message), { code, retryable: code === "capacity" || code === "timeout" }); }
function engine(): BgeRerankerBindings {
  if (!bindings) throw fail("provider_unavailable", "This signed Semantic component does not provide the BGE reranker");
  return bindings;
}
function running(state: PreparationState): BgePreparationProgress {
  return { taskId: state.taskId, state: "running", phase: state.phase, completed: state.completed, total: BGE_PREPARATION_TOTAL };
}
function complete(taskId: string, completed = BGE_PREPARATION_TOTAL): BgePreparationProgress {
  return { taskId, state: "complete", phase: "complete", completed, total: BGE_PREPARATION_TOTAL,
    modelId: BGE_MODEL.id, modelRevision: BGE_MODEL.revision, groupId: BGE_ASSET_GROUP_ID };
}
function newState(taskId: string, sequence?: number): PreparationState {
  const progress: BgePreparationProgress = { taskId, state: "running", phase: "inspect_graph", completed: 0, total: BGE_PREPARATION_TOTAL };
  return { taskId, nextSequence: sequence, completed: 0, phase: "inspect_graph", graphOffset: 0, ranges: [], tensorIndex: 0,
    tensorOffset: 0, dataOffset: 0, tensorStarted: false, tokenizerOffset: 0, tokenizerStarted: false, lastProgress: progress };
}

/** A fresh Host gesture starts a separate load task; E5 consent never reaches this path. */
export function startBgePreparation(taskId: string): BgePreparationProgress {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(taskId)) throw fail("invalid_input", "BGE task ID is invalid");
  if (prepared) return complete(taskId);
  engine().release();
  // The Host's private one-use step permit owns the first sequence. Bind to it
  // on the first step so a same-session resume can continue at Host sequence N+1.
  preparation = newState(taskId);
  return running(preparation);
}

export function* stepBgePreparation(taskId: string, sequence: number, host: GuestHost): Generator<HostCall, BgePreparationProgress, unknown> {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(taskId) || !Number.isSafeInteger(sequence) || sequence < 0 || sequence > 1_000_000) {
    throw fail("invalid_input", "BGE task identity or sequence is invalid");
  }
  const inference = engine();
  if (prepared) return complete(taskId);
  if (!preparation || preparation.taskId !== taskId) {
    // The Host journal never pretends that a previous Worker still owns WASM memory.
    // A resumed preparation replays from verified local asset chunks in this runtime.
    inference.release();
    preparation = newState(taskId, sequence);
  }
  const state = preparation;
  // A new or explicitly restarted guest runtime has no durable cursor. Accept
  // only the sequence the Host has already authorized, then enforce continuity.
  state.nextSequence ??= sequence;
  if (sequence < state.nextSequence) return state.lastProgress;
  if (sequence !== state.nextSequence) throw fail("snapshot_stale", "BGE preparation sequence skipped a checkpoint");
  let reads = 0;
  const readRange = function* (path: string, offset: number, expectedBytes: number, expectedSha256: string,
    requested: number): Generator<HostCall, Uint8Array, unknown> {
    const result = yield* host.request<AssetReadResult>(ASSET_READ, {
      group_id: BGE_ASSET_GROUP_ID, file_path: path, offset, length: requested,
    });
    reads += 1;
    if (!result || result.group_id !== BGE_ASSET_GROUP_ID || result.file_path !== path || result.offset !== offset ||
        result.total_bytes !== expectedBytes || result.sha256 !== expectedSha256 || !Array.isArray(result.bytes) ||
        result.bytes.length < 1 || result.bytes.length > RANGE_BYTES || result.bytes.length !== requested ||
        result.bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
      throw fail("model_unavailable", "Host returned a range outside the separately admitted BGE model files");
    }
    const next = offset + result.bytes.length;
    if (next > expectedBytes || (result.next_offset !== null && result.next_offset !== next) ||
        (result.next_offset === null && next !== expectedBytes)) throw fail("model_unavailable", "Host returned a discontinuous BGE asset range");
    state.completed += 1;
    return Uint8Array.from(result.bytes);
  };
  try {
    while (state.phase !== "complete" && reads < READS_PER_STEP) {
      if (state.phase === "inspect_graph") {
        state.graph ??= new Uint8Array(BGE_MODEL.graph_bytes);
        const count = Math.min(RANGE_BYTES, BGE_MODEL.graph_bytes - state.graphOffset);
        const bytes = yield* readRange(BGE_MODEL.graph_path, state.graphOffset, BGE_MODEL.graph_bytes, BGE_MODEL.graph_sha256, count);
        state.graph.set(bytes, state.graphOffset);
        state.graphOffset += bytes.byteLength;
        if (state.graphOffset === BGE_MODEL.graph_bytes) {
          const ranges = inference.inspectGraph(state.graph, BGE_MODEL.graph_sha256);
          validateRanges(ranges);
          state.ranges = ranges;
          state.graph = undefined;
          inference.beginData(BGE_MODEL.data_bytes, BGE_MODEL.data_sha256);
          state.phase = "load_tensors";
        }
      } else if (state.phase === "load_tensors") {
        if (state.dataOffset === BGE_MODEL.data_bytes) {
          if (state.tensorIndex !== state.ranges.length || state.tensorOffset !== 0 || state.tensorStarted) throw fail("model_unavailable", "BGE data transfer ended between tensor boundaries");
          inference.finishData();
          inference.beginTokenizer(BGE_MODEL.tokenizer_bytes, BGE_MODEL.tokenizer_sha256);
          state.phase = "load_tokenizer";
          state.tokenizerStarted = true;
          continue;
        }
        const count = Math.min(RANGE_BYTES, BGE_MODEL.data_bytes - state.dataOffset);
        const bytes = yield* readRange(BGE_MODEL.data_path, state.dataOffset, BGE_MODEL.data_bytes, BGE_MODEL.data_sha256, count);
        let used = 0;
        while (used < bytes.byteLength) {
          const range = state.ranges[state.tensorIndex];
          if (!range) throw fail("model_unavailable", "Pinned BGE tensor ranges ended before the signed data file");
          if (!state.tensorStarted) { inference.beginTensor(range.index); state.tensorStarted = true; }
          const take = Math.min(bytes.byteLength - used, range.bytes - state.tensorOffset);
          if (take <= 0) throw fail("model_unavailable", "Pinned BGE tensor range is empty or already complete");
          inference.appendTensor(range.index, state.tensorOffset, bytes.subarray(used, used + take));
          used += take;
          state.dataOffset += take;
          state.tensorOffset += take;
          if (state.tensorOffset === range.bytes) {
            inference.finishTensor(range.index);
            state.tensorIndex += 1;
            state.tensorOffset = 0;
            state.tensorStarted = false;
          }
        }
      } else if (state.phase === "load_tokenizer") {
        if (!state.tokenizerStarted) {
          inference.beginTokenizer(BGE_MODEL.tokenizer_bytes, BGE_MODEL.tokenizer_sha256);
          state.tokenizerStarted = true;
        }
        const count = Math.min(RANGE_BYTES, BGE_MODEL.tokenizer_bytes - state.tokenizerOffset);
        const bytes = yield* readRange(BGE_MODEL.tokenizer_path, state.tokenizerOffset,
          BGE_MODEL.tokenizer_bytes, BGE_MODEL.tokenizer_sha256, count);
        inference.appendTokenizer(state.tokenizerOffset, bytes);
        state.tokenizerOffset += bytes.byteLength;
        if (state.tokenizerOffset === BGE_MODEL.tokenizer_bytes) {
          inference.finishTokenizer();
          state.phase = "compile";
          break;
        }
      } else if (state.phase === "compile") {
        inference.loadModel();
        if (inference.modelId() !== BGE_MODEL.id || inference.modelRevision() !== BGE_MODEL.revision) {
          throw fail("model_unavailable", "The composed component reports another BGE model identity");
        }
        const memory = Number(inference.memoryBytes());
        if (!Number.isSafeInteger(memory) || memory < 0 || memory > 4 * 1024 ** 3) {
          throw fail("capacity", "BGE model memory use exceeds the supported WASM32 working range");
        }
        state.completed += 1;
        state.phase = "complete";
        prepared = true;
      }
    }
    state.nextSequence = sequence + 1;
    state.lastProgress = state.phase === "complete" ? complete(taskId, state.completed) : running(state);
    return state.lastProgress;
  } catch (error) {
    inference.release();
    prepared = false;
    preparation = undefined;
    throw normalizeBgeError(error);
  }
}

export interface BgeRerankCandidate {
  readonly candidateId: string;
  readonly entityId: string;
  readonly sourcePath: string;
  readonly sourceRevision: string;
  readonly sentenceIndex?: number;
  readonly text: string;
  readonly evidence: readonly { path: string; revision: string; start: number; end: number; quote: string }[];
}

export interface BgeRerankLogit { readonly candidateId: string; readonly logit: number }

/** Convert raw relevance logits into the bounded score required by the plugin action contract. */
export function rankBgeLogits(scored: readonly BgeRerankLogit[], limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 30 || scored.length > 30) {
    throw fail("invalid_input", "BGE candidate count or output limit is invalid");
  }
  const seen = new Set<string>();
  const ranked = scored.map((item, originalIndex) => {
    if (!item || typeof item.candidateId !== "string" || item.candidateId.length < 1 || item.candidateId.length > 128 || seen.has(item.candidateId)) {
      throw fail("invalid_input", "BGE candidate IDs must be unique nonempty strings up to 128 characters");
    }
    seen.add(item.candidateId);
    if (!Number.isFinite(item.logit)) throw fail("model_unavailable", "BGE returned a non-finite score");
    const score = item.logit >= 0
      ? 1 / (1 + Math.exp(-item.logit))
      : Math.exp(item.logit) / (1 + Math.exp(item.logit));
    return { candidateId: item.candidateId, logit: item.logit, score, originalIndex };
  });
  ranked.sort((left, right) => left.logit === right.logit ? left.originalIndex - right.originalIndex : left.logit > right.logit ? -1 : 1);
  return ranked.slice(0, limit).map(({ candidateId, score }, index) => ({ candidateId, score, rank: index + 1 }));
}

export function rerankBge(query: string, candidates: readonly BgeRerankCandidate[], limit: number) {
  if (!prepared) throw fail("provider_unavailable", "The explicitly prepared BGE reranker is not loaded in this runtime");
  const inference = engine();
  const results = rankBgeLogits(candidates.map(candidate => ({
    candidateId: candidate.candidateId,
    logit: inference.scorePair(query, candidate.text),
  })), limit);
  return { model: { id: BGE_MODEL.id, revision: BGE_MODEL.revision, role: "reranker" as const,
    digest: BGE_MODEL.group_sha256, byte_length: BGE_MODEL.group_bytes, license: BGE_MODEL.license, status: "ready" as const }, results };
}

export function bgeRerankerLoaded(): boolean { return prepared; }
export function releaseBgeReranker(): void {
  if (bindings) bindings.release();
  prepared = false;
  preparation = undefined;
}

function validateRanges(ranges: readonly BgeTensorRange[]): void {
  if (!Array.isArray(ranges) || ranges.length !== 393) throw fail("model_unavailable", "Pinned BGE graph declares an unexpected external tensor count");
  let offset = 0;
  for (let index = 0; index < ranges.length; index += 1) {
    const item = ranges[index];
    if (!item || item.index !== index || typeof item.name !== "string" || !item.name || item.name.length > 1024 ||
        !Number.isSafeInteger(item.offset) || item.offset !== offset || !Number.isSafeInteger(item.bytes) || item.bytes < 1 ||
        item.bytes > BGE_MODEL.data_bytes - offset) throw fail("model_unavailable", "Pinned BGE graph returned overlapping or discontinuous external tensors");
    offset += item.bytes;
  }
  if (offset !== BGE_MODEL.data_bytes) throw fail("model_unavailable", "Pinned BGE external tensors do not cover the signed data file");
}

function normalizeBgeError(error: unknown): Error {
  const value = error as { code?: unknown; message?: unknown } | null;
  const message = typeof value?.message === "string" ? value.message : String(error);
  if (typeof value?.code === "string") {
    if (["file_not_found", "asset_unavailable", "plugin_asset_missing"].includes(value.code)) {
      return fail("provider_unavailable", "The separately consented BGE asset group is not admitted for this plugin version");
    }
    return fail(value.code, message);
  }
  const separator = message.indexOf(":");
  const prefix = separator < 0 ? "" : message.slice(0, separator);
  if (["invalid_input", "provider_unavailable", "model_unavailable", "capacity", "timeout", "cancelled", "snapshot_stale", "capability_denied"].includes(prefix)) {
    return fail(prefix, message.slice(separator + 1).trim());
  }
  return fail("model_unavailable", "The pinned BGE reranker could not load or score this input");
}
