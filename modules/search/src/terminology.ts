import { assertProjectPath } from "@scriptorium/contracts";

export const TERM_REGISTRY_PATH = "meta/scriptorium/modules/search/terms.json";
export const MAX_TERMS = 5_000;
export const MAX_ALIASES_PER_TERM = 32;

export interface SearchTerm {
  id: string;
  canonical: string;
  aliases: string[];
  targetPath: string;
}

export interface TermRegistry { schemaVersion: 1; terms: SearchTerm[] }
export interface TermSpan { start: number; end: number; termId: string; targetPath: string }
export interface AmbiguousTermSpan { start: number; end: number; alias: string; termIds: string[] }
export interface TermResolution { spans: TermSpan[]; ambiguities: AmbiguousTermSpan[] }

export function normalizeTerm(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseTermRegistry(value: unknown): TermRegistry {
  if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.terms) || value.terms.length > MAX_TERMS) {
    throw new TypeError("Search term registry has an unsupported format");
  }
  const ids = new Set<string>();
  const terms = value.terms.map((raw, index): SearchTerm => {
    if (!record(raw) || typeof raw.id !== "string" || !/^[A-Za-z0-9_-]{1,96}$/u.test(raw.id) || ids.has(raw.id) ||
        typeof raw.canonical !== "string" || !raw.canonical.trim() || raw.canonical.length > 256 ||
        !Array.isArray(raw.aliases) || raw.aliases.length > MAX_ALIASES_PER_TERM ||
        raw.aliases.some((alias) => typeof alias !== "string" || !alias.trim() || alias.length > 256) ||
        typeof raw.targetPath !== "string") {
      throw new TypeError(`Search term registry entry ${index + 1} is invalid`);
    }
    const canonical = raw.canonical.trim();
    const aliases = [...new Set((raw.aliases as string[]).map((alias) => alias.trim()).filter((alias) => normalizeTerm(alias) !== normalizeTerm(canonical)))];
    assertProjectPath(raw.targetPath);
    ids.add(raw.id);
    return { id: raw.id, canonical, aliases, targetPath: raw.targetPath };
  });
  terms.sort((left, right) => left.id.localeCompare(right.id));
  return { schemaVersion: 1, terms };
}

interface AliasEntry { alias: string; normalized: string; term: SearchTerm }
interface NormalizedText { value: string; starts: number[]; ends: number[] }

/** Keeps offsets in the original UTF-16 string while matching normalized graphemes. */
function normalizeWithOffsets(text: string): NormalizedText {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let value = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (const segment of segmenter.segment(text)) {
    const normalized = normalizeTerm(segment.segment);
    value += normalized;
    for (let index = 0; index < normalized.length; index += 1) {
      starts.push(segment.index);
      ends.push(segment.index + segment.segment.length);
    }
  }
  return { value, starts, ends };
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}_]/u.test(value);
}

function hasWholeWordBoundary(text: string, start: number, end: number, alias: string): boolean {
  if (!/[A-Za-z0-9_]$/u.test(alias) && !/^[A-Za-z0-9_]/u.test(alias)) return true;
  return !isWordCharacter(Array.from(text.slice(0, start)).at(-1)) && !isWordCharacter(Array.from(text.slice(end))[0]);
}

/**
 * Resolves a bounded visible text slice. Shared aliases are returned for inspection and never
 * become links; overlapping unique aliases use longest match, then stable id ordering.
 */
export function resolveTermSpans(text: string, terms: readonly SearchTerm[], validTargetPaths?: ReadonlySet<string>): TermResolution {
  const normalizedText = normalizeWithOffsets(text);
  const aliases = new Map<string, AliasEntry[]>();
  for (const term of terms) {
    if (validTargetPaths && !validTargetPaths.has(term.targetPath)) continue;
    for (const alias of [term.canonical, ...term.aliases]) {
      const normalized = normalizeTerm(alias);
      if (!normalized) continue;
      const matches = aliases.get(normalized) ?? [];
      if (!matches.some((entry) => entry.term.id === term.id)) matches.push({ alias, normalized, term });
      aliases.set(normalized, matches);
    }
  }
  const candidates: Array<{ start: number; end: number; alias: string; terms: SearchTerm[] }> = [];
  for (const [normalized, entries] of aliases) {
    let at = normalizedText.value.indexOf(normalized);
    while (at !== -1) {
      const last = at + normalized.length;
      const start = normalizedText.starts[at];
      const end = normalizedText.ends[last - 1];
      if (start !== undefined && end !== undefined && hasWholeWordBoundary(normalizedText.value, at, last, normalized)) {
        candidates.push({ start, end, alias: entries[0]!.alias, terms: entries.map(({ term }) => term) });
      }
      at = normalizedText.value.indexOf(normalized, at + Math.max(1, normalized.length));
    }
  }
  candidates.sort((left, right) => (right.end - right.start) - (left.end - left.start) ||
    left.start - right.start || left.alias.localeCompare(right.alias) ||
    left.terms[0]!.id.localeCompare(right.terms[0]!.id));
  const spans: TermSpan[] = [];
  const ambiguities: AmbiguousTermSpan[] = [];
  const accepted: Array<{ start: number; end: number }> = [];
  for (const match of candidates) {
    if (accepted.some((item) => match.start < item.end && item.start < match.end)) continue;
    accepted.push({ start: match.start, end: match.end });
    const termIds = [...new Set(match.terms.map((term) => term.id))].sort();
    if (termIds.length > 1) ambiguities.push({ start: match.start, end: match.end, alias: match.alias, termIds });
    else spans.push({ start: match.start, end: match.end, termId: termIds[0]!, targetPath: match.terms[0]!.targetPath });
  }
  spans.sort((left, right) => left.start - right.start || left.end - right.end);
  ambiguities.sort((left, right) => left.start - right.start || left.end - right.end);
  return { spans, ambiguities };
}

