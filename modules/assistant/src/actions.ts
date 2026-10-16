import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { jsonrepair } from "jsonrepair";
import YAML from "yaml";
import { z } from "zod";
import {
  assertProjectPath,
  MODEL_USAGE_CAPABILITY,
  type ActionResult,
  type ChangeOperation,
  type FileRevision,
  type HttpContribution,
  type MachineError,
  type ModelUsageEvent,
  type ModelUsageStore,
  type ModuleAction,
  type ModuleActionContext,
  type ModuleContext,
  type SnapshotId,
  type ValueSchema,
} from "@scriptorium/contracts";
import { readStorySnapshot, type StoryEntity } from "@scriptorium/module-story";
import { splitIntoSentences } from "@scriptorium/module-nlp";
import {
  resolveAssistantModel,
  streamAssistantModel,
  type AssistantModelIdentity,
  type StreamAssistantModelResult,
} from "./provider.js";
import {
  applyAssistantSettingsPatch,
  ASSISTANT_FEATURE_IDS,
  ASSISTANT_SETTINGS_PATH,
  readAssistantSettings,
  serializeAssistantSettings,
  type AssistantModelSettings,
} from "./model-settings.js";
import { composePrompt, CUSTOM_PROMPT_VERSIONS, loadPromptTemplate, renderPromptTemplate } from "./prompts.js";

const ASSISTANT_MODULE_VERSION = "0.1.0";
const USAGE_PATH = "meta/scriptorium/modules/assistant/usage.jsonl";
const EXTERNAL_FEATURES: Readonly<Record<string, string>> = {
  rewrite: "rewrite",
  "scene-summary": "scene-summary",
  "chapter-summary": "chapter-summary",
  "setting-qa": "setting-qa",
  "continuation-options": "continuation-options",
  "aspect-review": "aspect-review",
  "dialogue-sketch": "dialogue-sketch",
  "dialogue-sketch-turn": "dialogue-sketch",
  "first-read-reaction": "first-read-reaction",
  "zukan-proposal": "zukan-proposal",
  "synonym-suggest": "rewrite",
  "contradiction-check": "contradiction-check",
  "state-event-draft": "state-event-draft",
  "speaker-attribution-llm": "speaker-attribution-llm",
};
const MAX_QUEUED_CALLS = 64;
const DEFAULT_DEADLINE_MS = 15 * 60 * 1000;
const outputSchema: ValueSchema = { parse(value) { return record(value, "action output"); } };

type RecordValue = Record<string, unknown>;
type LoadedStorySnapshot = Awaited<ReturnType<typeof readStorySnapshot>>;
interface StoryFile { path: string; content: string; revision: string }
interface SourceCitation { path: string; revision: string; quote: string; sceneId?: string; label?: string }
interface GenerationProvenance {
  snapshot: SnapshotId;
  provider: string;
  model: string;
  modelVersion: string;
  moduleVersion: string;
  promptVersion: string;
  generatedAt: string;
  sourceRevisions: FileRevision[];
}
interface GenerationResult extends StreamAssistantModelResult {
  provenance: GenerationProvenance;
  modelIdentity: AssistantModelIdentity;
}
interface QueueTask<T> {
  id: string;
  feature: string;
  key: string;
  perModelLimit: number;
  modelLimit: number;
  useCuBudget: boolean;
  cuWeight: number;
  cuBudget: number;
  signal: AbortSignal;
  work: () => Promise<T>;
  onStarted?: (queueWaitMs: number) => void;
  resolve(value: T): void;
  reject(error: unknown): void;
  abortListener?: () => void;
  startedAt?: string;
  queuedAt: number;
}
function record(value: unknown, label = "input"): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as RecordValue;
}
function parseEmpty(value: unknown): RecordValue { return record(value); }
function parseString(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new TypeError(`${label} must be a non-empty string of at most ${max} characters`);
  return value;
}
function parseIdInput(value: unknown, label = "sceneId"): RecordValue {
  const input = record(value);
  return { ...input, [label]: parseString(input[label], label, 256) };
}
function optionalString(input: RecordValue, key: string, max: number): string | undefined {
  if (input[key] === undefined) return undefined;
  return parseString(input[key], key, max);
}
function parseRewriteInput(value: unknown): { sceneId: string; selectedText: string; instruction?: string } {
  const input = record(value);
  return {
    sceneId: parseString(input.sceneId, "sceneId", 256),
    selectedText: parseString(input.selectedText, "selectedText", 20_000),
    ...(optionalString(input, "instruction", 4_000) ? { instruction: optionalString(input, "instruction", 4_000) } : {}),
  };
}
function parseQaInput(value: unknown): { question: string; sceneId?: string } {
  const input = record(value);
  return { question: parseString(input.question, "question", 8_000), ...(optionalString(input, "sceneId", 256) ? { sceneId: optionalString(input, "sceneId", 256) } : {}) };
}
function parseAspectInput(value: unknown): { chapterId: string; aspects: string[] } {
  const input = record(value);
  if (!Array.isArray(input.aspects) || input.aspects.length < 1 || input.aspects.length > 3 || input.aspects.some((item) => !["tempo", "pov-shift", "over-explain"].includes(String(item)))) throw new TypeError("aspects must contain one to three supported aspect IDs");
  return { chapterId: parseString(input.chapterId, "chapterId", 256), aspects: [...new Set(input.aspects as string[])] };
}
function parseDialogueTurnInput(value: unknown): { sceneId: string; topic: string; participants: string[]; precedingLines: string[] } {
  const input = record(value);
  if (!Array.isArray(input.participants) || input.participants.length < 2 || input.participants.length > 8 || input.participants.some((id) => typeof id !== "string" || !id.trim() || id.length > 256)) throw new TypeError("participants must contain two to eight entity IDs");
  if (input.precedingLines !== undefined && (!Array.isArray(input.precedingLines) || input.precedingLines.length > 40 || input.precedingLines.some((line) => typeof line !== "string" || line.length > 2_000))) throw new TypeError("precedingLines must be a bounded string array");
  return { sceneId: parseString(input.sceneId, "sceneId", 256), topic: parseString(input.topic, "topic", 2_000), participants: [...new Set(input.participants as string[])], precedingLines: (input.precedingLines ?? []) as string[] };
}
function parseSynonymInput(value: unknown): { terms: string[]; context?: string } {
  const input = record(value);
  if (!Array.isArray(input.terms) || input.terms.length < 1 || input.terms.length > 20 || input.terms.some((term) => typeof term !== "string" || !term.trim() || term.length > 256)) throw new TypeError("terms must contain one to twenty non-empty terms");
  return { terms: [...new Set(input.terms as string[])], ...(optionalString(input, "context", 8_000) ? { context: optionalString(input, "context", 8_000) } : {}) };
}
function parseUsageInput(value: unknown): { month?: string; limit: number; cursor?: string } {
  const input = record(value);
  if (input.month !== undefined && (typeof input.month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month))) throw new TypeError("month must use YYYY-MM format");
  const limit = input.limit === undefined ? 50 : input.limit;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 200) throw new TypeError("limit must be between 1 and 200");
  if (input.cursor !== undefined && (typeof input.cursor !== "string" || input.cursor.length > 512)) throw new TypeError("cursor is invalid");
  return { ...(typeof input.month === "string" ? { month: input.month } : {}), limit: limit as number, ...(typeof input.cursor === "string" ? { cursor: input.cursor } : {}) };
}
function objectArray(value: unknown, label: string): RecordValue[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value.map((item, index) => record(item, `${label}[${index}]`));
}
function codeError(code: string, message: string, retryable = false): Error {
  return Object.assign(new Error(message), { code, retryable });
}
function failure(context: ModuleActionContext, error: unknown): ActionResult {
  const cause = error instanceof Error ? error : new Error(String(error));
  const explicitCode = typeof (error as { code?: unknown } | null)?.code === "string" ? String((error as { code: string }).code) : undefined;
  const code = explicitCode ?? (cause instanceof TypeError ? "invalid_input" : "assistant_action_failed");
  const safeMessage = code === "assistant_provider_error" || code === "assistant_usage_unavailable" || code === "assistant_usage_record_failed"
    ? cause.message.slice(0, 512)
    : cause.message.slice(0, 512);
  return { ok: false, snapshot: context.reader.snapshot, error: { code, message: safeMessage, retryable: (error as { retryable?: unknown })?.retryable === true } };
}
function action(
  id: string,
  effect: ModuleAction["effect"],
  parse: (value: unknown) => unknown,
  handler: (input: RecordValue, context: ModuleActionContext) => Promise<unknown>,
): ModuleAction {
  return {
    id, effect, inputSchema: { parse }, outputSchema,
    async invoke(value, context) {
      try {
        if (context.signal.aborted) throw context.signal.reason ?? codeError("action_cancelled", "Assistant action was cancelled");
        const result = await handler(record(parse(value)), context);
        if (context.signal.aborted) throw context.signal.reason ?? codeError("action_cancelled", "Assistant action was cancelled");
        return { ok: true, snapshot: context.reader.snapshot, data: record(result, "action output") };
      } catch (error) { return failure(context, error); }
    },
  };
}

class ModelExecutionQueue {
  private readonly pending: QueueTask<unknown>[] = [];
  private readonly active = new Map<string, number>();
  private readonly activeTasks = new Map<string, { id: string; feature: string; model: string; startedAt: string }>();
  private activeCu = 0;

  status(): { active: Array<{ id: string; feature: string; model: string; startedAt: string }>; queued: Array<{ id: string; feature: string; model: string }>; activeCu: number } {
    return { active: [...this.activeTasks.values()], queued: this.pending.map(({ id, feature, key }) => ({ id, feature, model: key })), activeCu: this.activeCu };
  }

  run<T>(input: Omit<QueueTask<T>, "resolve" | "reject" | "abortListener" | "startedAt" | "queuedAt">): Promise<T> {
    if (input.signal.aborted) return Promise.reject(input.signal.reason ?? codeError("action_cancelled", "Assistant request was cancelled"));
    if (this.pending.length >= MAX_QUEUED_CALLS) return Promise.reject(codeError("assistant_queue_full", "Assistant model queue is full", true));
    if (input.useCuBudget && input.cuWeight > input.cuBudget) return Promise.reject(codeError("assistant_model_over_budget", `Configured model weight (${input.cuWeight}) exceeds the total CU budget (${input.cuBudget})`));
    return new Promise<T>((resolve, reject) => {
      const task: QueueTask<T> = { ...input, resolve, reject, queuedAt: Date.now() };
      task.abortListener = () => {
        const index = this.pending.indexOf(task as QueueTask<unknown>);
        if (index < 0) return;
        this.pending.splice(index, 1);
        reject(input.signal.reason ?? codeError("action_cancelled", "Assistant request was cancelled"));
        this.pump();
      };
      input.signal.addEventListener("abort", task.abortListener, { once: true });
      this.pending.push(task as QueueTask<unknown>);
      this.pump();
    });
  }

