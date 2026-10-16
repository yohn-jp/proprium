import type { SnapshotId } from "@scriptorium/contracts";
import type { NlpTokenizerCapability, MorphologyAnalysis, MorphToken, Token } from "@scriptorium/module-nlp";
import { isAuxiliaryVerb, isParticle, isSymbol, isTaConjunctive, isUnknown, isVerb, splitIntoSentenceOffsets } from "@scriptorium/module-nlp";
import { detectRhythmWarnings, isDialogue } from "./textAnalysis.js";
import type { HabitualPhraseWarning } from "./mining/types.js";
import type { RhythmWarning } from "./textAnalysis.js";
import type { ToneLexiconConfig } from "./tone/types.js";
import { candidatesFromToneLexicon, type SynonymCandidate, type SynonymSuggestion } from "./synonyms/types.js";

const SKIP_POS_EXTRA = new Set(["接続詞", "感動詞"]);

export interface SynonymsConfig {
  groups: Array<{ words: string[]; context?: "negative" | "positive" }>;
}

export interface TokenizerJob {
  analyze(text: string): Promise<MorphologyAnalysis>;
}

export interface SynonymSuggestionOptions {
  snapshot: SnapshotId;
  signal: AbortSignal;
  tokenizer: NlpTokenizerCapability;
  toneLexicon: ToneLexiconConfig;
  synonymsConfig: SynonymsConfig;
}

interface SentenceEndingToken {
  surface: string;
  basicForm: string;
  pos: string;
  posDetail1: string;
  conjugatedType: string;
  conjugatedForm: string;
  start: number;
  end: number;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw Object.assign(new Error("Synonym suggestion was cancelled"), { code: "job_cancelled" });
}

function sourceCandidatesFromProjectDict(warning: HabitualPhraseWarning, config: SynonymsConfig): SynonymCandidate[] {
  const group = config.groups.find((candidate) => candidate.words.includes(warning.phrase) && (!candidate.context || candidate.context === warning.band));
  if (!group) return [];
  return group.words.filter((word) => word !== warning.phrase).map((text) => ({ text, rewrittenSentence: "", source: "project-dict" }));
}

function dedupeCandidates(candidates: SynonymCandidate[]): SynonymCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.text)) return false;
    seen.add(candidate.text);
    return true;
  });
}

function findTextRange(text: string, needle: string, sentenceIndex: number): { start: number; end: number } | null {
  const sentence = splitIntoSentenceOffsets(text)[sentenceIndex - 1];
  if (!sentence) return null;
  const index = text.slice(sentence.start, sentence.end).indexOf(needle);
  return index < 0 ? null : { start: sentence.start + index, end: sentence.start + index + needle.length };
}

function buildRewrittenSentence(text: string, range: { start: number; end: number }, replacement: string): string {
  const sentence = splitIntoSentenceOffsets(text).find((span) => range.start >= span.start && range.end <= span.end);
  if (!sentence) return text.slice(0, range.start) + replacement + text.slice(range.end);
  const body = text.slice(sentence.start, sentence.end);
  const start = range.start - sentence.start;
  const end = range.end - sentence.start;
  return body.slice(0, start) + replacement + body.slice(end);
}

function isEndingPos(token: Token): boolean { return isVerb(token) || isAuxiliaryVerb(token); }
function isSkipPos(token: Token): boolean { return isSymbol(token) || isParticle(token) || SKIP_POS_EXTRA.has(token.pos); }

