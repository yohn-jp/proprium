import assert from "node:assert/strict";
import test from "node:test";
import { findNextScene } from "./NarrativeNavigation.js";

test("next scene follows paged volumes and chapters with pinned tree revision", async () => {
  const inputs: Record<string, unknown>[] = [];
  const pages: Record<string, unknown> = {
    root: { items: [{ id: "v1", kind: "volume" }], next_cursor: "page2", tree_revision: "tree" },
    page2: { items: [{ id: "v2", kind: "volume" }], next_cursor: null, tree_revision: "tree" },
    v1: { items: [{ id: "c1", kind: "chapter" }], next_cursor: null, tree_revision: "tree" },
    c1: { items: [{ id: "s1", kind: "scene" }], next_cursor: null, tree_revision: "tree" },
    v2: { items: [{ id: "c2", kind: "chapter" }], next_cursor: null, tree_revision: "tree" },
    c2: { items: [{ id: "s2", kind: "scene" }], next_cursor: null, tree_revision: "tree" },
  };
  const read = async (_: string, input: Record<string, unknown>) => { inputs.push(input); return pages[(input.cursor ?? input.parent_id ?? "root") as string]; };
  assert.deepEqual(await findNextScene(read, "s1", new AbortController().signal), { sceneId: "s2", treeRevision: "tree" });
  assert.ok(inputs.slice(1).every(input => input.expected_tree_revision === "tree"));
  assert.equal(await findNextScene(read, "s2", new AbortController().signal), null);
});

test("traversal rejects revision changes, repeated cursors and cancellation", async () => {
  const ctrl = new AbortController();
  let calls = 0;
  await assert.rejects(findNextScene(async () => ({ items: [], next_cursor: "same", tree_revision: ++calls === 1 ? "a" : "b" }), "s", ctrl.signal), /検証/);
  await assert.rejects(findNextScene(async () => ({ items: [], next_cursor: "same", tree_revision: "a" }), "s", ctrl.signal), /循環/);
  ctrl.abort();
  await assert.rejects(findNextScene(async () => { throw new Error("must not read"); }, "s", ctrl.signal), { name: "AbortError" });
});
