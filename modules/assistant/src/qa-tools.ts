import { type ToolSet, tool } from "ai";
import { z } from "zod";

const BIBLE_TYPES = new Set(["character", "location", "item", "faction", "lore", "thread", "event"]);
const MAX_QUERY_LENGTH = 8_192;
const MAX_ID_LENGTH = 256;
const MAX_QUOTE_LENGTH = 400;
const MAX_SCENE_RESULTS = 8;
const MAX_BIBLE_RESULTS = 8;
const MAX_WORLD_STATE_ENTRIES = 32;
const MAX_ACQUAINTANCES = 24;
const MAX_SUMMARY_LINES = 12;

export type AssistantQaSummaryScope = "scene" | "chapter" | "volume";
export type AssistantQaSearchMode = "scene" | "sentence";

/**
 * Read-only project access supplied by the action layer. Scene search should
 * invoke `semantic.search`; Bible search is a bounded local lookup over public
 * Story entities; world state should invoke `story.world-state.at-scene`;
 * summary lookup should read the accepted assistant summary through the
 * caller's public snapshot reader/capability. This helper has no project
 * reader, filesystem, or proposal/write access.
 */
export interface AssistantQaReadCapabilities {
  semanticSearch(input: {
    query: string;
    mode: AssistantQaSearchMode;
    limit: number;
    rerank: false;
  }): Promise<unknown>;
  searchBible(query: string, entityKind?: string): Promise<unknown>;
  worldStateAtScene(input: { sceneId: string }): Promise<unknown>;
  readSummary(input: { scope: AssistantQaSummaryScope; id: string }): Promise<unknown>;
}

export interface AssistantQaToolCallRecord {
  toolName: string;
  input: unknown;
  resultSummary: string;
  chars: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unwrapActionData(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (value.ok === false) throw new Error("Read action failed");
  if (value.ok === true && Object.hasOwn(value, "data")) return value.data;
  return value;
}

function getResults(value: unknown): Record<string, unknown>[] {
  const data = unwrapActionData(value);
  const results = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.results) ? data.results : [];
  return results.filter(isRecord);
}

function limitedText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.slice(0, max);
}

function citationFields(source: Record<string, unknown>, sourceId: string, quote: string) {
  const path = typeof source.path === "string" ? source.path : typeof source.filePath === "string" ? source.filePath : undefined;
  const revision = typeof source.revision === "string" ? source.revision : undefined;
  return {
    sourceId: limitedText(sourceId, MAX_ID_LENGTH),
    quote,
    ...(path ? { path: limitedText(path, 1_024) } : {}),
    ...(revision ? { revision: limitedText(revision, 512) } : {}),
  };
}

function summarize(value: unknown): string {
  let raw: string;
  try {
    raw = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  } catch {
    raw = "[unserializable result]";
  }
  return raw.length > 1_200 ? `${raw.slice(0, 1_200)}…` : raw;
}

function recordCall(
  log: AssistantQaToolCallRecord[] | undefined,
  toolName: string,
  input: unknown,
  result: unknown,
): void {
  if (!log) return;
  const resultSummary = summarize(result);
  log.push({ toolName, input, resultSummary, chars: resultSummary.length });
}

function limitedStateMap<T>(
  value: unknown,
  mapValue: (value: unknown) => T | null,
): { entries: Record<string, T>; truncated: boolean } {
  if (!isRecord(value)) return { entries: {}, truncated: false };
  const rows = Object.entries(value);
  const entries: Record<string, T> = {};
  let truncated = rows.length > MAX_WORLD_STATE_ENTRIES;
  for (const [id, item] of rows.slice(0, MAX_WORLD_STATE_ENTRIES)) {
    if (id.length > MAX_ID_LENGTH) {
      truncated = true;
      continue;
    }
    const mapped = mapValue(item);
    if (mapped === null) {
      truncated = true;
      continue;
    }
    entries[id] = mapped;
  }
  return { entries, truncated };
}

function mapLocation(value: unknown): { locationId: string; sinceSceneId: string } | null {
  if (!isRecord(value) || typeof value.locationId !== "string" || typeof value.sinceSceneId !== "string") return null;
  return {
    locationId: limitedText(value.locationId, MAX_ID_LENGTH),
    sinceSceneId: limitedText(value.sinceSceneId, MAX_ID_LENGTH),
  };
}

function mapItemOwner(value: unknown): { ownerCharacterId: string | null; sinceSceneId: string } | null {
  if (!isRecord(value) || (value.ownerCharacterId !== null && typeof value.ownerCharacterId !== "string") || typeof value.sinceSceneId !== "string") return null;
  return {
    ownerCharacterId: typeof value.ownerCharacterId === "string" ? limitedText(value.ownerCharacterId, MAX_ID_LENGTH) : null,
    sinceSceneId: limitedText(value.sinceSceneId, MAX_ID_LENGTH),
  };
}

