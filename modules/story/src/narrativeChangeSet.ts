import { createHash } from "node:crypto";
import YAML from "yaml";
import type {
  ChangeOperation,
  ModuleActionContext,
  ProposalEvidence,
  SnapshotReader,
} from "@scriptorium/contracts";
import { readStorySnapshot, type LoadedStorySnapshot } from "./snapshot.js";
import type { StoryEntity, StoryEntityType } from "./domain/types.js";
import { isRecord, type ObjectValue } from "./operations.js";

type NarrativeOperation = ObjectValue & { id: string; kind: string; evidenceIds: string[]; assessment: ObjectValue };
type NarrativeChangeSet = {
  schemaVersion: 1;
  id: string;
  projectId: string;
  goal: string;
  status: "proposed";
  assessment: ObjectValue;
  operations: NarrativeOperation[];
  evidence: ObjectValue[];
  diagnostics: ObjectValue;
};
type VirtualFile = { content: string; revision: string | null };
type WorkEntity = { id: string; type: StoryEntityType; filePath: string; raw: ObjectValue; body?: string };

const ID = /^[A-Za-z0-9_-]{1,256}$/;
const CORE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const TYPES = new Set<StoryEntityType>([
  "character", "location", "item", "faction", "event", "thread", "scene", "chapter",
  "volume", "arc", "lore", "dialogue_sketch", "manuscript",
]);
const CREATE_TYPES = new Set([
  "character", "location", "item", "faction", "event", "thread", "chapter", "volume", "arc", "lore", "dialogue_sketch",
]);
const OP_KINDS = new Set([
  "manuscript.replace-range", "entity.create", "entity.update", "scene.create", "scene.insert",
  "scene.update", "state.append-event", "thread.link-scene", "reference.link",
]);
const ENTITY_PREFIX: Partial<Record<StoryEntityType, string>> = {
  character: "bible/characters", location: "bible/locations", item: "bible/items", faction: "bible/factions",
  event: "bible/timeline/events", lore: "bible/lore", thread: "plot/threads", arc: "plot/arcs",
  dialogue_sketch: "bible/dialogue_sketches",
};

