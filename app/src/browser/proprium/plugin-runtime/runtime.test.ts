import assert from "node:assert/strict";
import test from "node:test";
import { CapabilityBroker } from "./capability-broker.js";
import { assertSnapshot, intersectCapabilities, isSafePluginPath, LIMITS, matchesResponse, PluginRuntimeError, type PluginCapability, type RuntimeSnapshot, type WorkerRequest, type WorkerResponse } from "./protocol.js";

const snapshot: RuntimeSnapshot = {
  id: "snapshot-1", revision: "head-1", files: [{ path: "notes.md", revision: "file-1", content: "before" }],
};
const capabilities = new Set<PluginCapability>(["workspace.snapshot.read", "workspace.change.propose", "workspace.ui.contribute"]);

test("plugin grants require manifest request, user consent, and Host policy", () => {
  assert.deepEqual(intersectCapabilities([...capabilities], [...capabilities], [...capabilities]), [...capabilities]);
  assert.deepEqual(intersectCapabilities([...capabilities], ["workspace.change.propose"], [...capabilities]), ["workspace.change.propose"]);
  assert.deepEqual(intersectCapabilities([...capabilities], [...capabilities], ["workspace.ui.contribute"]), ["workspace.ui.contribute"]);
  assert.deepEqual(intersectCapabilities(["workspace.ui.contribute"], [...capabilities], [...capabilities]), ["workspace.ui.contribute"]);
});

function request(overrides: Partial<Extract<WorkerRequest, { type: "invoke" }>> = {}): Extract<WorkerRequest, { type: "invoke" }> {
  return {
    type: "invoke", id: "request-1", sessionId: "session-1", epoch: 3, pluginId: "example.runtime", version: "1.0.0",
    digest: "a".repeat(64), workspaceId: "workspace-1", deadlineAt: Date.now() + LIMITS.requestDeadlineMs, grants: [...capabilities],
    snapshot, request: "{}", ...overrides,
  };
}

test("broker lists and reads only pinned snapshot files and returns review-only proposals and UI", () => {
  const active = request();
  const broker = new CapabilityBroker(capabilities, active);
  assert.deepEqual(broker.snapshotList(), [{ path: "notes.md", revision: "file-1" }]);
  assert.equal(broker.snapshotRead("notes.md"), "before");
  assert.equal(broker.snapshotRead("missing.md"), undefined);
  broker.proposeChange({
    snapshotId: snapshot.id, snapshotRevision: snapshot.revision,
    readSet: [{ path: "notes.md", revision: "file-1" }, { path: "missing.md" }],
    changes: [{ path: "notes.md", expectedRevision: "file-1", content: "after" }],
  });
  broker.uiContribute({ kind: "panel", id: "summary", title: "Summary" });
  assert.deepEqual(broker.transcript("ok"), {
    requestId: active.id, sessionId: active.sessionId, epoch: active.epoch, pluginId: active.pluginId,
    version: active.version, digest: active.digest, workspaceId: active.workspaceId, deadlineAt: active.deadlineAt,
    grants: [...active.grants],
    snapshotId: snapshot.id, snapshotRevision: snapshot.revision, value: "ok",
    reads: [{ path: "notes.md", revision: "file-1" }, { path: "missing.md" }],
    proposals: [{ snapshotId: snapshot.id, snapshotRevision: snapshot.revision, readSet: [{ path: "notes.md", revision: "file-1" }, { path: "missing.md" }], changes: [{ path: "notes.md", expectedRevision: "file-1", content: "after" }] }],
    contributions: [{ kind: "panel", id: "summary", title: "Summary" }],
  });
});

test("broker rejects missing grants, stale or unsafe proposals, and expired requests", () => {
  const denied = new CapabilityBroker(new Set(), request({ grants: [] }));
  assert.throws(() => denied.snapshotRead("notes.md"), (error: unknown) => error instanceof PluginRuntimeError && error.code === "capability_denied");
  assert.throws(() => new CapabilityBroker(capabilities, request()).proposeChange({
    snapshotId: "old-snapshot", snapshotRevision: snapshot.revision, readSet: [], changes: [{ path: "notes.md", expectedRevision: "file-1", content: "after" }],
  }), (error: unknown) => error instanceof PluginRuntimeError && error.code === "snapshot_stale");
  assert.throws(() => new CapabilityBroker(capabilities, request()).proposeChange({
    snapshotId: snapshot.id, snapshotRevision: snapshot.revision, readSet: [], changes: [{ path: "../outside", content: "after" }],
  }), (error: unknown) => error instanceof PluginRuntimeError && error.code === "invalid_input");
  assert.throws(() => new CapabilityBroker(capabilities, request({ deadlineAt: Date.now() - 1 })).snapshotList(),
    (error: unknown) => error instanceof PluginRuntimeError && error.code === "timeout");
});

