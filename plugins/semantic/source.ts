import YAML from "yaml";
import { splitIntoSentenceOffsets } from "./sentences.ts";

export interface SourceSpan {
  path: string;
  revision: string;
  start: number;
  end: number;
  quote: string;
}

export interface SemanticSourcePassage {
  entityId: string;
  sourcePath: string;
  sourceRevision: string;
  sentenceIndex: number;
  type: string;
  name?: string;
  text: string;
  evidence: SourceSpan;
}

export interface SemanticSourceEntity {
  id: string;
  type: string;
  path: string;
  revision: string;
  name?: string;
  aliases: string[];
  passages: SemanticSourcePassage[];
}

interface MappedText {
  text: string;
  starts: number[];
  ends: number[];
}

interface SourceScalar {
  value: unknown;
  range?: number[];
  srcToken?: {
    type?: string;
    offset?: number;
    indent?: number;
    source?: string;
    props?: Array<{ type?: string; offset?: number; source?: string }>;
  };
}

const ENTITY_PREFIXES = ["bible", "plot", "meta", "manuscript"] as const;
const EMBEDDABLE_TYPES = new Set(["scene", "manuscript", "character", "location", "item", "faction", "event", "thread", "lore"]);
const FRONT_MATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;

export function isSemanticSourcePath(path: string): boolean {
  return ENTITY_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)) && /\.(?:ya?ml|md)$/iu.test(path);
}

function fail(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, retryable: code === "capacity" || code === "timeout" });
}

function inferredType(path: string, data: Record<string, unknown>): string {
  if (typeof data.type === "string") return data.type;
  const normalized = `/${path.replaceAll("\\", "/")}`;
  const directoryTypes: Array<[string, string]> = [
    ["/bible/characters/", "character"], ["/bible/locations/", "location"],
    ["/bible/items/", "item"], ["/bible/factions/", "faction"],
    ["/bible/timeline/events/", "event"], ["/bible/lore/", "lore"],
    ["/plot/threads/", "thread"], ["/plot/arcs/", "arc"],
    ["/bible/dialogue_sketches/", "dialogue_sketch"],
  ];
  for (const [prefix, type] of directoryTypes) if (normalized.includes(prefix)) return type;
  if (normalized.includes("/plot/volumes/") && normalized.endsWith("volume.yaml")) return "volume";
  if (normalized.includes("/plot/volumes/") && normalized.endsWith("chapter.yaml")) return "chapter";
  if (normalized.includes("/scenes/") && /\.ya?ml$/iu.test(path)) return "scene";
  if (normalized.includes("/manuscript/") && /\.md$/iu.test(path)) return "manuscript";
  return "character";
}

function sourceMap(text: string, offset: number): MappedText {
  const starts = new Array<number>(text.length);
  const ends = new Array<number>(text.length);
  for (let index = 0; index < text.length; index++) {
    starts[index] = offset + index;
    ends[index] = offset + index + 1;
  }
  return { text, starts, ends };
}

function trimMapped(value: MappedText): MappedText {
  const leading = value.text.length - value.text.trimStart().length;
  const trailing = value.text.length - value.text.trimEnd().length;
  const end = Math.max(leading, value.text.length - trailing);
  return { text: value.text.slice(leading, end), starts: value.starts.slice(leading, end), ends: value.ends.slice(leading, end) };
}

function splitRawLines(source: string, absoluteStart: number): Array<{ text: string; start: number; eolStart: number; eolEnd: number }> {
  const lines: Array<{ text: string; start: number; eolStart: number; eolEnd: number }> = [];
  let start = 0;
  while (start < source.length) {
    let end = start;
    while (end < source.length && source[end] !== "\n" && source[end] !== "\r") end++;
    const eolStart = end;
    if (source[end] === "\r" && source[end + 1] === "\n") end += 2;
    else if (end < source.length) end++;
    lines.push({ text: source.slice(start, eolStart), start: absoluteStart + start, eolStart: absoluteStart + eolStart, eolEnd: absoluteStart + end });
    start = end;
  }
  if (source.length === 0) return [];
  return lines;
}

