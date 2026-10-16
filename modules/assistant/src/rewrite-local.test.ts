import assert from "node:assert/strict";
import test from "node:test";
import { buildRewriteLocalSuggestions } from "./rewrite-local.js";

test("buildRewriteLocalSuggestions splits at the first source-priority connective", () => {
  const result = buildRewriteLocalSuggestions("彼は息を整え、窓を見たが、しかし外には誰もいなかった。");

  assert.deepEqual(result.sentenceSplit, {
    text: "彼は息を整え、窓を見たが。しかし外には誰もいなかった。",
    rationale: "長い一文を意味の切れ目で二文に分け、読みやすさを上げます。",
  });
  assert.equal(result.tellToShow, undefined);
});

test("buildRewriteLocalSuggestions enforces source sentence-split minimums", () => {
  assert.deepEqual(buildRewriteLocalSuggestions("短いが、これも短い。"), {});
  assert.deepEqual(buildRewriteLocalSuggestions("これは十分に長い前半、そして後半も十分に長い文です。").sentenceSplit, {
    text: "これは十分に長い前半。そして後半も十分に長い文です。",
    rationale: "長い一文を意味の切れ目で二文に分け、読みやすさを上げます。",
  });
});

test("buildRewriteLocalSuggestions prefers the first corpus action only for recognized tell expressions", () => {
  assert.deepEqual(buildRewriteLocalSuggestions("彼女は悲しかった。", ["彼女は袖口を握り、うつむいた。", "別の所作。"]).tellToShow, {
    text: "彼女は袖口を握り、うつむいた。",
    rationale: "自作品コーパスにある所作描写を、tell→show の参考候補として提示します。",
    source: "corpus",
  });
  assert.deepEqual(buildRewriteLocalSuggestions("彼女は廊下を歩いた。", ["無関係な所作。"]), {});
});

test("buildRewriteLocalSuggestions retains every source tell-to-show replacement", () => {
  const cases = [
    ["悲しかった。", "喉の奥が詰まり、視線が足元へ落ちた。"],
    ["悲しい。", "喉の奥が詰まり、視線が足元へ落ちる。"],
    ["怒っていた。", "奥歯を噛み、握った拳に力を込めていた。"],
    ["怒った。", "奥歯を噛み、握った拳に力を込めた。"],
    ["怖かった。", "背筋が冷え、足がその場に縫い止められた。"],
    ["怖い。", "背筋が冷え、足がその場に縫い止められる。"],
    ["嬉しかった。", "頬がゆるみ、弾む息がこぼれた。"],
    ["嬉しい。", "頬がゆるみ、弾む息がこぼれる。"],
    ["緊張していた。", "浅い呼吸を整えようと、指先を握り込んでいた。"],
    ["緊張した。", "浅い呼吸を整えようと、指先を握り込んだ。"],
  ] as const;

  for (const [sentence, expected] of cases) {
    const suggestion = buildRewriteLocalSuggestions(sentence).tellToShow;
    assert.equal(suggestion?.text, expected, sentence);
    assert.equal(suggestion?.source, "heuristic", sentence);
  }
});

test("buildRewriteLocalSuggestions preserves source replacement order, punctuation, and whitespace semantics", () => {
  assert.deepEqual(buildRewriteLocalSuggestions("彼女はとても悲しかった。\t彼は怒っていた！").tellToShow, {
    text: "彼女はとても喉の奥が詰まり、視線が足元へ落ちた。\t彼は奥歯を噛み、握った拳に力を込めていた！",
    rationale: "感情を直接説明せず、身体反応と所作で示します。",
    source: "heuristic",
  });
  assert.deepEqual(buildRewriteLocalSuggestions("  彼女は廊下を歩いた。  "), {
    tellToShow: {
      text: "彼女は廊下を歩いた。",
      rationale: "感情を直接説明せず、身体反応と所作で示します。",
      source: "heuristic",
    },
  });
});
