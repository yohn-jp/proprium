import { test } from "node:test";
import assert from "node:assert/strict";
import { assertChangeOperation, snapshotKey, snapshotScopeRevision, type SnapshotReader, type ChangeOperation } from "./index.js";
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

test("scope guards bind unseen insertions, deletions and file revisions independent of listing order", async () => {
  const files = new Map([["bible/a.yaml", "a".repeat(64)], ["bible/b.yaml", "b".repeat(64)]]);
  let reverse = false;
  const reader: SnapshotReader = {
    snapshot: { repository: operation.repository, remoteCommit: operation.baseRemoteCommit },
    async list() { const paths = [...files.keys()]; return reverse ? paths.reverse() : paths; },
    async read(path) { const revision = files.get(path); return revision ? { content: "", revision } : null; },
  };
  const initial = await snapshotScopeRevision(reader, "bible");
  reverse = true;
  assert.equal(await snapshotScopeRevision(reader, "bible"), initial);
  files.set("bible/new.yaml", "c".repeat(64));
  assert.notEqual(await snapshotScopeRevision(reader, "bible"), initial);
  files.delete("bible/new.yaml");
  files.set("bible/a.yaml", "d".repeat(64));
  assert.notEqual(await snapshotScopeRevision(reader, "bible"), initial);
  files.delete("bible/a.yaml");
  assert.notEqual(await snapshotScopeRevision(reader, "bible"), initial);
  assert.doesNotThrow(() => assertChangeOperation({ ...operation, readScopes: [{ prefix: "bible", revision: initial }] }));
  for (const readScopes of [[{ prefix: "../secret", revision: initial }], [{ prefix: "bible", revision: null }], [{ prefix: "bible", revision: initial }, { prefix: "bible", revision: initial }]]) {
    assert.throws(() => assertChangeOperation({ ...operation, readScopes }));
  }
  await assert.rejects(snapshotScopeRevision({ ...reader, async list() { return ["manuscript/outside.md"]; } }, "bible"));
});
