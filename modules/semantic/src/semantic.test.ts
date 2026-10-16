import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { ChangeOperation, ModuleActionContext, ModuleContext, SnapshotId } from "@scriptorium/contracts";
import type { CandidateTerm, CanonicalSnapshotEntity } from "@scriptorium/module-nlp";
import { WorkerSupervisor } from "@scriptorium/module-runtime";
import type { StoryEntity } from "@scriptorium/module-story";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL_ID,
  EMBEDDING_MODEL_VERSION,
  RERANKER_MODEL_ID,
  RERANKER_MODEL_VERSION,
  type SemanticEmbeddingCapability,
  type SemanticPassage,
} from "./contracts.js";
import { collectMentionGroups, detectSourceRuleContradictions, embeddingContradictionsToCandidates } from "./contradictions.js";
import { semanticEmbeddingCapability } from "./embedding.js";
import { createSemanticActions } from "./actions.js";
import { buildSemanticPassages } from "./passages.js";
import { buildSearchDocuments, combineHybridScores, searchSnapshotLexically } from "./search.js";
import { clusterSimilarTerms } from "./termClustering.js";

const snapshot: SnapshotId = {
  repository: { provider: "local", repositoryId: "semantic-production-fixture", defaultBranch: "main", ownerScope: "owner", url: "local://semantic-production-fixture" },
  remoteCommit: "a".repeat(40),
};

test("source sentence rows preserve embeddable types, body/description/notes order, and trimmed indexes", () => {
  const entities: CanonicalSnapshotEntity[] = [
    { id: "sc-1", type: "scene", filePath: "plot/scene.yaml", name: "Station", aliases: [], raw: { description: " description. ", notes: " note." }, body: " First sentence. Second sentence." },
    { id: "arc-1", type: "arc", filePath: "plot/arc.yaml", raw: {}, body: "must not be embedded" },
    { id: "char-1", type: "character", filePath: "bible/characters/a.yaml", raw: { notes: "Alone." } },
  ];
  const rows = buildSemanticPassages(entities);
  assert.deepEqual(rows.map(({ entityId, sentenceIndex, text }) => ({ entityId, sentenceIndex, text })), [
    { entityId: "sc-1", sentenceIndex: 0, text: "First sentence." },
    { entityId: "sc-1", sentenceIndex: 1, text: "Second sentence." },
    { entityId: "sc-1", sentenceIndex: 2, text: "description." },
    { entityId: "sc-1", sentenceIndex: 3, text: "note." },
    { entityId: "char-1", sentenceIndex: 0, text: "Alone." },
  ]);
});

test("snapshot lexical projection supplies source field weighting and classic RRF ranks", () => {
  const entities: CanonicalSnapshotEntity[] = [
    { id: "scene-direct", type: "scene", filePath: "plot/a.yaml", name: "Blue harbor", aliases: [], raw: {}, body: "The blue harbor glows." },
    { id: "scene-body", type: "scene", filePath: "plot/b.yaml", name: "Quiet", aliases: [], raw: {}, body: "A blue harbor appears here." },
  ];
  const lexical = searchSnapshotLexically(entities, "blue harbor", 10);
  assert.equal(lexical[0]?.id, "scene-direct");
  assert.equal(lexical[0]?.field, "name");
  assert.equal(combineHybridScores(1, 1), 2 / 61);
  assert.equal(combineHybridScores(1, null), 1 / 61);
});

test("term expansion uses NLP rules and preserves the source short-token LIKE behavior", () => {
  const lexical = searchSnapshotLexically([
    { id: "station", type: "location", filePath: "bible/locations/station.yaml", name: "stations", aliases: [], raw: {} },
  ], "station", 10, ["stations"]);
  assert.equal(lexical[0]?.id, "station");

  const short = searchSnapshotLexically([
    { id: "nearby", type: "location", filePath: "bible/locations/nearby.yaml", name: "駅前", aliases: [], raw: {}, body: "駅前に着く" },
  ], "駅前", 10, ["駅前夜"]);
  assert.deepEqual(short, []);
});

