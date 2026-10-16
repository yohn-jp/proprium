import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MAX_JOB_INPUT_BYTES,
  MAX_JOB_OUTPUT_BYTES,
  snapshotKey,
  type ActionResult,
  type ChangeOperation,
  type JobRequest,
  type ModuleAction,
  type ModuleActionContext,
  type ModuleContext,
  type ModuleDefinition,
  type ModuleManifest,
  type ProposalEvidence,
  type SnapshotId,
  type ValueSchema,
  type WorkerService,
} from "@scriptorium/contracts";
import type { StoryEntity } from "@scriptorium/module-story";
import type { MorphologyAnalysis, Token } from "@scriptorium/module-nlp";
import type { StylometricProfile } from "@scriptorium/module-diagnostics";
import { NLP_MODEL_ID, NLP_MODEL_VERSION, NLP_TOKENIZER_CAPABILITY, type NlpTokenizerCapability } from "@scriptorium/module-nlp";
import { removeDialogueBrackets } from "@scriptorium/module-diagnostics";
import YAML from "yaml";
import { parseSpeakerCorrections, type SpeakerCorrectionRecord } from "./algorithms/speakerCorrectionLog.js";
import { parseSpeakerModel, type SpeakerModel } from "./algorithms/speakerReranker.js";
import { emptySpeakerRuleGates, parseSpeakerRuleGates, computeSpeakerRuleGates, type SpeakerRuleGates } from "./algorithms/speakerRuleStats.js";
import { splitIntoSentences, isDialogue } from "./algorithms/textAnalysis.js";
import { hashDialogueText, type SpeakerAttribution, type SpeakerOverride } from "./algorithms/speakerAttribution.js";
import { runSpeakerPipeline, type SpeakerPipelineInput, type SpeakerPipelineResult } from "./algorithms/pipeline.js";
import type { SpeakerEvalReport } from "./algorithms/speakerEval.js";
import { SPEAKER_ENGINE_ID, SPEAKER_ENGINE_VERSION, SPEAKER_MODULE_VERSION, type SpeakerTrainingResult, type SpeakerWorkerInput } from "./engine.js";

export * from "./algorithms/speakerAttribution.js";
export * from "./algorithms/speakerClustering.js";
export * from "./algorithms/speakerCount.js";
export * from "./algorithms/speakerCountEstimate.js";
export * from "./algorithms/speakerEval.js";
export * from "./algorithms/speakerGroupLabeling.js";
export * from "./algorithms/speakerOverrides.js";
export * from "./algorithms/speakerReranker.js";
export * from "./algorithms/speakerRuleStats.js";
export * from "./algorithms/speakerCorrectionLog.js";
export * from "./algorithms/voice/index.js";
export { createSpeakerMigrationProducer } from "./migration.js";
export { runSpeakerPipeline } from "./algorithms/pipeline.js";

const manifest: ModuleManifest = {
  id: "speaker",
  version: SPEAKER_MODULE_VERSION,
  contractVersion: 1,
  dependencies: ["story", "nlp", "diagnostics"],
  provides: [],
  requires: [NLP_TOKENIZER_CAPABILITY],
  serverEntry: "./dist/index.js",
  browserEntry: "./dist/browser.js",
  workerEntry: "./dist/worker.js",
  statePaths: ["meta/scriptorium/modules/speaker", "plot/volumes"],
  locality: "local",
};

const CORRECTIONS_PATH = "meta/scriptorium/modules/speaker/corrections.jsonl";
const ADOPTED_MODEL_PATH = "meta/scriptorium/modules/speaker/adopted-model.json";
const MAX_SCENE_CHARACTERS = 500_000;
const MAX_SCENES = 500;
const MAX_DIALOGUES = 500;
const MAX_CORPUS_CHARACTERS = 20_000;
const MAX_ATTRIBUTIONS = 100;
const WORKER_DEADLINE_MS = 120_000;
const CONFIDENCE_RANK: Record<SpeakerAttribution["confidence"], number> = { none: 0, low: 1, high: 2 };
const passThrough: ValueSchema = { parse(value) { return value; } };

type RecordValue = Record<string, unknown>;
type SpeakerCacheIdentity = {
  schemaVersion: 1;
  moduleVersion: string;
  engineId: string;
  engineVersion: string;
  tokenizerModel: string;
  tokenizerModelVersion: string;
  adoptedModelRevision: string | null;
};
type SpeakerPublicIdentity = {
  speakerEngine: string;
  speakerEngineVersion: string;
  speakerModuleVersion: string;
  adoptedModelIdentity: { revision: string } | null;
  tokenizerModel: string;
  tokenizerModelVersion: string;
};
type SceneContextDto = {
  scene: StoryEntity;
  appears?: StoryEntity[];
  manuscriptBody?: string;
  manuscriptPath?: string | null;
  manuscriptFileRevision?: string | null;
};
type PreparedScene = {
  scene: StoryEntity;
  text: string;
  candidates: StoryEntity[];
};
const cacheIdentityByContext = new WeakMap<ModuleActionContext, Promise<SpeakerCacheIdentity>>();

function record(value: unknown, label = "input"): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as RecordValue;
}

function objectSchema(value: unknown): RecordValue { return record(value); }

function schema(parse: (value: unknown) => unknown = (value) => value): ValueSchema {
  return { parse };
}

function snapshotFailure(context: ModuleActionContext, cause: unknown): ActionResult {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  const retryable = Boolean(cause && typeof cause === "object" && (cause as { retryable?: unknown }).retryable === true);
  const code = typeof (cause as { code?: unknown } | null)?.code === "string"
    ? String((cause as { code: string }).code)
    : error instanceof TypeError ? "invalid_input" : "speaker_action_failed";
  return { ok: false, snapshot: context.reader.snapshot, error: { code, message: error.message, retryable } };
}

function action(
  id: string,
  effect: ModuleAction["effect"],
  inputSchema: ValueSchema,
  handler: (input: RecordValue, context: ModuleActionContext) => Promise<unknown>,
  job?: ModuleAction["job"],
): ModuleAction {
  return {
    id,
    effect,
    inputSchema,
    outputSchema: passThrough,
    ...(job ? { job } : {}),
    async invoke(value, context) {
      const proposals: NonNullable<Extract<ActionResult, { ok: true }>['proposals']> = [];
      const scopedContext: ModuleActionContext = {
        ...context,
        async invoke(actionId, input, signal) {
          const result = await context.invoke(actionId, input, signal);
          if (result.ok && result.proposals) proposals.push(...result.proposals);
          return result;
        },
        async propose(operations, evidence, proposalId, signal) {
          const proposal = await context.propose(operations, evidence, proposalId, signal);
          proposals.push(proposal);
          return proposal;
        },
      };
      try {
        if (context.signal.aborted) throw context.signal.reason ?? Object.assign(new Error("Speaker action cancelled"), { code: "job_cancelled" });
        const input = record(inputSchema.parse(value));
        const data = await handler(input, scopedContext);
        if (context.signal.aborted) throw context.signal.reason ?? Object.assign(new Error("Speaker action cancelled"), { code: "job_cancelled" });
        return { ok: true, snapshot: context.reader.snapshot, data, ...(proposals.length ? { proposals } : {}) };
      } catch (error) {
        return snapshotFailure(context, error);
      }
    },
  };
}

function parseIdInput(value: unknown): { sceneId: string } {
  const input = record(value);
  if (typeof input.sceneId !== "string" || !input.sceneId.trim() || input.sceneId.length > 256) throw new TypeError("sceneId must be a non-empty string of at most 256 characters");
  return { sceneId: input.sceneId };
}

