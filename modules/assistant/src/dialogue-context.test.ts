import assert from "node:assert/strict";
import test from "node:test";
import { buildDialogueSketchSpeakerContext } from "./dialogue-context.js";

function fingerprint(entityId: string) {
  return {
    entityId,
    dialogueCount: 23,
    firstPersonDist: { z: 0.5, a: 0.5, middle: 0.25 },
    endingBigramDist: { "だ|よ": 0.75, "です|ね": 0.25 },
    politeRatio: 0.35,
    avgDialogueLength: 18.6,
    exclamationRate: 0.1,
    questionRate: 0.2,
  };
}

test("builds source-shaped voice, fingerprint, notes, blank headings, and high-confidence examples", () => {
  const result = buildDialogueSketchSpeakerContext({
    entityId: "character-a",
    name: "A",
    raw: {
      voicePatterns: {
        firstPerson: [" 私 ", "私"],
        sentenceEndings: ["ます"],
        tone: "淡々としている",
      },
      voice: {
        first_person: [{ name: "僕", reading: "ぼく" }],
        duality: {
          outer: {
            first_person: { name: "わたし" },
            second_person: { form: "あなた", note: "親しい相手" },
            tone: "静かな口調",
            register: "丁寧",
            sentence_endings: [
              { example: "かな", note: "親しい場面" },
              { note: "柔らかい語尾" },
            ],
          },
        },
      },
      voice_profiles: [
        {
          id: "informal",
          context_trigger: { type: "match_metadata", key: "relationship", value: "friend" },
          firstPerson: ["俺"],
          sentenceEndings: ["だよ", "ね"],
        },
        { id: "first-person-only", firstPerson: ["ぼく"] },
        { id: "invalid", sentenceEndings: [] },
      ],
      notes: {
        lead: [{ type: "paragraph", text: "人物概要" }],
        sections: [
          { heading: "未記入", body: [], children: [] },
          {
            heading: "記入済み",
            body: [{ type: "paragraph", text: "設定メモ" }],
            children: [{ heading: "子の未記入", body: [], children: [] }],
          },
          {
            heading: "分類のみ空",
            body: [{ type: "definitions", items: [{ term: "", description: " " }] }],
            children: [],
          },
          {
            heading: "Meta",
            body: [{ type: "paragraph", text: "同ディレクトリの voice.yaml を参照" }],
            children: [],
          },
        ],
      },
    },
    speakerDialogues: {
      characterId: "character-a",
      count: 9,
      minConfidence: "high",
      lines: [
        { text: "old", sceneId: "s0", sceneName: "S0", sentenceIndex: 1, confidence: "high", reason: "rule" },
        { text: "ignore-low", sceneId: "s1", sceneName: "S1", sentenceIndex: 1, confidence: "low", reason: "rule" },
        ...Array.from({ length: 7 }, (_, index) => ({
          text: `high-${index + 1}`,
          sceneId: `s${index + 1}`,
          sceneName: `S${index + 1}`,
          sentenceIndex: index + 1,
          confidence: "high" as const,
          reason: "preceding-narration",
        })),
      ],
    },
    speakerProfiles: { fingerprints: [fingerprint("other-character"), fingerprint("character-a")] },
  });

  assert.deepEqual(result, {
    entityId: "character-a",
    name: "A",
    voiceProfileExcerpt: [
      "一人称: 私、俺、ぼく、僕、わたし",
      "口調: 静かな口調",
      "語尾（登録）: ます",
      "二人称: あなた / 親しい相手",
      "語尾例: かな（親しい場面） / 柔らかい語尾",
      "文体: 丁寧",
      "状況別プロファイル:",
      "- [informal / relationship=friend] 語尾=だよ、ね",
    ].join("\n"),
    fingerprintSummary: {
      entityId: "character-a",
      dialogueCount: 23,
      topFirstPersons: ["a", "z", "middle"],
      topEndings: ["だよ", "ですね"],
      politeRatio: 0.35,
      avgDialogueLength: 18.6,
      exclamationRate: 0.1,
      questionRate: 0.2,
    },
    notesExcerpt: "人物概要\n# 未記入\n# 記入済み\n設定メモ\n# 分類のみ空\n# Meta",
    exampleDialogues: ["high-2", "high-3", "high-4", "high-5", "high-6", "high-7"],
    blankHeadings: ["未記入", "子の未記入", "分類のみ空"],
  });
});

test("supports missing public speaker data and rejects data for a different character", () => {
  const result = buildDialogueSketchSpeakerContext({
    entityId: "character-a",
    raw: {},
    speakerDialogues: {
      characterId: "character-b",
      count: 1,
      minConfidence: "high",
      lines: [{ text: "wrong speaker", sceneId: "s1", sceneName: "S1", sentenceIndex: 1, confidence: "high", reason: "rule" }],
    },
    speakerProfiles: { fingerprints: [fingerprint("character-b")] },
  });

  assert.deepEqual(result, {
    entityId: "character-a",
    name: "character-a",
    voiceProfileExcerpt: null,
    fingerprintSummary: null,
    notesExcerpt: null,
    exampleDialogues: [],
    blankHeadings: [],
  });
});

test("clips voice and notes excerpts to source bounds and accepts legacy notes", () => {
  const large = "x".repeat(1_300);
  const result = buildDialogueSketchSpeakerContext({
    entityId: "character-a",
    raw: {
      voicePatterns: { tone: large },
      notes: {
        lead: `${large}\n\n- 秘密: omitted from paragraph excerpt`,
        sections: [{ heading: "旧形式", body: [{ text: "旧形式ノート" }], children: [] }],
      },
    },
  });

  assert.equal(result.voiceProfileExcerpt?.length, 1_200);
  assert.ok(result.voiceProfileExcerpt?.endsWith("…"));
  assert.equal(result.notesExcerpt?.length, 801);
  assert.ok(result.notesExcerpt?.endsWith("…"));
  assert.deepEqual(result.blankHeadings, []);
});
