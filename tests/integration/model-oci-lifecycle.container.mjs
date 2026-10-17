import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

const OUTPUT_DIRECTORY = "/p13-output";
const API_ORIGIN = "http://127.0.0.1:3000";
const PROJECT_ID = process.env.P13_PROJECT_ID;
const AUTH_TOKEN = process.env.SCRIPTORIUM_AUTH_TOKEN;
const MODEL_IDS = {
  embedding: { id: "Xenova/multilingual-e5-small", revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78" },
  reranker: { id: "mogolloni/bge-reranker-v2-m3-onnx", revision: "e5023553f6c47f09057da7a19cdd79ef850a4985" },
};
const EXPECTED_MODULES = ["story", "nlp", "diagnostics", "semantic", "speaker", "assistant", "publishing", "mcp"];
const SETTINGS_PATHS = [
  "meta/scriptorium/modules/nlp/feature-settings.json",
  "meta/scriptorium/modules/semantic/settings.json",
  "meta/scriptorium/modules/semantic/contradiction-dismissals.jsonl",
];

assert.ok(PROJECT_ID && /^[0-9a-f-]{36}$/iu.test(PROJECT_ID), "project fixture ID is required");
assert.ok(AUTH_TOKEN && AUTH_TOKEN.length >= 32, "API auth token is required");

function waitGate() {
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

async function waitFor(predicate, message, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(message);
}

async function readProcess(pid) {
  try {
    const [status, rawCommand] = await Promise.all([
      readFile("/proc/" + pid + "/status", "utf8"),
      readFile("/proc/" + pid + "/cmdline"),
    ]);
    const rss = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(status);
    const command = rawCommand.toString("utf8").split("\0").filter(Boolean).join(" ");
    return { pid: Number(pid), rssMiB: rss ? Number(rss[1]) / 1024 : 0, command };
  } catch {
    return undefined;
  }
}

async function readCgroupValue(name) {
  try {
    return (await readFile("/sys/fs/cgroup/" + name, "utf8")).trim();
  } catch {
    return null;
  }
}

async function captureMetrics(runtime, workerEntries) {
  const pids = [];
  for (const entry of await import("node:fs/promises").then(({ readdir }) => readdir("/proc"))) {
    if (/^\d+$/u.test(entry)) pids.push(entry);
  }
  const processes = (await Promise.all(pids.map(readProcess))).filter(Boolean);
  const runtimePids = runtime ? [...new Set(runtime.workerSupervisor.activeWorkerPids)] : [];
  const workerRows = processes.filter((process) =>
    Object.values(workerEntries).some((entry) => entry && process.command.includes(entry))
  );
  const semanticEntry = workerEntries.semantic;
  const semanticRows = workerRows.filter((process) => semanticEntry && process.command.includes(semanticEntry));
  const runtimeRows = processes.filter((process) => runtimePids.includes(process.pid));
  return {
    at: new Date().toISOString(),
    processCount: processes.length,
    aggregateRssMiB: Number(processes.reduce((sum, process) => sum + process.rssMiB, 0).toFixed(1)),
    supervisedWorkerCount: runtime ? runtimePids.length : null,
    supervisedWorkerPids: runtimePids,
    supervisedWorkerRssMiB: runtime ? Number(runtimeRows.reduce((sum, process) => sum + process.rssMiB, 0).toFixed(1)) : null,
    compiledWorkerCount: workerRows.length,
    compiledWorkers: workerRows.map((process) => ({ pid: process.pid, rssMiB: Number(process.rssMiB.toFixed(1)), module: Object.entries(workerEntries).find(([, entry]) => entry && process.command.includes(entry))?.[0] ?? "unknown" })),
    semanticWorkerCount: semanticRows.length,
    semanticWorkerPids: semanticRows.map((process) => process.pid),
    semanticWorkerRssMiB: Number(semanticRows.reduce((sum, process) => sum + process.rssMiB, 0).toFixed(1)),
    cgroup: {
      memoryCurrent: await readCgroupValue("memory.current"),
      memoryMax: await readCgroupValue("memory.max"),
      pidsCurrent: await readCgroupValue("pids.current"),
      pidsMax: await readCgroupValue("pids.max"),
      cpuMax: await readCgroupValue("cpu.max"),
    },
  };
}

function createSampler(runtime, workerEntries) {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const phases = [];
  let current;
  let sampleInFlight = false;
  let healthInFlight = false;
  const healthLatencies = [];
  let healthFailures = 0;

  const sample = async () => {
    if (!current || sampleInFlight) return;
    sampleInFlight = true;
    try {
      const metrics = await captureMetrics(runtime, workerEntries);
      current.sampleCount += 1;
      current.last = metrics;
      if (!current.first) current.first = metrics;
      if (!current.peak || metrics.aggregateRssMiB > current.peak.aggregateRssMiB) current.peak = metrics;
      if (!current.peakCompiled || metrics.compiledWorkerCount > current.peakCompiled.compiledWorkerCount) current.peakCompiled = metrics;
      if (!current.peakSemantic || metrics.semanticWorkerCount > current.peakSemantic.semanticWorkerCount) current.peakSemantic = metrics;
    } finally {
      sampleInFlight = false;
    }
  };

  const samplingTimer = setInterval(() => { void sample(); }, 100);
  samplingTimer.unref();
  const healthTimer = setInterval(async () => {
    if (healthInFlight) return;
    healthInFlight = true;
    const started = performance.now();
    try {
      const response = await fetch(API_ORIGIN + "/health/live", { signal: AbortSignal.timeout(2_000) });
      if (!response.ok) healthFailures += 1;
      await response.arrayBuffer();
      healthLatencies.push(Number((performance.now() - started).toFixed(2)));
    } catch {
      healthFailures += 1;
    } finally {
      healthInFlight = false;
    }
  }, 100);
  healthTimer.unref();

  return {
    setPhase(name) {
      current = {
        name,
        startedAt: new Date().toISOString(),
        sampleCount: 0,
        first: null,
        last: null,
        peak: null,
        peakCompiled: null,
        peakSemantic: null,
      };
      histogram.reset();
    },
    async mark() {
      if (!current) throw new Error("resource sampler phase was not started");
      while (sampleInFlight) await delay(5);
      await sample();
      while (sampleInFlight) await delay(5);
      const phase = {
        ...current,
        endedAt: new Date().toISOString(),
        durationMs: Number((Date.now() - Date.parse(current.startedAt)).toFixed(1)),
        maxEventLoopDelayMs: Number((histogram.max / 1e6).toFixed(2)),
        meanEventLoopDelayMs: Number((histogram.mean / 1e6).toFixed(2)),
      };
      phases.push(phase);
      current = undefined;
      return phase;
    },
    async stop() {
      clearInterval(samplingTimer);
      clearInterval(healthTimer);
      if (current) await this.mark();
      histogram.disable();
      const ordered = [...healthLatencies].sort((a, b) => a - b);
      return {
        phases,
        healthProbe: {
          successfulRequests: healthLatencies.length,
          failures: healthFailures,
          maxLatencyMs: healthLatencies.length ? Math.max(...healthLatencies) : null,
          p95LatencyMs: ordered.length ? ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * 0.95))] : null,
        },
      };
    },
  };
}

