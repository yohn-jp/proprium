import assert from "node:assert/strict";
import test from "node:test";
import { savedSelectionRange } from "./NarrativeReadingMarkCapture.js";

test("saved offsets include BOM and preserve Japanese surrogate pairs and CRLF", () => {
  const text = "漢🙂\r\n次";
  assert.deepEqual(savedSelectionRange(`\ufeff${text}`, text, 3, 1), { offset: 2, length: 2, snippet: "🙂" });
  assert.deepEqual(savedSelectionRange(text, text, 3, 5), { offset: 3, length: 2, snippet: "\r\n" });
});

test("reject mismatched body, empty/out-of-range and split surrogate selections", () => {
  assert.throws(() => savedSelectionRange("a\r\nb", "a\nb", 0, 1), /一致/);
  assert.throws(() => savedSelectionRange("abc", "abc", 1, 1), /選択/);
  assert.throws(() => savedSelectionRange("abc", "abc", -1, 1), /範囲/);
  assert.throws(() => savedSelectionRange("🙂", "🙂", 0, 1), /途中/);
  assert.throws(() => savedSelectionRange("🙂", "🙂", 1, 2), /途中/);
  const big = "a".repeat(16385);
  assert.throws(() => savedSelectionRange(big, big, 0, big.length), /16384/);
});
