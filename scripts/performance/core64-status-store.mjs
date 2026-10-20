#!/usr/bin/env node
import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptPath);
const runtimeSourceSha = "a1587e784788fa87d86c0eb7ab175d7a28a3209f";
const positionalArgs = [];
let requestedRuntimeRoot;
const rawArgs = process.argv.slice(2);
for (let index = 0; index < rawArgs.length; index += 1) {
  const argument = rawArgs[index];
  if (argument === "--runtime-root") {
    requestedRuntimeRoot = rawArgs[index + 1];
    assert.ok(requestedRuntimeRoot, "--runtime-root requires a path");
    index += 1;
  } else if (argument.startsWith("--runtime-root=")) {
    requestedRuntimeRoot = argument.slice("--runtime-root=".length);
    assert.ok(requestedRuntimeRoot, "--runtime-root requires a path");
  } else {
    positionalArgs.push(argument);
  }
}
const runtimeRoot = path.resolve(requestedRuntimeRoot || path.resolve(scriptDirectory, "../.."));
const sourceCheck = spawnSync("git", ["-C", runtimeRoot, "diff", "--quiet", runtimeSourceSha, "--", "packages"]);
assert.equal(sourceCheck.error, undefined, "could not verify the runtime source tree with git");
assert.equal(sourceCheck.status, 0, "runtimeRoot packages source must match the frozen a1587e78 tree");
const storeUrl = pathToFileURL(path.join(runtimeRoot, "packages/api/dist/recent-activity-store.js"));
const repository = {
  provider: "github",
  repositoryId: "perf-status",
  defaultBranch: "main",
  ownerScope: "scriptorium-perf",
  url: "https://github.com/scriptorium-perf/status-fixture.git",
};
const temporaryRootPrefix = path.join(os.tmpdir(), "scriptorium-c64-status-");

function newMetrics() {
  return {
    durationMs: {
      lstat: 0,
      mkdir: 0,
      open: 0,
      stateStat: 0,
      stateRead: 0,
      tempWrite: 0,
      fileSync: 0,
      directorySync: 0,
      rename: 0,
      unlink: 0,
      jsonParse: 0,
      jsonStringify: 0,
      close: 0,
    },
    calls: {
      lstat: 0,
      mkdir: 0,
      open: 0,
      stateOpen: 0,
      tempOpen: 0,
      directoryOpen: 0,
      stateStat: 0,
      stateRead: 0,
      tempWrite: 0,
      fileSync: 0,
      directorySync: 0,
      rename: 0,
      unlink: 0,
      jsonParse: 0,
      jsonStringify: 0,
      close: 0,
    },
    bytes: { stateRead: 0, tempWrite: 0, jsonStringify: 0 },
  };
}

let activeMetrics;
let activeLayout;

function addTime(name, started) {
  if (!activeMetrics) return;
  activeMetrics.durationMs[name] += performance.now() - started;
}

function patchPromiseFunction(name) {
  const original = fsp[name].bind(fsp);
  fsp[name] = async function (...args) {
    const started = performance.now();
    if (activeMetrics) activeMetrics.calls[name] += 1;
    try {
      return await original(...args);
    } finally {
      addTime(name, started);
    }
  };
}

function pathKind(value) {
  const target = path.resolve(String(value));
  if (activeLayout && target === activeLayout.file) return "state";
  if (activeLayout && (target === activeLayout.root || target === activeLayout.directory)) return "directory";
  if (activeLayout && path.dirname(target) === activeLayout.directory && path.basename(target).startsWith(".tmp-")) return "temporary";
  return "other";
}

function instrumentHandle(handle, kind) {
  const wrap = (method, durationName, callName, onResult, onArgs) => {
    if (typeof handle[method] !== "function") return;
    const original = handle[method].bind(handle);
    handle[method] = async function (...args) {
      const started = performance.now();
      if (activeMetrics && callName) activeMetrics.calls[callName] += 1;
      if (activeMetrics && onArgs) onArgs(args);
      try {
        const result = await original(...args);
        if (activeMetrics && onResult) onResult(result);
        return result;
      } finally {
        if (durationName) addTime(durationName, started);
      }
    };
  };
  wrap("stat", kind === "state" ? "stateStat" : undefined, kind === "state" ? "stateStat" : undefined);
  wrap("readFile", kind === "state" ? "stateRead" : undefined, kind === "state" ? "stateRead" : undefined,
    (result) => { activeMetrics.bytes.stateRead += Buffer.isBuffer(result) ? result.byteLength : Buffer.byteLength(String(result)); });
  wrap("writeFile", kind === "temporary" ? "tempWrite" : undefined, kind === "temporary" ? "tempWrite" : undefined,
    undefined,
    (args) => { activeMetrics.bytes.tempWrite += Buffer.isBuffer(args[0]) ? args[0].byteLength : Buffer.byteLength(String(args[0]), args[1] || "utf8"); });
  wrap("sync", kind === "directory" ? "directorySync" : kind === "temporary" ? "fileSync" : undefined,
    kind === "directory" ? "directorySync" : kind === "temporary" ? "fileSync" : undefined);
  wrap("close", "close", "close");
}

