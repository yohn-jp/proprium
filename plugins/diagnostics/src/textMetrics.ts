import sentimentLexicon from "./sentimentLexicon.json" with { type: "json" };
import type { PlotToken } from "./plot.js";
import YAML from "yaml";

export interface MetricSentence { start: number; end: number; text: string; tokens: PlotToken[] }
export interface MetricEvidence { sentenceIndex: number; start: number; end: number; quote: string }
export interface FrequentTerm { term: string; count: number; evidence: MetricEvidence[] }
export interface FrequentPhrase { phrase: string; count: number; sentenceIndices: number[]; evidence: MetricEvidence[] }
export interface ToneLexicon { tones: Record<string, Record<string, number>> }

export const TONE_CONFIG_PATHS = [
  "meta/scriptorium/modules/diagnostics/tone-lexicon.yaml",
  "meta/tone-lexicon.yaml",
] as const;

export const DEFAULT_TONE_LEXICON: ToneLexicon = {
  tones: {
    suspense: { "緊張": 1, "不安": 1, "恐怖": 1, "静寂": 0.8, "悲鳴": 1, "戦慄": 1.2, "闇": 0.8, "足音": 0.8 },
    action: { "疾走": 1, "衝撃": 1, "咆哮": 1, "斬撃": 1.2, "爆発": 1, "加速": 0.8, "激突": 1 },
    slice_of_life: { "珈琲": 1, "あくび": 1, "日常": 1, "洗濯": 0.8, "昼寝": 1, "掃除": 0.8, "世間話": 1 },
  },
};

function isNoun(token: PlotToken): boolean { return token.pos === "名詞"; }
function base(token: PlotToken): string { return token.base ?? token.surface; }
function eligibleTerm(term: string): boolean { return term.length >= 2 && term.length <= 256 && !/^[\s\p{P}\p{S}0-9]+$/u.test(term); }
function evidenceFor(sentence: MetricSentence, sentenceIndex: number, predicate: (token: PlotToken) => boolean, max = 5): MetricEvidence[] {
  const result: MetricEvidence[] = [];
  for (const token of sentence.tokens) {
    if (!predicate(token) || token.start < sentence.start || token.end > sentence.end || sentence.text.slice(token.start - sentence.start, token.end - sentence.start) !== token.surface) continue;
    result.push({ sentenceIndex, start: token.start, end: token.end, quote: token.surface });
    if (result.length >= max) break;
  }
  return result;
}

/** Pinned source contiguous-noun extraction and stable occurrence evidence. */
export function frequentNouns(sentences: readonly MetricSentence[], knownTerms: ReadonlySet<string>): { frequent: FrequentTerm[]; unknown: FrequentTerm[] } {
  const counts = new Map<string, { count: number; evidence: MetricEvidence[] }>();
  for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex++) {
    const sentence = sentences[sentenceIndex];
    let run: PlotToken[] = [];
    const flush = () => {
      if (!run.length) return;
      const term = run.map((token) => token.surface).join("");
      if (eligibleTerm(term)) {
        const value = counts.get(term) ?? { count: 0, evidence: [] };
        value.count++;
        if (value.evidence.length < 5) value.evidence.push({ sentenceIndex: sentenceIndex + 1, start: run[0].start, end: run.at(-1)!.end, quote: term });
        counts.set(term, value);
      }
      run = [];
    };
    for (const token of sentence.tokens) { if (isNoun(token)) run.push(token); else flush(); }
    flush();
  }
  const frequent = [...counts.entries()].filter(([, value]) => value.count >= 2)
    .sort((left, right) => right[1].count - left[1].count || codePointCompare(left[0], right[0]))
    .slice(0, 30).map(([term, value]) => ({ term, count: value.count, evidence: value.evidence }));
  return { frequent, unknown: frequent.filter((item) => !knownTerms.has(item.term)) };
}

