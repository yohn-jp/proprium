import { expandSearchTerms, type CanonicalSnapshotEntity } from "@scriptorium/module-nlp";

export type SemanticSearchMode = "scene" | "sentence" | "expression";
export interface SemanticScoreBreakdown {
  rrf: number;
  ftsRank?: number;
  vectorRank?: number;
  ftsScore?: number;
  vectorScore?: number;
  rerank?: number;
}
export interface SemanticSearchHit {
  sceneId: string;
  sentenceIndex?: number;
  snippet?: string;
  score: number;
  scores: SemanticScoreBreakdown;
  type?: string;
  name?: string;
  filePath?: string;
  text?: string;
  entityId?: string;
}

export interface LexicalHit {
  id: string;
  type: string;
  name?: string;
  snippet?: string;
  filePath: string;
  score: number;
  field: "name" | "notes" | "memo" | "body";
}

interface SearchDocument {
  id: string;
  type: string;
  name?: string;
  filePath: string;
  field: LexicalHit["field"];
  content: string;
  order: number;
}

const FIELD_SCORE: Record<LexicalHit["field"], number> = { name: 10, notes: 6, memo: 5, body: 4 };

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }

type NoteBlock = { type: "paragraph"; text: string } | { type: "definitions" | "steps"; items: Array<{ term: string; description: string }> };
type NoteSection = { heading: string; body: NoteBlock[]; children: NoteSection[] };
type StructuredNotes = { lead: NoteBlock[]; sections: NoteSection[] };

function isNoteBlock(value: unknown): value is NoteBlock {
  if (!isRecord(value)) return false;
  if (value.type === "paragraph") return typeof value.text === "string";
  return (value.type === "definitions" || value.type === "steps") && Array.isArray(value.items) &&
    value.items.every((item) => isRecord(item) && typeof item.term === "string" && typeof item.description === "string");
}

function isNoteSection(value: unknown): value is NoteSection {
  return isRecord(value) && typeof value.heading === "string" && Array.isArray(value.body) &&
    value.body.every(isNoteBlock) && Array.isArray(value.children) && value.children.every(isNoteSection);
}

function parseLegacyNotesBody(value: string): NoteBlock[] {
  const lines = value.split("\n");
  while (lines.length && !lines[0]!.trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  const blocks: NoteBlock[] = [];
  let chunk: string[] = [];
  const flush = () => {
    if (!chunk.length) return;
    let prose: string[] = [];
    let listType: "definitions" | "steps" | null = null;
    let listItems: Array<{ term: string; description: string }> = [];
    const flushProse = () => { if (prose.length) blocks.push({ type: "paragraph", text: prose.join("\n") }); prose = []; };
    const flushList = () => { if (listType && listItems.length) blocks.push({ type: listType, items: listItems }); listType = null; listItems = []; };
    for (const line of chunk) {
      const step = /^\s*\d+[.、．)]\s+(.+)$/.exec(line);
      const definition = step ? null : /^\s*[*・-]\s+(.+)$/.exec(line);
      const nextType = step ? "steps" : definition ? "definitions" : null;
      if (!nextType) { flushList(); prose.push(line); continue; }
      flushProse();
      if (listType !== nextType) { flushList(); listType = nextType; }
      const match = step ?? definition;
      if (match) {
        const entry = match[1]!;
        const colon = entry.search(/[：:]/);
        const term = colon < 0 ? "" : entry.slice(0, colon).trim().replace(/^\*\*(.*)\*\*$/, "$1").trim();
        listItems.push({ term, description: colon < 0 ? entry.trim() : entry.slice(colon + 1).trim() });
      }
    }
    flushProse(); flushList(); chunk = [];
  };
  for (const line of lines) { if (!line.trim()) flush(); else chunk.push(line); }
  flush();
  return blocks;
}

function normalizeNoteBlocks(value: unknown): NoteBlock[] | null {
  if (typeof value === "string") return parseLegacyNotesBody(value);
  if (Array.isArray(value) && value.every(isNoteBlock)) return value;
  return null;
}

function normalizeNoteSection(value: unknown): NoteSection | null {
  if (isNoteSection(value)) return value;
  if (!isRecord(value) || typeof value.heading !== "string" || !Array.isArray(value.body) ||
      !value.body.every((block) => isRecord(block) && !("type" in block) && typeof block.text === "string") ||
      !Array.isArray(value.children)) return null;
  const children = value.children.map(normalizeNoteSection);
  if (children.some((child) => child === null)) return null;
  return { heading: value.heading, body: parseLegacyNotesBody(value.body.map((block) => (block as { text: string }).text).join("\n\n")), children: children as NoteSection[] };
}

