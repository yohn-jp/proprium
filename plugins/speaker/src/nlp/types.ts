export interface Token {
  surface: string;
  pos: string;
  posDetail?: string[];
  baseForm?: string;
  normalizedForm?: string;
  reading?: string;
  start: number;
  end: number;
}

export interface Tokenizer {
  tokenize(text: string): Token[];
}