function parseSceneTextInput(value: unknown): { sceneId: string; text?: string } {
  const input = parseIdInput(value) as { sceneId: string; text?: string };
  const raw = record(value);
  if (raw.text !== undefined && (typeof raw.text !== "string" || raw.text.length > MAX_SCENE_CHARACTERS)) throw new TypeError(`text must be at most ${MAX_SCENE_CHARACTERS} characters`);
  return { ...input, ...(typeof raw.text === "string" ? { text: raw.text } : {}) };
}

function parseDialogueInput(value: unknown): { characterId: string; sceneId?: string; limit: number; minConfidence: "high" | "low" } {
  const input = record(value);
  if (typeof input.characterId !== "string" || !input.characterId.trim() || input.characterId.length > 256) throw new TypeError("characterId must be a non-empty string of at most 256 characters");
  if (input.sceneId !== undefined && (typeof input.sceneId !== "string" || !input.sceneId.trim() || input.sceneId.length > 256)) throw new TypeError("sceneId must be a non-empty string of at most 256 characters");
  const limit = input.limit === undefined ? 20 : input.limit;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 2_000) throw new TypeError("limit must be an integer between 1 and 2000");
  const minConfidence = input.minConfidence === undefined ? "low" : input.minConfidence;
  if (minConfidence !== "high" && minConfidence !== "low") throw new TypeError("minConfidence must be high or low");
  return {
    characterId: input.characterId,
    ...(typeof input.sceneId === "string" ? { sceneId: input.sceneId } : {}),
    limit: limit as number,
    minConfidence,
  };
}

function parseOverrideInput(value: unknown): {
  sceneId: string; sentenceIndex: number; dialogueText: string; speakerEntityId: string | null;
  correction?: { label: "direct" | "propagated" };
} {
  const input = record(value);
  const scene = parseIdInput(input);
  if (!Number.isSafeInteger(input.sentenceIndex) || (input.sentenceIndex as number) < 1) throw new TypeError("sentenceIndex must be a positive integer");
  if (typeof input.dialogueText !== "string" || input.dialogueText.length > 5_000) throw new TypeError("dialogueText must be a string of at most 5000 characters");
  if (!(input.speakerEntityId === null || (typeof input.speakerEntityId === "string" && input.speakerEntityId.length <= 256))) throw new TypeError("speakerEntityId must be a character ID or null");
  let correction: { label: "direct" | "propagated" } | undefined;
  if (input.correction !== undefined) {
    const raw = record(input.correction, "correction");
    if (raw.label !== "direct" && raw.label !== "propagated") throw new TypeError("correction.label must be direct or propagated");
    correction = { label: raw.label };
  }
  return { ...scene, sentenceIndex: input.sentenceIndex as number, dialogueText: input.dialogueText, speakerEntityId: input.speakerEntityId as string | null, ...(correction ? { correction } : {}) };
}

function parseEvaluationInput(value: unknown): { writeGates: boolean } {
  const input = record(value);
  if (input.writeGates !== undefined && typeof input.writeGates !== "boolean") throw new TypeError("writeGates must be boolean");
  return { writeGates: input.writeGates === true };
}

function parseRetrainInput(value: unknown): { holdoutSceneIds?: string[]; dryRun: boolean } {
  const input = record(value);
  if (input.forceWrite !== undefined) throw new TypeError("forceWrite is not supported; adoption requires the held-out improvement gate");
  if (input.dryRun !== undefined && typeof input.dryRun !== "boolean") throw new TypeError("dryRun must be boolean");
  let holdoutSceneIds: string[] | undefined;
  if (input.holdoutSceneIds !== undefined) {
    if (!Array.isArray(input.holdoutSceneIds) || input.holdoutSceneIds.length > MAX_SCENES || input.holdoutSceneIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 256)) throw new TypeError("holdoutSceneIds must be a bounded string array");
    holdoutSceneIds = [...new Set(input.holdoutSceneIds as string[])];
  }
  return { ...(holdoutSceneIds ? { holdoutSceneIds } : {}), dryRun: input.dryRun === true };
}

function assertStoryEntity(value: unknown): asserts value is StoryEntity {
  const entity = record(value, "Story entity");
  if (typeof entity.id !== "string" || typeof entity.type !== "string" || typeof entity.filePath !== "string" || !record(entity.raw, "entity.raw")) throw new TypeError("Story returned an invalid entity");
}

async function invokeData(context: ModuleActionContext, actionId: string, input: unknown): Promise<unknown> {
  const result = await context.invoke(actionId, input, context.signal);
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code, retryable: result.error.retryable });
  if (snapshotKey(result.snapshot) !== snapshotKey(context.reader.snapshot)) throw Object.assign(new Error(`${actionId} returned a result from a different snapshot`), { code: "snapshot_mismatch" });
  return result.data;
}

async function loadEntities(context: ModuleActionContext): Promise<StoryEntity[]> {
  const raw = await invokeData(context, "story.entities.list", {});
  if (!Array.isArray(raw)) throw new TypeError("Story entity list is not an array");
  for (const entity of raw) assertStoryEntity(entity);
  return raw as StoryEntity[];
}

function resolveCandidates(scene: StoryEntity, appears: StoryEntity[] | undefined, entities: StoryEntity[], text: string): StoryEntity[] {
  const appearing = (appears ?? []).filter((entity) => entity.type === "character");
  if (appearing.length > 0) return appearing;
  const { buildMentionDictionary, findMentions } = mentionApi;
  const ids = new Set(findMentions(buildMentionDictionary(new Map(entities.map((entity) => [entity.id, entity]))), text));
  return entities.filter((entity) => entity.type === "character" && ids.has(entity.id));
}

import * as mentionApi from "./algorithms/mentionIndex.js";

async function loadScene(context: ModuleActionContext, sceneId: string, textOverride?: string): Promise<{ prepared: PreparedScene; entities: StoryEntity[]; sceneContext: SceneContextDto }> {
  const [entities, rawContext] = await Promise.all([
    loadEntities(context),
    invokeData(context, "story.scene.context", { sceneId }),
  ]);
  if (!rawContext) throw Object.assign(new Error(`Scene not found: ${sceneId}`), { code: "not_found" });
  const sceneContext = rawContext as SceneContextDto;
  assertStoryEntity(sceneContext.scene);
  if (sceneContext.scene.type !== "scene" || sceneContext.scene.id !== sceneId) throw new TypeError("Story returned an invalid scene context");
  const text = textOverride ?? sceneContext.manuscriptBody ?? "";
  if (text.length > MAX_SCENE_CHARACTERS) throw Object.assign(new Error(`Scene exceeds ${MAX_SCENE_CHARACTERS} characters`), { code: "scene_too_large" });
  const candidates = resolveCandidates(sceneContext.scene, sceneContext.appears, entities, text);
  return { prepared: { scene: sceneContext.scene, text, candidates }, entities, sceneContext };
}

async function prepareTokenCache(text: string, tokenizer: NlpTokenizerCapability, snapshot: SnapshotId, signal: AbortSignal): Promise<Record<string, Token[]>> {
  const inputs = new Set<string>();
  for (const sentence of splitIntoSentences(text)) {
    if (!sentence.trim()) continue;
    inputs.add(sentence);
    if (isDialogue(sentence)) {
      const content = removeDialogueBrackets(sentence).trim();
      if (content) inputs.add(content);
    }
  }
  const tokenCache: Record<string, Token[]> = {};
  for (const value of inputs) {
    if (signal.aborted) throw signal.reason ?? Object.assign(new Error("Speaker action cancelled"), { code: "job_cancelled" });
    const analysis: MorphologyAnalysis = await tokenizer.analyze(value, snapshot, signal);
    if (analysis.text !== value) throw new TypeError("Shared tokenizer returned morphology for different text");
    tokenCache[value] = analysis.tokens;
  }
  return tokenCache;
}