/** Match source normalizeNotes + collectNotesPlainTexts before indexing notes. */
function collectNotes(value: unknown, output: string[]): void {
  let notes: StructuredNotes | null = null;
  if (isRecord(value) && Array.isArray(value.lead) && value.lead.every(isNoteBlock) &&
      Array.isArray(value.sections) && value.sections.every(isNoteSection)) {
    notes = { lead: value.lead, sections: value.sections } as StructuredNotes;
  } else if (isRecord(value)) {
    const lead = normalizeNoteBlocks(value.lead);
    if (lead && Array.isArray(value.sections)) {
      const sections = value.sections.map(normalizeNoteSection);
      if (sections.every((section) => section !== null)) notes = { lead, sections: sections as NoteSection[] };
    }
  }
  if (!notes) return;
  const collectBlocks = (blocks: NoteBlock[]) => {
    for (const block of blocks) {
      if (block.type === "paragraph") output.push(block.text);
      else for (const item of block.items) output.push(item.term, item.description);
    }
  };
  const collectSections = (sections: NoteSection[]) => {
    for (const section of sections) { collectBlocks(section.body); collectSections(section.children); }
  };
  collectBlocks(notes.lead); collectSections(notes.sections);
}

/** Source index-db fields, reconstructed only from the immutable canonical reader. */
export function buildSearchDocuments(entities: readonly CanonicalSnapshotEntity[]): SearchDocument[] {
  const documents: SearchDocument[] = [];
  for (const entity of entities) {
    const nameParts = [entity.name, ...(entity.aliases ?? [])].filter((part): part is string => typeof part === "string" && part.trim().length > 0);
    const add = (field: SearchDocument["field"], content: string): void => {
      if (!content.trim()) return;
      documents.push({ id: entity.id, type: entity.type, name: entity.name, filePath: entity.filePath, field, content, order: documents.length });
    };
    if (nameParts.length) add("name", nameParts.join("\n"));
    if (entity.body?.trim()) add("body", entity.body);
    const notes: string[] = [];
    collectNotes(entity.raw.notes, notes);
    if (notes.some((text) => text.trim())) add("notes", notes.filter((text) => text.trim()).join("\n"));
    if (typeof entity.raw.memo === "string" && entity.raw.memo.trim()) add("memo", entity.raw.memo);
  }
  return documents;
}

function trigrams(value: string): string[] {
  const chars = Array.from(value.toLowerCase());
  const result: string[] = [];
  for (let i = 0; i + 2 < chars.length; i++) result.push(chars.slice(i, i + 3).join(""));
  return result;
}

function occurrenceCount(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) break;
    count++;
    from = index + 1;
  }
  return count;
}

function ftsPhraseFrequency(document: SearchDocument, term: string): number {
  // FTS5's trigram tokenizer indexes overlapping three-character phrases. A short query
  // follows the source's LIKE fallback, handled separately below.
  if (Array.from(term).length < 3) return occurrenceCount(document.content.toLowerCase(), term.toLowerCase());
  return occurrenceCount(document.content.toLowerCase(), term.toLowerCase());
}

function bm25Scores(documents: readonly SearchDocument[], groups: readonly string[][], matching: readonly SearchDocument[]): Map<SearchDocument, number> {
  const lengths = new Map<SearchDocument, number>();
  let totalLength = 0;
  for (const document of documents) {
    const length = trigrams(document.content).length;
    lengths.set(document, length);
    totalLength += length;
  }
  const averageLength = documents.length ? totalLength / documents.length : 0;
  const documentFrequency = groups.map((group) => documents.reduce((count, document) => count + (group.some((term) => ftsPhraseFrequency(document, term) > 0) ? 1 : 0), 0));
  const scores = new Map<SearchDocument, number>();
  for (const document of matching) {
    const dl = lengths.get(document) ?? 0;
    let rank = 0;
    for (let termIndex = 0; termIndex < groups.length; termIndex++) {
      // The source FTS expression ORs spelling variants inside each query-token group.
      const frequency = Math.max(0, ...groups[termIndex]!.map((term) => ftsPhraseFrequency(document, term)));
      if (!frequency) continue;
      const df = documentFrequency[termIndex] ?? 0;
      const numerator = documents.length - df + 0.5;
      const denominator = df + 0.5;
      const idf = Math.max(1e-6, Math.log(numerator / denominator));
      const norm = frequency + 1.2 * (1 - 0.75 + (averageLength > 0 ? 0.75 * dl / averageLength : 0));
      rank -= idf * (frequency * 2.2) / norm;
    }
    scores.set(document, rank);
  }
  return scores;
}

