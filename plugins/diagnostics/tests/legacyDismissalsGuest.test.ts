import assert from "node:assert/strict";
import test from "node:test";
import YAML from "yaml";
import { assertValue } from "../../../app/src/browser/proprium/authoring/schema.js";
import { guest } from "../guest.js";
import { sha256 } from "../src/core.js";

test("legacy dismissal import preserves source JSONL, unknown fields, and unresolved rows behind Host review", async () => {
  const scope = { workspace_id: "workspace-legacy-dismissals", repository_id: 52, branch: "main", generation: "g-legacy" };
  const snapshot = { id: "s-legacy", local_commit: "commit-legacy", worktree_generation: "tree-legacy", draft_generation: null };
  const legacyPath = "meta/scriptorium/modules/semantic/contradiction-dismissals.jsonl";
  const feedbackPath = "meta/proprium/plugins/proprium.diagnostics/feedback.yaml";
  const candidateId = "embed:char-a:sc-a:0:sc-b:0";
  const firstLine = JSON.stringify({ candidateId, timestamp: "2024-03-01T00:00:00Z", unknownField: { keep: ["raw", "legacy"] } });
  const secondLine = JSON.stringify({ candidateId: "embed:missing:scene:0:other:0", timestamp: "2024-03-02T00:00:00Z", extra: "stay in source" });
  const duplicateId = "embed:duplicate:scene:0:other:0";
  const duplicateLineA = JSON.stringify({ candidateId: duplicateId, timestamp: "2024-03-03T00:00:00Z", extension: "first" });
  const duplicateLineB = JSON.stringify({ candidateId: duplicateId, timestamp: "2024-03-04T00:00:00Z", extension: "second" });
  const malformedLine = "{not-json, retained exactly";
  const legacyText = `${firstLine}\n${secondLine}\n${duplicateLineA}\n${duplicateLineB}\n${malformedLine}\n`;
  const legacyBytes = new TextEncoder().encode(legacyText);
  const legacyRevision = sha256(legacyText);
  const feedbackText = "schemaVersion: 1\nretainedRootField: keep-me\nentries: []\n";
  const feedbackBytes = new TextEncoder().encode(feedbackText);
  const feedbackRevision = sha256(feedbackText);
  const sceneTexts = new Map([
    ["manuscript/a.md", "彼は剣を見つけた。"],
    ["manuscript/b.md", "彼女は剣を捨てた。"],
  ]);
  const sceneRevisions = new Map([...sceneTexts].map(([path, text]) => [path, sha256(text)]));
  const sources = new Map<string, Uint8Array>([
    [legacyPath, legacyBytes], [feedbackPath, feedbackBytes],
    ...[...sceneTexts].map(([path, text]) => [path, new TextEncoder().encode(text)] as const),
  ]);
  const candidate = {
    id: candidateId, kind: "embedding_midband", score: 0.5, suspicion: "確認が必要", entityId: "char-a",
    evidenceA: { sceneId: "sc-a", sentenceIndex: 0, quote: "彼は剣を見つけた。", entityId: "char-a" },
    evidenceB: { sceneId: "sc-b", sentenceIndex: 0, quote: "彼女は剣を捨てた。", entityId: "char-a" },
  };
  const model = { id: "test-embedding", revision: "1", role: "embedding", digest: null, byte_length: null, license: "test", status: "ready" };
  guest.initialize({ pluginId: "proprium.diagnostics", version: "0.1.0", workspaceId: scope.workspace_id });
  const proposals: Array<Record<string, unknown>> = [];
  const run = (actionId: string, input: Record<string, unknown>, requestId: string) => {
    let result = JSON.parse(guest.invoke(JSON.stringify({ schema_version: 1, request_id: requestId, plugin_id: "proprium.diagnostics", action_id: actionId, scope, snapshot, input, deadline_ms: 30_000, ...(input.idempotencyKey ? { idempotency_key: input.idempotencyKey } : {}) })));
    while (result.kind === "host_call") {
      const payload = result.payload as Record<string, unknown>;
      if (result.operation === "workspace.file.read") {
        const path = String(payload.path);
        const bytes = sources.get(path);
        if (!bytes) result = resume(result, { ok: false, error: { code: "file_not_found", message: "Absent", retryable: false } });
        else {
          const offset = Number(payload.offset);
          const length = Number(payload.length);
          const chunk = [...bytes.slice(offset, offset + length)];
          result = resume(result, { ok: true, value: { revision: path === legacyPath ? legacyRevision : path === feedbackPath ? feedbackRevision : sceneRevisions.get(path), total_bytes: bytes.length, offset, bytes: chunk, next_offset: offset + chunk.length === bytes.length ? null : offset + chunk.length } });
        }
      } else if (result.operation === "workspace.plugin.invoke") {
        const nestedAction = String(payload.action_id);
        let value: unknown;
        if (nestedAction === "proprium.semantic.contradictions.candidates") value = { snapshot, model, indexAvailable: true, candidates: [candidate], nextCursor: null, complete: true };
        else if (nestedAction === "proprium.narrative.scene.context") {
          const sceneId = String((payload.input as Record<string, unknown>).scene_id);
          const isA = sceneId === "sc-a";
          const path = isA ? "manuscript/a.md" : "manuscript/b.md";
          value = { scene_id: sceneId, manuscript_path: path, manuscript_revision: sceneRevisions.get(path) };
        } else assert.fail(`unexpected nested action ${nestedAction}`);
        result = resume(result, { ok: true, value: { request_id: `nested-${nestedAction}`, scope, snapshot, ok: true, warnings: [], value } });
      } else if (result.operation === "workspace.change.timestamp") {
        result = resume(result, { ok: true, value: { timestamp: "2026-10-29T00:00:00Z" } });
      } else if (result.operation === "workspace.change.propose") {
        const changeset = payload.changeset as Record<string, unknown>;
        proposals.push(changeset);
        const operation = (((changeset.units as Array<Record<string, unknown>>)[0].operations as Array<Record<string, unknown>>)[0]);
        if (operation.content) sources.set(feedbackPath, Uint8Array.from(operation.content as number[]));
        result = resume(result, { ok: true, value: { proposal_id: `proposal-${proposals.length}` } });
      } else assert.fail(`unexpected Host operation ${String(result.operation)}`);
    }
    return result;
  };
  const resume = (call: Record<string, unknown>, response: Record<string, unknown>) => JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: call.call_id, ...response })));

  const inspected = run("proprium.diagnostics.legacy-dismissals.inspect.v1", {}, "legacy-inspect");
  assert.equal(inspected.ok, true, JSON.stringify(inspected.error));
  const inspectManifest = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../plugin.json", import.meta.url), "utf8"));
  const inspectDescriptor = inspectManifest.actions.find((action: { action_id: string }) => action.action_id === "proprium.diagnostics.legacy-dismissals.inspect.v1");
  assertValue(inspectDescriptor.output_schema, inspected.value);
  assert.equal(inspected.value.rows[0].disposition, "importable", JSON.stringify(inspected.value.rows));
  assert.equal(inspected.value.rows[1].disposition, "unresolved");
  assert.equal(inspected.value.rows[0].rawLine, firstLine);
  assert.equal(inspected.value.rows[0].sourceRevision, legacyRevision);
  assert.equal(inspected.value.rows[0].targetFingerprint.length, 64);
  assert.equal(inspected.value.rows[1].disposition, "unresolved");
  assert.equal(inspected.value.rows[2].disposition, "conflict");
  assert.equal(inspected.value.rows[3].disposition, "conflict");
  assert.equal(inspected.value.rows[4].disposition, "invalid");
  assert.equal(inspected.value.rows[4].rawLine, malformedLine, "malformed source rows remain visible byte-for-byte");

  const proposed = run("proprium.diagnostics.legacy-dismissals.propose.v1", {
    rows: [{ sourcePath: legacyPath, sourceRevision: legacyRevision, rowId: inspected.value.rows[0].rowId }],
    expectedFeedbackRevision: feedbackRevision, idempotencyKey: "legacy-import-1",
  }, "legacy-propose");
  assert.equal(proposed.ok, true, JSON.stringify(proposed.error));
  const proposedDescriptor = inspectManifest.actions.find((action: { action_id: string }) => action.action_id === "proprium.diagnostics.legacy-dismissals.propose.v1");
  assertValue(proposedDescriptor.output_schema, proposed.value);
  assert.equal(proposed.value.importedRowIds[0], inspected.value.rows[0].rowId);
  assert.equal(sources.get(legacyPath), legacyBytes, "the legacy source bytes are never rewritten");
  assert.equal(proposals.length, 1);
  const changeSet = proposals[0];
  assert.deepEqual((changeSet.read_set as Array<Record<string, unknown>>).find((row) => row.path === legacyPath), { path: legacyPath, revision: legacyRevision });
  assert.ok((changeSet.evidence as Array<Record<string, unknown>>).some((row) => row.path === legacyPath && row.revision === legacyRevision));
  const operation = (((changeSet.units as Array<Record<string, unknown>>)[0].operations as Array<Record<string, unknown>>)[0]);
  assert.equal(operation.path, feedbackPath);
  const after = YAML.parse(new TextDecoder().decode(sources.get(feedbackPath)!)) as Record<string, unknown>;
  assert.equal(after.retainedRootField, "keep-me");
  const entry = (after.entries as Array<Record<string, unknown>>)[0];
  assert.equal(entry.decision, "legacy_dismissed");
  assert.equal(entry.findingFingerprint, inspected.value.rows[0].targetFingerprint);
  const legacy = entry.legacy as Record<string, unknown>;
  assert.equal(legacy.rawLine, firstLine);
  assert.deepEqual((legacy.record as Record<string, unknown>).unknownField, { keep: ["raw", "legacy"] });
  guest.dispose();
});
