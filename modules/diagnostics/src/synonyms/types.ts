export type SynonymCandidateSource = "ending-rule" | "tone-lexicon" | "project-dict" | "corpus" | "llm";
export interface SynonymCandidate { text: string; rewrittenSentence: string; score?: number; source: SynonymCandidateSource }
export interface SynonymSuggestion {
  original: string;
  candidates: SynonymCandidate[];
  sentenceIndex: number;
  range: { start: number; end: number };
  reason: "rhythm-ending" | "habitual-phrase" | "tone-word";
  suggestion: string;
}

/** Source tone fallback: alternatives with a nearby weight in the matching tone class. */
export function candidatesFromToneLexicon(
  phrase: string,
  lexicon: import("../tone/types.js").ToneLexiconConfig,
): SynonymCandidate[] {
  const tolerance = 0.2;
  for (const words of Object.values(lexicon.tones)) {
    if (!(phrase in words)) continue;
    const weight = words[phrase];
    return Object.entries(words)
      .filter(([other, candidateWeight]) => other !== phrase && Math.abs(candidateWeight - weight) <= tolerance)
      .slice(0, 3)
      .map(([text]) => ({ text, rewrittenSentence: "", source: "tone-lexicon" }));
  }
  return [];
}

export function makeSynonymSuggestion(fields: Omit<SynonymSuggestion, "suggestion">): SynonymSuggestion {
  return { ...fields, suggestion: fields.candidates[0]?.text ?? "" };
}
