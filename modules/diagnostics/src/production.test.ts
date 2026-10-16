import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { ChangeOperation, ChangeProposal, ModuleContext, SnapshotId } from "@scriptorium/contracts";
import { ModuleRuntime } from "@scriptorium/module-runtime";
import { createModule as createNlpModule } from "@scriptorium/module-nlp";
import { createModule as createDiagnosticsModule } from "./index.js";

const snapshot: SnapshotId = {
  repository: { provider: "local", repositoryId: "p06-production", defaultBranch: "main", ownerScope: "local-owner", url: "file:///p06-production" },
  remoteCommit: "c".repeat(40),
};

function moduleContext(): ModuleContext {
  return {
    cacheDirectory: "/tmp/scriptorium-p06-test-cache",
    signal: new AbortController().signal,
    async acquireCapability() { throw new Error("module context capability is available only during runtime invocation"); },
    async createWorkerService() { throw new Error("module context worker service is available only during runtime invocation"); },
  };
}

const initialFiles = new Map<string, { content: string; revision: string }>([
  ["bible/characters/hero/profile.yaml", { content: "id: char-hero\nname: 星野\naliases:\n  - 星の剣士\nnotes: 星の剣士は古い遺跡を調べる。\n", revision: "hero-r1" }],
  ["plot/volumes/v1/scenes/scene-1.yaml", { content: "id: scene-1\ntype: scene\nname: 遺跡\nintended_tone: suspense\ngoal: 鍵を見つけて扉を開ける\nconflict: 黒い霧が道を塞ぐ\nmanuscript: manuscript/v1/scene-1.md\n", revision: "scene-r1" }],
  ["manuscript/v1/scene-1.md", { content: "---\ntitle: 遺跡\n---\n「……」\n星野は古い遺跡へ走った。黒い霧が道を塞ぐ。\n", revision: "manuscript-r1" }],
  ["meta/scriptorium/modules/nlp/synonyms.yaml", { content: "groups:\n  - words: [強い, 力強い]\n    context: positive\n", revision: "synonyms-r1" }],
  ["meta/scriptorium/modules/nlp/feature-settings.json", { content: "{\"externalEnabled\":{\"setting-qa\":false}}\n", revision: "features-r1" }],
]);

async function createRuntime(files: Map<string, { content: string; revision: string }>, proposals: ChangeProposal[]) {
  const stub = moduleContext();
  const nlpDefinition = await createNlpModule(stub);
  const diagnosticsDefinition = await createDiagnosticsModule(stub);
  const packageManifest = (url: URL) => JSON.parse(readFileSync(url, "utf8")).scriptoriumModule;
  const nlpManifest = packageManifest(new URL("../../nlp/package.json", import.meta.url));
  const diagnosticsManifest = packageManifest(new URL("../package.json", import.meta.url));
  assert.deepEqual(nlpDefinition.manifest, nlpManifest, "NLP factory metadata must match installed package metadata");
  assert.deepEqual(diagnosticsDefinition.manifest, diagnosticsManifest, "diagnostics factory metadata must match installed package metadata");
  const manifests = [nlpManifest, diagnosticsManifest];
  const runtime = new ModuleRuntime({
    manifests,
    enabled: ["diagnostics"],
    cacheDirectory: "/tmp/scriptorium-p06-test-cache",
    loaders: {
      nlp: (context) => createNlpModule(context),
      diagnostics: (context) => createDiagnosticsModule(context),
    },
    workerEntries: {
      nlp: fileURLToPath(new URL("../../nlp/dist/worker.js", import.meta.url)),
      diagnostics: fileURLToPath(new URL("../dist/worker.js", import.meta.url)),
    },
  });
  const host = {
    projectId: "p06-production",
    signal: new AbortController().signal,
    reader: {
      snapshot,
      async read(path: string) { return files.get(path) ?? null; },
      async list(prefix: string) { return [...files.keys()].filter((path) => path.startsWith(`${prefix}/`)).sort(); },
    },
    async propose(operations: ChangeOperation[], evidence?: ChangeProposal["evidence"], proposalId?: string) {
      const proposal = { id: proposalId ?? `proposal-${proposals.length + 1}`, snapshot, operations, source: "module" as const, ...(evidence ? { evidence } : {}) };
      proposals.push(proposal);
      return proposal;
    },
  };
  return { runtime, host };
}

