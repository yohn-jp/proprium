import { randomUUID } from "node:crypto";
import type {
  ActionResult,
  ChangeOperation,
  FileRevision,
  ModuleAction,
  ModuleActionContext,
  ModuleContext,
  ProposalEvidence,
  SnapshotId,
  ValueSchema,
} from "@scriptorium/contracts";
import { snapshotScopeRevision } from "@scriptorium/contracts";
import {
  NLP_TOKENIZER_CAPABILITY,
  isAdjective,
  isAdverb,
  isVerb,
  readCanonicalSnapshotEntities,
  type CandidateTerm,
  type NlpTokenizerCapability,
} from "@scriptorium/module-nlp";
import { readStorySnapshot } from "@scriptorium/module-story";
import type { StoryEntity } from "@scriptorium/module-story";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL_ID,
  EMBEDDING_MODEL_VERSION,
  RERANKER_MODEL_ID,
  RERANKER_MODEL_VERSION,
  SEMANTIC_EMBEDDING_CAPABILITY,
  type SemanticEmbeddingCapability,
  type SemanticPassageHit,
} from "./contracts.js";
import { buildSemanticPassages } from "./passages.js";
import {
  CONTRADICTION_MID_BAND_MAX,
  CONTRADICTION_MID_BAND_MIN,
  collectMentionGroups,
  detectSourceRuleContradictions,
  embeddingContradictionsToCandidates,
  mergeContradictionCandidates,
  ruleContradictionsToCandidates,
  type ContradictionCandidate,
} from "./contradictions.js";
import { scoreBreakdown, searchSnapshotLexically, type LexicalHit, type SemanticSearchHit, type SemanticSearchMode } from "./search.js";
import { clusterSimilarTerms } from "./termClustering.js";

const STATE_ROOT = "meta/scriptorium/modules/semantic";
const SETTINGS_PATH = `${STATE_ROOT}/settings.json`;
const DISMISSALS_PATH = `${STATE_ROOT}/contradiction-dismissals.jsonl`;
const MAX_QUERY_LENGTH = 8192;
const MAX_CANDIDATES = 2000;
const DEFAULT_RERANKER_ENABLED = process.env.ARCADIA_RERANK === "1";

type ObjectValue = Record<string, unknown>;
interface SemanticSettings { schemaVersion: 1; rerankerEnabled: boolean }
interface TaskState { taskId: string; phase: string; completed: number; total: number; controller: AbortController }

