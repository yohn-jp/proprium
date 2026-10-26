import type { StoryEntity, StoryGraphInput } from "./types.js";

export interface SceneCharacterOccurrence {
  sceneId: string;
  characterIds: string[];
}

export interface CooccurrenceEdge {
  a: string;
  b: string;
  sceneCount: number;
  jaccard: number;
  pmi: number;
}

export interface RelationGapWarning {
  a: string;
  b: string;
  issue: "registered-but-no-cooccurrence" | "cooccurring-but-unregistered";
  sceneCount: number;
}

const UNREGISTERED_JACCARD_THRESHOLD = 0.25;
const UNREGISTERED_SCENE_COUNT_THRESHOLD = 2;

function pairKey(a: string, b: string): string {
  return `${a}|${b}`;
}

/** Source-derived Jaccard/PMI calculation over distinct scene-character sets. */
export function computeCooccurrence(occurrences: readonly SceneCharacterOccurrence[]): CooccurrenceEdge[] {
  const totalScenes = occurrences.length;
  if (totalScenes === 0) return [];

  const sceneCountByCharacter = new Map<string, number>();
  const pairSceneCounts = new Map<string, number>();
  for (const { characterIds } of occurrences) {
    const unique = [...new Set(characterIds)];
    for (const id of unique) sceneCountByCharacter.set(id, (sceneCountByCharacter.get(id) ?? 0) + 1);
    const sorted = [...unique].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = pairKey(sorted[i]!, sorted[j]!);
        pairSceneCounts.set(key, (pairSceneCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const edges: CooccurrenceEdge[] = [];
  for (const [key, sceneCount] of pairSceneCounts) {
    const separator = key.indexOf("|");
    const a = key.slice(0, separator);
    const b = key.slice(separator + 1);
    const countA = sceneCountByCharacter.get(a) ?? 0;
    const countB = sceneCountByCharacter.get(b) ?? 0;
    const union = countA + countB - sceneCount;
    const jaccard = union > 0 ? sceneCount / union : 0;
    const pAB = sceneCount / totalScenes;
    const pA = countA / totalScenes;
    const pB = countB / totalScenes;
    edges.push({ a, b, sceneCount, jaccard, pmi: Math.log2(pAB / (pA * pB)) });
  }
  edges.sort((x, y) => y.jaccard - x.jaccard || (x.a < y.a ? -1 : x.a > y.a ? 1 : 0) || (x.b < y.b ? -1 : x.b > y.b ? 1 : 0));
  return edges;
}

/** Find registered-but-unobserved and strong-but-unregistered character pairs. */
export function detectRelationGaps(
  edges: readonly CooccurrenceEdge[],
  registeredPairs: ReadonlySet<string>,
  characterSceneCounts: ReadonlyMap<string, number>,
): RelationGapWarning[] {
  const edgeByKey = new Map(edges.map((edge) => [pairKey(edge.a, edge.b), edge]));
  const registeredButNoCooccurrence: RelationGapWarning[] = [];
  for (const key of registeredPairs) {
    const separator = key.indexOf("|");
    const a = key.slice(0, separator), b = key.slice(separator + 1);
    if (!edgeByKey.has(key) && (characterSceneCounts.get(a) ?? 0) > 0 && (characterSceneCounts.get(b) ?? 0) > 0) {
      registeredButNoCooccurrence.push({ a, b, issue: "registered-but-no-cooccurrence", sceneCount: 0 });
    }
  }
  registeredButNoCooccurrence.sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : 0) || (x.b < y.b ? -1 : x.b > y.b ? 1 : 0));

  const cooccurringButUnregistered = edges
    .filter((edge) => edge.jaccard >= UNREGISTERED_JACCARD_THRESHOLD && edge.sceneCount >= UNREGISTERED_SCENE_COUNT_THRESHOLD && !registeredPairs.has(pairKey(edge.a, edge.b)))
    .map((edge): RelationGapWarning => ({ a: edge.a, b: edge.b, issue: "cooccurring-but-unregistered", sceneCount: edge.sceneCount }))
    .sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : 0) || (x.b < y.b ? -1 : x.b > y.b ? 1 : 0));
  return [...registeredButNoCooccurrence, ...cooccurringButUnregistered];
}

function registerPair(pairs: Set<string>, a: string, b: string, entities: ReadonlyMap<string, StoryEntity>): void {
  if (a === b || entities.get(a)?.type !== "character" || entities.get(b)?.type !== "character") return;
  const [first, second] = [a, b].sort();
  pairs.add(pairKey(first!, second!));
}

/**
 * Build the source co-occurrence model from canonical scene.appears relations.
 * Scope is applied to occurrences before Jaccard/PMI and gap calculations.
 */
export function buildStoryCooccurrence(input: StoryGraphInput & { sceneIds?: readonly string[] }): {
  edges: CooccurrenceEdge[];
  gaps: RelationGapWarning[];
} {
  const scope = input.sceneIds === undefined ? undefined : new Set(input.sceneIds);
  const byScene = new Map<string, Set<string>>();
  for (const link of input.links) {
    if (link.kind !== "appears" || (scope && !scope.has(link.from))) continue;
    if (input.entities.get(link.from)?.type !== "scene" || input.entities.get(link.to)?.type !== "character") continue;
    const characters = byScene.get(link.from) ?? new Set<string>();
    characters.add(link.to);
    byScene.set(link.from, characters);
  }
  const occurrences = [...byScene.entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([sceneId, characterIds]) => ({ sceneId, characterIds: [...characterIds].sort() }));
  const edges = computeCooccurrence(occurrences);
  const characterSceneCounts = new Map<string, number>();
  for (const { characterIds } of occurrences) for (const id of characterIds) {
    characterSceneCounts.set(id, (characterSceneCounts.get(id) ?? 0) + 1);
  }

  const registeredPairs = new Set<string>();
  for (const entity of input.entities.values()) {
    if (entity.type !== "character") continue;
    if (Array.isArray(entity.raw.relations)) {
      for (const relation of entity.raw.relations) {
        if (!relation || typeof relation !== "object" || Array.isArray(relation)) continue;
        const row = relation as Record<string, unknown>;
        if (row.auto === true || typeof row.target !== "string") continue;
        registerPair(registeredPairs, entity.id, row.target, input.entities);
      }
    }
  }
  for (const link of input.links) {
    if (link.kind !== "related") continue;
    const source = input.entities.get(link.from);
    const target = input.entities.get(link.to);
    if (source?.type !== "character" || target?.type !== "character") continue;
    const autoRelation = Array.isArray(source.raw.relations) && source.raw.relations.some((item) =>
      !!item && typeof item === "object" && !Array.isArray(item) &&
      (item as Record<string, unknown>).target === target.id && (item as Record<string, unknown>).auto === true);
    if (!autoRelation) registerPair(registeredPairs, source.id, target.id, input.entities);
  }
  return { edges, gaps: detectRelationGaps(edges, registeredPairs, characterSceneCounts) };
}
