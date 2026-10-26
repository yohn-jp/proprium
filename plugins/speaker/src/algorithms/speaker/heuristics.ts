import type { Tokenizer } from "../../nlp/types.js";
import type { SpeakerAttribution } from "../speakerAttribution.js";
import { removeDialogueBrackets } from "../styleFingerprint.js";
import type { Entity } from "../types.js";
import type { VoiceProfile } from "../voice/index.js";
import { findStrongEntity, findVocativeEntity } from "./anchors.js";
import { groupEntityId } from "./assign.js";
import { applySceneLocalFingerprint, buildRecords, voiceMismatch } from "./features.js";
import type { DialogueRecord } from "./types.js";
import { IMPERATIVE_RE, QUESTION_RE, SCENE_BREAK_RE } from "./types.js";
import { applyWeakEntityVoteMerges, collectWeakVotes } from "./votes.js";

export function alternateAmongN(
  previousKey: string | null,
  slotKeys: string[],
  records: DialogueRecord[],
  index: number,
  segmentStart: number,
): string {
  if (previousKey !== null) {
    const slotIndex = slotKeys.indexOf(previousKey);
    if (slotIndex >= 0) {
      return slotKeys[(slotIndex + 1) % slotKeys.length];
    }
    for (let i = index - 2; i >= segmentStart; i--) {
      const key = records[i].key;
      if (records[i].eligible && key !== null && key !== previousKey) return key;
    }
    const nextSlot = slotKeys.find((slot) => slot !== previousKey);
    if (nextSlot) return nextSlot;
  }
  const used = new Set(
    records
      .slice(0, index)
      .map((record) => record.key)
      .filter((key): key is string => key !== null),
  );
  for (const slot of slotKeys) {
    if (!used.has(slot)) return slot;
  }
  return slotKeys[0];
}

/** N>=2 の交代: 直前が entity で候補が揃うなら相手側へ。否则 slot 交互。 */
export function flipSpeakerKey(
  previousKey: string | null,
  candidates: Entity[],
  n: number,
  slotKeys: string[],
  records: DialogueRecord[],
  index: number,
  segmentStart: number,
  freshKey: () => string,
): string {
  if (previousKey?.startsWith("entity:") && candidates.length >= 2 && n >= 2) {
    const previousEntity = previousKey.slice("entity:".length);
    if (n === 2 || candidates.length === 2) {
      const other = candidates.find((candidate) => candidate.id !== previousEntity);
      if (other) return `entity:${other.id}`;
    }
    const others = candidates.filter((candidate) => candidate.id !== previousEntity);
    if (others.length > 0) {
      for (let i = index - 2; i >= segmentStart; i--) {
        const key = records[i].key;
        if (!key?.startsWith("entity:")) continue;
        const entityId = key.slice("entity:".length);
        if (entityId !== previousEntity && others.some((candidate) => candidate.id === entityId)) {
          return key;
        }
      }
      return `entity:${others[0].id}`;
    }
  }
  return differentKey(previousKey, slotKeys, records, index, segmentStart, freshKey);
}

export function differentKey(
  previousKey: string | null,
  slotKeys: string[],
  records: DialogueRecord[],
  index: number,
  segmentStart: number,
  freshKey: () => string,
): string {
  const alt = alternateAmongN(previousKey, slotKeys, records, index, segmentStart);
  if (alt !== previousKey) return alt;
  for (let i = index - 2; i >= segmentStart; i--) {
    const key = records[i].key;
    if (records[i].eligible && key !== null && key !== previousKey) return key;
  }
  return freshKey();
}

export function assignKeysToIneligible(records: DialogueRecord[], slotKeys: string[]): void {
  let rr = 0;
  let previousKey: string | null = null;
  for (const record of records) {
    if (record.key !== null) {
      previousKey = record.key;
      continue;
    }
    record.key = alternateAmongN(previousKey, slotKeys, records, record.attributionIndex, 0);
    // 上記は records 順序に依存するため、単純ラウンドロビンも併用して安定化
    if (record.key === previousKey && slotKeys.length > 1) {
      record.key = slotKeys[rr % slotKeys.length];
    }
    rr++;
    previousKey = record.key;
  }
}