function installInstrumentation() {
  const originalOpen = fsp.open.bind(fsp);
  fsp.open = async function (...args) {
    const started = performance.now();
    const kind = pathKind(args[0]);
    if (activeMetrics) {
      activeMetrics.calls.open += 1;
      if (kind === "state") activeMetrics.calls.stateOpen += 1;
      else if (kind === "temporary") activeMetrics.calls.tempOpen += 1;
      else if (kind === "directory") activeMetrics.calls.directoryOpen += 1;
    }
    try {
      return instrumentHandle(await originalOpen(...args), kind);
    } finally {
      addTime("open", started);
    }
  };
  for (const name of ["lstat", "mkdir", "rename", "unlink"]) patchPromiseFunction(name);

  const originalParse = JSON.parse;
  JSON.parse = function (...args) {
    const started = performance.now();
    if (activeMetrics) activeMetrics.calls.jsonParse += 1;
    try {
      return originalParse.apply(this, args);
    } finally {
      addTime("jsonParse", started);
    }
  };
  const originalStringify = JSON.stringify;
  JSON.stringify = function (...args) {
    const started = performance.now();
    if (activeMetrics) activeMetrics.calls.jsonStringify += 1;
    try {
      const result = originalStringify.apply(this, args);
      if (activeMetrics && typeof result === "string") activeMetrics.bytes.jsonStringify += Buffer.byteLength(result, "utf8");
      return result;
    } finally {
      addTime("jsonStringify", started);
    }
  };
  syncBuiltinESMExports();
}

function quantile(values, q) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(q * ordered.length) - 1)];
}

function summarize(values) {
  return {
    n: values.length,
    p50Ms: quantile(values, 0.50),
    p95Ms: quantile(values, 0.95),
    p99Ms: quantile(values, 0.99),
    maxMs: values.length ? Math.max(...values) : null,
  };
}

async function readProcIo() {
  try {
    const text = await fsp.readFile("/proc/self/io", "utf8");
    return Object.fromEntries(text.trim().split(/\n/u).map((line) => {
      const [name, value] = line.split(":");
      return [name, Number(value)];
    }));
  } catch {
    return null;
  }
}

function inputFor(sequence, deviceType) {
  return {
    sceneId: "scene-" + sequence,
    sentenceOffset: sequence,
    pageIndex: sequence % 40,
    deviceType,
  };
}

function layoutFor(usageDirectory) {
  const root = path.resolve(usageDirectory);
  const directory = path.join(root, "recent-activity");
  return { root, directory, file: path.join(directory, "recent-activity-state.json") };
}

