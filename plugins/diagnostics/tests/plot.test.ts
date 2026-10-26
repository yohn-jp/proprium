import assert from "node:assert/strict";
import test from "node:test";
import { analyzePlotGoal, DEFAULT_PLOT_LEXICON, parsePlotLexicon, type PlotToken } from "../src/plot.js";

function tokens(text: string, rows: Array<[string, string, string?]>): PlotToken[] {
  let offset = 0;
  return rows.map(([surface, pos, base]) => {
    const start = text.indexOf(surface, offset);
    assert.notEqual(start, -1);
    offset = start + surface.length;
    return { start, end: offset, surface, pos, ...(base ? { base } : {}) };
  });
}

test("pinned plot rules identify a weak lexical contradiction with both source spans", () => {
  const goal = "秘密を隠す";
  const body = "彼は正体を暴露した。";
  const warnings = analyzePlotGoal({
    goalTokens: tokens(goal, [["秘密", "名詞"], ["隠す", "動詞"]]),
    bodyTokens: tokens(body, [["彼", "名詞"], ["正体", "名詞"], ["暴露", "名詞"], ["した", "動詞"]]),
    goalText: goal, bodyText: body, goalPath: "meta/scenes/sc-1.yaml", goalRevision: "a".repeat(64),
    manuscriptPath: "manuscript/sc-1.md", manuscriptRevision: "b".repeat(64), lexicon: DEFAULT_PLOT_LEXICON,
  });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, "contradiction");
  assert.equal(warnings[0].signal, "weak_lexical");
  assert.ok(warnings[0].violationDensity! >= 0.03);
  assert.ok(warnings[0].evidence.some((item) => item.source === "goal" && item.quote === "秘密"));
  assert.ok(warnings[0].evidence.some((item) => item.source === "manuscript" && item.quote === "暴露"));
});

test("pinned divergence threshold uses unique content terms and source-paired spans", () => {
  const goal = "旅人が城の謎を探る";
  const body = "海鳥が舟を追う";
  const warnings = analyzePlotGoal({
    goalTokens: tokens(goal, [["旅人", "名詞"], ["城", "名詞"], ["謎", "名詞"], ["探る", "動詞"]]),
    bodyTokens: tokens(body, [["海鳥", "名詞"], ["舟", "名詞"], ["追う", "動詞"]]),
    goalText: goal, bodyText: body, goalPath: "meta/scenes/sc-2.yaml", goalRevision: "a".repeat(64),
    manuscriptPath: "manuscript/sc-2.md", manuscriptRevision: "b".repeat(64), lexicon: DEFAULT_PLOT_LEXICON,
  });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, "divergence");
  assert.equal(warnings[0].similarity, 0);
  assert.ok(warnings[0].evidence.some((item) => item.source === "goal"));
  assert.ok(warnings[0].evidence.some((item) => item.source === "manuscript"));
});

test("plot lexicon parser rejects duplicate keys and invalid thresholds", () => {
  assert.throws(() => parsePlotLexicon("archetypes:\n  concealment: {}\n  concealment: {}\n"));
  assert.throws(() => parsePlotLexicon("archetypes:\n  concealment:\n    goalKeywords: {秘密: 1}\n    violationThreshold: -1\n"));
});
