import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { NarrativeQuickAppend, recentManuscriptParagraphs } from "./NarrativeQuickAppend.js";

test("quick append exposes only the last three read-only paragraphs and an IME-capable editor input", () => {
  const text = "First paragraph.\r\n\r\nSecond paragraph.\r\n\r\nThird paragraph.\r\n\r\nFourth paragraph.\r\n";
  const paragraphs = recentManuscriptParagraphs(text);
  assert.deepEqual(paragraphs, ["Second paragraph.", "Third paragraph.", "Fourth paragraph."]);
  const html = renderToStaticMarkup(createElement(NarrativeQuickAppend, { paragraphs, append: async () => undefined }));
  assert.match(html, /aria-label="直前の段落"/u);
  assert.match(html, /Second paragraph\./u);
  assert.match(html, /Fourth paragraph\./u);
  assert.doesNotMatch(html, /First paragraph\./u);
  assert.match(html, /<textarea[^>]*id="narrative-quick-append-text"/u);
  assert.match(html, />原稿に追記<\/button>/u);
});

test("empty, blank and one-paragraph manuscripts have bounded context", () => {
  assert.deepEqual(recentManuscriptParagraphs("\n  \n"), []);
  assert.deepEqual(recentManuscriptParagraphs("Only paragraph.\n"), ["Only paragraph."]);
});
