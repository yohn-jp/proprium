import assert from "node:assert/strict";
import test from "node:test";
import { AuthoringTaskRegistry, MemoryAuthoringTaskStore } from "./tasks.js";
import type { AuthoringTaskIdentity } from "./tasks.js";
import type { Scope, Snapshot } from "./types.js";

const scope: Scope = { workspace_id: "work", repository_id: 1, branch: "main", generation: "g1" };
const snapshot: Snapshot = { id: "snap", local_commit: "commit", worktree_generation: "tree", draft_generation: null };
const identity: AuthoringTaskIdentity = {
  plugin_id: "proprium.semantic", plugin_version: "1.0.0", manifest_digest: "a".repeat(64),
  config_digest: "b".repeat(64), idempotency_key: "job-key",
};

test("task progress is Host-bound to one start or permitted step and completes monotonically", async () => {
  const store = new MemoryAuthoringTaskStore();
  const tasks = new AuthoringTaskRegistry(store, () => 1000, "session-a");
  const controller = new AbortController();
  const begun = await tasks.begin("start", 1, scope, snapshot, "task", identity, controller);
  assert.equal(begun.disposition, "started");
  await tasks.setStartResult("start", 1, scope, {
    snapshot, taskId: "task", state: "running", phase: "model_loading", completed: 0, total: 4,
  });
  assert.deepEqual(await tasks.status(scope, snapshot), [{
    taskId: "task", state: "running", phase: "model_loading", completed: 0, total: 4, resumable: true,
  }]);
  const stepController = new AbortController();
  await tasks.authorizeStep(scope, 1, "task", 1, "step-request", "step-key", stepController);
  assert.equal(await tasks.consumeStepPermit("spoofed", 1, scope, "task", 1, "step-key"), false);
  assert.equal(await tasks.consumeStepPermit("step-request", 1, scope, "task", 2, "step-key"), false);
  assert.equal(await tasks.consumeStepPermit("step-request", 1, scope, "task", 1, "wrong-key"), false);
  assert.equal(await tasks.consumeStepPermit("step-request", 1, scope, "task", 1, "step-key"), true);
  assert.equal(await tasks.consumeStepPermit("step-request", 1, scope, "task", 1, "step-key"), false);
  await tasks.update("step-request", 1, scope, { taskId: "task", phase: "embedding", completed: 1, total: 4 });
  await assert.rejects(tasks.update("other-request", 1, scope, { taskId: "task", phase: "embedding", completed: 2, total: 4 }),
    error => (error as { code?: string }).code === "invalid_input");
  const completed = await tasks.setStepResult("step-request", 1, scope, {
    snapshot, taskId: "task", state: "complete", phase: "complete", completed: 4, total: 4,
  });
  assert.equal(completed.step_sequence, 1);
  assert.deepEqual(completed.progress, { taskId: "task", state: "complete", phase: "complete", completed: 4, total: 4, resumable: false });
  await tasks.finishStep("step-request");
  assert.deepEqual(await tasks.status(scope, snapshot), [completed.progress]);
});

test("reload preserves only scoped metadata and explicit resume reuses the same checkpoint identity", async () => {
  const store = new MemoryAuthoringTaskStore();
  let now = 1000;
  const first = new AuthoringTaskRegistry(store, () => now, "first-session");
  const begun = await first.begin("start", 1, scope, snapshot, "task", identity, new AbortController());
  await first.setStartResult("start", 1, scope, {
    snapshot, taskId: "task", state: "running", phase: "embedding", completed: 2, total: 5,
  });
  const permit = await first.authorizeStep(scope, 1, "task", 1, "running-step", "step-key", new AbortController());
  assert.equal(permit.sequence, 1);
  await first.dispose();
  now += 1;
  const reloaded = new AuthoringTaskRegistry(store, () => now, "second-session");
  const renewedLease = { ...snapshot, id: "reloaded-pin" };
  assert.deepEqual(await reloaded.status(scope, renewedLease, "1.0.0", "a".repeat(64)), [{
    taskId: "task", state: "paused", phase: "embedding", completed: 2, total: 5, resumable: true,
  }]);
  const resumed = await reloaded.begin("resume", 2, { ...scope, generation: "g2" }, renewedLease, "task",
    { ...identity, idempotency_key: "fresh-resume-key" }, new AbortController());
  assert.equal(resumed.disposition, "resumed");
  assert.equal(resumed.task.scope.generation, "g2");
  assert.equal(resumed.task.snapshot.id, "reloaded-pin");
  assert.equal(resumed.task.identity.idempotency_key, "job-key");
  assert.equal(resumed.task.progress.state, "running");
  assert.deepEqual(await reloaded.status({ ...scope, generation: "g2" }, snapshot, "1.0.0", "a".repeat(64)), [{
    taskId: "task", state: "running", phase: "embedding", completed: 2, total: 5, resumable: true,
  }]);
  assert.equal(begun.task.snapshot.id, "snap");
});

