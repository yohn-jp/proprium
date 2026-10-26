import type { NarrativeChangeSetV1 } from "./changeset.js";
import { PairedError } from "./types.js";

export type CompilerOwner = "narrative" | "knowledge" | "paired" | "resolve-entity-update";
export interface CompilerTask {
  readonly owner: CompilerOwner;
  readonly operations: readonly Record<string, unknown>[];
}

const NARRATIVE_SCENE_FIELDS = new Set(["id", "type", "title", "volume", "chapter", "order", "manuscript", "readingMarks"]);

function projectObject(value: unknown, accepted: ReadonlySet<string>): Record<string, unknown> {
  const source = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(source).filter(([key]) => accepted.has(key)));
}

function hasFields(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0;
}

function projections(source: Record<string, unknown>): Array<{ owner: CompilerOwner; operation: Record<string, unknown> }> {
  switch (source.kind) {
    case "manuscript.replace-range": return [{ owner: "paired", operation: source }];
    case "entity.create": {
      const target = source.target as Record<string, unknown>;
      const owner = target.entityType === "volume" || target.entityType === "chapter" ? "narrative" : "knowledge";
      return [{ owner, operation: source }];
    }
    case "entity.update": return [{ owner: "resolve-entity-update", operation: source }];
    case "scene.create": {
      const values = source.values as Record<string, unknown>;
      const structural = projectObject(values, NARRATIVE_SCENE_FIELDS);
      const semantic = Object.fromEntries(Object.entries(values).filter(([key]) => !NARRATIVE_SCENE_FIELDS.has(key)));
      const result = [];
      if (hasFields(structural)) result.push({ owner: "narrative" as const, operation: { ...source, values: structural } });
      if (hasFields(semantic)) result.push({ owner: "knowledge" as const, operation: { ...source, values: semantic } });
      if (!result.length) throw new PairedError("invalid_input", `scene.create ${String(source.id)} has no compilable fields`, { source_operation_id: source.id });
      return result;
    }
    case "scene.update": {
      const changes = source.changes as Record<string, unknown>;
      const structural = projectObject(changes, NARRATIVE_SCENE_FIELDS);
      const semantic = Object.fromEntries(Object.entries(changes).filter(([key]) => !NARRATIVE_SCENE_FIELDS.has(key)));
      const result = [];
      if (hasFields(structural)) result.push({ owner: "narrative" as const, operation: { ...source, changes: structural } });
      if (hasFields(semantic)) result.push({ owner: "knowledge" as const, operation: { ...source, changes: semantic } });
      if (!result.length) throw new PairedError("invalid_input", `scene.update ${String(source.id)} has no changes`, { source_operation_id: source.id });
      return result;
    }
    case "scene.insert": return [{ owner: "narrative", operation: source }];
    case "state.append-event": case "reference.link": return [{ owner: "knowledge", operation: source }];
    case "thread.link-scene": {
      if (source.relation === "advanced") throw new PairedError("unsupported_schema", `thread.link-scene advanced is unsupported by the pinned proposal builder (${String(source.id)})`, { source_operation_id: source.id });
      return [{ owner: "knowledge", operation: source }];
    }
    default: throw new PairedError("unsupported_schema", `No Paired compiler owns operation kind ${String(source.kind)}`, { source_operation_id: source.id });
  }
}

/**
 * Partition validated source operations without reordering them. A mixed scene operation
 * intentionally appears in both owner tasks with the same source ID; Host staging separates
 * the Narrative and Knowledge views before the latter compiles.
 */
export function planCompilers(changeSet: NarrativeChangeSetV1): CompilerTask[] {
  const tasks: CompilerTask[] = [];
  let pendingOwner: CompilerOwner | undefined;
  let pendingOperations: Record<string, unknown>[] = [];
  const flush = () => {
    if (pendingOwner && pendingOperations.length) tasks.push({ owner: pendingOwner, operations: pendingOperations });
    pendingOwner = undefined;
    pendingOperations = [];
  };
  for (const source of changeSet.operations as readonly Record<string, unknown>[]) {
    for (const projection of projections(source)) {
      if (projection.owner === "resolve-entity-update") {
        flush();
        tasks.push({ owner: projection.owner, operations: [projection.operation] });
        continue;
      }
      if (pendingOwner !== projection.owner) flush();
      pendingOwner = projection.owner;
      pendingOperations.push(projection.operation);
    }
  }
  flush();
  return tasks;
}
