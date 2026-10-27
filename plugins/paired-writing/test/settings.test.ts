import assert from "node:assert/strict";
import test from "node:test";
import { guest } from "../guest.js";

const scope = { workspace_id: "settings", repository_id: 1, branch: "main", generation: "g1" };
const snapshot = { id: "s1", local_commit: null, worktree_generation: "w1", draft_generation: null };
async function invoke(content: string | null, preference: unknown = undefined) {
  guest.initialize({ pluginId: "proprium.paired-writing", version: "0.1.0", workspaceId: scope.workspace_id });
  let result = JSON.parse(guest.invoke(JSON.stringify({ schema_version: 1, request_id: "settings-read", plugin_id: "proprium.paired-writing", action_id: "paired.workspace-settings.read", scope, snapshot, input: {}, deadline_ms: 30000 })));
  while (result.kind === "host_call") {
    let response: Record<string, unknown>;
    if (result.operation === "workspace.file.read" && content === null) response = { ok: false, error: { code: "file_not_found", message: "absent", retryable: false } };
    else if (result.operation === "workspace.file.read") {
      const bytes = [...new TextEncoder().encode(content!)];
      response = { ok: true, value: { revision: "a".repeat(64), total_bytes: bytes.length, offset: 0, bytes, next_offset: null } };
    } else if (result.operation === "plugin.preferences.read") response = { ok: true, value: preference === undefined ? { found: false } : { found: true, value: preference } };
    else throw new Error(`Unexpected ${result.operation}`);
    result = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: result.call_id, ...response })));
  }
  guest.dispose();
  return result;
}

test("settings read reports workspace revision and local override without exposing unknown keys", async () => {
  const source = JSON.stringify({ defaultPresetId: "a", presets: [{ id: "a", label: "A", model: "vendor/model" }], featurePresetIds: {}, secret: "hidden" });
  const result = await invoke(source, { defaultPresetId: "a", presets: [{ id: "a", label: "A", model: "vendor/model", secret: "hidden-local" }] });
  assert.equal(result.ok, true);
  assert.equal(result.value.workspace.revision, "a".repeat(64));
  assert.equal(result.value.effective.defaultPresetId, "a");
  assert.equal(result.value.provenance.defaultPresetId, "local");
  assert.equal(JSON.stringify(result.value).includes("hidden"), false);
  const { readFile } = await import("node:fs/promises");
  const schemaPath: string = "../../../app/src/browser/proprium/authoring/schema.js";
  const { assertValue } = await import(schemaPath);
  const manifest = JSON.parse(await readFile(new URL("../plugin.json", import.meta.url), "utf8"));
  assertValue(manifest.actions.find((action: { action_id: string }) => action.action_id === "paired.workspace-settings.read").output_schema, result.value);
});

test("settings read preserves malformed source by returning unsupported_format", async () => {
  const result = await invoke("{bad json");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "unsupported_format");
});

test("invalid sampling in workspace settings is rejected rather than silently changed", async () => {
  const result = await invoke(JSON.stringify({ defaultPresetId: "a", presets: [{ id: "a", label: "A", model: "vendor/model", sampling: { temperature: 99 } }], featurePresetIds: {} }));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "unsupported_format");
});

test("absent settings use declared defaults with default provenance", async () => {
  const result = await invoke(null);
  assert.equal(result.ok, true);
  assert.equal(result.value.workspace.revision, null);
  assert.equal(result.value.effective.defaultPresetId, "quality-flash");
  assert.equal(result.value.provenance.defaultPresetId, "default");
});

