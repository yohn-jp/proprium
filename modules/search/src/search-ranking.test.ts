import assert from "node:assert/strict";
import { test } from "node:test";
import { createSearchDocument, lexicalTokens, searchDocuments, searchTerms } from "./search-ranking.js";

test("lexical search ranks exact names and full text, applies scope and result bounds", () => {
  const documents = [
    createSearchDocument("manuscript/vol-1/ch-1/harbor.md", "a".repeat(64), "The moonlit harbor was quiet."),
    createSearchDocument("manuscript/vol-1/ch-2/market.md", "b".repeat(64), "A market near the harbor."),
    createSearchDocument("bible/locations/harbor.yaml", "c".repeat(64), "name: Harbor\ndescription: Moonlit waters"),
  ];
  const hits = searchDocuments(documents, "moonlit harbor", "fulltext", 1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.path, "manuscript/vol-1/ch-1/harbor.md");
  assert.match(hits[0]?.snippet ?? "", /moonlit harbor/u);
  assert.deepEqual(searchDocuments(documents, "har", "prefix", 10, "manuscript/vol-1/ch-2").map(({ path }) => path), [
    "manuscript/vol-1/ch-2/market.md",
  ]);
  assert.equal(searchDocuments(documents, "harbor", "exact", 10).some(({ path }) => path === "bible/locations/harbor.yaml"), true);
});

test("Japanese full-text tokens retain useful character pairs and optional word hints", () => {
  assert.deepEqual(lexicalTokens("青い駅前"), ["青い", "い駅", "駅前"]);
  const document = createSearchDocument("manuscript/vol-1/ch-1/a.md", "d".repeat(64), "青い駅前で待つ");
  assert.equal(searchDocuments([document], "駅前", "fulltext", 10).length, 1);
  assert.equal(searchDocuments([document], "待ち合わせ", "fulltext", 10, undefined, ["待つ"]).length, 1);
});

test("exact and prefix terminology lookups return only available scoped targets", () => {
  const terms = [
    { id: "term-blue", canonical: "Blue Lantern", aliases: ["Lantern"], targetPath: "bible/items/lantern.yaml" },
    { id: "term-old", canonical: "Blue Lining", aliases: [], targetPath: "bible/items/missing.yaml" },
  ];
  const revisions = new Map([["bible/items/lantern.yaml", "e".repeat(64)]]);
  assert.deepEqual(searchTerms(terms, revisions, "lantern", "exact").map(({ termId }) => termId), ["term-blue"]);
  assert.deepEqual(searchTerms(terms, revisions, "blue", "prefix").map(({ title }) => title), ["Blue Lantern"]);
});

