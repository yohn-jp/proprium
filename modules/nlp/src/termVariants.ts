import { UnionFind } from "./utils/disjointSet.js";

export interface TermVariantSuggestion { candidate: string; canonical: string; count: number }

function levenshteinDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) rows[i][0] = i;
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    rows[i][j] = a[i - 1] === b[j - 1] ? rows[i - 1][j - 1] : 1 + Math.min(rows[i - 1][j], rows[i][j - 1], rows[i - 1][j - 1]);
  }
  return rows[a.length][b.length];
}

/** Source string-clustering rules: near substrings or short edit-distance variants. */
export function shouldClusterByString(termA: string, termB: string): boolean {
  if (termA.includes(termB) || termB.includes(termA)) {
    if (Math.abs(termA.length - termB.length) <= 3) return true;
  }
  const threshold = Math.min(Math.floor(Math.min(termA.length, termB.length) * 0.3), 2);
  return levenshteinDistance(termA, termB) <= threshold;
}

export function suggestTermVariants(
  unknownTermCandidates: Array<{ term: string; count: number }>,
  knownTerms: Set<string>,
): TermVariantSuggestion[] {
  const known = [...knownTerms];
  const result: TermVariantSuggestion[] = [];
  const matched = new Set<number>();
  for (let i = 0; i < unknownTermCandidates.length; i++) {
    const item = unknownTermCandidates[i];
    const canonical = known.find((term) => shouldClusterByString(item.term, term));
    if (canonical !== undefined) {
      matched.add(i);
      if (canonical !== item.term) result.push({ candidate: item.term, canonical, count: item.count });
    }
  }
  const remaining = unknownTermCandidates.map((_, i) => i).filter((i) => !matched.has(i));
  const union = new UnionFind();
  for (let a = 0; a < remaining.length; a++) for (let b = a + 1; b < remaining.length; b++) {
    const i = remaining[a]; const j = remaining[b];
    if (shouldClusterByString(unknownTermCandidates[i].term, unknownTermCandidates[j].term)) union.union(i, j);
  }
  const clusters = new Map<number, number[]>();
  for (const index of remaining) {
    const root = union.find(index);
    const group = clusters.get(root) ?? [];
    group.push(index);
    clusters.set(root, group);
  }
  for (const indices of clusters.values()) {
    if (indices.length < 2) continue;
    let canonicalIndex = indices[0];
    for (const index of indices.slice(1)) if (unknownTermCandidates[index].count > unknownTermCandidates[canonicalIndex].count) canonicalIndex = index;
    for (const index of indices) if (index !== canonicalIndex) result.push({
      candidate: unknownTermCandidates[index].term,
      canonical: unknownTermCandidates[canonicalIndex].term,
      count: unknownTermCandidates[index].count,
    });
  }
  return result;
}
