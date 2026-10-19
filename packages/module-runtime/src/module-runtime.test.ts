import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { ActionDescriptor, ActionResult, ChangeOperation, ChangeProposal, JobRequest, ModuleAction, ModuleActionContext, ModuleDefinition, ModuleId, ModuleManifest, SnapshotId, ValueSchema, WorkerService } from "@scriptorium/contracts";
import { createStoryActions } from "../../../modules/story/src/actions.js";
import { ModuleRuntime, ModuleRuntimeError, resolveModulePlan, SharedCapabilityPool, type DomainJobProgressSink, type WorkerJobLifecycleSnapshot } from "./index.js";

const snapshot: SnapshotId = {
  repository: { provider: "github", repositoryId: "repo-1", defaultBranch: "main", ownerScope: "owner", url: "https://github.com/owner/repo" },
  remoteCommit: "a".repeat(40),
};
const schema: ValueSchema = { parse: (value) => value };
const workerEntry = fileURLToPath(new URL("./fixtures/worker.mjs", import.meta.url));

function manifest(id: ModuleId, options: Partial<ModuleManifest> = {}): ModuleManifest {
  return {
    id,
    version: "0.1.0",
    contractVersion: 1,
    dependencies: [],
    provides: [],
    requires: [],
    statePaths: [],
    locality: "local",
    ...options,
  };
}

function definition(
  metadata: ModuleManifest,
  action: ModuleAction,
  dispose: () => void | Promise<void> = () => {},
): ModuleDefinition {
  return { manifest: metadata, actions: [action], ui: [], dispose: async () => { await dispose(); } };
}

function readContext(signal = new AbortController().signal) {
  return {
    projectId: "project-1",
    reader: {
      snapshot,
      async read() { return null; },
      async list() { return []; },
    },
    signal,
    async propose(): Promise<ChangeProposal> { throw new Error("not used"); },
  };
}

function proposalOperation(): ChangeOperation {
  return {
    id: "operation-1",
    generation: 1,
    repository: snapshot.repository,
    baseRemoteCommit: snapshot.remoteCommit,
    effect: "metadata",
    reads: [],
    writes: [{ path: "meta/scriptorium/modules/story/settings.yaml", revision: null, content: "setting: true\n" }],
    message: "Update story setting",
  };
}

test("metadata resolution rejects unknown, absent, version, dependency, cycle, and capability failures without loading code", () => {
  const base = manifest("story");
  assert.throws(() => resolveModulePlan([base], ["made-up"]), (error: unknown) => error instanceof ModuleRuntimeError && error.code === "unknown_module_id");
  assert.throws(() => resolveModulePlan([], ["story"]), (error: unknown) => error instanceof ModuleRuntimeError && error.code === "redeployment_required");
  assert.throws(() => resolveModulePlan([{ ...base, contractVersion: 2 }], []), (error: unknown) => error instanceof ModuleRuntimeError && error.code === "contract_version_mismatch");
  assert.throws(() => resolveModulePlan([{ ...base, version: "next" }], []), (error: unknown) => error instanceof ModuleRuntimeError && error.code === "invalid_module_version");
  assert.throws(() => resolveModulePlan([manifest("story", { dependencies: ["nlp"] })], []), (error: unknown) => error instanceof ModuleRuntimeError && error.code === "missing_dependency");
  assert.throws(() => resolveModulePlan([
    manifest("story", { dependencies: ["nlp"] }),
    manifest("nlp", { dependencies: ["story"] }),
  ], []), (error: unknown) => error instanceof ModuleRuntimeError && error.code === "dependency_cycle");
  assert.throws(() => resolveModulePlan([manifest("story", { requires: ["nlp.tokenizer"] })], ["story"]), (error: unknown) => error instanceof ModuleRuntimeError && error.code === "missing_capability");
  assert.throws(() => resolveModulePlan([
    manifest("nlp", { provides: ["nlp.tokenizer"] }),
    manifest("diagnostics", { provides: ["nlp.tokenizer"] }),
  ], []), (error: unknown) => error instanceof ModuleRuntimeError && error.code === "duplicate_capability_provider");

  const plan = resolveModulePlan([
    manifest("nlp", { provides: ["nlp.tokenizer"] }),
    manifest("diagnostics", { dependencies: ["nlp"], requires: ["nlp.tokenizer"] }),
  ], ["diagnostics"]);
  assert.deepEqual(plan.order, ["nlp", "diagnostics"]);
  assert.deepEqual([...plan.enabled], ["diagnostics", "nlp"]);
});

test("disabled modules are not imported; enabling an absent module reports redeployment", async () => {
  const metadata = manifest("story");
  let imports = 0;
  const runtime = new ModuleRuntime({
    manifests: [metadata], enabled: [], cacheDirectory: "/tmp/scriptorium-runtime-test",
    loaders: { story: async () => { imports += 1; throw new Error("must remain lazy"); } },
  });
  assert.equal(runtime.status("story").availability, "disabled");
  assert.equal(runtime.status("nlp").availability, "not-included");
  assert.deepEqual(runtime.actions("story"), []);
  await assert.rejects(runtime.activate("story"), (error: unknown) => error instanceof ModuleRuntimeError && error.code === "module_disabled");
  assert.throws(() => runtime.enable("nlp"), (error: unknown) => error instanceof ModuleRuntimeError && error.code === "redeployment_required");
  assert.equal(imports, 0);
  await runtime.shutdown();
});

test("authenticated action catalogs expose only a cloned module domain job descriptor", async () => {
  const metadata = manifest("speaker");
  const declaration = { type: "speaker-eval", privateExtra: "must not escape" };
  const action: ModuleAction = {
    id: "evaluate", effect: "compute", job: declaration as ModuleAction["job"],
    inputSchema: schema, outputSchema: schema,
    async invoke(_input, context) { return { ok: true, snapshot: context.reader.snapshot, data: { accepted: true } }; },
  };
  const runtime = new ModuleRuntime({
    manifests: [metadata], enabled: ["speaker"], cacheDirectory: "/tmp/scriptorium-runtime-test",
    loaders: { speaker: async () => definition(metadata, action) },
  });
  try {
    const host = { ...readContext(), access: "owner" as const };
    const first = await runtime.listActions(host);
    const descriptor = first.find(({ id }) => id === "speaker.evaluate");
    assert.deepEqual(descriptor, {
      id: "speaker.evaluate", module: "speaker", effect: "compute", job: { type: "speaker-eval" },
    });
    assert.notEqual(descriptor?.job, declaration);
    assert.equal("privateExtra" in (descriptor?.job ?? {}), false);
    descriptor!.job!.type = "mutated";
    const second = await runtime.listActions(host);
    assert.equal(second.find(({ id }) => id === "speaker.evaluate")?.job?.type, "speaker-eval");
    assert.equal(declaration.type, "speaker-eval");
  } finally {
    await runtime.shutdown();
  }
});

test("module job descriptors reject read actions and malformed ASCII types", async () => {
  const cases: Array<{ effect: ModuleAction["effect"]; type: string }> = [
    { effect: "read", type: "speaker-eval" },
    { effect: "compute", type: "speaker eval" },
    { effect: "propose", type: "A".repeat(65) },
  ];
  for (const [index, item] of cases.entries()) {
    const metadata = manifest("speaker");
    const runtime = new ModuleRuntime({
      manifests: [metadata], enabled: ["speaker"], cacheDirectory: "/tmp/scriptorium-runtime-test",
      loaders: { speaker: async () => definition(metadata, {
        id: `invalid-job-${index}`, effect: item.effect, job: { type: item.type },
        inputSchema: schema, outputSchema: schema,
        async invoke(_input, context) { return { ok: true, snapshot: context.reader.snapshot, data: null }; },
      }) },
    });
    try {
      await assert.rejects(runtime.activate("speaker"), (error: unknown) =>
        error instanceof ModuleRuntimeError && error.code === "invalid_module_definition");
    } finally {
      await runtime.shutdown();
    }
  }
});

