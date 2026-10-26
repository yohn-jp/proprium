import type { ActionRequest, ChangeUnit, ReadPrecondition, SourceSpan } from "../../../app/src/browser/proprium/authoring/types.js";
import type { GuestHost, HostCall } from "../../shared/guest.js";
import { HOST_OPERATIONS } from "../../shared/operations.js";
import { PairedError } from "./types.js";
import { invokeAction } from "./host.js";
import type { CompilerTask } from "./compiler-plan.js";
import type { NarrativeChangeSetV1 } from "./changeset.js";
import { exactKeys, filePath, identity, isRecord, record } from "./validation.js";

export interface CompilerDiagnostic {
  readonly code: string;
  readonly path?: string;
  readonly message: string;
  readonly severity: "warning" | "error";
}
export interface CompilerOperationMap {
  readonly source_operation_id: string;
  readonly unit_id: string;
  readonly operation_ids: readonly string[];
}
export interface CompilerResult {
  readonly read_set: readonly ReadPrecondition[];
  readonly units: readonly ChangeUnit[];
  readonly operation_map: readonly CompilerOperationMap[];
  readonly diagnostics: readonly CompilerDiagnostic[];
}
export interface CompiledBatch {
  readonly owner: CompilerTask["owner"];
  readonly source_operation_ids: readonly string[];
  readonly result: CompilerResult;
  readonly evidence?: readonly SourceSpan[];
  readonly staging_snapshot?: string;
}

function validateGenericOperation(value: unknown, label: string): ChangeUnit["operations"][number] {
  const row = record(value, label);
  exactKeys(row, ["id", "kind", "path", "expected_revision", "content", "content_artifact"], label);
  const id = identity(row.id, `${label}.id`, 512);
  if (!["create", "replace", "delete"].includes(String(row.kind))) throw new PairedError("unsupported_schema", `${label}.kind is unsupported`);
  const kind = row.kind as "create" | "replace" | "delete";
  const path = filePath(row.path, `${label}.path`);
  const expectedRevision = row.expected_revision;
  if (expectedRevision !== null && typeof expectedRevision !== "string") throw new PairedError("invalid_input", `${label}.expected_revision must be a file revision or null`);
  if (kind === "create" && expectedRevision !== null) throw new PairedError("conflict", `${label} create must preserve an absent base revision`);
  if (kind !== "create" && expectedRevision === null) throw new PairedError("conflict", `${label} ${kind} requires an existing original-base revision`);
  const hasBytes = row.content !== undefined;
  const hasArtifact = row.content_artifact !== undefined;
  if (kind === "delete") {
    if (hasBytes || hasArtifact) throw new PairedError("invalid_input", `${label} delete cannot contain output bytes`);
    return { id, kind, path, expected_revision: expectedRevision as string };
  }
  if (hasBytes === hasArtifact) throw new PairedError("invalid_input", `${label} must contain exactly one of content or content_artifact`);
  if (hasArtifact) return { id, kind, path, expected_revision: expectedRevision as string | null, content_artifact: identity(row.content_artifact, `${label}.content_artifact`, 512) };
  if (!Array.isArray(row.content) || row.content.length > 32 * 1024 * 1024 || row.content.some((byte) => !Number.isInteger(byte) || Number(byte) < 0 || Number(byte) > 255)) {
    throw new PairedError("capacity", `${label}.content is not a bounded byte array`);
  }
  return { id, kind, path, expected_revision: expectedRevision as string | null, content: row.content as number[] };
}