function mapAcquaintance(value: unknown): { a: string; b: string; sinceSceneId: string } | null {
  if (!isRecord(value) || typeof value.a !== "string" || typeof value.b !== "string" || typeof value.sinceSceneId !== "string") return null;
  return {
    a: limitedText(value.a, MAX_ID_LENGTH),
    b: limitedText(value.b, MAX_ID_LENGTH),
    sinceSceneId: limitedText(value.sinceSceneId, MAX_ID_LENGTH),
  };
}

function quoteJson(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, MAX_QUOTE_LENGTH);
  } catch {
    return "";
  }
}

const searchScenesSchema = z.object({
  query: z.string().min(1).max(MAX_QUERY_LENGTH),
  mode: z.enum(["scene", "sentence"]).default("scene"),
});
const searchBibleSchema = z.object({
  query: z.string().min(1).max(MAX_QUERY_LENGTH),
  entityKind: z.string().max(64).optional(),
});
const getWorldStateSchema = z.object({
  sceneId: z.string().min(1).max(MAX_ID_LENGTH),
  entityId: z.string().min(1).max(MAX_ID_LENGTH).optional(),
});
const getSummarySchema = z.object({
  scope: z.enum(["scene", "chapter", "volume"]),
  id: z.string().min(1).max(MAX_ID_LENGTH),
});

