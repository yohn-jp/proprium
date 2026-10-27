import assert from "node:assert/strict";
import test from "node:test";
import { AuthoringTaskRegistry } from "./tasks.js";
import type { Scope, Snapshot } from "./types.js";

const scope: Scope = { workspace_id: "work", repository_id: 1, branch: "main", generation: "g1" };
const snapshot: Snapshot = { id: "snap", local_commit: "commit", worktree_generation: "tree", draft_generation: null };

test("task cancellation is scoped to invocation epoch and workspace", () => {
  const tasks = new AuthoringTaskRegistry();
  let aborted = 0;
  tasks.begin("r1", 1, scope, snapshot, "task", () => { aborted++; });
  assert.equal(tasks.cancel({ ...scope, branch: "other" }, 1, "task"), false);
  assert.equal(tasks.cancel(scope, 2, "task"), false);
  assert.equal(aborted, 0);
  assert.equal(tasks.cancel(scope, 1, "task"), true);
  assert.equal(aborted, 1);
  tasks.finish("r1");
  tasks.begin("r2", 2, scope, snapshot, "next", () => { aborted++; });
  assert.equal(tasks.status(scope, { ...snapshot, worktree_generation: "changed" }, 2).length, 0);
  assert.equal(aborted, 2);
});

test("progress is throttled, phases reset counters, and completion is visible", () => {
  const tasks = new AuthoringTaskRegistry();
  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    tasks.begin("r", 1, scope, snapshot, "task", () => {});
    const update = (phase: string, completed: number, total: number) => tasks.update("r", 1, scope, { taskId: "task", phase, completed, total });
    update("embedding", 1, 10);
    now += 10;
    update("embedding", 2, 10);
    assert.equal(tasks.status(scope, snapshot, 1)[0].completed, 1);
    update("vector_scan", 0, 10);
    assert.deepEqual(tasks.status(scope, snapshot, 1)[0], { taskId: "task", phase: "vector_scan", completed: 0, total: 10 });
    update("vector_scan", 10, 10);
    assert.equal(tasks.status(scope, snapshot, 1)[0].completed, 10);
    assert.throws(() => update("vector_scan", 9, 10), { code: "invalid_input" });
  } finally { Date.now = originalNow; }
});

test("finishing an old request cannot remove its replacement", () => {
  const tasks = new AuthoringTaskRegistry();
  let aborted = 0;
  tasks.begin("old", 1, scope, snapshot, "old-task", () => { aborted++; });
  tasks.begin("new", 2, scope, snapshot, "new-task", () => {});
  assert.equal(aborted, 1);
  tasks.finish("old");
  assert.equal(tasks.status(scope, snapshot, 2)[0].taskId, "new-task");
  assert.throws(() => tasks.update("old", 1, scope, { taskId: "old-task", phase: "complete", completed: 1, total: 1 }), { code: "invalid_input" });
});