function codeError(code: string, message: string): Error { return Object.assign(new Error(message), { code }); }
function record(value: unknown, label = "input"): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as ObjectValue;
}
function parseEmpty(value: unknown): ObjectValue { return record(value); }
function parseObjectOutput(value: unknown): unknown { return record(value, "action output"); }
const outputSchema: ValueSchema = { parse: parseObjectOutput };
function action(id: string, effect: ModuleAction["effect"], parse: (value: unknown) => unknown, invoke: ModuleAction["invoke"]): ModuleAction {
  return { id, effect, inputSchema: { parse }, outputSchema, invoke };
}
function parseSearch(value: unknown): { query: string; mode: SemanticSearchMode; limit: number; rerank?: boolean; taskId?: string } {
  const input = record(value);
  if (typeof input.query !== "string" || input.query.length > MAX_QUERY_LENGTH) throw new TypeError(`query must be at most ${MAX_QUERY_LENGTH} characters`);
  const mode = input.mode ?? "scene";
  if (mode !== "scene" && mode !== "sentence" && mode !== "expression") throw new TypeError("mode must be scene, sentence, or expression");
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new TypeError("limit must be between 1 and 100");
  if (input.rerank !== undefined && typeof input.rerank !== "boolean") throw new TypeError("rerank must be a boolean");
  return {
    query: input.query,
    mode,
    limit: limit as number,
    ...(typeof input.rerank === "boolean" ? { rerank: input.rerank } : {}),
    ...(input.taskId === undefined ? {} : { taskId: safeTaskId(input.taskId) }),
  };
}
function parseTaskInput(value: unknown): { taskId: string } {
  const input = record(value);
  return { taskId: safeTaskId(input.taskId) };
}
function parseRebuildInput(value: unknown): { taskId: string } {
  const input = record(value);
  return { taskId: input.taskId === undefined ? randomUUID() : safeTaskId(input.taskId) };
}
function safeTaskId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new TypeError("taskId must be 1 to 128 letters, numbers, underscores, or hyphens");
  return value;
}
function parseClusters(value: unknown): { candidates?: CandidateTerm[]; useEmbedding: boolean; taskId?: string } {
  const input = record(value);
  if (input.useEmbedding !== undefined && typeof input.useEmbedding !== "boolean") throw new TypeError("useEmbedding must be a boolean");
  let candidates: CandidateTerm[] | undefined;
  if (input.candidates !== undefined) {
    if (!Array.isArray(input.candidates) || input.candidates.length > MAX_CANDIDATES) throw new TypeError(`candidates must contain at most ${MAX_CANDIDATES} entries`);
    candidates = input.candidates.map((item, index) => {
      const candidate = record(item, `candidates[${index}]`);
      if (typeof candidate.term !== "string" || !candidate.term.trim() || candidate.term.length > 256 ||
          !(candidate.reading === null || typeof candidate.reading === "string") || !Array.isArray(candidate.sourceEntityIds) ||
          candidate.sourceEntityIds.some((id) => typeof id !== "string") || !Number.isSafeInteger(candidate.occurrenceCount) || (candidate.occurrenceCount as number) < 0) {
        throw new TypeError(`candidates[${index}] has an invalid source term record`);
      }
      return { term: candidate.term, reading: candidate.reading as string | null, sourceEntityIds: candidate.sourceEntityIds as string[], occurrenceCount: candidate.occurrenceCount as number };
    });
  }
  return {
    ...(candidates ? { candidates } : {}),
    useEmbedding: input.useEmbedding === true,
    ...(input.taskId === undefined ? {} : { taskId: safeTaskId(input.taskId) }),
  };
}
function parseDismissal(value: unknown): { candidateId: string } {
  const input = record(value);
  if (typeof input.candidateId !== "string" || !input.candidateId.trim() || input.candidateId.length > 1024) throw new TypeError("candidateId must be a non-empty string of at most 1024 characters");
  return { candidateId: input.candidateId.trim() };
}
function parseSettingsUpdate(value: unknown): { rerankerEnabled: boolean } {
  const input = record(value);
  if (typeof input.rerankerEnabled !== "boolean") throw new TypeError("rerankerEnabled must be a boolean");
  return { rerankerEnabled: input.rerankerEnabled };
}

function createTaskRegistry() {
  const active = new Map<string, TaskState>();
  function begin(context: ModuleActionContext, taskId: string, phase: string, total = 0): { signal: AbortSignal; update(phase: string, completed?: number, total?: number): void; finish(): void } {
    if (context.signal.aborted) throw context.signal.reason ?? codeError("job_cancelled", "Semantic action was cancelled");
    if (active.has(taskId)) throw codeError("semantic_task_exists", `Semantic task ${taskId} is already running`);
    const controller = new AbortController();
    const task: TaskState = { taskId, phase, completed: 0, total, controller };
    active.set(taskId, task);
    const signal = AbortSignal.any([context.signal, controller.signal]);
    return {
      signal,
      update(nextPhase, completed = task.completed, nextTotal = task.total) {
        task.phase = nextPhase; task.completed = completed; task.total = nextTotal;
      },
      finish() { if (active.get(taskId) === task) active.delete(taskId); },
    };
  }
  return {
    begin,
    cancel(taskId: string): boolean { const task = active.get(taskId); if (!task) return false; task.controller.abort(codeError("job_cancelled", "Semantic task was cancelled")); return true; },
    list() { return [...active.values()].map(({ taskId, phase, completed, total }) => ({ taskId, phase, completed, total })); },
  };
}

async function withCapability<T>(moduleContext: ModuleContext, fn: (capability: SemanticEmbeddingCapability) => Promise<T>): Promise<T> {
  const lease = await moduleContext.acquireCapability<SemanticEmbeddingCapability>(SEMANTIC_EMBEDDING_CAPABILITY);
  try { return await fn(lease.value); }
  finally { await lease.release(); }
}
async function withTokenizer<T>(moduleContext: ModuleContext, signal: AbortSignal, fn: (capability: NlpTokenizerCapability) => Promise<T>): Promise<T> {
  if (signal.aborted) throw signal.reason ?? codeError("job_cancelled", "Semantic action was cancelled");
  const lease = await moduleContext.acquireCapability<NlpTokenizerCapability>(NLP_TOKENIZER_CAPABILITY);
  try { return await fn(lease.value); }
  finally { await lease.release(); }
}