/** Construct the four source-compatible QA tools over read-only public data capabilities. */
export function createAssistantQaTools(
  reads: AssistantQaReadCapabilities,
  toolLog?: AssistantQaToolCallRecord[],
): ToolSet {
  return {
    searchScenes: tool({
      description: "本文・シーンをハイブリッド意味検索する（mode=scene|sentence）。設定の事実確認に使う。",
      inputSchema: searchScenesSchema,
      execute: async ({ query, mode }) => {
        try {
          const selectedMode = mode ?? "scene";
          const hits = getResults(await reads.semanticSearch({ query, mode: selectedMode, limit: MAX_SCENE_RESULTS, rerank: false }));
          const result = hits
            .filter((hit) => hit.type === undefined || hit.type === "scene")
            .slice(0, MAX_SCENE_RESULTS)
            .flatMap((hit) => {
              const id = typeof hit.sceneId === "string" ? hit.sceneId : undefined;
              if (!id) return [];
              return [{
                kind: "scene" as const,
                id: limitedText(id, MAX_ID_LENGTH),
                sourceId: limitedText(id, MAX_ID_LENGTH),
                quote: limitedText(hit.snippet ?? hit.text, MAX_QUOTE_LENGTH),
                citation: citationFields(hit, id, limitedText(hit.snippet ?? hit.text, MAX_QUOTE_LENGTH)),
                ...(typeof hit.score === "number" ? { score: hit.score } : {}),
                ...(typeof hit.sentenceIndex === "number" ? { sentenceIndex: hit.sentenceIndex } : {}),
              }];
            });
          recordCall(toolLog, "searchScenes", { query, mode: selectedMode }, result);
          return result;
        } catch {
          const stub = { error: "searchScenes unavailable" };
          recordCall(toolLog, "searchScenes", { query, mode: mode ?? "scene" }, stub);
          return stub;
        }
      },
    }),
    searchBible: tool({
      description: "図鑑（キャラ・場所・アイテム等）を検索する。",
      inputSchema: searchBibleSchema,
      execute: async ({ query, entityKind }) => {
        try {
          const hits = getResults(await reads.searchBible(query, entityKind));
          const result = hits
            .filter((hit) => typeof hit.type === "string" && BIBLE_TYPES.has(hit.type) && (!entityKind || hit.type === entityKind))
            .slice(0, MAX_BIBLE_RESULTS)
            .flatMap((hit) => {
              const id = typeof hit.sceneId === "string" ? hit.sceneId : typeof hit.id === "string" ? hit.id : undefined;
              if (!id || typeof hit.type !== "string") return [];
              const quote = limitedText(hit.snippet ?? hit.name, MAX_QUOTE_LENGTH);
              return [{
                kind: "bible" as const,
                id: limitedText(id, MAX_ID_LENGTH),
                sourceId: limitedText(id, MAX_ID_LENGTH),
                entityType: limitedText(hit.type, 64),
                ...(typeof hit.name === "string" ? { name: limitedText(hit.name, 256) } : {}),
                quote,
                citation: citationFields(hit, id, quote),
              }];
            });
          recordCall(toolLog, "searchBible", { query, entityKind }, result);
          return result;
        } catch {
          const stub = { error: "searchBible unavailable" };
          recordCall(toolLog, "searchBible", { query, entityKind }, stub);
          return stub;
        }
      },
    }),
    getWorldState: tool({
      description: "指定シーン時点の物語状態スナップショットを返す（所有・位置・面識など）。",
      inputSchema: getWorldStateSchema,
      execute: async ({ sceneId, entityId }) => {
        try {
          const snapshot = unwrapActionData(await reads.worldStateAtScene({ sceneId }));
          if (!isRecord(snapshot)) {
            const miss = { error: "scene not found", sceneId };
            recordCall(toolLog, "getWorldState", { sceneId, entityId }, miss);
            return miss;
          }
          let filtered: Record<string, unknown>;
          let truncated = false;
          if (entityId) {
            const location = isRecord(snapshot.locations) ? mapLocation(snapshot.locations[entityId]) : null;
            const itemOwner = isRecord(snapshot.itemOwners) ? mapItemOwner(snapshot.itemOwners[entityId]) : null;
            const acquaintances = Array.isArray(snapshot.acquaintances)
              ? snapshot.acquaintances.flatMap((value) => {
                  const row = mapAcquaintance(value);
                  return row && (row.a === entityId || row.b === entityId) ? [row] : [];
                }).slice(0, MAX_ACQUAINTANCES)
              : [];
            filtered = { location, itemOwner, acquaintances };
            truncated = Array.isArray(snapshot.acquaintances) && snapshot.acquaintances.filter((item) => {
              const row = mapAcquaintance(item);
              return row && (row.a === entityId || row.b === entityId);
            }).length > MAX_ACQUAINTANCES;
          } else {
            const locations = limitedStateMap(snapshot.locations, mapLocation);
            const itemOwners = limitedStateMap(snapshot.itemOwners, mapItemOwner);
            const acquaintanceRows = Array.isArray(snapshot.acquaintances) ? snapshot.acquaintances : [];
            const acquaintances = acquaintanceRows.flatMap((value) => {
              const row = mapAcquaintance(value);
              return row ? [row] : [];
            }).slice(0, MAX_ACQUAINTANCES);
            filtered = { locations: locations.entries, acquaintances, itemOwners: itemOwners.entries };
            truncated = locations.truncated || itemOwners.truncated || acquaintanceRows.length > MAX_ACQUAINTANCES;
          }
          const result = {
            kind: "state" as const,
            id: limitedText(sceneId, MAX_ID_LENGTH),
            sourceId: limitedText(sceneId, MAX_ID_LENGTH),
            ...(entityId ? { entityId: limitedText(entityId, MAX_ID_LENGTH) } : {}),
            ...filtered,
            ...(truncated ? { truncated: true } : {}),
            quote: quoteJson(filtered),
            citation: citationFields({}, sceneId, quoteJson(filtered)),
          };
          recordCall(toolLog, "getWorldState", { sceneId, entityId }, result);
          return result;
        } catch {
          const stub = { error: "getWorldState unavailable" };
          recordCall(toolLog, "getWorldState", { sceneId, entityId }, stub);
          return stub;
        }
      },
    }),
    getSummary: tool({
      description: "階層要約を読む（scene / chapter / volume）。",
      inputSchema: getSummarySchema,
      execute: async ({ scope, id }) => {
        try {
          const summary = unwrapActionData(await reads.readSummary({ scope, id }));
          const rawLines = isRecord(summary) && Array.isArray(summary.summaryLines) ? summary.summaryLines : [];
          const summaryLines = rawLines
            .filter((line): line is string => typeof line === "string")
            .slice(0, MAX_SUMMARY_LINES)
            .map((line) => limitedText(line, MAX_QUOTE_LENGTH));
          const result = {
            kind: "summary" as const,
            id: limitedText(id, MAX_ID_LENGTH),
            sourceId: limitedText(id, MAX_ID_LENGTH),
            scope,
            summaryLines,
            quote: limitedText(summaryLines.join(" / "), MAX_QUOTE_LENGTH),
            citation: citationFields(isRecord(summary) ? summary : {}, id, limitedText(summaryLines.join(" / "), MAX_QUOTE_LENGTH)),
          };
          recordCall(toolLog, "getSummary", { scope, id }, result);
          return result;
        } catch {
          const stub = { error: "getSummary unavailable" };
          recordCall(toolLog, "getSummary", { scope, id }, stub);
          return stub;
        }
      },
    }),
  };
}
