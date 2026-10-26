import assert from "node:assert/strict";
import test from "node:test";
import type { ActionRequest } from "../../authoring/types.js";
import {
  assertActionRequest, decodeGuestStep, encodeHostResponse, validateHostResponse, V2PluginRuntimeError,
} from "./protocol.js";

const request: ActionRequest = {
  schema_version: 1,
  request_id: "request-123",
  plugin_id: "proprium.narrative",
  action_id: "proprium.narrative.hierarchy.tree",
  scope: { workspace_id: "work-1", repository_id: 7, branch: "main", generation: "generation-1" },
  snapshot: { id: "snapshot-1", local_commit: null, worktree_generation: "generation-1", draft_generation: null },
  input: {},
  deadline_ms: 30_000,
};

test("v2 ActionRequest is pinned to the activated plugin and workspace", () => {
  assertActionRequest(request, "proprium.narrative", "work-1");
  assert.throws(() => assertActionRequest({ ...request, plugin_id: "proprium.compute-sum" }, "proprium.narrative", "work-1"),
    (error: unknown) => error instanceof V2PluginRuntimeError && error.code === "invalid_input");
  assert.throws(() => assertActionRequest({ ...request, scope: { ...request.scope, workspace_id: "work-2" } }, "proprium.narrative", "work-1"),
    (error: unknown) => error instanceof V2PluginRuntimeError && error.code === "invalid_input");
});

test("guest continuation binds each call to its request and monotonically increasing sequence", () => {
  const yielded = decodeGuestStep(JSON.stringify({
    kind: "host_call", call_id: "request-123:1", operation: "workspace.file.list", payload: { prefix: "plot/", limit: 128 },
  }), request, 1);
  assert.equal(yielded.kind, "host_call");
  if (yielded.kind === "host_call") {
    assert.equal(yielded.call.call_id, "request-123:1");
    assert.equal(yielded.call.operation, "workspace.file.list");
  }
  assert.throws(() => decodeGuestStep(JSON.stringify({
    kind: "host_call", call_id: "request-123:3", operation: "workspace.file.read", payload: { path: "scene.md" },
  }), request, 2), (error: unknown) => error instanceof V2PluginRuntimeError && error.code === "malformed_message");
  assert.throws(() => decodeGuestStep(JSON.stringify({
    kind: "host_call", call_id: "request-123:2", operation: "workspace.file.read", payload: {}, undeclared: true,
  }), request, 2), (error: unknown) => error instanceof V2PluginRuntimeError && error.code === "malformed_message");
});

test("Host response resumes only the outstanding call ID and preserves byte arrays", () => {
  const raw = encodeHostResponse("request-123:1", { bytes: [0xE3, 0x81, 0x82], next_offset: 3 });
  const response = JSON.parse(raw) as unknown;
  validateHostResponse(response, "request-123:1");
  assert.deepEqual((response as { value: { bytes: number[] } }).value.bytes, [0xE3, 0x81, 0x82]);
  assert.throws(() => validateHostResponse(response, "request-123:2"),
    (error: unknown) => error instanceof V2PluginRuntimeError && error.code === "malformed_message");
});

test("final ActionResult cannot change scope, snapshot, or request identity", () => {
  const result = {
    request_id: request.request_id, scope: request.scope, snapshot: request.snapshot,
    ok: true, value: { items: [] }, warnings: [],
  };
  assert.equal(decodeGuestStep(JSON.stringify(result), request, 1).kind, "result");
  assert.throws(() => decodeGuestStep(JSON.stringify({ ...result, request_id: "other" }), request, 1),
    (error: unknown) => error instanceof V2PluginRuntimeError && error.code === "malformed_message");
  assert.throws(() => decodeGuestStep(JSON.stringify({ ...result, snapshot: { ...request.snapshot, id: "newer" } }), request, 1),
    (error: unknown) => error instanceof V2PluginRuntimeError && error.code === "malformed_message");
});

