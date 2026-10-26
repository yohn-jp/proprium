import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActionRequest } from "../../app/src/browser/proprium/authoring/types.js";
import { guest } from "./guest.js";

test("official Research guest exports the cooperative v2 lifecycle and returns a Host continuation", () => {
  const request: ActionRequest = {
    schema_version: 1, request_id: "research-status-1", plugin_id: "proprium.research", action_id: "research.index.status",
    scope: { workspace_id: "workspace-guest", repository_id: 7, branch: "main", generation: "scope-1" },
    snapshot: { id: "snapshot-guest", local_commit: null, worktree_generation: "worktree-1", draft_generation: null },
    input: {}, deadline_ms: 30_000,
  };
  guest.initialize({ pluginId: "proprium.research", version: "1.0.0", workspaceId: request.scope.workspace_id });
  try {
    const yielded = JSON.parse(guest.invoke(JSON.stringify(request))) as { kind: string; call_id: string; operation: string; payload: Record<string, unknown> };
    assert.equal(yielded.kind, "host_call");
    assert.equal(yielded.call_id, "research-status-1:1");
    assert.equal(yielded.operation, "workspace.derived.cache.get");
    assert.deepEqual(Object.keys(yielded.payload), ["key"]);
    const result = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: yielded.call_id, ok: true, value: { found: false } }))) as {
      request_id: string; ok: boolean; value: { state: string; coverage: { documents: number; bytes: number } };
    };
    assert.equal(result.request_id, request.request_id);
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { state: "missing", coverage: { documents: 0, bytes: 0 } });
  } finally {
    guest.dispose();
  }
});
