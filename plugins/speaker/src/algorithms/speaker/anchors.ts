import type { ClusterTrailCollector } from "../clusterAssignmentTrail.js";
import type { SpeakerAttribution } from "../speakerAttribution.js";
import { removeDialogueBrackets } from "../styleFingerprint.js";
import { splitIntoSentences } from "../textAnalysis.js";
import type { Entity } from "../types.js";
import { narrationBetween, nextDialogueIndex, previousDialogueIndex } from "./features.js";
import type { DialogueRecord } from "./types.js";
import { ATTRIBUTION_VERB_RE, BACK_REFERENCE_RE, STRICT_DIALOGUE_RE } from "./types.js";

/**
 * 強ヒント（名前＋発話動詞）で本文に現れる appears 内 entity のユニーク数 U。
 * `partitionDialoguesIntoN` / `clusterUnattributedDialogues` と同じ findStrongEntity 判定を使う。
 */
export function countUniqueStrongHintEntities(
  text: string,
  appearsEntities: readonly Entity[],
): number {
  const candidates = appearsEntities.filter((entity) => entity.type === "character");
  if (candidates.length === 0 || text.length === 0) return 0;

  const sentences = splitIntoSentences(text);
  const dialogueIndexes: number[] = [];
  for (let i = 0; i < sentences.length; i++) {
    if (STRICT_DIALOGUE_RE.test(sentences[i])) dialogueIndexes.push(i);
  }
  if (dialogueIndexes.length === 0) {
    // セリフが無くても地の文の強ヒントを拾う（推定の下限用）
    const ids = new Set<string>();
    const joined = sentences.join("");
    for (const backwardOnly of [false, true]) {
      const id = findStrongEntity(joined, candidates, backwardOnly);
      if (id) ids.add(id);
    }
    return ids.size;
  }

  const ids = new Set<string>();
  for (let d = 0; d < dialogueIndexes.length; d++) {
    const sentenceIndex = dialogueIndexes[d];
    const prevDialogue =
      d > 0 ? dialogueIndexes[d - 1] : previousDialogueIndex(sentences, sentenceIndex);
    const nextDialogue =
      d + 1 < dialogueIndexes.length
        ? dialogueIndexes[d + 1]
        : nextDialogueIndex(sentences, sentenceIndex);
    const narrationBefore = narrationBetween(sentences, prevDialogue, sentenceIndex);
    const narrationAfter = narrationBetween(sentences, sentenceIndex, nextDialogue);
    for (const backwardOnly of [false, true]) {
      const before = findStrongEntity(narrationBefore, candidates, backwardOnly);
      if (before) ids.add(before);
    }
    if (d === dialogueIndexes.length - 1) {
      for (const backwardOnly of [false, true]) {
        const after = findStrongEntity(narrationAfter, candidates, backwardOnly);
        if (after) ids.add(after);
      }
    }
  }
  return ids.size;
}

/**
 * パーティションの硬い entity アンカーにするか。
 * high（手動含む）は常にアンカー。low は仮説なので除外。
 * confidence none だが entity 付き（声紋ラベル等）は既に分割上の同一性制約なのでアンカーにする。
 */
function isPartitionEntityAnchor(attribution: SpeakerAttribution): boolean {
  if (attribution.speakerEntityId === null) return false;
  return attribution.confidence !== "low";
}

export function applyEntityAnchors(records: DialogueRecord[], result: SpeakerAttribution[]): void {
  const entityToKey = new Map<string, string>();
  for (const record of records) {
    const attribution = result[record.attributionIndex];
    const entityId = isPartitionEntityAnchor(attribution)
      ? attribution.speakerEntityId
      : record.strongEntityId;
    if (entityId === null) continue;
    const existing = entityToKey.get(entityId);
    if (existing) {
      record.key = existing;
      continue;
    }
    const key = record.key?.startsWith("entity:") ? record.key : `entity:${entityId}`;
    entityToKey.set(entityId, key);
    record.key = key;
  }

  // 同一 hard speakerEntityId は必ず同一キーへ寄せる
  for (const record of records) {
    const attribution = result[record.attributionIndex];
    if (!isPartitionEntityAnchor(attribution)) continue;
    const entityId = attribution.speakerEntityId;
    if (entityId === null) continue;
    record.key = entityToKey.get(entityId) ?? `entity:${entityId}`;
    record.provisional = false;
  }
}

/**
 * 分割中に強ヒント entity を null 話者へ埋める。
 * クラスタ同一性には有用だが規則A（attribution-verb）ではないため、
 * reason は `strong-hint`、confidence は `low` のみ（high 汚染を防ぐ）。
 */
export function promoteStrongHintEntities(
  records: DialogueRecord[],
  result: SpeakerAttribution[],
  candidates: Entity[],
  trail?: ClusterTrailCollector,
): void {
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  for (const record of records) {
    const attribution = result[record.attributionIndex];
    if (attribution.speakerEntityId !== null) continue;
    const entityId = record.strongEntityId ?? keyEntityId(record.key ?? "");
    if (!entityId || !candidateIds.has(entityId)) continue;
    attribution.speakerEntityId = entityId;
    if (attribution.reason === "none") {
      attribution.reason = "strong-hint";
      attribution.confidence = "low";
    }
    trail?.push(result[record.attributionIndex].sentenceIndex, {
      code: "promote-strong-hint",
      detail: entityId,
    });
  }
}

export function keyEntityId(key: string): string | null {
  return key.startsWith("entity:") ? key.slice("entity:".length) : null;
}

function entityTerms(entity: Entity): string[] {
  const rawTitles = Array.isArray(entity.raw.titles)
    ? entity.raw.titles.filter((value): value is string => typeof value === "string")
    : [];
  return [entity.name, ...(entity.aliases ?? []), ...rawTitles].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

export function nearestMention(text: string, candidates: Entity[]): Entity | null {
  let best: { entity: Entity; index: number } | null = null;
  for (const entity of candidates) {
    for (const term of entityTerms(entity)) {
      const index = text.lastIndexOf(term);
      if (index >= 0 && (best === null || index > best.index)) best = { entity, index };
    }
  }
  return best?.entity ?? null;
}

export function findStrongEntity(
  narration: string,
  candidates: Entity[],
  backwardOnly: boolean,
): string | null {
  if (!ATTRIBUTION_VERB_RE.test(narration)) return null;
  const backward = BACK_REFERENCE_RE.test(narration);
  if (backwardOnly !== backward) return null;
  return nearestMention(narration, candidates)?.id ?? null;
}

export function findVocativeEntity(dialogue: string, candidates: Entity[]): string | null {
  const content = removeDialogueBrackets(dialogue).trim();
  if (/(?:と申します|といいます|と名乗|私の名は|我が名は|名付け|名乗るがよい)/.test(content)) {
    return null;
  }
  const prefix = content.split(/[、。！？!?]/, 1)[0].trim();
  if (prefix.length === 0 || /(?:は|って|という)$/.test(prefix)) return null;

  for (const entity of candidates) {
    for (const term of entityTerms(entity)) {
      const addressed =
        prefix === term ||
        prefix === `${term}さん` ||
        prefix === `${term}様` ||
        prefix === `${term}殿` ||
        prefix.endsWith(term);
      if (addressed) return entity.id;
    }
  }
  // 発話全体が未知の名前らしい語だけなら呼びかけとして扱わない。
  if (!/[、。！？!?]/.test(content) && /^[\p{L}\p{N}ー・]+$/u.test(content)) return null;
  return null;
}
