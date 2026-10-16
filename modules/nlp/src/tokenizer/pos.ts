import type { MorphToken, Token } from "./types.js";
import { tokenPosDetail1 } from "./types.js";

/** IPADIC 品詞文字列。このファイル以外に直結合しない。 */
const POS_NOUN = "名詞";
const POS_VERB = "動詞";
const POS_ADJECTIVE = "形容詞";
const POS_ADJECTIVAL_NOUN = "形容動詞";
const POS_ADVERB = "副詞";
const POS_PARTICLE = "助詞";
const POS_AUXILIARY = "助動詞";
const POS_SYMBOL = "記号";
const POS_UNKNOWN = "未知語";

const DETAIL_PRONOUN = "代名詞";
const DETAIL_PROPER_NOUN = "固有名詞";
const DETAIL_NUMERAL = "数";
const DETAIL_FINAL_PARTICLE = "終助詞";
const DETAIL_COMMA = "読点";

const FORM_TA_CONJUNCTIVE = "連用タ接続";

export function isNoun(t: Token): boolean {
  return t.pos === POS_NOUN;
}

/** 名詞かつ細分類が代名詞（speaker 系の慣用）。 */
export function isPronoun(t: Token): boolean {
  return isNoun(t) && tokenPosDetail1(t) === DETAIL_PRONOUN;
}

export function isProperNoun(t: Token): boolean {
  return tokenPosDetail1(t) === DETAIL_PROPER_NOUN;
}

export function isNumeral(t: Token): boolean {
  return tokenPosDetail1(t) === DETAIL_NUMERAL;
}

export function isVerb(t: Token): boolean {
  return t.pos === POS_VERB;
}

/** 形容詞または形容動詞（proseBalance の慣用）。 */
export function isAdjective(t: Token): boolean {
  return t.pos === POS_ADJECTIVE || t.pos === POS_ADJECTIVAL_NOUN;
}

export function isAdverb(t: Token): boolean {
  return t.pos === POS_ADVERB;
}

export function isParticle(t: Token): boolean {
  return t.pos === POS_PARTICLE;
}

/** 助詞かつ品詞細分類に終助詞を含む。 */
export function isFinalParticle(t: Token): boolean {
  return isParticle(t) && (t.posDetail ?? []).includes(DETAIL_FINAL_PARTICLE);
}

export function isAuxiliaryVerb(t: Token): boolean {
  return t.pos === POS_AUXILIARY;
}

export function isSymbol(t: Token): boolean {
  return t.pos === POS_SYMBOL;
}

/** 記号かつ細分類第1が読点。 */
export function isComma(t: Token): boolean {
  return isSymbol(t) && tokenPosDetail1(t) === DETAIL_COMMA;
}

export function isUnknown(t: Token): boolean {
  return t.pos === POS_UNKNOWN;
}

/** 動詞かつ活用形が連用タ接続（endingMorph 用）。 */
export function isTaConjunctive(t: MorphToken): boolean {
  return isVerb(t) && t.conjugatedForm === FORM_TA_CONJUNCTIVE;
}
