import { createGuest, type Handler } from "../shared/guest.ts";
import { HOST_OPERATIONS, type FileChunk, type FilePage } from "../shared/operations.ts";
import type { ActionRequest } from "../../app/src/browser/proprium/authoring/types.js";
import { clusterTerms, EMBEDDING_MODEL, RERANKER_MODEL, type CandidateTerm } from "./core.ts";
import { E5_MODEL, embedPassages, embeddingLoaded, ensureEmbedding, releaseEmbedding } from "./inference.ts";

function fail(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, retryable: false });
}

function exactObject(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("invalid_input", `${label} must be an object`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw fail("invalid_input", `${label} contains an unknown field`);
  return record;
}

const SETTINGS_PATH = "meta/scriptorium/modules/semantic/settings.json";
const MAX_LEGACY_SETTINGS_BYTES = 64 * 1024;

function parseEmpty(raw: unknown): void {
  const input = exactObject(raw, [], "input");
  if (Object.keys(input).length !== 0) throw fail("invalid_input", "Input must be empty");
}

function safeTaskId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw fail("invalid_input", "taskId must be 1 to 128 letters, numbers, underscores, or hyphens");
  return value;
}

function unavailableModel(role: "embedding" | "reranker") {
  const identity = role === "embedding" ? EMBEDDING_MODEL : RERANKER_MODEL;
  return {
    id: identity.id,
    revision: identity.revision,
    role,
    ...(role === "embedding" ? { dimensions: EMBEDDING_MODEL.dimensions } : {}),
    digest: role === "embedding" ? E5_MODEL.model_sha256 : null,
    byte_length: role === "embedding" ? E5_MODEL.model_bytes : null,
    license: role === "embedding" ? E5_MODEL.license : "Apache-2.0",
    status: role === "embedding" && embeddingLoaded() ? "ready" : "unavailable",
  };
}

const indexStatus: Handler = (raw, context) => {
  parseEmpty(raw);
  return {
    snapshot: context.snapshot,
    model: { ...unavailableModel("embedding"), digest: null },
    index: {
      state: "missing",
      passageCount: 0,
      sourceGeneration: context.snapshot.worktree_generation,
      indexedAt: null,
    },
    resources: { modelLoaded: embeddingLoaded(), rerankerLoaded: false, locality: "local", downloadRequired: !embeddingLoaded() },
    activeTasks: [],
  };
};

const indexRebuild: Handler = (raw) => {
  const input = exactObject(raw, ["taskId"], "input");
  safeTaskId(input.taskId);
  throw fail("provider_unavailable", "The signed embedding asset is not admitted for this plugin version");
};

function queryInput(raw: unknown): { query: string; granularity: "scene" | "sentence"; limit: number; excludeSceneIds?: string[] } {
  const input = exactObject(raw, ["query", "granularity", "limit", "excludeSceneIds"], "input");
  if (typeof input.query !== "string" || input.query.length > 8192 ||
      (input.granularity !== "scene" && input.granularity !== "sentence") ||
      !Number.isInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 100 ||
      (input.excludeSceneIds !== undefined && (!Array.isArray(input.excludeSceneIds) || input.excludeSceneIds.length > 10000 || input.excludeSceneIds.some((id) => typeof id !== "string" || id.length > 256)))) {
    throw fail("invalid_input", "Passage query is invalid or outside configured bounds");
  }
  return {
    query: input.query,
    granularity: input.granularity,
    limit: input.limit as number,
    ...(input.excludeSceneIds ? { excludeSceneIds: input.excludeSceneIds as string[] } : {}),
  };
}

const passageQuery: Handler = (raw, context) => {
  const input = queryInput(raw);
  if (!input.query.trim()) return { snapshot: context.snapshot, model: unavailableModel("embedding"), results: [] };
  throw fail("index_missing", "No verified Semantic index exists for this snapshot; the embedding asset is unavailable");
};

