import { createGuest, type Handler } from "../shared/guest.ts";
import { HOST_OPERATIONS, type FileChunk, type FilePage } from "../shared/operations.ts";
import type { ActionRequest } from "../../app/src/browser/proprium/authoring/types.js";
import { clusterTerms, EMBEDDING_MODEL, RERANKER_MODEL, type CandidateTerm } from "./core.ts";
import { E5_MODEL, embedPassages, embeddingLoaded, ensureEmbedding, ensureEmbeddingStep, releaseEmbedding } from "./inference.ts";
import { loadIndex, releaseSemanticIndex, startIndexBuild, stepIndexBuild, queryIndex, contradictionPage } from "./index-operations.ts";
import { cancelSemanticTask, endSemanticTask, semanticTasks } from "./tasks.ts";
import { BGE_MODEL, bgeRerankerLoaded, rerankBge, startBgePreparation, stepBgePreparation } from "./reranker-inference.ts";

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
    digest: role === "embedding" ? E5_MODEL.model_sha256 : BGE_MODEL.group_sha256,
    byte_length: role === "embedding" ? E5_MODEL.model_bytes : BGE_MODEL.group_bytes,
    license: role === "embedding" ? E5_MODEL.license : "Apache-2.0",
    status: role === "embedding" ? embeddingLoaded() ? "ready" : "unavailable" : bgeRerankerLoaded() ? "ready" : "unavailable",
  };
}

const semanticEngine = { ensure: ensureEmbedding, ensureStep: ensureEmbeddingStep, embed: embedPassages, model: () => unavailableModel("embedding") };
const indexStatus: Handler = function* (raw, context, host) {
  parseEmpty(raw);
  let index;
  try { index = yield* loadIndex(context as ActionRequest, host); }
  catch (error) {
    if ((error as { code?: string })?.code !== "cache_corrupt" && (error as { code?: string })?.code !== "index_stale") throw error;
    return { snapshot: context.snapshot, model: unavailableModel("embedding"), index: { state: "stale", passageCount: 0, sourceGeneration: context.snapshot.worktree_generation, indexedAt: null }, resources: { modelLoaded: embeddingLoaded(), rerankerLoaded: false, locality: "local", downloadRequired: !embeddingLoaded() }, activeTasks: semanticTasks() };
  }
  return { snapshot: context.snapshot, model: unavailableModel("embedding"), index: { state: index ? "ready" : "missing", passageCount: index?.passages.length ?? 0, sourceGeneration: context.snapshot.worktree_generation, indexedAt: null }, resources: { modelLoaded: embeddingLoaded(), rerankerLoaded: false, locality: "local", downloadRequired: !embeddingLoaded() }, activeTasks: semanticTasks() };
};
const indexRebuild: Handler = function* (raw, context, host) {
  const input = exactObject(raw, ["taskId"], "input");
  return yield* startIndexBuild({ taskId: safeTaskId(input.taskId) }, context as ActionRequest, host, semanticEngine);
};
const indexStep: Handler = function* (raw, context, host) {
  const input = exactObject(raw, ["taskId", "sequence"], "input");
  if (!Number.isSafeInteger(input.sequence) || (input.sequence as number) < 0 || (input.sequence as number) > 1_000_000) throw fail("invalid_input", "sequence must be an integer from 0 to 1000000");
  return yield* stepIndexBuild({ taskId: safeTaskId(input.taskId), sequence: input.sequence as number }, context as ActionRequest, host, semanticEngine);
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

const passageQuery: Handler = function* (raw, context, host) {
  return yield* queryIndex(queryInput(raw), context as ActionRequest, host, semanticEngine);
};

const rerank: Handler = function* (raw, context, host) {
  const input = exactObject(raw, ["query", "candidates", "limit"], "input");
  if (typeof input.query !== "string" || input.query.length > 8192 || !Array.isArray(input.candidates) || input.candidates.length > 30 ||
      !Number.isInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 30) {
    throw fail("invalid_input", "Rerank request is invalid or outside configured bounds");
  }
  const ids = new Set<string>();
  for (const [index, item] of input.candidates.entries()) {
    const candidate = exactObject(item, ["candidateId", "entityId", "sourcePath", "sourceRevision", "sentenceIndex", "text", "evidence"], `candidates[${index}]`);
    if (typeof candidate.candidateId !== "string" || !candidate.candidateId || candidate.candidateId.length > 128 || ids.has(candidate.candidateId) ||
        typeof candidate.entityId !== "string" || !candidate.entityId || candidate.entityId.length > 256 ||
        typeof candidate.sourcePath !== "string" || !candidate.sourcePath || candidate.sourcePath.length > 4096 ||
        candidate.sourcePath.startsWith("/") || candidate.sourcePath.includes("\\") || candidate.sourcePath.split("/").some(part => !part || part === "." || part === "..") ||
        typeof candidate.sourceRevision !== "string" || !/^[a-f0-9]{64}$/u.test(candidate.sourceRevision) ||
        (candidate.sentenceIndex !== undefined && (!Number.isSafeInteger(candidate.sentenceIndex) || (candidate.sentenceIndex as number) < 0)) ||
        typeof candidate.text !== "string" || new TextEncoder().encode(candidate.text).length > 32_768 ||
        !Array.isArray(candidate.evidence) || candidate.evidence.length < 1 || candidate.evidence.length > 32) throw fail("invalid_input", `Candidate ${index} is invalid`);
    for (const [spanIndex, rawSpan] of candidate.evidence.entries()) {
      const span = exactObject(rawSpan, ["path", "revision", "start", "end", "quote"], `candidates[${index}].evidence[${spanIndex}]`);
      if (typeof span.path !== "string" || span.path !== candidate.sourcePath || typeof span.revision !== "string" ||
          span.revision !== candidate.sourceRevision || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) ||
          (span.start as number) < 0 || (span.end as number) < (span.start as number) || (span.end as number) - (span.start as number) > 32_768 ||
          typeof span.quote !== "string" || !span.quote || new TextEncoder().encode(span.quote).length > 32_768) {
        throw fail("invalid_input", `Candidate ${index} evidence is invalid`);
      }
    }
    ids.add(candidate.candidateId);
  }
  const preference = yield* host.request<{ found: boolean; value?: unknown }>(HOST_OPERATIONS.preferencesRead, {
    plugin_id: "proprium.semantic", key: "reranker.enabled", schema_version: 1,
  });
  if (!parsePreference(preference.found ? preference.value : undefined).rerankerEnabled) {
    throw fail("capability_denied", "Enable the Host reranker preference before requesting BGE scores");
  }
  const candidates = input.candidates as Parameters<typeof rerankBge>[1];
  const scored = rerankBge(input.query, candidates, input.limit as number);
  return { snapshot: context.snapshot, model: scored.model, results: scored.results };
};

