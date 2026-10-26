import assert from "node:assert/strict";
import test from "node:test";
import { guest } from "../guest.js";
import { sha256 } from "../src/core.js";

const scope = { workspace_id: "workspace-speaker", repository_id: 20, branch: "main", generation: "generation-speaker" };
const snapshot = { id: "snapshot-speaker", local_commit: "commit-sp", worktree_generation: "tree-sp", draft_generation: null };
const revision = "a".repeat(64);
function request(input: Record<string, unknown>) {
  return { schema_version: 1, request_id: "speaker-report", plugin_id: "proprium.diagnostics", action_id: "proprium.diagnostics.scene.run.v1", scope, snapshot, input, deadline_ms: 30_000 };
}
function resume(call: Record<string, unknown>, value: unknown): Record<string, unknown> {
  return JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: call.call_id, ok: true, value })));
}
function reject(call: Record<string, unknown>, code: string): Record<string, unknown> {
  return JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: call.call_id, ok: false, error: { code, message: code, retryable: false } })));
}

test("scene report consumes Speaker's pinned voice-check result without owning speaker writes", () => {
  guest.initialize({ pluginId: "proprium.diagnostics", version: "0.1.0", workspaceId: scope.workspace_id });
  const text = "彼は答えた。";
  const savedRevision = sha256(text);
  let result = JSON.parse(guest.invoke(JSON.stringify(request({ sceneId: "sc-1", sections: ["speaker"] }))));
  const calls: string[] = [];
  while (result.kind === "host_call") {
    calls.push(String(result.operation));
    if (result.operation === "workspace.plugin.invoke") {
      const payload = result.payload as Record<string, unknown>;
      if (payload.action_id === "proprium.narrative.scene.context") {
        result = resume(result, { request_id: "nested", scope, snapshot, ok: true, warnings: [], value: {
          scene_id: "sc-1", title: "場面", volume: { id: "vol-1", title: "巻" }, chapter: { id: "ch-1", title: "章" },
          manuscript_path: "manuscript/sc-1.md", metadata_revision: revision, manuscript_revision: savedRevision, diagnostics: [],
        } });
      } else if (payload.action_id === "speaker.voice.check") {
        assert.equal(payload.plugin_id, "proprium.speaker");
        assert.deepEqual(payload.input, { scene_id: "sc-1" });
        result = resume(result, { request_id: "nested-speaker", scope, snapshot, ok: true, warnings: [], value: {
          scene_id: "sc-1", attributions: [{ sentence_index: 1, start_utf16: 0, end_utf16: 6, text: "彼は答えた。", text_hash: savedRevision, confidence: "low", reason: "preceding-narration", evidence: [] }],
          declared_warnings: [], learned_style_warnings: [], stylometric_warnings: [], issues: [],
          speakerEngine: "speaker-v1", speakerEngineVersion: "1.0.0", speakerModuleVersion: "1.0.0",
          adoptedModelIdentity: null, tokenizerModel: "ja-local", tokenizerModelVersion: "1.0.0",
          provenance: { snapshot: snapshot.id, source_revisions: [{ path: "manuscript/sc-1.md", revision: savedRevision }] },
        } });
      } else assert.fail(`unexpected provider action: ${String(payload.action_id)}`);
    } else if (result.operation === "workspace.file.read") {
      const path = String((result.payload as Record<string, unknown>).path);
      if (path === "manuscript/sc-1.md") {
        const bytes = [...new TextEncoder().encode(text)];
        result = resume(result, { revision: savedRevision, total_bytes: bytes.length, offset: 0, bytes, next_offset: null });
      } else result = reject(result, "file_not_found");
    } else assert.fail(`unexpected operation: ${String(result.operation)}`);
  }
  assert.equal(result.ok, true);
  assert.equal(result.value.providerStatus.speaker, "ready");
  assert.equal(result.value.complete, true);
  assert.equal(result.value.sections.speaker.attributions.length, 1);
  assert.equal(result.value.sections.speaker.providerIdentity.speakerEngine, "speaker-v1");
  assert.deepEqual(calls.filter((operation) => operation === "workspace.plugin.invoke").length, 2);
  guest.dispose();
});
