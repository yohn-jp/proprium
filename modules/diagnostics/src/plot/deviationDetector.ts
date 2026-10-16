import type { Token } from "@scriptorium/module-nlp";
import {
  computeArchetypeVector,
  computeWeightedDensity,
  findDominantArchetype,
} from "./plotVector.js";
import { computeContentWordVector, cosineSimilarity } from "./semanticSimilarity.js";
import type { PlotLexiconConfig, PlotSemanticWarning } from "./types.js";

/** divergence判定を行うために goal/conflict 側に必要な最低内容語数。
 *  短すぎる（例: 一言のみの）goal/conflictでは類似度が不安定なため判定を見送る。 */
const MIN_GOAL_CONTENT_WORDS = 3;

/** divergence警告を出すコサイン類似度の閾値。これ未満なら「本文で目的の語彙がほぼ扱われていない」とみなす。 */
const DIVERGENCE_SIMILARITY_THRESHOLD = 0.05;

/** アーキタイプ側でviolationThresholdが未指定の場合に使う既定の矛盾語彙密度閾値。 */
const DEFAULT_VIOLATION_THRESHOLD = 0.03;

/**
 * シーンのgoal/conflict文（自然言語）と本文の叙述から、プロットの意味的な乖離・矛盾を検知する。
 *
 * 2種類の警告を独立に判定し、両方成立すれば両方返す:
 *
 * 1. contradiction: goal/conflictが語彙上あるアーキタイプ（例: concealment=隠す・秘匿）に
 *    分類でき、かつそのアーキタイプの矛盾語彙（violationKeywords。例: 正体・真相・種明かし等の
 *    解説・暴露語彙）が本文中に閾値以上の密度で検出された場合。
 * 2. divergence: goal/conflictの内容語彙（名詞・動詞・形容詞・副詞）が本文の内容語彙と
 *    コサイン類似度で見てほぼ重ならない場合。目的が本文で扱われていない疑いを示す弱いシグナル。
 *
 * 誤検知回避のため、以下は判定不能として対応する警告を出さない:
 * - goal/conflictがどのアーキタイプの特徴語にも一つも一致しない -> contradiction判定不能
 * - 一致したアーキタイプにviolationKeywordsが定義されていない -> contradiction判定不能
 * - goal/conflict側の内容語が少なすぎる -> divergence判定不能
 */
export function detectPlotSemanticWarnings(
  goalTokens: Token[],
  bodyTokens: Token[],
  lexicon: PlotLexiconConfig,
): PlotSemanticWarning[] {
  const warnings: PlotSemanticWarning[] = [];

  const archetypeVector = computeArchetypeVector(goalTokens, lexicon);
  const dominantArchetype = findDominantArchetype(archetypeVector);
  if (dominantArchetype !== null) {
    const archetype = lexicon.archetypes[dominantArchetype];
    if (archetype.violationKeywords) {
      const violationDensity = computeWeightedDensity(bodyTokens, archetype.violationKeywords);
      const threshold = archetype.violationThreshold ?? DEFAULT_VIOLATION_THRESHOLD;
      if (violationDensity >= threshold) {
        warnings.push({
          kind: "contradiction",
          archetype: dominantArchetype,
          violationDensity,
          message: `シーンの目的（${dominantArchetype}系）に対し、本文に矛盾する語彙（解説・暴露系）が高密度（${violationDensity.toFixed(3)}）で検出されました。`,
        });
      }
    }
  }

  const goalContentVector = computeContentWordVector(goalTokens);
  if (goalContentVector.size >= MIN_GOAL_CONTENT_WORDS) {
    const bodyContentVector = computeContentWordVector(bodyTokens);
    const similarity = cosineSimilarity(goalContentVector, bodyContentVector);
    if (similarity < DIVERGENCE_SIMILARITY_THRESHOLD) {
      warnings.push({
        kind: "divergence",
        similarity,
        message: `シーンのgoal/conflictの語彙が本文とほぼ重なりません（類似度${similarity.toFixed(3)}）。目的が本文で扱われていない可能性があります。`,
      });
    }
  }

  return warnings;
}