test("task ID cannot resume a different snapshot, plugin digest or repository", async () => {
  const changedSnapshots: Snapshot[] = [
    { ...snapshot, id: "new-snapshot", local_commit: "different-commit" },
    { ...snapshot, id: "new-snapshot", worktree_generation: "tree-2" },
    { ...snapshot, id: "new-snapshot", draft_generation: "draft-2" },
    { ...snapshot, id: "new-snapshot", remote_commit: "remote-2" },
  ];
  for (const [index, changed] of changedSnapshots.entries()) {
    const tasks = new AuthoringTaskRegistry(new MemoryAuthoringTaskStore(), () => 1000, `session-${index}`);
    await tasks.begin("start", 1, scope, snapshot, "task", identity, new AbortController());
    await tasks.setStartResult("start", 1, scope, {
      snapshot, taskId: "task", state: "running", phase: "source_scan", completed: 0, total: 0,
    });
    await tasks.dispose();
    await assert.rejects(tasks.begin("resume", 2, scope, changed, "task", identity, new AbortController()),
      error => (error as { code?: string }).code === "snapshot_stale");
  }
  const tasks = new AuthoringTaskRegistry(new MemoryAuthoringTaskStore(), () => 1000, "plugin-session");
  await tasks.begin("start", 1, scope, snapshot, "task", identity, new AbortController());
  await tasks.setStartResult("start", 1, scope, {
    snapshot, taskId: "task", state: "running", phase: "source_scan", completed: 0, total: 0,
  });
  await tasks.dispose();
  await assert.rejects(tasks.begin("resume", 2, scope, snapshot, "task", { ...identity, manifest_digest: "c".repeat(64) }, new AbortController()),
    error => (error as { code?: string }).code === "idempotency_conflict");
  assert.deepEqual(await tasks.status({ ...scope, repository_id: 2 }, snapshot), []);
});

test("cancel aborts only the active scoped task and preserves explicit resumability", async () => {
  const tasks = new AuthoringTaskRegistry(new MemoryAuthoringTaskStore(), () => 1000, "session");
  let aborted = 0;
  const controller = new AbortController();
  controller.signal.addEventListener("abort", () => aborted++);
  await tasks.begin("start", 1, scope, snapshot, "task", identity, controller);
  await tasks.setStartResult("start", 1, scope, {
    snapshot, taskId: "task", state: "running", phase: "embedding", completed: 0, total: 2,
  });
  const stepController = new AbortController();
  stepController.signal.addEventListener("abort", () => aborted++);
  await tasks.authorizeStep(scope, 1, "task", 1, "step", "step-key", stepController);
  assert.equal(await tasks.cancel({ ...scope, branch: "other" }, 1, "task"), false);
  assert.equal(await tasks.cancel(scope, 2, "task"), false);
  assert.equal(await tasks.cancel(scope, 1, "task"), true);
  assert.equal(aborted, 1);
  assert.deepEqual(await tasks.status(scope, snapshot), [{
    taskId: "task", state: "cancelled", phase: "embedding", completed: 0, total: 2, resumable: true,
  }]);
});

