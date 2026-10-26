import assert from "node:assert/strict";
import test from "node:test";
import { computeTextDiff } from "./text-diff.js";

test("computes a line diff with source and destination line numbers", () => {
  const diff = computeTextDiff("one\ntwo\nkeep\n", "one\nnew\nkeep\n");
  assert.ok(diff);
  assert.deepEqual(diff.lines, [
    { kind: "context", text: "one", beforeLine: 1, afterLine: 1 },
    { kind: "removed", text: "two", beforeLine: 2, afterLine: null },
    { kind: "added", text: "new", beforeLine: null, afterLine: 2 },
    { kind: "context", text: "keep", beforeLine: 3, afterLine: 3 },
  ]);
});

test("reports newline changes so the visual diff does not hide them", () => {
  const diff = computeTextDiff("one\r\n", "one");
  assert.ok(diff);
  assert.equal(diff.beforeLineEnding, "CRLF");
  assert.equal(diff.afterLineEnding, "なし");
  assert.equal(diff.beforeHasFinalNewline, true);
  assert.equal(diff.afterHasFinalNewline, false);
});

test("uses the side-by-side fallback before an inline diff would grow too large", () => {
  const manyLines = Array.from({ length: 1_500 }, (_, index) => `line-${index}`).join("\n");
  assert.equal(computeTextDiff(manyLines, manyLines), null);
});