const rerank: Handler = (raw) => {
  const input = exactObject(raw, ["query", "candidates", "limit"], "input");
  if (typeof input.query !== "string" || input.query.length > 8192 || !Array.isArray(input.candidates) || input.candidates.length > 30 ||
      !Number.isInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 30) {
    throw fail("invalid_input", "Rerank request is invalid or outside configured bounds");
  }
  const ids = new Set<string>();
  for (const [index, item] of input.candidates.entries()) {
    const candidate = exactObject(item, ["candidateId", "entityId", "sourcePath", "sourceRevision", "sentenceIndex", "text", "evidence"], `candidates[${index}]`);
    if (typeof candidate.candidateId !== "string" || !candidate.candidateId || candidate.candidateId.length > 128 || ids.has(candidate.candidateId) ||
        typeof candidate.entityId !== "string" || typeof candidate.sourcePath !== "string" || typeof candidate.sourceRevision !== "string" ||
        typeof candidate.text !== "string" || !Array.isArray(candidate.evidence)) throw fail("invalid_input", `Candidate ${index} is invalid`);
    ids.add(candidate.candidateId);
  }
  throw fail("model_unavailable", "The signed BGE reranker asset is not admitted for this plugin version");
};

function parseTerms(raw: unknown): { candidates: CandidateTerm[]; useEmbedding: boolean } {
  const input = exactObject(raw, ["candidates", "useEmbedding"], "input");
  if (!Array.isArray(input.candidates) || input.candidates.length > 2000 || typeof input.useEmbedding !== "boolean") {
    throw fail("invalid_input", "Candidate list or embedding option is invalid");
  }
  const candidates = input.candidates.map((rawCandidate, index): CandidateTerm => {
    const candidate = exactObject(rawCandidate, ["term", "reading", "sourceEntityIds", "occurrenceCount"], `candidates[${index}]`);
    if (typeof candidate.term !== "string" || !candidate.term.trim() || candidate.term.length > 256 ||
        !(candidate.reading === null || typeof candidate.reading === "string") || !Array.isArray(candidate.sourceEntityIds) ||
        candidate.sourceEntityIds.some((id) => typeof id !== "string" || id.length > 256) ||
        !Number.isSafeInteger(candidate.occurrenceCount) || (candidate.occurrenceCount as number) < 0) {
      throw fail("invalid_input", `Candidate ${index} is invalid`);
    }
    return {
      term: candidate.term,
      reading: candidate.reading as string | null,
      sourceEntityIds: candidate.sourceEntityIds as string[],
      occurrenceCount: candidate.occurrenceCount as number,
    };
  });
  return { candidates, useEmbedding: input.useEmbedding };
}

const clusterTermsAction: Handler = function* (raw, context, host) {
  const { candidates, useEmbedding } = parseTerms(raw);
  if (useEmbedding) {
    yield* ensureEmbedding(host);
    const vectors = embedPassages(candidates.map((candidate) => candidate.term));
    const results = clusterTerms(candidates, vectors).map((cluster) => ({ ...cluster, semanticOnly: cluster.semanticOnly === true }));
    return { snapshot: context.snapshot, model: unavailableModel("embedding"), results };
  }
  const results = clusterTerms(candidates).map((cluster) => ({ ...cluster, semanticOnly: false }));
  return { snapshot: context.snapshot, results };
};

const contradictionCandidates: Handler = (raw, context) => {
  const input = exactObject(raw, ["cursor", "limit"], "input");
  if (input.cursor !== undefined && (typeof input.cursor !== "string" || input.cursor.length > 4096) ||
      input.limit !== undefined && (!Number.isInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 100)) {
    throw fail("invalid_input", "Contradiction page request is invalid");
  }
  return { snapshot: context.snapshot, model: unavailableModel("embedding"), indexAvailable: false, candidates: [], nextCursor: null, complete: true };
};

function parsePreference(value: unknown): { rerankerEnabled: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { rerankerEnabled: false };
  const record = value as Record<string, unknown>;
  return typeof record.rerankerEnabled === "boolean" ? { rerankerEnabled: record.rerankerEnabled } : { rerankerEnabled: false };
}

