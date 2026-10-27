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
