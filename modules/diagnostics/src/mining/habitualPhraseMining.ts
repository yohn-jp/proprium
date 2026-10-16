import { mineFrequentPhrases } from "../phraseMining.js";
import type { SentimentArc } from "../sentimentArc.js";
import type { Token } from "@scriptorium/module-nlp";
import type { HabitualPhraseWarning, SentimentContextBand } from "./types.js";

/**
 * 「強い」感情文脈とみなすスコアの絶対値の下限。
 * sentimentLexicon.json の極性値は [-1, 1] の範囲なので、強い極性語が1語でも
 * 現れれば到達する水準を汎用閾値として採用する（特定作品の語彙構成に依存しない）。
 */
const STRONG_CONTEXT_THRESHOLD = 0.5;

const BAND_LABEL: Record<SentimentContextBand, string> = {
  negative: "緊迫した（強い負の感情の）",
  positive: "高揚した（強い正の感情の）",
};

type SentenceWithTokens = { text: string; tokens: Token[] };

/** 指定帯域に属する文のみを、原文の文番号を保ったまま抽出する。 */
function selectBandSentences(
  sentences: ReadonlyArray<SentenceWithTokens>,
  raws: number[],
  band: SentimentContextBand,
): { spans: SentenceWithTokens[]; originalIndices: number[] } {
  const spans: SentenceWithTokens[] = [];
  const originalIndices: number[] = [];
  for (let i = 0; i < sentences.length; i++) {
    const raw = raws[i] ?? 0;
    const inBand =
      band === "negative" ? raw <= -STRONG_CONTEXT_THRESHOLD : raw >= STRONG_CONTEXT_THRESHOLD;
    if (!inBand) continue;
    spans.push(sentences[i]);
    originalIndices.push(i + 1); // 1始まり（splitIntoSentencesと同じ基準）
  }
  return { spans, originalIndices };
}

/** 指定帯域内の文だけを対象に頻出フレーズ検出を行い、原文の文番号に変換して返す。 */
function mineForBand(
  sentences: ReadonlyArray<SentenceWithTokens>,
  raws: number[],
  band: SentimentContextBand,
): HabitualPhraseWarning[] {
  const { spans, originalIndices } = selectBandSentences(sentences, raws, band);
  if (spans.length === 0) return [];

  const phrases = mineFrequentPhrases(spans);

  return phrases.map(({ phrase, count, sentenceIndices }) => ({
    band,
    phrase,
    count,
    sentenceIndices: sentenceIndices.map((idx) => originalIndices[idx - 1]),
    message: `${BAND_LABEL[band]}場面で「${phrase}」という表現が${count}回使い回されています。多様な言い回しを検討してください。`,
  }));
}

/**
 * 文単位の感情アーク（sentimentArc.ts）と頻出フレーズ検出（phraseMining.ts）を組み合わせ、
 * 強い感情文脈（負/正）でだけ使い回されている手癖表現を検出する。
 *
 * 「緊迫した場面ではいつも『息を呑んだ』を使う」といった、特定の感情文脈に紐づいた
 * ワンパターン表現をあぶり出し、多様な表現を促すのが目的。
 * 全文を対象にした一般的な頻出フレーズ検出（mineFrequentPhrases単体）とは異なり、
 * 感情スコアが弱い/中立な文中の同一フレーズは対象外になる。
 */
export function mineContextualHabitualPhrases(
  sentences: ReadonlyArray<SentenceWithTokens>,
  arc: SentimentArc,
): HabitualPhraseWarning[] {
  const raws = arc.points.map((p) => p.raw);

  const negative = mineForBand(sentences, raws, "negative");
  const positive = mineForBand(sentences, raws, "positive");

  return [...negative, ...positive].sort(
    (a, b) => b.count - a.count || a.phrase.localeCompare(b.phrase, "ja"),
  );
}
