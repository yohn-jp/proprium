import type { SnapshotId } from "@scriptorium/contracts";
import type { CandidateTerm } from "@scriptorium/module-nlp";
import { cosineSimilarityDense } from "./cosine.js";
import type { SemanticEmbeddingCapability } from "./contracts.js";

export interface TermCluster {
  canonical: string;
  variants: string[];
  semanticOnly?: boolean;
}

export const EMBEDDING_SIMILARITY_THRESHOLD = 0.976;

export interface ClusterSimilarTermsOptions {
  useEmbedding?: boolean;
  embedding?: SemanticEmbeddingCapability;
  snapshot?: SnapshotId;
  signal?: AbortSignal;
}

class UnionFind {
  private parent = new Map<number, number>();
  find(value: number): number {
    if (!this.parent.has(value)) this.parent.set(value, value);
    const parent = this.parent.get(value) ?? value;
    if (parent !== value) this.parent.set(value, this.find(parent));
    return this.parent.get(value) ?? value;
  }
  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent.set(rootA, rootB);
  }
}

function levenshteinDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) rows[i]![0] = i;
  for (let j = 0; j <= b.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    rows[i]![j] = a[i - 1] === b[j - 1]
      ? rows[i - 1]![j - 1]!
      : 1 + Math.min(rows[i - 1]![j]!, rows[i]![j - 1]!, rows[i - 1]![j - 1]!);
  }
  return rows[a.length]![b.length]!;
}

/** Source substring, edit-distance, and reading rules, unchanged. */
export function shouldClusterByString(termA: string, termB: string): boolean {
  if (termA.includes(termB) || termB.includes(termA)) {
    if (Math.abs(termA.length - termB.length) <= 3) return true;
  }
  const threshold = Math.min(Math.floor(Math.min(termA.length, termB.length) * 0.3), 2);
  return levenshteinDistance(termA, termB) <= threshold;
}

function shouldCluster(a: CandidateTerm, b: CandidateTerm): boolean {
  if (a.reading !== null && b.reading !== null && a.reading === b.reading) return true;
  return shouldClusterByString(a.term, b.term);
}

async function buildEmbeddingCache(candidates: CandidateTerm[], options: ClusterSimilarTermsOptions): Promise<Map<number, Float32Array> | null> {
  if (!options.embedding || !options.snapshot || !options.signal) return null;
  const vectors = new Map<number, Float32Array>();
  try {
    for (let offset = 0; offset < candidates.length; offset += 32) {
      if (options.signal.aborted) throw options.signal.reason ?? Object.assign(new Error("Term clustering was cancelled"), { code: "job_cancelled" });
      const batch = candidates.slice(offset, offset + 32);
      const result = await options.embedding.embed(batch.map((candidate) => candidate.term), options.snapshot, options.signal);
      if (result.vectors.length !== batch.length) return null;
      for (let index = 0; index < batch.length; index++) vectors.set(offset + index, Float32Array.from(result.vectors[index]!));
    }
    return vectors;
  } catch (error) {
    if (options.signal.aborted) throw error;
    // Source behavior: one embedding failure disables all semantic-only merges.
    return null;
  }
}

/** Port of source `clusterSimilarTerms`; semantic similarity stays explicitly opt-in. */
export async function clusterSimilarTerms(candidates: CandidateTerm[], options: ClusterSimilarTermsOptions = {}): Promise<TermCluster[]> {
  if (candidates.length === 0) return [];
  const union = new UnionFind();
  const unstringedPairs: Array<[number, number]> = [];
  const semanticEdges = new Set<string>();
  for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
    if (shouldCluster(candidates[i]!, candidates[j]!)) union.union(i, j);
    else unstringedPairs.push([i, j]);
  }
  if (options.useEmbedding) {
    const cache = await buildEmbeddingCache(candidates, options);
    if (cache) for (const [i, j] of unstringedPairs) {
      const left = cache.get(i);
      const right = cache.get(j);
      if (left && right && cosineSimilarityDense(left, right) >= EMBEDDING_SIMILARITY_THRESHOLD) {
        union.union(i, j);
        semanticEdges.add(`${i}-${j}`);
      }
    }
  }
  const clusters = new Map<number, number[]>();
  for (let index = 0; index < candidates.length; index++) {
    const root = union.find(index);
    const indices = clusters.get(root) ?? [];
    indices.push(index);
    clusters.set(root, indices);
  }
  const semanticRoots = new Set<number>();
  for (const edge of semanticEdges) semanticRoots.add(union.find(Number(edge.split("-")[0])));
  const result: TermCluster[] = [];
  for (const [root, indices] of clusters) {
    if (indices.length < 2) continue;
    let canonical = indices[0]!;
    for (const index of indices.slice(1)) {
      const current = candidates[canonical]!;
      const candidate = candidates[index]!;
      if (candidate.occurrenceCount > current.occurrenceCount ||
          (candidate.occurrenceCount === current.occurrenceCount && candidate.sourceEntityIds.length > current.sourceEntityIds.length) ||
          (candidate.occurrenceCount === current.occurrenceCount && candidate.sourceEntityIds.length === current.sourceEntityIds.length && candidate.term.length < current.term.length)) canonical = index;
    }
    const cluster: TermCluster = { canonical: candidates[canonical]!.term, variants: indices.filter((index) => index !== canonical).map((index) => candidates[index]!.term) };
    if (semanticRoots.has(root)) cluster.semanticOnly = true;
    result.push(cluster);
  }
  return result;
}
