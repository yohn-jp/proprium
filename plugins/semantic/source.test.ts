import assert from "node:assert/strict";
import test from "node:test";
import { parseSemanticSourceFile } from "./source.ts";

function evidenceText(content: string, passage: { evidence: { start: number; end: number; quote: string } }) {
  assert.equal(passage.evidence.quote, content.slice(passage.evidence.start, passage.evidence.end));
  return passage.evidence.quote;
}

test("markdown body passages preserve exact source spans and UTF-16 offsets", () => {
  const content = "---\r\ntitle: Station\r\n---\r\n\r\n駅前で会う。🌸次の場面。\r\n";
  const entity = parseSemanticSourceFile("manuscript/chapter-1.md", "rev-1", content)!;
  assert.equal(entity.id, "ms-chapter-1");
  assert.equal(entity.type, "manuscript");
  assert.deepEqual(entity.passages.map(({ text }) => text), ["駅前で会う。", "🌸次の場面。"]);
  assert.deepEqual(entity.passages.map((passage) => evidenceText(content, passage)), ["駅前で会う。", "🌸次の場面。"]);
  assert.equal(entity.passages[1]!.evidence.start, content.indexOf("🌸"));
});

test("YAML literal block body and quoted description preserve field order and original spans", () => {
  const content = [
    "id: scene-1",
    "type: scene",
    "name: Station",
    "body: |",
    "  First sentence.",
    "  Second sentence.",
    'description: "A quoted description."',
    "notes: A note.",
    "",
  ].join("\n");
  const entity = parseSemanticSourceFile("plot/scenes/scene-1.yaml", "rev-2", content)!;
  assert.deepEqual(entity.passages.map(({ text, sentenceIndex }) => ({ text, sentenceIndex })), [
    { text: "First sentence.", sentenceIndex: 0 },
    { text: "Second sentence.", sentenceIndex: 1 },
    { text: "A quoted description.", sentenceIndex: 2 },
    { text: "A note.", sentenceIndex: 3 },
  ]);
  assert.deepEqual(entity.passages.map((passage) => evidenceText(content, passage)), [
    "First sentence.", "Second sentence.", "A quoted description.", "A note.",
  ]);
});

test("folded YAML text is embedded in parsed form while evidence cites its exact raw source", () => {
  const content = "id: lore-1\ntype: lore\nbody: >\n  First folded\n  sentence. Next paragraph.\n";
  const entity = parseSemanticSourceFile("bible/lore/place.yaml", "rev-folded", content)!;
  assert.deepEqual(entity.passages.map(({ text }) => text), ["First folded sentence.", "Next paragraph."]);
  assert.deepEqual(entity.passages.map((passage) => evidenceText(content, passage)), [
    "First folded\n  sentence.", "Next paragraph.",
  ]);
});

test("malformed YAML is skipped and escaped YAML text without a lossless source map is rejected", () => {
  assert.equal(parseSemanticSourceFile("bible/characters/a.yaml", "rev-bad", "id: [\n"), null);
  assert.throws(
    () => parseSemanticSourceFile("bible/characters/a.yaml", "rev-escaped", 'id: a\ndescription: "A\\nB"\n'),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "capacity"),
  );
});


test("markdown before a later delimiter remains manuscript text", () => {
  const content = "# Prologue\n---\ntitle: Station\n---\nStory.";
  const entity = parseSemanticSourceFile("manuscript/chapter-1.md", "rev-1", content)!;
  assert.equal(entity.passages[0]!.evidence.quote, "# Prologue");
});
