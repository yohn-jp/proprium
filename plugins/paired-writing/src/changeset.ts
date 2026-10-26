import { PairedError } from "./types.js";
import { assertBoundedJson, exactKeys, finiteInteger, identity, isRecord, record } from "./validation.js";

export type NarrativeOperation = Record<string, unknown> & {
  readonly id: string;
  readonly kind: string;
  readonly evidenceIds: readonly string[];
  readonly target: Record<string, unknown>;
};

export interface NarrativeChangeSetV1 extends Record<string, unknown> {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly projectId: string;
  readonly goal: string;
  readonly status: "proposed";
  readonly operations: readonly NarrativeOperation[];
  readonly evidence: readonly Record<string, unknown>[];
}

const OPERATION_KINDS = new Set([
  "manuscript.replace-range", "entity.create", "entity.update", "scene.create", "scene.insert",
  "scene.update", "state.append-event", "thread.link-scene", "reference.link",
]);

function fail(message: string, code = "invalid_input"): never {
  throw new PairedError(code, message);
}

function assessment(value: unknown, label: string): void {
  const row = record(value, label);
  exactKeys(row, ["confidence", "risk"], label);
  if (typeof row.confidence !== "number" || !Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 1 ||
      !["low", "medium", "high"].includes(String(row.risk))) fail(`${label} is invalid`);
}

function precondition(value: unknown, label: string, allowsAbsent: boolean): void {
  const row = record(value, label);
  if (row.kind === "absent" && allowsAbsent) {
    exactKeys(row, ["kind"], label);
    return;
  }
  if (row.kind !== "revision" && row.kind !== "content-hash") fail(`${label}.kind is invalid`);
  exactKeys(row, ["kind", "value"], label);
  identity(row.value, `${label}.value`);
}

function sourceRange(value: unknown, label: string): void {
  const row = record(value, label);
  exactKeys(row, ["start", "end"], label);
  const start = finiteInteger(row.start, `${label}.start`);
  finiteInteger(row.end, `${label}.end`, start);
}

function validateEvidence(value: unknown, index: number): Record<string, unknown> {
  const label = `evidence[${index}]`;
  const row = record(value, label);
  exactKeys(row, ["id", "sourceKind", "sourceId", "revision", "range"], label);
  identity(row.id, `${label}.id`);
  identity(row.sourceId, `${label}.sourceId`);
  identity(row.revision, `${label}.revision`);
  if (!["manuscript", "entity", "scene", "diagnostic", "state-proposal", "external"].includes(String(row.sourceKind))) {
    fail(`${label}.sourceKind is invalid`);
  }
  if (row.range !== undefined) sourceRange(row.range, `${label}.range`);
  return row;
}

function event(value: unknown, label: string): void {
  const row = record(value, label);
  exactKeys(row, ["sceneId", "order", "kind", "subject", "object", "payload", "source", "eventId", "propositionId", "evidence", "confidence", "createdAt", "status", "replacesEventId"], label);
  identity(row.sceneId, `${label}.sceneId`);
  identity(row.subject, `${label}.subject`);
  identity(row.eventId, `${label}.eventId`);
  if (!Number.isSafeInteger(row.order)) fail(`${label}.order is invalid`);
  if (!["location", "acquaintance", "ownership", "knowledge"].includes(String(row.kind))) fail(`${label}.kind is invalid`);
  if (row.object !== null && typeof row.object !== "string") fail(`${label}.object is invalid`);
  if (!isRecord(row.payload) || !["rule", "llm-draft", "manual"].includes(String(row.source)) || row.status !== "confirmed") fail(`${label} is invalid`);
  for (const key of ["propositionId", "replacesEventId"] as const) if (row[key] !== undefined) identity(row[key], `${label}.${key}`);
  if (row.confidence !== undefined && (typeof row.confidence !== "number" || !Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 1)) fail(`${label}.confidence is invalid`);
  if (row.createdAt !== undefined && (typeof row.createdAt !== "string" || Number.isNaN(Date.parse(row.createdAt)))) fail(`${label}.createdAt is invalid`);
  if (row.evidence !== undefined) {
    if (!Array.isArray(row.evidence) || row.evidence.length > 64) fail(`${label}.evidence is invalid`);
    for (const [index, item] of row.evidence.entries()) {
      const source = record(item, `${label}.evidence[${index}]`);
      exactKeys(source, ["sceneId", "excerpt", "startOffset", "endOffset"], `${label}.evidence[${index}]`);
      identity(source.sceneId, `${label}.evidence[${index}].sceneId`);
      if (source.excerpt !== undefined && (typeof source.excerpt !== "string" || source.excerpt.length > 10_000)) fail(`${label}.evidence[${index}].excerpt is invalid`);
      for (const name of ["startOffset", "endOffset"] as const) if (source[name] !== undefined) finiteInteger(source[name], `${label}.evidence[${index}].${name}`);
      if (source.startOffset !== undefined && source.endOffset !== undefined && Number(source.endOffset) < Number(source.startOffset)) fail(`${label}.evidence[${index}] has a reversed range`);
    }
  }
  assertBoundedJson(row.payload, `${label}.payload`);
}

