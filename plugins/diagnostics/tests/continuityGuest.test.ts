import assert from "node:assert/strict";
import test from "node:test";
import { guest } from "../guest.js";
import { sha256 } from "../src/core.js";

const scope = { workspace_id: "workspace-continuity", repository_id: 5, branch: "main", generation: "generation-4" };
const snapshot = { id: "snapshot-continuity", local_commit: "commit-4", worktree_generation: "tree-4", draft_generation: null };
function request(action_id: string, input: Record<string, unknown>) {
  return { schema_version: 1, request_id: `request-${action_id}`, plugin_id: "proprium.diagnostics", action_id, scope, snapshot, input, deadline_ms: 30_000 };
}
function continueWith(call: Record<string, unknown>, value: unknown): Record<string, unknown> {
  return JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: call.call_id, ok: true, value })));
}

test("continuity reads only pinned declared files and returns prior/current source evidence", () => {
  guest.initialize({ pluginId: "proprium.diagnostics", version: "0.1.0", workspaceId: scope.workspace_id });
  const files = new Map([
    ["plot/volumes/v/volume.yaml", "id: vol-1\norder: 1\n"],
    ["plot/volumes/v/chapters/c/chapter.yaml", "id: ch-1\nvolume: vol-1\norder: 1\n"],
    ["bible/characters/a.yaml", "id: char-a\ntype: character\n"],
    ["bible/characters/b.yaml", "id: char-b\ntype: character\n"],
    ["bible/items/item.yaml", "id: item-1\ntype: item\n"],
    ["bible/locations/a.yaml", "id: loc-a\ntype: location\ntravel: {daysTo: {loc-b: 3}}\n"],
    ["bible/locations/b.yaml", "id: loc-b\ntype: location\n"],
    ["plot/volumes/v/chapters/c/scenes/a.yaml", "id: sc-a\nchapter: ch-1\norder: 1\nlocation: loc-a\nmanuscript: manuscript/a.md\nappears: [char-a]\neffects: [{action: acquire_item, characterId: char-a, itemId: item-1}]\n"],
    ["plot/volumes/v/chapters/c/scenes/b.yaml", "id: sc-b\nchapter: ch-1\norder: 2\nlocation: loc-b\nmanuscript: manuscript/b.md\nappears: [char-a, char-b]\neffects: [{action: use_item, characterId: char-b, itemId: item-1}]\n"],
    ["manuscript/a.md", "朝、場面が始まる。\n"],
    ["manuscript/b.md", "昨日、次の場所へ移った。\n"],
  ]);
  const revisions = new Map([...files.keys()].map((path) => [path, sha256(files.get(path)!)]));
  const entries = [...files.keys()].map((path) => ({ path, revision: revisions.get(path)!, byte_length: new TextEncoder().encode(files.get(path)!).length, media_type: path.endsWith(".md") ? "text/markdown" : "text/yaml" }));
  let result = JSON.parse(guest.invoke(JSON.stringify(request("proprium.diagnostics.project.continuity.run.v1", {}))));
  const operations: string[] = [];
  while (result.kind === "host_call") {
    operations.push(String(result.operation));
    const payload = result.payload as Record<string, unknown>;
    let value: unknown;
    if (result.operation === "workspace.file.list") value = { entries, next_cursor: null };
    else if (result.operation === "workspace.file.read") {
      const path = String(payload.path);
      const content = files.get(path);
      assert.ok(content, `unexpected file read: ${path}`);
      assert.equal((payload.snapshot as typeof snapshot).id, snapshot.id);
      const bytes = [...new TextEncoder().encode(content)];
      const offset = Number(payload.offset);
      const chunk = bytes.slice(offset, offset + Number(payload.length));
      value = { revision: revisions.get(path), total_bytes: bytes.length, offset, bytes: chunk, next_offset: offset + chunk.length === bytes.length ? null : offset + chunk.length };
    } else assert.fail(`unexpected Host operation: ${String(result.operation)}`);
    result = continueWith(result, value);
  }
  assert.equal(result.ok, true);
  assert.equal(result.value.recognized, true);
  assert.ok(result.value.findings.some((finding: { kind: string }) => finding.kind === "non-adjacent-location"));
  assert.ok(result.value.findings.some((finding: { kind: string }) => finding.kind === "item-owner-mismatch"));
  assert.ok(result.value.findings.some((finding: { kind: string }) => finding.kind === "timeline-reversal"));
  const ownerMismatch = result.value.findings.find((finding: { kind: string }) => finding.kind === "item-owner-mismatch");
  assert.deepEqual(ownerMismatch.evidence.map((source: { path: string; revision: string }) => source.path).sort(), [
    "plot/volumes/v/chapters/c/scenes/a.yaml", "plot/volumes/v/chapters/c/scenes/b.yaml",
  ]);
  assert.ok(ownerMismatch.evidence.every((source: { revision: string }) => /^[a-f0-9]{64}$/u.test(source.revision)));
  assert.ok(operations.every((operation) => ["workspace.file.list", "workspace.file.read"].includes(operation)));
  guest.dispose();
});
