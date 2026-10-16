/**
 * Lindera WASM (IPADIC) アダプタ。
 * エンジン出力を MorphToken に写像し、byte→文字オフセット変換と UNK POS 補正を行う。
 * 根拠文書は散逸（参照先 wasm-engine-evaluation.md / nlp-module-design.md は
 * git 履歴上も存在せず復元不可）。選定根拠の一次情報は失われている。
 */

import { TokenizerBuilder } from "lindera-wasm-nodejs-ipadic";
import type { MorphToken, Token, Tokenizer } from "./types.js";

/** lindera-wasm-nodejs-ipadic の tokenize 1 要素（camelCase）。 */
interface LinderaRawToken {
  surface: string;
  partOfSpeech: string;
  partOfSpeechSubcategory1?: string;
  partOfSpeechSubcategory2?: string;
  partOfSpeechSubcategory3?: string;
  baseForm?: string;
  reading?: string;
  /** Lindera 側の命名。値は IPADIC の活用型（五段・…）が入る。 */
  conjugationForm?: string;
  /** Lindera 側の命名。値は IPADIC の活用形（連用タ接続 等）が入る。 */
  conjugationType?: string;
  byteStart: number;
  byteEnd: number;
}

let adapterPromise: Promise<Tokenizer> | null = null;

function starToUndef(value: string | undefined): string | undefined {
  if (!value || value === "*") return undefined;
  return value;
}

/**
 * UTF-8 byte オフセット → JS 文字列インデックス（UTF-16 code unit）の対応表。
 * 決定的な 1 パス。サロゲートペアは code point 単位で進める。
 */
function buildByteToCharMap(text: string): Map<number, number> {
  const map = new Map<number, number>();
  let bytePos = 0;
  map.set(0, 0);
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i);
    if (cp === undefined) break;
    const units = cp > 0xffff ? 2 : 1;
    bytePos += Buffer.byteLength(text.slice(i, i + units), "utf8");
    i += units;
    map.set(bytePos, i);
  }
  return map;
}

function byteToChar(map: Map<number, number>, byteOffset: number, label: string): number {
  const idx = map.get(byteOffset);
  if (idx === undefined) {
    throw new Error(`linderaAdapter: missing char index for byte ${byteOffset} (${label})`);
  }
  return idx;
}

/**
 * IPADIC unk.def 相当の文字種判定で UNK を補正する。
 * カタカナ→名詞/一般、ラテン→名詞/固有名詞、数字→名詞/数。
 */
export function correctUnkPos(surface: string): { pos: string; posDetail: string[] } {
  if (/^[\u30A0-\u30FFー゛゜]+$/u.test(surface)) {
    return { pos: "名詞", posDetail: ["一般"] };
  }
  if (/^[A-Za-z]+$/u.test(surface)) {
    return { pos: "名詞", posDetail: ["固有名詞"] };
  }
  if (/^[0-9０-９]+$/u.test(surface)) {
    return { pos: "名詞", posDetail: ["数"] };
  }
  return { pos: "名詞", posDetail: ["一般"] };
}

function mapLinderaTokens(text: string, raw: LinderaRawToken[]): MorphToken[] {
  const byteToCharMap = buildByteToCharMap(text);
  const tokens: MorphToken[] = [];

  for (const f of raw) {
    const surface = f.surface;
    const start = byteToChar(byteToCharMap, f.byteStart, surface);
    const end = byteToChar(byteToCharMap, f.byteEnd, surface);

    let pos = f.partOfSpeech;
    let posDetail = [
      f.partOfSpeechSubcategory1,
      f.partOfSpeechSubcategory2,
      f.partOfSpeechSubcategory3,
    ].filter((d): d is string => Boolean(d) && d !== "*");

    if (pos === "UNK") {
      const corrected = correctUnkPos(surface);
      pos = corrected.pos;
      posDetail = corrected.posDetail;
    }

    const baseForm = !f.baseForm || f.baseForm === "*" ? surface : f.baseForm;
    const reading = starToUndef(f.reading);

    // Lindera は conjugationForm/Type の命名が IPADIC 活用型/形と逆。
    // MorphToken は kuromoji 互換（conjugatedType=活用型、conjugatedForm=活用形）に揃える。
    const conjugatedType = starToUndef(f.conjugationForm);
    const conjugatedForm = starToUndef(f.conjugationType);

    tokens.push({
      surface,
      pos,
      posDetail: posDetail.length > 0 ? posDetail : undefined,
      baseForm,
      normalizedForm: surface,
      reading,
      start,
      end,
      conjugatedType,
      conjugatedForm,
    });
  }
  return tokens;
}

function wrapLindera(raw: { tokenize(text: string): unknown }): Tokenizer {
  return {
    tokenize(text: string): Token[] {
      const features = raw.tokenize(text) as LinderaRawToken[];
      return mapLinderaTokens(text, features);
    },
  };
}

/** Lindera WASM ベースの Tokenizer を初期化する（シングルトン）。 */
export function getLinderaTokenizer(): Promise<Tokenizer> {
  if (!adapterPromise) {
    adapterPromise = Promise.resolve().then(() => {
      const builder = new TokenizerBuilder();
      builder.setDictionary("embedded://ipadic");
      builder.setMode("normal");
      return wrapLindera(builder.build());
    });
  }
  return adapterPromise;
}

/** テスト用: キャッシュをクリアする。 */
export function resetLinderaTokenizerCacheForTests(): void {
  adapterPromise = null;
}
