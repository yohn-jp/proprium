import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTermRegistry, resolveTermSpans, type SearchTerm } from "./terminology.js";

const terms: SearchTerm[] = [
  { id: "term-blue", canonical: "Blue Lantern", aliases: ["Lantern"], targetPath: "manuscript/vol-1/ch-1/a.md" },
];

test("term resolver preserves UTF-16 offsets across emoji and compatibility normalization", () => {
  const text = "🎐 Ｂlue Lantern and Lanterners, then Lantern.";
  const result = resolveTermSpans(text, terms, new Set([terms[0]!.targetPath]));
  const first = result.spans[0]!;
  assert.equal(text.slice(first.start, first.end), "Ｂlue Lantern");
  assert.equal(first.start, 3);
  assert.equal(text.slice(result.spans[1]!.start, result.spans[1]!.end), "Lantern");
  assert.equal(result.spans.length, 2);
  assert.deepEqual(result.ambiguities, []);
});

test("shared aliases are inspectable but never become a guessed navigation link", () => {
  const collision = [
    ...terms,
    { id: "term-other", canonical: "Lantern Keeper", aliases: ["Lantern"], targetPath: "bible/characters/keeper.yaml" },
  ];
  const result = resolveTermSpans("Lantern", collision);
  assert.deepEqual(result.spans, []);
  assert.deepEqual(result.ambiguities, [{ start: 0, end: 7, alias: "Lantern", termIds: ["term-blue", "term-other"] }]);
});

test("longest overlapping unique alias wins and unavailable targets stay plain text", () => {
  const overlapping = [
    ...terms,
    { id: "term-short", canonical: "Blue", aliases: [], targetPath: "manuscript/vol-1/ch-1/a.md" },
  ];
  const resolved = resolveTermSpans("Blue Lantern", overlapping);
  assert.deepEqual(resolved.spans.map(({ termId }) => termId), ["term-blue"]);
  assert.deepEqual(resolveTermSpans("Blue Lantern", terms, new Set()).spans, []);
});

test("registry parser rejects unsafe targets, duplicate IDs, and malformed aliases", () => {
  assert.throws(() => parseTermRegistry({ schemaVersion: 1, terms: [{ ...terms[0]!, targetPath: "../secret.md" }] }), /Unsafe project path/u);
  assert.throws(() => parseTermRegistry({ schemaVersion: 1, terms: [terms[0], terms[0]] }), /invalid/u);
  assert.throws(() => parseTermRegistry({ schemaVersion: 1, terms: [{ ...terms[0]!, aliases: [""] }] }), /invalid/u);
});

