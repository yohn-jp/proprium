import assert from "node:assert/strict";
import test from "node:test";
import { AuthoringTaskRegistry, MemoryAuthoringTaskStore, getAuthoringTaskProfileForAction } from "./tasks.js";
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
  assert.deepEqual(await tasks.status("proprium.semantic",scope, snapshot), [{
    taskId: "task", state: "running", phase: "model_loading", completed: 0, total: 4, resumable: true,
  }]);
  const stepController = new AbortController();
  await tasks.authorizeStep("proprium.semantic",scope, 1, "task", 1, "step-request", "step-key", stepController);
  assert.equal(await tasks.consumeStepPermit("proprium.research","spoofed", 1, scope, "task", 1, "step-key"), false);
  assert.equal(await tasks.consumeStepPermit("proprium.semantic","step-request", 1, scope, "task", 2, "step-key"), false);
  assert.equal(await tasks.consumeStepPermit("proprium.semantic","step-request", 1, scope, "task", 1, "wrong-key"), false);
  assert.equal(await tasks.consumeStepPermit("proprium.semantic","step-request", 1, scope, "task", 1, "step-key"), true);
  assert.equal(await tasks.consumeStepPermit("proprium.semantic","step-request", 1, scope, "task", 1, "step-key"), false);
  await tasks.update("step-request", 1, scope, { taskId: "task", phase: "embedding", completed: 1, total: 4 });
  await assert.rejects(tasks.update("other-request", 1, scope, { taskId: "task", phase: "embedding", completed: 2, total: 4 }),
    error => (error as { code?: string }).code === "invalid_input");
  const completed = await tasks.setStepResult("step-request", 1, scope, {
    snapshot, taskId: "task", state: "complete", phase: "complete", completed: 4, total: 4,
  });
  assert.equal(completed.step_sequence, 1);
  assert.deepEqual(completed.progress, { taskId: "task", state: "complete", phase: "complete", completed: 4, total: 4, resumable: false });
  await tasks.finishStep("step-request");
  assert.deepEqual(await tasks.status("proprium.semantic",scope, snapshot), [completed.progress]);
});