async function timedBatch(Store, name, repeats, operationCount, ownerFor, deviceFor, expectedItemsPerOwner) {
  const runs = [];
  const allOperationLatencies = [];
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const tempRoot = await fsp.mkdtemp(temporaryRootPrefix);
    const usageDirectory = path.join(tempRoot, "usage");
    await fsp.mkdir(usageDirectory, { mode: 0o700 });
    const store = new Store(usageDirectory);
    const metrics = newMetrics();
    const layout = layoutFor(usageDirectory);
    const beforeIo = await readProcIo();
    const beforeCpu = process.cpuUsage();
    const batchStarted = performance.now();
    const latencies = [];
    activeLayout = layout;
    activeMetrics = metrics;
    try {
      await Promise.all(Array.from({ length: operationCount }, async (_, index) => {
        const operationStarted = performance.now();
        await store.upsert(ownerFor(index), repository, inputFor((repeat * operationCount) + index, deviceFor(index)));
        latencies[index] = performance.now() - operationStarted;
      }));
    } finally {
      activeMetrics = undefined;
      activeLayout = undefined;
    }
    const wallMs = performance.now() - batchStarted;
    const cpu = process.cpuUsage(beforeCpu);
    const afterIo = await readProcIo();
    const restarted = new Store(usageDirectory);
    const sampleOwners = new Set([ownerFor(0), ownerFor(Math.floor(operationCount / 2)), ownerFor(operationCount - 1)]);
    const scopeChecks = [];
    for (const owner of sampleOwners) {
      const items = await restarted.list(owner, repository);
      assert.equal(items.length, expectedItemsPerOwner, "each owner must retain exactly its current device cursors");
      scopeChecks.push({ owner, deviceTypes: items.map((item) => item.deviceType).sort() });
    }
    const absentItems = await restarted.list("synthetic-unrelated-author", repository);
    assert.deepEqual(absentItems, [], "unrelated author scopes must remain empty");
    const bytes = await fsp.readFile(layout.file);
    const state = JSON.parse(bytes.toString("utf8"));
    const expectedEntries = new Set(Array.from({ length: operationCount }, (_, index) => ownerFor(index))).size;
    assert.equal(state.entries.length, expectedEntries, "persisted owner scopes must not collapse");
    const run = {
      repeat,
      operationCount,
      ownerCount: expectedEntries,
      wallMs,
      operationLatencyMs: summarize(latencies),
      cpuUserMs: cpu.user / 1_000,
      cpuSystemMs: cpu.system / 1_000,
      stateBytes: bytes.byteLength,
      scopeChecks,
      unrelatedAuthorEmpty: true,
      io: beforeIo && afterIo ? Object.fromEntries(Object.keys(beforeIo).map((key) => [key, afterIo[key] - beforeIo[key]])) : null,
      metrics,
    };
    runs.push(run);
    allOperationLatencies.push(...latencies);
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
  return {
    name,
    operationCount,
    repeatCount: repeats,
    batchWallMs: summarize(runs.map((run) => run.wallMs)),
    operationLatencyMs: summarize(allOperationLatencies),
    runs,
  };
}