test("declared module jobs pass the exact validated action result and proposals to the host once", async () => {
  const metadata = manifest("story");
  const operation = proposalOperation();
  let executions = 0;
  let tracks = 0;
  let observed: { descriptor: ActionDescriptor; snapshot: SnapshotId; signal: AbortSignal } | undefined;
  const runtime = new ModuleRuntime({
    manifests: [metadata], enabled: ["story"], cacheDirectory: "/tmp/scriptorium-runtime-test",
    loaders: { story: async () => definition(metadata, {
      id: "refresh-summary", effect: "propose", job: { type: "summary-refresh" },
      inputSchema: schema, outputSchema: schema,
      async invoke(_input, context) {
        executions += 1;
        await context.propose([operation], undefined, "summary-refresh-proposal");
        return { ok: true, snapshot: context.reader.snapshot, data: { refreshed: true } };
      },
    }) },
  });
  const host = {
    ...readContext(), access: "owner" as const,
    async propose(operations: ChangeOperation[], _evidence: unknown, proposalId?: string): Promise<ChangeProposal> {
      return { id: proposalId ?? "proposal-1", snapshot, operations, source: "module" };
    },
    async trackDomainJob(
      descriptor: ActionDescriptor & { job: NonNullable<ActionDescriptor["job"]> },
      actionSnapshot: SnapshotId,
      signal: AbortSignal,
      execute: () => Promise<ActionResult>,
    ): Promise<ActionResult> {
      tracks += 1;
      observed = { descriptor, snapshot: actionSnapshot, signal };
      assert.equal(executions, 0, "the host can persist a queued record before invoking the action");
      const [first, second] = await Promise.all([execute(), execute()]);
      assert.strictEqual(first, second, "a host retry must reuse the same action execution");
      return first;
    },
  };
  try {
    const result = await runtime.invokeAction("story", "story.refresh-summary", {}, host);
    assert.equal(tracks, 1);
    assert.equal(executions, 1);
    assert.deepEqual(observed?.descriptor, {
      id: "story.refresh-summary", module: "story", effect: "propose", job: { type: "summary-refresh" },
    });
    assert.equal(observed?.snapshot, snapshot);
    assert.equal(observed?.signal.aborted, false);
    assert.deepEqual(result, {
      ok: true, snapshot, data: { refreshed: true },
      proposals: [{ id: "summary-refresh-proposal", snapshot, operations: [operation], source: "module" }],
    });
  } finally {
    await runtime.shutdown();
  }
});

test("nested module invocation retains the host tracker and suppresses duplicate job wrappers", async () => {
  const metadata = manifest("speaker");
  const plainOuter: ModuleAction = {
    id: "wrapper", effect: "compute", inputSchema: schema, outputSchema: schema,
    async invoke(_input, context) {
      const child = await context.invoke("speaker.inner", {});
      return { ok: true, snapshot: context.reader.snapshot, data: { child } };
    },
  };
  const jobOuter: ModuleAction = {
    id: "outer-job", effect: "compute", job: { type: "speaker-eval" }, inputSchema: schema, outputSchema: schema,
    async invoke(_input, context) {
      const child = await context.invoke("speaker.inner", {});
      return { ok: true, snapshot: context.reader.snapshot, data: { child } };
    },
  };
  const jobInner: ModuleAction = {
    id: "inner", effect: "compute", job: { type: "retrain" }, inputSchema: schema, outputSchema: schema,
    async invoke(_input, context) { return { ok: true, snapshot: context.reader.snapshot, data: { trained: true } }; },
  };
  const runtime = new ModuleRuntime({
    manifests: [metadata], enabled: ["speaker"], cacheDirectory: "/tmp/scriptorium-runtime-test",
    loaders: { speaker: async () => ({ manifest: metadata, actions: [plainOuter, jobOuter, jobInner], ui: [], async dispose() {} }) },
  });
  const tracked: string[] = [];
  const host = {
    ...readContext(), access: "owner" as const,
    async trackDomainJob(descriptor: ActionDescriptor & { job: NonNullable<ActionDescriptor["job"]> }, _actionSnapshot: SnapshotId, _signal: AbortSignal, execute: () => Promise<ActionResult>): Promise<ActionResult> {
      tracked.push(`${descriptor.id}:${descriptor.job.type}`);
      return execute();
    },
  };
  try {
    const plainResult = await runtime.invokeAction("speaker", "speaker.wrapper", {}, host);
    assert.equal(plainResult.ok, true, JSON.stringify(plainResult));
    assert.deepEqual(tracked, ["speaker.inner:retrain"], "a nested job under an untracked action is recorded");
    const outerResult = await runtime.invokeAction("speaker", "speaker.outer-job", {}, host);
    assert.equal(outerResult.ok, true, JSON.stringify(outerResult));
    assert.deepEqual(tracked, ["speaker.inner:retrain", "speaker.outer-job:speaker-eval"], "a nested job under a tracked action does not get a second wrapper");
  } finally {
    await runtime.shutdown();
  }
});

test("tracked module action receives abort cancellation and returns the cancelled result", async () => {
  const metadata = manifest("speaker");
  const controller = new AbortController();
  let started!: () => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  let trackedSignal: AbortSignal | undefined;
  const runtime = new ModuleRuntime({
    manifests: [metadata], enabled: ["speaker"], cacheDirectory: "/tmp/scriptorium-runtime-test",
    loaders: { speaker: async () => definition(metadata, {
      id: "evaluate", effect: "compute", job: { type: "speaker-eval" }, inputSchema: schema, outputSchema: schema,
      async invoke(_input, context) {
        started();
        await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
        return { ok: true, snapshot: context.reader.snapshot, data: { evaluated: true } };
      },
    }) },
  });
  const host = {
    ...readContext(controller.signal), access: "owner" as const,
    async trackDomainJob(_descriptor: ActionDescriptor & { job: NonNullable<ActionDescriptor["job"]> }, _actionSnapshot: SnapshotId, signal: AbortSignal, execute: () => Promise<ActionResult>): Promise<ActionResult> {
      trackedSignal = signal;
      return execute();
    },
  };
  try {
    const invocation = runtime.invokeAction("speaker", "speaker.evaluate", {}, host);
    await began;
    controller.abort();
    const result = await invocation;
    assert.equal(trackedSignal?.aborted, true);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "action_cancelled");
  } finally {
    await runtime.shutdown();
  }
});

test("abort while the host creates a queued record prevents the module action from starting", async () => {
  const metadata = manifest("speaker");
  const controller = new AbortController();
  let announceQueued!: () => void;
  const queued = new Promise<void>((resolve) => { announceQueued = resolve; });
  let executions = 0;
  const runtime = new ModuleRuntime({
    manifests: [metadata], enabled: ["speaker"], cacheDirectory: "/tmp/scriptorium-runtime-test",
    loaders: { speaker: async () => definition(metadata, {
      id: "evaluate", effect: "compute", job: { type: "speaker-eval" }, inputSchema: schema, outputSchema: schema,
      async invoke(_input, context) {
        executions += 1;
        return { ok: true, snapshot: context.reader.snapshot, data: { evaluated: true } };
      },
    }) },
  });
  const host = {
    ...readContext(controller.signal), access: "owner" as const,
    async trackDomainJob(_descriptor: ActionDescriptor & { job: NonNullable<ActionDescriptor["job"]> }, _actionSnapshot: SnapshotId, signal: AbortSignal, execute: () => Promise<ActionResult>): Promise<ActionResult> {
      const aborted = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      announceQueued();
      await aborted;
      return execute();
    },
  };
  try {
    const invocation = runtime.invokeAction("speaker", "speaker.evaluate", {}, host);
    await queued;
    controller.abort();
    const result = await invocation;
    assert.equal(executions, 0);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "action_cancelled");
  } finally {
    await runtime.shutdown();
  }
});

