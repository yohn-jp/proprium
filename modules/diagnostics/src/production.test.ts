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
  assert.ok(diagnosticsDefinition.ui?.some((item) => item.id === "diagnostics.consistency" && item.action === "diagnostics.checkConsistency"));
  assert.ok(diagnosticsDefinition.ui?.some((item) => item.id === "diagnostics.continuity" && item.action === "diagnostics.checkContinuity"));
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
    assert.deepEqual(analyzed.snapshot, snapshot);
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
    assert.deepEqual(candidates.snapshot, snapshot);
    if (candidates.ok) {
      const candidateData = candidates.data as { candidates: Array<{ term: string; sourceEntityIds: string[] }>; sourceCount: number };
      assert.equal(candidateData.sourceCount, 3, "candidate discovery reads canonical YAML and manuscript files without a Story module");
      assert.ok(candidateData.candidates.every((candidate) => candidate.sourceEntityIds.every((id) => id === "char-hero" || id === "scene-1" || id === "ms-v1-scene-1")));
    }

    const diagnosticsText = "星野は古い遺跡へ走った。黒い霧が道を塞ぐ。";
    const diagnostics = await runtime.invokeAction("diagnostics", "diagnostics.analyze", { text: diagnosticsText, sceneId: "scene-1" }, host);
    assert.equal(diagnostics.ok, true, JSON.stringify(diagnostics));
    assert.deepEqual(diagnostics.snapshot, snapshot);
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

    const sentiment = await runtime.invokeAction("diagnostics", "diagnostics.analyze", { text: "彼は悲しい。" }, host);
    assert.equal(sentiment.ok, true, JSON.stringify(sentiment));
    if (sentiment.ok) {
      const arc = (sentiment.data as { analysis: { sentimentArc: { points: Array<{ raw: number }> } } }).analysis.sentimentArc;
      assert.ok(arc.points[0]?.raw < 0, "the worker loads the packaged project lexicon and scores a source-covered negative term");
    }

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
  files.set("plot/volumes/volume-1/volume.yaml", { content: "id: vol-volume-1\nname: 第一巻\norder: 1\n", revision: "volume-r1" });
  files.set("plot/volumes/volume-1/chapter.yaml", { content: "id: ch-chapter-1\nname: 第一章\nvolume: vol-volume-1\norder: 1\n", revision: "chapter-r1" });
  files.set("plot/volumes/volume-1/scenes/scene-1.yaml", { content: "id: sc-scene-1\ntype: scene\nname: 遺跡\nchapter: ch-chapter-1\norder: 1\nlocation: loc-a\nappears: [char-hero]\nmentions: [char-ghost]\neffects:\n  - action: acquire_item\n    characterId: char-hero\n    itemId: relic-1\nmanuscript: manuscript/v1/scene-1.md\n", revision: "scene-r1" });
  files.set("plot/volumes/volume-1/scenes/scene-2.yaml", { content: "id: sc-scene-2\ntype: scene\nname: 帰路\nchapter: ch-chapter-1\norder: 2\nlocation: loc-b\nappears: [char-hero, char-companion]\neffects:\n  - action: use_item\n    characterId: char-companion\n    itemId: relic-1\nmanuscript: manuscript/v1/scene-2.md\n", revision: "scene-2-r1" });
  files.set("bible/characters/companion/profile.yaml", { content: "id: char-companion\nname: 旅人\n", revision: "companion-r1" });
  files.set("bible/locations/loc-a.yaml", { content: "id: loc-a\nname: 遺跡\n", revision: "loc-a-r1" });
  files.set("bible/locations/loc-b.yaml", { content: "id: loc-b\nname: 村\n", revision: "loc-b-r1" });
  files.set("plot/threads/thread-1.yaml", { content: "id: thread-1\nname: 古い約束\nstatus: open\n", revision: "thread-r1" });
  files.set("manuscript/v1/scene-2.md", { content: "---\ntitle: 帰路\n---\n前日、旅人は遺物を手にした。", revision: "manuscript-2-r1" });
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

    const consistency = await runtime.invokeAction("diagnostics", "diagnostics.checkConsistency", {}, host);
    assert.equal(consistency.ok, true, JSON.stringify(consistency));
    assert.deepEqual(consistency.snapshot, snapshot);
    if (consistency.ok) {
      const issues = (consistency.data as { issues: Array<{ code: string }> }).issues;
      assert.ok(issues.some((issue) => issue.code === "THREAD_NO_PLANT"), "open-thread validation is sourced from the entity/link graph");
      assert.ok(issues.some((issue) => issue.code === "MISSING_LINK_TARGET"), "validation reports a missing linked entity");
    }
    const continuity = await runtime.invokeAction("diagnostics", "diagnostics.checkContinuity", {}, host);
    assert.equal(continuity.ok, true, JSON.stringify(continuity));
    assert.deepEqual(continuity.snapshot, snapshot);
    if (continuity.ok) {
      const warnings = (continuity.data as { warnings: Array<{ reason: string }> }).warnings;
      assert.ok(warnings.some((warning) => warning.reason === "non-adjacent-location"));
      assert.ok(warnings.some((warning) => warning.reason === "item-owner-mismatch"));
      assert.ok(warnings.some((warning) => warning.reason === "unrecorded-teleport"));
      assert.ok(warnings.some((warning) => warning.reason === "timeline-reversal"));
    }
    const scopedConsistency = await runtime.invokeAction("diagnostics", "diagnostics.checkConsistency", { scope: "sc-scene-1" }, host);
    assert.equal(scopedConsistency.ok, true, JSON.stringify(scopedConsistency));
    if (scopedConsistency.ok) {
      const result = scopedConsistency.data as { scope: string; issues: Array<{ code: string }> };
      assert.equal(result.scope, "sc-scene-1");
      assert.ok(result.issues.some((issue) => issue.code === "MISSING_LINK_TARGET"));
      assert.ok(!result.issues.some((issue) => issue.code === "THREAD_NO_PLANT"), "unrelated issues are filtered like the scoped source route");
    }
    const scopedContinuity = await runtime.invokeAction("diagnostics", "diagnostics.checkContinuity", { scope: "sc-scene-1" }, host);
    assert.equal(scopedContinuity.ok, true, JSON.stringify(scopedContinuity));
    if (scopedContinuity.ok) {
      const result = scopedContinuity.data as { scope: string; warnings: Array<{ sceneId: string; previousSceneId: string }> };
      assert.equal(result.scope, "sc-scene-1");
      assert.ok(result.warnings.some((warning) => warning.sceneId === "sc-scene-2"), "continuity scope includes its adjacent scene as the source route does");
    }
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, [], "project rule checks stay local and do not start NLP workers");
  } finally {
    await runtime.shutdown();
  }
});