function* readLegacyPreference(context: ActionRequest, host: Parameters<Handler>[2]) {
  const listing = yield* host.request<FilePage>(HOST_OPERATIONS.list, { snapshot: context.snapshot, prefix: SETTINGS_PATH, limit: 1 });
  if (!Array.isArray(listing.entries) || listing.entries.some((entry) => !entry || typeof entry.path !== "string" || typeof entry.revision !== "string")) {
    throw fail("snapshot_stale", "Legacy setting file listing is inconsistent");
  }
  const entry = listing.entries.find((item) => item.path === SETTINGS_PATH);
  if (!entry) return { present: false, valid: false };
  const chunk = yield* host.request<FileChunk>(HOST_OPERATIONS.read, { snapshot: context.snapshot, path: SETTINGS_PATH, offset: 0, length: MAX_LEGACY_SETTINGS_BYTES });
  if (chunk.revision !== entry.revision || chunk.offset !== 0 || chunk.total_bytes > MAX_LEGACY_SETTINGS_BYTES ||
      chunk.bytes.length !== chunk.total_bytes || chunk.next_offset !== null) {
    return { present: true, valid: false, sourceRevision: entry.revision };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(chunk.bytes));
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { present: true, valid: false, sourceRevision: entry.revision };
    const setting = value as Record<string, unknown>;
    if (setting.schemaVersion !== 1 || typeof setting.rerankerEnabled !== "boolean") return { present: true, valid: false, sourceRevision: entry.revision };
    return { present: true, valid: true, value: setting.rerankerEnabled, sourceRevision: entry.revision };
  } catch {
    return { present: true, valid: false, sourceRevision: entry.revision };
  }
}

const settingsRead: Handler = function* (_raw, context, host) {
  parseEmpty(_raw);
  const [stored, legacyPreference] = yield* (function* () {
    const pref = yield* host.request<{ found: boolean; value?: unknown }>(HOST_OPERATIONS.preferencesRead, {
      plugin_id: "proprium.semantic", key: "reranker.enabled", schema_version: 1,
    });
    const legacy = yield* readLegacyPreference(context, host);
    return [pref, legacy] as const;
  })();
  return {
    snapshot: context.snapshot,
    preferences: parsePreference(stored.found ? stored.value : undefined),
    legacyPreference,
    models: [unavailableModel("embedding"), unavailableModel("reranker")],
    privacy: { projectDataTransmission: "none", locality: "local", externalProviders: false },
  };
};

const settingsUpdate: Handler = (raw, context) => {
  const input = exactObject(raw, ["rerankerEnabled"], "input");
  if (typeof input.rerankerEnabled !== "boolean") throw fail("invalid_input", "rerankerEnabled must be a boolean");
  return {
    snapshot: context.snapshot,
    host_ui: { route: "plugin_preferences", pluginId: "proprium.semantic", key: "reranker.enabled", pendingValue: input.rerankerEnabled },
  };
};

const taskStatus: Handler = (raw, context) => {
  parseEmpty(raw);
  return { snapshot: context.snapshot, activeTasks: [] };
};

const taskCancel: Handler = (raw, context) => {
  const input = exactObject(raw, ["taskId"], "input");
  return { snapshot: context.snapshot, taskId: safeTaskId(input.taskId), cancelled: false };
};

const implementation = createGuest("proprium.semantic", {
  "proprium.semantic.index.status": indexStatus,
  "proprium.semantic.index.rebuild": indexRebuild,
  "proprium.semantic.passages.query": passageQuery,
  "proprium.semantic.rerank": rerank,
  "proprium.semantic.terms.cluster": clusterTermsAction,
  "proprium.semantic.contradictions.candidates": contradictionCandidates,
  "proprium.semantic.settings.read": settingsRead,
  "proprium.semantic.settings.update": settingsUpdate,
  "proprium.semantic.task.status": taskStatus,
  "proprium.semantic.task.cancel": taskCancel,
});

export const guest = {
  initialize: implementation.initialize,
  invoke: implementation.invoke,
  dispose(): void {
    releaseEmbedding();
    implementation.dispose();
  },
};
