import { stringify } from "yaml";
import type { ActionRequest, ChangeUnit, FileOperation, NarrativeHost } from "./contracts.js";
import type { HostCall } from "../../shared/guest.js";
import { fail } from "./errors.js";
import { sha256Hex } from "./hash.js";
import { appendYamlSequenceValue, parseYamlRecord, removeYamlSequenceIndex, updateYamlFields } from "./yaml-source.js";
import { readWorkSnapshot, validateManuscriptPath, type MetadataFile, type WorkSnapshot } from "./workspace.js";
import { pathExists, readFileRevision, readTextFile } from "./actions.js";

type ObjectValue = Record<string, unknown>;
type SourceOperation = ObjectValue & { id: string; kind: string; evidenceIds: string[] };
type SourceEvidence = ObjectValue & { id: string; sourceKind: string; sourceId: string; revision: string; range?: { start: number; end: number } };
type SourceInput = { operations: SourceOperation[]; evidence: SourceEvidence[]; staging_snapshot?: string };
type PendingWrite = { path: string; expected_revision: string | null; content: string; source_ids: string[]; first_source: number };

const SOURCE_OPERATION_KINDS = new Set([
  "manuscript.replace-range", "entity.create", "entity.update", "scene.create", "scene.insert",
  "scene.update", "state.append-event", "thread.link-scene", "reference.link",
]);
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const MARK_KEYS = ["id", "offset", "length", "snippet", "createdAt"] as const;

