import { createHash, randomUUID } from "node:crypto";
import YAML from "yaml";
import type {
  ActionResult,
  ChangeProposal,
  ChangeOperation,
  FileRevision,
  ModuleAction,
  ModuleActionContext,
  ModuleContext,
  SnapshotId,
  ValueSchema,
} from "@scriptorium/contracts";
import {
  analyzeThreadLifecycles,
  buildLocationMap,
  buildStoryCooccurrence,
  buildSceneContext,
  buildSceneLocationInfos,
  buildSceneTimelineEntries,
  collectSceneTextInputs,
  computeThreadForgetRisks,
  diffReaderAndCharacterKnowledge,
  extractReaderDisclosures,
  findMentions,
  buildMentionDictionary,
  getBacklinks,
  getEntityAppearances,
  getEntityStateHistory,
  getWorldStateAtScene,
  getGraphData,
  getThreadStatus,
  getThreadsOverview,
  getVolumeTree,
  listByType,
  listRuleStateEvents,
  mergeSeriesOverlay,
  type SceneTextForDisclosure,
  type StoryEntity,
  type StoryEntityType,
} from "./domain/index.js";
import { readStorySnapshot, type LoadedStorySnapshot } from "./snapshot.js";
import { collectNotesPlainTexts, normalizeNotes } from "./notes.js";
import { buildNarrativeChangeProposal } from "./narrativeChangeSet.js";
import {
  buildOperation,
  isRecord,
  parseRecord,
  readTextFile,
  stableJson,
  type ObjectValue,
  type ProposedWrite,
} from "./operations.js";

const STORY_STATE_ROOT = "meta/scriptorium/modules/story";
const SERIES_SETTINGS_PATH = `${STORY_STATE_ROOT}/v1/series.json`;
const STATE_PROPOSALS_PATH = `${STORY_STATE_ROOT}/state-proposals.jsonl`;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const ENTITY_TYPES = new Set<StoryEntityType>([
  "character", "location", "item", "faction", "event", "thread", "scene", "chapter",
  "volume", "arc", "lore", "dialogue_sketch",
]);
const ID_PREFIX: Partial<Record<StoryEntityType, string>> = {
  character: "char-", location: "loc-", item: "item-", faction: "faction-", lore: "lore-",
  scene: "sc-", chapter: "ch-", volume: "vol-", arc: "arc-", thread: "thread-", event: "event-",
  dialogue_sketch: "ds-",
};

type MaybeStoryTokenizer = {
  analyze(text: string, snapshot: SnapshotId, signal: AbortSignal): Promise<{
    tokens: Array<{ surface: string; pos: string; posDetail?: string[]; start: number; end: number }>;
  }>;
};
type SeriesRecord = {
  id: string;
  name: string;
  ownerId: string;
  bibleRepositoryId?: string;
  memberRepositoryIds?: string[];
  /** Legacy owner-local IDs stay explicit until migration resolves them for review. */
  bibleProjectId?: string;
  memberProjectIds?: string[];
  createdAt: string;
  [key: string]: unknown;
};
type WorkSeriesBinding = { repositoryId?: string; projectId?: string; seriesId: string; bibleRev?: string; coverLabel?: string; [key: string]: unknown };
type SeriesSettings = { version: 1; series: SeriesRecord[]; bindings: WorkSeriesBinding[]; [key: string]: unknown };
type StoredStateProposal = {
  id: string;
  scene_id: string;
  event_json: string;
  manuscript_hash: string;
  status: "proposed" | "stale" | "approved" | "rejected" | string;
  conflict_event_ids_json: string;
  duplicate_of_proposal_id: string | null;
  history_json: string;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
};
type StateProposal = {
  id: string;
  event: Record<string, unknown>;
  manuscriptHash: string;
  status: string;
  conflictEventIds: string[];
  duplicateOfProposalId: string | null;
  history: Array<Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
};
type StoryCapabilityContext = ModuleContext & {
  acquireCapability<T>(id: string): Promise<{ value: T; release(): Promise<void> }>;
};

const passThrough: ValueSchema = { parse(value) { return value; } };
const ACTION_PROPOSALS = Symbol("story-action-proposals");
function withActionProposal<T>(value: T, proposal: ChangeProposal): T & { [ACTION_PROPOSALS]?: ChangeProposal[] } {
  return Object.assign(value as object, { [ACTION_PROPOSALS]: [proposal] }) as T & { [ACTION_PROPOSALS]?: ChangeProposal[] };
}
const objectSchema: ValueSchema<ObjectValue> = {
  parse(value) { return parseRecord(value); },
};
function fieldSchema(required: string[] = [], optionalStrings: string[] = []): ValueSchema<ObjectValue> {
  return {
    parse(value) {
      const input = parseRecord(value);
      for (const key of required) {
        if (!(key in input)) throw new TypeError(`Missing required field: ${key}`);
      }
      for (const key of optionalStrings) {
        if (input[key] !== undefined && typeof input[key] !== "string") throw new TypeError(`${key} must be a string`);
      }
      return input;
    },
  };
}
function arraySchema(requiredKey: string): ValueSchema<ObjectValue> {
  return {
    parse(value) {
      const input = parseRecord(value);
      if (!Array.isArray(input[requiredKey])) throw new TypeError(`${requiredKey} must be an array`);
      return input;
    },
  };
}

function failure(context: ModuleActionContext, error: unknown): ActionResult {
  const cause = error instanceof Error ? error : new Error(String(error));
  const code = typeof (error as { code?: unknown } | null)?.code === "string"
    ? String((error as { code: string }).code)
    : cause instanceof TypeError ? "invalid_input" : "story_action_failed";
  return {
    ok: false,
    snapshot: context.reader.snapshot,
    error: { code, message: cause.message, retryable: false },
  };
}

function action(
  id: string,
  effect: ModuleAction["effect"],
  inputSchema: ValueSchema = objectSchema,
  handler: (input: ObjectValue, context: ModuleActionContext) => Promise<unknown>,
): ModuleAction {
  return {
    id,
    effect,
    inputSchema,
    outputSchema: passThrough,
    async invoke(value, context) {
      try {
        if (context.signal.aborted) throw context.signal.reason ?? new Error("Action cancelled");
        const input = inputSchema.parse(value) as ObjectValue;
        const proposals: NonNullable<Extract<ActionResult, { ok: true }>["proposals"]> = [];
        const actionContext: ModuleActionContext = {
          ...context,
          async propose(operations, evidence, proposalId) {
            const proposal = await context.propose(operations, evidence, proposalId);
            proposals.push(proposal);
            return proposal;
          },
        };
        const returned = await handler(input, actionContext) as unknown;
        let data = returned;
        if (returned && typeof returned === "object" && ACTION_PROPOSALS in returned) {
          const result = returned as { [ACTION_PROPOSALS]?: ChangeProposal[] };
          proposals.push(...(result[ACTION_PROPOSALS] ?? []));
          const clean = { ...(returned as Record<string, unknown>) };
          delete (clean as Record<PropertyKey, unknown>)[ACTION_PROPOSALS];
          data = clean;
        }
        if (context.signal.aborted) throw context.signal.reason ?? new Error("Action cancelled");
        return { ok: true, snapshot: context.reader.snapshot, data, ...(proposals.length ? { proposals } : {}) };
      } catch (error) {
        return failure(context, error);
      }
    },
  };
}

function recordFromParsedLine(line: string): StoredStateProposal {
  const value = JSON.parse(line) as unknown;
  if (!isRecord(value) || typeof value.id !== "string") throw new TypeError("Story state proposal JSONL contains a row without a stable id");
  return value as StoredStateProposal;
}

async function readStateProposals(context: ModuleActionContext): Promise<{
  rows: StoredStateProposal[];
  revision: string | null;
}> {
  const file = await readTextFile(context.reader, STATE_PROPOSALS_PATH);
  const rows = file.content.split(/\r?\n/).filter((line) => line.trim()).map(recordFromParsedLine);
  if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new TypeError("Story state proposal IDs are duplicated");
  return { rows, revision: file.revision };
}