  private pump(): void {
    for (let index = 0; index < this.pending.length;) {
      const task = this.pending[index]!;
      if (task.signal.aborted) {
        this.pending.splice(index, 1);
        task.signal.removeEventListener("abort", task.abortListener!);
        task.reject(task.signal.reason ?? codeError("action_cancelled", "Assistant request was cancelled"));
        continue;
      }
      const runningForModel = this.active.get(task.key) ?? 0;
      const modelIsActive = this.active.has(task.key);
      const hasCapacity = task.useCuBudget
        ? this.activeCu + task.cuWeight <= task.cuBudget
        : modelIsActive || this.active.size < task.modelLimit;
      const canStart = runningForModel < task.perModelLimit && hasCapacity;
      if (!canStart) { index += 1; continue; }
      this.pending.splice(index, 1);
      task.signal.removeEventListener("abort", task.abortListener!);
      const startedAt = new Date().toISOString();
      task.startedAt = startedAt;
      task.onStarted?.(Math.max(0, Date.now() - task.queuedAt));
      this.active.set(task.key, runningForModel + 1);
      if (task.useCuBudget) this.activeCu += task.cuWeight;
      this.activeTasks.set(task.id, { id: task.id, feature: task.feature, model: task.key, startedAt });
      void Promise.resolve().then(task.work).then(task.resolve, task.reject).finally(() => {
        const count = this.active.get(task.key) ?? 1;
        if (count <= 1) this.active.delete(task.key);
        else this.active.set(task.key, count - 1);
        if (task.useCuBudget) this.activeCu = Math.max(0, this.activeCu - task.cuWeight);
        this.activeTasks.delete(task.id);
        this.pump();
      });
    }
  }
}

const modelQueue = new ModelExecutionQueue();

function clampOutputTokens(value: number): number { return Math.max(48, Math.min(256, Math.floor(value))); }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function fnv1aHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 0x01000193); }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function snapshotId(context: ModuleActionContext): SnapshotId { return context.reader.snapshot; }
function revisionList(files: readonly StoryFile[], extra: FileRevision[] = []): FileRevision[] {
  const byPath = new Map<string, FileRevision>();
  for (const file of files) byPath.set(file.path, { path: file.path, revision: file.revision });
  for (const item of extra) byPath.set(item.path, item);
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function requireExternalConsent(featureId: string, context: ModuleActionContext): Promise<void> {
  const externalId = EXTERNAL_FEATURES[featureId];
  if (!externalId) throw codeError("assistant_privacy_denied", `No external-consent mapping exists for ${featureId}`);
  const result = await context.invoke("nlp.features", {});
  if (!result.ok) throw codeError("assistant_privacy_unavailable", "External-consent settings could not be read");
  const data = record(result.data, "NLP feature settings");
  const features = objectArray(data.features, "NLP features");
  const selected = features.find((feature) => feature.id === externalId);
  if (!selected || selected.locality !== "external" || selected.enabled !== true) {
    throw codeError("assistant_privacy_denied", `External transmission for ${externalId} is not enabled`);
  }
}

async function settingsForFeature(context: ModuleActionContext, featureId: string): Promise<{
  settings: AssistantModelSettings; revision: string | null; model: AssistantModelIdentity;
}> {
  const { settings, revision } = await readAssistantSettings(context.reader);
  let model: AssistantModelIdentity | undefined;
  try { model = resolveAssistantModel(featureId, settings); }
  catch { throw codeError("assistant_provider_configuration_invalid", "The configured assistant provider is invalid"); }
  if (!model) throw codeError("assistant_provider_unavailable", "No assistant model provider is configured");
  return { settings, revision, model };
}

async function generate(
  moduleContext: ModuleContext,
  context: ModuleActionContext,
  input: { feature: string; prompt: string; promptVersion: string; sourceRevisions?: FileRevision[]; outputTokens?: number; onText?: (delta: string) => void | Promise<void> },
): Promise<GenerationResult> {
  await requireExternalConsent(input.feature, context);
  const { settings, revision, model } = await settingsForFeature(context, input.feature);
  const abortSignal = AbortSignal.any([context.signal, AbortSignal.timeout(DEFAULT_DEADLINE_MS)]);
  let lease: { value: ModelUsageStore; release(): Promise<void> };
  try { lease = await moduleContext.acquireCapability<ModelUsageStore>(MODEL_USAGE_CAPABILITY); }
  catch { throw codeError("assistant_usage_unavailable", "Durable model-usage history is unavailable; generation was not started"); }
  const callStartedEpoch = Date.now();
  let queueWaitMs = 0;
  let executionStartedEpoch = callStartedEpoch;
  let callResult: StreamAssistantModelResult | undefined;
  let callFailure: unknown;
  try {
    callResult = await modelQueue.run({
      id: randomUUID(), feature: input.feature, key: `${model.provider}:${model.model}`,
      perModelLimit: model.provider === "openai-compatible" ? 8 : Math.min(8, Math.max(1, settings.presets.find((preset) => preset.id === settings.featurePresetIds[input.feature])?.maxConcurrency ?? 1)),
      modelLimit: model.provider === "openai-compatible" ? 8 : Math.min(8, Math.max(1, settings.maxConcurrentModels ?? 1)),
      useCuBudget: model.provider === "openai-compatible",
      cuWeight: Math.max(1, Math.floor(settings.modelCuWeights?.[model.model] ?? ({
        "deepseek-ai/DeepSeek-V4-Pro": 2,
        "deepseek-ai/DeepSeek-V4-Flash": 1,
        "Qwen/Qwen3-4B-Instruct-2507": 1,
      } as Record<string, number>)[model.model] ?? 1)),
      cuBudget: settings.totalCuBudget ?? 4,
      signal: abortSignal,
      onStarted(waitMs) {
        queueWaitMs = waitMs;
        executionStartedEpoch = Date.now();
      },
      work: () => streamAssistantModel({
        featureId: input.feature,
        preferences: settings,
        model,
        prompt: input.prompt,
        maxOutputTokens: clampOutputTokens(input.outputTokens ?? 128),
        signal: abortSignal,
        onText: input.onText ?? (() => {}),
      }),
    });
  } catch (error) { callFailure = error; }
  let recordFailure: unknown;
  try {
    const completedEpoch = Date.now();
    if (abortSignal.aborted && executionStartedEpoch === callStartedEpoch) {
      queueWaitMs = Math.max(0, completedEpoch - callStartedEpoch);
      executionStartedEpoch = completedEpoch;
    }
    const completedAt = new Date(completedEpoch).toISOString();
    const aborted = abortSignal.aborted;
    const candidateCode = (callFailure as { code?: unknown } | undefined)?.code;
    const event: ModelUsageEvent = {
      id: randomUUID(), repository: context.reader.snapshot.repository, feature: input.feature,
      provider: model.provider, model: model.model, startedAt: new Date(callStartedEpoch).toISOString(), completedAt,
      state: callFailure ? (aborted ? "aborted" : "failed") : "completed",
      cacheHit: false,
      promptVersion: input.promptVersion,
      durationMs: Math.max(0, completedEpoch - Math.max(callStartedEpoch, executionStartedEpoch)),
      queueWaitMs,
      ...(typeof callResult?.inputTokens === "number" ? { inputTokens: callResult.inputTokens } : {}),
      ...(typeof callResult?.outputTokens === "number" ? { outputTokens: callResult.outputTokens } : {}),
      ...(callFailure ? { errorCode: typeof candidateCode === "string" ? candidateCode.slice(0, 96) : aborted ? "request_aborted" : "provider_error" } : {}),
    };
    await lease.value.append(event);
  } catch (error) { recordFailure = error; }
  finally { await lease.release().catch(() => {}); }
  if (recordFailure) throw codeError("assistant_usage_record_failed", "The provider call finished but durable usage history could not be recorded");
  if (callFailure) {
    if (abortSignal.aborted) throw codeError("action_cancelled", "Assistant model request was cancelled or exceeded its deadline");
    throw codeError("assistant_provider_error", "Assistant model request failed");
  }
  if (!callResult) throw codeError("assistant_provider_error", "Assistant model returned no result");
  return {
    ...callResult,
    modelIdentity: model,
    provenance: {
      snapshot: context.reader.snapshot,
      provider: model.provider,
      model: model.model,
      modelVersion: model.model,
      moduleVersion: ASSISTANT_MODULE_VERSION,
      promptVersion: input.promptVersion,
      generatedAt: new Date().toISOString(),
      sourceRevisions: revisionList([], [...(input.sourceRevisions ?? []), { path: ASSISTANT_SETTINGS_PATH, revision }]),
    },
  };
}

function parseStructured<T>(text: string, schema: z.ZodType<T>): T {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  const candidate = first >= 0 && last > first ? cleaned.slice(first, last + 1) : cleaned;
  let parsed: unknown;
  try { parsed = JSON.parse(candidate) as unknown; }
  catch { parsed = JSON.parse(jsonrepair(candidate)) as unknown; }
  return schema.parse(parsed);
}

function makeOperation(
  context: ModuleActionContext,
  effect: ChangeOperation["effect"],
  message: string,
  reads: FileRevision[],
  writes: Array<{ path: string; revision: string | null; content: string }>,
): ChangeOperation {
  for (const read of reads) assertProjectPath(read.path);
  for (const write of writes) assertProjectPath(write.path);
  const uniqueReads = new Map(reads.map((item) => [item.path, item]));
  return {
    id: randomUUID(), generation: 0, repository: context.reader.snapshot.repository,
    baseRemoteCommit: context.reader.snapshot.remoteCommit, effect,
    reads: [...uniqueReads.values()].sort((a, b) => a.path.localeCompare(b.path)),
    writes, message,
  };
}

function evidence(
  context: ModuleActionContext,
  kind: string,
  paths: FileRevision[],
  details: RecordValue,
) {
  return [{ id: randomUUID(), snapshot: context.reader.snapshot, module: "assistant" as const, kind, paths, details }];
}

async function invokeData(context: ModuleActionContext, actionId: string, input: unknown): Promise<RecordValue> {
  const result = await context.invoke(actionId, input);
  if (!result.ok) throw codeError(result.error.code, result.error.message);
  return record(result.data, `${actionId} result`);
}

function entity(snapshot: LoadedStorySnapshot, id: string): StoryEntity {
  const found = snapshot.entities.get(id);
  if (!found) throw codeError("assistant_source_missing", `Story entity ${id} was not found`);
  if (snapshot.duplicateIds.has(id)) throw codeError("assistant_source_ambiguous", `Story entity ${id} has duplicate source files`);
  return found;
}

function sourceFile(snapshot: LoadedStorySnapshot, filePath: string): StoryFile {
  const file = snapshot.files.get(filePath);
  if (!file) throw codeError("assistant_source_missing", `Source file ${filePath} was not found in this snapshot`);
  return file;
}

function sceneContext(snapshot: LoadedStorySnapshot, sceneId: string): { scene: StoryEntity; manuscript: StoryFile; body: string; bodyOffset: number } {
  const scene = entity(snapshot, sceneId);
  if (scene.type !== "scene") throw new TypeError(`${sceneId} is not a scene`);
  const manuscriptPath = typeof scene.raw.manuscript === "string" ? scene.raw.manuscript : undefined;
  if (!manuscriptPath) throw codeError("assistant_source_missing", `Scene ${sceneId} has no manuscript reference`);
  assertProjectPath(manuscriptPath);
  const manuscript = sourceFile(snapshot, manuscriptPath);
  const frontMatter = /^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/.exec(manuscript.content);
  const bodyOffset = frontMatter?.[0].length ?? 0;
  return { scene, manuscript, body: manuscript.content.slice(bodyOffset).trim(), bodyOffset };
}

function chapterScenes(snapshot: LoadedStorySnapshot, chapterId: string): { chapter: StoryEntity; scenes: Array<ReturnType<typeof sceneContext>> } {
  const chapter = entity(snapshot, chapterId);
  if (chapter.type !== "chapter") throw new TypeError(`${chapterId} is not a chapter`);
  const prefix = chapter.filePath.replace(/\/chapter\.ya?ml$/i, "/scenes/");
  const scenes = [...snapshot.entities.values()].filter((candidate) => candidate.type === "scene" && candidate.filePath.startsWith(prefix))
    .sort((a, b) => Number(a.raw.order ?? 0) - Number(b.raw.order ?? 0) || a.id.localeCompare(b.id))
    .map((candidate) => sceneContext(snapshot, candidate.id));
  return { chapter, scenes };
}

function chapterDirectory(chapter: StoryEntity): string { return chapter.filePath.replace(/\/chapter\.ya?ml$/i, ""); }
function sceneSummaryPath(scene: StoryEntity): string {
  const directory = path.posix.dirname(scene.filePath);
  return `${path.posix.dirname(directory)}/scene-summaries/${scene.id}.yaml`;
}
function chapterSummaryPath(chapter: StoryEntity): string { return `${chapterDirectory(chapter)}/chapter-summary.yaml`; }
function readRevision(context: ModuleActionContext, path: string, revision: string | null): FileRevision { return { path, revision }; }
function sourceCitation(file: StoryFile, quote: string, sceneId?: string, label?: string): SourceCitation {
  return { path: file.path, revision: file.revision, quote, ...(sceneId ? { sceneId } : {}), ...(label ? { label } : {}) };
}

function monthBounds(month: string): { from: string; to: string } {
  const start = new Date(`${month}-01T00:00:00.000Z`);
  const next = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return { from: start.toISOString(), to: next.toISOString() };
}

function decodeUsageCursor(value: unknown): number {
  if (typeof value !== "string" || !value) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    const offset = record(parsed).offset;
    return Number.isSafeInteger(offset) && (offset as number) >= 0 ? offset as number : 0;
  } catch { return 0; }
}