test("snapshot lexical notes follow source normalization and do not index malformed legacy strings", () => {
  const base = { id: "char-a", type: "character", filePath: "bible/characters/a.yaml", name: "A", raw: {} };
  const structured = { ...base, raw: { notes: {
    lead: [{ type: "paragraph", text: "Lead phrase" }],
    sections: [{ heading: "ignored heading", body: [{ type: "definitions", items: [{ term: "key", description: "definition phrase" }] }], children: [] }],
  } } };
  const legacyString = { ...base, id: "char-b", raw: { notes: "source normalization ignores a bare notes string" } };
  const notes = buildSearchDocuments([structured, legacyString]).filter((document) => document.field === "notes");
  assert.deepEqual(notes.map(({ id, content }) => ({ id, content })), [{ id: "char-a", content: "Lead phrase\nkey\ndefinition phrase" }]);
});

test("semantic reranker setting is returned as a revision-guarded author proposal", async () => {
  let proposed: ChangeOperation[] = [];
  let proposalSignal: AbortSignal | undefined;
  const controller = new AbortController();
  const context = {
    projectId: "project-semantic",
    reader: {
      snapshot,
      async read(path: string) {
        return path === "meta/scriptorium/modules/semantic/settings.json"
          ? { content: '{"schemaVersion":1,"rerankerEnabled":false}\n', revision: "settings-rev-1" }
          : null;
      },
      async list() { return []; },
    },
    signal: controller.signal,
    async propose(operations: ChangeOperation[], _evidence: unknown, _proposalId?: string, signal?: AbortSignal) {
      proposed = operations;
      proposalSignal = signal;
      return { id: "proposal-semantic-1", snapshot, operations, source: "module" as const };
    },
  } as unknown as ModuleActionContext;
  const actions = createSemanticActions({} as ModuleContext);
  const update = actions.find((action) => action.id === "semantic.settings.update");
  assert.equal(update?.effect, "propose");
  const result = await update!.invoke({ rerankerEnabled: true }, context);
  assert.equal(result.ok, true);
  assert.equal(proposed.length, 1);
  assert.equal(proposed[0]?.effect, "settings");
  assert.deepEqual(proposed[0]?.reads, [{ path: "meta/scriptorium/modules/semantic/settings.json", revision: "settings-rev-1" }]);
  assert.equal(proposed[0]?.writes[0]?.path, "meta/scriptorium/modules/semantic/settings.json");
  assert.equal(proposed[0]?.writes[0]?.revision, "settings-rev-1");
  assert.equal(JSON.parse(proposed[0]!.writes[0]!.content!).rerankerEnabled, true);
  assert.equal(proposalSignal, controller.signal);
});

test("term clustering retains source reading, edit distance, canonical ordering, and opt-in semantic edges", async () => {
  const candidates: CandidateTerm[] = [
    { term: "駅前", reading: "エキマエ", sourceEntityIds: ["a"], occurrenceCount: 2 },
    { term: "駅前広場", reading: "エキマエヒロバ", sourceEntityIds: ["b", "c"], occurrenceCount: 9 },
    { term: "海岸", reading: null, sourceEntityIds: ["d"], occurrenceCount: 4 },
  ];
  const lexical = await clusterSimilarTerms(candidates);
  assert.deepEqual(lexical, [{ canonical: "駅前広場", variants: ["駅前"] }]);

  const vectors = new Map([["海岸", [1, 0]], ["浜辺", [0.999, 0.01]]]);
  const embedding: SemanticEmbeddingCapability = {
    model: { id: EMBEDDING_MODEL_ID, version: EMBEDDING_MODEL_VERSION, dimensions: EMBEDDING_DIMENSIONS },
    async index(): Promise<never> { throw new Error("unused"); },
    async nearest(): Promise<never> { throw new Error("unused"); },
    async status(): Promise<never> { throw new Error("unused"); },
    async contradictionPairs(): Promise<never> { throw new Error("unused"); },
    async rerank(): Promise<never> { throw new Error("unused"); },
    async embed(texts) { return { snapshot, model: EMBEDDING_MODEL_ID, modelVersion: EMBEDDING_MODEL_VERSION, dimensions: EMBEDDING_DIMENSIONS, vectors: texts.map((text) => vectors.get(text) ?? [0, 1]) }; },
  };
  const semantic = await clusterSimilarTerms([
    candidates[2]!, { term: "浜辺", reading: null, sourceEntityIds: ["e"], occurrenceCount: 3 },
  ], { useEmbedding: true, embedding, snapshot, signal: new AbortController().signal });
  assert.deepEqual(semantic, [{ canonical: "海岸", variants: ["浜辺"], semanticOnly: true }]);
});