test("domain progress stays scoped to its host job through nested and overlapping invocations", async () => {
  const metadata = manifest("speaker");
  const outerIds = new Set<string>();
  let releaseBoth!: () => void;
  const bothStarted = new Promise<void>((resolve) => { releaseBoth = resolve; });
  const progressEvents: string[] = [];
  const makeOuter = (id: string, type: string): ModuleAction => ({
    id, effect: "compute", job: { type }, inputSchema: schema, outputSchema: schema,
    async invoke(input, context) {
      const name = (input as { name: string }).name;
      outerIds.add(name);
      if (outerIds.size === 2) releaseBoth();
      await bothStarted;
      assert.equal(typeof context.reportProgress, "function");
      await context.reportProgress!(0.1);
      const child = await context.invoke("speaker.inner", { name, progress: name === "a" ? 0.4 : 0.6 });
      await context.reportProgress!(0.9);
      return { ok: true, snapshot: context.reader.snapshot, data: { child } };
    },
  });
  const inner: ModuleAction = {
    id: "inner", effect: "compute", job: { type: "aspect-review" }, inputSchema: schema, outputSchema: schema,
    async invoke(input, context) {
      const value = input as { name: string; progress: number };
      assert.equal(typeof context.reportProgress, "function");
      await context.reportProgress!(value.progress);
      return { ok: true, snapshot: context.reader.snapshot, data: { name: value.name } };
    },
  };
  const runtime = new ModuleRuntime({
    manifests: [metadata], enabled: ["speaker"], cacheDirectory: "/tmp/scriptorium-runtime-test",
    loaders: { speaker: async () => ({ manifest: metadata, actions: [makeOuter("outer-a", "speaker-eval"), makeOuter("outer-b", "retrain"), inner], ui: [], async dispose() {} }) },
  });
  const tracked: string[] = [];
  const host = {
    ...readContext(), access: "owner" as const,
    async trackDomainJob(descriptor: ActionDescriptor & { job: NonNullable<ActionDescriptor["job"]> }, _actionSnapshot: SnapshotId, _signal: AbortSignal, execute: (reportProgress?: DomainJobProgressSink) => Promise<ActionResult>): Promise<ActionResult> {
      tracked.push(descriptor.id);
      return execute(async (progress) => { progressEvents.push(`${descriptor.id}:${progress}`); });
    },
  };
  try {
    const results = await Promise.all([
      runtime.invokeAction("speaker", "speaker.outer-a", { name: "a" }, host),
      runtime.invokeAction("speaker", "speaker.outer-b", { name: "b" }, host),
    ]);
    assert.deepEqual(results.map((result) => result.ok), [true, true]);
    assert.deepEqual(tracked.sort(), ["speaker.outer-a", "speaker.outer-b"], "nested declared jobs remain under their tracked outer invocation");
    assert.deepEqual(progressEvents.sort(), [
      "speaker.outer-a:0.1", "speaker.outer-a:0.4", "speaker.outer-a:0.9",
      "speaker.outer-b:0.1", "speaker.outer-b:0.6", "speaker.outer-b:0.9",
    ]);
  } finally {
    await runtime.shutdown();
  }
});

test("domain progress rejects non-finite values and clamps finite values to the source range", async () => {
  const metadata = manifest("speaker");
  const delivered: number[] = [];
  const runtime = new ModuleRuntime({
    manifests: [metadata], enabled: ["speaker"], cacheDirectory: "/tmp/scriptorium-runtime-test",
    loaders: { speaker: async () => definition(metadata, {
      id: "evaluate", effect: "compute", job: { type: "speaker-eval" }, inputSchema: schema, outputSchema: schema,
      async invoke(_input, context) {
        await context.reportProgress?.(-0.5);
        await context.reportProgress?.(1.5);
        await context.reportProgress?.(Number.NaN);
        return { ok: true, snapshot: context.reader.snapshot, data: { evaluated: true } };
      },
    }) },
  });
  const host = {
    ...readContext(), access: "owner" as const,
    async trackDomainJob(_descriptor: ActionDescriptor & { job: NonNullable<ActionDescriptor["job"]> }, _actionSnapshot: SnapshotId, _signal: AbortSignal, execute: (reportProgress?: DomainJobProgressSink) => Promise<ActionResult>): Promise<ActionResult> {
      return execute(async (progress) => { delivered.push(progress); });
    },
  };
  try {
    const result = await runtime.invokeAction("speaker", "speaker.evaluate", {}, host);
    assert.deepEqual(delivered, [0, 1]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "invalid_job_progress");
  } finally {
    await runtime.shutdown();
  }
});

test("cancellation during progress delivery stops the action before it continues", async () => {
  const metadata = manifest("speaker");
  const controller = new AbortController();
  let progressStarted!: () => void;
  const reported = new Promise<void>((resolve) => { progressStarted = resolve; });
  let continued = false;
  const runtime = new ModuleRuntime({
    manifests: [metadata], enabled: ["speaker"], cacheDirectory: "/tmp/scriptorium-runtime-test",
    loaders: { speaker: async () => definition(metadata, {
      id: "evaluate", effect: "compute", job: { type: "speaker-eval" }, inputSchema: schema, outputSchema: schema,
      async invoke(_input, context) {
        await context.reportProgress?.(0.5);
        continued = true;
        return { ok: true, snapshot: context.reader.snapshot, data: { evaluated: true } };
      },
    }) },
  });
  const host = {
    ...readContext(controller.signal), access: "owner" as const,
    async trackDomainJob(_descriptor: ActionDescriptor & { job: NonNullable<ActionDescriptor["job"]> }, _actionSnapshot: SnapshotId, signal: AbortSignal, execute: (reportProgress?: DomainJobProgressSink) => Promise<ActionResult>): Promise<ActionResult> {
      return execute(async () => {
        const aborted = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        progressStarted();
        await aborted;
      });
    },
  };
  try {
    const invocation = runtime.invokeAction("speaker", "speaker.evaluate", {}, host);
    await reported;
    controller.abort();
    const result = await invocation;
    assert.equal(continued, false);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "action_cancelled");
  } finally {
    await runtime.shutdown();
  }
});

test("enabled idle modules import no heavy capability; proposals are host-issued and attached to success", async () => {
  const metadata = manifest("story", { statePaths: ["meta/scriptorium/modules/story"], requires: ["model:test"] });
  let loaded = 0;
  let created = 0;
  let forwardedProposalId: string | undefined;
  const operation = proposalOperation();
  const runtime = new ModuleRuntime({
    manifests: [metadata], enabled: ["story"], cacheDirectory: "/tmp/scriptorium-runtime-test",
    capabilityProviders: { "model:test": { create: () => { created += 1; return { id: "shared-model" }; } } },
    loaders: { story: async (context) => {
      loaded += 1;
      return definition(metadata, {
        id: "propose",
        effect: "propose",
        inputSchema: schema,
        outputSchema: schema,
        async invoke(_input, actionContext) {
          const lease = await context.acquireCapability<{ id: string }>("model:test");
          await lease.release();
          await actionContext.propose([operation], undefined, "mcp-batch-1");
          return { ok: true, snapshot, data: { accepted: false } };
        },
      });
    } },
  });
  assert.equal(runtime.status("story").availability, "enabled-idle");
  assert.equal(created, 0);
  await runtime.activate("story");
  assert.equal(loaded, 1);
  assert.equal(created, 0);
  assert.equal(runtime.status("story").availability, "enabled-idle");
  const host = {
    ...readContext(),
    async propose(operations: ChangeOperation[], _evidence, proposalId): Promise<ChangeProposal> {
      forwardedProposalId = proposalId;
      return { id: proposalId ?? "proposal-1", snapshot, operations, source: "module" };
    },
  };
  const result = await runtime.invokeAction("story", "propose", {}, host);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(forwardedProposalId, "mcp-batch-1", "the host receives the caller's stable proposal ID");
  if (result.ok) {
    assert.deepEqual(result.proposals, [{ id: "mcp-batch-1", snapshot, operations: [operation], source: "module" }]);
  }
  await runtime.shutdown();
});

test("per-call proposal cancellation reaches the host and prevents a late proposal result", async () => {
  const metadata = manifest("story");
  let startProposal!: () => void;
  let finishProposal!: () => void;
  let hostSignal: AbortSignal | undefined;
  const proposalStarted = new Promise<void>((resolve) => { startProposal = resolve; });
  const hostProposal = new Promise<void>((resolve) => { finishProposal = resolve; });
  const callController = new AbortController();
  const operation = proposalOperation();
  const runtime = new ModuleRuntime({
    manifests: [metadata], enabled: ["story"], cacheDirectory: "/tmp/scriptorium-runtime-test",
    loaders: { story: async () => definition(metadata, {
      id: "propose",
      effect: "propose",
      inputSchema: schema,
      outputSchema: schema,
      async invoke(_input, action) {
        await action.propose([operation], undefined, "mcp-cancelled", callController.signal);
        return { ok: true, snapshot, data: { accepted: false } };
      },
    }) },
  });
  const host = {
    ...readContext(),
    async propose(operations: ChangeOperation[], _evidence, proposalId, signal?: AbortSignal): Promise<ChangeProposal> {
      hostSignal = signal;
      startProposal();
      await hostProposal;
      return { id: proposalId ?? "proposal-1", snapshot, operations, source: "module" };
    },
  };

  const invocation = runtime.invokeAction("story", "propose", {}, host);
  await proposalStarted;
  assert.ok(hostSignal, "the host receives a composed abort signal");
  callController.abort();
  assert.equal(hostSignal.aborted, true, "a per-call abort propagates into the host proposal operation");
  finishProposal();
  const result = await invocation;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "action_cancelled");
  await runtime.shutdown();
});

