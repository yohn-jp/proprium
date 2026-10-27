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

test("scene report requests Semantic hypotheses and reports a missing index honestly", () => {
  guest.initialize({ pluginId: "proprium.diagnostics", version: "0.1.0", workspaceId: scope.workspace_id });
  const savedText = "本文。";
  const savedRevision = sha256(savedText);
  let result = JSON.parse(guest.invoke(JSON.stringify(request({ sceneId: "sc-1", sections: ["semanticHypotheses"] }))));
  let semanticCalled = false;
  while (result.kind === "host_call") {
    const payload = result.payload as Record<string, unknown>;
    if (result.operation === "workspace.plugin.invoke" && payload.action_id === "proprium.narrative.scene.context") {
      result = resume(result, { request_id: "scene", scope, snapshot, ok: true, warnings: [], value: {
        scene_id: "sc-1", title: "場面", volume: { id: "v", title: "巻" }, chapter: { id: "c", title: "章" },
        manuscript_path: "manuscript/a.md", metadata_revision: revision, manuscript_revision: savedRevision, diagnostics: [],
      } });
    } else if (result.operation === "workspace.plugin.invoke" && payload.action_id === "proprium.semantic.contradictions.candidates") {
      semanticCalled = true;
      result = resume(result, { request_id: "semantic", scope, snapshot, ok: true, warnings: [], value: {
        snapshot, model: { id: "test", revision: "1", role: "embedding", status: "unavailable" }, indexAvailable: false, candidates: [], nextCursor: null, complete: true,
      } });
    } else if (payload.path === "manuscript/a.md") {
      const bytes = [...new TextEncoder().encode(savedText)];
      result = resume(result, { revision: savedRevision, total_bytes: bytes.length, offset: 0, bytes, next_offset: null });
    } else result = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: result.call_id, ok: false, error: { code: "file_not_found", message: "not configured", retryable: false } })));
  }
  assert.equal(result.ok, true);
  assert.equal(semanticCalled, true);
  assert.equal(result.value.sections.semanticHypotheses.status, "unavailable");
  assert.equal(result.value.complete, false);
  guest.dispose();
});

test("scene report returns matching Semantic evidence and marks a paginated result incomplete", async () => {
  guest.initialize({ pluginId: "proprium.diagnostics", version: "0.1.0", workspaceId: scope.workspace_id });
  const savedText = "本文。";
  const savedRevision = sha256(savedText);
  const evidence = (sceneId: string) => ({ sceneId, sentenceIndex: 0, quote: "本文。", path: "manuscript/a.md", revision: savedRevision, start: 0, end: 3 });
  const candidate = (id: string, sceneId: string) => ({ id, kind: "embedding_midband", entityId: "person", score: 0.5, suspicion: "review", evidenceA: evidence(sceneId), evidenceB: evidence("other") });
  let result = JSON.parse(guest.invoke(JSON.stringify(request({ sceneId: "sc-1", sections: ["semanticHypotheses"] }))));
  while (result.kind === "host_call") {
    const payload = result.payload as Record<string, unknown>;
    if (result.operation === "workspace.plugin.invoke" && payload.action_id === "proprium.narrative.scene.context") {
      result = resume(result, { request_id: "scene", scope, snapshot, ok: true, warnings: [], value: {
        scene_id: "sc-1", title: "場面", volume: { id: "v", title: "巻" }, chapter: { id: "c", title: "章" },
        manuscript_path: "manuscript/a.md", metadata_revision: revision, manuscript_revision: savedRevision, diagnostics: [],
      } });
    } else if (result.operation === "workspace.plugin.invoke" && payload.action_id === "proprium.semantic.contradictions.candidates") {
      result = resume(result, { request_id: "semantic", scope, snapshot, ok: true, warnings: [], value: {
        snapshot, model: { id: "test", revision: "1", role: "embedding", status: "ready", digest: null, byte_length: null, license: "MIT" }, indexAvailable: true,
        candidates: [candidate("match", "sc-1"), candidate("other", "another")], nextCursor: "more", complete: false,
      } });
    } else if (payload.path === "manuscript/a.md") {
      const bytes = [...new TextEncoder().encode(savedText)];
      result = resume(result, { revision: savedRevision, total_bytes: bytes.length, offset: 0, bytes, next_offset: null });
    } else result = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: result.call_id, ok: false, error: { code: "file_not_found", message: "not configured", retryable: false } })));
  }
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.sections.semanticHypotheses.candidates.map((candidate: { id: string }) => candidate.id), ["match"]);
  assert.equal(result.value.providerStatus.semanticHypotheses, "ready");
  assert.equal(result.value.complete, false);
  const { readFile } = await import("node:fs/promises");
  const { assertValue } = await import("../../../app/src/browser/proprium/authoring/schema.js");
  const manifest = JSON.parse(await readFile(new URL("../plugin.json", import.meta.url), "utf8"));
  const descriptor = manifest.actions.find((action: { action_id: string }) => action.action_id === "proprium.diagnostics.scene.run.v1");
  assertValue(descriptor.output_schema, result.value);
  guest.dispose();
});

test("Diagnostics panel offers an explicit Semantic evidence review", async () => {
  const { readFile } = await import("node:fs/promises");
  const manifest = JSON.parse(await readFile(new URL("../plugin.json", import.meta.url), "utf8"));
  const scene = manifest.ui.find((panel: { id: string }) => panel.id === "diagnostics.analysis").body.tabs.find((tab: { id: string }) => tab.id === "scene");
  const action = scene.body.tabs.find((tab: { id: string }) => tab.id === "semantic-run");
  const evidence = scene.body.tabs.find((tab: { id: string }) => tab.id === "semantic-evidence");
  assert.deepEqual(action.body.submit.input_template.sections, ["semanticHypotheses"]);
  assert.equal(evidence.body.primary, "evidenceA.quote");
  assert.equal(evidence.body.secondary, "evidenceB.quote");
});