function getKnownTerms(entities: readonly { name?: string; aliases?: string[] }[]): Set<string> {
  const terms = new Set<string>();
  for (const entity of entities) {
    if (entity.name) terms.add(entity.name);
    for (const alias of entity.aliases ?? []) if (alias) terms.add(alias);
  }
  return terms;
}
function buildSentenceHits(lexical: LexicalHit[], passages: readonly SemanticPassageHit[], limit: number): SemanticSearchHit[] {
  const ftsByEntity = new Map<string, { rank: number; hit: LexicalHit }>();
  lexical.forEach((hit, index) => ftsByEntity.set(hit.id, { rank: index + 1, hit }));
  const output = passages.slice(0, Math.max(limit * 3, 30)).map((passage, index): SemanticSearchHit => {
    const fts = ftsByEntity.get(passage.entityId);
    const scores = scoreBreakdown(fts?.rank, index + 1, fts?.hit.score, passage.score);
    return {
      sceneId: passage.entityId,
      entityId: passage.entityId,
      sentenceIndex: passage.sentenceIndex,
      snippet: passage.text,
      text: passage.text,
      score: scores.rrf,
      scores,
      ...(passage.type ? { type: passage.type } : {}),
      ...(passage.name ? { name: passage.name } : {}),
      ...(passage.filePath ? { filePath: passage.filePath } : {}),
    };
  });
  // Source returns FTS-only entity hits only when the vector path has no hits.
  if (passages.length === 0) for (const [entityId, fts] of ftsByEntity) {
    const scores = scoreBreakdown(fts.rank, null, fts.hit.score);
    output.push({ sceneId: entityId, snippet: fts.hit.snippet, score: scores.rrf, scores, type: fts.hit.type, ...(fts.hit.name ? { name: fts.hit.name } : {}), filePath: fts.hit.filePath });
  }
  return output.sort((a, b) => b.score - a.score || a.sceneId.localeCompare(b.sceneId)).slice(0, limit);
}

function sceneHits(lexical: LexicalHit[], nearest: SemanticPassageHit[], limit: number): SemanticSearchHit[] {
  const ftsByEntity = new Map(lexical.map((hit, index) => [hit.id, { rank: index + 1, hit }]));
  const bestByEntity = new Map<string, { hit: SemanticPassageHit; rank: number }>();
  nearest.forEach((hit) => {
    const previous = bestByEntity.get(hit.entityId);
    if (!previous || hit.score > previous.hit.score) bestByEntity.set(hit.entityId, { hit, rank: 0 });
  });
  const vectorOrdered = [...bestByEntity.entries()].sort((a, b) => b[1].hit.score - a[1].hit.score || a[0].localeCompare(b[0]));
  vectorOrdered.forEach(([, value], index) => { value.rank = index + 1; });
  const ids = new Set([...ftsByEntity.keys(), ...bestByEntity.keys()]);
  return [...ids].map((id): SemanticSearchHit => {
    const fts = ftsByEntity.get(id);
    const vector = bestByEntity.get(id);
    const source = fts?.hit;
    const passage = vector?.hit;
    const scores = scoreBreakdown(fts?.rank, vector?.rank, source?.score, passage?.score);
    return {
      sceneId: id,
      ...(passage ? { sentenceIndex: passage.sentenceIndex } : {}),
      ...(source?.snippet ? { snippet: source.snippet } : passage ? { snippet: passage.text } : {}),
      score: scores.rrf,
      scores,
      ...(source?.type ?? passage?.type ? { type: source?.type ?? passage?.type } : {}),
      ...(source?.name ?? passage?.name ? { name: source?.name ?? passage?.name } : {}),
      ...(source?.filePath ?? passage?.filePath ? { filePath: source?.filePath ?? passage?.filePath } : {}),
    };
  }).sort((a, b) => b.score - a.score || a.sceneId.localeCompare(b.sceneId)).slice(0, limit);
}

