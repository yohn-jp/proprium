/** 共通トークン型（WP-N1）。 */
export interface Token {
  surface: string;
  pos: string; // 品詞
  posDetail?: string[]; // 品詞細分類
  baseForm?: string; // 活用の基本形
  normalizedForm?: string; // 表記正規化形（Lindera アダプタでは surface と同一）
  reading?: string;
  start: number; // 文字オフセット
  end: number;
}

export interface Tokenizer {
  tokenize(text: string): Token[];
}

/**
 * 活用情報（surface / pos / 活用 / 正規化形 / 読み）。
 * WP-N1 の Token 本体には未掲載のため、アダプタが付随させる交差型として扱う。
 */
export interface TokenMorphExtras {
  conjugatedType?: string;
  conjugatedForm?: string;
}

export type MorphToken = Token & TokenMorphExtras;

/** 基本形（未設定時は表層形）。IPADIC `basic_form === "*"` 相当の解決済み値を想定。 */
export function tokenBase(token: Token): string {
  return token.baseForm ?? token.surface;
}

/** 品詞細分類の第1要素（旧 `pos_detail_1`）。 */
export function tokenPosDetail1(token: Token): string {
  return token.posDetail?.[0] ?? "";
}

/** 文分割と全文トークン列を1回の解析で束ねた結果。消費側の基本入力。 */
export interface MorphologyAnalysis {
  text: string;
  tokens: MorphToken[]; // 全文トークン。start/end は文字オフセット（バイトではない）
  sentences: SentenceSpan[]; // splitIntoSentenceOffsets と統合した文スパン
  tree?: SyntaxTree; // 係り受け（S-3 採用時のみ供給される optional 契約）
}

export interface SentenceSpan {
  start: number;
  end: number;
  text: string;
  tokens: MorphToken[]; // 全文 tokens のスライス（再 tokenize しない）
}

/** 係り受けプレースホルダ。S-3 スパイクの採否まで実装を持たない。 */
export interface SyntaxTree {
  sentences: SentenceParse[];
}

export interface SentenceParse {
  bunsetsu: Bunsetsu[];
  rootIndex: number;
}

export interface Bunsetsu {
  tokenIndexes: number[]; // MorphologyAnalysis.tokens への添字
  headIndex: number; // 係り先文節（bunsetsu 配列内添字、root は -1）
  label?: string; // 依存関係ラベル（エンジン依存、optional）
}