test("two enabled consumers share one capability until the final module disables", async () => {
  const story = manifest("story", { requires: ["shared:model:v1"] });
  const diagnostics = manifest("diagnostics", { requires: ["shared:model:v1"] });
  let creates = 0;
  let disposals = 0;
  const leases = new Map<ModuleId, { release(): Promise<void> }>();
  const makeLoader = (metadata: ModuleManifest) => async (context: import("@scriptorium/contracts").ModuleContext) => definition(metadata, {
    id: "use-model",
    effect: "compute",
    inputSchema: schema,
    outputSchema: schema,
    async invoke(_input: unknown, action: ModuleActionContext) {
      leases.set(metadata.id, await context.acquireCapability("shared:model:v1"));
      return { ok: true, snapshot: action.reader.snapshot, data: { loaded: true } };
    },
  });
  const runtime = new ModuleRuntime({
    manifests: [story, diagnostics], enabled: ["story", "diagnostics"], cacheDirectory: "/tmp/scriptorium-runtime-test",
    capabilityProviders: { "shared:model:v1": {
      create: () => { creates += 1; return { loaded: true }; },
      dispose: () => { disposals += 1; },
    } },
    loaders: { story: makeLoader(story), diagnostics: makeLoader(diagnostics) },
  });
  const host = readContext();
  await runtime.invokeAction("story", "use-model", {}, host);
  await runtime.invokeAction("diagnostics", "use-model", {}, host);
  assert.equal(creates, 1);
  assert.equal(runtime.status("story").availability, "active");
  await runtime.disable("story");
  assert.equal(disposals, 0);
  await runtime.disable("diagnostics");
  assert.equal(disposals, 1);
  assert.equal(runtime.status("story").availability, "disabled");
  assert.equal(runtime.status("diagnostics").availability, "disabled");
  assert.equal(leases.size, 2);
  await runtime.shutdown();
});

