export type SearchMode = "fulltext" | "exact" | "prefix";

export interface SearchDocument {
  path: string;
  revision: string;
  content: string;
  normalizedPath: string;
  normalizedContent: string;
  tokens: ReadonlySet<string>;
}

export interface SearchHit {
  kind: "document" | "term";
  path: string;
  title: string;
  revision: string;
  score: number;
  snippet: string;
  termId?: string;
  aliases?: string[];
}

export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

export function lexicalTokens(value: string): string[] {
  const normalized = normalizeSearchText(value);
  const output = new Set<string>();
  for (const match of normalized.matchAll(/[\p{L}\p{N}_]+/gu)) {
    const token = match[0];
    if (/^[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]+$/u.test(token)) {
      const chars = Array.from(token);
      if (chars.length === 1) output.add(chars[0]!);
      for (let index = 0; index < chars.length - 1; index += 1) output.add(chars.slice(index, index + 2).join(""));
    } else output.add(token);
  }
  return [...output];
}

export function createSearchDocument(path: string, revision: string, content: string): SearchDocument {
  return {
    path,
    revision,
    content,
    normalizedPath: normalizeSearchText(path),
    normalizedContent: normalizeSearchText(content),
    tokens: new Set(lexicalTokens(`${path}\n${content}`)),
  };
}

function titleFor(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.replace(/\.(?:md|markdown|txt|ya?ml)$/iu, "");
}

function snippet(content: string, normalizedContent: string, query: string, tokens: readonly string[]): string {
  let offset = query ? normalizedContent.indexOf(query) : -1;
  if (offset < 0) {
    for (const token of tokens) {
      offset = normalizedContent.indexOf(token);
      if (offset >= 0) break;
    }
  }
  if (offset < 0) return content.slice(0, 180).trim();
  const start = Math.max(0, offset - 70);
  const end = Math.min(content.length, offset + 180);
  return `${start ? "…" : ""}${content.slice(start, end).trim()}${end < content.length ? "…" : ""}`;
}

function documentScore(document: SearchDocument, query: string, tokens: readonly string[], mode: SearchMode): number {
  if (mode === "prefix") {
    if (document.normalizedPath.startsWith(query)) return 80;
    if (document.normalizedContent.startsWith(query)) return 35;
    if ([...document.tokens].some((token) => token.startsWith(query))) return 25;
    return 0;
  }
  if (mode === "exact") {
    return document.normalizedPath === query || normalizeSearchText(titleFor(document.path)) === query ? 100 : 0;
  }
  if (document.normalizedPath === query) return 120;
  if (normalizeSearchText(titleFor(document.path)) === query) return 110;
  if (document.normalizedPath.includes(query)) return 85;
  if (document.normalizedContent.includes(query)) return 65;
  if (tokens.length > 0 && tokens.every((token) => document.tokens.has(token))) return 30 + tokens.length;
  return 0;
}

export function searchDocuments(
  documents: Iterable<SearchDocument>,
  rawQuery: string,
  mode: SearchMode,
  limit: number,
  scope?: string,
  queryHints: readonly string[] = [],
): SearchHit[] {
  const query = normalizeSearchText(rawQuery.trim());
  const tokens = lexicalTokens(rawQuery);
  const hints = queryHints.map(normalizeSearchText).filter((hint) => hint.length > 1);
  const hits: SearchHit[] = [];
  for (const document of documents) {
    if (scope && document.path !== scope && !document.path.startsWith(`${scope}/`)) continue;
    let score = documentScore(document, query, tokens, mode);
    if (mode === "fulltext" && hints.length && hints.every((hint) => document.normalizedContent.includes(hint))) score = Math.max(score, 45 + hints.length);
    if (!score) continue;
    hits.push({ kind: "document", path: document.path, title: titleFor(document.path), revision: document.revision,
      score, snippet: snippet(document.content, document.normalizedContent, query, tokens) });
  }
  return hits.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path)).slice(0, limit);
}

export function searchTerms(
  terms: readonly { id: string; canonical: string; aliases: string[]; targetPath: string }[],
  revisions: ReadonlyMap<string, string>,
  rawQuery: string,
  mode: SearchMode,
  scope?: string,
): SearchHit[] {
  const query = normalizeSearchText(rawQuery.trim());
  const hits: SearchHit[] = [];
  for (const term of terms) {
    const revision = revisions.get(term.targetPath);
    if (!revision || scope && term.targetPath !== scope && !term.targetPath.startsWith(`${scope}/`)) continue;
    const values = [term.canonical, ...term.aliases].map(normalizeSearchText);
    const exact = values.some((value) => value === query);
    const prefix = values.some((value) => value.startsWith(query));
    if (mode === "exact" && !exact || mode === "prefix" && !prefix) continue;
    if (mode === "fulltext" && !exact && !prefix) continue;
    hits.push({ kind: "term", path: term.targetPath, title: term.canonical, revision, score: exact ? 1_000 : prefix ? 500 : 250,
      snippet: term.aliases.length ? `別名: ${term.aliases.join("、")}` : "", termId: term.id, aliases: [...term.aliases] });
  }
  return hits.sort((left, right) => right.score - left.score || left.title.localeCompare(right.title) || left.termId!.localeCompare(right.termId!));
}