test("a cancelled job resumes its durable cursor after a completed bounded step", async () => {
  const store = new MemoryAuthoringTaskStore();
  const firstSession = new AuthoringTaskRegistry(store, () => 1000, "first-session");
  await firstSession.begin("start", 1, scope, snapshot, "task", identity, new AbortController());
  await firstSession.setStartResult("start", 1, scope, {
    snapshot, taskId: "task", state: "running", phase: "embedding", completed: 0, total: 3,
  });
  await firstSession.authorizeStep(scope, 1, "task", 1, "step-1", "step-key-1", new AbortController());
  assert.equal(await firstSession.consumeStepPermit("step-1", 1, scope, "task", 1, "step-key-1"), true);
  const partial = await firstSession.setStepResult("step-1", 1, scope, {
    snapshot, taskId: "task", state: "running", phase: "embedding", completed: 1, total: 3,
  });
  assert.equal(partial.step_sequence, 1);
  await firstSession.finishStep("step-1");
  assert.equal(await firstSession.cancel(scope, 1, "task"), true);

  const resumedHost = new AuthoringTaskRegistry(store, () => 2000, "second-session");
  assert.deepEqual(await resumedHost.status(scope, snapshot, "1.0.0", "a".repeat(64)), [{
    taskId: "task", state: "cancelled", phase: "embedding", completed: 1, total: 3, resumable: true,
  }]);
  const resumed = await resumedHost.begin("resume", 2, { ...scope, generation: "g2" }, snapshot, "task",
    { ...identity, idempotency_key: "fresh-resume-key" }, new AbortController());
  assert.equal(resumed.disposition, "resumed");
  await resumedHost.authorizeStep({ ...scope, generation: "g2" }, 2, "task", 2, "step-2", "step-key-2", new AbortController());
  assert.equal(await resumedHost.consumeStepPermit("step-2", 2, { ...scope, generation: "g2" }, "task", 2, "step-key-2"), true);
  const complete = await resumedHost.setStepResult("step-2", 2, { ...scope, generation: "g2" }, {
    snapshot, taskId: "task", state: "complete", phase: "complete", completed: 3, total: 3,
  });
  assert.equal(complete.step_sequence, 2);
  assert.deepEqual(complete.progress, { taskId: "task", state: "complete", phase: "complete", completed: 3, total: 3, resumable: false });
  await resumedHost.finishStep("step-2");
});

test("model transfer progress restarts from zero when a resumable worker is recreated", async () => {
  const store = new MemoryAuthoringTaskStore();
  const firstSession = new AuthoringTaskRegistry(store, () => 1000, "first-session");
  await firstSession.begin("start", 1, scope, snapshot, "warm", identity, new AbortController());
  await firstSession.setStartResult("start", 1, scope, {
    snapshot, taskId: "warm", state: "running", phase: "model_loading", completed: 2, total: 4,
  });
  await firstSession.dispose();
  const nextSession = new AuthoringTaskRegistry(store, () => 2000, "second-session");
  const resumed = await nextSession.begin("resume", 2, { ...scope, generation: "g2" }, { ...snapshot, id: "warm-reloaded-pin" }, "warm",
    { ...identity, idempotency_key: "fresh-warm-key" }, new AbortController());
  assert.equal(resumed.task.progress.phase, "model_loading");
  assert.equal(resumed.task.progress.completed, 0);
  assert.equal(resumed.task.progress.total, 4);
});

test("task notifications coalesce to the latest bounded progress and retain scope identity", async () => {
  const tasks = new AuthoringTaskRegistry(new MemoryAuthoringTaskStore(), () => 1000, "session");
  const events: Array<{ scope: Scope; snapshot: Snapshot; taskId: string; completed: number }> = [];
  const unsubscribe = tasks.subscribe(update => events.push({ scope: update.scope, snapshot: update.snapshot,
    taskId: update.task.taskId, completed: update.task.completed }));
  await tasks.begin("start", 1, scope, snapshot, "task", identity, new AbortController());
  await tasks.setStartResult("start", 1, scope, {
    snapshot, taskId: "task", state: "running", phase: "embedding", completed: 1, total: 3,
  });
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.deepEqual(events, [{ scope, snapshot, taskId: "task", completed: 1 }]);
  unsubscribe();
  await tasks.dispose();
});