function validateOperation(value: unknown, index: number): NarrativeOperation {
  const label = `operations[${index}]`;
  const row = record(value, label);
  const kind = identity(row.kind, `${label}.kind`);
  if (!OPERATION_KINDS.has(kind)) fail(`${label}.kind is unsupported`, "unsupported_schema");
  identity(row.id, `${label}.id`);
  if (!Array.isArray(row.evidenceIds) || row.evidenceIds.length > 64) fail(`${label}.evidenceIds is invalid`);
  for (const id of row.evidenceIds) identity(id, `${label}.evidenceIds[]`);
  assessment(row.assessment, `${label}.assessment`);
  if (kind === "manuscript.replace-range") {
    exactKeys(row, ["id", "evidenceIds", "assessment", "kind", "precondition", "target", "range", "replacement"], label);
    precondition(row.precondition, `${label}.precondition`, false);
    const target = record(row.target, `${label}.target`);
    exactKeys(target, ["manuscriptId", "sceneId"], `${label}.target`);
    identity(target.manuscriptId, `${label}.target.manuscriptId`);
    identity(target.sceneId, `${label}.target.sceneId`);
    sourceRange(row.range, `${label}.range`);
    if (typeof row.replacement !== "string" || row.replacement.length > 100_000) fail(`${label}.replacement is invalid`);
  } else if (kind === "entity.create") {
    exactKeys(row, ["id", "evidenceIds", "assessment", "kind", "precondition", "target", "values"], label);
    precondition(row.precondition, `${label}.precondition`, true);
    const target = record(row.target, `${label}.target`);
    exactKeys(target, ["entityId", "entityType"], `${label}.target`);
    identity(target.entityId, `${label}.target.entityId`);
    identity(target.entityType, `${label}.target.entityType`);
    if (!isRecord(row.values)) fail(`${label}.values must be an object`);
    assertBoundedJson(row.values, `${label}.values`);
  } else if (kind === "entity.update" || kind === "scene.update") {
    exactKeys(row, ["id", "evidenceIds", "assessment", "kind", "precondition", "target", "changes"], label);
    precondition(row.precondition, `${label}.precondition`, false);
    const target = record(row.target, `${label}.target`);
    const idKey = kind === "entity.update" ? "entityId" : "sceneId";
    exactKeys(target, [idKey], `${label}.target`);
    identity(target[idKey], `${label}.target.${idKey}`);
    if (!isRecord(row.changes) || Object.hasOwn(row.changes, "id") || Object.hasOwn(row.changes, "type")) fail(`${label}.changes is invalid`);
    assertBoundedJson(row.changes, `${label}.changes`);
  } else if (kind === "scene.create") {
    exactKeys(row, ["id", "evidenceIds", "assessment", "kind", "precondition", "target", "collectionRevision", "values"], label);
    precondition(row.precondition, `${label}.precondition`, true);
    const target = record(row.target, `${label}.target`);
    exactKeys(target, ["sceneId"], `${label}.target`);
    identity(target.sceneId, `${label}.target.sceneId`);
    if (row.collectionRevision !== undefined) identity(row.collectionRevision, `${label}.collectionRevision`);
    if (!isRecord(row.values)) fail(`${label}.values must be an object`);
    assertBoundedJson(row.values, `${label}.values`);
    if (row.values.id !== undefined && row.values.id !== target.sceneId) fail(`${label}.values.id does not match target.sceneId`);
    if (row.values.type !== undefined && row.values.type !== "scene") fail(`${label}.values.type does not match scene.create`);
  } else if (kind === "scene.insert") {
    exactKeys(row, ["id", "evidenceIds", "assessment", "kind", "precondition", "target", "position", "expectedSiblings"], label);
    precondition(row.precondition, `${label}.precondition`, false);
    const target = record(row.target, `${label}.target`);
    exactKeys(target, ["sceneId", "chapterId"], `${label}.target`);
    identity(target.sceneId, `${label}.target.sceneId`);
    identity(target.chapterId, `${label}.target.chapterId`);
    finiteInteger(row.position, `${label}.position`, 1);
    if (!Array.isArray(row.expectedSiblings) || row.expectedSiblings.length > 1_000) fail(`${label}.expectedSiblings is invalid`);
    const ids = new Set<string>();
    for (const [siblingIndex, siblingValue] of row.expectedSiblings.entries()) {
      const sibling = record(siblingValue, `${label}.expectedSiblings[${siblingIndex}]`);
      exactKeys(sibling, ["id", "revision"], `${label}.expectedSiblings[${siblingIndex}]`);
      const id = identity(sibling.id, `${label}.expectedSiblings[${siblingIndex}].id`);
      identity(sibling.revision, `${label}.expectedSiblings[${siblingIndex}].revision`);
      if (ids.has(id)) fail(`${label}.expectedSiblings has duplicate IDs`);
      ids.add(id);
    }
    if (ids.has(String(target.sceneId))) fail(`${label}.expectedSiblings contains the inserted scene`);
  } else if (kind === "state.append-event") {
    exactKeys(row, ["id", "evidenceIds", "assessment", "kind", "precondition", "target", "event", "sourceProposal"], label);
    precondition(row.precondition, `${label}.precondition`, false);
    const target = record(row.target, `${label}.target`);
    exactKeys(target, ["sceneId", "eventId"], `${label}.target`);
    identity(target.sceneId, `${label}.target.sceneId`);
    identity(target.eventId, `${label}.target.eventId`);
    event(row.event, `${label}.event`);
    const eventValue = row.event as Record<string, unknown>;
    if (eventValue.sceneId !== target.sceneId || eventValue.eventId !== target.eventId) fail(`${label} event target does not match`);
    if (row.sourceProposal !== undefined) {
      const proposal = record(row.sourceProposal, `${label}.sourceProposal`);
      exactKeys(proposal, ["id", "manuscriptHash"], `${label}.sourceProposal`);
      identity(proposal.id, `${label}.sourceProposal.id`);
      identity(proposal.manuscriptHash, `${label}.sourceProposal.manuscriptHash`);
    }
  } else if (kind === "thread.link-scene") {
    exactKeys(row, ["id", "evidenceIds", "assessment", "kind", "precondition", "target", "relation", "note"], label);
    precondition(row.precondition, `${label}.precondition`, false);
    const target = record(row.target, `${label}.target`);
    exactKeys(target, ["threadId", "sceneId"], `${label}.target`);
    identity(target.threadId, `${label}.target.threadId`);
    identity(target.sceneId, `${label}.target.sceneId`);
    if (!["planted", "advanced", "payoff"].includes(String(row.relation))) fail(`${label}.relation is invalid`);
    if (row.note !== undefined && (typeof row.note !== "string" || row.note.length > 10_000)) fail(`${label}.note is invalid`);
  } else {
    exactKeys(row, ["id", "evidenceIds", "assessment", "kind", "precondition", "target", "note"], label);
    precondition(row.precondition, `${label}.precondition`, false);
    const target = record(row.target, `${label}.target`);
    exactKeys(target, ["from", "to", "kind"], `${label}.target`);
    identity(target.from, `${label}.target.from`);
    identity(target.to, `${label}.target.to`);
    identity(target.kind, `${label}.target.kind`);
    if (row.note !== undefined && (typeof row.note !== "string" || row.note.length > 10_000)) fail(`${label}.note is invalid`);
  }
  return row as NarrativeOperation;
}

