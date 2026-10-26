/** Bounded, model-free NLP utilities and tokenizer-result reducers for Research. */

export interface SentenceOffset { start: number; end: number }
export interface ResearchToken { start: number; end: number; surface: string; pos?: string; reading?: string; base?: string }
export interface CandidateSource {
  id: string;
  path?: string;
  revision: string;
  texts: Array<{ id: string; text: string; tokens: ResearchToken[] }>;
}
export interface CandidateEvidence { sourceId: string; textId: string; path?: string; revision: string; range: { start: number; end: number } }
export interface CandidateTerm { term: string; reading?: string; sourceIds: string[]; occurrenceCount: number; evidence: CandidateEvidence[] }
export const MAX_NLP_TEXT_UTF16 = 1_000_000;
export const MAX_CANDIDATE_ITEMS = 128;
export const MAX_CANDIDATE_TEXT_BYTES = 64 * 1024;
export const MAX_CANDIDATE_TOTAL_BYTES = 1024 * 1024;
export const MAX_TOKEN_COUNT_TEXTS = 128;
export const MAX_TOKEN_COUNT_TEXT_BYTES = 64 * 1024;
export const MAX_TOKEN_COUNT_BATCH_BYTES = 1024 * 1024;

/** Mirrors the pinned source's local model-ID grammar without importing Node path/config code. */
export function isSafeLocalModelId(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || value.includes("\\") || value.startsWith("/") ||
      value.includes(":") || /[\u0000-\u0020\u007F]/u.test(value)) return false;
  const parts = value.split("/");
  return parts.length <= 2 && parts.every((part) => part !== "" && part !== "." && part !== ".." && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(part));
}

const encoder = new TextEncoder();

interface SentenceSegment extends SentenceOffset { text: string }

interface SentenceSegmenter {
  segment(text: string): Iterable<{ segment: string; index: number }>;
}
type SentenceSegmenterConstructor = new (locale: string, options: { granularity: "sentence" }) => SentenceSegmenter;

const OPEN_BRACKETS = new Set(["「", "『"]);
const CLOSE_BRACKETS = new Set(["」", "』"]);

function splitLineFallback(line: string, lineStart: number): SentenceSegment[] {
  if (!line) return [{ text: "", start: lineStart, end: lineStart }];
  const output: SentenceSegment[] = [];
  const closers: string[] = [];
  let start = 0;
  let pendingQuotedBoundary = false;
  for (let i = 0; i < line.length; i++) {
    const character = line[i]!;
    const close = character === "「" ? "」" : character === "『" ? "』" : undefined;
    if (close) { closers.push(close); continue; }
    if (closers.at(-1) === character) {
      closers.pop();
      if (!closers.length && pendingQuotedBoundary) {
        output.push({ text: line.slice(start, i + 1), start: lineStart + start, end: lineStart + i + 1 });
        start = i + 1;
        pendingQuotedBoundary = false;
      }
      continue;
    }
    const terminal = /[。！？!?]/u.test(character) || character === "." && i > 0 && !/[0-9]/u.test(line[i - 1]!) && (i + 1 === line.length || /\s|[」』）)］\]｝}】〉》]/u.test(line[i + 1]!));
    if (!terminal) continue;
    while (i + 1 < line.length && /[。！？!?]/u.test(line[i + 1]!)) i++;
    if (closers.length) pendingQuotedBoundary = true;
    else {
      output.push({ text: line.slice(start, i + 1), start: lineStart + start, end: lineStart + i + 1 });
      start = i + 1;
    }
  }
  if (start < line.length) output.push({ text: line.slice(start), start: lineStart + start, end: lineStart + line.length });
  return output;
}

function createSentenceSegmenter(): SentenceSegmenter | null {
  const intl = (globalThis as unknown as { Intl?: { Segmenter?: SentenceSegmenterConstructor } }).Intl;
  const Segmenter = intl?.Segmenter;
  if (!Segmenter) return null;
  try { return new Segmenter("ja", { granularity: "sentence" }); }
  catch { return null; }
}

