/** Public fields consumed from `speaker.dialogue.list` for one character. */
export interface PublicSpeakerDialogueLineDto {
  text: string;
  sceneId: string;
  sceneName: string;
  sentenceIndex: number;
  confidence: "high" | "low" | "none";
  reason: string;
}

/**
 * `speaker.dialogue.list` data shape. The action also returns generated-result
 * identity fields; this helper consumes only characterId and lines.
 */
export interface PublicSpeakerDialogueListDto {
  characterId: string;
  count: number;
  minConfidence: "high" | "low";
  lines: readonly PublicSpeakerDialogueLineDto[];
}

/** Fingerprint fields returned in each row of `speaker.voice.profiles.fingerprints`. */
export interface PublicSpeakerFingerprintDto {
  entityId: string;
  dialogueCount: number;
  firstPersonDist: Record<string, number>;
  endingBigramDist: Record<string, number>;
  politeRatio: number;
  avgDialogueLength: number;
  exclamationRate: number;
  questionRate: number;
}

/** The profile action also returns matrix, stylometric, tokenizer and engine metadata. */
export interface PublicSpeakerVoiceProfilesDto {
  fingerprints: readonly PublicSpeakerFingerprintDto[];
}

export interface DialogueSketchFingerprintSummary {
  entityId: string;
  dialogueCount: number;
  topFirstPersons: string[];
  topEndings: string[];
  politeRatio: number;
  avgDialogueLength: number;
  exclamationRate: number;
  questionRate: number;
}

/** Prompt-ready output compatible with the source dialogue-sketch speaker context. */
export interface DialogueSketchSpeakerContext {
  entityId: string;
  name: string;
  voiceProfileExcerpt: string | null;
  fingerprintSummary: DialogueSketchFingerprintSummary | null;
  notesExcerpt: string | null;
  exampleDialogues: string[];
  blankHeadings: string[];
}

export interface BuildDialogueSketchSpeakerContextInput {
  entityId: string;
  name?: string;
  /** Raw story entity fields, including voice, voicePatterns, voice_profiles and notes. */
  raw: Record<string, unknown>;
  /** Result data from `speaker.dialogue.list`, requested with minConfidence="high". */
  speakerDialogues?: PublicSpeakerDialogueListDto | null;
  /** Result data from `speaker.voice.profiles`; fingerprints are matched by entityId. */
  speakerProfiles?: PublicSpeakerVoiceProfilesDto | null;
}

interface VoicePatterns {
  firstPerson?: string[];
  sentenceEndings?: string[];
  tone?: string;
}

interface VoiceProfile {
  id: string;
  contextTrigger?:
    | { type: "match_metadata"; key: string; value: string }
    | { type: "text_structure"; value: "monologue" };
  firstPerson?: string[];
  sentenceEndings?: string[];
}

type NotesBlock =
  | { type: "paragraph"; text: string }
  | { type: "definitions" | "steps"; items: Array<{ term: string; description: string }> };
interface NotesSection {
  heading: string;
  body: NotesBlock[];
  children: NotesSection[];
}
interface StructuredNotes {
  lead: NotesBlock[];
  sections: NotesSection[];
}

const MAX_VOICE_EXCERPT_CHARS = 1_200;
const MAX_NOTE_CHARS = 800;
const EXAMPLE_DIALOGUE_LIMIT = 6;
const STEP_RE = /^\s*\d+[.、．)]\s+(.+)$/u;
const DEFINITION_RE = /^\s*[*・-]\s+(.+)$/u;
const META_LINE_PATTERNS = [
  /^声紋の詳細.*voice\.yaml/u,
  /^voice\.yaml/u,
  /^同ディレクトリの voice\.yaml/u,
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function uniqueOrdered(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function firstPersonNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const record = asRecord(item);
        return record && typeof record.name === "string" ? record.name.trim() : "";
      })
      .filter((name) => name.length > 0);
  }
  const record = asRecord(value);
  const name = record && typeof record.name === "string" ? record.name.trim() : "";
  return name ? [name] : [];
}

function extractDualityPatterns(voice: Record<string, unknown>): VoicePatterns | null {
  const outer = asRecord(asRecord(voice.duality)?.outer);
  if (!outer) return null;
  const first = asRecord(outer.first_person);
  const firstPerson = first
    ? [first.name, first.reading].filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
    : [];
  const tone = typeof outer.tone === "string" && outer.tone.length > 0 ? outer.tone : undefined;
  return firstPerson.length || tone ? { ...(firstPerson.length ? { firstPerson } : {}), ...(tone ? { tone } : {}) } : null;
}