function operationTarget(operation: NarrativeOperation): string {
  const target = operation.target;
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

/** Strict source-format validation ported from the pinned Scriptorium v1 validator. */
export function validateNarrativeChangeSet(value: unknown): NarrativeChangeSetV1 {
  const row = record(value, "NarrativeChangeSet");
  exactKeys(row, ["schemaVersion", "id", "projectId", "goal", "status", "assessment", "operations", "evidence", "diagnostics"], "NarrativeChangeSet");
  if (row.schemaVersion !== 1) fail("Unsupported NarrativeChangeSet version", "unsupported_schema");
  identity(row.id, "id");
  identity(row.projectId, "projectId");
  if (typeof row.goal !== "string" || row.goal.length < 1 || row.goal.length > 10_000) fail("NarrativeChangeSet goal is invalid");
  if (row.status !== "proposed") fail("Only a proposed NarrativeChangeSet can be submitted");
  assessment(row.assessment, "assessment");
  if (!Array.isArray(row.operations) || row.operations.length < 1 || row.operations.length > 64) fail("NarrativeChangeSet operations must contain 1 to 64 operations");
  if (!Array.isArray(row.evidence) || row.evidence.length > 256) fail("NarrativeChangeSet evidence must contain at most 256 items");
  const evidence = row.evidence.map(validateEvidence);
  const evidenceById = new Set<string>();
  for (const item of evidence) {
    const id = String(item.id);
    if (evidenceById.has(id)) fail(`NarrativeChangeSet has duplicate evidence ID: ${id}`);
    evidenceById.add(id);
  }
  const operations = row.operations.map(validateOperation);
  const operationIds = new Set<string>();
  const targets = new Set<string>();
  for (const [index, operation] of operations.entries()) {
    if (operationIds.has(operation.id)) fail(`Duplicate operation ID at operations[${index}]`);
    operationIds.add(operation.id);
    const target = operationTarget(operation);
    if (targets.has(target)) fail(`Conflicting operation target at operations[${index}]`);
    targets.add(target);
    for (const id of operation.evidenceIds) if (!evidenceById.has(id)) fail(`Operation ${operation.id} refers to missing evidence ${id}`);
    if (operation.kind === "entity.create") {
      const targetValue = operation.target;
      const values = operation.values as Record<string, unknown>;
      if (values.id !== undefined && values.id !== targetValue.entityId) fail(`Operation ${operation.id} has a mismatched values.id`);
      if (values.type !== undefined && values.type !== targetValue.entityType) fail(`Operation ${operation.id} has a mismatched values.type`);
    }
    if (operation.kind === "scene.insert") {
      const targetValue = operation.target;
      const createdBefore = operations.slice(0, index).some((previous) => previous.kind === "scene.create" &&
        previous.target.sceneId === targetValue.sceneId && (previous.values as Record<string, unknown>).chapter === targetValue.chapterId);
      if (!createdBefore) fail(`scene.insert ${operation.id} must follow its matching scene.create`);
    }
  }
  const diagnostics = record(row.diagnostics, "diagnostics");
  exactKeys(diagnostics, ["before", "after"], "diagnostics");
  for (const key of ["before", "after"] as const) {
    if (diagnostics[key] === null) continue;
    const value = record(diagnostics[key], `diagnostics.${key}`);
    exactKeys(value, ["id", "revision"], `diagnostics.${key}`);
    identity(value.id, `diagnostics.${key}.id`);
    identity(value.revision, `diagnostics.${key}.revision`);
  }
  assertBoundedJson(row, "NarrativeChangeSet");
  return row as unknown as NarrativeChangeSetV1;
}
