import type { ClusterTrailCollector } from "../clusterAssignmentTrail.js";
import { pushGroupIdChangeEvents } from "../clusterAssignmentTrail.js";
import type { Tokenizer } from "@scriptorium/module-nlp";
import type { SpeakerAttribution } from "../speakerAttribution.js";
import { detachSoftSpeakerLabels, reattachSoftSpeakerLabels } from "../speakerAttribution.js";
import type { Entity } from "../types.js";
import type { VoiceProfile } from "../voice/index.js";
import {
  applyEntityAnchors,
  findStrongEntity,
  findVocativeEntity,
  promoteStrongHintEntities,
} from "./anchors.js";
import {
  assignPublicClusterIds,
  consolidateEntityClusters,
  expandClustersToN,
  fillEmptyClusters,
} from "./assign.js";
import { applySceneLocalFingerprint, buildRecords, voiceMismatch } from "./features.js";
import {
  alternateAmongN,
  assignKeysToIneligible,
  differentKey,
  enforceExactlyNKeys,
  findPreviousEligible,
  flipSpeakerKey,
  isTurnYield,
} from "./heuristics.js";
import type { DialogueRecord, PartitionContext } from "./types.js";
import { SCENE_BREAK_RE, speakerClusterId } from "./types.js";
import { applyWeakEntityVoteMerges, collectWeakVotes } from "./votes.js";

/**
 * 全セリフをちょうど N 個のクラスタへ分割する。
 * sentences + tokenizer があれば既存ヒューリスティックで初期割当し、ちょうど N に merge/split。
 * 欠けていればラウンドロビン stub にフォールバックする。
 */
export function partitionDialoguesIntoN(
  attributions: SpeakerAttribution[],
  n: number,
  context?: PartitionContext,
): SpeakerAttribution[] {
  // low 確度は仮説なので分割中は外し、終わってから衝突しない行へだけ戻す
  const { attributions: hard, soft } = detachSoftSpeakerLabels(attributions);
  const result = hard.map((attribution) => ({ ...attribution }));
  if (result.length === 0 || n <= 0) return reattachSoftSpeakerLabels(result, soft);

  const trail = context?.trailCollector;
  const clusterCount = Math.min(n, result.length);
  const partitioned =
    context?.sentences && context.tokenizer
      ? partitionWithHeuristics(result, clusterCount, context.sentences, context.tokenizer, {
          candidateEntities: context.candidateEntities,
          voiceProfiles: context.voiceProfiles,
          trailCollector: trail,
        })
      : partitionRoundRobinStub(result, clusterCount, trail);
  const beforeConsolidate = partitioned.map((attribution) => ({
    sentenceIndex: attribution.sentenceIndex,
    speakerGroupId: attribution.speakerGroupId,
  }));
  const consolidated = consolidateEntityClusters(reattachSoftSpeakerLabels(partitioned, soft));
  pushGroupIdChangeEvents(trail, beforeConsolidate, consolidated, "consolidate");
  return consolidated;
}