function patternsFromVoiceDefinition(voice: Record<string, unknown> | null): VoicePatterns | null {
  if (!voice) return null;
  if (Array.isArray(voice.first_person)) {
    const firstPerson = voice.first_person
      .map((item) => {
        const record = asRecord(item);
        return record && typeof record.name === "string" ? record.name : null;
      })
      .filter((name): name is string => name !== null);
    if (firstPerson.length > 0) return { firstPerson };
  }
  return extractDualityPatterns(voice);
}

function voicePatternsFromRaw(raw: Record<string, unknown>, voice: Record<string, unknown> | null): VoicePatterns | null {
  if (!raw.voicePatterns) return patternsFromVoiceDefinition(voice);
  const source = asRecord(raw.voicePatterns);
  if (!source) return null;
  const result: VoicePatterns = {};
  if (Array.isArray(source.firstPerson)) {
    result.firstPerson = source.firstPerson.filter((value): value is string => typeof value === "string");
  }
  if (Array.isArray(source.sentenceEndings)) {
    result.sentenceEndings = source.sentenceEndings.filter((value): value is string => typeof value === "string");
  }
  if (typeof source.tone === "string" && source.tone.length > 0) result.tone = source.tone;
  return result.firstPerson || result.sentenceEndings || result.tone ? result : null;
}

function parseContextTrigger(value: unknown): VoiceProfile["contextTrigger"] {
  const raw = asRecord(value);
  if (!raw) return undefined;
  if (raw.type === "match_metadata" && typeof raw.key === "string" && typeof raw.value === "string") {
    return { type: "match_metadata", key: raw.key, value: raw.value };
  }
  if (raw.type === "text_structure" && raw.value === "monologue") {
    return { type: "text_structure", value: "monologue" };
  }
  return undefined;
}

function extractVoiceProfiles(raw: Record<string, unknown>): VoiceProfile[] | null {
  if (!Array.isArray(raw.voice_profiles)) return null;
  const profiles = raw.voice_profiles.flatMap((value): VoiceProfile[] => {
    const record = asRecord(value);
    if (!record || typeof record.id !== "string" || record.id.length === 0) return [];
    const profile: VoiceProfile = { id: record.id };
    const trigger = parseContextTrigger(record.context_trigger);
    if (trigger) profile.contextTrigger = trigger;
    if (Array.isArray(record.firstPerson)) {
      const values = record.firstPerson.filter((item): item is string => typeof item === "string");
      if (values.length) profile.firstPerson = values;
    }
    if (Array.isArray(record.sentenceEndings)) {
      const values = record.sentenceEndings.filter((item): item is string => typeof item === "string");
      if (values.length) profile.sentenceEndings = values;
    }
    return profile.firstPerson || profile.sentenceEndings ? [profile] : [];
  });
  return profiles.length ? profiles : null;
}

function formatSecondPerson(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  const parts = [record.form, record.note].filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
  return parts.length ? parts.join(" / ") : null;
}

function formatSentenceEndings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    if (!record) return [];
    const example = typeof record.example === "string" ? record.example.trim() : "";
    const note = typeof record.note === "string" ? record.note.trim() : "";
    if (example && note) return [`${example}（${note}）`];
    if (example) return [example];
    if (note) return [note];
    return [];
  });
}

function formatProfileLines(profiles: VoiceProfile[]): string[] {
  const lines: string[] = [];
  for (const profile of profiles) {
    if (!profile.sentenceEndings?.length) continue;
    const trigger = profile.contextTrigger;
    const triggerLabel = trigger?.type === "match_metadata"
      ? `${trigger.key}=${trigger.value}`
      : trigger?.type === "text_structure" ? trigger.value : null;
    const label = triggerLabel ? `${profile.id} / ${triggerLabel}` : profile.id;
    lines.push(`- [${label}] 語尾=${profile.sentenceEndings.join("、")}`);
  }
  return lines.length ? ["状況別プロファイル:", ...lines] : [];
}

function clipVoiceExcerpt(value: string): string {
  const text = value.replace(/\s+\n/gu, "\n").trim();
  return text.length <= MAX_VOICE_EXCERPT_CHARS
    ? text
    : `${text.slice(0, MAX_VOICE_EXCERPT_CHARS - 1)}…`;
}

