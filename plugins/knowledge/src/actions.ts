import { normalizeUnicode } from "../../shared/unicode.js";
import { buildLocationMap } from "./domain/locationMap.js";
import { mergeSeriesOverlay } from "./domain/seriesOverlay.js";
import {
  buildSceneContext, buildSceneLocationInfos, buildStoryCooccurrence, buildThreadLifecycle,
  buildSceneTimelineEntries, buildEntityStateHistory, computeThreadForgetRisks,
  detectThreadLifecycleWarnings, diffReaderAndCharacterKnowledge, extractReaderDisclosures,
  findThreadMentionsByKeyword, getBacklinks, getEntityAppearances, getGraphData, getLinkedEntities,
  getThreadsOverview, getVolumeTree, getWorldStateAtScene, listRuleStateEvents,
} from "./domain/index.js";
import type { GuestHost, HostCall, Handler } from "../../shared/guest.js";
import { HOST_OPERATIONS, invokeAction } from "../../shared/operations.js";
import type { ActionRequest, Scope, Snapshot } from "../../../app/src/browser/proprium/authoring/types.js";
import { attachSceneManuscripts, createSnapshotReader, readKnowledgeSnapshot, readOptionalPath, type LoadedKnowledgeSnapshot, type StoryFile } from "./snapshot.js";
import { sha256Hex } from "./sha256.js";
import { seriesBindingPreferenceKey } from "./seriesBindingFingerprint.js";
import type { StoryEntity, StoryEntityType } from "./domain/types.js";
import { buildMentionDictionary, findMentions } from "./domain/mentionIndex.js";
import { appendProposedTextToNotes, collectNotesPlainTexts, normalizeNotes } from "./notes.js";
import { stableRecordId, submitProposal, type ProposalRead, type ProposalWrite } from "./changeProposal.js";
import { compileKnowledgeChanges } from "./changeCompiler.js";
import YAML from "yaml";

const PLUGIN_ID = "proprium.knowledge";
const ENTITY_TYPES: readonly StoryEntityType[] = ["character", "location", "item", "faction", "event", "thread", "scene", "chapter", "volume", "arc", "lore", "manuscript", "dialogue_sketch"];
const PAGE_DEFAULT = 50;
const KNOWLEDGE_META = "meta/proprium/plugins/proprium.knowledge/v1";
const STATE_PROPOSALS_PATH = `${KNOWLEDGE_META}/state-proposals.jsonl`;
const ZUKAN_SUGGESTIONS_PATH = `${KNOWLEDGE_META}/zukan-suggestions.jsonl`;
const SERIES_PATH = `${KNOWLEDGE_META}/series.yaml`;
const SERIES_BINDING_PATH = `${KNOWLEDGE_META}/series-binding.yaml`;
const LEGACY_META_ROOT = "meta/scriptorium/modules/story";
const LEGACY_STATE_PROPOSALS_PATH = `${LEGACY_META_ROOT}/state-proposals.jsonl`;
const LEGACY_ZUKAN_SUGGESTIONS_PATH = `${LEGACY_META_ROOT}/zukan-suggestions.jsonl`;
const LEGACY_SERIES_PATH = `${LEGACY_META_ROOT}/v1/series.json`;

let cachedKey = "";
let cachedStory: LoadedKnowledgeSnapshot | undefined;

function error(code: string, message: string, details?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code, retryable: code === "snapshot_stale" || code === "repository_unavailable", ...(details ? { details } : {}) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

function assertKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw error("invalid_input", `Unknown input field: ${unknown[0]}`);
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw error("invalid_input", `${key} must be a non-empty string`);
  return value;
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw error("invalid_input", `${key} must be a non-empty string`);
  return value;
}

function pageOptions(input: Record<string, unknown>, snapshotId: string, filters: Record<string, unknown>): { offset: number; limit: number } {
  const limit = input.limit === undefined ? PAGE_DEFAULT : input.limit;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 200) throw error("invalid_input", "limit must be between 1 and 200");
  if (input.cursor === undefined) return { offset: 0, limit: limit as number };
  if (typeof input.cursor !== "string" || input.cursor.length > 2048) throw error("invalid_input", "cursor is invalid");
  let cursor: unknown;
  try { cursor = JSON.parse(decodeURIComponent(input.cursor)); } catch { throw error("invalid_input", "cursor is invalid"); }
  if (!isRecord(cursor) || cursor.snapshot !== snapshotId || JSON.stringify(cursor.filters) !== JSON.stringify(filters) ||
      !Number.isSafeInteger(cursor.offset) || (cursor.offset as number) < 0) throw error("snapshot_stale", "cursor does not belong to these filters and snapshot");
  return { offset: cursor.offset as number, limit: limit as number };
}

function nextCursor(snapshotId: string, filters: Record<string, unknown>, offset: number, total: number): string | null {
  return offset < total ? encodeURIComponent(JSON.stringify({ snapshot: snapshotId, filters, offset })) : null;
}

function* storyFor(context: ActionRequest, host: GuestHost, allowDataDiagnostics = false): Generator<HostCall, LoadedKnowledgeSnapshot, unknown> {
  const key = JSON.stringify([context.scope, context.snapshot]);
  let story: LoadedKnowledgeSnapshot;
  if (cachedKey === key && cachedStory) story = cachedStory;
  else {
    const reader = createSnapshotReader(context, host);
    story = yield* readKnowledgeSnapshot(reader);
    cachedKey = key;
    cachedStory = story;
  }
  if (!allowDataDiagnostics) {
    const malformed = story.diagnostics.find((item) => ["unsupported_format", "invalid_encoding", "invalid_path"].includes(item.code));
    if (malformed) throw error(malformed.code === "invalid_path" ? "invalid_path" : "unsupported_format", malformed.message, { path: malformed.path, snapshot: context.snapshot });
  }
  return story;
}

function* storyWithScenes(context: ActionRequest, host: GuestHost, sceneIds?: ReadonlySet<string>): Generator<HostCall, LoadedKnowledgeSnapshot, unknown> {
  const base = yield* storyFor(context, host);
  const story = yield* attachSceneManuscripts(createSnapshotReader(context, host), base, sceneIds);
  for (const scene of base.entities.values()) {
    if (scene.type !== "scene" || (sceneIds && !sceneIds.has(scene.id)) || typeof scene.raw.manuscript !== "string") continue;
    if (story.diagnostics.some((item) => item.code === "invalid_path" && item.entityId === scene.id)) throw error("invalid_path", `Scene ${scene.id} has an unsafe manuscript path`, { path: scene.raw.manuscript, sceneId: scene.id, snapshot: context.snapshot });
    if (!story.files.has(scene.raw.manuscript)) throw error("file_not_found", `Scene manuscript is missing: ${scene.raw.manuscript}`, { path: scene.raw.manuscript, sceneId: scene.id, snapshot: context.snapshot });
  }
  return story;
}

function entityRevision(entity: StoryEntity, story: LoadedKnowledgeSnapshot): string {
  const revision = story.revisions.get(entity.filePath);
  if (!revision) throw error("file_not_found", `Entity source file is missing: ${entity.filePath}`, { kind: "entity_not_found", path: entity.filePath });
  return revision;
}

function entityCard(entity: StoryEntity, story: LoadedKnowledgeSnapshot): Record<string, unknown> {
  const revision = entityRevision(entity, story);
  return {
    id: entity.id, type: entity.type,
    ...(entity.name !== undefined ? { name: entity.name } : {}),
    ...(entity.aliases !== undefined ? { aliases: entity.aliases } : {}),
    ...(entity.tags !== undefined ? { tags: entity.tags } : {}),
    ...(entity.status !== undefined ? { status: entity.status } : {}),
    filePath: entity.filePath, entityRevision: revision, fileRevision: revision, raw: entity.raw,
  };
}

function getEntity(story: LoadedKnowledgeSnapshot, id: string): StoryEntity {
  const duplicate = story.duplicateIds.get(id);
  if (duplicate) throw error("ambiguous_identity", `Entity ID ${id} appears in multiple source files`, { kind: "entity_ambiguous", paths: duplicate });
  const entity = story.entities.get(id);
  if (!entity) throw error("file_not_found", `Entity ${id} was not found in this snapshot`, { kind: "entity_not_found", id });
  return entity;
}

function collectionRevision(story: LoadedKnowledgeSnapshot): string {
  const rows = [...story.files.values()]
    .filter((file) => /^(?:bible|plot)\//u.test(file.path) && /\.(?:yaml|yml)$/u.test(file.path))
    .map((file) => [file.path, file.revision] as const)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return sha256Hex(JSON.stringify(rows));
}

function sourceFiles(entity: StoryEntity, story: LoadedKnowledgeSnapshot): Array<{ path: string; revision: string }> {
  const result = [{ path: entity.filePath, revision: entityRevision(entity, story) }];
  if (entity.type === "character" && entity.filePath.endsWith("/profile.yaml")) {
    const voicePath = entity.filePath.replace(/profile\.yaml$/u, "voice.yaml");
    const revision = story.revisions.get(voicePath);
    if (revision) result.push({ path: voicePath, revision });
  }
  return result;
}

function orderedScenes(story: LoadedKnowledgeSnapshot): Array<{ entity: StoryEntity; order: number; volumeId: string; chapterId: string }> {
  const rows: Array<{ entity: StoryEntity; order: number; volumeId: string; chapterId: string }> = [];
  let order = 0;
  for (const volume of getVolumeTree(story).data) {
    for (const chapter of volume.chapters) {
      for (const entity of chapter.scenes) rows.push({ entity, order: ++order, volumeId: volume.volume.id, chapterId: chapter.chapter.id });
    }
  }
  return rows;
}

function sceneTextInputs(story: LoadedKnowledgeSnapshot) {
  return orderedScenes(story).map(({ entity, order, volumeId }) => {
    const context = buildSceneContext({ ...story, sceneId: entity.id }).data;
    return { sceneId: entity.id, order, text: context?.manuscriptBody ?? "", volumeId };
  });
}

function sourceErrorIfSceneMissing(scene: StoryEntity | undefined, sceneId: string): StoryEntity {
  if (!scene || scene.type !== "scene") throw error("scene_not_found", `Scene ${sceneId} does not exist in this snapshot`, { sceneId });
  return scene;
}

function sceneReferences(story: LoadedKnowledgeSnapshot, sceneId: string): Record<string, unknown> {
  const scene = sourceErrorIfSceneMissing(story.entities.get(sceneId), sceneId);
  const lookup = (id: unknown): unknown => {
    if (typeof id !== "string") return undefined;
    if (story.duplicateIds.has(id)) return { id, status: "ambiguous", paths: story.duplicateIds.get(id) };
    const entity = story.entities.get(id);
    return entity ? { id, status: "resolved", type: entity.type, name: entity.name, path: entity.filePath, revision: story.revisions.get(entity.filePath) ?? null } : { id, status: "missing" };
  };
  const resolveLink = (value: unknown): unknown => {
    if (typeof value === "string") return lookup(value);
    if (!isRecord(value)) return undefined;
    const id = value.target ?? value.to ?? value.scene ?? value.id;
    const resolved = lookup(id);
    return resolved && typeof value.note === "string" ? { ...(resolved as Record<string, unknown>), note: value.note } : resolved;
  };
  const values = (value: unknown): unknown[] => {
    if (Array.isArray(value)) return value.map(resolveLink).filter(Boolean);
    const resolved = resolveLink(value);
    return resolved ? [resolved] : [];
  };
  const unresolvedReferences = story.links.filter((link) => link.from === sceneId && !story.entities.has(link.to)).map((link) => ({ id: link.to, kind: link.kind, ambiguous: story.duplicateIds.has(link.to) }));
  const relations = Array.isArray(scene.raw.relations) ? scene.raw.relations : [];
  const files = sourceFiles(scene, story);
  return {
    sceneId,
    ...(typeof scene.raw.pov === "string" ? { pov: lookup(scene.raw.pov) } : {}),
    ...(typeof scene.raw.location === "string" ? { location: lookup(scene.raw.location) } : {}),
    appears: values(scene.raw.appears), mentions: values(scene.raw.mentions),
    relations, unresolvedReferences, sourceFiles: files,
  };
}

function threadProjection(story: LoadedKnowledgeSnapshot, sceneId?: string, staleThreshold = 5) {
  const scenes = sceneTextInputs(story);
  const threads = [...story.entities.values()].filter((entity) => entity.type === "thread");
  const mentions = findThreadMentionsByKeyword({ ...story, scenes }).data;
  const snapshots = buildThreadLifecycle({ ...story, threads, scenes, mentionsByThread: mentions }).data;
  const warnings = detectThreadLifecycleWarnings({ ...story, snapshots, threads, scenes, options: { staleSceneThreshold: staleThreshold } }).data;
  const scopedScene = sceneId ? scenes.find((scene) => scene.sceneId === sceneId) : undefined;
  if (sceneId && !scopedScene) throw error("scene_not_found", `Scene ${sceneId} was not found in the Narrative hierarchy`, { sceneId });
  const sceneOrder = scopedScene?.order;
  const sceneOrderById = new Map(scenes.map((scene) => [scene.sceneId, scene.order]));
  const atStatus = (row: (typeof snapshots)[number]): string => {
    if (sceneOrder === undefined) return row.state === "recalled" ? "advanced" : row.state;
    const planted = row.plantedSceneId ? sceneOrderById.get(row.plantedSceneId) : undefined;
    const resolved = row.resolvedSceneId ? sceneOrderById.get(row.resolvedSceneId) : undefined;
    if (resolved !== undefined && resolved <= sceneOrder) return "resolved";
    if (planted === undefined || planted > sceneOrder) return "unset";
    if (row.recalledSceneIds.some((id) => (sceneOrderById.get(id) ?? Infinity) <= sceneOrder)) return "advanced";
    return "planted";
  };
  return { scenes, threads, mentions, snapshots, warnings, atStatus };
}

function pageSlice<T>(items: readonly T[], input: Record<string, unknown>, context: ActionRequest, filters: Record<string, unknown>) {
  const page = pageOptions(input, context.snapshot.id, filters);
  const rows = items.slice(page.offset, page.offset + page.limit);
  return { rows, nextCursor: nextCursor(context.snapshot.id, filters, page.offset + rows.length, items.length) };
}

function* snapshotStatus(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, []);
  const story = yield* storyFor(context, host, true);
  return { snapshot: context.snapshot, entityCount: story.entities.size, linkCount: story.links.length, diagnostics: story.diagnostics };
}

function* entityList(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, ["type", "tag", "cursor", "limit"]);
  const type = optionalString(input, "type");
  if (type && !ENTITY_TYPES.includes(type as StoryEntityType)) throw error("invalid_input", `Unknown entity type: ${type}`);
  const tag = optionalString(input, "tag");
  const filters = { ...(type ? { type } : {}), ...(tag ? { tag } : {}) };
  const story = yield* storyFor(context, host);
  const rows = [...story.entities.values()].filter((entity) => (!type || entity.type === type) && (!tag || entity.tags?.includes(tag)))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const page = pageSlice(rows, input, context, filters);
  return { items: page.rows.map((entity) => entityCard(entity, story)), nextCursor: page.nextCursor, collectionRevision: collectionRevision(story) };
}

function* entityCollectionRevision(_input: Record<string, unknown>, _context: ActionRequest, host: GuestHost) {
  assertKeys(_input, []);
  const story = yield* storyFor(_context, host);
  return { collectionRevision: collectionRevision(story) };
}

function* entityGet(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, ["id"]);
  const story = yield* storyFor(context, host);
  const entity = getEntity(story, requiredString(input, "id"));
  return { entity: entityCard(entity, story), sourceFiles: sourceFiles(entity, story) };
}

function* entityBacklinks(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, ["id", "cursor", "limit"]);
  const id = requiredString(input, "id");
  const story = yield* storyFor(context, host);
  getEntity(story, id);
  const rows = getBacklinks({ ...story, toId: id }).data.map(({ link, entity }) => ({
    sourceId: entity.id, sourceType: entity.type, sourcePath: entity.filePath, relationKind: link.kind,
    ...(link.note ? { note: link.note } : {}), revision: entityRevision(entity, story),
  }));
  const page = pageSlice(rows, input, context, { id });
  return { items: page.rows, nextCursor: page.nextCursor };
}

function* entityAppearances(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, ["id", "cursor", "limit"]);
  const id = requiredString(input, "id");
  const story = yield* storyFor(context, host);
  getEntity(story, id);
  const rows = getEntityAppearances({ ...story, entityId: id }).data.map(({ scene, volumeId, chapterId, kinds }) => ({
    sceneId: scene.id, ...(volumeId ? { volumeId } : {}), ...(chapterId ? { chapterId } : {}),
    order: Number(scene.raw.order ?? 0), kinds, sourceRevision: entityRevision(scene, story),
  }));
  const page = pageSlice(rows, input, context, { id });
  return { items: page.rows, nextCursor: page.nextCursor };
}