const rerankerPrepare: Handler = function* (raw, context, host) {
  const input = exactObject(raw, ["taskId"], "input");
  const preference = yield* host.request<{ found: boolean; value?: unknown }>(HOST_OPERATIONS.preferencesRead, {
    plugin_id: "proprium.semantic", key: "reranker.enabled", schema_version: 1,
  });
  if (!parsePreference(preference.found ? preference.value : undefined).rerankerEnabled) {
    throw fail("capability_denied", "Enable the Host reranker preference before preparing the BGE model");
  }
  return { snapshot: context.snapshot, ...startBgePreparation(safeTaskId(input.taskId)) };
};
const rerankerPrepareStep: Handler = function* (raw, context, host) {
  const input = exactObject(raw, ["taskId", "sequence"], "input");
  if (!Number.isSafeInteger(input.sequence) || (input.sequence as number) < 0 || (input.sequence as number) > 1_000_000) {
    throw fail("invalid_input", "BGE preparation sequence is invalid");
  }
  return { snapshot: context.snapshot, ...yield* stepBgePreparation(safeTaskId(input.taskId), input.sequence as number, host) };
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
    if (!embeddingLoaded()) throw fail("provider_unavailable", "Use the explicit Semantic index action to load the pinned local model before embedding term candidates");
    const vectors = embedPassages(candidates.map((candidate) => candidate.term));
    const results = clusterTerms(candidates, vectors).map((cluster) => ({ ...cluster, semanticOnly: cluster.semanticOnly === true }));
    return { snapshot: context.snapshot, model: unavailableModel("embedding"), results };
  }
  const results = clusterTerms(candidates).map((cluster) => ({ ...cluster, semanticOnly: false }));
  return { snapshot: context.snapshot, results };
};

const contradictionCandidates: Handler = function* (raw, context, host) {
  const input = exactObject(raw, ["cursor", "limit"], "input");
  if (input.cursor !== undefined && (typeof input.cursor !== "string" || input.cursor.length > 4096) ||
      input.limit !== undefined && (!Number.isInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 100)) {
    throw fail("invalid_input", "Contradiction page request is invalid");
  }
  return yield* contradictionPage(input as { cursor?: string; limit?: number }, context as ActionRequest, host, semanticEngine);
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
  return { snapshot: context.snapshot, activeTasks: semanticTasks() };
};

const taskCancel: Handler = (raw, context) => {
  const input = exactObject(raw, ["taskId"], "input");
  const taskId = safeTaskId(input.taskId);
  return { snapshot: context.snapshot, taskId, cancelled: cancelSemanticTask(taskId) };
};

const implementation = createGuest("proprium.semantic", {
  "proprium.semantic.index.status": indexStatus,
  "proprium.semantic.index.rebuild": indexRebuild,
  "proprium.semantic.index.step": indexStep,
  "proprium.semantic.passages.query": passageQuery,
  "proprium.semantic.rerank": rerank,
  "proprium.semantic.reranker.prepare": rerankerPrepare,
  "proprium.semantic.reranker.prepare.step": rerankerPrepareStep,
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
    endSemanticTask();
    releaseEmbedding();
    releaseSemanticIndex();
    implementation.dispose();
  },
};
