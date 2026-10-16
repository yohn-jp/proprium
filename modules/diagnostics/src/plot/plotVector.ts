import type { Token } from "@scriptorium/module-nlp";
import { tokenBase } from "@scriptorium/module-nlp";
import type { PlotLexiconConfig, PlotVector, PlotWordWeights } from "./types.js";

/**
 * トークン列から、指定の特徴語（基本形）→重みマップに対する加重出現密度を算出する。
 * 密度 = 一致したトークンの重み合計 / 総トークン数。
 * 特徴語との一致判定はトークンの基本形を優先し、無ければ表層形で行う。
 */
export function computeWeightedDensity(tokens: Token[], weights: PlotWordWeights): number {
  if (tokens.length === 0) return 0;
  let sum = 0;
  for (const token of tokens) {
    const base = tokenBase(token);
    const weight = weights[base] ?? weights[token.surface];
    if (weight !== undefined) sum += weight;
  }
  return sum / tokens.length;
}

/** トークン列（goal/conflict文）から、各アーキタイプのgoalKeywords出現密度
 *  （アーキタイプ分類用ベクトル）を算出する。 */
export function computeArchetypeVector(tokens: Token[], lexicon: PlotLexiconConfig): PlotVector {
  const vector: PlotVector = {};
  for (const [name, archetype] of Object.entries(lexicon.archetypes)) {
    vector[name] = computeWeightedDensity(tokens, archetype.goalKeywords);
  }
  return vector;
}

/** ベクトル中で密度が最も高いアーキタイプ名を返す。全アーキタイプ密度0ならnull（判定不能）。 */
export function findDominantArchetype(vector: PlotVector): string | null {
  let dominant: string | null = null;
  let maxDensity = 0;
  for (const [name, density] of Object.entries(vector)) {
    if (density > maxDensity) {
      maxDensity = density;
      dominant = name;
    }
  }
  return dominant;
}
