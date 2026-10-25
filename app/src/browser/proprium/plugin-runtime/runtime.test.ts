import assert from "node:assert/strict";
import test from "node:test";
import { assertSnapshot, matchesResponse, PluginRuntimeError, type WorkerRequest, type WorkerResponse } from "./protocol.js";

const snapshot = { id: "snapshot-1", revision: "head-1" };

test("snapshot envelopes validate bounded identities", () => {
  assertSnapshot(snapshot);
  assert.throws(() => assertSnapshot({ ...snapshot, id: "x".repeat(257) }),
    (error: unknown) => error instanceof PluginRuntimeError && error.code === "invalid_input");
});

test("Worker responses reject old request, epoch, workspace, and snapshot identities", () => {
  const request: WorkerRequest = {
    type: "invoke", id: "r1", epoch: 4, workspaceId: "workspace-1", snapshotId: snapshot.id, snapshotRevision: snapshot.revision, request: "{}",
  };
  const response: WorkerResponse = { type: "invoke", id: "r1", epoch: 4, workspaceId: "workspace-1", snapshotId: snapshot.id };
  assert.equal(matchesResponse(request, response), true);
  assert.equal(matchesResponse(request, { ...response, id: "old-request" }), false);
  assert.equal(matchesResponse(request, { ...response, epoch: 3 }), false);
  assert.equal(matchesResponse(request, { ...response, workspaceId: "old-workspace" }), false);
  assert.equal(matchesResponse(request, { ...response, snapshotId: "snapshot-old" }), false);
});
