import { getLinderaTokenizer } from "./linderaAdapter.js";
import type { Tokenizer } from "./types.js";

export { correctUnkPos, getLinderaTokenizer, resetLinderaTokenizerCacheForTests } from "./linderaAdapter.js";
export type {
  Bunsetsu, MorphologyAnalysis, MorphToken, SentenceParse, SentenceSpan, SyntaxTree,
  Token, Tokenizer, TokenMorphExtras,
} from "./types.js";
export { tokenBase, tokenPosDetail1 } from "./types.js";
export { isAdjective, isAdverb, isAuxiliaryVerb, isComma, isFinalParticle, isNoun, isNumeral,
  isParticle, isPronoun, isProperNoun, isSymbol, isTaConjunctive, isUnknown, isVerb } from "./pos.js";

export type TokenizerEngine = "lindera";
let initializedTokenizer: Tokenizer | null = null;

/** The installed CPU engine is Lindera WASM with its embedded IPADIC dictionary. */
export async function getTokenizer(engine: TokenizerEngine = "lindera"): Promise<Tokenizer> {
  if (engine !== "lindera") throw new Error(`Unsupported tokenizer engine: ${engine}`);
  initializedTokenizer ??= await getLinderaTokenizer();
  return initializedTokenizer;
}

export function getInitializedTokenizer(): Tokenizer | null { return initializedTokenizer; }
export function resetInitializedTokenizerForTests(): void { initializedTokenizer = null; }
