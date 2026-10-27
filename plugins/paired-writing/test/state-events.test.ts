import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStateEventCandidates } from "../src/state-events.js";

test("state events keep only uniquely evidenced exact UTF-16 spans", () => {
  const text = "---\ntitle: 題\n---\n😀灯は港へ着いた。灯は港へ着いた。\n鍵を渡した。";
  const base = { kind: "ownership", target: "char-a", operation: "give", before: null, after: { owner: "char-b" }, object: "key", payload: {} };
  const result = parseStateEventCandidates(JSON.stringify({ events: [
    { ...base, evidenceQuote: "灯は港へ着いた。" }, { ...base, evidenceQuote: "鍵を渡した。" },
    { ...base, evidenceQuote: "存在しない" },
  ] }), { path: "manuscript/a.md", revision: "a".repeat(64), text });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]!.confidence, 0.5);
  assert.equal(text.slice(result.events[0]!.evidence.start, result.events[0]!.evidence.end), "鍵を渡した。");
  assert.equal(result.diagnostics.length, 2);
});

test("state event candidates reject invented types and more than 20 entries", () => {
  const source = { path: "manuscript/a.md", revision: "a".repeat(64), text: "確かな本文" };
  assert.throws(() => parseStateEventCandidates(JSON.stringify({ events: [{ kind: "prediction" }] }), source), { code: "invalid_input" });
  assert.throws(() => parseStateEventCandidates(JSON.stringify({ events: Array(21).fill({}) }), source), { code: "capacity" });
});

test("frontmatter cannot serve as state evidence", () => {
  const source = { path: "m.md", revision: "a".repeat(64), text: "---\ntitle: 青い港\n---\n本文のみ。" };
  const value = { kind: "location", target: "char-a", operation: "move", before: null, after: null, object: "loc-a", payload: {}, evidenceQuote: "青い港" };
  assert.equal(parseStateEventCandidates(JSON.stringify({ events: [value] }), source).events.length, 0);
});

test("selected state event delegates exact body-relative evidence to Knowledge", async () => {
  const { proposeStateEvent } = await import("../src/state-events.js");
  const { sha256 } = await import("../src/sha256.js");
  const scope = { workspace_id: "w", repository_id: 7, branch: "main", generation: "g" };
  const snapshot = { id: "s", local_commit: null, worktree_generation: "g", draft_generation: null };
  const request = { schema_version: 1 as const, request_id: "r", plugin_id: "proprium.paired-writing", action_id: "paired.state-events.propose", scope, snapshot, input: {}, deadline_ms: 30000, idempotency_key: "key" };
  const text = "---\ntitle: 題\n---\n😀鍵を渡した。\n", body = "😀鍵を渡した。\n", bodyOffset = text.indexOf(body), revision = "a".repeat(64), metadataRevision = "b".repeat(64), path = "manuscript/s.md";
  const parsed = parseStateEventCandidates(JSON.stringify({ events: [{ kind: "ownership", target: "item-1", operation: "give", before: null, after: null, object: "char-1", payload: {}, evidenceQuote: "鍵を渡した。" }] }), { path, revision, text });
  const host = { request(operation: string, payload: Record<string, unknown>) { return (function* () { return yield { kind: "host_call", call_id: "", operation, payload }; })(); } };
  const iter = proposeStateEvent({ sceneId: "scene-1", candidate: parsed.events[0] }, host as any, request); let next = iter.next(), captured: any;
  while (!next.done) {
    const call = next.value; let value: any;
    if (call.operation === "workspace.plugin.invoke") {
      const action = call.payload.action_id;
      if (action === "knowledge.state-proposals.create") { captured = call.payload.input; value = { proposalId: "proposal-1" }; }
      else value = action === "proprium.narrative.scene.open" ? { scene: { id: "scene-1", metadata_path: "scene.yaml", metadata_revision: metadataRevision }, manuscript_path: path, manuscript_revision: revision } : { scene_id: "scene-1", metadata_revision: metadataRevision, manuscript_path: path, manuscript_revision: revision };
      value = { ok: true, scope, snapshot, request_id: "child", warnings: [], value };
    } else if (call.operation === "workspace.file.read") { const bytes = [...new TextEncoder().encode(text)]; value = { revision, total_bytes: bytes.length, offset: 0, bytes, next_offset: null }; }
    else throw new Error(`Unexpected Host call ${call.operation}`);
    next = iter.next(value);
  }
  assert.equal(captured.manuscriptHash, sha256(new TextEncoder().encode(body)));
  assert.equal(captured.expectedSceneRevision, metadataRevision);
  assert.equal(captured.event.evidence[0].startOffset, parsed.events[0]!.evidence.start - bodyOffset);
  assert.equal(body.slice(captured.event.evidence[0].startOffset, captured.event.evidence[0].endOffset), "鍵を渡した。");
  assert.deepEqual(next.value, { proposalId: "proposal-1" });
});

test("state-event generation accepts fenced JSON from a provider", () => {
  assert.deepEqual(parseStateEventCandidates('```json\n{"events":[]}\n```', { path: "m.md", revision: "a".repeat(64), text: "本文" }).events, []);
});
