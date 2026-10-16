import { splitIntoSentenceOffsets } from "../sentenceSplit.js";
import type { MorphologyAnalysis, MorphToken, SentenceSpan } from "../tokenizer/types.js";

export function assignTokensToSentences(text: string, tokens: MorphToken[]): SentenceSpan[] {
  const offsets = splitIntoSentenceOffsets(text);
  const sentences: SentenceSpan[] = [];
  let tokenIndex = 0;
  for (const { start, end } of offsets) {
    while (tokenIndex < tokens.length && tokens[tokenIndex].start < start) tokenIndex++;
    const from = tokenIndex;
    while (tokenIndex < tokens.length && tokens[tokenIndex].start < end) tokenIndex++;
    sentences.push({ start, end, text: text.slice(start, end), tokens: tokens.slice(from, tokenIndex) });
  }
  return sentences;
}

export function buildMorphologyAnalysis(text: string, tokens: MorphToken[]): MorphologyAnalysis {
  return { text, tokens, sentences: assignTokensToSentences(text, tokens) };
}