function codePointCompare(left: string, right: string): number {
  const a = Array.from(left, (char) => char.codePointAt(0)!);
  const b = Array.from(right, (char) => char.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index++) if (a[index] !== b[index]) return a[index] - b[index];
  return a.length - b.length;
}

function contentToken(token: PlotToken): boolean { return isNoun(token) || token.pos === "動詞" || token.pos === "形容詞" || token.pos === "副詞"; }
function edgeExcluded(token: PlotToken): boolean { return token.pos === "助詞" || token.pos === "助動詞" || token.pos === "記号"; }

/** Port of the source morphology n-gram phrase miner (2..6 tokens, 3 occurrences). */
export function frequentPhrases(sentences: readonly MetricSentence[]): FrequentPhrase[] {
  const acc = new Map<string, { count: number; sentenceIndices: number[]; surfaces: Map<string, number>; evidence: MetricEvidence[] }>();
  for (let index = 0; index < sentences.length; index++) {
    const sentence = sentences[index];
    for (let n = 2; n <= 6; n++) for (let start = 0; start + n <= sentence.tokens.length; start++) {
      const tokens = sentence.tokens.slice(start, start + n);
      if (tokens.some((token) => token.pos === "記号") || !tokens.some(contentToken) || edgeExcluded(tokens[0]) || edgeExcluded(tokens.at(-1)!)) continue;
      const key = tokens.map(base).join("");
      const surface = tokens.map((token) => token.surface).join("");
      if (key.length > 512 || surface.length > 512) continue;
      const row = acc.get(key) ?? { count: 0, sentenceIndices: [], surfaces: new Map<string, number>(), evidence: [] };
      row.count++;
      if (row.sentenceIndices.at(-1) !== index + 1) row.sentenceIndices.push(index + 1);
      row.surfaces.set(surface, (row.surfaces.get(surface) ?? 0) + 1);
      if (row.evidence.length < 5) row.evidence.push({ sentenceIndex: index + 1, start: tokens[0].start, end: tokens.at(-1)!.end, quote: surface });
      acc.set(key, row);
    }
  }
  const candidates = [...acc].filter(([, value]) => value.count >= 3).map(([key, value]) => {
    let phrase = ""; let top = -1;
    for (const [surface, count] of value.surfaces) if (count > top) { phrase = surface; top = count; }
    return { key, phrase, ...value };
  });
  const kept = candidates.filter((candidate, index) => !candidates.some((other, otherIndex) => index !== otherIndex && candidate.count === other.count && candidate.key.length < other.key.length && other.key.includes(candidate.key)));
  return kept.sort((left, right) => right.count - left.count || codePointCompare(left.phrase, right.phrase)).slice(0, 30)
    .map(({ phrase, count, sentenceIndices, evidence }) => ({ phrase, count, sentenceIndices, evidence }));
}

const SENTIMENT: Record<string, number> = (sentimentLexicon as { entries: Record<string, number> }).entries;
const NEGATION = new Set(["ない", "ぬ", "ん", "ず"]);
const DEGREE = new Set(["とても", "非常", "ひどく", "実に", "あまりに", "すごく", "かなり", "極めて", "本当に"]);
function sentenceSentiment(tokens: readonly PlotToken[]): number {
  let total = 0;
  for (let index = 0; index < tokens.length; index++) {
    let score = SENTIMENT[base(tokens[index])];
    if (score === undefined) continue;
    for (let back = 1; back <= 2 && index - back >= 0; back++) if (DEGREE.has(base(tokens[index - back]))) { score *= 1.5; break; }
    for (let forward = index + 1; forward < tokens.length; forward++) if (NEGATION.has(base(tokens[forward]))) { score = -score; break; }
    total += score;
  }
  return total;
}
function dialogue(text: string): boolean { return /^[「『]/u.test(text.trim()); }