function encodeUsageCursor(offset: number): string { return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url"); }

function legacyUsageRows(content: string, repository: ModelUsageEvent["repository"]): Array<ModelUsageEvent & RecordValue> {
  const rows: Array<ModelUsageEvent & RecordValue> = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const raw = record(JSON.parse(line) as unknown, "legacy usage row");
      const startedAt = typeof raw.ts === "string" && Number.isFinite(Date.parse(raw.ts)) ? raw.ts : undefined;
      const model = typeof raw.model === "string" ? raw.model : undefined;
      const feature = typeof raw.feature === "string" ? raw.feature : undefined;
      if (!startedAt || !model || !feature) continue;
      const duration = typeof raw.durationMs === "number" && Number.isFinite(raw.durationMs) ? Math.max(0, raw.durationMs) : 0;
      const id = typeof raw.id === "string" ? raw.id : `legacy-${sha256(line)}`;
      rows.push({
        id, repository, feature, provider: typeof raw.provider === "string" ? raw.provider : "legacy",
        model, startedAt, completedAt: new Date(Date.parse(startedAt) + duration).toISOString(),
        state: raw.aborted === true ? "aborted" : "completed",
        ...(Number.isSafeInteger(raw.inputTokens) && (raw.inputTokens as number) >= 0 ? { inputTokens: raw.inputTokens as number } : {}),
        ...(Number.isSafeInteger(raw.outputTokens) && (raw.outputTokens as number) >= 0 ? { outputTokens: raw.outputTokens as number } : {}),
        source: "preserved-project-jsonl",
        ...(typeof raw.promptVersion === "string" ? { promptVersion: raw.promptVersion } : {}),
        ...(typeof raw.cacheHit === "boolean" ? { cacheHit: raw.cacheHit } : {}),
        ...(typeof raw.durationMs === "number" && Number.isFinite(raw.durationMs) ? { durationMs: duration } : {}),
        ...(typeof raw.queueWaitMs === "number" && Number.isFinite(raw.queueWaitMs) && raw.queueWaitMs >= 0 ? { queueWaitMs: raw.queueWaitMs } : {}),
        ...(typeof raw.aborted === "boolean" ? { aborted: raw.aborted } : {}),
      });
    } catch { /* Invalid historical rows stay byte-for-byte in the authoritative file. */ }
  }
  return rows;
}

async function readUsageHistory(moduleContext: ModuleContext, context: ModuleActionContext, input: { month?: string; limit: number; cursor?: string }) {
  const repository = context.reader.snapshot.repository;
  const file = await context.reader.read(USAGE_PATH);
  const legacy = file ? legacyUsageRows(file.content, repository) : [];
  let hostEvents: Array<ModelUsageEvent & RecordValue> = [];
  let storeAvailable = false;
  let storeError: string | undefined;
  try {
    const lease = await moduleContext.acquireCapability<ModelUsageStore>(MODEL_USAGE_CAPABILITY);
    storeAvailable = true;
    try {
      const query = input.month ? monthBounds(input.month) : undefined;
      let cursor: string | undefined;
      for (let page = 0; page < 50; page += 1) {
        const result = await lease.value.list(repository, { ...(query ?? {}), limit: 200, ...(cursor ? { cursor } : {}) });
        hostEvents.push(...result.events.map((event) => parseUsageRow({ ...event, source: "host-owned-store" })));
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
        if (page === 49) storeError = "history_page_limit";
      }
    } finally { await lease.release(); }
  } catch { storeError = "host_usage_store_unavailable"; }
  const merged = new Map<string, ModelUsageEvent & RecordValue>();
  for (const event of [...legacy, ...hostEvents]) {
    if (input.month && event.startedAt.slice(0, 7) !== input.month) continue;
    const key = `${event.id}\0${event.provider}\0${event.feature}\0${event.startedAt}`;
    if (!merged.has(key)) merged.set(key, event);
  }
  const events = [...merged.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id));
  const aggregateByMonth: Record<string, { calls: number; inputTokens: number; outputTokens: number; aborted: number; cacheHits: number; cost: number; byFeature: Record<string, number>; bySource: Record<string, number> }> = {};
  for (const event of events) {
    const month = event.startedAt.slice(0, 7);
    const aggregate = aggregateByMonth[month] ??= { calls: 0, inputTokens: 0, outputTokens: 0, aborted: 0, cacheHits: 0, cost: 0, byFeature: {}, bySource: {} };
    aggregate.calls += 1;
    aggregate.inputTokens += event.inputTokens ?? 0;
    aggregate.outputTokens += event.outputTokens ?? 0;
    aggregate.aborted += event.state === "aborted" ? 1 : 0;
    aggregate.cacheHits += event.cacheHit === true ? 1 : 0;
    aggregate.cost += event.cost ?? 0;
    aggregate.byFeature[event.feature] = (aggregate.byFeature[event.feature] ?? 0) + 1;
    const source = typeof event.source === "string" ? event.source : "host-owned-store";
    aggregate.bySource[source] = (aggregate.bySource[source] ?? 0) + 1;
  }
  const offset = decodeUsageCursor(input.cursor);
  const page = events.slice(offset, offset + input.limit);
  const nextOffset = offset + page.length;
  return {
    events: page, nextCursor: nextOffset < events.length ? encodeUsageCursor(nextOffset) : undefined,
    aggregates: aggregateByMonth, hasHostHistory: storeAvailable, legacyRevision: file?.revision ?? null,
    ...(storeError ? { historyWarning: storeError } : {}), total: events.length,
  };
}

const rewriteSchema = z.object({
  suggestions: z.array(z.object({
    text: z.string().min(1).max(20_000),
    strategy: z.enum(["concise", "contextual", "voice"]),
    rationale: z.string().min(1).max(2_000),
  })).length(3),
});
const sceneSummarySchema = z.object({
  summaryLines: z.array(z.string().min(1)).length(3),
  characters: z.array(z.string()).max(100),
  stateChanges: z.array(z.string()).max(100),
});
const chapterSummarySchema = z.object({ summaryLines: z.array(z.string().min(1)).length(3) });
const continuationSchema = z.object({ options: z.array(z.object({ direction: z.string().min(1), rationale: z.string().min(1) })).length(3) });
const aspectSchema = z.object({ findings: z.array(z.object({ aspect: z.string().min(1), finding: z.string().min(1), quote: z.string().min(1), sceneId: z.string().min(1) })).max(100) });
const topicsSchema = z.object({ topics: z.array(z.object({ title: z.string().min(1), situation: z.string().min(1) })).min(3).max(5) });
const dialogueLinesSchema = z.object({ lines: z.array(z.object({ speakerEntityId: z.string().min(1), text: z.string().min(1) })).length(3) });
const synonymSchema = z.object({ candidates: z.array(z.string().min(1)).min(3).max(5) });
const contradictionSchema = z.object({ verdict: z.enum(["contradiction", "compatible", "insufficient"]), reason: z.string(), quotes: z.array(z.string()).max(2) });
const zukanSchema = z.object({
  blockPath: z.string().min(1), proposedText: z.string().min(1),
  evidence: z.array(z.object({ sceneId: z.string().min(1), quote: z.string().min(1) })).min(1).max(8),
});
const stateEventSchema = z.object({ events: z.array(z.object({
  kind: z.enum(["location", "acquaintance", "ownership", "knowledge"]),
  target: z.string().min(1), operation: z.string().min(1), before: z.record(z.unknown()).nullable(),
  after: z.record(z.unknown()).nullable(), object: z.string().nullable(), payload: z.record(z.unknown()).default({}), evidenceQuote: z.string().min(1),
})).max(20) });
const speakerSchema = z.object({ attributions: z.array(z.object({ sentenceIndex: z.number().int().positive(), speakerEntityId: z.string().nullable(), rationale: z.string().optional() })).max(500) });
const reactionSchema = z.object({ questions: z.array(z.string()), expectations: z.array(z.string()), confusions: z.array(z.string()) });

function promptJson(schemaDescription: string): string {
  return `\n\nJSONのみを返してください。スキーマ: ${schemaDescription}`;
}

function citationPaths(citations: readonly SourceCitation[]): FileRevision[] {
  return revisionList([], citations.map(({ path, revision }) => ({ path, revision })));
}

