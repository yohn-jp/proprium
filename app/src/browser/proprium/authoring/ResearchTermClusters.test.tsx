import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import {
  evidenceQuote,
  parseResearchTermCandidates,
  parseSemanticTermClusters,
  semanticEmbeddingChoice,
  synonymProposalInput,
  toSemanticTermCandidates,
  type ResearchTermCandidate,
} from "./ResearchTermClusters.helpers.js";
import { ResearchTermClusters } from "./ResearchTermClusters.js";

const candidates: ResearchTermCandidate[] = [
  { term: "駅前", reading: "えきまえ", sourceIds: ["draft-a"], occurrenceCount: 3,
    evidence: [{ sourceId: "draft-a", textId: "body", revision: "a".repeat(64), range: { start: 3, end: 5 } }] },
  { term: "駅の前", reading: null, sourceIds: ["draft-b", "draft-c"], occurrenceCount: 1, evidence: [] },
];

test("Research candidates map to the Semantic protocol without dropping evidence-side identity", () => {
  assert.deepEqual(toSemanticTermCandidates(candidates), [
    { term: "駅前", reading: "えきまえ", sourceEntityIds: ["draft-a"], occurrenceCount: 3 },
    { term: "駅の前", reading: null, sourceEntityIds: ["draft-b", "draft-c"], occurrenceCount: 1 },
  ]);
});

test("candidate result validation retains exact evidence ranges and bounds page size", () => {
  const page = parseResearchTermCandidates({ candidates: [{
    term: "駅前", reading: "えきまえ", sourceIds: ["draft-a"], occurrenceCount: 1,
    evidence: [{ sourceId: "draft-a", textId: "body", revision: "a".repeat(64), range: { start: 2, end: 4 } }],
  }], nextCursor: "next" });
  assert.equal(page.nextCursor, "next");
  assert.equal(page.candidates[0]?.evidence[0]?.range.end, 4);
  assert.throws(() => parseResearchTermCandidates({ candidates: Array.from({ length: 51 }, () => candidates[0]), nextCursor: null }), /読み取れません/u);
  assert.throws(() => parseResearchTermCandidates({ candidates: [{ ...candidates[0], evidence: [{ ...candidates[0]!.evidence[0], range: { start: 5, end: 2 } }] }], nextCursor: null }), /根拠/u);
});

test("evidence excerpts use UTF-16 offsets from the pinned text", () => {
  const evidence = candidates[0]!.evidence[0]!;
  assert.equal(evidenceQuote({ ...evidence, range: { start: 2, end: 4 } }, new Map([["draft-a\u0000body", "🌙駅前です"]])), "駅前");
  assert.equal(evidenceQuote({ ...evidence, range: { start: 2, end: 99 } }, new Map([["draft-a\u0000body", "🌙駅前です"]])), null);
});

test("only an explicitly reported warm model enables embedding clusters", () => {
  assert.deepEqual(semanticEmbeddingChoice({ resources: { modelLoaded: true } }), { useEmbedding: true, state: "warm" });
  assert.deepEqual(semanticEmbeddingChoice({ resources: { modelLoaded: false } }), { useEmbedding: false, state: "cold" });
  assert.deepEqual(semanticEmbeddingChoice({ resources: { downloadRequired: true } }), { useEmbedding: false, state: "unknown" });
  assert.deepEqual(semanticEmbeddingChoice(null), { useEmbedding: false, state: "unknown" });
});

test("Semantic cluster rows preserve the semantic-only evidence flag", () => {
  assert.deepEqual(parseSemanticTermClusters({ results: [{ canonical: "海岸", variants: ["浜辺"], semanticOnly: true }] }), [
    { canonical: "海岸", variants: ["浜辺"], semanticOnly: true },
  ]);
});

test("synonym proposal input is one revision-guarded Research action", () => {
  const groupRef = { fileRevision: "b".repeat(64), ordinal: 2, words: ["駅前", "旧駅前"], context: "positive" as const };
  assert.deepEqual(synonymProposalInput({ canonical: "駅前", variants: ["駅の前", "駅の前"],
    expectedFileRevision: groupRef.fileRevision, mergeGroupRef: groupRef }), {
    words: ["駅前", "駅の前"], expectedFileRevision: groupRef.fileRevision, mergeGroupRef: groupRef,
  });
  assert.throws(() => synonymProposalInput({ canonical: "駅前", variants: ["駅前"], expectedFileRevision: null }), /2 件以上/u);
});

test("Host surface exposes local, explicit model behavior and no automatic download control", () => {
  const html = renderToStaticMarkup(createElement(ResearchTermClusters, {
    scopeKey: "repository:branch:snapshot",
    invokeRead: async () => { throw new Error("unexpected read"); },
    invokeUi: async () => { throw new Error("unexpected proposal"); },
  }));
  assert.match(html, /解析する文章/u);
  assert.match(html, /貼り付けた文章をローカル/u);
  assert.match(html, /すでに承認済みで実行時に読み込み済みの場合だけ/u);
  assert.doesNotMatch(html, /モデルをダウンロード|モデルを取得/u);
});
