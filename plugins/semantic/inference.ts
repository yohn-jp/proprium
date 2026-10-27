import type { GuestHost } from "../shared/guest.ts";

export const E5_ASSET_GROUP_ID = "proprium.semantic.embedding.e5-small";
export const E5_MODEL = {
  id: "Xenova/multilingual-e5-small",
  revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
  model_path: "proprium/semantic/embedding/e5-small/onnx/model.onnx",
  model_bytes: 470_268_533,
  model_sha256: "4aa845c27760e06e9a686b9d8b5d440eae4b6612cd09e5b522b716d3941f77ff",
  tokenizer_path: "proprium/semantic/embedding/e5-small/tokenizer.json",
  tokenizer_bytes: 17_082_730,
  tokenizer_sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
  dimensions: 384,
  group_bytes: 492_423_173,
  license: "MIT",
} as const;

export interface AssetReadResult {
  group_id: string;
  file_path: string;
  offset: number;
  total_bytes: number;
  bytes: number[];
  sha256: string;
  next_offset: number | null;
}

export interface InferenceBindings {
  beginAsset(groupId: string, filePath: string, totalBytes: number, sha256: string): void;
  appendAsset(groupId: string, filePath: string, offset: number, bytes: Uint8Array): void;
  finishAsset(groupId: string, filePath: string): void;
  loadEmbedding(): void;
  embedPassages(texts: string[]): Array<number[] | Float32Array>;
  release(): void;
  splitSentenceEnds(text: string): number[] | Uint32Array;
}

const ASSET_READ = "workspace.asset.read";
const ASSET_CHUNK_BYTES = 128 * 1024;
const ASSET_MAX_CHUNK_BYTES = 256 * 1024;
const MAX_EMBEDDING_BATCH = 32;
const CANONICAL_ERRORS = new Set([
  "invalid_input", "plugin_unavailable", "dependency_unavailable", "capability_denied",
  "provider_unavailable", "snapshot_stale", "index_missing", "index_stale", "task_exists",
  "model_unavailable", "cache_corrupt", "capacity", "timeout", "cancelled", "guest_trap",
]);

let bindings: InferenceBindings | undefined;
let ready = false;
let loading = false;

export function setInferenceBindings(value: InferenceBindings): void {
  if (bindings) throw new Error("Semantic inference bindings are already installed");
  bindings = value;
}

function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, retryable: code === "capacity" || code === "timeout" });
}

function modelUnavailable(error: unknown): Error {
  const value = error as { code?: unknown; message?: unknown } | null;
  const detail = typeof value?.message === "string" ? value.message : String(error);
  if (value?.code === "file_not_found" || value?.code === "asset_unavailable" || value?.code === "plugin_asset_missing") {
    return failure("provider_unavailable", "The pinned E5 asset is not admitted for this plugin version");
  }
  const code = typeof value?.code === "string" && CANONICAL_ERRORS.has(value.code)
    ? value.code
    : (() => {
      const prefix = detail.slice(0, detail.indexOf(":") < 0 ? detail.length : detail.indexOf(":"));
      return CANONICAL_ERRORS.has(prefix) ? prefix : "model_unavailable";
    })();
  if (code === "file_not_found" || code === "asset_unavailable" || code === "plugin_asset_missing") {
    return failure("provider_unavailable", "The pinned E5 asset is not admitted for this plugin version");
  }
  return failure(code, detail.replace(/^[a-z_]+:\s*/u, ""));
}

function expectBindings(): InferenceBindings {
  if (!bindings) throw failure("provider_unavailable", "This build has no admitted Semantic inference component");
  return bindings;
}

function validateRange(value: AssetReadResult, path: string, offset: number): void {
  if (!value || value.group_id !== E5_ASSET_GROUP_ID || value.file_path !== path || value.offset !== offset ||
      !Number.isSafeInteger(value.total_bytes) || value.total_bytes <= 0 ||
      typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.sha256) ||
      !Array.isArray(value.bytes) || value.bytes.length === 0 || value.bytes.length > ASSET_MAX_CHUNK_BYTES ||
      value.bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw failure("model_unavailable", "The Host returned an invalid signed model asset range");
  }
  const nextOffset = offset + value.bytes.length;
  if (nextOffset > value.total_bytes ||
      (value.next_offset !== null && (!Number.isSafeInteger(value.next_offset) || value.next_offset !== nextOffset)) ||
      (value.next_offset === null && nextOffset !== value.total_bytes)) {
    throw failure("model_unavailable", "The Host returned a discontinuous model asset range");
  }
}

