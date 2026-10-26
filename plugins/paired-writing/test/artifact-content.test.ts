import assert from "node:assert/strict";
import test from "node:test";
import type { ActionRequest, Snapshot } from "../../../app/src/browser/proprium/authoring/types.js";
import type { GuestHost, HostCall } from "../../shared/guest.js";
import { createContentReference } from "../src/artifact-content.js";
import { sha256 } from "../src/sha256.js";

const scope = { workspace_id: "workspace-1", repository_id: 41, branch: "main", generation: "generation-1" };
const snapshot: Snapshot = { id: "snapshot-1", local_commit: "commit-1", worktree_generation: "worktree-1", draft_generation: null };
const request: ActionRequest = { schema_version: 1, request_id: "artifact-1", plugin_id: "proprium.paired-writing", action_id: "paired.rewrite.propose", scope, snapshot, input: {}, deadline_ms: 30_000 };

function* requestHost<T>(operation: string, payload: Record<string, unknown>): Generator<HostCall, T, unknown> {
  return (yield { kind: "host_call", call_id: "", operation, payload }) as T;
}

function drive<T>(generator: Generator<HostCall, T, unknown>, respond: (operation: string, payload: Record<string, unknown>) => unknown): T {
  let state = generator.next();
  while (!state.done) {
    const call = state.value;
    state = generator.next(respond(call.operation, call.payload));
  }
  return state.value;
}

test("large Paired output streams exact bytes and digest through Host artifact operations", () => {
  const text = `${"🌙日本語".repeat(40_000)}\r\n`;
  const bytes = new TextEncoder().encode(text);
  const chunks: number[][] = [];
  const calls: string[] = [];
  const host: GuestHost = { request: requestHost };
  const result = drive(createContentReference(host, request, "manuscript/v1/c1/s1.md", text), (operation, payload) => {
    calls.push(operation);
    if (operation === "artifact.create") {
      assert.deepEqual(payload, { media_type: "text/markdown", filename: "s1.md", scope, snapshot });
      return "artifact-1";
    }
    if (operation === "artifact.append") {
      assert.equal(payload.artifact_id, "artifact-1");
      assert.equal(payload.sequence, chunks.length);
      assert.ok((payload.bytes as number[]).length <= 256 * 1024);
      chunks.push(payload.bytes as number[]);
      return null;
    }
    if (operation === "artifact.seal") {
      assert.deepEqual(payload, { artifact_id: "artifact-1", sha256: sha256(bytes), total_bytes: bytes.byteLength });
      return null;
    }
    throw new Error(`Unexpected Host operation ${operation}`);
  });
  assert.deepEqual(calls, ["artifact.create", "artifact.append", "artifact.append", "artifact.seal"]);
  assert.equal("content" in result, false);
  assert.deepEqual(result, { content_artifact: "artifact-1", artifact_id: "artifact-1" });
  const flattened = Uint8Array.from(chunks.flat());
  assert.deepEqual(flattened, bytes);
});

test("small Paired output remains inline and needs no artifact capability", () => {
  const text = "short passage\r\n";
  const result = drive(createContentReference({ request: requestHost } as GuestHost, request, "manuscript/s1.md", text), () => {
    throw new Error("Small contents must stay inline");
  });
  assert.deepEqual(result, { content: Array.from(new TextEncoder().encode(text)) });
});