async function api(path, options = {}) {
  const headers = { authorization: "Bearer " + AUTH_TOKEN };
  const init = { method: options.method ?? "GET", headers };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(API_ORIGIN + path, init);
  const text = await response.text();
  let value;
  try { value = text ? JSON.parse(text) : null; }
  catch { throw new Error("API returned a non-JSON response at " + path); }
  assert.equal(response.status, options.status ?? 200, "unexpected HTTP status for " + path + ": " + response.status);
  return value;
}

const projectPath = "/api/projects/" + encodeURIComponent(PROJECT_ID);

async function invoke(actionId, input) {
  return api(projectPath + "/actions/" + encodeURIComponent(actionId), {
    method: "POST",
    body: { input },
  });
}

function actionData(result, actionId) {
  assert.equal(result.ok, true, actionId + " action failed: " + JSON.stringify(result.error ?? null));
  assert.ok(result.data && typeof result.data === "object", actionId + " must return action data");
  return result.data;
}

function statusFor(statuses, id) {
  const status = statuses.find((item) => item.id === id);
  assert.ok(status, "full profile must include module " + id);
  return status;
}

function workerPids(runtime, workerEntry) {
  return runtime.workerSupervisor.activeWorkerPids.filter((pid) => {
    try {
      const command = readFileSync("/proc/" + pid + "/cmdline");
      return command.toString("utf8").includes(workerEntry);
    } catch {
      return false;
    }
  });
}

