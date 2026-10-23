import { test } from "node:test";
import assert from "node:assert/strict";
import { assertChangeOperation, BUILTIN_MODULE_IDS, createDocumentSource, snapshotKey, snapshotScopeRevision, type SnapshotReader, type ChangeOperation } from "./index.js";
test("built-in module IDs remain a frozen canonical tuple", () => {
  assert.deepEqual(BUILTIN_MODULE_IDS, ["story", "diagnostics", "nlp", "semantic", "speaker", "assistant", "publishing", "mcp", "search"]);
  assert.equal(Object.isFrozen(BUILTIN_MODULE_IDS), true);
});

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

test("document source keeps snapshot paths, uses revision metadata, and reports scoped deltas", async () => {
  const snapshot = { repository: operation.repository, remoteCommit: operation.baseRemoteCommit };
  const files = new Map([
    ["manuscript/scene.md", { content: "Scene text", revision: "a".repeat(64) }],
    ["manuscript/removed.md", { content: "Old text", revision: "b".repeat(64) }],
    ["meta/other.md", { content: "Outside scope", revision: "c".repeat(64) }],
  ]);
  const calls: string[] = [];
  const reader: SnapshotReader = {
    snapshot,
    async list(prefix) {
      calls.push(`list:${prefix}`);
      return [...files.keys()].filter(path => !prefix || path === prefix || path.startsWith(`${prefix}/`)).reverse();
    },
    async listRevisions(prefix) {
      calls.push(`revisions:${prefix}`);
      return [...files.entries()]
        .filter(([path]) => !prefix || path === prefix || path.startsWith(`${prefix}/`))
        .map(([path, file]) => ({ path, revision: file.revision }));
    },
    async read(path) {
      calls.push(`read:${path}`);
      return files.get(path) ?? null;
    },
  };
  const source = createDocumentSource(reader);
  assert.equal(source.version, 1);
  assert.deepEqual(source.snapshot, snapshot);
  assert.deepEqual(await source.enumerate("manuscript"), [
    { path: "manuscript/removed.md", revision: "b".repeat(64) },
    { path: "manuscript/scene.md", revision: "a".repeat(64) },
  ]);
  assert.deepEqual(calls, ["revisions:manuscript"], "metadata-backed enumeration does not read document contents");
  assert.deepEqual(await source.readMany(["manuscript/scene.md"]), [
    { path: "manuscript/scene.md", content: "Scene text", revision: "a".repeat(64) },
  ]);

  files.set("manuscript/scene.md", { content: "Updated text", revision: "d".repeat(64) });
  files.delete("manuscript/removed.md");
  files.set("manuscript/new.md", { content: "New text", revision: "e".repeat(64) });
  const delta = await source.changes([
    { path: "manuscript/scene.md", revision: "a".repeat(64) },
    { path: "manuscript/removed.md", revision: "b".repeat(64) },
    { path: "manuscript/new.md", revision: null },
    { path: "meta/other.md", revision: "c".repeat(64) },
  ], "manuscript");
  assert.deepEqual(delta, {
    upserted: [
      { path: "manuscript/new.md", revision: "e".repeat(64) },
      { path: "manuscript/scene.md", revision: "d".repeat(64) },
    ],
    removed: ["manuscript/removed.md"],
  });
});

test("document source rejects unsafe and out-of-scope snapshot paths", async () => {
  const reader: SnapshotReader = {
    snapshot: { repository: operation.repository, remoteCommit: operation.baseRemoteCommit },
    async list() { return ["manuscript/../secret.md"]; },
    async read() { return { content: "", revision: "a".repeat(64) }; },
  };
  const source = createDocumentSource(reader);
  await assert.rejects(source.enumerate("manuscript"));
  await assert.rejects(source.readMany([".git/config"]));

  const outsideReader: SnapshotReader = {
    ...reader,
    async listRevisions() { return [{ path: "meta/other.md", revision: "a".repeat(64) }]; },
  };
  await assert.rejects(createDocumentSource(outsideReader).enumerate("manuscript"));
});
