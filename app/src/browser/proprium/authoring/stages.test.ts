import assert from "node:assert/strict";
import { test } from "node:test";
import { ChangeStageError, ChangeStageStore, type ChangeStageBasePort, type ChangeStageContext } from "./stages.js";
import type { WriterScope, WriterSnapshot, WriterUnit } from "./writer.js";

const scope: WriterScope = { workspace_id: "workspace-1", repository_id: null, branch: "main", generation: "host-generation-1" };
const snapshot: WriterSnapshot = { id: "snapshot-1", local_commit: null, worktree_generation: "a".repeat(64), draft_generation: null };
const context: ChangeStageContext = { scope, caller_chain: ["ui", "proprium.paired-writing"], invocation_id: "invocation-1" };

function bytes(text: string): Uint8Array { return new TextEncoder().encode(text); }
async function hash(value: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return Array.from(digest, item => item.toString(16).padStart(2, "0")).join("");
}
function unit(id: string, path: string, expected_revision: string | null, content: Uint8Array | undefined): WriterUnit {
  return { id, label: id, depends_on: [], operations: [{ id: `operation-${id}`, kind: content ? expected_revision === null ? "create" : "replace" : "delete", path, expected_revision, ...(content ? { content } : {}) }] };
}
function expectCode(code: string) {
  return (error: unknown) => (error as { code?: string }).code === code;
}

class Base implements ChangeStageBasePort {
  readonly files = new Map<string, Uint8Array>();
  stale = false;
  async assert_snapshot(_scope: WriterScope, _snapshot: WriterSnapshot): Promise<void> {
    if (this.stale) throw new ChangeStageError("snapshot_stale", "base changed");
  }
  async assert_read_set(scope: WriterScope, snapshot: WriterSnapshot, readSet: readonly { path: string; revision: string | null }[]): Promise<void> {
    for (const item of readSet) if ((await this.read(scope, snapshot, item.path)).revision !== item.revision) throw new ChangeStageError("snapshot_stale", "read set changed");
  }
  async read(_scope: WriterScope, _snapshot: WriterSnapshot, path: string) {
    const value = this.files.get(path) ?? null;
    return { bytes: value?.slice() ?? null, revision: value ? await hash(value) : null };
  }
  async stat(scope: WriterScope, snapshot: WriterSnapshot, path: string) {
    const value = await this.read(scope, snapshot, path);
    return value.bytes ? { path, revision: value.revision!, byte_length: value.bytes.byteLength, media_type: "text/plain" } : null;
  }
  async list(scope: WriterScope, snapshot: WriterSnapshot, prefix: string, cursor: string | null, limit: number) {
    const all = await Promise.all([...this.files.keys()].filter(path => path.startsWith(prefix)).sort().map(async path => {
      const item = await this.stat(scope, snapshot, path);
      return item!;
    }));
    const start = cursor ? all.findIndex(item => item.path === cursor) + 1 : 0;
    const items = all.slice(start, start + limit);
    return { items, next_cursor: all.length > start + items.length ? items.at(-1)!.path : null };
  }
}