function buildVoiceProfileExcerpt(raw: Record<string, unknown>): string | null {
  const voice = asRecord(raw.voice);
  const patterns = voicePatternsFromRaw(raw, voice);
  const profiles = extractVoiceProfiles(raw);
  const lines: string[] = [];
  const firstPerson: string[] = [];
  if (patterns?.firstPerson) firstPerson.push(...patterns.firstPerson);
  if (profiles) {
    for (const profile of profiles) if (profile.firstPerson) firstPerson.push(...profile.firstPerson);
  }
  if (voice) {
    firstPerson.push(...firstPersonNames(voice.first_person));
    const outer = asRecord(asRecord(voice.duality)?.outer);
    if (outer) firstPerson.push(...firstPersonNames(outer.first_person));
  }
  const normalizedFirstPerson = uniqueOrdered(firstPerson);
  if (normalizedFirstPerson.length) lines.push(`一人称: ${normalizedFirstPerson.join("、")}`);

  const outer = voice ? asRecord(asRecord(voice.duality)?.outer) : null;
  const outerTone = outer && typeof outer.tone === "string" ? outer.tone.trim() : "";
  const patternTone = patterns?.tone?.trim() ?? "";
  const tone = outerTone || patternTone;
  if (tone) lines.push(`口調: ${tone}`);
  if (patterns?.sentenceEndings?.length) {
    lines.push(`語尾（登録）: ${patterns.sentenceEndings.join("、")}`);
  }
  const secondPerson = outer ? formatSecondPerson(outer.second_person) : null;
  if (secondPerson) lines.push(`二人称: ${secondPerson}`);
  const endings = outer ? formatSentenceEndings(outer.sentence_endings) : [];
  if (endings.length) lines.push(`語尾例: ${endings.slice(0, 8).join(" / ")}`);
  const register = outer && typeof outer.register === "string" && outer.register.trim()
    ? outer.register.trim()
    : voice && typeof voice.register === "string" && voice.register.trim()
      ? voice.register.trim()
      : null;
  if (register) lines.push(`文体: ${register}`);
  if (profiles) lines.push(...formatProfileLines(profiles));

  const unique = uniqueOrdered(lines);
  return unique.length ? clipVoiceExcerpt(unique.join("\n")) : null;
}

function isNotesBlock(value: unknown): value is NotesBlock {
  const record = asRecord(value);
  if (!record) return false;
  if (record.type === "paragraph") return typeof record.text === "string";
  return (record.type === "definitions" || record.type === "steps") && Array.isArray(record.items) &&
    record.items.every((item) => {
      const row = asRecord(item);
      return !!row && typeof row.term === "string" && typeof row.description === "string";
    });
}

function isNotesSection(value: unknown): value is NotesSection {
  const record = asRecord(value);
  return !!record && typeof record.heading === "string" && Array.isArray(record.body) &&
    record.body.every(isNotesBlock) && Array.isArray(record.children) && record.children.every(isNotesSection);
}

function isStructuredNotes(value: unknown): value is StructuredNotes {
  const record = asRecord(value);
  return !!record && Array.isArray(record.lead) && record.lead.every(isNotesBlock) &&
    Array.isArray(record.sections) && record.sections.every(isNotesSection);
}

function parseListItem(value: string): { term: string; description: string } {
  const colon = value.search(/[：:]/u);
  if (colon < 0) return { term: "", description: value.trim() };
  const rawTerm = value.slice(0, colon).trim();
  return {
    term: rawTerm.replace(/^\*\*(.*)\*\*$/u, "$1").trim(),
    description: value.slice(colon + 1).trim(),
  };
}

