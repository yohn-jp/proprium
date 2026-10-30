import assert from "node:assert/strict";
import test from "node:test";
import type { ActionRequest, ChangeSet } from "../../../app/src/browser/proprium/authoring/types.js";
import type { GuestHost, HostCall } from "../../shared/guest.js";
import { submitProposal } from "./changeProposal.js";

test("Knowledge proposes Japanese evidence using UTF-16 source spans", () => {
  const source = "第一章📚の本文";
  const revision = "a".repeat(64);
  const host: GuestHost = {
    *request<T = unknown>(operation: string, payload: Record<string, unknown>): Generator<HostCall, T, unknown> {
      yield { kind: "host_call", call_id: "test", operation, payload };
      return { proposal_id: "receipt-1", status: "proposed", preview: {} } as T;
    },
  };
  const context = {
    idempotency_key: "jp-evidence-1",
    action_id: "knowledge.entities.update",
    scope: { workspace_id: "local-1", repository_id: null, branch: "main", generation: "session-1" },
    snapshot: { id: "snapshot-1", local_commit: null, worktree_generation: "tree-1", draft_generation: null },
  } as ActionRequest;
  const iterator = submitProposal({
    context, host, title: "日本語の提案", reason: "根拠がある変更",
    reads: [{ path: "chapter.md", revision, content: source }],
    writes: [{ path: "chapter.md", expected_revision: revision, content: source + "追記" }],
  });
  const step = iterator.next();
  assert.equal(step.done, false);
  const call = step.value as HostCall;
  assert.equal(call.operation, "workspace.change.propose");
  const proposed = call.payload.changeset as ChangeSet;
  assert.deepEqual(proposed.evidence, [{ path: "chapter.md", revision, start: 0, end: source.length, quote: source }]);
  assert.equal(source.length, 8);
  assert.ok(new TextEncoder().encode(source).byteLength > source.length);
});
