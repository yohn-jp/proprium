import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { ActionResult, ChangeOperation, ChangeProposal, JobRequest, ModuleAction, ModuleActionContext, ModuleDefinition, ModuleId, ModuleManifest, SnapshotId, ValueSchema, WorkerService } from "@scriptorium/contracts";
import { ModuleRuntime, ModuleRuntimeError, resolveModulePlan, SharedCapabilityPool } from "./index.js";

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
          await actionContext.propose([operation]);
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
    async propose(operations: ChangeOperation[]): Promise<ChangeProposal> {
      return { id: "proposal-1", snapshot, operations, source: "module" };
    },
  };
  const result = await runtime.invokeAction("story", "propose", {}, host);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) {
    assert.deepEqual(result.proposals, [{ id: "proposal-1", snapshot, operations: [operation], source: "module" }]);
  }
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
  assert.equal(result.ok, true);
  assert.equal(runtime.status("speaker").availability, "disabled");
  assert.equal(runtime.workerSupervisor.activeJobCount, 0);
  assert.equal(disposed, 1);
  assert.deepEqual(authorData, { correction: "keep this author-owned value" });
  assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
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