function makeCitation(file: StoryFile, quote: string, sceneId?: string, label?: string): SourceCitation {
  const normalized = quote.trim();
  const verified = normalized && file.content.includes(normalized);
  return sourceCitation(file, verified ? normalized.slice(0, 1_200) : file.content.slice(0, 1_200), sceneId, label);
}

async function runRewrite(
  moduleContext: ModuleContext,
  context: ModuleActionContext,
  input: { sceneId: string; selectedText: string; instruction?: string },
  onText?: (delta: string) => void | Promise<void>,
) {
  const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
  const source = sceneContext(story, input.sceneId);
  const rawBody = source.manuscript.content.slice(source.bodyOffset);
  const bodyStart = source.bodyOffset + rawBody.length - rawBody.trimStart().length;
  const bodyEnd = bodyStart + source.body.length;
  const startInBody = source.manuscript.content.indexOf(input.selectedText, bodyStart);
  const nextMatch = source.manuscript.content.indexOf(input.selectedText, startInBody + 1);
  if (startInBody < bodyStart || startInBody + input.selectedText.length > bodyEnd || (nextMatch >= 0 && nextMatch < bodyEnd)) {
    throw codeError("assistant_rewrite_selection_ambiguous", "Selected text must occur exactly once in the referenced scene");
  }
  const relatedIds = Array.isArray(source.scene.raw.appears) ? source.scene.raw.appears.filter((id): id is string => typeof id === "string") : [];
  const characters = relatedIds.slice(0, 16).flatMap((id) => {
    const candidate = story.entities.get(id);
    if (!candidate || candidate.type !== "character") return [];
    return [{ id: candidate.id, name: candidate.name ?? candidate.id, role: candidate.id === source.scene.raw.pov ? "pov" : "appears", voice: candidate.raw.voice ?? candidate.raw.voicePatterns ?? null, notes: candidate.raw.notes ?? null }];
  });
  const prompt = await composePrompt([
    "次の小説の一文について、意味を保った言い換えをちょうど3案生成してください。",
    "診断ではなく、ユーザーが明示的に依頼したリライトです。",
    `対象文: ${input.selectedText}`,
    `追加指示: ${input.instruction ?? "なし"}`,
    `シーン文脈: ${JSON.stringify({ pov: source.scene.raw.pov ?? null, intendedTone: source.scene.raw.intendedTone ?? null, characters }, null, 2)}`,
    "各案では POV、意図されたトーン、キャラクター口調を可能な範囲で維持してください。意味の無い文や新しい設定を加えないでください.",
    promptJson('{"suggestions":[{"text":"...","strategy":"concise|contextual|voice","rationale":"..."},{"text":"...","strategy":"concise|contextual|voice","rationale":"..."},{"text":"...","strategy":"concise|contextual|voice","rationale":"..."}]}'),
  ].join("\n"));
  const sourceRevisions = revisionList([...story.files.values()].filter((file) => file.path === source.scene.filePath || file.path === source.manuscript.path || relatedIds.some((id) => story.entities.get(id)?.filePath === file.path)));
  const generated = await generate(moduleContext, context, { feature: "rewrite", prompt, promptVersion: CUSTOM_PROMPT_VERSIONS.rewrite, sourceRevisions, outputTokens: 192, ...(onText ? { onText } : {}) });
  const parsed = parseStructured(generated.text, rewriteSchema);
  const chosen = parsed.suggestions[0]!.text.trim();
  if (chosen.length > 20_000) throw codeError("assistant_output_invalid", "The rewrite output exceeded its text limit");
  const updatedContent = `${source.manuscript.content.slice(0, startInBody)}${chosen}${source.manuscript.content.slice(startInBody + input.selectedText.length)}`;
  const selectedCitation = sourceCitation(source.manuscript, input.selectedText, source.scene.id, "selected passage");
  const citations = [selectedCitation];
  const reads = [...generated.provenance.sourceRevisions, { path: source.scene.filePath, revision: story.files.get(source.scene.filePath)!.revision }, { path: source.manuscript.path, revision: source.manuscript.revision }];
  const operation = makeOperation(context, "manuscript", `Propose assistant rewrite for ${source.scene.id}`, reads, [{ path: source.manuscript.path, revision: source.manuscript.revision, content: updatedContent }]);
  const proposal = await context.propose([operation], evidence(context, "assistant.rewrite", reads, { sceneId: source.scene.id, model: generated.provenance.model, promptVersion: generated.provenance.promptVersion }));
  return {
    text: chosen, suggestions: parsed.suggestions, sceneId: source.scene.id,
    model: generated.provenance.model, provider: generated.provenance.provider,
    promptVersion: generated.provenance.promptVersion, citations, provenance: generated.provenance, proposal,
  };
}

function readYamlObject(content: string): RecordValue | null {
  try { return record(YAML.parse(content)); } catch { return null; }
}

async function runSceneSummary(moduleContext: ModuleContext, context: ModuleActionContext, sceneId: string) {
  const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
  const source = sceneContext(story, sceneId);
  const outputPath = sceneSummaryPath(source.scene);
  const existing = await context.reader.read(outputPath);
  const current = existing ? readYamlObject(existing.content) : null;
  const sourceHash = fnv1aHash(source.body);
  const template = await loadPromptTemplate("sceneSummary");
  if (current && current.sceneId === sceneId && current.sourceHash === sourceHash && current.promptVersion === template.version && typeof current.model === "string") {
    return { summary: current, stale: false, cached: true, model: current.model, promptVersion: current.promptVersion, citations: [makeCitation(source.manuscript, source.body, sceneId, "scene manuscript")], provenance: { snapshot: context.reader.snapshot, provider: current.provider, model: current.model, modelVersion: current.model, moduleVersion: ASSISTANT_MODULE_VERSION, promptVersion: template.version, generatedAt: current.generatedAt, sourceRevisions: [{ path: source.manuscript.path, revision: source.manuscript.revision }, { path: source.scene.filePath, revision: story.files.get(source.scene.filePath)!.revision }] } };
  }
  const sceneFile = story.files.get(source.scene.filePath)!;
  const knownCharacters = Array.isArray(source.scene.raw.appears) ? source.scene.raw.appears.map((id) => story.entities.get(String(id))?.name ?? String(id)) : [];
  const prepared = await renderPromptTemplate("sceneSummary", { sceneId, knownCharacters: knownCharacters.join("、") || "なし", manuscriptBody: source.body });
  const prompt = `${await composePrompt(prepared.body)}${promptJson('{"summaryLines":["...","...","..."],"characters":["..."],"stateChanges":["..."]}')}`;
  const sourceRevisions = [{ path: source.scene.filePath, revision: sceneFile.revision }, { path: source.manuscript.path, revision: source.manuscript.revision }];
  const generated = await generate(moduleContext, context, { feature: "scene-summary", prompt, promptVersion: prepared.version, sourceRevisions, outputTokens: 160 });
  const summary = parseStructured(generated.text, sceneSummarySchema);
  const recordValue = {
    sceneId, ...summary, sourceHash, generatedAt: generated.provenance.generatedAt,
    provider: generated.provenance.provider, model: generated.provenance.model,
    modelVersion: generated.provenance.modelVersion, promptVersion: generated.provenance.promptVersion,
    snapshot: generated.provenance.snapshot,
  };
  const content = YAML.stringify(recordValue);
  const reads = [...sourceRevisions, readRevision(context, outputPath, existing?.revision ?? null), ...generated.provenance.sourceRevisions.filter((item) => item.path === ASSISTANT_SETTINGS_PATH)];
  const operation = makeOperation(context, "metadata", `Propose scene summary for ${sceneId}`, reads, [{ path: outputPath, revision: existing?.revision ?? null, content }]);
  const proposal = await context.propose([operation], evidence(context, "assistant.scene-summary", reads, { sceneId, model: generated.provenance.model, promptVersion: prepared.version }));
  const citations = [makeCitation(source.manuscript, source.body, sceneId, "scene manuscript")];
  return { summary: recordValue, stale: false, cached: false, model: generated.provenance.model, provider: generated.provenance.provider, promptVersion: prepared.version, citations, provenance: generated.provenance, proposal };
}

async function runChapterSummary(moduleContext: ModuleContext, context: ModuleActionContext, chapterId: string) {
  const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
  const { chapter, scenes } = chapterScenes(story, chapterId);
  if (!scenes.length) throw codeError("assistant_source_missing", `Chapter ${chapterId} has no manuscript scenes`);
  if (scenes.length > 30) throw codeError("assistant_scope_too_large", "Chapter summaries are limited to 30 scenes per request");
  const sceneRecords: Array<RecordValue> = [];
  const citations: SourceCitation[] = [];
  const reads: FileRevision[] = [];
  for (const source of scenes) {
    const outputPath = sceneSummaryPath(source.scene);
    const existing = await context.reader.read(outputPath);
    const parsed = existing ? readYamlObject(existing.content) : null;
    if (parsed && parsed.sceneId === source.scene.id && parsed.sourceHash === fnv1aHash(source.body) && Array.isArray(parsed.summaryLines) && typeof parsed.model === "string") {
      sceneRecords.push(parsed);
    } else {
      const result = await runSceneSummary(moduleContext, context, source.scene.id);
      const recordValue = record(result.summary);
      sceneRecords.push(recordValue);
      if (result.proposal) { /* the operation was proposed by the nested generation */ }
    }
    const sceneFile = story.files.get(source.scene.filePath)!;
    reads.push({ path: source.scene.filePath, revision: sceneFile.revision }, { path: source.manuscript.path, revision: source.manuscript.revision }, { path: outputPath, revision: existing?.revision ?? null });
    citations.push(makeCitation(source.manuscript, source.body, source.scene.id, source.scene.name ?? "scene manuscript"));
  }
  const chapterPath = chapterSummaryPath(chapter);
  const existingChapter = await context.reader.read(chapterPath);
  const childHash = fnv1aHash(sceneRecords.map((item) => String(item.sourceHash ?? "")).join("|"));
  const existingSummary = existingChapter ? readYamlObject(existingChapter.content) : null;
  if (existingSummary?.sourceHash === childHash && Array.isArray(existingSummary.summaryLines) && typeof existingSummary.model === "string") {
    return { summary: existingSummary, stale: false, cached: true, model: existingSummary.model, promptVersion: existingSummary.promptVersion, citations: citations.slice(0, 12), provenance: { snapshot: context.reader.snapshot, provider: existingSummary.provider, model: existingSummary.model, modelVersion: existingSummary.modelVersion ?? existingSummary.model, moduleVersion: ASSISTANT_MODULE_VERSION, promptVersion: existingSummary.promptVersion, generatedAt: existingSummary.generatedAt, sourceRevisions: revisionList([], [...reads, { path: chapterPath, revision: existingChapter!.revision }]) } };
  }
  const template = await renderPromptTemplate("chapterSummary", { chapterId, sceneBlocks: sceneRecords.map((item) => `## ${String(item.sceneId)}\n${Array.isArray(item.summaryLines) ? item.summaryLines.join("\n") : ""}`).join("\n\n") });
  const prompt = `${await composePrompt(template.body)}${promptJson('{"summaryLines":["...","...","..."]}')}`;
  const generated = await generate(moduleContext, context, { feature: "chapter-summary", prompt, promptVersion: template.version, sourceRevisions: revisionList([...story.files.values()].filter((file) => reads.some((item) => item.path === file.path))), outputTokens: 128 });
  const summary = parseStructured(generated.text, chapterSummarySchema);
  const recordValue = { scope: "chapter", id: chapterId, ...summary, sourceHash: childHash, generatedAt: generated.provenance.generatedAt, provider: generated.provenance.provider, model: generated.provenance.model, modelVersion: generated.provenance.modelVersion, promptVersion: template.version, snapshot: generated.provenance.snapshot };
  const operationReads = [...reads, readRevision(context, chapterPath, existingChapter?.revision ?? null), ...generated.provenance.sourceRevisions.filter((item) => item.path === ASSISTANT_SETTINGS_PATH)];
  const operation = makeOperation(context, "metadata", `Propose chapter summary for ${chapterId}`, operationReads, [{ path: chapterPath, revision: existingChapter?.revision ?? null, content: YAML.stringify(recordValue) }]);
  const proposal = await context.propose([operation], evidence(context, "assistant.chapter-summary", operationReads, { chapterId, model: generated.provenance.model, promptVersion: template.version }));
  return { summary: recordValue, stale: false, cached: false, model: generated.provenance.model, provider: generated.provenance.provider, promptVersion: template.version, citations: citations.slice(0, 12), provenance: generated.provenance, proposal };
}

