import { buildMentionDictionary, findMentions } from "./mentionIndex.js";
import {
  snapshotResult,
  type StoryEntity,
  type StoryGraphInput,
  type StorySnapshotResult,
} from "./types.js";
import type { SnapshotId } from "@scriptorium/contracts";
import type { SceneStateEvent } from "./worldState.js";
import type { ThreadLifecycleSnapshot } from "./threadLifecycle.js";

export type ReaderDisclosureKind = "mention_first" | "summary_state_change";
export type ReaderDisclosureSource = "mention" | "scene_summary";

export interface ReaderKnowledgeEvent {
  sceneId: string;
  order: number;
  entityId: string;
  disclosureKind: ReaderDisclosureKind;
  evidence: string;
  source: ReaderDisclosureSource;
}

export type KnowledgeGapKind =
  | "character_knows_reader_does_not"
  | "reader_knows_character_does_not";

export interface KnowledgeGap {
  kind: KnowledgeGapKind;
  characterId: string;
  entityId: string;
  characterKnewAtSceneId: string | null;
  readerDisclosedAtSceneId: string | null;
}

export interface ThreadForgetRisk {
  threadId: string;
  plantedSceneId?: string;
  resolvedSceneId?: string;
  sceneDistance: number;
  disclosureCountBetween: number;
  forgetRisk: number;
}

export interface SceneTextForDisclosure {
  sceneId: string;
  order: number;
  text: string;
  characterIds: string[];
  stateChanges?: string[];
}

const MENTIONABLE_TYPES = new Set([
  "character",
  "location",
  "item",
  "faction",
  "event",
  "lore",
  "thread",
]);

function mentionableEntities(entities: ReadonlyMap<string, StoryEntity>): StoryEntity[] {
  return [...entities.values()].filter((entity) => MENTIONABLE_TYPES.has(entity.type));
}

function firstMentionEvidenceData(entity: StoryEntity, text: string): string | null {
  const tokens = [...(entity.name ? [entity.name] : []), ...(entity.aliases ?? [])];
  let best: string | null = null;
  let bestIndex = Infinity;
  for (const token of tokens) {
    if (token.length < 2) continue;
    const index = text.indexOf(token);
    if (index >= 0 && index < bestIndex) {
      bestIndex = index;
      best = token;
    }
  }
  return best;
}

export function firstMentionEvidence(input: {
  snapshot: SnapshotId;
  entity: StoryEntity;
  text: string;
}): StorySnapshotResult<string | null> {
  return snapshotResult(input.snapshot, firstMentionEvidenceData(input.entity, input.text));
}

function extractReaderDisclosuresData(
  entities: ReadonlyMap<string, StoryEntity>,
  scenes: readonly SceneTextForDisclosure[],
): ReaderKnowledgeEvent[] {
  const mentionable = mentionableEntities(entities);
  const entityById = new Map(mentionable.map((entity) => [entity.id, entity]));
  const dictionary = buildMentionDictionary(mentionable);
  const disclosed = new Set<string>();
  const events: ReaderKnowledgeEvent[] = [];
  for (const scene of [...scenes].sort((a, b) => a.order - b.order)) {
    if (scene.text) {
      for (const entityId of findMentions(dictionary, scene.text)) {
        if (disclosed.has(entityId)) continue;
        const entity = entityById.get(entityId);
        if (!entity) continue;
        const evidence = firstMentionEvidenceData(entity, scene.text) ?? entity.name ?? entityId;
        disclosed.add(entityId);
        events.push({
          sceneId: scene.sceneId,
          order: scene.order,
          entityId,
          disclosureKind: "mention_first",
          evidence,
          source: "mention",
        });
      }
    }
    for (const change of scene.stateChanges ?? []) {
      if (!change.trim()) continue;
      for (const entityId of findMentions(dictionary, change)) {
        if (disclosed.has(entityId)) continue;
        disclosed.add(entityId);
        events.push({
          sceneId: scene.sceneId,
          order: scene.order,
          entityId,
          disclosureKind: "summary_state_change",
          evidence: change.trim(),
          source: "scene_summary",
        });
      }
    }
  }
  return events;
}

export function extractReaderDisclosures(
  input: StoryGraphInput & { scenes: readonly SceneTextForDisclosure[] },
): StorySnapshotResult<ReaderKnowledgeEvent[]> {
  return snapshotResult(
    input.snapshot,
    extractReaderDisclosuresData(input.entities, input.scenes),
  );
}

