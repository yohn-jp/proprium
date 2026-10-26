import { createGuest, type Handler } from "../shared/guest.ts";
import { clusterTerms, type CandidateTerm } from "./core.ts";

function fail(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, retryable: false });
}

function exactObject(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("invalid_input", `${label} must be an object`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw fail("invalid_input", `${label} contains an unknown field`);
  return record;
}

function parseTerms(raw: unknown): { candidates: CandidateTerm[]; useEmbedding: boolean } {
  const input = exactObject(raw, ["candidates", "useEmbedding"], "input");
  if (!Array.isArray(input.candidates) || input.candidates.length > 2000 || typeof input.useEmbedding !== "boolean") {
    throw fail("invalid_input", "Candidate list or embedding option is invalid");
  }
  const candidates = input.candidates.map((rawCandidate, index): CandidateTerm => {
    const candidate = exactObject(rawCandidate, ["term", "reading", "sourceEntityIds", "occurrenceCount"], `candidates[${index}]`);
    if (typeof candidate.term !== "string" || !candidate.term.trim() || candidate.term.length > 256 ||
        !(candidate.reading === null || typeof candidate.reading === "string") || !Array.isArray(candidate.sourceEntityIds) ||
        candidate.sourceEntityIds.some((id) => typeof id !== "string" || id.length > 256) ||
        !Number.isSafeInteger(candidate.occurrenceCount) || (candidate.occurrenceCount as number) < 0) {
      throw fail("invalid_input", `Candidate ${index} is invalid`);
    }
    return {
      term: candidate.term,
      reading: candidate.reading as string | null,
      sourceEntityIds: candidate.sourceEntityIds as string[],
      occurrenceCount: candidate.occurrenceCount as number,
    };
  });
  return { candidates, useEmbedding: input.useEmbedding };
}

const clusterTermsAction: Handler = (raw, context) => {
  const { candidates, useEmbedding } = parseTerms(raw);
  if (useEmbedding) {
    throw fail("provider_unavailable", "The signed embedding asset is not admitted for this action");
  }
  return { snapshot: context.snapshot, results: clusterTerms(candidates) };
};

export const guest = createGuest("proprium.semantic", {
  "proprium.semantic.terms.cluster": clusterTermsAction,
});
