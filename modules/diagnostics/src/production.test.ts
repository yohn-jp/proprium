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
  ["meta/scriptorium/modules/nlp/synonyms.yaml", { content: "ownerNote: preserve\ngroups:\n  - words: [強い, 力強い]\n    context: positive\n", revision: "synonyms-r1" }],
  ["meta/scriptorium/modules/nlp/candidate-ignore-list.yaml", { content: "ownerNote: preserve\nignored:\n  - 既存語\n", revision: "ignored-r1" }],
  ["meta/scriptorium/modules/nlp/feature-settings.json", { content: "{\"externalEnabled\":{\"setting-qa\":false}}\n", revision: "features-r1" }],
]);

async function createRuntime(files: Map<string, { content: string; revision: string }>, proposals: ChangeProposal[], capabilityProviders: Record<string, { create(): unknown; dispose?(value: unknown): void | Promise<void> }> = {}) {
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
    capabilityProviders,
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

test("source manuscript formatter proposes a frontmatter-preserving edit without an external provider", async () => {
  const files = new Map(initialFiles);
  const frontMatter = "---\ntitle: 遺跡\nauthor_note: keep this\ncustom:\n  nested: true\n---\n";
  const original = `${frontMatter}　地の文…\n\t「会話」\n\n`;
  files.set("manuscript/v1/scene-1.md", { content: original, revision: "format-r1" });
  const proposals: ChangeProposal[] = [];
  const { runtime, host } = await createRuntime(files, proposals);
  try {
    const result = await runtime.invokeAction("diagnostics", "diagnostics.formatManuscript", { sceneId: "scene-1" }, host);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.snapshot, snapshot);
    if (!result.ok) return;
    const data = result.data as { actionId: string; resultId: string; proposalId: string | null; formattedText: string; proposal: ChangeProposal | null };
    assert.equal(data.actionId, "format-manuscript");
    assert.match(data.resultId, /^na-[a-f0-9]{64}$/u);
    assert.equal(data.formattedText, "地の文……\n\n「会話」");
    assert.equal(data.proposalId, data.proposal?.id);
    assert.equal(proposals.length, 1);
    assert.equal(data.proposal?.operations[0]?.id, `${data.proposalId}-replace`);
    assert.deepEqual(data.proposal?.operations[0]?.reads, [{ path: "manuscript/v1/scene-1.md", revision: "format-r1" }]);
    assert.equal(data.proposal?.operations[0]?.writes[0]?.content, `${frontMatter}${data.formattedText}`);
    assert.equal(files.get("manuscript/v1/scene-1.md")?.content, original, "formatting is proposal-only");
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, [], "local formatting does not start tokenizer, semantic, or LLM workers");

    files.set("manuscript/v1/scene-1.md", { content: `${frontMatter}${data.formattedText}`, revision: "format-r2" });
    const unchanged = await runtime.invokeAction("diagnostics", "diagnostics.formatManuscript", { sceneId: "scene-1" }, host);
    assert.equal(unchanged.ok, true, JSON.stringify(unchanged));
    if (unchanged.ok) {
      const noChange = unchanged.data as typeof data;
      assert.equal(noChange.formattedText, data.formattedText);
      assert.equal(noChange.proposalId, null);
      assert.equal(noChange.proposal, null);
    }
    assert.equal(proposals.length, 1, "already formatted text produces no empty proposal");
  } finally {
    await runtime.shutdown();
  }
});