function validateResult(value: unknown, allowedOperationIds: ReadonlySet<string>): CompilerResult {
  const row = record(value, "compiler result");
  exactKeys(row, ["read_set", "units", "operation_map", "diagnostics"], "compiler result");
  if (!Array.isArray(row.read_set) || row.read_set.length > 2048 || !Array.isArray(row.units) || row.units.length > 256 ||
      !Array.isArray(row.operation_map) || row.operation_map.length > 128 || !Array.isArray(row.diagnostics) || row.diagnostics.length > 1024) {
    throw new PairedError("capacity", "Owner compiler response exceeds the bounded result limits");
  }
  const reads: ReadPrecondition[] = row.read_set.map((entry, index) => {
    const read = record(entry, `read_set[${index}]`);
    exactKeys(read, ["path", "revision", "scope", "snapshot"], `read_set[${index}]`);
    if (read.revision !== null && typeof read.revision !== "string") throw new PairedError("invalid_input", `read_set[${index}].revision must be a revision or null`);
    if ((read.scope === undefined) !== (read.snapshot === undefined)) throw new PairedError("invalid_input", `read_set[${index}] foreign reads require both scope and snapshot`);
    return {
      path: filePath(read.path, `read_set[${index}].path`),
      revision: read.revision as string | null,
      ...(read.scope === undefined ? {} : { scope: read.scope as ActionRequest["scope"], snapshot: read.snapshot as ActionRequest["snapshot"] }),
    };
  });
  const units: ChangeUnit[] = row.units.map((entry, index) => {
    const unit = record(entry, `units[${index}]`);
    exactKeys(unit, ["id", "label", "depends_on", "operations", "source_operation_ids"], `units[${index}]`);
    if (!Array.isArray(unit.depends_on) || unit.depends_on.length > 256 || !Array.isArray(unit.operations) || unit.operations.length < 1 || unit.operations.length > 1024) {
      throw new PairedError("invalid_input", `units[${index}] has an invalid operation or dependency list`);
    }
    if (unit.source_operation_ids !== undefined && !Array.isArray(unit.source_operation_ids)) throw new PairedError("invalid_input", `units[${index}].source_operation_ids must be an array`);
    const paths = new Set<string>();
    const operations = unit.operations.map((operation, operationIndex) => {
      const parsed = validateGenericOperation(operation, `units[${index}].operations[${operationIndex}]`);
      if (paths.has(parsed.path)) throw new PairedError("conflict", `Owner compiler emitted repeated path ${parsed.path} in one unit`);
      paths.add(parsed.path);
      return parsed;
    });
    return {
      id: identity(unit.id, `units[${index}].id`, 512),
      label: identity(unit.label, `units[${index}].label`, 512),
      depends_on: unit.depends_on.map((id, dependencyIndex) => identity(id, `units[${index}].depends_on[${dependencyIndex}]`, 512)),
      operations,
      ...(unit.source_operation_ids === undefined ? {} : { source_operation_ids: unit.source_operation_ids.map((id, sourceIndex) => identity(id, `units[${index}].source_operation_ids[${sourceIndex}]`)) }),
    };
  });
  const unitIds = new Set<string>();
  const operationsById = new Set<string>();
  for (const unit of units) {
    if (unitIds.has(unit.id)) throw new PairedError("invalid_input", `Compiler response contains duplicate unit ID ${unit.id}`);
    unitIds.add(unit.id);
    for (const operation of unit.operations) {
      if (operationsById.has(operation.id)) throw new PairedError("invalid_input", `Compiler response contains duplicate generic operation ID ${operation.id}`);
      operationsById.add(operation.id);
    }
  }
  const operationMap: CompilerOperationMap[] = row.operation_map.map((entry, index) => {
    const mapped = record(entry, `operation_map[${index}]`);
    exactKeys(mapped, ["source_operation_id", "unit_id", "operation_ids"], `operation_map[${index}]`);
    const sourceId = identity(mapped.source_operation_id, `operation_map[${index}].source_operation_id`);
    if (!allowedOperationIds.has(sourceId)) throw new PairedError("invalid_input", `Compiler mapped unknown source operation ${sourceId}`);
    if (!unitIds.has(String(mapped.unit_id))) throw new PairedError("invalid_input", `Compiler mapped ${sourceId} to missing unit ${String(mapped.unit_id)}`);
    if (!Array.isArray(mapped.operation_ids) || mapped.operation_ids.length < 1) throw new PairedError("invalid_input", `Compiler map for ${sourceId} has no generic operations`);
    if (new Set(mapped.operation_ids).size !== mapped.operation_ids.length) throw new PairedError("invalid_input", `Compiler map for ${sourceId} repeats a generic operation ID`);
    return {
      source_operation_id: sourceId,
      unit_id: identity(mapped.unit_id, `operation_map[${index}].unit_id`, 512),
      operation_ids: mapped.operation_ids.map((id, operationIndex) => identity(id, `operation_map[${index}].operation_ids[${operationIndex}]`, 512)),
    };
  });
  const mappedSourceIds = new Set<string>();
  const mappedOperationIds = new Set<string>();
  for (const mapping of operationMap) {
    if (mappedSourceIds.has(mapping.source_operation_id)) throw new PairedError("invalid_input", `Compiler response repeats source operation ${mapping.source_operation_id}`);
    mappedSourceIds.add(mapping.source_operation_id);
    if (mapping.operation_ids.some((id) => !operationsById.has(id))) throw new PairedError("invalid_input", `Compiler map for ${mapping.source_operation_id} refers to a missing generic operation`);
    const unit = units.find((item) => item.id === mapping.unit_id)!;
    if (unit.source_operation_ids && !unit.source_operation_ids.includes(mapping.source_operation_id)) {
      throw new PairedError("invalid_input", `Compiler map for ${mapping.source_operation_id} disagrees with unit ${unit.id} source IDs`);
    }
    if (mapping.operation_ids.some((id) => !unit.operations.some((operation) => operation.id === id))) {
      throw new PairedError("invalid_input", `Compiler map for ${mapping.source_operation_id} crosses unit boundaries`);
    }
    for (const id of mapping.operation_ids) mappedOperationIds.add(id);
  }
  for (const sourceId of allowedOperationIds) {
    if (!mappedSourceIds.has(sourceId)) throw new PairedError("invalid_input", `Compiler omitted source operation ${sourceId} from operation_map`);
  }
  for (const unit of units) {
    if (unit.source_operation_ids?.some((id) => !allowedOperationIds.has(id))) {
      throw new PairedError("invalid_input", `Compiler unit ${unit.id} names a source operation outside its batch`);
    }
    if (unit.source_operation_ids?.some((id) => !operationMap.some((mapping) => mapping.source_operation_id === id && mapping.unit_id === unit.id))) {
      throw new PairedError("invalid_input", `Compiler unit ${unit.id} has an unmapped source operation`);
    }
  }
  for (const operationId of operationsById) {
    if (!mappedOperationIds.has(operationId)) throw new PairedError("invalid_input", `Compiler omitted generic operation ${operationId} from operation_map`);
  }
  const diagnostics: CompilerDiagnostic[] = row.diagnostics.map((entry, index) => {
    const diagnostic = record(entry, `diagnostics[${index}]`);
    exactKeys(diagnostic, ["code", "path", "message", "severity"], `diagnostics[${index}]`);
    if (diagnostic.severity !== "warning" && diagnostic.severity !== "error") throw new PairedError("invalid_input", `diagnostics[${index}].severity is invalid`);
    return {
      code: identity(diagnostic.code, `diagnostics[${index}].code`),
      ...(diagnostic.path === undefined ? {} : { path: filePath(diagnostic.path, `diagnostics[${index}].path`) }),
      message: identity(diagnostic.message, `diagnostics[${index}].message`, 4000),
      severity: diagnostic.severity,
    };
  });
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    const diagnostic = diagnostics.find((item) => item.severity === "error")!;
    throw new PairedError(diagnostic.code, diagnostic.message, { ...(diagnostic.path ? { path: diagnostic.path } : {}) });
  }
  for (const unit of units) {
    for (const dependency of unit.depends_on) if (!unitIds.has(dependency)) throw new PairedError("invalid_input", `Compiler unit ${unit.id} depends on unknown unit ${dependency}`);
  }
  return { read_set: reads, units, operation_map: operationMap, diagnostics };
}