function* declaredVoice(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, ["id"]);
  const story = yield* storyFor(context, host);
  const entity = getEntity(story, requiredString(input, "id"));
  if (entity.type !== "character") throw error("invalid_input", "Declared voice is available only for a character entity");
  const voice = isRecord(entity.raw.voice) ? entity.raw.voice : {};
  const patterns = isRecord(entity.raw.voicePatterns) ? entity.raw.voicePatterns : {};
  const firstPerson = Array.isArray(patterns.firstPerson) ? patterns.firstPerson : Array.isArray(voice.firstPerson) ? voice.firstPerson : [];
  const sentenceEndings = Array.isArray(patterns.sentenceEndings) ? patterns.sentenceEndings : Array.isArray(voice.sentenceEndings) ? voice.sentenceEndings : [];
  return { firstPerson, sentenceEndings, ...(typeof voice.tone === "string" ? { tone: voice.tone } : {}), sourceFiles: sourceFiles(entity, story) };
}

function* freshness(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, ["id"]);
  const id = requiredString(input, "id");
  const base = yield* storyFor(context, host);
  const entity = getEntity(base, id);
  const mentionable = [...base.entities.values()].filter((item) => ["character", "location", "item", "faction", "event", "lore", "thread"].includes(item.type));
  const dictionary = buildMentionDictionary(mentionable);
  const story = yield* storyWithScenes(context, host);
  const mentioned = new Set(sceneTextInputs(story).filter((scene) => findMentions(dictionary, scene.text).includes(id)).map((scene) => scene.sceneId));
  const baseline = isRecord(entity.raw.notesMentionBaseline) && Array.isArray(entity.raw.notesMentionBaseline.sceneIds)
    ? entity.raw.notesMentionBaseline.sceneIds.filter((value): value is string => typeof value === "string") : null;
  const newMentionSceneIds = baseline ? [...mentioned].filter((sceneId) => !baseline.includes(sceneId)).sort() : [];
  return { newMentionCount: newMentionSceneIds.length, newMentionSceneIds, ...(baseline ? { baselineRevision: story.revisions.get(entity.filePath) ?? null } : {}) };
}

function* tagsList(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, []);
  const story = yield* storyFor(context, host);
  const tags = [...new Set([...story.entities.values()].flatMap((entity) => entity.tags ?? []))].sort();
  return { tags, sourceRevision: story.revisions.get("meta/tags.yaml") ?? null };
}

function* sceneReferencesGet(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, ["sceneId"]);
  const story = yield* storyFor(context, host);
  return sceneReferences(story, requiredString(input, "sceneId"));
}

function* sceneContext(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, ["sceneId"]);
  const sceneId = requiredString(input, "sceneId");
  const base = yield* storyFor(context, host);
  sourceErrorIfSceneMissing(base.entities.get(sceneId), sceneId);
  const story = yield* attachSceneManuscripts(createSnapshotReader(context, host), base, new Set([sceneId]));
  const view = buildSceneContext({ ...story, sceneId }).data;
  if (!view) throw error("scene_not_found", `Scene ${sceneId} was not found`);
  const card = (entity: StoryEntity | undefined) => entity ? entityCard(entity, story) : undefined;
  const ids = (kind: string) => getLinkedEntities({ ...story, fromId: sceneId, kind }).data;
  const sceneThreads = story.links.filter((link) => link.from === sceneId && ["plants", "advances"].includes(link.kind));
  return {
    sceneId, ...(view.pov ? { povId: view.pov.id } : {}), ...(view.location ? { locationId: view.location.id } : {}),
    appears: ids("appears").map((entity) => entityCard(entity, story)), mentions: ids("mentions").map((entity) => entityCard(entity, story)),
    plantedThreads: sceneThreads.filter((link) => link.kind === "plants").map((link) => link.to),
    advancedThreads: sceneThreads.filter((link) => link.kind === "advances").map((link) => link.to),
    entityCards: [card(view.pov), card(view.location), ...view.appears.map(card), ...view.mentions.map(card)].filter(Boolean),
    sourceFiles: [sourceFiles(view.scene, story)[0], ...(view.manuscript ? sourceFiles(view.manuscript, story) : [])],
  };
}

function* threadsOverview(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, ["cursor", "limit"]);
  const story = yield* storyFor(context, host);
  const rows = getThreadsOverview(story).data;
  const page = pageSlice(rows, input, context, {});
  const mapRefs = (refs: typeof rows[number]["planted"]) => refs.map((ref) => ({
    sceneId: ref.scene.id, title: ref.scene.name ?? ref.scene.id, path: ref.scene.filePath,
    revision: story.revisions.get(ref.scene.filePath) ?? null, ...(ref.note ? { note: ref.note } : {}),
  }));
  return { items: page.rows.map((row) => ({ thread: entityCard(row.thread, story), planted: mapRefs(row.planted), advanced: mapRefs(row.advanced), payoff: mapRefs(row.payoff) })), nextCursor: page.nextCursor };
}

function* threadsStatus(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, ["threadId", "atSceneId"]);
  const threadId = optionalString(input, "threadId");
  const atSceneId = optionalString(input, "atSceneId");
  const story = yield* storyWithScenes(context, host);
  const projection = threadProjection(story, atSceneId);
  if (threadId) getEntity(story, threadId);
  return { items: projection.snapshots.filter((item) => (!threadId || item.threadId === threadId) && projection.atStatus(item) !== "unset")
    .map((item) => ({ threadId: item.threadId, status: projection.atStatus(item), plantedSceneId: item.plantedSceneId, advancedSceneIds: item.recalledSceneIds, resolvedSceneId: item.resolvedSceneId, mentions: item.mentions })), snapshot: context.snapshot };
}

function* threadsLifecycle(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, ["threadId", "staleSceneThreshold"]);
  const threadId = optionalString(input, "threadId");
  const staleSceneThreshold = input.staleSceneThreshold === undefined ? 5 : input.staleSceneThreshold;
  if (!Number.isSafeInteger(staleSceneThreshold) || (staleSceneThreshold as number) < 1) throw error("invalid_input", "staleSceneThreshold must be a positive integer");
  const story = yield* storyWithScenes(context, host);
  const projection = threadProjection(story, undefined, staleSceneThreshold as number);
  return { snapshots: projection.snapshots.filter((row) => !threadId || row.threadId === threadId), warnings: projection.warnings.filter((row) => !threadId || row.threadId === threadId).map((row) => ({ code: row.code, severity: row.severity, threadId: row.threadId, sourcePath: row.filePath, message: row.message })) };
}

function* graphQuery(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, ["types", "maxNodes", "focusId", "hops"]);
  const types = input.types;
  if (types !== undefined && (!Array.isArray(types) || types.some((type) => typeof type !== "string" || !ENTITY_TYPES.includes(type as StoryEntityType)))) throw error("invalid_input", "types must be a list of known entity types");
  const maxNodes = input.maxNodes ?? 2000; const hops = input.hops ?? 1;
  if (!Number.isInteger(maxNodes) || (maxNodes as number) < 1 || (maxNodes as number) > 2000) throw error("invalid_input", "maxNodes must be between 1 and 2000");
  if (!Number.isInteger(hops) || (hops as number) < 1 || (hops as number) > 3) throw error("invalid_input", "hops must be between 1 and 3");
  const focusId = optionalString(input, "focusId");
  const story = yield* storyFor(context, host);
  const base = getGraphData({ ...story, ...(types ? { types: types as StoryEntityType[] } : {}) }).data;
  let nodes = base.nodes;
  let edges = base.edges;
  if (focusId) {
    const allowed = new Set(nodes.map((node) => node.id));
    const seen = new Set<string>(allowed.has(focusId) ? [focusId] : []);
    let frontier = new Set(seen);
    for (let depth = 0; depth < (hops as number); depth++) {
      const next = new Set<string>();
      for (const edge of edges) {
        if (frontier.has(edge.from) && allowed.has(edge.to)) next.add(edge.to);
        if (frontier.has(edge.to) && allowed.has(edge.from)) next.add(edge.from);
      }
      for (const id of next) seen.add(id);
      frontier = next;
    }
    nodes = nodes.filter((node) => seen.has(node.id));
    edges = edges.filter((edge) => seen.has(edge.from) && seen.has(edge.to));
  }
  if (nodes.length > (maxNodes as number)) {
    nodes = nodes.slice(0, maxNodes as number);
    const ids = new Set(nodes.map((node) => node.id));
    edges = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  }
  const brokenReferences = story.diagnostics.filter((row) => row.code === "broken_reference" || row.code === "duplicate_id")
    .map((row) => ({ ...(row.entityId ? { entityId: row.entityId } : {}), ...(row.path ? { path: row.path } : {}), message: row.message }));
  return { nodes, edges, brokenReferences, snapshot: context.snapshot };
}

function* graphCooccurrence(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, ["sceneIds"]);
  const sceneIds = input.sceneIds;
  if (sceneIds !== undefined && (!Array.isArray(sceneIds) || sceneIds.length > 10000 || sceneIds.some((id) => typeof id !== "string"))) throw error("invalid_input", "sceneIds must be a string list up to 10,000 items");
  const story = yield* storyFor(context, host);
  const result = buildStoryCooccurrence({ ...story, ...(sceneIds ? { sceneIds: sceneIds as string[] } : {}) });
  return { ...result, snapshot: context.snapshot };
}

function* mapQuery(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, []);
  const story = yield* storyFor(context, host);
  const result = buildLocationMap(story).data;
  const brokenReferences = story.diagnostics.filter((row) => row.code === "broken_reference" || row.code === "duplicate_id").map((row) => ({ path: row.path, entityId: row.entityId, message: row.message }));
  return { ...result, brokenReferences, snapshot: context.snapshot };
}

function* timelineQuery(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, ["sceneId", "chapterId", "characterId"]);
  const sceneId = optionalString(input, "sceneId"); const chapterId = optionalString(input, "chapterId"); const characterId = optionalString(input, "characterId");
  const base = yield* storyFor(context, host);
  const ordered = orderedScenes(base);
  const selected = ordered.filter((row) => (!sceneId || row.entity.id === sceneId) && (!chapterId || row.chapterId === chapterId) &&
    (!characterId || base.links.some((link) => link.from === row.entity.id && link.to === characterId && link.kind === "appears")));
  if (sceneId && !selected.length) throw error("scene_not_found", `Scene ${sceneId} is not in the pinned hierarchy`, { sceneId });
  const story = yield* attachSceneManuscripts(createSnapshotReader(context, host), base, new Set(selected.map((row) => row.entity.id)));
  const inputs = selected.map(({ entity, order, chapterId: chapter }) => {
    const sceneContext = buildSceneContext({ ...story, sceneId: entity.id }).data;
    return {
      sceneId: entity.id, order, text: sceneContext?.manuscriptBody ?? "",
      title: entity.name ?? entity.id,
      explicitDateMeta: [entity.raw.date, entity.raw.storyDate, entity.raw.calendarDate].some((value) => typeof value === "string"),
      locationId: sceneContext?.location?.id, locationName: sceneContext?.location?.name,
      characters: sceneContext?.appears.filter((item) => item.type === "character").map((item) => ({ id: item.id, name: item.name ?? item.id })),
      chapterId: chapter, chapterName: story.entities.get(chapter)?.name ?? chapter,
    };
  });
  const result = buildSceneTimelineEntries({ snapshot: context.snapshot, scenes: inputs }).data;
  const sourceFiles = [...new Map(selected.flatMap(({ entity }) => {
    const manuscript = typeof entity.raw.manuscript === "string" ? entity.raw.manuscript : undefined;
    return [{ path: entity.filePath, revision: story.revisions.get(entity.filePath) }, ...(manuscript ? [{ path: manuscript, revision: story.revisions.get(manuscript) }] : [])];
  }).filter((row): row is { path: string; revision: string } => Boolean(row.revision)).map((row) => [row.path, row])).values()];
  return { items: result, snapshot: context.snapshot, sourceFiles };
}

function* worldStateAtScene(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, ["sceneId"]);
  const sceneId = requiredString(input, "sceneId");
  const story = yield* storyFor(context, host);
  const scene = sourceErrorIfSceneMissing(story.entities.get(sceneId), sceneId);
  const position = orderedScenes(story).find((row) => row.entity.id === sceneId);
  if (!position) throw error("scene_not_found", `Scene ${sceneId} is missing its Narrative parent identity`);
  const state = getWorldStateAtScene({ ...story, sceneId }).data;
  const events = listRuleStateEvents(story).data.filter((event) => event.order <= position.order && (!event.status || event.status === "confirmed"));
  const storyWithText = yield* storyWithScenes(context, host, new Set(orderedScenes(story).filter((row) => row.order <= position.order).map((row) => row.entity.id)));
  const disclosureScenes = sceneTextInputs(storyWithText).filter((row) => row.order <= position.order).map((row) => {
    const entity = storyWithText.entities.get(row.sceneId)!;
    return { sceneId: row.sceneId, order: row.order, text: row.text, characterIds: getLinkedEntities({ ...storyWithText, fromId: row.sceneId, kind: "appears" }).data.filter((item) => item.type === "character").map((item) => item.id), stateChanges: [] };
  });
  const disclosures = extractReaderDisclosures({ ...storyWithText, scenes: disclosureScenes }).data;
  if (!state) throw error("scene_not_found", `Scene ${sceneId} has no resolvable ordered state`, { sceneId });
  const revisions = new Map([[scene.filePath, story.revisions.get(scene.filePath)!], ...(typeof scene.raw.manuscript === "string" && storyWithText.revisions.has(scene.raw.manuscript) ? [[scene.raw.manuscript, storyWithText.revisions.get(scene.raw.manuscript)!] as [string, string]] : [])]);
  return { ...state, confirmedEvents: events, readerDisclosures: disclosures, characterBeliefs: { availability: "unavailable", reason: "not_implemented" }, sourceFiles: [...revisions].map(([path, revision]) => ({ path, revision })) };
}

function* worldStateHistory(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, ["entityId", "cursor", "limit"]);
  const entityId = requiredString(input, "entityId");
  const story = yield* storyFor(context, host);
  getEntity(story, entityId);
  const result = buildEntityStateHistory({ snapshot: story.snapshot, entityId, events: listRuleStateEvents(story).data }).data;
  if (!result) return { entityId, entries: [], nextCursor: null, snapshot: context.snapshot };
  const page = pageSlice(result.entries, input, context, { entityId });
  return { entityId, entries: page.rows, nextCursor: page.nextCursor, snapshot: context.snapshot };
}

function* readerModelBuild(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, ["chapterId"]);
  const chapterId = requiredString(input, "chapterId");
  const base = yield* storyFor(context, host);
  const tree = getVolumeTree(base).data;
  const chapterRows = tree.flatMap((volume) => volume.chapters.map((chapter) => ({ volume, chapter }))).find(({ chapter }) => chapter.chapter.id === chapterId);
  if (!chapterRows) throw error("file_not_found", `Chapter ${chapterId} not found`, { kind: "chapter_not_found" });
  const chapterOrder = orderedScenes(base).filter((row) => row.chapterId === chapterId).at(-1)?.order;
  if (chapterOrder === undefined) throw error("unsupported_format", `Chapter ${chapterId} has no scenes to analyze`);
  const selectedIds = new Set(orderedScenes(base).filter((row) => row.order <= chapterOrder).map((row) => row.entity.id));
  const story = yield* storyWithScenes(context, host, selectedIds);
  const allScenes = sceneTextInputs(story).filter((row) => row.order <= chapterOrder);
  const disclosureScenes = allScenes.map((row) => ({ sceneId: row.sceneId, order: row.order, text: row.text,
    characterIds: getLinkedEntities({ ...story, fromId: row.sceneId, kind: "appears" }).data.filter((entity) => entity.type === "character").map((entity) => entity.id), stateChanges: [] }));
  const disclosures = extractReaderDisclosures({ ...story, scenes: disclosureScenes }).data;
  const knowledgeEvents = listRuleStateEvents(story).data.filter((event) => event.kind === "knowledge" && (!event.status || event.status === "confirmed"));
  const knowledgeGaps = diffReaderAndCharacterKnowledge({ ...story, disclosures, knowledgeEvents, scenes: disclosureScenes, upToOrder: chapterOrder }).data;
  const lifecycle = threadProjection(story);
  const orderBySceneId = new Map(allScenes.map((scene) => [scene.sceneId, scene.order]));
  const forgetRisks = computeThreadForgetRisks({ snapshot: context.snapshot, snapshots: lifecycle.snapshots, disclosures, orderBySceneId }).data;
  return { chapterId, disclosures: disclosures.filter((event) => event.order <= chapterOrder), knowledgeGaps, forgetRisks, firstReadReaction: null, snapshot: context.snapshot };
}

