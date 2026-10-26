import assert from "node:assert/strict";
import test from "node:test";
import { createGuest, withWarnings } from "./guest.ts";

const request = {
  schema_version: 1, request_id: "job", plugin_id: "example.reader", action_id: "read",
  scope: { workspace_id: "workspace", repository_id: null, branch: "main", generation: "g" },
  snapshot: { id: "snapshot", local_commit: null, worktree_generation: "g", draft_generation: null },
  input: {}, deadline_ms: 30000,
};
test("cooperative guest preserves action identity and warnings over an asynchronous Host continuation", () => {
  const guest = createGuest("example.reader", {
    *read(_input, context, host) {
      const value = yield* host.request("workspace.file.read", { snapshot: context.snapshot, path: "draft.md" });
      return withWarnings(value, ["optional_dictionary_unavailable"]);
    },
  });
  guest.initialize({ pluginId: "example.reader", version: "1.0.0", workspaceId: "workspace" });
  const pending = JSON.parse(guest.invoke(JSON.stringify(request)));
  assert.equal(pending.call_id, "job:1");
  assert.throws(() => guest.invoke(JSON.stringify({ kind: "host_response", call_id: "other:1", ok: true, value: "wrong" })));
  const result = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: pending.call_id, ok: true, value: "本文\r\n" })));
  assert.equal(result.value, "本文\r\n");
  assert.deepEqual(result.scope, request.scope);
  assert.deepEqual(result.warnings, ["optional_dictionary_unavailable"]);
});
test("Host denial stays a typed error and completed guest can accept the next action", () => {
  const guest = createGuest("example.reader", { *read(_input, _context, host) { return yield* host.request("workspace.file.read", {}); } });
  guest.initialize({ pluginId: "example.reader", version: "1.0.0", workspaceId: "workspace" });
  const pending = JSON.parse(guest.invoke(JSON.stringify(request)));
  const result = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: pending.call_id, ok: false,
    error: { code: "snapshot_stale", message: "Source changed", retryable: true } })));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "snapshot_stale");
  assert.equal(JSON.parse(guest.invoke(JSON.stringify({ ...request, request_id: "next" }))).call_id, "next:1");
});
