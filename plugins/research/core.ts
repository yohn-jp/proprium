import { normalizeUnicode } from "../shared/unicode.js";
/** Pure, deterministic Research algorithms used by the signed guest. */

export const RESEARCH_PLUGIN_ID = "proprium.research";
export const TERM_REGISTRY_PATH = "meta/scriptorium/modules/search/terms.json";
export const DEFAULT_DOCUMENT_ROOTS = ["manuscript", "plot", "bible", "meta/scratch"] as const;
export const MAX_QUERY_LENGTH = 512;
export const MAX_DOCUMENTS = 10_000;
export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
export const MAX_INDEX_BYTES = 32 * 1024 * 1024;
export const MAX_TERM_REGISTRY_BYTES = 1024 * 1024;
export const MAX_DOCUMENT_TERMS = 50_000;
export const MAX_INDEX_TERMS = 250_000;
export const MAX_DOCUMENT_NORMALIZATION_SPANS = 100_000;
export const MAX_INDEX_NORMALIZATION_SPANS = 250_000;

export type SearchMode = "lexical" | "exact" | "prefix";
export interface ResearchDocumentInput { path: string; fileRevision: string; text: string }
export interface ResearchDocument extends ResearchDocumentInput {
  title: string;
  normalizedPath: string;
  normalizedTitle: string;
  normalizedText: string;
  normalizationSpans: NormalizationException[];
  tokens: ReadonlySet<string>;
  bytes: number;
}
export interface TermEntry { id: string; canonical: string; aliases: string[]; targetPath: string; [key: string]: unknown }
export interface TermRegistry { schemaVersion: 1; terms: TermEntry[]; [key: string]: unknown }
export interface SearchHit {
  kind: "document" | "term";
  path: string;
  title: string;
  fileRevision: string;
  snippet: string;
  matchRanges: Array<{ start: number; end: number }>;
  score: number;
  scoreFactors: string[];
  termId?: string;
}
export interface SearchRequest {
  query: string;
  mode: SearchMode;
  snapshot: string;
  scopeBinding?: string;
  scope?: string;
  cursor?: string;
  limit?: number;
  includeTerms?: boolean;
  morphologyHints?: boolean;
}
export interface SearchPage {
  hits: SearchHit[];
  nextCursor: string | null;
  indexSnapshot: string;
  coverage: { documents: number; bytes: number };
  warnings: string[];
}

export interface ResearchIndex {
  snapshot: string;
  documents: ResearchDocument[];
  bytes: number;
}

/** Apply the author's exact, case-sensitive ignored-candidate choices before paging. */
export function filterIgnoredCandidates<T extends { term: string }>(candidates: readonly T[], ignoredTerms: ReadonlySet<string>): T[] {
  return candidates.filter(({ term }) => !ignoredTerms.has(term));
}

export interface FusedSearchCandidate {
  rank: number;
  path: string;
  title: string;
  fileRevision: string;
  snippet: string;
  score: number;
  scoreFactors: string[];
  navigationSpan: { path: string; revision: string; start: number; end: number; quote: string };
}

export interface SemanticSearchCandidate {
  candidateId: string;
  entityId: string;
  sentenceIndex: number;
  path: string;
  title: string;
  fileRevision: string;
  snippet: string;
  cosineScore: number;
  rank: number;
  navigationSpan: { path: string; revision: string; start: number; end: number; quote: string };
}