test("production modules lazily run the real Lindera child and preserve snapshot-derived NLP and diagnostics behavior", { timeout: 90_000 }, async () => {
  const files = new Map(initialFiles);
  const proposals: ChangeProposal[] = [];
  const { runtime, host } = await createRuntime(files, proposals);
  try {
    assert.equal(runtime.status("nlp").availability, "enabled-idle");
    assert.equal(runtime.status("diagnostics").availability, "enabled-idle");
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, [], "enabled-idle modules must not load the model or start workers");

    const analysisPromise = runtime.invokeAction("nlp", "nlp.analyze", { text: "😀猫が走る。東京へ行く。" }, host);
    let observedRealWorker = false;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (runtime.workerSupervisor.activeWorkerPids.length > 0) { observedRealWorker = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const analyzed = await analysisPromise;
    assert.equal(observedRealWorker, true, "the public action must start an actual supervised child process");
    assert.equal(analyzed.ok, true, JSON.stringify(analyzed));
    if (!analyzed.ok) return;
    const nlpData = analyzed.data as { analysis: { text: string; tokens: Array<{ surface: string; start: number; end: number }>; sentences: Array<{ start: number; end: number; text: string }> }; engine: string; engineVersion: string };
    assert.equal(nlpData.engine, "lindera-wasm-nodejs-ipadic");
    assert.equal(nlpData.engineVersion, "2.0.0");
    assert.equal(nlpData.analysis.text, "😀猫が走る。東京へ行く。");
    assert.ok(nlpData.analysis.tokens.length > 3);
    for (const token of nlpData.analysis.tokens) {
      assert.equal(nlpData.analysis.text.slice(token.start, token.end), token.surface, `real Lindera token span ${token.start}:${token.end}`);
    }
    assert.deepEqual(nlpData.analysis.sentences.map((sentence) => nlpData.analysis.text.slice(sentence.start, sentence.end)), nlpData.analysis.sentences.map((sentence) => sentence.text));

    const candidates = await runtime.invokeAction("nlp", "nlp.discoverCandidates", {}, host);
    assert.equal(candidates.ok, true, JSON.stringify(candidates));
    if (candidates.ok) {
      const candidateData = candidates.data as { candidates: Array<{ term: string; sourceEntityIds: string[] }>; sourceCount: number };
      assert.equal(candidateData.sourceCount, 3, "candidate discovery reads canonical YAML and manuscript files without a Story module");
      assert.ok(candidateData.candidates.every((candidate) => candidate.sourceEntityIds.every((id) => id === "char-hero" || id === "scene-1" || id === "ms-v1-scene-1")));
    }

    const diagnosticsText = "星野は古い遺跡へ走った。黒い霧が道を塞ぐ。";
    const diagnostics = await runtime.invokeAction("diagnostics", "diagnostics.analyze", { text: diagnosticsText, sceneId: "scene-1" }, host);
    assert.equal(diagnostics.ok, true, JSON.stringify(diagnostics));
    if (!diagnostics.ok) return;
    const data = diagnostics.data as { analysis: { charCount: number; sentenceCount: number; sentimentArc: { points: unknown[] } }; plotSemanticWarnings: unknown[]; synonymSuggestions: unknown[]; model: string; modelVersion: string; diagnosticsEngine: string };
    assert.equal(data.model, "lindera-wasm-nodejs-ipadic");
    assert.equal(data.modelVersion, "2.0.0");
    assert.equal(data.diagnosticsEngine, "scriptorium-diagnostics-cpu");
    assert.equal(data.analysis.charCount, diagnosticsText.length);
    assert.equal(data.analysis.sentenceCount, 2);
    assert.ok(data.analysis.sentimentArc.points.length > 0);
    assert.ok(Array.isArray(data.plotSemanticWarnings));
    assert.ok(Array.isArray(data.synonymSuggestions));

    const plot = await runtime.invokeAction("diagnostics", "diagnostics.checkPlotSemantics", { sceneId: "scene-1" }, host);
    assert.equal(plot.ok, true, JSON.stringify(plot));
    if (plot.ok) assert.ok(Array.isArray((plot.data as { warnings: unknown[] }).warnings));
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, [], "releasing the final capability lease terminates the real tokenizer child");
  } finally {
    await runtime.shutdown();
  }
  assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, [], "shutdown terminates the tokenizer child process");
});

test("public actions read namespaced dictionaries/settings and lint changes remain proposals", { timeout: 90_000 }, async () => {
  const files = new Map(initialFiles);
  const proposals: ChangeProposal[] = [];
  const { runtime, host } = await createRuntime(files, proposals);
  try {
    const dictionary = await runtime.invokeAction("nlp", "nlp.dictionary", { term: "強い" }, host);
    assert.equal(dictionary.ok, true, JSON.stringify(dictionary));
    if (dictionary.ok) assert.deepEqual((dictionary.data as { alternatives: string[] }).alternatives, ["力強い"]);

    const features = await runtime.invokeAction("nlp", "nlp.features", {}, host);
    assert.equal(features.ok, true, JSON.stringify(features));
    if (features.ok) {
      const settings = (features.data as { settings: { externalEnabled: Record<string, boolean> } }).settings;
      assert.equal(settings.externalEnabled["setting-qa"], false);
    }

    const lint = await runtime.invokeAction("diagnostics", "diagnostics.proposeLintFix", {
      path: "manuscript/v1/scene-1.md", baseRevision: "manuscript-r1", operationId: "mcp-p06-lint-1",
    }, host);
    assert.equal(lint.ok, true, JSON.stringify(lint));
    assert.equal(proposals.length, 1, "lint output is proposed for review, never written directly");
    const operation = proposals[0].operations[0];
    assert.equal(operation.id, "mcp-p06-lint-1");
    assert.equal(operation.reads[0].revision, "manuscript-r1");
    assert.ok(operation.writes[0].content?.startsWith("---\ntitle: 遺跡\n---\n"));
    assert.equal(files.get("manuscript/v1/scene-1.md")?.content, initialFiles.get("manuscript/v1/scene-1.md")?.content);

    const consent = await runtime.invokeAction("nlp", "nlp.updateExternalConsent", { externalEnabled: { "setting-qa": true } }, host);
    assert.equal(consent.ok, true, JSON.stringify(consent));
    assert.equal(proposals.length, 2);
    assert.equal(proposals[1].operations[0].writes[0].path, "meta/scriptorium/modules/nlp/feature-settings.json");
  } finally {
    await runtime.shutdown();
  }
});
