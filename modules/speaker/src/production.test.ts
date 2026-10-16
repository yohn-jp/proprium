import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { assertChangeOperation, type ChangeOperation, type ChangeProposal, type ModuleContext, type ModuleManifest, type SnapshotId } from "@scriptorium/contracts";
import { ModuleRuntime } from "@scriptorium/module-runtime";
import { createModule as createStoryModule } from "@scriptorium/module-story";
import { createModule as createNlpModule } from "@scriptorium/module-nlp";
import { createModule as createDiagnosticsModule } from "@scriptorium/module-diagnostics";
import { createModule as createSpeakerModule } from "./index.js";

const repository = {
  provider: "local" as const,
  repositoryId: "p10-synthetic-speaker",
  defaultBranch: "main",
  ownerScope: "local-owner",
  url: "file:///p10-synthetic-speaker",
};

function fileRevision(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function snapshotFor(files: Map<string, { content: string; revision: string }>): SnapshotId {
  const tree = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([filePath, file]) => [filePath, file.revision]);
  return { repository, remoteCommit: createHash("sha256").update(JSON.stringify(tree)).digest("hex").slice(0, 40) };
}

function sceneText(): string { return "星野は灯りを見た。『俺が行く。』"; }

function initialFiles(sceneCount = 14): Map<string, { content: string; revision: string }> {
  const files = new Map<string, { content: string; revision: string }>();
  const add = (filePath: string, content: string) => files.set(filePath, { content, revision: fileRevision(content) });
  add("bible/characters/hero/profile.yaml", [
    "id: char-hero",
    "type: character",
    "name: 星野",
    "aliases: [星野]",
    "voicePatterns:",
    "  firstPerson: [僕]",
    "",
  ].join("\n"));
  for (let index = 0; index < sceneCount; index += 1) {
    const id = `sc-synthetic-${String(index + 1).padStart(2, "0")}`;
    const slug = String(index + 1).padStart(2, "0");
    const scenePath = `plot/volumes/volume-1/scenes/${id}.yaml`;
    const manuscriptPath = `manuscript/v1/${id}.md`;
    add(scenePath, [
      `id: ${id}`,
      "type: scene",
      `name: 合成シーン ${slug}`,
      "appears: [char-hero]",
      "speakerCount: 1",
      `manuscript: ${manuscriptPath}`,
      "",
    ].join("\n"));
    add(manuscriptPath, sceneText());
  }
  return files;
}

function moduleContext(): ModuleContext {
  return {
    cacheDirectory: "/tmp/scriptorium-p10-test-cache",
    signal: new AbortController().signal,
    async acquireCapability() { throw new Error("Capability leases are supplied by ModuleRuntime"); },
    async createWorkerService() { throw new Error("Worker services are supplied by ModuleRuntime"); },
  };
}

function readManifest(url: URL): ModuleManifest {
  return JSON.parse(readFileSync(url, "utf8")).scriptoriumModule as ModuleManifest;
}

async function createRuntime(
  files: Map<string, { content: string; revision: string }>,
  getSnapshot: () => SnapshotId,
  cacheDirectory: string,
): Promise<{ runtime: ModuleRuntime; host: Parameters<ModuleRuntime["invokeAction"]>[3] }> {
  const stub = moduleContext();
  const [storyDefinition, nlpDefinition, diagnosticsDefinition, speakerDefinition] = await Promise.all([
    createStoryModule(stub), createNlpModule(stub), createDiagnosticsModule(stub), createSpeakerModule(stub),
  ]);
  const manifests = [
    readManifest(new URL("../../story/package.json", import.meta.url)),
    readManifest(new URL("../../nlp/package.json", import.meta.url)),
    readManifest(new URL("../../diagnostics/package.json", import.meta.url)),
    readManifest(new URL("../package.json", import.meta.url)),
  ];
  assert.deepEqual(storyDefinition.manifest, manifests[0]);
  assert.deepEqual(nlpDefinition.manifest, manifests[1]);
  assert.deepEqual(diagnosticsDefinition.manifest, manifests[2]);
  assert.deepEqual(speakerDefinition.manifest, manifests[3]);
  const runtime = new ModuleRuntime({
    manifests,
    enabled: ["speaker"],
    cacheDirectory,
    loaders: {
      story: (context) => createStoryModule(context),
      nlp: (context) => createNlpModule(context),
      diagnostics: (context) => createDiagnosticsModule(context),
      speaker: (context) => createSpeakerModule(context),
    },
    workerEntries: {
      nlp: fileURLToPath(new URL("../../nlp/dist/worker.js", import.meta.url)),
      diagnostics: fileURLToPath(new URL("../../diagnostics/dist/worker.js", import.meta.url)),
      speaker: fileURLToPath(new URL("../dist/worker.js", import.meta.url)),
    },
  });
  const host = {
    projectId: repository.repositoryId,
    signal: new AbortController().signal,
    reader: {
      get snapshot() { return getSnapshot(); },
      async read(filePath: string) { return files.get(filePath) ?? null; },
      async list(prefix: string) {
        return [...files.keys()].filter((filePath) => filePath === prefix || filePath.startsWith(`${prefix}/`)).sort();
      },
    },
    async propose(operations: ChangeOperation[], evidence?: ChangeProposal["evidence"], proposalId?: string) {
      const snapshot = getSnapshot();
      for (const operation of operations) assertChangeOperation(operation);
      const proposal: ChangeProposal = { id: proposalId ?? `p10-proposal-${Date.now()}`, snapshot, operations, source: "module", ...(evidence ? { evidence } : {}) };
      return proposal;
    },
  };
  return { runtime, host };
}

