import assert from "node:assert/strict";
import test from "node:test";
import { guest } from "../guest.js";
import { sha256 } from "../src/core.js";

const scope = { workspace_id: "workspace-scene", repository_id: 14, branch: "main", generation: "generation-scene" };
const snapshot = { id: "snapshot-scene", local_commit: "commit-s", worktree_generation: "tree-s", draft_generation: null };
const revision = "a".repeat(64);
function request(input: Record<string, unknown>, currentSnapshot = snapshot) {
  return { schema_version: 1, request_id: "scene-run", plugin_id: "proprium.diagnostics", action_id: "proprium.diagnostics.scene.run.v1", scope, snapshot: currentSnapshot, input, deadline_ms: 30_000 };
}
function resume(call: Record<string, unknown>, value: unknown): Record<string, unknown> {
  return JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: call.call_id, ok: true, value })));
}
test("scene report ties saved and explicit Draft analysis to Narrative identity", () => {
  guest.initialize({ pluginId: "proprium.diagnostics", version: "0.1.0", workspaceId: scope.workspace_id });
  const savedText = "本文。本文。本文。";
  const savedRevision = sha256(savedText);
  let result = JSON.parse(guest.invoke(JSON.stringify(request({ sceneId: "sc-1", sections: ["prose"] }))));
  while (result.kind === "host_call") {
    const payload = result.payload as Record<string, unknown>;
    if (result.operation === "workspace.plugin.invoke") {
      if (payload.action_id === "proprium.narrative.scene.context") result = resume(result, { request_id: "scene", scope, snapshot, ok: true, warnings: [], value: {
        scene_id: "sc-1", title: "場面", volume: { id: "vol-1", title: "巻" }, chapter: { id: "ch-1", title: "章" },
        manuscript_path: "manuscript/a.md", metadata_revision: revision, manuscript_revision: savedRevision, diagnostics: [],
      } });
      else result = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: result.call_id, ok: false, error: { code: "dependency_unavailable", message: "Research is not installed", retryable: true } })));
    } else {
      const path = String(payload.path);
      if (path === "manuscript/a.md") {
        const savedBytes = [...new TextEncoder().encode(savedText)];
        result = resume(result, { revision: savedRevision, total_bytes: savedBytes.length, offset: 0, bytes: savedBytes, next_offset: null });
      } else result = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: result.call_id, ok: false, error: { code: "file_not_found", message: "not configured", retryable: false } })));
    }
  }
  assert.equal(result.ok, true);
  assert.equal(result.value.identity.documentPath, "manuscript/a.md");
  assert.equal(result.value.identity.documentRevision, savedRevision);
  assert.equal(result.value.sections.prose.status, "partial");
  assert.equal(result.value.sections.speaker, undefined);
  assert.equal(result.value.complete, false);

  const draft = "新しい文章。新しい文章。新しい文章。";
  const draftSnapshot = { ...snapshot, draft_generation: "draft-7" };
  result = JSON.parse(guest.invoke(JSON.stringify(request({ sceneId: "sc-1", documentPath: "manuscript/a.md", documentRevision: savedRevision, draftGeneration: "draft-7", text: draft, sections: ["prose"] }, draftSnapshot))));
  while (result.kind === "host_call") {
    const payload = result.payload as Record<string, unknown>;
    if (result.operation === "workspace.plugin.invoke") {
      if (payload.action_id === "proprium.narrative.scene.context") result = resume(result, { request_id: "scene-draft", scope, snapshot: draftSnapshot, ok: true, warnings: [], value: {
        scene_id: "sc-1", title: "場面", volume: { id: "vol-1", title: "巻" }, chapter: { id: "ch-1", title: "章" },
        manuscript_path: "manuscript/a.md", metadata_revision: revision, manuscript_revision: savedRevision, diagnostics: [],
      } });
      else result = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: result.call_id, ok: false, error: { code: "dependency_unavailable", message: "Research is not installed", retryable: true } })));
    } else if (String(payload.path) === "manuscript/a.md") {
      const savedBytes = [...new TextEncoder().encode(savedText)];
      result = resume(result, { revision: savedRevision, total_bytes: savedBytes.length, offset: 0, bytes: savedBytes, next_offset: null });
    } else result = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: result.call_id, ok: false, error: { code: "file_not_found", message: "not configured", retryable: false } })));
  }
  assert.equal(result.ok, true);
  assert.equal(result.value.identity.draftGeneration, "draft-7");
  assert.equal(result.value.identity.textHash, sha256(draft));
  assert.equal(result.value.identity.documentRevision, savedRevision);
  guest.dispose();
});
