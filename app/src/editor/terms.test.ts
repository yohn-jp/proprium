import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RubyText } from "./ruby";
import { selectVisibleTermSlices, validateEditorTermSpans, type EditorTermSpan } from "./terms";

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
