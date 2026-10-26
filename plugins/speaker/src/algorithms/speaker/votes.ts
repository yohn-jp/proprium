import type { Entity } from "../types.js";
import { nearestMention } from "./anchors.js";
import type { DialogueRecord } from "./types.js";
import { PERCEPTION_RE, REPETITION_RE, UNNAMED_ANCHOR_RE } from "./types.js";

export function collectWeakVotes(
  records: DialogueRecord[],
  candidates: Entity[],
): Map<string, Map<string, number>> {
  const votes = new Map<string, Map<string, number>>();
  for (const record of records) {
    if (!record.key) continue;
    const narration = `${record.narrationBefore}${record.narrationAfter}`;
    if (PERCEPTION_RE.test(narration)) continue;
    const entity = nearestMention(narration, candidates);
    const tags = [
      entity?.id,
      UNNAMED_ANCHOR_RE.test(narration) ? "unnamed-anchor" : undefined,
      REPETITION_RE.test(narration) ? "montage" : undefined,
      record.features.openingMark ? "opening-mark" : undefined,
    ].filter((tag): tag is string => tag !== undefined);
    if (tags.length === 0) continue;
    const groupVotes = votes.get(record.key) ?? new Map<string, number>();
    for (const tag of tags) groupVotes.set(tag, (groupVotes.get(tag) ?? 0) + 1);
    votes.set(record.key, groupVotes);
  }
  return votes;
}

export function applyWeakEntityVoteMerges(
  records: DialogueRecord[],
  votes: Map<string, Map<string, number>>,
  candidates: Entity[],
): void {
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const replacements = new Map<string, string>();
  for (const [groupKey, groupVotes] of votes) {
    const ranked = [...groupVotes.entries()]
      .filter(([tag]) => candidateIds.has(tag))
      .sort((left, right) => right[1] - left[1]);
    // 単独の弱ヒントでは交代判定を覆さない。2票以上かつ首位が一意のときだけ、
    // 統合フェーズで同名の強タグ群へ寄せる。
    if (ranked.length === 0 || ranked[0][1] < 2) continue;
    if (ranked[1]?.[1] === ranked[0][1]) continue;
    replacements.set(groupKey, `entity:${ranked[0][0]}`);
  }
  for (const record of records) {
    if (record.key) record.key = replacements.get(record.key) ?? record.key;
  }
}