function blockScalar(node: SourceScalar, sourceBase: number): MappedText | null {
  const token = node.srcToken;
  const raw = token?.source;
  if (!token || token.type !== "block-scalar" || typeof raw !== "string" || typeof node.value !== "string") return null;
  const header = token.props?.find((item) => item.type === "block-scalar-header");
  const headerNewline = token.props?.find((item) => item.type === "newline" && (header?.offset ?? -1) < (item.offset ?? -1));
  if (!header || !headerNewline || typeof header.offset !== "number" || typeof header.source !== "string" || typeof headerNewline.source !== "string") return null;
  const style = header.source[0];
  if (style !== "|" && style !== ">") return null;
  const bodyBase = sourceBase + headerNewline.offset! + headerNewline.source.length;
  const lines = splitRawLines(raw, bodyBase);
  const explicitIndent = /[|>][+-]?([1-9])/u.exec(header.source)?.[1];
  let indentation = explicitIndent ? Number(explicitIndent) : undefined;
  if (indentation === undefined) {
    for (const line of lines) {
      if (!line.text.trim()) continue;
      indentation = line.text.length - line.text.trimStart().length;
      break;
    }
  }
  indentation ??= 0;
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  const append = (character: string, start: number, end: number) => {
    text += character;
    starts.push(start);
    ends.push(end);
  };
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    const strip = Math.min(indentation, line.text.length - (line.text.length - line.text.trimStart().length));
    const contentStart = line.start + strip;
    const content = line.text.slice(strip);
    for (let index = 0; index < content.length; index++) append(content[index]!, contentStart + index, contentStart + index + 1);
    if (line.eolEnd > line.eolStart && lineIndex < lines.length - 1) {
      const next = lines[lineIndex + 1]!;
      const nextIndent = next.text.length - next.text.trimStart().length;
      const nextContent = next.text.slice(Math.min(indentation, nextIndent));
      const folded = style === ">" && content.trim().length > 0 && nextContent.trim().length > 0;
      append(folded ? " " : "\n", line.eolStart, line.eolEnd);
    } else if (line.eolEnd > line.eolStart && lineIndex === lines.length - 1) {
      append("\n", line.eolStart, line.eolEnd);
    }
  }
  const expected = node.value;
  if (!text.startsWith(expected)) return null;
  return { text: expected, starts: starts.slice(0, expected.length), ends: ends.slice(0, expected.length) };
}

function mappedYamlScalar(node: unknown, sourceBase: number): MappedText | null {
  if (!node || typeof node !== "object") return null;
  const scalar = node as SourceScalar;
  if (typeof scalar.value !== "string") return null;
  const block = blockScalar(scalar, sourceBase);
  if (block) return trimMapped(block);
  const raw = scalar.srcToken?.source;
  const offset = scalar.srcToken?.offset ?? scalar.range?.[0];
  if (typeof raw !== "string" || typeof offset !== "number") return null;
  const valueOffset = raw.indexOf(scalar.value);
  if (valueOffset < 0 || raw.slice(valueOffset, valueOffset + scalar.value.length) !== scalar.value) return null;
  return trimMapped(sourceMap(scalar.value, sourceBase + offset + valueOffset));
}

function parseYaml(yamlSource: string): { raw: Record<string, unknown>; nodes: Map<string, unknown> } | null {
  try {
    const document = YAML.parseDocument(yamlSource, { keepSourceTokens: true, uniqueKeys: true });
    if (document.errors.length > 0) return null;
    const value: unknown = document.toJS();
    if (value === null || value === undefined) return { raw: {}, nodes: new Map() };
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const nodes = new Map<string, unknown>();
    const contents = document.contents as { items?: Array<{ key?: { value?: unknown }; value?: unknown }> } | null;
    for (const pair of contents?.items ?? []) if (typeof pair.key?.value === "string") nodes.set(pair.key.value, pair.value);
    return { raw: value as Record<string, unknown>, nodes };
  } catch {
    return null;
  }
}