export function enforceExactlyNKeys(
  records: DialogueRecord[],
  result: SpeakerAttribution[],
  n: number,
  slotKeys: string[],
  freshKey: () => string,
): void {
  const orderedKeys = (): string[] => {
    const seen = new Set<string>();
    const keys: string[] = [];
    for (const record of records) {
      if (record.key === null || seen.has(record.key)) continue;
      seen.add(record.key);
      keys.push(record.key);
    }
    return keys;
  };

  const remap = (from: string, to: string) => {
    for (const record of records) {
      if (record.key === from) record.key = to;
    }
  };

  // 過分割を優先したうえで N まで統合
  while (orderedKeys().length > n) {
    const keys = orderedKeys();
    let bestPair: [string, string] | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let a = 0; a < keys.length; a++) {
      for (let b = a + 1; b < keys.length; b++) {
        const left = keys[a];
        const right = keys[b];
        const leftEntity = groupEntityId(left, records, result);
        const rightEntity = groupEntityId(right, records, result);
        if (leftEntity && rightEntity && leftEntity !== rightEntity) continue;

        const leftRecords = records.filter((record) => record.key === left);
        const rightRecords = records.filter((record) => record.key === right);
        const provisionalPenalty =
          (leftRecords.every((record) => record.provisional) ? 0 : 2) +
          (rightRecords.every((record) => record.provisional) ? 0 : 2);
        const entityPenalty = leftEntity || rightEntity ? 1 : 0;
        const minDist = Math.min(
          ...leftRecords.flatMap((leftRecord) =>
            rightRecords.map((rightRecord) =>
              Math.abs(leftRecord.sentenceIndex - rightRecord.sentenceIndex),
            ),
          ),
        );
        // 連続発話で隣接するキー同士は同一話者にしにくい（交互パターンを壊さない）
        let adjacentTurns = 0;
        for (let i = 1; i < records.length; i++) {
          const prev = records[i - 1].key;
          const curr = records[i].key;
          if ((prev === left && curr === right) || (prev === right && curr === left)) {
            adjacentTurns++;
          }
        }
        const score = minDist + provisionalPenalty * 10 + entityPenalty * 5 + adjacentTurns * 50;
        if (score < bestScore) {
          bestScore = score;
          bestPair = [left, right];
        }
      }
    }

    if (!bestPair) {
      // entity 衝突だけで減らせない場合: 非 entity キーを最も近い entity/slot へ吸収
      const nonEntity = keys.find((key) => groupEntityId(key, records, result) === null);
      const sink =
        keys.find((key) => key !== nonEntity && groupEntityId(key, records, result) !== null) ??
        keys.find((key) => key !== nonEntity) ??
        null;
      if (!nonEntity || !sink) break;
      remap(nonEntity, sink);
      continue;
    }

    const [left, right] = bestPair;
    const leftEntity = groupEntityId(left, records, result);
    const rightEntity = groupEntityId(right, records, result);
    // entity キー側へ寄せる
    if (rightEntity && !leftEntity) remap(left, right);
    else remap(right, left);
  }

  // 不足分は未ラベル行だけを切り離して埋める（同一キャラの分割は禁止）
  while (orderedKeys().length < n) {
    const keys = orderedKeys();
    let donorKey: string | null = null;
    let unlabeledInDonor = 0;
    for (const key of keys) {
      const members = records.filter((record) => record.key === key);
      const unlabeled = members.filter(
        (record) => result[record.attributionIndex].speakerEntityId === null,
      ).length;
      if (unlabeled > unlabeledInDonor && members.length > 1) {
        unlabeledInDonor = unlabeled;
        donorKey = key;
      }
    }
    if (donorKey === null || unlabeledInDonor < 1) break;

    const donorMembers = records.filter((record) => record.key === donorKey);
    const move = [...donorMembers]
      .reverse()
      .find((record) => result[record.attributionIndex].speakerEntityId === null);
    if (!move) break;
    const unused = slotKeys.find((slot) => !keys.includes(slot)) ?? freshKey();
    move.key = unused;
    move.provisional = true;
  }
}

export function findPreviousEligible(
  records: DialogueRecord[],
  index: number,
  segmentStart: number,
): DialogueRecord | null {
  for (let i = index - 1; i >= segmentStart; i--) {
    if (records[i].eligible && records[i].key !== null) return records[i];
  }
  return null;
}

function oppositeKey(
  previousKey: string | null,
  candidates: Entity[],
  records: DialogueRecord[],
  index: number,
  segmentStart: number,
  freshKey: () => string,
): string {
  if (previousKey?.startsWith("entity:") && candidates.length === 2) {
    const previousEntity = previousKey.slice("entity:".length);
    const other = candidates.find((candidate) => candidate.id !== previousEntity);
    if (other) return `entity:${other.id}`;
  }
  for (let i = index - 2; i >= segmentStart; i--) {
    const key = records[i].key;
    if (records[i].eligible && key !== null && key !== previousKey) return key;
  }
  return freshKey();
}

export function isTurnYield(text: string): boolean {
  const content = removeDialogueBrackets(text).trim();
  return QUESTION_RE.test(content) || IMPERATIVE_RE.test(content);
}