function consumeBracketDepth(line: string, state: { offset: number; depth: number }, end: number): number {
  while (state.offset < end) {
    const character = line[state.offset]!;
    if (OPEN_BRACKETS.has(character)) state.depth++;
    else if (CLOSE_BRACKETS.has(character)) state.depth = Math.max(0, state.depth - 1);
    state.offset++;
  }
  return state.depth;
}

function splitAtClosingBrackets(line: string, lineStart: number, segment: SentenceSegment, initialDepth: number): { segments: SentenceSegment[]; depth: number } {
  const relativeStart = segment.start - lineStart;
  const relativeEnd = segment.end - lineStart;
  const output: SentenceSegment[] = [];
  let depth = initialDepth;
  let chunkStart = relativeStart;
  for (let index = relativeStart; index < relativeEnd; index++) {
    const character = line[index]!;
    if (OPEN_BRACKETS.has(character)) {
      if (depth === 0 && index > chunkStart) {
        output.push({ text: line.slice(chunkStart, index), start: lineStart + chunkStart, end: lineStart + index });
        chunkStart = index;
      }
      depth++;
    } else if (CLOSE_BRACKETS.has(character)) {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        const end = index + 1;
        output.push({ text: line.slice(chunkStart, end), start: lineStart + chunkStart, end: lineStart + end });
        chunkStart = end;
      }
    }
  }
  if (chunkStart < relativeEnd) output.push({ text: line.slice(chunkStart, relativeEnd), start: lineStart + chunkStart, end: segment.end });
  return { segments: output.length > 0 ? output : [segment], depth };
}

function splitLineWithSegmenter(line: string, lineStart: number, segmenter: SentenceSegmenter | null): SentenceSegment[] {
  if (line.length === 0) return [{ text: "", start: lineStart, end: lineStart }];
  if (!segmenter) return splitLineFallback(line, lineStart);
  const raw: SentenceSegment[] = [];
  try {
    for (const { segment, index } of segmenter.segment(line)) {
      raw.push({ text: segment, start: lineStart + index, end: lineStart + index + segment.length });
    }
  } catch { return splitLineFallback(line, lineStart); }
  if (raw.length === 0) return splitLineFallback(line, lineStart);

  const merged: SentenceSegment[] = [];
  const depthState = { offset: 0, depth: 0 };
  let current = raw[0]!;
  for (let index = 1; index < raw.length; index++) {
    if (consumeBracketDepth(line, depthState, current.end - lineStart) > 0) {
      current = { text: line.slice(current.start - lineStart, raw[index]!.end - lineStart), start: current.start, end: raw[index]!.end };
    } else {
      merged.push(current);
      current = raw[index]!;
    }
  }
  merged.push(current);

  const output: SentenceSegment[] = [];
  let bracketDepth = 0;
  for (const segment of merged) {
    const split = splitAtClosingBrackets(line, lineStart, segment, bracketDepth);
    output.push(...split.segments);
    bracketDepth = split.depth;
  }
  return output;
}

function sentenceSegments(text: string): SentenceSegment[] {
  const output: SentenceSegment[] = [];
  // Reuse a single locale segmenter for this manuscript text, while retaining a safe fallback for
  // component runtimes whose JavaScript engine does not provide Intl.Segmenter.
  const segmenter = createSentenceSegmenter();
  let lineStart = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i < text.length && text[i] !== "\n") continue;
    output.push(...splitLineWithSegmenter(text.slice(lineStart, i), lineStart, segmenter));
    lineStart = i + 1;
  }
  return output;
}

export function splitIntoSentenceOffsets(text: string): SentenceOffset[] {
  if (text.length > MAX_NLP_TEXT_UTF16) throw new RangeError("Text exceeds the Research analysis limit");
  return sentenceSegments(text).map(({ start, end }) => ({ start, end }));
}
export function splitIntoSentences(text: string): string[] {
  if (text.length > MAX_NLP_TEXT_UTF16) throw new RangeError("Text exceeds the Research analysis limit");
  return sentenceSegments(text).map(({ text: sentence }) => sentence);
}

function levenshteinDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) rows[i]![0] = i;
  for (let j = 0; j <= b.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    rows[i]![j] = a[i - 1] === b[j - 1] ? rows[i - 1]![j - 1]! : 1 + Math.min(rows[i - 1]![j]!, rows[i]![j - 1]!, rows[i - 1]![j - 1]!);
  }
  return rows[a.length]![b.length]!;
}
function shouldCluster(a: string, b: string): boolean {
  if (a.includes(b) || b.includes(a)) if (Math.abs(a.length - b.length) <= 3) return true;
  const threshold = Math.min(Math.floor(Math.min(a.length, b.length) * 0.3), 2);
  return levenshteinDistance(a, b) <= threshold;
}

export function expandKnownSpellingVariants(query: string, knownTerms: readonly string[]): Array<{ value: string; reason: "literal" | "known-spelling" }> {
  const literal = query.trim();
  if (!literal) return [];
  const values = new Set<string>([literal]);
  for (const term of knownTerms) if (term && term !== literal && shouldCluster(literal, term)) values.add(term);
  return [...values].map((value, index) => ({ value, reason: index === 0 ? "literal" : "known-spelling" }));
}

export function suggestTermVariants(candidates: readonly { term: string; count: number }[], knownTerms: readonly string[]): Array<{
  candidate: string; canonical: string; count: number; reason: "known-spelling" | "candidate-cluster";
}> {
  const known = [...new Set(knownTerms)];
  const output: Array<{ candidate: string; canonical: string; count: number; reason: "known-spelling" | "candidate-cluster" }> = [];
  const matched = new Set<number>();
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const canonical = known.find((term) => shouldCluster(candidate.term, term));
    if (canonical !== undefined) {
      matched.add(i);
      if (canonical !== candidate.term) output.push({ candidate: candidate.term, canonical, count: candidate.count, reason: "known-spelling" });
    }
  }
  const remaining = candidates.map((_, i) => i).filter((i) => !matched.has(i));
  const parent = new Map<number, number>(remaining.map((i) => [i, i]));
  const find = (i: number): number => {
    const p = parent.get(i)!;
    if (p === i) return i;
    const root = find(p); parent.set(i, root); return root;
  };
  for (let left = 0; left < remaining.length; left++) for (let right = left + 1; right < remaining.length; right++) {
    const a = remaining[left]!; const b = remaining[right]!;
    if (shouldCluster(candidates[a]!.term, candidates[b]!.term)) parent.set(find(b), find(a));
  }
  const groups = new Map<number, number[]>();
  for (const i of remaining) { const root = find(i); const rows = groups.get(root) ?? []; rows.push(i); groups.set(root, rows); }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    let canonicalIndex = group[0]!;
    for (const i of group.slice(1)) if (candidates[i]!.count > candidates[canonicalIndex]!.count) canonicalIndex = i;
    for (const i of group) if (i !== canonicalIndex) output.push({ candidate: candidates[i]!.term, canonical: candidates[canonicalIndex]!.term, count: candidates[i]!.count, reason: "candidate-cluster" });
  }
  return output;
}

export function validateTokenCountTexts(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TOKEN_COUNT_TEXTS) throw new TypeError("texts must contain between 1 and 128 strings");
  let totalBytes = 0;
  return value.map((text) => {
    if (typeof text !== "string") throw new TypeError("texts must contain only strings");
    const bytes = encoder.encode(text).byteLength;
    if (bytes > MAX_TOKEN_COUNT_TEXT_BYTES) throw Object.assign(new RangeError("Each token count text exceeds 64 KiB"), { code: "capacity" });
    totalBytes += bytes;
    if (totalBytes > MAX_TOKEN_COUNT_BATCH_BYTES) throw Object.assign(new RangeError("Token count batch exceeds 1 MiB"), { code: "capacity" });
    return text;
  });
}