async function enrichPipeline(
  scene: PreparedScene,
  entities: StoryEntity[],
  tokenizer: NlpTokenizerCapability,
  context: ModuleActionContext,
  moduleContext: ModuleContext,
  options: { stylometricProfiles?: StylometricProfile[]; ignoreOverrides?: boolean; skipReranker?: boolean } = {},
): Promise<SpeakerPipelineInput> {
  const identity = await cacheIdentityFor(context);
  const [cache, gates, model] = await Promise.all([
    prepareTokenCache(scene.text, tokenizer, context.reader.snapshot, context.signal),
    readGateCache(moduleContext.cacheDirectory, context.reader.snapshot, identity),
    readAdoptedModel(context),
  ]);
  return {
    scene: scene.scene,
    text: scene.text,
    entities,
    candidates: scene.candidates,
    tokenCache: cache,
    gates: gates.gates,
    model,
    ...(options.stylometricProfiles ? { stylometricProfiles: options.stylometricProfiles } : {}),
    ...(options.ignoreOverrides === true ? { ignoreOverrides: true } : {}),
    ...(options.skipReranker === true ? { skipReranker: true } : {}),
  };
}

async function readAdoptedModel(context: ModuleActionContext): Promise<SpeakerModel | null> {
  const file = await context.reader.read(ADOPTED_MODEL_PATH);
  if (!file) return null;
  try { return parseSpeakerModel(JSON.parse(file.content)); }
  catch { return null; }
}

async function cacheIdentityFor(context: ModuleActionContext): Promise<SpeakerCacheIdentity> {
  let pending = cacheIdentityByContext.get(context);
  if (!pending) {
    pending = context.reader.read(ADOPTED_MODEL_PATH).then((adoptedModel) => ({
      schemaVersion: 1,
      moduleVersion: SPEAKER_MODULE_VERSION,
      engineId: SPEAKER_ENGINE_ID,
      engineVersion: SPEAKER_ENGINE_VERSION,
      tokenizerModel: NLP_MODEL_ID,
      tokenizerModelVersion: NLP_MODEL_VERSION,
      adoptedModelRevision: adoptedModel?.revision ?? null,
    }));
    cacheIdentityByContext.set(context, pending);
  }
  return pending;
}

function cacheFile(cacheDirectory: string, kind: "rules" | "evaluation", snapshot: SnapshotId, identity: SpeakerCacheIdentity): string {
  const key = JSON.stringify({ snapshot: snapshotKey(snapshot), identity });
  const digest = createHash("sha256").update(key).digest("hex");
  return path.join(cacheDirectory, "speaker", `${kind}-${digest}.json`);
}

function sameCacheIdentity(actual: unknown, expected: SpeakerCacheIdentity): boolean {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const value = actual as Record<string, unknown>;
  return Object.keys(expected).length === Object.keys(value).length
    && Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue);
}

function cacheProvenance(identity: SpeakerCacheIdentity): RecordValue {
  return {
    ...generatedResultIdentity(identity),
    moduleVersion: identity.moduleVersion,
    engineId: identity.engineId,
    engineVersion: identity.engineVersion,
    adoptedModelRevision: identity.adoptedModelRevision,
  };
}

function speakerIdentityFields(identity: SpeakerCacheIdentity): Pick<SpeakerPublicIdentity, "speakerEngine" | "speakerEngineVersion" | "speakerModuleVersion" | "adoptedModelIdentity"> {
  return {
    speakerEngine: identity.engineId,
    speakerEngineVersion: identity.engineVersion,
    speakerModuleVersion: identity.moduleVersion,
    adoptedModelIdentity: identity.adoptedModelRevision === null ? null : { revision: identity.adoptedModelRevision },
  };
}

function tokenizerIdentityFields(identity: SpeakerCacheIdentity): Pick<SpeakerPublicIdentity, "tokenizerModel" | "tokenizerModelVersion"> {
  return {
    tokenizerModel: identity.tokenizerModel,
    tokenizerModelVersion: identity.tokenizerModelVersion,
  };
}

function generatedResultIdentity(identity: SpeakerCacheIdentity): SpeakerPublicIdentity {
  return { ...speakerIdentityFields(identity), ...tokenizerIdentityFields(identity) };
}

async function writeCache(cacheDirectory: string, filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, filePath);
  } catch (error) {
    await import("node:fs/promises").then(({ rm }) => rm(temporary, { force: true })).catch(() => undefined);
    throw error;
  }
}

async function readGateCache(cacheDirectory: string, snapshot: SnapshotId, identity: SpeakerCacheIdentity): Promise<SpeakerPublicIdentity & { gates: SpeakerRuleGates; exists: boolean; provenance: RecordValue }> {
  try {
    const parsed = JSON.parse(await readFile(cacheFile(cacheDirectory, "rules", snapshot, identity), "utf8")) as { snapshot?: unknown; identity?: unknown; gates?: unknown };
    if (parsed.snapshot !== snapshotKey(snapshot) || !sameCacheIdentity(parsed.identity, identity)) return { ...generatedResultIdentity(identity), gates: emptySpeakerRuleGates(), exists: false, provenance: cacheProvenance(identity) };
    return { ...generatedResultIdentity(identity), gates: parseSpeakerRuleGates(parsed.gates), exists: true, provenance: cacheProvenance(identity) };
  } catch { return { ...generatedResultIdentity(identity), gates: emptySpeakerRuleGates(), exists: false, provenance: cacheProvenance(identity) }; }
}

async function writeGateCache(cacheDirectory: string, snapshot: SnapshotId, identity: SpeakerCacheIdentity, gates: SpeakerRuleGates): Promise<void> {
  await writeCache(cacheDirectory, cacheFile(cacheDirectory, "rules", snapshot, identity), { version: 2, snapshot: snapshotKey(snapshot), identity, gates });
}

async function readEvaluationCache(cacheDirectory: string, snapshot: SnapshotId, identity: SpeakerCacheIdentity): Promise<SpeakerPublicIdentity & { report: SpeakerEvalReport | null; exists: boolean; provenance: RecordValue }> {
  try {
    const parsed = JSON.parse(await readFile(cacheFile(cacheDirectory, "evaluation", snapshot, identity), "utf8")) as { snapshot?: unknown; identity?: unknown; report?: unknown };
    if (parsed.snapshot !== snapshotKey(snapshot) || !sameCacheIdentity(parsed.identity, identity) || !isSpeakerEvalReport(parsed.report)) return { ...generatedResultIdentity(identity), report: null, exists: false, provenance: cacheProvenance(identity) };
    return { ...generatedResultIdentity(identity), report: parsed.report, exists: true, provenance: cacheProvenance(identity) };
  } catch { return { ...generatedResultIdentity(identity), report: null, exists: false, provenance: cacheProvenance(identity) }; }
}

function isSpeakerEvalReport(value: unknown): value is SpeakerEvalReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  if (typeof report.generatedAt !== "string" || !Array.isArray(report.scenes) || !record(report.byReason)) return false;
  const metrics = report.metrics;
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return false;
  return Object.values(metrics as Record<string, unknown>).every((metric) => typeof metric === "number" && Number.isFinite(metric));
}

