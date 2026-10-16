/** 文末表現（語尾）の抽出・正規化。textAnalysis（リズム検知）と linter（ending_repetition）の両方から参照する共有ユーティリティ。 */

/** 文末の句読点・記号（除去対象）。 */
const TRAILING_PUNCTUATION_RE = /[。！？」』]+$/;

/** 文から文末表現（末尾の句読点・記号を除いた末尾1文字）を抽出する。空文字はnullを返す。 */
export function extractEnding(sentence: string): string | null {
  const trimmed = sentence.replace(TRAILING_PUNCTUATION_RE, "").trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(-1);
}

/** 濁点・半濁点を清音に正規化する（例: "だ"→"た"）。「浮かんだ」「歩いた」のような
 *  音便由来の清濁差を同一の語尾リズムとして比較するために使う。 */
export function normalizeEnding(ending: string): string {
  return ending.normalize("NFD").replace(/[゙゚]/g, "").normalize("NFC");
}
