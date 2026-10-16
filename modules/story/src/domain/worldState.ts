import { buildSceneLocationInfos } from "./graph.js";
import {
  snapshotResult,
  type StoryEntity,
  type StoryGraphInput,
  type StorySnapshotResult,
} from "./types.js";
import type { SnapshotId } from "@scriptorium/contracts";

export type SceneStateEventKind = "location" | "acquaintance" | "ownership" | "knowledge";
export type SceneStateEventSource = "rule" | "llm-draft" | "manual";
export type StateAssertionStatus = "proposed" | "confirmed" | "rejected" | "superseded";

export interface StateProposition {
  id: string;
  predicate: string;
  subject: string;
  object: string | null;
  payload: Record<string, unknown>;
}

export interface StateEvidence {
  sceneId: string;
  excerpt?: string;
  startOffset?: number;
  endOffset?: number;
}

export interface ObjectiveState {
  layer: "objective";
  proposition: StateProposition;
  evidence: StateEvidence[];
  confidence: number;
  status: StateAssertionStatus;
  createdAt: string;
  replacesEventId?: string;
}

export interface CharacterBeliefState {
  layer: "character-belief";
  characterId: string;
  proposition: StateProposition;
  evidence: StateEvidence[];
  confidence: number;
  status: StateAssertionStatus;
  createdAt: string;
  replacesEventId?: string;
}

export interface ReaderKnowledgeState {
  layer: "reader-knowledge";
  proposition: StateProposition;
  evidence: StateEvidence[];
  confidence: number;
  status: StateAssertionStatus;
  createdAt: string;
  replacesEventId?: string;
}

/** Snapshot id is carried by the query result, never persisted on a raw event. */
export interface SceneStateEvent {
  sceneId: string;
  order: number;
  kind: SceneStateEventKind;
  subject: string;
  object: string | null;
  payload: Record<string, unknown>;
  source: SceneStateEventSource;
  eventId?: string;
  propositionId?: string;
  evidence?: StateEvidence[];
  confidence?: number;
  createdAt?: string;
  status?: StateAssertionStatus;
  replacesEventId?: string;
}

export interface CharacterLocationState {
  locationId: string;
  sinceSceneId: string;
}

export interface ItemOwnerState {
  ownerCharacterId: string | null;
  sinceSceneId: string;
}

export interface AcquaintanceState {
  a: string;
  b: string;
  sinceSceneId: string;
}

export interface WorldStateSnapshot {
  sceneId: string;
  order: number;
  locations: Record<string, CharacterLocationState>;
  acquaintances: AcquaintanceState[];
  itemOwners: Record<string, ItemOwnerState>;
}

export interface EntityStateHistoryEntry {
  sceneId: string;
  order: number;
  kind: SceneStateEventKind;
  subject: string;
  object: string | null;
  payload: Record<string, unknown>;
  source: SceneStateEventSource;
}

export interface EntityStateHistory {
  entityId: string;
  entries: EntityStateHistoryEntry[];
}

type SceneEffect =
  | { action: "move_to"; characterId: string; toLocationId: string }
  | { action: "transfer_item"; itemId: string; toCharacterId: string; fromCharacterId?: string }
  | { action: "acquire_item" | "drop_item" | "use_item"; characterId: string; itemId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseSceneEffects(raw: unknown): SceneEffect[] {
  if (!Array.isArray(raw)) return [];
  const effects: SceneEffect[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.action !== "string") continue;
    switch (item.action) {
      case "move_to":
        if (typeof item.characterId === "string" && typeof item.toLocationId === "string") {
          effects.push({ action: "move_to", characterId: item.characterId, toLocationId: item.toLocationId });
        }
        break;
      case "transfer_item":
        if (typeof item.itemId === "string" && typeof item.toCharacterId === "string") {
          effects.push({
            action: "transfer_item",
            itemId: item.itemId,
            toCharacterId: item.toCharacterId,
            fromCharacterId: typeof item.fromCharacterId === "string" ? item.fromCharacterId : undefined,
          });
        }
        break;
      case "acquire_item":
      case "drop_item":
      case "use_item":
        if (typeof item.characterId === "string" && typeof item.itemId === "string") {
          effects.push({ action: item.action, characterId: item.characterId, itemId: item.itemId });
        }
        break;
    }
  }
  return effects;
}

function isSceneStateEventKind(value: unknown): value is SceneStateEventKind {
  return value === "location" || value === "ownership" || value === "acquaintance" || value === "knowledge";
}

function stateEventFromRaw(raw: unknown, sceneId: string, order: number, requireSceneId: boolean): SceneStateEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const event = raw as Partial<SceneStateEvent>;
  if (!isSceneStateEventKind(event.kind) || typeof event.subject !== "string") return null;
  if (requireSceneId && typeof event.sceneId !== "string") return null;
  return {
    sceneId: typeof event.sceneId === "string" ? event.sceneId : sceneId,
    order: typeof event.order === "number" ? event.order : order,
    kind: event.kind,
    subject: event.subject,
    object: typeof event.object === "string" ? event.object : null,
    payload: event.payload && typeof event.payload === "object" ? (event.payload as Record<string, unknown>) : {},
    source: "manual",
    eventId: event.eventId,
    propositionId: event.propositionId,
    evidence: event.evidence,
    confidence: event.confidence,
    createdAt: event.createdAt,
    status: "confirmed",
    replacesEventId: event.replacesEventId,
  };
}

