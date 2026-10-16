import type { Token } from "@scriptorium/module-nlp";
import { tokenBase, isAdjective, isAdverb, isComma, isNoun, isSymbol, isVerb } from "@scriptorium/module-nlp";
import type { PosBias, StylometricMetrics } from "./types.js";

/** 品詞バイアス判定で「偏向あり」とみなす形容詞比率と動詞比率の差の閾値。 */
const POS_BIAS_THRESHOLD = 0.15;

/** 内容語（品詞バイアス算出の分母）とみなすか。 */
function isContentWord(t: Token): boolean {
  return isNoun(t) || isVerb(t) || isAdjective(t) || isAdverb(t);
}

/** セリフ文字列から鉤括弧を除去する（styleFingerprint.ts の同名処理と同一仕様）。 */
function removeBrackets(text: string): string {
  return text.replace(/^[「『]|[」』]$/g, "").trim();
}

/**
 * 形態素解析済みトークン列（1発話分）から StylometricMetrics を算出する。
 * 空トークン列（発話が空文字列等）は全指標0を返す。
 */
export function computeDialogueMetrics(tokens: Token[]): StylometricMetrics {
  if (tokens.length === 0) {
    return {
      typeTokenRatio: 0,
      morphemeCount: 0,
      commaFrequency: 0,
      adjectiveRatio: 0,
      verbRatio: 0,
    };
  }

  const meaningful = tokens.filter((t) => !isSymbol(t));
  const typeSet = new Set(meaningful.map(tokenBase));
  const typeTokenRatio = meaningful.length > 0 ? typeSet.size / meaningful.length : 0;

  const commaCount = tokens.filter((t) => isComma(t)).length;
  const commaFrequency = commaCount / tokens.length;

  const contentWords = tokens.filter(isContentWord);
  const adjectiveCount = contentWords.filter((t) => isAdjective(t)).length;
  const verbCount = contentWords.filter((t) => isVerb(t)).length;
  const adjectiveRatio = contentWords.length > 0 ? adjectiveCount / contentWords.length : 0;
  const verbRatio = contentWords.length > 0 ? verbCount / contentWords.length : 0;

  return {
    typeTokenRatio,
    morphemeCount: tokens.length,
    commaFrequency,
    adjectiveRatio,
    verbRatio,
  };
}

/** セリフ文字列（鉤括弧含む）を形態素解析し、StylometricMetrics を算出するユーティリティ。 */
export function computeDialogueMetricsFromText(
  dialogue: string,
  tokenize: (text: string) => Token[],
): StylometricMetrics {
  const content = removeBrackets(dialogue);
  return computeDialogueMetrics(tokenize(content));
}

/** 形容詞比率と動詞比率の差から、品詞の選択偏向（形容詞主体 / 動詞主体 / 中立）を分類する。 */
export function classifyPosBias(metrics: StylometricMetrics): PosBias {
  const diff = metrics.adjectiveRatio - metrics.verbRatio;
  if (diff > POS_BIAS_THRESHOLD) return "adjective-dominant";
  if (diff < -POS_BIAS_THRESHOLD) return "verb-dominant";
  return "neutral";
}