function compilerRoute(owner: CompilerTask["owner"]): { pluginId: string; actionId: string } {
  if (owner === "narrative") return { pluginId: "proprium.narrative", actionId: "proprium.narrative.changes.compile" };
  if (owner === "knowledge") return { pluginId: "proprium.knowledge", actionId: "proprium.knowledge.changes.compile" };
  throw new PairedError("invalid_input", `No owner compiler route for ${owner}`);
}

function* callOwnerCompiler(
  owner: "narrative" | "knowledge",
  sourceOperations: readonly Record<string, unknown>[],
  sourceEvidence: NarrativeChangeSetV1["evidence"],
  stagingSnapshot: string | undefined,
  host: GuestHost,
  request: ActionRequest,
): Generator<HostCall, CompilerResult, unknown> {
  const route = compilerRoute(owner);
  const input = {
    operations: sourceOperations,
    evidence: sourceEvidence,
    ...(stagingSnapshot === undefined ? {} : { staging_snapshot: stagingSnapshot }),
  };
  const raw = yield* invokeAction<unknown>(host, request, route.pluginId, route.actionId, input);
  return validateResult(raw, new Set(sourceOperations.map((operation) => String(operation.id))));
}

export function* compileOwnerBatch(
  task: CompilerTask,
  sourceEvidence: NarrativeChangeSetV1["evidence"],
  stagingSnapshot: string | undefined,
  host: GuestHost,
  request: ActionRequest,
): Generator<HostCall, CompilerResult, unknown> {
  if (task.owner === "resolve-entity-update") {
    try { return yield* callOwnerCompiler("knowledge", task.operations, sourceEvidence, stagingSnapshot, host, request); }
    catch (error) {
      if ((error as { code?: string })?.code !== "unsupported_schema") throw error;
      return yield* callOwnerCompiler("narrative", task.operations, sourceEvidence, stagingSnapshot, host, request);
    }
  }
  if (task.owner === "paired") throw new PairedError("invalid_input", "The Paired manuscript compiler must be called by the ChangeSet workflow");
  return yield* callOwnerCompiler(task.owner, task.operations, sourceEvidence, stagingSnapshot, host, request);
}

/** Request an ephemeral overlay lease; it carries no save, apply, or approval authority. */
export function* stageCompilerBatch(
  baseSnapshot: ActionRequest["snapshot"],
  previousStage: string | undefined,
  units: readonly ChangeUnit[],
  host: GuestHost,
): Generator<HostCall, string, unknown> {
  if (!units.length) throw new PairedError("invalid_input", "Cannot stage an empty compiler result");
  const result = yield* host.request<{ readonly staging_snapshot: string }>(HOST_OPERATIONS.stage, {
    base_snapshot: baseSnapshot,
    ...(previousStage === undefined ? {} : { previous_stage: previousStage }),
    units,
  });
  if (!result || typeof result.staging_snapshot !== "string" || !result.staging_snapshot) throw new PairedError("invalid_input", "Host returned an invalid staging lease");
  return result.staging_snapshot;
}

export function sourceOperationOrder(changeSet: NarrativeChangeSetV1): Map<string, number> {
  return new Map(changeSet.operations.map((operation, index) => [String(operation.id), index]));
}

export function asSourceRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new PairedError("invalid_input", `${label} must be a plain JSON record`);
  return value;
}
