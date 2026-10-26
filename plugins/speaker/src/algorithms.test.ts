import assert from "node:assert/strict";
import test from "node:test";
import {
  applySpeakerOverridesDetailed,
  attributeSpeakers,
  applyGatesToAttributions,
  buildMentionDictionary,
  computeSpeakerRuleGates,
  hashDialogueText,
  runSpeakerPipeline,
  splitIntoSentenceOffsets,
  type Entity,
  type Token,
} from "./index.js";

const taro: Entity = { id: "char-taro", type: "character", name: "太郎", aliases: ["太郎くん"], raw: {} };
const hanako: Entity = { id: "char-hanako", type: "character", name: "花子", raw: {} };

function tokenizerFor(text: string): Token[] {
  const result: Token[] = [];
  let offset = 0;
  for (const surface of Array.from(text)) {
    const start = offset;
    offset += surface.length;
    const particle = new Set(["は", "が", "を", "に", "へ", "と", "の", "も", "で", "から", "まで"]).has(surface);
    result.push({
      surface,
      pos: particle ? "助詞" : "名詞",
      ...(particle ? { posDetail: ["格助詞"] } : {}),
      baseForm: surface,
      start,
      end: offset,
    });
  }
  return result;
}

function cacheAllTextWithDeterministicTokenizer(): Record<string, Token[]> {
  return new Proxy({}, {
    get(_target, key) {
      if (typeof key !== "string") return undefined;
      return tokenizerFor(key);
    },
  }) as Record<string, Token[]>;
}

test("Japanese dialogue attribution keeps source text and reserves high confidence for calibrated evidence", () => {
  const entities = new Map([[taro.id, taro], [hanako.id, hanako]]);
  const mentions = buildMentionDictionary(entities);
  const rows = attributeSpeakers("太郎は壁の向こうを見た。「誰かいるのか。」", [taro, hanako], mentions);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.text, "「誰かいるのか。」");
  assert.equal(rows[0]?.speakerEntityId, taro.id);
  assert.equal(rows[0]?.reason, "preceding-narration");
  assert.equal(rows[0]?.confidence, "high");

  const unresolved = attributeSpeakers("「誰かいるのか。」", [taro, hanako], mentions);
  assert.equal(unresolved[0]?.speakerEntityId, null);
  assert.equal(unresolved[0]?.reason, "none");
  assert.equal(unresolved[0]?.confidence, "none");
});

test("source sentence offsets use UTF-16 indices and keep original Japanese text", () => {
  const text = "😀太郎は言った。「行こう。」";
  const offsets = splitIntoSentenceOffsets(text);
  const quoteIndex = text.indexOf("「");
  const quote = offsets.find(({ start, end }) => text.slice(start, end).startsWith("「"));

  assert.ok(quote);
  assert.equal(quote.start, quoteIndex);
  assert.equal(text.slice(quote.start, quote.end), "「行こう。」");
  assert.equal(quote.start, 9);
});

test("a unique line hash reanchors after insertion, while duplicate text stays stale", () => {
  const shifted = [{
    sentenceIndex: 2,
    text: "「別の文。」",
    speakerEntityId: null,
    speakerGroupId: "cluster-1",
    reason: "none" as const,
    confidence: "none" as const,
  }];
  const override = {
    sentenceIndex: 1,
    textHash: hashDialogueText("「別の文。」"),
    dialogueText: "「別の文。」",
    speakerEntityId: null,
    source: "direct" as const,
  };
  const unique = applySpeakerOverridesDetailed(shifted, [override]);
  assert.equal(unique.staleOverrides.length, 0);
  assert.equal(unique.attributions[0]?.reason, "manual-override");
  assert.equal(unique.attributions[0]?.confidence, "none");
  assert.equal(unique.attributions[0]?.speakerGroupId, "cluster-1");

  const duplicateRows = [
    { ...shifted[0]!, sentenceIndex: 2 },
    { ...shifted[0]!, sentenceIndex: 3 },
  ];
  const ambiguous = applySpeakerOverridesDetailed(duplicateRows, [override]);
  assert.equal(ambiguous.staleOverrides.length, 1);
  assert.ok(ambiguous.attributions.every((row) => row.reason === "none"));
});

test("same pinned scene and text produce deterministic clusters and preserve manual unknown", () => {
  const text = "太郎は目を向けた。「行こう。」花子はうなずいた。「うん。」";
  const scene: Entity = {
    id: "scene-1",
    type: "scene",
    raw: { appears: [taro.id, hanako.id] },
  };
  const run = () => runSpeakerPipeline({
    scene,
    text,
    entities: [scene, taro, hanako],
    candidates: [taro, hanako],
    tokenCache: cacheAllTextWithDeterministicTokenizer(),
  });
  const first = run();
  const second = run();
  assert.deepEqual(first, second);
  assert.equal(first.attributions.length, 2);
  assert.ok(first.attributions.every((row) => row.speakerGroupId !== null));

  const unknownScene = { ...scene, raw: {
    ...scene.raw,
    speakerOverrides: [{
      sentenceIndex: 4,
      dialogueText: "「うん。」",
      textHash: hashDialogueText("「うん。」"),
      speakerEntityId: null,
      source: "direct",
    }],
  } };
  const withUnknown = runSpeakerPipeline({
    scene: unknownScene,
    text,
    entities: [unknownScene, taro, hanako],
    candidates: [taro, hanako],
    tokenCache: cacheAllTextWithDeterministicTokenizer(),
  });
  const confirmedUnknown = withUnknown.attributions.find((row) => row.sentenceIndex === 4);
  assert.equal(confirmedUnknown?.speakerEntityId, null);
  assert.equal(confirmedUnknown?.reason, "manual-override");
  assert.equal(confirmedUnknown?.confidence, "none");
});

test("dialogue hashes remain lowercase eight-digit UTF-16 FNV-1a values", () => {
  assert.match(hashDialogueText("「😀」"), /^[0-9a-f]{8}$/u);
  assert.equal(hashDialogueText("「声。」"), hashDialogueText("「声。」"));
});

test("rule gates enforce sample and precision boundaries without changing manual confirmations", () => {
  const gates = computeSpeakerRuleGates({
      insufficient: { fired: 19, correct: 0 },
      "preceding-narration": { fired: 20, correct: 5 },
      "attribution-verb": { fired: 20, correct: 6 },
      "alternating-turn": { fired: 20, correct: 8 },
      boundary: { fired: 20, correct: 12 },
  });
  assert.deepEqual(gates.gates, {
    "preceding-narration": { action: "disable", measuredPrecision: 0.25, sampleSize: 20 },
    "attribution-verb": { action: "demote", measuredPrecision: 0.3, sampleSize: 20 },
    "alternating-turn": { action: "demote", measuredPrecision: 0.4, sampleSize: 20 },
  });

  const manual = {
    sentenceIndex: 1, text: "「手で確定。」", speakerEntityId: taro.id,
    speakerGroupId: "cluster-1", reason: "manual-override" as const, confidence: "high" as const,
  };
  const automatic = {
    sentenceIndex: 2, text: "「自動推定。」", speakerEntityId: taro.id,
    speakerGroupId: "cluster-1", reason: "preceding-narration" as const, confidence: "high" as const,
  };
  const gated = applyGatesToAttributions([manual, automatic], gates);
  assert.equal(gated[0]?.speakerEntityId, taro.id);
  assert.equal(gated[0]?.confidence, "high");
  assert.equal(gated[1]?.speakerEntityId, null);
  assert.equal(gated[1]?.confidence, "none");
});
