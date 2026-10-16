import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { MAX_JOB_INPUT_BYTES, MAX_JOB_OUTPUT_BYTES, type JobRequest, type ModuleId, type SnapshotId } from "@scriptorium/contracts";
import { WorkerSupervisor } from "./index.js";

const workerEntry = fileURLToPath(new URL("./fixtures/worker.mjs", import.meta.url));
const workerServiceEntry = fileURLToPath(new URL("./fixtures/worker-service.mjs", import.meta.url));
const unreadyWorkerServiceEntry = fileURLToPath(new URL("./fixtures/worker-service-unready.mjs", import.meta.url));
const missingNodeExecutable = fileURLToPath(new URL("./fixtures/node-executable-missing", import.meta.url));
const snapshot: SnapshotId = {
  repository: { provider: "github", repositoryId: "repo-1", defaultBranch: "main", ownerScope: "owner", url: "https://github.com/owner/repo" },
  remoteCommit: "b".repeat(40),
};

function request(task = "echo", input: unknown = { value: "hello" }, options: Partial<JobRequest> = {}): JobRequest {
  return {
    id: `job-${Math.random().toString(16).slice(2)}`,
    module: "story" as ModuleId,
    task,
    snapshot,
    model: "test-model",
    modelVersion: "1.0.0",
    moduleVersion: "0.1.0",
    deadline: Date.now() + 5_000,
    input,
    ...options,
  };
}

async function waitForPid(supervisor: WorkerSupervisor): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const pid = supervisor.activeWorkerPids[0];
    if (pid) return pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("worker process did not start");
}

async function waitForJob(supervisor: WorkerSupervisor): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (supervisor.activeJobCount > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("worker service job did not start");
}

function assertGone(pid: number): void {
  assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
}

test("child job uses isolated IPC, strips injected credentials, and exits after a matching result", async () => {
  const supervisor = new WorkerSupervisor();
  const prior = {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    UNDECLARED_SECRET: process.env.UNDECLARED_SECRET,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
  };
  process.env.GITHUB_TOKEN = "worker-secret-test";
  process.env.OPENAI_API_KEY = "provider-secret-test";
  process.env.UNDECLARED_SECRET = "unknown-secret-test";
  process.env.NODE_OPTIONS = "--require=/no/such/preload.js";
  try {
    const outcome = await supervisor.run<{ echo: unknown; pid: number; cwd: string; credentials: Record<string, string | null> }>(request(), workerEntry);
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.deepEqual(outcome.result.output.echo, { value: "hello" });
      assert.deepEqual(outcome.result.snapshot, snapshot);
      assert.equal(outcome.result.modelVersion, "1.0.0");
      assert.equal(outcome.result.moduleVersion, "0.1.0");
      assert.equal(outcome.result.output.credentials.github, null);
      assert.equal(outcome.result.output.credentials.openai, null);
      assert.equal(outcome.result.output.credentials.injected, null);
      assert.equal(outcome.result.output.credentials.home, null);
      assert.equal(outcome.result.output.credentials.nodeOptions, null);
      assertGone(outcome.result.output.pid);
    }
    assert.equal(supervisor.activeJobCount, 0);
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await supervisor.shutdown();
  }
});

test("cancel and deadline terminate the actual child process", async () => {
  const supervisor = new WorkerSupervisor({ maxJobDurationMs: 5000, cancellationGraceMs: 50 });
  const cancellationRequest = request("hold", {}, { deadline: Date.now() + 4000 });
  const running = supervisor.run(cancellationRequest, workerEntry);
  const pid = await waitForPid(supervisor);
  assert.equal(await supervisor.cancel(cancellationRequest.id), true);
  const result = await running;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "job_cancelled");
  assertGone(pid);
  assert.equal(await supervisor.cancel("missing"), false);

  const deadlineRequest = request("hold", {}, { deadline: Date.now() + 300 });
  const deadlinePromise = supervisor.run(deadlineRequest, workerEntry);
  const deadlinePid = await waitForPid(supervisor);
  const deadline = await deadlinePromise;
  assert.equal(deadline.ok, false);
  if (!deadline.ok) assert.equal(deadline.error.code, "job_deadline_exceeded");
  assertGone(deadlinePid);

  await supervisor.shutdown();
});

