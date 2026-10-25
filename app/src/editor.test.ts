import assert from "node:assert/strict";
import test from "node:test";
import { Text } from "@codemirror/state";
import { resolveBracketInput } from "./editor/cm/bracketLogic";
import { normalizeEllipsisInsert } from "./editor/cm/ellipsisNormalize";
import { documentBody, parseRubySegments, replaceDocumentBody } from "./editor/ruby";
import { planWritingSymbol } from "./editor/writingSymbols";
import { normalizeTypographySettings } from "./editor/typography";
import { typographyPresetValues } from "./editor/typography";
import { clampPageIndex, measureColumnPageCount, pageTranslateX, tapZoneAtX } from "./editor/readingMetrics";

test("writing input retains Japanese bracket pairing and skips an existing closer", () => {
  const empty = Text.of([""]);
  assert.deepEqual(resolveBracketInput(empty, 0, 0, "「"), { insert: "「」", cursor: 1 });
  assert.deepEqual(resolveBracketInput(Text.of(["」"]), 0, 0, "「"), { insert: "「", cursor: 1 });
  assert.deepEqual(resolveBracketInput(Text.of(["」"]), 0, 0, "」"), { insert: "", cursor: 1 });
  assert.equal(resolveBracketInput(empty, 0, 0, "あ"), null);
});

test("single ellipses normalize to the source's two-character form", () => {
  assert.equal(normalizeEllipsisInsert("", "…", ""), "……");
  assert.equal(normalizeEllipsisInsert("前", "…", "後"), "……");
  assert.equal(normalizeEllipsisInsert("", "……", ""), "……");
});

test("ruby parsing keeps the source's explicit Aozora syntax and frontmatter bytes", () => {
  assert.deepEqual(parseRubySegments("彼は|東京《とうきょう》へ行く。"), [
    { kind: "text", value: "彼は", key: "text-0" },
    { kind: "ruby", base: "東京", reading: "とうきょう", key: "ruby-2" },
    { kind: "text", value: "へ行く。", key: "text-12" },
  ]);
  assert.deepEqual(parseRubySegments("｜東京《とうきょう》"), [
    { kind: "text", value: "｜東京《とうきょう》", key: "text-0" },
  ]);
  const document = "---\ntitle: 試験\n---\n\n本文\n";
  assert.deepEqual(documentBody(document), { prefix: "---\ntitle: 試験\n---\n\n", body: "本文\n" });
  assert.equal(replaceDocumentBody(document, "新しい本文"), "---\ntitle: 試験\n---\n\n新しい本文");
});

test("mobile writing symbols wrap selected text and preserve the cursor inside quotes", () => {
  assert.deepEqual(planWritingSymbol("本文", 0, 2, "quotes"), {
    from: 0,
    to: 2,
    insert: "「本文」",
    cursor: 3,
  });
  assert.equal(planWritingSymbol("本文", 2, 2, "paragraph").insert, "\n\n");
});

test("typography preferences retain source ranges and reject invalid values", () => {
  assert.deepEqual(normalizeTypographySettings({ fontSize: 100, lineHeight: 0, letterSpacing: 0.08, fontFamily: "mincho" }), {
    fontSize: 16,
    lineHeight: 1.8,
    letterSpacing: 0.08,
    maxWidth: 960,
    fontFamily: "mincho",
  });
  assert.deepEqual(normalizeTypographySettings(null), {
    fontSize: 16,
    lineHeight: 1.8,
    letterSpacing: 0,
    maxWidth: 960,
    fontFamily: "gothic",
  });
  assert.deepEqual(typographyPresetValues("bunko"), { fontFamily: "mincho", lineHeight: 1.7, maxWidth: 560, letterSpacing: 0.02 });
  assert.equal(normalizeTypographySettings({ maxWidth: 100 }).maxWidth, 960);
});

test("mobile reading pagination clamps pages, measures columns, and follows writing direction", () => {
  assert.equal(measureColumnPageCount(901, 300), 4);
  assert.equal(measureColumnPageCount(0, 300), 1);
  assert.equal(clampPageIndex(8, 4), 3);
  assert.equal(clampPageIndex(Number.NaN, 4), 0);
  assert.equal(pageTranslateX(2, 320, "ltr"), -640);
  assert.equal(pageTranslateX(2, 320, "rtl"), 640);
  assert.equal(tapZoneAtX(10, 0, 400), "left");
  assert.equal(tapZoneAtX(390, 0, 400), "right");
  assert.equal(tapZoneAtX(200, 0, 400), "center");
});