export function sentimentArc(sentences: readonly MetricSentence[]): { points: Array<{ sentenceIndex: number; start: number; end: number; raw: number; smoothed: number; isDialogue: boolean; text: string; textTruncated: boolean }>; mean: number; minIndex: number | null; maxIndex: number | null; totalSentences: number; sampled: boolean } {
  const raw = sentences.map((sentence) => sentence.text.trim() ? sentenceSentiment(sentence.tokens) : 0);
  let minIndex: number | null = null, maxIndex: number | null = null;
  for (let index = 0; index < raw.length; index++) {
    if (minIndex === null || raw[index] < raw[minIndex - 1]) minIndex = index + 1;
    if (maxIndex === null || raw[index] > raw[maxIndex - 1]) maxIndex = index + 1;
  }
  const maxPoints = 1000;
  const sampled = raw.length > maxPoints;
  const indices = sampled
    ? new Set(Array.from({ length: maxPoints }, (_, index) => Math.floor(index * (raw.length - 1) / (maxPoints - 1))))
    : new Set(raw.map((_, index) => index));
  if (minIndex !== null) indices.add(minIndex - 1);
  if (maxIndex !== null) indices.add(maxIndex - 1);
  const points = [...indices].sort((left, right) => left - right).map((index) => {
    const score = raw[index];
    const start = Math.max(0, index - 2), end = Math.min(raw.length - 1, index + 2);
    const smoothed = end >= start ? raw.slice(start, end + 1).reduce((sum, value) => sum + value, 0) / (end - start + 1) : 0;
    const sentence = sentences[index];
    return { sentenceIndex: index + 1, start: sentence.start, end: sentence.end, raw: score, smoothed, isDialogue: dialogue(sentence.text), text: sentence.text.slice(0, 128), textTruncated: sentence.text.length > 128 };
  });
  return { points, mean: raw.length ? raw.reduce((sum, value) => sum + value, 0) / raw.length : 0, minIndex, maxIndex, totalSentences: raw.length, sampled };
}

export interface ProseBalance {
  charCount: number; dialogueCharCount: number; narrationCharCount: number;
  dialogueRatio: number; narrationRatio: number; adjectiveRatio: number; adverbRatio: number; verbRatio: number;
  warnings: Array<{ metric: string; value: number; threshold: number; message: string }>;
}

export function proseBalance(text: string, tokens: readonly PlotToken[], sentences: readonly MetricSentence[]): ProseBalance {
  let dialogueChars = 0, narrationChars = 0;
  for (const sentence of sentences) if (dialogue(sentence.text)) dialogueChars += sentence.text.length; else narrationChars += sentence.text.length;
  const charCount = text.length || 1;
  let adjectiveCount = 0, adverbCount = 0, verbCount = 0;
  for (const token of tokens) {
    if (token.pos === "形容詞" || token.pos === "形容動詞") adjectiveCount++;
    else if (token.pos === "副詞") adverbCount++;
    else if (token.pos === "動詞") verbCount++;
  }
  const denominator = tokens.length || 1;
  const dialogueRatio = dialogueChars / charCount, narrationRatio = narrationChars / charCount;
  const adjectiveRatio = adjectiveCount / denominator, adverbRatio = adverbCount / denominator, verbRatio = verbCount / denominator;
  const warnings: ProseBalance["warnings"] = [];
  if (dialogueRatio > 0.75) warnings.push({ metric: "dialogue-ratio", value: dialogueRatio, threshold: 0.75, message: `Dialogue ratio is high (${Math.round(dialogueRatio * 100)}%).` });
  if (dialogueRatio < 0.15 && charCount > 100) warnings.push({ metric: "narration-ratio", value: narrationRatio, threshold: 0.85, message: `Narration ratio is high (${Math.round(narrationRatio * 100)}%).` });
  if (adjectiveRatio > 0.18) warnings.push({ metric: "adjective-density", value: adjectiveRatio, threshold: 0.18, message: `Adjective density is high (${Math.round(adjectiveRatio * 100)}%).` });
  if (adverbRatio > 0.12) warnings.push({ metric: "adverb-density", value: adverbRatio, threshold: 0.12, message: `Adverb density is high (${Math.round(adverbRatio * 100)}%).` });
  return { charCount, dialogueCharCount: dialogueChars, narrationCharCount: narrationChars, dialogueRatio, narrationRatio, adjectiveRatio, adverbRatio, verbRatio, warnings };
}