test("one-shot admission bounds child processes and queued requests, then drains on cancellation and disable", async () => {
  const supervisor = new WorkerSupervisor({ maxConcurrentJobs: 1, maxQueuedJobs: 1, cancellationGraceMs: 50 });
  const activeRequest = request("hold", {}, { deadline: Date.now() + 4000 });
  const active = supervisor.run(activeRequest, workerEntry);
  const pid = await waitForPid(supervisor);

  const queuedRequest = request("hold", {}, { deadline: Date.now() + 4000 });
  const queuedController = new AbortController();
  const queued = supervisor.run(queuedRequest, workerEntry, queuedController.signal);
  const overloaded = await supervisor.run(request(), workerEntry);
  assert.equal(overloaded.ok, false);
  if (!overloaded.ok) {
    assert.equal(overloaded.error.code, "worker_overloaded");
    assert.equal(overloaded.error.retryable, true);
  }
  assert.equal(supervisor.activeWorkerPids.length, 1);
  queuedController.abort();
  const queuedResult = await queued;
  assert.equal(queuedResult.ok, false);
  if (!queuedResult.ok) assert.equal(queuedResult.error.code, "job_cancelled");
  assert.equal(supervisor.activeWorkerPids.length, 1);

  await supervisor.cancelModule("story");
  const activeResult = await active;
  assert.equal(activeResult.ok, false);
  if (!activeResult.ok) assert.equal(activeResult.error.code, "job_cancelled");
  assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
  assert.equal(supervisor.activeJobCount, 0);
  await supervisor.shutdown();
});

test("persistent service and per-service job admission are bounded and require consumer cancellation", async () => {
  assert.throws(() => new WorkerSupervisor({ maxConcurrentJobs: Number.POSITIVE_INFINITY }), RangeError);
  const supervisor = new WorkerSupervisor({
    maxWorkerServices: 1,
    maxConcurrentServiceJobs: 1,
    maxQueuedServiceJobs: 1,
    cancellationGraceMs: 100,
  });
  const service = await supervisor.createService("story", "0.1.0", workerServiceEntry);
  await assert.rejects(
    supervisor.createService("nlp", "0.1.0", workerServiceEntry),
    (error: unknown) => (error as { code?: string }).code === "worker_overloaded",
  );
  const noSignal = await service.request(request());
  assert.equal(noSignal.ok, false);
  if (!noSignal.ok) assert.equal(noSignal.error.code, "job_cancellation_required");

  const activeRequest = request("hold", {}, { deadline: Date.now() + 4000 });
  const activeController = new AbortController();
  const running = service.request<{ pid: number }>(activeRequest, activeController.signal);
  const pid = await waitForPid(supervisor);
  await waitForJob(supervisor);

  const queuedRequest = request("hold", {}, { deadline: Date.now() + 4000 });
  const queuedController = new AbortController();
  const queued = service.request(queuedRequest, queuedController.signal);
  const overloaded = await service.request(request(), new AbortController().signal);
  assert.equal(overloaded.ok, false);
  if (!overloaded.ok) assert.equal(overloaded.error.code, "worker_overloaded");
  assert.equal(supervisor.activeWorkerPids.length, 1);

  queuedController.abort();
  const queuedResult = await queued;
  assert.equal(queuedResult.ok, false);
  if (!queuedResult.ok) assert.equal(queuedResult.error.code, "job_cancelled");
  activeController.abort();
  const outcome = await running;
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.error.code, "job_cancelled");
  assert.doesNotThrow(() => process.kill(pid, 0));

  const disableActiveRequest = request("hold", {}, { deadline: Date.now() + 4000 });
  const disableActive = service.request(disableActiveRequest, new AbortController().signal);
  await waitForJob(supervisor);
  const disableQueuedRequest = request();
  const disableQueued = service.request(disableQueuedRequest, new AbortController().signal);
  await service.dispose();
  for (const result of await Promise.all([disableActive, disableQueued])) {
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "job_cancelled");
  }
  assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
  await supervisor.shutdown();
});

