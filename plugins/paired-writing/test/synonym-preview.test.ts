import assert from "node:assert/strict";
import test from "node:test";
import { guest } from "../guest.js";
const scope = { workspace_id: "preview", repository_id: 1, branch: "main", generation: "g" };
const snapshot = { id: "s", local_commit: null, worktree_generation: "w", draft_generation: null };
function run(input: unknown) {
  guest.initialize({ pluginId: "proprium.paired-writing", version: "0.1.0", workspaceId: scope.workspace_id });
  let result = JSON.parse(guest.invoke(JSON.stringify({ schema_version: 1, request_id: "preview", plugin_id: "proprium.paired-writing", action_id: "paired.synonyms.preview", scope, snapshot, input, deadline_ms: 30000 })));
  const operations: string[] = [];
  while (result.kind === "host_call") {
    operations.push(result.operation);
    const response = result.operation === "workspace.file.read" ? { ok: false, error: { code: "file_not_found", message: "absent", retryable: false } } : { ok: true, value: { found: false } };
    result = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: result.call_id, ...response })));
  }
  guest.dispose(); return { result, operations };
}
test("synonym preview produces the source prompt without invoking a provider", async () => {
  const { result, operations } = run({ original: "駅", sentence: "駅へ向かう。", reason: "重複" });
  assert.equal(result.ok, true);
  assert.equal(result.value.provider_invoked, false);
  assert.match(result.value.prompt, /対象語句: 駅\n文: 駅へ向かう。/u);
  assert.equal(result.value.model, "deepseek-ai/DeepSeek-V4-Pro");
  assert.equal(operations.includes("provider.request"), false);
  const { readFile } = await import("node:fs/promises");
  const schemaPath: string = "../../../app/src/browser/proprium/authoring/schema.js";
  const { assertValue } = await import(schemaPath);
  const manifest = JSON.parse(await readFile(new URL("../plugin.json", import.meta.url), "utf8"));
  assertValue(manifest.actions.find((action: { action_id: string }) => action.action_id === "paired.synonyms.preview").output_schema, result.value);
});
test("synonym preview rejects an original absent from the sentence", () => {
  const { result, operations } = run({ original: "海", sentence: "駅へ向かう。" });
  assert.equal(result.ok, false); assert.equal(result.error.code, "invalid_input"); assert.deepEqual(operations, []);
});
