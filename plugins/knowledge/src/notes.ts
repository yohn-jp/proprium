export type NotesBlock =
  | { type: "paragraph"; text: string }
  | { type: "definitions" | "steps"; items: Array<{ term: string; description: string }> };
export interface NotesSection { heading: string; body: NotesBlock[]; children: NotesSection[] }
export interface StructuredNotes { lead: NotesBlock[]; sections: NotesSection[] }

function appendToParagraph(block: NotesBlock | undefined, text: string): NotesBlock {
  const trimmed = text.trim();
  if (block?.type !== "paragraph") return { type: "paragraph", text: trimmed };
  const base = block.text.trimEnd();
  return { type: "paragraph", text: base ? `${base}\n${trimmed}` : trimmed };
}

function ensureSection(notes: StructuredNotes, sectionIndex: number): NotesSection {
  while (notes.sections.length <= sectionIndex) notes.sections.push({ heading: "", body: [], children: [] });
  return notes.sections[sectionIndex]!;
}

/** Source-compatible approval behavior for a Zukan suggestion's note block. */
export function appendProposedTextToNotes(
  notes: StructuredNotes | null | undefined,
  blockPath: string,
  proposedText: string,
): StructuredNotes {
  const next: StructuredNotes = notes
    ? { lead: notes.lead.map((block) => structuredClone(block)), sections: notes.sections.map((section) => structuredClone(section)) }
    : { lead: [], sections: [] };
  const text = proposedText.trim();
  if (!text) return next;
  const lead = /^lead\.(\d+)$/.exec(blockPath);
  const section = /^sections\.(\d+)\.body\.(\d+)$/.exec(blockPath);
  if (lead) {
    const index = Number(lead[1]);
    while (next.lead.length < index) next.lead.push({ type: "paragraph", text: "" });
    if (next.lead.length === index) next.lead.push({ type: "paragraph", text });
    else next.lead[index] = appendToParagraph(next.lead[index], text);
    return next;
  }
  if (section) {
    const sectionIndex = Number(section[1]);
    const bodyIndex = Number(section[2]);
    const target = ensureSection(next, sectionIndex);
    while (target.body.length < bodyIndex) target.body.push({ type: "paragraph", text: "" });
    if (target.body.length === bodyIndex) target.body.push({ type: "paragraph", text });
    else target.body[bodyIndex] = appendToParagraph(target.body[bodyIndex], text);
    return next;
  }
  next.lead.push({ type: "paragraph", text });
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isBlock(value: unknown): value is NotesBlock {
  if (!isRecord(value)) return false;
  if (value.type === "paragraph") return typeof value.text === "string";
  return (value.type === "definitions" || value.type === "steps") && Array.isArray(value.items) &&
    value.items.every((item) => isRecord(item) && typeof item.term === "string" && typeof item.description === "string");
}
function isSection(value: unknown): value is NotesSection {
  return isRecord(value) && typeof value.heading === "string" && Array.isArray(value.body) &&
    value.body.every(isBlock) && Array.isArray(value.children) && value.children.every(isSection);
}
function isStructured(value: unknown): value is StructuredNotes {
  return isRecord(value) && Array.isArray(value.lead) && value.lead.every(isBlock) &&
    Array.isArray(value.sections) && value.sections.every(isSection);
}

const STEP = /^\s*\d+[.、．)]\s+(.+)$/;
const DEFINITION = /^\s*[*・-]\s+(.+)$/;
function parseItem(text: string): { term: string; description: string } {
  const colon = text.search(/[：:]/);
  if (colon < 0) return { term: "", description: text.trim() };
  const term = text.slice(0, colon).trim().replace(/^\*\*(.*)\*\*$/, "$1").trim();
  return { term, description: text.slice(colon + 1).trim() };
}

/** Source-compatible normalization for structured, nested, and legacy `{text}` notes. */
export function normalizeNotes(raw: unknown): StructuredNotes | null {
  if (isStructured(raw)) return raw;
  if (!isRecord(raw)) return null;
  const lead = normalizeBlocks(raw.lead);
  if (!lead || !Array.isArray(raw.sections)) return null;
  const sections = raw.sections.map(normalizeSection);
  return sections.some((section) => section === null) ? null : { lead, sections: sections as NotesSection[] };
}

function normalizeBlocks(value: unknown): NotesBlock[] | null {
  if (typeof value === "string") return parseBody(value);
  if (Array.isArray(value) && value.every(isBlock)) return value;
  return null;
}
function normalizeSection(value: unknown): NotesSection | null {
  if (isSection(value)) return value;
  if (!isRecord(value) || typeof value.heading !== "string" || !Array.isArray(value.body) ||
      !value.body.every((block) => isRecord(block) && !("type" in block) && typeof block.text === "string") ||
      !Array.isArray(value.children)) return null;
  const children = value.children.map(normalizeSection);
  if (children.some((child) => child === null)) return null;
  return { heading: value.heading, body: parseBody(value.body.map((block) => (block as { text: string }).text).join("\n\n")), children: children as NotesSection[] };
}
function parseBody(text: string): NotesBlock[] {
  const lines = text.split("\n");
  while (lines.length && !lines[0]!.trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  const blocks: NotesBlock[] = [];
  let chunk: string[] = [];

  const flushChunk = () => {
    if (!chunk.length) return;
    let prose: string[] = [];
    let listType: "definitions" | "steps" | null = null;
    let listItems: Array<{ term: string; description: string }> = [];
    const flushProse = () => {
      if (prose.length) blocks.push({ type: "paragraph", text: prose.join("\n") });
      prose = [];
    };
    const flushList = () => {
      if (listType && listItems.length) blocks.push({ type: listType, items: listItems });
      listType = null;
      listItems = [];
    };
    for (const line of chunk) {
      const step = STEP.exec(line);
      const definition = step ? null : DEFINITION.exec(line);
      const nextType = step ? "steps" : definition ? "definitions" : null;
      if (!nextType) {
        flushList();
        prose.push(line);
        continue;
      }
      flushProse();
      if (listType !== nextType) {
        flushList();
        listType = nextType;
      }
      const match = step ?? definition;
      if (match) listItems.push(parseItem(match[1]!));
    }
    flushProse();
    flushList();
    chunk = [];
  };

  for (const line of lines) {
    if (!line.trim()) flushChunk();
    else chunk.push(line);
  }
  flushChunk();
  return blocks;
}

export function collectNotesPlainTexts(notes: StructuredNotes): string[] {
  const result: string[] = [];
  const collectBlocks = (blocks: NotesBlock[]) => {
    for (const block of blocks) {
      if (block.type === "paragraph") result.push(block.text);
      else for (const item of block.items) result.push(item.term, item.description);
    }
  };
  const collectSections = (sections: NotesSection[]) => {
    for (const section of sections) {
      collectBlocks(section.body);
      collectSections(section.children);
    }
  };
  collectBlocks(notes.lead);
  collectSections(notes.sections);
  return result;
}