function extractRuleStateEventsData(input: StoryGraphInput): SceneStateEvent[] {
  const scenes = buildSceneLocationInfos(input).data;
  const events: SceneStateEvent[] = [];
  const knownPairs = new Set<string>();
  const lastLocation = new Map<string, string>();

  for (const scene of scenes) {
    const rawEffects = input.entities.get(scene.sceneId)?.raw.effects;
    const effects = parseSceneEffects(rawEffects);
    for (const effect of effects) {
      switch (effect.action) {
        case "transfer_item":
          events.push({
            sceneId: scene.sceneId,
            order: scene.order,
            kind: "ownership",
            subject: effect.itemId,
            object: effect.toCharacterId,
            payload: { action: "transfer_item", fromCharacterId: effect.fromCharacterId ?? null },
            source: "rule",
          });
          break;
        case "acquire_item":
          events.push({
            sceneId: scene.sceneId,
            order: scene.order,
            kind: "ownership",
            subject: effect.itemId,
            object: effect.characterId,
            payload: { action: "acquire_item" },
            source: "rule",
          });
          break;
        case "drop_item":
          events.push({
            sceneId: scene.sceneId,
            order: scene.order,
            kind: "ownership",
            subject: effect.itemId,
            object: null,
            payload: { action: "drop_item", characterId: effect.characterId },
            source: "rule",
          });
          break;
        case "use_item":
          events.push({
            sceneId: scene.sceneId,
            order: scene.order,
            kind: "ownership",
            subject: effect.itemId,
            object: effect.characterId,
            payload: { action: "use_item", characterId: effect.characterId },
            source: "rule",
          });
          break;
        default:
          break;
      }
    }

    for (const effect of effects) {
      if (effect.action !== "move_to") continue;
      events.push({
        sceneId: scene.sceneId,
        order: scene.order,
        kind: "location",
        subject: effect.characterId,
        object: effect.toLocationId,
        payload: { via: "move_to" },
        source: "rule",
      });
      lastLocation.set(effect.characterId, effect.toLocationId);
    }

    if (scene.locationId) {
      for (const characterId of scene.characterIds) {
        if (lastLocation.get(characterId) === scene.locationId) continue;
        events.push({
          sceneId: scene.sceneId,
          order: scene.order,
          kind: "location",
          subject: characterId,
          object: scene.locationId,
          payload: { via: "appears" },
          source: "rule",
        });
        lastLocation.set(characterId, scene.locationId);
      }
    }

    const uniqueCharacterIds = [...new Set(scene.characterIds)].sort();
    for (let leftIndex = 0; leftIndex < uniqueCharacterIds.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < uniqueCharacterIds.length; rightIndex++) {
        const left = uniqueCharacterIds[leftIndex]!;
        const right = uniqueCharacterIds[rightIndex]!;
        const key = `${left}|${right}`;
        if (knownPairs.has(key)) continue;
        knownPairs.add(key);
        events.push({
          sceneId: scene.sceneId,
          order: scene.order,
          kind: "acquaintance",
          subject: left,
          object: right,
          payload: { via: "cooccurrence" },
          source: "rule",
        });
      }
    }

    const rawEvents = input.entities.get(scene.sceneId)?.raw.state_events;
    if (Array.isArray(rawEvents)) {
      for (const rawEvent of rawEvents) {
        const event = stateEventFromRaw(rawEvent, scene.sceneId, scene.order, true);
        if (event) events.push(event);
      }
    }
  }

  const processedSceneIds = new Set(scenes.map((scene) => scene.sceneId));
  for (const entity of input.entities.values()) {
    if (entity.type !== "scene" || processedSceneIds.has(entity.id)) continue;
    const rawEvents = entity.raw.state_events;
    if (!Array.isArray(rawEvents)) continue;
    const order = typeof entity.raw.order === "number" ? entity.raw.order : 0;
    for (const rawEvent of rawEvents) {
      const event = stateEventFromRaw(rawEvent, entity.id, order, false);
      if (event) events.push(event);
    }
  }
  return events;
}

export function extractRuleStateEvents(
  input: StoryGraphInput,
): StorySnapshotResult<SceneStateEvent[]> {
  return snapshotResult(input.snapshot, extractRuleStateEventsData(input));
}

function sortEvents(events: readonly SceneStateEvent[]): SceneStateEvent[] {
  return [...events].sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    const rank = (event: SceneStateEvent): number => {
      if (event.kind === "ownership") return 0;
      if (event.kind === "location" && event.payload.via === "move_to") return 1;
      if (event.kind === "location") return 2;
      if (event.kind === "acquaintance") return 3;
      return 4;
    };
    return rank(a) - rank(b);
  });
}