function fail(message: string, code = "invalid_input"): never {
  throw Object.assign(new TypeError(message), { code });
}
function assertRecord(value: unknown, label: string): ObjectValue {
  if (!isRecord(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail(`${label} must be an object`);
  return value;
}
function exactKeys(value: ObjectValue, allowed: string[], label: string): void {
  const keys = new Set(allowed);
  const extra = Object.keys(value).find((key) => !keys.has(key));
  if (extra) fail(`${label} contains unsupported field: ${extra}`);
}
function identity(value: unknown, label: string, max = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) fail(`${label} must be a string of 1 to ${max} characters`);
  return value;
}
function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} must be finite`);
  return value;
}
function assessment(value: unknown, label: string): ObjectValue {
  const row = assertRecord(value, label);
  exactKeys(row, ["confidence", "risk"], label);
  const confidence = finite(row.confidence, `${label}.confidence`);
  if (confidence < 0 || confidence > 1 || !["low", "medium", "high"].includes(String(row.risk))) fail(`${label} is invalid`);
  return row;
}
function assertJson(value: unknown, label: string): void {
  let count = 0;
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (pending.length) {
    const current = pending.pop()!;
    if (++count > 10_000 || current.depth > 16) fail(`${label} exceeds source JSON limits`);
    const item = current.value;
    if (item === null || typeof item === "boolean") continue;
    if (typeof item === "string") { if (item.length > 100_000) fail(`${label} contains an oversized string`); continue; }
    if (typeof item === "number") { if (!Number.isFinite(item)) fail(`${label} contains a non-finite number`); continue; }
    if (typeof item !== "object") fail(`${label} must contain JSON data`);
    if (Array.isArray(item)) {
      if (item.length > 1_000) fail(`${label} contains an oversized array`);
      for (const child of item) pending.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    const record = item as ObjectValue;
    if (Object.getPrototypeOf(record) !== Object.prototype && Object.getPrototypeOf(record) !== null) fail(`${label} must contain plain JSON records`);
    const entries = Object.entries(record);
    if (entries.length > 1_000) fail(`${label} contains an oversized record`);
    for (const [key, child] of entries) {
      if (key.length > 256 || ["__proto__", "prototype", "constructor"].includes(key)) fail(`${label} contains an unsafe key`);
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
}
function range(value: unknown, label: string): { start: number; end: number } {
  const row = assertRecord(value, label);
  exactKeys(row, ["start", "end"], label);
  const start = finite(row.start, `${label}.start`), end = finite(row.end, `${label}.end`);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) fail(`${label} is invalid`);
  return { start, end };
}
function precondition(value: unknown, label: string, allowAbsent = false): ObjectValue {
  const row = assertRecord(value, label);
  if (row.kind === "absent" && allowAbsent) {
    exactKeys(row, ["kind"], label);
    return row;
  }
  if (row.kind !== "revision" && row.kind !== "content-hash") fail(`${label}.kind is invalid`);
  exactKeys(row, ["kind", "value"], label);
  identity(row.value, `${label}.value`);
  return row;
}
function validateEvent(value: unknown, label: string): ObjectValue {
  const row = assertRecord(value, label);
  exactKeys(row, ["sceneId", "order", "kind", "subject", "object", "payload", "source", "eventId", "propositionId", "evidence", "confidence", "createdAt", "status", "replacesEventId"], label);
  identity(row.sceneId, `${label}.sceneId`); identity(row.subject, `${label}.subject`); identity(row.eventId, `${label}.eventId`);
  if (!Number.isInteger(row.order) || typeof row.order !== "number") fail(`${label}.order is invalid`);
  if (!["location", "acquaintance", "ownership", "knowledge"].includes(String(row.kind))) fail(`${label}.kind is invalid`);
  if (row.object !== null && typeof row.object !== "string") fail(`${label}.object is invalid`);
  if (!isRecord(row.payload) || !["rule", "llm-draft", "manual"].includes(String(row.source)) || row.status !== "confirmed") fail(`${label} is invalid`);
  for (const field of ["propositionId", "replacesEventId"] as const) if (row[field] !== undefined) identity(row[field], `${label}.${field}`);
  if (row.confidence !== undefined && (finite(row.confidence, `${label}.confidence`) < 0 || Number(row.confidence) > 1)) fail(`${label}.confidence is invalid`);
  if (row.createdAt !== undefined && (typeof row.createdAt !== "string" || Number.isNaN(Date.parse(row.createdAt)))) fail(`${label}.createdAt is invalid`);
  if (row.evidence !== undefined) {
    if (!Array.isArray(row.evidence) || row.evidence.length > 64) fail(`${label}.evidence is invalid`);
    for (const [index, evidence] of row.evidence.entries()) {
      const item = assertRecord(evidence, `${label}.evidence[${index}]`);
      exactKeys(item, ["sceneId", "excerpt", "startOffset", "endOffset"], `${label}.evidence[${index}]`);
      identity(item.sceneId, `${label}.evidence[${index}].sceneId`);
      if (item.excerpt !== undefined && (typeof item.excerpt !== "string" || item.excerpt.length > 10_000)) fail(`${label}.evidence[${index}].excerpt is invalid`);
      for (const n of ["startOffset", "endOffset"] as const) if (item[n] !== undefined && (!Number.isInteger(item[n]) || Number(item[n]) < 0)) fail(`${label}.evidence[${index}].${n} is invalid`);
    }
  }
  assertJson(row.payload, `${label}.payload`);
  return row;
}
function validateEvidence(value: unknown, index: number): ObjectValue {
  const label = `evidence[${index}]`, row = assertRecord(value, label);
  exactKeys(row, ["id", "sourceKind", "sourceId", "revision", "range"], label);
  identity(row.id, `${label}.id`); identity(row.sourceId, `${label}.sourceId`); identity(row.revision, `${label}.revision`);
  if (!["manuscript", "entity", "scene", "diagnostic", "state-proposal", "external"].includes(String(row.sourceKind))) fail(`${label}.sourceKind is invalid`);
  if (row.range !== undefined) range(row.range, `${label}.range`);
  return row;
}
function validateOperation(value: unknown, index: number): NarrativeOperation {
  const label = `operations[${index}]`, row = assertRecord(value, label);
  const kind = identity(row.kind, `${label}.kind`);
  if (!OP_KINDS.has(kind)) fail(`${label}.kind is unsupported`);
  identity(row.id, `${label}.id`);
  if (!Array.isArray(row.evidenceIds) || row.evidenceIds.length > 64) fail(`${label}.evidenceIds is invalid`);
  for (const id of row.evidenceIds) identity(id, `${label}.evidenceIds[]`);
  assessment(row.assessment, `${label}.assessment`);
  if (kind === "manuscript.replace-range") {
    exactKeys(row, ["id", "evidenceIds", "assessment", "kind", "precondition", "target", "range", "replacement"], label);
    precondition(row.precondition, `${label}.precondition`);
    const target = assertRecord(row.target, `${label}.target`); exactKeys(target, ["manuscriptId", "sceneId"], `${label}.target`);
    identity(target.manuscriptId, `${label}.target.manuscriptId`); identity(target.sceneId, `${label}.target.sceneId`);
    range(row.range, `${label}.range`);
    if (typeof row.replacement !== "string" || row.replacement.length > 100_000) fail(`${label}.replacement is invalid`);
  } else if (kind === "entity.create") {
    exactKeys(row, ["id", "evidenceIds", "assessment", "kind", "precondition", "target", "values"], label);
    precondition(row.precondition, `${label}.precondition`, true);
    const target = assertRecord(row.target, `${label}.target`); exactKeys(target, ["entityId", "entityType"], `${label}.target`);
    identity(target.entityId, `${label}.target.entityId`); identity(target.entityType, `${label}.target.entityType`);
    if (!isRecord(row.values)) fail(`${label}.values must be an object`); assertJson(row.values, `${label}.values`);
  } else if (kind === "entity.update" || kind === "scene.update") {
    exactKeys(row, ["id", "evidenceIds", "assessment", "kind", "precondition", "target", "changes"], label);
    precondition(row.precondition, `${label}.precondition`);
    const target = assertRecord(row.target, `${label}.target`);
    exactKeys(target, kind === "entity.update" ? ["entityId"] : ["sceneId"], `${label}.target`);
    identity(target[kind === "entity.update" ? "entityId" : "sceneId"], `${label}.target`);
    if (!isRecord(row.changes) || "id" in row.changes || "type" in row.changes) fail(`${label}.changes is invalid`); assertJson(row.changes, `${label}.changes`);
  } else if (kind === "scene.create") {
    exactKeys(row, ["id", "evidenceIds", "assessment", "kind", "precondition", "target", "collectionRevision", "values"], label);
    precondition(row.precondition, `${label}.precondition`, true);
    const target = assertRecord(row.target, `${label}.target`); exactKeys(target, ["sceneId"], `${label}.target`); identity(target.sceneId, `${label}.target.sceneId`);
    if (row.collectionRevision !== undefined) identity(row.collectionRevision, `${label}.collectionRevision`);
    if (!isRecord(row.values)) fail(`${label}.values must be an object`); assertJson(row.values, `${label}.values`);
  } else if (kind === "scene.insert") {
    exactKeys(row, ["id", "evidenceIds", "assessment", "kind", "precondition", "target", "position", "expectedSiblings"], label);
    precondition(row.precondition, `${label}.precondition`);
    const target = assertRecord(row.target, `${label}.target`); exactKeys(target, ["sceneId", "chapterId"], `${label}.target`);
    identity(target.sceneId, `${label}.target.sceneId`); identity(target.chapterId, `${label}.target.chapterId`);
    if (!Number.isInteger(row.position) || Number(row.position) < 1) fail(`${label}.position is invalid`);
    if (!Array.isArray(row.expectedSiblings) || row.expectedSiblings.length > 1_000) fail(`${label}.expectedSiblings is invalid`);
    for (const sibling of row.expectedSiblings) { const item = assertRecord(sibling, `${label}.expectedSiblings[]`); exactKeys(item, ["id", "revision"], `${label}.expectedSiblings[]`); identity(item.id, "sibling.id"); identity(item.revision, "sibling.revision"); }
  } else if (kind === "state.append-event") {
    exactKeys(row, ["id", "evidenceIds", "assessment", "kind", "precondition", "target", "event", "sourceProposal"], label);
    precondition(row.precondition, `${label}.precondition`);
    const target = assertRecord(row.target, `${label}.target`); exactKeys(target, ["sceneId", "eventId"], `${label}.target`);
    identity(target.sceneId, `${label}.target.sceneId`); identity(target.eventId, `${label}.target.eventId`);
    validateEvent(row.event, `${label}.event`);
    if (row.sourceProposal !== undefined) { const source = assertRecord(row.sourceProposal, `${label}.sourceProposal`); exactKeys(source, ["id", "manuscriptHash"], `${label}.sourceProposal`); identity(source.id, "sourceProposal.id"); identity(source.manuscriptHash, "sourceProposal.manuscriptHash"); }
  } else if (kind === "thread.link-scene") {
    exactKeys(row, ["id", "evidenceIds", "assessment", "kind", "precondition", "target", "relation", "note"], label);
    precondition(row.precondition, `${label}.precondition`);
    const target = assertRecord(row.target, `${label}.target`); exactKeys(target, ["threadId", "sceneId"], `${label}.target`);
    identity(target.threadId, `${label}.target.threadId`); identity(target.sceneId, `${label}.target.sceneId`);
    if (!["planted", "advanced", "payoff"].includes(String(row.relation))) fail(`${label}.relation is invalid`);
    if (row.note !== undefined && (typeof row.note !== "string" || row.note.length > 10_000)) fail(`${label}.note is invalid`);
  } else {
    exactKeys(row, ["id", "evidenceIds", "assessment", "kind", "precondition", "target", "note"], label);
    precondition(row.precondition, `${label}.precondition`);
    const target = assertRecord(row.target, `${label}.target`); exactKeys(target, ["from", "to", "kind"], `${label}.target`);
    identity(target.from, `${label}.target.from`); identity(target.to, `${label}.target.to`); identity(target.kind, `${label}.target.kind`);
    if (row.note !== undefined && (typeof row.note !== "string" || row.note.length > 10_000)) fail(`${label}.note is invalid`);
  }
  return row as NarrativeOperation;
}
function targetKey(operation: NarrativeOperation): string {
  const target = operation.target as ObjectValue;
  switch (operation.kind) {
    case "manuscript.replace-range": return `manuscript:${target.manuscriptId}`;
    case "entity.create": case "entity.update": return `entity:${target.entityId}`;
    case "scene.create": case "scene.update": return `entity:${target.sceneId}`;
    case "scene.insert": return `scene-insert:${target.sceneId}`;
    case "state.append-event": return `state-event:${JSON.stringify([target.sceneId, target.eventId])}`;
    case "thread.link-scene": return `thread-scene:${JSON.stringify([target.threadId, target.sceneId])}`;
    default: return `reference:${JSON.stringify([target.from, target.to, target.kind])}`;
  }
}
function validateChangeSet(value: unknown, context: ModuleActionContext): NarrativeChangeSet {
  const row = assertRecord(value, "NarrativeChangeSet");
  exactKeys(row, ["schemaVersion", "id", "projectId", "goal", "status", "assessment", "operations", "evidence", "diagnostics"], "NarrativeChangeSet");
  if (row.schemaVersion !== 1) fail("Unsupported NarrativeChangeSet version");
  const id = identity(row.id, "id"), projectId = identity(row.projectId, "projectId");
  if (projectId !== context.projectId) fail("NarrativeChangeSet projectId does not match the active project", "operation_precondition_conflict");
  if (typeof row.goal !== "string" || !row.goal.length || row.goal.length > 10_000) fail("NarrativeChangeSet goal is invalid");
  if (row.status !== "proposed") fail("Only a proposed NarrativeChangeSet can be submitted");
  assessment(row.assessment, "assessment");
  if (!Array.isArray(row.operations) || row.operations.length < 1 || row.operations.length > 64) fail("NarrativeChangeSet operations must contain 1 to 64 operations");
  if (!Array.isArray(row.evidence) || row.evidence.length > 256) fail("NarrativeChangeSet evidence must contain at most 256 items");
  const evidence = row.evidence.map(validateEvidence);
  const evidenceIds = new Set<string>();
  for (const item of evidence) { const evidenceId = item.id as string; if (evidenceIds.has(evidenceId)) fail("NarrativeChangeSet has duplicate evidence IDs"); evidenceIds.add(evidenceId); }
  const operations = row.operations.map(validateOperation), opIds = new Set<string>(), targets = new Set<string>();
  for (const [index, op] of operations.entries()) {
    if (opIds.has(op.id)) fail(`Duplicate operation ID at operations[${index}]`);
    opIds.add(op.id);
    const target = targetKey(op); if (targets.has(target)) fail(`Conflicting target at operations[${index}]`); targets.add(target);
    for (const evidenceId of op.evidenceIds) if (!evidenceIds.has(evidenceId)) fail(`Operation ${op.id} refers to missing evidence ${evidenceId}`);
    if (op.kind === "entity.create" || op.kind === "scene.create") {
      const targetValue = op.target as ObjectValue, values = op.values as ObjectValue;
      const entityId = String(targetValue.entityId ?? targetValue.sceneId), type = op.kind === "scene.create" ? "scene" : String(targetValue.entityType);
      if (values.id !== undefined && values.id !== entityId) fail(`Operation ${op.id} has a mismatched values.id`);
      if (values.type !== undefined && values.type !== type) fail(`Operation ${op.id} has a mismatched values.type`);
    }
    if (op.kind === "scene.insert") {
      const targetValue = op.target as ObjectValue;
      const precedingCreate = operations.slice(0, index).some((previous) => previous.kind === "scene.create" && (previous.target as ObjectValue).sceneId === targetValue.sceneId && (previous.values as ObjectValue).chapter === targetValue.chapterId);
      if (!precedingCreate) fail(`scene.insert ${op.id} must follow its matching scene.create`);
      const siblings = op.expectedSiblings as ObjectValue[];
      if (siblings.some((sibling) => sibling.id === targetValue.sceneId) || new Set(siblings.map((sibling) => sibling.id)).size !== siblings.length) fail(`scene.insert ${op.id} has invalid expected siblings`);
    }
    if (op.kind === "state.append-event") {
      const targetValue = op.target as ObjectValue, event = op.event as ObjectValue;
      if (event.sceneId !== targetValue.sceneId || event.eventId !== targetValue.eventId) fail(`state.append-event ${op.id} target does not match event`);
    }
  }
  const diagnostics = assertRecord(row.diagnostics, "diagnostics"); exactKeys(diagnostics, ["before", "after"], "diagnostics");
  for (const field of ["before", "after"] as const) {
    if (diagnostics[field] === null) continue;
    const item = assertRecord(diagnostics[field], `diagnostics.${field}`); exactKeys(item, ["id", "revision"], `diagnostics.${field}`);
    identity(item.id, `diagnostics.${field}.id`); identity(item.revision, `diagnostics.${field}.revision`);
  }
  assertJson(row, "NarrativeChangeSet");
  if (JSON.stringify(row).length > 1_000_000) fail("NarrativeChangeSet exceeds the source size limit");
  return { schemaVersion: 1, id, projectId, goal: row.goal, status: "proposed", assessment: row.assessment as ObjectValue, operations, evidence, diagnostics };
}
export function identifyNarrativeChangeSet(context: ModuleActionContext, rawInput: unknown): {
  changeSetId: string;
  coreProposalId: string;
  sourceFingerprint: string;
  operationIds: string[];
} {
  const sourceObject = assertRecord(rawInput, "NarrativeChangeSet");
  const changeSet = validateChangeSet(rawInput, context);
  return {
    changeSetId: changeSet.id,
    coreProposalId: coreProposalId(changeSet.id),
    sourceFingerprint: createHash("sha256").update(canonicalJson(sourceObject), "utf8").digest("hex"),
    operationIds: changeSet.operations.map((operation) => operation.id),
  };
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as ObjectValue).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function entityRevision(entity: Pick<WorkEntity, "raw" | "body">): string {
  return `\"sha256-${createHash("sha256").update(JSON.stringify(canonical({ raw: entity.raw, body: entity.body ?? null }))).digest("hex")}\"`;
}
function textHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 0x01000193); }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function revisionOf(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function pathForEntity(type: string, id: string, raw: ObjectValue): string {
  if (!SAFE_ID.test(id)) fail(`Unsafe entity ID: ${id}`);
  const flat = ENTITY_PREFIX[type as StoryEntityType];
  if (flat) return `${flat}/${id}.yaml`;
  if (type === "volume") return `plot/volumes/${id}/volume.yaml`;
  if (type === "chapter") {
    const volume = identity(raw.volume, "chapter.volume"); if (!SAFE_ID.test(volume)) fail("Unsafe chapter volume ID");
    return `plot/volumes/${volume}/chapters/${id}/chapter.yaml`;
  }
  if (type === "scene") {
    const volume = identity(raw.volume, "scene.volume"), chapter = identity(raw.chapter, "scene.chapter");
    if (!SAFE_ID.test(volume) || !SAFE_ID.test(chapter)) fail("Unsafe scene parent ID");
    return `plot/volumes/${volume}/chapters/${chapter}/scenes/${id}.yaml`;
  }
  fail(`Unsupported entity type: ${type}`);
}
function workEntity(entity: StoryEntity): WorkEntity { return { id: entity.id, type: entity.type, filePath: entity.filePath, raw: structuredClone(entity.raw), ...(entity.body !== undefined ? { body: entity.body } : {}) }; }
function parsedMarkdown(content: string): { prefix: string; raw: ObjectValue; body: string; rawBody: string } {
  const opening = /^---[ \t]*\r?\n/.exec(content);
  if (!opening) return { prefix: "", raw: {}, body: content.trim(), rawBody: content };
  const delimiter = /^---[ \t]*\r?$/gm; delimiter.lastIndex = opening[0].length;
  const closing = delimiter.exec(content); if (!closing) fail("Manuscript frontmatter is unclosed");
  const raw = YAML.parse(content.slice(opening[0].length, closing.index));
  if (raw !== null && !isRecord(raw)) fail("Manuscript frontmatter must be a YAML mapping");
  let bodyStart = closing.index + closing[0].length;
  if (content.startsWith("\r\n", bodyStart)) bodyStart += 2; else if (content.startsWith("\n", bodyStart)) bodyStart += 1;
  const prefix = content.slice(0, bodyStart), rawBody = content.slice(bodyStart);
  return { prefix, raw: (raw ?? {}) as ObjectValue, body: rawBody.trim(), rawBody };
}
function outputYaml(value: ObjectValue): string { return YAML.stringify(value); }
function entityForId(entities: Map<string, WorkEntity>, id: unknown, label: string): WorkEntity {
  const entity = typeof id === "string" ? entities.get(id) : undefined;
  if (!entity) fail(`${label} not found: ${String(id)}`, "operation_precondition_conflict");
  return entity;
}
function assertPrecondition(entity: WorkEntity | undefined, condition: ObjectValue, label: string): void {
  if (condition.kind === "absent") { if (entity) fail(`${label} already exists`, "operation_precondition_conflict"); return; }
  if (!entity) fail(`${label} does not exist`, "operation_precondition_conflict");
  const actual = condition.kind === "content-hash" && entity.type === "manuscript"
    ? textHash(entity.body ?? "")
    : entityRevision(entity);
  if (actual !== condition.value) fail(`${label} revision does not match the selected Story snapshot`, "operation_precondition_conflict");
}
function collectionRevision(entities: Map<string, WorkEntity>): string {
  const rows = [...entities.values()].map((entity) => [entity.id, entityRevision(entity)]).sort(([a], [b]) => String(a).localeCompare(String(b)));
  return `\"sha256-${createHash("sha256").update(JSON.stringify(canonical(rows))).digest("hex")}\"`;
}
function entityReferences(entities: Map<string, WorkEntity>, raw: ObjectValue, omit?: string): void {
  const require = (value: unknown, label: string, type?: string) => {
    if (typeof value !== "string" || !entities.has(value) || value === omit) fail(`${label} must reference an existing entity`, "operation_precondition_conflict");
    if (type && entities.get(value)!.type !== type) fail(`${label} must reference a ${type}`, "operation_precondition_conflict");
  };
  for (const [key, type] of [["volume", "volume"], ["chapter", "chapter"], ["pov", "character"], ["location", "location"], ["resolution", "scene"]] as const) if (raw[key] !== undefined && raw[key] !== null) require(raw[key], key, type);
  for (const field of ["appears", "mentions", "plants", "advances", "related", "pov", "affiliated", "target", "first_appears", "planted", "payoff"]) {
    const value = raw[field], refs = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
    for (const ref of refs) if (typeof ref === "string") require(ref, field); else if (isRecord(ref)) require(ref.target ?? ref.scene ?? ref.id, field);
  }
  if (Array.isArray(raw.relations)) for (const relation of raw.relations) if (isRecord(relation) && relation.target !== undefined) require(relation.target, "relations.target");
}
function containsLink(entity: WorkEntity, to: string, kind: string): boolean {
  if (Array.isArray(entity.raw.relations) && entity.raw.relations.some((relation) => isRecord(relation) && relation.to === to && relation.kind === kind)) return true;
  for (const field of ["appears", "mentions", "plants", "advances", "related", "pov", "affiliated", "target", "first_appears", "planted", "payoff"]) {
    const values = Array.isArray(entity.raw[field]) ? entity.raw[field] as unknown[] : [entity.raw[field]];
    if (values.some((value) => value === to || (isRecord(value) && (value.target ?? value.scene ?? value.id) === to && (value.kind === undefined || value.kind === kind)))) return true;
  }
  return false;
}
function safeHash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 48); }
function coreProposalId(sourceId: string): string {
  return CORE_ID.test(sourceId) ? sourceId : `story-cs-${createHash("sha256").update(sourceId, "utf8").digest("hex")}`;
}
function sourceTarget(operation: NarrativeOperation): string {
  const target = operation.target as ObjectValue;
  switch (operation.kind) {
    case "manuscript.replace-range": return String(target.manuscriptId);
    case "entity.create": return String(target.entityId);
    case "entity.update": return String(target.entityId);
    case "scene.create": case "scene.update": return String(target.sceneId);
    case "scene.insert": return String(target.chapterId);
    case "state.append-event": return String(target.sceneId);
    case "thread.link-scene": return String(target.threadId);
    default: return String(target.from);
  }
}
function entityBySourceId(entities: Map<string, WorkEntity>, id: string): WorkEntity | undefined { return entities.get(id); }