async function runQa(moduleContext: ModuleContext, context: ModuleActionContext, input: { question: string; sceneId?: string }) {
  const search = await invokeData(context, "semantic.search", { query: input.question, mode: "sentence", limit: 12, rerank: false });
  const results = Array.isArray(search.results) ? search.results.map((hit) => record(hit)) : [];
  const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
  const citations: SourceCitation[] = [];
  for (const hit of results) {
    const sceneId = typeof hit.sceneId === "string" ? hit.sceneId : undefined;
    if (input.sceneId && sceneId !== input.sceneId) continue;
    const quote = typeof hit.snippet === "string" ? hit.snippet : typeof hit.text === "string" ? hit.text : "";
    if (!quote.trim()) continue;
    const exactFilePath = typeof hit.filePath === "string" ? hit.filePath : undefined;
    const file = exactFilePath ? story.files.get(exactFilePath) : undefined;
    const source = file ?? (sceneId && story.entities.get(sceneId)?.type === "scene"
      ? story.files.get(String(story.entities.get(sceneId)!.raw.manuscript ?? ""))
      : undefined);
    if (!source || !source.content.includes(quote.trim())) continue;
    if (citations.some((item) => item.path === source.path && item.quote === quote.trim())) continue;
    citations.push(sourceCitation(source, quote.trim(), sceneId, `semantic result ${citations.length + 1}`));
    if (citations.length >= 8) break;
  }
  if (!citations.length) {
    return { answer: "このスナップショットから裏付ける記述を見つけられませんでした。", confidence: "low", citations: [], provenance: { snapshot: context.reader.snapshot, provider: null, model: null, moduleVersion: ASSISTANT_MODULE_VERSION, promptVersion: "setting-qa.v1", generatedAt: new Date().toISOString(), sourceRevisions: [] } };
  }
  const evidenceBlock = citations.map((citation, index) => `[${index + 1}] ${citation.path}${citation.sceneId ? ` (scene ${citation.sceneId})` : ""}\n${citation.quote}`).join("\n\n");
  const template = await renderPromptTemplate("settingQa", { manuscriptBody: evidenceBlock });
  const prompt = `${await composePrompt(`${template.body}\n\n質問: ${input.question}\n\n参照した根拠:\n${evidenceBlock}`)}${promptJson('{"answer":"...","confidence":"high|medium|low"}')}`;
  const generation = await generate(moduleContext, context, { feature: "setting-qa", prompt, promptVersion: template.version, sourceRevisions: citationPaths(citations), outputTokens: 192 });
  const parsed = parseStructured(generation.text, z.object({ answer: z.string().min(1), confidence: z.enum(["high", "medium", "low"]) }));
  return { ...parsed, citations, model: generation.provenance.model, provider: generation.provenance.provider, promptVersion: generation.provenance.promptVersion, provenance: generation.provenance };
}

async function runContinuation(moduleContext: ModuleContext, context: ModuleActionContext, sceneId: string) {
  const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
  const source = sceneContext(story, sceneId);
  const template = await renderPromptTemplate("continuationOptions", {});
  const prompt = `${await composePrompt(`${template.body}\n\n場面本文:\n${source.body}`)}${promptJson('{"options":[{"direction":"...","rationale":"..."},{"direction":"...","rationale":"..."},{"direction":"...","rationale":"..."}]}')}`;
  const sceneFile = story.files.get(source.scene.filePath)!;
  const sourceRevisions = [{ path: source.scene.filePath, revision: sceneFile.revision }, { path: source.manuscript.path, revision: source.manuscript.revision }];
  const generated = await generate(moduleContext, context, { feature: "continuation-options", prompt, promptVersion: template.version, sourceRevisions, outputTokens: 192 });
  const result = parseStructured(generated.text, continuationSchema);
  return { ...result, sceneId, model: generated.provenance.model, provider: generated.provenance.provider, promptVersion: generated.provenance.promptVersion, citations: [makeCitation(source.manuscript, source.body, source.scene.id, "scene manuscript")], provenance: generated.provenance };
}

async function runAspectReview(moduleContext: ModuleContext, context: ModuleActionContext, input: { chapterId: string; aspects: string[] }) {
  const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
  const { chapter, scenes } = chapterScenes(story, input.chapterId);
  if (!scenes.length) throw codeError("assistant_source_missing", `Chapter ${input.chapterId} has no manuscript scenes`);
  if (scenes.length > 30 || scenes.reduce((size, scene) => size + scene.body.length, 0) > 80_000) throw codeError("assistant_scope_too_large", "Aspect review is limited to 30 scenes and 80000 characters");
  const labels: Record<string, string> = { tempo: "テンポ", "pov-shift": "視点の揺れ", "over-explain": "説明過多" };
  const sceneBlocks = scenes.map((item) => `## ${item.scene.name ?? item.scene.id} (${item.scene.id})\nPOV: ${String(item.scene.raw.pov ?? "不明")}\n${item.body}`).join("\n\n");
  const template = await renderPromptTemplate("aspectReview", {
    chapterId: input.chapterId, chapterName: chapter.name ?? input.chapterId,
    aspectLines: input.aspects.map((aspect) => `- ${aspect}（${labels[aspect]}）`).join("\n"), sceneBlocks,
  });
  const prompt = `${await composePrompt(template.body)}${promptJson('{"findings":[{"aspect":"tempo|pov-shift|over-explain","finding":"...","quote":"exact source quote","sceneId":"..."}]}')}`;
  const sourceRevisions = revisionList([...story.files.values()].filter((file) => scenes.some((item) => file.path === item.scene.filePath || file.path === item.manuscript.path)));
  const generated = await generate(moduleContext, context, { feature: "aspect-review", prompt, promptVersion: template.version, sourceRevisions, outputTokens: 256 });
  const parsed = parseStructured(generated.text, aspectSchema);
  const verified: Array<RecordValue> = [];
  const citations: SourceCitation[] = [];
  for (const finding of parsed.findings) {
    if (!input.aspects.includes(finding.aspect)) continue;
    const source = scenes.find((item) => item.scene.id === finding.sceneId);
    if (!source || !source.body.includes(finding.quote)) continue;
    verified.push(finding);
    citations.push(sourceCitation(source.manuscript, finding.quote, source.scene.id, finding.aspect));
  }
  return { findings: verified, chapterId: input.chapterId, model: generated.provenance.model, provider: generated.provenance.provider, promptVersion: generated.provenance.promptVersion, citations, provenance: generated.provenance };
}

async function runDialogueTopics(moduleContext: ModuleContext, context: ModuleActionContext, sceneId: string) {
  const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
  const source = sceneContext(story, sceneId);
  const participantIds = Array.isArray(source.scene.raw.appears) ? [...new Set(source.scene.raw.appears.filter((id): id is string => typeof id === "string"))] : [];
  if (participantIds.length < 2 || participantIds.length > 8) throw codeError("assistant_dialogue_participants_invalid", "Dialogue topic suggestions require two to eight scene participants");
  const participants = participantIds.map((id) => ({ id, name: story.entities.get(id)?.name ?? id }));
  const nameById = Object.fromEntries(participants.map((item) => [item.id, item.name]));
  const pairs: Array<{ a: string; b: string; label: string }> = [];
  for (let left = 0; left < participantIds.length; left += 1) for (let right = left + 1; right < participantIds.length; right += 1) {
    const a = participantIds[left]!, b = participantIds[right]!;
    const relations = story.links.filter((link) => (link.from === a && link.to === b) || (link.from === b && link.to === a));
    for (const relation of relations.slice(0, 4)) pairs.push({ a, b, label: relation.note ?? relation.kind });
  }
  const pairLines = pairs.length ? pairs.map((item) => `- ${nameById[item.a]} ↔ ${nameById[item.b]}: ${item.label}`).join("\n") : "（関係ラベル未登録 — 参加者の対比・緊張を想像してよい）";
  const prompt = await composePrompt([
    "あなたは小説のセリフ問答（SS）用お題の提案者です。",
    "参加キャラの関係性ラベルを種に、対比・緊張・親密さが際立つお題を3〜5個提案してください。",
    "各お題は title と situation の組で構成してください。セリフ・地の文・説明文は禁止。",
    `参加者: ${participants.map((item) => `${item.name} (${item.id})`).join("、")}`,
    `関係種:\n${pairLines}`,
    promptJson('{"topics":[{"title":"...","situation":"..."},{"title":"...","situation":"..."},{"title":"...","situation":"..."}]}'),
  ].join("\n"));
  const sceneFile = story.files.get(source.scene.filePath)!;
  const sourceRevisions = revisionList([sceneFile, source.manuscript, ...participantIds.flatMap((id) => {
    const participant = story.entities.get(id);
    return participant ? [story.files.get(participant.filePath)!].filter(Boolean) : [];
  })]);
  const generated = await generate(moduleContext, context, { feature: "dialogue-sketch", prompt, promptVersion: CUSTOM_PROMPT_VERSIONS.dialogueTopics, sourceRevisions, outputTokens: 192 });
  const parsed = parseStructured(generated.text, topicsSchema);
  return { topics: parsed.topics, sceneId, model: generated.provenance.model, provider: generated.provenance.provider, promptVersion: generated.provenance.promptVersion, citations: [makeCitation(source.manuscript, source.body, source.scene.id, "scene manuscript")], provenance: generated.provenance };
}

function cleanShort(value: unknown, limit = 2_000): string { return typeof value === "string" ? value.trim().slice(0, limit) : ""; }