async function writeEvaluationCache(cacheDirectory: string, snapshot: SnapshotId, identity: SpeakerCacheIdentity, report: SpeakerEvalReport): Promise<void> {
  await writeCache(cacheDirectory, cacheFile(cacheDirectory, "evaluation", snapshot, identity), { version: 2, snapshot: snapshotKey(snapshot), identity, report });
}

async function withTokenizer<T>(moduleContext: ModuleContext, signal: AbortSignal, callback: (tokenizer: NlpTokenizerCapability) => Promise<T>): Promise<T> {
  if (signal.aborted) throw signal.reason ?? Object.assign(new Error("Speaker action cancelled"), { code: "job_cancelled" });
  const lease = await moduleContext.acquireCapability<NlpTokenizerCapability>(NLP_TOKENIZER_CAPABILITY);
  try { return await callback(lease.value); }
  finally { await lease.release(); }
}

async function withSpeakerWorker<T>(
  moduleContext: ModuleContext,
  callback: (worker: WorkerService) => Promise<T>,
): Promise<T> {
  const worker = await moduleContext.createWorkerService();
  try { return await callback(worker); }
  finally { await worker.dispose(); }
}

async function requestSpeakerWorker<T>(
  worker: WorkerService,
  context: ModuleActionContext,
  task: SpeakerWorkerInput["kind"],
  input: SpeakerWorkerInput,
): Promise<T> {
  const encoded = JSON.stringify(input);
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_JOB_INPUT_BYTES) throw Object.assign(new Error(`Speaker worker input exceeds ${MAX_JOB_INPUT_BYTES} UTF-8 bytes`), { code: "job_input_too_large" });
  const request: JobRequest<SpeakerWorkerInput> = {
    id: randomUUID(),
    module: "speaker",
    task: `speaker.${task}`,
    snapshot: context.reader.snapshot,
    model: SPEAKER_ENGINE_ID,
    modelVersion: SPEAKER_ENGINE_VERSION,
    moduleVersion: SPEAKER_MODULE_VERSION,
    deadline: Date.now() + WORKER_DEADLINE_MS,
    input,
  };
  const result = await worker.request<T>(request, context.signal);
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code, retryable: result.error.retryable });
  if (snapshotKey(result.result.snapshot) !== snapshotKey(context.reader.snapshot)) throw Object.assign(new Error("Speaker worker returned a result for another snapshot"), { code: "snapshot_mismatch" });
  const output = JSON.stringify(result.result.output);
  if (output !== undefined && Buffer.byteLength(output, "utf8") > MAX_JOB_OUTPUT_BYTES) throw Object.assign(new Error(`Speaker worker output exceeds ${MAX_JOB_OUTPUT_BYTES} UTF-8 bytes`), { code: "job_output_too_large" });
  return result.result.output;
}

async function runWorker<T>(
  moduleContext: ModuleContext,
  context: ModuleActionContext,
  task: SpeakerWorkerInput["kind"],
  input: SpeakerWorkerInput,
): Promise<T> {
  return withSpeakerWorker(moduleContext, (worker) => requestSpeakerWorker<T>(worker, context, task, input));
}

async function runPipelineAction(
  input: { sceneId: string; text?: string },
  context: ModuleActionContext,
  moduleContext: ModuleContext,
  options: { stylometricProfiles?: StylometricProfile[]; ignoreOverrides?: boolean; skipReranker?: boolean } = {},
): Promise<{ prepared: PreparedScene; pipeline: SpeakerPipelineInput; result: SpeakerPipelineResult; sceneContext: SceneContextDto; entities: StoryEntity[] }> {
  const { prepared, entities, sceneContext } = await loadScene(context, input.sceneId, input.text);
  return withTokenizer(moduleContext, context.signal, async (tokenizer) => {
    const pipeline = await enrichPipeline(prepared, entities, tokenizer, context, moduleContext, options);
    const result = await runWorker<SpeakerPipelineResult>(moduleContext, context, "attribute", { kind: "attribute", pipeline });
    return { prepared, pipeline, result, sceneContext, entities };
  });
}

async function loadCorpusScenes(context: ModuleActionContext): Promise<{ entities: StoryEntity[]; scenes: PreparedScene[] }> {
  const entities = await loadEntities(context);
  const sceneEntities = entities.filter((entity) => entity.type === "scene");
  if (sceneEntities.length > MAX_SCENES) throw Object.assign(new Error(`Work has more than ${MAX_SCENES} scenes; speaker corpus scan is bounded`), { code: "corpus_too_large" });
  const scenes: PreparedScene[] = [];
  for (const scene of sceneEntities) {
    if (context.signal.aborted) throw context.signal.reason ?? Object.assign(new Error("Speaker action cancelled"), { code: "job_cancelled" });
    const raw = await invokeData(context, "story.scene.context", { sceneId: scene.id });
    if (!raw) continue;
    const sceneContext = raw as SceneContextDto;
    const text = typeof sceneContext.manuscriptBody === "string" ? sceneContext.manuscriptBody : "";
    if (!text) continue;
    if (text.length > MAX_SCENE_CHARACTERS) throw Object.assign(new Error(`Scene ${scene.id} exceeds ${MAX_SCENE_CHARACTERS} characters`), { code: "scene_too_large" });
    scenes.push({ scene: sceneContext.scene, text, candidates: resolveCandidates(sceneContext.scene, sceneContext.appears, entities, text) });
  }
  return { entities, scenes };
}

async function prepareCorpusPipelines(
  scenes: PreparedScene[],
  entities: StoryEntity[],
  tokenizer: NlpTokenizerCapability,
  context: ModuleActionContext,
  moduleContext: ModuleContext,
  options: { skipReranker?: boolean; ignoreOverrides?: boolean } = {},
): Promise<SpeakerPipelineInput[]> {
  const pipelines: SpeakerPipelineInput[] = [];
  for (const scene of scenes) {
    if (context.signal.aborted) throw context.signal.reason ?? Object.assign(new Error("Speaker action cancelled"), { code: "job_cancelled" });
    pipelines.push(await enrichPipeline(scene, entities, tokenizer, context, moduleContext, options));
  }
  return pipelines;
}

async function orderedSceneIds(context: ModuleActionContext): Promise<string[]> {
  const raw = record(await invokeData(context, "story.volumes.tree", {}), "Story volume tree");
  if (!Array.isArray(raw.tree)) throw new TypeError("Story volume tree is not an array");
  const sceneIds: string[] = [];
  for (const volumeValue of raw.tree) {
    const volume = record(volumeValue, "volume tree item");
    if (!Array.isArray(volume.chapters)) continue;
    for (const chapterValue of volume.chapters) {
      const chapter = record(chapterValue, "chapter tree item");
      if (!Array.isArray(chapter.scenes)) continue;
      for (const sceneValue of chapter.scenes) {
        const scene = record(sceneValue, "scene tree item");
        if (typeof scene.id === "string") sceneIds.push(scene.id);
      }
    }
  }
  return [...new Set(sceneIds)];
}