function mapEvidence(changeSet: NarrativeChangeSet, story: LoadedStorySnapshot, context: ModuleActionContext): ProposalEvidence[] {
  return changeSet.evidence.map((source) => {
    const sourceId = String(source.sourceId);
    const entity = story.entities.get(sourceId);
    const path = entity?.filePath ?? (story.files.has(sourceId) ? sourceId : undefined);
    const revision = path ? story.files.get(path)?.revision ?? null : null;
    return {
      id: `story-evidence-${safeHash(`${changeSet.id}\0${source.id}`)}`,
      snapshot: context.reader.snapshot,
      module: "story",
      kind: `source.${source.sourceKind}`,
      paths: path ? [{ path, revision }] : [],
      details: {
        changeSetId: changeSet.id,
        sourceEvidenceId: source.id,
      },
    };
  });
}
function evidenceIdMap(changeSet: NarrativeChangeSet): Map<string, string> {
  return new Map(changeSet.evidence.map((source) => [String(source.id), `story-evidence-${safeHash(`${changeSet.id}\0${source.id}`)}`]));
}
function linkedEvidenceIds(op: NarrativeOperation, ids: Map<string, string>): string[] { return op.evidenceIds.map((id) => ids.get(id)!).filter(Boolean); }
function makeOperation(context: ModuleActionContext, changeSetId: string, source: NarrativeOperation, reads: Map<string, string | null>, writes: Map<string, { revision: string | null; content: string | null }>, evidenceIds: string[]): ChangeOperation {
  const operationId = `story-cs-${safeHash(`${context.projectId}\0${changeSetId}\0${source.id}`)}`;
  const effect: ChangeOperation["effect"] = source.kind === "manuscript.replace-range" ? "manuscript" :
    source.kind === "scene.create" || source.kind === "scene.insert" || source.kind === "entity.create" ? "structure" : "metadata";
  return {
    id: operationId,
    generation: 0,
    repository: context.reader.snapshot.repository,
    baseRemoteCommit: context.reader.snapshot.remoteCommit,
    effect,
    reads: [...reads].map(([path, revision]) => ({ path, revision })),
    writes: [...writes].map(([path, write]) => ({ path, revision: write.revision, content: write.content })),
    message: `Story change set ${source.id}: ${source.kind}`,
    evidenceIds,
  };
}
function setFileWrite(files: Map<string, VirtualFile>, reads: Map<string, string | null>, writes: Map<string, { revision: string | null; content: string | null }>, path: string, content: string): void {
  const prior = files.get(path);
  if (!reads.has(path)) reads.set(path, prior?.revision ?? null);
  writes.set(path, { revision: prior?.revision ?? null, content });
  files.set(path, { content, revision: revisionOf(content) });
}
function writeEntity(entity: WorkEntity, content: string, files: Map<string, VirtualFile>, reads: Map<string, string | null>, writes: Map<string, { revision: string | null; content: string | null }>): void {
  setFileWrite(files, reads, writes, entity.filePath, content);
}
function validateEntityValues(type: string, id: string, values: ObjectValue, entities: Map<string, WorkEntity>): ObjectValue {
  if (!CREATE_TYPES.has(type) && type !== "scene") fail(`Entity creation type is unsupported: ${type}`);
  const raw: ObjectValue = { ...values, id, type };
  if (typeof raw.title === "string") raw.title = raw.title.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^[=\-_~]{3,}\s*$/.test(line)).join(" ").trim();
  if (typeof raw.name === "string") raw.name = raw.name.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^[=\-_~]{3,}\s*$/.test(line)).join(" ").trim();
  entityReferences(entities, raw, id);
  return raw;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as ObjectValue;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