test("corpus synonym suggestions acquire the optional snapshot-indexed provider and keep model identity", { timeout: 90_000 }, async () => {
  const files = new Map(initialFiles);
  const proposals: ChangeProposal[] = [];
  const providerCalls: Array<{ kind: string; values: unknown[] }> = [];
  const model = { id: "p06-test-semantic", version: "test-model-v1", dimensions: 3 };
  const capabilityProviders = {
    "semantic.embedding": {
      create: () => ({
        model,
        async index(passages: Array<{ entityId: string; sceneId: string; sentenceIndex: number; text: string; type?: string }>, target: SnapshotId, signal: AbortSignal) {
          assert.equal(signal.aborted, false);
          assert.deepEqual(target, snapshot);
          providerCalls.push({ kind: "index", values: passages });
          assert.ok(passages.some((passage) => passage.entityId === "ms-v1-scene-1" && passage.type === "manuscript"));
          assert.ok(passages.some((passage) => passage.entityId === "char-hero" && passage.text.includes("星の剣士")));
          return { snapshot: target, model: model.id, modelVersion: model.version, dimensions: model.dimensions, scanned: passages.length, embedded: passages.length, reused: 0, removed: 0 };
        },
        async nearest(query: string, target: SnapshotId, options: { limit?: number; excludeSceneIds?: readonly string[] }, signal: AbortSignal) {
          assert.equal(signal.aborted, false);
          assert.equal(target.remoteCommit, snapshot.remoteCommit);
          providerCalls.push({ kind: "nearest", values: [query, options] });
          return {
            snapshot: target, model: model.id, modelVersion: model.version, dimensions: model.dimensions,
            hits: [{ entityId: "neighbor-1", sceneId: "neighbor-1", sentenceIndex: 0, text: "彼は寂しい。", score: 0.8 }],
          };
        },
      }),
      dispose: () => { providerCalls.push({ kind: "dispose", values: [] }); },
    },
  };
  const { runtime, host } = await createRuntime(files, proposals, capabilityProviders);
  try {
    assert.equal(runtime.status("diagnostics").availability, "enabled-idle");
    assert.equal(providerCalls.length, 0, "declared optional provider remains idle until a corpus suggestion is needed");
    const result = await runtime.invokeAction("diagnostics", "diagnostics.analyze", {
      text: "彼は悲しい。彼は悲しい。彼は悲しい。", sceneId: "scene-1",
    }, host);
    assert.equal(result.ok, true, `${JSON.stringify(result)}\n${JSON.stringify(providerCalls)}`);
    assert.deepEqual(result.snapshot, snapshot);
    if (!result.ok) return;
    const data = result.data as { analysis: { habitualPhraseWarnings: Array<{ phrase: string }> }; semanticEmbedding?: { model: string; modelVersion: string; dimensions: number }; synonymSuggestions: Array<{ candidates: Array<{ source: string; text: string }> }> };
    assert.ok(data.analysis.habitualPhraseWarnings.some((warning) => warning.phrase === "彼は悲しい"));
    assert.deepEqual(data.semanticEmbedding, { model: model.id, modelVersion: model.version, dimensions: model.dimensions }, JSON.stringify(providerCalls));
    assert.ok(data.synonymSuggestions.some((suggestion) => suggestion.candidates.some((candidate) => candidate.source === "corpus" && candidate.text === "彼は寂しい")));
    const nearest = providerCalls.find((call) => call.kind === "nearest");
    assert.ok(nearest);
    assert.equal(nearest.values[0], "彼は悲しい");
    assert.deepEqual(nearest.values[1], { limit: 24, excludeSceneIds: ["scene-1"] });
    assert.ok(providerCalls.some((call) => call.kind === "dispose"), "the provider lease is released after the action");
  } finally {
    await runtime.shutdown();
  }
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

    const synonymUpdate = await runtime.invokeAction("nlp", "nlp.saveSynonymGroup", { words: ["剛健"], mergeGroupIndex: 0 }, host);
    assert.equal(synonymUpdate.ok, true, JSON.stringify(synonymUpdate));
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]?.operations[0]?.writes[0]?.path, "meta/scriptorium/modules/nlp/synonyms.yaml");
    assert.match(proposals[0]?.operations[0]?.writes[0]?.content ?? "", /ownerNote: preserve/u);
    assert.match(proposals[0]?.operations[0]?.writes[0]?.content ?? "", /剛健/u, "a single word can be added to an existing source group");

    const ignoreUpdate = await runtime.invokeAction("nlp", "nlp.ignoreCandidates", { terms: ["新候補"] }, host);
    assert.equal(ignoreUpdate.ok, true, JSON.stringify(ignoreUpdate));
    assert.equal(proposals.length, 2);
    assert.equal(proposals[1]?.operations[0]?.writes[0]?.path, "meta/scriptorium/modules/nlp/candidate-ignore-list.yaml");
    assert.match(proposals[1]?.operations[0]?.writes[0]?.content ?? "", /ownerNote: preserve/u);
    assert.match(proposals[1]?.operations[0]?.writes[0]?.content ?? "", /既存語/u);
    assert.match(proposals[1]?.operations[0]?.writes[0]?.content ?? "", /新候補/u);

    const features = await runtime.invokeAction("nlp", "nlp.features", {}, host);
    assert.equal(features.ok, true, JSON.stringify(features));
    if (features.ok) {
      const featureData = features.data as { features: Array<{ id: string; locality: "local" | "external"; enabled: boolean }>; settings: { externalEnabled: Record<string, boolean> } };
      const settings = featureData.settings;
      assert.equal(settings.externalEnabled["setting-qa"], false);
      assert.equal(featureData.features.find((feature) => feature.id === "setting-qa")?.enabled, false);
      assert.equal(featureData.features.find((feature) => feature.id === "rewrite")?.enabled, false, "missing external consent is opt-in denied");
      assert.equal(featureData.features.find((feature) => feature.id === "embedding")?.enabled, true, "local features do not require external-send consent");
    }

    const lint = await runtime.invokeAction("diagnostics", "diagnostics.proposeLintFix", {
      path: "manuscript/v1/scene-1.md", baseRevision: "manuscript-r1", operationId: "mcp-p06-lint-1",
    }, host);
    assert.equal(lint.ok, true, JSON.stringify(lint));
    assert.equal(proposals.length, 3, "lint output is proposed for review, never written directly");
    const operation = proposals[2].operations[0];
    assert.equal(operation.id, "mcp-p06-lint-1");
    assert.equal(operation.reads[0].revision, "manuscript-r1");
    assert.ok(operation.writes[0].content?.startsWith("---\ntitle: 遺跡\n---\n"));
    assert.equal(files.get("manuscript/v1/scene-1.md")?.content, initialFiles.get("manuscript/v1/scene-1.md")?.content);

    const consent = await runtime.invokeAction("nlp", "nlp.updateExternalConsent", { externalEnabled: { "setting-qa": true } }, host);
    assert.equal(consent.ok, true, JSON.stringify(consent));
    assert.equal(proposals.length, 4);
    assert.equal(proposals[3].operations[0].writes[0].path, "meta/scriptorium/modules/nlp/feature-settings.json");
    const consentBeforeApproval = await runtime.invokeAction("nlp", "nlp.features", {}, host);
    assert.equal(consentBeforeApproval.ok, true, JSON.stringify(consentBeforeApproval));
    if (consentBeforeApproval.ok) {
      const feature = (consentBeforeApproval.data as { features: Array<{ id: string; enabled: boolean }> }).features.find((item) => item.id === "setting-qa");
      assert.equal(feature?.enabled, false, "proposing consent does not activate it before Core approval changes the selected snapshot");
    }

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
    const voice = await runtime.invokeAction("diagnostics", "diagnostics.voiceConsistency", {
      attributions: [
        { speakerEntityId: "char-hero", confidence: "low", text: "『俺は行く』", sentenceIndex: 1 },
        { speakerEntityId: "char-companion", confidence: "high", text: "『俺は行く』", sentenceIndex: 2 },
      ],
      speakerDefinitions: {
        "char-hero": { voicePatterns: { firstPerson: ["僕"] } },
        "char-companion": { voice_profiles: [
          { id: "formal", context_trigger: { type: "match_metadata", key: "situation", value: "formal" }, firstPerson: ["私"] },
          { id: "default", firstPerson: ["僕"] },
        ] },
      },
      sceneMetadata: { situation: "formal" },
    }, host);
    assert.equal(voice.ok, true, JSON.stringify(voice));
    assert.deepEqual(voice.snapshot, snapshot);
    if (voice.ok) {
      const warnings = (voice.data as { warnings: Array<{ issue: string; speakerEntityId: string; expected: string[]; basis: string }> }).warnings;
      assert.equal(warnings.length, 2, "low-confidence attributions and declared context profiles retain source checks");
      assert.ok(warnings.every((warning) => warning.issue === "unexpected-first-person" && warning.basis === "profile"));
      assert.deepEqual(warnings.map((warning) => warning.expected), [["僕"], ["私"]]);
    }

    const profiles = await runtime.invokeAction("diagnostics", "diagnostics.voiceProfiles", {
      dialoguesByCharacter: { "char-hero": ["『僕は行く』", "『僕が帰る』", "『僕は進む』"] },
    }, host);
    assert.equal(profiles.ok, true, JSON.stringify(profiles));
    assert.deepEqual(profiles.snapshot, snapshot);
    if (!profiles.ok) return;
    const profileData = profiles.data as { fingerprints: Array<Record<string, unknown> & { entityId: string; dialogueCount: number; firstPersonDist: Record<string, number> }>; stylometricProfiles: Array<{ entityId: string; dialogueCount: number }> };
    const fingerprint = profileData.fingerprints.find((item) => item.entityId === "char-hero");
    assert.equal(fingerprint?.dialogueCount, 3);
    assert.equal(fingerprint?.firstPersonDist["僕"], 1);
    assert.equal(profileData.stylometricProfiles.find((item) => item.entityId === "char-hero")?.dialogueCount, 3);

    const voiceDeviations = await runtime.invokeAction("diagnostics", "diagnostics.voiceDeviations", {
      attributions: [{ speakerEntityId: "char-hero", confidence: "high", text: "『俺は走る』", sentenceIndex: 1 }],
      fingerprints: [{ ...fingerprint, dialogueCount: 10 }],
    }, host);
    assert.equal(voiceDeviations.ok, true, JSON.stringify(voiceDeviations));
    if (voiceDeviations.ok) {
      const warnings = (voiceDeviations.data as { warnings: Array<{ issue: string; basis: string; found: string }> }).warnings;
      assert.ok(warnings.some((warning) => warning.issue === "unusual-first-person" && warning.basis === "statistical" && warning.found === "俺"));
    }

    const metrics = { typeTokenRatio: 0, morphemeCount: 0, commaFrequency: 0, adjectiveRatio: 0, verbRatio: 0 };
    const stylometricDeviations = await runtime.invokeAction("diagnostics", "diagnostics.stylometricDeviations", {
      attributions: [{ speakerEntityId: "char-hero", confidence: "high", text: "『俺が走る』", sentenceIndex: 1 }],
      profiles: [{ entityId: "char-hero", dialogueCount: 10, mean: metrics, stdDev: metrics }],
    }, host);
    assert.equal(stylometricDeviations.ok, true, JSON.stringify(stylometricDeviations));
    if (stylometricDeviations.ok) {
      const warnings = (stylometricDeviations.data as { warnings: Array<{ distance: number; threshold: number }> }).warnings;
      assert.ok(warnings.some((warning) => warning.distance > warning.threshold), "source stylometric distance reports an out-of-profile utterance");
    }
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, [], "all NLP and diagnostics worker leases are released after each action");
  } finally {
    await runtime.shutdown();
  }
});
