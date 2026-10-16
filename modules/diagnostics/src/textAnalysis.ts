import { extractCompoundNouns, isEligibleTerm, suggestTermVariants, splitIntoSentences, splitIntoSentenceOffsets } from "@scriptorium/module-nlp";
import { isDialogue } from "./dialogueDetection.js";
import { extractEnding, normalizeEnding } from "./sentenceEnding.js";

export { DIALOGUE_RE, isDialogue } from "./dialogueDetection.js";
export type { SentenceOffset } from "@scriptorium/module-nlp";
export { splitIntoSentenceOffsets, splitIntoSentences } from "@scriptorium/module-nlp";

import { evaluateLintRules } from "./linter/rulesEvaluator.js";
import type { LintRule, LintWarning } from "./linter/types.js";
import { DEFAULT_LINT_RULES } from "./linter/types.js";
import type { HabitualPhraseWarning } from "./mining/index.js";
import { mineContextualHabitualPhrases } from "./mining/index.js";
import type { MorphologyAnalysis } from "@scriptorium/module-nlp";
import { detectToneDeviation } from "./tone/deviationDetector.js";
import type { ToneDeviationWarning, ToneLexiconConfig } from "./tone/types.js";
import { DEFAULT_TONE_LEXICON } from "./tone/types.js";
import type { FrequentPhrase } from "./phraseMining.js";
import { mineFrequentPhrases } from "./phraseMining.js";
import type { SentimentArc } from "./sentimentArc.js";
import { computeSentimentArc } from "./sentimentArc.js";
import type { TermVariantSuggestion } from "@scriptorium/module-nlp";

export interface TextAnalysisResult {
  charCount: number;
  sentenceCount: number;
  frequentNouns: Array<{ term: string; count: number }>;
  unknownTermCandidates: Array<{ term: string; count: number }>;
  rhythmWarnings: RhythmWarning[];
  termVariantSuggestions: TermVariantSuggestion[];
  frequentPhrases: FrequentPhrase[];
  sentimentArc: SentimentArc;
  lintWarnings: LintWarning[];
  /** シーンの演出意図（intendedTone未指定時は常に空配列）とのトーン乖離警告。 */
  toneWarnings: ToneDeviationWarning[];
  /** 強い感情文脈（緊迫した/高揚した場面）で使い回されている手癖フレーズの警告。 */
  habitualPhraseWarnings: HabitualPhraseWarning[];
}

/** トーン乖離検知のオプション。intendedTone未指定時はチェック自体を行わない。 */
export interface ToneAnalysisOptions {
  lexicon?: ToneLexiconConfig;
  intendedTone?: string;
}

/** 文末表現（語尾）の連続を検知した結果。 */
export interface RhythmWarning {
  /** 連続していた文末表現（例: "た"）。 */
  ending: string;
  /** 連続した文の数。 */
  count: number;
  /** 連続の最初の文の番号（1始まり）。 */
  startSentenceIndex: number;
}

/** 頻出名詞として残す最大件数。 */
const MAX_FREQUENT_NOUNS = 30;

/** 頻出扱いとみなす出現回数の下限（1回だけの語はノイズが多い）。 */
const MIN_OCCURRENCE = 2;

/** 文末表現の連続をこの回数以上で検知する。 */
const RHYTHM_WARNING_THRESHOLD = 3;

function flushRhythmStreak(
  warnings: RhythmWarning[],
  ending: string | null,
  count: number,
  startIndex: number,
): void {
  if (count >= RHYTHM_WARNING_THRESHOLD && ending !== null) {
    warnings.push({
      ending,
      count,
      startSentenceIndex: startIndex,
    });
  }
}

