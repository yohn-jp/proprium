import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import YAML from "yaml";

import { CoreStore } from "../../../packages/core/dist/index.js";
import { ModuleRuntime } from "../../../packages/module-runtime/dist/index.js";

const execFile = promisify(execFileCallback);
const nlpPackageUrl = new URL("../../nlp/package.json", import.meta.url);
const diagnosticsPackageUrl = new URL("../package.json", import.meta.url);
const storyPackageUrl = new URL("../../story/package.json", import.meta.url);
const speakerPackageUrl = new URL("../../speaker/package.json", import.meta.url);
const nlpPackage = JSON.parse(await readFile(nlpPackageUrl, "utf8"));
const diagnosticsPackage = JSON.parse(await readFile(diagnosticsPackageUrl, "utf8"));
const storyPackage = JSON.parse(await readFile(storyPackageUrl, "utf8"));
const speakerPackage = JSON.parse(await readFile(speakerPackageUrl, "utf8"));
const nlpManifest = nlpPackage.scriptoriumModule;
const diagnosticsManifest = diagnosticsPackage.scriptoriumModule;
const storyManifest = storyPackage.scriptoriumModule;
const speakerManifest = speakerPackage.scriptoriumModule;
const nlpEntry = new URL("../../nlp/dist/index.js", import.meta.url).href;
const diagnosticsEntry = new URL("../dist/index.js", import.meta.url).href;
const storyEntry = new URL("../../story/dist/index.js", import.meta.url).href;
const speakerEntry = new URL("../../speaker/dist/index.js", import.meta.url).href;
const nlpWorker = fileURLToPath(new URL("../../nlp/dist/worker.js", import.meta.url));
const diagnosticsWorker = fileURLToPath(new URL("../dist/worker.js", import.meta.url));
const speakerWorker = fileURLToPath(new URL("../../speaker/dist/worker.js", import.meta.url));

const synonymsPath = "meta/scriptorium/modules/nlp/synonyms.yaml";
const ignoredPath = "meta/scriptorium/modules/nlp/candidate-ignore-list.yaml";
const featureSettingsPath = "meta/scriptorium/modules/nlp/feature-settings.json";
const lintConfigPath = "meta/scriptorium/modules/diagnostics/lint-rules.yaml";
const firstScenePath = "manuscript/vol-one/ch-one/sc-one.md";

