import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RubyText } from "./ruby";
import { findTermSpanAtSelection, selectPendingTermLines, selectVisibleTermSlices, validateEditorTermSpans, type EditorTermSpan } from "./terms";

test("visible reader lines are resolved once per visit and can be queued again after leaving", () => {
  const visible = [10, 20, 30];
  const active = new Set([20]);
  const completed = new Set([10]);

  assert.deepEqual(selectPendingTermLines(visible, active, completed, 2), [30]);
  completed.add(30);
  assert.deepEqual(selectPendingTermLines(visible, active, completed, 2), []);

  completed.delete(30);
  assert.deepEqual(selectPendingTermLines(visible, active, completed, 2), [30]);
});

test("editor keyboard navigation selects the term under the caret or one exact marked selection", () => {
  const spans: EditorTermSpan[] = [
    { start: 4, end: 8, termId: "one", targetPath: "terms/one.md" },
    { start: 8, end: 12, termId: "two", targetPath: "terms/two.md" },
  ];
  assert.equal(findTermSpanAtSelection(spans, { from: 5, to: 5 }), spans[0]);
  assert.equal(findTermSpanAtSelection(spans, { from: 8, to: 8 }), spans[1]);
  assert.equal(findTermSpanAtSelection(spans, { from: 5, to: 7 }), spans[0]);
  assert.equal(findTermSpanAtSelection(spans, { from: 3, to: 9 }), undefined);
});

test("visible term slices are sorted, clipped, and bounded", () => {
  assert.deepEqual(selectVisibleTermSlices([
    { from: 30, to: 50 },
    { from: 5, to: 12 },
    { from: 10, to: 20 },
    { from: Number.NaN, to: 80 },
  ], 100, { maxTotalChars: 19, maxSliceChars: 8 }), [
    { from: 5, to: 12 },
    { from: 12, to: 20 },
    { from: 30, to: 34 },
  ]);
  assert.deepEqual(selectVisibleTermSlices([{ from: -5, to: 8 }, { from: 95, to: 110 }], 100), [
    { from: 0, to: 8 },
    { from: 95, to: 100 },
  ]);
});

test("resolver spans use UTF-16 positions and malformed or overlapping results are discarded", () => {
  const text = "🙂猫";
  const spans: EditorTermSpan[] = [
    { start: 2, end: 3, termId: "cat", targetPath: "terms/cat.md" },
    { start: 0, end: 1, termId: "broken-surrogate", targetPath: "terms/invalid.md" },
    { start: 2, end: 3, termId: "duplicate", targetPath: "terms/duplicate.md" },
    { start: 3, end: 4, termId: "past-end", targetPath: "terms/end.md" },
  ];
  assert.deepEqual(validateEditorTermSpans(text, spans), [spans[0]]);
  assert.equal(text, "🙂猫");
});

test("reading terms render as accessible links over Ruby text without changing the source", () => {
  const text = "|東京《とうきょう》へ行く";
  const original = text;
  const html = renderToStaticMarkup(createElement(RubyText, {
    text,
    termSpans: [{ start: 1, end: 3, termId: "tokyo", targetPath: "terms/tokyo.md" }],
    onTermNavigate: () => undefined,
  }));

  assert.match(html, /<ruby><button[^>]*aria-label="東京、用語を開く"[^>]*>東京<\/button><rt>とうきょう<\/rt><\/ruby>/u);
  assert.equal(text, original);
});
