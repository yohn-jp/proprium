import assert from "node:assert/strict";
import test from "node:test";
import { splitIntoSentenceOffsets } from "./sentences.ts";

test("sentence offsets preserve Japanese brackets, multiline boundaries, and UTF-16 coordinates", () => {
  const text = "「彼は言った。続けよう。」\n海岸へ向かった。🌊";
  const offsets = splitIntoSentenceOffsets(text);
  const nonEmpty = offsets.map(({ start, end }) => text.slice(start, end).trim()).filter(Boolean);
  assert.deepEqual(nonEmpty, ["「彼は言った。続けよう。」", "海岸へ向かった。", "🌊"]);
  const finalSentence = offsets.find(({ start, end }) => text.slice(start, end) === "🌊")!;
  assert.equal(finalSentence.end - finalSentence.start, 2);
});