async function runDialogueTurns(moduleContext: ModuleContext, context: ModuleActionContext, input: { sceneId: string; topic: string; participants: string[]; precedingLines: string[] }) {
  const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
  const source = sceneContext(story, input.sceneId);
  const participantEntities = input.participants.map((id) => entity(story, id));
  if (participantEntities.some((item) => item.type !== "character")) throw codeError("assistant_dialogue_participants_invalid", "Dialogue participants must be character entities");
  const roster = participantEntities.map((item) => `### ${item.name ?? item.id} (${item.id})\n口調・声紋:\n${JSON.stringify(item.raw.voice ?? item.raw.voicePatterns ?? {}, null, 2).slice(0, 2_000) || "（未登録）"}\n図鑑ノート:\n${JSON.stringify(item.raw.notes ?? {}, null, 2).slice(0, 2_000) || "（未登録）"}`).join("\n\n");
  const template = await renderPromptTemplate("dialogueSketchLines", {
    lineCount: "3", speakerRoster: roster, topic: input.topic,
    situation: cleanShort(source.scene.raw.description ?? source.scene.raw.goal) || `${source.scene.name ?? source.scene.id} の場面`,
    precedingLines: input.precedingLines.join("\n") || "（まだ会話はありません）",
  });
  const prompt = `${await composePrompt(template.body)}${promptJson('{"lines":[{"speakerEntityId":"participant-id","text":"..."},{"speakerEntityId":"participant-id","text":"..."},{"speakerEntityId":"participant-id","text":"..."}]}')}`;
  const sourceRevisions = revisionList([story.files.get(source.scene.filePath)!, source.manuscript, ...participantEntities.map((item) => story.files.get(item.filePath)!).filter(Boolean)]);
  const generated = await generate(moduleContext, context, { feature: "dialogue-sketch-turn", prompt, promptVersion: template.version, sourceRevisions, outputTokens: 192 });
  const parsed = parseStructured(generated.text, dialogueLinesSchema);
  const allowed = new Set(input.participants);
  const lines = parsed.lines.map((line) => {
    if (!allowed.has(line.speakerEntityId)) throw codeError("assistant_output_invalid", "Dialogue output included a character outside the selected participants");
    return { ...line, text: line.text.replace(/^[「『]|[」』]$/g, "").trim() };
  });
  return { lines, sceneId: input.sceneId, model: generated.provenance.model, provider: generated.provenance.provider, promptVersion: generated.provenance.promptVersion, citations: [makeCitation(source.manuscript, source.body, source.scene.id, "scene manuscript")], provenance: generated.provenance };
}

async function runReaderReaction(moduleContext: ModuleContext, context: ModuleActionContext, chapterId: string) {
  const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
  const target = entity(story, chapterId);
  if (target.type !== "chapter") throw new TypeError(`${chapterId} is not a chapter`);
  const chapters = [...story.entities.values()].filter((item) => item.type === "chapter").sort((left, right) => {
    const leftVolume = story.entities.get(String(left.raw.volume ?? ""));
    const rightVolume = story.entities.get(String(right.raw.volume ?? ""));
    return Number(leftVolume?.raw.order ?? 0) - Number(rightVolume?.raw.order ?? 0) ||
      String(left.raw.volume ?? "").localeCompare(String(right.raw.volume ?? "")) ||
      Number(left.raw.order ?? 0) - Number(right.raw.order ?? 0) || left.id.localeCompare(right.id);
  });
  const targetIndex = chapters.findIndex((item) => item.id === chapterId);
  if (targetIndex < 0) throw codeError("assistant_source_missing", `Chapter ${chapterId} is missing from the story order`);
  const cumulative: Array<{ chapterId: string; summaryLines: string[] }> = [];
  const citations: SourceCitation[] = [];
  const sourceRevisions: FileRevision[] = [];
  for (const chapter of chapters.slice(0, targetIndex + 1)) {
    const { scenes } = chapterScenes(story, chapter.id);
    const childHashes: string[] = [];
    let fresh = scenes.length > 0;
    for (const scene of scenes) {
      const path = sceneSummaryPath(scene.scene);
      const file = await context.reader.read(path);
      const summary = file ? readYamlObject(file.content) : null;
      if (!summary || summary.sceneId !== scene.scene.id || summary.sourceHash !== fnv1aHash(scene.body) || !Array.isArray(summary.summaryLines)) { fresh = false; break; }
      childHashes.push(String(summary.sourceHash));
      sourceRevisions.push({ path, revision: file!.revision }, { path: scene.manuscript.path, revision: scene.manuscript.revision });
    }
    const chapterPath = chapterSummaryPath(chapter);
    const chapterFile = await context.reader.read(chapterPath);
    const chapterSummary = chapterFile ? readYamlObject(chapterFile.content) : null;
    if (!fresh || !chapterSummary || chapterSummary.id !== chapter.id || chapterSummary.sourceHash !== fnv1aHash(childHashes.join("|")) || !Array.isArray(chapterSummary.summaryLines)) {
      throw codeError("assistant_summary_stale", `Fresh accepted summaries are required through chapter ${chapter.id}`);
    }
    sourceRevisions.push({ path: chapterPath, revision: chapterFile!.revision });
    cumulative.push({ chapterId: chapter.id, summaryLines: (chapterSummary.summaryLines as unknown[]).filter((line): line is string => typeof line === "string") });
    citations.push(sourceCitation({ ...chapterFile!, path: chapterPath }, chapterSummary.summaryLines.join("\n"), chapter.id, "accepted chapter summary"));
  }
  const template = await renderPromptTemplate("firstReadReaction", { chapterId, blocks: cumulative.map((item) => `chapter_id: ${item.chapterId}\n${item.summaryLines.map((line) => `- ${line}`).join("\n")}`).join("\n\n") || "(要約なし)" });
  const prompt = `${await composePrompt(template.body)}${promptJson('{"questions":["..."],"expectations":["..."],"confusions":["..."]}')}`;
  const generated = await generate(moduleContext, context, { feature: "first-read-reaction", prompt, promptVersion: template.version, sourceRevisions: revisionList([], sourceRevisions), outputTokens: 160 });
  const reaction = parseStructured(generated.text, reactionSchema);
  return { chapterId, ...reaction, model: generated.provenance.model, provider: generated.provenance.provider, promptVersion: generated.provenance.promptVersion, citations, provenance: generated.provenance };
}

async function runSynonyms(moduleContext: ModuleContext, context: ModuleActionContext, input: { terms: string[]; context?: string }) {
  if (input.terms.length > 8) throw codeError("assistant_scope_too_large", "Synonym generation is limited to eight terms per request");
  const results: Array<RecordValue> = [];
  for (const original of input.terms) {
    const sentence = input.context ?? original;
    const prompt = await composePrompt([
      "対象語句と文全体の意味・文体を保ち、言い換え語句を3〜5個出してください。",
      `対象語句: ${original}`, `文: ${sentence}`,
      promptJson('{"candidates":["...","...","..."]}'),
    ].join("\n"));
    const generated = await generate(moduleContext, context, { feature: "synonym-suggest", prompt, promptVersion: CUSTOM_PROMPT_VERSIONS.synonym, outputTokens: 128 });
    const parsed = parseStructured(generated.text, synonymSchema);
    results.push({ term: original, candidates: parsed.candidates, model: generated.provenance.model, provider: generated.provenance.provider, promptVersion: generated.provenance.promptVersion, citations: [], provenance: generated.provenance });
  }
  return { suggestions: results, model: results[0]?.model ?? null, promptVersion: CUSTOM_PROMPT_VERSIONS.synonym };
}

function parseContradictionInput(value: unknown): { candidateId?: string; candidateText?: string } {
  const input = record(value);
  if (typeof input.candidate === "string") return { candidateText: parseString(input.candidate, "candidate", 8_000) };
  const candidate = input.candidate === undefined ? undefined : record(input.candidate, "candidate");
  return { candidateId: parseString(input.candidateId ?? candidate?.id, "candidate.id", 256) };
}

async function runContradictionAssist(moduleContext: ModuleContext, context: ModuleActionContext, input: { candidateId?: string; candidateText?: string }) {
  const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
  let candidateId: string | undefined;
  let claim: string;
  let grounded: Array<{ source: ReturnType<typeof sceneContext>; quote: string }> = [];
  if (input.candidateId) {
    const rebuilt = await invokeData(context, "semantic.contradictions.rebuild", {});
    const candidates = Array.isArray(rebuilt.candidates) ? rebuilt.candidates.map((item) => record(item, "contradiction candidate")) : [];
    const candidate = candidates.find((item) => item.id === input.candidateId);
    if (!candidate) throw codeError("assistant_candidate_stale", "The selected contradiction candidate is no longer present in this snapshot");
    candidateId = String(candidate.id);
    const evidenceA = record(candidate.evidenceA, "evidenceA"), evidenceB = record(candidate.evidenceB, "evidenceB");
    const sourceA = sceneContext(story, parseString(evidenceA.sceneId, "evidenceA.sceneId", 256));
    const sourceB = sceneContext(story, parseString(evidenceB.sceneId, "evidenceB.sceneId", 256));
    const quoteA = parseString(evidenceA.quote, "evidenceA.quote", 2_000), quoteB = parseString(evidenceB.quote, "evidenceB.quote", 2_000);
    if (!sourceA.body.includes(quoteA) || !sourceB.body.includes(quoteB)) throw codeError("assistant_candidate_stale", "Contradiction evidence changed after candidate selection");
    claim = String(candidate.suspicion ?? "Compare these two source statements for contradiction.");
    grounded = [{ source: sourceA, quote: quoteA }, { source: sourceB, quote: quoteB }];
  } else {
    claim = input.candidateText!;
    const search = await invokeData(context, "semantic.search", { query: claim, mode: "sentence", limit: 12, rerank: false });
    const hits = Array.isArray(search.results) ? search.results.map((item) => record(item, "semantic result")) : [];
    for (const hit of hits) {
      const sceneId = typeof hit.sceneId === "string" ? hit.sceneId : undefined;
      if (!sceneId) continue;
      const source = sceneContext(story, sceneId);
      const quote = typeof hit.snippet === "string" ? hit.snippet : typeof hit.text === "string" ? hit.text : "";
      if (!quote.trim() || !source.body.includes(quote.trim())) continue;
      if (grounded.some((item) => item.source.scene.id === sceneId && item.quote === quote.trim())) continue;
      grounded.push({ source, quote: quote.trim() });
      if (grounded.length >= 8) break;
    }
  }
  if (grounded.length === 0) throw codeError("assistant_evidence_missing", "No current manuscript passages support a contradiction review");
  const evidenceBlock = grounded.map((item, index) => `[${index + 1}] scene ${item.source.scene.id}\n${item.quote}`).join("\n\n");
  const prompt = await composePrompt([
    "候補の主張と、提示した原稿断片の関係を確認してください。原稿と候補が矛盾する場合は contradiction、両立できる場合は compatible、原稿の根拠が足りない場合は insufficient を選んでください。",
    "reason は短く説明し、quotes は判定に使った原稿断片を最大2つ返してください。引用は入力にある完全一致の範囲にしてください。",
    ...(candidateId ? [`矛盾候補ID: ${candidateId}`] : []), `確認する主張: ${claim}`,
    `現在の原稿根拠:\n${evidenceBlock}`,
    promptJson('{"verdict":"contradiction|compatible|insufficient","reason":"...","quotes":["exact source quote"]}'),
  ].join("\n\n"));
  const sourceRevisions = revisionList(grounded.flatMap(({ source }) => [story.files.get(source.scene.filePath)!, source.manuscript]));
  const evidenceHash = sha256(`${candidateId ?? claim}:${grounded.map(({ source, quote }) => `${source.scene.id}:${quote}`).join("|")}`).slice(0, 16);
  const generated = await generate(moduleContext, context, { feature: "contradiction-check", prompt, promptVersion: `${CUSTOM_PROMPT_VERSIONS.contradiction}:${evidenceHash}`, sourceRevisions, outputTokens: 128 });
  const parsed = parseStructured(generated.text, contradictionSchema);
  const allowedQuotes = new Set(grounded.map((item) => item.quote));
  const citations = grounded.map(({ source, quote }, index) => sourceCitation(source.manuscript, quote, source.scene.id, `evidence ${index + 1}`));
  return { ...(candidateId ? { candidateId } : { candidate: claim }), verdict: parsed.verdict, reason: parsed.reason, quotes: parsed.quotes.filter((quote) => allowedQuotes.has(quote)), model: generated.provenance.model, provider: generated.provenance.provider, promptVersion: generated.provenance.promptVersion, citations, provenance: generated.provenance };
}