test("spawn errors close one-shot and persistent worker records and release their admission slots", async () => {
  const supervisor = new WorkerSupervisor({
    workerExecPath: missingNodeExecutable,
    maxConcurrentJobs: 1,
    maxQueuedJobs: 0,
    maxWorkerServices: 1,
  });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outcome = await supervisor.run(request(), workerEntry);
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.equal(outcome.error.code, "worker_start_failed");
      assert.equal(supervisor.activeJobCount, 0);
      assert.deepEqual(supervisor.activeWorkerPids, []);
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(
        supervisor.createService("nlp", "0.1.0", workerServiceEntry),
        (error: unknown) => (error as { code?: string }).code === "worker_start_failed",
      );
      assert.deepEqual(supervisor.activeWorkerPids, []);
    }
  } finally {
    await supervisor.shutdown();
  }
});

test("a timed-out unready service keeps its process slot until its resistant child exits", async () => {
  const supervisor = new WorkerSupervisor({ maxWorkerServices: 1, maxJobDurationMs: 100, cancellationGraceMs: 250 });
  let pid: number | undefined;
  let startupFailure: Promise<unknown> | undefined;
  try {
    startupFailure = supervisor.createService("nlp", "0.1.0", unreadyWorkerServiceEntry).then(
      () => undefined,
      (error: unknown) => error,
    );
    pid = await waitForPid(supervisor);
    await new Promise((resolve) => setTimeout(resolve, 125));
    assert.doesNotThrow(() => process.kill(pid!, 0), "the startup timeout should still be draining the SIGTERM-resistant process");

    const replacement = await supervisor.createService("story", "0.1.0", workerServiceEntry).then(
      (service) => ({ service }),
      (error: unknown) => ({ error }),
    );
    if ("service" in replacement) await replacement.service.dispose();
    assert.ok("error" in replacement, "a replacement service must be rejected while the old process remains alive");
    if ("error" in replacement) assert.equal((replacement.error as { code?: string }).code, "worker_overloaded");

    const error = await startupFailure;
    assert.equal((error as { code?: string } | undefined)?.code, "worker_service_start_timeout");
    assertGone(pid);
  } finally {
    if (startupFailure) await startupFailure;
    await supervisor.shutdown();
    if (pid !== undefined) {
      try { process.kill(pid, "SIGKILL"); } catch { /* The supervised child has already exited. */ }
    }
  }
});

test("worker IPC enforces the shared UTF-8 input and output byte limits and identity", async () => {
  const supervisor = new WorkerSupervisor();
  const oversizedInput = request("echo", { text: "x".repeat(MAX_JOB_INPUT_BYTES) });
  const inputResult = await supervisor.run(oversizedInput, workerEntry);
  assert.equal(inputResult.ok, false);
  if (!inputResult.ok) assert.equal(inputResult.error.code, "job_input_too_large");
  assert.equal(supervisor.activeJobCount, 0);

  const outputResult = await supervisor.run(request("large", { size: MAX_JOB_OUTPUT_BYTES }), workerEntry);
  assert.equal(outputResult.ok, false);
  if (!outputResult.ok) assert.equal(outputResult.error.code, "job_output_too_large");

  const mismatch = await supervisor.run(request("echo", {}, { modelVersion: "wrong" }), workerEntry);
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.error.code, "worker_identity_mismatch");
  await supervisor.shutdown();
});
