import type { Token } from "@scriptorium/module-nlp";
import { tokenBase } from "@scriptorium/module-nlp";
import type { ToneLexiconConfig, ToneVector } from "./types.js";

/**
 * 形態素解析結果から、各トーンクラスの特徴語出現密度（トーンベクトル）を算出する。
 * 密度 = そのクラスの特徴語に一致したトークンの重み合計 / 総トークン数。
 * 特徴語との一致判定はトークンの基本形を優先し、無ければ表層形で行う
 * （未知語で基本形が確定しない語彙も拾えるようにするため）。
 */
export function computeToneVector(tokens: Token[], lexicon: ToneLexiconConfig): ToneVector {
  const toneClasses = Object.keys(lexicon.tones);
  const vector: ToneVector = {};
  for (const toneClass of toneClasses) vector[toneClass] = 0;
  if (tokens.length === 0) return vector;

  for (const token of tokens) {
    const base = tokenBase(token);
    for (const toneClass of toneClasses) {
      const weights = lexicon.tones[toneClass];
      const weight = weights[base] ?? weights[token.surface];
      if (weight !== undefined) {
        vector[toneClass] += weight;
      }
    }
  }

  for (const toneClass of toneClasses) {
    vector[toneClass] /= tokens.length;
  }

  return vector;
}
