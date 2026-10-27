import assert from "node:assert/strict";
import test from "node:test";
import { guest } from "./guest.ts";

const scope = { workspace_id: "workspace-a", repository_id: 7, branch: "main", generation: "g1" };
const snapshot = { id: "snapshot-a", local_commit: null, worktree_generation: "w1", draft_generation: null };

function startInvoke(actionId: string, input: Record<string, unknown>) {
  guest.initialize({ pluginId: "proprium.semantic", version: "0.1.0", workspaceId: scope.workspace_id });
  return guest.invoke(JSON.stringify({
    schema_version: 1,
    request_id: "request-a",
    plugin_id: "proprium.semantic",
    action_id: actionId,
    scope,
    snapshot,
    input,
    deadline_ms: 30_000,
    idempotency_key: "test-key",
  }));
}

function invoke(input: Record<string, unknown>) {
  const response = startInvoke("proprium.semantic.terms.cluster", input);
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
  assert.deepEqual(response.value.results, [{ canonical: "駅前広場", variants: ["駅前"], semanticOnly: false }]);
});

test("index and model actions report their unavailable state without loading or fabricating data", () => {
  let status = JSON.parse(startInvoke("proprium.semantic.index.status", {})) as Record<string, any>;
  assert.equal(status.operation, "workspace.derived.cache.get");
  status = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: status.call_id, ok: true, value: { found: false } })));
  assert.equal(status.ok, true);
  assert.equal(status.value.index.state, "missing");
  assert.equal(status.value.resources.modelLoaded, false);
  assert.equal(status.value.resources.downloadRequired, true);
  guest.dispose();

  const empty = JSON.parse(startInvoke("proprium.semantic.passages.query", { query: "  ", granularity: "sentence", limit: 10 })) as Record<string, any>;
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.value.results, []);
  guest.dispose();

  let query = JSON.parse(startInvoke("proprium.semantic.passages.query", { query: "旅", granularity: "sentence", limit: 10 })) as Record<string, any>;
  query = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: query.call_id, ok: true, value: { found: false } })));
  assert.equal(query.ok, false);
  assert.equal(query.error.code, "index_missing");
  assert.doesNotMatch(query.error.message, /asset is unavailable/i);
  guest.dispose();

  let rebuild = JSON.parse(startInvoke("proprium.semantic.index.rebuild", { taskId: "build-1" })) as Record<string, any>;
  rebuild = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: rebuild.call_id, ok: true, value: { found: false } })));
  assert.equal(rebuild.operation, "workspace.file.list");
  rebuild = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: rebuild.call_id, ok: true, value: { entries: [], next_cursor: null } })));
  assert.equal(rebuild.ok, false);
  assert.equal(rebuild.error.code, "provider_unavailable");
  guest.dispose();
});

test("settings read uses Host preferences and read-only legacy bytes, then reports both pinned model limits", () => {
  let response = JSON.parse(startInvoke("proprium.semantic.settings.read", {})) as Record<string, any>;
  assert.equal(response.kind, "host_call");
  assert.equal(response.operation, "plugin.preferences.read");
  response = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: response.call_id, ok: true, value: { found: true, value: { rerankerEnabled: true } } }))) as Record<string, any>;
  assert.equal(response.kind, "host_call");
  assert.equal(response.operation, "workspace.file.list");
  response = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: response.call_id, ok: true, value: { entries: [], next_cursor: null } }))) as Record<string, any>;
  assert.equal(response.ok, true);
  assert.deepEqual(response.value.preferences, { rerankerEnabled: true });
  assert.deepEqual(response.value.legacyPreference, { present: false, valid: false });
  assert.deepEqual(response.value.models.map((model: Record<string, unknown>) => model.status), ["unavailable", "unavailable"]);
  guest.dispose();
});

test("settings updates route to the Host preference form and task actions do not invent work", () => {
  const update = JSON.parse(startInvoke("proprium.semantic.settings.update", { rerankerEnabled: true })) as Record<string, any>;
  assert.equal(update.ok, true);
  assert.deepEqual(update.value.host_ui, { route: "plugin_preferences", pluginId: "proprium.semantic", key: "reranker.enabled", pendingValue: true });
  guest.dispose();

  const status = JSON.parse(startInvoke("proprium.semantic.task.status", {})) as Record<string, any>;
  assert.deepEqual(status.value.activeTasks, []);
  guest.dispose();

  const cancelled = JSON.parse(startInvoke("proprium.semantic.task.cancel", { taskId: "absent" })) as Record<string, any>;
  assert.deepEqual(cancelled.value, { snapshot, taskId: "absent", cancelled: false });
  guest.dispose();
});

test("guest rejects unknown fields and reports missing admitted model capability explicitly", () => {
  const invalid = invoke({ candidates: [], useEmbedding: false, write: true });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "invalid_input");

  const unavailable = invoke({ candidates: [], useEmbedding: true });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.error.code, "provider_unavailable");
});

test("Semantic exposes index state and explicit rebuild through a Host panel", async () => {
  const { readFile } = await import("node:fs/promises");
  const manifest = JSON.parse(await readFile(new URL("./plugin.json", import.meta.url), "utf8"));
  const panel = manifest.ui.find((item: { id: string }) => item.id === "semantic.index");
  assert.equal(panel.body.load_action.action_id, "proprium.semantic.index.status");
  const rebuild = panel.body.tabs.find((tab: { id: string }) => tab.id === "rebuild");
  assert.equal(rebuild.body.submit.action_id, "proprium.semantic.index.rebuild");
});