function isRecord(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function record(value: unknown, label: string): ObjectValue {
  if (!isRecord(value)) fail("invalid_input", `${label} must be an object`);
  return value;
}
function exactKeys(value: ObjectValue, allowed: string[], label: string): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra) fail("invalid_input", `${label} contains unsupported field: ${extra}`);
}
function identity(value: unknown, label: string, max = 256): string {
  if (typeof value !== "string" || !value.length || value.length > max) fail("invalid_input", `${label} must be a string of 1 to ${max} characters`);
  return value;
}
function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail("invalid_input", `${label} must be finite`);
  return value;
}
function jsonData(value: unknown, label: string): void {
  let count = 0;
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (pending.length) {
    const current = pending.pop()!;
    if (++count > 10_000 || current.depth > 16) fail("invalid_input", `${label} exceeds source JSON limits`);
    const item = current.value;
    if (item === null || typeof item === "boolean") continue;
    if (typeof item === "string") { if (item.length > 100_000) fail("invalid_input", `${label} contains an oversized string`); continue; }
    if (typeof item === "number") { if (!Number.isFinite(item)) fail("invalid_input", `${label} contains a non-finite number`); continue; }
    if (typeof item !== "object") fail("invalid_input", `${label} must contain JSON data`);
    if (Array.isArray(item)) {
      if (item.length > 1_000) fail("invalid_input", `${label} contains an oversized array`);
      for (const child of item) pending.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    if (!isRecord(item)) fail("invalid_input", `${label} must contain plain JSON records`);
    const entries = Object.entries(item);
    if (entries.length > 1_000) fail("invalid_input", `${label} contains an oversized record`);
    for (const [key, child] of entries) {
      if (key.length > 256 || ["__proto__", "prototype", "constructor"].includes(key)) fail("invalid_input", `${label} contains an unsafe key`);
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
}
function validateAssessment(value: unknown, label: string): void {
  const row = record(value, label); exactKeys(row, ["confidence", "risk"], label);
  const confidence = finite(row.confidence, `${label}.confidence`);
  if (confidence < 0 || confidence > 1 || !["low", "medium", "high"].includes(String(row.risk))) fail("invalid_input", `${label} is invalid`);
}
function validatePrecondition(value: unknown, label: string, allowAbsent = false): ObjectValue {
  const row = record(value, label);
  if (row.kind === "absent" && allowAbsent) { exactKeys(row, ["kind"], label); return row; }
  if (row.kind !== "revision" && row.kind !== "content-hash") fail("invalid_input", `${label}.kind is invalid`);
  exactKeys(row, ["kind", "value"], label); identity(row.value, `${label}.value`);
  return row;
}
function validateRange(value: unknown, label: string): { start: number; end: number } {
  const row = record(value, label); exactKeys(row, ["start", "end"], label);
  const start = finite(row.start, `${label}.start`), end = finite(row.end, `${label}.end`);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) fail("invalid_input", `${label} is invalid`);
  return { start, end };
}
function validateEvent(value: unknown, label: string): void {
  const row = record(value, label);
  exactKeys(row, ["sceneId", "order", "kind", "subject", "object", "payload", "source", "eventId", "propositionId", "evidence", "confidence", "createdAt", "status", "replacesEventId"], label);
  identity(row.sceneId, `${label}.sceneId`); identity(row.subject, `${label}.subject`); identity(row.eventId, `${label}.eventId`);
  if (!Number.isInteger(row.order) || typeof row.order !== "number") fail("invalid_input", `${label}.order is invalid`);
  if (!["location", "acquaintance", "ownership", "knowledge"].includes(String(row.kind))) fail("invalid_input", `${label}.kind is invalid`);
  if (row.object !== null && typeof row.object !== "string") fail("invalid_input", `${label}.object is invalid`);
  if (!isRecord(row.payload) || !["rule", "llm-draft", "manual"].includes(String(row.source)) || row.status !== "confirmed") fail("invalid_input", `${label} is invalid`);
  for (const field of ["propositionId", "replacesEventId"] as const) if (row[field] !== undefined) identity(row[field], `${label}.${field}`);
  if (row.confidence !== undefined && (finite(row.confidence, `${label}.confidence`) < 0 || Number(row.confidence) > 1)) fail("invalid_input", `${label}.confidence is invalid`);
  if (row.createdAt !== undefined && (typeof row.createdAt !== "string" || Number.isNaN(Date.parse(row.createdAt)))) fail("invalid_input", `${label}.createdAt is invalid`);
  if (row.evidence !== undefined) {
    if (!Array.isArray(row.evidence) || row.evidence.length > 64) fail("invalid_input", `${label}.evidence is invalid`);
    for (const [index, raw] of row.evidence.entries()) {
      const evidence = record(raw, `${label}.evidence[${index}]`); exactKeys(evidence, ["sceneId", "excerpt", "startOffset", "endOffset"], `${label}.evidence[${index}]`);
      identity(evidence.sceneId, `${label}.evidence[${index}].sceneId`);
      if (evidence.excerpt !== undefined && (typeof evidence.excerpt !== "string" || evidence.excerpt.length > 10_000)) fail("invalid_input", `${label}.evidence[${index}].excerpt is invalid`);
      for (const key of ["startOffset", "endOffset"] as const) if (evidence[key] !== undefined && (!Number.isInteger(evidence[key]) || Number(evidence[key]) < 0)) fail("invalid_input", `${label}.evidence[${index}].${key} is invalid`);
    }
  }
  jsonData(row.payload, `${label}.payload`);
}
function validateOperation(value: unknown, index: number): SourceOperation {
  const label = `operations[${index}]`, row = record(value, label);
  const kind = identity(row.kind, `${label}.kind`);
  if (!SOURCE_OPERATION_KINDS.has(kind)) fail("invalid_input", `${label}.kind is unsupported`);
  identity(row.id, `${label}.id`);
  if (!Array.isArray(row.evidenceIds) || row.evidenceIds.length > 64) fail("invalid_input", `${label}.evidenceIds is invalid`);
  for (const id of row.evidenceIds) identity(id, `${label}.evidenceIds[]`);
  validateAssessment(row.assessment, `${label}.assessment`);
  if (kind === "manuscript.replace-range") {
    exactKeys(row, ["id", "evidenceIds", "assessment", "kind", "precondition", "target", "range", "replacement"], label);
    validatePrecondition(row.precondition, `${label}.precondition`);
    const target = record(row.target, `${label}.target`); exactKeys(target, ["manuscriptId", "sceneId"], `${label}.target`);
    identity(target.manuscriptId, `${label}.target.manuscriptId`); identity(target.sceneId, `${label}.target.sceneId`);
    validateRange(row.range, `${label}.range`);
    if (typeof row.replacement !== "string" || row.replacement.length > 100_000) fail("invalid_input", `${label}.replacement is invalid`);
  } else if (kind === "entity.create") {
    exactKeys(row, ["id", "evidenceIds", "assessment", "kind", "precondition", "target", "values"], label);
    validatePrecondition(row.precondition, `${label}.precondition`, true);
    const target = record(row.target, `${label}.target`); exactKeys(target, ["entityId", "entityType"], `${label}.target`);
    identity(target.entityId, `${label}.target.entityId`); identity(target.entityType, `${label}.target.entityType`);
    if (!isRecord(row.values)) fail("invalid_input", `${label}.values must be an object`); jsonData(row.values, `${label}.values`);
  } else if (kind === "entity.update" || kind === "scene.update") {
    exactKeys(row, ["id", "evidenceIds", "assessment", "kind", "precondition", "target", "changes"], label);
    validatePrecondition(row.precondition, `${label}.precondition`);
    const target = record(row.target, `${label}.target`); exactKeys(target, kind === "entity.update" ? ["entityId"] : ["sceneId"], `${label}.target`);
    identity(target[kind === "entity.update" ? "entityId" : "sceneId"], `${label}.target`);
    if (!isRecord(row.changes) || "id" in row.changes || "type" in row.changes) fail("invalid_input", `${label}.changes is invalid`);
    jsonData(row.changes, `${label}.changes`);
  } else if (kind === "scene.create") {
    exactKeys(row, ["id", "evidenceIds", "assessment", "kind", "precondition", "target", "collectionRevision", "values"], label);
    validatePrecondition(row.precondition, `${label}.precondition`, true);
    const target = record(row.target, `${label}.target`); exactKeys(target, ["sceneId"], `${label}.target`); identity(target.sceneId, `${label}.target.sceneId`);
    if (row.collectionRevision !== undefined) identity(row.collectionRevision, `${label}.collectionRevision`);
    if (!isRecord(row.values)) fail("invalid_input", `${label}.values must be an object`); jsonData(row.values, `${label}.values`);
  } else if (kind === "scene.insert") {
    exactKeys(row, ["id", "evidenceIds", "assessment", "kind", "precondition", "target", "position", "expectedSiblings"], label);
    validatePrecondition(row.precondition, `${label}.precondition`);
    const target = record(row.target, `${label}.target`); exactKeys(target, ["sceneId", "chapterId"], `${label}.target`);
    identity(target.sceneId, `${label}.target.sceneId`); identity(target.chapterId, `${label}.target.chapterId`);
    if (!Number.isInteger(row.position) || Number(row.position) < 1) fail("invalid_input", `${label}.position is invalid`);
    if (!Array.isArray(row.expectedSiblings) || row.expectedSiblings.length > 1_000) fail("invalid_input", `${label}.expectedSiblings is invalid`);
    for (const sibling of row.expectedSiblings) {
      const item = record(sibling, `${label}.expectedSiblings[]`); exactKeys(item, ["id", "revision"], `${label}.expectedSiblings[]`);
      identity(item.id, "sibling.id"); identity(item.revision, "sibling.revision");
    }
  } else if (kind === "state.append-event") {
    exactKeys(row, ["id", "evidenceIds", "assessment", "kind", "precondition", "target", "event", "sourceProposal"], label);
    validatePrecondition(row.precondition, `${label}.precondition`);
    const target = record(row.target, `${label}.target`); exactKeys(target, ["sceneId", "eventId"], `${label}.target`);
    identity(target.sceneId, `${label}.target.sceneId`); identity(target.eventId, `${label}.target.eventId`); validateEvent(row.event, `${label}.event`);
    if (row.sourceProposal !== undefined) {
      const source = record(row.sourceProposal, `${label}.sourceProposal`); exactKeys(source, ["id", "manuscriptHash"], `${label}.sourceProposal`);
      identity(source.id, "sourceProposal.id"); identity(source.manuscriptHash, "sourceProposal.manuscriptHash");
    }
  } else if (kind === "thread.link-scene") {
    exactKeys(row, ["id", "evidenceIds", "assessment", "kind", "precondition", "target", "relation", "note"], label);
    validatePrecondition(row.precondition, `${label}.precondition`);
    const target = record(row.target, `${label}.target`); exactKeys(target, ["threadId", "sceneId"], `${label}.target`);
    identity(target.threadId, `${label}.target.threadId`); identity(target.sceneId, `${label}.target.sceneId`);
    if (!["planted", "advanced", "payoff"].includes(String(row.relation))) fail("invalid_input", `${label}.relation is invalid`);
    if (row.note !== undefined && (typeof row.note !== "string" || row.note.length > 10_000)) fail("invalid_input", `${label}.note is invalid`);
  } else {
    exactKeys(row, ["id", "evidenceIds", "assessment", "kind", "precondition", "target", "note"], label);
    validatePrecondition(row.precondition, `${label}.precondition`);
    const target = record(row.target, `${label}.target`); exactKeys(target, ["from", "to", "kind"], `${label}.target`);
    identity(target.from, `${label}.target.from`); identity(target.to, `${label}.target.to`); identity(target.kind, `${label}.target.kind`);
    if (row.note !== undefined && (typeof row.note !== "string" || row.note.length > 10_000)) fail("invalid_input", `${label}.note is invalid`);
  }
  return row as SourceOperation;
}
function validateEvidence(value: unknown, index: number): SourceEvidence {
  const label = `evidence[${index}]`, row = record(value, label);
  exactKeys(row, ["id", "sourceKind", "sourceId", "revision", "range"], label);
  identity(row.id, `${label}.id`); identity(row.sourceId, `${label}.sourceId`); identity(row.revision, `${label}.revision`);
  if (!["manuscript", "entity", "scene", "diagnostic", "state-proposal", "external"].includes(String(row.sourceKind))) fail("invalid_input", `${label}.sourceKind is invalid`);
  if (row.range !== undefined) validateRange(row.range, `${label}.range`);
  return row as SourceEvidence;
}
function targetKey(operation: SourceOperation): string {
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
function validateInput(value: unknown): SourceInput {
  const input = record(value, "input"); exactKeys(input, ["operations", "evidence", "staging_snapshot"], "input");
  if (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > 64) fail("invalid_input", "operations must contain 1 to 64 source operations");
  if (!Array.isArray(input.evidence) || input.evidence.length > 256) fail("invalid_input", "evidence must contain at most 256 source evidence records");
  if (input.staging_snapshot !== undefined && (typeof input.staging_snapshot !== "string" || !input.staging_snapshot.length || input.staging_snapshot.length > 512)) fail("invalid_input", "staging_snapshot must be an opaque Host lease ID");
  const operations = input.operations.map(validateOperation), evidence = input.evidence.map(validateEvidence);
  const evidenceById = new Map<string, SourceEvidence>();
  for (const item of evidence) {
    if (evidenceById.has(item.id)) fail("invalid_input", `Duplicate evidence ID: ${item.id}`);
    evidenceById.set(item.id, item);
  }
  const operationIds = new Set<string>(), targets = new Set<string>();
  for (const [index, operation] of operations.entries()) {
    if (operationIds.has(operation.id)) fail("invalid_input", `Duplicate operation ID at operations[${index}]`);
    operationIds.add(operation.id);
    const key = targetKey(operation);
    if (targets.has(key)) fail("conflict", `Conflicting target at operations[${index}]`);
    targets.add(key);
    for (const id of operation.evidenceIds) if (!evidenceById.has(id)) fail("invalid_input", `Operation ${operation.id} refers to missing evidence ${id}`);
    if (operation.kind === "entity.create" || operation.kind === "scene.create") {
      const target = operation.target as ObjectValue, values = operation.values as ObjectValue;
      const id = String(target.entityId ?? target.sceneId), kind = operation.kind === "scene.create" ? "scene" : String(target.entityType);
      if (values.id !== undefined && values.id !== id) fail("invalid_input", `Operation ${operation.id} has a mismatched values.id`);
      if (values.type !== undefined && values.type !== kind) fail("invalid_input", `Operation ${operation.id} has a mismatched values.type`);
    }
    if (operation.kind === "scene.insert") {
      const target = operation.target as ObjectValue;
      const hasCreate = operations.slice(0, index).some((prior) => prior.kind === "scene.create" &&
        (prior.target as ObjectValue).sceneId === target.sceneId && (prior.values as ObjectValue).chapter === target.chapterId);
      if (!hasCreate && input.staging_snapshot === undefined) fail("dependency_unavailable", `scene.insert ${operation.id} requires its preceding matching scene.create stage`, { source_operation_id: operation.id });
      const siblings = operation.expectedSiblings as ObjectValue[];
      if (siblings.some((item) => item.id === target.sceneId) || new Set(siblings.map((item) => item.id)).size !== siblings.length) fail("invalid_input", `scene.insert ${operation.id} has invalid expected siblings`);
    }
    if (operation.kind === "state.append-event") {
      const target = operation.target as ObjectValue, event = operation.event as ObjectValue;
      if (event.sceneId !== target.sceneId || event.eventId !== target.eventId) fail("invalid_input", `state.append-event ${operation.id} target does not match event`);
    }
  }
  jsonData(input, "NarrativeChangeSet compiler input");
  if (JSON.stringify(input).length > 1_000_000) fail("capacity", "NarrativeChangeSet compiler input exceeds the source size limit");
  return { operations, evidence, ...(typeof input.staging_snapshot === "string" ? { staging_snapshot: input.staging_snapshot } : {}) };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as ObjectValue).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}
export function narrativeEntityRevision(raw: ObjectValue): string {
  const serialized = JSON.stringify(canonical({ raw, body: null }));
  return `"sha256-${sha256Hex(serialized)}"`;
}
function sourcePrecondition(operation: SourceOperation, raw: ObjectValue, label: string, allowAbsent = false): void {
  const condition = operation.precondition as ObjectValue;
  if (condition.kind === "absent" && allowAbsent) return;
  if (condition.kind !== "revision") fail("invalid_input", `${label} requires an entity revision precondition`);
  const actual = narrativeEntityRevision(raw);
  if (condition.value !== actual) fail("snapshot_stale", `${label} revision does not match the selected source snapshot`, { expected: condition.value, actual });
}
function safeId(value: unknown, label: string): string {
  const id = identity(value, label);
  if (!SAFE_ID.test(id)) fail("invalid_path", `${label} must be a safe 1 to 128 character path component`);
  return id;
}
function title(value: unknown, label = "title"): string {
  if (typeof value !== "string" || !value.trim() || value.trim() !== value || [...value].length > 500 || /[\r\n\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    fail("invalid_input", `${label} must be one non-empty line of at most 500 Unicode scalar values`);
  }
  return value;
}
function positiveOrder(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 2_147_483_647) fail("invalid_input", `${label} must be a positive order integer`);
  return Number(value);
}
function appendOrder(rows: Array<{ order?: number }>): number {
  const maximum = rows.reduce((max, row) => row.order === undefined ? max : Math.max(max, row.order), 0);
  const missing = rows.filter((row) => row.order === undefined).length;
  return positiveOrder(Math.max(1, maximum + missing + 1), "order");
}
function metadataPath(kind: "volume" | "chapter" | "scene", id: string, parentIds: string[] = []): string {
  if (kind === "volume") return `plot/volumes/${id}/volume.yaml`;
  if (kind === "chapter") {
    const volumeId = safeId(parentIds[0], "parent volume ID");
    return `plot/volumes/${volumeId}/chapters/${id}/chapter.yaml`;
  }
  const volumeId = safeId(parentIds[0], "parent volume ID"), chapterId = safeId(parentIds[1], "parent chapter ID");
  return `plot/volumes/${volumeId}/chapters/${chapterId}/scenes/${id}.yaml`;
}
function fileOperation(id: string, path: string, expected_revision: string | null, content: string): FileOperation {
  return {
    id,
    kind: expected_revision === null ? "create" : "replace",
    path,
    expected_revision,
    content: Array.from(new TextEncoder().encode(content)),
  };
}
function compareRows(a: { order?: number; metadata_path: string; id: string }, b: { order?: number; metadata_path: string; id: string }): number {
  if (a.order !== undefined && b.order !== undefined && a.order !== b.order) return a.order - b.order;
  if (a.order !== undefined && b.order === undefined) return -1;
  if (a.order === undefined && b.order !== undefined) return 1;
  return a.metadata_path.localeCompare(b.metadata_path) || a.id.localeCompare(b.id);
}
function addRead(reads: Map<string, string | null>, path: string, revision: string | null): void {
  const prior = reads.get(path);
  if (prior !== undefined && prior !== revision) fail("snapshot_stale", `Original-base read revision conflicts at ${path}`, { path });
  reads.set(path, revision);
}
function addWrite(writes: Map<string, PendingWrite>, path: string, expected_revision: string | null, content: string, sourceId: string, sourceIndex: number): void {
  const prior = writes.get(path);
  if (prior && prior.expected_revision !== expected_revision) fail("snapshot_stale", `Write precondition changed at ${path}`, { path });
  writes.set(path, {
    path,
    expected_revision,
    content,
    source_ids: [...new Set([...(prior?.source_ids ?? []), sourceId])],
    first_source: prior?.first_source ?? sourceIndex,
  });
}
function refreshFile(work: WorkSnapshot, path: string, text: string, kind: "volume" | "chapter" | "scene", revision: string): MetadataFile {
  const raw = parseYamlRecord(text, path).value;
  const id = identity(raw.id, `${path}.id`);
  const parent = kind === "chapter" ? identity(raw.volume, `${path}.volume`) : kind === "scene" ? identity(raw.chapter, `${path}.chapter`) : null;
  const rawTitle = raw.title ?? raw.name ?? id;
  const row = {
    id,
    kind,
    title: title(rawTitle),
    ...(Number.isSafeInteger(raw.order) ? { order: Number(raw.order) } : {}),
    parent_id: parent,
    metadata_path: path,
    metadata_revision: revision,
    ...(kind === "scene" ? { manuscript_path: validateManuscriptPath(raw.manuscript) } : {}),
    raw,
  } as const;
  const metadata: MetadataFile = { path, revision, text, raw, kind, row: { ...row, raw } };
  work.files.set(path, metadata);
  work.byId.set(id, metadata.row!);
  const rows = kind === "volume" ? work.volumes : kind === "chapter" ? work.chapters : work.scenes;
  const index = rows.findIndex((item) => item.id === id);
  if (index >= 0) rows[index] = metadata.row!;
  else rows.push(metadata.row!);
  rows.sort(compareRows);
  if (!work.entries.some((entry) => entry.path === path)) work.entries.push({ path, revision, byte_length: new TextEncoder().encode(text).length, media_type: "text/yaml" });
  return metadata;
}
function entityFor(work: WorkSnapshot, id: string, kind?: "volume" | "chapter" | "scene"): MetadataFile {
  const paths = work.duplicatePaths.get(id);
  if (paths) fail("ambiguous_identity", `Hierarchy ID ${id} is ambiguous`, { paths });
  const row = work.byId.get(id);
  if (!row || (kind && row.kind !== kind)) fail("scene_not_found", `Narrative hierarchy entity ${id} was not found`);
  const file = work.files.get(row.metadata_path);
  if (!file) fail("unsupported_format", `Narrative metadata could not be read: ${row.metadata_path}`, { path: row.metadata_path });
  return file;
}
function parentRows(work: WorkSnapshot, kind: "chapter" | "scene", parentId: string): MetadataFile[] {
  entityFor(work, parentId, kind === "chapter" ? "volume" : "chapter");
  const parentKey = kind === "chapter" ? "volume" : "chapter";
  const rawChildren = [...work.files.values()].filter((file) => file.kind === kind && file.raw[parentKey] === parentId);
  for (const file of rawChildren) {
    const id = typeof file.raw.id === "string" ? file.raw.id : "";
    if (work.duplicatePaths.has(id)) fail("ambiguous_identity", `Sibling ID ${id} is ambiguous`, { paths: work.duplicatePaths.get(id) });
  }
  const children = (kind === "chapter" ? work.chapters : work.scenes).filter((row) => row.parent_id === parentId);
  return children.sort(compareRows).map((row) => work.files.get(row.metadata_path)!).filter(Boolean);
}
function validMark(value: unknown): value is ObjectValue {
  if (!isRecord(value)) return false;
  if (!MARK_KEYS.every((key) => key in value)) return false;
  return typeof value.id === "string" && value.id.length > 0 && Number.isSafeInteger(value.offset) && Number(value.offset) >= 0 &&
    Number.isSafeInteger(value.length) && Number(value.length) > 0 && typeof value.snippet === "string" &&
    Number(value.offset) + Number(value.length) <= Number.MAX_SAFE_INTEGER &&
    typeof value.createdAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u.test(value.createdAt) && Number.isFinite(Date.parse(value.createdAt)) &&
    (value.comment === undefined || typeof value.comment === "string" && value.comment.length <= 200);
}
function sameMarkData(left: ObjectValue, right: ObjectValue): boolean {
  return MARK_KEYS.every((key) => left[key] === right[key]) && (left.comment ?? undefined) === (right.comment ?? undefined);
}
function normalizeNewMark(value: ObjectValue): ObjectValue {
  const allowed = new Set<string>([...MARK_KEYS, "comment"]);
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra) fail("invalid_input", `New reading mark has unsupported field ${extra}`);
  return {
    id: value.id,
    offset: value.offset,
    length: value.length,
    snippet: value.snippet,
    ...(value.comment && value.comment !== "" ? { comment: value.comment } : {}),
    createdAt: value.createdAt,
  };
}
function manuscriptId(path: string): string {
  return `ms-${path.slice("manuscript/".length).replaceAll("/", "-").replace(/\.md$/u, "")}`;
}
function outputSchemaDiagnostics(work: WorkSnapshot): Array<{ code: string; path?: string; message: string; severity: "warning" | "error" }> {
  return work.diagnostics.map(({ code, path, message, severity }) => ({ code, ...(path ? { path } : {}), message, severity }));
}
function createNewMetadata(work: WorkSnapshot, path: string, content: string, kind: "volume" | "chapter" | "scene"): void {
  const revision = `staged-${sha256Hex(content)}`;
  refreshFile(work, path, content, kind, revision);
}
function hierarchyRows(work: WorkSnapshot, kind: "volume" | "chapter" | "scene"): MetadataFile[] {
  return (kind === "volume" ? work.volumes : kind === "chapter" ? work.chapters : work.scenes)
    .map((row) => work.files.get(row.metadata_path)!).filter(Boolean);
}
function sceneInsertDiagnostics(work: WorkSnapshot, chapter: MetadataFile): void {
  const sceneDir = `${chapter.path.replace(/\/chapter\.ya?ml$/iu, "")}/scenes/`;
  const malformed = work.diagnostics.find((item) => item.severity === "error" && item.path?.startsWith(sceneDir));
  if (malformed) fail("unsupported_format", `Cannot verify the complete scene sibling set while ${malformed.path} is malformed`, { path: malformed.path });
}
/** Compile only Narrative-owned source v1 changes. It has no proposal or apply authority. */
export function* compileNarrativeChanges(host: NarrativeHost, request: ActionRequest, value: unknown): Generator<HostCall, unknown, unknown> {
  const input = validateInput(value);
  const evidenceById = new Map(input.evidence.map((item) => [item.id, item]));
  const stagedRequest: ActionRequest = input.staging_snapshot
    ? { ...request, snapshot: { ...request.snapshot, id: input.staging_snapshot } }
    : request;
  const original = yield* readWorkSnapshot(host, request);
  const baseWork = original;
  const work = input.staging_snapshot ? yield* readWorkSnapshot(host, stagedRequest) : original;
  const baseRevisionByPath = new Map<string, string | null>(original.entries.map((entry) => [entry.path, entry.revision]));
  const baseReads = new Map<string, string | null>(baseRevisionByPath);
  const writes = new Map<string, PendingWrite>();
  const sourceOrder = new Map(input.operations.map((operation, index) => [operation.id, index]));
  const sourcePaths = new Map(input.operations.map((operation) => [operation.id, new Set<string>()]));
  const declaredDependencies: Array<[string, string]> = [];
  const createdById = new Map<string, string>();
  const originalRevision = function* (path: string): Generator<HostCall, string | null, unknown> {
    if (baseRevisionByPath.has(path)) return baseRevisionByPath.get(path)!;
    let revision: string | null = null;
    try { revision = yield* readFileRevision(host, request, path); }
    catch (error) { if ((error as { code?: unknown } | null)?.code !== "file_not_found") throw error; }
    addRead(baseReads, path, revision);
    return revision;
  };
  const stagePathExists = function* (path: string): Generator<HostCall, boolean, unknown> {
    return yield* pathExists(host, stagedRequest, path);
  };

  for (const [index, operation] of input.operations.entries()) {
    const target = operation.target as ObjectValue;
    const condition = operation.precondition as ObjectValue;
    const operationId = operation.id;
    const markOperationWrite = (path: string, revision: string | null, content: string): void => {
      addWrite(writes, path, revision, content, operationId, index);
      sourcePaths.get(operationId)!.add(path);
    };
    if (operation.kind === "entity.create") {
      const entityId = safeId(target.entityId, "target.entityId"), entityType = String(target.entityType);
      if (entityType !== "volume" && entityType !== "chapter") {
        fail("dependency_unavailable", `Narrative does not own entity type ${entityType}`, { source_operation_id: operationId, owner: "proprium.knowledge" });
      }
      if (condition.kind !== "absent") fail("invalid_input", `${operationId} create requires an absent precondition`);
      const existing = work.byId.get(entityId) || work.duplicatePaths.has(entityId);
      if (existing) fail("conflict", `Narrative ID already exists: ${entityId}`);
      const values = operation.values as ObjectValue;
      const allowed = entityType === "volume" ? ["id", "type", "title", "name", "order"] : ["id", "type", "title", "name", "volume", "order"];
      const unsupported = Object.keys(values).find((key) => !allowed.includes(key));
      if (unsupported) fail("invalid_input", `Narrative ${entityType} create does not accept ${unsupported}`);
      const displayTitle = title(values.title ?? values.name);
      let path: string;
      if (entityType === "chapter") {
        const volumeId = safeId(values.volume, "values.volume");
        const parent = entityFor(work, volumeId, "volume");
        yield* originalRevision(parent.path);
        const priorCreator = createdById.get(volumeId); if (priorCreator) declaredDependencies.push([operationId, priorCreator]);
        path = metadataPath("chapter", entityId, [volumeId]);
      } else {
        path = metadataPath("volume", entityId);
      }
      if (yield* stagePathExists(path)) fail("conflict", `Narrative metadata path already exists: ${path}`, { path });
      const existingBase = yield* originalRevision(path);
      if (existingBase !== null) fail("conflict", `Narrative metadata path exists in the original workspace: ${path}`, { path });
      const rows = entityType === "volume" ? work.volumes : parentRows(work, "chapter", String(values.volume)).map((file) => file.row!);
      if (entityType === "volume") {
        for (const sibling of hierarchyRows(work, "volume")) yield* originalRevision(sibling.path);
      } else {
        for (const sibling of parentRows(work, "chapter", String(values.volume))) yield* originalRevision(sibling.path);
      }
      const order = values.order === undefined ? appendOrder(rows) : positiveOrder(values.order, "values.order");
      const raw = entityType === "volume"
        ? { id: entityId, type: "volume", title: displayTitle, order }
        : { id: entityId, type: "chapter", title: displayTitle, volume: String(values.volume), order };
      const content = stringify(raw, { lineWidth: 0, simpleKeys: true });
      markOperationWrite(path, null, content);
      createNewMetadata(work, path, content, entityType);
      createdById.set(entityId, operationId);
    } else if (operation.kind === "scene.create") {
      const sceneId = safeId(target.sceneId, "target.sceneId");
      if (condition.kind !== "absent") fail("invalid_input", `${operationId} scene.create requires an absent precondition`);
      if (work.byId.has(sceneId) || work.duplicatePaths.has(sceneId)) fail("conflict", `Narrative ID already exists: ${sceneId}`);
      const values = operation.values as ObjectValue;
      const volumeId = safeId(values.volume, "values.volume"), chapterId = safeId(values.chapter, "values.chapter");
      const volume = entityFor(work, volumeId, "volume"), chapter = entityFor(work, chapterId, "chapter");
      if (chapter.row?.parent_id !== volumeId) fail("invalid_parent", `Chapter ${chapterId} does not belong to volume ${volumeId}`);
      yield* originalRevision(volume.path);
      yield* originalRevision(chapter.path);
      for (const parentId of [volumeId, chapterId]) { const creator = createdById.get(parentId); if (creator) declaredDependencies.push([operationId, creator]); }
      const displayTitle = title(values.title ?? values.name);
      const path = metadataPath("scene", sceneId, [volumeId, chapterId]);
      const manuscriptPath = `manuscript/${volumeId}/${chapterId}/${sceneId}.md`;
      if ((yield* stagePathExists(path)) || (yield* stagePathExists(manuscriptPath))) fail("conflict", "Scene metadata or linked manuscript path already exists", { path });
      const metadataBaseRevision = yield* originalRevision(path);
      const manuscriptBaseRevision = yield* originalRevision(manuscriptPath);
      if (metadataBaseRevision !== null || manuscriptBaseRevision !== null) fail("conflict", "Scene metadata or linked manuscript exists in the original workspace", { path });
      const siblings = parentRows(work, "scene", chapterId).map((file) => file.row!);
      for (const sibling of parentRows(work, "scene", chapterId)) yield* originalRevision(sibling.path);
      const order = values.order === undefined ? appendOrder(siblings) : positiveOrder(values.order, "values.order");
      const raw: ObjectValue = { id: sceneId, type: "scene", title: displayTitle, volume: volumeId, chapter: chapterId, order, manuscript: manuscriptPath };
      if (values.readingMarks !== undefined) {
        if (!Array.isArray(values.readingMarks)) fail("invalid_input", "scene.create readingMarks must be an array");
        if (values.readingMarks.length) fail("invalid_input", "A new scene has an empty manuscript and cannot contain reading marks");
        raw.readingMarks = values.readingMarks;
      }
      const metadataContent = stringify(raw, { lineWidth: 0, simpleKeys: true });
      const bodyContent = `---\n${stringify({ title: displayTitle, status: "planned" }, { lineWidth: 0, simpleKeys: true })}---\n\n`;
      markOperationWrite(path, null, metadataContent);
      markOperationWrite(manuscriptPath, null, bodyContent);
      createNewMetadata(work, path, metadataContent, "scene");
      createdById.set(sceneId, operationId);
    } else if (operation.kind === "entity.update" || operation.kind === "scene.update") {
      const id = String(operation.kind === "entity.update" ? target.entityId : target.sceneId);
      let metadata: MetadataFile;
      try { metadata = entityFor(work, id); }
      catch (error) {
        if ((error as { code?: unknown } | null)?.code === "scene_not_found") fail("dependency_unavailable", `Narrative does not own entity ${id}`, { source_operation_id: operationId });
        throw error;
      }
      if (operation.kind === "entity.update" && metadata.kind === "scene") fail("invalid_input", "Scenes require scene.update, not entity.update");
      if (operation.kind === "entity.update" && metadata.kind !== "volume" && metadata.kind !== "chapter") {
        fail("dependency_unavailable", `Narrative does not own entity ${id}`, { source_operation_id: operationId });
      }
      if (operation.kind === "scene.update" && metadata.kind !== "scene") fail("scene_not_found", `Scene ${id} was not found`);
      const originalMetadata = baseWork?.files.get(metadata.path) ?? metadata;
      sourcePrecondition(operation, originalMetadata.raw, `Entity ${id}`);
      const changes = operation.changes as ObjectValue;
      if (metadata.kind === "volume" && "order" in changes) fail("invalid_input", "Narrative does not support changing volume order");
      const ownerKeys = operation.kind === "scene.update" ? ["title", "manuscript", "order", "readingMarks"] : ["title", ...(metadata.kind === "chapter" ? ["order"] : [])];
      const selected = Object.fromEntries(Object.entries(changes).filter(([key]) => ownerKeys.includes(key)));
      if (!Object.keys(selected).length) fail("dependency_unavailable", `No Narrative-owned fields appear in ${operationId}`, { source_operation_id: operationId, owner: "proprium.knowledge" });
      const disallowedParent = Object.keys(changes).find((key) => ["volume", "chapter"].includes(key));
      if (disallowedParent) fail("invalid_input", `Narrative does not support changing ${disallowedParent} through scene.update`);
      if (selected.title !== undefined) title(selected.title, "changes.title");
      if (selected.order !== undefined) positiveOrder(selected.order, "changes.order");
      let changed = metadata.text;
      const scalarUpdates: Record<string, string | number> = {};
      for (const key of ["title", "order"] as const) if (selected[key] !== undefined) scalarUpdates[key] = selected[key] as string | number;
      if (selected.manuscript !== undefined) {
        const destination = validateManuscriptPath(selected.manuscript);
        const destinationRevision = yield* readFileRevision(host, stagedRequest, destination);
        const baseDestinationRevision = yield* originalRevision(destination);
        addRead(baseReads, destination, baseDestinationRevision);
        if (!destinationRevision) fail("file_not_found", `Linked manuscript is missing: ${destination}`, { path: destination });
        scalarUpdates.manuscript = destination;
      }
      if (Object.keys(scalarUpdates).length) changed = updateYamlFields(changed, metadata.path, scalarUpdates);
      if (selected.readingMarks !== undefined) {
        if (!Array.isArray(selected.readingMarks)) fail("invalid_input", "changes.readingMarks must be an array");
        const prior = metadata.raw.readingMarks;
        if (prior !== undefined && !Array.isArray(prior)) fail("unsupported_format", `readingMarks must be a YAML sequence at ${metadata.path}`, { path: metadata.path });
        const priorRows = Array.isArray(prior) ? prior : [];
        const priorValid = priorRows.flatMap((mark, markIndex) => validMark(mark) ? [{ mark, markIndex }] : []);
        const wanted = selected.readingMarks as unknown[];
        for (const row of wanted) if (!validMark(row)) fail("invalid_input", "Narrative source readingMarks contains an invalid mark");
        const wantedIds = wanted.map((row) => (row as ObjectValue).id as string);
        if (new Set(wantedIds).size !== wantedIds.length) fail("conflict", "Narrative source readingMarks contains duplicate IDs");
        let lastKept = -1;
        for (const mark of priorValid) {
          const nextIndex = wantedIds.indexOf(mark.mark.id as string);
          if (nextIndex >= 0) {
            if (!sameMarkData(mark.mark, wanted[nextIndex] as ObjectValue)) fail("invalid_input", "Existing reading marks may only be explicitly added or removed");
            if (nextIndex <= lastKept) fail("invalid_input", "Existing reading mark order cannot be changed");
            lastKept = nextIndex;
          }
        }
        const manuscriptPath = validateManuscriptPath(metadata.row?.manuscript_path);
        const stageBody = yield* readTextFile(host, stagedRequest, manuscriptPath);
        if (stageBody.revision === null) fail("file_not_found", `Linked manuscript is missing: ${manuscriptPath}`, { path: manuscriptPath });
        const baseBodyRevision = yield* originalRevision(manuscriptPath);
        addRead(baseReads, manuscriptPath, baseBodyRevision);
        const evidenceCandidates = operation.evidenceIds.map((idValue) => evidenceById.get(idValue)!).filter((item) => item.sourceKind === "manuscript");
        const additions = wanted.filter((item) => !priorValid.some(({ mark }) => mark.id === (item as ObjectValue).id)) as ObjectValue[];
        for (const added of additions) {
          const start = Number(added.offset), end = start + Number(added.length);
          if (end > stageBody.text.length || stageBody.text.slice(start, end) !== added.snippet) fail("conflict", `Reading mark ${String(added.id)} does not match the staged manuscript range`, { path: manuscriptPath });
          const evidence = evidenceCandidates.find((candidate) => {
            const range = candidate.range;
            return (candidate.sourceId === manuscriptPath || candidate.sourceId === manuscriptId(manuscriptPath)) &&
              candidate.revision === baseBodyRevision && range?.start === start && range.end === end;
          });
          if (!evidence) fail("invalid_input", `Reading mark ${String(added.id)} needs manuscript evidence for its original revision and exact UTF-16 range`, { path: manuscriptPath });
        }
        if (baseBodyRevision === null) fail("file_not_found", `Linked manuscript is missing from the original base: ${manuscriptPath}`, { path: manuscriptPath });
        const currentIds = new Set(priorRows.flatMap((row) => isRecord(row) && typeof row.id === "string" ? [row.id] : []));
        if (additions.some((mark) => currentIds.has(mark.id as string))) fail("conflict", "A reading mark ID already exists");
        for (const { mark, markIndex } of [...priorValid].filter(({ mark }) => !wantedIds.includes(mark.id as string)).sort((a, b) => b.markIndex - a.markIndex)) {
          const rawSequence = parseYamlRecord(changed, metadata.path).value.readingMarks;
          if (!Array.isArray(rawSequence)) fail("unsupported_format", `Cannot safely edit readingMarks at ${metadata.path}`, { path: metadata.path });
          const idIndex = rawSequence.findIndex((row) => isRecord(row) && row.id === mark.id);
          if (idIndex < 0) fail("unsupported_format", `Reading mark source changed during compilation at ${metadata.path}`, { path: metadata.path });
          changed = removeYamlSequenceIndex(changed, metadata.path, "readingMarks", idIndex);
        }
        for (const added of additions) changed = appendYamlSequenceValue(changed, metadata.path, "readingMarks", normalizeNewMark(added));
        const allSpans = wanted;
        const spans = new Set<string>();
        for (const mark of allSpans) {
          const key = `${String((mark as ObjectValue).offset)}:${String((mark as ObjectValue).length)}`;
          if (spans.has(key)) fail("conflict", `Reading mark span already exists: ${key}`);
          spans.add(key);
        }
      }
      if (changed === metadata.text) fail("invalid_input", `Operation ${operationId} does not change Narrative-owned fields`);
      const baseMetadataRevision = yield* originalRevision(metadata.path);
      addRead(baseReads, metadata.path, baseMetadataRevision);
      addWrite(writes, metadata.path, baseMetadataRevision, changed, operationId, index);
      sourcePaths.get(operationId)!.add(metadata.path);
      const updated = parseYamlRecord(changed, metadata.path).value;
      metadata.text = changed; metadata.raw = updated;
      const row = metadata.row!; row.raw = updated; row.title = String(updated.title ?? updated.name ?? row.id);
      row.order = Number.isSafeInteger(updated.order) ? Number(updated.order) : undefined;
      if (metadata.kind === "scene") {
        row.manuscript_path = validateManuscriptPath(updated.manuscript);
        row.parent_id = String(updated.chapter);
      } else if (metadata.kind === "chapter") row.parent_id = String(updated.volume);
    } else if (operation.kind === "scene.insert") {
      const targetId = String(target.sceneId), chapterId = String(target.chapterId);
      const chapter = entityFor(work, chapterId, "chapter");
      const originalChapter = baseWork?.files.get(chapter.path) ?? chapter;
      sourcePrecondition(operation, originalChapter.raw, `Chapter ${chapterId}`);
      yield* originalRevision(chapter.path);
      const scene = entityFor(work, targetId, "scene");
      if (scene.row?.parent_id !== chapterId) fail("invalid_parent", `Scene ${targetId} does not belong to chapter ${chapterId}`);
      if (baseWork?.byId.has(targetId) && !input.operations.slice(0, index).some((prior) => prior.kind === "scene.create" && (prior.target as ObjectValue).sceneId === targetId)) {
        fail("invalid_input", `scene.insert ${operationId} must follow its matching scene.create`);
      }
      sceneInsertDiagnostics(work, chapter);
      const baseSiblingFiles = baseWork && !baseWork.byId.has(chapterId)
        ? []
        : parentRows(baseWork ?? work, "scene", chapterId).filter((file) => file.row?.id !== targetId);
      const actual = baseSiblingFiles
        .map((file) => ({ id: String(file.raw.id), revision: narrativeEntityRevision(file.raw) }))
        .sort((a, b) => a.id.localeCompare(b.id));
      const expected = (operation.expectedSiblings as ObjectValue[]).map((item) => ({ id: String(item.id), revision: String(item.revision) })).sort((a, b) => a.id.localeCompare(b.id));
      if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("snapshot_stale", `Scene insertion sibling revisions are stale for ${chapterId}`, { path: chapter.path });
      const siblings = parentRows(work, "scene", chapterId).filter((file) => file.row?.id !== targetId).map((file) => file.row!).sort(compareRows);
      for (const sibling of parentRows(work, "scene", chapterId)) yield* originalRevision(sibling.path);
      const position = Math.min(Number(operation.position) - 1, siblings.length);
      siblings.splice(position, 0, scene.row!);
      const createOperation = input.operations.slice(0, index).find((prior) => prior.kind === "scene.create" && (prior.target as ObjectValue).sceneId === targetId);
      if (createOperation) declaredDependencies.push([operationId, createOperation.id]);
      let orderChanged = false;
      for (const [orderIndex, row] of siblings.entries()) {
        const metadata = work.files.get(row.metadata_path)!;
        if (metadata.raw.order === orderIndex + 1) continue;
        const content = updateYamlFields(metadata.text, metadata.path, { order: orderIndex + 1 });
        const baseRevision = yield* originalRevision(metadata.path);
        addRead(baseReads, metadata.path, baseRevision);
        markOperationWrite(metadata.path, baseRevision, content);
        metadata.text = content; metadata.raw.order = orderIndex + 1; row.raw.order = orderIndex + 1; row.order = orderIndex + 1;
        orderChanged = true;
      }
      if (createOperation) sourcePaths.get(operationId)!.add(scene.path);
      else if (!orderChanged) fail("invalid_input", `Scene ${targetId} already has the requested position`);
    } else {
      const owner = operation.kind === "manuscript.replace-range" ? "proprium.paired-writing" : "proprium.knowledge";
      fail("dependency_unavailable", `Narrative does not own ${operation.kind}`, { source_operation_id: operationId, owner });
    }
  }

  if (!writes.size) fail("invalid_input", "NarrativeChangeSet has no Narrative file changes");
  const sourceIds = input.operations.filter((operation) => sourcePaths.get(operation.id)!.size > 0).map((operation) => operation.id);
  const adjacency = new Map(sourceIds.map((id) => [id, new Set<string>([id])]));
  for (const write of writes.values()) for (const id of write.source_ids) for (const other of write.source_ids) adjacency.get(id)!.add(other);
  for (const [left, right] of declaredDependencies) if (adjacency.has(left) && adjacency.has(right)) { adjacency.get(left)!.add(right); adjacency.get(right)!.add(left); }
  const components: string[][] = [];
  const visited = new Set<string>();
  for (const id of sourceIds) {
    if (visited.has(id)) continue;
    const stack = [id], component: string[] = [];
    while (stack.length) {
      const next = stack.pop()!; if (visited.has(next)) continue; visited.add(next); component.push(next);
      for (const neighbor of adjacency.get(next) ?? []) if (!visited.has(neighbor)) stack.push(neighbor);
    }
    component.sort((a, b) => sourceOrder.get(a)! - sourceOrder.get(b)!);
    components.push(component);
  }
  const units: ChangeUnit[] = [];
  const operationMap: Array<{ source_operation_id: string; unit_id: string; operation_ids: string[] }> = [];
  for (const component of components) {
    const unitId = `narrative-unit-${sha256Hex(component.join("\0")).slice(0, 32)}`;
    const rows = [...writes.values()].filter((write) => write.source_ids.some((id) => component.includes(id)))
      .sort((a, b) => a.first_source - b.first_source || a.path.localeCompare(b.path));
    const operations: FileOperation[] = rows.map((write) => fileOperation(
      `narrative-op-${sha256Hex(`${write.path}\0${write.source_ids.join("\0")}`).slice(0, 32)}`,
      write.path,
      write.expected_revision,
      write.content,
    ));
    const source_operation_ids = component;
    units.push({ id: unitId, label: source_operation_ids.map((id) => input.operations.find((item) => item.id === id)!.kind).join(" + "), depends_on: [], operations, source_operation_ids });
    for (const id of component) {
      const operation_ids = rows.filter((write) => write.source_ids.includes(id)).map((write) => `narrative-op-${sha256Hex(`${write.path}\0${write.source_ids.join("\0")}`).slice(0, 32)}`);
      operationMap.push({ source_operation_id: id, unit_id: unitId, operation_ids });
    }
  }
  operationMap.sort((a, b) => sourceOrder.get(a.source_operation_id)! - sourceOrder.get(b.source_operation_id)!);
  return {
    read_set: [...baseReads].map(([path, revision]) => ({ path, revision })).sort((a, b) => a.path.localeCompare(b.path)),
    units,
    operation_map: operationMap,
    diagnostics: outputSchemaDiagnostics(original),
  };
}
