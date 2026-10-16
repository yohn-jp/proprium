import type { Token } from "./tokenizer/types.js";
import { isNoun } from "./tokenizer/pos.js";

const MIN_TERM_LENGTH = 2;
const SYMBOLS_ONLY_RE = /^[\s\p{P}\p{S}0-9]+$/u;

export interface CandidateTerm {
  term: string;
  reading: string | null;
  sourceEntityIds: string[];
  occurrenceCount: number;
}

export interface CandidateEntityInput {
  id: string;
  name?: string;
  aliases?: string[];
  raw?: Record<string, unknown>;
  body?: string;
}

type NotesBlock = { type: "paragraph"; text: string } | { type: "definitions" | "steps"; items: Array<{ term: string; description: string }> };
const STEP_RE = /^\s*\d+[.、．)]\s+(.+)$/;
const DEFINITION_RE = /^\s*[*・-]\s+(.+)$/;

function notesBlocksFromText(text: string): NotesBlock[] {
  const blocks: NotesBlock[] = [];
  let paragraph: string[] = [];
  let listType: "definitions" | "steps" | null = null;
  let items: Array<{ term: string; description: string }> = [];
  const flushParagraph = () => { if (paragraph.length) blocks.push({ type: "paragraph", text: paragraph.join("\n") }); paragraph = []; };
  const flushList = () => { if (listType && items.length) blocks.push({ type: listType, items }); listType = null; items = []; };
  const lines = text.split("\n");
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  for (const line of lines.slice(start, end)) {
    if (line.trim() === "") { flushParagraph(); flushList(); continue; }
    const step = STEP_RE.exec(line);
    const definition = step ? null : DEFINITION_RE.exec(line);
    const type = step ? "steps" : definition ? "definitions" : null;
    if (!type) { flushList(); paragraph.push(line); continue; }
    flushParagraph();
    if (listType !== type) flushList();
    listType = type;
    const content = (step ?? definition)![1];
    const colon = content.search(/[：:]/);
    if (colon < 0) items.push({ term: "", description: content.trim() });
    else items.push({ term: content.slice(0, colon).trim().replace(/^\*\*(.*)\*\*$/, "$1").trim(), description: content.slice(colon + 1).trim() });
  }
  flushParagraph(); flushList();
  return blocks;
}

function blocksFromRaw(value: unknown): NotesBlock[] | null {
  if (typeof value === "string") return notesBlocksFromText(value);
  if (!Array.isArray(value)) return null;
  const output: NotesBlock[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const block = item as Record<string, unknown>;
    if (block.type === "paragraph" && typeof block.text === "string") output.push({ type: "paragraph", text: block.text });
    else if ((block.type === "definitions" || block.type === "steps") && Array.isArray(block.items) && block.items.every((row) => !!row && typeof row === "object" && typeof (row as Record<string, unknown>).term === "string" && typeof (row as Record<string, unknown>).description === "string")) {
      output.push({ type: block.type, items: block.items as Array<{ term: string; description: string }> });
    } else return null;
  }
  return output;
}

function collectBlockTexts(blocks: NotesBlock[], out: string[]): void {
  for (const block of blocks) {
    if (block.type === "paragraph") out.push(block.text);
    else for (const item of block.items) out.push(item.term, item.description);
  }
}

function collectSectionTexts(value: unknown, out: string[]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const section = value as Record<string, unknown>;
  if (typeof section.heading !== "string" || !Array.isArray(section.children)) return false;
  const blocks = blocksFromRaw(section.body);
  if (blocks) collectBlockTexts(blocks, out);
  else if (Array.isArray(section.body) && section.body.every((item) => !!item && typeof item === "object" && typeof (item as Record<string, unknown>).text === "string" && !("type" in (item as Record<string, unknown>)))) {
    const legacyText = (section.body as Array<{ text: string }>).map((item) => item.text).join("\n\n");
    collectBlockTexts(notesBlocksFromText(legacyText), out);
  } else return false;
  for (const child of section.children) if (!collectSectionTexts(child, out)) return false;
  return true;
}

/** Exact source candidate input: entity name/aliases plus notes and body text. */
export function collectEntityTexts(entity: CandidateEntityInput): string[] {
  const texts: string[] = [];
  const notes = entity.raw?.notes;
  if (typeof notes === "string") texts.push(notes);
  else if (notes && typeof notes === "object" && !Array.isArray(notes)) {
    const root = notes as Record<string, unknown>;
    const lead = blocksFromRaw(root.lead);
    if (lead && Array.isArray(root.sections)) {
      const sections: string[] = [];
      if (root.sections.every((section) => collectSectionTexts(section, sections))) {
        collectBlockTexts(lead, texts);
        texts.push(...sections);
      }
    }
  }
  if (entity.body) texts.push(entity.body);
  return texts;
}

export function extractCompoundNouns(tokens: Token[]): string[] {
  const terms: string[] = [];
  let current = "";
  for (const token of tokens) {
    if (isNoun(token)) current += token.surface;
    else {
      if (current) terms.push(current);
      current = "";
    }
  }
  if (current) terms.push(current);
  return terms;
}

export function extractCompoundNounsWithReading(tokens: Token[]): Array<{ term: string; reading: string | null }> {
  const terms: Array<{ term: string; reading: string | null }> = [];
  let current = "";
  let currentReading = "";
  let readingKnown = true;
  const flush = () => {
    if (current) terms.push({ term: current, reading: readingKnown ? currentReading : null });
    current = "";
    currentReading = "";
    readingKnown = true;
  };
  for (const token of tokens) {
    if (isNoun(token)) {
      current += token.surface;
      if (!token.reading) readingKnown = false;
      else currentReading += token.reading;
    } else flush();
  }
  flush();
  return terms;
}

export function isEligibleTerm(term: string): boolean {
  return term.length >= MIN_TERM_LENGTH && !SYMBOLS_ONLY_RE.test(term);
}

/** Source candidate discovery, adapted from in-memory entities to pinned snapshot documents. */
export function aggregateCandidateTerms(
  documents: ReadonlyArray<{ id: string; tokenizedTexts: ReadonlyArray<Token[]> }>,
  knownTerms: ReadonlySet<string>,
): CandidateTerm[] {
  const aggregated = new Map<string, { reading: string | null; sourceEntityIds: Set<string>; occurrenceCount: number }>();
  for (const document of documents) {
    const seenInDocument = new Map<string, { count: number; reading: string | null }>();
    for (const tokens of document.tokenizedTexts) {
      for (const { term, reading } of extractCompoundNounsWithReading([...tokens])) {
        if (!isEligibleTerm(term) || knownTerms.has(term)) continue;
        const existing = seenInDocument.get(term);
        if (existing) existing.count++;
        else seenInDocument.set(term, { count: 1, reading });
      }
    }
    for (const [term, value] of seenInDocument) {
      const entry = aggregated.get(term) ?? { reading: null, sourceEntityIds: new Set<string>(), occurrenceCount: 0 };
      if (entry.reading === null) entry.reading = value.reading;
      entry.sourceEntityIds.add(document.id);
      entry.occurrenceCount += value.count;
      aggregated.set(term, entry);
    }
  }
  return [...aggregated].map(([term, entry]) => ({
    term, reading: entry.reading, sourceEntityIds: [...entry.sourceEntityIds], occurrenceCount: entry.occurrenceCount,
  }));
}
