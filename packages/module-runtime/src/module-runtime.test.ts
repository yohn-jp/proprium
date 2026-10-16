import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { ActionResult, ChangeOperation, ChangeProposal, JobRequest, ModuleAction, ModuleActionContext, ModuleDefinition, ModuleId, ModuleManifest, SnapshotId, ValueSchema, WorkerService } from "@scriptorium/contracts";
import { createStoryActions } from "../../../modules/story/src/actions.js";
import { ModuleRuntime, ModuleRuntimeError, resolveModulePlan, SharedCapabilityPool, type WorkerJobLifecycleSnapshot } from "./index.js";

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