async function findSentenceEndingToken(
  text: string,
  sentenceIndex: number,
  options: SynonymSuggestionOptions,
): Promise<SentenceEndingToken | null> {
  const sentence = splitIntoSentenceOffsets(text)[sentenceIndex - 1];
  if (!sentence) return null;
  const sentenceText = text.slice(sentence.start, sentence.end);
  const analysis = await options.tokenizer.analyze(sentenceText, options.snapshot, options.signal);
  const sentenceTokens: Array<MorphToken & { charStart: number; charEnd: number }> = [];
  let searchFrom = 0;
  for (const token of analysis.tokens) {
    const index = sentenceText.indexOf(token.surface, searchFrom);
    if (index < 0) continue;
    searchFrom = index + token.surface.length;
    sentenceTokens.push({ ...token, charStart: index, charEnd: index + token.surface.length });
  }
  const meaningful = sentenceTokens.filter((token) => !isSymbol(token));
  for (let i = meaningful.length - 1; i >= 0; i--) {
    const token = meaningful[i];
    if (isSkipPos(token)) continue;
    if (isAuxiliaryVerb(token) && (token.surface === "た" || token.surface === "だ") && i > 0) {
      const previous = meaningful[i - 1];
      if (isTaConjunctive(previous)) {
        const start = sentence.start + previous.charStart;
        const end = sentence.start + token.charEnd;
        return {
          surface: text.slice(start, end), basicForm: previous.baseForm ?? previous.surface, pos: "動詞",
          posDetail1: previous.posDetail?.[0] ?? "", conjugatedType: previous.conjugatedType ?? "",
          conjugatedForm: "タ形", start, end,
        };
      }
    }
    if (!isEndingPos(token)) continue;
    return {
      surface: token.surface, basicForm: token.baseForm ?? token.surface, pos: token.pos,
      posDetail1: token.posDetail?.[0] ?? "", conjugatedType: token.conjugatedType ?? "",
      conjugatedForm: token.conjugatedForm ?? "", start: sentence.start + token.charStart, end: sentence.start + token.charEnd,
    };
  }
  return null;
}

function endingReplacementCandidates(ending: SentenceEndingToken): string[] {
  const { surface, basicForm, pos, conjugatedForm, conjugatedType } = ending;
  const candidates: string[] = [];
  const asToken = { surface, pos, start: 0, end: surface.length } satisfies Token;
  if (isVerb(asToken)) {
    if (conjugatedForm === "タ形" || surface.endsWith("た") || surface.endsWith("だ")) {
      const stemMatch = surface.match(/^(.+?)(った|いた|した|んだ|いだ|えた|した)$/);
      if (stemMatch) {
        candidates.push(`${stemMatch[1]}ている`, `${stemMatch[1]}る`);
      } else if (conjugatedType.includes("五段")) {
        const stem = surface.replace(/[いたえおう]た$/, "").replace(/んだ$/, "む");
        if (stem && stem !== surface) candidates.push(`${stem}ている`, `${stem}う`);
      }
      if (basicForm.endsWith("る") && conjugatedType.includes("一段")) {
        const stem = basicForm.slice(0, -1);
        candidates.push(`${stem}ている`, `${stem}る`);
      }
    }
    if (conjugatedForm === "基本形" && surface.endsWith("る")) candidates.push(`${surface.slice(0, -1)}ている`);
  }
  if (isAuxiliaryVerb(asToken)) {
    if (surface === "だ" || surface === "だった") candidates.push("である", "だった");
    if (surface === "です") candidates.push("である", "だ");
  }
  return [...new Set(candidates.filter((candidate) => candidate && candidate !== surface))];
}

async function passesMorphValidation(sentence: string, options: SynonymSuggestionOptions): Promise<boolean> {
  const tokens = (await options.tokenizer.analyze(sentence, options.snapshot, options.signal)).tokens;
  if (tokens.some((token) => isUnknown(token) || (token.surface.length > 1 && /(.)\1{2,}/.test(token.surface)))) return false;
  return tokens.some((token) => isVerb(token)) || /[。！？]$/.test(sentence.trim());
}

function applyEndingReplacement(text: string, range: { start: number; end: number }, replacement: string): string {
  return text.slice(0, range.start) + replacement + text.slice(range.end);
}