test("proposal and complete transcript budgets cap aggregate content across one invocation", () => {
  const broker = new CapabilityBroker(capabilities, request());
  broker.snapshotRead("notes.md");
  const proposal = {
    snapshotId: snapshot.id, snapshotRevision: snapshot.revision,
    readSet: [{ path: "notes.md", revision: "file-1" }],
    changes: [{ path: "notes.md", expectedRevision: "file-1", content: "x".repeat(10_000) }],
  };
  for (let index = 0; index < 26; index++) broker.proposeChange(proposal);
  assert.throws(() => broker.proposeChange(proposal),
    (error: unknown) => error instanceof PluginRuntimeError && error.code === "invalid_input");

  const transcript = new CapabilityBroker(capabilities, request());
  transcript.snapshotRead("notes.md");
  transcript.proposeChange({
    snapshotId: snapshot.id, snapshotRevision: snapshot.revision,
    readSet: [{ path: "notes.md", revision: "file-1" }],
    changes: [{ path: "notes.md", expectedRevision: "file-1", content: "x".repeat(60_000) }],
  });
  assert.throws(() => transcript.transcript("y".repeat(210_000)),
    (error: unknown) => error instanceof PluginRuntimeError && error.code === "invalid_input");

  const counted = new CapabilityBroker(capabilities, request());
  counted.proposeChange({
    snapshotId: snapshot.id, snapshotRevision: snapshot.revision, readSet: [],
    changes: Array.from({ length: LIMITS.proposalChanges }, (_, index) => ({ path: `new-${index}.txt`, content: "x" })),
  });
  assert.throws(() => counted.proposeChange({
    snapshotId: snapshot.id, snapshotRevision: snapshot.revision, readSet: [],
    changes: [{ path: "overflow.txt", content: "x" }],
  }), (error: unknown) => error instanceof PluginRuntimeError && error.code === "invalid_input");
});

test("snapshot and Worker envelopes bound payloads and reject stale request identities", () => {
  assertSnapshot(snapshot);
  assert.equal(isSafePluginPath("notes/日本語.md"), true);
  assert.equal(isSafePluginPath(".git/config"), false);
  assert.equal(isSafePluginPath("../outside"), false);
  assert.throws(() => assertSnapshot({ ...snapshot, files: [{ path: "notes.md", revision: "", content: "x" }] }),
    (error: unknown) => error instanceof PluginRuntimeError && error.code === "invalid_input");
  assert.throws(() => assertSnapshot({ ...snapshot, files: [{ path: "large.txt", revision: "r", content: "x".repeat(LIMITS.snapshotBytes + 1) }] }),
    (error: unknown) => error instanceof PluginRuntimeError && error.code === "invalid_input");

  const active = request();
  const response: WorkerResponse = {
    type: "invoke", id: active.id, sessionId: active.sessionId, epoch: active.epoch, pluginId: active.pluginId,
    version: active.version, digest: active.digest, workspaceId: active.workspaceId, deadlineAt: active.deadlineAt, grants: [...active.grants],
    snapshotId: snapshot.id, snapshotRevision: snapshot.revision,
  };
  assert.equal(matchesResponse(active, response), true);
  assert.equal(matchesResponse(active, { ...response, id: "old-request" }), false);
  assert.equal(matchesResponse(active, { ...response, sessionId: "old-session" }), false);
  assert.equal(matchesResponse(active, { ...response, epoch: 2 }), false);
  assert.equal(matchesResponse(active, { ...response, pluginId: "other.runtime" }), false);
  assert.equal(matchesResponse(active, { ...response, digest: "b".repeat(64) }), false);
  assert.equal(matchesResponse(active, { ...response, workspaceId: "old-workspace" }), false);
  assert.equal(matchesResponse(active, { ...response, deadlineAt: response.deadlineAt + 1 }), false);
  assert.equal(matchesResponse(active, { ...response, snapshotId: "snapshot-old" }), false);
  assert.equal(matchesResponse(active, { ...response, snapshotRevision: "head-old" }), false);
});
