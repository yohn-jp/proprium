import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { sourceTextDecoder } from "../../app/src/browser/proprium/authoring/source-text.ts";
import { guest } from "./guest.ts";
import { parseSemanticSourceFile } from "./source.ts";

const scope = { workspace_id: "workspace-a", repository_id: 7, branch: "main", generation: "g1" };
const snapshot = { id: "snapshot-a", local_commit: null, worktree_generation: "w1", draft_generation: null };
const rerankSourcePath = "bible/scenes/one.yaml";
const rerankSourceText = "id: scene-a\ntype: scene\nbody: '🌃 旅人は町へ入った。'\n";
const revisionFor = (text: string) => createHash("sha256").update(new TextEncoder().encode(text)).digest("hex");
const rerankSourceRevision = revisionFor(rerankSourceText);
const rerankSourcePassage = parseSemanticSourceFile(rerankSourcePath, rerankSourceRevision, rerankSourceText)!.passages[0]!;
const validRerankCandidate = {
  candidateId: "candidate-1", entityId: "scene-a", sourcePath: rerankSourcePath, sourceRevision: rerankSourceRevision,
  sentenceIndex: rerankSourcePassage.sentenceIndex, text: rerankSourcePassage.text, evidence: [rerankSourcePassage.evidence],
};

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

function rerankAfterHostReads(candidate: typeof validRerankCandidate, currentText = rerankSourceText,
  currentRevision = rerankSourceRevision) {
  const response = JSON.parse(startInvoke("proprium.semantic.rerank", { query: "旅人", limit: 1, candidates: [candidate] })) as Record<string, any>;
  const operations: string[] = [];
  let next = response;
  for (;;) {
    if (next.kind !== "host_call") {
      guest.dispose();
      return { result: next, operations };
    }
    operations.push(next.operation);
    if (next.operation === "plugin.preferences.read") {
      next = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: next.call_id, ok: true,
        value: { found: true, value: { rerankerEnabled: true } } })));
    } else if (next.operation === "workspace.file.list") {
      assert.equal(next.payload.prefix, rerankSourcePath);
      assert.equal(next.payload.snapshot.id, snapshot.id);
      next = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: next.call_id, ok: true,
        value: { entries: [{ path: rerankSourcePath, revision: currentRevision, byte_length: new TextEncoder().encode(currentText).length,
          media_type: "text/yaml" }], next_cursor: null } })));
    } else if (next.operation === "workspace.file.read") {
      assert.equal(next.payload.path, rerankSourcePath);
      assert.equal(next.payload.snapshot.id, snapshot.id);
      const bytes = [...new TextEncoder().encode(currentText)];
      next = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: next.call_id, ok: true,
        value: { revision: currentRevision, total_bytes: bytes.length, offset: 0, bytes, next_offset: null } })));
    } else throw new Error(`Unexpected rerank Host operation: ${next.operation}`);
  }
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
  assert.equal(status.operation, "workspace.derived.cache.get");
  status = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: status.call_id, ok: true, value: { found: false } })));
  assert.equal(status.operation, "workspace.derived.cache.get_previous");
  status = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: status.call_id, ok: true, value: { found: false } })));
  assert.equal(status.operation, "workspace.derived.cache.get_previous");
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
  assert.equal(query.operation, "workspace.derived.cache.get");
  query = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: query.call_id, ok: true, value: { found: false } })));
  assert.equal(query.operation, "workspace.derived.cache.get_previous");
  query = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: query.call_id, ok: true, value: { found: false } })));
  assert.equal(query.operation, "workspace.derived.cache.get_previous");
  query = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: query.call_id, ok: true, value: { found: false } })));
  assert.equal(query.ok, false);
  assert.equal(query.error.code, "index_missing");
  assert.doesNotMatch(query.error.message, /asset is unavailable/i);
  guest.dispose();

  let rebuild = JSON.parse(startInvoke("proprium.semantic.index.rebuild", { taskId: "build-1" })) as Record<string, any>;
  assert.equal(rebuild.operation, "workspace.derived.cache.get");
  rebuild = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: rebuild.call_id, ok: true, value: { found: false } })));
  assert.equal(rebuild.operation, "workspace.derived.cache.get");
  rebuild = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: rebuild.call_id, ok: true, value: { found: false } })));
  assert.equal(rebuild.operation, "workspace.derived.cache.get_previous");
  rebuild = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: rebuild.call_id, ok: true, value: { found: false } })));
  assert.equal(rebuild.operation, "workspace.derived.cache.get_previous");
  rebuild = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: rebuild.call_id, ok: true, value: { found: false } })));
  assert.equal(rebuild.ok, true);
  assert.equal(rebuild.value.state, "running");
  guest.dispose();
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