async function git(cwd, ...args) {
  const { stdout } = await execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

async function writeText(root, relativePath, content) {
  const filePath = join(root, relativePath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function writeYaml(root, relativePath, value) {
  await writeText(root, relativePath, YAML.stringify(value));
}

async function createSyntheticRepository(root) {
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  await mkdir(seed, { recursive: true });
  await git(root, "init", "--bare", "--initial-branch=main", remote);
  await git(seed, "init", "--initial-branch=main");
  await git(seed, "config", "user.name", "P06 Synthetic Author");
  await git(seed, "config", "user.email", "p06-author@example.test");

  await writeYaml(seed, "meta/project.yaml", { id: "p06-synthetic", title: "P06 Synthetic Work", ownerNote: "preserve-project-metadata" });
  await writeYaml(seed, "plot/volumes/vol-one/volume.yaml", { id: "vol-one", name: "第一巻", order: 1 });
  await writeYaml(seed, "plot/volumes/vol-one/chapters/ch-one/chapter.yaml", { id: "ch-one", title: "第一章", volume: "vol-one", order: 1 });
  await writeYaml(seed, "plot/volumes/vol-one/chapters/ch-one/scenes/sc-one.yaml", {
    id: "sc-one", type: "scene", name: "遺跡", chapter: "ch-one", order: 1,
    location: "loc-a", appears: ["char-hero"], mentions: ["char-missing"],
    goal: "古文書を見つける", conflict: "黒い霧が道を塞ぐ", intended_tone: "suspense",
    manuscript: firstScenePath,
  });
  await writeYaml(seed, "plot/volumes/vol-one/chapters/ch-one/scenes/sc-two.yaml", {
    id: "sc-two", type: "scene", name: "帰路", chapter: "ch-one", order: 2,
    location: "loc-b", appears: ["char-hero"], manuscript: "manuscript/vol-one/ch-one/sc-two.md",
  });
  await writeYaml(seed, "plot/volumes/vol-one/chapters/ch-one/scenes/sc-three.yaml", {
    id: "sc-three", type: "scene", name: "夜明け", chapter: "ch-one", order: 3,
    location: "loc-b", appears: ["char-hero"], manuscript: "manuscript/vol-one/ch-one/sc-three.md",
  });
  await writeYaml(seed, "plot/threads/thread-open.yaml", { id: "thread-open", type: "thread", name: "古い約束", status: "open" });
  await writeYaml(seed, "bible/characters/hero/profile.yaml", {
    id: "char-hero", type: "character", name: "星野", aliases: ["星の剣士"],
    voicePatterns: { firstPerson: ["僕"] }, notes: "星野は未知の古文書を探す。",
    ownerNote: "preserve-character-metadata",
  });
  await writeYaml(seed, "bible/locations/loc-a.yaml", { id: "loc-a", type: "location", name: "遺跡" });
  await writeYaml(seed, "bible/locations/loc-b.yaml", { id: "loc-b", type: "location", name: "村" });
  await writeText(seed, firstScenePath,
    "---\ntitle: 遺跡\nauthor_note: preserve-this\ncustom:\n  nested: true\n---\n星野は悲しい。星影列車の古文書を調べた…。\n「俺は行く。」\n");
  await writeText(seed, "manuscript/vol-one/ch-one/sc-two.md", "---\ntitle: 帰路\nauthor_note: preserve-formatting-metadata\ncustom:\n  nested: true\n---\n\t前日、星野は青い彗星を見上げた…。\n　「俺は行く。」\n");
  await writeText(seed, "manuscript/vol-one/ch-one/sc-three.md", "---\ntitle: 夜明け\nauthor_note: preserve-source-proposal-metadata\ncustom:\n  nested: true\n---\n\t星野は夜明けを待った…。\n　「もう大丈夫だ。」\n");

  await writeYaml(seed, synonymsPath, {
    ownerNote: "preserve-synonym-root",
    groups: [{ id: "source-group-1", words: ["強い", "力強い"], context: "positive", ownerNote: "preserve-synonym-group" }],
  });
  await writeYaml(seed, ignoredPath, { ownerNote: "preserve-ignore-root", ignored: ["既存語"] });
  await writeText(seed, featureSettingsPath, `${JSON.stringify({
    externalEnabled: { "setting-qa": false, rewrite: false },
    ownerNote: "preserve-feature-settings",
  }, null, 2)}\n`);
  await writeYaml(seed, lintConfigPath, {
    ownerNote: "preserve-diagnostics-config",
    rules: [{
      id: "ellipsis-single-piece", kind: "regex_sequence", pattern: "(?<!…)…(?!…)", flags: "u",
      replacement: "……", message: "三点リーダーは二つ連続させてください。",
    }, {
      id: "dialogue-blank-line", kind: "line_spacing", startPattern: "^[「『]",
      message: "会話文の前後に空行を入れてください。",
    }],
  });

  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "Seed synthetic P06 acceptance work");
  await git(seed, "remote", "add", "origin", remote);
  await git(seed, "push", "-u", "origin", "main");
  await git(root, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
  return remote;
}

async function createRuntime(cacheDirectory) {
  await mkdir(cacheDirectory, { recursive: true });
  const runtime = new ModuleRuntime({
    manifests: [nlpManifest, storyManifest, diagnosticsManifest, speakerManifest],
    enabled: ["diagnostics", "speaker", "story"],
    cacheDirectory,
    workerEntries: { nlp: nlpWorker, diagnostics: diagnosticsWorker, speaker: speakerWorker },
    loaders: {
      nlp: async (context) => (await import(nlpEntry)).createModule(context),
      story: async (context) => (await import(storyEntry)).createModule(context),
      diagnostics: async (context) => (await import(diagnosticsEntry)).createModule(context),
      speaker: async (context) => (await import(speakerEntry)).createModule(context),
    },
  });
  return runtime;
}

function actionHost(store, projectId, reader) {
  const passThrough = { parse(value) { return value; } };
  return {
    projectId,
    reader,
    signal: new AbortController().signal,
    access: "owner",
    actions: [{
      module: "core",
      action: {
        id: "core.proposals.get",
        effect: "read",
        inputSchema: passThrough,
        outputSchema: passThrough,
        async invoke(input, context) {
          const proposalId = input?.proposalId;
          if (typeof proposalId !== "string") throw new TypeError("proposalId is required");
          const proposal = await store.getProposal(projectId, proposalId);
          if (!proposal) throw Object.assign(new Error("Proposal not found"), { code: "PROPOSAL_NOT_FOUND" });
          return { ok: true, snapshot: context.reader.snapshot, data: { proposal } };
        },
      },
    }],
    async propose(operations, evidence, proposalId, signal) {
      if (signal?.aborted) throw Object.assign(new Error("Acceptance proposal was cancelled"), { code: "action_cancelled" });
      return store.propose(projectId, {
        id: proposalId ?? `p06_${randomUUID().replaceAll("-", "")}`,
        snapshot: reader.snapshot,
        operations,
        source: "module",
        ...(evidence ? { evidence } : {}),
      });
    },
  };
}

function actionData(result, name, reader) {
  assert.equal(result.ok, true, `${name} failed: ${JSON.stringify(result.error)}`);
  assert.deepEqual(result.snapshot, reader.snapshot, `${name} must report the Core-pinned snapshot`);
  return result.data;
}

function proposalFor(result, name) {
  const proposal = result.proposals?.[0] ?? result.data?.proposal;
  assert.ok(proposal && Array.isArray(proposal.operations) && proposal.operations.length > 0, `${name} did not return a Core proposal`);
  assert.equal(proposal.source, "module");
  return proposal;
}

function fnv1aHash(input) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function sourceFormatterResultId({ projectId, sceneId, manuscriptId, manuscriptRevision, text }) {
  return `na-${createHash("sha256").update(JSON.stringify({
    action: "format-manuscript",
    projectId,
    sceneId,
    manuscriptId,
    manuscriptRevision,
    manuscriptContentHash: fnv1aHash(text),
    text,
  })).digest("hex")}`;
}

async function approveCheckpointAndPublish(store, projectId, proposals) {
  const accepted = [];
  for (const proposal of proposals) {
    const operationIds = proposal.operations.map((operation) => operation.id);
    await store.approve(projectId, { proposalId: proposal.id, operationIds, authorScope: "p06-synthetic-owner" });
    for (const operation of proposal.operations) accepted.push(await store.checkpoint(projectId, operation));
  }
  const receipt = await store.publish(projectId, "p06-production-acceptance");
  assert.equal(receipt.state, "confirmed", `Core did not confirm the synthetic publish: ${JSON.stringify(receipt)}`);
  assert.equal(receipt.acknowledged.length, accepted.length);
  assert.deepEqual(new Set(receipt.acknowledged.map((item) => item.operationId)), new Set(accepted.map((item) => item.operationId)));
  return receipt;
}

async function pinnedRemoteReader(store, projectId) {
  const observed = await store.observe(projectId);
  assert.equal(observed.state, "fresh");
  return store.reader(projectId, "remote", observed.snapshot);
}

test("P06 public actions survive Core-approved publish, data-root deletion, and repository reclone", { timeout: 180_000 }, async () => {
  assert.ok(nlpManifest && diagnosticsManifest, "installed NLP and diagnostics module metadata must be present");
  assert.deepEqual(diagnosticsManifest.optionalRequires, ["semantic.embedding"], "diagnostics retains its optional semantic provider contract");

  const root = await mkdtemp(join(tmpdir(), "scriptorium-p06-production-"));
  const remote = await createSyntheticRepository(root);
  const dataDirectory = join(root, "data-root");
  let runtime;
  let restartedRuntime;
  try {
    let store = new CoreStore({ dataDir: dataDirectory, allowLocalRemotes: true });
    let project = await store.registerProject({ url: remote });
    runtime = await createRuntime(join(root, "runtime-cache-before"));
    const reader = await pinnedRemoteReader(store, project.id);
    let host = actionHost(store, project.id, reader);

    assert.equal(runtime.status("nlp").availability, "enabled-idle");
    assert.equal(runtime.status("diagnostics").availability, "enabled-idle");
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, [], "enabled-idle production modules start no worker or model process");

    const analyzed = await runtime.invokeAction("nlp", "nlp.analyze", { text: "😀猫が走る。東京へ行く。" }, host);
    const nlp = actionData(analyzed, "nlp.analyze", reader).analysis;
    assert.equal(analyzed.data.engine, "lindera-wasm-nodejs-ipadic");
    assert.equal(analyzed.data.engineVersion, "2.0.0");
    assert.equal(nlp.text, "😀猫が走る。東京へ行く。");
    assert.ok(nlp.tokens.length > 3);
    for (const token of nlp.tokens) assert.equal(nlp.text.slice(token.start, token.end), token.surface, "real Lindera output retains UTF-16 token offsets after a surrogate pair");
    for (const sentence of nlp.sentences) assert.equal(nlp.text.slice(sentence.start, sentence.end), sentence.text);
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, [], "the actual NLP child exits after its final tokenizer lease");

    const dictionaryResult = await runtime.invokeAction("nlp", "nlp.dictionary", { term: "強い" }, host);
    const dictionary = actionData(dictionaryResult, "nlp.dictionary", reader);
    assert.deepEqual(dictionary.alternatives, ["力強い"]);
    assert.equal(dictionary.group.ownerNote, "preserve-synonym-group");

    const featuresResult = await runtime.invokeAction("nlp", "nlp.features", {}, host);
    const initialFeatures = actionData(featuresResult, "nlp.features", reader);
    assert.equal(initialFeatures.features.find((feature) => feature.id === "setting-qa")?.enabled, false);
    assert.equal(initialFeatures.features.find((feature) => feature.id === "rewrite")?.enabled, false);

    const candidateResult = await runtime.invokeAction("nlp", "nlp.discoverCandidates", {}, host);
    const candidates = actionData(candidateResult, "nlp.discoverCandidates", reader).candidates;
    assert.ok(candidates.length > 0, "synthetic Japanese work should produce real dictionary-backed lexical candidates");
    const ignoredTerm = candidates[0].term;
    assert.ok(candidates[0].sourceEntityIds.length > 0);

    const diagnosticsResult = await runtime.invokeAction("diagnostics", "diagnostics.analyze", {
      text: "星野は悲しい。星野は走る。", sceneId: "sc-one",
    }, host);
    const diagnostics = actionData(diagnosticsResult, "diagnostics.analyze", reader);
    assert.equal(diagnostics.model, "lindera-wasm-nodejs-ipadic");
    assert.equal(diagnostics.modelVersion, "2.0.0");
    assert.equal(diagnostics.diagnosticsEngine, "scriptorium-diagnostics-cpu");
    assert.ok(diagnostics.analysis.sentimentArc.points.length > 0);
    assert.ok(diagnostics.semanticEmbedding === undefined, "this P06 acceptance run does not claim P09 embedding-engine certification");

    const draftText = "星野は古文書を見つけた。\n『俺は行く。』";
    const fullResult = await runtime.invokeAction("diagnostics", "diagnostics.scene", { sceneId: "sc-one", text: draftText }, host);
    const full = actionData(fullResult, "diagnostics.scene", reader);
    assert.deepEqual(Object.keys(full), [
      "textHash", "tier", "meta", "analysis", "speakerAttributions", "estimatedN", "clusterTrails",
      "voiceWarnings", "styleDeviations", "stylometricDeviations", "plotSemanticWarnings", "proseBalance",
      "synonymSuggestions", "issues",
    ], "the composed action retains the source SceneDiagnosticsResult DTO without transport/model fields");
    assert.equal(full.tier, "full");
    assert.equal(full.analysis.charCount, draftText.length, "the optional draft text override is used by the complete analysis");
    assert.equal(typeof full.textHash, "string");
    assert.equal(typeof full.estimatedN, "number");
    for (const key of ["speakerAttributions", "clusterTrails", "voiceWarnings", "styleDeviations", "stylometricDeviations", "plotSemanticWarnings", "synonymSuggestions", "issues"]) {
      assert.ok(Array.isArray(full[key]), `full diagnostics includes source field ${key}`);
    }
    assert.ok(full.issues.some((issue) => issue.kind === "voice" && issue.meta?.basis === "profile" && issue.meta?.found === "俺"),
      "actual speaker attribution and declared voice profile findings reach the source-normalized issue list");
    assert.equal(full.semanticEmbedding, undefined, "the source DTO does not gain provider fields when optional semantic modules are unavailable");

    const continuityResult = await runtime.invokeAction("diagnostics", "diagnostics.checkContinuity", {}, host);
    const continuity = actionData(continuityResult, "diagnostics.checkContinuity", reader);
    assert.ok(continuity.warnings.some((warning) => warning.reason === "non-adjacent-location"));
    assert.ok(continuity.warnings.some((warning) => warning.reason === "unrecorded-teleport"));
    assert.ok(continuity.warnings.some((warning) => warning.reason === "timeline-reversal"));

    const characterFile = await reader.read("bible/characters/hero/profile.yaml");
    assert.ok(characterFile);
    const character = YAML.parse(characterFile.content);
    const voiceResult = await runtime.invokeAction("diagnostics", "diagnostics.voiceConsistency", {
      attributions: [{ speakerEntityId: character.id, confidence: "high", text: "『俺は行く』", sentenceIndex: 1 }],
      speakerDefinitions: { [character.id]: character },
    }, host);
    const voice = actionData(voiceResult, "diagnostics.voiceConsistency", reader);
    assert.ok(voice.warnings.some((warning) => warning.issue === "unexpected-first-person" && warning.basis === "profile" && warning.found === "俺"));

    const manuscript = await reader.read(firstScenePath);
    assert.ok(manuscript);
    const lintResult = await runtime.invokeAction("diagnostics", "diagnostics.proposeLintFix", {
      path: firstScenePath, baseRevision: manuscript.revision, operationId: "p06-lint-fix",
    }, host);
    const lint = actionData(lintResult, "diagnostics.proposeLintFix", reader);
    assert.equal(lint.fixed, true);
    assert.ok(lint.body.includes("……"));
    const lintProposal = proposalFor(lintResult, "diagnostics.proposeLintFix");
    assert.equal(lintProposal.operations[0].writes[0].path, firstScenePath);
    assert.equal(lintProposal.operations[0].reads[0].revision, manuscript.revision);

    const formatResult = await runtime.invokeAction("diagnostics", "diagnostics.formatManuscript", { sceneId: "sc-two" }, host);
    const formatted = actionData(formatResult, "diagnostics.formatManuscript", reader);
    assert.equal(formatted.actionId, "format-manuscript");
    assert.equal(formatted.formattedText, "前日、星野は青い彗星を見上げた……。\n\n「俺は行く。」");
    assert.match(formatted.resultId, /^na-[a-f0-9]{64}$/u);
    const formatProposal = proposalFor(formatResult, "diagnostics.formatManuscript");
    assert.equal(formatProposal.id, formatted.proposalId);
    assert.equal(formatProposal.operations[0].id, `${formatted.proposalId}-replace`);
    assert.equal(formatProposal.operations[0].writes[0].path, "manuscript/vol-one/ch-one/sc-two.md");

    const storyContextResult = await runtime.invokeAction("story", "story.scene.context", { sceneId: "sc-three" }, host);
    const storyContext = actionData(storyContextResult, "story.scene.context", reader);
    assert.equal(storyContext.manuscriptPath, "manuscript/vol-one/ch-one/sc-three.md");
    assert.equal(typeof storyContext.manuscriptRevision, "string");
    const sourceFormatResult = await runtime.invokeAction("diagnostics", "diagnostics.formatManuscript", {
      sceneId: "sc-three", registerProposal: false,
    }, host);
    const sourceFormatted = actionData(sourceFormatResult, "diagnostics.formatManuscript source adapter", reader);
    assert.equal(sourceFormatted.actionId, "format-manuscript");
    assert.equal(sourceFormatted.formattedText, "星野は夜明けを待った……。\n\n「もう大丈夫だ。」");
    assert.equal(sourceFormatted.resultId, sourceFormatterResultId({
      projectId: project.id,
      sceneId: "sc-three",
      manuscriptId: storyContext.manuscript.id,
      manuscriptRevision: storyContext.manuscriptRevision,
      text: storyContext.manuscriptBody,
    }), "result identity matches the source formatter's pinned Story revision and text hash");
    assert.equal(sourceFormatted.proposalId, sourceFormatted.sourceProposal.id);
    assert.equal(sourceFormatted.proposal, null, "registerProposal:false does not create a canonical Core proposal");
    assert.equal(sourceFormatResult.proposals, undefined, "the adapter leaves source submission to the author-facing Story route");
    const sourceNcs = sourceFormatted.sourceProposal;
    assert.deepEqual(Object.keys(sourceNcs), ["schemaVersion", "id", "projectId", "goal", "status", "assessment", "operations", "evidence", "diagnostics"]);
    assert.equal(sourceNcs.projectId, project.id);
    assert.equal(sourceNcs.goal, "Format manuscript");
    assert.equal(sourceNcs.operations.length, 1);
    assert.deepEqual(sourceNcs.operations[0], {
      id: `${sourceNcs.id}-replace`,
      kind: "manuscript.replace-range",
      target: { manuscriptId: storyContext.manuscript.id, sceneId: "sc-three" },
      precondition: { kind: "revision", value: storyContext.manuscriptRevision },
      range: { start: 0, end: storyContext.manuscriptBody.length },
      replacement: sourceFormatted.formattedText,
      evidenceIds: [`${sourceNcs.id}-source`],
      assessment: { confidence: 1, risk: "low" },
    }, "source replacement operation uses the semantic Story revision, not the Core file revision");
    assert.deepEqual(sourceNcs.evidence, [{
      id: `${sourceNcs.id}-source`, sourceKind: "manuscript", sourceId: storyContext.manuscript.id,
      revision: storyContext.manuscriptRevision, range: { start: 0, end: storyContext.manuscriptBody.length },
    }]);
    assert.deepEqual(sourceNcs.diagnostics, { before: null, after: null });
    const sourceSubmitResult = await runtime.invokeAction("story", "story.changes.propose", sourceNcs, host);
    const sourceSubmit = actionData(sourceSubmitResult, "story.changes.propose formatted NCS", reader);
    const sourceCoreProposal = proposalFor(sourceSubmitResult, "story.changes.propose formatted NCS");
    assert.equal(sourceSubmit.changeSetId, sourceNcs.id, "the emitted source NarrativeChangeSet is accepted by the public Story submission action");
    assert.ok(sourceCoreProposal.operations.some((operation) => operation.writes.some((write) => write.path === "manuscript/vol-one/ch-one/sc-three.md")));

    const synonymResult = await runtime.invokeAction("nlp", "nlp.saveSynonymGroup", {
      words: ["剛健"], mergeGroupIndex: 0,
    }, host);
    const synonymData = actionData(synonymResult, "nlp.saveSynonymGroup", reader);
    assert.ok(synonymData.groups[0].words.includes("剛健"));
    const ignoredResult = await runtime.invokeAction("nlp", "nlp.ignoreCandidates", { terms: [ignoredTerm] }, host);
    actionData(ignoredResult, "nlp.ignoreCandidates", reader);
    const consentResult = await runtime.invokeAction("nlp", "nlp.updateExternalConsent", {
      externalEnabled: { "setting-qa": true },
    }, host);
    actionData(consentResult, "nlp.updateExternalConsent", reader);

    const proposals = [
      proposalFor(lintResult, "diagnostics.proposeLintFix"),
      formatProposal,
      sourceCoreProposal,
      proposalFor(synonymResult, "nlp.saveSynonymGroup"),
      proposalFor(ignoredResult, "nlp.ignoreCandidates"),
      proposalFor(consentResult, "nlp.updateExternalConsent"),
    ];
    assert.equal(proposals.length, 6);
    const unchangedReader = await pinnedRemoteReader(store, project.id);
    assert.deepEqual(unchangedReader.snapshot, reader.snapshot, "module proposals leave the canonical remote snapshot unchanged until author approval");
    assert.equal((await unchangedReader.read(synonymsPath)).content, (await reader.read(synonymsPath)).content);
    assert.equal((await unchangedReader.read(firstScenePath)).content, manuscript.content, "lint never edits the Git worktree directly");
    assert.equal((await unchangedReader.read("manuscript/vol-one/ch-one/sc-two.md")).content, (await reader.read("manuscript/vol-one/ch-one/sc-two.md")).content, "formatting never edits the Git worktree directly");
    assert.equal((await unchangedReader.read("manuscript/vol-one/ch-one/sc-three.md")).content, (await reader.read("manuscript/vol-one/ch-one/sc-three.md")).content, "source formatting remains a proposal until the author submits and approves its NarrativeChangeSet");

    const publication = await approveCheckpointAndPublish(store, project.id, proposals);
    assert.equal(publication.acknowledged.length, 6);
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, [], "all NLP and diagnostics worker processes have exited before data-root replacement");
    await runtime.shutdown();
    runtime = undefined;

    const committedReader = await pinnedRemoteReader(store, project.id);
    const committedSynonyms = YAML.parse((await committedReader.read(synonymsPath)).content);
    assert.equal(committedSynonyms.ownerNote, "preserve-synonym-root");
    assert.equal(committedSynonyms.groups[0].ownerNote, "preserve-synonym-group");
    assert.ok(committedSynonyms.groups[0].words.includes("剛健"));
    const committedIgnored = YAML.parse((await committedReader.read(ignoredPath)).content);
    assert.equal(committedIgnored.ownerNote, "preserve-ignore-root");
    assert.ok(committedIgnored.ignored.includes("既存語"));
    assert.ok(committedIgnored.ignored.includes(ignoredTerm));
    const committedFeatures = JSON.parse((await committedReader.read(featureSettingsPath)).content);
    assert.equal(committedFeatures.ownerNote, "preserve-feature-settings");
    assert.equal(committedFeatures.externalEnabled["setting-qa"], true);
    const committedManuscript = (await committedReader.read(firstScenePath)).content;
    assert.ok(committedManuscript.startsWith("---\ntitle: 遺跡\nauthor_note: preserve-this\ncustom:\n  nested: true\n---\n"));
    assert.ok(committedManuscript.includes("……"));
    assert.ok(committedManuscript.includes("\n\n「俺は行く。」"));
    const committedFormatted = (await committedReader.read("manuscript/vol-one/ch-one/sc-two.md")).content;
    assert.ok(committedFormatted.startsWith("---\ntitle: 帰路\nauthor_note: preserve-formatting-metadata\ncustom:\n  nested: true\n---\n"));
    assert.ok(committedFormatted.endsWith("前日、星野は青い彗星を見上げた……。\n\n「俺は行く。」"));
    const committedSourceFormatted = (await committedReader.read("manuscript/vol-one/ch-one/sc-three.md")).content;
    assert.ok(committedSourceFormatted.startsWith("---\ntitle: 夜明け\nauthor_note: preserve-source-proposal-metadata\ncustom:\n  nested: true\n---\n"));
    assert.ok(committedSourceFormatted.endsWith("星野は夜明けを待った……。\n\n「もう大丈夫だ。」\n"));

    await rm(dataDirectory, { recursive: true, force: true });
    await assert.rejects(stat(dataDirectory), { code: "ENOENT" },
      "the complete Core data root was removed before reconstructing project state from Git");
    store = new CoreStore({ dataDir: dataDirectory, allowLocalRemotes: true });
    project = await store.registerProject({ url: remote });
    const rebuiltReader = await pinnedRemoteReader(store, project.id);
    assert.equal(rebuiltReader.snapshot.remoteCommit, publication.remoteCommit);
    const rebuiltStatuses = await store.listProposals(project.id);
    for (const proposal of proposals) {
      const rebuilt = rebuiltStatuses.find((status) => status.proposal.id === proposal.id);
      assert.ok(rebuilt, `published proposal ${proposal.id} is reconstructed from Git metadata after reclone`);
      assert.equal(rebuilt.state, "checkpointed");
      assert.deepEqual(new Set(rebuilt.publishedOperationIds), new Set(proposal.operations.map((operation) => operation.id)));
    }

    restartedRuntime = await createRuntime(join(root, "runtime-cache-after"));
    host = actionHost(store, project.id, rebuiltReader);
    assert.equal(restartedRuntime.status("nlp").availability, "enabled-idle");
    assert.equal(restartedRuntime.status("diagnostics").availability, "enabled-idle");
    assert.equal(restartedRuntime.status("speaker").availability, "enabled-idle");
    assert.deepEqual(restartedRuntime.workerSupervisor.activeWorkerPids, [], "re-enabled modules remain idle until the rebuilt snapshot is queried");

    const rebuiltDictionary = actionData(await restartedRuntime.invokeAction("nlp", "nlp.dictionary", { term: "強い" }, host), "recloned nlp.dictionary", rebuiltReader);
    assert.ok(rebuiltDictionary.alternatives.includes("剛健"));
    assert.equal(rebuiltDictionary.group.ownerNote, "preserve-synonym-group");
    const rebuiltFeatures = actionData(await restartedRuntime.invokeAction("nlp", "nlp.features", {}, host), "recloned nlp.features", rebuiltReader);
    assert.equal(rebuiltFeatures.features.find((feature) => feature.id === "setting-qa")?.enabled, true);
    assert.equal(rebuiltFeatures.settings.ownerNote, "preserve-feature-settings");
    const rebuiltContinuity = actionData(await restartedRuntime.invokeAction("diagnostics", "diagnostics.checkContinuity", {}, host), "recloned diagnostics.checkContinuity", rebuiltReader);
    assert.ok(rebuiltContinuity.warnings.some((warning) => warning.reason === "unrecorded-teleport"));
    const rebuiltNoOp = actionData(await restartedRuntime.invokeAction("diagnostics", "diagnostics.formatManuscript", {
      sceneId: "sc-three", registerProposal: false,
    }, host), "recloned diagnostics.formatManuscript no-op", rebuiltReader);
    assert.equal(rebuiltNoOp.sourceProposal, null);
    assert.equal(rebuiltNoOp.proposalId, null);
    assert.equal(rebuiltNoOp.proposal, null);

    const rebuiltCandidatesResult = await restartedRuntime.invokeAction("nlp", "nlp.discoverCandidates", {}, host);
    const rebuiltCandidates = actionData(rebuiltCandidatesResult, "recloned nlp.discoverCandidates", rebuiltReader);
    assert.ok(!rebuiltCandidates.candidates.some((candidate) => candidate.term === ignoredTerm), "the published ignored-term decision survives data-root deletion and candidate-index rebuild");
    assert.equal(rebuiltCandidates.model, "lindera-wasm-nodejs-ipadic");
    assert.equal(rebuiltCandidates.modelVersion, "2.0.0");

    const rebuiltAnalysis = await restartedRuntime.invokeAction("diagnostics", "diagnostics.analyze", {
      text: "星野は悲しい。", sceneId: "sc-one",
    }, host);
    const rebuiltDiagnostics = actionData(rebuiltAnalysis, "recloned diagnostics.analyze", rebuiltReader);
    assert.equal(rebuiltDiagnostics.model, "lindera-wasm-nodejs-ipadic");
    assert.equal(rebuiltDiagnostics.diagnosticsEngine, "scriptorium-diagnostics-cpu");
    assert.ok(rebuiltDiagnostics.analysis.sentimentArc.points.length > 0, "diagnostics recompute from the recloned snapshot with the actual CPU engines");
    assert.deepEqual(restartedRuntime.workerSupervisor.activeWorkerPids, [], "the rebuilt real tokenizer child exits after its final action lease");
  } finally {
    await runtime?.shutdown().catch(() => undefined);
    await restartedRuntime?.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