export function approximateTokenCount(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const character of text) {
    if (/[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u.test(character)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 3);
}

function isNoun(token: ResearchToken): boolean { return token.pos === "noun" || token.pos === "名詞"; }
function eligibleCandidate(term: string): boolean { return Array.from(term).length >= 2 && !/^[\s\p{P}\p{S}0-9]+$/u.test(term); }

/** Reduce tokenizer outputs to reproducible candidate counts and source-bound evidence. */
export function aggregateCandidateEvidence(
  sources: readonly CandidateSource[],
  knownTerms: ReadonlySet<string>,
): CandidateTerm[] {
  if (sources.length > MAX_CANDIDATE_ITEMS) throw Object.assign(new RangeError("Candidate corpus exceeds 128 items"), { code: "capacity" });
  const aggregate = new Map<string, { reading?: string; sourceIds: Set<string>; evidence: CandidateEvidence[]; occurrenceCount: number }>();
  let totalBytes = 0;
  const sourceIds = new Set<string>();
  for (const source of sources) {
    if (!source || typeof source.id !== "string" || !source.id || sourceIds.has(source.id) || !/^[a-f0-9]{64}$/u.test(source.revision) ||
        source.path !== undefined && !isSafeRelativePath(source.path)) throw new TypeError("Candidate source identity or revision is invalid");
    sourceIds.add(source.id);
    const perSource = new Map<string, { reading?: string; evidence: CandidateEvidence[]; occurrenceCount: number }>();
    for (const item of source.texts) {
      if (!item || typeof item.id !== "string" || typeof item.text !== "string" || item.text.length > MAX_NLP_TEXT_UTF16 || !Array.isArray(item.tokens)) throw new TypeError("Candidate text input is invalid");
      totalBytes += encoder.encode(item.text).byteLength;
      if (totalBytes > MAX_CANDIDATE_TOTAL_BYTES) throw Object.assign(new RangeError("Candidate corpus exceeds 1 MiB"), { code: "capacity" });
      if (encoder.encode(item.text).byteLength > MAX_CANDIDATE_TEXT_BYTES) throw Object.assign(new RangeError("Candidate text exceeds 64 KiB"), { code: "capacity" });
      let current: ResearchToken[] = [];
      const flush = () => {
        if (!current.length) return;
        const term = current.map(({ surface }) => surface).join("");
        if (eligibleCandidate(term) && !knownTerms.has(term)) {
          const start = current[0]!.start;
          const end = current.at(-1)!.end;
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || item.text.slice(start, end) !== term) throw new TypeError("Tokenizer candidate offsets do not match source text");
          const reading = current.every(({ reading }) => typeof reading === "string") ? current.map(({ reading }) => reading).join("") : undefined;
          const rows = perSource.get(term) ?? { reading, evidence: [], occurrenceCount: 0 };
          rows.reading ??= reading;
          rows.occurrenceCount++;
          if (rows.evidence.length < 5) rows.evidence.push({ sourceId: source.id, textId: item.id, ...(source.path ? { path: source.path } : {}), revision: source.revision, range: { start, end } });
          perSource.set(term, rows);
        }
        current = [];
      };
      for (const token of item.tokens) { if (isNoun(token)) current.push(token); else flush(); }
      flush();
    }
    for (const [term, row] of perSource) {
      const entry = aggregate.get(term) ?? { reading: undefined, sourceIds: new Set<string>(), evidence: [], occurrenceCount: 0 };
      entry.reading ??= row.reading;
      entry.sourceIds.add(source.id);
      entry.occurrenceCount += row.occurrenceCount;
      for (const evidence of row.evidence) if (entry.evidence.length < 5) entry.evidence.push(evidence);
      aggregate.set(term, entry);
    }
  }
  return [...aggregate].sort(([a, left], [b, right]) => right.occurrenceCount - left.occurrenceCount || (a < b ? -1 : a > b ? 1 : 0)).map(([term, value]) => ({
    term, ...(value.reading ? { reading: value.reading } : {}), sourceIds: [...value.sourceIds], occurrenceCount: value.occurrenceCount, evidence: value.evidence,
  }));
}
import { isSafeRelativePath } from "./core.js";