/** sentences/tokenizer 欠落時のフォールバック（WT0 stub 相当）。 */
function partitionRoundRobinStub(
  result: SpeakerAttribution[],
  clusterCount: number,
  trail?: ClusterTrailCollector,
): SpeakerAttribution[] {
  const assignment = new Array<string | null>(result.length).fill(null);

  const entityToCluster = new Map<string, string>();
  const hardEntityIds: string[] = [];
  for (let i = 0; i < result.length; i++) {
    const attribution = result[i];
    // low 確度は仮説なので stub でも硬いアンカーにしない
    if (attribution.speakerEntityId === null || attribution.confidence === "low") continue;
    if (!hardEntityIds.includes(attribution.speakerEntityId)) {
      hardEntityIds.push(attribution.speakerEntityId);
    }
  }
  const effectiveCount = Math.max(clusterCount, hardEntityIds.length);
  const effectiveIds = Array.from({ length: effectiveCount }, (_, i) => speakerClusterId(i + 1));

  for (let i = 0; i < result.length; i++) {
    const attribution = result[i];
    if (attribution.speakerEntityId === null || attribution.confidence === "low") continue;
    const entityId = attribution.speakerEntityId;
    let groupId = entityToCluster.get(entityId);
    if (!groupId) {
      groupId = effectiveIds[entityToCluster.size];
      entityToCluster.set(entityId, groupId);
    }
    assignment[i] = groupId;
    trail?.push(attribution.sentenceIndex, {
      code: "partition-key",
      detail: `entity:${entityId}`,
    });
  }

  let rr = 0;
  for (let i = 0; i < result.length; i++) {
    if (assignment[i] !== null) continue;
    assignment[i] = effectiveIds[rr % effectiveCount];
    rr++;
    trail?.push(result[i].sentenceIndex, {
      code: "partition-key",
      detail: `stub:${assignment[i]}`,
    });
  }

  fillEmptyClusters(result, assignment, effectiveIds, entityToCluster);

  for (let i = 0; i < result.length; i++) {
    result[i].speakerGroupId = assignment[i];
    const groupId = assignment[i];
    if (groupId) {
      trail?.push(result[i].sentenceIndex, {
        code: "assign-cluster-id",
        detail: groupId,
      });
    }
  }
  const beforeConsolidate = result.map((attribution) => ({
    sentenceIndex: attribution.sentenceIndex,
    speakerGroupId: attribution.speakerGroupId,
  }));
  const consolidated = consolidateEntityClusters(result);
  pushGroupIdChangeEvents(trail, beforeConsolidate, consolidated, "consolidate");
  const beforeExpand = consolidated.map((attribution) => ({
    sentenceIndex: attribution.sentenceIndex,
    speakerGroupId: attribution.speakerGroupId,
  }));
  const expanded = expandClustersToN(consolidated, effectiveCount);
  pushGroupIdChangeEvents(trail, beforeExpand, expanded, "expand");
  return expanded;
}

