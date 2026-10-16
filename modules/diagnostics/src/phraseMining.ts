import type { Token } from "@scriptorium/module-nlp";
import { tokenBase } from "@scriptorium/module-nlp";
import {
  isAdverb,
  isAuxiliaryVerb,
  isNoun,
  isParticle,
  isSymbol,
  isVerb,
} from "@scriptorium/module-nlp";

/** 検知した頻出フレーズ1件分。 */
export interface FrequentPhrase {
  /** 表示用フレーズ（最頻 surface 形の連結）。 */
  phrase: string;
  /** 出現回数。 */
  count: number;
  /** 出現した文の番号（1始まり、splitIntoSentences と同じ分割基準）。 */
  sentenceIndices: number[];
}

/** 報告対象とする出現回数の下限。 */
export const MIN_PHRASE_OCCURRENCE = 3;

/** 報告する頻出フレーズの最大件数。 */
export const MAX_FREQUENT_PHRASES = 30;

/** n-gram の最小/最大トークン数。 */
const MIN_N = 2;
const MAX_N = 6;

/** 自立語とみなす品詞か。 */
function isContentToken(t: Token): boolean {
  // TODO: isAdjective also matches 形容動詞; keep 形容詞-only for behavior parity
  return isNoun(t) || isVerb(t) || t.pos === "形容詞" || isAdverb(t);
}

/** n-gram の先頭・末尾に許可しない品詞か（助詞・助動詞・記号）。 */
function isEdgeExcluded(t: Token): boolean {
  return isParticle(t) || isAuxiliaryVerb(t) || isSymbol(t);
}

/** n-gram が集計対象として有効かどうかを判定する。 */
function isEligibleNgram(tokens: Token[]): boolean {
  if (tokens.some(isSymbol)) return false;
  if (!tokens.some(isContentToken)) return false;
  if (isEdgeExcluded(tokens[0])) return false;
  if (isEdgeExcluded(tokens[tokens.length - 1])) return false;
  return true;
}

interface PhraseAccumulator {
  count: number;
  sentenceIndices: number[];
  surfaceCounts: Map<string, number>;
}

/**
 * 文単位の事前トークン列から繰り返しフレーズ（形態素 n-gram）を検出する。
 * 再 tokenize は行わない（SentenceSpan.tokens 等のスライスをそのまま使う）。
 */
export function mineFrequentPhrases(
  sentences: ReadonlyArray<{ tokens: Token[] }>,
): FrequentPhrase[] {
  const accumulators = new Map<string, PhraseAccumulator>();

  for (let i = 0; i < sentences.length; i++) {
    const sentenceIndex = i + 1; // 1始まり
    const tokens = sentences[i].tokens;

    for (let n = MIN_N; n <= MAX_N; n++) {
      for (let start = 0; start + n <= tokens.length; start++) {
        const ngram = tokens.slice(start, start + n);
        if (!isEligibleNgram(ngram)) continue;

        const key = ngram.map(tokenBase).join("");
        const surface = ngram.map((t) => t.surface).join("");

        let acc = accumulators.get(key);
        if (!acc) {
          acc = { count: 0, sentenceIndices: [], surfaceCounts: new Map() };
          accumulators.set(key, acc);
        }
        acc.count++;
        if (acc.sentenceIndices[acc.sentenceIndices.length - 1] !== sentenceIndex) {
          acc.sentenceIndices.push(sentenceIndex);
        }
        acc.surfaceCounts.set(surface, (acc.surfaceCounts.get(surface) ?? 0) + 1);
      }
    }
  }

  const candidates = [...accumulators.entries()]
    .filter(([, acc]) => acc.count >= MIN_PHRASE_OCCURRENCE)
    .map(([key, acc]) => {
      let bestSurface = "";
      let bestSurfaceCount = -1;
      for (const [surface, surfaceCount] of acc.surfaceCounts) {
        if (surfaceCount > bestSurfaceCount) {
          bestSurface = surface;
          bestSurfaceCount = surfaceCount;
        }
      }
      return {
        key,
        phrase: bestSurface,
        count: acc.count,
        sentenceIndices: acc.sentenceIndices,
      };
    });

  const kept = removeSubsumed(candidates);

  return kept
    .sort((a, b) => b.count - a.count || a.phrase.localeCompare(b.phrase, "ja"))
    .slice(0, MAX_FREQUENT_PHRASES)
    .map(({ phrase, count, sentenceIndices }) => ({ phrase, count, sentenceIndices }));
}

interface PhraseCandidate {
  key: string;
  phrase: string;
  count: number;
  sentenceIndices: number[];
}

/**
 * 包摂除去: n-gram A が n-gram B の部分列（キー文字列が包含関係）で count が同じ場合、
 * 短い方 A を落とし長い方 B のみ残す。
 */
function removeSubsumed(candidates: PhraseCandidate[]): PhraseCandidate[] {
  const dropped = new Set<number>();

  for (let i = 0; i < candidates.length; i++) {
    if (dropped.has(i)) continue;
    for (let j = 0; j < candidates.length; j++) {
      if (i === j || dropped.has(j)) continue;
      const a = candidates[i];
      const b = candidates[j];
      if (a.count !== b.count) continue;
      if (a.key.length >= b.key.length) continue;
      if (b.key.includes(a.key)) {
        dropped.add(i);
        break;
      }
    }
  }

  return candidates.filter((_, idx) => !dropped.has(idx));
}
