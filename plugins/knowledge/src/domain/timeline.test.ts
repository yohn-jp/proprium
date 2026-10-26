import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSceneTimelineEntries,
  deriveTimelineConfidence,
  estimateSceneTimeline,
  extractTimeExpressions,
  parseJapaneseNumber,
  type StoryTokenizer,
} from "./timeline.js";
import type { SnapshotId } from "./types.js";

const snapshot: SnapshotId = {
  repository: {
    provider: "local",
    repositoryId: "repo-time",
    defaultBranch: "main",
    ownerScope: "owner-1",
    url: "file:///repo-time",
  },
  remoteCommit: "c".repeat(40),
};

test("Japanese number and time extraction retain source surfaces and offsets", () => {
  assert.equal(parseJapaneseNumber("三"), 3);
  assert.equal(parseJapaneseNumber("十二"), 12);
  assert.equal(parseJapaneseNumber("3"), 3);
  assert.equal(parseJapaneseNumber("三日"), null);

  const result = extractTimeExpressions({
    snapshot,
    text: "三日後の翌朝、夕暮れまで歩いた。",
  });
  assert.strictEqual(result.snapshot, snapshot);
  assert.deepEqual(
    result.data.map((expression) => [expression.surface, expression.deltaDays, expression.kind]),
    [
      ["三日後", 3, "relative-forward"],
      ["翌朝", 1, "relative-forward"],
      ["夕暮れ", null, "time-of-day"],
    ],
  );
  assert.equal(result.data[1]?.timeOfDay, "morning");
});

test("tokenizer recovers split relative expressions while preserving source spans", () => {
  const tokenizer: StoryTokenizer = {
    tokenize: () => [
      { surface: "三", pos: "名詞", posDetail: ["数"], start: 0, end: 1 },
      { surface: "日", pos: "名詞", posDetail: ["接尾"], start: 2, end: 3 },
      { surface: "後", pos: "助詞", start: 4, end: 5 },
    ],
  };
  const result = extractTimeExpressions({ snapshot, text: "三 日 後", tokenizer });
  assert.deepEqual(result.data, [
    {
      surface: "三日後",
      start: 0,
      end: 5,
      deltaDays: 3,
      kind: "relative-forward",
    },
  ]);
});

test("timeline stays unknown without relative time and marks reversals from explicit deltas", () => {
  const unknown = estimateSceneTimeline({
    snapshot,
    scenes: [
      { sceneId: "sc-1", order: 1, text: "ただの日常描写。" },
      { sceneId: "sc-2", order: 2, text: "会話が続く。" },
    ],
  });
  assert.equal(unknown.data[0]?.relation, "unknown");
  assert.equal(unknown.data[1]?.deltaFromPrevious, null);

  const reversal = estimateSceneTimeline({
    snapshot,
    scenes: [
      { sceneId: "sc-a", order: 1, text: "三日後に到着した。" },
      { sceneId: "sc-b", order: 2, text: "前日のことを思い出した。" },
    ],
  });
  assert.equal(reversal.data[0]?.cumulativeDayOffset, 3);
  assert.equal(reversal.data[1]?.deltaFromPrevious, -1);
  assert.equal(reversal.data[1]?.relation, "backward");
});

test("timeline entries carry caller snapshot, scene context and confidence labels", () => {
  const result = buildSceneTimelineEntries({
    snapshot,
    scenes: [
      {
        sceneId: "sc-a",
        order: 1,
        text: "日常。",
        title: "開幕",
        locationId: "loc-castle",
        locationName: "城",
        characters: [{ id: "char-a", name: "アリス" }],
        chapterId: "ch-1",
        chapterName: "序章",
      },
      { sceneId: "sc-b", order: 2, text: "三日後に到着した。", title: "到着" },
      { sceneId: "sc-c", order: 3, text: "会話のみ。", title: "日付付き", explicitDateMeta: true },
      { sceneId: "sc-d", order: 4, text: "王国暦12年3月5日、門が開いた。" },
    ],
  });
  assert.strictEqual(result.snapshot, snapshot);
  assert.equal(result.data[0]?.confidence, "unknown");
  assert.equal(result.data[0]?.locationId, "loc-castle");
  assert.deepEqual(result.data[0]?.characters, [{ id: "char-a", name: "アリス" }]);
  assert.equal(result.data[1]?.confidence, "estimated");
  assert.deepEqual(result.data[1]?.expressionSurfaces, ["三日後"]);
  assert.equal(result.data[2]?.confidence, "confirmed");
  assert.equal(result.data[3]?.confidence, "confirmed");
  assert.equal(deriveTimelineConfidence({ snapshot, estimate: { expressions: [] } }).data, "unknown");
});
