import type { Token } from "@scriptorium/module-nlp";
import { tokenBase, isAdjective, isAdverb, isNoun, isVerb } from "@scriptorium/module-nlp";

/** 内容語（名詞・動詞・形容詞・副詞）か。nlp/stylometry/metrics.ts と同一方針。 */
function isContentWord(t: Token): boolean {
  return isNoun(t) || isVerb(t) || isAdjective(t) || isAdverb(t);
}

/** トークン列から内容語（名詞・動詞・形容詞・副詞）の出現頻度ベクトルを構築する。
 *  特定語彙に依存しない汎用ベクトル化（bag-of-words）。 */
export function computeContentWordVector(tokens: Token[]): Map<string, number> {
  const vector = new Map<string, number>();
  for (const token of tokens) {
    if (!isContentWord(token)) continue;
    const base = tokenBase(token);
    vector.set(base, (vector.get(base) ?? 0) + 1);
  }
  return vector;
}

/** 2つの疎頻度ベクトルのコサイン類似度を算出する。どちらかが空、またはノルムが0なら0。 */
export function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;

  let dot = 0;
  for (const [term, weightA] of a) {
    const weightB = b.get(term);
    if (weightB !== undefined) dot += weightA * weightB;
  }

  const normA = Math.sqrt([...a.values()].reduce((sum, v) => sum + v * v, 0));
  const normB = Math.sqrt([...b.values()].reduce((sum, v) => sum + v * v, 0));
  if (normA === 0 || normB === 0) return 0;

  return dot / (normA * normB);
}