function* tagsSuggested(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, ["id"]);
  const id = requiredString(input, "id");
  const story = yield* storyFor(context, host);
  const entity = getEntity(story, id);
  const configFile = story.files.get("meta/tags.yaml");
  const config = configFile ? importYaml(configFile.content) : {};
  const categories = isRecord(config) && isRecord(config.categories) ? config.categories : {};
  const notes = normalizeNotes(entity.raw.notes);
  const texts = [...(entity.name ? [entity.name] : []), ...(entity.aliases ?? []), ...(entity.keywords ?? []), ...(notes ? collectNotesPlainTexts(notes) : [])];
  const corpus = texts.join("\n");
  if (new TextEncoder().encode(corpus).byteLength > 1024 * 1024) throw error("capacity", "Entity note text is too large for tokenizer candidate generation");
  const found = new Set<string>();
  const tokenizerIdentity = { plugin_id: "proprium.research", action_id: "research.nlp.analyze" };
  let analysis: { tokens: Array<{ surface: string; pos?: string }> };
  try { analysis = yield* invokeAction<{ tokens: Array<{ surface: string; pos?: string }> }>(host, "proprium.research", "research.nlp.analyze", { text: corpus, source: { kind: "literal" } }); }
  catch (cause) {
    const code = (cause as { code?: string } | null)?.code;
    if (code === "dependency_unavailable" || code === "plugin_unavailable" || code === "missing_capability") throw error("missing_capability", "Suggested tags require the optional Research tokenizer", { capability: "research.tokenizer" });
    throw cause;
  }
  let current = "";
  const flush = () => { if (current.length >= 2 && !/^[\s\p{P}\p{S}0-9]+$/u.test(current)) found.add(current); current = ""; };
  for (const token of analysis.tokens) { if (token.pos === "名詞") current += token.surface; else flush(); }
  flush();
  const keywordScores = new Map<string, number>();
  for (const [category, values] of Object.entries(categories)) {
    if (!Array.isArray(values)) continue;
    const keywords = values.filter((value): value is string => typeof value === "string");
    const count = keywords.filter((keyword) => found.has(keyword)).length;
    if (keywords.length && count) keywordScores.set(category, count / keywords.length);
  }
  const mentionDictionary = buildMentionDictionary(story.entities.values());
  const mentionedIds = new Set(texts.flatMap((text) => findMentions(mentionDictionary, text)).filter((candidate) => candidate !== id));
  const counts = new Map<string, number>();
  for (const mentionedId of mentionedIds) for (const tag of story.entities.get(mentionedId)?.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  const items = [...new Set([...keywordScores.keys(), ...counts.keys()])].filter((tag) => !entity.tags?.includes(tag)).map((tag) => {
    const keywordScore = keywordScores.get(tag) ?? 0;
    const mentionScore = mentionedIds.size ? (counts.get(tag) ?? 0) / mentionedIds.size : 0;
    return { tag, score: keywordScore * 0.6 + mentionScore * 0.4, reason: keywordScore && mentionScore ? "both" as const : keywordScore ? "keyword" as const : "mention" as const };
  }).filter((row) => row.score >= 0.3).sort((a, b) => b.score - a.score);
  return { items, snapshot: context.snapshot, tokenizerIdentity };
}

function importYaml(text: string): unknown { return YAML.parse(text); }

function noteBlockMap(value: unknown, sourcePath: string): Map<string, string> {
  if (value === undefined || value === null) return new Map();
  const notes = normalizeNotes(value);
  if (!notes) throw error("unsupported_format", "Structured notes are malformed and cannot be losslessly updated", { field: "notes", sourcePath });
  const result = new Map<string, string>();
  const addBlocks = (prefix: string, blocks: typeof notes.lead) => blocks.forEach((block, index) => result.set(`${prefix}.${index}`, JSON.stringify(block)));
  const addSections = (sections: typeof notes.sections, parent: string) => sections.forEach((section, index) => {
    const path = `${parent}.${index}`;
    addBlocks(`${path}.body`, section.body);
    addSections(section.children, `${path}.children`);
  });
  addBlocks("lead", notes.lead);
  addSections(notes.sections, "sections");
  return result;
}

function changedNoteBlockPaths(before: unknown, after: unknown): Set<string> {
  const oldBlocks = noteBlockMap(before, "current notes");
  const newBlocks = noteBlockMap(after, "patched notes");
  return new Set([...new Set([...oldBlocks.keys(), ...newBlocks.keys()])].filter((path) => oldBlocks.get(path) !== newBlocks.get(path)));
}

interface JsonlDocument { file: StoryFile | null; rows: Array<Record<string, unknown>> }
function* readJsonl(context: ActionRequest, host: GuestHost, path: string, label: string, legacyPath?: string): Generator<HostCall, JsonlDocument, unknown> {
  const reader = createSnapshotReader(context, host);
  const current = yield* readOptionalPath(reader, path);
  const legacy = legacyPath ? yield* readOptionalPath(reader, legacyPath) : null;
  const parseRows = (file: StoryFile, sourcePath: string): Array<Record<string, unknown>> => {
    const parsed: Array<Record<string, unknown>> = [];
    const ids = new Set<string>();
    for (const [index, line] of file.content.split(/\r?\n/u).entries()) {
      if (!line.trim()) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch { throw error("unsupported_format", `Malformed ${label} JSONL row ${index + 1}`, { path: sourcePath, line: index + 1 }); }
      if (!isRecord(value) || typeof value.id !== "string" || !value.id) throw error("unsupported_format", `Malformed ${label} identity on row ${index + 1}`, { path: sourcePath, line: index + 1 });
      if (ids.has(value.id)) throw error("ambiguous_identity", `Duplicate ${label} identity ${value.id}`, { path: sourcePath, id: value.id });
      ids.add(value.id); parsed.push(value);
    }
    return parsed;
  };
  const currentRows = current ? parseRows(current, path) : [];
  const legacyRows = legacy ? parseRows(legacy, legacyPath!) : [];
  if (current && legacy && canonicalJson(currentRows) !== canonicalJson(legacyRows)) {
    throw error("conflict", `Legacy and Proprium ${label} stores differ`, { currentPath: path, currentRevision: current.revision, legacyPath, legacyRevision: legacy.revision, kind: "metadata_reconciliation_required" });
  }
  const file = legacy ?? current;
  const rows = legacy ? legacyRows : currentRows;
  if (!file) return { file: null, rows: [] };
  return { file, rows };
}

function* stableTimestamp(context: ActionRequest, host: GuestHost): Generator<HostCall, string, unknown> {
  const key = context.idempotency_key;
  if (!key || !key.trim()) throw error("invalid_input", "Host idempotency_key is required for a proposal");
  const result = yield* host.request<{ timestamp: string }>("workspace.change.timestamp", {
    scope: context.scope, plugin_id: context.plugin_id, action_id: context.action_id, idempotency_key: key,
  });
  if (!result || typeof result.timestamp !== "string" || Number.isNaN(Date.parse(result.timestamp))) throw error("guest_trap", "Host returned an invalid stable proposal timestamp");
  return result.timestamp;
}

function jsonlContent(rows: readonly Record<string, unknown>[]): string {
  return rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "";
}

function assertStateProposal(value: Record<string, unknown>, path: string): void {
  if (!isRecord(value.event) || typeof value.event.sceneId !== "string" || !Number.isInteger(value.event.order) ||
      !["location", "acquaintance", "ownership", "knowledge"].includes(String(value.event.kind)) || typeof value.event.subject !== "string" ||
      !(value.event.object === null || typeof value.event.object === "string") || !isRecord(value.event.payload) ||
      !["rule", "llm-draft", "manual-draft", "manual"].includes(String(value.event.source)) ||
      !["proposed", "confirmed"].includes(String(value.event.status)) ||
      !["proposed", "stale", "approved", "rejected"].includes(String(value.status)) ||
      typeof value.manuscriptHash !== "string" || !Array.isArray(value.conflictEventIds) || !Array.isArray(value.history)) {
    throw error("unsupported_format", `Malformed StateProposal row ${String(value.id)}`, { path, id: value.id });
  }
}

function assertSuggestion(value: Record<string, unknown>, path: string): void {
  if (typeof value.entityId !== "string" || typeof value.blockPath !== "string" || typeof value.proposedText !== "string" ||
      !Array.isArray(value.evidence) || !["pending", "approved", "rejected", "stale"].includes(String(value.status)) ||
      !["manuscript", "dialogue-sketch", "sandbox"].includes(String(value.source))) {
    throw error("unsupported_format", `Malformed ZukanSuggestion row ${String(value.id)}`, { path, id: value.id });
  }
}

function suggestionView(row: Record<string, unknown>): Record<string, unknown> {
  if (row.source !== "sandbox") return row;
  return {
    ...row,
    source: "dialogue-sketch",
    sourceId: row.sourceId ?? row.sourceSessionId ?? null,
    sourceRange: row.sourceRange ?? row.sourceTurnRange ?? null,
    sourceRevision: row.sourceRevision ?? null,
    legacySource: "sandbox",
    sourceRevisionAvailable: typeof row.sourceRevision === "string",
  };
}

function* stateProposalsList(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, ["sceneId", "status", "cursor", "limit"]);
  const sceneId = optionalString(input, "sceneId");
  const status = optionalString(input, "status");
  if (status && !["proposed", "stale", "approved", "rejected"].includes(status)) throw error("invalid_input", "status is not a valid proposal status");
  const doc = yield* readJsonl(context, host, STATE_PROPOSALS_PATH, "StateProposal", LEGACY_STATE_PROPOSALS_PATH);
  const rows = doc.rows.filter((row) => {
    try { assertStateProposal(row, STATE_PROPOSALS_PATH); } catch (cause) { throw cause; }
    return (!sceneId || (row.event as Record<string, unknown>).sceneId === sceneId) && (!status || row.status === status);
  });
  const page = pageSlice(rows, input, context, { ...(sceneId ? { sceneId } : {}), ...(status ? { status } : {}) });
  return { items: page.rows, nextCursor: page.nextCursor, proposalFileRevision: doc.file?.revision ?? null };
}

function* suggestionsList(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, ["entityId", "status", "cursor", "limit"]);
  const entityId = optionalString(input, "entityId");
  const status = input.status === undefined ? "all" : requiredString(input, "status");
  if (!["pending", "approved", "rejected", "stale", "all"].includes(status)) throw error("invalid_input", "status is not a valid suggestion status");
  const doc = yield* readJsonl(context, host, ZUKAN_SUGGESTIONS_PATH, "ZukanSuggestion", LEGACY_ZUKAN_SUGGESTIONS_PATH);
  for (const row of doc.rows) assertSuggestion(row, ZUKAN_SUGGESTIONS_PATH);
  const matching = doc.rows.filter((row) => !entityId || row.entityId === entityId)
    .sort((left, right) => String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")) || String(left.id).localeCompare(String(right.id)));
  const rows = matching.filter((row) => status === "all" || row.status === status);
  const page = pageSlice(rows, input, context, { ...(entityId ? { entityId } : {}), status });
  return { items: page.rows.map(suggestionView), pendingCount: matching.filter((row) => row.status === "pending").length, nextCursor: page.nextCursor, proposalFileRevision: doc.file?.revision ?? null };
}

function* worldStateWorkbench(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, ["sceneId", "proposalStatus"]);
  const sceneId = optionalString(input, "sceneId");
  const proposalStatus = optionalString(input, "proposalStatus");
  if (proposalStatus && !["proposed", "stale", "approved", "rejected"].includes(proposalStatus)) throw error("invalid_input", "proposalStatus is invalid");
  const story = yield* storyFor(context, host);
  if (sceneId) sourceErrorIfSceneMissing(story.entities.get(sceneId), sceneId);
  const order = new Map(orderedScenes(story).map((row) => [row.entity.id, row.order]));
  const events = listRuleStateEvents(story).data;
  const proposalDoc = yield* readJsonl(context, host, STATE_PROPOSALS_PATH, "StateProposal", LEGACY_STATE_PROPOSALS_PATH);
  for (const row of proposalDoc.rows) assertStateProposal(row, STATE_PROPOSALS_PATH);
  const scenes = [...story.entities.values()].filter((entity) => entity.type === "scene" && (!sceneId || entity.id === sceneId))
    .map((scene) => ({ sceneId: scene.id, path: scene.filePath, revision: story.revisions.get(scene.filePath) ?? null, order: order.get(scene.id) ?? null }));
  const sceneIds = new Set(scenes.map((scene) => scene.sceneId));
  const confirmedEvents = events.filter((event) => (!sceneId || event.sceneId === sceneId) && (!event.status || event.status === "confirmed"));
  const pendingProposals = proposalDoc.rows.filter((row) => (!sceneId || (row.event as Record<string, unknown>).sceneId === sceneId) && (!proposalStatus || row.status === proposalStatus));
  const diagnostics = [...story.diagnostics];
  for (const event of events) if (!story.entities.has(event.sceneId)) diagnostics.push({ code: "broken_reference", entityId: event.sceneId, message: `State event scene is missing: ${event.sceneId}` });
  for (const row of proposalDoc.rows) {
    const proposalSceneId = String((row.event as Record<string, unknown>).sceneId);
    if (!story.entities.has(proposalSceneId)) diagnostics.push({ code: "broken_reference", entityId: String(row.id), message: `State proposal source scene is missing: ${proposalSceneId}` });
  }
  if (sceneId && !sceneIds.size) throw error("scene_not_found", `Scene ${sceneId} is not in the Narrative hierarchy`, { sceneId });
  return { scenes, confirmedEvents, pendingProposals, diagnostics, proposalRevision: proposalDoc.file?.revision ?? null, snapshot: context.snapshot };
}

function stateEventInput(value: unknown, label: string): Record<string, unknown> {
  const event = requireRecord(value, label);
  assertKeys(event, ["kind", "subject", "object", "payload", "evidence", "confidence"]);
  if (!["location", "acquaintance", "ownership", "knowledge"].includes(String(event.kind))) throw error("invalid_input", `${label}.kind is invalid`);
  requiredString(event, "subject");
  if (!(event.object === null || typeof event.object === "string")) throw error("invalid_input", `${label}.object must be an entity ID or null`);
  if (!isRecord(event.payload)) throw error("invalid_input", `${label}.payload must be an object`);
  if (!Array.isArray(event.evidence) || event.evidence.length > 64) throw error("invalid_input", `${label}.evidence must contain at most 64 entries`);
  for (const [index, evidence] of event.evidence.entries()) {
    if (!isRecord(evidence)) throw error("invalid_input", `${label}.evidence[${index}] must be an object`);
    assertKeys(evidence, ["sceneId", "excerpt", "startOffset", "endOffset"]);
    requiredString(evidence, "sceneId");
    if (evidence.excerpt !== undefined && (typeof evidence.excerpt !== "string" || !evidence.excerpt.length)) throw error("invalid_input", `${label}.evidence[${index}].excerpt must be non-empty text`);
    for (const key of ["startOffset", "endOffset"] as const) if (evidence[key] !== undefined && (!Number.isSafeInteger(evidence[key]) || (evidence[key] as number) < 0)) throw error("invalid_input", `${label}.evidence[${index}].${key} must be a nonnegative integer`);
    if (evidence.startOffset !== undefined && evidence.endOffset !== undefined && (evidence.endOffset as number) < (evidence.startOffset as number)) throw error("invalid_input", `${label}.evidence[${index}] range is reversed`);
  }
  if (event.confidence !== undefined && (typeof event.confidence !== "number" || event.confidence < 0 || event.confidence > 1)) throw error("invalid_input", `${label}.confidence must be between 0 and 1`);
  validateJsonSize(event.payload);
  return event;
}

function eventSubjects(story: LoadedKnowledgeSnapshot, kind: string, subjectId: string, objectId: unknown) {
  const subject = getEntity(story, subjectId);
  const object = objectId === null ? undefined : getEntity(story, String(objectId));
  const valid = kind === "location" ? subject.type === "character" && object?.type === "location"
    : kind === "acquaintance" ? subject.type === "character" && object?.type === "character"
      : kind === "ownership" ? subject.type === "item" && (!object || object.type === "character")
        : kind === "knowledge" ? subject.type === "character" && (!object || object.type !== "scene" && object.type !== "manuscript")
          : false;
  if (!valid) throw error("invalid_input", `State ${kind} event references invalid entity types`, { subjectId, objectId, kind });
  return { subject, object };
}

function sceneManuscript(story: LoadedKnowledgeSnapshot, scene: StoryEntity): { path: string; file: StoryFile; body: string } {
  if (scene.type !== "scene" || typeof scene.raw.manuscript !== "string") throw error("file_not_found", `Scene ${scene.id} has no authored manuscript path`, { kind: "manuscript_not_found", sceneId: scene.id });
  const path = scene.raw.manuscript;
  const file = story.files.get(path);
  const manuscript = [...story.entities.values()].find((entity) => entity.type === "manuscript" && entity.filePath === path);
  if (!file || !manuscript || manuscript.body === undefined) throw error("file_not_found", `Scene manuscript is missing: ${path}`, { path, sceneId: scene.id });
  return { path, file, body: manuscript.body };
}