async function applyRerank(
  query: string,
  hits: SemanticSearchHit[],
  snapshot: SnapshotId,
  signal: AbortSignal,
  moduleContext: ModuleContext,
): Promise<{ hits: SemanticSearchHit[]; warning?: string }> {
  const pool = hits.slice(0, 30);
  const rest = hits.slice(30);
  const withText = pool.filter((hit) => (hit.snippet ?? hit.text)?.trim());
  const withoutText = pool.filter((hit) => !(hit.snippet ?? hit.text)?.trim());
  if (!withText.length) return { hits: [...pool.map((hit) => ({ ...hit, scores: { ...hit.scores, rerank: 0 } })), ...rest] };
  try {
    const scores = await withCapability(moduleContext, (embedding) => embedding.rerank(query, withText.map((hit) => (hit.snippet ?? hit.text)!.trim()), snapshot, signal));
    const ranked = withText.map((hit, index) => ({ hit: { ...hit, scores: { ...hit.scores, rerank: scores.scores[index] ?? 0 } }, score: scores.scores[index] ?? 0, index }));
    ranked.sort((a, b) => b.score - a.score || a.index - b.index);
    return {
      hits: [...ranked.map((entry) => entry.hit), ...withoutText.map((hit) => ({ ...hit, scores: { ...hit.scores, rerank: 0 } })), ...rest],
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return { hits: [...pool.map((hit) => ({ ...hit, scores: { ...hit.scores, rerank: 0 } })), ...rest], warning: "semantic_reranker_unavailable" };
  }
}

async function readSettings(context: ModuleActionContext): Promise<{ settings: SemanticSettings; revision: string | null }> {
  const file = await context.reader.read(SETTINGS_PATH);
  if (!file) return { settings: { schemaVersion: 1, rerankerEnabled: DEFAULT_RERANKER_ENABLED }, revision: null };
  let value: unknown;
  try { value = JSON.parse(file.content); } catch { throw new TypeError("Semantic settings are invalid JSON"); }
  const settings = record(value, "semantic settings");
  if (settings.schemaVersion !== 1 || typeof settings.rerankerEnabled !== "boolean") throw new TypeError("Semantic settings have an unsupported schema");
  return { settings: { schemaVersion: 1, rerankerEnabled: settings.rerankerEnabled }, revision: file.revision };
}

function operation(context: ModuleActionContext, path: string, revision: string | null, content: string, message: string, additionalReads: FileRevision[] = []): ChangeOperation {
  return {
    id: `semantic-${randomUUID()}`,
    generation: 0,
    repository: context.reader.snapshot.repository,
    baseRemoteCommit: context.reader.snapshot.remoteCommit,
    effect: "settings",
    reads: [{ path, revision }, ...additionalReads],
    writes: [{ path, revision, content }],
    message,
  };
}

function parseDismissals(content: string): Set<string> {
  const ids = new Set<string>();
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = record(JSON.parse(line), "dismissal record");
      if (typeof value.candidateId === "string" && value.candidateId.trim() && typeof value.timestamp === "string" && value.timestamp.trim()) ids.add(value.candidateId);
    } catch { /* Match the source reader: malformed JSONL rows are skipped. */ }
  }
  return ids;
}

function storyEntities(story: Awaited<ReturnType<typeof readStorySnapshot>>): StoryEntity[] { return [...story.entities.values()]; }

async function rebuildCandidates(
  moduleContext: ModuleContext,
  context: ModuleActionContext,
  signal: AbortSignal,
  onProgress?: (phase: string, completed?: number, total?: number) => void,
): Promise<{ candidates: ContradictionCandidate[]; indexAvailable: boolean }> {
  onProgress?.("reading_snapshot");
  const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
  onProgress?.("checking_rules");
  const ruleCandidates = ruleContradictionsToCandidates(detectSourceRuleContradictions(story));
  const canonical = await readCanonicalSnapshotEntities(context.reader, signal);
  const passages = buildSemanticPassages(canonical);
  const entities = new Map(storyEntities(story).map((entity) => [entity.id, entity]));
  onProgress?.("checking_embeddings", 0, passages.length);
  const candidates = await withCapability(moduleContext, async (embedding) => {
    const status = await embedding.status(context.reader.snapshot, signal);
    if (!status.indexAvailable) return { candidates: ruleCandidates, indexAvailable: false };
    const groups = collectMentionGroups(entities, passages).map((group) => ({
      entityId: group.entityId,
      anchors: group.anchors.map(({ sceneId, sentenceIndex }) => ({ sceneId, sentenceIndex })),
    }));
    const result = await embedding.contradictionPairs(groups, context.reader.snapshot, {
      minimum: CONTRADICTION_MID_BAND_MIN,
      maximum: CONTRADICTION_MID_BAND_MAX,
    }, signal);
    onProgress?.("merging_candidates", result.pairs.length, result.pairs.length);
    return { candidates: mergeContradictionCandidates(ruleCandidates, embeddingContradictionsToCandidates(result.pairs)), indexAvailable: true };
  });
  onProgress?.("filtering_dismissals");
  const dismissalFile = await context.reader.read(DISMISSALS_PATH);
  const dismissed = dismissalFile ? parseDismissals(dismissalFile.content) : new Set<string>();
  return { candidates: candidates.candidates.filter((candidate) => !dismissed.has(candidate.id)), indexAvailable: candidates.indexAvailable };
}

