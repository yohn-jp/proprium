import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateCandidateTerms, extractCompoundNounsWithReading } from "./candidateDiscovery.js";
import { expandSearchTerms, suggestTermVariants } from "./termVariants.js";
import type { Token } from "./tokenizer/types.js";

function noun(surface: string, reading: string, start: number): Token {
  return { surface, reading, pos: "名詞", start, end: start + surface.length };
}

test("candidate aggregation preserves source reading, per-entity occurrence count, and known-name exclusions", () => {
  const firstText = [noun("銀", "ギン", 0), noun("河", "カワ", 1), { surface: "。", pos: "記号", start: 2, end: 3 }];
  const secondText = [noun("銀", "ギン", 0), noun("河", "カワ", 1)];
  const otherTerm = [noun("大", "ダイ", 0), noun("河", "カワ", 1)];
  assert.deepEqual(extractCompoundNounsWithReading(firstText), [{ term: "銀河", reading: "ギンカワ" }]);

  const candidates = aggregateCandidateTerms([
    { id: "character-1", tokenizedTexts: [firstText, secondText, otherTerm] },
    { id: "scene-1", tokenizedTexts: [firstText] },
  ], new Set(["大河"]));
  assert.deepEqual(candidates, [{ term: "銀河", reading: "ギンカワ", sourceEntityIds: ["character-1", "scene-1"], occurrenceCount: 3 }]);
});

test("term variants preserve known-term first match and choose the highest-frequency cluster representative", () => {
  assert.deepEqual(suggestTermVariants([
    { term: "王都街道", count: 5 },
    { term: "王都街道筋", count: 2 },
    { term: "王都街道脇", count: 3 },
  ], new Set(["王都街道" ])), [
    { candidate: "王都街道筋", canonical: "王都街道", count: 2 },
    { candidate: "王都街道脇", canonical: "王都街道", count: 3 },
  ]);
});

test("search term expansion trims literals and adds only known source-style variants", () => {
  assert.deepEqual(expandSearchTerms("  サーベル剣  ", ["サーベル", "サーベル剣", "短剣", ""]), ["サーベル剣", "サーベル"]);
  assert.deepEqual(expandSearchTerms("   ", ["a"]), []);
});