function validateStateEvidence(story: LoadedKnowledgeSnapshot, evidence: readonly unknown[]): StoryEntity[] {
  const evidenceScenes: StoryEntity[] = [];
  for (const [index, value] of evidence.entries()) {
    const item = value as Record<string, unknown>;
    const scene = sourceErrorIfSceneMissing(story.entities.get(String(item.sceneId)), String(item.sceneId));
    const manuscript = sceneManuscript(story, scene);
    const { body } = manuscript;
    const start = item.startOffset, end = item.endOffset;
    if (typeof start === "number" && typeof end === "number") {
      if (end > body.length || (typeof item.excerpt === "string" && body.slice(start, end) !== item.excerpt)) throw error("snapshot_stale", `State evidence ${index + 1} does not match the selected manuscript`, { sceneId: scene.id, path: manuscript.path, sourceRevision: manuscript.file.revision });
    } else if (typeof item.excerpt === "string" && !body.includes(item.excerpt)) {
      throw error("snapshot_stale", `State evidence ${index + 1} quote is absent from the selected manuscript`, { sceneId: scene.id, path: manuscript.path, sourceRevision: manuscript.file.revision });
    }
    evidenceScenes.push(scene);
  }
  return evidenceScenes;
}

function proposalConflicts(event: Record<string, unknown>, confirmed: readonly Record<string, unknown>[]) {
  return confirmed.filter((prior) => prior.kind === event.kind && prior.subject === event.subject && prior.object !== event.object)
    .map((prior) => typeof prior.eventId === "string" ? prior.eventId : `${String(prior.sceneId)}:${String(prior.kind)}:${String(prior.subject)}`);
}

function sameProposedEvent(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return left.sceneId === right.sceneId && left.order === right.order && left.kind === right.kind && left.subject === right.subject &&
    left.object === right.object && JSON.stringify(left.payload) === JSON.stringify(right.payload);
}

function proposalFileRead(doc: JsonlDocument, fallbackPath: string): ProposalRead {
  return doc.file ? { path: doc.file.path, revision: doc.file.revision, content: doc.file.content } : { path: fallbackPath, revision: null };
}

function* stateProposalCreate(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, ["sceneId", "event", "expectedSceneRevision", "manuscriptHash"]);
  const sceneId = requiredString(input, "sceneId");
  const eventInput = stateEventInput(input.event, "event");
  const expectedSceneRevision = requiredString(input, "expectedSceneRevision");
  const manuscriptHash = requiredString(input, "manuscriptHash");
  const base = yield* storyFor(context, host);
  const scene = sourceErrorIfSceneMissing(base.entities.get(sceneId), sceneId);
  const sceneRevision = entityRevision(scene, base);
  if (expectedSceneRevision !== sceneRevision) throw error("snapshot_stale", "Scene changed after the selected snapshot", { sceneId, path: scene.filePath, expectedSceneRevision, actualSceneRevision: sceneRevision });
  const eventEvidence = eventInput.evidence as Array<Record<string, unknown>>;
  const evidenceSceneIds = new Set([sceneId, ...eventEvidence.map((item) => String(item.sceneId))]);
  const story = yield* storyWithScenes(context, host, evidenceSceneIds);
  const resolvedScene = sourceErrorIfSceneMissing(story.entities.get(sceneId), sceneId);
  const sceneText = sceneManuscript(story, resolvedScene);
  if (sha256Hex(sceneText.body) !== manuscriptHash) throw error("snapshot_stale", "Manuscript changed after this state proposal was drafted", { sceneId, path: sceneText.path, expectedManuscriptHash: manuscriptHash, actualManuscriptHash: sha256Hex(sceneText.body) });
  const eventReferences = eventSubjects(story, String(eventInput.kind), String(eventInput.subject), eventInput.object);
  const evidenceScenes = validateStateEvidence(story, eventEvidence);
  const position = orderedScenes(story).find((row) => row.entity.id === sceneId);
  if (!position) throw error("scene_not_found", `Scene ${sceneId} has no Narrative order`, { sceneId });
  const document = yield* readJsonl(context, host, STATE_PROPOSALS_PATH, "StateProposal", LEGACY_STATE_PROPOSALS_PATH);
  for (const row of document.rows) assertStateProposal(row, document.file?.path ?? STATE_PROPOSALS_PATH);
  const proposalId = stableRecordId(context, "state-proposal");
  if (document.rows.some((row) => row.id === proposalId)) throw error("idempotency_conflict", "State proposal ID already exists in the selected snapshot", { proposalId });
  const at = yield* stableTimestamp(context, host);
  const event = {
    sceneId, order: position.order, kind: eventInput.kind, subject: eventInput.subject, object: eventInput.object,
    payload: eventInput.payload, source: "manual-draft", eventId: `event-${sha256Hex(`${proposalId}\0event`).slice(0, 32)}`,
    status: "proposed", evidence: eventEvidence,
    ...(eventInput.confidence !== undefined ? { confidence: eventInput.confidence } : {}), createdAt: at,
  };
  const confirmed = listRuleStateEvents(story).data.filter((row) => !row.status || row.status === "confirmed") as unknown as Array<Record<string, unknown>>;
  const existingProposal = document.rows.find((row) => row.status === "proposed" && sameProposedEvent(row.event as Record<string, unknown>, event));
  const proposal = {
    id: proposalId, event, manuscriptHash, status: "proposed", conflictEventIds: proposalConflicts(event, confirmed),
    duplicateOfProposalId: existingProposal?.id ?? null, history: [{ action: "created", at, event }], createdAt: at, updatedAt: at,
  };
  const nextRows = [...document.rows, proposal];
  const reads = [proposalFileRead(document, STATE_PROPOSALS_PATH),
    { path: resolvedScene.filePath, revision: sceneRevision, content: base.files.get(resolvedScene.filePath)?.content },
    { path: sceneText.path, revision: sceneText.file.revision, content: sceneText.file.content },
    ...readsForReferences(story, [eventReferences.subject, ...(eventReferences.object ? [eventReferences.object] : []), ...evidenceScenes])];
  const metadataPath = document.file?.path ?? STATE_PROPOSALS_PATH;
  const submitted = yield* submitProposal({ context, host, title: `Create state proposal ${proposalId}`, reason: "Record a source-backed, unconfirmed world-state candidate.", reads,
    writes: [{ path: metadataPath, expected_revision: document.file?.revision ?? null, content: jsonlContent(nextRows) }] });
  return { stateProposalId: proposalId, proposalId: submitted.proposalId, preview: submitted.preview };
}

function* stateProposalUpdate(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, ["id", "event", "expectedProposalRevision", "expectedSceneRevision", "manuscriptHash"]);
  const id = requiredString(input, "id");
  const eventInput = stateEventInput(input.event, "event");
  const expectedProposalRevision = requiredString(input, "expectedProposalRevision");
  const expectedSceneRevision = requiredString(input, "expectedSceneRevision");
  const manuscriptHash = requiredString(input, "manuscriptHash");
  const story = yield* storyFor(context, host);
  const document = yield* readJsonl(context, host, STATE_PROPOSALS_PATH, "StateProposal", LEGACY_STATE_PROPOSALS_PATH);
  for (const row of document.rows) assertStateProposal(row, document.file?.path ?? STATE_PROPOSALS_PATH);
  if (!document.file || expectedProposalRevision !== document.file.revision) throw error("snapshot_stale", "State proposal file changed after the selected snapshot", { path: document.file?.path ?? STATE_PROPOSALS_PATH, expectedProposalRevision, actualProposalRevision: document.file?.revision ?? null });
  const index = document.rows.findIndex((row) => row.id === id);
  if (index < 0) throw error("file_not_found", `State proposal ${id} was not found`, { kind: "state_proposal_not_found", id });
  const prior = document.rows[index]!;
  if (prior.status !== "proposed" && prior.status !== "stale") throw error("conflict", `State proposal ${id} is no longer editable`, { id, status: prior.status });
  const priorEvent = prior.event as Record<string, unknown>;
  const sceneId = String(priorEvent.sceneId);
  const scene = sourceErrorIfSceneMissing(story.entities.get(sceneId), sceneId);
  const sceneRevision = entityRevision(scene, story);
  if (expectedSceneRevision !== sceneRevision) throw error("snapshot_stale", "Scene changed after the selected snapshot", { sceneId, path: scene.filePath, expectedSceneRevision, actualSceneRevision: sceneRevision });
  const evidence = eventInput.evidence as Array<Record<string, unknown>>;
  const evidenceScenes = new Set([sceneId, ...evidence.map((item) => String(item.sceneId))]);
  const withText = yield* storyWithScenes(context, host, evidenceScenes);
  const source = sceneManuscript(withText, scene);
  if (sha256Hex(source.body) !== manuscriptHash) throw error("snapshot_stale", "Manuscript changed after this state proposal was drafted", { sceneId, path: source.path, expectedManuscriptHash: manuscriptHash, actualManuscriptHash: sha256Hex(source.body) });
  const { subject, object } = eventSubjects(withText, String(eventInput.kind), String(eventInput.subject), eventInput.object);
  const evidenceEntities = validateStateEvidence(withText, evidence);
  const position = orderedScenes(withText).find((row) => row.entity.id === sceneId);
  if (!position) throw error("scene_not_found", `Scene ${sceneId} has no Narrative order`, { sceneId });
  const at = yield* stableTimestamp(context, host);
  const event = {
    ...priorEvent, sceneId, order: position.order, kind: eventInput.kind, subject: eventInput.subject, object: eventInput.object,
    payload: eventInput.payload, source: "manual-draft", status: "proposed", evidence,
    ...(eventInput.confidence !== undefined ? { confidence: eventInput.confidence } : { confidence: undefined }),
  };
  if (event.confidence === undefined) delete (event as Record<string, unknown>).confidence;
  const confirmed = listRuleStateEvents(withText).data.filter((row) => !row.status || row.status === "confirmed") as unknown as Array<Record<string, unknown>>;
  const duplicate = document.rows.find((row) => row.id !== id && row.status === "proposed" && sameProposedEvent(row.event as Record<string, unknown>, event));
  const next: Record<string, unknown> = {
    ...prior, event, manuscriptHash, status: "proposed", conflictEventIds: proposalConflicts(event, confirmed),
    duplicateOfProposalId: duplicate?.id ?? null,
    history: [...(prior.history as unknown[]), { action: "edited", at, event }], updatedAt: at,
  };
  const rows = [...document.rows]; rows[index] = next;
  const sceneFile = story.files.get(scene.filePath);
  if (!sceneFile) throw error("file_not_found", `Scene source is missing: ${scene.filePath}`, { path: scene.filePath });
  const metadataPath = document.file.path;
  const submitted = yield* submitProposal({ context, host, title: `Update state proposal ${id}`, reason: "Refresh a source-backed world-state candidate against the current scene and manuscript.",
    reads: [{ path: metadataPath, revision: document.file.revision, content: document.file.content }, { path: scene.filePath, revision: sceneRevision, content: sceneFile.content }, { path: source.path, revision: source.file.revision, content: source.file.content }, ...readsForReferences(withText, [subject, ...(object ? [object] : []), ...evidenceEntities])],
    writes: [{ path: metadataPath, expected_revision: document.file.revision, content: jsonlContent(rows) }] });
  return { stateProposalId: id, proposalId: submitted.proposalId, preview: submitted.preview };
}

function* stateProposalDecide(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, ["id", "decision", "expectedProposalRevision", "expectedSceneRevision"]);
  const id = requiredString(input, "id");
  const decision = requiredString(input, "decision");
  if (decision !== "confirm" && decision !== "reject") throw error("invalid_input", "decision must be confirm or reject");
  const expectedProposalRevision = requiredString(input, "expectedProposalRevision");
  const expectedSceneRevision = requiredString(input, "expectedSceneRevision");
  const story = yield* storyFor(context, host);
  const document = yield* readJsonl(context, host, STATE_PROPOSALS_PATH, "StateProposal", LEGACY_STATE_PROPOSALS_PATH);
  for (const row of document.rows) assertStateProposal(row, document.file?.path ?? STATE_PROPOSALS_PATH);
  if (!document.file || expectedProposalRevision !== document.file.revision) throw error("snapshot_stale", "State proposal file changed after the selected snapshot", { path: document.file?.path ?? STATE_PROPOSALS_PATH, expectedProposalRevision, actualProposalRevision: document.file?.revision ?? null });
  const index = document.rows.findIndex((row) => row.id === id);
  if (index < 0) throw error("file_not_found", `State proposal ${id} was not found`, { kind: "state_proposal_not_found", id });
  const prior = document.rows[index]!;
  if (prior.status !== "proposed" && prior.status !== "stale") throw error("conflict", `State proposal ${id} is no longer decidable`, { id, status: prior.status });
  const event = prior.event as Record<string, unknown>;
  const sceneId = String(event.sceneId);
  const scene = sourceErrorIfSceneMissing(story.entities.get(sceneId), sceneId);
  const sceneRevision = entityRevision(scene, story);
  if (expectedSceneRevision !== sceneRevision) throw error("snapshot_stale", "Scene changed after the selected snapshot", { sceneId, path: scene.filePath, expectedSceneRevision, actualSceneRevision: sceneRevision });
  if (decision === "confirm") {
    if (prior.status !== "proposed") throw error("snapshot_stale", "Stale state proposals must be updated before confirmation", { id, status: prior.status });
    const manuscript = sceneManuscript(yield* storyWithScenes(context, host, new Set([sceneId])), scene);
    if (sha256Hex(manuscript.body) !== prior.manuscriptHash) throw error("snapshot_stale", "Manuscript changed after this state proposal was drafted", { sceneId, path: manuscript.path, expectedManuscriptHash: prior.manuscriptHash, actualManuscriptHash: sha256Hex(manuscript.body) });
    if ((prior.conflictEventIds as unknown[]).length > 0 || prior.duplicateOfProposalId) throw error("conflict", "State proposal has a confirmed conflict or duplicate candidate", { id, conflictEventIds: prior.conflictEventIds, duplicateOfProposalId: prior.duplicateOfProposalId });
    const existing = Array.isArray(scene.raw.state_events) ? scene.raw.state_events : [];
    if (existing.some((candidate) => isRecord(candidate) && candidate.eventId === event.eventId)) throw error("conflict", `State event already exists: ${String(event.eventId)}`, { sceneId, eventId: event.eventId });
  }
  const at = yield* stableTimestamp(context, host);
  const rowStatus = decision === "confirm" ? "approved" : "rejected";
  const nextRow: Record<string, unknown> = { ...prior, status: rowStatus, history: [...(prior.history as unknown[]), { action: rowStatus, at, event }], updatedAt: at };
  const rows = [...document.rows]; rows[index] = nextRow;
  const metadataPath = document.file.path;
  const reads: ProposalRead[] = [{ path: metadataPath, revision: document.file.revision, content: document.file.content }, { path: scene.filePath, revision: sceneRevision, content: story.files.get(scene.filePath)?.content }];
  const writes: ProposalWrite[] = [{ path: metadataPath, expected_revision: document.file.revision, content: jsonlContent(rows) }];
  if (decision === "confirm") {
    const eventRefs = eventSubjects(story, String(event.kind), String(event.subject), event.object);
    const confirmed = { ...event, source: "manual", status: "confirmed" };
    const nextScene = { ...scene.raw, state_events: [...(Array.isArray(scene.raw.state_events) ? scene.raw.state_events : []), confirmed] };
    reads.push(...readsForReferences(story, [eventRefs.subject, ...(eventRefs.object ? [eventRefs.object] : [])]));
    writes.push({ path: scene.filePath, expected_revision: sceneRevision, content: YAML.stringify(nextScene) });
  }
  const submitted = yield* submitProposal({ context, host, title: `${decision === "confirm" ? "Confirm" : "Reject"} state proposal ${id}`, reason: decision === "confirm" ? "Propose the confirmed event append and proposal history transition as one review unit." : "Record the rejection in the Git-backed state proposal history.", reads, writes });
  return { stateProposalId: id, decision, proposalId: submitted.proposalId, preview: submitted.preview };
}

function compactSourceText(value: string): string { return value.replace(/\s+/gu, " ").trim(); }
function sourceContainsQuote(source: string, quote: string): boolean {
  const normalized = compactSourceText(quote);
  return normalized.length > 0 && compactSourceText(source).includes(normalized);
}

function sourceSpan(file: StoryFile, quote: string): { path: string; revision: string; start: number; end: number; quote: string } {
  const index = file.content.indexOf(quote);
  if (index < 0) return { path: file.path, revision: file.revision, start: 0, end: new TextEncoder().encode(file.content).byteLength, quote: file.content };
  const start = new TextEncoder().encode(file.content.slice(0, index)).byteLength;
  const end = start + new TextEncoder().encode(quote).byteLength;
  return { path: file.path, revision: file.revision, start, end, quote };
}

