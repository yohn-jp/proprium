import assert from "node:assert/strict";
import test from "node:test";
import {
  BGE_ASSET_GROUP_ID, BGE_MODEL, BGE_PREPARATION_TOTAL, releaseBgeReranker, setBgeRerankerBindings,
  startBgePreparation, stepBgePreparation,
} from "./reranker-inference.ts";
import type { HostCall } from "../shared/guest.ts";

const rangeCount = 393;
const baseBytes = Math.floor(BGE_MODEL.data_bytes / rangeCount);
const ranges = Array.from({ length: rangeCount }, (_, index) => {
  const offset = index * baseBytes;
  return { index, name: `tensor-${index}`, offset, bytes: index === rangeCount - 1 ? BGE_MODEL.data_bytes - offset : baseBytes };
});
let calls: Array<{ group_id: string; file_path: string; offset: number; length: number }> = [];
let appends = 0;
let releases = 0;
let loaded = false;

setBgeRerankerBindings({
  inspectGraph: () => ranges,
  beginData: () => undefined,
  beginTensor: () => undefined,
  appendTensor: () => { appends += 1; },
  finishTensor: () => undefined,
  finishData: () => undefined,
  beginTokenizer: () => undefined,
  appendTokenizer: () => undefined,
  finishTokenizer: () => undefined,
  loadModel: () => { loaded = true; },
  scorePair: (_query, passage) => passage === "positive" ? 3 : -2,
  modelId: () => BGE_MODEL.id,
  modelRevision: () => BGE_MODEL.revision,
  memoryBytes: () => 3_540_385_792n,
  release: () => { releases += 1; loaded = false; },
});

function host() {
  return {
    *request<T>(operation: string, payload: Record<string, unknown>): Generator<HostCall, T, unknown> {
      return (yield { kind: "host_call", call_id: "test", operation, payload }) as T;
    },
  };
}

function assetResult(call: HostCall): unknown {
  const request = call.payload as typeof calls[number];
  calls.push(request);
  const bytes = new Array(request.length).fill(0);
  const total = request.file_path === BGE_MODEL.graph_path ? BGE_MODEL.graph_bytes
    : request.file_path === BGE_MODEL.data_path ? BGE_MODEL.data_bytes : BGE_MODEL.tokenizer_bytes;
  return { group_id: request.group_id, file_path: request.file_path, offset: request.offset, total_bytes: total,
    bytes, sha256: request.file_path === BGE_MODEL.graph_path ? BGE_MODEL.graph_sha256
      : request.file_path === BGE_MODEL.data_path ? BGE_MODEL.data_sha256 : BGE_MODEL.tokenizer_sha256,
    next_offset: request.offset + bytes.length === total ? null : request.offset + bytes.length };
}
function invokeStep(taskId: string, sequence: number) {
  const iterator = stepBgePreparation(taskId, sequence, host() as never);
  let state = iterator.next();
  while (!state.done) state = iterator.next(assetResult(state.value as HostCall) as never);
  return state.value;
}

test("BGE uses a separate exact asset group and each scheduler action stays below 4096 range calls", () => {
  calls = []; appends = 0; releases = 0; loaded = false;
  const start = startBgePreparation("bge_task");
  assert.equal(start.phase, "inspect_graph");
  assert.equal(start.completed, 0);
  assert.equal(start.total, BGE_PREPARATION_TOTAL);
  assert.equal(start.total, 8_733);

  // The first Host call is the graph chunk. A missing asset grant fails closed before inference.
  const first = stepBgePreparation("bge_task", 1, { request: function* (operation: string, payload: Record<string, unknown>) {
    yield { kind: "host_call", call_id: "test", operation, payload };
    return undefined;
  } } as never);
  const call = first.next();
  assert.equal(call.value?.operation, "workspace.asset.read");
  assert.throws(() => first.throw(Object.assign(new Error("missing"), { code: "file_not_found" })),
    (error: Error & { code?: string }) => error.code === "provider_unavailable");
  assert.equal(loaded, false);
  assert.equal(releases, 2);

  const fresh = startBgePreparation("bge_task");
  assert.equal(fresh.state, "running");
  const result = invokeStep("bge_task", 1);
  assert.equal(result.state, "running");
  assert.equal(result.phase, "load_tensors");
  assert.equal(result.completed, 64);
  assert.ok(calls.length <= 64);
  assert.equal(calls.length, 64);
  assert.equal(calls[0]?.group_id, BGE_ASSET_GROUP_ID);
  assert.equal(calls[0]?.file_path, BGE_MODEL.graph_path);
  assert.equal(calls[2]?.file_path, BGE_MODEL.data_path);
  assert.equal(calls[2]?.offset, 0);
  assert.ok(appends >= 62);
  assert.ok(appends <= 64);
  releaseBgeReranker();
});