test("module-owned capability shares one supervised worker across two consumers and exits after the last release", async () => {
  const nlp = manifest("nlp", { provides: ["nlp.tokenizer"], workerEntry: "worker-service.mjs" });
  const diagnostics = manifest("diagnostics", { dependencies: ["nlp"], requires: ["nlp.tokenizer"] });
  const story = manifest("story", { dependencies: ["nlp"], requires: ["nlp.tokenizer"] });
  let creates = 0;
  let disposals = 0;
  const held = new Map<ModuleId, { release(): Promise<void> }>();
  const makeDefinition = (metadata: ModuleManifest, context: import("@scriptorium/contracts").ModuleContext): ModuleDefinition => ({
    manifest: metadata,
    actions: [{
      id: "tokenize",
      effect: "compute",
      inputSchema: schema,
      outputSchema: schema,
      async invoke(_input, action) {
        const lease = await context.acquireCapability<WorkerService>("nlp.tokenizer");
        held.set(metadata.id, lease);
        const outcome = await lease.value.request<{ pid: number }>(jobRequest("nlp", { task: "tokenize", moduleVersion: nlp.version }), action.signal);
        if (!outcome.ok) return { ok: false, snapshot: action.reader.snapshot, error: outcome.error };
        return { ok: true, snapshot: action.reader.snapshot, data: outcome.result.output };
      },
    }], ui: [], async dispose() {},
  });
  const makeConsumer = (metadata: ModuleManifest) => async (context: import("@scriptorium/contracts").ModuleContext): Promise<ModuleDefinition> => makeDefinition(metadata, context);
  const runtime = new ModuleRuntime({
    manifests: [nlp, diagnostics, story], enabled: ["nlp", "diagnostics", "story"],
    cacheDirectory: "/tmp/scriptorium-runtime-test", workerEntries: { nlp: fileURLToPath(new URL("./fixtures/worker-service.mjs", import.meta.url)) },
    loaders: {
      nlp: async (context) => {
        const definition = makeDefinition(nlp, context);
        definition.capabilities = [{
          id: "nlp.tokenizer",
          version: "1.0.0",
          async create(providerContext) { creates += 1; return providerContext.createWorkerService(); },
          async dispose(service) { disposals += 1; await service.dispose(); },
        }];
        return definition;
      },
      diagnostics: makeConsumer(diagnostics),
      story: makeConsumer(story),
    },
  });
  const host = readContext();
  const producerResult = await runtime.invokeAction("nlp", "tokenize", {}, host);
  assert.equal(producerResult.ok, true, JSON.stringify(producerResult));
  const diagnosticsResult = await runtime.invokeAction("diagnostics", "tokenize", {}, host);
  assert.equal(diagnosticsResult.ok, true, JSON.stringify(diagnosticsResult));
  const pid = runtime.workerSupervisor.activeWorkerPids[0];
  assert.ok(pid, "provider should own a live child process");
  const storyResult = await runtime.invokeAction("story", "tokenize", {}, host);
  assert.equal(storyResult.ok, true, JSON.stringify(storyResult));
  assert.equal(creates, 1);
  assert.equal(runtime.workerSupervisor.activeWorkerPids[0], pid);

  await runtime.disable("diagnostics");
  assert.equal(disposals, 0);
  assert.doesNotThrow(() => process.kill(pid!, 0));
  await assert.rejects(runtime.disable("nlp"), (error: unknown) => error instanceof ModuleRuntimeError && error.code === "module_dependency_in_use");
  await runtime.disable("story");
  await runtime.disable("nlp");
  assert.equal(disposals, 1);
  assert.throws(() => process.kill(pid!, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
  assert.equal(held.size, 3);
  await runtime.shutdown();
});

test("disabling a consumer cancels its provider-owned job and keeps the shared child until the final consumer releases", async () => {
  const nlp = manifest("nlp", { provides: ["nlp.tokenizer"], workerEntry: "worker-service.mjs" });
  const diagnostics = manifest("diagnostics", { dependencies: ["nlp"], requires: ["nlp.tokenizer"] });
  const story = manifest("story", { dependencies: ["nlp"], requires: ["nlp.tokenizer"] });
  const held = new Map<ModuleId, { release(): Promise<void> }>();
  const providerDefinition: ModuleDefinition = {
    manifest: nlp, actions: [], ui: [],
    capabilities: [{
      id: "nlp.tokenizer", version: "1.0.0",
      async create(context) { return context.createWorkerService(); },
      async dispose(service) { await service.dispose(); },
    }],
    async dispose() {},
  };
  const consumerLoader = (metadata: ModuleManifest, makeRequest: boolean) => async (context: import("@scriptorium/contracts").ModuleContext): Promise<ModuleDefinition> => definition(metadata, {
    id: `${metadata.id}.tokenize`,
    effect: "compute",
    inputSchema: schema,
    outputSchema: schema,
    async invoke(_input, action) {
      const lease = await context.acquireCapability<WorkerService>("nlp.tokenizer");
      held.set(metadata.id, lease);
      if (!makeRequest) return { ok: true, snapshot: action.reader.snapshot, data: { leased: true } };
      const outcome = await lease.value.request(jobRequest("nlp", {
        task: "hold", moduleVersion: nlp.version, deadline: Date.now() + 60_000,
      }), action.signal);
      if (!outcome.ok) return { ok: false, snapshot: action.reader.snapshot, error: outcome.error };
      return { ok: true, snapshot: action.reader.snapshot, data: outcome.result.output };
    },
  });
  const runtime = new ModuleRuntime({
    manifests: [nlp, diagnostics, story], enabled: ["nlp", "diagnostics", "story"],
    cacheDirectory: "/tmp/scriptorium-runtime-test",
    workerEntries: { nlp: fileURLToPath(new URL("./fixtures/worker-service.mjs", import.meta.url)) },
    loaders: {
      nlp: async () => providerDefinition,
      diagnostics: consumerLoader(diagnostics, false),
      story: consumerLoader(story, true),
    },
  });
  const lifecycle: WorkerJobLifecycleSnapshot[] = [];
  const unsubscribe = runtime.subscribeJobLifecycle((event) => { lifecycle.push(event); });
  const host = readContext();
  const diagnosticResult = await runtime.invokeAction("diagnostics", "diagnostics.tokenize", {}, host);
  assert.equal(diagnosticResult.ok, true, JSON.stringify(diagnosticResult));
  const pid = runtime.workerSupervisor.activeWorkerPids[0];
  assert.ok(pid, "shared capability should own a live child process");

  const storyInvocation = runtime.invokeAction("story", "story.tokenize", {}, host);
  await new Promise<void>((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      if (runtime.workerSupervisor.activeJobCountFor("nlp") > 0 && lifecycle.some((event) => event.state === "running")) { resolve(); return; }
      attempts += 1;
      if (attempts > 100) { reject(new Error("provider-owned service job did not start")); return; }
      setTimeout(check, 10);
    };
    check();
  });
  await runtime.disable("story");
  const cancelled = await storyInvocation;
  assert.equal(cancelled.ok, false);
  if (!cancelled.ok) assert.equal(cancelled.error.code, "action_cancelled");
  assert.equal(runtime.workerSupervisor.activeJobCountFor("nlp"), 0);
  assert.doesNotThrow(() => process.kill(pid!, 0), "the other consumer still holds the shared service");
  const jobLifecycle = lifecycle.filter((event) => event.task === "hold");
  assert.deepEqual(jobLifecycle.map((event) => event.state), ["queued", "running", "cancelled"]);
  assert.equal(jobLifecycle.at(-1)?.errorCode, "job_cancelled");

  await runtime.disable("diagnostics");
  await runtime.disable("nlp");
  assert.throws(() => process.kill(pid!, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
  assert.equal(held.size, 2);
  unsubscribe();
  await runtime.shutdown();
});

test("a per-call abort cancels a real nested worker while its outer action remains active", async () => {
  const nlp = manifest("nlp", { provides: ["nlp.tokenizer"], workerEntry: "worker-service.mjs" });
  const story = manifest("story", {
    optionalRequires: ["nlp.tokenizer"],
    statePaths: ["bible", "plot", "manuscript", "meta/scriptorium/modules/story"],
    serverEntry: "./dist/index.js",
    browserEntry: "./dist/browser.js",
  });
  const speaker = manifest("speaker", { dependencies: ["story"] });
  const perCall = new AbortController();
  let finishOuter: (() => void) | undefined;
  let markNestedFinished!: (value: { result: ActionResult; outerAborted: boolean }) => void;
  const nestedFinished = new Promise<{ result: ActionResult; outerAborted: boolean }>((resolve) => { markNestedFinished = resolve; });
  const runtime = new ModuleRuntime({
    manifests: [nlp, story, speaker], enabled: ["nlp", "story", "speaker"], cacheDirectory: "/tmp/scriptorium-runtime-test",
    workerEntries: { nlp: fileURLToPath(new URL("./fixtures/worker-service.mjs", import.meta.url)) },
    loaders: {
      nlp: async () => ({
        manifest: nlp, actions: [], ui: [],
        capabilities: [{
          id: "nlp.tokenizer", version: "1.0.0",
          async create(providerContext) {
            const service = await providerContext.createWorkerService();
            return {
              service,
              async analyze(_text: string, selectedSnapshot: SnapshotId, signal: AbortSignal) {
                const outcome = await service.request(jobRequest("nlp", {
                  task: "hold", snapshot: selectedSnapshot, moduleVersion: nlp.version, deadline: Date.now() + 60_000,
                }), signal);
                if (!outcome.ok) throw Object.assign(new Error(outcome.error.message), { code: outcome.error.code });
                return { tokens: [] };
              },
            };
          },
          async dispose(tokenizer) { await tokenizer.service.dispose(); },
        }],
        async dispose() {},
      }),
      story: async (context) => ({ manifest: story, actions: createStoryActions(context), ui: [], async dispose() {} }),
      speaker: async () => ({
        manifest: speaker,
        actions: [
          {
            id: "speaker.attribute", effect: "compute", inputSchema: schema, outputSchema: schema,
            async invoke(_input: unknown, action: ModuleActionContext) {
              const result = await action.invoke("story.entities.suggested-tags", { id: "char-1" }, perCall.signal);
              const hold = new Promise<void>((resolve) => { finishOuter = resolve; });
              markNestedFinished({ result, outerAborted: action.signal.aborted });
              await hold;
              return { ok: true, snapshot: action.reader.snapshot, data: { nestedOk: result.ok } };
            },
          },
          {
            id: "speaker.read-only", effect: "read", inputSchema: schema, outputSchema: schema,
            async invoke(_input: unknown, action: ModuleActionContext) {
              const result = await action.invoke("story.entities.suggested-tags", { id: "char-1" });
              return { ok: true, snapshot: action.reader.snapshot, data: {
                nestedError: result.ok ? null : result.error.code,
              } };
            },
          },
        ],
        ui: [], async dispose() {},
      }),
    },
  });

  const reader = {
    snapshot,
    async list(prefix: string) {
      return prefix === "bible" ? ["bible/characters/char-1/profile.yaml"] : [];
    },
    async read(path: string) {
      if (path === "bible/characters/char-1/profile.yaml") {
        return { content: "id: char-1\nname: Character\nnotes: A character with enough text to request local tokenization.\n", revision: "r1" };
      }
      return null;
    },
  };
  const host = { ...readContext(), reader };
  const invocation = runtime.invokeAction("speaker", "speaker.attribute", { id: "char-1" }, host);
  await new Promise<void>((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      if (runtime.workerSupervisor.activeJobCountFor("nlp") > 0) { resolve(); return; }
      attempts += 1;
      if (attempts > 100) { reject(new Error("nested provider-owned worker job did not start")); return; }
      setTimeout(check, 10);
    };
    check();
  });
  const pid = runtime.workerSupervisor.activeWorkerPids[0];
  assert.ok(pid, "nested job should run in a real supervised child process");
  perCall.abort();
  const nested = await nestedFinished;
  assert.equal(nested.outerAborted, false, "the parent action signal remains active");
  assert.equal(nested.result.ok, false);
  if (!nested.result.ok) assert.equal(nested.result.error.code, "action_cancelled");
  assert.equal(runtime.workerSupervisor.activeJobCountFor("nlp"), 0, "the worker has settled its cancelled job");
  assert.equal(runtime.status("speaker").availability, "active", "the outer action remains in flight");
  assert.throws(() => process.kill(pid!, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH", "the canceled Story capability releases its actual child while the speaker action remains active");

  finishOuter?.();
  const result = await invocation;
  assert.equal(result.ok, true, JSON.stringify(result));
  const readOnly = await runtime.invokeAction("speaker", "speaker.read-only", {}, readContext());
  assert.equal(readOnly.ok, true, JSON.stringify(readOnly));
  if (readOnly.ok) assert.deepEqual(readOnly.data, { nestedError: "action_effect_denied" });
  await runtime.disable("speaker");
  await runtime.disable("story");
  await runtime.disable("nlp");
  assert.throws(() => process.kill(pid!, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
  await runtime.shutdown();
});

test("runtime module version mismatch is rejected before the worker starts", async () => {
  const metadata = manifest("speaker", { workerEntry: "worker.mjs" });
  let imports = 0;
  const runtime = new ModuleRuntime({
    manifests: [metadata], enabled: ["speaker"], cacheDirectory: "/tmp/scriptorium-runtime-test",
    workerEntries: { speaker: "/does/not/exist.mjs" },
    loaders: { speaker: async () => { imports += 1; return definition(metadata, {
      id: "unused", effect: "compute", inputSchema: schema, outputSchema: schema,
      async invoke(_input, context) { return { ok: true, snapshot: context.reader.snapshot, data: {} }; },
    }); } },
  });
  const request = jobRequest("speaker", { moduleVersion: "0.0.9" });
  const result = await runtime.runJob(request);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "module_version_mismatch");
  assert.equal(imports, 0);
  await runtime.shutdown();
});

test("disabling a module drains its real child process and leaves author data untouched", async () => {
  const metadata = manifest("speaker", { workerEntry: "worker.mjs" });
  let disposed = 0;
  const authorData = { correction: "keep this author-owned value" };
  const runtime = new ModuleRuntime({
    manifests: [metadata], enabled: ["speaker"], cacheDirectory: "/tmp/scriptorium-runtime-test",
    workerEntries: { speaker: workerEntry },
    loaders: { speaker: async () => definition(metadata, {
      id: "train",
      effect: "compute",
      inputSchema: schema,
      outputSchema: schema,
      async invoke(_input, context) {
        const outcome = await context.runJob({
          id: "disable-worker-job",
          module: "speaker",
          task: "hold",
          snapshot,
          model: "test-model",
          modelVersion: "1.0.0",
          moduleVersion: metadata.version,
          deadline: Date.now() + 10_000,
          input: {},
        });
        return { ok: true, snapshot: context.reader.snapshot, data: outcome };
      },
    }, () => { disposed += 1; }) },
  });
  const lifecycle: WorkerJobLifecycleSnapshot[] = [];
  const unsubscribe = runtime.subscribeJobLifecycle((event) => { lifecycle.push(event); });
  assert.equal(runtime.workerSupervisor.activeWorkerPids.length, 0, "subscribing must not activate a module worker");
  const invocation = runtime.invokeAction("speaker", "train", {}, readContext());
  const pid = await new Promise<number>((resolve, reject) => {
    let attempt = 0;
    const check = () => {
      const running = runtime.workerSupervisor.activeWorkerPids[0];
      if (running) { resolve(running); return; }
      attempt += 1;
      if (attempt > 100) { reject(new Error("worker process did not start")); return; }
      setTimeout(check, 10);
    };
    check();
  });
  await runtime.disable("speaker");
  const result = await invocation;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "action_cancelled");
  assert.equal(runtime.status("speaker").availability, "disabled");
  assert.equal(runtime.workerSupervisor.activeJobCount, 0);
  assert.equal(disposed, 1);
  assert.deepEqual(authorData, { correction: "keep this author-owned value" });
  assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
  assert.deepEqual(lifecycle.map((event) => event.state), ["queued", "running", "cancelled"]);
  assert.equal(lifecycle.at(-1)?.errorCode, "job_cancelled");
  assert.equal("input" in (lifecycle.at(-1) ?? {}), false);
  unsubscribe();
  await runtime.shutdown();
});

test("module actions compose through namespaced host actions and owner-checked linked readers", async () => {
  const metadata = manifest("story");
  const linkedSnapshot: SnapshotId = { ...snapshot, repository: { ...snapshot.repository, repositoryId: "repo-linked" } };
  const linkedReader = {
    snapshot: linkedSnapshot,
    async read() { return "linked"; },
    async list() { return ["linked.md"]; },
  };
  let loaderCalls = 0;
  const runtime = new ModuleRuntime({
    manifests: [metadata], enabled: ["story"], cacheDirectory: "/tmp/scriptorium-runtime-test",
    loaders: { story: async () => {
      loaderCalls += 1;
      return definition(metadata, {
        id: "story.describe",
        effect: "read",
        inputSchema: schema,
        outputSchema: schema,
        async invoke(_input, action) {
          const actions = await action.listActions();
          const status = await action.invoke("core.status", {});
          const linked = await action.linkedReader("repo-linked");
          return { ok: true, snapshot: action.reader.snapshot, data: {
            actions: actions.map(({ id, module }) => ({ id, module })),
            status,
            projectId: action.projectId,
            linkedPaths: await linked.list(),
          } };
        },
      });
    } },
  });
  assert.equal(loaderCalls, 0, "enabled idle modules remain lazy");
  const host = {
    ...readContext(),
    actions: [{ module: "core" as const, action: {
      id: "status", effect: "read" as const, inputSchema: schema, outputSchema: schema,
      async invoke(_input: unknown, context: ModuleActionContext) {
        return { ok: true as const, snapshot: context.reader.snapshot, data: { projectId: context.projectId } };
      },
    } }],
    async linkedReader(repositoryId: string) {
      assert.equal(repositoryId, "repo-linked");
      return linkedReader;
    },
  };
  const result = await runtime.invokeAction("story", "story.describe", {}, host);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) {
    assert.deepEqual(result.data, {
      actions: [{ id: "story.describe", module: "story" }, { id: "core.status", module: "core" }],
      status: { ok: true, snapshot, data: { projectId: "project-1" } },
      projectId: "project-1",
      linkedPaths: ["linked.md"],
    });
  }
  assert.equal(loaderCalls, 1);
  await runtime.shutdown();
});

test("optional capabilities do not block profile resolution and cannot activate a disabled provider", async () => {
  const nlp = manifest("nlp", { provides: ["nlp.tokenizer"] });
  const story = manifest("story", { optionalRequires: ["nlp.tokenizer"] });
  const plan = resolveModulePlan([nlp, story], ["story"]);
  assert.deepEqual([...plan.enabled], ["story"]);
  assert.deepEqual([...resolveModulePlan([story], ["story"]).enabled], ["story"], "the optional package may be absent");

  let providerImports = 0;
  let held: { release(): Promise<void> } | undefined;
  const storyLoader = async (context: import("@scriptorium/contracts").ModuleContext): Promise<ModuleDefinition> => definition(story, {
    id: "suggest-tags",
    effect: "compute",
    inputSchema: schema,
    outputSchema: schema,
    async invoke(_input, action) {
      held = await context.acquireCapability("nlp.tokenizer");
      return { ok: true, snapshot: action.reader.snapshot, data: { ready: true } };
    },
  });
  const missingRuntime = new ModuleRuntime({
    manifests: [story], enabled: ["story"], cacheDirectory: "/tmp/scriptorium-runtime-test",
    loaders: { story: storyLoader },
  });
  const missing = await missingRuntime.invokeAction("story", "suggest-tags", {}, readContext());
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, "optional_capability_unavailable");
  await missingRuntime.shutdown();

  const runtime = new ModuleRuntime({
    manifests: [nlp, story], enabled: ["story"], cacheDirectory: "/tmp/scriptorium-runtime-test",
    loaders: {
      nlp: async () => {
        providerImports += 1;
        return { manifest: nlp, actions: [], ui: [], capabilities: [{
          id: "nlp.tokenizer", version: "1.0.0", async create() { return { tokens: true }; },
        }], async dispose() {} };
      },
      story: storyLoader,
    },
  });
  const host = readContext();
  const unavailable = await runtime.invokeAction("story", "suggest-tags", {}, host);
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) assert.equal(unavailable.error.code, "optional_capability_unavailable");
  assert.equal(providerImports, 0, "optional acquisition must not import a disabled provider");

  runtime.enable("nlp");
  const available = await runtime.invokeAction("story", "suggest-tags", {}, host);
  assert.equal(available.ok, true, JSON.stringify(available));
  assert.equal(providerImports, 1);
  await assert.rejects(runtime.disable("nlp"), (error: unknown) => error instanceof ModuleRuntimeError && error.code === "module_dependency_in_use");
  await held?.release();
  await runtime.disable("nlp");
  await runtime.shutdown();
});

test("HTTP contributions are hidden until activation and public reads cannot propose; streamed calls drain on cancel", async () => {
  const metadata = manifest("publishing");
  const story = manifest("story");
  let proposals = 0;
  let storyImports = 0;
  let linkedReaderCalls = 0;
  const runtime = new ModuleRuntime({
    manifests: [metadata, story], enabled: ["publishing", "story"], cacheDirectory: "/tmp/scriptorium-runtime-test",
    loaders: {
      story: async () => {
        storyImports += 1;
        return definition(story, {
          id: "private-read", effect: "read", inputSchema: schema, outputSchema: schema,
          async invoke(_input, context) { return { ok: true, snapshot: context.reader.snapshot, data: { private: true } }; },
        });
      },
      publishing: async () => ({
        manifest: metadata,
        actions: [],
        ui: [],
        http: [
          { id: "public-read", path: "public/status", methods: ["GET"], access: "public", effect: "read", async handle(_request, context) {
            await context.propose([proposalOperation()]);
            return Response.json({ ok: true });
          } },
          { id: "public-context", path: "public/context", methods: ["GET"], access: "public", effect: "read", async handle(_request, context) {
            const actions = await context.listActions();
            const nested = await context.invoke("story.private-read", {});
            let linkedReaderError: string | undefined;
            try { await context.linkedReader("repo-linked"); } catch (error) {
              linkedReaderError = (error as { code?: string }).code;
            }
            return Response.json({ actions, nested, linkedReaderError });
          } },
          { id: "stream", path: "public/stream", methods: ["GET"], access: "public", effect: "read", async handle() {
            return new Response(new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new TextEncoder().encode("chunk")); } }));
          } },
        ],
        async dispose() {},
      }),
    },
  });
  assert.deepEqual(runtime.httpContributions("publishing"), []);
  await runtime.activate("publishing");
  const descriptors = runtime.httpContributions("publishing");
  assert.equal(descriptors.length, 3);
  assert.equal("handle" in descriptors[0]!, false);
  const host = {
    ...readContext(),
    access: "public" as const,
    actions: [{ module: "core" as const, action: {
      id: "status", effect: "read" as const, inputSchema: schema, outputSchema: schema,
      async invoke(_input: unknown, context: ModuleActionContext) {
        return { ok: true as const, snapshot: context.reader.snapshot, data: { projectId: context.projectId } };
      },
    } }],
    async linkedReader() {
      linkedReaderCalls += 1;
      return { ...readContext().reader, snapshot: { ...snapshot, repository: { ...snapshot.repository, repositoryId: "repo-linked" } } };
    },
    async propose(operations: ChangeOperation[]): Promise<ChangeProposal> {
      proposals += 1;
      return { id: "proposal-http", snapshot, operations, source: "module" };
    },
  };
  const denied = await runtime.invokeHttp("publishing", "public-read", new Request("http://localhost/public/status"), host);
  assert.equal(denied.status, 403);
  assert.equal(proposals, 0);

  const publicContext = await runtime.invokeHttp("publishing", "public-context", new Request("http://localhost/public/context"), host);
  assert.equal(publicContext.status, 200);
  assert.deepEqual(await publicContext.json(), {
    actions: [],
    nested: { ok: false, snapshot, error: { code: "public_action_unavailable", message: "Public routes cannot invoke composed actions", retryable: false } },
    linkedReaderError: "public_access_restricted",
  });
  assert.equal(storyImports, 0, "public route contexts do not enumerate or activate private modules");
  assert.equal(linkedReaderCalls, 0, "public route contexts cannot access linked repositories");

  const streaming = await runtime.invokeHttp("publishing", "stream", new Request("http://localhost/public/stream"), host);
  assert.equal(streaming.status, 200);
  assert.equal(runtime.status("publishing").availability, "active");
  await streaming.body?.cancel();
  assert.equal(runtime.status("publishing").availability, "enabled-idle");
  await runtime.disable("publishing");
  assert.deepEqual(runtime.httpContributions("publishing"), []);
  assert.equal((await runtime.invokeHttp("publishing", "stream", new Request("http://localhost/public/stream"), host)).status, 404);
  await runtime.shutdown();
});