function normalizeStoredProposal(row: StoredStateProposal): StateProposal {
  const event = typeof row.event_json === "string" ? JSON.parse(row.event_json) : row.event_json;
  const history = typeof row.history_json === "string" ? JSON.parse(row.history_json) : row.history_json;
  const conflicts = typeof row.conflict_event_ids_json === "string"
    ? JSON.parse(row.conflict_event_ids_json) : row.conflict_event_ids_json;
  if (!isRecord(event) || !Array.isArray(history) || !Array.isArray(conflicts)) throw new TypeError(`Malformed state proposal row: ${row.id}`);
  return {
    id: row.id,
    event,
    manuscriptHash: row.manuscript_hash,
    status: row.status,
    conflictEventIds: conflicts.filter((id): id is string => typeof id === "string"),
    duplicateOfProposalId: typeof row.duplicate_of_proposal_id === "string" ? row.duplicate_of_proposal_id : null,
    history: history.filter(isRecord),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function storedProposal(proposal: StateProposal, prior?: StoredStateProposal): StoredStateProposal {
  return {
    ...(prior ?? {}),
    id: proposal.id,
    scene_id: String(proposal.event.sceneId ?? prior?.scene_id ?? ""),
    event_json: JSON.stringify(proposal.event),
    manuscript_hash: proposal.manuscriptHash,
    status: proposal.status,
    conflict_event_ids_json: JSON.stringify(proposal.conflictEventIds),
    duplicate_of_proposal_id: proposal.duplicateOfProposalId,
    history_json: JSON.stringify(proposal.history),
    created_at: proposal.createdAt,
    updated_at: proposal.updatedAt,
  };
}

function stateProposalFile(rows: readonly StoredStateProposal[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
}

function createStateEvent(input: ObjectValue, scene: StoryEntity, manuscriptHash: string): StateProposal {
  const raw = parseRecord(input.event, "event");
  const kind = raw.kind;
  if (!["location", "acquaintance", "ownership", "knowledge"].includes(String(kind))) throw new TypeError("event.kind is invalid");
  const subject = stringValue(raw.subject, "event.subject");
  const object = raw.object === null ? null : stringValue(raw.object, "event.object");
  const payload = isRecord(raw.payload) ? raw.payload : {};
  const now = new Date().toISOString();
  const event = {
    sceneId: scene.id,
    order: typeof scene.raw.order === "number" ? scene.raw.order : 0,
    kind,
    subject,
    object,
    payload,
    source: "llm-draft",
    eventId: typeof raw.eventId === "string" && raw.eventId ? raw.eventId : `state-${randomUUID()}`,
    propositionId: typeof raw.propositionId === "string" && raw.propositionId ? raw.propositionId : `proposition-${randomUUID()}`,
    evidence: Array.isArray(raw.evidence) ? raw.evidence : [{ sceneId: scene.id }],
    confidence: typeof raw.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : 0.5,
    createdAt: now,
    status: "proposed",
    ...(typeof raw.replacesEventId === "string" ? { replacesEventId: raw.replacesEventId } : {}),
  };
  return {
    id: typeof input.id === "string" && SAFE_ID.test(input.id) ? input.id : `state-proposal-${randomUUID()}`,
    event,
    manuscriptHash,
    status: "proposed",
    conflictEventIds: [],
    duplicateOfProposalId: null,
    history: [{ action: "created", at: now, event }],
    createdAt: now,
    updatedAt: now,
  };
}

function validateEventReferences(event: Record<string, unknown>, story: LoadedStorySnapshot): void {
  const subject = typeof event.subject === "string" ? story.entities.get(event.subject) : undefined;
  const object = typeof event.object === "string" ? story.entities.get(event.object) : undefined;
  if (!subject) throw new TypeError("State event subject must reference an existing entity");
  if (typeof event.object === "string" && !object) throw new TypeError("State event object must reference an existing entity");
  if (event.kind === "location" && subject.type !== "character") throw new TypeError("Location state subject must be a character");
  if (event.kind === "location" && object?.type !== "location") throw new TypeError("Location state object must be a location");
  if (event.kind === "ownership" && subject.type !== "item") throw new TypeError("Ownership state subject must be an item");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function contentRevision(value: unknown): string {
  return `\"sha256-${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}\"`;
}
function sourceEntityRevision(entity: StoryEntity): string {
  return contentRevision({ raw: entity.raw, body: entity.body ?? null });
}
function requestedOperationId(input: ObjectValue): string | undefined {
  const value = input.operationId ?? input.operation_id;
  if (value === undefined) return undefined;
  return stringValue(value, "operationId");
}
function assertSourceRevision(input: ObjectValue, current: string, label = "base_revision"): void {
  const expected = input.baseRevision ?? input.base_revision;
  if (expected !== undefined && expected !== current) {
    throw Object.assign(new Error(`Stale ${label}: the Story data changed after the selected snapshot`), { code: "operation_precondition_conflict" });
  }
}
function entityCollectionRevision(entities: Iterable<StoryEntity>): string {
  return contentRevision([...entities].map((entity) => [entity.id, sourceEntityRevision(entity)]).sort(([a], [b]) => String(a).localeCompare(String(b))));
}
function entityWithRevision(entity: StoryEntity, story: LoadedStorySnapshot): StoryEntity & { revision: string; fileRevision: string | null } {
  return {
    ...entity,
    revision: sourceEntityRevision(entity),
    fileRevision: story.revisions.get(entity.filePath) ?? null,
  };
}
function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function pathForEntity(type: StoryEntityType, id: string, raw: ObjectValue): string {
  if (!SAFE_ID.test(id)) throw new TypeError("`id` must contain only letters, numbers, hyphens, and underscores");
  if (type === "character") return `bible/characters/${id}/profile.yaml`;
  const flat: Partial<Record<StoryEntityType, string>> = {
    location: "bible/locations", item: "bible/items", faction: "bible/factions", event: "bible/timeline/events",
    lore: "bible/lore", thread: "plot/threads", arc: "plot/arcs", dialogue_sketch: "bible/dialogue_sketches",
  };
  if (flat[type]) return `${flat[type]}/${id}.yaml`;
  if (type === "volume") return `plot/volumes/${id}/volume.yaml`;
  if (type === "chapter") {
    const volume = stringValue(raw.volume, "volume");
    if (!SAFE_ID.test(volume)) throw new TypeError("`volume` must contain only letters, numbers, hyphens, and underscores");
    return `plot/volumes/${volume}/chapters/${id}/chapter.yaml`;
  }
  if (type === "scene") {
    const volume = stringValue(raw.volume, "volume");
    const chapter = stringValue(raw.chapter, "chapter");
    if (!SAFE_ID.test(volume) || !SAFE_ID.test(chapter)) throw new TypeError("Scene volume and chapter IDs must contain only letters, numbers, hyphens, and underscores");
    return `plot/volumes/${volume}/chapters/${chapter}/scenes/${id}.yaml`;
  }
  throw new TypeError(`Cannot create entities of type "${type}"`);
}

function slugifyHint(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

function allocateEntityId(type: StoryEntityType, entities: ReadonlyMap<string, StoryEntity>, hint?: string): string {
  const prefix = ID_PREFIX[type] ?? `${type.replace(/_/g, "-")}-`;
  const slug = hint?.trim() ? slugifyHint(hint) : "";
  const base = slug ? `${prefix}${slug}` : `${prefix}1`;
  if (!entities.has(base) && SAFE_ID.test(base)) return base;
  for (let n = 2; n < 10_000; n++) {
    const candidate = slug ? `${base}-${n}` : `${prefix}${n}`;
    if (!entities.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

function sanitizeScalar(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^[=\-_~]{3,}\s*$/.test(line)).join(" ").trim();
}

function validateReferences(raw: ObjectValue, story: LoadedStorySnapshot, omitId?: string): void {
  const requireEntity = (id: unknown, label: string) => {
    if (typeof id !== "string" || !story.entities.has(id) || id === omitId) throw new TypeError(`${label} must reference an existing entity`);
  };
  const requireType = (id: unknown, type: StoryEntityType, label: string) => {
    requireEntity(id, label);
    if (story.entities.get(id as string)?.type !== type) throw new TypeError(`${label} must reference a ${type}`);
  };
  if (raw.volume !== undefined && raw.volume !== null) requireType(raw.volume, "volume", "volume");
  if (raw.chapter !== undefined && raw.chapter !== null) requireType(raw.chapter, "chapter", "chapter");
  if (raw.pov !== undefined && raw.pov !== null) requireType(raw.pov, "character", "pov");
  if (raw.location !== undefined && raw.location !== null) requireType(raw.location, "location", "location");
  if (raw.resolution !== undefined && raw.resolution !== null) requireType(raw.resolution, "scene", "resolution");
  const relationValues = new Set(["appears", "mentions", "plants", "advances", "related", "pov", "affiliated", "target", "first_appears", "planted", "payoff"]);
  for (const field of relationValues) {
    const value = raw[field];
    const references = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
    for (const ref of references) {
      if (typeof ref === "string") requireEntity(ref, field);
      else if (isRecord(ref)) {
        const target = ref.target ?? ref.scene ?? ref.id;
        if (target !== undefined) requireEntity(target, field);
      }
    }
  }
  if (Array.isArray(raw.relations)) for (const relation of raw.relations) {
    if (isRecord(relation) && relation.target !== undefined) requireEntity(relation.target, "relations.target");
  }
}

function yamlContent(value: ObjectValue): string {
  return YAML.stringify(value);
}

async function readForWrite(context: ModuleActionContext, path: string): Promise<{ revision: string | null; content: string }> {
  const file = await context.reader.read(path);
  return file ? { revision: file.revision, content: file.content } : { revision: null, content: "" };
}

async function prepareEntityUpdate(
  input: { story: LoadedStorySnapshot; context: ModuleActionContext; id: string; patch: ObjectValue; effect?: "structure" | "metadata" },
): Promise<{ entity: StoryEntity; content: string; path: string; revision: string }> {
  const entity = input.story.entities.get(input.id);
  if (!entity) throw new TypeError(`Entity not found: ${input.id}`);
  if (typeof input.patch.type === "string" && input.patch.type !== entity.type) throw new TypeError("Cannot change an entity's `type`");
  const patch = { ...input.patch };
  if (patch["links[+]"] !== undefined) {
    if (patch.relations !== undefined || !isRecord(patch["links[+]"])) throw new TypeError("`links[+]` requires one link object without `relations`");
    const link = patch["links[+]"] as ObjectValue;
    const target = link.to ?? link.target;
    if (typeof target !== "string" || !input.story.entities.has(target)) throw new TypeError("Link target not found");
    const relations = Array.isArray(entity.raw.relations) ? [...entity.raw.relations] : [];
    relations.push({ target, kind: link.type ?? link.kind ?? "related" });
    patch.relations = relations;
    delete patch["links[+]"];
  }
  const next: ObjectValue = { ...entity.raw, ...patch, id: entity.id, type: entity.type };
  if ("name" in next) next.name = sanitizeScalar(next.name);
  if ("title" in next) next.title = sanitizeScalar(next.title);
  for (const [key, value] of Object.entries(patch)) if (value === null) delete next[key];
  if (next.notes !== undefined) {
    const normalized = normalizeNotes(next.notes);
    if (normalized) next.notes = normalized;
  }
  validateReferences(next, input.story, entity.id);
  const file = await readForWrite(input.context, entity.filePath);
  if (file.revision === null) throw new TypeError(`Entity file is missing: ${entity.filePath}`);
  return { entity, content: yamlContent(next), path: entity.filePath, revision: file.revision };
}

function sceneTextInputs(story: LoadedStorySnapshot): SceneTextForDisclosure[] {
  const infos = buildSceneLocationInfos(story).data;
  return infos.map((info) => {
    const scene = story.entities.get(info.sceneId)!;
    const ctx = buildSceneContext({ ...story, sceneId: info.sceneId }).data;
    return { sceneId: info.sceneId, order: info.order, text: ctx?.manuscriptBody ?? "", characterIds: info.characterIds };
  });
}

function timelineInputs(story: LoadedStorySnapshot) {
  return buildSceneLocationInfos(story).data.map((info) => {
    const scene = story.entities.get(info.sceneId)!;
    const chapter = info.chapterId ? story.entities.get(info.chapterId) : undefined;
    const context = buildSceneContext({ ...story, sceneId: scene.id }).data;
    return {
      sceneId: scene.id,
      order: info.order,
      text: context?.manuscriptBody ?? "",
      title: typeof scene.raw.title === "string" && scene.raw.title.trim() ? scene.raw.title : scene.name ?? scene.id,
      explicitDateMeta: [scene.raw.date, scene.raw.storyDate, scene.raw.calendarDate].some((value) => typeof value === "string"),
      locationId: info.locationId,
      locationName: info.locationId ? story.entities.get(info.locationId)?.name : undefined,
      characters: info.characterIds.map((id) => ({ id, name: story.entities.get(id)?.name?.trim() || id })),
      chapterId: info.chapterId,
      chapterName: chapter?.name,
    };
  });
}

function emptySeriesSettings(): SeriesSettings { return { version: 1, series: [], bindings: [] }; }
async function readSeriesSettings(context: ModuleActionContext): Promise<{ settings: SeriesSettings; revision: string | null }> {
  const file = await readTextFile(context.reader, SERIES_SETTINGS_PATH);
  if (!file.content.trim()) return { settings: emptySeriesSettings(), revision: file.revision };
  const parsed: unknown = JSON.parse(file.content);
  if (!isRecord(parsed) || !Array.isArray(parsed.series) || !parsed.series.every(isRecord) || !Array.isArray(parsed.bindings) || !parsed.bindings.every(isRecord)) throw new TypeError("Story series settings are malformed");
  return {
    settings: {
      ...parsed,
      version: 1,
      series: parsed.series as unknown as SeriesRecord[],
      bindings: parsed.bindings as unknown as WorkSeriesBinding[],
    },
    revision: file.revision,
  };
}

function assertSeriesSettings(settings: SeriesSettings): void {
  for (const series of settings.series) {
    if (!series.id || !series.name?.trim() || !series.ownerId?.trim() || (!series.bibleRepositoryId?.trim() && !series.bibleProjectId?.trim()) ||
      (series.bibleRepositoryId !== undefined && !series.bibleRepositoryId.trim()) ||
      (series.bibleProjectId !== undefined && !series.bibleProjectId.trim()) ||
      (series.memberRepositoryIds !== undefined && (!Array.isArray(series.memberRepositoryIds) || series.memberRepositoryIds.some((id) => typeof id !== "string"))) ||
      (series.memberProjectIds !== undefined && (!Array.isArray(series.memberProjectIds) || series.memberProjectIds.some((id) => typeof id !== "string")))) {
      throw new TypeError("Story series records require id, name, ownerId, and valid repository bindings");
    }
  }
  const ids = settings.series.map((series) => series.id);
  if (new Set(ids).size !== ids.length) throw new TypeError("Story series IDs must be unique");
  for (const binding of settings.bindings) {
    if ((!binding.repositoryId?.trim() && !binding.projectId?.trim()) || !binding.seriesId?.trim() || !settings.series.some((series) => series.id === binding.seriesId)) {
      throw new TypeError("Story series bindings must use a repository identity and reference an existing series");
    }
  }
}

async function proposeSeriesSettings(context: ModuleActionContext, settings: SeriesSettings, revision: string | null, message: string, operationId?: string) {
  assertSeriesSettings(settings);
  const operation = buildOperation({
    reader: context.reader,
    reads: [{ path: SERIES_SETTINGS_PATH, revision }],
    writes: [{ path: SERIES_SETTINGS_PATH, revision, content: stableJson(settings) }],
    message,
    effect: "settings",
    operationId,
  });
  await context.propose([operation]);
  return settings;
}

function collectTexts(entity: StoryEntity): string[] {
  const notes = normalizeNotes(entity.raw.notes);
  const result = notes ? collectNotesPlainTexts(notes) : typeof entity.raw.notes === "string" ? [entity.raw.notes] : [];
  if (entity.body) result.push(entity.body);
  return result;
}

function buildVoicePatterns(entity: StoryEntity): ObjectValue {
  const profiles = Array.isArray(entity.raw.voice_profiles)
    ? entity.raw.voice_profiles.filter(isRecord).filter((profile) => typeof profile.id === "string")
    : [];
  if (profiles.length) {
    const firstPerson = [...new Set(profiles.flatMap((profile) => Array.isArray(profile.firstPerson) ? profile.firstPerson.filter((item): item is string => typeof item === "string") : []))];
    const sentenceEndings = [...new Set(profiles.flatMap((profile) => Array.isArray(profile.sentenceEndings) ? profile.sentenceEndings.filter((item): item is string => typeof item === "string") : []))];
    return { ...(firstPerson.length ? { firstPerson } : {}), ...(sentenceEndings.length ? { sentenceEndings } : {}) };
  }
  const patterns = isRecord(entity.raw.voicePatterns) ? entity.raw.voicePatterns : {};
  const result: ObjectValue = {};
  for (const key of ["firstPerson", "sentenceEndings"] as const) {
    if (Array.isArray(patterns[key])) result[key] = patterns[key]!.filter((item): item is string => typeof item === "string");
  }
  if (typeof patterns.tone === "string" && patterns.tone.length) result.tone = patterns.tone;
  if (Object.keys(result).length) return result;
  const voice = isRecord(entity.raw.voice) ? entity.raw.voice : {};
  const voiceFirstPerson = voice.first_person;
  if (Array.isArray(voiceFirstPerson)) {
    const names = voiceFirstPerson.filter(isRecord).map((item) => item.name).filter((item): item is string => typeof item === "string");
    if (names.length) result.firstPerson = names;
  }
  const duality = isRecord(voice.duality) ? voice.duality : {};
  const outer = isRecord(duality.outer) ? duality.outer : {};
  const first = isRecord(outer.first_person) ? outer.first_person : {};
  if (!result.firstPerson) {
    const names = [first.name, first.reading].filter((item): item is string => typeof item === "string" && item.length > 0);
    if (names.length) result.firstPerson = [...new Set(names)];
  }
  if (typeof outer.tone === "string" && outer.tone.length) result.tone = outer.tone;
  return result;
}

function suggestedTagData(input: {
  entity: StoryEntity;
  entities: ReadonlyMap<string, StoryEntity>;
  tagsConfig: ObjectValue;
  tokenize: (text: string) => Promise<Array<{ surface: string; pos: string }>>;
}): Promise<Array<{ tag: string; score: number; reason: "keyword" | "mention" | "both" }>> {
  return (async () => {
    const entity = input.entity;
    const texts = collectTexts(entity);
    const foundTerms = new Set<string>();
    for (const text of texts) {
      if (!text) continue;
      let current = "";
      const flush = () => {
        if (current.length >= 2 && !/^[\s\p{P}\p{S}0-9]+$/u.test(current)) foundTerms.add(current);
        current = "";
      };
      for (const token of await input.tokenize(text)) {
        if (token.pos === "名詞") current += token.surface;
        else flush();
      }
      flush();
    }
    const categories = isRecord(input.tagsConfig.categories) ? input.tagsConfig.categories : {};
    const keywordScores = new Map<string, number>();
    for (const [category, values] of Object.entries(categories)) {
      if (!Array.isArray(values) || !values.length) continue;
      const keywords = values.filter((value): value is string => typeof value === "string");
      if (!keywords.length) continue;
      const hits = keywords.filter((keyword) => foundTerms.has(keyword)).length;
      if (hits) keywordScores.set(category, hits / keywords.length);
    }
    const mentionDictionary = buildMentionDictionary(input.entities.values());
    const mentionedIds = new Set<string>();
    for (const text of texts) for (const id of findMentions(mentionDictionary, text)) if (id !== entity.id) mentionedIds.add(id);
    const tagCounts = new Map<string, number>();
    for (const id of mentionedIds) for (const tag of input.entities.get(id)?.tags ?? []) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    const result: Array<{ tag: string; score: number; reason: "keyword" | "mention" | "both" }> = [];
    for (const tag of new Set([...keywordScores.keys(), ...tagCounts.keys()])) {
      if (entity.tags?.includes(tag)) continue;
      const keywordScore = keywordScores.get(tag) ?? 0;
      const mentionScore = mentionedIds.size ? (tagCounts.get(tag) ?? 0) / mentionedIds.size : 0;
      const score = keywordScore * 0.6 + mentionScore * 0.4;
      if (score < 0.3) continue;
      result.push({ tag, score, reason: keywordScore && mentionScore ? "both" : keywordScore ? "keyword" : "mention" });
    }
    return result.sort((a, b) => b.score - a.score);
  })();
}

async function withTokenizer<T>(capabilityContext: StoryCapabilityContext, context: ModuleActionContext, task: (tokenizer: MaybeStoryTokenizer) => Promise<T>): Promise<T> {
  let lease: { value: MaybeStoryTokenizer; release(): Promise<void> };
  try {
    lease = await capabilityContext.acquireCapability<MaybeStoryTokenizer>("nlp.tokenizer");
  } catch {
    throw Object.assign(new Error("Suggested tags require the optional NLP tokenizer. Enable the NLP module and retry."), { code: "feature_unavailable" });
  }
  try { return await task(lease.value); }
  finally { await lease.release(); }
}

function makeActions(moduleContext: StoryCapabilityContext): ModuleAction[] {
  const read = "read" as const;
  const propose = "propose" as const;
  const compute = "compute" as const;
  return [
    action("story.changes.propose", propose, passThrough, async (input, context) => {
      const converted = await buildNarrativeChangeProposal(context, input);
      const existingResult = await context.invoke("core.proposals.get", { proposalId: converted.proposalId });
      if (existingResult.ok) {
        const status = (existingResult.data as { proposal?: { proposal?: unknown } }).proposal;
        const prior = status?.proposal;
        if (!isRecord(prior) || !Array.isArray(prior.evidence)) {
          throw Object.assign(new Error("Existing Core proposal has no Story source identity evidence"), { code: "change_set_identity_conflict" });
        }
        const identity = prior.evidence.find((item) => isRecord(item) && item.kind === "source.narrative-change-set.v1");
        const details = isRecord(identity) && isRecord(identity.details) ? identity.details : undefined;
        if (details?.sourceFingerprint !== converted.sourceFingerprint || JSON.stringify(details.operationMap) !== JSON.stringify(converted.operationMap)) {
          throw Object.assign(new Error("This NarrativeChangeSet ID is already bound to a different source payload"), { code: "change_set_identity_conflict" });
        }
        if (typeof details.submittedAt !== "string" || Number.isNaN(Date.parse(details.submittedAt))) {
          throw Object.assign(new Error("Existing Story proposal is missing its source submission timestamp"), { code: "change_set_identity_conflict" });
        }
        return withActionProposal({
          changeSetId: converted.changeSetId,
          proposalId: converted.proposalId,
          coreProposalId: converted.coreProposalId,
          submittedAt: details.submittedAt,
          operationIds: converted.operationIds,
          operationMap: converted.operationMap,
          dependencies: converted.dependencies,
          resultIds: converted.resultIds,
          resultPaths: converted.resultPaths,
          resultRevisions: converted.resultRevisions,
          affectedEntities: converted.affectedEntities,
          sourceFingerprint: converted.sourceFingerprint,
          replayed: true,
        }, prior as unknown as ChangeProposal);
      }
      if (!new Set(["PROPOSAL_NOT_FOUND", "proposal_not_found"]).has(existingResult.error.code)) {
        throw Object.assign(new Error(`Unable to verify existing Core proposal identity: ${existingResult.error.message}`), { code: existingResult.error.code });
      }
      await context.propose(converted.operations, converted.evidence, converted.proposalId);
      return {
        changeSetId: converted.changeSetId,
        proposalId: converted.proposalId,
        coreProposalId: converted.coreProposalId,
        submittedAt: converted.submittedAt,
        operationIds: converted.operationIds,
        operationMap: converted.operationMap,
        dependencies: converted.dependencies,
        resultIds: converted.resultIds,
        resultPaths: converted.resultPaths,
        resultRevisions: converted.resultRevisions,
        affectedEntities: converted.affectedEntities,
        sourceFingerprint: converted.sourceFingerprint,
        replayed: false,
      };
    }),
    action("story.entities.list", read, fieldSchema([], ["type", "tag"]), async (input, context) => {
      const story = await readStorySnapshot(context.reader);
      return [...story.entities.values()].filter((entity) => (!input.type || entity.type === input.type) && (!input.tag || entity.tags?.includes(String(input.tag)))).sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id, "ja")).map((entity) => entityWithRevision(entity, story));
    }),
    action("story.entities.collection-revision", read, objectSchema, async (_input, context) => {
      const story = await readStorySnapshot(context.reader);
      return { revision: entityCollectionRevision(story.entities.values()) };
    }),
    action("story.entities.get", read, fieldSchema(["id"], ["id"]), async (input, context) => {
      const story = await readStorySnapshot(context.reader);
      const entity = story.entities.get(String(input.id));
      return entity ? entityWithRevision(entity, story) : null;
    }),
    action("story.entities.create", propose, fieldSchema(["type"]), async (input, context) => {
      const type = stringValue(input.type, "type") as StoryEntityType;
      if (!ENTITY_TYPES.has(type)) throw new TypeError(`Unsupported entity type: ${type}`);
      const story = await readStorySnapshot(context.reader);
      const collectionRevision = entityCollectionRevision(story.entities.values());
      const treeRevision = contentRevision(getVolumeTree(story).data);
      const baseRevision = input.baseRevision ?? input.base_revision;
      if (baseRevision !== undefined && baseRevision !== collectionRevision && !(type === "scene" && baseRevision === treeRevision)) {
        throw Object.assign(new Error("Stale base_revision: Story entities changed after the selected snapshot"), { code: "operation_precondition_conflict" });
      }
      const data: ObjectValue = { ...input };
      for (const field of ["type", "baseRevision", "base_revision", "operationId", "operation_id", "position"]) delete data[field];
      const hint = typeof data.slug === "string" ? data.slug : typeof data.name === "string" ? data.name : typeof data.title === "string" ? data.title : undefined;
      const slugId = type === "scene" && typeof data.slug === "string" ? (data.slug.startsWith("sc-") ? data.slug : `sc-${data.slug}`) : undefined;
      const id = typeof data.id === "string" && data.id ? data.id : slugId ?? allocateEntityId(type, story.entities, hint);
      delete data.slug;
      if (story.entities.has(id)) throw Object.assign(new Error(`Entity with id "${id}" already exists`), { code: "entity_conflict" });
      data.id = id;
      data.type = type;
      if (type === "scene" && Array.isArray(data.characters)) {
        if (!data.characters.every((character) => typeof character === "string")) throw new TypeError("characters must be a string array");
        const relations = Array.isArray(data.relations) ? [...data.relations] : [];
        for (const character of data.characters as string[]) {
          if (story.entities.get(character)?.type !== "character") throw new TypeError(`Character not found: ${character}`);
          relations.push({ target: character, kind: "appears" });
        }
        data.relations = relations;
        delete data.characters;
      }
      if ("name" in data) data.name = sanitizeScalar(data.name);
      if ("title" in data) data.title = sanitizeScalar(data.title);
      if ((type === "chapter" || type === "scene") && data.order == null) {
        const parentField = type === "chapter" ? "volume" : "chapter";
        const parent = data[parentField];
        const siblings = [...story.entities.values()].filter((entity) => entity.type === type && entity.raw[parentField] === parent);
        data.order = siblings.reduce((max, sibling) => Math.max(max, typeof sibling.raw.order === "number" ? sibling.raw.order : 0), 0) + 1;
      }
      if (type === "chapter") {
        const volume = story.entities.get(String(data.volume));
        if (volume?.type !== "volume") throw new TypeError("`volume` must reference an existing volume id");
      }
      if (type === "scene") {
        const chapter = story.entities.get(String(data.chapter));
        if (chapter?.type !== "chapter") throw new TypeError("`chapter` must reference an existing chapter id");
        const volume = story.entities.get(String(data.volume));
        if (volume?.type !== "volume") throw new TypeError("`volume` must reference an existing volume id");
        if (chapter.raw.volume !== data.volume) throw new TypeError("Scene chapter must belong to its volume");
        data.manuscript = `manuscript/${String(data.volume)}/${String(data.chapter)}/${id}.md`;
        if (data.location !== undefined && story.entities.get(String(data.location))?.type !== "location") throw new TypeError("location must reference an existing location");
      }
      validateReferences(data, story);
      const path = pathForEntity(type, id, data);
      const current = await readForWrite(context, path);
      if (current.revision !== null) throw Object.assign(new Error(`File already exists: ${path}`), { code: "entity_conflict" });
      const filesToWrite: ProposedWrite[] = [{ path, revision: null, content: yamlContent(data) }];
      const readPaths = new Set([path]);
      if (type === "scene") {
        const manuscript = String(data.manuscript);
        const manuscriptFile = await readForWrite(context, manuscript);
        if (manuscriptFile.revision !== null) throw Object.assign(new Error(`File already exists: ${manuscript}`), { code: "entity_conflict" });
        filesToWrite.push({ path: manuscript, revision: null, content: `---\n${YAML.stringify({ title: typeof data.title === "string" ? data.title : id, status: "planned" })}---\n` });
        readPaths.add(manuscript);
      }
      const reads: FileRevision[] = [{ path, revision: null }];
      if (type === "scene") {
        const existingScenes = [...story.entities.values()]
          .filter((entity) => entity.type === "scene" && entity.raw.chapter === data.chapter)
          .sort((a, b) => Number(a.raw.order ?? 0) - Number(b.raw.order ?? 0) || a.id.localeCompare(b.id));
        const hasPosition = input.position !== undefined;
        if (hasPosition && (!Number.isInteger(input.position) || (input.position as number) < 1)) throw new TypeError("position must be a positive integer");
        const insertAt = hasPosition ? Math.min((input.position as number) - 1, existingScenes.length) : existingScenes.length;
        const finalIds = existingScenes.map((entity) => entity.id);
        finalIds.splice(insertAt, 0, id);
        data.order = insertAt + 1;
        filesToWrite[0] = { path, revision: null, content: yamlContent(data) };
        if (hasPosition) {
          for (const sceneId of finalIds) {
            if (sceneId === id) continue;
            const sibling = story.entities.get(sceneId)!;
            const revision = story.revisions.get(sibling.filePath);
            if (!revision) throw new TypeError(`Scene file is missing: ${sibling.filePath}`);
            reads.push({ path: sibling.filePath, revision });
            if (Number(sibling.raw.order ?? 0) !== finalIds.indexOf(sceneId) + 1) {
              filesToWrite.push({ path: sibling.filePath, revision, content: yamlContent({ ...sibling.raw, order: finalIds.indexOf(sceneId) + 1 }) });
            }
          }
        }
      }
      for (const parentId of [data.volume, data.chapter]) {
        if (typeof parentId === "string") {
          const parent = story.entities.get(parentId);
          if (parent) reads.push({ path: parent.filePath, revision: story.revisions.get(parent.filePath) ?? null });
        }
      }
      for (const filePath of readPaths) if (!reads.some((entry) => entry.path === filePath)) reads.push({ path: filePath, revision: null });
      const operation = buildOperation({ reader: context.reader, reads, writes: filesToWrite, message: `Create Story ${type} ${id}`, effect: type === "scene" || type === "chapter" || type === "volume" ? "structure" : "metadata", operationId: requestedOperationId(input) });
      await context.propose([operation]);
      return { id, type, name: typeof data.name === "string" ? data.name : undefined, tags: data.tags, filePath: path, raw: data };
    }),
    action("story.entities.update", propose, fieldSchema(["id", "patch"]), async (input, context) => {
      const story = await readStorySnapshot(context.reader);
      const patch = parseRecord(input.patch, "patch");
      const current = story.entities.get(stringValue(input.id, "id"));
      if (!current) throw new TypeError(`Entity not found: ${String(input.id)}`);
      assertSourceRevision(input, sourceEntityRevision(current));
      const update = await prepareEntityUpdate({ story, context, id: current.id, patch });
      const operation = buildOperation({ reader: context.reader, operationId: requestedOperationId(input), reads: [{ path: update.path, revision: update.revision }], writes: [{ path: update.path, revision: update.revision, content: update.content }], message: `Update Story entity ${input.id}`, effect: "metadata" });
      await context.propose([operation]);
      return { ...update.entity, raw: { ...update.entity.raw, ...patch, id: update.entity.id, type: update.entity.type } };
    }),
    action("story.scene.metadata.update", propose, fieldSchema(["sceneId", "patch"]), async (input, context) => {
      const story = await readStorySnapshot(context.reader);
      const scene = story.entities.get(stringValue(input.sceneId, "sceneId"));
      if (scene?.type !== "scene") throw new TypeError("Scene not found");
      assertSourceRevision(input, sourceEntityRevision(scene));
      const update = await prepareEntityUpdate({ story, context, id: scene.id, patch: parseRecord(input.patch, "patch"), effect: "metadata" });
      const operation = buildOperation({ reader: context.reader, operationId: requestedOperationId(input), reads: [{ path: update.path, revision: update.revision }], writes: [{ path: update.path, revision: update.revision, content: update.content }], message: `Update Story scene metadata ${scene.id}`, effect: "metadata" });
      await context.propose([operation]);
      return { ...scene, raw: { ...scene.raw, ...parseRecord(input.patch, "patch") } };
    }),
    action("story.entities.reorder", propose, fieldSchema(["type", "parentId", "orderedIds"]), async (input, context) => {
      if (input.type !== "chapter" && input.type !== "scene") throw new TypeError("type must be chapter or scene");
      const parentId = stringValue(input.parentId, "parentId");
      if (!Array.isArray(input.orderedIds) || !input.orderedIds.every((id) => typeof id === "string")) throw new TypeError("orderedIds must be a string array");
      const story = await readStorySnapshot(context.reader);
      assertSourceRevision(input, contentRevision(getVolumeTree(story).data));
      const parentField = input.type === "chapter" ? "volume" : "chapter";
      const siblings = [...story.entities.values()].filter((entity) => entity.type === input.type && entity.raw[parentField] === parentId);
      const orderedIds = input.orderedIds as string[];
      if (orderedIds.length !== siblings.length || new Set(orderedIds).size !== orderedIds.length || orderedIds.some((id) => !siblings.some((entity) => entity.id === id))) throw new TypeError("orderedIds must include every sibling exactly once");
      const writes: ProposedWrite[] = [];
      const reads: FileRevision[] = [];
      for (let index = 0; index < orderedIds.length; index++) {
        const entity = story.entities.get(orderedIds[index]!)!;
        const revision = story.revisions.get(entity.filePath);
        if (!revision) throw new TypeError(`Entity file is missing: ${entity.filePath}`);
        const raw = { ...entity.raw, order: index + 1 };
        reads.push({ path: entity.filePath, revision });
        writes.push({ path: entity.filePath, revision, content: yamlContent(raw) });
      }
      if (writes.length === 0) return { ok: true, changedPaths: [] };
      const operation = buildOperation({ reader: context.reader, operationId: requestedOperationId(input), reads, writes, message: `Reorder Story ${input.type} siblings`, effect: "structure" });
      await context.propose([operation]);
      return { ok: true, changedPaths: writes.map((write) => write.path) };
    }),
    action("story.entities.backlinks", read, fieldSchema(["id"], ["id"]), async (input, context) => getBacklinks({ ...await readStorySnapshot(context.reader), toId: stringValue(input.id, "id") }).data),
    action("story.entities.appearances", read, fieldSchema(["id"], ["id"]), async (input, context) => getEntityAppearances({ ...await readStorySnapshot(context.reader), entityId: stringValue(input.id, "id") }).data),
    action("story.entities.voice-patterns", read, fieldSchema(["id"], ["id"]), async (input, context) => {
      const story = await readStorySnapshot(context.reader);
      const entity = story.entities.get(stringValue(input.id, "id"));
      if (!entity) return null;
      return buildVoicePatterns(entity);
    }),
    action("story.entities.freshness", read, fieldSchema(["id"], ["id"]), async (input, context) => {
      const story = await readStorySnapshot(context.reader);
      const id = stringValue(input.id, "id");
      const entity = story.entities.get(id);
      if (!entity) return null;
      const mentionable = [...story.entities.values()].filter((item) => ["character", "location", "item", "faction", "event", "lore", "thread"].includes(item.type));
      const dictionary = buildMentionDictionary(mentionable);
      const scenes = [...story.entities.values()].filter((item) => item.type === "scene");
      const mentionedIn = new Set<string>();
      for (const scene of scenes) {
        const text = typeof scene.raw.manuscript === "string" ? [...story.entities.values()].find((item) => item.filePath === scene.raw.manuscript)?.body : undefined;
        if (text && findMentions(dictionary, text).includes(id)) mentionedIn.add(scene.id);
      }
      const baseline = isRecord(entity.raw.notesMentionBaseline) && Array.isArray(entity.raw.notesMentionBaseline.sceneIds)
        ? entity.raw.notesMentionBaseline.sceneIds.filter((value): value is string => typeof value === "string") : null;
      const current = [...mentionedIn].sort((a, b) => a.localeCompare(b));
      const known = new Set(baseline ?? []);
      const newMentionSceneIds = baseline ? current.filter((sceneId) => !known.has(sceneId)) : [];
      return { entityId: id, newMentionCount: newMentionSceneIds.length, newMentionSceneIds, notesUpdatedAt: baseline && isRecord(entity.raw.notesMentionBaseline) && typeof entity.raw.notesMentionBaseline.updatedAt === "string" ? entity.raw.notesMentionBaseline.updatedAt : null };
    }),
    action("story.entities.suggested-tags", compute, fieldSchema(["id"], ["id"]), async (input, context) => {
      const story = await readStorySnapshot(context.reader);
      const entity = story.entities.get(stringValue(input.id, "id"));
      if (!entity) throw new TypeError(`Entity not found: ${String(input.id)}`);
      const config = await context.reader.read("meta/tags.yaml");
      const tagsConfig = config ? YAML.parse(config.content) as ObjectValue : { categories: {} };
      return withTokenizer(moduleContext, context, async (tokenizer) => suggestedTagData({
        entity,
        entities: story.entities,
        tagsConfig: isRecord(tagsConfig) ? tagsConfig : { categories: {} },
        tokenize: async (text) => (await tokenizer.analyze(text, context.reader.snapshot, context.signal)).tokens,
      }));
    }),
    action("story.tags.list", read, objectSchema, async (_input, context) => {
      const story = await readStorySnapshot(context.reader);
      return [...new Set([...story.entities.values()].flatMap((entity) => entity.tags ?? []))].sort((a, b) => a.localeCompare(b));
    }),
    action("story.scene.context", read, fieldSchema(["sceneId"], ["sceneId"]), async (input, context) => {
      const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
      const scene = story.entities.get(stringValue(input.sceneId, "sceneId"));
      const result = buildSceneContext({ ...story, sceneId: stringValue(input.sceneId, "sceneId") }).data;
      if (!result || !scene) return null;
      const manuscript = result.manuscript;
      return {
        ...result,
        sceneRevision: sourceEntityRevision(scene),
        sceneFileRevision: story.revisions.get(scene.filePath) ?? null,
        manuscriptPath: manuscript?.filePath ?? (typeof scene.raw.manuscript === "string" ? scene.raw.manuscript : null),
        manuscriptRevision: manuscript ? sourceEntityRevision(manuscript) : null,
        manuscriptFileRevision: manuscript ? story.revisions.get(manuscript.filePath) ?? null : null,
      };
    }),
    action("story.volumes.tree", read, objectSchema, async (_input, context) => {
      const tree = getVolumeTree(await readStorySnapshot(context.reader)).data;
      return { tree, revision: contentRevision(tree) };
    }),
    action("story.threads.overview", read, objectSchema, async (_input, context) => getThreadsOverview(await readStorySnapshot(context.reader)).data),
    action("story.threads.status", read, fieldSchema([], ["at", "threadId"]), async (input, context) => (await getThreadStatus({ ...await readStorySnapshot(context.reader, { includeManuscripts: true }), ...(typeof input.at === "string" ? { at: input.at } : {}), ...(typeof input.threadId === "string" ? { threadId: input.threadId } : {}) })).data),
    action("story.threads.lifecycle", read, fieldSchema([], ["threadId"]), async (input, context) => {
      const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
      const scenes = collectSceneTextInputs(story).data;
      const lifecycle = await analyzeThreadLifecycles({ ...story, scenes });
      const ids = typeof input.threadId === "string" ? new Set([input.threadId]) : null;
      return { snapshots: lifecycle.data.snapshots.filter((item) => !ids || ids.has(item.threadId)), warnings: lifecycle.data.warnings.filter((item) => !ids || ids.has(item.threadId)) };
    }),
    action("story.graph.query", read, fieldSchema([], ["types"]), async (input, context) => {
      if (input.types !== undefined && (!Array.isArray(input.types) || !input.types.every((type) => typeof type === "string"))) throw new TypeError("types must be a string array");
      const graph = getGraphData({ ...await readStorySnapshot(context.reader), types: input.types as StoryEntityType[] | undefined }).data;
      const maxNodes = typeof input.maxNodes === "number" && Number.isInteger(input.maxNodes) ? Math.max(1, Math.min(2000, input.maxNodes)) : 1000;
      const nodes = graph.nodes.slice(0, maxNodes);
      const nodeIds = new Set(nodes.map((node) => node.id));
      return { nodes, edges: graph.edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)) };
    }),
    action("story.cooccurrence", read, objectSchema, async (input, context) => {
      if (input.sceneIds !== undefined && (!Array.isArray(input.sceneIds) || input.sceneIds.length > 10_000 || !input.sceneIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 256))) {
        throw new TypeError("sceneIds must be an array of at most 10000 scene IDs");
      }
      const story = await readStorySnapshot(context.reader);
      return buildStoryCooccurrence({ ...story, sceneIds: input.sceneIds as string[] | undefined });
    }),
    action("story.map.query", read, objectSchema, async (_input, context) => buildLocationMap(await readStorySnapshot(context.reader)).data),
    action("story.timeline.query", read, fieldSchema([], ["sceneId"]), async (input, context) => {
      const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
      const entries = buildSceneTimelineEntries({ snapshot: context.reader.snapshot, scenes: timelineInputs(story) }).data;
      return typeof input.sceneId === "string" ? entries.filter((entry) => entry.sceneId === input.sceneId) : entries;
    }),
    action("story.world-state.at-scene", read, fieldSchema(["sceneId"], ["sceneId"]), async (input, context) => getWorldStateAtScene({ ...await readStorySnapshot(context.reader), sceneId: stringValue(input.sceneId, "sceneId") }).data),
    action("story.world-state.history", read, fieldSchema(["entityId"], ["entityId"]), async (input, context) => getEntityStateHistory({ ...await readStorySnapshot(context.reader), entityId: stringValue(input.entityId, "entityId") }).data),
    action("story.world-state.workbench", read, fieldSchema([], ["sceneId"]), async (input, context) => {
      const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
      const scenes = [...story.entities.values()].filter((entity) => entity.type === "scene");
      const events = listRuleStateEvents(story).data;
      const proposals = (await readStateProposals(context)).rows.map(normalizeStoredProposal);
      const sceneId = typeof input.sceneId === "string" ? input.sceneId : undefined;
      const filtered = sceneId ? proposals.filter((proposal) => proposal.event.sceneId === sceneId) : proposals;
      return { scenes, events: sceneId ? events.filter((event) => event.sceneId === sceneId) : events, proposals: filtered };
    }),
    action("story.state-proposals.list", read, fieldSchema([], ["sceneId", "status"]), async (input, context) => {
      const proposals = (await readStateProposals(context)).rows.map(normalizeStoredProposal);
      return proposals.filter((proposal) => (typeof input.sceneId !== "string" || proposal.event.sceneId === input.sceneId) && (typeof input.status !== "string" || proposal.status === input.status));
    }),
    action("story.state-proposals.create", propose, fieldSchema(["sceneId", "event"], ["sceneId", "id"]), async (input, context) => {
      const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
      const scene = story.entities.get(stringValue(input.sceneId, "sceneId"));
      if (scene?.type !== "scene") throw new TypeError(`Scene not found: ${String(input.sceneId)}`);
      const manuscript = typeof scene.raw.manuscript === "string" ? [...story.entities.values()].find((entity) => entity.filePath === scene.raw.manuscript)?.body ?? "" : "";
      const proposal = createStateEvent(input, scene, createHash("sha256").update(manuscript, "utf8").digest("hex"));
      validateEventReferences(proposal.event, story);
      const { rows, revision } = await readStateProposals(context);
      if (rows.some((row) => row.id === proposal.id)) throw Object.assign(new Error(`State proposal already exists: ${proposal.id}`), { code: "proposal_conflict" });
      const row = storedProposal(proposal);
      const writes = [...rows, row].map((value) => JSON.stringify(value)).join("\n") + "\n";
      const operation = buildOperation({ reader: context.reader, reads: [{ path: STATE_PROPOSALS_PATH, revision }], writes: [{ path: STATE_PROPOSALS_PATH, revision, content: writes }], message: `Propose world-state event for ${scene.id}`, effect: "metadata", operationId: requestedOperationId(input) });
      await context.propose([operation]);
      return proposal;
    }),
    action("story.state-proposals.update", propose, fieldSchema(["id", "event"], ["id"]), async (input, context) => {
      const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
      const { rows, revision } = await readStateProposals(context);
      const index = rows.findIndex((row) => row.id === input.id);
      if (index < 0) throw new TypeError(`State proposal not found: ${String(input.id)}`);
      const prior = normalizeStoredProposal(rows[index]!);
      if (prior.status !== "proposed" && prior.status !== "stale") throw new TypeError("State proposal is not editable");
      const scene = story.entities.get(String(prior.event.sceneId));
      if (scene?.type !== "scene") throw new TypeError("State proposal scene not found");
      const manuscript = typeof scene.raw.manuscript === "string" ? [...story.entities.values()].find((entity) => entity.filePath === scene.raw.manuscript)?.body ?? "" : "";
      const updated = createStateEvent({ id: prior.id, event: input.event }, scene, createHash("sha256").update(manuscript, "utf8").digest("hex"));
      validateEventReferences(updated.event, story);
      updated.createdAt = prior.createdAt;
      updated.history = [...prior.history, { action: "edited", at: updated.updatedAt, event: updated.event }];
      rows[index] = storedProposal(updated, rows[index]);
      const operation = buildOperation({ reader: context.reader, reads: [{ path: STATE_PROPOSALS_PATH, revision }], writes: [{ path: STATE_PROPOSALS_PATH, revision, content: stateProposalFile(rows) }], message: `Edit world-state proposal ${prior.id}`, effect: "metadata", operationId: requestedOperationId(input) });
      await context.propose([operation]);
      return updated;
    }),
    action("story.state-proposals.approve", propose, fieldSchema(["id"], ["id"]), async (input, context) => {
      const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
      const { rows, revision } = await readStateProposals(context);
      const index = rows.findIndex((row) => row.id === input.id);
      if (index < 0) throw new TypeError(`State proposal not found: ${String(input.id)}`);
      const prior = normalizeStoredProposal(rows[index]!);
      if (prior.status !== "proposed") throw new TypeError("State proposal is not approvable");
      if (prior.conflictEventIds.length || prior.duplicateOfProposalId) throw new TypeError("State proposal has unresolved conflicts or duplicates");
      const scene = story.entities.get(String(prior.event.sceneId));
      if (scene?.type !== "scene") throw new TypeError("State proposal scene not found");
      const event = { ...prior.event, source: "manual", status: "confirmed" };
      const rawEvents = Array.isArray(scene.raw.state_events) ? scene.raw.state_events : [];
      const updatedProposal = { ...prior, status: "approved", updatedAt: new Date().toISOString(), history: [...prior.history, { action: "approved", at: new Date().toISOString(), event }] };
      rows[index] = storedProposal(updatedProposal, rows[index]);
      const sceneFile = await readForWrite(context, scene.filePath);
      if (sceneFile.revision === null) throw new TypeError(`Scene file is missing: ${scene.filePath}`);
      const sceneRaw = { ...scene.raw, state_events: [...rawEvents, event] };
      const operation = buildOperation({
        reader: context.reader,
        reads: [{ path: scene.filePath, revision: sceneFile.revision }, { path: STATE_PROPOSALS_PATH, revision }],
        writes: [
          { path: scene.filePath, revision: sceneFile.revision, content: yamlContent(sceneRaw) },
          { path: STATE_PROPOSALS_PATH, revision, content: stateProposalFile(rows) },
        ],
        message: `Confirm world-state event from proposal ${prior.id}`,
        effect: "metadata",
        operationId: requestedOperationId(input),
      });
      await context.propose([operation]);
      return updatedProposal;
    }),
    action("story.state-proposals.reject", propose, fieldSchema(["id"], ["id"]), async (input, context) => {
      const { rows, revision } = await readStateProposals(context);
      const index = rows.findIndex((row) => row.id === input.id);
      if (index < 0) throw new TypeError(`State proposal not found: ${String(input.id)}`);
      const prior = normalizeStoredProposal(rows[index]!);
      if (prior.status !== "proposed" && prior.status !== "stale") throw new TypeError("State proposal is not rejectable");
      const updated = { ...prior, status: "rejected", updatedAt: new Date().toISOString(), history: [...prior.history, { action: "rejected", at: new Date().toISOString(), event: prior.event }] };
      rows[index] = storedProposal(updated, rows[index]);
      const operation = buildOperation({ reader: context.reader, reads: [{ path: STATE_PROPOSALS_PATH, revision }], writes: [{ path: STATE_PROPOSALS_PATH, revision, content: stateProposalFile(rows) }], message: `Reject world-state proposal ${prior.id}`, effect: "metadata", operationId: requestedOperationId(input) });
      await context.propose([operation]);
      return updated;
    }),
    action("story.state-proposals.stale", propose, fieldSchema(["sceneId"], ["sceneId"]), async (input, context) => {
      const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
      const scene = story.entities.get(stringValue(input.sceneId, "sceneId"));
      if (scene?.type !== "scene") throw new TypeError("Scene not found");
      const manuscript = typeof scene.raw.manuscript === "string" ? [...story.entities.values()].find((entity) => entity.filePath === scene.raw.manuscript)?.body ?? "" : "";
      const hash = createHash("sha256").update(manuscript, "utf8").digest("hex");
      const { rows, revision } = await readStateProposals(context);
      const changed: StateProposal[] = [];
      for (let index = 0; index < rows.length; index++) {
        const proposal = normalizeStoredProposal(rows[index]!);
        if (proposal.event.sceneId !== scene.id || proposal.status !== "proposed" || proposal.manuscriptHash === hash) continue;
        const updated = { ...proposal, status: "stale", updatedAt: new Date().toISOString(), history: [...proposal.history, { action: "stale", at: new Date().toISOString(), event: proposal.event }] };
        rows[index] = storedProposal(updated, rows[index]);
        changed.push(updated);
      }
      if (!changed.length) return [];
      const operation = buildOperation({ reader: context.reader, reads: [{ path: STATE_PROPOSALS_PATH, revision }], writes: [{ path: STATE_PROPOSALS_PATH, revision, content: stateProposalFile(rows) }], message: `Mark stale world-state proposals for ${scene.id}`, effect: "metadata", operationId: requestedOperationId(input) });
      await context.propose([operation]);
      return changed;
    }),
    action("story.reader-model.build", compute, fieldSchema(["chapterId"], ["chapterId"]), async (input, context) => {
      const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
      const chapterId = stringValue(input.chapterId, "chapterId");
      const chapter = story.entities.get(chapterId);
      if (chapter?.type !== "chapter") return null;
      const allScenes = sceneTextInputs(story);
      const sceneIdsInOrder = buildSceneLocationInfos(story).data;
      const orderBySceneId = new Map(sceneIdsInOrder.map((info) => [info.sceneId, info.order]));
      const tree = getVolumeTree(story).data;
      let upToOrder = 0;
      let reached = false;
      let selectedSceneIds: string[] = [];
      for (const volume of tree) for (const item of volume.chapters) {
        const chapterSceneIds = item.scenes.map((scene) => scene.id);
        for (const sceneId of chapterSceneIds) if (item.chapter.id === chapterId || !reached) upToOrder = Math.max(upToOrder, orderBySceneId.get(sceneId) ?? 0);
        if (item.chapter.id === chapterId) { selectedSceneIds = chapterSceneIds; reached = true; }
      }
      const disclosures = extractReaderDisclosures({ ...story, scenes: allScenes }).data;
      const events = listRuleStateEvents(story).data;
      const knowledgeGaps = diffReaderAndCharacterKnowledge({ ...story, disclosures, knowledgeEvents: events, scenes: allScenes, upToOrder }).data;
      const threadLife = await analyzeThreadLifecycles({ ...story, scenes: collectSceneTextInputs(story).data });
      const forgetRisks = computeThreadForgetRisks({ snapshot: context.reader.snapshot, snapshots: threadLife.data.snapshots, disclosures, orderBySceneId }).data;
      const maxOrder = Math.max(0, ...selectedSceneIds.map((id) => orderBySceneId.get(id) ?? 0));
      return { chapterId, disclosures: disclosures.filter((event) => event.order <= maxOrder), knowledgeGaps, forgetRisks, firstReadReaction: null };
    }),
    action("story.series.list", read, objectSchema, async (_input, context) => (await readSeriesSettings(context)).settings.series),
    action("story.series.get", read, fieldSchema(["id"], ["id"]), async (input, context) => (await readSeriesSettings(context)).settings.series.find((series) => series.id === input.id) ?? null),
    action("story.series.create", propose, fieldSchema(["name", "bibleRepositoryId"], ["name", "bibleRepositoryId", "ownerId", "base_revision", "baseRevision", "operation_id", "operationId"]), async (input, context) => {
      const { settings, revision } = await readSeriesSettings(context);
      assertSourceRevision(input, revision ?? "missing", "series settings revision");
      const name = stringValue(input.name, "name").trim();
      const bibleRepositoryId = stringValue(input.bibleRepositoryId, "bibleRepositoryId").trim();
      const created: SeriesRecord = { id: `series-${slugifyHint(name) || "series"}-${randomUUID().slice(0, 8)}`, name, ownerId: stringValue(input.ownerId ?? context.reader.snapshot.repository.ownerScope, "ownerId"), bibleRepositoryId, memberRepositoryIds: [], createdAt: new Date().toISOString() };
      settings.series.push(created);
      await proposeSeriesSettings(context, settings, revision, `Create Story series ${created.id}`, requestedOperationId(input));
      return created;
    }),
    action("story.series.update", propose, fieldSchema(["id", "patch"], ["base_revision", "baseRevision", "operation_id", "operationId"]), async (input, context) => {
      const { settings, revision } = await readSeriesSettings(context);
      assertSourceRevision(input, revision ?? "missing", "series settings revision");
      const index = settings.series.findIndex((series) => series.id === input.id);
      if (index < 0) throw new TypeError(`Series not found: ${String(input.id)}`);
      const patch = parseRecord(input.patch, "patch");
      const previous = settings.series[index]!;
      const next: SeriesRecord = {
        ...previous,
        name: patch.name !== undefined ? stringValue(patch.name, "name").trim() : previous.name,
        bibleRepositoryId: patch.bibleRepositoryId !== undefined ? stringValue(patch.bibleRepositoryId, "bibleRepositoryId").trim() : previous.bibleRepositoryId,
        memberRepositoryIds: Array.isArray(patch.memberRepositoryIds) ? [...new Set(patch.memberRepositoryIds.filter((id): id is string => typeof id === "string"))] : previous.memberRepositoryIds ?? [],
      };
      if (!next.name || !next.bibleRepositoryId) throw new TypeError("Series name and stable bibleRepositoryId are required");
      settings.series[index] = next;
      await proposeSeriesSettings(context, settings, revision, `Update Story series ${next.id}`, requestedOperationId(input));
      return next;
    }),
    action("story.series.delete", propose, fieldSchema(["id"], ["base_revision", "baseRevision", "operation_id", "operationId"]), async (input, context) => {
      const { settings, revision } = await readSeriesSettings(context);
      assertSourceRevision(input, revision ?? "missing", "series settings revision");
      const before = settings.series.length;
      settings.series = settings.series.filter((series) => series.id !== input.id);
      if (settings.series.length === before) throw new TypeError(`Series not found: ${String(input.id)}`);
      settings.bindings = settings.bindings.filter((binding) => binding.seriesId !== input.id);
      await proposeSeriesSettings(context, settings, revision, `Delete Story series ${String(input.id)}`, requestedOperationId(input));
      return { removed: true };
    }),
    action("story.series.binding.get", read, objectSchema, async (_input, context) => {
      const { settings } = await readSeriesSettings(context);
      const repositoryId = context.reader.snapshot.repository.repositoryId;
      const binding = settings.bindings.find((entry) => entry.repositoryId === repositoryId);
      if (!binding) return { binding: null, series: null, requiresAuthorReview: settings.bindings.some((entry) => !entry.repositoryId), unresolvedLegacyBindings: settings.bindings.filter((entry) => !entry.repositoryId).map((entry) => ({ legacyProjectId: entry.projectId, seriesId: entry.seriesId })) };
      const series = settings.series.find((entry) => entry.id === binding.seriesId);
      if (!series) return { binding, series: null, requiresAuthorReview: true, error: "bound_series_missing" };
      return { binding, bibleRepositoryId: series.bibleRepositoryId ?? null, series, requiresAuthorReview: !series.bibleRepositoryId, legacyBibleProjectId: series.bibleProjectId ?? null };
    }),
    action("story.series.binding.update", propose, fieldSchema(["seriesId"], ["base_revision", "baseRevision", "operation_id", "operationId", "bibleRev", "coverLabel"]), async (input, context) => {
      const { settings, revision } = await readSeriesSettings(context);
      assertSourceRevision(input, revision ?? "missing", "series settings revision");
      const series = settings.series.find((entry) => entry.id === input.seriesId);
      if (!series) throw new TypeError("Series not found");
      if (!series.bibleRepositoryId) throw Object.assign(new Error("The series Bible still uses a legacy project ID and requires author review before it can be linked."), { code: "author_review_required" });
      const repositoryId = context.reader.snapshot.repository.repositoryId;
      series.memberRepositoryIds = [...new Set([...(series.memberRepositoryIds ?? []), repositoryId])];
      const binding: WorkSeriesBinding = { repositoryId, seriesId: series.id };
      if (typeof input.bibleRev === "string" && input.bibleRev.trim()) binding.bibleRev = input.bibleRev.trim();
      if (typeof input.coverLabel === "string" && input.coverLabel.trim()) binding.coverLabel = input.coverLabel.trim();
      const index = settings.bindings.findIndex((item) => item.repositoryId === repositoryId);
      if (index < 0) settings.bindings.push(binding); else settings.bindings[index] = binding;
      await proposeSeriesSettings(context, settings, revision, `Bind work to Story series ${series.id}`, requestedOperationId(input));
      return { binding, bibleRepositoryId: series.bibleRepositoryId };
    }),
    action("story.series.binding.delete", propose, fieldSchema([], ["base_revision", "baseRevision", "operation_id", "operationId"]), async (input, context) => {
      const { settings, revision } = await readSeriesSettings(context);
      assertSourceRevision(input, revision ?? "missing", "series settings revision");
      const repositoryId = context.reader.snapshot.repository.repositoryId;
      const prior = settings.bindings.find((item) => item.repositoryId === repositoryId);
      if (!prior) throw new TypeError("Series binding not found");
      settings.bindings = settings.bindings.filter((item) => item.repositoryId !== repositoryId);
      const series = settings.series.find((item) => item.id === prior.seriesId);
      if (series?.memberRepositoryIds) series.memberRepositoryIds = series.memberRepositoryIds.filter((id) => id !== repositoryId);
      await proposeSeriesSettings(context, settings, revision, "Remove Story series binding", requestedOperationId(input));
      return { removed: true };
    }),
    action("story.series.overlay", read, objectSchema, async (_input, context) => {
      const { settings } = await readSeriesSettings(context);
      const repositoryId = context.reader.snapshot.repository.repositoryId;
      const binding = settings.bindings.find((item) => item.repositoryId === repositoryId);
      if (!binding) {
        if (settings.bindings.some((item) => !item.repositoryId)) throw Object.assign(new Error("Legacy series bindings must be resolved by the author before the overlay can be read."), { code: "author_review_required" });
        return null;
      }
      const series = settings.series.find((item) => item.id === binding.seriesId);
      if (!series) return null;
      if (!series.bibleRepositoryId) throw Object.assign(new Error("The series Bible repository ID is unresolved and requires author review."), { code: "author_review_required" });
      const linked = await context.linkedReader(series.bibleRepositoryId);
      const work = await readStorySnapshot(context.reader);
      const bible = await readStorySnapshot(linked);
      const merged = mergeSeriesOverlay({ snapshot: context.reader.snapshot, workEntities: work.entities, workLinks: work.links, bibleEntities: bible.entities, bibleLinks: bible.links }).data;
      return { entities: [...merged.entities.values()], links: merged.links, workSnapshot: context.reader.snapshot, bibleSnapshot: linked.snapshot, binding, series };
    }),
  ];
}

export function createStoryActions(context: ModuleContext): ModuleAction[] {
  return makeActions(context as StoryCapabilityContext);
}
