/**
 * Pure Semantic plugin algorithms recovered from Scriptorium's pinned
 * modules/semantic sources. These functions accept data and vectors already
 * bound to one Host snapshot; they never read or write workspace state.
 */

export const EMBEDDING_MODEL = {
  id: "Xenova/multilingual-e5-small",
  revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
  dimensions: 384,
} as const;

export const RERANKER_MODEL = {
  id: "mogolloni/bge-reranker-v2-m3-onnx",
  revision: "e5023553f6c47f09057da7a19cdd79ef850a4985",
} as const;

export const EMBEDDING_SIMILARITY_THRESHOLD = 0.976;
export const CONTRADICTION_MID_BAND_MIN = 0.29;
export const CONTRADICTION_MID_BAND_MAX = 0.84;

export interface CandidateTerm {
  readonly term: string;
  readonly reading: string | null;
  readonly sourceEntityIds: readonly string[];
  readonly occurrenceCount: number;
}

export interface TermCluster {
  readonly canonical: string;
  readonly variants: readonly string[];
  readonly semanticOnly?: boolean;
}

export interface SourceSpan {
  readonly path: string;
  readonly revision: string;
  readonly start: number;
  readonly end: number;
  readonly quote: string;
}

export interface SemanticAnchor {
  readonly sceneId: string;
  readonly sentenceIndex: number;
  readonly text: string;
  readonly vector: readonly number[];
  readonly evidence: SourceSpan;
}

export interface EmbeddingContradiction {
  readonly id: string;
  readonly kind: "embedding_midband";
  readonly entityId: string;
  readonly score: number;
  readonly suspicion: string;
  readonly evidenceA: {
    readonly sceneId: string;
    readonly sentenceIndex: number;
    readonly quote: string;
    readonly path: string;
    readonly revision: string;
    readonly start: number;
    readonly end: number;
  };
  readonly evidenceB: EmbeddingContradiction["evidenceA"];
}

export interface IndexedPassage {
  readonly entityId: string;
  readonly sentenceIndex: number;
  readonly sceneId: string;
  readonly sourcePath: string;
  readonly sourceRevision: string;
  readonly quote: string;
  readonly vector: readonly number[];
}

export interface RerankCandidate {
  readonly candidateId: string;
  readonly entityId: string;
  readonly sourcePath: string;
  readonly sourceRevision: string;
  readonly text: string;
  readonly evidence: readonly SourceSpan[];
}

export interface RerankResult {
  readonly candidateId: string;
  readonly score: number;
  readonly rank: number;
}

export interface NamedEntity {
  readonly id: string;
  readonly type: string;
  readonly name?: string;
  readonly aliases?: readonly string[];
}

export interface MentionSourcePassage extends IndexedPassage {
  readonly type: string;
  readonly evidence: SourceSpan;
}

interface MentionTrieNode {
  readonly children: Map<string, MentionTrieNode>;
  entityIds?: string[];
}

function mentionNode(): MentionTrieNode {
  return { children: new Map() };
}

function findMentionIds(root: MentionTrieNode, text: string): string[] {
  const found = new Set<string>();
  const characters = Array.from(text);
  for (let start = 0; start < characters.length; start++) {
    let node = root;
    let lastMatchIds: string[] | undefined;
    let lastMatchLength = 0;
    for (let index = start; index < characters.length; index++) {
      const next = node.children.get(characters[index]!);
      if (!next) break;
      node = next;
      if (node.entityIds) {
        lastMatchIds = node.entityIds;
        lastMatchLength = index - start + 1;
      }
    }
    if (lastMatchIds) {
      for (const id of lastMatchIds) found.add(id);
      start += lastMatchLength - 1;
    }
  }
  return [...found];
}