test("mention groups use the source name trie and only retain prose entity mentions", () => {
  const char: StoryEntity = { id: "char-1", type: "character", name: "青い騎士", aliases: ["騎士"], filePath: "bible/characters/knight.yaml", raw: {} };
  const scene: StoryEntity = { id: "sc-1", type: "scene", name: "Scene", filePath: "plot/scene.yaml", raw: {} };
  const groups = collectMentionGroups(new Map([[char.id, char], [scene.id, scene]]), [
    { entityId: "sc-1", sceneId: "sc-1", sentenceIndex: 0, text: "青い騎士は東へ歩いた。", type: "scene" },
    { entityId: "char-1", sceneId: "char-1", sentenceIndex: 0, text: "青い騎士は赤い。", type: "character" },
  ]);
  assert.deepEqual(groups, [{ entityId: "char-1", anchors: [{ sceneId: "sc-1", sentenceIndex: 0, text: "青い騎士は東へ歩いた。" }] }]);
  const candidate = embeddingContradictionsToCandidates([{ entityId: "char-1", evidenceA: { sceneId: "sc-1", sentenceIndex: 0, text: "A" }, evidenceB: { sceneId: "sc-2", sentenceIndex: 1, text: "B" }, score: 0.5 }])[0]!;
  assert.equal(candidate.id, "embed:char-1:sc-1:0:sc-2:1");
  assert.equal(candidate.evidenceA.quote, "A");
});

test("source rule contradictions preserve pre-scene ownership boundaries and validated empty-string effects", () => {
  const entities: StoryEntity[] = [
    { id: "vol-1", type: "volume", filePath: "plot/volumes/v/volume.yaml", raw: { order: 0 } },
    { id: "ch-1", type: "chapter", filePath: "plot/volumes/v/chapter.yaml", raw: { volume: "vol-1", order: 0 } },
    { id: "sc-1", type: "scene", filePath: "plot/volumes/v/scenes/a.yaml", raw: { chapter: "ch-1", order: 0, effects: [{ action: "acquire_item", itemId: "", characterId: "owner" }] } },
    { id: "sc-2", type: "scene", filePath: "plot/volumes/v/scenes/b.yaml", raw: { chapter: "ch-1", order: 1, effects: [{ action: "use_item", itemId: "", characterId: "thief" }] } },
  ];
  const contradictions = detectSourceRuleContradictions({ snapshot, entities: new Map(entities.map((entity) => [entity.id, entity])), links: [] });
  assert.equal(contradictions.length, 1);
  assert.equal(contradictions[0]?.reason, "item-owner-mismatch");
  assert.equal(contradictions[0]?.itemId, "");
  assert.equal(contradictions[0]?.previousSceneId, "sc-1");
});

