import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { MAX_JOB_INPUT_BYTES, MAX_JOB_OUTPUT_BYTES, type JobRequest, type ModuleId, type SnapshotId } from "@scriptorium/contracts";
import { WorkerSupervisor } from "./index.js";

const workerEntry = fileURLToPath(new URL("./fixtures/worker.mjs", import.meta.url));
const workerServiceEntry = fileURLToPath(new URL("./fixtures/worker-service.mjs", import.meta.url));
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

test("shared worker service cancels one job and releases its persistent child on dispose", async () => {
  const supervisor = new WorkerSupervisor({ cancellationGraceMs: 100 });
  const service = await supervisor.createService("story", "0.1.0", workerServiceEntry);
  const holdRequest = request("hold", {}, { deadline: Date.now() + 4000 });
  const running = service.request<{ pid: number }>(holdRequest);
  const pid = await waitForPid(supervisor);
  await waitForJob(supervisor);
  assert.equal(service.cancel(holdRequest.id), true);
  const outcome = await running;
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.error.code, "job_cancelled");
  assert.doesNotThrow(() => process.kill(pid, 0));
  await service.dispose();
  assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
  await supervisor.shutdown();
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
