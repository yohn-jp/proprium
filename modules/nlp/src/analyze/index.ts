import { getTokenizer } from "../tokenizer/index.js";
import type { MorphologyAnalysis, MorphToken } from "../tokenizer/types.js";
import { buildMorphologyAnalysis } from "./primitives.js";

export { assignTokensToSentences, buildMorphologyAnalysis } from "./primitives.js";

/** Tokenize once and retain source-compatible UTF-16 token and sentence spans. */
export async function analyze(text: string): Promise<MorphologyAnalysis> {
  const tokenizer = await getTokenizer();
  const tokens = tokenizer.tokenize(text) as MorphToken[];
  return buildMorphologyAnalysis(text, tokens);
}
