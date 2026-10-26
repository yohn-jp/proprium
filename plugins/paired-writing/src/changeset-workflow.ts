import type { ActionRequest, ChangeSet, ChangeUnit, ReadPrecondition, SourceSpan } from "../../../app/src/browser/proprium/authoring/types.js";
import type { GuestHost, HostCall } from "../../shared/guest.js";
import { HOST_OPERATIONS } from "../../shared/operations.js";
import { PairedError } from "./types.js";
import { compileOwnerBatch, stageCompilerBatch, type CompiledBatch, type CompilerResult } from "./compiler.js";
import { planCompilers } from "./compiler-plan.js";
import { assembleChangeSet } from "./change-assembly.js";
import { compileManuscriptReplacement } from "./manuscript-compiler.js";
import { discardTemporaryArtifact } from "./artifact-content.js";
import type { NarrativeChangeSetV1 } from "./changeset.js";
import { validateNarrativeChangeSet } from "./changeset.js";
import { verifyLegacyProjectBinding } from "./host.js";
import { canonicalJson, sha256 } from "./sha256.js";
import { record } from "./validation.js";
import type { CompilerTask } from "./compiler-plan.js";

interface CompiledSource {
  readonly source: NarrativeChangeSetV1;
  readonly source_fingerprint: string;
  readonly change_set_id: string;
  readonly assembly: ReturnType<typeof assembleChangeSet>;
  readonly batches: readonly CompiledBatch[];
  readonly temporary_artifacts: readonly string[];
}

function sourceChangeSet(value: unknown): NarrativeChangeSetV1 {
  const row = record(value, "input");
  if (Object.keys(row).length !== 1 || !Object.hasOwn(row, "changeSet")) throw new PairedError("invalid_input", "Input must contain exactly one changeSet field");
  return validateNarrativeChangeSet(row.changeSet);
}

function makeChangeSetId(request: ActionRequest): string {
  if (!request.idempotency_key) {
    const checkKey = canonicalJson([request.scope.workspace_id, request.scope.generation, request.request_id]);
    return `paired-check-${sha256(new TextEncoder().encode(checkKey)).slice(0, 48)}`;
  }
  const source = canonicalJson([request.scope.workspace_id, request.scope.generation, "paired.changeset.propose", request.idempotency_key]);
  return `paired-cs-${sha256(new TextEncoder().encode(source)).slice(0, 48)}`;
}

function collectSceneMetadataPath(task: CompilerTask, result: CompilerResult, scenePaths: Map<string, string>): void {
  const operationsById = new Map(result.units.flatMap((unit) => unit.operations.map((operation) => [operation.id, operation] as const)));
  for (const sourceOperation of task.operations) {
    if (sourceOperation.kind !== "scene.create" && sourceOperation.kind !== "scene.update") continue;
    const target = sourceOperation.target as Record<string, unknown>;
    const sceneId = typeof target.sceneId === "string" ? target.sceneId : undefined;
    if (!sceneId) continue;
    const mappings = result.operation_map.filter((mapping) => mapping.source_operation_id === sourceOperation.id);
    const candidates = mappings.flatMap((mapping) => mapping.operation_ids)
      .map((operationId) => operationsById.get(operationId))
      .filter((operation) => operation && operation.path.startsWith("plot/volumes/") && operation.path.includes("/chapters/") &&
        operation.path.includes("/scenes/") && operation.path.endsWith(`/scenes/${sceneId}.yaml`));
    if (candidates.length > 1) throw new PairedError("ambiguous_identity", `Narrative compiler returned multiple metadata paths for scene ${sceneId}`);
    if (candidates[0]) scenePaths.set(sceneId, candidates[0].path);
  }
}

function compilerResultFromManual(
  sourceOperation: Record<string, unknown>,
  value: { readonly unit: ChangeUnit; readonly read_set: ReadPrecondition[]; readonly evidence: SourceSpan[] },
): CompilerResult {
  return {
    read_set: value.read_set,
    units: [value.unit],
    operation_map: [{
      source_operation_id: String(sourceOperation.id),
      unit_id: value.unit.id,
      operation_ids: value.unit.operations.map((operation) => operation.id),
    }],
    diagnostics: [],
  };
}