test("BGE preparation and inference require the Host reranker preference, independently of E5 state", () => {
  let prepare = JSON.parse(startInvoke("proprium.semantic.reranker.prepare", { taskId: "bge-task" })) as Record<string, any>;
  assert.equal(prepare.operation, "plugin.preferences.read");
  assert.deepEqual(prepare.payload, { plugin_id: "proprium.semantic", key: "reranker.enabled", schema_version: 1 });
  prepare = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: prepare.call_id, ok: true, value: { found: false } }))) as Record<string, any>;
  assert.equal(prepare.ok, false);
  assert.equal(prepare.error.code, "capability_denied");
  assert.equal(prepare.snapshot.id, snapshot.id);
  guest.dispose();

  let rerank = JSON.parse(startInvoke("proprium.semantic.rerank", { query: "旅", limit: 1, candidates: [validRerankCandidate] })) as Record<string, any>;
  assert.equal(rerank.operation, "plugin.preferences.read");
  rerank = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: rerank.call_id, ok: true, value: { found: true, value: { rerankerEnabled: false } } }))) as Record<string, any>;
  assert.equal(rerank.ok, false);
  assert.equal(rerank.error.code, "capability_denied");
  guest.dispose();
});

test("BGE reranking rereads and verifies the exact current UTF-16 source evidence before inference", () => {
  const valid = rerankAfterHostReads(validRerankCandidate);
  assert.deepEqual(valid.operations, ["plugin.preferences.read", "workspace.file.list", "workspace.file.read"]);
  assert.equal(valid.result.ok, false);
  assert.equal(valid.result.error.code, "provider_unavailable", "valid source must advance to the unavailable, unprepared model");

  const staleRevision = rerankAfterHostReads({ ...validRerankCandidate,
    sourceRevision: "b".repeat(64), evidence: validRerankCandidate.evidence.map(span => ({ ...span, revision: "b".repeat(64) })) });
  assert.equal(staleRevision.result.error.code, "snapshot_stale");
  assert.deepEqual(staleRevision.operations, ["plugin.preferences.read", "workspace.file.list"]);

  const forgedQuote = validRerankCandidate.evidence[0]!.quote.replace("旅人", "旅行");
  assert.equal(forgedQuote.length, validRerankCandidate.evidence[0]!.quote.length);
  const mismatchedQuote = rerankAfterHostReads({ ...validRerankCandidate, evidence: [{ ...validRerankCandidate.evidence[0]!, quote: forgedQuote }] });
  assert.equal(mismatchedQuote.result.error.code, "snapshot_stale");
  assert.deepEqual(mismatchedQuote.operations, ["plugin.preferences.read", "workspace.file.list", "workspace.file.read"]);

  const forgedText = rerankAfterHostReads({ ...validRerankCandidate, text: validRerankCandidate.text.replace("入", "出") });
  assert.equal(forgedText.result.error.code, "snapshot_stale");
  assert.deepEqual(forgedText.operations, ["plugin.preferences.read", "workspace.file.list", "workspace.file.read"]);

  const bomText = `\uFEFF${rerankSourceText}`;
  const bomRevision = revisionFor(bomText);
  const bomHostText = sourceTextDecoder().decode(new TextEncoder().encode(bomText));
  const bomPassage = parseSemanticSourceFile(rerankSourcePath, bomRevision, bomHostText)!.passages[0]!;
  assert.equal(bomPassage.evidence.quote, bomHostText.slice(bomPassage.evidence.start, bomPassage.evidence.end));
  assert.equal(bomPassage.evidence.start, bomHostText.indexOf(bomPassage.evidence.quote));
  const shiftedEvidence = rerankAfterHostReads({ ...validRerankCandidate, sourceRevision: bomRevision,
    evidence: validRerankCandidate.evidence.map(span => ({ ...span, revision: bomRevision })) }, bomText, bomRevision);
  assert.equal(shiftedEvidence.result.error.code, "snapshot_stale", "offsets from BOM-stripped text must be rejected against original Host text");
  const bomEvidence = rerankAfterHostReads({ ...validRerankCandidate, sourceRevision: bomRevision, text: bomPassage.text,
    sentenceIndex: bomPassage.sentenceIndex, evidence: [bomPassage.evidence] }, bomText, bomRevision);
  assert.equal(bomEvidence.result.error.code, "provider_unavailable", "correct original UTF-16 offsets must advance to the unavailable model");

  const missingQuote = rerankAfterHostReads({ ...validRerankCandidate, evidence: [{ ...validRerankCandidate.evidence[0]!, quote: undefined as unknown as string }] });
  assert.equal(missingQuote.result.error.code, "invalid_input");
  assert.deepEqual(missingQuote.operations, [], "malformed quote shapes must fail before Host access");

  const nulPath = rerankAfterHostReads({ ...validRerankCandidate, sourcePath: "bible/scenes/one.yaml\0evil",
    evidence: [{ ...validRerankCandidate.evidence[0]!, path: "bible/scenes/one.yaml\0evil" }] });
  assert.equal(nulPath.result.error.code, "invalid_input");
  assert.deepEqual(nulPath.operations, [], "malformed paths must fail before Host access or model scoring");
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
  assert.ok(manifest.actions.some((action: { action_id: string }) => action.action_id === "proprium.semantic.index.step"));
  const rebuild = panel.body.tabs.find((tab: { id: string }) => tab.id === "rebuild");
  assert.equal(rebuild.body.submit.action_id, "proprium.semantic.index.rebuild");
});