/** Source name/alias trie and prose-only filtering used for contradiction candidates. */
export function collectMentionGroups(
  entities: readonly NamedEntity[],
  passages: readonly MentionSourcePassage[],
): Array<{ entityId: string; anchors: SemanticAnchor[] }> {
  const entityIds = new Set(entities.map((entity) => entity.id));
  const root = mentionNode();
  for (const entity of entities) {
    for (const token of [...(entity.name ? [entity.name] : []), ...(entity.aliases ?? [])]) {
      if (token.length < 2) continue;
      let node = root;
      for (const character of Array.from(token)) {
        let next = node.children.get(character);
        if (!next) {
          next = mentionNode();
          node.children.set(character, next);
        }
        node = next;
      }
      node.entityIds ??= [];
      if (!node.entityIds.includes(entity.id)) node.entityIds.push(entity.id);
    }
  }

  const groups = new Map<string, SemanticAnchor[]>();
  for (const passage of passages) {
    if ((passage.type !== "scene" && passage.type !== "manuscript") || !entityIds.has(passage.entityId)) continue;
    for (const mentionedEntityId of findMentionIds(root, passage.quote)) {
      if (mentionedEntityId === passage.entityId) continue;
      const anchors = groups.get(mentionedEntityId) ?? [];
      anchors.push({
        sceneId: passage.sceneId,
        sentenceIndex: passage.sentenceIndex,
        text: passage.quote,
        vector: passage.vector,
        evidence: passage.evidence,
      });
      groups.set(mentionedEntityId, anchors);
    }
  }
  return [...groups].map(([entityId, anchors]) => ({ entityId, anchors }));
}

export function cosineSimilarityDense(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError("Semantic vectors must contain only finite values");
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  const score = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  if (!Number.isFinite(score)) throw new TypeError("Semantic similarity was not finite");
  return score;
}

function levenshteinDistanceAtMost(a: string, b: string, maximum: number): number {
  if (Math.abs(a.length - b.length) > maximum) return maximum + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = Array<number>(b.length + 1).fill(maximum + 1);
    current[0] = i;
    const first = Math.max(1, i - maximum);
    const last = Math.min(b.length, i + maximum);
    let rowMinimum = current[0]!;
    for (let j = first; j <= last; j++) {
      current[j] = a[i - 1] === b[j - 1]
        ? previous[j - 1]!
        : 1 + Math.min(previous[j]!, current[j - 1]!, previous[j - 1]!);
      rowMinimum = Math.min(rowMinimum, current[j]!);
    }
    if (rowMinimum > maximum) return maximum + 1;
    previous = current;
  }
  return previous[b.length]!;
}

/** Source substring, edit-distance, and reading equivalence rules. */
export function shouldClusterByString(termA: string, termB: string): boolean {
  if (termA.includes(termB) || termB.includes(termA)) {
    if (Math.abs(termA.length - termB.length) <= 3) return true;
  }
  const threshold = Math.min(Math.floor(Math.min(termA.length, termB.length) * 0.3), 2);
  return levenshteinDistanceAtMost(termA, termB, threshold) <= threshold;
}

class UnionFind {
  private readonly parent = new Map<number, number>();

  find(value: number): number {
    if (!this.parent.has(value)) this.parent.set(value, value);
    const parent = this.parent.get(value)!;
    if (parent !== value) this.parent.set(value, this.find(parent));
    return this.parent.get(value)!;
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent.set(rootA, rootB);
  }
}

/**
 * Port of Scriptorium's term grouping. Embedding edges must come from the
 * admitted, snapshot-bound model lease; omitting vectors gives the exact
 * deterministic no-model result.
 */
