import assert from "node:assert/strict";
import test from "node:test";
import { setSentenceEnds, splitIntoSentenceOffsets, splitIntoSentences } from "./sentenceSplit.js";

test("component sentence boundaries retain Japanese quotes and UTF-16 offsets", () => {
  setSentenceEnds((text) => new Uint32Array([text.length]));
  const source = "🌙太郎は言った。「行こう。」";
  const offsets = splitIntoSentenceOffsets(source);
  assert.deepEqual(offsets.map(({ start, end }) => source.slice(start, end)), ["🌙太郎は言った。", "「行こう。」", ""]);
  assert.deepEqual(splitIntoSentences(source), ["🌙太郎は言った。", "「行こう。」", ""]);
  assert.deepEqual(offsets, [{ start: 0, end: 9 }, { start: 9, end: source.length }, { start: source.length, end: source.length }]);
});

test("component sentence boundaries fail closed on invalid offsets", () => {
  setSentenceEnds(() => new Uint32Array([1, 1]));
  assert.throws(() => splitIntoSentenceOffsets("abc"), /Invalid Unicode sentence boundary/u);
  setSentenceEnds(() => new Uint32Array([1]));
  assert.throws(() => splitIntoSentenceOffsets("abc"), /Incomplete Unicode sentence boundaries/u);
});
