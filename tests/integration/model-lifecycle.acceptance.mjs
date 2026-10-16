import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { test } from "node:test";

import { CoreStore } from "../../packages/core/dist/index.js";
import { ModuleRuntime } from "../../packages/module-runtime/dist/index.js";

const execFile = promisify(execFileCallback);
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const defaultModelCache = "/tmp/scriptorium-model-runtime-edc033c/home/.arcadia/models";
const modelCache = resolve(process.env.SCRIPTORIUM_P13_MODEL_CACHE ?? defaultModelCache);
const semanticCapability = "semantic.embedding";
const capabilityValueIds = new WeakMap();
let nextCapabilityValueId = 1;
const semanticSettingsPath = "meta/scriptorium/modules/semantic/settings.json";
const semanticDismissalsPath = "meta/scriptorium/modules/semantic/contradiction-dismissals.jsonl";
const nlpSettingsPath = "meta/scriptorium/modules/nlp/feature-settings.json";
const workerFiles = {
  story: join(root, "modules/story/dist/worker.js"),
  nlp: join(root, "modules/nlp/dist/worker.js"),
  diagnostics: join(root, "modules/diagnostics/dist/worker.js"),
  semantic: join(root, "modules/semantic/dist/worker.js"),
};

async function git(cwd, ...args) {
  const { stdout } = await execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

async function writeText(directory, relativePath, content) {
  const path = join(directory, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function writeYaml(directory, relativePath, value) {
  // JSON is a valid YAML subset and avoids adding a root test dependency.
  await writeText(directory, relativePath, `${JSON.stringify(value)}\n`);
}

async function createSyntheticRepository(directory) {
  const remote = join(directory, "remote.git");
  const seed = join(directory, "seed");
  await mkdir(seed, { recursive: true });
  await git(directory, "init", "--bare", "--initial-branch=main", remote);
  await git(seed, "init", "--initial-branch=main");
  await git(seed, "config", "user.name", "P13 Synthetic Author");
  await git(seed, "config", "user.email", "p13-author@example.test");

  await writeYaml(seed, "meta/project.yaml", { id: "p13-model-lifecycle", title: "Synthetic model lifecycle work" });
  await writeYaml(seed, "plot/volumes/v1/volume.yaml", { id: "vol-one", name: "第一巻", order: 1 });
  await writeYaml(seed, "plot/volumes/v1/chapters/c1/chapter.yaml", { id: "ch-one", title: "第一章", volume: "vol-one", order: 1 });

  const sceneCount = Number(process.env.SCRIPTORIUM_P13_SCENE_COUNT ?? 240);
  assert.ok(Number.isSafeInteger(sceneCount) && sceneCount >= 16 && sceneCount <= 1200, "scene count must be between 16 and 1200");
  for (let index = 0; index < sceneCount; index += 1) {
    const suffix = String(index).padStart(4, "0");
    const sceneId = `sc-${suffix}`;
    const manuscriptPath = `manuscript/v1/c1/${sceneId}.md`;
    await writeYaml(seed, `plot/volumes/v1/chapters/c1/scenes/${sceneId}.yaml`, {
      id: sceneId, type: "scene", name: `駅の場面 ${suffix}`, chapter: "ch-one", order: index + 1,
      manuscript: manuscriptPath,
    });
    const body = `夜遅く駅に着き、青い切符を握りしめた。静かなホームで遠い汽笛を聞いた。${index % 2 === 0 ? "雨上がりの路地に白い花が咲いた。" : "朝の市場で赤い林檎を買った。"}`;
    await writeText(seed, manuscriptPath, `---\ntitle: ${sceneId}\n---\n${body}\n`);
  }

  await writeText(seed, nlpSettingsPath, `${JSON.stringify({
    externalEnabled: { "setting-qa": false, rewrite: false },
    ownerNote: "preserve-local-consent",
  }, null, 2)}\n`);
  await writeText(seed, semanticSettingsPath, `${JSON.stringify({ schemaVersion: 1, rerankerEnabled: false }, null, 2)}\n`);
  const dismissal = `${JSON.stringify({ candidateId: "author-dismissed-p13-fixture", timestamp: "2026-10-17T00:00:00.000Z" })}\n`;
  await writeText(seed, semanticDismissalsPath, dismissal);

  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "Seed synthetic P13 model lifecycle work");
  await git(seed, "remote", "add", "origin", remote);
  await git(seed, "push", "-u", "origin", "main");
  await git(directory, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
  return remote;
}

async function packageManifest(id) {
  const path = join(root, "modules", id, "package.json");
  const parsed = JSON.parse(await readFile(path, "utf8"));
  assert.equal(parsed.name, `@scriptorium/module-${id}`);
  assert.equal(parsed.scriptoriumModule?.id, id);
  return parsed.scriptoriumModule;
}

function moduleLoader(id) {
  const entry = new URL(`../../modules/${id}/dist/index.js`, import.meta.url).href;
  return async (context) => {
    const module = await import(entry);
    assert.equal(typeof module.createModule, "function", `${id} must use its compiled production factory`);
    return module.createModule(context);
  };
}

function createGate() {
  let resolve;
  let opened = false;
  const promise = new Promise((done) => { resolve = done; });
  return {
    promise,
    open() {
      if (opened) return;
      opened = true;
      resolve();
    },
  };
}

function observingLoader(id, events, acquireGates = []) {
  const load = moduleLoader(id);
  const pendingAcquireGates = [...acquireGates];
  return async (context) => load({
    ...context,
    async acquireCapability(capabilityId) {
      const lease = await context.acquireCapability(capabilityId);
      if (capabilityId === semanticCapability) {
        let valueId = capabilityValueIds.get(lease.value);
        if (valueId === undefined) {
          valueId = nextCapabilityValueId++;
          capabilityValueIds.set(lease.value, valueId);
        }
        events.push({ module: id, phase: "acquired", value: lease.value, valueId, at: performance.now() });
        const acquireGate = pendingAcquireGates.shift();
        if (acquireGate) await acquireGate.promise;
        events.push({ module: id, phase: "returned", value: lease.value, valueId, at: performance.now() });
        return {
          value: lease.value,
          async release() {
            events.push({ module: id, phase: "released", value: lease.value, valueId, at: performance.now() });
            await lease.release();
          },
        };
      }
      return lease;
    },
  });
}

async function waitFor(predicate, message, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(message);
}

async function readOwnedProcess(pid) {
  try {
    const [status, command] = await Promise.all([
      readFile(`/proc/${pid}/status`, "utf8"),
      readFile(`/proc/${pid}/cmdline`),
    ]);
    const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    return {
      pid,
      rssMiB: rss ? Number(rss[1]) / 1024 : 0,
      command: command.toString("utf8").split("\0").filter(Boolean).join(" "),
    };
  } catch {
    return undefined;
  }
}

async function findWorkerPid(runtime, workerEntry) {
  return (await findWorkerPids(runtime, workerEntry))[0];
}

async function findWorkerPids(runtime, workerEntry) {
  const observed = await Promise.all(runtime.workerSupervisor.activeWorkerPids.map(readOwnedProcess));
  return observed.filter((process) => process?.command.includes(workerEntry)).map(({ pid }) => pid);
}

async function ownedMetrics(runtime) {
  const pids = [...new Set(runtime.workerSupervisor.activeWorkerPids)];
  const processes = (await Promise.all(pids.map(readOwnedProcess))).filter(Boolean);
  const semanticProcesses = processes.filter((process) => process.command.includes(workerFiles.semantic));
  return {
    processCount: processes.length,
    pids: processes.map(({ pid }) => pid),
    rssMiB: Number(processes.reduce((total, process) => total + process.rssMiB, 0).toFixed(1)),
    semanticWorkerCount: semanticProcesses.length,
    semanticWorkerPids: semanticProcesses.map(({ pid }) => pid),
    semanticWorkerRssMiB: Number(semanticProcesses.reduce((total, process) => total + process.rssMiB, 0).toFixed(1)),
    processes,
  };
}

function makeResourceSampler(runtime) {
  let phase = "setup";
  let peakRssMiB = 0;
  let peakProcessCount = 0;
  let peakSemanticWorkerCount = 0;
  let peakSemanticWorkerRssMiB = 0;
  let sampleFailure;
  let maxEventLoopDelayMs = 0;
  let expectedTick = performance.now() + 50;
  const lagTimer = setInterval(() => {
    const now = performance.now();
    maxEventLoopDelayMs = Math.max(maxEventLoopDelayMs, now - expectedTick);
    expectedTick = now + 50;
  }, 50);
  lagTimer.unref();
  let sampling = true;
  const samplingPromise = (async () => {
    while (sampling) {
      try {
        const metrics = await ownedMetrics(runtime);
        peakRssMiB = Math.max(peakRssMiB, metrics.rssMiB);
        peakProcessCount = Math.max(peakProcessCount, metrics.processCount);
        peakSemanticWorkerCount = Math.max(peakSemanticWorkerCount, metrics.semanticWorkerCount);
        peakSemanticWorkerRssMiB = Math.max(peakSemanticWorkerRssMiB, metrics.semanticWorkerRssMiB);
      } catch (error) {
        sampleFailure ??= error;
      }
      await delay(100);
    }
  })();
  return {
    setPhase(value) {
      phase = value;
      peakRssMiB = 0;
      peakProcessCount = 0;
      peakSemanticWorkerCount = 0;
      peakSemanticWorkerRssMiB = 0;
      maxEventLoopDelayMs = 0;
      expectedTick = performance.now() + 50;
    },
    async mark() {
      const metrics = await ownedMetrics(runtime);
      return {
        phase,
        ...metrics,
        peakRssMiB: Number(peakRssMiB.toFixed(1)),
        peakProcessCount,
        peakSemanticWorkerCount,
        peakSemanticWorkerRssMiB: Number(peakSemanticWorkerRssMiB.toFixed(1)),
        maxEventLoopDelayMs: Number(maxEventLoopDelayMs.toFixed(1)),
      };
    },
    async stop() {
      sampling = false;
      clearInterval(lagTimer);
      await samplingPromise;
      if (sampleFailure) throw sampleFailure;
    },
  };
}

function actionHost(projectId, reader, signal) {
  return {
    projectId,
    reader,
    signal,
    access: "owner",
    async propose() { throw new Error("This read-only model lifecycle fixture must not propose changes"); },
  };
}

function actionData(result, name) {
  assert.equal(result.ok, true, `${name} failed: ${JSON.stringify(result.error)}`);
  return result.data;
}

async function requireModelArtifacts() {
  const required = [
    join(modelCache, "Xenova/multilingual-e5-small/761b726dd34fb83930e26aab4e9ac3899aa1fa78"),
    join(modelCache, "mogolloni/bge-reranker-v2-m3-onnx/e5023553f6c47f09057da7a19cdd79ef850a4985"),
    join(root, "modules/nlp/node_modules/lindera-wasm-nodejs-ipadic/package.json"),
  ];
  for (const path of required) {
    const info = await stat(path);
    assert.ok(info.isDirectory() || info.isFile(), `required pinned model/engine artifact is missing: ${path}`);
  }
}

test("P13 actual module consumers share and release pinned CPU model workers", { timeout: 15 * 60_000 }, async () => {
  await requireModelArtifacts();
  const rootDirectory = await mkdtemp(join(tmpdir(), "scriptorium-p13-lifecycle-"));
  const remote = await createSyntheticRepository(rootDirectory);
  const dataDirectory = join(rootDirectory, "core-data");
  const runtimeCache = join(rootDirectory, "runtime-cache");
  const modelLink = join(runtimeCache, "semantic", "semantic", "models");
  await mkdir(dirname(modelLink), { recursive: true });
  await symlink(modelCache, modelLink, "dir");

  const store = new CoreStore({ dataDir: dataDirectory, allowLocalRemotes: true });
  const project = await store.registerProject({ url: remote });
  const observed = await store.observe(project.id);
  assert.equal(observed.state, "fresh");
  const reader = await store.reader(project.id, "remote", observed.snapshot);
  const capabilityEvents = [];
  const diagnosticAcquireGate = createGate();
  const diagnosticRebuildAcquireGate = createGate();
  const semanticAcquireGate = createGate();
  const manifests = await Promise.all(["story", "nlp", "diagnostics", "semantic"].map(packageManifest));
  const runtime = new ModuleRuntime({
    manifests,
    enabled: ["story", "diagnostics"],
    cacheDirectory: runtimeCache,
    loaders: {
      story: moduleLoader("story"),
      nlp: moduleLoader("nlp"),
      diagnostics: observingLoader("diagnostics", capabilityEvents, [diagnosticAcquireGate, diagnosticRebuildAcquireGate]),
      semantic: observingLoader("semantic", capabilityEvents, [semanticAcquireGate]),
    },
    workerEntries: Object.fromEntries(Object.entries(workerFiles).map(([id, path]) => [id, path])),
  });
  const resources = makeResourceSampler(runtime);
  const metrics = [];
  const host = (signal = new AbortController().signal) => actionHost(project.id, reader, signal);
  let storyStatus;
  try {
    assert.equal(runtime.status("semantic").availability, "disabled");
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, [], "installed but disabled modules start no worker or model process");
    resources.setPhase("installed-disabled");
    metrics.push(await resources.mark());

    const storyTree = actionData(await runtime.invokeAction("story", "story.volumes.tree", {}, host()), "story.volumes.tree");
    assert.ok(storyTree);
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, [], "compiled Story read remains worker-free");
    const consent = actionData(await runtime.invokeAction("nlp", "nlp.features", {}, host()), "nlp.features");
    assert.equal(consent.features.find((feature) => feature.id === "setting-qa")?.enabled, false);
    const savedDismissals = await reader.read(semanticDismissalsPath);
    assert.ok(savedDismissals);
    const savedConsent = await reader.read(nlpSettingsPath);
    const savedSettings = await reader.read(semanticSettingsPath);
    assert.ok(savedConsent && savedSettings);
    assert.equal(runtime.status("semantic").availability, "disabled");
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, [], "actual metadata and settings reads do not load the semantic model");

    runtime.enable("semantic");
    assert.equal(runtime.status("semantic").availability, "enabled-idle");
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, [], "enabled-idle semantic module remains lazy");
    const semanticSettings = actionData(await runtime.invokeAction("semantic", "semantic.settings.read", {}, host()), "semantic.settings.read");
    assert.deepEqual(semanticSettings.settings, { schemaVersion: 1, rerankerEnabled: false });
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, [], "semantic settings read does not load the model worker");
    resources.setPhase("enabled-idle");
    metrics.push(await resources.mark());

    resources.setPhase("concurrent-index-and-diagnostics");
    const diagnosticPromise = runtime.invokeAction("diagnostics", "diagnostics.analyze", {
      text: "彼は悲しい。彼は悲しい。彼は悲しい。", sceneId: "sc-0000",
    }, host());
    await waitFor(() => capabilityEvents.some((event) => event.module === "diagnostics" && event.phase === "acquired"), "diagnostics did not acquire the actual semantic capability");

    const cancelController = new AbortController();
    const cancelledSemanticPromise = runtime.invokeAction("semantic", "semantic.index.rebuild", { taskId: "p13-cancel-queued-consumer" }, host(cancelController.signal));
    await waitFor(() => capabilityEvents.some((event) => event.module === "semantic" && event.phase === "acquired"), "semantic did not acquire the same capability instance");
    const firstSemanticLease = capabilityEvents.find((event) => event.module === "semantic" && event.phase === "acquired");
    const diagnosticLease = capabilityEvents.find((event) => event.module === "diagnostics" && event.phase === "acquired");
    assert.ok(firstSemanticLease && diagnosticLease);
    assert.equal(firstSemanticLease.value, diagnosticLease.value,
      `the actual semantic and diagnostics modules receive the same capability instance: ${JSON.stringify({
        events: capabilityEvents.map(({ module, phase, valueId }) => ({ module, phase, valueId })),
        activeWorkerPids: runtime.workerSupervisor.activeWorkerPids,
      })}`);
    diagnosticAcquireGate.open();
    await waitFor(() => runtime.workerSupervisor.activeJobCountFor("semantic") > 0, "diagnostics did not start actual semantic model work");
    const sharedPid = await findWorkerPid(runtime, workerFiles.semantic);
    assert.ok(sharedPid, "the shared actual semantic worker process must be observable");
    const processBeforeCancel = await readOwnedProcess(sharedPid);
    assert.ok(processBeforeCancel);
    semanticAcquireGate.open();
    await delay(100);
    assert.deepEqual(await findWorkerPids(runtime, workerFiles.semantic), [sharedPid],
      "concurrent Diagnostics and Semantic consumers must share one real semantic worker PID");
    cancelController.abort(new Error("P13 acceptance cancels only the queued semantic consumer"));
    assert.ok(runtime.workerSupervisor.activeWorkerPids.includes(sharedPid), "canceling the queued consumer must not kill the active diagnostics worker");

    const diagnostics = actionData(await diagnosticPromise, "diagnostics.analyze");
    assert.ok(diagnostics.analysis.habitualPhraseWarnings.some((warning) => warning.phrase === "彼は悲しい"));
    assert.deepEqual(diagnostics.semanticEmbedding, {
      model: "Xenova/multilingual-e5-small",
      modelVersion: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
      dimensions: 384,
    });
    const cancelledSemantic = await cancelledSemanticPromise;
    assert.equal(cancelledSemantic.ok, false, "the queued semantic consumer should observe its own cancellation");
    assert.ok(await findWorkerPid(runtime, workerFiles.semantic) === undefined, "the last actual capability release must end the persistent semantic child");
    metrics.push(await resources.mark());

    const semanticIndexStatus = actionData(await runtime.invokeAction("semantic", "semantic.index.status", {}, host()), "semantic.index.status");
    assert.equal(semanticIndexStatus.indexAvailable, true);
    const repositoryKey = createHash("sha256").update(JSON.stringify([
      reader.snapshot.repository.provider,
      reader.snapshot.repository.ownerScope,
      reader.snapshot.repository.repositoryId,
      reader.snapshot.repository.defaultBranch,
    ])).digest("hex");
    const modelKey = createHash("sha256").update("Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78").digest("hex").slice(0, 24);
    const derivedIndex = join(runtimeCache, "semantic", "semantic", "indexes", `${repositoryKey}-${modelKey}.json`);
    assert.ok((await stat(derivedIndex)).isFile(), "actual semantic derived index must be present before deletion");
    await rm(derivedIndex);
    const missingIndex = actionData(await runtime.invokeAction("semantic", "semantic.index.status", {}, host()), "semantic.index.status");
    assert.equal(missingIndex.indexAvailable, false, "deleting the derived cache must make the real worker report it missing");

    resources.setPhase("concurrent-disable-and-cache-rebuild");
    const disablingDiagnosticPromise = runtime.invokeAction("diagnostics", "diagnostics.analyze", {
      text: "彼は悲しい。彼は悲しい。彼は悲しい。", sceneId: "sc-0000",
    }, host());
    await waitFor(() => capabilityEvents.filter((event) => event.module === "diagnostics" && event.phase === "acquired").length >= 2,
      "diagnostics did not acquire the replacement capability before the concurrent rebuild");
    const rebuildPromise = runtime.invokeAction("semantic", "semantic.index.rebuild", { taskId: "p13-cache-rebuild" }, host());
    await waitFor(() => runtime.workerSupervisor.activeJobCountFor("semantic") > 0, "semantic cache rebuild did not start actual model work");
    const rebuildPid = await findWorkerPid(runtime, workerFiles.semantic);
    assert.ok(rebuildPid && rebuildPid !== sharedPid, "a released semantic capability must be replaced by a new worker process");
    diagnosticRebuildAcquireGate.open();
    await waitFor(() => capabilityEvents.filter((event) => event.module === "diagnostics" && event.phase === "returned").length >= 2,
      "diagnostics did not receive its actual lease during the semantic rebuild");
    await delay(0);
    assert.deepEqual(await findWorkerPids(runtime, workerFiles.semantic), [rebuildPid],
      "the rebuilding Semantic consumer and Diagnostics lease must share one real worker PID");
    const disablePromise = runtime.disable("diagnostics");
    assert.ok(runtime.workerSupervisor.activeWorkerPids.includes(rebuildPid), "disabling diagnostics must leave the active semantic child alive");
    const rebuilt = actionData(await rebuildPromise, "semantic.index.rebuild");
    assert.ok(rebuilt.embedded > 0, "rebuilding after deletion must run the actual pinned embedding model again");
    const disabledDiagnostic = await disablingDiagnosticPromise;
    await disablePromise;
    assert.equal(disabledDiagnostic.ok, false, "disabling diagnostics must cancel its queued consumer while semantic continues");
    assert.equal(runtime.status("diagnostics").availability, "disabled");
    assert.ok((await stat(derivedIndex)).isFile(), "the real index worker must recreate the deleted derived cache");
    metrics.push(await resources.mark());

    const settingsAfter = await reader.read(semanticSettingsPath);
    const dismissalsAfter = await reader.read(semanticDismissalsPath);
    const consentAfter = await reader.read(nlpSettingsPath);
    assert.equal(settingsAfter?.content, savedSettings.content, "module enable/disable and cache rebuild must preserve author settings");
    assert.equal(dismissalsAfter?.content, savedDismissals.content, "module enable/disable and cache rebuild must preserve author dismissals");
    assert.equal(consentAfter?.content, savedConsent.content, "module enable/disable and cache rebuild must preserve external consent settings");

    await runtime.disable("semantic");
    await waitFor(() => runtime.workerSupervisor.activeWorkerPids.length === 0, "last semantic lease did not release its worker PID");
    resources.setPhase("after-disable-before-replacement");
    metrics.push(await resources.mark());

    runtime.enable("semantic");
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, [], "re-enabled module must remain model-free until an action needs it");
    resources.setPhase("replacement-inference-e5-bge");
    const replacement = runtime.invokeAction("semantic", "semantic.search", {
      query: "夜遅く駅に着き、青い切符を握りしめた", mode: "scene", limit: 5, rerank: true,
    }, host());
    await waitFor(() => runtime.workerSupervisor.activeWorkerPids.length > 0, "replacement semantic worker did not start");
    const replacementPid = runtime.workerSupervisor.activeWorkerPids[0];
    assert.ok(replacementPid && replacementPid !== sharedPid, "replacement activation must create a fresh worker PID");
    const replacementData = actionData(await replacement, "semantic.search");
    assert.equal(replacementData.modelVersion, "761b726dd34fb83930e26aab4e9ac3899aa1fa78");
    assert.equal(replacementData.reranker?.id, "mogolloni/bge-reranker-v2-m3-onnx");
    assert.equal(replacementData.reranker?.version, "e5023553f6c47f09057da7a19cdd79ef850a4985");
    assert.equal(replacementData.rerankWarning, undefined, "the exact pinned BGE ONNX external-data model must complete CPU reranking");
    metrics.push(await resources.mark());
    await waitFor(() => runtime.workerSupervisor.activeWorkerPids.length === 0, "replacement worker remained after its final capability consumer released it");
    resources.setPhase("after-replacement-release");
    metrics.push(await resources.mark());

    storyStatus = runtime.status("story").availability;
    assert.equal(storyStatus, "enabled-idle");
    console.log("P13 model lifecycle observations:", JSON.stringify({
      evidenceBase: "55cecfa5af73982d2b98009c125928f1ab3126c5",
      hostOnly: true,
      modelCache,
      modelRefs: {
        embedding: "Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78",
        reranker: "mogolloni/bge-reranker-v2-m3-onnx@e5023553f6c47f09057da7a19cdd79ef850a4985",
      },
      storyAvailabilityAfter: storyStatus,
      observations: metrics,
    }, null, 2));
  } finally {
    diagnosticAcquireGate.open();
    diagnosticRebuildAcquireGate.open();
    semanticAcquireGate.open();
    await resources.stop();
    await runtime.shutdown();
    await rm(rootDirectory, { recursive: true, force: true });
  }
});