function resultIdentity(operation: NarrativeOperation): string {
  const target = operation.target as ObjectValue;
  switch (operation.kind) {
    case "manuscript.replace-range": return String(target.manuscriptId);
    case "entity.create": case "entity.update": return String(target.entityId);
    case "scene.create": case "scene.update": case "scene.insert": return String(target.sceneId);
    case "state.append-event": return String(target.eventId);
    case "thread.link-scene": return JSON.stringify([target.threadId, target.sceneId, operation.relation]);
    default: return JSON.stringify([target.from, target.to, target.kind]);
  }
}

/** Convert a validated source v1 change set into snapshot-bound Core operations without mutating files. */
export async function buildNarrativeChangeProposal(context: ModuleActionContext, rawInput: unknown, preparedIdentity?: ReturnType<typeof identifyNarrativeChangeSet>): Promise<{
  changeSetId: string;
  proposalId: string;
  coreProposalId: string;
  submittedAt: string;
  operationIds: string[];
  operationMap: Record<string, string>;
  dependencies: Record<string, string[]>;
  resultIds: Record<string, string>;
  resultPaths: Record<string, string[]>;
  resultRevisions: Record<string, string>;
  affectedEntities: Record<string, Array<{ id: string; revision: string }>>;
  sourceFingerprint: string;
  operations: ChangeOperation[];
  evidence: ProposalEvidence[];
}> {
  const sourceObject = assertRecord(rawInput, "NarrativeChangeSet");
  const changeSet = validateChangeSet(rawInput, context);
  const identity = preparedIdentity ?? identifyNarrativeChangeSet(context, rawInput);
  const mappedCoreProposalId = identity.coreProposalId;
  const sourceFingerprint = identity.sourceFingerprint;
  const submittedAt = new Date().toISOString();
  const story = await readStorySnapshot(context.reader);
  const entities = new Map([...story.entities].map(([id, entity]) => [id, workEntity(entity)]));
  const files = new Map<string, VirtualFile>([...story.files].map(([path, file]) => [path, { content: file.content, revision: file.revision }]));
  const evidence = mapEvidence(changeSet, story, context), evidenceIds = evidenceIdMap(changeSet);
  const operations: ChangeOperation[] = [], operationMap: Record<string, string> = {}, dependencies: Record<string, string[]> = {}, resultIds: Record<string, string> = {}, resultPaths: Record<string, string[]> = {}, resultRevisions: Record<string, string> = {}, affectedEntities: Record<string, Array<{ id: string; revision: string }>> = {};
  const createdScenes = new Map<string, string>();
  for (const [index, op] of changeSet.operations.entries()) {
    const target = op.target as ObjectValue;
    const condition = op.precondition as ObjectValue;
    const reads = new Map<string, string | null>(), writes = new Map<string, { revision: string | null; content: string | null }>();
    const findUnique = (id: string): WorkEntity | undefined => {
      if (story.duplicateIds.has(id)) fail(`Duplicate entity ID in Story snapshot: ${id}`, "operation_precondition_conflict");
      return entityBySourceId(entities, id);
    };
    const requireTarget = (id: string, label: string): WorkEntity => {
      const entity = findUnique(id); if (!entity) fail(`${label} not found: ${id}`, "operation_precondition_conflict"); return entity;
    };
    const addEntityRead = (entity: WorkEntity): void => {
      const file = files.get(entity.filePath); reads.set(entity.filePath, file?.revision ?? null);
    };
    if (op.kind === "manuscript.replace-range") {
      const manuscript = requireTarget(String(target.manuscriptId), "Manuscript");
      const scene = requireTarget(String(target.sceneId), "Scene");
      if (manuscript.type !== "manuscript" || scene.type !== "scene" || scene.raw.manuscript !== manuscript.filePath || manuscript.body === undefined) fail("Manuscript and scene do not match", "operation_precondition_conflict");
      assertPrecondition(manuscript, condition, `Manuscript ${manuscript.id}`); addEntityRead(manuscript);
      const manuscriptFile = files.get(manuscript.filePath); if (!manuscriptFile) fail(`Manuscript file not found: ${manuscript.filePath}`);
      const doc = parsedMarkdown(manuscriptFile.content), replacementRange = op.range as ObjectValue;
      const start = Number(replacementRange.start), end = Number(replacementRange.end);
      if (end > doc.body.length) fail("Manuscript replacement range exceeds the selected body", "operation_precondition_conflict");
      const leftTrim = doc.rawBody.length - doc.rawBody.trimStart().length;
      const body = doc.rawBody.slice(0, leftTrim + start) + String(op.replacement) + doc.rawBody.slice(leftTrim + end);
      const next = doc.prefix + body;
      setFileWrite(files, reads, writes, manuscript.filePath, next);
      manuscript.body = body.trim();
    } else if (op.kind === "entity.create" || op.kind === "scene.create") {
      const id = String(op.kind === "scene.create" ? target.sceneId : target.entityId);
      const type = op.kind === "scene.create" ? "scene" : String(target.entityType);
      if (op.kind === "entity.create" && !CREATE_TYPES.has(type)) fail(`Entity creation type is unsupported: ${type}`);
      const existing = findUnique(id); assertPrecondition(existing, condition, `Entity ${id}`);
      const raw = validateEntityValues(type, id, op.values as ObjectValue, entities);
      const path = pathForEntity(type, id, raw);
      if (files.has(path)) fail(`Entity file already exists: ${path}`, "operation_precondition_conflict");
      if (op.kind === "scene.create" && op.collectionRevision !== undefined) {
        if (collectionRevision(entities) !== op.collectionRevision) fail("Scene creation collection revision is stale", "operation_precondition_conflict");
        for (const entity of entities.values()) addEntityRead(entity);
      }
      if (op.kind === "scene.create") {
        const parent = requireTarget(String(raw.chapter), "Chapter");
        if (parent.type !== "chapter") fail("Scene chapter must reference a chapter", "operation_precondition_conflict");
        if (parent.raw.volume !== raw.volume) fail("Scene chapter does not belong to the requested volume", "operation_precondition_conflict");
      }
      if (op.kind === "entity.create" && type === "chapter") {
        const parent = requireTarget(String(raw.volume), "Volume"); if (parent.type !== "volume") fail("Chapter volume must reference a volume", "operation_precondition_conflict");
      }
      if ((type === "chapter" || type === "scene") && (raw.order === undefined || raw.order === null)) {
        const parentKey = type === "chapter" ? "volume" : "chapter";
        const parentId = String(raw[parentKey]);
        const siblings = [...entities.values()].filter((entity) => entity.type === type && entity.raw[parentKey] === parentId);
        raw.order = siblings.reduce((max, entity) => Math.max(max, typeof entity.raw.order === "number" ? entity.raw.order : 0), 0) + 1;
      }
      const entity: WorkEntity = { id, type: type as StoryEntityType, filePath: path, raw, ...(typeof raw.body === "string" ? { body: raw.body } : {}) };
      setFileWrite(files, reads, writes, path, outputYaml(raw)); entities.set(id, entity);
      if (op.kind === "scene.create") {
        const manuscriptPath = `manuscript/${String(raw.volume)}/${String(raw.chapter)}/${id}.md`;
        if (files.has(manuscriptPath)) fail(`Manuscript file already exists: ${manuscriptPath}`, "operation_precondition_conflict");
        raw.manuscript = manuscriptPath;
        setFileWrite(files, reads, writes, path, outputYaml(raw));
        const stubFrontmatter = YAML.stringify({ title: typeof raw.title === "string" ? raw.title : id, status: "planned" });
        setFileWrite(files, reads, writes, manuscriptPath, `---\n${stubFrontmatter}---\n`);
        createdScenes.set(id, op.id);
      }
    } else if (op.kind === "entity.update" || op.kind === "scene.update") {
      const id = String(op.kind === "scene.update" ? target.sceneId : target.entityId), entity = requireTarget(id, "Entity");
      if (op.kind === "scene.update" && entity.type !== "scene") fail(`Entity ${id} is not a scene`, "operation_precondition_conflict");
      if (op.kind === "entity.update" && ["scene", "manuscript"].includes(entity.type)) fail(`Entity ${id} cannot be updated through entity.update`, "operation_precondition_conflict");
      assertPrecondition(entity, condition, `Entity ${id}`); addEntityRead(entity);
      const changes = op.changes as ObjectValue;
      const nextRaw: ObjectValue = { ...entity.raw, ...changes, id: entity.id, type: entity.type };
      for (const [key, value] of Object.entries(changes)) if (value === null) delete nextRaw[key];
      entityReferences(entities, nextRaw, entity.id);
      entity.raw = nextRaw; writeEntity(entity, outputYaml(nextRaw), files, reads, writes);
    } else if (op.kind === "scene.insert") {
      const sceneId = String(target.sceneId), chapterId = String(target.chapterId), chapter = requireTarget(chapterId, "Chapter"), scene = requireTarget(sceneId, "Scene");
      if (chapter.type !== "chapter" || scene.type !== "scene" || scene.raw.chapter !== chapterId) fail("scene.insert target does not belong to the named chapter", "operation_precondition_conflict");
      assertPrecondition(chapter, condition, `Chapter ${chapterId}`); addEntityRead(chapter);
      const expected = (op.expectedSiblings as ObjectValue[]).map((item) => ({ id: String(item.id), revision: String(item.revision) })).sort((a, b) => a.id.localeCompare(b.id));
      const siblings = [...entities.values()].filter((entity) => entity.type === "scene" && entity.raw.chapter === chapterId && entity.id !== sceneId).map((entity) => ({ id: entity.id, revision: entityRevision(entity) })).sort((a, b) => a.id.localeCompare(b.id));
      if (JSON.stringify(expected) !== JSON.stringify(siblings)) fail("Scene insertion sibling revisions are stale", "operation_precondition_conflict");
      for (const sibling of entities.values()) if (sibling.type === "scene" && sibling.raw.chapter === chapterId) addEntityRead(sibling);
      const ordered = [...entities.values()].filter((entity) => entity.type === "scene" && entity.raw.chapter === chapterId).sort((a, b) => Number(a.raw.order ?? 0) - Number(b.raw.order ?? 0) || a.id.localeCompare(b.id)).filter((entity) => entity.id !== sceneId).map((entity) => entity.id);
      const insertAt = Math.min(Number(op.position) - 1, ordered.length); ordered.splice(insertAt, 0, sceneId);
      for (const [position, id] of ordered.entries()) {
        const entity = requireTarget(id, "Scene");
        const nextRaw = { ...entity.raw, order: position + 1 };
        entity.raw = nextRaw;
        writeEntity(entity, outputYaml(nextRaw), files, reads, writes);
      }
      const createId = createdScenes.get(sceneId); if (!createId) fail("scene.insert depends on a scene.create operation in this change set");
      dependencies[op.id] = [createId];
    } else if (op.kind === "state.append-event") {
      const scene = requireTarget(String(target.sceneId), "Scene"), event = op.event as ObjectValue;
      if (scene.type !== "scene") fail("State events can only be appended to a scene", "operation_precondition_conflict");
      assertPrecondition(scene, condition, `Scene ${scene.id}`); addEntityRead(scene);
      if (event.sceneId !== scene.id || event.eventId !== target.eventId) fail("State event target mismatch");
      const events = Array.isArray(scene.raw.state_events) ? scene.raw.state_events as unknown[] : [];
      if (events.some((item) => isRecord(item) && item.eventId === event.eventId)) fail(`State event already exists: ${String(event.eventId)}`, "operation_precondition_conflict");
      const subject = requireTarget(String(event.subject), "State event subject");
      const object = event.object === null ? undefined : requireTarget(String(event.object), "State event object");
      if (event.kind === "location" && (subject.type !== "character" || object?.type !== "location")) fail("Location event references have invalid entity types", "operation_precondition_conflict");
      if (event.kind === "ownership" && subject.type !== "item") fail("Ownership event subject must be an item", "operation_precondition_conflict");
      const nextRaw = { ...scene.raw, state_events: [...events, event] }; scene.raw = nextRaw; writeEntity(scene, outputYaml(nextRaw), files, reads, writes);
    } else if (op.kind === "thread.link-scene") {
      const thread = requireTarget(String(target.threadId), "Thread"), scene = requireTarget(String(target.sceneId), "Scene");
      if (thread.type !== "thread" || scene.type !== "scene") fail("Thread and scene references have invalid types", "operation_precondition_conflict");
      if (op.relation === "advanced") fail("Source apply does not support advanced thread links", "feature_unsupported");
      assertPrecondition(thread, condition, `Thread ${thread.id}`); addEntityRead(thread);
      if (containsLink(thread, scene.id, String(op.relation))) fail("Thread already has this scene relation", "operation_precondition_conflict");
      const relation: ObjectValue = { to: scene.id, kind: op.relation, ...(typeof op.note === "string" ? { note: op.note } : {}) };
      const nextRaw = { ...thread.raw, relations: [...(Array.isArray(thread.raw.relations) ? thread.raw.relations as unknown[] : []), relation] };
      thread.raw = nextRaw; writeEntity(thread, outputYaml(nextRaw), files, reads, writes);
    } else {
      const from = requireTarget(String(target.from), "Reference source"), to = requireTarget(String(target.to), "Reference target");
      assertPrecondition(from, condition, `Entity ${from.id}`); addEntityRead(from);
      if (containsLink(from, to.id, String(target.kind))) fail("Reference already exists", "operation_precondition_conflict");
      const relation: ObjectValue = { to: to.id, kind: target.kind, ...(typeof op.note === "string" ? { note: op.note } : {}) };
      const nextRaw = { ...from.raw, relations: [...(Array.isArray(from.raw.relations) ? from.raw.relations as unknown[] : []), relation] };
      from.raw = nextRaw; writeEntity(from, outputYaml(nextRaw), files, reads, writes);
    }
    if (reads.size > 512 || writes.size > 256) fail(`Operation ${op.id} exceeds Core file operation limits`);
    const operation = makeOperation(context, changeSet.id, op, reads, writes, linkedEvidenceIds(op, evidenceIds));
    if (!operation.writes.length) fail(`Operation ${op.id} does not produce a Story write`);
    operationMap[op.id] = operation.id;
    resultIds[op.id] = resultIdentity(op);
    resultPaths[op.id] = operation.writes.map((write) => write.path);
    const targetEntityId = resultEntityId(op);
    const targetEntity = entities.get(targetEntityId);
    if (!targetEntity) fail(`Operation ${op.id} result entity is unavailable: ${targetEntityId}`);
    resultRevisions[op.id] = entityRevision(targetEntity);
    if (op.kind === "scene.insert") {
      const writtenPaths = new Set(resultPaths[op.id]);
      affectedEntities[op.id] = [...entities.values()]
        .filter((entity) => entity.type === "scene" && writtenPaths.has(entity.filePath))
        .map((entity) => ({ id: entity.id, revision: entityRevision(entity) }))
        .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    }
    operations.push(operation);
  }
  if (new Set(operations.map((op) => op.id)).size !== operations.length) fail("NarrativeChangeSet produced duplicate Core operation IDs");
  const metadataEvidenceId = `story-changeset-${safeHash(changeSet.id)}`;
  for (const operation of operations) operation.evidenceIds = [...new Set([...(operation.evidenceIds ?? []), metadataEvidenceId])];
  evidence.push({
    id: metadataEvidenceId,
    snapshot: context.reader.snapshot,
    module: "story",
    kind: "source.narrative-change-set.v1",
    paths: [],
    details: { sourceChangeSet: sourceObject, sourceFingerprint, submittedAt, coreProposalId: mappedCoreProposalId, operationMap, dependencies, resultIds, resultPaths, resultRevisions, affectedEntities },
  });
  const evidenceBytes = Buffer.byteLength(JSON.stringify(evidence), "utf8");
  if (evidenceBytes > 1_000_000) fail("NarrativeChangeSet source evidence exceeds the Core proposal evidence limit");
  return { changeSetId: changeSet.id, proposalId: mappedCoreProposalId, coreProposalId: mappedCoreProposalId, submittedAt, operationIds: operations.map((op) => op.id), operationMap, dependencies, resultIds, resultPaths, resultRevisions, affectedEntities, sourceFingerprint, operations, evidence };
}

function resultEntityId(operation: NarrativeOperation): string {
  const target = operation.target as ObjectValue;
  switch (operation.kind) {
    case "manuscript.replace-range": return String(target.manuscriptId);
    case "entity.create": case "entity.update": return String(target.entityId);
    case "scene.create": case "scene.update": case "scene.insert": return String(target.sceneId);
    case "state.append-event": return String(target.sceneId);
    case "thread.link-scene": return String(target.threadId);
    default: return String(target.from);
  }
}

