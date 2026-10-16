/**
 * コンテキスト依存の手癖表現マイニングの型定義。
 * sentimentArc.ts が出力する文単位の感情極性スコアと、phraseMining.ts の
 * 頻出フレーズ（形態素n-gram）検出を組み合わせ、「強い感情文脈（緊迫した/高揚した場面）
 * になるといつも同じ表現を使い回している」という、コンテキストに紐づいた手癖を検出する。
 */

/** 強い感情文脈とみなす極性帯域。 */
export type SentimentContextBand = "negative" | "positive";

/** 特定の感情文脈帯域で使い回されている手癖フレーズの警告1件分。 */
export interface HabitualPhraseWarning {
  /** 検出された感情文脈帯域（negative: 緊迫した場面 / positive: 高揚した場面）。 */
  band: SentimentContextBand;
  /** 使い回されているフレーズ（表示用 surface 形）。 */
  phrase: string;
  /** その帯域内での出現回数。 */
  count: number;
  /** 出現した文番号（1始まり、splitIntoSentencesと同じ基準）。 */
  sentenceIndices: number[];
  message: string;
}