async function speakerDialogueList(
  input: ReturnType<typeof parseDialogueInput>,
  context: ModuleActionContext,
  moduleContext: ModuleContext,
): Promise<unknown> {
  const identity = await cacheIdentityFor(context);
  const { entities, scenes } = await loadCorpusScenes(context);
  const character = entities.find((entity) => entity.id === input.characterId);
  if (character?.type !== "character") throw Object.assign(new Error(`Character not found: ${input.characterId}`), { code: "not_found" });
  let selectedScenes = scenes;
  if (input.sceneId) {
    const scene = entities.find((entity) => entity.id === input.sceneId);
    if (scene?.type !== "scene") throw Object.assign(new Error(`Scene not found: ${input.sceneId}`), { code: "not_found" });
    selectedScenes = scenes.filter((item) => item.scene.id === input.sceneId);
  } else {
    const ids = await orderedSceneIds(context);
    const sceneById = new Map(scenes.map((item) => [item.scene.id, item]));
    selectedScenes = ids.flatMap((id) => sceneById.has(id) ? [sceneById.get(id)!] : []);
  }

  const minRank = CONFIDENCE_RANK[input.minConfidence];
  const lines: Array<{ text: string; sceneId: string; sceneName: string; sentenceIndex: number; confidence: SpeakerAttribution["confidence"]; reason: string }> = [];
  await withTokenizer(moduleContext, context.signal, async (tokenizer) => withSpeakerWorker(moduleContext, async (worker) => {
    for (const scene of selectedScenes) {
      if (context.signal.aborted) throw context.signal.reason ?? Object.assign(new Error("Speaker action cancelled"), { code: "job_cancelled" });
      const pipeline = await enrichPipeline(scene, entities, tokenizer, context, moduleContext);
      const result = await requestSpeakerWorker<SpeakerPipelineResult>(worker, context, "attribute", { kind: "attribute", pipeline });
      for (const attribution of result.attributions) {
        if (attribution.speakerEntityId !== input.characterId || CONFIDENCE_RANK[attribution.confidence] < minRank) continue;
        lines.push({
          text: attribution.text,
          sceneId: scene.scene.id,
          sceneName: scene.scene.name ?? scene.scene.id,
          sentenceIndex: attribution.sentenceIndex,
          confidence: attribution.confidence,
          reason: attribution.reason,
        });
      }
    }
  }));
  return {
    ...generatedResultIdentity(identity),
    characterId: input.characterId,
    count: Math.min(lines.length, input.limit),
    minConfidence: input.minConfidence,
    lines: lines.slice(Math.max(0, lines.length - input.limit)),
  };
}

function correctionsFromScene(raw: unknown): SpeakerOverride[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is SpeakerOverride => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    return typeof row.dialogueText === "string" && (row.speakerEntityId === null || typeof row.speakerEntityId === "string");
  });
}

async function readCorrections(context: ModuleActionContext): Promise<{ records: SpeakerCorrectionRecord[]; content: string; revision: string | null; skipped: number }> {
  const file = await context.reader.read(CORRECTIONS_PATH);
  const content = file?.content ?? "";
  const parsed = parseSpeakerCorrections(content);
  return { records: parsed.records, content, revision: file?.revision ?? null, skipped: parsed.skipped };
}

function proposalEvidence(context: ModuleActionContext, kind: string, paths: Array<{ path: string; revision: string | null }>, details: unknown): ProposalEvidence[] {
  return [{ id: randomUUID(), snapshot: context.reader.snapshot, module: "speaker", kind, paths, details }];
}

async function speakerOverrideAction(input: ReturnType<typeof parseOverrideInput>, context: ModuleActionContext, moduleContext: ModuleContext): Promise<unknown> {
  const identity = await cacheIdentityFor(context);
  const { prepared, sceneContext, entities } = await loadScene(context, input.sceneId);
  if (!prepared.scene.filePath.startsWith("plot/volumes/") || !prepared.scene.filePath.endsWith(".yaml")) throw Object.assign(new Error("Scene is not stored at a canonical plot/volumes YAML path"), { code: "invalid_scene_path" });
  const { result, pipeline } = await runPipelineAction({ sceneId: input.sceneId }, context, moduleContext, { ignoreOverrides: true });
  const attribution = result.attributions.find((row) => row.sentenceIndex === input.sentenceIndex);
  if (!attribution || attribution.text !== input.dialogueText) throw Object.assign(new Error("The dialogue changed or no longer matches the requested sentence; reload the scene before confirming"), { code: "stale_attribution" });
  const sceneFile = await context.reader.read(prepared.scene.filePath);
  if (!sceneFile) throw Object.assign(new Error("Canonical scene file is missing"), { code: "not_found" });
  const document = YAML.parseDocument(sceneFile.content, { prettyErrors: true, uniqueKeys: true });
  if (document.errors.length || !YAML.isMap(document.contents)) throw new TypeError(`Scene YAML is invalid: ${document.errors[0]?.message ?? "expected a mapping"}`);
  const existing = Array.isArray(prepared.scene.raw.speakerOverrides) ? prepared.scene.raw.speakerOverrides as unknown[] : [];
  const filtered = existing.filter((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return true;
    const row = value as Record<string, unknown>;
    return row.sentenceIndex !== input.sentenceIndex;
  });
  const textHash = hashDialogueText(input.dialogueText);
  const provisionalOverride: SpeakerOverride = {
    sentenceIndex: input.sentenceIndex,
    textHash,
    dialogueText: input.dialogueText,
    speakerEntityId: input.speakerEntityId,
    source: input.correction?.label ?? "direct",
  };
  const proposedScene = {
    ...prepared.scene,
    raw: { ...prepared.scene.raw, speakerOverrides: [...filtered, provisionalOverride] },
  };
  const confirmed = await runWorker<SpeakerPipelineResult>(moduleContext, context, "attribute", {
    kind: "attribute",
    pipeline: { ...pipeline, scene: proposedScene },
  });
  const confirmedAttribution = confirmed.attributions.find((row) => row.sentenceIndex === input.sentenceIndex && row.text === input.dialogueText);
  const override: SpeakerOverride = {
    ...provisionalOverride,
    ...(confirmedAttribution?.speakerGroupId ? { speakerGroupId: confirmedAttribution.speakerGroupId } : {}),
  };
  document.set("speakerOverrides", [...filtered, override]);
  const updatedScene = document.toString();
  const correction: SpeakerCorrectionRecord = {
    sentenceIndex: input.sentenceIndex,
    textHash,
    dialogueText: input.dialogueText,
    predictedSpeakerEntityId: attribution.speakerEntityId,
    predictedReason: attribution.reason,
    speakerGroupId: attribution.speakerGroupId,
    label: input.correction?.label ?? "direct",
    sceneId: input.sceneId,
    speakerEntityId: input.speakerEntityId,
    timestamp: new Date().toISOString(),
  };
  const correctionFile = await context.reader.read(CORRECTIONS_PATH);
  const oldLog = correctionFile?.content ?? "";
  const appendedLog = `${oldLog}${oldLog && !oldLog.endsWith("\n") ? "\n" : ""}${JSON.stringify(correction)}\n`;
  const reads = [
    { path: prepared.scene.filePath, revision: sceneFile.revision },
    { path: CORRECTIONS_PATH, revision: correctionFile?.revision ?? null },
    ...(sceneContext.manuscriptPath ? [{ path: sceneContext.manuscriptPath, revision: sceneContext.manuscriptFileRevision ?? null }] : []),
  ];
  const operation: ChangeOperation = {
    id: `speaker-${randomUUID()}`,
    generation: 0,
    repository: context.reader.snapshot.repository,
    baseRemoteCommit: context.reader.snapshot.remoteCommit,
    effect: "metadata",
    reads,
    writes: [
      { path: prepared.scene.filePath, revision: sceneFile.revision, content: updatedScene },
      { path: CORRECTIONS_PATH, revision: correctionFile?.revision ?? null, content: appendedLog },
    ],
    message: `Confirm speaker attribution in ${prepared.scene.name ?? prepared.scene.id}`,
  };
  const evidence = proposalEvidence(context, "speaker_attribution_confirmation", reads, {
    sceneId: input.sceneId,
    sentenceIndex: input.sentenceIndex,
    textHash,
    predictedReason: attribution.reason,
  });
  const proposal = await context.propose([operation], evidence, `speaker-confirm-${randomUUID()}`, context.signal);
  return { ...generatedResultIdentity(identity), proposal, attribution, override };
}

