import assert from "node:assert/strict";
import test from "node:test";
import { BrowserGitWriterWorkspace } from "./writer-browser.js";
import type { BrowserLocalGit } from "../git/index.js";

const scope = { workspace_id: "local-writer", repository_id: null, branch: "main", generation: "host-1" };
const snapshot = { id: "original", local_commit: null, worktree_generation: "a".repeat(64), draft_generation: null };

function fixture(mutate = false) {
  let pins = 0, releases = 0, assertions = 0;
  const files = Array.from({ length: 301 }, (_, i) => ({ path: `scene/${i}.yaml`, revision: `revision-${i}`, byte_length: 100, media_type: "text/yaml" }));
  const git = {
    pinAuthoringSnapshot: async () => { pins++; return { snapshot_id: "fresh", local_commit: null, worktree_generation: "a".repeat(64) }; },
    listAuthoringSnapshot: async (_id: string, _prefix: string, cursor: string | null) => {
      const start = Number(cursor ?? 0);
      return { items: files.slice(start, start + 128), next_cursor: start + 128 < files.length ? String(start + 128) : null };
    },
    assertAuthoringSnapshot: async () => { assertions++; if (mutate) throw Object.assign(new Error("changed"), { code: "snapshot_stale" }); },
    releaseAuthoringSnapshot: async () => { releases++; },
  } as unknown as BrowserLocalGit;
  const workspace = new BrowserGitWriterWorkspace(git, { provider: "local", name: "Writer fixture", localWorkspaceId: scope.workspace_id, branch: "main" }, {
    selected_scope: () => scope, is_editor_dirty: () => false,
    with_editor_write_guard: async (_scope, operation) => operation(),
  });
  return { workspace, files, counts: () => ({ pins, releases, assertions }) };
}

test("301 read dependencies use one paged fresh snapshot and retain the final generation guard", async () => {
  const { workspace, files, counts } = fixture();
  await workspace.assert_read_set(scope, snapshot, [...files.map(({ path, revision }) => ({ path, revision })), { path: "new.yaml", revision: null }]);
  assert.deepEqual(counts(), { pins: 1, releases: 1, assertions: 1 });
});

test("read-set sweep rejects changed and missing sources and releases its snapshot", async () => {
  for (const read of [{ path: "scene/0.yaml", revision: "old" }, { path: "missing.yaml", revision: "old" }, { path: "scene/0.yaml", revision: null }]) {
    const { workspace, counts } = fixture();
    await assert.rejects(workspace.assert_read_set(scope, snapshot, [read]), { code: "snapshot_stale" });
    assert.equal(counts().releases, 1);
  }
  const { workspace, files, counts } = fixture(true);
  await assert.rejects(workspace.assert_read_set(scope, snapshot, files), { code: "snapshot_stale" });
  assert.equal(counts().releases, 1);
});

test("foreign source dependencies require their separate Host authority", async () => {
  const { workspace, counts } = fixture();
  await assert.rejects(workspace.assert_read_set(scope, snapshot, [{ path: "other.yaml", revision: "old", scope: { ...scope, workspace_id: "other" }, snapshot }]), { code: "dependency_unavailable" });
  assert.equal(counts().pins, 0);
});
