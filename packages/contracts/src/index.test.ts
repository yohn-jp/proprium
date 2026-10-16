import { test } from "node:test";
import assert from "node:assert/strict";
import { assertChangeOperation, snapshotKey, type ChangeOperation } from "./index.js";
const operation: ChangeOperation = {
  id: "op-1", generation: 2, repository: { provider: "github", repositoryId: "12", defaultBranch: "writing", ownerScope: "owner", url: "https://github.com/example/work" },
  baseRemoteCommit: "a".repeat(40), effect: "manuscript", reads: [],
  writes: [{ path: "manuscripts/一.md", revision: null, content: "日本語" }], message: "Write scene",
};
test("recovery payload retains exact operation and snapshot identity", () => {
  const recovered = JSON.parse(JSON.stringify(operation));
  assert.doesNotThrow(() => assertChangeOperation(recovered));
  assert.deepEqual(recovered, operation);
  const snapshot = { repository: operation.repository, remoteCommit: operation.baseRemoteCommit };
  assert.notEqual(snapshotKey(snapshot), snapshotKey({ ...snapshot, overlayCommit: "b".repeat(40) }));
  assert.notEqual(snapshotKey(snapshot), snapshotKey({ ...snapshot, repository: { ...snapshot.repository, ownerScope: "other" } }));
});
test("untrusted recovery rejects traversal, duplicate writes and missing preconditions", () => {
  for (const path of ["../secret", "/absolute", "x/.GIT/config", "x\\y", "x//y"]) {
    assert.throws(() => assertChangeOperation({ ...operation, writes: [{ ...operation.writes[0], path }] }));
  }
  assert.throws(() => assertChangeOperation({ ...operation, writes: [...operation.writes, ...operation.writes] }));
  assert.throws(() => assertChangeOperation({ ...operation, writes: [{ path: "x", content: "x" }] }));
});