test("owner compute HTTP contributions can compose reads, compute, and jobs but cannot propose", async () => {
  const publishing = manifest("publishing");
  const story = manifest("story");
  let proposeActionCalls = 0;
  let hostProposalCalls = 0;
  // Exercise the registered module HTTP contribution through the production context ports.
  const handlerRuntime = new ModuleRuntime({
    manifests: [publishing, story], enabled: ["publishing", "story"], cacheDirectory: "/tmp/scriptorium-runtime-test",
    workerEntries: { publishing: workerEntry },
    loaders: {
      story: async () => ({
        manifest: story,
        actions: [
          { id: "read", effect: "read", inputSchema: schema, outputSchema: schema,
            async invoke(_input, context) { return { ok: true, snapshot: context.reader.snapshot, data: { source: "read" } }; } },
          { id: "compute", effect: "compute", inputSchema: schema, outputSchema: schema,
            async invoke(_input, context) { return { ok: true, snapshot: context.reader.snapshot, data: { source: "compute" } }; } },
          { id: "propose", effect: "propose", inputSchema: schema, outputSchema: schema,
            async invoke(_input, context) {
              proposeActionCalls += 1;
              return { ok: true, snapshot: context.reader.snapshot, data: { source: "propose" } };
            } },
        ],
        ui: [], async dispose() {},
      }),
      publishing: async () => ({
        manifest: publishing, actions: [], ui: [],
        http: [{ id: "qa-stream", path: "qa/stream", methods: ["POST"], access: "owner", effect: "compute", async handle(_request, context) {
          const read = await context.invoke("story.read", {});
          const compute = await context.invoke("story.compute", {});
          const nestedProposal = await context.invoke("story.propose", {});
          let directProposalCode: string | undefined;
          try { await context.propose([proposalOperation()]); }
          catch (error) { directProposalCode = (error as { code?: string }).code; }
          const jobRequest: JobRequest = {
            id: "http-compute-job", module: "publishing", task: "echo", snapshot: context.reader.snapshot,
            model: "test-model", modelVersion: "1", moduleVersion: publishing.version,
            deadline: Date.now() + 5_000, input: { source: "http-compute" },
          };
          const job = await context.runJob(jobRequest);
          return Response.json({
            read: read.ok ? read.data : read.error.code,
            compute: compute.ok ? compute.data : compute.error.code,
            nestedProposalCode: nestedProposal.ok ? null : nestedProposal.error.code,
            directProposalCode: directProposalCode ?? null,
            jobEcho: job.ok ? job.result.output.echo : job.error.code,
          });
        } }],
        async dispose() {},
      }),
    },
  });
  const host = {
    ...readContext(), access: "owner" as const,
    async propose(operations: ChangeOperation[]): Promise<ChangeProposal> {
      hostProposalCalls += 1;
      return { id: "unexpected-proposal", snapshot, operations, source: "module" };
    },
  };
  try {
    assert.deepEqual(handlerRuntime.httpContributions("publishing"), []);
    await handlerRuntime.activate("publishing");
    assert.equal(handlerRuntime.httpContributions("publishing")[0]?.effect, "compute");
    const response = await handlerRuntime.invokeHttp("publishing", "qa-stream", new Request("http://localhost/qa/stream", { method: "POST" }), host);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      read: { source: "read" },
      compute: { source: "compute" },
      nestedProposalCode: "action_effect_denied",
      directProposalCode: "action_effect_denied",
      jobEcho: { source: "http-compute" },
    });
    assert.equal(proposeActionCalls, 0, "compute HTTP cannot dispatch propose actions");
    assert.equal(hostProposalCalls, 0, "compute HTTP cannot use the proposal coordinator");
  } finally {
    await handlerRuntime.shutdown();
  }
});

