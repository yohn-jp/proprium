import assert from "node:assert/strict";
import test from "node:test";
import { guest } from "../guest.js";
import { sha256 } from "../src/core.js";

const scope = { workspace_id: "workspace-plot", repository_id: 12, branch: "main", generation: "gen-plot" };
const revision = "a".repeat(64);
const snapshot = { id: "snapshot-plot", local_commit: "commit-plot", worktree_generation: "tree-plot", draft_generation: "draft-1" };
const actionId = "proprium.diagnostics.scene.plot-goal.check.v1";

function request(input: Record<string, unknown>) {
  return { schema_version: 1, request_id: "plot-request", plugin_id: "proprium.diagnostics", action_id: actionId, scope, snapshot, input, deadline_ms: 30_000 };
}
function resume(call: Record<string, unknown>, value: unknown): Record<string, unknown> {
  return JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: call.call_id, ok: true, value })));
}
function reject(call: Record<string, unknown>, code: string): Record<string, unknown> {
  return JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: call.call_id, ok: false, error: { code, message: code, retryable: false } })));
}
function token(text: string, surface: string, pos: string, after = 0) {
  const start = text.indexOf(surface, after);
  assert.ok(start >= 0);
  return { start, end: start + surface.length, surface, pos };
}

test("plot-goal uses same-snapshot Narrative, Knowledge and Research and cites weak lexical evidence", () => {
  guest.initialize({ pluginId: "proprium.diagnostics", version: "0.1.0", workspaceId: scope.workspace_id });
  const text = "---\nid: sc-1\n---\n彼は正体を暴露した。";
  const bodyOffset = text.indexOf("彼は");
  const goal = "秘密を隠す";
  let result = JSON.parse(guest.invoke(JSON.stringify(request({ sceneId: "sc-1", text, draftGeneration: "draft-1", documentRevision: revision }))));
  const operations: string[] = [];
  while (result.kind === "host_call") {
    operations.push(String(result.operation));
    const payload = result.payload as Record<string, unknown>;
    if (result.operation === "workspace.plugin.invoke") {
      const action = payload.action_id;
      if (action === "proprium.narrative.scene.context") {
        result = resume(result, { request_id: "nested", scope, snapshot, ok: true, warnings: [], value: {
          scene_id: "sc-1", title: "場面", volume: { id: "vol-1", title: "巻" }, chapter: { id: "ch-1", title: "章" },
          manuscript_path: "manuscript/sc-1.md", metadata_revision: revision, manuscript_revision: revision, diagnostics: [],
        } });
      } else if (action === "knowledge.entities.get") {
        result = resume(result, { request_id: "nested", scope, snapshot, ok: true, warnings: [], value: {
          entity: { id: "sc-1", type: "scene", filePath: "plot/scene.yaml", fileRevision: revision, raw: { goal } },
          sourceFiles: [{ path: "plot/scene.yaml", revision }],
        } });
      } else if (action === "research.nlp.analyze") {
        const analyzedText = String(payload.input && (payload.input as Record<string, unknown>).text);
        const rows = analyzedText === goal
          ? [token(goal, "秘密", "名詞"), token(goal, "隠す", "動詞")]
          : [token(analyzedText, "彼", "名詞", bodyOffset), token(analyzedText, "正体", "名詞", bodyOffset), token(analyzedText, "暴露", "名詞", bodyOffset), token(analyzedText, "した", "動詞", bodyOffset)];
        const value = {
          source: { kind: (payload.input as Record<string, unknown>).source && ((payload.input as Record<string, unknown>).source as Record<string, unknown>).kind, textDigest: sha256(analyzedText) },
          sentences: [], tokens: rows,
          engine: { id: "local-ja", version: "1.0.0", digest: "d".repeat(64) },
        };
        result = resume(result, { request_id: "nested", scope, snapshot, ok: true, warnings: [], value });
      } else assert.fail(`unexpected nested action: ${String(action)}`);
    } else if (result.operation === "workspace.file.read") {
      result = reject(result, "file_not_found");
    } else assert.fail(`unexpected operation: ${String(result.operation)}`);
  }
  assert.equal(result.ok, true);
  assert.equal(result.value.status, "ready");
  assert.equal(result.value.warnings[0].kind, "contradiction");
  assert.equal(result.value.warnings[0].signal, "weak_lexical");
  assert.ok(result.value.warnings[0].evidence.some((item: { path: string; quote: string }) => item.path === "plot/scene.yaml" && item.quote === "秘密"));
  assert.ok(result.value.warnings[0].evidence.some((item: { path: string; quote: string }) => item.path === "manuscript/sc-1.md" && item.quote === "暴露"));
  assert.ok(result.value.warnings[0].evidence.every((item: { revision: string }) => item.revision === revision));
  assert.equal(operations.filter((op) => op === "workspace.plugin.invoke").length, 4);
  assert.equal(operations.filter((op) => op === "workspace.file.read").length, 2);
  guest.dispose();
});

test("plot-goal refuses Draft text without the exact active generation", () => {
  guest.initialize({ pluginId: "proprium.diagnostics", version: "0.1.0", workspaceId: scope.workspace_id });
  const result = JSON.parse(guest.invoke(JSON.stringify(request({ sceneId: "sc-1", text: "draft", draftGeneration: "old-draft" }))));
  const next = resume(result, { request_id: "nested", scope, snapshot, ok: true, warnings: [], value: {
    scene_id: "sc-1", title: "場面", volume: { id: "vol-1", title: "巻" }, chapter: { id: "ch-1", title: "章" },
    manuscript_path: "manuscript/sc-1.md", metadata_revision: revision, manuscript_revision: revision, diagnostics: [],
  } });
  assert.equal(next.ok, false);
  assert.equal(next.error.code, "snapshot_stale");
  guest.dispose();
});