function diffReaderAndCharacterKnowledgeData(options: {
  entities: ReadonlyMap<string, StoryEntity>;
  disclosures: readonly ReaderKnowledgeEvent[];
  knowledgeEvents: readonly SceneStateEvent[];
  scenes: readonly SceneTextForDisclosure[];
  upToOrder: number;
}): KnowledgeGap[] {
  const { entities, disclosures, knowledgeEvents, upToOrder } = options;
  const sorted = [...options.scenes]
    .sort((a, b) => a.order - b.order)
    .filter((scene) => scene.order <= upToOrder);
  const readerFirst = new Map<string, { sceneId: string; order: number }>();
  for (const disclosure of disclosures) {
    if (disclosure.order > upToOrder) continue;
    if (!readerFirst.has(disclosure.entityId)) {
      readerFirst.set(disclosure.entityId, {
        sceneId: disclosure.sceneId,
        order: disclosure.order,
      });
    }
  }

  const characterKnowledge = new Map<string, Map<string, { sceneId: string; order: number }>>();
  function recordKnowledge(characterId: string, entityId: string, sceneId: string, order: number): void {
    if (characterId === entityId) return;
    let byEntity = characterKnowledge.get(characterId);
    if (!byEntity) {
      byEntity = new Map();
      characterKnowledge.set(characterId, byEntity);
    }
    const previous = byEntity.get(entityId);
    if (!previous || order < previous.order) byEntity.set(entityId, { sceneId, order });
  }

  for (const event of knowledgeEvents) {
    if (event.kind !== "knowledge" || event.order > upToOrder || !event.object) continue;
    recordKnowledge(event.subject, event.object, event.sceneId, event.order);
  }

  const dictionary = buildMentionDictionary(mentionableEntities(entities));
  for (const scene of sorted) {
    if (!scene.text || scene.characterIds.length === 0) continue;
    const hitIds = findMentions(dictionary, scene.text);
    for (const characterId of scene.characterIds) {
      for (const entityId of hitIds) recordKnowledge(characterId, entityId, scene.sceneId, scene.order);
    }
  }

  const gaps: KnowledgeGap[] = [];
  const seen = new Set<string>();
  for (const [characterId, byEntity] of characterKnowledge) {
    for (const [entityId, knew] of byEntity) {
      const reader = readerFirst.get(entityId);
      if (reader && reader.order <= knew.order) continue;
      const key = `c>${characterId}|${entityId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      gaps.push({
        kind: "character_knows_reader_does_not",
        characterId,
        entityId,
        characterKnewAtSceneId: knew.sceneId,
        readerDisclosedAtSceneId: reader?.sceneId ?? null,
      });
    }
  }

  const allCharacters = new Set<string>();
  for (const scene of sorted) for (const characterId of scene.characterIds) allCharacters.add(characterId);
  for (const [entityId, reader] of readerFirst) {
    for (const characterId of allCharacters) {
      if (characterId === entityId || characterKnowledge.get(characterId)?.has(entityId)) continue;
      const key = `r>${characterId}|${entityId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      gaps.push({
        kind: "reader_knows_character_does_not",
        characterId,
        entityId,
        characterKnewAtSceneId: null,
        readerDisclosedAtSceneId: reader.sceneId,
      });
    }
  }
  gaps.sort((a, b) =>
    a.kind !== b.kind
      ? a.kind.localeCompare(b.kind)
      : a.characterId !== b.characterId
        ? a.characterId.localeCompare(b.characterId)
        : a.entityId.localeCompare(b.entityId),
  );
  return gaps;
}

export function diffReaderAndCharacterKnowledge(input: StoryGraphInput & {
  disclosures: readonly ReaderKnowledgeEvent[];
  knowledgeEvents: readonly SceneStateEvent[];
  scenes: readonly SceneTextForDisclosure[];
  upToOrder: number;
}): StorySnapshotResult<KnowledgeGap[]> {
  return snapshotResult(
    input.snapshot,
    diffReaderAndCharacterKnowledgeData({
      entities: input.entities,
      disclosures: input.disclosures,
      knowledgeEvents: input.knowledgeEvents,
      scenes: input.scenes,
      upToOrder: input.upToOrder,
    }),
  );
}

export function scoreForgetRisk(sceneDistance: number, disclosureCountBetween: number): number {
  if (sceneDistance <= 0) return 0;
  const distanceFactor = Math.min(1, sceneDistance / 12);
  const clutterFactor = Math.min(1, disclosureCountBetween / 20);
  return Math.round(Math.min(1, 0.55 * distanceFactor + 0.45 * clutterFactor) * 1000) / 1000;
}

export function computeThreadForgetRisks(input: {
  snapshot: SnapshotId;
  snapshots: readonly ThreadLifecycleSnapshot[];
  disclosures: readonly ReaderKnowledgeEvent[];
  orderBySceneId: ReadonlyMap<string, number>;
}): StorySnapshotResult<ThreadForgetRisk[]> {
  const risks: ThreadForgetRisk[] = [];
  for (const thread of input.snapshots) {
    const plantedOrder =
      thread.plantedSceneId == null ? undefined : input.orderBySceneId.get(thread.plantedSceneId);
    if (plantedOrder == null) continue;
    const resolvedOrder =
      thread.resolvedSceneId == null ? undefined : input.orderBySceneId.get(thread.resolvedSceneId);
    const endOrder = resolvedOrder ?? Math.max(0, ...input.orderBySceneId.values());
    const sceneDistance = Math.max(0, endOrder - plantedOrder);
    const disclosureCountBetween = input.disclosures.filter(
      (disclosure) => disclosure.order > plantedOrder && disclosure.order < endOrder,
    ).length;
    risks.push({
      threadId: thread.threadId,
      plantedSceneId: thread.plantedSceneId,
      resolvedSceneId: thread.resolvedSceneId,
      sceneDistance,
      disclosureCountBetween,
      forgetRisk: scoreForgetRisk(sceneDistance, disclosureCountBetween),
    });
  }
  risks.sort((a, b) => b.forgetRisk - a.forgetRisk || a.threadId.localeCompare(b.threadId));
  return snapshotResult(input.snapshot, risks);
}
