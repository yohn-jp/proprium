import { z } from "zod";

const identitySchema = z.string().min(1).max(256);
const textSchema = z.string().min(1).max(10_000);
const revisionSchema = identitySchema;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function isJsonValue(input: unknown): input is JsonValue {
  const pending: { value: unknown; depth: number }[] = [{ value: input, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const next = pending.pop();
    if (!next) break;
    const { value, depth } = next;
    if (++count > 10_000 || depth > 16) return false;
    if (value === null || typeof value === "boolean") continue;
    if (typeof value === "string") {
      if (value.length > 100_000) return false;
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return false;
      continue;
    }
    if (typeof value !== "object") return false;
    if (Array.isArray(value)) {
      if (value.length > 1_000) return false;
      for (const item of value) pending.push({ value: item, depth: depth + 1 });
      continue;
    }
    if (
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
      Object.entries(value).length > 1_000
    ) {
      return false;
    }
    for (const [key, item] of Object.entries(value)) {
      if (key.length > 256 || key === "__proto__" || key === "constructor" || key === "prototype") return false;
      pending.push({ value: item, depth: depth + 1 });
    }
  }
  return true;
}

const jsonRecordSchema = z.custom<Record<string, JsonValue>>(
  (value) => value !== null && typeof value === "object" && !Array.isArray(value) && isJsonValue(value),
);
const existingPreconditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("revision"), value: revisionSchema }).strict(),
  z.object({ kind: z.literal("content-hash"), value: revisionSchema }).strict(),
]);
const absentPreconditionSchema = z.object({ kind: z.literal("absent") }).strict();
const narrativePreconditionSchema = z.union([existingPreconditionSchema, absentPreconditionSchema]);
const rangeSchema = z
  .object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() })
  .strict()
  .refine(({ start, end }) => end >= start, { message: "invalid_range" });
const assessmentSchema = z
  .object({ confidence: z.number().finite().min(0).max(1), risk: z.enum(["low", "medium", "high"]) })
  .strict();
const evidenceSchema = z
  .object({
    id: identitySchema,
    sourceKind: z.enum(["manuscript", "entity", "scene", "diagnostic", "state-proposal", "external"]),
    sourceId: identitySchema,
    revision: revisionSchema,
    range: rangeSchema.optional(),
  })
  .strict();
const diagnosticSnapshotSchema = z.object({ id: identitySchema, revision: revisionSchema }).strict();
const operationBase = { id: identitySchema, evidenceIds: z.array(identitySchema).max(64), assessment: assessmentSchema };

const sourceStateEvidenceSchema = z.object({
  sceneId: identitySchema,
  excerpt: z.string().min(1).optional(),
  startOffset: z.number().int().nonnegative().optional(),
  endOffset: z.number().int().nonnegative().optional(),
});
const stateEventSchema = z
  .object({
    sceneId: identitySchema,
    order: z.number().int(),
    kind: z.enum(["location", "acquaintance", "ownership", "knowledge"]),
    subject: identitySchema,
    object: identitySchema.nullable(),
    payload: z.record(z.unknown()).pipe(jsonRecordSchema),
    source: z.enum(["rule", "llm-draft", "manual"]),
    eventId: identitySchema,
    propositionId: identitySchema.optional(),
    evidence: z
      .array(sourceStateEvidenceSchema.extend({ excerpt: z.string().max(10_000).optional() }).strict())
      .max(64)
      .optional(),
    confidence: z.number().min(0).max(1).optional(),
    createdAt: z.string().datetime().optional(),
    status: z.literal("confirmed"),
    replacesEventId: identitySchema.optional(),
  })
  .strict();

const narrativeOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    ...operationBase,
    kind: z.literal("manuscript.replace-range"),
    precondition: existingPreconditionSchema,
    target: z.object({ manuscriptId: identitySchema, sceneId: identitySchema }).strict(),
    range: rangeSchema,
    replacement: z.string().max(100_000),
  }).strict(),
  z.object({
    ...operationBase,
    kind: z.literal("entity.create"),
    precondition: absentPreconditionSchema,
    target: z.object({ entityId: identitySchema, entityType: identitySchema }).strict(),
    values: z.record(z.unknown()).pipe(jsonRecordSchema),
  }).strict(),
  z.object({
    ...operationBase,
    kind: z.literal("entity.update"),
    precondition: existingPreconditionSchema,
    target: z.object({ entityId: identitySchema }).strict(),
    changes: z.record(z.unknown()).pipe(jsonRecordSchema),
  }).strict(),
  z.object({
    ...operationBase,
    kind: z.literal("scene.create"),
    precondition: absentPreconditionSchema,
    target: z.object({ sceneId: identitySchema }).strict(),
    collectionRevision: revisionSchema.optional(),
    values: z.record(z.unknown()).pipe(jsonRecordSchema),
  }).strict(),
  z.object({
    ...operationBase,
    kind: z.literal("scene.insert"),
    precondition: existingPreconditionSchema,
    target: z.object({ sceneId: identitySchema, chapterId: identitySchema }).strict(),
    position: z.number().int().positive(),
    expectedSiblings: z.array(z.object({ id: identitySchema, revision: revisionSchema }).strict()).max(1_000),
  }).strict(),
  z.object({
    ...operationBase,
    kind: z.literal("scene.update"),
    precondition: existingPreconditionSchema,
    target: z.object({ sceneId: identitySchema }).strict(),
    changes: z.record(z.unknown()).pipe(jsonRecordSchema),
  }).strict(),
  z.object({
    ...operationBase,
    kind: z.literal("state.append-event"),
    precondition: existingPreconditionSchema,
    target: z.object({ sceneId: identitySchema, eventId: identitySchema }).strict(),
    event: stateEventSchema,
    sourceProposal: z.object({ id: identitySchema, manuscriptHash: revisionSchema }).strict().optional(),
  }).strict(),
  z.object({
    ...operationBase,
    kind: z.literal("thread.link-scene"),
    precondition: existingPreconditionSchema,
    target: z.object({ threadId: identitySchema, sceneId: identitySchema }).strict(),
    relation: z.enum(["planted", "advanced", "payoff"]),
    note: z.string().max(10_000).optional(),
  }).strict(),
  z.object({
    ...operationBase,
    kind: z.literal("reference.link"),
    precondition: existingPreconditionSchema,
    target: z.object({ from: identitySchema, to: identitySchema, kind: identitySchema }).strict(),
    note: z.string().max(10_000).optional(),
  }).strict(),
]);

/** Source NarrativeChangeSet v1 wire schema; domain and snapshot checks remain owned by Story. */
export const narrativeChangeSetSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: identitySchema,
    projectId: identitySchema,
    goal: textSchema,
    status: z.enum(["proposed", "stale", "approved", "rejected", "partially-applied", "applied", "failed"]),
    assessment: assessmentSchema,
    operations: z.array(narrativeOperationSchema).min(1).max(64),
    evidence: z.array(evidenceSchema).max(256),
    diagnostics: z.object({ before: diagnosticSnapshotSchema.nullable(), after: diagnosticSnapshotSchema.nullable() }).strict(),
  })
  .strict();

export type NarrativeChangeSetInput = z.infer<typeof narrativeChangeSetSchema>;