function parseZukanInput(value: unknown): { entityId: string; blockPath?: string; prompt?: string } {
  const input = record(value);
  return { entityId: parseString(input.entityId, "entityId", 256), ...(optionalString(input, "blockPath", 128) ? { blockPath: optionalString(input, "blockPath", 128) } : {}), ...(optionalString(input, "prompt", 4_000) ? { prompt: optionalString(input, "prompt", 4_000) } : {}) };
}

async function runZukanSuggestions(moduleContext: ModuleContext, context: ModuleActionContext, input: { entityId: string; blockPath?: string; prompt?: string }) {
  const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
  const target = entity(story, input.entityId);
  const name = target.name ?? target.id;
  const search = await invokeData(context, "semantic.search", { query: name, mode: "sentence", limit: 12, rerank: false });
  const candidates = Array.isArray(search.results) ? search.results.map((item) => record(item)) : [];
  const eligible = new Map<string, { source: ReturnType<typeof sceneContext>; file: StoryFile }>();
  for (const hit of candidates) {
    if (typeof hit.sceneId !== "string" || eligible.has(hit.sceneId)) continue;
    const source = sceneContext(story, hit.sceneId);
    const quote = typeof hit.snippet === "string" ? hit.snippet.trim() : typeof hit.text === "string" ? hit.text.trim() : "";
    if (quote && source.body.includes(quote)) eligible.set(hit.sceneId, { source, file: source.manuscript });
    if (eligible.size >= 8) break;
  }
  if (!eligible.size) throw codeError("assistant_evidence_missing", "No current manuscript references were found for this entity");
  const notesExcerpt = JSON.stringify(target.raw.notes ?? "").slice(0, 4_000) || "(空)";
  const evidenceBlock = [...eligible.values()].map(({ source }) => `--- scene ${source.scene.id} ---\n${source.body.slice(0, 3_000)}`).join("\n\n");
  const desiredBlockPath = input.blockPath ?? "lead.0";
  const prompt = await composePrompt([
    "あなたは小説の図鑑ノート編集アシスタントです。新しい言及から現行ノートへの差分追記案を1件だけ作ってください。",
    "図鑑は直接書き換えず、どの節にどの一文を足すかだけ提案します。proposedText は evidence.quote 内の実在表現だけで構成し、入力に無い設定を作らないでください。",
    `entityId: ${target.id}`, `entityName: ${name}`, `推奨 blockPath: ${desiredBlockPath}`,
    `追加指示: ${input.prompt ?? "なし"}`, `現行ノート:\n${notesExcerpt}`, `新規言及シーン:\n${evidenceBlock}`,
    "blockPath は lead.<i> または sections.<si>.body.<bi> 形式。",
    promptJson('{"blockPath":"lead.0","proposedText":"...","evidence":[{"sceneId":"...","quote":"exact source quote"}]}'),
  ].join("\n\n"));
  const sourceRevisions = revisionList([...story.files.values()].filter((file) => file.path === target.filePath || [...eligible.values()].some((item) => item.source.scene.filePath === file.path || item.file.path === file.path)));
  const generated = await generate(moduleContext, context, { feature: "zukan-proposal", prompt, promptVersion: CUSTOM_PROMPT_VERSIONS.zukan, sourceRevisions, outputTokens: 160 });
  const parsed = parseStructured(generated.text, zukanSchema);
  if (!/^(?:lead\.\d+|sections\.\d+\.body\.\d+)$/.test(parsed.blockPath)) throw codeError("assistant_output_invalid", "Zukan output used an unsupported notes block path");
  if (input.blockPath && parsed.blockPath !== input.blockPath) throw codeError("assistant_output_invalid", "Zukan output changed the selected notes block path");
  const allowed = new Map([...eligible].map(([sceneId, item]) => [sceneId, item.source]));
  const verifiedEvidence: Array<{ sceneId: string; quote: string }> = [];
  const citations: SourceCitation[] = [];
  for (const item of parsed.evidence) {
    const source = allowed.get(item.sceneId);
    if (!source || !source.body.includes(item.quote)) continue;
    verifiedEvidence.push(item);
    citations.push(sourceCitation(source.manuscript, item.quote, item.sceneId, "Zukan evidence"));
  }
  if (!verifiedEvidence.length) throw codeError("assistant_output_invalid", "Zukan output did not cite an exact current manuscript passage");
  const storyResult = await context.invoke("story.zukan-suggestions.create", {
    entityId: target.id, proposedText: parsed.proposedText, evidence: verifiedEvidence, source: "manuscript",
    blockPath: parsed.blockPath, kind: "fact", confidence: "low",
  });
  if (!storyResult.ok) throw codeError(storyResult.error.code, storyResult.error.message);
  const storyData = record(storyResult.data, "Story Zukan create result");
  return { entityId: target.id, suggestion: storyData.suggestion ?? storyData, created: storyData.created === true, proposal: storyResult.proposals?.[0] ?? null, model: generated.provenance.model, provider: generated.provenance.provider, promptVersion: generated.provenance.promptVersion, citations, provenance: generated.provenance };
}

async function runStateEventDraft(moduleContext: ModuleContext, context: ModuleActionContext, sceneId: string) {
  const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
  const source = sceneContext(story, sceneId);
  const worldState = await invokeData(context, "story.world-state.at-scene", { sceneId });
  const priorState = JSON.stringify(worldState, null, 2).slice(0, 8_000);
  const prompt = await composePrompt([
    "原稿から客観的な状態変化だけを抽出してください。推測は禁止し、変化が無ければ events: [] を返してください。",
    "各 event は kind, target, operation, before, after, object, payload, evidenceQuote を返します。before/after はオブジェクトか null。evidenceQuote は本文中の連続した完全一致の引用です。人物の信念、読者への開示、将来予測は出力しません。",
    `sceneId: ${sceneId}`, `直前の確定状態: ${priorState}`, `本文:\n${source.body}`,
    promptJson('{"events":[{"kind":"location|acquaintance|ownership|knowledge","target":"entity-id","operation":"...","before":{},"after":{},"object":"entity-id|null","payload":{},"evidenceQuote":"exact quote"}]}'),
  ].join("\n\n"));
  const sourceRevisions = [{ path: source.scene.filePath, revision: story.files.get(source.scene.filePath)!.revision }, { path: source.manuscript.path, revision: source.manuscript.revision }];
  const generated = await generate(moduleContext, context, { feature: "state-event-draft", prompt, promptVersion: `${CUSTOM_PROMPT_VERSIONS.stateEvent}:${fnv1aHash(source.body)}`, sourceRevisions, outputTokens: 192 });
  const parsed = parseStructured(generated.text, stateEventSchema);
  const drafts: Array<RecordValue> = [];
  const proposals: unknown[] = [];
  for (const item of parsed.events) {
    const startOffset = source.body.indexOf(item.evidenceQuote);
    if (startOffset < 0 || source.body.indexOf(item.evidenceQuote, startOffset + 1) >= 0) continue;
    const eventId = `llm-draft-${fnv1aHash(`${sceneId}:${startOffset}:${JSON.stringify(item)}`)}`;
    const event = {
      kind: item.kind, subject: item.target, object: item.object,
      payload: { ...item.payload, operation: item.operation, before: item.before, after: item.after },
      eventId, propositionId: `proposal-${fnv1aHash(eventId)}`,
      evidence: [{ sceneId, excerpt: item.evidenceQuote, startOffset, endOffset: startOffset + item.evidenceQuote.length }], confidence: 0.5,
    };
    const result = await context.invoke("story.state-proposals.create", { sceneId, event });
    if (!result.ok) throw codeError(result.error.code, result.error.message);
    drafts.push(record(result.data, "state proposal"));
    proposals.push(...(result.proposals ?? []));
  }
  return { sceneId, drafts, proposals, model: generated.provenance.model, provider: generated.provenance.provider, promptVersion: generated.provenance.promptVersion, citations: parsed.events.filter((item) => source.body.includes(item.evidenceQuote)).map((item) => sourceCitation(source.manuscript, item.evidenceQuote, sceneId, "state event evidence")), provenance: generated.provenance };
}

function isDialogueSentence(text: string): boolean { return /[「『].+[」』]/u.test(text); }