test("supervised CPU model indexes, retrieves, reranks, reuses, and rebuilds from deleted derived cache", {
  skip: !process.env.SCRIPTORIUM_SEMANTIC_MODEL_CACHE,
}, async () => {
  const modelCache = process.env.SCRIPTORIUM_SEMANTIC_MODEL_CACHE!;
  const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), "scriptorium-semantic-p09-"));
  const modelDirectory = path.join(cacheDirectory, "semantic", "models");
  await mkdir(path.dirname(modelDirectory), { recursive: true });
  await symlink(modelCache, modelDirectory, "dir");
  const workerEntry = fileURLToPath(new URL("../dist/worker.js", import.meta.url));
  const supervisor = new WorkerSupervisor({ maxWorkerServices: 1, maxConcurrentServiceJobs: 1, maxJobDurationMs: 30 * 60_000 });
  const controller = new AbortController();
  const service = await supervisor.createService("semantic", "0.1.0", workerEntry, controller.signal);
  const capability = await semanticEmbeddingCapability.create({
    cacheDirectory,
    signal: controller.signal,
    async acquireCapability() { throw new Error("unused"); },
    async createWorkerService() { return service; },
  });
  try {
    const passages: SemanticPassage[] = [
      { entityId: "sc-station", sceneId: "sc-station", sentenceIndex: 0, type: "scene", name: "Station", text: "夜遅く駅に着き、青い切符を握りしめた。" },
      { entityId: "sc-sea", sceneId: "sc-sea", sentenceIndex: 0, type: "scene", name: "Sea", text: "昼の海で泳ぎ、白い波を眺めた。" },
      { entityId: "sc-market", sceneId: "sc-market", sentenceIndex: 0, type: "scene", name: "Market", text: "朝の市場で赤い林檎を買った。" },
      { entityId: "sc-book", sceneId: "sc-book", sentenceIndex: 0, type: "scene", name: "Book", text: "静かな部屋で小説を読んだ。" },
    ];
    const first = await capability.index(passages, snapshot, controller.signal);
    assert.equal(first.embedded, passages.length);
    assert.equal(first.dimensions, 384);
    const retrieved = await capability.nearest(passages[0]!.text, snapshot, { limit: 4 }, controller.signal);
    assert.equal(retrieved.hits[0]?.entityId, "sc-station");
    assert.ok(retrieved.hits[0]!.score > 0.98);
    const second = await capability.index(passages, snapshot, controller.signal);
    assert.equal(second.reused, passages.length);
    assert.equal(second.embedded, 0);

    const actionSnapshot: SnapshotId = { ...snapshot, remoteCommit: "c".repeat(40) };
    const files = new Map([
      ["plot/volumes/v/scenes/station.yaml", "id: sc-station\ntype: scene\nname: Station\ndescription: 夜遅く駅に着き、青い切符を握りしめた。\n"],
      ["plot/volumes/v/scenes/sea.yaml", "id: sc-sea\ntype: scene\nname: Sea\ndescription: 昼の海で泳ぎ、白い波を眺めた。\n"],
    ]);
    const reader = {
      snapshot: actionSnapshot,
      async list(prefix: string) { return [...files.keys()].filter((file) => file.startsWith(`${prefix}/`)); },
      async read(path: string) {
        const content = files.get(path);
        return content === undefined ? null : { content, revision: "revision-" + path };
      },
    };
    const moduleContext = {
      cacheDirectory,
      signal: controller.signal,
      async acquireCapability(id: string) {
        assert.equal(id, "semantic.embedding");
        return { value: capability, async release() {} };
      },
      async createWorkerService() { return service; },
    } as unknown as ModuleContext;
    const actionContext = {
      projectId: "semantic-production-fixture",
      reader,
      signal: controller.signal,
      async invoke() { throw new Error("unexpected nested action"); },
      async listActions() { return []; },
      async linkedReader() { throw new Error("unexpected linked reader"); },
      async propose() { throw new Error("unexpected proposal"); },
      async runJob() { throw new Error("unexpected job"); },
    } as unknown as ModuleActionContext;
    const actions = createSemanticActions(moduleContext);
    const rebuild = actions.find((action) => action.id === "semantic.index.rebuild");
    const search = actions.find((action) => action.id === "semantic.search");
    assert.ok(rebuild && search);
    const indexed = await rebuild.invoke({ taskId: "action-index" }, actionContext);
    assert.equal(indexed.ok, true);
    const indexedData = indexed.data as Record<string, unknown>;
    assert.equal(indexedData.model, EMBEDDING_MODEL_ID);
    assert.equal(indexedData.modelVersion, EMBEDDING_MODEL_VERSION);
    assert.equal(indexedData.scanned, 2);
    const searched = await search.invoke({ query: "夜遅く 駅", mode: "scene", limit: 5 }, actionContext);
    assert.equal(searched.ok, true);
    const searchData = searched.data as { modelVersion: string; results: Array<{ sceneId: string; scores: { vectorRank?: number } }> };
    assert.equal(searchData.modelVersion, EMBEDDING_MODEL_VERSION);
    assert.equal(searchData.results[0]?.sceneId, "sc-station");
    assert.equal(searchData.results[0]?.scores.vectorRank, 1);

    const nextSnapshot: SnapshotId = { ...snapshot, remoteCommit: "b".repeat(40) };
    const changedPassages = passages.map((passage) => passage.entityId === "sc-station"
      ? { ...passage, name: "Updated Station", text: "夜明けに駅から遠ざかり、白い切符を手放した。" }
      : passage);
    const changed = await capability.index(changedPassages, nextSnapshot, controller.signal);
    assert.equal(changed.embedded, 1);
    assert.equal(changed.reused, passages.length - 1);
    const oldSnapshotHit = (await capability.nearest("駅の切符", snapshot, { limit: 4 }, controller.signal)).hits.find((hit) => hit.entityId === "sc-station");
    const newSnapshotHit = (await capability.nearest("駅の切符", nextSnapshot, { limit: 4 }, controller.signal)).hits.find((hit) => hit.entityId === "sc-station");
    assert.equal(oldSnapshotHit?.text, passages[0]!.text);
    assert.equal(oldSnapshotHit?.name, "Station");
    assert.equal(newSnapshotHit?.text, changedPassages[0]!.text);
    assert.equal(newSnapshotHit?.name, "Updated Station");
    const reranked = await capability.rerank("夜の駅の情景", ["夜遅く駅に着いた。", "昼の海で泳いだ。"], snapshot, controller.signal);
    assert.equal(reranked.model, RERANKER_MODEL_ID);
    assert.equal(reranked.modelVersion, RERANKER_MODEL_VERSION);
    assert.equal(reranked.scores.length, 2);
    assert.ok(reranked.scores.every(Number.isFinite));
    assert.ok(reranked.scores[0]! > reranked.scores[1]!);

    const { createHash } = await import("node:crypto");
    const repositoryKey = createHash("sha256").update(JSON.stringify([snapshot.repository.provider, snapshot.repository.ownerScope, snapshot.repository.repositoryId, snapshot.repository.defaultBranch])).digest("hex");
    const modelKey = createHash("sha256").update(`${EMBEDDING_MODEL_ID}@${EMBEDDING_MODEL_VERSION}`).digest("hex").slice(0, 24);
    await rm(path.join(cacheDirectory, "semantic", "indexes", `${repositoryKey}-${modelKey}.json`));
    assert.equal((await capability.status(snapshot, controller.signal)).indexAvailable, false);
    const rebuilt = await capability.index(passages, snapshot, controller.signal);
    assert.equal(rebuilt.embedded, passages.length);
    assert.equal((await capability.status(snapshot, controller.signal)).indexAvailable, true);
  } finally {
    await capability.dispose();
    await supervisor.shutdown();
    await rm(cacheDirectory, { recursive: true, force: true });
  }
});
