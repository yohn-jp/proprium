import assert from "node:assert/strict";
import test from "node:test";
import YAML from "yaml";
import { guest } from "../guest.js";
import { sha256 } from "../src/core.js";

test("feedback decisions are replay-bound, timestamped and proposed with exact source evidence", () => {
  const scope = { workspace_id: "workspace-feedback", repository_id: 42, branch: "main", generation: "g-feedback" };
  const snapshot = { id: "s-feedback", local_commit: "commit-f", worktree_generation: "tree-f", draft_generation: null };
  const text = "彼は…と話した。";
  const revision = sha256(text);
  guest.initialize({ pluginId: "proprium.diagnostics", version: "0.1.0", workspaceId: scope.workspace_id });
  const respond = (call: Record<string, unknown>, response: Record<string, unknown>) => JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: call.call_id, ...response })));
  let result = JSON.parse(guest.invoke(JSON.stringify({
    schema_version: 1, request_id: "feedback-lint", plugin_id: "proprium.diagnostics", action_id: "proprium.diagnostics.lint.run.v1",
    scope, snapshot, input: { text, documentPath: "manuscript/scene.md", documentRevision: revision }, deadline_ms: 30_000,
  })));
  while (result.kind === "host_call") result = respond(result, { ok: false, error: { code: "file_not_found", message: "No custom rules", retryable: false } });
  assert.equal(result.ok, true);
  const finding = result.value.findings[0];
  assert.ok(finding, "fixture should produce a format finding");

  let feedbackBytes: Uint8Array | undefined;
  let feedbackRevision: string | null = null;
  let timestampSequence = 0;
  const proposals: Array<Record<string, unknown>> = [];
  const applyAction = (decision: string, key: string, expected?: string | null) => {
    let action = JSON.parse(guest.invoke(JSON.stringify({
      schema_version: 1, request_id: `feedback-${key}`, plugin_id: "proprium.diagnostics", action_id: "proprium.diagnostics.feedback.propose.v1",
      scope, snapshot, input: { findingFingerprint: finding.fingerprint, decision, sourceIdentity: finding.sourceIdentity, idempotencyKey: key, ...(expected === undefined ? {} : { expectedFeedbackRevision: expected }) },
      deadline_ms: 30_000, idempotency_key: key,
    })));
    while (action.kind === "host_call") {
      const payload = action.payload as Record<string, unknown>;
      if (action.operation === "workspace.file.read") {
        const path = String(payload.path);
        if (path === "manuscript/scene.md") {
          const bytes = [...new TextEncoder().encode(text)];
          action = respond(action, { ok: true, value: { revision, total_bytes: bytes.length, offset: 0, bytes, next_offset: null } });
        } else if (path === "meta/proprium/plugins/proprium.diagnostics/feedback.yaml" && feedbackBytes) {
          action = respond(action, { ok: true, value: { revision: feedbackRevision, total_bytes: feedbackBytes.length, offset: 0, bytes: [...feedbackBytes], next_offset: null } });
        } else action = respond(action, { ok: false, error: { code: "file_not_found", message: "File is absent", retryable: false } });
      } else if (action.operation === "workspace.change.timestamp") {
        timestampSequence++;
        action = respond(action, { ok: true, value: { timestamp: `2026-10-26T00:00:${String(timestampSequence).padStart(2, "0")}Z` } });
      } else if (action.operation === "workspace.change.propose") {
        const changeset = payload.changeset as Record<string, unknown>;
        proposals.push(changeset);
        const operations = ((changeset.units as Array<Record<string, unknown>>)[0].operations as Array<Record<string, unknown>>);
        feedbackBytes = Uint8Array.from(operations[0].content as number[]);
        feedbackRevision = sha256(new TextDecoder().decode(feedbackBytes));
        action = respond(action, { ok: true, value: { proposal_id: `proposal-${proposals.length}` } });
      } else assert.fail(`unexpected Host operation ${String(action.operation)}`);
    }
    return action;
  };

  const first = applyAction("intentional", "feedback-key-1", null);
  assert.equal(first.ok, true);
  assert.equal(first.value.expectedRevision, null);
  const firstChange = proposals[0];
  const firstOperation = ((firstChange.units as Array<Record<string, unknown>>)[0].operations as Array<Record<string, unknown>>)[0];
  assert.equal(firstOperation.kind, "create");
  assert.equal(firstOperation.expected_revision, null);
  assert.equal(firstOperation.path, "meta/proprium/plugins/proprium.diagnostics/feedback.yaml");
  assert.ok((firstChange.read_set as Array<Record<string, unknown>>).some((row) => row.path === "manuscript/scene.md" && row.revision === revision));
  const firstDocument = YAML.parse(new TextDecoder().decode(feedbackBytes)) as Record<string, unknown>;
  const firstEntry = (firstDocument.entries as Array<Record<string, unknown>>)[0];
  assert.equal(firstDocument.schemaVersion, 1);
  assert.equal(firstEntry.decision, "intentional");
  assert.equal(firstEntry.createdAt, "2026-10-26T00:00:01Z");

  const withUnknown = YAML.parseDocument(new TextDecoder().decode(feedbackBytes));
  withUnknown.set("retainedRootField", { source: "author" });
  const entriesNode = withUnknown.get("entries", true) as { items: Array<{ set(key: string, value: unknown): void }> };
  entriesNode.items[0].set("retainedEntryField", "preserve me");
  feedbackBytes = new TextEncoder().encode(withUnknown.toString({ lineWidth: 0 }));
  feedbackRevision = sha256(new TextDecoder().decode(feedbackBytes));

  const secondExpectedRevision = feedbackRevision;
  const second = applyAction("false_positive", "feedback-key-2", secondExpectedRevision);
  assert.equal(second.ok, true);
  assert.equal(second.value.expectedRevision, sha256(withUnknown.toString({ lineWidth: 0 })));
  const secondDocument = YAML.parse(new TextDecoder().decode(feedbackBytes)) as Record<string, unknown>;
  const secondEntry = (secondDocument.entries as Array<Record<string, unknown>>)[0];
  assert.deepEqual(secondDocument.retainedRootField, { source: "author" });
  assert.equal(secondEntry.retainedEntryField, "preserve me");
  assert.equal(secondEntry.id, firstEntry.id);
  assert.equal(secondEntry.decision, "false_positive");
  assert.equal(secondEntry.createdAt, "2026-10-26T00:00:01Z");
  assert.equal(secondEntry.updatedAt, "2026-10-26T00:00:02Z");
  const secondChange = proposals[1];
  assert.equal(((secondChange.units as Array<Record<string, unknown>>)[0].operations as Array<Record<string, unknown>>)[0].expected_revision, secondExpectedRevision);
  guest.dispose();
});
