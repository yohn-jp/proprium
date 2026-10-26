import assert from "node:assert/strict";
import test from "node:test";
import { guest } from "../guest.js";
import { sha256 } from "../src/core.js";

const scope = { workspace_id: "workspace-proposals", repository_id: 13, branch: "main", generation: "generation-p" };
const snapshot = { id: "snapshot-proposals", local_commit: "commit-p", worktree_generation: "tree-p", draft_generation: null };
const revision = "e".repeat(64);
function request(action_id: string, input: Record<string, unknown>) {
  return { schema_version: 1, request_id: `request-${action_id}`, plugin_id: "proprium.diagnostics", action_id, scope, snapshot, input, idempotency_key: String(input.idempotencyKey), deadline_ms: 30_000 };
}
function resume(call: Record<string, unknown>, value: unknown): Record<string, unknown> {
  return JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: call.call_id, ok: true, value })));
}

test("lint proposal pins the saved file and config, then submits a review-only ChangeSet", () => {
  guest.initialize({ pluginId: "proprium.diagnostics", version: "0.1.0", workspaceId: scope.workspace_id });
  const text = "---\ntitle: Keep\n---\n  地の文…\n「会話」\n次の行";
  const body = text.slice(text.indexOf("---\n", 4) + 4);
  const fileRevision = sha256(text);
  const bytes = [...new TextEncoder().encode(text)];
  let result = JSON.parse(guest.invoke(JSON.stringify(request("proprium.diagnostics.lint.propose.v1", {
    documentPath: "manuscript/a.md", expectedRevision: fileRevision, textHash: sha256(body), idempotencyKey: "key-lint-1",
  }))));
  let changeset: Record<string, unknown> | undefined;
  const operations: string[] = [];
  while (result.kind === "host_call") {
    operations.push(String(result.operation));
    const payload = result.payload as Record<string, unknown>;
    if (result.operation === "workspace.file.list") result = resume(result, { entries: [{ path: "manuscript/a.md", revision: fileRevision, byte_length: bytes.length, media_type: "text/markdown" }], next_cursor: null });
    else if (result.operation === "workspace.file.read" && payload.path === "manuscript/a.md") result = resume(result, { revision: fileRevision, total_bytes: bytes.length, offset: 0, bytes, next_offset: null });
    else if (result.operation === "workspace.file.read" && String(payload.path).includes("lint-rules.yaml")) result = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: result.call_id, ok: false, error: { code: "file_not_found", message: "missing config", retryable: false } })));
    else if (result.operation === "workspace.change.propose") { changeset = payload.changeset as Record<string, unknown>; result = resume(result, { proposal_id: "proposal-lint" }); }
    else assert.fail(`unexpected Host operation ${String(result.operation)}`);
  }
  assert.equal(result.ok, true);
  assert.equal(result.value.proposalId, "proposal-lint");
  assert.equal(result.value.expectedRevision, fileRevision);
  assert.ok(result.value.warnings.some((warning: { ruleId: string }) => warning.ruleId === "ellipsis-single-piece"));
  assert.equal(operations.filter((operation) => operation === "workspace.change.propose").length, 1);
  assert.ok(changeset);
  assert.equal((changeset!.snapshot as typeof snapshot).id, snapshot.id);
  const readSet = changeset!.read_set as Array<{ path: string; revision: string | null }>;
  assert.ok(readSet.some((item) => item.path === "manuscript/a.md" && item.revision === fileRevision));
  assert.ok(readSet.some((item) => item.path === "meta/scriptorium/modules/diagnostics/lint-rules.yaml" && item.revision === null));
  const operation = ((changeset!.units as Array<{ operations: Array<Record<string, unknown>> }>)[0].operations)[0];
  assert.equal(operation.kind, "replace");
  assert.equal(operation.expected_revision, fileRevision);
  assert.ok(new TextDecoder().decode(Uint8Array.from(operation.content as number[])).includes("……"));
  assert.ok((changeset!.evidence as Array<{ path: string; revision: string; start: number; end: number; quote: string }>).every((item) => item.path === "manuscript/a.md" && item.revision === fileRevision && text.slice(item.start, item.end) === item.quote));
  guest.dispose();
});

test("manuscript formatter resolves the explicit Narrative link and proposes preserved frontmatter", () => {
  guest.initialize({ pluginId: "proprium.diagnostics", version: "0.1.0", workspaceId: scope.workspace_id });
  const body = "---\ntitle: Keep\n---\n  地の文…\n「会話」";
  const manuscriptRevision = sha256(body);
  const metadataRevision = "f".repeat(64);
  const treeRevision = "a".repeat(64);
  let result = JSON.parse(guest.invoke(JSON.stringify(request("proprium.diagnostics.manuscript.format.propose.v1", {
    sceneId: "sc-1", expectedRevision: manuscriptRevision, idempotencyKey: "key-format-1",
  }))));
  let changeset: Record<string, unknown> | undefined;
  while (result.kind === "host_call") {
    const payload = result.payload as Record<string, unknown>;
    if (result.operation === "workspace.plugin.invoke") {
      const action = String(payload.action_id);
      if (action === "proprium.narrative.scene.context") result = resume(result, { request_id: "scene-context", scope, snapshot, ok: true, warnings: [], value: {
        scene_id: "sc-1", title: "場面", volume: { id: "vol-1", title: "巻" }, chapter: { id: "ch-1", title: "章" },
        manuscript_path: "manuscript/a.md", metadata_revision: metadataRevision, manuscript_revision: manuscriptRevision, diagnostics: [],
      } });
      else if (action === "proprium.narrative.hierarchy.tree") result = resume(result, { request_id: "tree", scope, snapshot, ok: true, warnings: [], value: {
        parent_id: "ch-1", tree_revision: treeRevision, next_cursor: null,
        items: [{ id: "sc-1", kind: "scene", title: "場面", metadata_path: "plot/sc-1.yaml", manuscript_path: "manuscript/a.md" }],
      } });
      else assert.fail(`unexpected Narrative action ${action}`);
    } else if (result.operation === "workspace.file.read") {
      const bytes = [...new TextEncoder().encode(body)];
      result = resume(result, { revision: manuscriptRevision, total_bytes: bytes.length, offset: 0, bytes, next_offset: null });
    } else if (result.operation === "workspace.change.propose") { changeset = payload.changeset as Record<string, unknown>; result = resume(result, { proposal_id: "proposal-format" }); }
    else assert.fail(`unexpected Host operation ${String(result.operation)}`);
  }
  assert.equal(result.ok, true);
  assert.equal(result.value.proposalId, "proposal-format");
  assert.equal(result.value.frontmatterPreserved, true);
  assert.equal(result.value.changed, true);
  assert.ok(changeset);
  const readSet = changeset!.read_set as Array<{ path: string; revision: string | null }>;
  assert.ok(readSet.some((item) => item.path === "plot/sc-1.yaml" && item.revision === metadataRevision));
  assert.ok(readSet.some((item) => item.path === "manuscript/a.md" && item.revision === manuscriptRevision));
  const operation = ((changeset!.units as Array<{ operations: Array<Record<string, unknown>> }>)[0].operations)[0];
  const after = new TextDecoder().decode(Uint8Array.from(operation.content as number[]));
  assert.ok(after.startsWith("---\ntitle: Keep\n---\n"));
  assert.ok(after.includes("地の文……"));
  guest.dispose();
});
