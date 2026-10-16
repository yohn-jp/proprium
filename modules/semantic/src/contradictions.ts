import { buildSceneLocationInfos, findMentions, buildMentionDictionary, type StoryEntity, type StoryGraphInput } from "@scriptorium/module-story";
import type { SemanticMentionPair, SemanticPassage } from "./contracts.js";

export type ContradictionKind = "embedding_midband" | "rule_ownership" | "rule_location";
export interface ContradictionEvidence {
  sceneId: string;
  sentenceIndex?: number | null;
  quote: string;
  entityId?: string;
}
export interface ContradictionCandidate {
  id: string;
  kind: ContradictionKind;
  score: number;
  suspicion: string;
  evidenceA: ContradictionEvidence;
  evidenceB: ContradictionEvidence;
  entityId?: string | null;
  verdict: null;
  reason: null;
}

const EMBEDDABLE_TYPES = new Set(["scene", "manuscript"]);
export const CONTRADICTION_MID_BAND_MIN = 0.29;
export const CONTRADICTION_MID_BAND_MAX = 0.84;

export interface MentionGroup {
  entityId: string;
  anchors: Array<{ sceneId: string; sentenceIndex: number; text: string }>;
}

/** Build N7 mention groups from the persisted source sentence rows and name/alias trie. */
export function collectMentionGroups(entities: ReadonlyMap<string, StoryEntity>, passages: readonly SemanticPassage[]): MentionGroup[] {
  const dictionary = buildMentionDictionary(entities.values());
  const byEntity = new Map<string, MentionGroup>();
  for (const row of passages) {
    if (!EMBEDDABLE_TYPES.has(row.type ?? "") || !entities.has(row.entityId)) continue;
    for (const entityId of findMentions(dictionary, row.text)) {
      if (entityId === row.entityId) continue;
      const group = byEntity.get(entityId) ?? { entityId, anchors: [] };
      group.anchors.push({ sceneId: row.entityId, sentenceIndex: row.sentenceIndex, text: row.text });
      byEntity.set(entityId, group);
    }
  }
  return [...byEntity.values()];
}

