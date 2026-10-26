import assert from "node:assert/strict";
import test from "node:test";
import { guest } from "../guest.js";

const scope = { workspace_id: "workspace-aspects", repository_id: 7, branch: "main", generation: "generation-1" };
const snapshot = { id: "snapshot-aspects", local_commit: "commit-1", worktree_generation: "tree-1", draft_generation: null };
const revision = "b".repeat(64);
function request(action_id: string, input: Record<string, unknown>) {
  return { schema_version: 1, request_id: `request-${action_id}`, plugin_id: "proprium.diagnostics", action_id, scope, snapshot, input, deadline_ms: 30_000 };
}
function resume(call: Record<string, unknown>, value: unknown): Record<string, unknown> {
  return JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: call.call_id, ok: true, value })));
}
function sceneContext(sceneId: string, title: string) {
  return { scene_id: sceneId, title, volume: { id: "vol-1", title: "巻" }, chapter: { id: "ch-1", title: "章題" }, manuscript_path: `manuscript/${sceneId}.md`, metadata_revision: revision, manuscript_revision: revision, diagnostics: [] };
}

test("chapter aspect preview uses Narrative identity without reading manuscript bytes or invoking providers", () => {
  guest.initialize({ pluginId: "proprium.diagnostics", version: "0.1.0", workspaceId: scope.workspace_id });
  let result = JSON.parse(guest.invoke(JSON.stringify(request("proprium.diagnostics.chapter.aspects.preview.v1", { chapterId: "ch-1", aspects: ["tempo"] }))));
  result = resume(result, {
    request_id: "narrative-tree", scope, snapshot, ok: true, warnings: [],
    value: { parent_id: "ch-1", items: [{ id: "sc-1", kind: "scene", title: "場面", metadata_path: "plot/scene.yaml", manuscript_path: "manuscript/sc-1.md" }], next_cursor: null, tree_revision: revision },
  });
  result = resume(result, { request_id: "narrative-context", scope, snapshot, ok: true, warnings: [], value: sceneContext("sc-1", "場面") });
  assert.equal(result.ok, true);
  assert.equal(result.value.includesManuscript, false);
  assert.equal(result.value.providerInvoked, false);
  assert.match(result.value.prompt, /章題/u);
  assert.doesNotMatch(result.value.prompt, /秘匿本文/u);
  guest.dispose();
});

test("chapter aspect review reads pinned prose and remains useful when Knowledge POV is unavailable", () => {
  guest.initialize({ pluginId: "proprium.diagnostics", version: "0.1.0", workspaceId: scope.workspace_id });
  let result = JSON.parse(guest.invoke(JSON.stringify(request("proprium.diagnostics.chapter.aspects.review.v1", { chapterId: "ch-1", aspects: ["tempo"] }))));
  result = resume(result, {
    request_id: "narrative-tree", scope, snapshot, ok: true, warnings: [],
    value: { parent_id: "ch-1", items: [{ id: "sc-1", kind: "scene", title: "場面", metadata_path: "plot/scene.yaml", manuscript_path: "manuscript/sc-1.md" }], next_cursor: null, tree_revision: revision },
  });
  result = resume(result, { request_id: "narrative-context", scope, snapshot, ok: true, warnings: [], value: sceneContext("sc-1", "場面") });
  const body = `「台詞」\n\n${"地の文".repeat(400)}\n\n${"さらに地の文".repeat(300)}`;
  const bytes = [...new TextEncoder().encode(body)];
  result = resume(result, { revision, total_bytes: bytes.length, offset: 0, bytes, next_offset: null });
  assert.equal(result.operation, "workspace.plugin.invoke");
  result = resume(result, { request_id: "knowledge", scope, snapshot, ok: false, error: { code: "dependency_unavailable", message: "not installed", retryable: false } });
  assert.equal(result.ok, true);
  assert.equal(result.value.sceneCount, 1);
  assert.equal(result.value.complete, true);
  assert.ok(result.value.findings.some((item: { aspect: string }) => item.aspect === "tempo"));
  assert.ok(result.value.findings.some((item: { evidence: unknown[] }) => item.evidence.length > 0));
  guest.dispose();
});