export function clusterTerms(
  candidates: readonly CandidateTerm[],
  vectors?: readonly (readonly number[] | undefined)[],
): TermCluster[] {
  if (candidates.length > 2000) throw new RangeError("At most 2000 term candidates may be clustered");
  if (vectors && vectors.length !== candidates.length) throw new TypeError("Vector count must match candidate count");
  if (candidates.length === 0) return [];

  const union = new UnionFind();
  const semanticPairs: Array<[number, number]> = [];
  let dimensions: number | undefined;
  for (const vector of vectors ?? []) {
    if (!vector) continue;
    if (dimensions === undefined) dimensions = vector.length;
    if (vector.length !== dimensions || vector.length !== EMBEDDING_MODEL.dimensions || vector.some((value) => !Number.isFinite(value))) {
      throw new TypeError("Candidate vectors must have one shared nonzero dimension and finite values");
    }
  }

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const left = candidates[i]!;
      const right = candidates[j]!;
      if ((left.reading !== null && right.reading !== null && left.reading === right.reading) || shouldClusterByString(left.term, right.term)) {
        union.union(i, j);
      } else {
        if (vectors?.[i] && vectors[j]) semanticPairs.push([i, j]);
      }
    }
  }

  const semanticEdges = new Set<string>();
  for (const [i, j] of semanticPairs) {
    if (cosineSimilarityDense(vectors![i]!, vectors![j]!) >= EMBEDDING_SIMILARITY_THRESHOLD) {
      union.union(i, j);
      semanticEdges.add(`${i}-${j}`);
    }
  }

  const groups = new Map<number, number[]>();
  for (let index = 0; index < candidates.length; index++) {
    const root = union.find(index);
    const members = groups.get(root) ?? [];
    members.push(index);
    groups.set(root, members);
  }

  const semanticRoots = new Set<number>();
  for (const edge of semanticEdges) semanticRoots.add(union.find(Number(edge.split("-")[0])));
  const clusters: TermCluster[] = [];
  for (const [root, indices] of groups) {
    if (indices.length < 2) continue;
    let canonicalIndex = indices[0]!;
    for (const index of indices.slice(1)) {
      const current = candidates[canonicalIndex]!;
      const candidate = candidates[index]!;
      if (candidate.occurrenceCount > current.occurrenceCount ||
          (candidate.occurrenceCount === current.occurrenceCount && candidate.sourceEntityIds.length > current.sourceEntityIds.length) ||
          (candidate.occurrenceCount === current.occurrenceCount && candidate.sourceEntityIds.length === current.sourceEntityIds.length && candidate.term.length < current.term.length)) {
        canonicalIndex = index;
      }
    }
    const cluster: TermCluster = {
      canonical: candidates[canonicalIndex]!.term,
      variants: indices.filter((index) => index !== canonicalIndex).map((index) => candidates[index]!.term),
    };
    if (semanticRoots.has(root)) (cluster as { semanticOnly?: boolean }).semanticOnly = true;
    clusters.push(cluster);
  }
  return clusters;
}

function evidenceFrom(anchor: SemanticAnchor): EmbeddingContradiction["evidenceA"] {
  const { evidence } = anchor;
  if (evidence.quote !== anchor.text || !evidence.path || !evidence.revision ||
      !Number.isInteger(evidence.start) || !Number.isInteger(evidence.end) ||
      evidence.start < 0 || evidence.end - evidence.start !== evidence.quote.length) {
    throw new TypeError("Contradiction evidence must contain a valid exact source span");
  }
  return {
    sceneId: anchor.sceneId,
    sentenceIndex: anchor.sentenceIndex,
    quote: evidence.quote,
    path: evidence.path,
    revision: evidence.revision,
    start: evidence.start,
    end: evidence.end,
  };
}