async function runBench(outputPath, repeats) {
  installInstrumentation();
  const { RecentActivityStore } = await import(storeUrl.href);
  const cases = [
    await timedBatch(RecentActivityStore, "single-upsert", repeats, 1,
      () => "synthetic-owner-0", () => "desktop", 1),
    await timedBatch(RecentActivityStore, "parallel-100-device-burst-one-author", repeats, 100,
      () => "synthetic-owner-shared", (index) => index % 2 === 0 ? "desktop" : "mobile", 2),
    await timedBatch(RecentActivityStore, "parallel-100-scoped-authors", repeats, 100,
      (index) => "synthetic-owner-" + index, (index) => index % 2 === 0 ? "desktop" : "mobile", 1),
  ];
  const result = {
    schemaVersion: 1,
    candidate: "C42",
    runtimeRoot,
    runtimeSourceSha,
    source: "real RecentActivityStore implementation; synthetic temporary directories and owner/repository identities",
    durabilityPrimitive: ["bounded JSON state", "private temporary file", "file sync", "atomic rename", "containing-directory sync"],
    instrumentation: "in-process async filesystem and JSON phase wrappers plus /proc/self/io deltas; no production source hooks",
    environment: { node: process.versions.node, platform: process.platform, arch: process.arch, kernel: os.release() },
    repeats,
    cases,
  };
  await fsp.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await fsp.writeFile(outputPath, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  process.stdout.write(JSON.stringify({
    outputPath,
    runtimeRoot,
    runtimeSourceSha,
    cases: cases.map(({ name, operationLatencyMs }) => ({ name, operationLatencyMs })),
  }, null, 2) + "\n");
}

async function crashChild(usageDirectory) {
  const actualOpen = fsp.open.bind(fsp);
  fsp.open = async function (...args) {
    const handle = await actualOpen(...args);
    const target = path.resolve(String(args[0]));
    if (path.dirname(target) === path.join(path.resolve(usageDirectory), "recent-activity") &&
        path.basename(target).startsWith(".tmp-")) {
      handle.writeFile = async function (data, encoding = "utf8") {
        const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, encoding);
        const partial = bytes.subarray(0, Math.max(1, Math.floor(bytes.byteLength / 2)));
        const writeResult = await handle.write(partial, 0, partial.byteLength, 0);
        process.send({
          event: "partial-temp-record",
          temporaryPath: target,
          expectedBytes: bytes.byteLength,
          writtenBytes: writeResult.bytesWritten,
        });
        await new Promise(() => undefined);
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  const { RecentActivityStore } = await import(storeUrl.href);
  const store = new RecentActivityStore(usageDirectory);
  await store.upsert("surviving-author", repository, inputFor(999_999, "desktop"));
  process.exitCode = 3;
}

async function runCrash(outputPath) {
  const { RecentActivityStore } = await import(storeUrl.href);
  const tempRoot = await fsp.mkdtemp(temporaryRootPrefix);
  const usageDirectory = path.join(tempRoot, "usage");
  const store = new RecentActivityStore(usageDirectory);
  await store.upsert("surviving-author", repository, {
    sceneId: "durable-before-crash",
    sentenceOffset: 7,
    pageIndex: 9,
    deviceType: "desktop",
  });
  const statePath = path.join(usageDirectory, "recent-activity", "recent-activity-state.json");
  const beforeBytes = await fsp.readFile(statePath);
  const beforeHash = createHash("sha256").update(beforeBytes).digest("hex");
  const child = fork(scriptPath, ["crash-child", usageDirectory, "--runtime-root", runtimeRoot], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
  let partialMessage;
  try {
    partialMessage = await new Promise((resolve, reject) => {
      child.once("message", resolve);
      child.once("error", reject);
      child.once("exit", (code, signal) => reject(new Error("crash writer exited before partial-write handoff: " + code + "/" + signal)));
    });
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(partialMessage.event, "partial-temp-record");
  assert.ok(partialMessage.writtenBytes > 0 && partialMessage.writtenBytes < partialMessage.expectedBytes);
  child.kill("SIGKILL");
  const [exitCode, exitSignal] = await once(child, "exit");
  assert.equal(exitSignal, "SIGKILL");
  const tempDirectory = path.join(usageDirectory, "recent-activity");
  const orphanNames = (await fsp.readdir(tempDirectory)).filter((name) => name.startsWith(".tmp-"));
  assert.equal(orphanNames.length, 1, "the interrupted temporary record remains isolated from the canonical state");
  const orphanPath = path.join(tempDirectory, orphanNames[0]);
  const orphanBytes = await fsp.readFile(orphanPath);
  assert.equal(orphanBytes.byteLength, partialMessage.writtenBytes);
  assert.throws(() => JSON.parse(orphanBytes.toString("utf8")), "the injected temporary record is incomplete");

  const restarted = new RecentActivityStore(usageDirectory);
  const afterRestart = await restarted.list("surviving-author", repository);
  assert.equal(afterRestart.length, 1);
  assert.equal(afterRestart[0].sceneId, "durable-before-crash");
  assert.equal(afterRestart[0].sentenceOffset, 7);
  await restarted.upsert("surviving-author", repository, {
    sceneId: "after-restart",
    sentenceOffset: 8,
    pageIndex: 10,
    deviceType: "desktop",
  });
  const afterRecoveryWrite = await new RecentActivityStore(usageDirectory).list("surviving-author", repository);
  assert.equal(afterRecoveryWrite[0].sceneId, "after-restart");
  const afterBytes = await fsp.readFile(statePath);
  const result = {
    schemaVersion: 1,
    candidate: "C42",
    runtimeRoot,
    runtimeSourceSha,
    fixture: "synthetic private directory; existing upsert with injected half-write to its private temporary file",
    crashSignal: exitSignal,
    childExitCode: exitCode,
    temporaryBytes: { written: partialMessage.writtenBytes, intended: partialMessage.expectedBytes },
    canonicalStateBeforeSha256: beforeHash,
    canonicalStateAfterSha256: createHash("sha256").update(afterBytes).digest("hex"),
    canonicalStateAfterCrashParses: JSON.parse(afterBytes.toString("utf8")).version === 1,
    restartPreservedCommittedCursor: afterRestart[0].sceneId === "durable-before-crash",
    subsequentUpsertSucceeded: afterRecoveryWrite[0].sceneId === "after-restart",
    orphanTemporaryFileRetained: true,
  };
  await fsp.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await fsp.writeFile(outputPath, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  process.stdout.write(JSON.stringify({ outputPath, result }, null, 2) + "\n");
  await fsp.rm(tempRoot, { recursive: true, force: true });
}

const [mode = "bench", outputPath = path.join(os.tmpdir(), "core64-status-store.json")] = positionalArgs;
if (mode === "crash-child") {
  await crashChild(outputPath);
} else if (mode === "crash") {
  await runCrash(outputPath);
} else if (mode === "bench") {
  const repeats = Number(process.env.C64_STATUS_REPEATS || 10);
  assert.ok(Number.isSafeInteger(repeats) && repeats >= 5 && repeats <= 30, "C64_STATUS_REPEATS must be between 5 and 30");
  await runBench(outputPath, repeats);
} else {
  throw new Error("Usage: core64-status-store.mjs [bench|crash|crash-child] [output.json]");
}
