import type { ActionRequest, ChangeUnit, FileOperation, ReadPrecondition } from "../../../app/src/browser/proprium/authoring/types.js";
import type { GuestHost, HostCall } from "../../shared/guest.js";
import { sha256Hex } from "./sha256.js";
import { createSnapshotReader, readKnowledgeSnapshot, readOptionalPath, type LoadedKnowledgeSnapshot, type StoryFile } from "./snapshot.js";
import type { StoryEntity, StoryEntityType } from "./domain/types.js";
import { listRuleStateEvents } from "./domain/worldState.js";
import YAML from "yaml";

type Row = Record<string, unknown>;
type SourceOperation = Row & { id: string; kind: string; evidenceIds: string[] };
type VirtualFile = { content: string; revision: string };
type CompileEvidence = { id: string; sourceKind: string; sourceId: string; revision: string; range?: { start: number; end: number } };

const BIBLE_TYPES = new Set<StoryEntityType>(["character", "location", "item", "faction", "event", "lore", "thread", "arc", "dialogue_sketch"]);
const ENTITY_DIR: Partial<Record<StoryEntityType, string>> = {
  character: "bible/characters", location: "bible/locations", item: "bible/items", faction: "bible/factions",
  event: "bible/timeline/events", lore: "bible/lore", thread: "plot/threads", arc: "plot/arcs", dialogue_sketch: "bible/dialogue_sketches",
};
const SAFE_ID = /^[A-Za-z0-9_-]{1,256}$/u;
const KNOWLEDGE_STATE_PATH = "meta/proprium/plugins/proprium.knowledge/v1/state-proposals.jsonl";
const LEGACY_STATE_PATH = "meta/scriptorium/modules/story/state-proposals.jsonl";

function fail(code: string, message: string, details?: Row): never {
  throw Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}
