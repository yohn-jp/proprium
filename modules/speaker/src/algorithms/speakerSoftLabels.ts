import type { SpeakerAttribution } from "./speakerAttribution.js";

const CONFIDENCE_RANK: Record<SpeakerAttribution["confidence"], number> = {
  none: 0,
  low: 1,
  high: 2,
};

/**
 * 話者帰属済みセリフをキャラクター（entityId）ごとに集約する。
 * 既定では confidence "high" のみ（学習用の高信頼サンプル）。
 */
export function aggregateDialoguesBySpeaker(
  attributions: SpeakerAttribution[],
  options?: { minConfidence?: "high" | "low" },
): Map<string, string[]> {
  const minRank = CONFIDENCE_RANK[options?.minConfidence ?? "high"];
  const bySpeaker = new Map<string, string[]>();
  for (const attr of attributions) {
    if (attr.speakerEntityId === null) continue;
    if (CONFIDENCE_RANK[attr.confidence] < minRank) continue;
    const list = bySpeaker.get(attr.speakerEntityId) ?? [];
    list.push(attr.text);
    bySpeaker.set(attr.speakerEntityId, list);
  }
  return bySpeaker;
}

/** 複数シーン分のキャラ別セリフ Map をマージする（順序は呼び出し順を維持）。 */
export function mergeDialogueMaps(maps: Iterable<Map<string, string[]>>): Map<string, string[]> {
  const merged = new Map<string, string[]>();
  for (const map of maps) {
    for (const [entityId, dialogues] of map) {
      const list = merged.get(entityId) ?? [];
      list.push(...dialogues);
      merged.set(entityId, list);
    }
  }
  return merged;
}

/**
 * 手動確定または confidence high の行だけを「既知話者」とみなす。
 * low は仮説であり、N の下限にもパーティションの硬いアンカーにも使わない。
 */
export function isHardSpeakerAnchor(attribution: SpeakerAttribution): boolean {
  return attribution.speakerEntityId !== null && attribution.confidence === "high";
}

/** 既知話者（手動＋high）のユニーク数 L。 */
export function countKnownSpeakers(attributions: SpeakerAttribution[]): number {
  const ids = new Set<string>();
  for (const attribution of attributions) {
    if (attribution.speakerEntityId !== null && attribution.confidence === "high") {
      ids.add(attribution.speakerEntityId);
    }
  }
  return ids.size;
}

export interface SoftSpeakerLabel {
  sentenceIndex: number;
  speakerEntityId: string;
  reason: SpeakerAttribution["reason"];
  confidence: "low";
}

/**
 * low 確度の entity を分割前に外す。仮説をクラスタキーにしないため。
 * 分割後に {@link reattachSoftSpeakerLabels} で、衝突しない行へだけ戻す。
 */
export function detachSoftSpeakerLabels(attributions: SpeakerAttribution[]): {
  attributions: SpeakerAttribution[];
  soft: SoftSpeakerLabel[];
} {
  const soft: SoftSpeakerLabel[] = [];
  const next = attributions.map((attribution) => {
    if (attribution.speakerEntityId !== null && attribution.confidence === "low") {
      soft.push({
        sentenceIndex: attribution.sentenceIndex,
        speakerEntityId: attribution.speakerEntityId,
        reason: attribution.reason,
        confidence: "low",
      });
      return {
        ...attribution,
        speakerEntityId: null,
        reason: "none" as const,
        confidence: "none" as const,
      };
    }
    return { ...attribution };
  });
  return { attributions: next, soft };
}

/**
 * 分割結果へ low ラベルを戻す。既に entity がある行、または同一クラスタに別キャラが
 * 居る行には付けない。
 *
 * 衝突判定は confidence に依らない（`strong-hint`/low など promote 済み entity も
 * 同クラスタの soft 再付与をブロックする）。
 */
export function reattachSoftSpeakerLabels(
  attributions: SpeakerAttribution[],
  soft: SoftSpeakerLabel[],
): SpeakerAttribution[] {
  if (soft.length === 0) return attributions;

  const softByIndex = new Map(soft.map((label) => [label.sentenceIndex, label]));
  const entityByGroup = new Map<string, string>();
  for (const attribution of attributions) {
    if (attribution.speakerEntityId !== null && attribution.speakerGroupId !== null) {
      entityByGroup.set(attribution.speakerGroupId, attribution.speakerEntityId);
    }
  }

  return attributions.map((attribution) => {
    const label = softByIndex.get(attribution.sentenceIndex);
    if (!label || attribution.speakerEntityId !== null) return attribution;

    const groupId = attribution.speakerGroupId;
    if (groupId !== null) {
      const existing = entityByGroup.get(groupId);
      if (existing !== undefined && existing !== label.speakerEntityId) return attribution;
      entityByGroup.set(groupId, label.speakerEntityId);
    }

    return {
      ...attribution,
      speakerEntityId: label.speakerEntityId,
      reason: label.reason,
      confidence: label.confidence,
    };
  });
}

/**
 * フルパイプライン後の話者クラスタ不変条件を検証する。
 * - 全 attribution が non-null speakerGroupId
 * - 同一 speakerGroupId につき non-null speakerEntityId は高々1種
 * - 同一 speakerEntityId は高々1つの speakerGroupId（1キャラ≤1クラスタ）
 * - distinct group ID 数 === n
 */
export function assertSpeakerClusterInvariants(
  attributions: SpeakerAttribution[],
  n: number,
): void {
  if (attributions.length === 0) {
    if (n !== 0) {
      throw new Error(`expected ${n} speaker groups but found 0 attributions`);
    }
    return;
  }

  for (const attribution of attributions) {
    if (attribution.speakerGroupId === null) {
      throw new Error(`speakerGroupId is null at sentenceIndex=${attribution.sentenceIndex}`);
    }
  }

  const entityByGroup = new Map<string, string | null>();
  const groupByEntity = new Map<string, string>();
  for (const attribution of attributions) {
    const groupId = attribution.speakerGroupId;
    if (groupId === null) continue;
    const existing = entityByGroup.get(groupId);
    if (existing === undefined) {
      entityByGroup.set(groupId, attribution.speakerEntityId);
    } else if (
      attribution.speakerEntityId !== null &&
      existing !== null &&
      attribution.speakerEntityId !== existing
    ) {
      throw new Error(
        `group ${groupId} has conflicting speakerEntityIds: ${existing} vs ${attribution.speakerEntityId}`,
      );
    } else if (existing === null && attribution.speakerEntityId !== null) {
      entityByGroup.set(groupId, attribution.speakerEntityId);
    }

    if (attribution.speakerEntityId !== null) {
      const priorGroup = groupByEntity.get(attribution.speakerEntityId);
      if (priorGroup !== undefined && priorGroup !== groupId) {
        throw new Error(
          `entity ${attribution.speakerEntityId} spans groups ${priorGroup} and ${groupId}`,
        );
      }
      groupByEntity.set(attribution.speakerEntityId, groupId);
    }
  }

  if (entityByGroup.size !== n) {
    throw new Error(
      `expected ${n} distinct speakerGroupIds but found ${entityByGroup.size}: ${[...entityByGroup.keys()].join(", ")}`,
    );
  }
}
