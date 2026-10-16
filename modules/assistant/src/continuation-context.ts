/**
 * Source-aligned context assembly for continuation suggestions (R35).
 *
 * The helper stays pure: callers read the optional chapter summary and invoke
 * the public semantic-search action, then pass those results here. Without a
 * caller-supplied model tokenizer, the budget uses the source's conservative
 * character approximation and the manifest labels that count as approximate.
 */

export const CONTINUATION_FEATURE_ID = "continuation-options";
export const DEFAULT_CONTINUATION_K = 8;
export const MAX_CONTINUATION_K = 40;
export const DEFAULT_CONTINUATION_TOKEN_BUDGET = 12_000;
export const MAX_CONTINUATION_TOKEN_BUDGET = 200_000;
export const CONTINUATION_RETRIEVAL_TOP_K = 5;

const SECTION_SEPARATOR = "\n\n";
const CJK_RE = /[\u3000-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFA\uFF00-\uFFEF]/u;

export interface ContinuationContextPart {
  kind: "recent-sentences" | "chapter-summary" | "retrieval-hit";
  chars: number;
  /** Token estimate/counter output for this part, when the cap is applied. */
  tokens?: number;
  count?: number;
  chapterId?: string;
  entityId?: string;
}

export interface ContinuationContextManifest {
  featureId: typeof CONTINUATION_FEATURE_ID;
  parts: ContinuationContextPart[];
  totalChars: number;
  totalTokens: number;
  tokenBudget: number;
  /** `provided` does not certify that a caller-supplied counter is model-exact. */
  tokenCountMode: "provided" | "approximate";
}

export interface ContinuationSearchResult {
  sceneId: string;
  entityId?: string | null;
  snippet?: string | null;
  text?: string | null;
}

export interface ContinuationRetrievalHit {
  entityId: string;
  text: string;
}

export interface BuildContinuationContextInput {
  /** Newest-last sentence list. */
  recentSentences: readonly string[];
  k?: number;
  chapterSummary?: { chapterId: string; text: string } | null;
  /** Best-first results returned by the public semantic-search action. */
  retrievalHits?: readonly ContinuationRetrievalHit[];
  tokenBudget?: number;
  /** Inject the active model's tokenizer when the host can provide one. */
  countTokens?: (text: string) => number;
}

export interface BuiltContinuationContext {
  text: string;
  manifest: ContinuationContextManifest;
}

/** R35 searches using the last three recent sentences, newest-last input. */
export function buildContinuationRetrievalQuery(recentSentences: readonly string[]): string {
  return recentSentences.slice(-3).join(" ").trim();
}

/**
 * Normalize the public `semantic.search` result shape while preserving
 * best-first ordering. The caller requests limit=5; this function also caps
 * defensively and applies the source's entityId/sceneId and snippet/text
 * fallbacks.
 */
export function normalizeContinuationRetrievalHits(
  results: readonly ContinuationSearchResult[],
): ContinuationRetrievalHit[] {
  return results.slice(0, CONTINUATION_RETRIEVAL_TOP_K)
    .map((hit) => ({
      entityId: hit.entityId ?? hit.sceneId,
      text: (hit.snippet ?? hit.text ?? "").trim(),
    }))
    .filter((hit) => hit.text.length > 0);
}

/** Port of the pinned source's explicitly approximate fallback token count. */
export function approximateContinuationTokenCount(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const character of text) {
    if (CJK_RE.test(character)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 3);
}

function boundedK(k: number | undefined): number {
  if (k === undefined || !Number.isFinite(k)) return DEFAULT_CONTINUATION_K;
  return Math.max(0, Math.min(MAX_CONTINUATION_K, Math.floor(k)));
}

function boundedTokenBudget(tokenBudget: number | undefined): number {
  if (tokenBudget === undefined) return DEFAULT_CONTINUATION_TOKEN_BUDGET;
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1 || tokenBudget > MAX_CONTINUATION_TOKEN_BUDGET) {
    throw new RangeError(`tokenBudget must be an integer between 1 and ${MAX_CONTINUATION_TOKEN_BUDGET}`);
  }
  return tokenBudget;
}

/**
 * Assemble recent sentences, optional chapter summary, and up to five
 * best-first semantic hits. Recent sentences are trimmed from the oldest;
 * lower-priority complete sections are dropped when they do not fit.
 */
export function buildContinuationContext(input: BuildContinuationContextInput): BuiltContinuationContext {
  const budget = boundedTokenBudget(input.tokenBudget);
  const k = boundedK(input.k);
  const countTokens = input.countTokens ?? approximateContinuationTokenCount;
  const count = (text: string): number => {
    const result = countTokens(text);
    if (!Number.isSafeInteger(result) || result < 0) {
      throw new TypeError("countTokens must return a non-negative integer");
    }
    return result;
  };
  const separatorTokens = count(SECTION_SEPARATOR);

  let taken = k === 0 ? [] : input.recentSentences.slice(Math.max(0, input.recentSentences.length - k));
  while (taken.length > 0 && count(taken.join("\n")) > budget) {
    taken = taken.slice(1);
  }

  const sections: string[] = [];
  const parts: ContinuationContextPart[] = [];
  let usedTokens = 0;

  const tryPush = (text: string, part: ContinuationContextPart): void => {
    const tokens = count(text);
    const cost = tokens + (sections.length > 0 ? separatorTokens : 0);
    if (usedTokens + cost > budget) return;
    usedTokens += cost;
    sections.push(text);
    parts.push({ ...part, tokens });
  };

  if (taken.length > 0) {
    const text = taken.join("\n");
    tryPush(text, { kind: "recent-sentences", count: taken.length, chars: text.length });
  }

  const summary = input.chapterSummary;
  if (summary?.text.trim()) {
    const text = summary.text.trim();
    tryPush(text, { kind: "chapter-summary", chapterId: summary.chapterId, chars: text.length });
  }

  for (const hit of (input.retrievalHits ?? []).slice(0, CONTINUATION_RETRIEVAL_TOP_K)) {
    const text = hit.text.trim();
    if (!text) continue;
    tryPush(text, { kind: "retrieval-hit", entityId: hit.entityId, chars: text.length });
  }

  const text = sections.join(SECTION_SEPARATOR);
  return {
    text,
    manifest: {
      featureId: CONTINUATION_FEATURE_ID,
      parts,
      totalChars: text.length,
      totalTokens: usedTokens,
      tokenBudget: budget,
      tokenCountMode: input.countTokens ? "provided" : "approximate",
    },
  };
}