function createObservationGate(id, context, gate, events, valueIds, sharedUseObservation) {
  return {
    ...context,
    async acquireCapability(capabilityId) {
      const lease = await context.acquireCapability(capabilityId);
      if (capabilityId !== "semantic.embedding") return lease;
      let identity = valueIds.get(lease.value);
      if (identity === undefined) {
        identity = valueIds.size + 1;
        valueIds.set(lease.value, identity);
      }
      events.push({ module: id, phase: "acquired", identity, value: lease.value });
      if (gate && !gate.used) {
        gate.used = true;
        const aborted = new Promise((resolve) => {
          if (context.signal.aborted) {
            resolve(true);
            return;
          }
          context.signal.addEventListener("abort", () => resolve(true), { once: true });
        });
        await Promise.race([gate.promise.then(() => false), aborted]);
        if (context.signal.aborted) {
          events.push({ module: id, phase: "cancelled", identity });
          await lease.release();
          throw Object.assign(new Error("P13 acceptance cancelled the gated real capability lease"), { code: "action_cancelled" });
        }
      }
      events.push({ module: id, phase: "returned", identity });
      return {
        value: new Proxy(lease.value, {
          get(target, property) {
            const member = Reflect.get(target, property, target);
            if (typeof member !== "function") return member;
            return (...args) => {
              if (sharedUseObservation?.enabled && (property === "index" || property === "nearest")) {
                sharedUseObservation.calls.push({ module: id, method: property, identity });
              }
              return Reflect.apply(member, target, args);
            };
          },
        }),
        async release() {
          events.push({ module: id, phase: "released", identity });
          await lease.release();
        },
      };
    },
  };
}