function suggestionBlockPath(rawNotes: unknown, supplied: unknown): string {
  if (supplied !== undefined) {
    if (typeof supplied !== "string" || !supplied.trim()) throw error("invalid_input", "blockPath must be a non-empty string");
    const match = /^(?:lead\.(\d+)|sections\.(\d+)\.body\.(\d+))$/u.exec(supplied);
    if (!match) throw error("invalid_input", "blockPath must be lead.<index> or sections.<index>.body.<index>");
    if (match.slice(1).filter(Boolean).some((item) => !Number.isSafeInteger(Number(item)) || Number(item) > 1000)) throw error("capacity", "blockPath index must be 0..1000");
    return supplied;
  }
  const notes = normalizeNotes(rawNotes);
  if (!notes || notes.lead.length === 0) return "lead.0";
  for (let index = notes.lead.length - 1; index >= 0; index--) if (notes.lead[index]?.type === "paragraph") return `lead.${index}`;
  return `lead.${notes.lead.length}`;
}

function verifySuggestionBlock(rawNotes: unknown, path: string): void {
  const notes = rawNotes === undefined || rawNotes === null ? { lead: [], sections: [] } : normalizeNotes(rawNotes);
  if (!notes) throw error("unsupported_format", "Structured notes are malformed", { field: "notes" });
  const lead = /^lead\.(\d+)$/u.exec(path);
  if (lead) {
    if (Number(lead[1]) > notes.lead.length) throw error("file_not_found", `Notes block ${path} does not exist`, { kind: "notes_block_not_found", blockPath: path });
    return;
  }
  const section = /^sections\.(\d+)\.body\.(\d+)$/u.exec(path);
  if (!section || Number(section[1]) >= notes.sections.length || Number(section[2]) > notes.sections[Number(section[1])]?.body.length) {
    throw error("file_not_found", `Notes block ${path} does not exist`, { kind: "notes_block_not_found", blockPath: path });
  }
}

function suggestionSourceRevision(row: Record<string, unknown>): string | undefined {
  return typeof row.sourceRevision === "string" ? row.sourceRevision : undefined;
}

function* suggestionCreate(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, ["entityId", "blockPath", "proposedText", "evidence", "source", "sourceId", "sourceRange", "sourceRevision", "kind", "confidence", "expectedEntityRevision"]);
  const entityId = requiredString(input, "entityId");
  const proposedText = requiredString(input, "proposedText").trim();
  if (!proposedText || proposedText.length > 20_000) throw error("invalid_input", "proposedText must contain 1 to 20000 characters");
  const source = requiredString(input, "source");
  if (source !== "manuscript" && source !== "dialogue-sketch") throw error("invalid_input", "source must be manuscript or dialogue-sketch");
  const sourceRevision = requiredString(input, "sourceRevision");
  const sourceIdInput = optionalString(input, "sourceId");
  const kind = input.kind === undefined || input.kind === null ? null : requiredString(input, "kind");
  if (kind !== null && !["fact", "dynamic", "habit"].includes(kind)) throw error("invalid_input", "kind must be fact, dynamic, habit, or null");
  const confidence = input.confidence === undefined || input.confidence === null ? null : input.confidence;
  if (confidence !== null && !["high", "low", "none"].includes(String(confidence))) throw error("invalid_input", "confidence must be high, low, none, or null");
  if (!Array.isArray(input.evidence) || input.evidence.length < 1 || input.evidence.length > 64) throw error("invalid_input", "evidence must contain 1 to 64 quoted source references");
  const evidence = input.evidence.map((item, index) => {
    if (!isRecord(item) || typeof item.quote !== "string" || !item.quote.trim() || item.quote.length > 20_000 ||
        (item.sceneId !== undefined && (typeof item.sceneId !== "string" || !item.sceneId.trim()))) throw error("invalid_input", `evidence[${index}] is invalid`);
    return { quote: item.quote, ...(typeof item.sceneId === "string" ? { sceneId: item.sceneId } : {}) };
  });
  let sourceRange: { start: number; end: number } | null = null;
  if (input.sourceRange !== undefined && input.sourceRange !== null) {
    if (!isRecord(input.sourceRange) || Object.keys(input.sourceRange).some((key) => !["start", "end"].includes(key)) ||
        !Number.isSafeInteger(input.sourceRange.start) || !Number.isSafeInteger(input.sourceRange.end) ||
        (input.sourceRange.start as number) < 0 || (input.sourceRange.end as number) < (input.sourceRange.start as number)) throw error("invalid_input", "sourceRange must be a nonnegative inclusive line range");
    sourceRange = { start: input.sourceRange.start as number, end: input.sourceRange.end as number };
  }
  if (source === "manuscript" && sourceRange) throw error("invalid_input", "sourceRange is only valid for dialogue-sketch suggestions");
  const story = yield* storyFor(context, host);
  const entity = getEntity(story, entityId);
  const expectedEntityRevision = requiredString(input, "expectedEntityRevision");
  const entityFileRevision = entityRevision(entity, story);
  if (expectedEntityRevision !== entityFileRevision) throw error("snapshot_stale", "Suggestion target entity changed after the selected snapshot", { entityId, path: entity.filePath, expectedEntityRevision, actualEntityRevision: entityFileRevision });
  const blockPath = suggestionBlockPath(entity.raw.notes, input.blockPath);
  verifySuggestionBlock(entity.raw.notes, blockPath);

  let sourceFile: StoryFile;
  let canonicalSourceId: string;
  let sourceRead: ProposalRead;
  let readStory = story;
  if (source === "manuscript") {
    const cited = [...new Set(evidence.map((item) => item.sceneId).filter((id): id is string => typeof id === "string"))];
    if (evidence.some((item) => !item.sceneId) || cited.length !== 1 || (sourceIdInput && sourceIdInput !== cited[0])) throw error("invalid_input", "Manuscript suggestions must cite one exact source scene");
    canonicalSourceId = cited[0]!;
    const selected = yield* storyWithScenes(context, host, new Set([canonicalSourceId]));
    readStory = selected;
    const scene = sourceErrorIfSceneMissing(selected.entities.get(canonicalSourceId), canonicalSourceId);
    const manuscript = sceneManuscript(selected, scene);
    sourceFile = manuscript.file;
    sourceRead = { path: sourceFile.path, revision: sourceFile.revision, content: sourceFile.content };
    for (const item of evidence) if (!sourceContainsQuote(manuscript.body, item.quote)) throw error("snapshot_stale", `Evidence quote is absent from manuscript ${canonicalSourceId}`, { sceneId: canonicalSourceId, path: sourceFile.path, sourceRevision });
    const actualRevision = sourceFile.revision;
    if (sourceRevision !== actualRevision) throw error("snapshot_stale", "Manuscript evidence revision changed", { sceneId: canonicalSourceId, path: sourceFile.path, expectedSourceRevision: sourceRevision, actualSourceRevision: actualRevision });
    const sceneFile = selected.files.get(scene.filePath);
    if (!sceneFile) throw error("file_not_found", `Scene source is missing: ${scene.filePath}`, { path: scene.filePath });
    sourceRead.evidence = sourceSpan(sourceFile, evidence[0]!.quote);
    sourceRead = { ...sourceRead, evidence: sourceSpan(sourceFile, evidence[0]!.quote) };
    sourceRead = { ...sourceRead };
  } else {
    canonicalSourceId = requiredString(input, "sourceId");
    const sketch = getEntity(story, canonicalSourceId);
    if (sketch.type !== "dialogue_sketch") throw error("invalid_input", "sourceId must identify a dialogue sketch");
    sourceFile = story.files.get(sketch.filePath)!;
    const actualRevision = entityRevision(sketch, story);
    if (sourceRevision !== actualRevision) throw error("snapshot_stale", "Dialogue sketch changed after this suggestion was drafted", { sourceId: canonicalSourceId, path: sketch.filePath, expectedSourceRevision: sourceRevision, actualSourceRevision: actualRevision });
    const lines = Array.isArray(sketch.raw.lines) ? sketch.raw.lines.filter(isRecord) : [];
    const start = sourceRange?.start ?? 0, end = sourceRange?.end ?? lines.length - 1;
    if (end >= lines.length || start > end) throw error("snapshot_stale", "Dialogue sketch source range is stale", { sourceId: canonicalSourceId, sourceRange });
    const selectedLines = lines.slice(start, end + 1);
    const participantIds = new Set(Array.isArray(sketch.raw.participantEntityIds) ? sketch.raw.participantEntityIds.filter((id): id is string => typeof id === "string") : []);
    for (const line of selectedLines) if (typeof line.speakerEntityId === "string") participantIds.add(line.speakerEntityId);
    if (!participantIds.has(entityId)) throw error("invalid_input", "Suggestion target is not a participant in the selected dialogue sketch lines", { entityId, sourceId: canonicalSourceId });
    const transcript = selectedLines.map((line) => typeof line.text === "string" ? line.text : "").join("\n");
    for (const item of evidence) if (!sourceContainsQuote(transcript, item.quote)) throw error("snapshot_stale", "Evidence quote is absent from the selected dialogue sketch lines", { sourceId: canonicalSourceId, sourceRevision });
    sourceRead = { path: sketch.filePath, revision: actualRevision, content: sourceFile.content, evidence: sourceSpan(sourceFile, evidence[0]!.quote) };
  }
  const sourceHash = sha256Hex(JSON.stringify({ source, sourceId: canonicalSourceId, sourceRange, sourceRevision, entityFileRevision, blockPath, noteBlock: noteBlockMap(entity.raw.notes, "suggestion target").get(blockPath) ?? null }));
  const document = yield* readJsonl(context, host, ZUKAN_SUGGESTIONS_PATH, "ZukanSuggestion", LEGACY_ZUKAN_SUGGESTIONS_PATH);
  for (const row of document.rows) assertSuggestion(row, document.file?.path ?? ZUKAN_SUGGESTIONS_PATH);
  const suggestionId = stableRecordId(context, "zukan");
  if (document.rows.some((row) => row.id === suggestionId)) throw error("idempotency_conflict", "Suggestion identity already exists in the selected snapshot", { suggestionId });
  const at = yield* stableTimestamp(context, host);
  const inputSource = document.file?.path === LEGACY_ZUKAN_SUGGESTIONS_PATH && source === "dialogue-sketch" ? "sandbox" : source;
  const suggestion: Record<string, unknown> = {
    id: suggestionId, entityId, blockPath, proposedText, evidence, status: "pending", source: inputSource,
    kind, sourceId: canonicalSourceId, sourceRevision, confidence, createdAt: at, updatedAt: at, sourceHash,
    ...(sourceRange ? { sourceRange } : {}),
    ...(inputSource === "sandbox" ? { sourceSessionId: canonicalSourceId, ...(sourceRange ? { sourceTurnRange: sourceRange } : {}) } : {}),
    history: [{ action: "created", at }],
  };
  const pendingToStale = document.rows.filter((row) => row.entityId === entityId && row.blockPath === blockPath && row.status === "pending" &&
    (row.source === source || row.source === "sandbox") && String(row.sourceId ?? row.sourceSessionId ?? "") === canonicalSourceId && row.sourceHash !== sourceHash);
  const staleIds = new Set(pendingToStale.map((row) => row.id));
  const rows = document.rows.map((row) => staleIds.has(row.id) ? { ...row, status: "stale", updatedAt: at, history: [...(Array.isArray(row.history) ? row.history : []), { action: "stale", at }] } : row);
  rows.push(suggestion);
  const targetFile = story.files.get(entity.filePath);
  if (!targetFile) throw error("file_not_found", `Suggestion target file is missing: ${entity.filePath}`, { path: entity.filePath });
  const metaRead = proposalFileRead(document, ZUKAN_SUGGESTIONS_PATH);
  const metadataPath = document.file?.path ?? ZUKAN_SUGGESTIONS_PATH;
  const submitted = yield* submitProposal({
    context, host, title: `Create Zukan suggestion ${suggestionId}`, reason: "Record a source-revision-bound notes candidate for Host review.",
    reads: [metaRead, { path: entity.filePath, revision: entityFileRevision, content: targetFile.content }, sourceRead,
      ...(source === "manuscript" ? [{ path: readStory.entities.get(canonicalSourceId)!.filePath, revision: readStory.revisions.get(readStory.entities.get(canonicalSourceId)!.filePath)!, content: readStory.files.get(readStory.entities.get(canonicalSourceId)!.filePath)?.content }] : [])],
    writes: [{ path: metadataPath, expected_revision: document.file?.revision ?? null, content: jsonlContent(rows) }],
  });
  return { suggestionId, proposalId: submitted.proposalId, proposalStatus: submitted.status, preview: submitted.preview };
}

function suggestionSourceCurrent(story: LoadedKnowledgeSnapshot, row: Record<string, unknown>): { entity?: StoryEntity; scene?: StoryEntity; file: StoryFile } {
  const source = row.source === "sandbox" ? "dialogue-sketch" : row.source;
  const sourceId = String(row.sourceId ?? row.sourceSessionId ?? "");
  const expected = suggestionSourceRevision(row);
  if (!expected) throw error("author_review_required", "Legacy suggestion has no exact source file revision and cannot be accepted automatically", { id: row.id, sourceId });
  if (source === "manuscript") {
    const scene = sourceErrorIfSceneMissing(story.entities.get(sourceId), sourceId);
    const manuscript = sceneManuscript(story, scene);
    if (manuscript.file.revision !== expected) throw error("snapshot_stale", "Suggestion manuscript source has changed", { id: row.id, sceneId: sourceId, path: manuscript.path, expectedSourceRevision: expected, actualSourceRevision: manuscript.file.revision });
    for (const item of row.evidence as Array<Record<string, unknown>>) if (!sourceContainsQuote(manuscript.body, String(item.quote))) throw error("snapshot_stale", "Suggestion quote is no longer in its manuscript source", { id: row.id, sceneId: sourceId, path: manuscript.path });
    return { scene, file: manuscript.file };
  }
  const sketch = getEntity(story, sourceId);
  if (sketch.type !== "dialogue_sketch") throw error("file_not_found", `Suggestion dialogue sketch ${sourceId} is missing`, { id: row.id, sourceId });
  const file = story.files.get(sketch.filePath);
  if (!file || entityRevision(sketch, story) !== expected) throw error("snapshot_stale", "Suggestion dialogue sketch source has changed", { id: row.id, sourceId, path: sketch.filePath, expectedSourceRevision: expected, actualSourceRevision: story.revisions.get(sketch.filePath) ?? null });
  return { entity: sketch, file };
}

function* suggestionDecide(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, ["id", "decision", "expectedSuggestionRevision", "expectedEntityRevision"]);
  const id = requiredString(input, "id");
  const decision = requiredString(input, "decision");
  if (decision !== "accept" && decision !== "reject") throw error("invalid_input", "decision must be accept or reject");
  const expectedSuggestionRevision = requiredString(input, "expectedSuggestionRevision");
  const expectedEntityRevision = requiredString(input, "expectedEntityRevision");
  const document = yield* readJsonl(context, host, ZUKAN_SUGGESTIONS_PATH, "ZukanSuggestion", LEGACY_ZUKAN_SUGGESTIONS_PATH);
  for (const row of document.rows) assertSuggestion(row, document.file?.path ?? ZUKAN_SUGGESTIONS_PATH);
  if (!document.file || document.file.revision !== expectedSuggestionRevision) throw error("snapshot_stale", "Suggestion store changed after selection", { path: document.file?.path ?? ZUKAN_SUGGESTIONS_PATH, expectedSuggestionRevision, actualSuggestionRevision: document.file?.revision ?? null });
  const index = document.rows.findIndex((row) => row.id === id);
  if (index < 0) throw error("file_not_found", `Suggestion ${id} was not found`, { kind: "suggestion_not_found", id });
  const prior = document.rows[index]!;
  if (prior.status !== "pending") throw error("conflict", `Suggestion ${id} is not pending`, { id, status: prior.status });
  const story = yield* storyFor(context, host);
  const entity = getEntity(story, String(prior.entityId));
  const entityFileRevision = entityRevision(entity, story);
  if (expectedEntityRevision !== entityFileRevision) throw error("snapshot_stale", "Suggestion target entity changed after selection", { entityId: entity.id, path: entity.filePath, expectedEntityRevision, actualEntityRevision: entityFileRevision });
  let freshStory = story;
  if (decision === "accept" && prior.source === "manuscript") {
    const sourceId = String(prior.sourceId ?? (prior.evidence as Array<Record<string, unknown>>)[0]?.sceneId ?? "");
    freshStory = yield* storyWithScenes(context, host, new Set([sourceId]));
  }
  const source = decision === "accept" ? suggestionSourceCurrent(freshStory, prior) : null;
  const at = yield* stableTimestamp(context, host);
  const rows = [...document.rows];
  const changedBlocks = new Set<string>();
  let writes: ProposalWrite[] = [];
  let reads: ProposalRead[] = [proposalFileRead(document, ZUKAN_SUGGESTIONS_PATH)];
  if (decision === "accept") {
    const currentNotes = entity.raw.notes === undefined || entity.raw.notes === null ? null : normalizeNotes(entity.raw.notes);
    if (entity.raw.notes !== undefined && entity.raw.notes !== null && !currentNotes) throw error("unsupported_format", "Suggestion target notes are malformed", { entityId: entity.id, path: entity.filePath });
    verifySuggestionBlock(entity.raw.notes, String(prior.blockPath));
    const nextNotes = appendProposedTextToNotes(currentNotes, String(prior.blockPath), String(prior.proposedText));
    for (const path of changedNoteBlockPaths(entity.raw.notes, nextNotes)) changedBlocks.add(path);
    const nextEntity: Record<string, unknown> = { ...entity.raw, notes: nextNotes };
    const entityFile = story.files.get(entity.filePath);
    if (!entityFile) throw error("file_not_found", `Entity source is missing: ${entity.filePath}`, { path: entity.filePath });
    reads.push({ path: entity.filePath, revision: entityFileRevision, content: entityFile.content });
    if (source) reads.push({ path: source.file.path, revision: source.file.revision, content: source.file.content });
    writes.push({ path: entity.filePath, expected_revision: entityFileRevision, content: YAML.stringify(nextEntity) });
  }
  const nextPrior = { ...prior, status: decision === "accept" ? "approved" : "rejected", updatedAt: at,
    history: [...(Array.isArray(prior.history) ? prior.history : []), { action: decision === "accept" ? "approved" : "rejected", at }] };
  rows[index] = nextPrior;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    if (rowIndex === index) continue;
    const row = rows[rowIndex]!;
    if (decision === "accept" && row.entityId === entity.id && row.status === "pending" && changedBlocks.has(String(row.blockPath))) {
      rows[rowIndex] = { ...row, status: "stale", updatedAt: at, history: [...(Array.isArray(row.history) ? row.history : []), { action: "stale", at }] };
    }
  }
  const metadataPath = document.file.path;
  writes.push({ path: metadataPath, expected_revision: document.file.revision, content: jsonlContent(rows) });
  const submitted = yield* submitProposal({
    context, host, title: `${decision === "accept" ? "Accept" : "Reject"} Zukan suggestion ${id}`,
    reason: decision === "accept" ? "Append the evidence-backed text to notes and update suggestion history in one review unit." : "Record the suggestion rejection in the Git-backed review history.",
    reads, writes,
  });
  return { suggestionId: id, decision, proposalId: submitted.proposalId, preview: submitted.preview };
}