export function partitionWithHeuristics(
  result: SpeakerAttribution[],
  n: number,
  sentences: string[],
  tokenizer: Tokenizer,
  context?: {
    candidateEntities?: Entity[];
    voiceProfiles?: VoiceProfile[];
    trailCollector?: ClusterTrailCollector;
  },
): SpeakerAttribution[] {
  const candidates = (context?.candidateEntities ?? []).filter(
    (entity) => entity.type === "character",
  );
  const voiceProfiles = context?.voiceProfiles ?? [];
  const trail = context?.trailCollector;
  const records = buildRecords(result, sentences, tokenizer);
  const sentenceOf = (record: DialogueRecord) => result[record.attributionIndex].sentenceIndex;
  const slotKeys = Array.from({ length: n }, (_, i) => `slot:${i}`);
  let anonymousKey = 0;
  let segmentStart = 0;
  const freshKey = () => `anon:${++anonymousKey}`;

  const multiSpeaker = n >= 2;

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record.eligible) continue;

    if (result[record.attributionIndex].speakerEntityId !== null) {
      record.key = `entity:${result[record.attributionIndex].speakerEntityId}`;
      record.provisional = false;
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
        trail?.push(sentenceOf(previous), {
          code: "heuristic",
          detail: "backward-strong-entity",
          relatedSentenceIndex: sentenceOf(record),
        });
      }
    }

    const strongEntity =
      findStrongEntity(record.narrationBefore, candidates, false) ??
      (i === records.length - 1
        ? findStrongEntity(record.narrationAfter, candidates, false)
        : null);
    if (strongEntity !== null) {
      record.key = `entity:${strongEntity}`;
      record.strongEntityId = strongEntity;
      record.provisional = false;
      trail?.push(sentenceOf(record), {
        code: "heuristic",
        detail: "strong-entity",
      });
      continue;
    }

    if (SCENE_BREAK_RE.test(record.narrationBefore)) {
      record.key = freshKey();
      record.provisional = false;
      segmentStart = i;
      trail?.push(sentenceOf(record), {
        code: "heuristic",
        detail: "scene-break",
      });
      continue;
    }

    const addressedEntity = findVocativeEntity(record.text, candidates);
    if (multiSpeaker && addressedEntity !== null) {
      const others = candidates.filter((candidate) => candidate.id !== addressedEntity);
      if (others.length === 1) {
        record.key = `entity:${others[0].id}`;
        trail?.push(sentenceOf(record), {
          code: "heuristic",
          detail: "vocative-other",
        });
        continue;
      }
      if (others.length > 1) {
        const previous = findPreviousEligible(records, i, segmentStart);
        const prevEntity = previous?.key?.startsWith("entity:")
          ? previous.key.slice("entity:".length)
          : null;
        const pick = others.find((candidate) => candidate.id !== prevEntity) ?? others[0];
        record.key = `entity:${pick.id}`;
        trail?.push(sentenceOf(record), {
          code: "heuristic",
          detail: "vocative-other-multi",
          relatedSentenceIndex: previous ? sentenceOf(previous) : undefined,
        });
        continue;
      }
      record.key = differentKey(
        `entity:${addressedEntity}`,
        slotKeys,
        records,
        i,
        segmentStart,
        freshKey,
      );
      record.provisional = true;
      trail?.push(sentenceOf(record), {
        code: "heuristic",
        detail: "vocative-flip",
      });
      continue;
    }

    const previous = findPreviousEligible(records, i, segmentStart);
    if (previous && multiSpeaker && isTurnYield(previous.text)) {
      record.key = flipSpeakerKey(
        previous.key,
        candidates,
        n,
        slotKeys,
        records,
        i,
        segmentStart,
        freshKey,
      );
      record.provisional = true;
      trail?.push(sentenceOf(record), {
        code: "heuristic",
        detail: "turn-yield",
        relatedSentenceIndex: sentenceOf(previous),
      });
      continue;
    }

    if (previous && voiceMismatch(previous.features, record.features, voiceProfiles)) {
      record.key = flipSpeakerKey(
        previous.key,
        candidates,
        n,
        slotKeys,
        records,
        i,
        segmentStart,
        freshKey,
      );
      record.provisional = true;
      trail?.push(sentenceOf(record), {
        code: "heuristic",
        detail: "voice-mismatch",
        relatedSentenceIndex: sentenceOf(previous),
      });
      continue;
    }

    record.key = alternateAmongN(previous?.key ?? null, slotKeys, records, i, segmentStart);
    record.provisional = true;
    trail?.push(sentenceOf(record), {
      code: "heuristic",
      detail: "alternate",
      relatedSentenceIndex: previous ? sentenceOf(previous) : undefined,
    });
  }

  applySceneLocalFingerprint(records, candidates, voiceProfiles, n);
  if (n === 2) {
    const weakVotes = collectWeakVotes(records, candidates);
    applyWeakEntityVoteMerges(records, weakVotes, candidates);
  }

  applyEntityAnchors(records, result);
  assignKeysToIneligible(records, slotKeys);
  enforceExactlyNKeys(records, result, n, slotKeys, freshKey);

  for (const record of records) {
    if (record.key === null) continue;
    trail?.push(sentenceOf(record), {
      code: "partition-key",
      detail: record.key,
    });
  }

  promoteStrongHintEntities(records, result, candidates, trail);
  assignPublicClusterIds(records, result, n, trail);
  const beforeConsolidate = result.map((attribution) => ({
    sentenceIndex: attribution.sentenceIndex,
    speakerGroupId: attribution.speakerGroupId,
  }));
  const consolidated = consolidateEntityClusters(result);
  pushGroupIdChangeEvents(trail, beforeConsolidate, consolidated, "consolidate");
  const beforeExpand = consolidated.map((attribution) => ({
    sentenceIndex: attribution.sentenceIndex,
    speakerGroupId: attribution.speakerGroupId,
  }));
  const expanded = expandClustersToN(consolidated, n);
  pushGroupIdChangeEvents(trail, beforeExpand, expanded, "expand");
  return expanded;
}