function makeSnippet(content: string, offset: number, length: number): string {
  return content.slice(Math.max(0, offset - 40), Math.min(content.length, offset + length + 80)).replace(/\s+/g, " ");
}

/** Source `searchEntities` field weighting and RRF rank input over a pinned snapshot. */
export function searchSnapshotLexically(entities: readonly CanonicalSnapshotEntity[], query: string, limit: number, knownTerms?: Iterable<string>): LexicalHit[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const terms = trimmed.split(/\s+/u).filter(Boolean);
  const known = knownTerms ?? [];
  const groups = terms.map((term) => expandSearchTerms(term, known));
  const expandedTerms = [...new Set(groups.flat())];
  const shortTerms = expandedTerms.some((term) => term.length > 0 && term.length < 3);
  const documents = buildSearchDocuments(entities);
  const matching = documents.filter((document) => {
    const content = document.content.toLowerCase();
    return shortTerms
      ? expandedTerms.every((term) => content.includes(term.toLowerCase()))
      : groups.every((group) => group.some((term) => content.includes(term.toLowerCase())));
  });
  const bm25 = shortTerms ? new Map<SearchDocument, number>() : bm25Scores(documents, groups, matching);
  const bestById = new Map<string, LexicalHit>();
  const queryLower = trimmed.toLowerCase();
  const sourceRows = shortTerms
    ? matching
    : [...matching].sort((a, b) => (bm25.get(a) ?? 0) - (bm25.get(b) ?? 0) || a.order - b.order);
  for (const document of sourceRows.slice(0, Math.max(limit * 4, limit))) {
    const content = document.content.toLowerCase();
    let offset = -1;
    let matchLength = 0;
    let matchedTerm = "";
    for (const term of expandedTerms) {
      const index = content.indexOf(term.toLowerCase());
      if (index >= 0 && (offset < 0 || index < offset || (index === offset && term.length > matchLength))) {
        offset = index;
        matchLength = term.length;
        matchedTerm = term;
      }
    }
    const fieldValue = FIELD_SCORE[document.field] ?? 3;
    const idBonus = document.id.toLowerCase().includes(queryLower) ? 10 : 0;
    const nameBonus = document.name?.toLowerCase().includes(queryLower) ? 8 : 0;
    const ftsRank = bm25.get(document) ?? 0;
    const score = fieldValue + idBonus + nameBonus + Math.max(0, Math.min(3, -ftsRank * 1e6));
    const result: LexicalHit = {
      id: document.id,
      type: document.type,
      ...(document.name ? { name: document.name } : {}),
      ...(offset >= 0 ? { snippet: makeSnippet(document.content, offset, matchedTerm.length) } : { snippet: document.content.slice(0, 120).replace(/\s+/g, " ") }),
      filePath: document.filePath,
      score,
      field: document.field,
    };
    const previous = bestById.get(result.id);
    if (!previous || result.score > previous.score) bestById.set(result.id, result);
  }
  return [...bestById.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}

export function combineHybridScores(ftsRank: number | null | undefined, vectorRank: number | null | undefined, k = 60): number {
  let score = 0;
  if (ftsRank != null && ftsRank > 0) score += 1 / (k + ftsRank);
  if (vectorRank != null && vectorRank > 0) score += 1 / (k + vectorRank);
  return score;
}

export function scoreBreakdown(ftsRank: number | null | undefined, vectorRank: number | null | undefined, ftsScore?: number, vectorScore?: number): SemanticScoreBreakdown {
  const scores: SemanticScoreBreakdown = { rrf: combineHybridScores(ftsRank, vectorRank) };
  if (ftsRank != null && ftsRank > 0) scores.ftsRank = ftsRank;
  if (vectorRank != null && vectorRank > 0) scores.vectorRank = vectorRank;
  if (ftsScore != null && ftsScore > 0) scores.ftsScore = ftsScore;
  if (vectorScore != null && vectorScore > 0) scores.vectorScore = vectorScore;
  return scores;
}
