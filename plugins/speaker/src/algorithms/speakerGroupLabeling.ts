import {
  computeDialogueMetricsFromText,
  computeStyleDistance,
  DEVIATION_DISTANCE_THRESHOLD,
  MIN_DIALOGUE_FOR_DEVIATION_CHECK,
  type StylometricProfile,
} from "./stylometryCompat.js";
import type { Tokenizer } from "../nlp/types.js";
import type { SpeakerAttribution } from "./speakerAttribution.js";

interface NearestProfile {
  entityId: string;
  distance: number;
}

function findNearestProfile(
  attribution: SpeakerAttribution,
  profiles: StylometricProfile[],
  tokenizer: Tokenizer,
): NearestProfile {
  const metrics = computeDialogueMetricsFromText(attribution.text, (text) =>
    tokenizer.tokenize(text),
  );
  let nearest = profiles[0];
  let distance = computeStyleDistance(metrics, nearest);

  for (let i = 1; i < profiles.length; i++) {
    const candidateDistance = computeStyleDistance(metrics, profiles[i]);
    if (candidateDistance < distance) {
      nearest = profiles[i];
      distance = candidateDistance;
    }
  }

  return { entityId: nearest.entityId, distance };
}

function nextClusterGroupId(usedGroupIds: Set<string>, nextNumber: { value: number }): string {
  let candidate: string;
  do {
    candidate = `cluster-${nextNumber.value++}`;
  } while (usedGroupIds.has(candidate));
  usedGroupIds.add(candidate);
  return candidate;
}

/**
 * 話者グループを既存の声紋と照合してラベリングする。
 * 呼び出し前に解析パイプラインの共通トークナイザを初期化しておく必要がある。
 * `candidateEntityIds` を渡すと、appears/シーン候補に含まれる声紋だけを最近傍探索の対象にする。
 */
export function labelGroupsByVoiceprint(
  attributions: SpeakerAttribution[],
  profiles: StylometricProfile[],
  tokenizer?: Tokenizer,
  candidateEntityIds?: ReadonlySet<string> | string[],
): SpeakerAttribution[] {
  const result = attributions.map((attribution) => ({ ...attribution }));
  const candidateSet =
    candidateEntityIds === undefined
      ? null
      : candidateEntityIds instanceof Set
        ? candidateEntityIds
        : new Set(candidateEntityIds);
  const eligibleProfiles = profiles.filter((profile) => {
    if (profile.dialogueCount < MIN_DIALOGUE_FOR_DEVIATION_CHECK) return false;
    if (candidateSet && !candidateSet.has(profile.entityId)) return false;
    return true;
  });
  if (eligibleProfiles.length === 0) return result;
  const resolvedTokenizer = tokenizer;
  if (!resolvedTokenizer) {
    throw new Error(
      "labelGroupsByVoiceprint requires an explicit tokenizer or getTokenizer() initialization",
    );
  }

  const groupIndices = new Map<string, number[]>();
  for (let index = 0; index < attributions.length; index++) {
    const attribution = attributions[index];
    if (attribution.speakerGroupId === null || attribution.speakerEntityId !== null) continue;
    const indices = groupIndices.get(attribution.speakerGroupId) ?? [];
    indices.push(index);
    groupIndices.set(attribution.speakerGroupId, indices);
  }

  const usedGroupIds = new Set(
    attributions.flatMap((attribution) =>
      attribution.speakerGroupId === null ? [] : [attribution.speakerGroupId],
    ),
  );
  const maxClusterNumber = Math.max(
    0,
    ...[...usedGroupIds].map((groupId) => {
      const match = /^(?:cluster|unnamed)-(\d+)$/.exec(groupId);
      return match ? Number(match[1]) : 0;
    }),
  );
  const nextNumber = { value: maxClusterNumber + 1 };

  for (const [originalGroupId, indices] of groupIndices) {
    const matches = indices.map((index) =>
      findNearestProfile(attributions[index], eligibleProfiles, resolvedTokenizer),
    );
    const acceptedEntityIds = matches.map((match) =>
      match.distance <= DEVIATION_DISTANCE_THRESHOLD ? match.entityId : null,
    );

    if (acceptedEntityIds.every((entityId) => entityId === null)) continue;

    const firstEntityId = acceptedEntityIds[0];
    if (
      firstEntityId !== null &&
      acceptedEntityIds.every((entityId) => entityId === firstEntityId)
    ) {
      // 既に他クラスタが同じ entity を持っていればそちらへ合流する
      const existingGroup = result.find(
        (attribution) =>
          attribution.speakerEntityId === firstEntityId &&
          attribution.speakerGroupId !== null &&
          attribution.speakerGroupId !== originalGroupId,
      )?.speakerGroupId;
      const targetGroupId = existingGroup ?? originalGroupId;
      for (const index of indices) {
        result[index].speakerEntityId = firstEntityId;
        result[index].speakerGroupId = targetGroupId;
      }
      continue;
    }

    const groupIdByEntity = new Map<string | null, string>();
    for (let i = 0; i < indices.length; i++) {
      const entityId = acceptedEntityIds[i];
      let groupId = groupIdByEntity.get(entityId);
      if (groupId === undefined) {
        groupId =
          groupIdByEntity.size === 0
            ? originalGroupId
            : nextClusterGroupId(usedGroupIds, nextNumber);
        groupIdByEntity.set(entityId, groupId);
      }
      result[indices[i]].speakerGroupId = groupId;
      result[indices[i]].speakerEntityId = entityId;
    }
  }

  return result;
}
