export interface ResearchCandidateEvidence {
  sourceId: string;
  textId: string;
  path?: string;
  revision: string;
  range: { start: number; end: number };
}

export interface ResearchTermCandidate {
  term: string;
  reading: string | null;
  sourceIds: string[];
  occurrenceCount: number;
  evidence: ResearchCandidateEvidence[];
}

export interface SemanticTermCandidate {
  term: string;
  reading: string | null;
  sourceEntityIds: string[];
  occurrenceCount: number;
}

export interface SemanticTermCluster {
  canonical: string;
  variants: string[];
  semanticOnly: boolean;
}

export interface SynonymGroupRef {
  fileRevision: string;
  ordinal: number;
  words: string[];
  context?: "positive" | "negative";
}

export function toSemanticTermCandidates(candidates: readonly ResearchTermCandidate[]): SemanticTermCandidate[] {
  if (candidates.length > 2_000) throw new Error("一度にクラスタ化できる語句は 2000 件までです。");
  return candidates.map(candidate => ({
    term: candidate.term,
    reading: candidate.reading,
    sourceEntityIds: [...candidate.sourceIds],
    occurrenceCount: candidate.occurrenceCount,
  }));
}

export function parseResearchTermCandidates(value: unknown, limit = 50): {
  candidates: ResearchTermCandidate[];
  nextCursor: string | null;
} {
  if (!isRecord(value) || !Array.isArray(value.candidates) || value.candidates.length > limit ||
      !(value.nextCursor === null || typeof value.nextCursor === "string")) {
    throw new Error("候補の結果を読み取れません。");
  }
  const candidates = value.candidates.map((raw, index): ResearchTermCandidate => {
    if (!isRecord(raw) || typeof raw.term !== "string" || !raw.term.trim() || raw.term.length > 256 ||
        !(raw.reading === undefined || raw.reading === null || typeof raw.reading === "string") ||
        !Array.isArray(raw.sourceIds) || raw.sourceIds.length > 128 || raw.sourceIds.some(id => typeof id !== "string") ||
        !Number.isSafeInteger(raw.occurrenceCount) || (raw.occurrenceCount as number) < 1 || !Array.isArray(raw.evidence)) {
      throw new Error(`用語候補 ${index + 1} の形式が正しくありません。`);
    }
    const evidence = raw.evidence.map((item, evidenceIndex): ResearchCandidateEvidence => {
      if (!isRecord(item) || typeof item.sourceId !== "string" || typeof item.textId !== "string" ||
          typeof item.revision !== "string" || !isRecord(item.range) ||
          !Number.isSafeInteger(item.range.start) || !Number.isSafeInteger(item.range.end) ||
          (item.range.start as number) < 0 || (item.range.end as number) <= (item.range.start as number) ||
          !(item.path === undefined || typeof item.path === "string")) {
        throw new Error(`用語候補 ${index + 1} の根拠 ${evidenceIndex + 1} を読み取れません。`);
      }
      return {
        sourceId: item.sourceId,
        textId: item.textId,
        ...(typeof item.path === "string" ? { path: item.path } : {}),
        revision: item.revision,
        range: { start: item.range.start as number, end: item.range.end as number },
      };
    });
    return {
      term: raw.term,
      reading: typeof raw.reading === "string" ? raw.reading : null,
      sourceIds: raw.sourceIds as string[],
      occurrenceCount: raw.occurrenceCount as number,
      evidence,
    };
  });
  return { candidates, nextCursor: value.nextCursor };
}

export function parseSemanticTermClusters(value: unknown): SemanticTermCluster[] {
  if (!isRecord(value) || !Array.isArray(value.results) || value.results.length > 2_000) {
    throw new Error("Semantic のクラスタ結果を読み取れません。");
  }
  return value.results.map((raw, index) => {
    if (!isRecord(raw) || typeof raw.canonical !== "string" || !raw.canonical.trim() ||
        !Array.isArray(raw.variants) || raw.variants.length < 1 || raw.variants.length > 1_999 ||
        raw.variants.some(term => typeof term !== "string" || !term.trim()) ||
        !(raw.semanticOnly === undefined || typeof raw.semanticOnly === "boolean")) {
      throw new Error(`Semantic クラスタ ${index + 1} の形式が正しくありません。`);
    }
    return { canonical: raw.canonical, variants: raw.variants as string[], semanticOnly: raw.semanticOnly === true };
  });
}

export function evidenceQuote(evidence: ResearchCandidateEvidence, texts: ReadonlyMap<string, string>): string | null {
  const text = texts.get(`${evidence.sourceId}\u0000${evidence.textId}`);
  if (text === undefined || evidence.range.end > text.length) return null;
  return text.slice(evidence.range.start, evidence.range.end);
}

export function synonymProposalInput(args: {
  canonical: string;
  variants: readonly string[];
  expectedFileRevision: string | null;
  mergeGroupRef?: SynonymGroupRef;
}): Record<string, unknown> {
  const words = [...new Set([args.canonical, ...args.variants].map(word => word.trim()).filter(Boolean))];
  if (words.length < 2 || words.length > 100) throw new Error("同義語の提案には異なる語句が 2 件以上必要です。");
  return {
    words,
    ...(args.mergeGroupRef ? { mergeGroupRef: args.mergeGroupRef } : {}),
    expectedFileRevision: args.expectedFileRevision,
  };
}

export function semanticEmbeddingChoice(value: unknown): { useEmbedding: boolean; state: "warm" | "cold" | "unknown" } {
  if (!isRecord(value) || !isRecord(value.resources) || typeof value.resources.modelLoaded !== "boolean") {
    return { useEmbedding: false, state: "unknown" };
  }
  return value.resources.modelLoaded
    ? { useEmbedding: true, state: "warm" }
    : { useEmbedding: false, state: "cold" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