function unresolvedRows(attributions: SpeakerAttribution[]): Array<{ attribution: SpeakerAttribution; unresolvedInGroup: number }> {
  const rows = attributions.filter((attribution) => attribution.confidence !== "high").map((attribution) => ({
    attribution,
    unresolvedInGroup: attribution.speakerGroupId === null ? 0 : attributions.filter((candidate) => candidate.speakerGroupId === attribution.speakerGroupId && candidate.confidence !== "high").length,
  }));
  rows.sort((a, b) => CONFIDENCE_RANK[a.attribution.confidence] - CONFIDENCE_RANK[b.attribution.confidence] || b.unresolvedInGroup - a.unresolvedInGroup || a.attribution.sentenceIndex - b.attribution.sentenceIndex);
  return rows;
}

interface SpeakerEvaluationResult {
  speakerEngine: string;
  speakerEngineVersion: string;
  speakerModuleVersion: string;
  adoptedModelIdentity: { revision: string } | null;
  tokenizerModel: string;
  tokenizerModelVersion: string;
  report: SpeakerEvalReport;
  gates: SpeakerRuleGates;
  gatesUpdated: boolean;
  provenance: RecordValue;
}

async function runEvaluation(input: { writeGates: boolean }, context: ModuleActionContext, moduleContext: ModuleContext): Promise<SpeakerEvaluationResult> {
  const identity = await cacheIdentityFor(context);
  const { entities, scenes } = await loadCorpusScenes(context);
  const goldScenes = scenes.filter((scene) => correctionsFromScene(scene.scene.raw.speakerOverrides).length > 0);
  const report = await withTokenizer(moduleContext, context.signal, async (tokenizer) => {
    const pipelines = await prepareCorpusPipelines(goldScenes, entities, tokenizer, context, moduleContext);
    await context.reportProgress?.(0.05);
    return runWorker<SpeakerEvalReport>(moduleContext, context, "evaluate", { kind: "evaluate", pipelines, generatedAt: new Date().toISOString() });
  });
  await writeEvaluationCache(moduleContext.cacheDirectory, context.reader.snapshot, identity, report);
  let gates = await readGateCache(moduleContext.cacheDirectory, context.reader.snapshot, identity);
  if (input.writeGates) {
    const { records } = await readCorrections(context);
    gates = { ...generatedResultIdentity(identity), gates: computeSpeakerRuleGates(report.byReason, records), exists: true, provenance: cacheProvenance(identity) };
    await writeGateCache(moduleContext.cacheDirectory, context.reader.snapshot, identity, gates.gates);
  }
  await context.reportProgress?.(1);
  return { ...generatedResultIdentity(identity), report, gates: gates.gates, gatesUpdated: input.writeGates, provenance: cacheProvenance(identity) };
}

async function deterministicHoldoutIds(scenes: PreparedScene[]): Promise<string[]> {
  if (scenes.length < 2) return [];
  const ranked = scenes.map((scene) => ({
    id: scene.scene.id,
    rank: createHash("sha256").update(`speaker-holdout-v1:${scene.scene.id}`).digest("hex"),
  })).sort((a, b) => a.rank.localeCompare(b.rank));
  const count = Math.min(scenes.length - 1, Math.max(1, Math.ceil(scenes.length * 0.2)));
  return ranked.slice(0, count).map((row) => row.id);
}

async function speakerRetrainAction(input: ReturnType<typeof parseRetrainInput>, context: ModuleActionContext, moduleContext: ModuleContext): Promise<unknown> {
  const identity = await cacheIdentityFor(context);
  const { entities, scenes } = await loadCorpusScenes(context);
  const goldScenes = scenes.filter((scene) => correctionsFromScene(scene.scene.raw.speakerOverrides).length > 0);
  const holdoutIds = input.holdoutSceneIds ?? await deterministicHoldoutIds(goldScenes);
  const knownGoldIds = new Set(goldScenes.map((scene) => scene.scene.id));
  if (holdoutIds.some((id) => !knownGoldIds.has(id))) throw new TypeError("Every holdout scene must contain canonical speaker overrides");
  const holdoutSet = new Set(holdoutIds);
  const trainingScenes = goldScenes.filter((scene) => !holdoutSet.has(scene.scene.id));
  const holdoutScenes = goldScenes.filter((scene) => holdoutSet.has(scene.scene.id));
  if (holdoutScenes.length === 0) throw Object.assign(new Error("At least one holdout scene with canonical speaker overrides is required"), { code: "empty_holdout" });
  const { records: corrections } = await readCorrections(context);
  const gates = await readGateCache(moduleContext.cacheDirectory, context.reader.snapshot, identity);
  const result = await withTokenizer(moduleContext, context.signal, async (tokenizer) => {
    const [trainPipelines, holdoutPipelines] = await Promise.all([
      prepareCorpusPipelines(trainingScenes, entities, tokenizer, context, moduleContext, { ignoreOverrides: true, skipReranker: true }),
      prepareCorpusPipelines(holdoutScenes, entities, tokenizer, context, moduleContext, { ignoreOverrides: true, skipReranker: true }),
    ]);
    const reasonPrecision = Object.fromEntries(Object.entries(gates.gates.gates).map(([reason, gate]) => [reason, gate.measuredPrecision]));
    await context.reportProgress?.(0.05);
    return runWorker<SpeakerTrainingResult>(moduleContext, context, "train", {
      kind: "train", trainPipelines, holdoutPipelines, corrections, reasonPrecision,
    });
  });
  const { model, ...metrics } = result;
  let adoptionProposal: unknown = null;
  if (result.adopted && !input.dryRun) {
    const existing = await context.reader.read(ADOPTED_MODEL_PATH);
    const content = `${JSON.stringify(model, null, 2)}\n`;
    const operation: ChangeOperation = {
      id: `speaker-model-${randomUUID()}`,
      generation: 0,
      repository: context.reader.snapshot.repository,
      baseRemoteCommit: context.reader.snapshot.remoteCommit,
      effect: "settings",
      reads: [{ path: ADOPTED_MODEL_PATH, revision: existing?.revision ?? null }],
      writes: [{ path: ADOPTED_MODEL_PATH, revision: existing?.revision ?? null, content }],
      message: "Adopt speaker attribution model after held-out evaluation",
    };
    adoptionProposal = await context.propose([operation], proposalEvidence(context, "speaker_model_adoption", operation.reads, {
      trainExampleCount: result.trainExampleCount,
      holdoutSceneIds: result.holdoutSceneIds,
      accuracyWithoutModel: result.accuracyWithoutModel,
      accuracyWithModel: result.accuracyWithModel,
      deltaPt: result.deltaPt,
    }), `speaker-model-adoption-${randomUUID()}`, context.signal);
  }
  await context.reportProgress?.(1);
  return { ...generatedResultIdentity(identity), ...metrics, model, adoptionProposal, dryRun: input.dryRun, provenance: cacheProvenance(identity) };
}