export interface FusedSearchHit {
  kind: "document";
  path: string;
  title: string;
  fileRevision: string;
  snippet: string;
  score: number;
  source: "hybrid" | "lexical" | "semantic";
  scoreFactors: string[];
  matchRanges: Array<{ start: number; end: number }>;
  navigationSpan: { path: string; revision: string; start: number; end: number; quote: string };
  lexicalScore: number | null;
  semanticScore: number | null;
  lexicalRank: number | null;
  semanticRank: number | null;
  semanticCandidate?: {
    candidateId: string;
    entityId: string;
    sourcePath: string;
    sourceRevision: string;
    sentenceIndex: number;
    text: string;
    evidence: [{ path: string; revision: string; start: number; end: number; quote: string }];
  };
  expressionScore?: number;
  expressionTokens?: string[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const CODE_POINT_ORDER = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

export function compareCodePoints(a: string, b: string): number { return CODE_POINT_ORDER(a, b); }

export function normalizeSearchText(value: string): string { return normalizeUnicode(value, "NFKC").toLowerCase(); }

/** Japanese runs contribute adjacent character pairs; other words remain whole. */
export function lexicalTokens(value: string): string[] {
  const output = new Set<string>();
  const add = (token: string) => {
    if (output.has(token)) return;
    if (output.size >= MAX_DOCUMENT_TERMS) throw Object.assign(new RangeError("Document contains too many distinct search terms"), { code: "capacity" });
    output.add(token);
  };
  for (const match of normalizeSearchText(value).matchAll(/[\p{L}\p{N}_]+/gu)) {
    const token = match[0];
    if (/^[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+$/u.test(token)) {
      const chars = Array.from(token);
      if (chars.length === 1) add(chars[0]!);
      for (let i = 0; i + 1 < chars.length; i++) add(chars[i]! + chars[i + 1]!);
    } else add(token);
  }
  return [...output];
}

function isWithinRoot(path: string, root: string): boolean { return path === root || path.startsWith(`${root}/`); }

export function isSearchableDocumentPath(path: string): boolean {
  if (!isSafeRelativePath(path)) return false;
  const lower = path.toLowerCase();
  const root = DEFAULT_DOCUMENT_ROOTS.find((candidate) => lower.startsWith(`${candidate}/`));
  if (!root || lower.split("/").some((segment) => segment.startsWith("."))) return false;
  const extension = lower.slice(lower.lastIndexOf(".") + 1);
  if (root === "manuscript" || root === "meta/scratch") return ["md", "markdown", "txt"].includes(extension);
  return ["md", "markdown", "txt", "yaml", "yml", "json"].includes(extension);
}

export function isSafeRelativePath(path: string): boolean {
  return typeof path === "string" && path.length > 0 && path.length <= 1024 && !path.startsWith("/") &&
    !path.includes("\\") && !path.includes("\0") && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function titleFor(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.replace(/\.(?:md|markdown|txt|yaml|yml|json)$/iu, "");
}

interface NormalizationException {
  normalizedStart: number;
  normalizedEnd: number;
  sourceStart: number;
  sourceEnd: number;
  deltaAfter: number;
}
interface NormalizedText { value: string; exceptions: NormalizationException[] }

function codePointWidth(text: string, index: number): number {
  return (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
}
function isGraphemeExtend(value: string): boolean {
  const point = value.codePointAt(0) ?? 0;
  return /\p{M}/u.test(value) || point >= 0x1f3fb && point <= 0x1f3ff || point >= 0xe0020 && point <= 0xe007f || point === 0xfe0e || point === 0xfe0f;
}

/** Small guest-safe grapheme iterator for marks, flags, emoji modifiers and ZWJ sequences. */
function* graphemeSegments(text: string): Generator<{ segment: string; index: number }> {
  let start = 0;
  while (start < text.length) {
    let end = start + codePointWidth(text, start);
    const first = text.codePointAt(start) ?? 0;
    if (first >= 0x1f1e6 && first <= 0x1f1ff && end < text.length) {
      const next = text.codePointAt(end) ?? 0;
      if (next >= 0x1f1e6 && next <= 0x1f1ff) end += codePointWidth(text, end);
    }
    while (end < text.length) {
      const nextWidth = codePointWidth(text, end);
      const nextText = text.slice(end, end + nextWidth);
      if (isGraphemeExtend(nextText)) { end += nextWidth; continue; }
      if (nextText === "\u200d" && end + nextWidth < text.length) {
        end += nextWidth;
        end += codePointWidth(text, end);
        continue;
      }
      break;
    }
    yield { segment: text.slice(start, end), index: start };
    start = end;
  }
}

/** Normalize per grapheme so every normalized UTF-16 unit retains its original span. */
function normalizeWithOffsets(text: string): NormalizedText {
  let value = "";
  const exceptions: NormalizationException[] = [];
  let delta = 0;
  for (const { segment, index } of graphemeSegments(text)) {
    const normalized = normalizeSearchText(segment);
    const normalizedStart = value.length;
    value += normalized;
    if (segment.length !== 1 || normalized.length !== 1) {
      if (exceptions.length >= MAX_DOCUMENT_NORMALIZATION_SPANS) throw Object.assign(new RangeError("Text contains too many normalization spans"), { code: "capacity" });
      delta += segment.length - normalized.length;
      exceptions.push({ normalizedStart, normalizedEnd: value.length, sourceStart: index, sourceEnd: index + segment.length, deltaAfter: delta });
    }
  }
  return { value, exceptions };
}

function sourceOffset(mapped: NormalizedText, normalizedIndex: number, end: boolean): number | undefined {
  if (!Number.isSafeInteger(normalizedIndex) || normalizedIndex < 0 || normalizedIndex >= mapped.value.length) return undefined;
  let low = 0;
  let high = mapped.exceptions.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (mapped.exceptions[middle]!.normalizedStart <= normalizedIndex) low = middle + 1;
    else high = middle;
  }
  const exception = mapped.exceptions[low - 1];
  if (exception && normalizedIndex < exception.normalizedEnd) return end ? exception.sourceEnd : exception.sourceStart;
  return normalizedIndex + (end ? 1 : 0) + (exception?.deltaAfter ?? 0);
}

export function createResearchDocument(input: ResearchDocumentInput): ResearchDocument {
  if (!isSafeRelativePath(input.path) || !isSearchableDocumentPath(input.path)) throw new TypeError("Document path is outside Research roots or has an unsupported extension");
  if (!/^[a-f0-9]{64}$/u.test(input.fileRevision)) throw new TypeError("fileRevision must be a lowercase SHA-256 digest");
  const bytes = encoder.encode(input.text).byteLength;
  if (bytes > MAX_DOCUMENT_BYTES) throw Object.assign(new RangeError(`Document exceeds ${MAX_DOCUMENT_BYTES} bytes`), { code: "capacity" });
  const mapped = normalizeWithOffsets(input.text);
  if (mapped.exceptions.length > MAX_DOCUMENT_NORMALIZATION_SPANS) throw Object.assign(new RangeError("Document contains too many normalization spans"), { code: "capacity" });
  const title = titleFor(input.path);
  return {
    ...input, title, normalizedPath: normalizeSearchText(input.path), normalizedTitle: normalizeSearchText(title),
    normalizedText: mapped.value, normalizationSpans: mapped.exceptions,
    tokens: new Set(lexicalTokens(`${input.path}\n${input.text}`)), bytes,
  };
}

export function buildResearchIndex(documents: readonly ResearchDocumentInput[], snapshot: string): ResearchIndex {
  if (!snapshot) throw new TypeError("snapshot is required");
  if (documents.length > MAX_DOCUMENTS) throw Object.assign(new RangeError("Too many searchable documents"), { code: "capacity" });
  const seen = new Set<string>();
  const indexed: ResearchDocument[] = [];
  let bytes = 0;
  let terms = 0;
  let normalizationSpans = 0;
  for (const input of documents) {
    if (!isSearchableDocumentPath(input.path)) continue;
    if (seen.has(input.path)) throw new TypeError(`Duplicate searchable path: ${input.path}`);
    seen.add(input.path);
    const document = createResearchDocument(input);
    bytes += document.bytes;
    if (bytes > MAX_INDEX_BYTES) throw Object.assign(new RangeError("Search index exceeds its byte limit"), { code: "capacity" });
    terms += document.tokens.size;
    normalizationSpans += document.normalizationSpans.length;
    if (terms > MAX_INDEX_TERMS) throw Object.assign(new RangeError("Search index contains too many distinct document terms"), { code: "capacity" });
    if (normalizationSpans > MAX_INDEX_NORMALIZATION_SPANS) throw Object.assign(new RangeError("Search index contains too many normalization spans"), { code: "capacity" });
    indexed.push(document);
  }
  indexed.sort((a, b) => compareCodePoints(a.path, b.path));
  return { snapshot, documents: indexed, bytes };
}

/**
 * Reuse parsed documents whose content revision is unchanged in the current
 * Host-pinned file listing. Changed and newly added documents must be supplied
 * in `replacements`; deleted documents disappear from the returned index.
 */
export function updateResearchIndex(
  previous: ResearchIndex,
  current: readonly { path: string; fileRevision: string; byteLength: number }[],
  replacements: readonly ResearchDocumentInput[],
  snapshot: string,
): ResearchIndex {
  if (!snapshot) throw new TypeError("snapshot is required");
  if (current.length > MAX_DOCUMENTS) throw Object.assign(new RangeError("Too many searchable documents"), { code: "capacity" });

  const previousByPath = new Map(previous.documents.map((document) => [document.path, document]));
  const replacementsByPath = new Map<string, ResearchDocumentInput>();
  for (const replacement of replacements) {
    if (replacementsByPath.has(replacement.path)) throw new TypeError(`Duplicate replacement path: ${replacement.path}`);
    replacementsByPath.set(replacement.path, replacement);
  }

  const seen = new Set<string>();
  const indexed: ResearchDocument[] = [];
  let bytes = 0;
  let terms = 0;
  let normalizationSpans = 0;
  for (const entry of current) {
    if (!isSearchableDocumentPath(entry.path)) continue;
    if (seen.has(entry.path)) throw new TypeError(`Duplicate searchable path: ${entry.path}`);
    seen.add(entry.path);
    if (!/^[a-f0-9]{64}$/u.test(entry.fileRevision) || !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0) {
      throw new TypeError(`Invalid current file metadata: ${entry.path}`);
    }

    const prior = previousByPath.get(entry.path);
    let document: ResearchDocument;
    if (prior && prior.fileRevision === entry.fileRevision && prior.bytes === entry.byteLength) {
      document = prior;
      replacementsByPath.delete(entry.path);
    } else {
      const replacement = replacementsByPath.get(entry.path);
      if (!replacement || replacement.fileRevision !== entry.fileRevision || encoder.encode(replacement.text).byteLength !== entry.byteLength) {
        throw new TypeError(`Changed searchable document bytes are required: ${entry.path}`);
      }
      document = createResearchDocument(replacement);
      replacementsByPath.delete(entry.path);
    }

    bytes += document.bytes;
    if (bytes > MAX_INDEX_BYTES) throw Object.assign(new RangeError("Search index exceeds its byte limit"), { code: "capacity" });
    terms += document.tokens.size;
    normalizationSpans += document.normalizationSpans.length;
    if (terms > MAX_INDEX_TERMS) throw Object.assign(new RangeError("Search index contains too many distinct document terms"), { code: "capacity" });
    if (normalizationSpans > MAX_INDEX_NORMALIZATION_SPANS) throw Object.assign(new RangeError("Search index contains too many normalization spans"), { code: "capacity" });
    indexed.push(document);
  }
  if (replacementsByPath.size) throw new TypeError(`Replacement path is absent from the current searchable listing: ${replacementsByPath.keys().next().value}`);
  indexed.sort((a, b) => compareCodePoints(a.path, b.path));
  return { snapshot, documents: indexed, bytes };
}

/**
 * Combine snapshot-validated document and passage ranks using reciprocal rank
 * fusion. Semantic passages are reduced to their best passage per source file
 * so one document cannot occupy multiple positions in the same result list.
 */
export function fuseSearchCandidates(
  lexicalCandidates: readonly FusedSearchCandidate[],
  semanticCandidates: readonly SemanticSearchCandidate[],
  mode: "hybrid" | "semantic" | "expression",
  limit: number,
): FusedSearchHit[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30 || lexicalCandidates.length > 30 || semanticCandidates.length > 30) {
    throw Object.assign(new RangeError("Fusion candidates or limit exceed the 30-result bound"), { code: "capacity" });
  }
  if (mode !== "hybrid" && mode !== "semantic" && mode !== "expression") throw Object.assign(new TypeError("Fusion mode is unsupported"), { code: "invalid_input" });

  const lexicalBySource = new Map<string, { candidate: FusedSearchCandidate; rank: number }>();
  lexicalCandidates.forEach((candidate) => {
    const key = `${candidate.path}\0${candidate.fileRevision}`;
    if (!lexicalBySource.has(key)) lexicalBySource.set(key, { candidate, rank: candidate.rank });
  });
  const semanticBySource = new Map<string, SemanticSearchCandidate>();
  for (const candidate of semanticCandidates.slice().sort((a, b) => a.rank - b.rank)) {
    const key = `${candidate.path}\0${candidate.fileRevision}`;
    if (!semanticBySource.has(key)) semanticBySource.set(key, candidate);
  }

  const keys = new Set<string>(mode === "semantic" ? semanticBySource.keys() : [...lexicalBySource.keys(), ...semanticBySource.keys()]);
  const rows: FusedSearchHit[] = [];
  for (const key of keys) {
    const lexical = lexicalBySource.get(key);
    const semantic = semanticBySource.get(key);
    if (mode === "semantic" && !semantic) continue;
    if (!lexical && !semantic) continue;
    const lexicalRrf = mode === "semantic" || !lexical ? 0 : 1 / (60 + lexical.rank);
    const semanticRrf = semantic ? 1 / (60 + semantic.rank) : 0;
    const lexicalSpan = lexical?.candidate.navigationSpan;
    const navigationSpan = semantic?.navigationSpan ?? lexicalSpan;
    if (!navigationSpan) continue;
    const source = lexical && semantic ? "hybrid" : semantic ? "semantic" : "lexical";
    rows.push({
      kind: "document",
      path: semantic?.path ?? lexical!.candidate.path,
      title: semantic?.title || lexical?.candidate.title || semantic?.path || lexical!.candidate.path,
      fileRevision: semantic?.fileRevision ?? lexical!.candidate.fileRevision,
      snippet: semantic?.snippet ?? lexical!.candidate.snippet,
      score: lexicalRrf + semanticRrf,
      source,
      scoreFactors: [
        ...(lexicalRrf ? [`rrf-lexical:1/${60 + lexical!.rank}`] : []),
        ...(semanticRrf ? [`rrf-semantic:1/${60 + semantic!.rank}`] : []),
        ...(lexical?.candidate.scoreFactors ?? []),
      ].slice(0, 16),
      matchRanges: [{ start: navigationSpan.start, end: navigationSpan.end }],
      navigationSpan,
      lexicalScore: lexical?.candidate.score ?? null,
      semanticScore: semantic?.cosineScore ?? null,
      lexicalRank: lexical?.rank ?? null,
      semanticRank: semantic?.rank ?? null,
      ...(semantic ? { semanticCandidate: {
        candidateId: semantic.candidateId,
        entityId: semantic.entityId,
        sourcePath: semantic.path,
        sourceRevision: semantic.fileRevision,
        sentenceIndex: semantic.sentenceIndex,
        text: semantic.snippet,
        evidence: [semantic.navigationSpan],
      } } : {}),
    });
  }
  rows.sort((a, b) => b.score - a.score ||
    (a.lexicalRank ?? Number.MAX_SAFE_INTEGER) - (b.lexicalRank ?? Number.MAX_SAFE_INTEGER) ||
    (a.semanticRank ?? Number.MAX_SAFE_INTEGER) - (b.semanticRank ?? Number.MAX_SAFE_INTEGER) ||
    compareCodePoints(a.path, b.path));
  return rows.slice(0, limit);
}

function rangesForNeedle(document: ResearchDocument, needle: string, cap = 10): Array<{ start: number; end: number }> {
  if (!needle) return [];
  const ranges: Array<{ start: number; end: number }> = [];
  const mapped: NormalizedText = { value: document.normalizedText, exceptions: document.normalizationSpans };
  let at = document.normalizedText.indexOf(needle);
  while (at >= 0 && ranges.length < cap) {
    const last = at + needle.length;
    const start = sourceOffset(mapped, at, false);
    const end = sourceOffset(mapped, last - 1, true);
    if (start !== undefined && end !== undefined) ranges.push({ start, end });
    at = document.normalizedText.indexOf(needle, at + Math.max(1, needle.length));
  }
  return coalesceRanges(ranges).slice(0, cap);
}

function rangesForQuery(document: ResearchDocument, query: string, mode: SearchMode): Array<{ start: number; end: number }> {
  const phraseRanges = rangesForNeedle(document, query);
  if (phraseRanges.length || mode === "exact") return phraseRanges;
  const ranges = [...phraseRanges];
  for (const token of lexicalTokens(query)) {
    ranges.push(...rangesForNeedle(document, token, 10));
    if (ranges.length >= 40) break;
  }
  return coalesceRanges(ranges).slice(0, 10);
}

function coalesceRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const output: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const last = output.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else output.push({ ...range });
  }
  return output;
}

function safeBoundary(text: string, at: number): number {
  if (at > 0 && at < text.length) {
    const before = text.charCodeAt(at - 1);
    const current = text.charCodeAt(at);
    if (before >= 0xd800 && before <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) return at - 1;
  }
  return at;
}

function snippetFor(document: ResearchDocument, first: { start: number; end: number } | undefined): string {
  const text = document.text;
  const windowSize = 240;
  let start = first ? Math.max(0, first.start - Math.floor((windowSize - (first.end - first.start)) / 2)) : 0;
  start = safeBoundary(text, start);
  let end = Math.min(text.length, start + windowSize);
  end = safeBoundary(text, end);
  if (first && first.end > end) { end = safeBoundary(text, first.end); start = safeBoundary(text, Math.max(0, end - windowSize)); }
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function documentScore(document: ResearchDocument, query: string, tokens: readonly string[], mode: SearchMode, hints: readonly string[]): { score: number; factors: string[] } {
  const factors: string[] = [];
  let score = 0;
  if (mode === "lexical") {
    if (document.normalizedPath === query) { score = 120; factors.push("path-exact"); }
    else if (document.normalizedTitle === query) { score = 110; factors.push("title-exact"); }
    else if (document.normalizedPath.includes(query)) { score = 85; factors.push("path-contains"); }
    else if (document.normalizedText.includes(query)) { score = 65; factors.push("body-contains"); }
    else if (tokens.length && tokens.every((token) => document.tokens.has(token))) { score = 30 + tokens.length; factors.push("all-query-tokens"); }
    if (hints.length && hints.every((hint) => document.normalizedText.includes(hint))) {
      const hinted = 45 + new Set(hints).size;
      if (hinted > score) { score = hinted; factors.push("morphology-hints"); }
    }
  } else if (mode === "exact") {
    if (document.normalizedPath === query || document.normalizedTitle === query) { score = 100; factors.push(document.normalizedPath === query ? "path-exact" : "title-exact"); }
    else if (document.normalizedText.includes(query)) { score = 65; factors.push("body-phrase"); }
  } else {
    if (document.normalizedPath.startsWith(query)) { score = 80; factors.push("prefix-path"); }
    else if (document.normalizedTitle.startsWith(query)) { score = 80; factors.push("prefix-path"); }
    else if (document.normalizedText.startsWith(query)) { score = 35; factors.push("prefix-body"); }
    else if ([...document.tokens].some((token) => token.startsWith(query))) { score = 25; factors.push("prefix-token"); }
  }
  return { score, factors };
}

function sortHits(a: SearchHit, b: SearchHit): number {
  return b.score - a.score || compareCodePoints(normalizeSearchText(a.path), normalizeSearchText(b.path)) ||
    compareCodePoints(normalizeSearchText(a.title), normalizeSearchText(b.title)) ||
    compareCodePoints(a.kind, b.kind) || compareCodePoints(a.termId ?? "", b.termId ?? "");
}

export function parseTermRegistry(value: unknown): TermRegistry {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.terms) || value.terms.length > 5_000) {
    throw Object.assign(new TypeError("Unsupported term registry schema"), { code: "unsupported_schema" });
  }
  const ids = new Set<string>();
  const terms = value.terms.map((raw, index): TermEntry => {
    if (!isRecord(raw) || typeof raw.id !== "string" || !/^[A-Za-z0-9_-]{1,96}$/u.test(raw.id) || ids.has(raw.id) ||
        typeof raw.canonical !== "string" || !raw.canonical.trim() || raw.canonical.length > 256 ||
        !Array.isArray(raw.aliases) || raw.aliases.length > 32 || raw.aliases.some((alias) => typeof alias !== "string" || !alias.trim() || alias.length > 256) ||
        typeof raw.targetPath !== "string" || !isSafeRelativePath(raw.targetPath)) {
      throw Object.assign(new TypeError(`Invalid term registry entry ${index + 1}`), { code: "unsupported_schema" });
    }
    ids.add(raw.id);
    const canonical = raw.canonical.trim();
    const aliases = [...new Set((raw.aliases as string[]).map((alias) => alias.trim()).filter((alias) => normalizeSearchText(alias) !== normalizeSearchText(canonical)))];
    return { ...raw, id: raw.id, canonical, aliases, targetPath: raw.targetPath } as TermEntry;
  });
  terms.sort((a, b) => compareCodePoints(a.id, b.id));
  return { ...value, schemaVersion: 1, terms } as TermRegistry;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

export function upsertTermRegistry(registry: TermRegistry, next: Pick<TermEntry, "canonical" | "aliases" | "targetPath"> & { id?: string }): TermRegistry {
  const id = next.id ?? `term-${registry.terms.length + 1}`;
  if (!/^[A-Za-z0-9_-]{1,96}$/u.test(id)) throw new TypeError("Term ID is invalid");
  const existing = registry.terms.find((term) => term.id === id);
  const entry = { ...(existing ?? {}), ...next, id, canonical: next.canonical.trim(), aliases: [...new Set(next.aliases.map((alias) => alias.trim()))] } as TermEntry;
  return parseTermRegistry({ ...registry, terms: [...registry.terms.filter((term) => term.id !== id), entry] });
}

export function removeTermRegistryEntry(registry: TermRegistry, termId: string): TermRegistry {
  if (!registry.terms.some((term) => term.id === termId)) throw Object.assign(new Error("Term entry was not found"), { code: "file_not_found" });
  return parseTermRegistry({ ...registry, terms: registry.terms.filter((term) => term.id !== termId) });
}

interface ResolveSpan { start: number; end: number }
function isWordCharacter(value: string | undefined): boolean { return value !== undefined && /[\p{L}\p{N}_]/u.test(value); }
function hasBoundary(normalized: string, start: number, end: number, alias: string): boolean {
  if (!/[A-Za-z0-9_]$/u.test(alias) && !/^[A-Za-z0-9_]/u.test(alias)) return true;
  return !isWordCharacter(Array.from(normalized.slice(0, start)).at(-1)) && !isWordCharacter(Array.from(normalized.slice(end))[0]);
}

export function resolveTermSpans(text: string, terms: readonly TermEntry[], validTargetPaths?: ReadonlySet<string>): {
  spans: Array<ResolveSpan & { termId: string; targetPath: string }>;
  ambiguities: Array<ResolveSpan & { alias: string; termIds: string[] }>;
} {
  const normalizedText = normalizeWithOffsets(text);
  const normalizedMap: NormalizedText = { value: normalizedText.value, exceptions: normalizedText.exceptions };
  const aliases = new Map<string, Array<{ alias: string; term: TermEntry }>>();
  for (const term of terms) {
    if (validTargetPaths && !validTargetPaths.has(term.targetPath)) continue;
    for (const alias of [term.canonical, ...term.aliases]) {
      const normalized = normalizeSearchText(alias);
      if (!normalized) continue;
      const entries = aliases.get(normalized) ?? [];
      if (!entries.some(({ term: existing }) => existing.id === term.id)) entries.push({ alias, term });
      aliases.set(normalized, entries);
    }
  }
  const matches: Array<ResolveSpan & { alias: string; terms: TermEntry[] }> = [];
  for (const [needle, entries] of aliases) {
    let at = normalizedText.value.indexOf(needle);
    while (at >= 0) {
      const last = at + needle.length;
      const start = sourceOffset(normalizedMap, at, false);
      const end = sourceOffset(normalizedMap, last - 1, true);
      if (start !== undefined && end !== undefined && hasBoundary(normalizedText.value, at, last, needle)) {
        matches.push({ start, end, alias: entries[0]!.alias, terms: entries.map(({ term }) => term) });
      }
      at = normalizedText.value.indexOf(needle, at + Math.max(1, needle.length));
    }
  }
  matches.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start ||
    compareCodePoints(a.alias, b.alias) || compareCodePoints(a.terms[0]!.id, b.terms[0]!.id));
  const spans: Array<ResolveSpan & { termId: string; targetPath: string }> = [];
  const ambiguities: Array<ResolveSpan & { alias: string; termIds: string[] }> = [];
  const accepted: ResolveSpan[] = [];
  for (const match of matches) {
    if (accepted.some((item) => match.start < item.end && item.start < match.end)) continue;
    accepted.push({ start: match.start, end: match.end });
    const termIds = [...new Set(match.terms.map((term) => term.id))].sort(compareCodePoints);
    if (termIds.length > 1) ambiguities.push({ start: match.start, end: match.end, alias: match.alias, termIds });
    else spans.push({ start: match.start, end: match.end, termId: termIds[0]!, targetPath: match.terms[0]!.targetPath });
  }
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  ambiguities.sort((a, b) => a.start - b.start || a.end - b.end);
  return { spans, ambiguities };
}