test("reload preserves only scoped metadata and explicit resume reuses the same checkpoint identity", async () => {
  const store = new MemoryAuthoringTaskStore();
  let now = 1000;
  const first = new AuthoringTaskRegistry(store, () => now, "first-session");
  const begun = await first.begin("start", 1, scope, snapshot, "task", identity, new AbortController());
  await first.setStartResult("start", 1, scope, {
    snapshot, taskId: "task", state: "running", phase: "embedding", completed: 2, total: 5,
  });
  const permit = await first.authorizeStep("proprium.semantic",scope, 1, "task", 1, "running-step", "step-key", new AbortController());
  assert.equal(permit.sequence, 1);
  await first.dispose();
  now += 1;
  const reloaded = new AuthoringTaskRegistry(store, () => now, "second-session");
  const renewedLease = { ...snapshot, id: "reloaded-pin" };
  assert.deepEqual(await reloaded.status("proprium.semantic",scope, renewedLease, "1.0.0", "a".repeat(64)), [{
    taskId: "task", state: "paused", phase: "embedding", completed: 2, total: 5, resumable: true,
  }]);
  const resumed = await reloaded.begin("resume", 2, { ...scope, generation: "g2" }, renewedLease, "task",
    { ...identity, idempotency_key: "fresh-resume-key" }, new AbortController());
  assert.equal(resumed.disposition, "resumed");
  assert.equal(resumed.task.scope.generation, "g2");
  assert.equal(resumed.task.snapshot.id, "reloaded-pin");
  assert.equal(resumed.task.identity.idempotency_key, "job-key");
  assert.equal(resumed.task.progress.state, "running");
  assert.deepEqual(await reloaded.status("proprium.semantic",{ ...scope, generation: "g2" }, snapshot, "1.0.0", "a".repeat(64)), [{
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
  assert.deepEqual(await tasks.status("proprium.semantic",{ ...scope, repository_id: 2 }, snapshot), []);
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
  await tasks.authorizeStep("proprium.semantic",scope, 1, "task", 1, "step", "step-key", stepController);
  assert.equal(await tasks.cancel("proprium.semantic",{ ...scope, branch: "other" }, 1, "task"), false);
  assert.equal(await tasks.cancel("proprium.semantic",scope, 2, "task"), false);
  assert.equal(await tasks.cancel("proprium.semantic",scope, 1, "task"), true);
  assert.equal(aborted, 1);
  assert.deepEqual(await tasks.status("proprium.semantic",scope, snapshot), [{
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
  await firstSession.authorizeStep("proprium.semantic",scope, 1, "task", 1, "step-1", "step-key-1", new AbortController());
  assert.equal(await firstSession.consumeStepPermit("proprium.semantic","step-1", 1, scope, "task", 1, "step-key-1"), true);
  const partial = await firstSession.setStepResult("step-1", 1, scope, {
    snapshot, taskId: "task", state: "running", phase: "embedding", completed: 1, total: 3,
  });
  assert.equal(partial.step_sequence, 1);
  await firstSession.finishStep("step-1");
  assert.equal(await firstSession.cancel("proprium.semantic",scope, 1, "task"), true);

  const resumedHost = new AuthoringTaskRegistry(store, () => 2000, "second-session");
  assert.deepEqual(await resumedHost.status("proprium.semantic",scope, snapshot, "1.0.0", "a".repeat(64)), [{
    taskId: "task", state: "cancelled", phase: "embedding", completed: 1, total: 3, resumable: true,
  }]);
  const resumed = await resumedHost.begin("resume", 2, { ...scope, generation: "g2" }, snapshot, "task",
    { ...identity, idempotency_key: "fresh-resume-key" }, new AbortController());
  assert.equal(resumed.disposition, "resumed");
  await resumedHost.authorizeStep("proprium.semantic",{ ...scope, generation: "g2" }, 2, "task", 2, "step-2", "step-key-2", new AbortController());
  assert.equal(await resumedHost.consumeStepPermit("proprium.semantic","step-2", 2, { ...scope, generation: "g2" }, "task", 2, "step-key-2"), true);
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
  const events: Array<{ pluginId: string; scope: Scope; snapshot: Snapshot; taskId: string; completed: number }> = [];
  const unsubscribe = tasks.subscribe(update => events.push({ pluginId: update.pluginId, scope: update.scope, snapshot: update.snapshot,
    taskId: update.task.taskId, completed: update.task.completed }));
  await tasks.begin("start", 1, scope, snapshot, "task", identity, new AbortController());
  await tasks.setStartResult("start", 1, scope, {
    snapshot, taskId: "task", state: "running", phase: "embedding", completed: 1, total: 3,
  });
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.deepEqual(events, [{ pluginId: "proprium.semantic", scope, snapshot, taskId: "task", completed: 1 }]);
  unsubscribe();
  await tasks.dispose();
});

test("Research uses its own narrow step profile and cannot consume Semantic permits", async () => {
  const tasks = new AuthoringTaskRegistry(new MemoryAuthoringTaskStore(), () => 1000, "research-session");
  const researchIdentity: AuthoringTaskIdentity = {
    plugin_id: "proprium.research", plugin_version: "1.0.0", manifest_digest: "c".repeat(64),
    config_digest: "d".repeat(64), idempotency_key: "research-job",
  };
  const begun = await tasks.begin("research-start", 1, scope, snapshot, "research-task", researchIdentity, new AbortController());
  assert.equal(begun.task.progress.phase, "source_scan");
  await tasks.setStartResult("research-start", 1, scope, {
    snapshot, taskId: "research-task", state: "running", phase: "source_scan", completed: 0, total: 2,
  });
  await tasks.authorizeStep("proprium.research", scope, 1, "research-task", 1, "research-step", "research-step-key", new AbortController());
  assert.equal(await tasks.consumeStepPermit("proprium.semantic", "research-step", 1, scope, "research-task", 1, "research-step-key"), false);
  assert.equal(await tasks.consumeStepPermit("proprium.research", "research-step", 1, scope, "research-task", 1, "research-step-key"), true);
  await tasks.update("research-step", 1, scope, {
    taskId: "research-task", phase: "source_scan", completed: 1, total: 0,
  });
  await assert.rejects(tasks.update("research-step", 1, scope, {
    taskId: "research-task", phase: "embedding", completed: 0, total: 2,
  }), error => (error as { code?: string }).code === "invalid_input");
  const complete = await tasks.setStepResult("research-step", 1, scope, {
    snapshot, taskId: "research-task", state: "complete", phase: "complete", completed: 2, total: 2,
  });
  await tasks.finishStep("research-step");
  assert.equal(complete.progress.state, "complete");
  assert.deepEqual(await tasks.status("proprium.research", scope, snapshot), [complete.progress]);
  assert.deepEqual(await tasks.status("proprium.semantic", scope, snapshot), []);
  await tasks.dispose();
});

test("Research restart retains the Worker cursor in one session and resets it after a Host reload", async () => {
  const store = new MemoryAuthoringTaskStore();
  const researchIdentity: AuthoringTaskIdentity = {
    plugin_id: "proprium.research", plugin_version: "1.0.0", manifest_digest: "c".repeat(64),
    config_digest: "d".repeat(64), idempotency_key: "research-job",
  };
  const sameSession = new AuthoringTaskRegistry(store, () => 1000, "research-session-a");
  await sameSession.begin("start", 1, scope, snapshot, "research-task", researchIdentity, new AbortController());
  await sameSession.setStartResult("start", 1, scope, {
    snapshot, taskId: "research-task", state: "running", phase: "source_scan", completed: 0, total: 2,
  });
  await sameSession.authorizeStep("proprium.research", scope, 1, "research-task", 1, "step-1", "step-key-1", new AbortController());
  assert.equal(await sameSession.consumeStepPermit("proprium.research", "step-1", 1, scope, "research-task", 1, "step-key-1"), true);
  await sameSession.setStepResult("step-1", 1, scope, {
    snapshot, taskId: "research-task", state: "running", phase: "index_build", completed: 1, total: 2,
  });
  await sameSession.finishStep("step-1");
  await sameSession.cancel("proprium.research", scope, 1, "research-task");

  const sameSessionRestart = await sameSession.begin("restart", 2, { ...scope, generation: "g2" }, snapshot, "research-task",
    { ...researchIdentity, idempotency_key: "research-retry" }, new AbortController());
  assert.equal(sameSessionRestart.task.step_sequence, 1);
  assert.equal(sameSessionRestart.task.progress.phase, "index_build");
  await sameSession.dispose();

  const reloaded = new AuthoringTaskRegistry(store, () => 2000, "research-session-b");
  const restartFromSource = await reloaded.begin("reload-restart", 3, { ...scope, generation: "g3" }, snapshot, "research-task",
    { ...researchIdentity, idempotency_key: "research-after-reload" }, new AbortController());
  assert.equal(restartFromSource.task.step_sequence, 0);
  assert.deepEqual(restartFromSource.task.progress, {
    taskId: "research-task", state: "running", phase: "source_scan", completed: 0, total: 1, resumable: true,
  });
});

test("BGE preparation has its own explicit action profile and cannot use E5 task permits", async () => {
  const profile = getAuthoringTaskProfileForAction("proprium.semantic", "proprium.semantic.reranker.prepare");
  assert.equal(profile?.profile_id, "semantic-reranker-v1");
  assert.equal(getAuthoringTaskProfileForAction("proprium.semantic", "proprium.semantic.reranker.prepare.step")?.profile_id, profile?.profile_id);
  assert.equal(getAuthoringTaskProfileForAction("proprium.semantic", "proprium.semantic.reranker.task.status")?.profile_id, profile?.profile_id);
  assert.equal(getAuthoringTaskProfileForAction("proprium.semantic", "proprium.semantic.reranker.task.cancel")?.profile_id, profile?.profile_id);
  assert.deepEqual([...profile!.phases], ["inspect_graph", "load_tensors", "load_tokenizer", "compile", "complete"]);
  assert.equal(profile!.restart_on_new_session, true);

  const tasks = new AuthoringTaskRegistry(new MemoryAuthoringTaskStore(), () => 1000, "reranker-session");
  const rerankerIdentity: AuthoringTaskIdentity = {
    ...identity, profile_id: profile!.profile_id, idempotency_key: "bge-prepare", config_digest: "e".repeat(64),
  };
  const begun = await tasks.begin("reranker-start", 1, scope, snapshot, "bge-task", rerankerIdentity, new AbortController());
  await tasks.setStartResult("reranker-start", 1, scope, {
    snapshot, taskId: "bge-task", state: "running", phase: "inspect_graph", completed: 0, total: 8668,
  });
  await assert.rejects(tasks.update("reranker-start", 1, scope, {
    taskId: "bge-task", phase: "model_loading", completed: 0, total: 8668,
  }), error => (error as { code?: string }).code === "invalid_input");
  const stepController = new AbortController();
  await tasks.authorizeStep("proprium.semantic", scope, 1, "bge-task", 1, "bge-step", "bge-step-key", stepController, profile!.profile_id);
  assert.equal(await tasks.consumeStepPermit("proprium.semantic", "bge-step", 1, scope, "bge-task", 1, "bge-step-key"), false);
  assert.equal(await tasks.consumeStepPermit("proprium.semantic", "bge-step", 1, scope, "bge-task", 1, "bge-step-key", profile!.profile_id), true);
  const partial = await tasks.setStepResult("bge-step", 1, scope, {
    snapshot, taskId: "bge-task", state: "running", phase: "load_tensors", completed: 64, total: 8668,
  });
  assert.equal(partial.progress.phase, "load_tensors");
  assert.deepEqual(await tasks.status("proprium.semantic", scope, snapshot, "1.0.0", "a".repeat(64), profile!.profile_id, "bge-task"), [partial.progress]);
  assert.deepEqual(await tasks.status("proprium.semantic", scope, snapshot, "1.0.0", "a".repeat(64)), []);
  await tasks.finishStep("bge-step");
  assert.equal(await tasks.cancel("proprium.semantic", scope, 1, "bge-task", profile!.profile_id), true);
  await tasks.dispose();
  assert.equal(begun.task.identity.profile_id, profile!.profile_id);
});