test("settings proposal keeps unknown source bytes and submits a revision-guarded change", async () => {
  const source = '{\n  "defaultPresetId": "a",\n  "presets": [{"id":"a","label":"A","model":"vendor/model","future":true,"sampling":{"temperature":0.5,"futureKnob":7}}],\n  "featurePresetIds": {},\n  "futureField"  : { "untouched" : [ 1, 2 ] }\n}\n';
  const revision = "b".repeat(64);
  guest.initialize({ pluginId: "proprium.paired-writing", version: "0.1.0", workspaceId: scope.workspace_id });
  let result = JSON.parse(guest.invoke(JSON.stringify({ schema_version: 1, request_id: "settings-propose", plugin_id: "proprium.paired-writing", action_id: "paired.workspace-settings.propose", scope, snapshot, input: { patch: { totalCuBudget: 7, presets: [{ id: "a", label: "A", model: "vendor/model", sampling: { temperature: 0.7 } }] }, expectedRevision: revision }, idempotency_key: "change-1", deadline_ms: 30000 })));
  let changeset: any;
  while (result.kind === "host_call") {
    let value: unknown;
    if (result.operation === "workspace.file.read") { const bytes = [...new TextEncoder().encode(source)]; value = { revision, total_bytes: bytes.length, offset: 0, bytes, next_offset: null }; }
    else if (result.operation === "workspace.change.propose") { changeset = result.payload.changeset; value = { proposal_id: "proposal-1" }; }
    else throw new Error(`Unexpected ${result.operation}`);
    result = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: result.call_id, ok: true, value })));
  }
  guest.dispose();
  assert.equal(result.ok, true);
  assert.equal(result.value.proposal_id, "proposal-1");
  const { readFile } = await import("node:fs/promises");
  const schemaPath: string = "../../../app/src/browser/proprium/authoring/schema.js";
  const { assertValue } = await import(schemaPath);
  const manifest = JSON.parse(await readFile(new URL("../plugin.json", import.meta.url), "utf8"));
  assertValue(manifest.actions.find((action: { action_id: string }) => action.action_id === "paired.workspace-settings.propose").output_schema, result.value);
  assert.deepEqual(changeset.read_set, [{ path: "meta/scriptorium/modules/assistant/model-settings.json", revision }]);
  const operation = changeset.units[0].operations[0];
  const output = new TextDecoder().decode(Uint8Array.from(operation.content));
  assert.equal(operation.expected_revision, revision);
  assert.match(output, /"futureField"  : \{ "untouched" : \[ 1, 2 \] \}/u);
  assert.match(output, /"future":true/u);
  assert.equal(JSON.parse(output).totalCuBudget, 7);
  assert.equal(JSON.parse(output).presets[0].sampling.futureKnob, 7);
});

test("settings proposal rejects secret fields before any Host operation", () => {
  guest.initialize({ pluginId: "proprium.paired-writing", version: "0.1.0", workspaceId: scope.workspace_id });
  const result = JSON.parse(guest.invoke(JSON.stringify({ schema_version: 1, request_id: "settings-secret", plugin_id: "proprium.paired-writing", action_id: "paired.workspace-settings.propose", scope, snapshot, input: { patch: { presets: [{ id: "a", label: "A", model: "safe", apiKey: "secret" }] }, expectedRevision: null }, idempotency_key: "secret-attempt", deadline_ms: 30000 })));
  guest.dispose();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_input");
});

test("settings proposal stops on a stale revision without registering a change", () => {
  guest.initialize({ pluginId: "proprium.paired-writing", version: "0.1.0", workspaceId: scope.workspace_id });
  let result = JSON.parse(guest.invoke(JSON.stringify({ schema_version: 1, request_id: "settings-stale", plugin_id: "proprium.paired-writing", action_id: "paired.workspace-settings.propose", scope, snapshot, input: { patch: { totalCuBudget: 3 }, expectedRevision: "old" }, idempotency_key: "stale", deadline_ms: 30000 })));
  const source = JSON.stringify({ defaultPresetId: "a", presets: [{ id: "a", label: "A", model: "safe" }], featurePresetIds: {} });
  const bytes = [...new TextEncoder().encode(source)];
  assert.equal(result.operation, "workspace.file.read");
  result = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: result.call_id, ok: true, value: { revision: "c".repeat(64), total_bytes: bytes.length, offset: 0, bytes, next_offset: null } })));
  guest.dispose();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "snapshot_stale");
});

test("settings read tolerates and omits future nested sampling fields", async () => {
  const source = JSON.stringify({ defaultPresetId: "a", presets: [{ id: "a", label: "A", model: "safe", sampling: { temperature: 0.5, futureKnob: 7 } }], featurePresetIds: {} });
  const result = await invoke(source);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.effective.presets[0].sampling, { temperature: 0.5 });
});

test("settings reject credential-looking model values and arbitrary URLs", async () => {
  for (const model of ["github_pat_abcdefghijklmnopqrstuv", "ftp://example.test/model"]) {
    const result = await invoke(JSON.stringify({ defaultPresetId: "a", presets: [{ id: "a", label: "A", model }], featurePresetIds: {} }));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "unsupported_format");
    assert.equal(JSON.stringify(result).includes(model), false);
  }
});