/** Produce hypothesis pairs only; this does not decide that passages conflict. */
export function embeddingContradictions(
  groups: readonly { readonly entityId: string; readonly anchors: readonly SemanticAnchor[] }[],
): EmbeddingContradiction[] {
  const result: EmbeddingContradiction[] = [];
  for (const group of groups) {
    const dimensions = group.anchors[0]?.vector.length;
    if (dimensions !== EMBEDDING_MODEL.dimensions || group.anchors.some((anchor) => anchor.vector.length !== dimensions || anchor.vector.some((value) => !Number.isFinite(value)))) {
      throw new TypeError("Contradiction vectors must have one shared nonzero dimension and finite values");
    }
    for (let leftIndex = 0; leftIndex < group.anchors.length; leftIndex++) {
      const left = group.anchors[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < group.anchors.length; rightIndex++) {
        const right = group.anchors[rightIndex]!;
        if (left.sceneId === right.sceneId && left.sentenceIndex === right.sentenceIndex) continue;
        const score = cosineSimilarityDense(left.vector, right.vector);
        if (score < CONTRADICTION_MID_BAND_MIN || score >= CONTRADICTION_MID_BAND_MAX) continue;
        const [a, b] = compareAnchor(left, right) <= 0 ? [left, right] : [right, left];
        const evidenceA = evidenceFrom(a);
        const evidenceB = evidenceFrom(b);
        result.push({
          id: `embed:${group.entityId}:${a.sceneId}:${a.sentenceIndex}:${b.sceneId}:${b.sentenceIndex}`,
          kind: "embedding_midband",
          entityId: group.entityId,
          score,
          suspicion: `同一エンティティ「${group.entityId}」への言及文が中域類似（score=${score.toFixed(3)}）。同話題で内容が異なる可能性。`,
          evidenceA,
          evidenceB,
        });
      }
    }
  }
  return result.sort((a, b) => b.score - a.score || compareText(a.id, b.id));
}

function compareAnchor(a: SemanticAnchor, b: SemanticAnchor): number {
  return compareText(a.sceneId, b.sceneId) || a.sentenceIndex - b.sentenceIndex;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Rank a bounded snapshot index with stable source-identity tie breaking. */
export function nearestPassages(
  queryVector: readonly number[],
  passages: readonly IndexedPassage[],
  limit: number,
  excludeSceneIds: readonly string[] = [],
): Array<IndexedPassage & { readonly cosineScore: number }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("Semantic query limit must be between 1 and 100");
  if (queryVector.length !== EMBEDDING_MODEL.dimensions || queryVector.some((value) => !Number.isFinite(value))) {
    throw new TypeError("Query vector does not match the pinned embedding model");
  }
  if (passages.some((passage) => passage.vector.length !== EMBEDDING_MODEL.dimensions || passage.vector.some((value) => !Number.isFinite(value)))) {
    throw new TypeError("Indexed passage vector does not match the pinned embedding model");
  }
  const excluded = new Set(excludeSceneIds);
  return passages.filter((passage) => !excluded.has(passage.sceneId))
    .map((passage) => ({ ...passage, cosineScore: cosineSimilarityDense(queryVector, passage.vector) }))
    .sort((a, b) => b.cosineScore - a.cosineScore || compareText(a.entityId, b.entityId) || a.sentenceIndex - b.sentenceIndex)
    .slice(0, limit);
}

/** Match BGE's sigmoid-logit score and stable original-order tie behavior. */
export function rerankResults(candidates: readonly RerankCandidate[], logits: readonly number[], limit: number): RerankResult[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 30 || candidates.length > 30 || candidates.length !== logits.length) {
    throw new RangeError("Reranker candidate count or output limit is invalid");
  }
  const seen = new Set<string>();
  const ranked = candidates.map((candidate, index) => {
    if (!candidate.candidateId || candidate.candidateId.length > 128 || seen.has(candidate.candidateId)) {
      throw new TypeError("Reranker candidate IDs must be unique nonempty strings up to 128 characters");
    }
    seen.add(candidate.candidateId);
    const logit = logits[index]!;
    if (!Number.isFinite(logit)) throw new TypeError("Reranker logits must be finite");
    const score = logit >= 0 ? 1 / (1 + Math.exp(-logit)) : Math.exp(logit) / (1 + Math.exp(logit));
    return { candidateId: candidate.candidateId, score, originalIndex: index };
  });
  ranked.sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex);
  return ranked.slice(0, limit).map(({ candidateId, score }, index) => ({ candidateId, score, rank: index + 1 }));
}
