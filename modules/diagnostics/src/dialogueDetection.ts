/** 文が会話文（セリフ）かどうかの判定。textAnalysis と linter の両方から参照する共有ユーティリティ。 */

/** セリフ文（鉤括弧・二重鉤括弧で始まる文）の判定。 */
export const DIALOGUE_RE = /^[「『]/;

/** 文がセリフ（会話文）かどうかを判定する。地の文リズム判定の対象から除外するために使う。 */
export function isDialogue(sentence: string): boolean {
  return DIALOGUE_RE.test(sentence.trim());
}
