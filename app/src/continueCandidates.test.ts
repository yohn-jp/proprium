import assert from "node:assert/strict";
import test from "node:test";
import { EditorState } from "@codemirror/state";
import type { RecentActivityItem } from "@scriptorium/contracts";
import type { Tree } from "./api";
import {
  createUiSentencePositionIndexCache,
  createUiSentencePositionIndex,
  formatHandoffHint,
  mergeContinueCandidates,
  offsetAtUiSentenceIndex,
  readingResumeStorageKey,
  writingResumeStorageKey,
  uiSentenceIndexAtOffset,
} from "./resume/continueCandidates";

const tree: Tree = {
  title: "Novel",
  volumes: [{
    id: "v1",
    title: "Volume One",
    chapters: [{
      id: "c1",
      title: "Chapter One",
      scenes: [{ id: "scene-1", title: "First" }, { id: "scene-2", title: "Second" }],
    }],
  }],
};

test("continue candidates keep distinct device scenes and prefer the local cursor for the same scene", () => {
  const remote: RecentActivityItem[] = [
    { sceneId: "scene-1", sentenceOffset: 4, pageIndex: 3, deviceType: "mobile", updatedAt: "2026-10-17T01:00:00Z" },
    { sceneId: "scene-1", sentenceOffset: 5, pageIndex: 4, deviceType: "mobile", updatedAt: "2026-10-17T01:01:00Z" },
    { sceneId: "scene-2", sentenceOffset: 2, pageIndex: null, deviceType: "desktop", updatedAt: "2026-10-17T01:02:00Z" },
    { sceneId: "deleted-scene", sentenceOffset: 1, deviceType: "desktop", updatedAt: "2026-10-17T01:03:00Z" },
  ];
  const candidates = mergeContinueCandidates({ sceneId: "scene-1", cursorSentenceIndex: 7, scrollTop: 120 }, remote, tree);
  assert.deepEqual(candidates, [
    { sceneId: "scene-1", sentenceOffset: 7, pageIndex: 4, source: "local", deviceType: "mobile", updatedAt: "2026-10-17T01:01:00Z", scrollTop: 120 },
    { sceneId: "scene-2", sentenceOffset: 2, pageIndex: null, source: "server", deviceType: "desktop", updatedAt: "2026-10-17T01:02:00Z" },
  ]);
});

test("handoff hints identify the other device without displaying prose", () => {
  assert.equal(formatHandoffHint("mobile", "2026-10-17T11:59:00.000Z", Date.parse("2026-10-17T12:00:00.000Z"), "desktop"), "スマホで1分前まで編集していました");
  assert.equal(formatHandoffHint("desktop", "2026-10-17T11:59:00.000Z", Date.parse("2026-10-17T12:00:00.000Z"), "desktop"), null);
  assert.equal(formatHandoffHint("mobile", "invalid", 0, "desktop"), null);
});

test("local reading positions are isolated by author, repository, and scene", () => {
  const ownerA = readingResumeStorageKey("owner-a", "repo-key", "scene-1");
  assert.notEqual(ownerA, readingResumeStorageKey("owner-b", "repo-key", "scene-1"));
  assert.notEqual(ownerA, readingResumeStorageKey("owner-a", "other-repo", "scene-1"));
  assert.notEqual(ownerA, readingResumeStorageKey("owner-a", "repo-key", "scene-2"));
  assert.notEqual(writingResumeStorageKey("owner-a", "repo-key"), writingResumeStorageKey("owner-b", "repo-key"));
});

test("cursor mapping uses source sentence numbering around Japanese punctuation and dialogue", () => {
  const text = "地の文。「台詞です。」続き。";
  assert.equal(uiSentenceIndexAtOffset(text, 0), 1);
  assert.equal(uiSentenceIndexAtOffset(text, 4), 2);
  assert.equal(uiSentenceIndexAtOffset(text, 11), 3);
  assert.equal(offsetAtUiSentenceIndex(text, 2), 4);
  assert.equal(offsetAtUiSentenceIndex(text, 3), 11);
  assert.equal(offsetAtUiSentenceIndex(text, null), null);
});

test("reusable cursor positions preserve dialogue, UTF-16, and newline offsets", () => {
  const dialogue = createUiSentencePositionIndex("地の文。「台詞です。」続き。");
  assert.equal(dialogue.indexAtOffset(4), 2);
  assert.equal(dialogue.indexAtOffset(11), 3);
  assert.equal(dialogue.offsetAtIndex(2), 4);
  assert.equal(dialogue.offsetAtIndex(3), 11);

  const surrogatePair = createUiSentencePositionIndex("A😀。B。");
  assert.equal(surrogatePair.indexAtOffset(2), 1);
  assert.equal(surrogatePair.indexAtOffset(4), 2);
  assert.equal(surrogatePair.offsetAtIndex(2), 4);

  const multipleLines = createUiSentencePositionIndex("一文目。\n二文目。\n三文目。");
  assert.equal(multipleLines.indexAtOffset(4), null);
  assert.equal(multipleLines.indexAtOffset(5), 2);
  assert.equal(multipleLines.indexAtOffset(10), 3);
  assert.equal(multipleLines.offsetAtIndex(2), 5);
  assert.equal(multipleLines.offsetAtIndex(3), 10);

  const blankLine = createUiSentencePositionIndex("一文目。\n\n四文目。");
  assert.equal(blankLine.offsetAtIndex(3), 6);
  assert.equal(blankLine.indexAtOffset(6), 3);
  assert.equal(blankLine.indexAtOffset(10), 4);
});

test("selection-only cursor updates reuse the CodeMirror document without materializing text", () => {
  const state = EditorState.create({ doc: "地の文。「台詞です。」続き。" });
  const doc = state.doc;
  const originalToString = doc.toString;
  let materializations = 0;
  Object.defineProperty(doc, "toString", {
    configurable: true,
    value() {
      materializations++;
      return originalToString.call(this);
    },
  });

  let indexBuilds = 0;
  const cache = createUiSentencePositionIndexCache<typeof doc>((text) => {
    indexBuilds++;
    return createUiSentencePositionIndex(text);
  });

  try {
    const changedText = doc.toString();
    const index = cache.get(doc, changedText);
    const afterDocumentChange = materializations;
    let selectionState = state;
    for (const anchor of [4, 11, 2, 14]) {
      selectionState = selectionState.update({ selection: { anchor } }).state;
      assert.strictEqual(selectionState.doc, doc);
      assert.strictEqual(cache.get(selectionState.doc), index);
    }

    assert.equal(materializations - afterDocumentChange, 0);
    assert.equal(indexBuilds, 1);
    assert.equal(index.indexAtOffset(4), 2);
    assert.equal(index.indexAtOffset(11), 3);

    const revisedState = selectionState.update({
      changes: { from: 0, to: selectionState.doc.length, insert: "一文目。\n\n四文目。" },
    }).state;
    assert.notStrictEqual(revisedState.doc, doc);
    const revisedText = revisedState.doc.toString();
    const revisedIndex = cache.get(revisedState.doc, revisedText);
    assert.notStrictEqual(revisedIndex, index);
    assert.equal(index.offsetAtIndex(3), 11);
    assert.equal(revisedIndex.offsetAtIndex(3), 6);
    assert.equal(revisedIndex.indexAtOffset(6), 3);
    assert.equal(indexBuilds, 2);
  } finally {
    Reflect.deleteProperty(doc, "toString");
  }
});