function markdownParts(path: string, content: string): { raw: Record<string, unknown>; nodes: Map<string, unknown>; parts: MappedText[] } | null {
  const match = FRONT_MATTER_RE.exec(content);
  if (!match) return { raw: {}, nodes: new Map(), parts: [trimMapped(sourceMap(content, 0))] };
  const opening = /^---[ \t]*\r?\n/u.exec(content)?.[0];
  if (!opening) return null;
  const yamlStart = opening.length;
  const parsed = parseYaml(match[1]!);
  if (!parsed) return null;
  const bodyStart = match[0].length;
  const body = trimMapped(sourceMap(content.slice(bodyStart), bodyStart));
  const parts = body.text ? [body] : [];
  for (const key of ["description", "notes"] as const) {
    const value = parsed.raw[key];
    if (typeof value !== "string" || !value.trim()) continue;
    const mapped = mappedYamlScalar(parsed.nodes.get(key), yamlStart);
    if (!mapped) throw fail("capacity", `Semantic cannot preserve an exact source map for ${path} front matter field ${key}`);
    parts.push(mapped);
  }
  return { raw: parsed.raw, nodes: parsed.nodes, parts };
}

function yamlParts(path: string, content: string): { raw: Record<string, unknown>; parts: MappedText[] } | null {
  const parsed = parseYaml(content);
  if (!parsed) return null;
  if (typeof parsed.raw.id !== "string") return null;
  const parts: MappedText[] = [];
  for (const key of ["body", "description", "notes"] as const) {
    const value = parsed.raw[key];
    if (typeof value !== "string" || !value.trim()) continue;
    const mapped = mappedYamlScalar(parsed.nodes.get(key), 0);
    if (!mapped) throw fail("capacity", `Semantic cannot preserve an exact source map for ${path} field ${key}`);
    parts.push(mapped);
  }
  return { raw: parsed.raw, parts };
}

export function parseSemanticSourceFile(path: string, revision: string, content: string, linked?: { entityId: string; type: "manuscript" }): SemanticSourceEntity | null {
  if (!linked && !isSemanticSourcePath(path)) return null;
  const isMarkdown = /\.md$/iu.test(path);
  const parsed = isMarkdown ? markdownParts(path, content) : yamlParts(path, content);
  if (!parsed) return null;
  const { raw, parts } = parsed;
  const id = linked?.entityId ?? (isMarkdown
    ? `ms-${path.slice("manuscript/".length).replaceAll("/", "-").replace(/\.md$/iu, "")}`
    : typeof raw.id === "string" ? raw.id : "");
  if (!id) return null;
  const type = linked?.type ?? inferredType(path, raw);
  if (!EMBEDDABLE_TYPES.has(type)) return { id, type, path, revision, aliases: [], passages: [] };
  const name = typeof raw.name === "string" ? raw.name : typeof raw.title === "string" && isMarkdown ? raw.title : undefined;
  const aliases = Array.isArray(raw.aliases) ? raw.aliases.filter((alias): alias is string => typeof alias === "string") : [];
  const passages: SemanticSourcePassage[] = [];
  let sentenceIndex = 0;
  for (const part of parts) {
    if (!part.text.trim()) continue;
    for (const range of splitIntoSentenceOffsets(part.text)) {
      const rawText = part.text.slice(range.start, range.end);
      const leading = rawText.length - rawText.trimStart().length;
      const trailing = rawText.length - rawText.trimEnd().length;
      const start = range.start + leading;
      const end = Math.max(start, range.end - trailing);
      const text = part.text.slice(start, end);
      if (!text) continue;
      if (text.length > 32_768) throw fail("capacity", `Semantic source sentence exceeds 32768 characters in ${path}`);
      const sourceStart = part.starts[start];
      const sourceEnd = part.ends[end - 1];
      if (!Number.isInteger(sourceStart) || !Number.isInteger(sourceEnd) || sourceEnd! <= sourceStart!) {
        throw fail("capacity", `Semantic could not map sentence offsets back to ${path}`);
      }
      const quote = content.slice(sourceStart!, sourceEnd!);
      if (!quote || quote.length !== sourceEnd! - sourceStart!) throw fail("capacity", `Semantic source evidence is discontinuous in ${path}`);
      passages.push({
        entityId: id,
        sourcePath: path,
        sourceRevision: revision,
        sentenceIndex: sentenceIndex++,
        type,
        ...(name ? { name } : {}),
        text,
        evidence: { path, revision, start: sourceStart!, end: sourceEnd!, quote },
      });
    }
  }
  return { id, type, path, revision, ...(name ? { name } : {}), aliases, passages };
}