export function createSemanticActions(moduleContext: ModuleContext): ModuleAction[] {
  const tasks = createTaskRegistry();
  const actions: ModuleAction[] = [
    action("semantic.index.rebuild", "compute", parseRebuildInput, async (raw, context) => {
      const { taskId } = raw as { taskId: string };
      const task = tasks.begin(context, taskId, "reading_snapshot");
      try {
        const entities = await readCanonicalSnapshotEntities(context.reader, task.signal);
        const passages = buildSemanticPassages(entities);
        task.update("embedding", 0, passages.length);
        const result = await withCapability(moduleContext, (embedding) => embedding.index(passages, context.reader.snapshot, task.signal, (completed, total) => task.update("embedding", completed, total)));
        task.update("complete", result.scanned, result.scanned);
        return { ok: true, snapshot: context.reader.snapshot, data: { ...result, taskId } } as ActionResult;
      } finally { task.finish(); }
    }),
    action("semantic.index.status", "read", parseEmpty, async (_raw, context) => {
      const status = await withCapability(moduleContext, (embedding) => embedding.status(context.reader.snapshot, context.signal));
      return { ok: true, snapshot: context.reader.snapshot, data: { ...status, taskId: null, activeTasks: tasks.list(), privacy: { locality: "local", projectDataTransmission: "none", modelArtifactDownloads: "pinned artifacts may be fetched if missing", modelExecution: "supervised CPU worker", indexStorage: "local module cache" } } } as ActionResult;
    }),
    action("semantic.search", "compute", parseSearch, async (raw, context) => {
      const input = raw as ReturnType<typeof parseSearch>;
      const taskId = input.taskId ?? randomUUID();
      const task = tasks.begin(context, taskId, "reading_snapshot");
      try {
        if (!input.query.trim()) return { ok: true, snapshot: context.reader.snapshot, data: { query: input.query, mode: input.mode, results: [], taskId } } as ActionResult;
        const entities = await readCanonicalSnapshotEntities(context.reader, task.signal);
        const knownTerms = getKnownTerms(entities);
        const lexical = searchSnapshotLexically(entities, input.query, Math.max(input.limit * 2, input.limit), knownTerms);
        let nearest: SemanticPassageHit[] = [];
        let vectorUnavailable = false;
        if (input.mode === "expression" || input.mode === "sentence" || input.mode === "scene") {
          task.update("embedding_query");
          try {
            const result = await withCapability(moduleContext, (embedding) => embedding.nearest(input.query, context.reader.snapshot, {
              limit: Math.min(100, Math.max(input.limit * 3, 30)),
            }, task.signal));
            nearest = result.hits;
          } catch (error) {
            if (task.signal.aborted) throw error;
            vectorUnavailable = true;
          }
        }
        task.update(input.mode === "expression" ? "ordering_expressions" : "ranking_results");
        let results: SemanticSearchHit[];
        if (input.mode === "expression") {
          const ordered = await withTokenizer(moduleContext, task.signal, async (tokenizer) => {
            const described: SemanticPassageHit[] = [];
            const other: SemanticPassageHit[] = [];
            for (const hit of nearest) {
              if (task.signal.aborted) throw task.signal.reason ?? codeError("job_cancelled", "Expression search was cancelled");
              const analysis = await tokenizer.analyze(hit.text, context.reader.snapshot, task.signal);
              (analysis.tokens.some((token) => isVerb(token) || isAdjective(token) || isAdverb(token)) ? described : other).push(hit);
            }
            return [...described, ...other];
          });
          results = ordered.slice(0, input.limit).map((hit, index) => {
            const scores = scoreBreakdown(null, index + 1, undefined, hit.score);
            return { sceneId: hit.entityId, entityId: hit.entityId, sentenceIndex: hit.sentenceIndex, snippet: hit.text, text: hit.text,
              score: scores.rrf, scores, ...(hit.type ? { type: hit.type } : {}), ...(hit.name ? { name: hit.name } : {}), ...(hit.filePath ? { filePath: hit.filePath } : {}) };
          });
        } else if (input.mode === "sentence") {
          results = buildSentenceHits(lexical, nearest, input.limit);
        } else {
          results = sceneHits(lexical, nearest, input.limit);
        }
        const { settings } = await readSettings(context);
        const shouldRerank = input.rerank ?? settings.rerankerEnabled;
        let rerankWarning: string | undefined;
        if (shouldRerank && input.mode !== "expression" && results.length > 0) {
          task.update("reranking", 0, Math.min(30, results.length));
          const reranked = await applyRerank(input.query, results, context.reader.snapshot, task.signal, moduleContext);
          results = reranked.hits;
          rerankWarning = reranked.warning;
        }
        return { ok: true, snapshot: context.reader.snapshot, data: { query: input.query, mode: input.mode, results, model: EMBEDDING_MODEL_ID, modelVersion: EMBEDDING_MODEL_VERSION,
          reranker: shouldRerank && input.mode !== "expression" ? { id: RERANKER_MODEL_ID, version: RERANKER_MODEL_VERSION } : null,
          ...(vectorUnavailable ? { warning: "semantic_index_missing_or_model_unavailable" } : {}), ...(rerankWarning ? { rerankWarning } : {}), taskId } } as ActionResult;
      } finally { task.finish(); }
    }),
    action("semantic.expressions.search", "compute", (value) => {
      const input = parseSearch({ ...record(value), mode: "expression" });
      return input;
    }, async (raw, context) => {
      const input = raw as ReturnType<typeof parseSearch>;
      return actions.find((item) => item.id === "semantic.search")!.invoke(input, context);
    }),
    action("semantic.terms.clusters", "compute", parseClusters, async (raw, context) => {
      const input = raw as ReturnType<typeof parseClusters>;
      const task = input.taskId ? tasks.begin(context, input.taskId, "discovering_candidates") : undefined;
      try {
        let candidates = input.candidates;
        if (!candidates) {
          const result = await context.invoke("nlp.discoverCandidates", {}, task?.signal ?? context.signal);
          if (!result.ok) throw codeError(result.error.code, result.error.message);
          const data = record(result.data, "nlp.discoverCandidates result");
          if (!Array.isArray(data.candidates)) throw new TypeError("NLP candidate action returned an invalid candidate list");
          candidates = data.candidates as CandidateTerm[];
        }
        const clusters = input.useEmbedding
          ? await withCapability(moduleContext, (embedding) => clusterSimilarTerms(candidates!, {
            useEmbedding: true, snapshot: context.reader.snapshot, signal: task?.signal ?? context.signal, embedding,
          }))
          : await clusterSimilarTerms(candidates);
        return { ok: true, snapshot: context.reader.snapshot, data: { candidates: candidates.length, clusters, model: input.useEmbedding ? EMBEDDING_MODEL_ID : null, modelVersion: input.useEmbedding ? EMBEDDING_MODEL_VERSION : null } } as ActionResult;
      } finally { task?.finish(); }
    }),
    action("semantic.contradictions.rebuild", "compute", (value) => {
      const input = record(value);
      return { ...(input.taskId === undefined ? {} : { taskId: safeTaskId(input.taskId) }) };
    }, async (raw, context) => {
      const taskId = (raw as { taskId?: string }).taskId ?? randomUUID();
      const task = tasks.begin(context, taskId, "checking_rules");
      try {
        const result = await rebuildCandidates(moduleContext, context, task.signal, (phase, completed, total) => task.update(phase, completed, total));
        task.update("complete", result.candidates.length, result.candidates.length);
        return { ok: true, snapshot: context.reader.snapshot, data: { candidates: result.candidates, count: result.candidates.length, indexAvailable: result.indexAvailable, taskId } } as ActionResult;
      } finally { task.finish(); }
    }),
    action("semantic.contradictions.dismiss", "propose", parseDismissal, async (raw, context) => {
      const { candidateId } = raw as { candidateId: string };
      const current = await rebuildCandidates(moduleContext, context, context.signal);
      const candidate = current.candidates.find((item) => item.id === candidateId);
      if (!candidate) throw codeError("stale_contradiction_candidate", "The contradiction candidate no longer exists in this snapshot");
      const file = await context.reader.read(DISMISSALS_PATH);
      const content = file?.content ?? "";
      const revision = file?.revision ?? null;
      const recordLine = JSON.stringify({ candidateId, timestamp: new Date().toISOString() });
      const next = `${content}${content && !content.endsWith("\n") ? "\n" : ""}${recordLine}\n`;
      const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
      const uniquePaths = [...new Set([candidate.evidenceA.sceneId, candidate.evidenceB.sceneId]
        .map((entityId) => story.entities.get(entityId)?.filePath)
        .filter((path): path is string => typeof path === "string"))];
      const sourceReads = await Promise.all(uniquePaths.map(async (path) => ({ path, revision: (await context.reader.read(path))?.revision ?? null })));
      const readScopes = await Promise.all(["bible", "plot"].map(async (prefix) => ({
        prefix,
        revision: await snapshotScopeRevision(context.reader, prefix),
      })));
      const evidence: ProposalEvidence = {
        id: randomUUID(), snapshot: context.reader.snapshot, module: "semantic", kind: "contradiction_dismissal",
        paths: [{ path: DISMISSALS_PATH, revision }, ...sourceReads],
        details: { candidateId, kind: candidate.kind, score: candidate.score, evidenceA: candidate.evidenceA, evidenceB: candidate.evidenceB },
      };
      const dismissal = operation(context, DISMISSALS_PATH, revision, next, "Dismiss semantic contradiction candidate", sourceReads);
      dismissal.readScopes = readScopes;
      const proposal = await context.propose([dismissal], [evidence], undefined, context.signal);
      return { ok: true, snapshot: context.reader.snapshot, data: { candidateId, dismissed: true, proposal } } as ActionResult;
    }),
    action("semantic.settings.read", "read", parseEmpty, async (_raw, context) => {
      const { settings } = await readSettings(context);
      return { ok: true, snapshot: context.reader.snapshot, data: { settings, privacy: { locality: "local", projectDataTransmission: "none", modelArtifactDownloads: "pinned artifacts may be fetched if missing", externalProviders: false }, models: {
        embedding: { id: EMBEDDING_MODEL_ID, version: EMBEDDING_MODEL_VERSION, dimensions: EMBEDDING_DIMENSIONS },
        reranker: { id: RERANKER_MODEL_ID, version: RERANKER_MODEL_VERSION },
      } } } as ActionResult;
    }),
    action("semantic.settings.update", "propose", parseSettingsUpdate, async (raw, context) => {
      const input = raw as { rerankerEnabled: boolean };
      const { revision } = await readSettings(context);
      const settings: SemanticSettings = { schemaVersion: 1, rerankerEnabled: input.rerankerEnabled };
      const content = `${JSON.stringify(settings, null, 2)}\n`;
      const proposal = await context.propose([operation(context, SETTINGS_PATH, revision, content, "Update semantic search settings")], [{
        id: randomUUID(), snapshot: context.reader.snapshot, module: "semantic", kind: "semantic_settings_update",
        paths: [{ path: SETTINGS_PATH, revision }], details: settings,
      }], undefined, context.signal);
      return { ok: true, snapshot: context.reader.snapshot, data: { settings, proposal } } as ActionResult;
    }),
    action("semantic.task.status", "read", parseEmpty, async (_raw, context) => ({ ok: true, snapshot: context.reader.snapshot, data: { activeTasks: tasks.list() } } as ActionResult)),
    action("semantic.task.cancel", "compute", parseTaskInput, async (raw, context) => {
      const { taskId } = raw as { taskId: string };
      return { ok: true, snapshot: context.reader.snapshot, data: { taskId, cancelled: tasks.cancel(taskId) } } as ActionResult;
    }),
  ];
  return actions;
}
