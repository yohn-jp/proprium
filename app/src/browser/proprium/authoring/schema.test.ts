import assert from "node:assert/strict";
import test from "node:test";
import { assertActionRequest, assertDescriptor, assertValue, assertSurface } from "./schema.js";

const input = { type: "object", properties: { query: { type: "string", maxLength: 100 } }, required: ["query"], additionalProperties: false };
const descriptor = {
  plugin_id: "proprium.research", action_id: "research.query", schema_version: 1, effect: "read",
  input_schema: input, output_schema: input, required_capabilities: ["workspace.file.read"],
  callers: ["ui", "mcp", "plugin"], requires_user_gesture: false,
};
test("adopted validators reject caller spoofing and undeclared input fields", () => {
  assertDescriptor(descriptor);
  assertValue(input, { query: "日本語" });
  assert.throws(() => assertValue(input, { query: "本文", caller: "ui" }), /declared schema/);
  const request = { schema_version: 1, request_id: "req", plugin_id: descriptor.plugin_id, action_id: descriptor.action_id,
    scope: { workspace_id: "w", repository_id: null, branch: "main", generation: "g" },
    snapshot: { id: "s", local_commit: null, worktree_generation: "g", draft_generation: null }, input: { query: "本文" }, deadline_ms: 30000 };
  assertActionRequest(request);
  assert.throws(() => assertActionRequest({ ...request, caller: "ui" }));
  assert.throws(() => assertActionRequest({ ...request, scope: { ...request.scope, repository_id: "legacy-project" } }));
});
test("admission refuses network schema references and unbounded public shapes", () => {
  assert.throws(() => assertDescriptor({ ...descriptor, input_schema: { $ref: "https://untrusted.example/schema" } }));
  assert.throws(() => assertDescriptor({ ...descriptor, input_schema: { type: "object", properties: {} } }));
  assert.throws(() => assertDescriptor({ ...descriptor, input_schema: { type: "array", items: { type: "number" } } }));
});
test("only Host widget shapes and declared data bindings are admitted", () => {
  const surface = { id: "search", kind: "panel", title: "検索", context: {}, body: {
    id: "results", type: "list", items: { data_key: "last_action_result.items" }, primary: "title",
    load_action: { action_id: "research.query", input_template: { query: "本文" } },
  } };
  assertSurface(surface);
  assert.throws(() => assertSurface({ ...surface, body: { ...surface.body, html: "<script>" } }));
  assert.throws(() => assertSurface({ ...surface, body: { id: "custom", type: "html", value: "<b>" } }));
});

test("interpreted schema validation preserves frozen signed declarations and rejects malformed types", () => {
  const schema = Object.freeze({ type: "object", additionalProperties: false,
    properties: Object.freeze({ count: Object.freeze({ type: "integer", minimum: 1 }) }), required: Object.freeze(["count"]) });
  const before = JSON.stringify(schema);
  assertValue(schema, { count: 2 });
  assert.equal(JSON.stringify(schema), before);
  assert.throws(() => assertValue(schema, { count: 0 }));
  assert.throws(() => assertValue({ type: "invented" } as never, {}));
  assert.throws(() => assertValue({ type: "object", properties: { x: { type: "invented" } }, additionalProperties: false } as never, {}));
});
