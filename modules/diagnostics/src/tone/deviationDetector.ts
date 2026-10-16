import type { Token } from "@scriptorium/module-nlp";
import { computeToneVector } from "./toneVector.js";
import type { ToneDeviationWarning, ToneLexiconConfig, ToneVector } from "./types.js";

/** トーンベクトル中で密度が最も高いトーンクラスを返す。全クラス密度0ならnull（判定不能）。 */
function findDominantTone(vector: ToneVector): string | null {
  let dominant: string | null = null;
  let maxDensity = 0;
  for (const [toneClass, density] of Object.entries(vector)) {
    if (density > maxDensity) {
      maxDensity = density;
      dominant = toneClass;
    }
  }
  return dominant;
}

/**
 * 本文の形態素解析結果とシーンの演出意図（intended_tone）から、トーン乖離を検知する。
 * 本文トーンベクトルの最高密度成分（dominantTone）が intended_tone と異なる場合に警告を返す。
 *
 * 以下の場合は判定不能として null を返す（誤検知回避）:
 * - intended_tone が語彙側に定義されていないトーンクラス名
 * - 本文中に語彙のどの特徴語も一つも出現しない（トーンベクトルが全クラス0）
 */
export function detectToneDeviation(
  tokens: Token[],
  lexicon: ToneLexiconConfig,
  intendedTone: string,
): ToneDeviationWarning | null {
  if (!(intendedTone in lexicon.tones)) return null;

  const toneVector = computeToneVector(tokens, lexicon);
  const dominantTone = findDominantTone(toneVector);
  if (dominantTone === null || dominantTone === intendedTone) return null;

  return {
    intendedTone,
    dominantTone,
    toneVector,
    message: `演出意図のトーン「${intendedTone}」に対し、本文は「${dominantTone}」のトーン語彙が優勢です。`,
  };
}