interface SeriesSettings {
  file: StoryFile | null;
  raw: Record<string, unknown>;
  series: Array<Record<string, unknown>>;
  bindings: Array<Record<string, unknown>>;
}

function* readSeriesSettings(context: ActionRequest, host: GuestHost): Generator<HostCall, SeriesSettings, unknown> {
  const reader = createSnapshotReader(context, host);
  const current = yield* readOptionalPath(reader, SERIES_PATH);
  const legacy = yield* readOptionalPath(reader, LEGACY_SERIES_PATH);
  const parseCurrent = (file: StoryFile): Record<string, unknown> => {
    let value: unknown;
    try { value = YAML.parse(file.content); } catch (cause) { throw error("unsupported_format", `Malformed series YAML: ${cause instanceof Error ? cause.message : String(cause)}`, { path: file.path }); }
    if (!isRecord(value) || !Array.isArray(value.series) || !value.series.every(isRecord)) throw error("unsupported_format", "Series registry must contain a series array", { path: file.path });
    return value;
  };
  const parseLegacy = (file: StoryFile): Record<string, unknown> => {
    let value: unknown;
    try { value = JSON.parse(file.content); } catch (cause) { throw error("unsupported_format", `Malformed legacy series JSON: ${cause instanceof Error ? cause.message : String(cause)}`, { path: file.path }); }
    if (!isRecord(value) || !Array.isArray(value.series) || !value.series.every(isRecord)) throw error("unsupported_format", "Legacy series registry must contain a series array", { path: file.path });
    return value;
  };
  const currentRaw = current ? parseCurrent(current) : null;
  const legacyRaw = legacy ? parseLegacy(legacy) : null;
  if (currentRaw && legacyRaw && canonicalJson(currentRaw) !== canonicalJson(legacyRaw)) {
    throw error("conflict", "Legacy and Proprium series registries differ", { currentPath: current!.path, currentRevision: current!.revision, legacyPath: legacy!.path, legacyRevision: legacy!.revision, kind: "metadata_reconciliation_required" });
  }
  const file = legacy ?? current;
  const raw = legacyRaw ?? currentRaw ?? { version: 1, series: [] };
  const series = (raw.series as Array<Record<string, unknown>> | undefined) ?? [];
  const ids = new Set<string>();
  for (const row of series) {
    if (typeof row.id !== "string" || !row.id) throw error("unsupported_format", "Series registry contains a record without a stable id", { path: file?.path ?? SERIES_PATH });
    if (ids.has(row.id)) throw error("ambiguous_identity", `Duplicate series identity ${row.id}`, { path: file?.path ?? SERIES_PATH, id: row.id });
    ids.add(row.id);
  }
  if (raw.bindings !== undefined && (!Array.isArray(raw.bindings) || !raw.bindings.every(isRecord))) throw error("unsupported_format", "Series bindings must be an array of records", { path: file?.path ?? SERIES_PATH });
  const bindings = Array.isArray(raw.bindings) ? raw.bindings as Array<Record<string, unknown>> : [];
  return { file, raw, series, bindings };
}

function* seriesList(_input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(_input, []);
  const settings = yield* readSeriesSettings(context, host);
  return { series: settings.series, registryRevision: settings.file?.revision ?? null, snapshot: context.snapshot };
}

function* seriesGet(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, ["seriesId"]);
  const seriesId = requiredString(input, "seriesId");
  const settings = yield* readSeriesSettings(context, host);
  const series = settings.series.find((row) => row.id === seriesId);
  if (!series) throw error("file_not_found", `Series ${seriesId} was not found`, { kind: "series_not_found", seriesId });
  return { series, registryRevision: settings.file?.revision ?? null, snapshot: context.snapshot };
}

function seriesIdHint(name: string): string {
  return normalizeUnicode(name, "NFKC").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48);
}

function allocateSeriesId(name: string, rows: readonly Record<string, unknown>[]): string {
  const hint = seriesIdHint(name);
  const base = `series-${hint || "1"}`;
  const used = new Set(rows.map((row) => row.id).filter((id): id is string => typeof id === "string"));
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix <= 9999; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  throw error("capacity", "Knowledge exhausted safe series IDs");
}

function seriesRevisionInput(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim()) throw error("invalid_input", "expectedRegistryRevision must be a SHA-256 revision or null");
  return value;
}

function seriesFileContent(raw: Record<string, unknown>, path: string): string {
  return path === LEGACY_SERIES_PATH ? `${JSON.stringify(raw, null, 2)}\n` : YAML.stringify(raw);
}

function* seriesPropose(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, ["seriesId", "patch", "expectedRegistryRevision"]);
  const seriesId = optionalString(input, "seriesId");
  const patch = requireRecord(input.patch, "patch");
  const allowed = ["name", "ownerId", "bibleRepositoryId", "delete"];
  const unknown = Object.keys(patch).find((key) => !allowed.includes(key));
  if (unknown) throw error("invalid_input", `Unsupported series patch field: ${unknown}`, { field: unknown });
  if (!Object.keys(patch).length) throw error("invalid_input", "patch must change at least one series field");
  if (patch.delete !== undefined && typeof patch.delete !== "boolean") throw error("invalid_input", "patch.delete must be boolean");
  if (patch.name !== undefined && (typeof patch.name !== "string" || !patch.name.trim() || patch.name.length > 256)) throw error("invalid_input", "patch.name must be non-empty text");
  if (patch.ownerId !== undefined && (typeof patch.ownerId !== "string" || !patch.ownerId.trim() || patch.ownerId.length > 256)) throw error("invalid_input", "patch.ownerId must be non-empty text");
  if (patch.bibleRepositoryId !== undefined && (!Number.isSafeInteger(patch.bibleRepositoryId) || (patch.bibleRepositoryId as number) <= 0)) throw error("invalid_input", "patch.bibleRepositoryId must be a positive GitHub repository ID");
  if (patch.delete === true && (Object.keys(patch).length !== 1 || !seriesId)) throw error("invalid_input", "Deleting a series requires seriesId and no other patch fields");
  if (!seriesId && (typeof patch.name !== "string" || typeof patch.bibleRepositoryId !== "number")) throw error("invalid_input", "Creating a series requires patch.name and a verified patch.bibleRepositoryId");
  const settings = yield* readSeriesSettings(context, host);
  const expected = seriesRevisionInput(input.expectedRegistryRevision);
  const actual = settings.file?.revision ?? null;
  if (expected !== actual) throw error("snapshot_stale", "Series registry changed after the selected snapshot", { path: settings.file?.path ?? SERIES_PATH, expectedRegistryRevision: expected, actualRegistryRevision: actual });
  const nextRaw: Record<string, unknown> = { ...settings.raw, version: 1, series: [...settings.series] };
  const rows = nextRaw.series as Array<Record<string, unknown>>;
  let resultId: string;
  let title: string;
  if (!seriesId) {
    const id = allocateSeriesId(String(patch.name), rows);
    const timestamp = yield* stableTimestamp(context, host);
    const repositoryId = context.scope.repository_id;
    if (repositoryId === null || repositoryId !== patch.bibleRepositoryId) throw error("repository_not_active", "A series registry can only be created for the currently selected, verified Bible repository", { selectedRepositoryId: repositoryId, requestedBibleRepositoryId: patch.bibleRepositoryId });
    const created: Record<string, unknown> = { id, name: String(patch.name).trim(), bibleRepositoryId: repositoryId, createdAt: timestamp };
    if (typeof patch.ownerId === "string") created.ownerId = patch.ownerId.trim();
    rows.push(created);
    resultId = id;
    title = `Create series ${id}`;
  } else {
    const index = rows.findIndex((row) => row.id === seriesId);
    if (index < 0) throw error("file_not_found", `Series ${seriesId} was not found`, { kind: "series_not_found", seriesId });
    const prior = rows[index]!;
    if (patch.delete === true) {
      rows.splice(index, 1);
      if (Array.isArray(nextRaw.bindings)) nextRaw.bindings = nextRaw.bindings.filter((value) => !isRecord(value) || value.seriesId !== seriesId);
      resultId = seriesId;
      title = `Delete series ${seriesId}`;
    } else {
      const next = { ...prior };
      if (patch.name !== undefined) next.name = String(patch.name).trim();
      if (patch.ownerId !== undefined) next.ownerId = String(patch.ownerId).trim();
      if (patch.bibleRepositoryId !== undefined) {
        if (context.scope.repository_id === null || context.scope.repository_id !== patch.bibleRepositoryId) throw error("repository_not_active", "Series registry updates must name the currently selected, verified Bible repository", { selectedRepositoryId: context.scope.repository_id, requestedBibleRepositoryId: patch.bibleRepositoryId });
        next.bibleRepositoryId = context.scope.repository_id;
      }
      next.updatedAt = yield* stableTimestamp(context, host);
      rows[index] = next;
      resultId = seriesId;
      title = `Update series ${seriesId}`;
    }
  }
  const path = settings.file?.path ?? SERIES_PATH;
  const content = seriesFileContent(nextRaw, path);
  const submitted = yield* submitProposal({
    context, host, title, reason: "Propose a change to the active series registry while retaining all other registry fields.",
    reads: [{ path, revision: settings.file?.revision ?? null, ...(settings.file ? { content: settings.file.content } : {}) }],
    writes: [{ path, expected_revision: settings.file?.revision ?? null, content }],
  });
  return { seriesId: resultId, proposalId: submitted.proposalId, preview: submitted.preview };
}

function positiveRepositoryId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function legacyWorkBinding(rows: readonly Record<string, unknown>[], repositoryId: number | null): Record<string, unknown> | undefined {
  if (repositoryId === null) return undefined;
  const matches = rows.filter((row) => row.repositoryId === repositoryId || row.repositoryId === String(repositoryId));
  if (matches.length > 1) throw error("ambiguous_identity", `Legacy series registry repeats work repository ${repositoryId}`);
  return matches[0];
}

function unresolvedLegacyBindings(rows: readonly Record<string, unknown>[], series: readonly Record<string, unknown>[] = []) {
  const unresolved = rows.filter((row) => row.repositoryId === undefined || row.repositoryId === null || typeof row.projectId === "string")
    .map((row) => ({ legacyProjectId: row.projectId ?? null, seriesId: row.seriesId ?? null }));
  for (const row of series) {
    if (typeof row.bibleProjectId === "string") unresolved.push({ legacyProjectId: row.bibleProjectId, seriesId: row.id ?? null });
    if (typeof row.projectId === "string") unresolved.push({ legacyProjectId: row.projectId, seriesId: row.id ?? null });
  }
  return unresolved;
}

function* readSeriesBinding(context: ActionRequest, host: GuestHost): Generator<HostCall, {
  binding: Record<string, unknown> | null;
  bibleRepositoryId?: number;
  bindingRevision: string | null;
  requiresAuthorReview: boolean;
  unresolvedLegacyBindings?: Array<{ legacyProjectId: unknown; seriesId: unknown }>;
}, unknown> {
  const settings = yield* readSeriesSettings(context, host);
  const bindingFile = yield* readOptionalPath(createSnapshotReader(context, host), SERIES_BINDING_PATH);
  if (settings.file?.path === LEGACY_SERIES_PATH) {
    if (bindingFile) throw error("conflict", "Legacy registry bindings and Proprium series-binding.yaml both exist", {
      legacyPath: settings.file.path, legacyRevision: settings.file.revision, bindingPath: bindingFile.path, bindingRevision: bindingFile.revision,
      kind: "metadata_reconciliation_required",
    });
    const match = legacyWorkBinding(settings.bindings, context.scope.repository_id);
    const unresolved = unresolvedLegacyBindings(settings.bindings, settings.series);
    if (!match) return { binding: null, bindingRevision: settings.file.revision, requiresAuthorReview: unresolved.length > 0, ...(unresolved.length ? { unresolvedLegacyBindings: unresolved } : {}) };
    const row = settings.series.find((item) => item.id === match.seriesId);
    if (!row) throw error("file_not_found", `Legacy series ${String(match.seriesId)} is missing`, { kind: "series_not_found", seriesId: match.seriesId });
    const id = row.bibleRepositoryId;
    const valid = positiveRepositoryId(id);
    const unresolvedForMatch = [
      ...(typeof row.bibleProjectId === "string" ? [{ legacyProjectId: row.bibleProjectId, seriesId: row.id }] : []),
      ...(typeof match.projectId === "string" ? [{ legacyProjectId: match.projectId, seriesId: row.id }] : []),
    ];
    const requiresAuthorReview = !valid || unresolvedForMatch.length > 0;
    return {
      binding: { ...match }, ...(valid ? { bibleRepositoryId: id } : {}), bindingRevision: settings.file.revision, requiresAuthorReview,
      ...(unresolvedForMatch.length ? { unresolvedLegacyBindings: unresolvedForMatch } : {}),
    };
  }
  if (!bindingFile) return {
    binding: null, bindingRevision: null, requiresAuthorReview: false,
  };
  const binding = parseYamlRecord(bindingFile, "series_binding");
  if (typeof binding.seriesId !== "string" || !binding.seriesId) throw error("unsupported_format", "Series binding has no seriesId", { path: SERIES_BINDING_PATH });
  const id = binding.bibleRepositoryId;
  const valid = id === undefined || positiveRepositoryId(id);
  if (!valid) throw error("unsupported_format", "Series binding bibleRepositoryId must be a positive GitHub numeric ID", { path: SERIES_BINDING_PATH });
  const unresolved = [binding.bibleProjectId, binding.projectId]
    .filter((legacyId): legacyId is string => typeof legacyId === "string")
    .map((legacyProjectId) => ({ legacyProjectId, seriesId: binding.seriesId }));
  return {
    binding, ...(positiveRepositoryId(id) ? { bibleRepositoryId: id } : {}), bindingRevision: bindingFile.revision,
    requiresAuthorReview: unresolved.length > 0, ...(unresolved.length ? { unresolvedLegacyBindings: unresolved } : {}),
  };
}

function* seriesBindingGet(_input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(_input, []);
  const result = yield* readSeriesBinding(context, host);
  return {
    binding: result.binding,
    ...(positiveRepositoryId(result.bibleRepositoryId) ? { bibleRepositoryId: result.bibleRepositoryId } : {}),
    registryRevision: result.bindingRevision,
    workSnapshot: context.snapshot,
    requiresAuthorReview: result.requiresAuthorReview,
    ...(result.unresolvedLegacyBindings?.length ? { unresolvedLegacyBindings: result.unresolvedLegacyBindings } : {}),
  };
}