async function runLifecycle() {
  await mkdir("/data/.arcadia", { recursive: true });
  await symlink("/models", "/data/.arcadia/models", "dir");

  const [{ CoreStore }, { ModuleRuntime }, { start }, { MODEL_USAGE_CAPABILITY }, composition] = await Promise.all([
    import("/app/node_modules/.pnpm/node_modules/@scriptorium/core/dist/index.js"),
    import("/app/node_modules/.pnpm/node_modules/@scriptorium/module-runtime/dist/index.js"),
    import("/app/node_modules/@scriptorium/api/dist/server.js"),
    import("/app/node_modules/.pnpm/node_modules/@scriptorium/contracts/dist/index.js"),
    import("/app/generated/server.mjs"),
  ]);
  assert.equal(composition.profile, "full");
  assert.deepEqual(composition.moduleManifests.map((manifest) => manifest.id), EXPECTED_MODULES);

  const diagnosticGate = waitGate();
  diagnosticGate.used = false;
  const capabilityEvents = [];
  const valueIds = new WeakMap();
  const sharedUseObservation = { enabled: false, calls: [] };
  const loaders = {
    ...composition.moduleLoaders,
    diagnostics: async (context) => composition.moduleLoaders.diagnostics(createObservationGate("diagnostics", context, diagnosticGate, capabilityEvents, valueIds, sharedUseObservation)),
    semantic: async (context) => composition.moduleLoaders.semantic(createObservationGate("semantic", context, undefined, capabilityEvents, valueIds, sharedUseObservation)),
  };
  const apiUrl = new URL("file:///app/node_modules/@scriptorium/api/dist/server.js");
  const { HistoricalModelUsageStore } = await import(new URL("./historical-store.js", apiUrl).href);
  const usageStore = new HistoricalModelUsageStore("/history");
  const runtime = new ModuleRuntime({
    manifests: composition.moduleManifests,
    enabled: ["story", "nlp", "diagnostics", "semantic"],
    loaders,
    moduleDirectories: composition.moduleDirectories,
    workerEntries: composition.moduleWorkerEntries,
    cacheDirectory: "/data/module-cache",
    capabilityProviders: {
      [MODEL_USAGE_CAPABILITY]: { create: () => usageStore },
    },
  });
  assert.equal(await readlink("/data/module-cache/semantic/semantic/models"), "/models");
  const fs = await import("node:fs/promises");
  const e5ModelDirectory = "/models/" + MODEL_IDS.embedding.id + "/" + MODEL_IDS.embedding.revision + "/onnx";
  const bgeModelDirectory = "/models/" + MODEL_IDS.reranker.id + "/" + MODEL_IDS.reranker.revision + "/onnx";
  assert.ok((await fs.readdir(e5ModelDirectory)).length > 0);
  assert.ok((await fs.readdir(bgeModelDirectory)).length > 0);
  const store = new CoreStore({ dataDir: "/data", allowLocalRemotes: true });
  const server = await start({ store, authToken: AUTH_TOKEN, runtime, profile: "full", usageDirectory: "/history", staticDir: "/app/app/dist" });
  const productionRuntime = server.scriptorium.runtime;
  assert.equal(productionRuntime, runtime);

  const sampler = createSampler(runtime, composition.moduleWorkerEntries);
  const outcome = {
    profile: composition.profile,
    enabledOnInjectedRuntime: ["story", "nlp", "diagnostics", "semantic"],
    installedModules: EXPECTED_MODULES,
    modelArtifacts: MODEL_IDS,
    phases: [],
    assertions: {},
  };

  try {
    const version = await api("/api/version");
    assert.equal(version.profile, "full");
    const initialStatuses = await api(projectPath + "/modules");
    assert.deepEqual([...initialStatuses.map((item) => item.id)].sort(), [...EXPECTED_MODULES].sort());
    for (const id of EXPECTED_MODULES) statusFor(initialStatuses, id);
    assert.equal(statusFor(initialStatuses, "assistant").availability, "disabled");
    assert.equal(statusFor(initialStatuses, "publishing").availability, "disabled");
    assert.equal(statusFor(initialStatuses, "mcp").availability, "disabled");
    assert.equal(statusFor(initialStatuses, "speaker").availability, "disabled");

    sampler.setPhase("full-installed-disabled-and-enabled-idle-baseline");
    const initialActions = (await api(projectPath + "/actions")).actions;
    assert.ok(Array.isArray(initialActions));
    assert.ok(!initialActions.some((item) => item.id.startsWith("speaker.")), "disabled Speaker actions must not be exposed");
    assert.ok(!initialActions.some((item) => item.id.startsWith("assistant.")), "disabled Assistant actions must not be exposed");
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, [], "enabled-idle and disabled modules must not start workers");
    outcome.phases.push(await sampler.mark());
    outcome.assertions.disabledModulesHaveNoActions = true;
    outcome.assertions.noWorkerAtEnabledIdle = true;

    sampler.setPhase("actual-nlp-tokenizer-child");
    const nlp = actionData(await invoke("nlp.analyze", { text: "😀猫が走る。東京へ行く。" }), "nlp.analyze");
    assert.equal(nlp.engine, "lindera-wasm-nodejs-ipadic");
    assert.equal(nlp.engineVersion, "2.0.0");
    assert.ok(Array.isArray(nlp.analysis.tokens) && nlp.analysis.tokens.length > 0);
    outcome.phases.push(await sampler.mark());
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, [], "NLP tokenizer child must release after the actual API action");
    outcome.assertions.nlpEngine = { id: nlp.engine, version: nlp.engineVersion, tokens: nlp.analysis.tokens.length };

    sampler.setPhase("actual-nlp-token-counter-child");
    const exactTokenResult = await invoke("nlp.countTokens", {
      texts: ["駅で別れた。", "A quiet station.", "星野は遺跡へ向かう。"],
      modelId: MODEL_IDS.embedding.id,
    });
    const exactTokens = actionData(exactTokenResult, "nlp.countTokens exact E5");
    assert.deepEqual(exactTokens.counts, [8, 6, 11], "the public API must return cached E5 AutoTokenizer counts");
    assert.deepEqual(exactTokens.snapshot, exactTokenResult.snapshot);
    assert.deepEqual(exactTokens.counter, {
      modelId: MODEL_IDS.embedding.id,
      exact: true,
      engine: "huggingface-transformers",
      engineVersion: "3.8.1",
    });
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, [], "the exact token-counter child must release after its API lease");

    const fallbackTokenResult = await invoke("nlp.countTokens", {
      texts: ["駅abc", "abcdef", ""],
      modelId: "scriptorium-p13/no-such-tokenizer",
    });
    const fallbackTokens = actionData(fallbackTokenResult, "nlp.countTokens unavailable fallback");
    assert.deepEqual(fallbackTokens.counts, [2, 2, 0], "an unavailable local tokenizer must report the source approximation");
    assert.deepEqual(fallbackTokens.snapshot, fallbackTokenResult.snapshot);
    assert.deepEqual(fallbackTokens.counter, {
      modelId: "approx",
      exact: false,
      engine: "source-approx",
      engineVersion: "source-approx-v1",
      requestedModelId: "scriptorium-p13/no-such-tokenizer",
      fallbackReason: "tokenizer_unavailable",
    });
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, [], "the approximate token-counter child must release after its API lease");
    outcome.phases.push(await sampler.mark());
    outcome.assertions.tokenCounter = {
      exact: { counter: exactTokens.counter, counts: exactTokens.counts },
      fallback: { counter: fallbackTokens.counter, counts: fallbackTokens.counts },
    };

    runtime.enable("speaker");
    assert.equal(runtime.status("speaker").availability, "enabled-idle");
    sampler.setPhase("actual-speaker-and-lindera-children");
    const speaker = actionData(await invoke("speaker.attribute", { sceneId: "sc-synthetic-01" }), "speaker.attribute");
    assert.equal(speaker.speakerEngine, "scriptorium-speaker-cpu");
    assert.equal(speaker.speakerEngineVersion, "1.0.0");
    assert.equal(speaker.tokenizerModel, "lindera-wasm-nodejs-ipadic");
    assert.equal(speaker.tokenizerModelVersion, "2.0.0");
    const firstAttribution = speaker.attributions?.[0];
    assert.equal(firstAttribution?.speakerEntityId, "char-hero");
    assert.equal(firstAttribution?.text, "『俺が行く。』");
    outcome.phases.push(await sampler.mark());
    await waitFor(() => runtime.workerSupervisor.activeWorkerPids.length === 0, "speaker and tokenizer workers did not release");
    outcome.assertions.speakerEngine = {
      id: speaker.speakerEngine,
      version: speaker.speakerEngineVersion,
      tokenizer: speaker.tokenizerModel,
      tokenizerVersion: speaker.tokenizerModelVersion,
      attributedCharacter: firstAttribution.speakerEntityId,
    };
    await runtime.disable("speaker");
    assert.equal(runtime.status("speaker").availability, "disabled");

    sampler.setPhase("gated-diagnostics-semantic-lease-cancellation");
    const diagnosticPromise = invoke("diagnostics.analyze", {
      text: "彼は悲しい。彼は悲しい。彼は悲しい。", sceneId: "sc-synthetic-01",
    });
    await waitFor(() => capabilityEvents.some((event) => event.module === "diagnostics" && event.phase === "acquired"),
      "Diagnostics did not acquire its actual semantic embedding capability");

    const rebuildPromise = invoke("semantic.index.rebuild", { taskId: "p13-oci-shared-index" });
    await waitFor(async () => capabilityEvents.some((event) => event.module === "semantic" && event.phase === "acquired") &&
      workerPids(runtime, composition.moduleWorkerEntries.semantic).length > 0,
    "Semantic did not start its actual embedding worker");
    const diagnosticsLease = capabilityEvents.find((event) => event.module === "diagnostics" && event.phase === "acquired");
    const semanticLease = capabilityEvents.find((event) => event.module === "semantic" && event.phase === "acquired");
    assert.ok(diagnosticsLease && semanticLease);
    assert.equal(diagnosticsLease.value, semanticLease.value, "both real modules must hold the same semantic capability provider instance");
    const identity = diagnosticsLease.identity;
    const firstSemanticPid = workerPids(runtime, composition.moduleWorkerEntries.semantic)[0];
    assert.ok(firstSemanticPid);
    await waitFor(async () => workerPids(runtime, composition.moduleWorkerEntries.semantic).length === 1,
      "overlapping real capability users must share one semantic child PID");
    outcome.assertions.sharedCapability = { identity, workerPid: firstSemanticPid, consumers: ["diagnostics", "semantic"] };

    assert.ok(runtime.workerSupervisor.activeJobCountFor("semantic") > 0, "the semantic model job must be active before disabling one consumer");
    const diagnosticDisablePromise = runtime.disable("diagnostics");
    await diagnosticDisablePromise;
    const diagnosticResult = await diagnosticPromise;
    assert.equal(runtime.status("diagnostics").availability, "disabled");
    assert.equal(diagnosticResult.ok, false, "the disabled Diagnostics action must be cancelled while Semantic remains active");
    assert.deepEqual(workerPids(runtime, composition.moduleWorkerEntries.semantic), [firstSemanticPid],
      "the Semantic child must remain alive after the other real consumer is disabled");
    assert.ok(runtime.workerSupervisor.activeJobCountFor("semantic") > 0,
      "Semantic must still be processing its real model job when Diagnostics has drained");
    const rebuildResult = await rebuildPromise;
    const rebuilt = actionData(rebuildResult, "semantic.index.rebuild");
    assert.ok(rebuilt.embedded > 0);
    await waitFor(() => workerPids(runtime, composition.moduleWorkerEntries.semantic).length === 0,
      "last Semantic lease release did not stop the child");
    outcome.phases.push(await sampler.mark());
    outcome.assertions.disableOneConsumerPreservesOther = true;
    outcome.assertions.lastLeaseStopsWorker = true;

    runtime.enable("diagnostics");
    assert.equal(runtime.status("diagnostics").availability, "enabled-idle");
    assert.equal(diagnosticGate.used, true, "the one-shot cancellation gate must remain consumed before actual shared use");
    sampler.setPhase("shared-diagnostics-semantic-real-inference");
    const sharedUseEventStart = capabilityEvents.length;
    const sharedUseCallStart = sharedUseObservation.calls.length;
    sharedUseObservation.enabled = true;
    const actualDiagnosticsPromise = invoke("diagnostics.analyze", {
      text: "彼は悲しい。彼は悲しい。彼は悲しい。", sceneId: "sc-synthetic-01",
    });
    await waitFor(() => sharedUseObservation.calls.slice(sharedUseCallStart).some((event) => event.module === "diagnostics" && event.method === "nearest") &&
      workerPids(runtime, composition.moduleWorkerEntries.semantic).length === 1,
    "Diagnostics did not use the real semantic nearest provider with one Semantic child");
    const sharedSemanticPid = workerPids(runtime, composition.moduleWorkerEntries.semantic)[0];
    const actualSemanticPromise = invoke("semantic.search", {
      query: "夜遅く駅に着き、青い切符を握りしめた。", mode: "scene", limit: 5, rerank: false,
    });
    await waitFor(() => sharedUseObservation.calls.slice(sharedUseCallStart).some((event) => event.module === "semantic" && event.method === "nearest") &&
      workerPids(runtime, composition.moduleWorkerEntries.semantic).length === 1 &&
      workerPids(runtime, composition.moduleWorkerEntries.semantic)[0] === sharedSemanticPid,
    "Semantic search did not use the same real provider and Semantic child as Diagnostics");
    const [actualDiagnosticsResponse, actualSemanticResponse] = await Promise.all([actualDiagnosticsPromise, actualSemanticPromise]);
    sharedUseObservation.enabled = false;
    const actualDiagnostics = actionData(actualDiagnosticsResponse, "diagnostics.analyze");
    const actualSemantic = actionData(actualSemanticResponse, "semantic.search");
    assert.ok(actualDiagnostics.analysis.habitualPhraseWarnings.some((warning) => warning.phrase === "彼は悲しい"),
      "Diagnostics input must exercise the corpus-neighbor path");
    assert.deepEqual(actualDiagnostics.semanticEmbedding, {
      model: MODEL_IDS.embedding.id, modelVersion: MODEL_IDS.embedding.revision, dimensions: 384,
    }, "Diagnostics must report the real shared model identity");
    assert.equal(actualSemantic.model, MODEL_IDS.embedding.id);
    assert.equal(actualSemantic.modelVersion, MODEL_IDS.embedding.revision);
    assert.ok(actualSemantic.results?.length > 0, "Semantic search must return results from the synthetic corpus");

    const sharedUseEvents = capabilityEvents.slice(sharedUseEventStart);
    const diagnosticsUseLease = sharedUseEvents.find((event) => event.module === "diagnostics" && event.phase === "acquired");
    const semanticUseLease = sharedUseEvents.find((event) => event.module === "semantic" && event.phase === "acquired");
    assert.ok(diagnosticsUseLease && semanticUseLease, "both real actions must acquire the shared capability");
    assert.equal(diagnosticsUseLease.value, semanticUseLease.value, "actual Diagnostics and Semantic use must share one capability provider instance");
    assert.equal(diagnosticsUseLease.identity, semanticUseLease.identity);
    const sharedUseCalls = sharedUseObservation.calls.slice(sharedUseCallStart);
    assert.ok(sharedUseCalls.some((event) => event.module === "diagnostics" && event.method === "index"));
    assert.ok(sharedUseCalls.some((event) => event.module === "diagnostics" && event.method === "nearest"));
    assert.ok(sharedUseCalls.some((event) => event.module === "semantic" && event.method === "nearest"));
    const sharedUsePhase = await sampler.mark();
    assert.equal(sharedUsePhase.peakSemantic?.semanticWorkerCount, 1,
      "actual shared use must observe exactly one Semantic child");
    assert.deepEqual(sharedUsePhase.peakSemantic?.semanticWorkerPids, [sharedSemanticPid]);
    outcome.phases.push(sharedUsePhase);
    outcome.assertions.sharedProviderActualUse = {
      identity: diagnosticsUseLease.identity,
      workerPid: sharedSemanticPid,
      calls: sharedUseCalls.map(({ module, method }) => ({ module, method })),
      diagnosticsModel: actualDiagnostics.semanticEmbedding,
      diagnosticsWarnings: actualDiagnostics.analysis.habitualPhraseWarnings.length,
      semanticModel: { id: actualSemantic.model, revision: actualSemantic.modelVersion },
      semanticResults: actualSemantic.results.length,
    };
    await waitFor(() => runtime.workerSupervisor.activeWorkerPids.length === 0,
      "shared Diagnostics and Semantic actions did not release their final Semantic worker lease");

    const firstStatusResult = await invoke("semantic.index.status", {});
    const firstStatus = actionData(firstStatusResult, "semantic.index.status");
    assert.equal(firstStatus.indexAvailable, true);
    assert.equal(firstStatus.modelVersion, MODEL_IDS.embedding.revision);
    const repository = firstStatusResult.snapshot.repository;
    const repositoryKey = createHash("sha256").update(JSON.stringify([
      repository.provider, repository.ownerScope, repository.repositoryId, repository.defaultBranch,
    ])).digest("hex");
    const modelKey = createHash("sha256").update(MODEL_IDS.embedding.id + "@" + MODEL_IDS.embedding.revision).digest("hex").slice(0, 24);
    const candidateIndex = "/data/module-cache/semantic/semantic/indexes/" + repositoryKey + "-" + modelKey + ".json";
    const fs = await import("node:fs/promises");
    await fs.stat(candidateIndex);

    sampler.setPhase("delete-derived-index-and-rebuild-from-synthetic-git");
    await fs.unlink(candidateIndex);
    const missingStatus = actionData(await invoke("semantic.index.status", {}), "semantic.index.status");
    assert.equal(missingStatus.indexAvailable, false, "the worker must report a deleted derived cache as missing");
    const recovered = actionData(await invoke("semantic.index.rebuild", { taskId: "p13-oci-cache-recovery" }), "semantic.index.rebuild");
    assert.ok(recovered.embedded > 0, "the actual CPU model must rebuild a deleted derived cache");
    assert.ok((await fs.stat(candidateIndex)).isFile());
    outcome.phases.push(await sampler.mark());
    outcome.assertions.derivedCacheDeletionAndRebuild = { deletedPath: candidateIndex, recovered: true };

    await runtime.disable("semantic");
    await waitFor(() => runtime.workerSupervisor.activeWorkerPids.length === 0, "Semantic worker remained after last capability release and disable");
    sampler.setPhase("after-disable-before-replacement");
    assert.equal(runtime.status("semantic").availability, "disabled");
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, []);
    outcome.phases.push(await sampler.mark());

    runtime.enable("semantic");
    assert.equal(runtime.status("semantic").availability, "enabled-idle");
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, [], "re-enabled semantic must remain model-free until requested");
    sampler.setPhase("replacement-e5-bge-search");
    const replacement = actionData(await invoke("semantic.search", {
      query: "夜遅く駅に着き、青い切符を握りしめた。", mode: "scene", limit: 5, rerank: true,
    }), "semantic.search");
    assert.equal(replacement.modelVersion, MODEL_IDS.embedding.revision);
    assert.equal(replacement.reranker?.id, MODEL_IDS.reranker.id);
    assert.equal(replacement.reranker?.version, MODEL_IDS.reranker.revision);
    assert.equal(replacement.rerankWarning, undefined, "the pinned BGE ONNX CPU reranker must return a real result");
    assert.ok(replacement.results?.length > 0);
    outcome.phases.push(await sampler.mark());
    outcome.assertions.replacementSearch = {
      embeddingModel: replacement.modelVersion,
      reranker: { id: replacement.reranker.id, revision: replacement.reranker.version },
      results: replacement.results.length,
    };
    assert.ok(outcome.phases.at(-1)?.peakSemantic?.semanticWorkerCount > 0, "sampling must observe the replacement semantic child during E5/BGE inference");
    await waitFor(() => runtime.workerSupervisor.activeWorkerPids.length === 0, "replacement semantic worker remained after the action's final lease release");
    sampler.setPhase("after-replacement-worker-release");
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, []);
    outcome.phases.push(await sampler.mark());

    const projectResponse = await api(projectPath);
    const projectRoot = projectResponse.project?.workspaceDirectory ?? "/data/projects/" + PROJECT_ID;
    outcome.projectId = PROJECT_ID;
    outcome.snapshot = projectResponse.observation?.snapshot ?? null;
    outcome.preservedFiles = [];
    for (const relative of SETTINGS_PATHS) {
      const file = await readFile(projectRoot + "/" + relative, "utf8");
      outcome.preservedFiles.push({ path: relative, sha256: createHash("sha256").update(file).digest("hex") });
    }
    outcome.workerEntries = composition.moduleWorkerEntries;
    outcome.runtimeStatusesAtEnd = runtime.statuses();
    outcome.resourceMeasurements = await sampler.stop();
    await writeFile(OUTPUT_DIRECTORY + "/lifecycle.json", JSON.stringify(outcome, null, 2) + "\n", { mode: 0o600 });
  } finally {
    diagnosticGate.open();
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    if (runtime.workerSupervisor.activeWorkerPids.length !== 0) {
      await runtime.shutdown();
    }
    const measurements = await sampler.stop();
    if (!outcome.resourceMeasurements) outcome.resourceMeasurements = measurements;
  }
}