interface VoiceProfileAnalysis {
  fingerprints: RecordValue[];
  matrix: RecordValue[];
  stylometricProfiles: StylometricProfile[];
  diagnosticsEngine: string;
  diagnosticsEngineVersion: string;
  targetResult?: SpeakerPipelineResult;
}

async function analyzeVoiceProfiles(
  entities: StoryEntity[],
  scenes: PreparedScene[],
  context: ModuleActionContext,
  moduleContext: ModuleContext,
  target?: PreparedScene,
): Promise<VoiceProfileAnalysis> {
  return withTokenizer(moduleContext, context.signal, async (tokenizer) => withSpeakerWorker(moduleContext, async (worker) => {
    const corpusDialogues: Record<string, string[]> = {};
    for (const scene of scenes) {
      if (context.signal.aborted) throw context.signal.reason ?? Object.assign(new Error("Speaker action cancelled"), { code: "job_cancelled" });
      const pipeline = await enrichPipeline(scene, entities, tokenizer, context, moduleContext);
      const result = await requestSpeakerWorker<SpeakerPipelineResult>(worker, context, "attribute", {
        kind: "attribute", pipeline: { ...pipeline, stylometricProfiles: [] },
      });
      for (const attribution of result.attributions) {
        if (attribution.confidence !== "high" || !attribution.speakerEntityId) continue;
        (corpusDialogues[attribution.speakerEntityId] ??= []).push(attribution.text);
      }
    }
    let count = 0;
    let totalCharacters = 0;
    for (const values of Object.values(corpusDialogues)) {
      count += values.length;
      totalCharacters += values.reduce((sum, text) => sum + text.length, 0);
    }
    if (count > MAX_DIALOGUES || totalCharacters > MAX_CORPUS_CHARACTERS) throw Object.assign(new Error(`Attributed corpus exceeds diagnostics profile limits (${MAX_DIALOGUES} utterances / ${MAX_CORPUS_CHARACTERS} characters)`), { code: "voice_corpus_too_large" });
    const voiceData = record(await invokeData(context, "diagnostics.voiceProfiles", { dialoguesByCharacter: corpusDialogues }), "diagnostics.voiceProfiles output");
    const fingerprints = arrayField(voiceData, "fingerprints");
    const matrix = arrayField(voiceData, "matrix");
    const stylometricProfiles = arrayField(voiceData, "stylometricProfiles") as unknown as StylometricProfile[];
    if (typeof voiceData.diagnosticsEngine !== "string" || typeof voiceData.diagnosticsEngineVersion !== "string") throw new TypeError("Diagnostics voice profile identity is missing");
    let targetResult: SpeakerPipelineResult | undefined;
    if (target) {
      const targetPipeline = await enrichPipeline(target, entities, tokenizer, context, moduleContext, { stylometricProfiles });
      targetResult = await requestSpeakerWorker<SpeakerPipelineResult>(worker, context, "attribute", { kind: "attribute", pipeline: targetPipeline });
    }
    return {
      fingerprints,
      matrix,
      stylometricProfiles,
      diagnosticsEngine: voiceData.diagnosticsEngine,
      diagnosticsEngineVersion: voiceData.diagnosticsEngineVersion,
      ...(targetResult ? { targetResult } : {}),
    };
  }));
}

async function speakerVoiceProfiles(_input: RecordValue, context: ModuleActionContext, moduleContext: ModuleContext): Promise<unknown> {
  const identity = await cacheIdentityFor(context);
  const { entities, scenes } = await loadCorpusScenes(context);
  const profiles = await analyzeVoiceProfiles(entities, scenes, context, moduleContext);
  return {
    ...generatedResultIdentity(identity),
    fingerprints: profiles.fingerprints,
    matrix: profiles.matrix,
    stylometricProfiles: profiles.stylometricProfiles,
    tokenizerModel: NLP_MODEL_ID,
    tokenizerModelVersion: NLP_MODEL_VERSION,
    diagnosticsEngine: profiles.diagnosticsEngine,
    diagnosticsEngineVersion: profiles.diagnosticsEngineVersion,
  };
}

async function speakerVoiceCheck(input: { sceneId: string; text?: string }, context: ModuleActionContext, moduleContext: ModuleContext): Promise<unknown> {
  const identity = await cacheIdentityFor(context);
  const { entities, scenes } = await loadCorpusScenes(context);
  let target = scenes.find((scene) => scene.scene.id === input.sceneId);
  if (!target) throw Object.assign(new Error(`Scene not found: ${input.sceneId}`), { code: "not_found" });
  if (input.text !== undefined) target = (await loadScene(context, input.sceneId, input.text)).prepared;
  const profiles = await analyzeVoiceProfiles(entities, scenes, context, moduleContext, target);
  const targetResult = profiles.targetResult;
  if (!targetResult) throw new TypeError("Speaker voice analysis did not return target-scene attributions");

  const speakerDefinitions = Object.fromEntries(entities.filter((entity) => entity.type === "character").map((entity) => [entity.id, entity.raw]));
  const attributionInput = targetResult.attributions.map(({ speakerEntityId, confidence, text, sentenceIndex }) => ({ speakerEntityId, confidence, text, sentenceIndex }));
  const [declaredResult, learnedResult, stylometricResult] = await Promise.all([
    invokeData(context, "diagnostics.voiceConsistency", { attributions: attributionInput, speakerDefinitions, sceneMetadata: target.scene.raw }),
    invokeData(context, "diagnostics.voiceDeviations", { attributions: attributionInput, fingerprints: profiles.fingerprints }),
    invokeData(context, "diagnostics.stylometricDeviations", { attributions: attributionInput, profiles: profiles.stylometricProfiles }),
  ]);
  const declaredWarnings = arrayField(declaredResult, "warnings");
  const learnedWarnings = arrayField(learnedResult, "warnings");
  const stylometricWarnings = arrayField(stylometricResult, "warnings");
  const merged = [
    ...declaredWarnings.map((warning) => displayVoiceWarning(warning, "registered")),
    ...learnedWarnings.map((warning) => displayVoiceWarning(warning, "learned")),
    ...stylometricWarnings.map((warning) => displayStylometricWarning(warning)),
  ].sort((a, b) => Number(a.sentenceIndex) - Number(b.sentenceIndex));
  return {
    ...generatedResultIdentity(identity),
    sceneId: input.sceneId,
    attributions: targetResult.attributions,
    estimatedN: targetResult.estimatedN,
    fromManual: targetResult.fromManual,
    evidence: targetResult.evidence,
    clusterTrails: targetResult.clusterTrails,
    warnings: declaredWarnings,
    styleDeviations: learnedWarnings,
    stylometricDeviations: stylometricWarnings,
    issues: merged,
    fingerprints: profiles.fingerprints,
    matrix: profiles.matrix,
    stylometricProfiles: profiles.stylometricProfiles,
    speakerEngine: SPEAKER_ENGINE_ID,
    speakerEngineVersion: SPEAKER_ENGINE_VERSION,
    tokenizerModel: NLP_MODEL_ID,
    tokenizerModelVersion: NLP_MODEL_VERSION,
    diagnosticsEngine: profiles.diagnosticsEngine,
    diagnosticsEngineVersion: profiles.diagnosticsEngineVersion,
  };
}

function arrayField(value: unknown, field: string): RecordValue[] {
  const root = record(value, "diagnostics output");
  const result = root[field];
  if (!Array.isArray(result)) throw new TypeError(`Diagnostics output ${field} must be an array`);
  return result.map((item) => record(item, `${field} item`));
}