function parseBodyTextToBlocks(value: string): NotesBlock[] {
  const lines = value.split("\n");
  while (lines.length && !lines[0]!.trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  const blocks: NotesBlock[] = [];
  let chunk: string[] = [];
  const flushChunk = () => {
    if (!chunk.length) return;
    let prose: string[] = [];
    let listType: "definitions" | "steps" | null = null;
    let items: Array<{ term: string; description: string }> = [];
    const flushProse = () => {
      if (prose.length) blocks.push({ type: "paragraph", text: prose.join("\n") });
      prose = [];
    };
    const flushList = () => {
      if (listType && items.length) blocks.push({ type: listType, items });
      listType = null;
      items = [];
    };
    for (const line of chunk) {
      const step = STEP_RE.exec(line);
      const definition = step ? null : DEFINITION_RE.exec(line);
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
      if (match) items.push(parseListItem(match[1]!));
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

function normalizeLegacySection(value: unknown): NotesSection | null {
  const record = asRecord(value);
  if (!record || typeof record.heading !== "string" || !Array.isArray(record.body) ||
      !record.body.every((block) => {
        const row = asRecord(block);
        return !!row && !("type" in row) && typeof row.text === "string";
      }) || !Array.isArray(record.children)) return null;
  const children = record.children.map(normalizeSection);
  if (children.some((child) => child === null)) return null;
  return {
    heading: record.heading,
    body: parseBodyTextToBlocks(record.body.map((block) => (block as { text: string }).text).join("\n\n")),
    children: children as NotesSection[],
  };
}

function normalizeSection(value: unknown): NotesSection | null {
  return isNotesSection(value) ? value : normalizeLegacySection(value);
}

function normalizeLead(value: unknown): NotesBlock[] | null {
  if (typeof value === "string") return parseBodyTextToBlocks(value);
  return Array.isArray(value) && value.every(isNotesBlock) ? value : null;
}

function normalizeNotes(value: unknown): StructuredNotes | null {
  if (isStructuredNotes(value)) return value;
  const raw = asRecord(value);
  if (!raw) return null;
  const lead = normalizeLead(raw.lead);
  if (!lead || !Array.isArray(raw.sections)) return null;
  const sections = raw.sections.map(normalizeSection);
  if (sections.some((section) => section === null)) return null;
  return { lead, sections: sections as NotesSection[] };
}

function notesPlainExcerpt(notes: StructuredNotes | null): string {
  if (!notes) return "";
  const parts: string[] = [];
  const addParagraphs = (blocks: NotesBlock[]) => {
    for (const block of blocks) if (block.type === "paragraph") parts.push(block.text);
  };
  addParagraphs(notes.lead);
  for (const section of notes.sections) {
    if (section.heading) parts.push(`# ${section.heading}`);
    addParagraphs(section.body);
  }
  const joined = parts.join("\n").trim();
  return joined.length <= MAX_NOTE_CHARS ? joined : `${joined.slice(0, MAX_NOTE_CHARS)}…`;
}

function blockHasContent(block: NotesBlock): boolean {
  if (block.type === "paragraph") return block.text.trim().length > 0;
  return block.items.some((item) => item.term.trim().length > 0 || item.description.trim().length > 0);
}

function blankHeadings(sections: NotesSection[], out: string[]): void {
  for (const section of sections) {
    const heading = section.heading.trim();
    if (heading && !section.body.some(blockHasContent)) out.push(heading);
    blankHeadings(section.children, out);
  }
}

function buildNotes(raw: Record<string, unknown>): { excerpt: string | null; blankHeadings: string[] } {
  const notes = normalizeNotes(raw.notes);
  if (!notes) return { excerpt: null, blankHeadings: [] };
  const excerpt = notesPlainExcerpt(notes)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !META_LINE_PATTERNS.some((pattern) => pattern.test(line)))
    .join("\n")
    .trim();
  const blank: string[] = [];
  blankHeadings(notes.sections, blank);
  return { excerpt: excerpt || null, blankHeadings: blank };
}

function topKeys(distribution: Record<string, number>, limit: number): string[] {
  return Object.entries(distribution)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([key]) => key);
}

function fingerprintSummary(
  profile: PublicSpeakerVoiceProfilesDto | null | undefined,
  entityId: string,
): DialogueSketchFingerprintSummary | null {
  const fingerprint = profile?.fingerprints.find((item) => item.entityId === entityId);
  if (!fingerprint) return null;
  return {
    entityId: fingerprint.entityId,
    dialogueCount: fingerprint.dialogueCount,
    topFirstPersons: topKeys(fingerprint.firstPersonDist, 5),
    topEndings: topKeys(fingerprint.endingBigramDist, 5).map((key) => key.replace(/\|/gu, "")),
    politeRatio: fingerprint.politeRatio,
    avgDialogueLength: fingerprint.avgDialogueLength,
    exclamationRate: fingerprint.exclamationRate,
    questionRate: fingerprint.questionRate,
  };
}

function exampleDialogues(
  dialogue: PublicSpeakerDialogueListDto | null | undefined,
  entityId: string,
): string[] {
  if (!dialogue || dialogue.characterId !== entityId || !Array.isArray(dialogue.lines)) return [];
  return dialogue.lines
    .filter((line) => line.confidence === "high" && typeof line.text === "string")
    .slice(-EXAMPLE_DIALOGUE_LIMIT)
    .map((line) => line.text);
}

/**
 * Build the prompt-ready context from pinned raw entity fields and public speaker
 * action DTOs. The function is deterministic, performs no I/O, and does not mutate inputs.
 */
export function buildDialogueSketchSpeakerContext(
  input: BuildDialogueSketchSpeakerContextInput,
): DialogueSketchSpeakerContext {
  const notes = buildNotes(input.raw);
  return {
    entityId: input.entityId,
    name: input.name || input.entityId,
    voiceProfileExcerpt: buildVoiceProfileExcerpt(input.raw),
    fingerprintSummary: fingerprintSummary(input.speakerProfiles, input.entityId),
    notesExcerpt: notes.excerpt,
    exampleDialogues: exampleDialogues(input.speakerDialogues, input.entityId),
    blankHeadings: notes.blankHeadings,
  };
}