function* seriesBindingPropose(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, ["seriesId", "bibleRepositoryId", "expectedWorkRevision"]);
  const seriesId = requiredString(input, "seriesId");
  if (input.bibleRepositoryId !== undefined && !positiveRepositoryId(input.bibleRepositoryId)) throw error("invalid_input", "bibleRepositoryId must be a positive GitHub repository ID");
  if (!(input.expectedWorkRevision === null || typeof input.expectedWorkRevision === "string" && input.expectedWorkRevision.trim())) {
    throw error("invalid_input", "expectedWorkRevision must be a SHA-256 revision or null");
  }
  const settings = yield* readSeriesSettings(context, host);
  const repositoryId = context.scope.repository_id;
  if (settings.file?.path === LEGACY_SERIES_PATH) {
    if (repositoryId === null) throw error("author_review_required", "Legacy series bindings require a stable selected work repository ID; resolve local-only bindings through Host registration");
    if (input.expectedWorkRevision !== settings.file.revision) throw error("snapshot_stale", "Legacy work series registry changed after selection", { path: settings.file.path, expectedWorkRevision: input.expectedWorkRevision, actualWorkRevision: settings.file.revision });
    const series = settings.series.find((row) => row.id === seriesId);
    if (!series) throw error("file_not_found", `Series ${seriesId} was not found in the active legacy registry`, { kind: "series_not_found", seriesId });
    if (typeof series.bibleProjectId === "string" || typeof series.projectId === "string") {
      throw error("author_review_required", "Legacy project identity must be resolved to a verified GitHub repository ID before binding", {
        seriesId, legacyProjectId: series.bibleProjectId ?? series.projectId,
      });
    }
    if (positiveRepositoryId(input.bibleRepositoryId) && (!positiveRepositoryId(series.bibleRepositoryId) || input.bibleRepositoryId !== series.bibleRepositoryId)) {
      throw error("conflict", "Requested Bible repository does not match the active series registry", { seriesId, requestedRepositoryId: input.bibleRepositoryId, registryRepositoryId: series.bibleRepositoryId ?? null });
    }
    const matching = settings.bindings.filter((row) => row.repositoryId === repositoryId || row.repositoryId === String(repositoryId));
    if (matching.length > 1) throw error("ambiguous_identity", `Legacy registry repeats work repository ${repositoryId}`, { repositoryId });
    if (matching[0] && typeof matching[0].projectId === "string") throw error("author_review_required", "Legacy work project identity must be resolved through Host registration before binding", { legacyProjectId: matching[0].projectId });
    const rows = [...settings.bindings];
    const bindingRow: Record<string, unknown> = { ...(matching[0] ?? {}), repositoryId, seriesId };
    if (matching.length) rows[rows.indexOf(matching[0]!)] = bindingRow; else rows.push(bindingRow);
    const nextRaw: Record<string, unknown> = { ...settings.raw, version: 1, series: settings.series, bindings: rows };
    const submitted = yield* submitProposal({
      context, host, title: `Bind work to series ${seriesId}`, reason: "Update the active legacy series binding under its exact source revision.",
      reads: [{ path: settings.file.path, revision: settings.file.revision, content: settings.file.content }],
      writes: [{ path: settings.file.path, expected_revision: settings.file.revision, content: seriesFileContent(nextRaw, settings.file.path) }],
    });
    return { binding: bindingRow, proposalId: submitted.proposalId, preview: submitted.preview };
  }

  const reader = createSnapshotReader(context, host);
  const oldFile = yield* readOptionalPath(reader, SERIES_BINDING_PATH);
  const actualRevision = oldFile?.revision ?? null;
  if (input.expectedWorkRevision !== actualRevision) throw error("snapshot_stale", "Work series binding changed after selection", { path: SERIES_BINDING_PATH, expectedWorkRevision: input.expectedWorkRevision, actualWorkRevision: actualRevision });
  const registrySeries = settings.series.find((row) => row.id === seriesId);
  if (!registrySeries) throw error("file_not_found", `Series ${seriesId} was not found in the active registry`, { kind: "series_not_found", seriesId });
  if (positiveRepositoryId(input.bibleRepositoryId) &&
      (!positiveRepositoryId(registrySeries.bibleRepositoryId) || input.bibleRepositoryId !== registrySeries.bibleRepositoryId)) {
    throw error("conflict", "Requested Bible repository does not match the active series registry", { seriesId, requestedRepositoryId: input.bibleRepositoryId, registryRepositoryId: registrySeries.bibleRepositoryId ?? null });
  }
  if (typeof registrySeries.bibleProjectId === "string" || typeof registrySeries.projectId === "string") {
    throw error("author_review_required", "Legacy Bible project identity must be resolved to a verified GitHub repository ID before binding", { seriesId, legacyBibleProjectId: registrySeries.bibleProjectId ?? registrySeries.projectId });
  }
  const oldBinding = oldFile ? parseYamlRecord(oldFile, "series_binding") : {};
  if (typeof oldBinding.bibleProjectId === "string" || typeof oldBinding.projectId === "string") throw error("author_review_required", "Legacy Bible project identity must be resolved through the Host registered-source selector before binding", { seriesId, legacyBibleProjectId: oldBinding.bibleProjectId ?? oldBinding.projectId });
  const bibleRepositoryId = positiveRepositoryId(input.bibleRepositoryId) ? input.bibleRepositoryId
    : positiveRepositoryId(oldBinding.bibleRepositoryId) ? oldBinding.bibleRepositoryId
      : registrySeries && positiveRepositoryId(registrySeries.bibleRepositoryId) ? registrySeries.bibleRepositoryId : undefined;
  const binding: Record<string, unknown> = { ...oldBinding, seriesId, ...(bibleRepositoryId ? { bibleRepositoryId } : {}) };
  const reads: ProposalRead[] = [{ path: SERIES_BINDING_PATH, revision: actualRevision, ...(oldFile ? { content: oldFile.content } : {}) }];
  if (settings.file) reads.push({ path: settings.file.path, revision: settings.file.revision, content: settings.file.content });
  const submitted = yield* submitProposal({
    context, host, title: `Bind work to series ${seriesId}`, reason: "Propose the selected work's source-backed series binding without writing to the Bible repository.",
    reads, writes: [{ path: SERIES_BINDING_PATH, expected_revision: actualRevision, content: YAML.stringify(binding) }],
  });
  return { binding, proposalId: submitted.proposalId, preview: submitted.preview };
}

interface RegisteredSeriesSource {
  workspace_id: string;
  repository_id: number | null;
  branch: string;
  snapshot_id: string;
}

function registeredSeriesSource(value: unknown): RegisteredSeriesSource {
  if (!isRecord(value) || typeof value.workspace_id !== "string" || !value.workspace_id ||
      !(value.repository_id === null || positiveRepositoryId(value.repository_id)) ||
      typeof value.branch !== "string" || !value.branch || typeof value.snapshot_id !== "string" || !value.snapshot_id) {
    throw error("unsupported_format", "Host series source preference is malformed", { kind: "invalid_series_source_preference" });
  }
  const unknown = Object.keys(value).find((key) => !["workspace_id", "repository_id", "branch", "snapshot_id"].includes(key));
  if (unknown) throw error("unsupported_format", "Host series source preference contains unsupported fields", { kind: "invalid_series_source_preference", field: unknown });
  return value as unknown as RegisteredSeriesSource;
}

function validForeignLease(value: unknown, selected: RegisteredSeriesSource): value is { scope: Scope; snapshot: Snapshot } {
  if (!isRecord(value) || !isRecord(value.scope) || !isRecord(value.snapshot)) return false;
  const scope = value.scope;
  const snapshot = value.snapshot;
  return scope.workspace_id === selected.workspace_id && scope.repository_id === selected.repository_id &&
    scope.branch === selected.branch && typeof scope.generation === "string" && !!scope.generation &&
    snapshot.id === selected.snapshot_id && typeof snapshot.worktree_generation === "string" && !!snapshot.worktree_generation &&
    (snapshot.local_commit === null || typeof snapshot.local_commit === "string") &&
    (snapshot.draft_generation === null || typeof snapshot.draft_generation === "string");
}

interface OverlaySourceRecord {
  source: "work" | "bible";
  entity: StoryEntity;
  scope: Scope;
  snapshot: Snapshot;
  path: string;
  revision: string;
}

function overlayEntityRecord(source: "work" | "bible", entity: StoryEntity, request: ActionRequest, story: LoadedKnowledgeSnapshot): OverlaySourceRecord {
  const revision = story.revisions.get(entity.filePath);
  if (!revision) throw error("file_not_found", `Overlay entity source revision is missing: ${entity.filePath}`, { source, path: entity.filePath, snapshot: request.snapshot });
  return { source, entity, scope: request.scope, snapshot: request.snapshot, path: entity.filePath, revision };
}

function overlayLinkKey(link: { from: string; to: string; kind: string }): string {
  return `${link.from}\0${link.to}\0${link.kind}`;
}

function* seriesOverlay(_input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(_input, []);
  const selectedWorkBinding = yield* readSeriesBinding(context, host);
  const binding = selectedWorkBinding.binding;
  if (!binding || typeof binding.seriesId !== "string") throw error("author_review_required", "This work has no source-backed series binding", { kind: "series_binding_missing" });
  if (selectedWorkBinding.requiresAuthorReview) throw error("author_review_required", "The series source contains an unresolved legacy project identity", {
    kind: "unresolved_series_identity", seriesId: binding.seriesId,
    ...(selectedWorkBinding.unresolvedLegacyBindings ? { unresolvedLegacyBindings: selectedWorkBinding.unresolvedLegacyBindings } : {}),
  });

  let preferenceKey: string;
  try { preferenceKey = seriesBindingPreferenceKey(binding); }
  catch (cause) { throw error("unsupported_format", `Cannot fingerprint this series binding: ${cause instanceof Error ? cause.message : String(cause)}`, { kind: "invalid_binding_record" }); }
  const preference = yield* host.request<unknown>(HOST_OPERATIONS.preferencesRead, { key: preferenceKey, schema_version: 1 });
  if (!isRecord(preference) || preference.found !== true) throw error("repository_not_active", "No Host-registered Bible source is selected for this series binding", {
    kind: "series_source_not_selected", seriesId: binding.seriesId, preferenceKey,
  });
  const selected = registeredSeriesSource(preference.value);
  const bibleRepositoryId = selectedWorkBinding.bibleRepositoryId;
  if (positiveRepositoryId(bibleRepositoryId) ? selected.repository_id !== bibleRepositoryId : selected.repository_id !== null) {
    throw error("conflict", "Selected Host source does not match the Git-backed series binding", {
      kind: "series_source_identity_mismatch", seriesId: binding.seriesId,
      expectedRepositoryId: bibleRepositoryId ?? null, selectedRepositoryId: selected.repository_id,
    });
  }
  const lease = yield* host.request<unknown>("workspace.repository.snapshot.read", selected as unknown as Record<string, unknown>);
  if (!validForeignLease(lease, selected)) throw error("snapshot_stale", "Host did not return the exact registered series source snapshot", {
    kind: "foreign_snapshot_mismatch", workspace_id: selected.workspace_id, repository_id: selected.repository_id,
    branch: selected.branch, snapshot_id: selected.snapshot_id,
  });
  const sourceRequest: ActionRequest = { ...context, scope: lease.scope, snapshot: lease.snapshot };
  const sourceSettings = yield* readSeriesSettings(sourceRequest, host);
  const sourceSeries = sourceSettings.series.find((series) => series.id === binding.seriesId);
  if (!sourceSeries) throw error("file_not_found", `Selected Bible repository does not contain series ${binding.seriesId}`, {
    kind: "series_not_found", seriesId: binding.seriesId, path: sourceSettings.file?.path ?? SERIES_PATH,
    scope: sourceRequest.scope, snapshot: sourceRequest.snapshot,
  });
  if (positiveRepositoryId(sourceSeries.bibleRepositoryId) &&
      (sourceSeries.bibleRepositoryId !== sourceRequest.scope.repository_id || positiveRepositoryId(bibleRepositoryId) && sourceSeries.bibleRepositoryId !== bibleRepositoryId)) {
    throw error("conflict", "Selected Bible registry identifies a different repository", {
      kind: "series_repository_mismatch", seriesId: binding.seriesId, bindingRepositoryId: bibleRepositoryId ?? null,
      selectedRepositoryId: sourceRequest.scope.repository_id, registryRepositoryId: sourceSeries.bibleRepositoryId, path: sourceSettings.file?.path,
    });
  }

  const workStory = yield* storyFor(context, host);
  const bibleStory = yield* readKnowledgeSnapshot(createSnapshotReader(sourceRequest, host));
  const merged = mergeSeriesOverlay({
    snapshot: context.snapshot, workEntities: workStory.entities, workLinks: workStory.links,
    bibleEntities: bibleStory.entities, bibleLinks: bibleStory.links,
  });
  const workRecords = new Map<string, OverlaySourceRecord>();
  for (const [id, entity] of workStory.entities) workRecords.set(id, overlayEntityRecord("work", entity, context, workStory));
  const bibleRecords = new Map<string, OverlaySourceRecord>();
  for (const [id, entity] of bibleStory.entities) bibleRecords.set(id, overlayEntityRecord("bible", entity, sourceRequest, bibleStory));

  const entities = [...merged.data.entities].map(([id, display]) => {
    const sourceRecords = [bibleRecords.get(id), workRecords.get(id)].filter((record): record is OverlaySourceRecord => !!record);
    return { id, preferredSource: workRecords.has(id) ? "work" as const : "bible" as const, display, sourceRecords };
  });
  const linkRecords = new Map<string, Array<Record<string, unknown>>>();
  for (const [source, story, request] of [["bible", bibleStory, sourceRequest], ["work", workStory, context]] as const) {
    for (const link of story.links) {
      const entity = story.entities.get(link.from);
      if (!entity) continue;
      const revision = story.revisions.get(entity.filePath);
      const records = linkRecords.get(overlayLinkKey(link)) ?? [];
      records.push({ source, link, scope: request.scope, snapshot: request.snapshot, path: entity.filePath, ...(revision ? { revision } : {}) });
      linkRecords.set(overlayLinkKey(link), records);
    }
  }
  const links = merged.data.links.map((link) => ({ ...link, sourceRecords: linkRecords.get(overlayLinkKey(link)) ?? [] }));

  const brokenReferences: Array<Record<string, unknown>> = [];
  for (const [source, story, request] of [["bible", bibleStory, sourceRequest], ["work", workStory, context]] as const) {
    for (const link of story.links) {
      if (merged.data.entities.has(link.to)) continue;
      const from = story.entities.get(link.from);
      brokenReferences.push({
        source, link, entityId: link.from, targetId: link.to, scope: request.scope, snapshot: request.snapshot,
        ...(from ? { path: from.filePath, revision: story.revisions.get(from.filePath) } : {}),
        message: `Unresolved ${link.kind} reference ${link.to}`,
      });
    }
  }

  const conflicts: Array<Record<string, unknown>> = [];
  for (const [source, story, request] of [["bible", bibleStory, sourceRequest], ["work", workStory, context]] as const) {
    for (const [entityId, paths] of story.duplicateIds) conflicts.push({ kind: "duplicate_id", source, entityId, paths, scope: request.scope, snapshot: request.snapshot });
    for (const diagnostic of story.diagnostics) {
      if (diagnostic.code === "broken_reference" || diagnostic.code === "duplicate_id") continue;
      conflicts.push({ kind: "source_diagnostic", source, ...diagnostic, scope: request.scope, snapshot: request.snapshot });
    }
  }
  for (const [entityId, workRecord] of workRecords) {
    const bibleRecord = bibleRecords.get(entityId);
    if (bibleRecord && bibleRecord.entity.type !== workRecord.entity.type) conflicts.push({
      kind: "entity_type_mismatch", entityId, workType: workRecord.entity.type, bibleType: bibleRecord.entity.type,
      workPath: workRecord.path, biblePath: bibleRecord.path,
    });
  }
  const value = {
    entities, links, workSnapshot: context.snapshot, bibleSnapshot: sourceRequest.snapshot,
    binding: { ...binding, ...(positiveRepositoryId(bibleRepositoryId) ? { bibleRepositoryId } : {}) },
    brokenReferences, conflicts,
  };
  let serialized: string;
  try { serialized = JSON.stringify(value); }
  catch (cause) { throw error("unsupported_format", `Series overlay contains non-JSON source data: ${cause instanceof Error ? cause.message : String(cause)}`, { kind: "non_json_overlay_source" }); }
  if (new TextEncoder().encode(serialized).byteLength > 1_048_576) throw error("capacity", "Series overlay result exceeds the bounded action result size", {
    kind: "overlay_result_too_large", entityCount: entities.length, linkCount: links.length,
  });
  return value;
}

const BIBLE_ENTITY_TYPES: readonly StoryEntityType[] = ["character", "location", "item", "faction", "event", "lore", "thread", "arc", "dialogue_sketch"];
const ENTITY_PREFIX: Partial<Record<StoryEntityType, string>> = {
  character: "char-", location: "loc-", item: "item-", faction: "faction-", event: "event-",
  lore: "lore-", thread: "thread-", arc: "arc-", dialogue_sketch: "ds-",
};
const SAFE_ID = /^[A-Za-z0-9_-]+$/u;

