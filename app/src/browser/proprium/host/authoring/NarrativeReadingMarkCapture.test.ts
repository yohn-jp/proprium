import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { findMarkForSelectedRange, NarrativeReadingMarkCapture, savedSelectionRange } from "./NarrativeReadingMarkCapture.js";

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

test("selection removes only one current mark with the exact saved UTF-16 range", () => {
  const selected = { scene_id: "scene", offset: 1, length: 2, snippet: "漢🙂", expected_metadata_revision: "metadata", expected_manuscript_revision: "body" };
  const current = { id: "mark-current", ...selected, position_status: "current" as const };
  const snapshot = { metadata_revision: "metadata", manuscript_revision: "body", marks: [current] };
  assert.deepEqual(findMarkForSelectedRange(snapshot, selected), current);
  assert.throws(() => findMarkForSelectedRange({ ...snapshot, marks: [{ ...current, position_status: "stale" }] }, selected), /一致/);
  assert.throws(() => findMarkForSelectedRange({ ...snapshot, marks: [{ ...current, offset: 0 }] }, selected), /一致/);
  assert.throws(() => findMarkForSelectedRange({ ...snapshot, marks: [current, { ...current, id: "mark-duplicate" }] }, selected), /複数/);
  assert.throws(() => findMarkForSelectedRange({ ...snapshot, manuscript_revision: "new-body" }, selected), /変更/u);
  assert.throws(() => findMarkForSelectedRange({ ...snapshot, metadata_revision: "new-metadata" }, selected), /変更/u);
});

test("reader capture surface exposes a review-gated delete action for the selected saved range", () => {
  const html = renderToStaticMarkup(createElement(NarrativeReadingMarkCapture, {
    capture: () => ({ scene_id: "scene", offset: 0, length: 1, snippet: "漢", expected_metadata_revision: "meta", expected_manuscript_revision: "body" }),
    propose: async () => undefined,
    removeSelected: async () => undefined,
  }));
  assert.match(html, /選択範囲に読書マークを提案/u);
  assert.match(html, /選択した読書マークの削除を提案/u);
});
