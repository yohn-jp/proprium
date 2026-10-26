import type { ChangeSet, ChangeUnit, FileOperation, ReadPrecondition, SourceSpan } from "../../../app/src/browser/proprium/authoring/types.js";
import type { CompiledBatch } from "./compiler.js";
import type { NarrativeChangeSetV1 } from "./changeset.js";
import { PairedError } from "./types.js";
import { canonicalJson } from "./sha256.js";

interface UnitRef {
  readonly key: string;
  readonly batchIndex: number;
  readonly unit: ChangeUnit;
  readonly sourceIds: Set<string>;
}
interface WriteRef {
  readonly unitRef: UnitRef;
  readonly operation: FileOperation;
  readonly sourceIds: Set<string>;
  readonly operationIndex: number;
}

class UnionFind {
  readonly #parent: number[];
  constructor(size: number) { this.#parent = Array.from({ length: size }, (_, index) => index); }
  find(index: number): number {
    const parent = this.#parent[index]!;
    if (parent !== index) this.#parent[index] = this.find(parent);
    return this.#parent[index]!;
  }
  union(left: number, right: number): void {
    const a = this.find(left), b = this.find(right);
    if (a !== b) this.#parent[Math.max(a, b)] = Math.min(a, b);
  }
}

function sourceReferences(operation: Record<string, unknown>): Set<string> {
  const result = new Set<string>();
  const scan = (value: unknown): void => {
    if (typeof value === "string") result.add(value);
    else if (Array.isArray(value)) for (const item of value) scan(item);
    else if (value && typeof value === "object") for (const item of Object.values(value as Record<string, unknown>)) scan(item);
  };
  for (const key of ["target", "values", "changes", "event", "sourceProposal", "expectedSiblings"]) scan(operation[key]);
  return result;
}

function operationTargetId(operation: Record<string, unknown>): string | undefined {
  const target = operation.target as Record<string, unknown> | undefined;
  if (operation.kind === "entity.create") return typeof target?.entityId === "string" ? target.entityId : undefined;
  if (operation.kind === "scene.create") return typeof target?.sceneId === "string" ? target.sceneId : undefined;
  return undefined;
}

function fileReadKey(entry: ReadPrecondition): string {
  return `${entry.scope ? canonicalJson(entry.scope) : "local"}\0${entry.snapshot ? canonicalJson(entry.snapshot) : "base"}\0${entry.path}`;
}

function registerRead(reads: Map<string, ReadPrecondition>, entry: ReadPrecondition): void {
  const key = fileReadKey(entry);
  const previous = reads.get(key);
  if (previous && previous.revision !== entry.revision) {
    throw new PairedError("conflict", `Compilers disagree about original-base revision for ${entry.path}`, { path: entry.path });
  }
  reads.set(key, entry);
}

/** Merge staged owner compiler results into unique-path, dependency-closed Host units. */
export function assembleChangeSet(
  source: NarrativeChangeSetV1,
  batches: readonly CompiledBatch[],
  changeSetId: string,
  idempotencyKey: string,
  scope: ChangeSet["scope"],
  snapshot: ChangeSet["snapshot"],
  sourceEvidence: readonly SourceSpan[],
): { readonly changeset: ChangeSet; readonly operation_map: Array<{ source_operation_id: string; unit_id: string; operation_ids: string[] }>; readonly diagnostics: readonly unknown[] } {
  const order = new Map(source.operations.map((operation, index) => [String(operation.id), index]));
  const refs: UnitRef[] = [];
  const refsByKey = new Map<string, UnitRef>();
  const unitsByBatchId = new Map<string, UnitRef>();
  const sourceUnits = new Map<string, Set<number>>();
  const opSourceIdsByRef = new Map<string, Map<string, Set<string>>>();
  const reads = new Map<string, ReadPrecondition>();
  const diagnostics: unknown[] = [];

  for (const [batchIndex, batch] of batches.entries()) {
    for (const read of batch.result.read_set) registerRead(reads, read);
    diagnostics.push(...batch.result.diagnostics);
    for (const unit of batch.result.units) {
      const key = `${batchIndex}\0${unit.id}`;
      if (refsByKey.has(key)) throw new PairedError("invalid_input", `Duplicate compiler unit ${unit.id} in batch ${batchIndex}`);
      const ref: UnitRef = { key, batchIndex, unit, sourceIds: new Set(unit.source_operation_ids ?? []) };
      refs.push(ref); refsByKey.set(key, ref); unitsByBatchId.set(key, ref);
    }
    const operationSources = new Map<string, Set<string>>();
    for (const mapping of batch.result.operation_map) {
      const ref = refsByKey.get(`${batchIndex}\0${mapping.unit_id}`);
      if (!ref) throw new PairedError("invalid_input", `Compiler mapping references missing unit ${mapping.unit_id}`);
      if (!order.has(mapping.source_operation_id)) throw new PairedError("invalid_input", `Compiler mapping references unknown source operation ${mapping.source_operation_id}`);
      ref.sourceIds.add(mapping.source_operation_id);
      const ids = sourceUnits.get(mapping.source_operation_id) ?? new Set<number>();
      ids.add(refs.indexOf(ref)); sourceUnits.set(mapping.source_operation_id, ids);
      for (const operationId of mapping.operation_ids) {
        const sources = operationSources.get(operationId) ?? new Set<string>();
        sources.add(mapping.source_operation_id); operationSources.set(operationId, sources);
      }
    }
    for (const unit of batch.result.units) {
      for (const operation of unit.operations) {
        if (!operationSources.get(operation.id)?.size) {
          throw new PairedError("invalid_input", `Compiler operation ${operation.id} has no source operation mapping`);
        }
      }
    }
    opSourceIdsByRef.set(String(batchIndex), operationSources);
  }

  if (!refs.length) throw new PairedError("invalid_input", "All owner compilers returned an empty proposal");
  const union = new UnionFind(refs.length);
  const indexByKey = new Map(refs.map((ref, index) => [ref.key, index]));

  for (const indexes of sourceUnits.values()) {
    const values = [...indexes];
    for (let index = 1; index < values.length; index++) union.union(values[0]!, values[index]!);
  }
  const firstUnitByPath = new Map<string, number>();
  const writes: WriteRef[] = [];
  for (const ref of refs) {
    for (const dependency of ref.unit.depends_on) {
      const target = indexByKey.get(`${ref.batchIndex}\0${dependency}`);
      if (target === undefined) throw new PairedError("dependency_unavailable", `Unit ${ref.unit.id} depends on a unit outside its compiler batch`);
      union.union(indexByKey.get(ref.key)!, target);
    }
    const operationSources = opSourceIdsByRef.get(String(ref.batchIndex))!;
    for (const [operationIndex, operation] of ref.unit.operations.entries()) {
      const prior = firstUnitByPath.get(operation.path);
      if (prior !== undefined) union.union(indexByKey.get(ref.key)!, prior);
      else firstUnitByPath.set(operation.path, indexByKey.get(ref.key)!);
      writes.push({ unitRef: ref, operation, sourceIds: operationSources.get(operation.id)!, operationIndex });
    }
  }

  const created: Array<{ id: string; sourceId: string; index: number }> = [];
  for (const [index, operation] of (source.operations as readonly Record<string, unknown>[]).entries()) {
    const currentId = String(operation.id);
    for (const createdId of sourceReferences(operation)) {
      const creator = created.find((item) => item.id === createdId && item.index < index);
      if (!creator) continue;
      const sourceRefs = [...(sourceUnits.get(currentId) ?? [])];
      const creatorRefs = [...(sourceUnits.get(creator.sourceId) ?? [])];
      if (!sourceRefs.length || !creatorRefs.length) throw new PairedError("invalid_input", `Source dependency ${creator.sourceId} -> ${currentId} has no compiled unit`);
      for (const sourceRef of sourceRefs) for (const creatorRef of creatorRefs) union.union(sourceRef, creatorRef);
    }
    const createdId = operationTargetId(operation);
    if (createdId) created.push({ id: createdId, sourceId: currentId, index });
  }

  const roots = new Map<number, number[]>();
  for (let index = 0; index < refs.length; index++) {
    const root = union.find(index);
    const values = roots.get(root) ?? [];
    values.push(index); roots.set(root, values);
  }
  const components = [...roots.values()].map((indexes) => {
    const componentRefs = indexes.map((index) => refs[index]!);
    const sourceIds = new Set(componentRefs.flatMap((ref) => [...ref.sourceIds]));
    const firstSourceIndex = Math.min(...[...sourceIds].map((id) => order.get(id) ?? Number.MAX_SAFE_INTEGER));
    return { indexes, refs: componentRefs, sourceIds, firstSourceIndex };
  }).sort((left, right) => left.firstSourceIndex - right.firstSourceIndex);
  const componentForRef = new Map<number, number>();
  components.forEach((component, componentIndex) => component.indexes.forEach((refIndex) => componentForRef.set(refIndex, componentIndex)));

  const readByPath = new Map<string, ReadPrecondition>();
  for (const read of reads.values()) {
    if (read.scope || read.snapshot) continue;
    const previous = readByPath.get(read.path);
    if (previous && previous.revision !== read.revision) throw new PairedError("conflict", `Original-base read revisions disagree for ${read.path}`, { path: read.path });
    readByPath.set(read.path, read);
  }

  const writeRowsByPath = new Map<string, WriteRef[]>();
  for (const write of writes) {
    const existing = writeRowsByPath.get(write.operation.path) ?? [];
    existing.push(write); writeRowsByPath.set(write.operation.path, existing);
  }
  const finalOperationsByComponent = new Map<number, Array<{ operation: FileOperation; sourceIds: string[] }>>();
  const operationIdsBySource = new Map<string, Set<string>>();
  let operationSequence = 0;
  for (const [path, rows] of writeRowsByPath) {
    rows.sort((left, right) => {
      const leftIndex = Math.min(...[...left.sourceIds].map((id) => order.get(id) ?? Number.MAX_SAFE_INTEGER));
      const rightIndex = Math.min(...[...right.sourceIds].map((id) => order.get(id) ?? Number.MAX_SAFE_INTEGER));
      return leftIndex - rightIndex || left.unitRef.batchIndex - right.unitRef.batchIndex || left.operationIndex - right.operationIndex;
    });
    const base = readByPath.get(path);
    if (!base) throw new PairedError("invalid_input", `Compiler omitted original-base read precondition for written path ${path}`, { path });
    if (rows.some((row) => row.operation.expected_revision !== base.revision)) {
      throw new PairedError("conflict", `Compiler write for ${path} does not preserve the original-base revision`, { path });
    }
    const componentIndexes = new Set(rows.map((row) => componentForRef.get(indexByKey.get(row.unitRef.key)!)!));
    if (componentIndexes.size !== 1) throw new PairedError("invalid_input", `Repeated path ${path} was not closed into one unit`);
    const componentIndex = [...componentIndexes][0]!;
    const final = rows[rows.length - 1]!;
    if (base.revision === null && final.operation.kind === "delete") continue;
    const id = `${changeSetId}/op/${++operationSequence}`;
    const kind = final.operation.kind === "delete" ? "delete" : base.revision === null ? "create" : "replace";
    const outputBytes = final.operation.content;
    const outputArtifact = final.operation.content_artifact;
    if (kind !== "delete" && outputBytes === undefined && outputArtifact === undefined) {
      throw new PairedError("invalid_input", `Final staged path ${path} has no retained content reference`);
    }
    const operation: FileOperation = {
      id,
      kind,
      path,
      expected_revision: base.revision,
      ...(kind === "delete" ? {} : outputBytes !== undefined ? { content: outputBytes } : { content_artifact: outputArtifact! }),
    };
    const componentRows = finalOperationsByComponent.get(componentIndex) ?? [];
    componentRows.push({ operation, sourceIds: [...new Set(rows.flatMap((row) => [...row.sourceIds]))] });
    finalOperationsByComponent.set(componentIndex, componentRows);
    for (const sourceId of [...new Set(rows.flatMap((row) => [...row.sourceIds]))]) {
      const ids = operationIdsBySource.get(sourceId) ?? new Set<string>(); ids.add(id); operationIdsBySource.set(sourceId, ids);
    }
  }

  const unitIds = components.map((_, index) => `${changeSetId}/unit/${index + 1}`);
  const units: ChangeUnit[] = components.map((component, componentIndex) => {
    const componentWrites = finalOperationsByComponent.get(componentIndex) ?? [];
    if (!componentWrites.length) throw new PairedError("conflict", `Source operations ${[...component.sourceIds].join(", ")} cancel all file changes`);
    const dependencies = new Set<string>();
    for (const refIndex of component.indexes) {
      const ref = refs[refIndex]!;
      for (const dependency of ref.unit.depends_on) {
        const dependencyIndex = indexByKey.get(`${ref.batchIndex}\0${dependency}`)!;
        const targetComponent = componentForRef.get(dependencyIndex)!;
        if (targetComponent !== componentIndex) dependencies.add(unitIds[targetComponent]!);
      }
    }
    const orderedSourceIds = [...component.sourceIds].sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER));
    return {
      id: unitIds[componentIndex]!,
      label: `${orderedSourceIds.length} source operation${orderedSourceIds.length === 1 ? "" : "s"}`,
      depends_on: [...dependencies].sort(),
      source_operation_ids: orderedSourceIds,
      operations: componentWrites.map((row) => row.operation),
    };
  });
  const graph = new Map(units.map((unit) => [unit.id, unit.depends_on]));
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new PairedError("invalid_input", "Compiled ChangeSet dependencies contain a cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const id of graph.keys()) visit(id);

  const sourceOperationIds = source.operations.map((operation) => String(operation.id));
  const operation_map = sourceOperationIds.map((sourceId) => {
    const componentIndexes = [...(sourceUnits.get(sourceId) ?? [])].map((refIndex) => componentForRef.get(refIndex)!);
    const uniqueComponents = [...new Set(componentIndexes)];
    if (uniqueComponents.length !== 1) throw new PairedError("invalid_input", `Source operation ${sourceId} maps to independent units after dependency closure`);
    const operationIds = [...(operationIdsBySource.get(sourceId) ?? [])].sort();
    if (!operationIds.length) throw new PairedError("invalid_input", `Source operation ${sourceId} did not produce a final generic operation`);
    return { source_operation_id: sourceId, unit_id: unitIds[uniqueComponents[0]!]!, operation_ids: operationIds };
  });
  const changeSet: ChangeSet = {
    id: changeSetId,
    idempotency_key: idempotencyKey,
    scope,
    snapshot,
    title: source.goal,
    reason: source.goal,
    read_set: [...reads.values()],
    units,
    evidence: [...new Map(sourceEvidence.map((span) => [`${span.path}\0${span.revision}\0${span.start}\0${span.end}\0${span.quote}`, span])).values()],
  };
  return { changeset: changeSet, operation_map, diagnostics };
}