/** 文末表現（語尾）の連続を検知し、3回以上連続した箇所を全て返す。 */
export function detectRhythmWarnings(text: string): RhythmWarning[] {
  const sentences = splitIntoSentences(text);
  const warnings: RhythmWarning[] = [];

  let currentEnding: string | null = null;
  let currentNormalized: string | null = null;
  let currentCount = 0;
  let currentStartIndex = 0;

  const resetStreak = () => {
    flushRhythmStreak(warnings, currentEnding, currentCount, currentStartIndex);
    currentEnding = null;
    currentNormalized = null;
    currentCount = 0;
    currentStartIndex = 0;
  };

  for (let i = 0; i < sentences.length; i++) {
    if (isDialogue(sentences[i])) {
      resetStreak();
      continue;
    }
    const ending = extractEnding(sentences[i]);
    if (ending === null) {
      resetStreak();
      continue;
    }
    const normalized = normalizeEnding(ending);

    if (normalized === currentNormalized) {
      currentCount++;
    } else {
      flushRhythmStreak(warnings, currentEnding, currentCount, currentStartIndex);
      currentEnding = ending;
      currentNormalized = normalized;
      currentCount = 1;
      currentStartIndex = i + 1; // 1始まりの文番号
    }
  }

  flushRhythmStreak(warnings, currentEnding, currentCount, currentStartIndex);
  return warnings;
}

/** analyzeText の追加オプション（呼び出し側で既に tokenize 済みの結果を再利用する等）。 */
export interface AnalyzeTextOptions {
  /** Diagnostics receives this from the shared NLP capability; it never loads another tokenizer. */
  precomputed: MorphologyAnalysis;
}

function resolveMorphology(text: string, options: AnalyzeTextOptions): MorphologyAnalysis {
  if (options.precomputed.text !== text) throw new TypeError("Precomputed morphology does not match the analyzed text");
  return options.precomputed;
}

/** 単一テキスト（執筆中の原稿本文）を形態素解析し、頻出名詞と未登録語候補を返す。
 *  lintRules未指定時は組み込みの既定ルール（DEFAULT_LINT_RULES）で組版バリデーションを行う。 */
export async function analyzeText(
  text: string,
  knownTerms: Set<string>,
  lintRules: LintRule[],
  toneOptions: ToneAnalysisOptions | undefined,
  options: AnalyzeTextOptions,
): Promise<TextAnalysisResult> {
  const morphology = resolveMorphology(text, options);
  const tokens = morphology.tokens;
  const sentences = morphology.sentences;
  const terms = extractCompoundNouns(tokens);

  const counts = new Map<string, number>();
  for (const term of terms) {
    if (!isEligibleTerm(term)) continue;
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }

  const frequentNouns = [...counts.entries()]
    .filter(([, count]) => count >= MIN_OCCURRENCE)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_FREQUENT_NOUNS)
    .map(([term, count]) => ({ term, count }));

  const unknownTermCandidates = frequentNouns.filter(({ term }) => !knownTerms.has(term));

  // トーン乖離チェック: intendedTone未指定（シーンに演出意図が設定されていない）なら行わない。
  const toneWarnings: ToneDeviationWarning[] = [];
  if (toneOptions?.intendedTone) {
    const warning = detectToneDeviation(
      tokens,
      toneOptions.lexicon ?? DEFAULT_TONE_LEXICON,
      toneOptions.intendedTone,
    );
    if (warning) toneWarnings.push(warning);
  }

  const sentimentArc = computeSentimentArc(sentences);

  return {
    charCount: text.length,
    sentenceCount: (text.match(/[。！？]/g) ?? []).length,
    frequentNouns,
    unknownTermCandidates,
    rhythmWarnings: detectRhythmWarnings(text),
    termVariantSuggestions: suggestTermVariants(unknownTermCandidates, knownTerms),
    frequentPhrases: mineFrequentPhrases(sentences),
    sentimentArc,
    lintWarnings: evaluateLintRules(text, lintRules),
    toneWarnings,
    habitualPhraseWarnings: mineContextualHabitualPhrases(sentences, sentimentArc),
  };
}