export function habitualPhraseWarnings(sentences: readonly MetricSentence[]): Array<{ band: "negative" | "positive"; phrase: string; count: number; sentenceIndices: number[]; message: string; evidence: MetricEvidence[] }> {
  const output: ReturnType<typeof habitualPhraseWarnings> = [];
  for (const band of ["negative", "positive"] as const) {
    const selected: MetricSentence[] = [], original: number[] = [];
    for (let index = 0; index < sentences.length; index++) {
      const score = sentenceSentiment(sentences[index].tokens);
      if (band === "negative" ? score <= -0.5 : score >= 0.5) { selected.push(sentences[index]); original.push(index + 1); }
    }
    for (const phrase of frequentPhrases(selected)) {
      const indices = phrase.sentenceIndices.map((value) => original[value - 1]);
      output.push({ band, phrase: phrase.phrase, count: phrase.count, sentenceIndices: indices, message: `${band === "negative" ? "Strong negative emotion" : "Strong positive emotion"} context repeats “${phrase.phrase}” ${phrase.count} times.`, evidence: phrase.evidence.map((item) => ({ ...item, sentenceIndex: original[item.sentenceIndex - 1] ?? item.sentenceIndex })) });
    }
  }
  return output.sort((left, right) => right.count - left.count || codePointCompare(left.phrase, right.phrase));
}

export function parseToneLexicon(text: string): ToneLexicon {
  const document = YAML.parseDocument(text, { strict: true, uniqueKeys: true });
  if (document.errors.length) throw new TypeError(document.errors[0].message);
  const root = document.toJS({ maxAliasCount: 100 }) as Record<string, unknown>;
  if (!root || typeof root !== "object" || Array.isArray(root) || !root.tones || typeof root.tones !== "object" || Array.isArray(root.tones)) throw new TypeError("tone lexicon.tones must be a mapping");
  const tones: Record<string, Record<string, number>> = {};
  const classes = Object.entries(root.tones as Record<string, unknown>);
  if (classes.length > 128) throw new TypeError("tone classes exceed 128 entries");
  for (const [name, raw] of classes) {
    if (!name || name.length > 128 || !raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("tone classes must have bounded mapping values");
    const words = Object.entries(raw as Record<string, unknown>);
    if (words.length > 2048) throw new TypeError(`${name} exceeds 2048 terms`);
    tones[name] = {};
    for (const [term, weight] of words) {
      if (!term || term.length > 256 || typeof weight !== "number" || !Number.isFinite(weight) || Math.abs(weight) > 1_000_000) throw new TypeError(`${name}.${term} must have a bounded finite weight`);
      tones[name][term] = weight;
    }
  }
  return Object.keys(tones).length ? { tones } : DEFAULT_TONE_LEXICON;
}

export function toneDeviation(tokens: readonly PlotToken[], lexicon: ToneLexicon, intendedTone: string): Record<string, unknown> | null {
  if (!Object.hasOwn(lexicon.tones, intendedTone)) return null;
  const vector: Record<string, number> = Object.fromEntries(Object.keys(lexicon.tones).map((name) => [name, 0]));
  if (tokens.length) for (const token of tokens) for (const [name, weights] of Object.entries(lexicon.tones)) vector[name] += weights[base(token)] ?? weights[token.surface] ?? 0;
  if (tokens.length) for (const name of Object.keys(vector)) vector[name] /= tokens.length;
  let dominant: string | undefined;
  let maximum = 0;
  for (const [name, value] of Object.entries(vector)) if (value > maximum) { maximum = value; dominant = name; }
  if (!dominant || dominant === intendedTone) return null;
  return { intendedTone, dominantTone: dominant, toneVector: vector, message: `Declared intended tone “${intendedTone}” differs from the dominant lexical tone “${dominant}”.`, signal: "statistical" };
}
