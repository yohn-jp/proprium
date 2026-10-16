import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { MAX_JOB_INPUT_BYTES, MAX_JOB_OUTPUT_BYTES, type JobRequest, type ModuleId, type SnapshotId } from "@scriptorium/contracts";
import { WorkerSupervisor, type WorkerJobLifecycleSnapshot } from "./index.js";

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

async function waitForLifecycle(
  events: readonly WorkerJobLifecycleSnapshot[],
  jobId: string,
  state: WorkerJobLifecycleSnapshot["state"],
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (events.some((event) => event.jobId === jobId && event.state === state)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`job ${jobId} did not reach lifecycle state ${state}`);
}

async function within<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds} ms`)), milliseconds); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

test("one-shot lifecycle subscription awaits ordered metadata and omits request and result payloads", async () => {
  const supervisor = new WorkerSupervisor();
  const events: WorkerJobLifecycleSnapshot[] = [];
  let releaseQueued!: () => void;
  let markQueuedSeen!: () => void;
  const queuedGate = new Promise<void>((resolve) => { releaseQueued = resolve; });
  const queuedSeen = new Promise<void>((resolve) => { markQueuedSeen = resolve; });
  const job = request("echo", { privateText: "never store this input" }, { id: "lifecycle-one-shot" });
  const unsubscribe = supervisor.subscribeJobLifecycle(async (event) => {
    events.push(event);
    if (event.jobId === job.id && event.state === "queued") {
      markQueuedSeen();
      await queuedGate;
    }
  });
  try {
    const running = supervisor.run(job, workerEntry);
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        queuedSeen,
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("queued lifecycle event was not delivered")), 1000); }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    assert.equal(supervisor.activeWorkerPids.length, 0, "the child must not receive work before queued metadata is persisted");
    releaseQueued();
    const outcome = await running;
    assert.equal(outcome.ok, true);
    const jobEvents = events.filter((event) => event.jobId === job.id);
    assert.deepEqual(jobEvents.map((event) => event.state), ["queued", "running", "succeeded"]);
    assert.equal(jobEvents[0]?.module, "story");
    assert.equal(jobEvents[0]?.task, "echo");
    assert.deepEqual(jobEvents[0]?.snapshot, snapshot);
    assert.ok(jobEvents[0]?.createdAt && jobEvents[0]?.updatedAt);
    assert.equal(jobEvents[0]?.startedAt, null);
    assert.ok(jobEvents[1]?.startedAt);
    assert.ok(jobEvents[2]?.finishedAt);
    for (const event of jobEvents) {
      assert.ok(Object.keys(event).every((key) => ["jobId", "module", "task", "snapshot", "state", "createdAt", "updatedAt", "startedAt", "finishedAt", "errorCode"].includes(key)));
      assert.equal("input" in event, false);
      assert.equal("output" in event, false);
      assert.equal("error" in event, false);
    }
    const failedRequest = request("echo", {}, { id: "lifecycle-one-shot-failed" });
    const failed = await supervisor.run(failedRequest, fileURLToPath(new URL("./fixtures/worker-missing.mjs", import.meta.url)));
    assert.equal(failed.ok, false);
    const failedEvents = events.filter((event) => event.jobId === failedRequest.id);
    assert.deepEqual(failedEvents.map((event) => event.state), ["queued", "failed"]);
    assert.equal(failedEvents.at(-1)?.errorCode, "worker_entry_missing");
    assert.equal("error" in (failedEvents.at(-1) ?? {}), false);
  } finally {
    releaseQueued();
    unsubscribe();
    await supervisor.shutdown();
  }
});

test("persistent worker requests publish successful and AbortSignal-cancelled lifecycle metadata", async () => {
  const supervisor = new WorkerSupervisor({ cancellationGraceMs: 50 });
  const events: WorkerJobLifecycleSnapshot[] = [];
  const unsubscribe = supervisor.subscribeJobLifecycle((event) => { events.push(event); });
  const service = await supervisor.createService("story", "0.1.0", workerServiceEntry);
  try {
    const successRequest = request("echo", { privateText: "service input" }, { id: "lifecycle-service-success" });
    const success = await service.request(successRequest, new AbortController().signal);
    assert.equal(success.ok, true);
    assert.deepEqual(events.filter((event) => event.jobId === successRequest.id).map((event) => event.state), ["queued", "running", "succeeded"]);

    const cancelRequest = request("hold", { privateText: "service input" }, { id: "lifecycle-service-cancel", deadline: Date.now() + 4000 });
    const controller = new AbortController();
    const cancelled = service.request(cancelRequest, controller.signal);
    await waitForLifecycle(events, cancelRequest.id, "running");
    controller.abort();
    const cancelOutcome = await cancelled;
    assert.equal(cancelOutcome.ok, false);
    if (!cancelOutcome.ok) assert.equal(cancelOutcome.error.code, "job_cancelled");
    const cancelEvents = events.filter((event) => event.jobId === cancelRequest.id);
    assert.deepEqual(cancelEvents.map((event) => event.state), ["queued", "running", "cancelled"]);
    assert.equal(cancelEvents.at(-1)?.errorCode, "job_cancelled");
    assert.equal("input" in (cancelEvents.at(-1) ?? {}), false);
    assert.equal("output" in (cancelEvents.at(-1) ?? {}), false);
    assert.equal("error" in (cancelEvents.at(-1) ?? {}), false);
  } finally {
    unsubscribe();
    await service.dispose();
    await supervisor.shutdown();
  }
});

test("a non-cooperative queued listener cannot hold a short job deadline or shutdown", async () => {
  const supervisor = new WorkerSupervisor({ jobLifecycleListenerTimeoutMs: 250 });
  const never = new Promise<void>(() => {});
  const states: WorkerJobLifecycleSnapshot["state"][] = [];
  let markQueued!: () => void;
  const queued = new Promise<void>((resolve) => { markQueued = resolve; });
  const job = request("hold", {}, { id: "lifecycle-never-queued", deadline: Date.now() + 200 });
  const unsubscribe = supervisor.subscribeJobLifecycle(async (event) => {
    if (event.jobId !== job.id) return;
    states.push(event.state);
    if (event.state === "queued") markQueued();
    await never;
  });
  try {
    const running = supervisor.run(job, workerEntry);
    await within(queued, 500, "queued lifecycle callback");
    await new Promise((resolve) => setTimeout(resolve, 240));
    await within(supervisor.shutdown(), 500, "supervisor shutdown");
    const outcome = await within(running, 1_000, "one-shot job promise");
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.error.code, "job_deadline_exceeded");
    assert.deepEqual(states, ["queued", "failed"]);
    assert.equal(supervisor.activeJobCount, 0);
  } finally {
    unsubscribe();
    await within(supervisor.shutdown(), 500, "supervisor cleanup");
  }
});

test("a non-cooperative running listener cannot hold a real one-shot child result", async () => {
  const supervisor = new WorkerSupervisor({ jobLifecycleListenerTimeoutMs: 25 });
  const never = new Promise<void>(() => {});
  const job = request("echo", { privateText: "omitted" }, { id: "lifecycle-never-running" });
  let markRunning!: () => void;
  const runningState = new Promise<void>((resolve) => { markRunning = resolve; });
  const unsubscribe = supervisor.subscribeJobLifecycle(async (event) => {
    if (event.jobId === job.id && event.state === "running") {
      markRunning();
      await never;
    }
  });
  try {
    const running = supervisor.run(job, workerEntry);
    await within(runningState, 1_000, "running lifecycle callback");
    const outcome = await within(running, 500, "one-shot child result");
    assert.equal(outcome.ok, true);
    if (outcome.ok) assert.deepEqual(outcome.result.output.echo, { privateText: "omitted" });
    assert.equal(supervisor.activeJobCount, 0);
  } finally {
    unsubscribe();
    await within(supervisor.shutdown(), 500, "supervisor cleanup");
  }
});

test("a non-cooperative service listener cannot hold AbortSignal cancellation or service shutdown", async () => {
  const supervisor = new WorkerSupervisor({ jobLifecycleListenerTimeoutMs: 25, cancellationGraceMs: 50 });
  const never = new Promise<void>(() => {});
  const service = await supervisor.createService("story", "0.1.0", workerServiceEntry);
  const controller = new AbortController();
  const job = request("hold", {}, { id: "lifecycle-service-never-running", deadline: Date.now() + 5_000 });
  let markRunning!: () => void;
  const runningState = new Promise<void>((resolve) => { markRunning = resolve; });
  const unsubscribe = supervisor.subscribeJobLifecycle(async (event) => {
    if (event.jobId === job.id && event.state === "running") {
      markRunning();
      await never;
    }
  });
  try {
    const requestPromise = service.request(job, controller.signal);
    await within(runningState, 1_000, "service running lifecycle callback");
    controller.abort();
    const outcome = await within(requestPromise, 500, "persistent worker cancellation");
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.error.code, "job_cancelled");
    assert.equal(service.activeJobCount, 0);
    await within(supervisor.shutdown(), 1_000, "service shutdown");
  } finally {
    unsubscribe();
    await within(supervisor.shutdown(), 1_000, "supervisor cleanup");
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