/** speakerEntityId === null の要素をシーン内の話者グループへ分類する。 */
export function clusterUnattributedDialogues(
  attributions: SpeakerAttribution[],
  sentences: string[],
  tokenizer: Tokenizer,
  context?: {
    candidateEntities?: Entity[];
    voiceProfiles?: VoiceProfile[];
  },
): SpeakerAttribution[] {
  const result = attributions.map((attribution) => ({ ...attribution }));
  const candidates = (context?.candidateEntities ?? []).filter(
    (entity) => entity.type === "character",
  );
  const twoSpeakerMode = candidates.length === 2;
  const anonymousMode = candidates.length !== 2;
  const records = buildRecords(result, sentences, tokenizer);
  let anonymousKey = 0;
  let segmentStart = 0;

  const freshKey = () => `anon:${++anonymousKey}`;

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record.eligible) continue;

    if (result[record.attributionIndex].speakerEntityId !== null) {
      record.key = `entity:${result[record.attributionIndex].speakerEntityId}`;
      continue;
    }

    const backwardEntity =
      findStrongEntity(record.narrationBefore, candidates, true) ??
      (i === records.length - 1 ? findStrongEntity(record.narrationAfter, candidates, true) : null);
    if (backwardEntity !== null && i > 0) {
      const previous = records[i - 1];
      if (previous.eligible && result[previous.attributionIndex].speakerEntityId === null) {
        previous.key = `entity:${backwardEntity}`;
        previous.strongEntityId = backwardEntity;
        previous.provisional = false;
      }
    }

    // セリフ間の非後方参照タグは次のセリフへの導入、末尾のタグだけは現在の
    // セリフへの後置タグとして扱う。これにより同じ地の文を両側へ適用しない。
    const strongEntity =
      findStrongEntity(record.narrationBefore, candidates, false) ??
      (i === records.length - 1
        ? findStrongEntity(record.narrationAfter, candidates, false)
        : null);
    if (strongEntity !== null) {
      record.key = `entity:${strongEntity}`;
      record.strongEntityId = strongEntity;
      continue;
    }

    if (anonymousMode && SCENE_BREAK_RE.test(record.narrationBefore)) {
      record.key = freshKey();
      record.provisional = false;
      segmentStart = i;
      continue;
    }

    const addressedEntity = findVocativeEntity(record.text, candidates);
    if (twoSpeakerMode && addressedEntity !== null) {
      const speaker = candidates.find((candidate) => candidate.id !== addressedEntity);
      if (speaker) {
        record.key = `entity:${speaker.id}`;
        continue;
      }
    }

    const previous = findPreviousEligible(records, i, segmentStart);
    if (previous && twoSpeakerMode && isTurnYield(previous.text)) {
      record.key = oppositeKey(previous.key, candidates, records, i, segmentStart, freshKey);
      record.provisional = true;
      continue;
    }

    if (
      previous &&
      voiceMismatch(previous.features, record.features, context?.voiceProfiles ?? [])
    ) {
      record.key = oppositeKey(previous.key, candidates, records, i, segmentStart, freshKey);
      record.provisional = true;
      continue;
    }

    record.key = oppositeKey(previous?.key ?? null, candidates, records, i, segmentStart, freshKey);
    record.provisional = true;
  }

  applySceneLocalFingerprint(
    records,
    candidates,
    context?.voiceProfiles ?? [],
    twoSpeakerMode ? 2 : Math.max(candidates.length, 3),
  );

  // 同じ内部タグを一度だけ統合し、公開IDは登場順の unnamed-N に正規化する。
  // 弱ヒント（名前言及・無名アンカー・モンタージュ・冒頭記号）はここでのみ観測し、
  // 単独では既に決めたクラスタを変更しない。
  const weakVotes = collectWeakVotes(records, candidates);
  if (twoSpeakerMode) applyWeakEntityVoteMerges(records, weakVotes, candidates);
  const publicIds = new Map<string, string>();
  // override で既に付いている unnamed-N と衝突しないよう採番を続ける。
  let publicId = Math.max(
    0,
    ...result.map((attribution) => {
      const match = /^unnamed-(\d+)$/.exec(attribution.speakerGroupId ?? "");
      return match ? Number(match[1]) : 0;
    }),
  );
  for (const record of records) {
    const attribution = result[record.attributionIndex];
    // 手動確定行は隣接の手がかりには使うが、新規の公開グループIDは付けない。
    if (
      !record.eligible ||
      attribution.speakerEntityId !== null ||
      attribution.reason === "manual-override" ||
      record.key === null
    ) {
      continue;
    }
    let groupId = publicIds.get(record.key);
    if (!groupId) {
      groupId = `unnamed-${++publicId}`;
      publicIds.set(record.key, groupId);
    }
    attribution.speakerGroupId = groupId;
  }

  return result;
}
