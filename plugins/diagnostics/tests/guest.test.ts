import assert from "node:assert/strict";
import test from "node:test";
import { guest } from "../guest.js";

const scope = { workspace_id: "workspace-a", repository_id: 7, branch: "main", generation: "generation-1" };
const snapshot = { id: "snapshot-1", local_commit: "commit-1", worktree_generation: "tree-1", draft_generation: null };
function request(action_id: string, input: Record<string, unknown>) {
  return { schema_version: 1, request_id: `request-${action_id}`, plugin_id: "proprium.diagnostics", action_id, scope, snapshot, input, deadline_ms: 30_000 };
}
function continueWith(call: Record<string, unknown>, value: unknown): Record<string, unknown> {
  return JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: call.call_id, ok: true, value })));
}

test("typed text analysis echoes exact Host scope and exposes missing lexical provider", () => {
  guest.initialize({ pluginId: "proprium.diagnostics", version: "0.1.0", workspaceId: scope.workspace_id });
  let result = JSON.parse(guest.invoke(JSON.stringify(request(
    "proprium.diagnostics.text.analyze.v1", { text: "彼は走った。彼は笑った。彼は話した。" },
  ))));
  while (result.kind === "host_call") {
    if (result.operation === "workspace.file.read") {
      result = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: result.call_id, ok: false, error: { code: "file_not_found", message: "not configured", retryable: false } })));
    } else {
      assert.equal(result.operation, "workspace.plugin.invoke");
      result = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: result.call_id, ok: false, error: { code: "dependency_unavailable", message: "Research is not installed", retryable: true } })));
    }
  }
  assert.equal(result.ok, true);
  assert.deepEqual(result.scope, scope);
  assert.deepEqual(result.snapshot, snapshot);
  assert.equal(result.value.providers.lexical, "unavailable");
  assert.equal(result.value.identity.complete, false);
  assert.ok(result.value.findings.some((finding: { kind: string }) => finding.kind === "rhythm"));
  guest.dispose();
});

test("project scan pages Host list/read and returns provenance without mutating files", () => {
  guest.initialize({ pluginId: "proprium.diagnostics", version: "0.1.0", workspaceId: scope.workspace_id });
  const sourceFiles = new Map([
    ["plot/volumes/one/volume.yaml", "id: vol-1\norder: 1\n"],
    ["plot/volumes/one/chapters/one/chapter.yaml", "id: ch-1\nvolume: vol-1\norder: 1\n"],
    ["plot/volumes/one/chapters/one/scenes/one.yaml", "id: sc-1\nchapter: ch-1\norder: 1\nmanuscript: manuscript/actual.md\nappears: [missing-character]\n"],
    ["manuscript/actual.md", "本文\n"],
  ]);
  const revisions = new Map([...sourceFiles.keys()].map((path, index) => [path, `${index + 1}`.repeat(64).slice(0, 64)]));
  const entries = [...sourceFiles.keys()].map((path) => ({ path, revision: revisions.get(path), byte_length: new TextEncoder().encode(sourceFiles.get(path)!).length, media_type: path.endsWith(".yaml") ? "text/yaml" : "text/markdown" }));
  let result = JSON.parse(guest.invoke(JSON.stringify(request("proprium.diagnostics.project.consistency.run.v1", {}))));
  const calls: string[] = [];
  while (result.kind === "host_call") {
    calls.push(String(result.operation));
    const payload = result.payload as Record<string, unknown>;
    let value: unknown;
    if (result.operation === "workspace.file.list") value = { entries, next_cursor: null };
    else if (result.operation === "workspace.file.read") {
      const path = String(payload.path);
      const content = sourceFiles.get(path);
      assert.ok(content, `unexpected file read ${path}`);
      const bytes = [...new TextEncoder().encode(content)];
      assert.equal(payload.snapshot && (payload.snapshot as typeof snapshot).id, snapshot.id);
      value = { revision: revisions.get(path), total_bytes: bytes.length, offset: 0, bytes, next_offset: null };
    } else assert.fail(`Diagnostics must not request ${String(result.operation)}`);
    result = continueWith(result, value);
  }
  assert.equal(result.ok, true);
  assert.equal(result.value.recognized, true);
  assert.equal(result.value.complete, true);
  assert.equal(result.value.findings[0].source_path, "plot/volumes/one/chapters/one/scenes/one.yaml");
  assert.equal(result.value.findings[0].source_revision, revisions.get("plot/volumes/one/chapters/one/scenes/one.yaml"));
  assert.ok(result.value.findings.some((finding: { kind: string }) => finding.kind === "MISSING_LINK_TARGET"));
  assert.deepEqual(calls, ["workspace.file.list", "workspace.file.read", "workspace.file.read", "workspace.file.read"]);
  guest.dispose();
});

test("unknown and extra input fields fail closed", () => {
  guest.initialize({ pluginId: "proprium.diagnostics", version: "0.1.0", workspaceId: scope.workspace_id });
  const unknown = JSON.parse(guest.invoke(JSON.stringify(request("proprium.diagnostics.unknown.v1", {}))));
  assert.equal(unknown.ok, false);
  const invalid = JSON.parse(guest.invoke(JSON.stringify(request("proprium.diagnostics.lint.run.v1", { text: "ok", unlisted: true }))));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "invalid_input");
  guest.dispose();
});


test("lint output satisfies the signed schema for a local workspace", async () => {
  const localScope = { ...scope, repository_id: null };
  guest.initialize({ pluginId: "proprium.diagnostics", version: "0.1.0", workspaceId: scope.workspace_id });
  let result = JSON.parse(guest.invoke(JSON.stringify({ ...request("proprium.diagnostics.lint.run.v1", { text: "彼は…笑った。" }), scope: localScope })));
  while (result.kind === "host_call") {
    const bytes = [...new TextEncoder().encode("severity: {}\n")];
    result = continueWith(result, { revision: "a".repeat(64), total_bytes: bytes.length, offset: 0, bytes, next_offset: null });
  }
  assert.equal(result.ok, true);
  const { assertValue } = await import("../../../app/src/browser/proprium/authoring/schema.js");
  const manifest = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../plugin.json", import.meta.url), "utf8"));
  const descriptor = manifest.actions.find((action: { action_id: string }) => action.action_id === "proprium.diagnostics.lint.run.v1");
  assertValue(descriptor.output_schema, result.value);
  assert.equal(result.value.identity.configRevisions.lint, "a".repeat(64));
  assert.equal(result.value.identity.providerStatus.lexical, "disabled");
  assert.equal(result.value.warnings[0].ruleId, "ellipsis-single-piece");
  guest.dispose();
});

test("project scans reject repeating cursors and duplicate file identities", () => {
  for (const action of ["proprium.diagnostics.project.consistency.run.v1", "proprium.diagnostics.project.continuity.run.v1"]) {
    for (const duplicate of [false, true]) {
      guest.initialize({ pluginId: "proprium.diagnostics", version: "0.1.0", workspaceId: scope.workspace_id });
      let result = JSON.parse(guest.invoke(JSON.stringify(request(action, {}))));
      const entry = { path: "manuscript/a.md", revision: "a".repeat(64), byte_length: 1, media_type: "text/markdown" };
      result = continueWith(result, { entries: duplicate ? [entry] : [], next_cursor: "cursor-1" });
      assert.equal(result.operation, "workspace.file.list");
      result = continueWith(result, { entries: duplicate ? [entry] : [], next_cursor: duplicate ? null : "cursor-1" });
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "snapshot_stale");
      guest.dispose();
    }
  }
});