test("compiler stages overlay exact bytes while preserving original path revisions", async () => {
  const base = new Base();
  base.files.set("plot/scenes/scene.yaml", bytes("title: original\r\n"));
  const originalRevision = await hash(base.files.get("plot/scenes/scene.yaml")!);
  let nextId = 0;
  const store = new ChangeStageStore(base, 1024, () => 1000, () => `stage-token-${String(++nextId).padStart(10, "0")}`);
  const first = await store.stage(context, { base_snapshot: snapshot, units: [unit("first", "plot/scenes/scene.yaml", originalRevision, bytes("title: staged\r\n"))] });
  const view = await store.read(first.staging_snapshot, context, snapshot, "plot/scenes/scene.yaml");
  assert.equal(new TextDecoder().decode(view.bytes!), "title: staged\r\n");
  assert.equal(view.revision, await hash(bytes("title: staged\r\n")));
  assert.equal(view.original_revision, originalRevision);
  assert.equal(view.source, "stage");

  const second = await store.stage(context, {
    base_snapshot: snapshot,
    previous_stage: first.staging_snapshot,
    units: [unit("second", "plot/chapters/chapter.yaml", null, bytes("id: chapter-1\n"))],
  });
  const priorOverlay = await store.read(second.staging_snapshot, context, snapshot, "plot/scenes/scene.yaml");
  const created = await store.read(second.staging_snapshot, context, snapshot, "plot/chapters/chapter.yaml");
  assert.equal(new TextDecoder().decode(priorOverlay.bytes!), "title: staged\r\n");
  assert.equal(created.original_revision, null);
  assert.equal(new TextDecoder().decode(created.bytes!), "id: chapter-1\n");
  const overlay = store.readOverlay(scope, snapshot, second.staging_snapshot, context.caller_chain, context.invocation_id);
  const page = await overlay.reader.list({ prefix: "plot/", limit: 10 });
  assert.deepEqual(page.items.map(item => item.path), ["plot/chapters/chapter.yaml", "plot/scenes/scene.yaml"]);
  const stagedFile = await overlay.reader.stat("plot/chapters/chapter.yaml");
  assert.equal(stagedFile?.source, "stage");
  const chunk = await overlay.reader.read("plot/scenes/scene.yaml", { offset: 7, length: 6 });
  assert.equal(new TextDecoder().decode(chunk.bytes!), "staged");
  assert.equal(chunk.total_bytes, 15);
  assert.equal(base.files.size, 1, "staging never mutates base workspace bytes");
});

test("compiler stage leases reject caller, scope, snapshot, stale base, and reload mismatches", async () => {
  const base = new Base();
  base.files.set("meta/terms.json", bytes("{}"));
  const revision = await hash(base.files.get("meta/terms.json")!);
  const store = new ChangeStageStore(base, 1024, () => 1000, () => "stage-token-0000000002");
  const stage = await store.stage(context, { base_snapshot: snapshot, units: [unit("terms", "meta/terms.json", revision, bytes("{\"terms\":[]}"))] });

  assert.throws(() => store.assertStage(stage.staging_snapshot, scope, snapshot, ["ui", "proprium.other"], context.invocation_id), expectCode("snapshot_stale"));
  assert.throws(() => store.assertStage(stage.staging_snapshot, { ...scope, workspace_id: "another-workspace" }, snapshot, context.caller_chain, context.invocation_id), expectCode("snapshot_stale"));
  assert.throws(() => store.assertStage(stage.staging_snapshot, scope, { ...snapshot, id: "another-snapshot" }, context.caller_chain, context.invocation_id), expectCode("snapshot_stale"));
  base.stale = true;
  await assert.rejects(store.stage(context, { base_snapshot: snapshot, previous_stage: stage.staging_snapshot, units: [unit("more", "meta/terms.json", revision, bytes("more"))] }), expectCode("snapshot_stale"));

  const reloaded = new ChangeStageStore(base);
  assert.throws(() => reloaded.assertStage(stage.staging_snapshot, scope, snapshot, context.caller_chain, context.invocation_id), expectCode("snapshot_stale"));
});

test("compiler staging enforces byte quota and releases every lease on cancellation", async () => {
  const base = new Base();
  const store = new ChangeStageStore(base, 8, () => 1000, () => crypto.randomUUID());
  await assert.rejects(store.stage(context, { base_snapshot: snapshot, units: [unit("large", "large.txt", null, bytes("123456789"))] }), expectCode("capacity"));
  const one = await store.stage(context, { base_snapshot: snapshot, units: [unit("one", "one.txt", null, bytes("1234"))] });
  const two = await store.stage(context, { base_snapshot: snapshot, previous_stage: one.staging_snapshot, units: [unit("two", "two.txt", null, bytes("5678"))] });
  assert.equal(store.bytes_in_use, 8);
  assert.equal(store.releaseInvocation(context), 1);
  assert.equal(store.bytes_in_use, 0);
  assert.throws(() => store.assertStage(two.staging_snapshot, scope, snapshot, context.caller_chain, context.invocation_id), expectCode("snapshot_stale"));
});