async function replacementProbe() {
  const composition = await import("/app/generated/server.mjs");
  assert.equal(composition.profile, "full");
  const projectPathname = "/api/projects/" + encodeURIComponent(PROJECT_ID);
  const probe = createSampler(undefined, composition.moduleWorkerEntries);
  const outcome = {
    profile: composition.profile,
    mode: "production-launcher-replacement",
    modelArtifacts: MODEL_IDS,
    phases: [],
    assertions: {},
  };
  try {
    const version = await api("/api/version");
    assert.equal(version.profile, "full");
    const statuses = await api(projectPathname + "/modules");
    assert.deepEqual([...statuses.map((item) => item.id)].sort(), [...EXPECTED_MODULES].sort());
    assert.ok(statuses.every((item) => item.availability === "enabled-idle"), "production full profile should start all installed modules enabled-idle");
    const actions = (await api(projectPathname + "/actions")).actions;
    for (const moduleId of EXPECTED_MODULES.filter((id) => id !== "mcp")) {
      assert.ok(actions.some((item) => item.id.startsWith(moduleId + ".")), "production API must expose " + moduleId + " actions");
    }

    probe.setPhase("replacement-enabled-idle-before-model-action");
    const idle = await captureMetrics(undefined, composition.moduleWorkerEntries);
    assert.equal(idle.compiledWorkerCount, 0, "replacement launcher must remain model-worker-free before an action");
    outcome.phases.push(await probe.mark());
    outcome.assertions.allEightModulesInstalledAndEnabled = true;
    outcome.assertions.noWorkerAtReplacementIdle = true;

    probe.setPhase("replacement-semantic-index-restored");
    const status = actionData(await api(projectPathname + "/actions/semantic.index.status", {
      method: "POST",
      body: { input: {} },
    }), "semantic.index.status");
    assert.equal(status.indexAvailable, true, "derived index must survive container replacement");
    assert.equal(status.modelVersion, MODEL_IDS.embedding.revision);
    outcome.phases.push(await probe.mark());
    outcome.assertions.persistedDerivedIndex = true;

    probe.setPhase("replacement-production-e5-bge-inference");
    const result = actionData(await api(projectPathname + "/actions/semantic.search", {
      method: "POST",
      body: { input: { query: "夜遅く駅に着き、青い切符を握りしめた。", mode: "scene", limit: 5, rerank: true } },
    }), "semantic.search");
    assert.equal(result.modelVersion, MODEL_IDS.embedding.revision);
    assert.equal(result.reranker?.id, MODEL_IDS.reranker.id);
    assert.equal(result.reranker?.version, MODEL_IDS.reranker.revision);
    assert.equal(result.rerankWarning, undefined);
    assert.ok(result.results?.length > 0);
    const inferencePhase = await probe.mark();
    assert.ok(inferencePhase.peakSemantic?.semanticWorkerCount > 0, "sampling must observe the replacement semantic child during model inference");
    outcome.phases.push(inferencePhase);
    outcome.assertions.realReplacementInference = {
      embeddingModel: result.modelVersion,
      reranker: { id: result.reranker.id, revision: result.reranker.version },
      results: result.results.length,
    };
    await waitFor(async () => (await captureMetrics(undefined, composition.moduleWorkerEntries)).compiledWorkerCount === 0,
      "replacement semantic worker did not exit after its capability lease was released", 30_000);
  } finally {
    outcome.resourceMeasurements = await probe.stop();
  }
  await writeFile(OUTPUT_DIRECTORY + "/replacement.json", JSON.stringify(outcome, null, 2) + "\n", { mode: 0o600 });
}

const mode = process.argv[2];
try {
  if (mode === "lifecycle") await runLifecycle();
  else if (mode === "replacement-probe") await replacementProbe();
  else throw new Error("unknown P13 container mode");
} catch (error) {
  const failure = {
    name: error instanceof Error ? error.name : "Error",
    code: error && typeof error === "object" && "code" in error ? error.code : undefined,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
  await writeFile(OUTPUT_DIRECTORY + "/failure.json", JSON.stringify(failure, null, 2) + "\\n", { mode: 0o600 }).catch(() => {});
  console.error("P13 OCI acceptance failed: " + failure.message);
  process.exitCode = 1;
}
