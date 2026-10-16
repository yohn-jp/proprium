import assert from "node:assert/strict";
import test from "node:test";
import {
  approximateContinuationTokenCount,
  buildContinuationContext,
  buildContinuationRetrievalQuery,
  DEFAULT_CONTINUATION_K,
  DEFAULT_CONTINUATION_TOKEN_BUDGET,
  normalizeContinuationRetrievalHits,
} from "./continuation-context.js";

test("continuation context defaults to the trailing eight sentences and a 12,000 budget", () => {
  const recentSentences = Array.from({ length: 10 }, (_, index) => `sentence-${index + 1}`);
  const built = buildContinuationContext({ recentSentences });

  assert.equal(DEFAULT_CONTINUATION_K, 8);
  assert.equal(built.text, recentSentences.slice(-8).join("\n"));
  assert.equal(built.manifest.parts[0]?.kind, "recent-sentences");
  assert.equal(built.manifest.parts[0]?.count, 8);
  assert.equal(built.manifest.tokenBudget, DEFAULT_CONTINUATION_TOKEN_BUDGET);
  assert.equal(built.manifest.tokenCountMode, "approximate");
});

test("continuation retrieval query uses the last three sentences and trims surrounding whitespace", () => {
  assert.equal(
    buildContinuationRetrievalQuery(["ignored", "  second  ", " third", "fourth ", "fifth "]),
    "third fourth  fifth",
  );
  assert.equal(buildContinuationRetrievalQuery(["  ", "\n"]), "");
});

test("retrieval adapter keeps best-first top five and follows the public hit fallbacks", () => {
  assert.deepEqual(normalizeContinuationRetrievalHits([
    { entityId: "scene-1", sceneId: "scene-1", snippet: "  first  ", text: "ignored" },
    { sceneId: "scene-2", text: "second" },
    { entityId: "scene-3", sceneId: "scene-3", snippet: "  " },
    { entityId: "scene-4", sceneId: "scene-4", text: "fourth" },
    { sceneId: "scene-5", snippet: "fifth" },
    { entityId: "scene-6", text: "outside top five" },
  ]), [
    { entityId: "scene-1", text: "first" },
    { entityId: "scene-2", text: "second" },
    { entityId: "scene-4", text: "fourth" },
    { entityId: "scene-5", text: "fifth" },
  ]);
});

test("chapter summary and up to five retrieval hits follow source context priority", () => {
  const built = buildContinuationContext({
    recentSentences: ["recent"],
    chapterSummary: { chapterId: "chapter-1", text: "  summary  " },
    retrievalHits: [
      { entityId: "hit-1", text: "one" },
      { entityId: "hit-2", text: "two" },
      { entityId: "hit-3", text: "three" },
      { entityId: "hit-4", text: "four" },
      { entityId: "hit-5", text: "five" },
      { entityId: "hit-6", text: "six" },
    ],
    tokenBudget: 10_000,
    countTokens: (text) => text.length,
  });

  assert.equal(built.text, "recent\n\nsummary\n\none\n\ntwo\n\nthree\n\nfour\n\nfive");
  assert.deepEqual(built.manifest.parts.map((part) => part.kind), [
    "recent-sentences",
    "chapter-summary",
    "retrieval-hit",
    "retrieval-hit",
    "retrieval-hit",
    "retrieval-hit",
    "retrieval-hit",
  ]);
  assert.equal(built.manifest.parts[1]?.chapterId, "chapter-1");
  assert.equal(built.manifest.parts.at(-1)?.entityId, "hit-5");
  assert.equal(built.manifest.tokenCountMode, "provided");
});

test("budget trims oldest recent sentences before dropping lower-priority sections", () => {
  const built = buildContinuationContext({
    recentSentences: ["oldest", "middle", "tail"],
    k: 3,
    chapterSummary: { chapterId: "chapter-1", text: "too long" },
    retrievalHits: [{ entityId: "hit-1", text: "x" }],
    tokenBudget: 8,
    countTokens: (text) => text.length,
  });

  assert.equal(built.text, "tail\n\nx");
  assert.deepEqual(built.manifest.parts.map((part) => part.kind), ["recent-sentences", "retrieval-hit"]);
  assert.equal(built.manifest.parts[0]?.count, 1);
  assert.equal(built.manifest.totalTokens, 7);
  assert.equal(built.manifest.totalTokens <= built.manifest.tokenBudget, true);
});

test("k is bounded to the source API range and zero omits recent sentences", () => {
  const sentences = Array.from({ length: 45 }, (_, index) => `s${index}`);
  const bounded = buildContinuationContext({ recentSentences: sentences, k: 80, countTokens: () => 0 });
  const none = buildContinuationContext({ recentSentences: sentences, k: 0, countTokens: () => 0 });

  assert.equal(bounded.manifest.parts[0]?.count, 40);
  assert.equal(bounded.text.split("\n").length, 40);
  assert.equal(none.text, "");
  assert.deepEqual(none.manifest.parts, []);
});

test("approximate fallback is explicitly labeled and is not presented as model-token measurement", () => {
  assert.equal(approximateContinuationTokenCount("あa"), 2);
  const built = buildContinuationContext({ recentSentences: ["hello"] });

  assert.equal(built.manifest.tokenCountMode, "approximate");
  assert.equal(built.manifest.totalTokens, approximateContinuationTokenCount("hello"));
});

test("invalid budgets and injected counter results fail instead of bypassing the cap", () => {
  assert.throws(() => buildContinuationContext({ recentSentences: [], tokenBudget: 0 }), /tokenBudget/);
  assert.throws(() => buildContinuationContext({ recentSentences: ["x"], countTokens: () => Number.NaN }), /countTokens/);
});
