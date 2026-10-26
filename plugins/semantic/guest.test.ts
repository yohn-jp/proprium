import assert from "node:assert/strict";
import test from "node:test";
import { guest } from "./guest.ts";

const scope = { workspace_id: "workspace-a", repository_id: 7, branch: "main", generation: "g1" };
const snapshot = { id: "snapshot-a", local_commit: null, worktree_generation: "w1", draft_generation: null };

function invoke(input: Record<string, unknown>) {
  guest.initialize({ pluginId: "proprium.semantic", version: "0.1.0", workspaceId: scope.workspace_id });
  const response = guest.invoke(JSON.stringify({
    schema_version: 1,
    request_id: "request-a",
    plugin_id: "proprium.semantic",
    action_id: "proprium.semantic.terms.cluster",
    scope,
    snapshot,
    input,
    deadline_ms: 30_000,
  }));
  guest.dispose();
  return JSON.parse(response) as Record<string, any>;
}

test("guest routes term candidates through the canonical snapshot and deterministic clustering", () => {
  const response = invoke({
    candidates: [
      { term: "駅前", reading: "エキマエ", sourceEntityIds: ["a"], occurrenceCount: 2 },
      { term: "駅前広場", reading: "エキマエヒロバ", sourceEntityIds: ["b", "c"], occurrenceCount: 9 },
    ],
    useEmbedding: false,
  });
  assert.equal(response.ok, true);
  assert.equal(response.snapshot.id, snapshot.id);
  assert.deepEqual(response.value.results, [{ canonical: "駅前広場", variants: ["駅前"] }]);
});

test("guest rejects unknown fields and reports missing admitted model capability explicitly", () => {
  const invalid = invoke({ candidates: [], useEmbedding: false, write: true });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "invalid_input");

  const unavailable = invoke({ candidates: [], useEmbedding: true });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.error.code, "provider_unavailable");
});