function requireRecord(value: unknown, key: string): Record<string, unknown> {
  if (!isRecord(value)) throw error("invalid_input", `${key} must be an object`);
  return value;
}

function validateJsonSize(value: unknown): void {
  let nodes = 0;
  const visit = (node: unknown, depth: number): void => {
    if (++nodes > 10_000 || depth > 16) throw error("capacity", "Input JSON exceeds the Knowledge depth or node limit");
    if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return; }
    if (isRecord(node)) { for (const item of Object.values(node)) visit(item, depth + 1); return; }
    if (typeof node === "number" && !Number.isFinite(node)) throw error("invalid_input", "Input contains a non-finite number");
  };
  visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 1_048_576) throw error("capacity", "Input JSON exceeds the 1 MiB limit");
}

function entityFilePath(type: StoryEntityType, id: string): string {
  if (!SAFE_ID.test(id)) throw error("invalid_input", "Entity ID must contain only ASCII letters, digits, hyphens and underscores");
  if (type === "character") return `bible/characters/${id}/profile.yaml`;
  const flat: Partial<Record<StoryEntityType, string>> = {
    location: "bible/locations", item: "bible/items", faction: "bible/factions", event: "bible/timeline/events",
    lore: "bible/lore", thread: "plot/threads", arc: "plot/arcs", dialogue_sketch: "bible/dialogue_sketches",
  };
  const directory = flat[type];
  if (!directory) throw error("unsupported_schema", `Knowledge cannot create ${type} records`);
  return `${directory}/${id}.yaml`;
}

function allocateEntityId(type: StoryEntityType, story: LoadedKnowledgeSnapshot, hint?: string): string {
  const prefix = ENTITY_PREFIX[type];
  if (!prefix) throw error("unsupported_schema", `Knowledge cannot create ${type} records`);
  const slug = (hint === undefined ? "" : normalizeUnicode(hint.trim(), "NFKC").toLowerCase()).replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48);
  const base = slug ? `${prefix}${slug}` : `${prefix}1`;
  const used = (id: string) => story.entities.has(id) || story.duplicateIds.has(id);
  if (!used(base)) return base;
  for (let suffix = 2; suffix <= 9999; suffix++) {
    const candidate = slug ? `${base}-${suffix}` : `${prefix}${suffix}`;
    if (!used(candidate)) return candidate;
  }
  throw error("capacity", `Knowledge exhausted safe IDs for ${type}`);
}

function entitySetReads(story: LoadedKnowledgeSnapshot): ProposalRead[] {
  return [...story.files.values()]
    .filter((file) => /^(?:bible|plot)\//u.test(file.path) && /\.(?:yaml|yml)$/u.test(file.path))
    .map((file) => ({ path: file.path, revision: file.revision }));
}

function entityReferenceIds(raw: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (typeof item === "string" && item) ids.add(item);
      else if (isRecord(item)) {
        const target = item.target ?? item.to ?? item.scene ?? item.id;
        if (typeof target === "string" && target) ids.add(target);
      }
    }
  };
  for (const key of ["volume", "chapter", "pov", "location", "resolution", "appears", "mentions", "plants", "advances", "related", "affiliated", "target", "first_appears", "planted", "payoff"]) add(raw[key]);
  if (Array.isArray(raw.relations)) add(raw.relations);
  if (isRecord(raw.entities)) for (const key of ["appears", "mentions", "plants", "advances", "related", "pov", "affiliated", "target", "first_appears", "planted", "payoff"]) add(raw.entities[key]);
  if (isRecord(raw.threads)) { add(raw.threads.plants); add(raw.threads.advances); }
  if (Array.isArray(raw.participantEntityIds)) add(raw.participantEntityIds);
  if (Array.isArray(raw.lines)) for (const line of raw.lines) if (isRecord(line)) add(line.speakerEntityId);
  return [...ids];
}

function validateEntityReferences(raw: Record<string, unknown>, story: LoadedKnowledgeSnapshot, omitId?: string): StoryEntity[] {
  const resolved: StoryEntity[] = [];
  const typeField: Record<string, StoryEntityType> = { pov: "character", location: "location", chapter: "chapter", volume: "volume", resolution: "scene" };
  for (const [field, type] of Object.entries(typeField)) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") throw error("invalid_input", `${field} must be a stable entity ID or null`);
    const entity = getEntity(story, value);
    if (entity.type !== type) throw error("invalid_input", `${field} must reference a ${type}`, { field, entityId: value });
  }
  for (const id of entityReferenceIds(raw)) {
    if (id === omitId) throw error("invalid_input", "An entity cannot reference itself", { id });
    const entity = getEntity(story, id);
    resolved.push(entity);
  }
  if (raw.type === "dialogue_sketch" || raw.participantEntityIds !== undefined || raw.lines !== undefined) {
    if (typeof raw.title !== "string" || !raw.title.trim()) throw error("invalid_input", "Dialogue sketches require a non-empty title");
    if (raw.situation !== undefined && typeof raw.situation !== "string") throw error("invalid_input", "Dialogue sketch situation must be text");
    if (!Array.isArray(raw.participantEntityIds) || raw.participantEntityIds.some((id) => typeof id !== "string") || new Set(raw.participantEntityIds).size !== raw.participantEntityIds.length) {
      throw error("invalid_input", "Dialogue sketch participantEntityIds must be unique character IDs");
    }
    const participants = new Set<string>();
    for (const id of raw.participantEntityIds as string[]) {
      if (getEntity(story, id).type !== "character") throw error("invalid_input", `Dialogue sketch participant ${id} is not a character`);
      participants.add(id);
    }
    if (!Array.isArray(raw.lines)) throw error("invalid_input", "Dialogue sketch lines must be an ordered array");
    for (const [index, line] of raw.lines.entries()) {
      if (!isRecord(line) || typeof line.speakerEntityId !== "string" || !participants.has(line.speakerEntityId) || typeof line.text !== "string" || !line.text.trim()) {
        throw error("invalid_input", `Dialogue sketch line ${index + 1} needs a selected character speaker and non-empty text`);
      }
    }
  }
  return resolved;
}

function readsForReferences(story: LoadedKnowledgeSnapshot, entities: readonly StoryEntity[]): ProposalRead[] {
  const unique = new Map<string, ProposalRead>();
  for (const entity of entities) {
    const file = story.files.get(entity.filePath);
    const revision = story.revisions.get(entity.filePath);
    if (!file || !revision) throw error("file_not_found", `Referenced entity source is missing: ${entity.filePath}`, { path: entity.filePath });
    unique.set(entity.filePath, { path: entity.filePath, revision, content: file.content });
  }
  return [...unique.values()];
}

function parseYamlRecord(file: StoryFile, kind: string): Record<string, unknown> {
  let value: unknown;
  try { value = YAML.parse(file.content); } catch (cause) { throw error("unsupported_format", `Malformed YAML in ${file.path}: ${cause instanceof Error ? cause.message : String(cause)}`, { path: file.path, kind }); }
  if (!isRecord(value)) throw error("unsupported_format", `${file.path} must contain a YAML object`, { path: file.path, kind });
  return value;
}

function* entityCreate(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, ["type", "values", "expectedCollectionRevision"]);
  const type = requiredString(input, "type") as StoryEntityType;
  if (!BIBLE_ENTITY_TYPES.includes(type)) throw error("unsupported_schema", `Knowledge cannot create ${type}`);
  const values = requireRecord(input.values, "values");
  validateJsonSize(values);
  const story = yield* storyFor(context, host);
  const expected = requiredString(input, "expectedCollectionRevision");
  if (expected !== collectionRevision(story)) throw error("snapshot_stale", "Bible collection changed after the selected snapshot", { expectedCollectionRevision: expected, actualCollectionRevision: collectionRevision(story) });
  if (values.type !== undefined && values.type !== type) throw error("invalid_input", "Entity values cannot change the requested type");
  const hint = typeof values.name === "string" ? values.name : typeof values.title === "string" ? values.title : undefined;
  const id = values.id === undefined ? allocateEntityId(type, story, hint) : requiredString(values, "id");
  if (!SAFE_ID.test(id) || story.entities.has(id) || story.duplicateIds.has(id)) throw error("ambiguous_identity", `Entity ID ${id} is invalid, already present, or ambiguous`, { id });
  if (type === "dialogue_sketch" && !id.startsWith("ds-")) throw error("invalid_input", "Dialogue sketch IDs must use the ds- prefix");
  const raw = { ...values, id, type };
  const references = validateEntityReferences(raw, story, id);
  const path = entityFilePath(type, id);
  const exact = yield* readOptionalPath(createSnapshotReader(context, host), path);
  if (exact) throw error("conflict", `Entity path already exists: ${path}`, { path, revision: exact.revision });
  const reads = entitySetReads(story);
  reads.push({ path, revision: null });
  const submitted = yield* submitProposal({
    context, host, title: `Create ${type} ${id}`, reason: `Add a ${type} record to the pinned Bible snapshot.`,
    reads: [...reads, ...readsForReferences(story, references)],
    writes: [{ path, expected_revision: null, content: YAML.stringify(raw) }],
  });
  return { entityId: id, path, proposalId: submitted.proposalId, preview: submitted.preview };
}

function* entityUpdate(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, ["id", "patch", "expectedEntityRevision"]);
  const id = requiredString(input, "id");
  const patch = requireRecord(input.patch, "patch");
  validateJsonSize(patch);
  if (Object.hasOwn(patch, "id") || Object.hasOwn(patch, "type")) throw error("invalid_input", "Entity identity and type are immutable");
  if (Object.keys(patch).length === 0) throw error("invalid_input", "Entity patch must change at least one field");
  const story = yield* storyFor(context, host);
  const entity = getEntity(story, id);
  if (!BIBLE_ENTITY_TYPES.includes(entity.type)) throw error("unsupported_schema", `Knowledge cannot update ${entity.type} records`);
  const expected = requiredString(input, "expectedEntityRevision");
  const currentRevision = entityRevision(entity, story);
  if (expected !== currentRevision) throw error("snapshot_stale", "Entity changed after the selected snapshot", { id, expectedEntityRevision: expected, actualEntityRevision: currentRevision, path: entity.filePath });
  const file = story.files.get(entity.filePath);
  if (!file) throw error("file_not_found", `Entity source is missing: ${entity.filePath}`, { path: entity.filePath });
  const sourceRaw = parseYamlRecord(file, "entity");
  if (entity.type === "character" && entity.filePath.endsWith("/profile.yaml") && Object.hasOwn(patch, "voice")) {
    const voicePath = entity.filePath.replace(/profile\.yaml$/u, "voice.yaml");
    if (story.files.has(voicePath)) throw error("unsupported_schema", "Sibling voice.yaml cannot be edited through the character profile action", { path: voicePath });
  }
  const next: Record<string, unknown> = { ...sourceRaw };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  next.id = entity.id; next.type = entity.type;
  const references = validateEntityReferences(next, story, id);
  const reads: ProposalRead[] = [{ path: entity.filePath, revision: currentRevision, content: file.content }, ...readsForReferences(story, references)];
  const writes: ProposalWrite[] = [{ path: entity.filePath, expected_revision: currentRevision, content: YAML.stringify(next) }];
  if (Object.hasOwn(patch, "notes")) {
    const changedBlocks = changedNoteBlockPaths(entity.raw.notes, next.notes);
    if (changedBlocks.size) {
      const suggestions = yield* readJsonl(context, host, ZUKAN_SUGGESTIONS_PATH, "ZukanSuggestion", LEGACY_ZUKAN_SUGGESTIONS_PATH);
      for (const row of suggestions.rows) assertSuggestion(row, suggestions.file?.path ?? ZUKAN_SUGGESTIONS_PATH);
      const pending = suggestions.rows.filter((row) => row.entityId === id && row.status === "pending" && changedBlocks.has(String(row.blockPath)));
      if (pending.length && suggestions.file) {
        const updatedAt = yield* stableTimestamp(context, host);
        const pendingIds = new Set(pending.map((row) => row.id));
        const nextRows = suggestions.rows.map((row) => pendingIds.has(row.id) ? { ...row, status: "stale", updatedAt } : row);
        reads.push({ path: suggestions.file.path, revision: suggestions.file.revision, content: suggestions.file.content });
        writes.push({ path: suggestions.file.path, expected_revision: suggestions.file.revision, content: jsonlContent(nextRows) });
      }
    }
  }
  const submitted = yield* submitProposal({
    context, host, title: `Update ${entity.type} ${id}`, reason: "Apply the typed entity patch while preserving existing source fields.", reads,
    writes,
  });
  return { entityId: id, proposalId: submitted.proposalId, preview: submitted.preview };
}

function* sceneReferencesPropose(input: Record<string, unknown>, context: ActionRequest, host: GuestHost) {
  assertKeys(input, ["sceneId", "patch", "expectedSceneRevision"]);
  const sceneId = requiredString(input, "sceneId");
  const patch = requireRecord(input.patch, "patch");
  validateJsonSize(patch);
  const allowed = ["pov", "location", "appears", "mentions", "relations"];
  const unknown = Object.keys(patch).filter((key) => !allowed.includes(key));
  if (unknown.length) throw error("unsupported_schema", `Scene reference patch cannot change ${unknown[0]}`, { field: unknown[0], kind: "narrative_owned" });
  if (!Object.keys(patch).length) throw error("invalid_input", "Scene reference patch must change at least one field");
  const story = yield* storyFor(context, host);
  const scene = sourceErrorIfSceneMissing(story.entities.get(sceneId), sceneId);
  const expected = requiredString(input, "expectedSceneRevision");
  const revision = entityRevision(scene, story);
  if (expected !== revision) throw error("snapshot_stale", "Scene references changed after the selected snapshot", { sceneId, expectedSceneRevision: expected, actualSceneRevision: revision, path: scene.filePath });
  const next: Record<string, unknown> = { ...scene.raw };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  const references = validateEntityReferences(next, story, sceneId);
  const file = story.files.get(scene.filePath);
  if (!file) throw error("file_not_found", `Scene source is missing: ${scene.filePath}`, { path: scene.filePath });
  const submitted = yield* submitProposal({
    context, host, title: `Update references for scene ${sceneId}`, reason: "Change only authored Knowledge scene references.",
    reads: [{ path: scene.filePath, revision, content: file.content }, ...readsForReferences(story, references)],
    writes: [{ path: scene.filePath, expected_revision: revision, content: YAML.stringify(next) }],
  });
  return { sceneId, proposalId: submitted.proposalId, changedFields: Object.keys(patch), preview: submitted.preview };
}

export const knowledgeHandlers: Record<string, Handler> = {
  "knowledge.snapshot.status": snapshotStatus,
  "knowledge.entities.list": entityList,
  "knowledge.entities.collection-revision": entityCollectionRevision,
  "knowledge.entities.get": entityGet,
  "knowledge.entities.create": entityCreate,
  "knowledge.entities.update": entityUpdate,
  "knowledge.entities.backlinks": entityBacklinks,
  "knowledge.entities.appearances": entityAppearances,
  "knowledge.entities.declared-voice": declaredVoice,
  "knowledge.entities.freshness": freshness,
  "knowledge.tags.list": tagsList,
  "knowledge.tags.suggested": tagsSuggested,
  "knowledge.scene.references.get": sceneReferencesGet,
  "knowledge.scene.references.propose": sceneReferencesPropose,
  "proprium.knowledge.changes.compile": compileKnowledgeChanges,
  "knowledge.scene.context": sceneContext,
  "knowledge.threads.overview": threadsOverview,
  "knowledge.threads.status": threadsStatus,
  "knowledge.threads.lifecycle": threadsLifecycle,
  "knowledge.graph.query": graphQuery,
  "knowledge.graph.cooccurrence": graphCooccurrence,
  "knowledge.map.query": mapQuery,
  "knowledge.timeline.query": timelineQuery,
  "knowledge.world-state.at-scene": worldStateAtScene,
  "knowledge.world-state.history": worldStateHistory,
  "knowledge.world-state.workbench": worldStateWorkbench,
  "knowledge.state-proposals.list": stateProposalsList,
  "knowledge.state-proposals.create": stateProposalCreate,
  "knowledge.state-proposals.update": stateProposalUpdate,
  "knowledge.state-proposals.decide": stateProposalDecide,
  "knowledge.suggestions.list": suggestionsList,
  "knowledge.suggestions.create": suggestionCreate,
  "knowledge.suggestions.decide": suggestionDecide,
  "knowledge.series.list": seriesList,
  "knowledge.series.get": seriesGet,
  "knowledge.series.propose": seriesPropose,
  "knowledge.series.binding.get": seriesBindingGet,
  "knowledge.series.binding.propose": seriesBindingPropose,
  "knowledge.series.overlay": seriesOverlay,
  "knowledge.reader-model.build": readerModelBuild,
};

export function clearKnowledgeCache(): void { cachedKey = ""; cachedStory = undefined; }