function* loadAsset(
  host: GuestHost,
  path: string,
  byteLength: number,
  expectedDigest: string,
): Generator<import("../shared/guest.ts").HostCall, void, unknown> {
  const engine = expectBindings();
  let offset = 0;
  let started = false;
  while (true) {
    const range = yield* host.request<AssetReadResult>(ASSET_READ, {
      group_id: E5_ASSET_GROUP_ID,
      file_path: path,
      offset,
      length: ASSET_CHUNK_BYTES,
    });
    validateRange(range, path, offset);
    if (range.total_bytes !== byteLength || range.sha256 !== expectedDigest) {
      throw failure("model_unavailable", "The admitted model metadata does not match the pinned E5 release");
    }
    if (!started) {
      engine.beginAsset(E5_ASSET_GROUP_ID, path, range.total_bytes, range.sha256);
      started = true;
    }
    engine.appendAsset(E5_ASSET_GROUP_ID, path, offset, Uint8Array.from(range.bytes));
    offset += range.bytes.length;
    if (range.next_offset === null) break;
    if (range.next_offset <= offset - range.bytes.length) throw failure("model_unavailable", "The Host model asset cursor did not advance");
    offset = range.next_offset;
  }
  engine.finishAsset(E5_ASSET_GROUP_ID, path);
}

export function* ensureEmbedding(host: GuestHost): Generator<import("../shared/guest.ts").HostCall, void, unknown> {
  if (ready) return;
  if (loading) throw failure("capacity", "Semantic model loading is already in progress");
  const engine = expectBindings();
  loading = true;
  try {
    yield* loadAsset(host, E5_MODEL.model_path, E5_MODEL.model_bytes, E5_MODEL.model_sha256);
    yield* loadAsset(host, E5_MODEL.tokenizer_path, E5_MODEL.tokenizer_bytes, E5_MODEL.tokenizer_sha256);
    engine.loadEmbedding();
    ready = true;
  } catch (error) {
    engine.release();
    throw modelUnavailable(error);
  } finally {
    loading = false;
  }
}

/** Validate native component vectors, including typed arrays from another realm. */
export function validateEmbeddingBatch(batch: unknown, expected: number): number[][] {
  if (!Array.isArray(batch) || batch.length !== expected) throw failure("model_unavailable", "The E5 component returned invalid embedding vectors");
  return batch.map(raw => {
    if (!Array.isArray(raw) && !(ArrayBuffer.isView(raw) && Object.prototype.toString.call(raw) === "[object Float32Array]")) throw failure("model_unavailable", "The E5 component returned invalid embedding vectors");
    const vector = Array.from(raw as ArrayLike<number>);
    if (vector.length !== E5_MODEL.dimensions || vector.some(value => typeof value !== "number" || !Number.isFinite(value))) throw failure("model_unavailable", "The E5 component returned invalid embedding vectors");
    return vector;
  });
}

export function embedPassages(texts: readonly string[]): number[][] {
  if (!ready) throw failure("provider_unavailable", "The signed E5 model is not loaded");
  const engine = expectBindings();
  const output: number[][] = [];
  for (let offset = 0; offset < texts.length; offset += MAX_EMBEDDING_BATCH) {
    const batch = engine.embedPassages(texts.slice(offset, offset + MAX_EMBEDDING_BATCH));
    output.push(...validateEmbeddingBatch(batch, Math.min(MAX_EMBEDDING_BATCH, texts.length - offset)));
  }
  return output;
}

export function embeddingLoaded(): boolean { return ready; }

export function releaseEmbedding(): void {
  if (bindings) bindings.release();
  ready = false;
  loading = false;
}

/** UAX #29 sentence breaks from the component's pinned Unicode implementation. */
export function componentSentenceEnds(text: string): number[] {
  if (!bindings) throw failure("dependency_unavailable", "This runtime does not provide the pinned Japanese sentence segmenter");
  const raw = bindings.splitSentenceEnds(text);
  if (!Array.isArray(raw) && !(ArrayBuffer.isView(raw) && Object.prototype.toString.call(raw) === "[object Uint32Array]")) throw failure("dependency_unavailable", "The component returned invalid sentence boundaries");
  const ends = Array.from(raw);
  if (ends.length > text.length || ends.some((end, index) => !Number.isSafeInteger(end) || end <= (index ? ends[index - 1]! : 0) || end > text.length) || (text.length > 0 && ends[ends.length - 1] !== text.length)) {
    throw failure("dependency_unavailable", "The component returned invalid sentence boundaries");
  }
  return ends;
}