function isRow(value: unknown): value is Row { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value: Row, allowed: readonly string[], label: string): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra) fail("invalid_input", `${label} contains unsupported field ${extra}`, { field: extra });
}
function stringValue(value: unknown, label: string, max = 256): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) fail("invalid_input", `${label} must be non-empty text of at most ${max} characters`);
  return value;
}
function assertJson(value: unknown, label: string): void {
  let nodes = 0;
  const visit = (item: unknown, depth: number) => {
    if (++nodes > 10_000 || depth > 16) fail("capacity", `${label} exceeds the Knowledge JSON depth/node limit`);
    if (typeof item === "number" && !Number.isFinite(item)) fail("invalid_input", `${label} contains a non-finite number`);
    if (Array.isArray(item)) { if (item.length > 1000) fail("capacity", `${label} contains an oversized array`); for (const child of item) visit(child, depth + 1); }
    else if (isRow(item)) {
      const entries = Object.entries(item);
      if (entries.length > 1000 || entries.some(([key]) => key.length > 256 || ["__proto__", "prototype", "constructor"].includes(key))) fail("invalid_input", `${label} contains an unsafe or oversized object`);
      for (const [, child] of entries) visit(child, depth + 1);
    } else if (typeof item === "string" && item.length > 100_000) fail("capacity", `${label} contains an oversized string`);
  };
  visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 1_000_000) fail("capacity", `${label} exceeds 1 MiB`);
}
function safePathId(value: unknown, label: string): string {
  const id = stringValue(value, label);
  if (!SAFE_ID.test(id)) fail("invalid_path", `${label} is not a safe stable ID`, { id });
  return id;
}
function parsePrecondition(value: unknown, label: string): Row {
  if (!isRow(value)) fail("invalid_input", `${label} must be an object`);
  if (value.kind === "absent") { exactKeys(value, ["kind"], label); return value; }
  if (value.kind !== "revision" && value.kind !== "content-hash") fail("invalid_input", `${label}.kind must be revision, content-hash, or absent`);
  exactKeys(value, ["kind", "value"], label);
  stringValue(value.value, `${label}.value`, 1024);
  return value;
}
function parseOperation(value: unknown, index: number): SourceOperation {
  const label = `operations[${index}]`;
  if (!isRow(value)) fail("invalid_input", `${label} must be an object`);
  const kind = stringValue(value.kind, `${label}.kind`, 128);
  const shared = ["id", "evidenceIds", "assessment", "kind", "precondition", "target"];
  const allowedByKind: Record<string, string[]> = {
    "entity.create": ["values"], "entity.update": ["changes"], "scene.update": ["changes"],
    "state.append-event": ["event", "sourceProposal"], "thread.link-scene": ["relation", "note"], "reference.link": ["note"],
  };
  if (!allowedByKind[kind]) fail("unsupported_schema", `Knowledge does not compile ${kind}`, { kind });
  exactKeys(value, [...shared, ...allowedByKind[kind]!], label);
  const id = safePathId(value.id, `${label}.id`);
  if (!Array.isArray(value.evidenceIds) || value.evidenceIds.length > 64 || value.evidenceIds.some((item) => typeof item !== "string")) fail("invalid_input", `${label}.evidenceIds must be a string array`);
  if (!isRow(value.assessment)) fail("invalid_input", `${label}.assessment must be an object`);
  exactKeys(value.assessment, ["confidence", "risk"], `${label}.assessment`);
  if (typeof value.assessment.confidence !== "number" || value.assessment.confidence < 0 || value.assessment.confidence > 1 || !["low", "medium", "high"].includes(String(value.assessment.risk))) fail("invalid_input", `${label}.assessment is invalid`);
  value.precondition = parsePrecondition(value.precondition, `${label}.precondition`);
  if (!isRow(value.target)) fail("invalid_input", `${label}.target must be an object`);
  if (kind === "entity.create") {
    exactKeys(value.target, ["entityId", "entityType"], `${label}.target`);
    safePathId(value.target.entityId, `${label}.target.entityId`); stringValue(value.target.entityType, `${label}.target.entityType`);
    if ((value.precondition as Row).kind !== "absent") fail("invalid_input", `${label} create requires an absent precondition`);
    if (!isRow(value.values)) fail("invalid_input", `${label}.values must be an object`); assertJson(value.values, `${label}.values`);
  } else if (kind === "entity.update" || kind === "scene.update") {
    exactKeys(value.target, kind === "entity.update" ? ["entityId"] : ["sceneId"], `${label}.target`);
    safePathId(value.target[kind === "entity.update" ? "entityId" : "sceneId"], `${label}.target identity`);
    if ((value.precondition as Row).kind === "absent") fail("invalid_input", `${label} update cannot use an absent precondition`);
    if (!isRow(value.changes)) fail("invalid_input", `${label}.changes must be an object`);
    if ("id" in value.changes || "type" in value.changes) fail("invalid_input", `${label}.changes cannot mutate id or type`);
    if (kind === "scene.update") {
      const unsupported = Object.keys(value.changes).find((key) => ["id", "type", "volume", "chapter", "order", "manuscript", "readingMarks"].includes(key));
      if (unsupported) fail("unsupported_schema", `Scene field ${unsupported} is owned by Narrative`, { field: unsupported });
    }
    assertJson(value.changes, `${label}.changes`);
  } else if (kind === "state.append-event") {
    exactKeys(value.target, ["sceneId", "eventId"], `${label}.target`);
    safePathId(value.target.sceneId, `${label}.target.sceneId`); safePathId(value.target.eventId, `${label}.target.eventId`);
    if ((value.precondition as Row).kind === "absent") fail("invalid_input", `${label} event append cannot use an absent precondition`);
    validateEvent(value.event, `${label}.event`);
    if ((value.event as Row).sceneId !== value.target.sceneId || (value.event as Row).eventId !== value.target.eventId) fail("invalid_input", `${label}.event identity differs from target`);
    if (value.sourceProposal !== undefined) {
      if (!isRow(value.sourceProposal)) fail("invalid_input", `${label}.sourceProposal must be an object`);
      exactKeys(value.sourceProposal, ["id", "manuscriptHash"], `${label}.sourceProposal`);
      stringValue(value.sourceProposal.id, `${label}.sourceProposal.id`); stringValue(value.sourceProposal.manuscriptHash, `${label}.sourceProposal.manuscriptHash`);
    }
  } else if (kind === "thread.link-scene") {
    exactKeys(value.target, ["threadId", "sceneId"], `${label}.target`);
    safePathId(value.target.threadId, `${label}.target.threadId`); safePathId(value.target.sceneId, `${label}.target.sceneId`);
    if ((value.precondition as Row).kind === "absent") fail("invalid_input", `${label} link cannot use an absent precondition`);
    if (value.relation !== "planted" && value.relation !== "payoff") fail("unsupported_schema", "Knowledge thread links support planted or payoff");
    if (value.note !== undefined && (typeof value.note !== "string" || value.note.length > 10_000)) fail("invalid_input", `${label}.note is invalid`);
  } else {
    exactKeys(value.target, ["from", "to", "kind"], `${label}.target`);
    safePathId(value.target.from, `${label}.target.from`); safePathId(value.target.to, `${label}.target.to`); stringValue(value.target.kind, `${label}.target.kind`, 256);
    if ((value.precondition as Row).kind === "absent") fail("invalid_input", `${label} link cannot use an absent precondition`);
    if (value.note !== undefined && (typeof value.note !== "string" || value.note.length > 10_000)) fail("invalid_input", `${label}.note is invalid`);
  }
  if (value.kind !== "entity.create") assertJson(value, label);
  return value as SourceOperation;
}
function validateEvent(value: unknown, label: string): Row {
  if (!isRow(value)) fail("invalid_input", `${label} must be an object`);
  exactKeys(value, ["sceneId", "order", "kind", "subject", "object", "payload", "source", "eventId", "propositionId", "evidence", "confidence", "createdAt", "status", "replacesEventId"], label);
  for (const key of ["sceneId", "subject", "eventId"]) safePathId(value[key], `${label}.${key}`);
  if (!Number.isSafeInteger(value.order) || typeof value.order !== "number" || value.order < 0) fail("invalid_input", `${label}.order must be a nonnegative integer`);
  if (!["location", "acquaintance", "ownership", "knowledge"].includes(String(value.kind))) fail("unsupported_schema", `${label}.kind is unsupported`);
  if (!(value.object === null || typeof value.object === "string") || !isRow(value.payload)) fail("invalid_input", `${label}.object/payload is invalid`);
  if (!["rule", "llm-draft", "manual"].includes(String(value.source)) || value.status !== "confirmed") fail("invalid_input", `${label} must be an author-confirmed StateEvent`);
  if (value.evidence !== undefined && (!Array.isArray(value.evidence) || value.evidence.length > 64)) fail("invalid_input", `${label}.evidence is invalid`);
  if (value.confidence !== undefined && (typeof value.confidence !== "number" || value.confidence < 0 || value.confidence > 1)) fail("invalid_input", `${label}.confidence is invalid`);
  assertJson(value.payload, `${label}.payload`);
  return value;
}
function validateEvidence(value: unknown, index: number): CompileEvidence {
  const label = `evidence[${index}]`;
  if (!isRow(value)) fail("invalid_input", `${label} must be an object`);
  exactKeys(value, ["id", "sourceKind", "sourceId", "revision", "range"], label);
  const id = safePathId(value.id, `${label}.id`);
  const sourceId = stringValue(value.sourceId, `${label}.sourceId`);
  const revision = stringValue(value.revision, `${label}.revision`, 1024);
  if (!["manuscript", "entity", "scene", "diagnostic", "state-proposal", "external"].includes(String(value.sourceKind))) fail("invalid_input", `${label}.sourceKind is invalid`);
  let range: CompileEvidence["range"];
  if (value.range !== undefined) {
    if (!isRow(value.range)) fail("invalid_input", `${label}.range must be an object`);
    exactKeys(value.range, ["start", "end"], `${label}.range`);
    if (!Number.isSafeInteger(value.range.start) || !Number.isSafeInteger(value.range.end) || (value.range.start as number) < 0 || (value.range.end as number) < (value.range.start as number)) fail("invalid_input", `${label}.range is invalid`);
    range = { start: value.range.start as number, end: value.range.end as number };
  }
  return { id, sourceKind: String(value.sourceKind), sourceId, revision, ...(range ? { range } : {}) };
}
function entityPath(type: StoryEntityType, id: string, raw: Row): string {
  if (!SAFE_ID.test(id)) fail("invalid_path", `Unsafe entity ID ${id}`);
  const dir = ENTITY_DIR[type];
  if (dir) return type === "character" ? `${dir}/${id}/profile.yaml` : `${dir}/${id}.yaml`;
  fail("unsupported_schema", `Knowledge cannot create ${type} entities`);
}
function referenceIds(raw: Row): string[] {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === "string") ids.add(item);
      else if (isRow(item)) { const target = item.target ?? item.to ?? item.scene ?? item.id; if (typeof target === "string") ids.add(target); }
    }
  };
  for (const field of ["volume", "chapter", "pov", "location", "resolution", "appears", "mentions", "plants", "advances", "related", "affiliated", "target", "first_appears", "planted", "payoff"]) add(raw[field]);
  if (Array.isArray(raw.relations)) add(raw.relations);
  if (isRow(raw.entities)) for (const key of ["appears", "mentions", "plants", "advances", "related", "pov", "affiliated", "target", "first_appears", "planted", "payoff"]) add(raw.entities[key]);
  if (isRow(raw.threads)) { add(raw.threads.plants); add(raw.threads.advances); }
  if (Array.isArray(raw.participantEntityIds)) add(raw.participantEntityIds);
  if (Array.isArray(raw.lines)) for (const line of raw.lines) if (isRow(line)) add(line.speakerEntityId);
  return [...ids];
}
function assertRefs(raw: Row, story: LoadedKnowledgeSnapshot, self?: string): StoryEntity[] {
  const result: StoryEntity[] = [];
  const types: Record<string, StoryEntityType> = { pov: "character", location: "location", volume: "volume", chapter: "chapter", resolution: "scene" };
  for (const [field, type] of Object.entries(types)) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") fail("invalid_input", `${field} must be a stable entity ID or null`);
    const target = uniqueEntity(story, value);
    if (target.type !== type) fail("invalid_input", `${field} must reference a ${type}`, { id: value });
  }
  for (const id of referenceIds(raw)) {
    if (self && id === self) fail("invalid_input", "An entity cannot reference itself", { id });
    result.push(uniqueEntity(story, id));
  }
  if (raw.type === "dialogue_sketch" || raw.participantEntityIds !== undefined || raw.lines !== undefined) {
    if (typeof raw.title !== "string" || !raw.title.trim() || !Array.isArray(raw.participantEntityIds) || !Array.isArray(raw.lines)) fail("invalid_input", "Dialogue sketch requires a title, participants, and ordered lines");
    if (new Set(raw.participantEntityIds).size !== raw.participantEntityIds.length || raw.participantEntityIds.some((id) => typeof id !== "string")) fail("invalid_input", "Dialogue sketch participants must be unique character IDs");
    const participants = new Set<string>();
    for (const id of raw.participantEntityIds as string[]) { if (uniqueEntity(story, id).type !== "character") fail("invalid_input", `Dialogue sketch participant ${id} is not a character`); participants.add(id); }
    for (const [index, line] of raw.lines.entries()) if (!isRow(line) || typeof line.speakerEntityId !== "string" || !participants.has(line.speakerEntityId) || typeof line.text !== "string" || !line.text.trim()) fail("invalid_input", `Dialogue sketch line ${index + 1} is invalid`);
  }
  return result;
}
function uniqueEntity(story: LoadedKnowledgeSnapshot, id: string): StoryEntity {
  if (story.duplicateIds.has(id)) fail("ambiguous_identity", `Entity ${id} is ambiguous`, { id, paths: story.duplicateIds.get(id) });
  const entity = story.entities.get(id);
  if (!entity) fail("file_not_found", `Entity ${id} was not found in the selected snapshot`, { kind: "entity_not_found", id });
  return entity;
}
function revision(entity: StoryEntity, story: LoadedKnowledgeSnapshot): string {
  const value = story.revisions.get(entity.filePath);
  if (!value) fail("file_not_found", `Entity source is missing: ${entity.filePath}`, { path: entity.filePath });
  return value;
}
function validatePrecondition(entity: StoryEntity | undefined, file: StoryFile | null, condition: Row, label: string): void {
  if (condition.kind === "absent") { if (entity || file) fail("conflict", `${label} already exists`); return; }
  if (!entity || !file) fail("file_not_found", `${label} does not exist`, { kind: "entity_not_found" });
  const actual = condition.kind === "content-hash" ? sha256Hex(file.content) : file.revision;
  if (actual !== condition.value) fail("snapshot_stale", `${label} source revision changed`, { path: entity.filePath, expected: condition.value, actual });
}
function relationExists(entity: StoryEntity, to: string, kind: string): boolean {
  if (Array.isArray(entity.raw.relations) && entity.raw.relations.some((item) => isRow(item) && (item.target ?? item.to ?? item.scene ?? item.id) === to && item.kind === kind)) return true;
  const values = Array.isArray(entity.raw[kind]) ? entity.raw[kind] as unknown[] : [entity.raw[kind]];
  return values.some((item) => item === to || (isRow(item) && (item.target ?? item.to ?? item.scene ?? item.id) === to && (item.kind === undefined || item.kind === kind)));
}
function manuscriptBody(content: string): string {
  const opening = /^---[ \t]*\r?\n/u.exec(content);
  if (!opening) return content;
  const closing = /^---[ \t]*\r?$/gmu;
  closing.lastIndex = opening[0].length;
  const delimiter = closing.exec(content);
  if (!delimiter) fail("unsupported_format", "Manuscript frontmatter is unclosed");
  let bodyStart = delimiter.index + delimiter[0].length;
  if (content.startsWith("\r\n", bodyStart)) bodyStart += 2; else if (content.startsWith("\n", bodyStart)) bodyStart += 1;
  return content.slice(bodyStart);
}
function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRow(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
function sameProposedEvent(proposed: Row, confirmed: Row): boolean {
  const fields = ["sceneId", "order", "kind", "subject", "object", "payload", "eventId", "evidence", "confidence", "replacesEventId"];
  return fields.every((field) => canonicalJson(proposed[field]) === canonicalJson(confirmed[field]));
}
function relationDirection(from: StoryEntity, to: StoryEntity, kind: string): void {
  if (!["plants", "planted", "advances", "payoff"].includes(kind)) return;
  const valid = from.type === "thread" ? to.type === "scene" && ["planted", "payoff"].includes(kind)
    : from.type === "scene" ? to.type === "thread" && ["plants", "advances", "payoff"].includes(kind)
      : false;
  if (!valid) fail("unsupported_schema", "Thread relation direction is unsupported", { from: from.id, to: to.id, kind });
}
function linksIn(raw: Row): unknown[] { return Array.isArray(raw.relations) ? raw.relations : []; }
function changedRaw(entity: StoryEntity, changes: Row): Row {
  const next: Row = { ...entity.raw, ...changes, id: entity.id, type: entity.type };
  for (const [key, value] of Object.entries(changes)) if (value === null) delete next[key];
  return next;
}
function updateView(view: LoadedKnowledgeSnapshot, path: string, file: VirtualFile, entity?: StoryEntity): LoadedKnowledgeSnapshot {
  const files = new Map(view.files);
  const revisions = new Map(view.revisions);
  const entities = new Map(view.entities);
  files.set(path, { path, content: file.content, revision: file.revision });
  revisions.set(path, file.revision);
  if (entity) entities.set(entity.id, entity);
  return { ...view, files, revisions, entities };
}

export function* compileKnowledgeChanges(input: Row, context: ActionRequest, host: GuestHost): Generator<HostCall, Row, unknown> {
  exactKeys(input, ["operations", "evidence", "staging_snapshot"], "input");
  if (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > 64) fail("invalid_input", "operations must contain 1 to 64 source operations");
  if (!Array.isArray(input.evidence) || input.evidence.length > 256) fail("invalid_input", "evidence must contain at most 256 source records");
  if (input.staging_snapshot !== undefined && (typeof input.staging_snapshot !== "string" || !input.staging_snapshot || input.staging_snapshot.length > 2048)) fail("invalid_input", "staging_snapshot must be a Host-issued opaque token");
  assertJson(input, "input");
  const operations = input.operations.map(parseOperation);
  const opIds = new Set<string>(), targets = new Set<string>();
  for (const op of operations) {
    if (opIds.has(op.id)) fail("invalid_input", `Duplicate source operation ID ${op.id}`); opIds.add(op.id);
    const target = isRow(op.target) ? op.target : {};
    const key = op.kind === "entity.create" ? `entity:${target.entityId}`
      : op.kind === "entity.update" ? `entity:${target.entityId}`
        : op.kind === "scene.update" ? `scene:${target.sceneId}`
          : op.kind === "state.append-event" ? `state:${target.sceneId}:${target.eventId}`
            : op.kind === "thread.link-scene" ? `thread:${target.threadId}:${target.sceneId}:${op.relation}`
              : `reference:${target.from}:${target.to}:${target.kind}`;
    if (targets.has(key)) fail("invalid_input", `Duplicate source operation target ${key}`); targets.add(key);
  }
  const evidence = input.evidence.map(validateEvidence);
  const evidenceById = new Map<string, CompileEvidence>();
  for (const row of evidence) { if (evidenceById.has(row.id)) fail("invalid_input", `Duplicate evidence identity ${row.id}`); evidenceById.set(row.id, row); }
  for (const operation of operations) for (const id of operation.evidenceIds) if (!evidenceById.has(id)) fail("invalid_input", `Operation ${operation.id} refers to missing evidence ${id}`);

  const baseReader = createSnapshotReader(context, host);
  const base = yield* readKnowledgeSnapshot(baseReader);
  const staging = typeof input.staging_snapshot === "string" ? input.staging_snapshot : undefined;
  const stagedReader = staging ? createSnapshotReader(context, host, staging) : baseReader;
  const stageStory = staging ? yield* readKnowledgeSnapshot(stagedReader) : base;
  const stageFiles = new Map<string, VirtualFile>([...stageStory.files].map(([path, file]) => [path, { content: file.content, revision: file.revision }]));
  let view: LoadedKnowledgeSnapshot = { ...stageStory, files: new Map(stageStory.files), revisions: new Map(stageStory.revisions), entities: new Map(stageStory.entities) };
  const baseReadSet = new Map<string, ReadPrecondition>();
  const baseFileCache = new Map<string, StoryFile | null>();
  function* originalFile(path: string): Generator<HostCall, StoryFile | null, unknown> {
    if (baseFileCache.has(path)) return baseFileCache.get(path)!;
    const fromSnapshot = base.files.get(path);
    const file = fromSnapshot ?? (yield* readOptionalPath(baseReader, path));
    baseFileCache.set(path, file);
    return file;
  }
  function* recordBase(path: string): Generator<HostCall, string | null, unknown> {
    const prior = baseReadSet.get(path);
    if (prior) return prior.revision;
    const file = yield* originalFile(path);
    const revision = file?.revision ?? null;
    baseReadSet.set(path, { path, revision });
    return revision;
  }
  function* currentFile(path: string): Generator<HostCall, StoryFile | null, unknown> {
    const cached = stageFiles.get(path);
    if (cached) return { path, content: cached.content, revision: cached.revision };
    const file = yield* readOptionalPath(stagedReader, path);
    if (file) stageFiles.set(path, { content: file.content, revision: file.revision });
    return file;
  }
  const evidenceReadPaths = new Set<string>();
  for (const item of evidence) {
    if (item.sourceKind === "external") continue;
    let path: string | undefined;
    if (item.sourceKind === "entity" || item.sourceKind === "scene") {
      const entity = uniqueEntity(view, item.sourceId); path = entity.filePath;
      if (item.sourceKind === "scene" && entity.type !== "scene") fail("invalid_input", `Evidence ${item.id} does not identify a scene`);
      if (item.sourceKind === "entity" && entity.type === "scene") fail("invalid_input", `Evidence ${item.id} must use sourceKind scene`);
      if (revision(entity, view) !== item.revision) fail("snapshot_stale", `Evidence ${item.id} source revision changed`, { path, expected: item.revision, actual: revision(entity, view) });
    } else if (item.sourceKind === "manuscript") {
      const scene = uniqueEntity(view, item.sourceId);
      if (scene.type !== "scene" || typeof scene.raw.manuscript !== "string") fail("file_not_found", `Evidence scene ${item.sourceId} has no manuscript path`);
      path = scene.raw.manuscript;
      const manuscript = [...view.entities.values()].find((entity) => entity.type === "manuscript" && entity.filePath === path);
      if (!manuscript || revision(manuscript, view) !== item.revision) fail("snapshot_stale", `Evidence ${item.id} manuscript revision changed`, { path, expected: item.revision, actual: manuscript ? revision(manuscript, view) : null });
    } else if (item.sourceKind === "state-proposal") {
      const canonical = yield* currentFile(KNOWLEDGE_STATE_PATH);
      const legacy = yield* currentFile(LEGACY_STATE_PATH);
      const parseRows = (file: StoryFile | null, sourcePath: string): Row[] => {
        if (!file) return [];
        try { return file.content.split(/\r?\n/u).filter((line) => line.trim()).map((line) => JSON.parse(line) as Row); }
        catch { return fail("unsupported_format", `Malformed state proposal JSONL: ${sourcePath}`, { path: sourcePath }); }
      };
      const canonicalRows = parseRows(canonical, KNOWLEDGE_STATE_PATH);
      const legacyRows = parseRows(legacy, LEGACY_STATE_PATH);
      if (canonical && legacy && JSON.stringify(canonicalRows) !== JSON.stringify(legacyRows)) fail("conflict", "Legacy and Proprium state proposal stores differ", { canonicalPath: KNOWLEDGE_STATE_PATH, legacyPath: LEGACY_STATE_PATH });
      const file = legacy ?? canonical;
      const rows = legacy ? legacyRows : canonicalRows;
      if (!rows.some((row) => row.id === item.sourceId)) fail("file_not_found", `State proposal ${item.sourceId} is missing`);
      if (!file || file.revision !== item.revision) fail("snapshot_stale", `State proposal ${item.sourceId} revision changed`, { expected: item.revision, actual: file?.revision ?? null });
      path = file.path;
    } else if (item.sourceKind === "diagnostic") {
      const diagnostic = view.diagnostics.find((row) => row.path === item.sourceId || row.entityId === item.sourceId);
      if (!diagnostic) fail("file_not_found", `Evidence diagnostic ${item.sourceId} is not in this snapshot`);
      path = diagnostic.path;
    }
    if (path) {
      const file = yield* currentFile(path);
      if (!file || file.revision !== item.revision) fail("snapshot_stale", `Evidence ${item.id} source bytes changed`, { path, expected: item.revision, actual: file?.revision ?? null });
      if (item.range && item.range.end > new TextEncoder().encode(file.content).byteLength) fail("invalid_input", `Evidence ${item.id} range exceeds source bytes`, { path });
      evidenceReadPaths.add(path);
      yield* recordBase(path);
    }
  }

  const units: ChangeUnit[] = [];
  const operationMap: Array<{ source_operation_id: string; unit_id: string; operation_ids: string[] }> = [];
  const producerByEntity = new Map<string, string>();
  const allOperations: FileOperation[] = [];
  const filesWritten = new Map<string, string>();
  for (const source of operations) {
    const target = source.target as Row;
    const precondition = source.precondition as Row;
    let entity: StoryEntity | undefined;
    let writePath = "";
    let nextRaw: Row | undefined;
    const dependencies = new Set<string>();
    const referenceDeps = (raw: Row) => { for (const id of referenceIds(raw)) { const producer = producerByEntity.get(id); if (producer) dependencies.add(producer); } };

    if (source.kind === "entity.create") {
      const id = safePathId(target.entityId, "target.entityId");
      const type = String(target.entityType) as StoryEntityType;
      if (!BIBLE_TYPES.has(type)) fail("unsupported_schema", `Knowledge cannot create ${type} entities`, { type });
      if (type === "dialogue_sketch" && !id.startsWith("ds-")) fail("invalid_input", "Dialogue sketch IDs must use the ds- prefix");
      if (view.entities.has(id) || view.duplicateIds.has(id)) fail("conflict", `Entity ${id} already exists or is ambiguous`, { id });
      const values = source.values as Row;
      if (values.id !== undefined && values.id !== id) fail("invalid_input", `Entity create ${source.id} values.id does not match target`);
      if (values.type !== undefined && values.type !== type) fail("invalid_input", `Entity create ${source.id} values.type does not match target`);
      nextRaw = { ...values, id, type };
      writePath = entityPath(type, id, nextRaw);
      const file = yield* currentFile(writePath);
      validatePrecondition(undefined, file, precondition, `Entity ${id}`);
      referenceDeps(nextRaw);
      const references = assertRefs(nextRaw, view, id);
      for (const referenced of references) yield* recordBase(referenced.filePath);
      yield* recordBase(writePath);
      const nextFile = { content: YAML.stringify(nextRaw), revision: "" };
      nextFile.revision = sha256Hex(nextFile.content);
      stageFiles.set(writePath, nextFile);
      entity = { id, type, filePath: writePath, raw: nextRaw };
      view = updateView(view, writePath, nextFile, entity);
      producerByEntity.set(id, source.id);
    } else if (source.kind === "entity.update" || source.kind === "scene.update") {
      const id = String(target[source.kind === "scene.update" ? "sceneId" : "entityId"]);
      entity = uniqueEntity(view, id);
      if (source.kind === "scene.update" && entity.type !== "scene") fail("invalid_input", `Entity ${id} is not a scene`);
      if (source.kind === "entity.update" && !BIBLE_TYPES.has(entity.type)) fail("unsupported_schema", `entity.update cannot update ${entity.type}`, { id, type: entity.type });
      const file = yield* currentFile(entity.filePath);
      validatePrecondition(entity, file, precondition, `Entity ${id}`);
      if (!file) fail("file_not_found", `Entity source is missing: ${entity.filePath}`, { path: entity.filePath });
      nextRaw = changedRaw(entity, source.changes as Row);
      referenceDeps(nextRaw);
      const references = assertRefs(nextRaw, view, id);
      for (const referenced of references) yield* recordBase(referenced.filePath);
      yield* recordBase(entity.filePath);
      const nextFile = { content: YAML.stringify(nextRaw), revision: "" };
      nextFile.revision = sha256Hex(nextFile.content);
      stageFiles.set(entity.filePath, nextFile);
      entity = { ...entity, raw: nextRaw };
      view = updateView(view, entity.filePath, nextFile, entity);
      writePath = entity.filePath;
    } else if (source.kind === "state.append-event") {
      const scene = uniqueEntity(view, String(target.sceneId));
      if (scene.type !== "scene") fail("invalid_input", `State event target ${scene.id} is not a scene`);
      const file = yield* currentFile(scene.filePath);
      validatePrecondition(scene, file, precondition, `Scene ${scene.id}`);
      if (!file) fail("file_not_found", `Scene source is missing: ${scene.filePath}`);
      const event = source.event as Row;
      const subject = uniqueEntity(view, String(event.subject));
      const object = event.object === null ? undefined : uniqueEntity(view, String(event.object));
      const validTypes = event.kind === "location" ? subject.type === "character" && object?.type === "location"
        : event.kind === "acquaintance" ? subject.type === "character" && object?.type === "character"
          : event.kind === "ownership" ? subject.type === "item" && (!object || object.type === "character")
            : event.kind === "knowledge" ? subject.type === "character" && (!object || !["scene", "manuscript"].includes(object.type)) : false;
      if (!validTypes) fail("invalid_input", "State event subject/object types are invalid", { sceneId: scene.id, subject: subject.id, object: object?.id, kind: event.kind });
      const priorEvents = Array.isArray(scene.raw.state_events) ? scene.raw.state_events.filter(isRow) : [];
      if (priorEvents.some((row) => row.eventId === event.eventId)) fail("conflict", `State event ${String(event.eventId)} already exists`);
      if (listRuleStateEvents(view).data.some((row) => row.kind === event.kind && row.subject === event.subject && row.object !== event.object)) fail("conflict", "State event conflicts with a confirmed rule event", { sceneId: scene.id });
      if (source.sourceProposal) {
        const proposal = source.sourceProposal as Row;
        if (event.source !== "manual") fail("invalid_input", "A confirmed proposal event must use source: manual");
        const canonicalPath = KNOWLEDGE_STATE_PATH;
        const legacyPath = LEGACY_STATE_PATH;
        const canonical = yield* currentFile(canonicalPath);
        const legacy = yield* currentFile(legacyPath);
        const parseRows = (file: StoryFile | null): Row[] => {
          if (!file) return [];
          try {
            return file.content.split(/\r?\n/u).filter((line) => line.trim()).map((line) => {
              const value: unknown = JSON.parse(line);
              if (!isRow(value) || typeof value.id !== "string") fail("unsupported_format", `Malformed state proposal row: ${file.path}`, { path: file.path });
              return value;
            });
          } catch (cause) {
            if ((cause as { code?: string })?.code) throw cause;
            fail("unsupported_format", `Malformed state proposal JSONL: ${file.path}`, { path: file.path });
          }
        };
        const canonicalRows = parseRows(canonical);
        const legacyRows = parseRows(legacy);
        if (canonical && legacy && canonicalJson(canonicalRows) !== canonicalJson(legacyRows)) {
          fail("conflict", "Legacy and Proprium state proposal stores differ", {
            canonicalPath, canonicalRevision: canonical.revision, legacyPath, legacyRevision: legacy.revision,
          });
        }
        // An active Scriptorium store remains authoritative until an approved migration, even if
        // an identical Proprium copy is also present.
        const active = legacy ?? canonical;
        const candidates = legacy ? legacyRows : canonicalRows;
        const matching = candidates.find((row) => row.id === proposal.id);
        if (!active || !matching || matching.status !== "proposed" || matching.manuscriptHash !== proposal.manuscriptHash || !isRow(matching.event) ||
            matching.event.status !== "proposed" || (Array.isArray(matching.conflictEventIds) && matching.conflictEventIds.length > 0) ||
            (matching.duplicateOfProposalId !== undefined && matching.duplicateOfProposalId !== null) ||
            !sameProposedEvent(matching.event, event)) {
          fail("snapshot_stale", `State proposal ${String(proposal.id)} is not live or does not match the confirmed event in this staged snapshot`);
        }
        const manuscript = typeof scene.raw.manuscript === "string" ? yield* currentFile(scene.raw.manuscript) : null;
        if (!manuscript || sha256Hex(manuscriptBody(manuscript.content)) !== proposal.manuscriptHash) fail("snapshot_stale", `State proposal ${String(proposal.id)} manuscript hash is stale`);
        yield* recordBase(active.path);
        yield* recordBase(scene.raw.manuscript as string);
      }
      for (const referenced of [scene, subject, ...(object ? [object] : [])]) yield* recordBase(referenced.filePath);
      nextRaw = { ...scene.raw, state_events: [...(Array.isArray(scene.raw.state_events) ? scene.raw.state_events : []), event] };
      const nextFile = { content: YAML.stringify(nextRaw), revision: "" }; nextFile.revision = sha256Hex(nextFile.content);
      stageFiles.set(scene.filePath, nextFile); entity = { ...scene, raw: nextRaw }; view = updateView(view, scene.filePath, nextFile, entity); writePath = scene.filePath;
    } else if (source.kind === "thread.link-scene") {
      const thread = uniqueEntity(view, String(target.threadId)); const scene = uniqueEntity(view, String(target.sceneId));
      if (thread.type !== "thread" || scene.type !== "scene") fail("invalid_input", "Thread link requires one thread and one scene");
      const file = yield* currentFile(thread.filePath); validatePrecondition(thread, file, precondition, `Thread ${thread.id}`);
      if (!file) fail("file_not_found", `Thread source is missing: ${thread.filePath}`);
      relationDirection(thread, scene, String(source.relation));
      if (relationExists(thread, scene.id, String(source.relation))) fail("conflict", "Thread relation already exists", { threadId: thread.id, sceneId: scene.id });
      yield* recordBase(thread.filePath); yield* recordBase(scene.filePath);
      const nextRelations = [...linksIn(thread.raw), { target: scene.id, kind: source.relation, ...(source.note ? { note: source.note } : {}) }];
      nextRaw = { ...thread.raw, relations: nextRelations };
      const nextFile = { content: YAML.stringify(nextRaw), revision: "" }; nextFile.revision = sha256Hex(nextFile.content);
      stageFiles.set(thread.filePath, nextFile); entity = { ...thread, raw: nextRaw }; view = updateView(view, thread.filePath, nextFile, entity); writePath = thread.filePath;
    } else {
      const from = uniqueEntity(view, String(target.from)); const to = uniqueEntity(view, String(target.to)); const kind = String(target.kind);
      const file = yield* currentFile(from.filePath); validatePrecondition(from, file, precondition, `Entity ${from.id}`);
      if (!file) fail("file_not_found", `Reference source is missing: ${from.filePath}`);
      relationDirection(from, to, kind);
      if (relationExists(from, to.id, kind)) fail("conflict", "Reference already exists", { from: from.id, to: to.id, kind });
      yield* recordBase(from.filePath); yield* recordBase(to.filePath);
      nextRaw = { ...from.raw, relations: [...linksIn(from.raw), { target: to.id, kind, ...(source.note ? { note: source.note } : {}) }] };
      const nextFile = { content: YAML.stringify(nextRaw), revision: "" }; nextFile.revision = sha256Hex(nextFile.content);
      stageFiles.set(from.filePath, nextFile); entity = { ...from, raw: nextRaw }; view = updateView(view, from.filePath, nextFile, entity); writePath = from.filePath;
    }

    const currentWrite = stageFiles.get(writePath);
    if (!currentWrite || !entity || !nextRaw) fail("guest_trap", `Compiler failed to produce bytes for ${source.id}`);
    const baseRevision = yield* recordBase(writePath);
    const operationId = `knowledge-${sha256Hex(`${context.snapshot.id}\0${source.id}\0${writePath}`).slice(0, 40)}`;
    const fileOperation: FileOperation = {
      id: operationId,
      kind: baseRevision === null ? "create" : "replace",
      path: writePath,
      expected_revision: baseRevision,
      content: [...new TextEncoder().encode(currentWrite.content)],
    };
    if (fileOperation.content!.length > 1_048_576) fail("capacity", `Compiled file exceeds 1 MiB: ${writePath}`, { path: writePath });
    const unitId = `unit-${sha256Hex(`${context.snapshot.id}\0${source.id}`).slice(0, 32)}`;
    const dependencyUnitIds = [...dependencies].map((sourceId) => `unit-${sha256Hex(`${context.snapshot.id}\0${sourceId}`).slice(0, 32)}`);
    const unit: ChangeUnit = { id: unitId, label: `${source.kind}: ${source.id}`, depends_on: dependencyUnitIds, operations: [fileOperation], source_operation_ids: [source.id] };
    units.push(unit); allOperations.push(fileOperation);
    operationMap.push({ source_operation_id: source.id, unit_id: unitId, operation_ids: [operationId] });
    filesWritten.set(writePath, source.id);
  }

  const read_set: ReadPrecondition[] = [...baseReadSet.values()].sort((left, right) => left.path.localeCompare(right.path));
  const diagnostics: Array<{ code: string; path?: string; message: string; severity: string }> = [];
  return { read_set, units, operation_map: operationMap, diagnostics };
}