function termHits(terms: readonly TermEntry[], revisions: ReadonlyMap<string, string>, query: string, mode: SearchMode, scope?: string): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const term of terms) {
    const revision = revisions.get(term.targetPath);
    if (!revision || scope && term.targetPath !== scope && !term.targetPath.startsWith(`${scope}/`)) continue;
    const labels = [term.canonical, ...term.aliases].map(normalizeSearchText);
    const exact = labels.includes(query);
    const prefix = labels.some((value) => value.startsWith(query));
    const lexical = labels.some((value) => value.includes(query));
    if (mode === "exact" ? !exact : mode === "prefix" ? !prefix : !lexical) continue;
    hits.push({ kind: "term", path: term.targetPath, title: term.canonical, fileRevision: revision, snippet: "",
      matchRanges: [], score: exact ? 1000 : prefix ? 500 : 250,
      scoreFactors: [exact ? "term-exact" : prefix ? "term-prefix" : "term-lexical"], termId: term.id });
  }
  return hits;
}

interface CursorData { snapshot: string; request: string; offset: number }
function encodeCursor(value: CursorData): string {
  const bytes = encoder.encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}
function decodeCursor(value: string): CursorData {
  try {
    const binary = atob(value.replace(/-/gu, "+").replace(/_/gu, "/"));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed: unknown = JSON.parse(decoder.decode(bytes));
    if (!isRecord(parsed) || typeof parsed.snapshot !== "string" || typeof parsed.request !== "string" || !Number.isSafeInteger(parsed.offset) || (parsed.offset as number) < 0) throw new Error();
    return { snapshot: parsed.snapshot, request: parsed.request, offset: parsed.offset as number };
  } catch { throw Object.assign(new TypeError("Search cursor is invalid"), { code: "invalid_input" }); }
}

