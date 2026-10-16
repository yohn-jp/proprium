import { randomUUID } from "node:crypto";
import type {
  ChangeOperation,
  FileChange,
  FileRevision,
  ModuleActionContext,
  SnapshotReader,
  ValueSchema,
} from "@scriptorium/contracts";

export type ObjectValue = Record<string, unknown>;

export function isRecord(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseRecord(value: unknown, label = "input"): ObjectValue {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

export function recordSchema<T extends ObjectValue = ObjectValue>(
  parse: (value: ObjectValue) => T = ((value) => value as T),
): ValueSchema<T> {
  return { parse(value) { return parse(parseRecord(value)); } };
}

export function stringField(value: unknown, label: string, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || (required && !value.trim())) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

export function readFieldRevisions(
  paths: Iterable<string>,
  known: ReadonlyMap<string, string>,
): FileRevision[] {
  const result = new Map<string, string | null>();
  for (const path of paths) result.set(path, known.get(path) ?? null);
  return [...result].map(([path, revision]) => ({ path, revision }));
}

export interface ProposedWrite { path: string; revision: string | null; content: string | null }

export function buildOperation(input: {
  reader: SnapshotReader;
  reads: FileRevision[];
  writes: ProposedWrite[];
  message: string;
  effect: ChangeOperation["effect"];
  operationId?: string;
}): ChangeOperation {
  const requestedId = input.operationId?.trim();
  const id = requestedId ? (requestedId.startsWith("story-") ? requestedId : `story-${requestedId}`) : `story-${randomUUID()}`;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new TypeError("operationId must contain only letters, numbers, hyphens, and underscores");
  return {
    id,
    generation: 0,
    repository: input.reader.snapshot.repository,
    baseRemoteCommit: input.reader.snapshot.remoteCommit,
    effect: input.effect,
    reads: input.reads,
    writes: input.writes.map((write): FileChange => ({
      path: write.path,
      revision: write.revision,
      content: write.content,
    })),
    message: input.message,
  };
}

export async function proposeOperation(
  context: ModuleActionContext,
  input: Omit<Parameters<typeof buildOperation>[0], "reader">,
): Promise<void> {
  const operation = buildOperation({ ...input, reader: context.reader });
  await context.propose([operation]);
}

export async function readTextFile(reader: SnapshotReader, path: string): Promise<{
  content: string;
  revision: string | null;
}> {
  const file = await reader.read(path);
  return file ? { content: file.content, revision: file.revision } : { content: "", revision: null };
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}