const VOICE_ISSUES: Record<string, string> = {
  "unexpected-first-person": "想定外の一人称",
  "unexpected-ending": "想定外の語尾",
  "unusual-first-person": "学習一人称から逸脱",
  "unusual-ending": "学習語尾から逸脱",
  "length-zscore": "文長の統計逸脱",
  "polite-zscore": "丁寧さの統計逸脱",
};

function displayVoiceWarning(value: RecordValue, source: "registered" | "learned"): RecordValue {
  return {
    sentenceIndex: value.sentenceIndex,
    text: value.text,
    speakerEntityId: value.speakerEntityId,
    issueLabel: VOICE_ISSUES[String(value.issue)] ?? String(value.issue),
    expected: Array.isArray(value.expected) ? value.expected : [],
    found: typeof value.found === "string" ? value.found : "",
    source,
  };
}

function displayStylometricWarning(value: RecordValue): RecordValue {
  const distance = typeof value.distance === "number" ? value.distance : 0;
  const threshold = typeof value.threshold === "number" ? value.threshold : 0;
  return {
    sentenceIndex: value.sentenceIndex,
    text: value.text,
    speakerEntityId: value.speakerEntityId,
    issueLabel: `統計的逸脱 (距離 ${distance.toFixed(2)} / 閾値 ${threshold.toFixed(2)})`,
    expected: [],
    found: "",
    source: "stylometric",
  };
}

function makeActions(moduleContext: ModuleContext): ModuleAction[] {
  return [
    action("speaker.scenes.list", "read", schema(objectSchema), async (_input, context) => {
      const entities = await loadEntities(context);
      return { scenes: entities.filter((entity) => entity.type === "scene").map(({ id, name, raw, filePath }) => ({ id, name: name ?? id, filePath, volume: raw.volume, chapter: raw.chapter })) };
    }),
    action("speaker.dialogue.list", "compute", schema(parseDialogueInput), async (input, context) => speakerDialogueList(input as ReturnType<typeof parseDialogueInput>, context, moduleContext)),
    action("speaker.voice.profiles", "compute", schema(objectSchema), async (input, context) => speakerVoiceProfiles(input, context, moduleContext)),
    action("speaker.attribute", "compute", schema(parseSceneTextInput), async (input, context) => {
      const run = await runPipelineAction(input as ReturnType<typeof parseSceneTextInput>, context, moduleContext);
      return {
        ...generatedResultIdentity(await cacheIdentityFor(context)),
        ...run.result,
        candidates: run.prepared.candidates.map(({ id, name }) => ({ id, name: name ?? id })),
        model: SPEAKER_ENGINE_ID,
        modelVersion: SPEAKER_ENGINE_VERSION,
        tokenizerModel: NLP_MODEL_ID,
        tokenizerModelVersion: NLP_MODEL_VERSION,
      };
    }),
    action("speaker.voice.check", "compute", schema(parseSceneTextInput), async (input, context) => speakerVoiceCheck(input as ReturnType<typeof parseSceneTextInput>, context, moduleContext)),
    action("speaker.review.queue", "compute", schema(objectSchema), async (_input, context) => {
      const identity = await cacheIdentityFor(context);
      const { entities, scenes } = await loadCorpusScenes(context);
      const rows: RecordValue[] = [];
      const speakerNames = new Map(entities.filter((entity) => entity.type === "character").map((entity) => [entity.id, entity.name ?? entity.id]));
      await withTokenizer(moduleContext, context.signal, async (tokenizer) => withSpeakerWorker(moduleContext, async (worker) => {
        for (const prepared of scenes) {
          if (context.signal.aborted) throw context.signal.reason ?? Object.assign(new Error("Speaker action cancelled"), { code: "job_cancelled" });
          const pipeline = await enrichPipeline(prepared, entities, tokenizer, context, moduleContext);
          const result = await requestSpeakerWorker<SpeakerPipelineResult>(worker, context, "attribute", { kind: "attribute", pipeline });
          const speakerRows = unresolvedRows(result.attributions);
          const candidates = prepared.candidates.map((candidate) => ({ id: candidate.id, name: candidate.name ?? candidate.id }));
          for (const row of speakerRows) rows.push({
            sceneId: prepared.scene.id,
            sceneName: prepared.scene.name ?? prepared.scene.id,
            attribution: row.attribution,
            speakerName: row.attribution.speakerEntityId ? speakerNames.get(row.attribution.speakerEntityId) ?? row.attribution.speakerEntityId : null,
            candidates,
            unresolvedInGroup: row.unresolvedInGroup,
            otherResolvableCount: Math.max(0, row.unresolvedInGroup - 1),
          });
        }
      }));
      if (rows.length > 10_000) throw Object.assign(new Error("Speaker review queue exceeds 10000 rows"), { code: "review_queue_too_large" });
      return { ...generatedResultIdentity(identity), rows };
    }),
    action("speaker.override", "propose", schema(parseOverrideInput), async (input, context) => speakerOverrideAction(input as ReturnType<typeof parseOverrideInput>, context, moduleContext)),
    action("speaker.count.update", "propose", schema((value) => {
      const input = record(value);
      const scene = parseIdInput(input);
      if (!(input.speakerCount === null || (typeof input.speakerCount === "number" && Number.isSafeInteger(input.speakerCount) && input.speakerCount > 0 && input.speakerCount <= 1000))) throw new TypeError("speakerCount must be a positive integer or null");
      return { ...scene, speakerCount: input.speakerCount as number | null };
    }), async (input, context) => {
      const result = await context.invoke("story.scene.metadata.update", { sceneId: input.sceneId, patch: { speakerCount: input.speakerCount } }, context.signal);
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
      return { proposed: Boolean(result.proposals?.length) };
    }),
    action("speaker.evaluation.latest", "read", schema(objectSchema), async (_input, context) => readEvaluationCache(moduleContext.cacheDirectory, context.reader.snapshot, await cacheIdentityFor(context))),
    action("speaker.ruleGates", "read", schema(objectSchema), async (_input, context) => readGateCache(moduleContext.cacheDirectory, context.reader.snapshot, await cacheIdentityFor(context))),
    action("speaker.evaluation.run", "compute", schema(parseEvaluationInput), async (input, context) => runEvaluation(input as ReturnType<typeof parseEvaluationInput>, context, moduleContext), { type: "speaker-eval" }),
    action("speaker.retraining.run", "propose", schema(parseRetrainInput), async (input, context) => speakerRetrainAction(input as ReturnType<typeof parseRetrainInput>, context, moduleContext), { type: "speaker-retrain" }),
  ];
}

export async function createModule(_moduleContext: ModuleContext): Promise<ModuleDefinition> {
  return {
    manifest,
    actions: makeActions(_moduleContext),
    ui: [
      { id: "speaker.attribution", module: "speaker", slot: "dock", title: "話者帰属", action: "speaker.attribute" },
      { id: "speaker.review", module: "speaker", slot: "review", title: "話者確認キュー", action: "speaker.review.queue" },
      { id: "speaker.dialogue", module: "speaker", slot: "inspection", title: "キャラクター別セリフ", action: "speaker.dialogue.list" },
      { id: "speaker.voice.profiles", module: "speaker", slot: "inspection", title: "キャラクター声紋", action: "speaker.voice.profiles" },
      { id: "speaker.evaluation", module: "speaker", slot: "settings", title: "話者評価・モデル", action: "speaker.evaluation.run" },
    ],
    async dispose() {},
  };
}

export { browserModule } from "./browser.js";