export function queryResearchIndex(
  index: ReturnType<typeof buildResearchIndex>,
  request: SearchRequest,
  options: { terms?: readonly TermEntry[]; queryHints?: readonly string[]; tokenizerAvailable?: boolean } = {},
): SearchPage {
  if (typeof request.query !== "string" || !request.query.trim() || request.query.length > MAX_QUERY_LENGTH) throw Object.assign(new TypeError("query must contain 1 to 512 characters"), { code: "invalid_input" });
  if (!["lexical", "exact", "prefix"].includes(request.mode)) throw Object.assign(new TypeError("mode is unsupported"), { code: "invalid_input" });
  const limit = request.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Object.assign(new TypeError("limit must be between 1 and 100"), { code: "invalid_input" });
  if (request.scope !== undefined && !isSafeRelativePath(request.scope)) throw Object.assign(new TypeError("scope is not a safe workspace path"), { code: "invalid_path" });
  if (index.snapshot !== request.snapshot) throw Object.assign(new Error("Search index belongs to another snapshot"), { code: "snapshot_stale" });
  const query = normalizeSearchText(request.query.trim());
  const termsQuery = JSON.stringify({ query, mode: request.mode, scopeBinding: request.scopeBinding ?? null, scope: request.scope ?? null, limit,
    includeTerms: request.includeTerms !== false, morphologyHints: request.morphologyHints === true, queryHints: options.queryHints ?? [] });
  const cursorSnapshot = `${request.snapshot}\0${request.scopeBinding ?? ""}`;
  let offset = 0;
  if (request.cursor) {
    const cursor = decodeCursor(request.cursor);
    if (cursor.snapshot !== cursorSnapshot || cursor.request !== termsQuery) throw Object.assign(new Error("Search cursor does not match this snapshot or query"), { code: "snapshot_stale" });
    offset = cursor.offset;
  }
  const warnings: string[] = [];
  const hints = request.morphologyHints ? options.queryHints ?? [] : [];
  if (request.morphologyHints && !options.tokenizerAvailable) warnings.push("tokenizer_unavailable");
  const hits: SearchHit[] = [];
  const queryTokens = lexicalTokens(request.query);
  for (const document of index.documents) {
    if (request.scope && document.path !== request.scope && !document.path.startsWith(`${request.scope}/`)) continue;
    const { score, factors } = documentScore(document, query, queryTokens, request.mode, hints);
    if (!score) continue;
    const matchRanges = rangesForQuery(document, query, request.mode);
    hits.push({ kind: "document", path: document.path, title: document.title, fileRevision: document.fileRevision,
      snippet: snippetFor(document, matchRanges[0]), matchRanges, score, scoreFactors: factors });
  }
  if (request.includeTerms !== false) {
    const revisions = new Map(index.documents.map(({ path, fileRevision }) => [path, fileRevision]));
    hits.push(...termHits(options.terms ?? [], revisions, query, request.mode, request.scope));
  }
  hits.sort(sortHits);
  if (offset > hits.length) throw Object.assign(new Error("Search cursor offset is outside the result set"), { code: "invalid_input" });
  const page = hits.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    hits: page,
    nextCursor: nextOffset < hits.length ? encodeCursor({ snapshot: cursorSnapshot, request: termsQuery, offset: nextOffset }) : null,
    indexSnapshot: index.snapshot,
    coverage: { documents: index.documents.length, bytes: index.bytes },
    warnings,
  };
}
