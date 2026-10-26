import assert from "node:assert/strict";
import test from "node:test";
import {
  clusterTerms,
  collectMentionGroups,
  cosineSimilarityDense,
  embeddingContradictions,
  nearestPassages,
  rerankResults,
  shouldClusterByString,
  type CandidateTerm,
  type SemanticAnchor,
} from "./core.ts";

function candidate(term: string, occurrenceCount = 1, sourceEntityIds = [term]): CandidateTerm {
  return { term, reading: null, sourceEntityIds, occurrenceCount };
}

function vector(first: number, second = 0): number[] {
  return [first, second, ...Array(382).fill(0)];
}

test("cosine similarity handles orthogonal, zero and mismatched vectors", () => {
  assert.equal(cosineSimilarityDense([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarityDense([0, 0], [0, 0]), 0);
  assert.equal(cosineSimilarityDense([1], [1, 0]), 0);
  assert.ok(Math.abs(cosineSimilarityDense([1, 2], [2, 4]) - 1) < 1e-12);
  assert.throws(() => cosineSimilarityDense([1, Number.NaN], [1, 2]), /finite/);
});

test("term clusters preserve exact-reading and bounded-string rules and stable canonical order", () => {
  assert.deepEqual(clusterTerms([
    { term: "駅前", reading: "エキマエ", sourceEntityIds: ["a"], occurrenceCount: 2 },
    { term: "駅前広場", reading: "エキマエヒロバ", sourceEntityIds: ["b", "c"], occurrenceCount: 9 },
    candidate("海岸", 4, ["d"]),
  ]), [{ canonical: "駅前広場", variants: ["駅前"] }]);
  assert.equal(shouldClusterByString("海辺地域", "浜辺地域"), true);
  assert.equal(shouldClusterByString("海岸", "浜辺"), false);
  const result = clusterTerms([
    candidate("浜辺地域", 4, ["a", "b"]),
    candidate("海辺地域", 4, ["a", "b", "c"]),
  ]);
  assert.deepEqual(result, [
    { canonical: "海辺地域", variants: ["浜辺地域"] },
  ]);
  assert.deepEqual(clusterTerms([
    { ...candidate("海岸"), reading: "かいがん" },
    { ...candidate("海辺"), reading: "かいがん" },
  ]), [{ canonical: "海岸", variants: ["海辺"] }]);
});

test("semantic term links are opt-in input and mark their resulting cluster", () => {
  const terms = [candidate("海岸", 3), candidate("浜辺", 3)];
  const noModel = clusterTerms(terms);
  assert.deepEqual(noModel, []);
  const withModel = clusterTerms(terms, [vector(1), vector(0.999, 0.01)]);
  assert.deepEqual(withModel, [{ canonical: "海岸", variants: ["浜辺"], semanticOnly: true }]);
  assert.throws(() => clusterTerms(terms, [[1], [1, 0]]), /dimension/);
});

test("nearest results exclude requested scenes and tie-break by stable source identity", () => {
  const hits = nearestPassages(vector(1), [
    { entityId: "z", sceneId: "z", sentenceIndex: 0, sourcePath: "manuscript/z.md", sourceRevision: "a", quote: "z", vector: vector(1) },
    { entityId: "a", sceneId: "a", sentenceIndex: 1, sourcePath: "manuscript/a.md", sourceRevision: "b", quote: "a", vector: vector(1) },
    { entityId: "b", sceneId: "excluded", sentenceIndex: 0, sourcePath: "manuscript/b.md", sourceRevision: "c", quote: "b", vector: vector(1) },
  ], 2, ["excluded"]);
  assert.deepEqual(hits.map(({ entityId }) => entityId), ["a", "z"]);
});

test("reranker scores use sigmoid(logit), stable tie order, and bounded unique candidates", () => {
  const candidates = [
    { candidateId: "first", entityId: "a", sourcePath: "a.md", sourceRevision: "r1", text: "a", evidence: [] },
    { candidateId: "second", entityId: "b", sourcePath: "b.md", sourceRevision: "r1", text: "b", evidence: [] },
    { candidateId: "third", entityId: "c", sourcePath: "c.md", sourceRevision: "r1", text: "c", evidence: [] },
  ];
  assert.deepEqual(rerankResults(candidates, [0, 4, 4], 3), [
    { candidateId: "second", score: 1 / (1 + Math.exp(-4)), rank: 1 },
    { candidateId: "third", score: 1 / (1 + Math.exp(-4)), rank: 2 },
    { candidateId: "first", score: 0.5, rank: 3 },
  ]);
  assert.equal(rerankResults([candidates[0]!], [1000], 1)[0]!.score, 1);
  assert.throws(() => rerankResults([candidates[0]!, candidates[0]!], [0, 1], 2), /unique/);
});

function anchor(sceneId: string, sentenceIndex: number, vector: number[], quote: string): SemanticAnchor {
  return {
    sceneId,
    sentenceIndex,
    text: quote,
    vector,
    evidence: { path: `manuscript/${sceneId}.md`, revision: "sha256:source", start: 0, end: quote.length, quote },
  };
}

test("contradiction candidates are midband hypotheses with two exact source spans", () => {
  const [candidate] = embeddingContradictions([{
    entityId: "person-1",
    anchors: [anchor("scene-a", 0, vector(1), "朝に北へ向かった。"), anchor("scene-b", 2, vector(0.7, Math.sqrt(0.51)), "夜に南へ向かった。")],
  }]);
  assert.ok(candidate);
  assert.equal(candidate.kind, "embedding_midband");
  assert.equal(candidate.id, "embed:person-1:scene-a:0:scene-b:2");
  assert.equal(candidate.evidenceA.quote, "朝に北へ向かった。");
  assert.equal(candidate.evidenceA.path, "manuscript/scene-a.md");
  assert.equal(candidate.evidenceB.quote, "夜に南へ向かった。");
  assert.ok(candidate.score >= 0.29 && candidate.score < 0.84);
});

test("mention groups use the longest name or alias and only include prose passages", () => {
  const evidence = (sceneId: string, quote: string) => ({ path: `manuscript/${sceneId}.md`, revision: "sha256:source", start: 0, end: quote.length, quote });
  const groups = collectMentionGroups([
    { id: "char-1", type: "character", name: "青い騎士", aliases: ["騎士"] },
    { id: "scene-1", type: "scene", name: "Scene" },
  ], [
    { entityId: "scene-1", sceneId: "scene-1", sentenceIndex: 0, sourcePath: "manuscript/a.md", sourceRevision: "sha256:source", quote: "青い騎士は東へ歩いた。", type: "scene", vector: [1, 0], evidence: evidence("a", "青い騎士は東へ歩いた。") },
    { entityId: "char-1", sceneId: "char-1", sentenceIndex: 0, sourcePath: "bible/characters/a.yaml", sourceRevision: "sha256:source", quote: "青い騎士は赤い。", type: "character", vector: [1, 0], evidence: evidence("b", "青い騎士は赤い。") },
  ]);
  assert.deepEqual(groups.map((group) => group.entityId), ["char-1"]);
  assert.equal(groups[0]!.anchors[0]!.evidence.path, "manuscript/a.md");
});

test("contradiction candidates exclude same passages and scores outside the midband", () => {
  assert.deepEqual(embeddingContradictions([{ entityId: "person-1", anchors: [
    anchor("same", 1, vector(1), "a"), anchor("same", 1, vector(0.7, Math.sqrt(0.51)), "a"),
  ] }]), []);
  assert.deepEqual(embeddingContradictions([{ entityId: "person-1", anchors: [
    anchor("a", 0, vector(1), "a"), anchor("b", 0, vector(0.9, Math.sqrt(0.19)), "b"),
  ] }]), []);
  assert.deepEqual(embeddingContradictions([{ entityId: "person-1", anchors: [
    anchor("a", 0, vector(1), "a"), anchor("b", 0, vector(0, 1), "b"),
  ] }]), []);
  const mismatchedEvidence = { ...anchor("a", 0, vector(1), "a"), text: "changed" };
  assert.throws(() => embeddingContradictions([{ entityId: "person-1", anchors: [
    mismatchedEvidence, anchor("b", 0, vector(0.7, Math.sqrt(0.51)), "b"),
  ] }]), /exact passage/);
});