async function runSpeakerAttribution(moduleContext: ModuleContext, context: ModuleActionContext, sceneId: string) {
  const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
  const source = sceneContext(story, sceneId);
  const dialogues = splitIntoSentences(source.body).map((text, index) => ({ sentenceIndex: index + 1, text: text.trim() })).filter((item) => item.text && isDialogueSentence(item.text));
  if (!dialogues.length) throw codeError("assistant_dialogue_missing", "No quoted dialogue lines were found in the scene");
  const candidateIds = Array.isArray(source.scene.raw.appears) ? [...new Set(source.scene.raw.appears.filter((id): id is string => typeof id === "string"))].slice(0, 32) : [];
  const candidates = candidateIds.map((id) => story.entities.get(id)).filter((item): item is StoryEntity => !!item && item.type === "character");
  const candidateBlock = candidates.map((candidate) => `### ${candidate.name ?? candidate.id} (${candidate.id})\n口調・声紋:\n${JSON.stringify(candidate.raw.voice ?? candidate.raw.voicePatterns ?? {}).slice(0, 2_000) || "（未登録）"}\n図鑑ノート:\n${JSON.stringify(candidate.raw.notes ?? {}).slice(0, 2_000) || "（未登録）"}`).join("\n\n") || "（なし）";
  const numbered = splitIntoSentences(source.body).map((text, index) => text.trim() ? `${index + 1}. ${text.trim()}` : "").filter(Boolean).join("\n");
  const prompt = await composePrompt([
    "あなたは小説の話者帰属アシスタントです。番号付きシーン本文の各セリフ（鉤括弧）について、候補キャラから話者を推定してください。候補外は null にしてください。",
    `候補キャラ:\n${candidateBlock}`, `シーン本文:\n${numbered}`,
    promptJson('{"attributions":[{"sentenceIndex":1,"speakerEntityId":"character-id|null","rationale":"..."}]}'),
  ].join("\n\n"));
  const sourceRevisions = revisionList([story.files.get(source.scene.filePath)!, source.manuscript, ...candidates.map((candidate) => story.files.get(candidate.filePath)!).filter(Boolean)]);
  const generated = await generate(moduleContext, context, { feature: "speaker-attribution-llm", prompt, promptVersion: CUSTOM_PROMPT_VERSIONS.speaker, sourceRevisions, outputTokens: 192 });
  const parsed = parseStructured(generated.text, speakerSchema);
  const candidateSet = new Set(candidates.map((item) => item.id));
  const byIndex = new Map(parsed.attributions.map((item) => [item.sentenceIndex, item]));
  const proposals = dialogues.map((dialogue) => {
    const answer = byIndex.get(dialogue.sentenceIndex);
    return { ...dialogue, speakerEntityId: answer?.speakerEntityId && candidateSet.has(answer.speakerEntityId) ? answer.speakerEntityId : null, ...(answer?.rationale ? { rationale: answer.rationale } : {}) };
  });
  return { sceneId, attributions: proposals, model: generated.provenance.model, provider: generated.provenance.provider, promptVersion: generated.provenance.promptVersion, citations: [makeCitation(source.manuscript, source.body, sceneId, "scene manuscript")], provenance: generated.provenance };
}

function parseSettingsPatch(value: unknown): { patch: RecordValue } {
  return { patch: record(record(value).patch, "settings patch") };
}

function providerState(feature = "rewrite", settings?: AssistantModelSettings): { providerKind: string; envDefaultModel: string | null; issue?: string } {
  try {
    const model = resolveAssistantModel(feature, settings);
    return { providerKind: model?.provider ?? "none", envDefaultModel: model?.model ?? null };
  } catch {
    return { providerKind: "invalid", envDefaultModel: null, issue: "provider_configuration_invalid" };
  }
}

function parseModelUsageEvent(value: unknown): ModelUsageEvent {
  const input = record(value, "host model usage event");
  const state = input.state;
  if (!(["completed", "aborted", "failed"] as unknown[]).includes(state)) throw new TypeError("Host model usage event has an invalid state");
  return {
    id: parseString(input.id, "event.id", 256),
    repository: record(input.repository, "event.repository") as unknown as ModelUsageEvent["repository"],
    feature: parseString(input.feature, "event.feature", 256),
    provider: parseString(input.provider, "event.provider", 128),
    model: parseString(input.model, "event.model", 512),
    startedAt: parseString(input.startedAt, "event.startedAt", 64),
    completedAt: parseString(input.completedAt, "event.completedAt", 64),
    state: state as ModelUsageEvent["state"],
    ...(Number.isSafeInteger(input.inputTokens) && (input.inputTokens as number) >= 0 ? { inputTokens: input.inputTokens as number } : {}),
    ...(Number.isSafeInteger(input.outputTokens) && (input.outputTokens as number) >= 0 ? { outputTokens: input.outputTokens as number } : {}),
    ...(typeof input.cost === "number" && Number.isFinite(input.cost) && input.cost >= 0 ? { cost: input.cost } : {}),
    ...(typeof input.cacheHit === "boolean" ? { cacheHit: input.cacheHit } : {}),
    ...(typeof input.promptVersion === "string" ? { promptVersion: input.promptVersion.slice(0, 256) } : {}),
    ...(Number.isSafeInteger(input.durationMs) && (input.durationMs as number) >= 0 ? { durationMs: input.durationMs as number } : {}),
    ...(Number.isSafeInteger(input.queueWaitMs) && (input.queueWaitMs as number) >= 0 ? { queueWaitMs: input.queueWaitMs as number } : {}),
    ...(typeof input.errorCode === "string" ? { errorCode: input.errorCode.slice(0, 96) } : {}),
  };
}

function parseUsageRow(value: unknown): ModelUsageEvent & RecordValue {
  const row = record(value, "model usage row");
  return { ...parseModelUsageEvent(row), ...(typeof row.source === "string" ? { source: row.source } : {}) };
}

export function createAssistantActions(moduleContext: ModuleContext): ModuleAction[] {
  return [
    action("assistant.health", "read", parseEmpty, async () => {
      const state = providerState();
      return { available: state.providerKind !== "none" && state.providerKind !== "invalid", providerKind: state.providerKind, configuredModel: state.envDefaultModel, ...(state.issue ? { issue: state.issue } : {}), locality: "optional-external" };
    }),
    action("assistant.queue.status", "read", parseEmpty, async () => modelQueue.status()),
    action("assistant.settings.read", "read", parseEmpty, async (_input, context) => {
      const { settings, revision } = await readAssistantSettings(context.reader);
      const modelByFeature = Object.fromEntries(ASSISTANT_FEATURE_IDS.map((feature) => {
        const identity = resolveAssistantModel(feature, settings);
        return [feature, identity ? { provider: identity.provider, model: identity.model, purpose: identity.purpose } : null];
      }));
      const state = providerState("rewrite", settings);
      return { settings, revision, providerKind: state.providerKind, envDefaultModel: state.envDefaultModel, modelByFeature };
    }),
    action("assistant.settings.propose", "propose", parseSettingsPatch, async (input, context) => {
      const current = await readAssistantSettings(context.reader);
      const settings = applyAssistantSettingsPatch(current.settings, input.patch);
      const reads = [{ path: ASSISTANT_SETTINGS_PATH, revision: current.revision }];
      const operation = makeOperation(context, "settings", "Propose Assistant model preferences", reads, [{ path: ASSISTANT_SETTINGS_PATH, revision: current.revision, content: serializeAssistantSettings(settings) }]);
      const proposal = await context.propose([operation], evidence(context, "assistant.model-settings", reads, { fields: Object.keys(record(input.patch)).sort() }));
      return { settings, revision: current.revision, proposal };
    }),
    action("assistant.usage.read", "read", parseUsageInput, async (input, context) => readUsageHistory(moduleContext, context, input as ReturnType<typeof parseUsageInput>)),
    action("assistant.rewrite", "propose", parseRewriteInput, async (input, context) => runRewrite(moduleContext, context, input as ReturnType<typeof parseRewriteInput>)),
    action("assistant.summary.scene", "propose", parseIdInput, async (input, context) => runSceneSummary(moduleContext, context, input.sceneId as string)),
    action("assistant.summary.chapter", "propose", (value) => parseIdInput(value, "chapterId"), async (input, context) => runChapterSummary(moduleContext, context, input.chapterId as string)),
    action("assistant.qa", "compute", parseQaInput, async (input, context) => runQa(moduleContext, context, input as ReturnType<typeof parseQaInput>)),
    action("assistant.continuation", "compute", parseIdInput, async (input, context) => runContinuation(moduleContext, context, input.sceneId as string)),
    action("assistant.aspect.review", "compute", parseAspectInput, async (input, context) => runAspectReview(moduleContext, context, input as ReturnType<typeof parseAspectInput>)),
    action("assistant.dialogue.topics", "compute", parseIdInput, async (input, context) => runDialogueTopics(moduleContext, context, input.sceneId as string)),
    action("assistant.dialogue.turns", "compute", parseDialogueTurnInput, async (input, context) => runDialogueTurns(moduleContext, context, input as ReturnType<typeof parseDialogueTurnInput>)),
    action("assistant.reader.reaction", "compute", (value) => parseIdInput(value, "chapterId"), async (input, context) => runReaderReaction(moduleContext, context, input.chapterId as string)),
    action("assistant.zukan.suggestions", "propose", parseZukanInput, async (input, context) => runZukanSuggestions(moduleContext, context, input as ReturnType<typeof parseZukanInput>)),
    action("assistant.synonyms.suggestions", "compute", parseSynonymInput, async (input, context) => runSynonyms(moduleContext, context, input as ReturnType<typeof parseSynonymInput>)),
    action("assistant.contradictions.assist", "compute", parseContradictionInput, async (input, context) => runContradictionAssist(moduleContext, context, input as ReturnType<typeof parseContradictionInput>)),
    action("assistant.stateEvents.draft", "propose", parseIdInput, async (input, context) => runStateEventDraft(moduleContext, context, input.sceneId as string)),
    action("assistant.speaker.attribute", "compute", parseIdInput, async (input, context) => runSpeakerAttribution(moduleContext, context, input.sceneId as string)),
  ];
}

function jsonFailure(status: number, message: string): Response {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export function createRewriteStreamHttpContribution(moduleContext: ModuleContext): HttpContribution {
  return {
    id: "assistant.rewrite.stream",
    path: "rewrite/stream",
    methods: ["POST"],
    access: "owner",
    effect: "propose",
    async handle(request, context) {
      if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) return jsonFailure(415, "Content-Type must be application/json");
      let input: ReturnType<typeof parseRewriteInput>;
      try { input = parseRewriteInput(await request.json()); }
      catch (error) { return jsonFailure(400, error instanceof Error ? error.message.slice(0, 256) : "Invalid rewrite request"); }

      const encoder = new TextEncoder();
      const requestController = new AbortController();
      const signal = AbortSignal.any([context.signal, request.signal, requestController.signal]);
      let cancelled = false;
      const streamContext: ModuleActionContext = {
        ...context,
        signal,
        invoke: (actionId, payload, callSignal) => context.invoke(actionId, payload, callSignal ? AbortSignal.any([signal, callSignal]) : signal),
        propose: (operations, proposalEvidence, proposalId, callSignal) => context.propose(operations, proposalEvidence, proposalId, callSignal ? AbortSignal.any([signal, callSignal]) : signal),
      };
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (event: string, data: unknown) => {
            if (cancelled || signal.aborted) return;
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          };
          void (async () => {
            try {
              const result = await runRewrite(moduleContext, streamContext, input, (delta) => send("delta", { delta }));
              send("final", { ...result, proposals: result.proposal ? [result.proposal] : [] });
            } catch (error) {
              const err = error instanceof Error ? error : new Error(String(error));
              send(signal.aborted ? "cancelled" : "error", { code: (error as { code?: unknown })?.code ?? "assistant_action_failed", message: err.message.slice(0, 512) });
            } finally {
              if (!cancelled) {
                try { controller.close(); } catch { /* The host already cancelled the response. */ }
              }
            }
          })();
        },
        cancel(reason) { cancelled = true; requestController.abort(reason); },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
    },
  };
}