test("public compute HTTP contribution definitions are rejected", async () => {
  const metadata = manifest("publishing");
  const runtime = new ModuleRuntime({
    manifests: [metadata], enabled: ["publishing"], cacheDirectory: "/tmp/scriptorium-runtime-test",
    loaders: { publishing: async () => ({
      manifest: metadata, actions: [], ui: [],
      http: [{ id: "public-compute", path: "public/qa", methods: ["POST"], access: "public", effect: "compute", async handle() { return Response.json({}); } }],
      async dispose() {},
    }) },
  });
  try {
    await assert.rejects(runtime.activate("publishing"), (error: unknown) =>
      error instanceof ModuleRuntimeError && error.code === "invalid_module_definition");
  } finally {
    await runtime.shutdown();
  }
});

test("owner compute HTTP contributions cannot use GET or HEAD", async () => {
  for (const method of ["GET", "HEAD"] as const) {
    const metadata = manifest("publishing");
    const runtime = new ModuleRuntime({
      manifests: [metadata], enabled: ["publishing"], cacheDirectory: "/tmp/scriptorium-runtime-test",
      loaders: { publishing: async () => ({
        manifest: metadata, actions: [], ui: [],
        http: [{
          id: `compute-${method.toLowerCase()}`, path: `unsafe/compute-${method.toLowerCase()}`,
          methods: [method], access: "owner", effect: "compute", async handle() { return Response.json({}); },
        }],
        async dispose() {},
      }) },
    });
    try {
      await assert.rejects(runtime.activate("publishing"), (error: unknown) =>
        error instanceof ModuleRuntimeError && error.code === "invalid_module_definition",
        `compute ${method} must not bypass write-method CSRF checks`);
    } finally {
      await runtime.shutdown();
    }
  }
});