function applyReviewedProposal(
  proposal: ChangeProposal,
  files: Map<string, { content: string; revision: string }>,
  getSnapshot: () => SnapshotId,
  setSnapshot: (snapshot: SnapshotId) => void,
): void {
  assert.deepEqual(proposal.snapshot, getSnapshot(), "Core proposal must be bound to the pinned snapshot being reviewed");
  for (const operation of proposal.operations) {
    assertChangeOperation(operation);
    assert.equal(operation.baseRemoteCommit, proposal.snapshot.remoteCommit);
    for (const read of operation.reads) assert.equal(files.get(read.path)?.revision ?? null, read.revision, `${read.path} read revision`);
    for (const write of operation.writes) {
      if (write.content === null) files.delete(write.path);
      else files.set(write.path, { content: write.content, revision: fileRevision(write.content) });
    }
  }
  setSnapshot(snapshotFor(files));
}

function dataOf(result: Awaited<ReturnType<ModuleRuntime["invokeAction"]>>): Record<string, unknown> {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error(result.error.message);
  assert.ok(result.data && typeof result.data === "object" && !Array.isArray(result.data));
  return result.data as Record<string, unknown>;
}

test("speaker actions run real CPU attribution, propose corrections/model adoption, and reload from the reviewed snapshot", { timeout: 180_000 }, async () => {
  const files = initialFiles();
  let snapshot = snapshotFor(files);
  const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), "scriptorium-p10-cache-"));
  let runtime: ModuleRuntime | undefined;
  try {
    const first = await createRuntime(files, () => snapshot, cacheDirectory);
    runtime = first.runtime;
    const { host } = first;

    assert.equal(runtime.status("speaker").availability, "enabled-idle");
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, [], "enabled-idle speaker allocates neither tokenizer nor speaker worker");

    const sceneId = "sc-synthetic-01";
    const attributed = await runtime.invokeAction("speaker", "speaker.attribute", { sceneId }, host);
    const attributionData = dataOf(attributed);
    assert.deepEqual(attributed.snapshot, snapshot);
    const attributions = attributionData.attributions as Array<{ sentenceIndex: number; text: string; speakerEntityId: string | null; confidence: string; reason: string }>;
    assert.equal(attributions.length, 1, JSON.stringify(attributions));
    const predicted = attributions[0]!;
    assert.equal(predicted.text, "『俺が行く。』");
    assert.equal(predicted.speakerEntityId, "char-hero", JSON.stringify(predicted));
    assert.equal(predicted.confidence, "high", JSON.stringify(predicted));

    const voice = await runtime.invokeAction("speaker", "speaker.voice.check", { sceneId }, host);
    const voiceData = dataOf(voice);
    const voiceWarnings = voiceData.warnings as Array<{ issue: string; basis: string }>;
    assert.ok(voiceWarnings.some((warning) => warning.issue === "unexpected-first-person" && warning.basis === "profile"), JSON.stringify(voiceData));
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, [], "voice-check worker and its shared Lindera lease are released after the action");

    for (let index = 0; index < 14; index += 1) {
      const currentSceneId = `sc-synthetic-${String(index + 1).padStart(2, "0")}`;
      const sceneResult = await runtime.invokeAction("speaker", "speaker.attribute", { sceneId: currentSceneId }, host);
      const sceneData = dataOf(sceneResult);
      const row = (sceneData.attributions as typeof attributions)[0]!;
      assert.equal(row.speakerEntityId, "char-hero", `synthetic rule attribution ${currentSceneId}`);
      const proposed = await runtime.invokeAction("speaker", "speaker.override", {
        sceneId: currentSceneId,
        sentenceIndex: row.sentenceIndex,
        dialogueText: row.text,
        speakerEntityId: null,
      }, host);
      const proposalData = dataOf(proposed);
      assert.equal(proposed.ok && proposed.proposals?.length, 1, JSON.stringify(proposed));
      const proposal = proposed.ok ? proposed.proposals?.[0] : undefined;
      assert.ok(proposal, JSON.stringify(proposalData));
      assert.deepEqual(proposal.operations[0]?.writes.map((write) => write.path).sort(), [
        `meta/scriptorium/modules/speaker/corrections.jsonl`,
        `plot/volumes/volume-1/scenes/${currentSceneId}.yaml`,
      ].sort());
      applyReviewedProposal(proposal, files, () => snapshot, (next) => { snapshot = next; });
      assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, [], "each action releases both supervised CPU processes");
    }

    const correctionPath = "meta/scriptorium/modules/speaker/corrections.jsonl";
    const corrections = files.get(correctionPath)?.content ?? "";
    assert.equal(corrections.trim().split("\n").length, 14);
    assert.ok(corrections.includes('"speakerEntityId":null'));

    const holdoutIds = ["sc-synthetic-13", "sc-synthetic-14"];
    const trained = await runtime.invokeAction("speaker", "speaker.retraining.run", { holdoutSceneIds: holdoutIds }, host);
    const trainingData = dataOf(trained);
    assert.equal(trainingData.adopted, true, JSON.stringify({ accuracyWithoutModel: trainingData.accuracyWithoutModel, accuracyWithModel: trainingData.accuracyWithModel, deltaPt: trainingData.deltaPt }));
    assert.ok(Number(trainingData.deltaPt) >= 5, JSON.stringify(trainingData));
    assert.ok(Number(trainingData.trainExampleCount) >= 10);
    assert.ok(Array.isArray(trainingData.model && (trainingData.model as Record<string, unknown>).weights));
    const modelProposal = trained.ok ? trained.proposals?.find((proposal) => proposal.operations.some((operation) => operation.writes.some((write) => write.path === "meta/scriptorium/modules/speaker/adopted-model.json"))) : undefined;
    assert.ok(modelProposal, "only the host proposal boundary receives the adopted CPU model");
    const modelOperation = modelProposal.operations[0]!;
    assert.equal(modelOperation.effect, "settings");
    assert.deepEqual(modelOperation.writes.map((write) => write.path), ["meta/scriptorium/modules/speaker/adopted-model.json"]);
    applyReviewedProposal(modelProposal, files, () => snapshot, (next) => { snapshot = next; });

    const applied = await runtime.invokeAction("speaker", "speaker.attribute", { sceneId: holdoutIds[0] }, host);
    const appliedData = dataOf(applied);
    const appliedRow = (appliedData.attributions as typeof attributions)[0]!;
    assert.equal(appliedRow.speakerEntityId, null, JSON.stringify(appliedRow));
    assert.equal(appliedRow.reason, "rerank", JSON.stringify(appliedRow));
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, []);

    const evaluation = await runtime.invokeAction("speaker", "speaker.evaluation.run", { writeGates: true }, host);
    const evaluationData = dataOf(evaluation);
    assert.equal(evaluationData.gatesUpdated, true);
    const report = evaluationData.report as { scenes: Array<{ sceneId: string }>; metrics: { attributionAccuracy: number } };
    assert.equal(report.scenes.length, 14);
    assert.equal(report.metrics.attributionAccuracy, 1, JSON.stringify(report.metrics));
    const latest = await runtime.invokeAction("speaker", "speaker.evaluation.latest", {}, host);
    assert.equal((dataOf(latest).exists), true);
    const gates = await runtime.invokeAction("speaker", "speaker.ruleGates", {}, host);
    assert.equal((dataOf(gates).exists), true);

    await runtime.shutdown();
    runtime = undefined;
    assert.deepEqual(files.get("meta/scriptorium/modules/speaker/adopted-model.json") && JSON.parse(files.get("meta/scriptorium/modules/speaker/adopted-model.json")!.content).weights, (trainingData.model as Record<string, unknown>).weights);

    const restarted = await createRuntime(files, () => snapshot, cacheDirectory);
    runtime = restarted.runtime;
    assert.equal(runtime.status("speaker").availability, "enabled-idle");
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, [], "recreated runtime starts idle and reloads only on demand");
    const reloaded = await runtime.invokeAction("speaker", "speaker.attribute", { sceneId: holdoutIds[0] }, restarted.host);
    const reloadedRow = (dataOf(reloaded).attributions as typeof attributions)[0]!;
    assert.equal(reloadedRow.speakerEntityId, null, JSON.stringify(reloadedRow));
    assert.equal(reloadedRow.reason, "rerank", JSON.stringify(reloadedRow));
    assert.equal((dataOf(await runtime.invokeAction("speaker", "speaker.evaluation.latest", {}, restarted.host))).exists, true);
    assert.equal((dataOf(await runtime.invokeAction("speaker", "speaker.ruleGates", {}, restarted.host))).exists, true);
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, [], "all worker and shared tokenizer processes exit after reload checks");
  } finally {
    await runtime?.shutdown();
    await rm(cacheDirectory, { recursive: true, force: true });
  }
});
