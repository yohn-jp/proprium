import sentimentLexicon from "./data/sentimentLexicon.json" with { type: "json" };
import type { Token } from "@scriptorium/module-nlp";
import { tokenBase } from "@scriptorium/module-nlp";
import { isDialogue } from "./textAnalysis.js";

/** 感情アーク上の1文分のスコア。 */
export interface SentimentPoint {
  /** 文番号（1始まり、splitIntoSentencesと同じ基準）。 */
  sentenceIndex: number;
  /** その文の生スコア（辞書照合合算、否定反転・程度ブースト適用後）。 */
  raw: number;
  /** 移動平均（窓幅5文）による平滑化スコア。 */
  smoothed: number;
  /** セリフ（鉤括弧で始まる文）かどうか。 */
  isDialogue: boolean;
  /** 文の原文（ツールチップ表示用）。 */
  text: string;
}

/** 原稿全体の感情曲線（感情アーク）。 */
export interface SentimentArc {
  points: SentimentPoint[];
  /** 全文の平均スコア。 */
  mean: number;
  /** 最も負に振れた文番号（無ければnull）。 */
  minIndex: number | null;
  /** 最も正に振れた文番号（無ければnull）。 */
  maxIndex: number | null;
}

/** 否定表現とみなす基本形。 */
const NEGATION_BASIC_FORMS = new Set(["ない", "ぬ", "ん", "ず"]);

/** 程度ブーストの対象とする副詞（基本形）。 */
const DEGREE_ADVERBS = new Set([
  "とても",
  "非常",
  "ひどく",
  "実に",
  "あまりに",
  "すごく",
  "かなり",
  "極めて",
  "本当に",
]);

/** 程度ブーストの倍率。 */
const DEGREE_BOOST_FACTOR = 1.5;

/** 程度副詞を探索する直前トークン数。 */
const DEGREE_LOOKBACK = 2;

/** 平滑化の移動平均窓幅（前後2文＋自身の5文）。 */
const SMOOTHING_RADIUS = 2;

const sentimentLexiconMap = new Map(Object.entries((sentimentLexicon as { entries: Record<string, number> }).entries));

/**
 * 1文分のトークン列から極性スコアを算出する。
 * 簡易実装: 極性語を見つけたら保留し、文末まで走査して否定表現が
 * 現れればそのスコアを反転して加算する。係り受け解析は行わない
 * 単純なスコープ判定であり、文全体を対象に「後方に否定があるか」を見るのみ。
 */
function scoreSentence(tokens: Token[], lexicon: Map<string, number>): number {
  let total = 0;

  for (let i = 0; i < tokens.length; i++) {
    const base = tokenBase(tokens[i]);
    const polarity = lexicon.get(base);
    if (polarity === undefined) continue;

    let score = polarity;

    // 程度ブースト: 直前2トークン以内に程度副詞があれば1.5倍。
    for (let back = 1; back <= DEGREE_LOOKBACK && i - back >= 0; back++) {
      if (DEGREE_ADVERBS.has(tokenBase(tokens[i - back]))) {
        score *= DEGREE_BOOST_FACTOR;
        break;
      }
    }

    // 否定反転: 極性語より後方（同一文内）に否定表現が現れれば反転する。
    for (let fwd = i + 1; fwd < tokens.length; fwd++) {
      if (NEGATION_BASIC_FORMS.has(tokenBase(tokens[fwd]))) {
        score = -score;
        break;
      }
    }

    total += score;
  }

  return total;
}

/**
 * 文単位の感情スコア列から、窓幅5文（前後2文＋自身）の移動平均を計算する。
 * 端は存在する範囲での平均。
 */
function smoothScores(raws: number[]): number[] {
  return raws.map((_, i) => {
    const start = Math.max(0, i - SMOOTHING_RADIUS);
    const end = Math.min(raws.length - 1, i + SMOOTHING_RADIUS);
    let sum = 0;
    for (let j = start; j <= end; j++) sum += raws[j];
    return sum / (end - start + 1);
  });
}

/** 文単位の事前トークン列から原稿全体の感情アーク（文単位スコアと平滑化曲線）を算出する。 */
export function computeSentimentArc(
  sentences: ReadonlyArray<{ text: string; tokens: Token[] }>,
): SentimentArc {
  const lexicon = sentimentLexiconMap;

  const raws = sentences.map((sentence) => {
    if (sentence.text.trim().length === 0) return 0;
    return scoreSentence(sentence.tokens, lexicon);
  });

  const smoothed = smoothScores(raws);

  const points: SentimentPoint[] = raws.map((raw, i) => ({
    sentenceIndex: i + 1,
    raw,
    smoothed: smoothed[i],
    isDialogue: isDialogue(sentences[i].text),
    text: sentences[i].text,
  }));

  const mean = raws.length > 0 ? raws.reduce((sum, v) => sum + v, 0) / raws.length : 0;

  let minIndex: number | null = null;
  let maxIndex: number | null = null;
  let minValue = Infinity;
  let maxValue = -Infinity;
  for (const point of points) {
    if (point.raw < minValue) {
      minValue = point.raw;
      minIndex = point.sentenceIndex;
    }
    if (point.raw > maxValue) {
      maxValue = point.raw;
      maxIndex = point.sentenceIndex;
    }
  }

  return { points, mean, minIndex, maxIndex };
}