function applyEvent(
  event: SceneStateEvent,
  locations: Map<string, CharacterLocationState>,
  itemOwners: Map<string, ItemOwnerState>,
  acquaintances: Map<string, AcquaintanceState>,
): void {
  if (event.source === "llm-draft" || (event.status !== undefined && event.status !== "confirmed")) return;
  switch (event.kind) {
    case "location":
      if (event.object) {
        locations.set(event.subject, { locationId: event.object, sinceSceneId: event.sceneId });
      }
      break;
    case "ownership":
      if (event.payload.action === "use_item") break;
      itemOwners.set(event.subject, { ownerCharacterId: event.object, sinceSceneId: event.sceneId });
      break;
    case "acquaintance":
      if (event.object) {
        const a = event.subject < event.object ? event.subject : event.object;
        const b = event.subject < event.object ? event.object : event.subject;
        const key = `${a}|${b}`;
        if (!acquaintances.has(key)) acquaintances.set(key, { a, b, sinceSceneId: event.sceneId });
      }
      break;
    case "knowledge":
      break;
  }
}

function foldWorldStateUpToOrderData(
  events: readonly SceneStateEvent[],
  sceneId: string,
  order: number,
): WorldStateSnapshot {
  const locations = new Map<string, CharacterLocationState>();
  const itemOwners = new Map<string, ItemOwnerState>();
  const acquaintances = new Map<string, AcquaintanceState>();
  for (const event of sortEvents(events)) {
    if (event.order > order) break;
    applyEvent(event, locations, itemOwners, acquaintances);
  }
  return {
    sceneId,
    order,
    locations: Object.fromEntries(locations),
    acquaintances: [...acquaintances.values()].sort((a, b) =>
      a.a !== b.a ? (a.a < b.a ? -1 : 1) : a.b < b.b ? -1 : a.b > b.b ? 1 : 0,
    ),
    itemOwners: Object.fromEntries(itemOwners),
  };
}

export function foldWorldStateUpToOrder(input: {
  snapshot: SnapshotId;
  events: readonly SceneStateEvent[];
  sceneId: string;
  order: number;
}): StorySnapshotResult<WorldStateSnapshot> {
  return snapshotResult(
    input.snapshot,
    foldWorldStateUpToOrderData(input.events, input.sceneId, input.order),
  );
}

export function foldWorldStateAtScene(input: {
  snapshot: SnapshotId;
  events: readonly SceneStateEvent[];
  sceneId: string;
}): StorySnapshotResult<WorldStateSnapshot | null> {
  const order = input.events.find((event) => event.sceneId === input.sceneId)?.order;
  return snapshotResult(
    input.snapshot,
    order === undefined ? null : foldWorldStateUpToOrderData(input.events, input.sceneId, order),
  );
}

function buildEntityStateHistoryData(
  events: readonly SceneStateEvent[],
  entityId: string,
): EntityStateHistory {
  const entries = sortEvents(events)
    .filter((event) => event.subject === entityId || event.object === entityId)
    .map((event) => ({
      sceneId: event.sceneId,
      order: event.order,
      kind: event.kind,
      subject: event.subject,
      object: event.object,
      payload: event.payload,
      source: event.source,
    }));
  return { entityId, entries };
}

export function buildEntityStateHistory(input: {
  snapshot: SnapshotId;
  events: readonly SceneStateEvent[];
  entityId: string;
}): StorySnapshotResult<EntityStateHistory> {
  return snapshotResult(input.snapshot, buildEntityStateHistoryData(input.events, input.entityId));
}

export function getWorldStateAtScene(
  input: StoryGraphInput & { sceneId: string },
): StorySnapshotResult<WorldStateSnapshot | null> {
  const scene = input.entities.get(input.sceneId);
  if (scene?.type !== "scene") return snapshotResult(input.snapshot, null);
  const info = buildSceneLocationInfos(input).data.find((item) => item.sceneId === input.sceneId);
  if (!info) return snapshotResult(input.snapshot, null);
  const events = extractRuleStateEventsData(input);
  return snapshotResult(
    input.snapshot,
    foldWorldStateUpToOrderData(events, input.sceneId, info.order),
  );
}

export function getEntityStateHistory(
  input: StoryGraphInput & { entityId: string },
): StorySnapshotResult<EntityStateHistory | null> {
  if (!input.entities.has(input.entityId)) return snapshotResult(input.snapshot, null);
  return snapshotResult(
    input.snapshot,
    buildEntityStateHistoryData(extractRuleStateEventsData(input), input.entityId),
  );
}

export function listRuleStateEvents(input: StoryGraphInput): StorySnapshotResult<SceneStateEvent[]> {
  return snapshotResult(input.snapshot, extractRuleStateEventsData(input));
}

export type { StoryEntity };