async function buildEndingCandidates(text: string, sentenceIndex: number, ending: SentenceEndingToken, options: SynonymSuggestionOptions): Promise<Array<{ text: string; rewrittenSentence: string }>> {
  const sentence = splitIntoSentenceOffsets(text)[sentenceIndex - 1];
  if (!sentence) return [];
  const sentenceText = text.slice(sentence.start, sentence.end);
  const candidates: Array<{ text: string; rewrittenSentence: string }> = [];
  for (const replacement of endingReplacementCandidates(ending)) {
    throwIfAborted(options.signal);
    const rewrittenSentence = applyEndingReplacement(sentenceText, { start: ending.start - sentence.start, end: ending.end - sentence.start }, replacement);
    if (await passesMorphValidation(rewrittenSentence, options)) candidates.push({ text: replacement, rewrittenSentence });
  }
  return candidates;
}

function pickRhythmTargetSentence(warning: RhythmWarning): number {
  return warning.startSentenceIndex + (warning.count <= 1 ? 0 : Math.floor((warning.count - 1) / 2));
}

function resolvesRhythmStreak(fullText: string, warning: RhythmWarning, targetSentenceIndex: number, rewrittenFullText: string): boolean {
  const isTargetStreak = (candidate: RhythmWarning) => candidate.startSentenceIndex <= targetSentenceIndex && targetSentenceIndex < candidate.startSentenceIndex + candidate.count && candidate.ending === warning.ending;
  if (!detectRhythmWarnings(fullText).some(isTargetStreak)) return true;
  return !detectRhythmWarnings(rewrittenFullText).some(isTargetStreak);
}

/** Source synonym workflow: validated ending alternatives, then project dictionary, then tone lexicon. */
export async function suggestSynonyms(
  text: string,
  rhythmWarnings: RhythmWarning[],
  habitualWarnings: HabitualPhraseWarning[],
  options: SynonymSuggestionOptions,
): Promise<SynonymSuggestion[]> {
  const suggestions: SynonymSuggestion[] = [];
  const seen = new Set<string>();
  for (const warning of rhythmWarnings) {
    throwIfAborted(options.signal);
    const sentenceIndex = pickRhythmTargetSentence(warning);
    const sentence = splitIntoSentenceOffsets(text)[sentenceIndex - 1];
    if (!sentence || isDialogue(text.slice(sentence.start, sentence.end))) continue;
    const key = `rhythm:${warning.ending}:${sentenceIndex}`;
    if (seen.has(key)) continue;
    const ending = await findSentenceEndingToken(text, sentenceIndex, options);
    if (!ending) continue;
    if (warning.ending.length === 1 && ending.surface.length === 1 && ending.surface !== warning.ending) continue;
    const range = { start: ending.start, end: ending.end };
    const candidates = (await buildEndingCandidates(text, sentenceIndex, ending, options))
      .filter((candidate) => resolvesRhythmStreak(text, warning, sentenceIndex, applyEndingReplacement(text, range, candidate.text)))
      .map((candidate) => ({ ...candidate, source: "ending-rule" as const }));
    if (candidates.length === 0) continue;
    seen.add(key);
    suggestions.push({ original: ending.surface, candidates, sentenceIndex, range, reason: "rhythm-ending", suggestion: candidates[0].text });
  }

  for (const warning of habitualWarnings) {
    for (const sentenceIndex of warning.sentenceIndices.slice(0, 1)) {
      throwIfAborted(options.signal);
      const key = `habitual:${warning.phrase}:${sentenceIndex}`;
      if (seen.has(key)) continue;
      const range = findTextRange(text, warning.phrase, sentenceIndex);
      if (!range) continue;
      const project = sourceCandidatesFromProjectDict(warning, options.synonymsConfig);
      const tone = project.length > 0 ? [] : candidatesFromToneLexicon(warning.phrase, options.toneLexicon);
      const candidates = dedupeCandidates([...project, ...tone]).map((candidate) => ({
        ...candidate,
        rewrittenSentence: buildRewrittenSentence(text, range, candidate.text),
      }));
      if (candidates.length === 0) continue;
      seen.add(key);
      suggestions.push({ original: warning.phrase, candidates, sentenceIndex, range, reason: "habitual-phrase", suggestion: candidates[0].text });
    }
  }
  return suggestions;
}