interface SceneEffect {
  action: "move_to" | "transfer_item" | "acquire_item" | "drop_item" | "use_item";
  characterId?: string;
  itemId?: string;
  toCharacterId?: string;
  fromCharacterId?: string;
  toLocationId?: string;
}
interface SceneEntry { sceneId: string; order: number; effects: SceneEffect[] }
interface StateContradiction {
  sceneId: string;
  previousSceneId?: string;
  reason: "item-owner-mismatch" | "unrecorded-teleport";
  characterEntityId: string;
  itemId?: string;
  expectedOwnerId?: string;
  fromLocationId?: string;
  toLocationId?: string;
  detail: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseEffects(raw: unknown): SceneEffect[] {
  if (!Array.isArray(raw)) return [];
  const effects: SceneEffect[] = [];
  for (const value of raw) {
    if (!isRecord(value) || typeof value.action !== "string") continue;
    switch (value.action) {
      case "move_to":
        if (typeof value.characterId === "string" && typeof value.toLocationId === "string") effects.push({ action: "move_to", characterId: value.characterId, toLocationId: value.toLocationId });
        break;
      case "transfer_item":
        if (typeof value.itemId === "string" && typeof value.toCharacterId === "string") effects.push({ action: "transfer_item", itemId: value.itemId, toCharacterId: value.toCharacterId, fromCharacterId: typeof value.fromCharacterId === "string" ? value.fromCharacterId : undefined });
        break;
      case "acquire_item":
      case "drop_item":
      case "use_item":
        if (typeof value.characterId === "string" && typeof value.itemId === "string") effects.push({ action: value.action, characterId: value.characterId, itemId: value.itemId });
        break;
    }
  }
  return effects;
}

function sceneEntries(input: StoryGraphInput): { entries: SceneEntry[]; sceneInfos: ReturnType<typeof buildSceneLocationInfos>["data"] } {
  const sceneInfos = buildSceneLocationInfos(input).data;
  return {
    sceneInfos,
    entries: sceneInfos.map((scene) => ({ sceneId: scene.sceneId, order: scene.order, effects: parseEffects(input.entities.get(scene.sceneId)?.raw.effects) })),
  };
}

/** Port of source tracker state-stack rules, with its same per-scene before/after boundaries. */
export function detectSourceRuleContradictions(input: StoryGraphInput): StateContradiction[] {
  const { entries, sceneInfos } = sceneEntries(input);
  const sorted = [...entries].sort((a, b) => a.order - b.order);
  const itemOwners = new Map<string, { ownerCharacterId: string | null; sinceSceneId: string }>();
  const characterLocations = new Map<string, { locationId: string; sinceSceneId: string }>();
  const snapshots = new Map<string, { itemOwners: Map<string, { ownerCharacterId: string | null; sinceSceneId: string }>; characterLocations: Map<string, { locationId: string; sinceSceneId: string }> }>();
  for (const entry of sorted) {
    for (const effect of entry.effects) {
      if (effect.action === "move_to") characterLocations.set(effect.characterId!, { locationId: effect.toLocationId!, sinceSceneId: entry.sceneId });
      else if (effect.action === "transfer_item") itemOwners.set(effect.itemId!, { ownerCharacterId: effect.toCharacterId!, sinceSceneId: entry.sceneId });
      else if (effect.action === "acquire_item") itemOwners.set(effect.itemId!, { ownerCharacterId: effect.characterId!, sinceSceneId: entry.sceneId });
      else if (effect.action === "drop_item") itemOwners.set(effect.itemId!, { ownerCharacterId: null, sinceSceneId: entry.sceneId });
    }
    snapshots.set(entry.sceneId, { itemOwners: new Map(itemOwners), characterLocations: new Map(characterLocations) });
  }

  const contradictions: StateContradiction[] = [];
  const sortedSnapshotRows = [...snapshots.entries()];
  for (const entry of sorted) {
    const previousIndex = sorted.findIndex((candidate) => candidate.sceneId === entry.sceneId) - 1;
    const before = previousIndex >= 0 ? snapshots.get(sorted[previousIndex]!.sceneId) : undefined;
    for (const effect of entry.effects) {
      if (effect.action !== "use_item") continue;
      const owner = before?.itemOwners.get(effect.itemId!);
      if (!owner || owner.ownerCharacterId === null || owner.ownerCharacterId === effect.characterId) continue;
      contradictions.push({
        sceneId: entry.sceneId,
        previousSceneId: owner.sinceSceneId,
        reason: "item-owner-mismatch",
        characterEntityId: effect.characterId!,
        itemId: effect.itemId!,
        expectedOwnerId: owner.ownerCharacterId,
        detail: `アイテム「${effect.itemId}」はシーン「${owner.sinceSceneId}」以降キャラ「${owner.ownerCharacterId}」が所持しているはずだが、シーン「${entry.sceneId}」でキャラ「${effect.characterId}」が使用した。`,
      });
    }
  }

  const observed = new Map<string, { locationId: string; sceneId: string }>();
  for (const scene of [...sceneInfos].sort((a, b) => a.order - b.order)) {
    if (!scene.locationId) continue;
    const after = snapshots.get(scene.sceneId);
    for (const characterId of scene.characterIds) {
      const prior = observed.get(characterId);
      if (prior && prior.locationId !== scene.locationId) {
        const trackedLocation = after?.characterLocations.get(characterId)?.locationId;
        if (trackedLocation !== scene.locationId) contradictions.push({
          sceneId: scene.sceneId,
          previousSceneId: prior.sceneId,
          reason: "unrecorded-teleport",
          characterEntityId: characterId,
          fromLocationId: prior.locationId,
          toLocationId: scene.locationId,
          detail: `キャラ「${characterId}」はシーン「${prior.sceneId}」で場所「${prior.locationId}」にいたが、移動effect（move_to）の記録なしにシーン「${scene.sceneId}」で場所「${scene.locationId}」に出現した。`,
        });
      }
      observed.set(characterId, { locationId: scene.locationId, sceneId: scene.sceneId });
    }
  }
  return contradictions;
}

export function ruleContradictionsToCandidates(contradictions: StateContradiction[]): ContradictionCandidate[] {
  return contradictions.map((item) => {
    const ownership = item.reason === "item-owner-mismatch";
    const kind: ContradictionKind = ownership ? "rule_ownership" : "rule_location";
    const quoteA = ownership
      ? `シーン「${item.previousSceneId ?? "?"}」以降、アイテム「${item.itemId}」の所有者は「${item.expectedOwnerId}」。`
      : `シーン「${item.previousSceneId ?? "?"}」でキャラ「${item.characterEntityId}」は場所「${item.fromLocationId}」にいた。`;
    const quoteB = ownership
      ? `シーン「${item.sceneId}」でキャラ「${item.characterEntityId}」がアイテム「${item.itemId}」を使用。`
      : `シーン「${item.sceneId}」で移動effectなしに場所「${item.toLocationId}」へ出現。`;
    const previous = item.previousSceneId ?? "_";
    return {
      id: `rule:${item.reason}:${previous}:${item.sceneId}:${item.characterEntityId}:${item.itemId ?? item.toLocationId ?? ""}`,
      kind,
      score: 1,
      suspicion: item.detail,
      evidenceA: { sceneId: item.previousSceneId ?? item.sceneId, quote: quoteA, entityId: item.characterEntityId },
      evidenceB: { sceneId: item.sceneId, quote: quoteB, entityId: item.characterEntityId },
      entityId: item.characterEntityId,
      verdict: null,
      reason: null,
    };
  });
}

export function embeddingContradictionsToCandidates(pairs: readonly SemanticMentionPair[]): ContradictionCandidate[] {
  return pairs.map((pair) => ({
    id: `embed:${pair.entityId}:${pair.evidenceA.sceneId}:${pair.evidenceA.sentenceIndex}:${pair.evidenceB.sceneId}:${pair.evidenceB.sentenceIndex}`,
    kind: "embedding_midband",
    score: pair.score,
    suspicion: `同一エンティティ「${pair.entityId}」への言及文が中域類似（score=${pair.score.toFixed(3)}）。同話題で内容が異なる可能性。`,
    evidenceA: { sceneId: pair.evidenceA.sceneId, sentenceIndex: pair.evidenceA.sentenceIndex, quote: pair.evidenceA.text, entityId: pair.entityId },
    evidenceB: { sceneId: pair.evidenceB.sceneId, sentenceIndex: pair.evidenceB.sentenceIndex, quote: pair.evidenceB.text, entityId: pair.entityId },
    entityId: pair.entityId,
    verdict: null,
    reason: null,
  }));
}

export function mergeContradictionCandidates(rule: readonly ContradictionCandidate[], embedding: readonly ContradictionCandidate[]): ContradictionCandidate[] {
  const byId = new Map<string, ContradictionCandidate>();
  for (const item of [...rule, ...embedding]) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