function* compileAllUnsafe(
  source: NarrativeChangeSetV1,
  host: GuestHost,
  request: ActionRequest,
  temporaryArtifacts: string[],
): Generator<HostCall, CompiledSource, unknown> {
  yield* verifyLegacyProjectBinding(host, request, String(source.projectId));
  const tasks = planCompilers(source);
  const sourceFingerprint = sha256(new TextEncoder().encode(canonicalJson(source)));
  const changeSetId = makeChangeSetId(request);
  const batches: CompiledBatch[] = [];
  const sceneMetadataPaths = new Map<string, string>();
  const originalReads: ReadPrecondition[] = [];
  let stagingSnapshot: string | undefined;
  const sourceIndexes = new Map(source.operations.map((operation, index) => [String(operation.id), index]));

  for (const task of tasks) {
    if (task.owner === "paired") {
      // A manual operation can depend on an earlier generated manuscript or metadata file,
      // so compile and stage each one in source order even when adjacent Paired operations batch.
      for (const operation of task.operations) {
        const sourceIndex = sourceIndexes.get(String(operation.id));
        if (sourceIndex === undefined) throw new PairedError("invalid_input", `Unknown source operation ${String(operation.id)}`);
        const result = yield* compileManuscriptReplacement(
          operation as never,
          source.evidence as never,
          sourceIndex,
          changeSetId,
          host,
          request,
          {
            ...(stagingSnapshot === undefined ? {} : { stagingSnapshot }),
            baseReadSet: originalReads,
            ...(sceneMetadataPaths.has(String((operation.target as Record<string, unknown>).sceneId))
              ? { metadataPath: sceneMetadataPaths.get(String((operation.target as Record<string, unknown>).sceneId))! }
              : {}),
          },
        );
        const compilerResult = compilerResultFromManual(operation, result);
        temporaryArtifacts.push(...result.temporary_artifacts);
        batches.push({ owner: "paired", source_operation_ids: [String(operation.id)], result: compilerResult, evidence: result.evidence, ...(stagingSnapshot ? { staging_snapshot: stagingSnapshot } : {}) });
        originalReads.push(...result.read_set);
        stagingSnapshot = yield* stageCompilerBatch(request.snapshot, stagingSnapshot, [result.unit], host);
      }
      continue;
    }
    const result = yield* compileOwnerBatch(task, source.evidence, stagingSnapshot, host, request);
    collectSceneMetadataPath(task, result, sceneMetadataPaths);
    batches.push({ owner: task.owner, source_operation_ids: task.operations.map((operation) => String(operation.id)), result, ...(stagingSnapshot ? { staging_snapshot: stagingSnapshot } : {}) });
    originalReads.push(...result.read_set);
    if (result.units.length) stagingSnapshot = yield* stageCompilerBatch(request.snapshot, stagingSnapshot, result.units, host);
  }

  const evidence = batches.flatMap((batch) => batch.evidence ?? []);
  const assembly = assembleChangeSet(source, batches, changeSetId, request.idempotency_key ?? "", request.scope, request.snapshot, evidence);
  return { source, source_fingerprint: sourceFingerprint, change_set_id: changeSetId, assembly, batches, temporary_artifacts: temporaryArtifacts };
}

function* compileAll(source: NarrativeChangeSetV1, host: GuestHost, request: ActionRequest): Generator<HostCall, CompiledSource, unknown> {
  const temporaryArtifacts: string[] = [];
  try {
    const result = yield* compileAllUnsafe(source, host, request, temporaryArtifacts);
    if (request.action_id === "paired.changeset.validate") {
      for (const artifactId of temporaryArtifacts) yield* discardTemporaryArtifact(host, artifactId);
      return { ...result, temporary_artifacts: [] };
    }
    return result;
  } catch (error) {
    for (const artifactId of temporaryArtifacts) {
      try { yield* discardTemporaryArtifact(host, artifactId); } catch { /* Host request cancellation also releases temporary artifacts. */ }
    }
    throw error;
  }
}

function getManualEvidence(value: unknown): SourceSpan[] {
  const result = value as CompiledSource;
  return result.batches.flatMap((batch) => batch.evidence ?? []);
}

export function* validateChangeSet(input: unknown, host: GuestHost, request: ActionRequest): Generator<HostCall, Record<string, unknown>, unknown> {
  const source = sourceChangeSet(input);
  const compiled = yield* compileAll(source, host, request);
  const assessment = source.assessment as { readonly risk: string; readonly confidence: number };
  const { changeset, operation_map, diagnostics } = compiled.assembly;
  return {
    valid: true,
    source_fingerprint: compiled.source_fingerprint,
    source_operation_count: source.operations.length,
    owner_map: compiled.batches.map((batch) => ({ owner: batch.owner, source_operation_ids: batch.source_operation_ids, staging_snapshot: batch.staging_snapshot ?? null })),
    operation_map,
    read_set: changeset.read_set,
    write_set: changeset.units.flatMap((unit) => unit.operations.map((operation) => ({ path: operation.path, expected_revision: operation.expected_revision, kind: operation.kind }))),
    dependency_closure: changeset.units.map((unit) => ({ unit_id: unit.id, source_operation_ids: unit.source_operation_ids ?? [], depends_on: unit.depends_on })),
    current_snapshot: request.snapshot,
    base_snapshot: request.snapshot,
    risk: assessment.risk,
    confidence: assessment.confidence,
    diagnostics,
  };
}

export function* proposeChangeSet(input: unknown, host: GuestHost, request: ActionRequest): Generator<HostCall, Record<string, unknown>, unknown> {
  if (!request.idempotency_key) throw new PairedError("invalid_input", "The Host must provide an idempotency key for a proposal");
  const source = sourceChangeSet(input);
  const compiled = yield* compileAll(source, host, request);
  const evidence = getManualEvidence(compiled);
  const changeset = {
    ...compiled.assembly.changeset,
    source_payload: source,
    source_payload_digest: compiled.source_fingerprint,
    domain_evidence: {
      assessment: source.assessment,
      diagnostics: source.diagnostics,
      evidence: source.evidence,
    },
  };
  let result: Record<string, unknown>;
  try { result = yield* host.request<Record<string, unknown>>(HOST_OPERATIONS.propose, { changeset }); }
  catch (error) {
    if ((error as { code?: string })?.code !== "storage_unknown") {
      for (const artifactId of compiled.temporary_artifacts) {
        try { yield* discardTemporaryArtifact(host, artifactId); } catch { /* Host broker releases leftovers at request end. */ }
      }
    }
    throw error;
  }
  if (!result || typeof result !== "object" || typeof result.proposal_id !== "string") {
    throw new PairedError("storage_unknown", "Host proposal result is ambiguous; inspect the idempotency key before retrying", { source_fingerprint: compiled.source_fingerprint }, true);
  }
  return {
    ...result,
    source_fingerprint: compiled.source_fingerprint,
    operation_map: compiled.assembly.operation_map,
    submission_snapshot: request.snapshot,
    source_evidence: evidence,
  };
}