async function readMcpSseResult(response: Response): Promise<{
  result: { serverInfo?: { name: string }; tools?: Array<{ name: string }> };
}> {
  const reader = response.body?.getReader();
  assert.ok(reader, "MCP request should return an event stream");
  const decoder = new TextDecoder();
  let event = "";
  try {
    while (!event.includes("\n\n")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, "MCP event stream ended before returning the request result");
      event += decoder.decode(chunk.value, { stream: true });
    }
    const data = event.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    assert.ok(data, "MCP event stream should contain a JSON-RPC result");
    return JSON.parse(data);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

test("the production MCP module activates and serves tools through Streamable HTTP", async () => {
  const metadata = manifest("mcp", { serverEntry: "./dist/index.js" });
  const runtime = new ModuleRuntime({
    manifests: [metadata], enabled: ["mcp"], cacheDirectory: "/tmp/scriptorium-runtime-test",
    loaders: { mcp: async (context) => {
      const { createModule } = await import("../../../modules/mcp/src/index.js");
      return createModule(context);
    } },
  });
  const host = { ...readContext(), access: "owner" as const, actions: [] };
  try {
    await runtime.activate("mcp");
    assert.deepEqual(runtime.httpContributions("mcp"), [{
      id: "streamable", path: "streamable", methods: ["GET", "POST", "DELETE"], access: "owner", effect: "propose",
    }]);
    const endpoint = "http://scriptorium.test/api/projects/project-1/modules/mcp/streamable";
    const post = (message: unknown, sessionId?: string) => runtime.invokeHttp("mcp", "streamable", new Request(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream", "content-type": "application/json",
        ...(sessionId ? { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-03-26" } : {}),
      },
      body: JSON.stringify(message),
    }), host);
    const initialize = await post({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "module-runtime-test", version: "0.1.0" } },
    });
    assert.equal(initialize.status, 200);
    const sessionId = initialize.headers.get("mcp-session-id");
    assert.ok(sessionId);
    const initialization = await readMcpSseResult(initialize);
    assert.equal(initialization.result.serverInfo?.name, "scriptorium-mcp");

    const initialized = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
    assert.equal(initialized.status, 202);
    const listed = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sessionId);
    assert.equal(listed.status, 200);
    const toolList = await readMcpSseResult(listed);
    assert.ok(toolList.result.tools?.some(({ name }) => name === "get_status"));

    const eventStream = await runtime.invokeHttp("mcp", "streamable", new Request(endpoint, {
      method: "GET", headers: {
        accept: "text/event-stream", "mcp-session-id": sessionId, "mcp-protocol-version": "2025-03-26",
      },
    }), host);
    assert.equal(eventStream.status, 200);
    await eventStream.body?.cancel();
  } finally {
    await runtime.shutdown();
  }
});

test("module disable bounds a non-cooperative action drain and rejects late proposals", async () => {
  const metadata = manifest("assistant");
  let proposalCalls = 0;
  let finishAction: (() => void) | undefined;
  const runtime = new ModuleRuntime({
    manifests: [metadata], enabled: ["assistant"], cacheDirectory: "/tmp/scriptorium-runtime-test", moduleDrainTimeoutMs: 20,
    loaders: { assistant: async () => definition(metadata, {
      id: "assistant.wait",
      effect: "propose",
      inputSchema: schema,
      outputSchema: schema,
      async invoke(_input, action) {
        await new Promise<void>((resolve) => { finishAction = resolve; });
        await action.propose([proposalOperation()]);
        return { ok: true, snapshot: action.reader.snapshot, data: {} };
      },
    }) },
  });
  const host = { ...readContext(), async propose(): Promise<ChangeProposal> {
    proposalCalls += 1;
    return { id: "proposal-late", snapshot, operations: [], source: "module" };
  } };
  const invocation = runtime.invokeAction("assistant", "assistant.wait", {}, host);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await assert.rejects(runtime.disable("assistant"), (error: unknown) => error instanceof ModuleRuntimeError && error.code === "module_drain_timeout");
  finishAction?.();
  const result = await invocation;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "action_cancelled");
  assert.equal(proposalCalls, 0);
  assert.equal(runtime.status("assistant").availability, "disabled");
  await runtime.shutdown();
});

test("a late non-cooperative action cannot return success after disable times out", async () => {
  const metadata = manifest("assistant");
  let finishAction: (() => void) | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const runtime = new ModuleRuntime({
    manifests: [metadata], enabled: ["assistant"], cacheDirectory: "/tmp/scriptorium-runtime-test", moduleDrainTimeoutMs: 20,
    loaders: { assistant: async () => definition(metadata, {
      id: "assistant.late-data",
      effect: "compute",
      inputSchema: schema,
      outputSchema: schema,
      async invoke(_input, action) {
        await new Promise<void>((resolve) => {
          finishAction = resolve;
          markStarted();
        });
        return { ok: true, snapshot: action.reader.snapshot, data: { stale: true } };
      },
    }) },
  });

  const invocation = runtime.invokeAction("assistant", "assistant.late-data", {}, readContext());
  await started;
  await assert.rejects(runtime.disable("assistant"), (error: unknown) => error instanceof ModuleRuntimeError && error.code === "module_drain_timeout");
  finishAction?.();
  const result = await invocation;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "action_cancelled");
  await runtime.shutdown();
});

test("a late HTTP handler cannot return a response after module disable", async () => {
  const metadata = manifest("assistant");
  let finishHandler: ((response: Response) => void) | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const runtime = new ModuleRuntime({
    manifests: [metadata], enabled: ["assistant"], cacheDirectory: "/tmp/scriptorium-runtime-test", moduleDrainTimeoutMs: 20,
    loaders: { assistant: async () => ({
      manifest: metadata,
      actions: [],
      ui: [],
      http: [{ id: "late-response", path: "late", methods: ["GET"], access: "owner", effect: "read", async handle() {
        const response = new Promise<Response>((resolve) => { finishHandler = resolve; });
        markStarted();
        return response;
      } }],
      async dispose() {},
    }) },
  });
  const host = { ...readContext(), access: "owner" as const };
  const invocation = runtime.invokeHttp("assistant", "late-response", new Request("http://localhost/late"), host);
  await started;
  await assert.rejects(runtime.disable("assistant"), (error: unknown) => error instanceof ModuleRuntimeError && error.code === "module_drain_timeout");
  finishHandler?.(new Response("late"));
  const response = await invocation;
  assert.equal(response.status, 499);
  await runtime.shutdown();
});

function jobRequest(module: ModuleId, options: Partial<JobRequest> = {}): JobRequest {
  return {
    id: `job-${Math.random().toString(16).slice(2)}`,
    module,
    task: "echo",
    snapshot,
    model: "fixture",
    modelVersion: "1",
    moduleVersion: "0.1.0",
    deadline: Date.now() + 5000,
    input: { value: "hello" },
    ...options,
  };
}

test("composition contributions validate kind and host contexts independently of placement", async () => {
  const metadata = manifest("search");
  const action: ModuleAction = { id: "lookup", effect: "read", inputSchema: schema, outputSchema: schema,
    async invoke(_input, context) { return { ok: true, snapshot: context.reader.snapshot }; } };
  for (const invalid of [null, { contractVersion: 2 }, { kind: "script" }, { contexts: [] }, { contexts: ["editor", "editor"] }, { contexts: ["foreign"] }, { multipleInstances: "yes" }]) {
    const runtime = new ModuleRuntime({ manifests: [metadata], enabled: ["search"], cacheDirectory: "/tmp/scriptorium-composition-test",
      loaders: { search: async () => ({ ...definition(metadata, action), ui: [{
        id: "search.terms", module: "search", slot: "editor", title: "Terms", action: "lookup",
        contractVersion: 1, kind: "editor-adornment", contexts: ["editor", "reading"], ...(invalid ?? {}),
      } as never] }) },
    });
    if (invalid === null) {
      await runtime.activate("search");
      assert.equal(runtime.contributions("search")[0]?.kind, "editor-adornment");
    } else {
      await assert.rejects(runtime.activate("search"), (error: unknown) => error instanceof ModuleRuntimeError && error.code === "invalid_module_definition");
    }
    await runtime.shutdown();
  }
});
