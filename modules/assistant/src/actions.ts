import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { ModelMessage, ToolSet } from "ai";
import { jsonrepair } from "jsonrepair";
import YAML from "yaml";
import { z } from "zod";
import {
  assertProjectPath,
  MODEL_USAGE_CAPABILITY,
  snapshotKey,
  type ActionResult,
  type BrowserEditorDocument,
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
import { splitIntoSentenceOffsets, splitIntoSentences } from "@scriptorium/module-nlp";
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
import { normalizeAspectIds, runDeterministicAspectReview, type AspectId } from "./aspect-review.js";
import { buildDialogueSketchSpeakerContext, type PublicSpeakerDialogueListDto, type PublicSpeakerVoiceProfilesDto } from "./dialogue-context.js";
import { buildRewriteFallbackSuggestions, buildRewriteLocalSuggestions, type RewriteFallbackCandidate } from "./rewrite-local.js";
import { createAssistantQaTools, type AssistantQaToolCallRecord } from "./qa-tools.js";
import {
  buildContinuationContext,
  buildContinuationRetrievalQuery,
  normalizeContinuationRetrievalHits,
} from "./continuation-context.js";

const ASSISTANT_MODULE_VERSION = "0.1.0";
const USAGE_PATH = "meta/scriptorium/modules/assistant/usage.jsonl";
const EXTERNAL_FEATURES: Readonly<Record<string, string>> = {
  rewrite: "rewrite",
  "scene-summary": "scene-summary",
  "chapter-summary": "chapter-summary",
  "setting-qa": "setting-qa",
  "continuation-options": "continuation-options",
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
const SETTING_QA_MAX_STEPS = 8;
const outputSchema: ValueSchema = { parse(value) { return record(value, "action output"); } };

type RecordValue = Record<string, unknown>;
type LoadedStorySnapshot = Awaited<ReturnType<typeof readStorySnapshot>>;
interface StoryFile { path: string; content: string; revision: string }
interface SourceCitation {
  path: string;
  revision: string;
  quote: string;
  sceneId?: string;
  label?: string;
  revisionKind?: "editor-document" | "editor-scene";
  snapshot?: SnapshotId;
}
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
function parseEditorDraft(value: unknown): BrowserEditorDocument {
  const draft = record(value, "editorDraft");
  const snapshot = record(draft.snapshot, "editorDraft.snapshot") as unknown as SnapshotId;
  const baseSnapshot = record(draft.baseSnapshot, "editorDraft.baseSnapshot") as unknown as SnapshotId;
  const documentRevision = draft.documentRevision;
  const baseSceneRevision = draft.baseSceneRevision;
  if (documentRevision !== null && (typeof documentRevision !== "string" || !documentRevision || documentRevision.length > 256)) {
    throw new TypeError("editorDraft.documentRevision must be null or a bounded revision string");
  }
  if (baseSceneRevision !== null && (typeof baseSceneRevision !== "string" || !baseSceneRevision || baseSceneRevision.length > 256)) {
    throw new TypeError("editorDraft.baseSceneRevision must be null or a bounded revision string");
  }
  if (typeof draft.sceneRevision !== "string" || !draft.sceneRevision || draft.sceneRevision.length > 256) {
    throw new TypeError("editorDraft.sceneRevision must be a bounded revision string");
  }
  if (typeof draft.text !== "string" || draft.text.length > 256_000) {
    throw new TypeError("editorDraft.text must be a string of at most 256000 characters");
  }
  // Validate the two identities before comparing them to the remote reader below.
  try { snapshotKey(snapshot); snapshotKey(baseSnapshot); }
  catch { throw new TypeError("editorDraft snapshot identities are invalid"); }
  return {
    sceneId: parseString(draft.sceneId, "editorDraft.sceneId", 256),
    documentPath: parseString(draft.documentPath, "editorDraft.documentPath", 1_024),
    documentRevision: documentRevision as string | null,
    sceneRevision: draft.sceneRevision,
    text: draft.text,
    snapshot,
    baseSnapshot,
    baseSceneRevision: baseSceneRevision as string | null,
  };
}
function parseSpeakerAttributionInput(value: unknown): { sceneId: string; editorDraft?: BrowserEditorDocument } {
  const input = record(value);
  return {
    sceneId: parseString(input.sceneId, "sceneId", 256),
    ...(input.editorDraft === undefined ? {} : { editorDraft: parseEditorDraft(input.editorDraft) }),
  };
}
function assertEditorDraftBase(
  context: ModuleActionContext,
  source: ReturnType<typeof sceneContext>,
  sceneRevision: string | null,
  editorDraft: BrowserEditorDocument,
): void {
  if (editorDraft.sceneId !== source.scene.id) throw codeError("assistant_editor_draft_stale", "The current editor draft belongs to a different scene");
  if (editorDraft.documentPath !== source.manuscript.path) throw codeError("assistant_editor_draft_stale", "The current editor draft does not target this scene's canonical manuscript");
  if (snapshotKey(editorDraft.baseSnapshot) !== snapshotKey(context.reader.snapshot)) throw codeError("assistant_editor_draft_stale", "The current editor draft was checkpointed against a different remote snapshot");
  if (editorDraft.baseSceneRevision !== sceneRevision) throw codeError("assistant_editor_draft_stale", "The current editor draft's remote scene baseline has changed");
}
function optionalString(input: RecordValue, key: string, max: number): string | undefined {
  if (input[key] === undefined) return undefined;
  return parseString(input[key], key, max);
}
function parseRewriteInput(value: unknown): { sceneId: string; selectedText?: string; sentenceIndex?: number; instruction?: string } {
  const input = record(value);
  const selectedText = optionalString(input, "selectedText", 20_000);
  const sentenceIndex = input.sentenceIndex;
  if (sentenceIndex !== undefined && (!Number.isSafeInteger(sentenceIndex) || (sentenceIndex as number) < 0 || (sentenceIndex as number) > 100_000)) throw new TypeError("sentenceIndex must be a bounded zero-based integer");
  if (selectedText === undefined && sentenceIndex === undefined) throw new TypeError("selectedText or sentenceIndex is required");
  return {
    sceneId: parseString(input.sceneId, "sceneId", 256),
    ...(selectedText ? { selectedText } : {}),
    ...(typeof sentenceIndex === "number" ? { sentenceIndex } : {}),
    ...(optionalString(input, "instruction", 4_000) ? { instruction: optionalString(input, "instruction", 4_000) } : {}),
  };
}
function parseRewriteProposalInput(value: unknown): { sceneId: string; selectedText: string; replacementText: string; sentenceIndex?: number } {
  const input = record(value);
  const sentenceIndex = input.sentenceIndex;
  if (sentenceIndex !== undefined && (!Number.isSafeInteger(sentenceIndex) || (sentenceIndex as number) < 0 || (sentenceIndex as number) > 100_000)) throw new TypeError("sentenceIndex must be a bounded zero-based integer");
  return {
    sceneId: parseString(input.sceneId, "sceneId", 256),
    selectedText: parseString(input.selectedText, "selectedText", 20_000),
    replacementText: parseString(input.replacementText, "replacementText", 20_000),
    ...(typeof sentenceIndex === "number" ? { sentenceIndex } : {}),
  };
}
interface AssistantChatMessage { role: "user" | "assistant"; content: string }
function parseQaInput(value: unknown): { messages: AssistantChatMessage[]; sceneId?: string } {
  const input = record(value);
  let messages: AssistantChatMessage[];
  if (Array.isArray(input.messages)) {
    if (input.messages.length < 1 || input.messages.length > 20) throw new TypeError("messages must contain one to twenty turns");
    messages = input.messages.map((value, index) => {
      const message = record(value, `messages[${index}]`);
      if (message.role !== "user" && message.role !== "assistant") throw new TypeError(`messages[${index}].role must be user or assistant`);
      return { role: message.role, content: parseString(message.content, `messages[${index}].content`, 8_000) };
    });
    if (!messages.some((message) => message.role === "user")) throw new TypeError("messages must contain a user question");
  } else {
    messages = [{ role: "user", content: parseString(input.question, "question", 8_000) }];
  }
  return { messages, ...(optionalString(input, "sceneId", 256) ? { sceneId: optionalString(input, "sceneId", 256) } : {}) };
}
function parseAspectInput(value: unknown): { chapterId: string; aspects: AspectId[] } {
  const input = record(value);
  if (Array.isArray(input.aspects) && input.aspects.length > 100) throw new TypeError("aspects must contain at most 100 entries");
  return { chapterId: parseString(input.chapterId, "chapterId", 256), aspects: normalizeAspectIds(input.aspects) };
}
function parsePreviewIdInput(value: unknown, key: "sceneId" | "chapterId"): { id: string } {
  const input = record(value);
  return { id: parseString(input[key], key, 256) };
}
function parseQaPreviewInput(value: unknown): { sceneId?: string } {
  const input = record(value);
  const sceneId = optionalString(input, "sceneId", 256);
  return sceneId ? { sceneId } : {};
}
function parseContinuationPreviewInput(value: unknown): { recentSentences: string[] } {
  const input = record(value);
  if (input.editorText !== undefined) {
    if (typeof input.editorText !== "string" || input.editorText.length > 256_000) throw new TypeError("editorText must be a string of at most 256000 characters");
    return { recentSentences: splitIntoSentences(input.editorText).slice(-12) };
  }
  const recentSentences = input.recentSentences ?? [];
  if (!Array.isArray(recentSentences) || recentSentences.length > 2_000 || recentSentences.some((sentence) => typeof sentence !== "string" || sentence.length > 8_000)) {
    throw new TypeError("recentSentences must contain at most 2000 bounded strings");
  }
  return { recentSentences: (recentSentences as string[]).map((sentence) => sentence.trim()).filter(Boolean) };
}
function parseSynonymPreviewInput(value: unknown): SynonymRequest {
  const input = record(value);
  const original = parseString(input.original, "original", 256);
  const sentence = parseString(input.sentence, "sentence", 8_000);
  if (!sentence.includes(original)) throw new TypeError("sentence must contain original");
  return { original, sentence, ...(optionalString(input, "reason", 512) ? { reason: optionalString(input, "reason", 512) } : {}) };
}
function parseSandboxZukanPreviewInput(value: unknown): { sketchId: string; turnRange?: { start: number; end: number } } {
  const input = record(value);
  const range = input.turnRange === undefined ? undefined : record(input.turnRange, "turnRange");
  if (range && (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || (range.start as number) < 0 || (range.end as number) < (range.start as number))) {
    throw new TypeError("turnRange must contain a valid zero-based inclusive start and end");
  }
  return {
    sketchId: parseString(input.sketchId, "sketchId", 256),
    ...(range ? { turnRange: { start: range.start as number, end: range.end as number } } : {}),
  };
}
function parseDialogueTopicsInput(value: unknown): { participantEntityIds: string[] } {
  const input = record(value);
  const ids = input.participantEntityIds;
  if (!Array.isArray(ids) || ids.length < 2 || ids.length > 8 || ids.some((id) => typeof id !== "string" || !id.trim() || id.length > 256)) throw new TypeError("participantEntityIds must contain two to eight entity IDs");
  return { participantEntityIds: [...new Set(ids as string[])] };
}
interface DialogueSketchLine { speakerEntityId: string; text: string }
interface DialogueTurnInput {
  participantEntityIds: string[];
  precedingLines: DialogueSketchLine[];
  speakerEntityId?: string;
  lineCount?: number;
  sketchId?: string;
  topic?: string;
  situation?: string;
}
function parseDialogueTurnInput(value: unknown): DialogueTurnInput {
  const input = record(value);
  if (!Array.isArray(input.participantEntityIds) || input.participantEntityIds.length < 1 || input.participantEntityIds.length > 8 || input.participantEntityIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 256)) throw new TypeError("participantEntityIds must contain one to eight entity IDs");
  if (input.precedingLines !== undefined && (!Array.isArray(input.precedingLines) || input.precedingLines.length > 80)) throw new TypeError("precedingLines must contain at most 80 lines");
  const precedingLines = ((input.precedingLines ?? []) as unknown[]).map((value, index) => {
    const line = record(value, `precedingLines[${index}]`);
    return {
      speakerEntityId: parseString(line.speakerEntityId, `precedingLines[${index}].speakerEntityId`, 256),
      text: parseString(line.text, `precedingLines[${index}].text`, 2_000),
    };
  });
  const participantEntityIds = [...new Set(input.participantEntityIds as string[])];
  const speakerEntityId = optionalString(input, "speakerEntityId", 256);
  const lineCount = input.lineCount;
  if (lineCount !== undefined && (!Number.isSafeInteger(lineCount) || (lineCount as number) < 1 || (lineCount as number) > 30)) throw new TypeError("lineCount must be an integer from 1 to 30");
  if ((speakerEntityId === undefined) === (lineCount === undefined)) throw new TypeError("choose exactly one of speakerEntityId or lineCount");
  if (speakerEntityId && !participantEntityIds.includes(speakerEntityId)) throw new TypeError("speakerEntityId must be a selected participant");
  if (lineCount !== undefined && participantEntityIds.length < 2) throw new TypeError("bulk dialogue requires at least two participants");
  return {
    participantEntityIds,
    precedingLines,
    ...(speakerEntityId ? { speakerEntityId } : {}),
    ...(typeof lineCount === "number" ? { lineCount } : {}),
    ...(optionalString(input, "sketchId", 256) ? { sketchId: optionalString(input, "sketchId", 256) } : {}),
    ...(optionalString(input, "topic", 2_000) ? { topic: optionalString(input, "topic", 2_000) } : {}),
    ...(optionalString(input, "situation", 4_000) ? { situation: optionalString(input, "situation", 4_000) } : {}),
  };
}
interface SynonymRequest { original: string; sentence: string; reason?: string }
function parseSynonymInput(value: unknown): { suggestions: SynonymRequest[] } {
  const input = record(value);
  const raw = input.suggestions;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8) throw new TypeError("suggestions must contain one to eight synonym requests");
  const suggestions = raw.map((value, index) => {
    const suggestion = record(value, `suggestions[${index}]`);
    const original = parseString(suggestion.original, `suggestions[${index}].original`, 256);
    const sentence = parseString(suggestion.sentence, `suggestions[${index}].sentence`, 8_000);
    if (!sentence.includes(original)) throw new TypeError(`suggestions[${index}].sentence must contain original`);
    return { original, sentence, ...(optionalString(suggestion, "reason", 512) ? { reason: optionalString(suggestion, "reason", 512) } : {}) };
  });
  return { suggestions };
}
interface ContinuationInput {
  sceneId?: string;
  chapterId?: string;
  recentSentences?: string[];
  editorDraft?: BrowserEditorDocument;
  k: number;
  tokenBudget?: number;
}
function parseContinuationInput(value: unknown): ContinuationInput {
  const input = record(value);
  const sceneId = optionalString(input, "sceneId", 256);
  const chapterId = optionalString(input, "chapterId", 256);
  const editorDraft = input.editorDraft === undefined ? undefined : parseEditorDraft(input.editorDraft);
  if (editorDraft && !sceneId) throw new TypeError("sceneId is required when editorDraft is provided");
  let recentSentences: string[] | undefined;
  if (input.recentSentences !== undefined) {
    if (!Array.isArray(input.recentSentences) || input.recentSentences.length > 2_000 || input.recentSentences.some((line) => typeof line !== "string" || line.length > 8_000)) throw new TypeError("recentSentences must be an array of up to 2000 bounded strings");
    recentSentences = (input.recentSentences as string[]).map((line) => line.trim()).filter(Boolean);
  }
  const k = input.k === undefined ? 8 : input.k;
  if (!Number.isSafeInteger(k) || (k as number) < 0 || (k as number) > 40) throw new TypeError("k must be between 0 and 40");
  const tokenBudget = input.tokenBudget;
  if (tokenBudget !== undefined && (!Number.isSafeInteger(tokenBudget) || (tokenBudget as number) < 1 || (tokenBudget as number) > 200_000)) throw new TypeError("tokenBudget must be an integer between 1 and 200000");
  return {
    ...(sceneId ? { sceneId } : {}), ...(chapterId ? { chapterId } : {}),
    ...(recentSentences ? { recentSentences } : {}), ...(editorDraft ? { editorDraft } : {}), k: k as number,
    ...(typeof tokenBudget === "number" ? { tokenBudget } : {}),
  };
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
  jobType?: string,
): ModuleAction {
  return {
    id, effect, ...(jobType ? { job: { type: jobType } } : {}), inputSchema: { parse }, outputSchema,
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

function clampOutputTokens(value: number): number { return Math.max(48, Math.min(32_768, Math.floor(value))); }
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

async function previewModelId(context: ModuleActionContext, featureId: string): Promise<string | null> {
  const { settings } = await readAssistantSettings(context.reader);
  const configured = resolveAssistantModel(featureId, settings)?.model;
  if (configured) return configured;
  const presetId = settings.featurePresetIds[featureId];
  return settings.presets.find((preset) => preset.id === presetId)?.model || null;
}

async function generate(
  moduleContext: ModuleContext,
  context: ModuleActionContext,
  input: {
    feature: string;
    prompt?: string;
    messages?: ModelMessage[];
    system?: string;
    tools?: ToolSet;
    maxToolSteps?: number;
    promptVersion: string;
    sourceRevisions?: FileRevision[];
    outputTokens?: number;
    onText?: (delta: string) => void | Promise<void>;
  },
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
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(input.messages ? { messages: input.messages } : {}),
        ...(input.system !== undefined ? { system: input.system } : {}),
        ...(input.tools ? { tools: input.tools } : {}),
        ...(input.maxToolSteps !== undefined ? { maxToolSteps: input.maxToolSteps } : {}),
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

const REWRITE_STRATEGIES = ["concise", "contextual", "voice"] as const;
type RewriteStrategy = (typeof REWRITE_STRATEGIES)[number];
interface RewriteSuggestion { text: string; strategy: RewriteStrategy; rationale: string; source: "provider" | "source-heuristic" }

function parseRewriteCandidates(text: string): RewriteSuggestion[] {
  const unfenced = text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
  const attempts = [unfenced];
  const arrayStart = unfenced.indexOf("[");
  const arrayEnd = unfenced.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) attempts.push(unfenced.slice(arrayStart, arrayEnd + 1));
  const objectStart = unfenced.indexOf("{");
  const objectEnd = unfenced.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) attempts.push(unfenced.slice(objectStart, objectEnd + 1));

  for (const candidateText of attempts) {
    let parsed: unknown;
    try { parsed = JSON.parse(candidateText) as unknown; }
    catch {
      try { parsed = JSON.parse(jsonrepair(candidateText)) as unknown; }
      catch { continue; }
    }
    const object = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as RecordValue : undefined;
    const rows = Array.isArray(parsed) ? parsed : object?.suggestions ?? object?.candidates ?? object?.rewrites;
    if (!Array.isArray(rows)) continue;
    const suggestions = rows.flatMap((value, index): RewriteSuggestion[] => {
      const row = typeof value === "string" ? undefined : value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
      const rawText = typeof value === "string" ? value : typeof row?.text === "string" ? row.text : typeof row?.rewrite === "string" ? row.rewrite : "";
      const normalizedText = rawText.trim();
      if (!normalizedText || normalizedText.length > 20_000) return [];
      const rawStrategy = row?.strategy;
      const strategy = (REWRITE_STRATEGIES as readonly unknown[]).includes(rawStrategy)
        ? rawStrategy as RewriteStrategy
        : REWRITE_STRATEGIES[index] ?? "contextual";
      const rationale = typeof row?.rationale === "string" && row.rationale.trim()
        ? row.rationale.trim().slice(0, 2_000)
        : "LLM が文脈を踏まえて生成した候補です。";
      return [{ text: normalizedText, strategy, rationale, source: "provider" }];
    });
    if (suggestions.length) return suggestions.slice(0, 3);
  }

  return unfenced.split(/\r?\n/u)
    .map((line) => line.match(/^\s*(?:[-*]|\d+[.)]|[①②③])\s*(.+?)\s*$/u)?.[1]?.trim())
    .filter((candidate): candidate is string => Boolean(candidate))
    .slice(0, 3)
    .flatMap((candidate, index) => {
      const normalizedText = candidate.replace(/^["「]|["」]$/g, "").trim();
      return normalizedText && normalizedText.length <= 20_000
        ? [{ text: normalizedText, strategy: REWRITE_STRATEGIES[index] ?? "contextual", rationale: "LLM が文脈を踏まえて生成した候補です。", source: "provider" }]
        : [];
    });
}

function uniqueRewriteCandidates(candidates: readonly RewriteSuggestion[]): RewriteSuggestion[] {
  const seen = new Set<string>();
  const unique: RewriteSuggestion[] = [];
  for (const candidate of candidates) {
    const text = candidate.text.trim();
    if (!text || text.length > 20_000 || seen.has(text)) continue;
    seen.add(text);
    unique.push({ ...candidate, text });
    if (unique.length === 3) break;
  }
  return unique;
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

const sceneSummarySchema = z.object({
  summaryLines: z.array(z.string().min(1)).length(3),
  characters: z.array(z.string()).max(100),
  stateChanges: z.array(z.string()).max(100),
});
const chapterSummarySchema = z.object({ summaryLines: z.array(z.string().min(1)).length(3) });
const continuationSchema = z.object({ options: z.array(z.object({ direction: z.string().min(1), rationale: z.string().min(1) })).length(3) });
const topicsSchema = z.object({ topics: z.array(z.object({ title: z.string().min(1), situation: z.string().min(1) })).min(3).max(5) });
const dialogueLineResponseSchema = z.object({ text: z.string().min(1) });
const dialogueLinesSchema = z.object({ lines: z.array(z.object({ speakerEntityId: z.string().min(1), text: z.string().min(1) })).min(1).max(30) });
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

function locateRewriteSelection(body: string, selectedText: string | undefined, requestedSentenceIndex?: number): { selectedText: string; sentenceIndex: number; offset: number } {
  const offsets = splitIntoSentenceOffsets(body).filter((span) => body.slice(span.start, span.end).trim().length > 0);
  let sentenceIndex = requestedSentenceIndex;
  if (sentenceIndex === undefined) {
    if (!selectedText) throw codeError("assistant_rewrite_selection_missing", "A selected sentence is required");
    const matches = offsets.flatMap((span, index) => body.slice(span.start, span.end).includes(selectedText) ? [index] : []);
    if (matches.length !== 1) throw codeError("assistant_rewrite_selection_ambiguous", "Selected text must identify one sentence or provide its zero-based sentence index");
    sentenceIndex = matches[0]!;
  }
  const span = offsets[sentenceIndex];
  if (!span) throw codeError("assistant_rewrite_sentence_missing", `Sentence ${sentenceIndex} was not found in the scene`);
  const rawSentence = body.slice(span.start, span.end);
  const leadingWhitespace = rawSentence.length - rawSentence.trimStart().length;
  const sentence = rawSentence.trim();
  const selection = selectedText ?? sentence;
  if (!sentence.includes(selection)) throw codeError("assistant_rewrite_selection_stale", "Selected text is not part of the requested sentence in this snapshot");
  const offsetInSentence = sentence.indexOf(selection);
  if (offsetInSentence < 0 || sentence.indexOf(selection, offsetInSentence + 1) >= 0) throw codeError("assistant_rewrite_selection_ambiguous", "Selected text must occur exactly once in the requested sentence");
  return { selectedText: selection, sentenceIndex, offset: span.start + leadingWhitespace + offsetInSentence };
}

async function runRewrite(
  moduleContext: ModuleContext,
  context: ModuleActionContext,
  input: { sceneId: string; selectedText?: string; sentenceIndex?: number; instruction?: string },
  onText?: (delta: string) => void | Promise<void>,
) {
  const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
  const source = sceneContext(story, input.sceneId);
  const rawBody = source.manuscript.content.slice(source.bodyOffset);
  const bodyStart = source.bodyOffset + rawBody.length - rawBody.trimStart().length;
  const selection = locateRewriteSelection(source.body, input.selectedText, input.sentenceIndex);
  const selectedText = selection.selectedText;
  const relatedIds = [...new Set([
    ...(typeof source.scene.raw.pov === "string" ? [source.scene.raw.pov] : []),
    ...(Array.isArray(source.scene.raw.appears) ? source.scene.raw.appears.filter((id): id is string => typeof id === "string") : []),
  ])].slice(0, 16);
  const candidateEntities = relatedIds.flatMap((id) => {
    const candidate = story.entities.get(id);
    return candidate?.type === "character" ? [candidate] : [];
  });
  let profilesData: PublicSpeakerVoiceProfilesDto | undefined;
  try {
    profilesData = await invokeData(context, "speaker.voice.profiles", {}) as unknown as PublicSpeakerVoiceProfilesDto;
  } catch { /* Like the source's optional SQLite index, learned style data may be unavailable. */ }
  const dialogueSamples = await Promise.all(candidateEntities.map(async (character) => {
    try {
      const data = await invokeData(context, "speaker.dialogue.list", { characterId: character.id, limit: 6, minConfidence: "high" });
      return [character.id, Array.isArray(data.lines) ? data.lines.slice(0, 6).map((item) => record(item)) : [] as RecordValue[]] as const;
    } catch { return [character.id, [] as RecordValue[]] as const; }
  }));
  const dialogueByCharacter = new Map(dialogueSamples);
  const contextualCharacters = candidateEntities.map((candidate) => {
    const speakerContext = buildDialogueSketchSpeakerContext({
      entityId: candidate.id,
      name: candidate.name,
      raw: candidate.raw,
      speakerDialogues: dialogueByCharacter.get(candidate.id) as unknown as PublicSpeakerDialogueListDto | undefined,
      speakerProfiles: profilesData,
    });
    return {
      id: speakerContext.entityId,
      name: speakerContext.name,
      role: speakerContext.entityId === source.scene.raw.pov ? "pov" : "appears",
      voiceProfileExcerpt: speakerContext.voiceProfileExcerpt,
      fingerprintSummary: speakerContext.fingerprintSummary,
      exampleDialogues: speakerContext.exampleDialogues,
      notesExcerpt: speakerContext.notesExcerpt,
      blankHeadings: speakerContext.blankHeadings,
    };
  });
  let corpusActionDescriptions: string[] = [];
  let corpusActionSceneIds: string[] = [];
  try {
    const data = await invokeData(context, "semantic.search", { query: selectedText, mode: "sentence", limit: 12, rerank: false });
    const seenDescriptions = new Set<string>();
    for (const value of Array.isArray(data.results) ? data.results : []) {
      const hit = record(value);
      if (hit.sceneId === source.scene.id && hit.sentenceIndex === selection.sentenceIndex) continue;
      if (typeof hit.sceneId !== "string" || !hit.sceneId) continue;
      const description = typeof hit.snippet === "string" ? hit.snippet.trim() : typeof hit.text === "string" ? hit.text.trim() : "";
      if (!description || description === selectedText || seenDescriptions.has(description)) continue;
      seenDescriptions.add(description);
      corpusActionDescriptions.push(description);
      corpusActionSceneIds.push(hit.sceneId);
      if (corpusActionDescriptions.length === 3) break;
    }
  } catch { /* Corpus retrieval is optional, matching the source's best-effort index lookup. */ }
  const sentenceIndex = selection.sentenceIndex;
  const rewriteContext = {
    pov: typeof source.scene.raw.pov === "string" ? (() => {
      const pov = story.entities.get(source.scene.raw.pov);
      return { id: source.scene.raw.pov, ...(pov?.name ? { name: pov.name } : {}) };
    })() : null,
    intended_tone: source.scene.raw.intended_tone ?? source.scene.raw.intendedTone ?? null,
    character_voice_profiles: contextualCharacters,
    corpus_action_descriptions: corpusActionDescriptions,
  };
  const prompt = await composePrompt([
    "次の小説の一文について、意味を保った言い換えをちょうど3案生成してください。",
    "診断ではなく、ユーザーが明示的に依頼したリライトです。",
    `対象文（0始まりの文番号 ${sentenceIndex}）: ${selectedText}`,
    "シーン文脈:", JSON.stringify(rewriteContext, null, 2),
    `追加指示: ${input.instruction ?? "なし"}`,
    "各案では POV、意図されたトーン、キャラクター口調を可能な範囲で維持してください。",
    "自作品コーパスの所作描写がある場合は、tell→show の参考にしつつ文章をそのまま複製しないでください。",
    promptJson('{"suggestions":[{"text":"...","strategy":"concise","rationale":"..."},{"text":"...","strategy":"contextual","rationale":"..."},{"text":"...","strategy":"voice","rationale":"..."}]}'),
  ].join("\n"));
  const sampleSceneIds = [...new Set(dialogueSamples.flatMap(([, lines]) => lines.flatMap((line) => typeof line.sceneId === "string" ? [line.sceneId] : [])))];
  const profileSourcePaths = new Set<string>();
  for (const scene of story.entities.values()) {
    if (scene.type !== "scene") continue;
    profileSourcePaths.add(scene.filePath);
    if (typeof scene.raw.manuscript === "string") profileSourcePaths.add(scene.raw.manuscript);
  }
  const sourceRevisions = revisionList([...story.files.values()].filter((file) => profileSourcePaths.has(file.path) || file.path === source.scene.filePath || file.path === source.manuscript.path || relatedIds.some((id) => story.entities.get(id)?.filePath === file.path) || [...sampleSceneIds, ...corpusActionSceneIds].some((id) => {
    const scene = story.entities.get(id);
    return scene && (scene.filePath === file.path || String(scene.raw.manuscript ?? "") === file.path);
  })));
  let generated: GenerationResult | undefined;
  let providerFallback = false;
  try {
    generated = await generate(moduleContext, context, { feature: "rewrite", prompt, promptVersion: CUSTOM_PROMPT_VERSIONS.rewrite, sourceRevisions, outputTokens: 1_024, ...(onText ? { onText } : {}) });
  } catch (error) {
    const errorCode = typeof (error as { code?: unknown } | null)?.code === "string" ? String((error as { code: string }).code) : "";
    if (errorCode !== "assistant_provider_error") throw error;
    // Source rewrite retains its deterministic alternatives when an enabled provider call fails.
    // generate() has already recorded the failed attempt and fails closed on usage-store errors.
    providerFallback = true;
  }
  const povProfile = contextualCharacters.find((character) => character.role === "pov")?.voiceProfileExcerpt;
  const preferredFirstPerson = povProfile?.match(/^一人称:\s*([^\n]+)/mu)?.[1]?.split(/[、，,]/u)[0]?.trim();
  const fallback = buildRewriteFallbackSuggestions({
    sentence: selectedText,
    ...(typeof rewriteContext.intended_tone === "string" ? { intendedTone: rewriteContext.intended_tone } : {}),
    ...(preferredFirstPerson ? { preferredFirstPerson } : {}),
  }).map((candidate) => ({ ...candidate, source: "source-heuristic" as const }));
  const suggestions = uniqueRewriteCandidates([...(generated ? parseRewriteCandidates(generated.text) : []), ...fallback]);
  if (suggestions.length !== 3) throw codeError("assistant_output_invalid", "The rewrite provider and source fallback did not produce three distinct candidates");
  const local = buildRewriteLocalSuggestions(selectedText, corpusActionDescriptions);
  const selectedCitation = sourceCitation(source.manuscript, selectedText, source.scene.id, "selected passage");
  const citations = [selectedCitation];
  const sourceSentenceOffsets = splitIntoSentenceOffsets(source.body).filter((span) => source.body.slice(span.start, span.end).trim().length > 0);
  const resultProvenance = generated?.provenance ?? {
    snapshot: context.reader.snapshot,
    provider: "local",
    model: "scriptorium-rewrite-heuristics",
    modelVersion: "source-heuristic-v1",
    moduleVersion: ASSISTANT_MODULE_VERSION,
    promptVersion: `${CUSTOM_PROMPT_VERSIONS.rewrite}:local-fallback-v1`,
    generatedAt: new Date().toISOString(),
    sourceRevisions: revisionList([...story.files.values()].filter((file) => file.path === source.scene.filePath || file.path === source.manuscript.path || relatedIds.some((id) => story.entities.get(id)?.filePath === file.path) || [...sampleSceneIds, ...corpusActionSceneIds].some((id) => {
      const scene = story.entities.get(id);
      return scene && (scene.filePath === file.path || String(scene.raw.manuscript ?? "") === file.path);
    }))),
  };
  return {
    text: selectedText, originalSentence: source.body.slice(sourceSentenceOffsets[sentenceIndex]!.start, sourceSentenceOffsets[sentenceIndex]!.end).trim(), sentenceIndex, context: rewriteContext, prompt, suggestions, ...local, sceneId: source.scene.id,
    model: resultProvenance.model, provider: resultProvenance.provider,
    promptVersion: resultProvenance.promptVersion, ...(providerFallback ? { providerAttempt: { outcome: "failed", fallback: "source-heuristics" } } : {}), citations, provenance: resultProvenance,
  };
}

async function proposeRewrite(context: ModuleActionContext, input: ReturnType<typeof parseRewriteProposalInput>) {
  const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
  const source = sceneContext(story, input.sceneId);
  const rawBody = source.manuscript.content.slice(source.bodyOffset);
  const bodyStart = source.bodyOffset + rawBody.length - rawBody.trimStart().length;
  const selection = locateRewriteSelection(source.body, input.selectedText, input.sentenceIndex);
  const start = bodyStart + selection.offset;
  if (source.manuscript.content.slice(start, start + input.selectedText.length) !== input.selectedText) throw codeError("assistant_rewrite_selection_stale", "The selected sentence no longer matches the current manuscript snapshot");
  if (input.replacementText === input.selectedText) throw codeError("assistant_rewrite_selection_unchanged", "The selected candidate is unchanged");
  const updatedContent = `${source.manuscript.content.slice(0, start)}${input.replacementText}${source.manuscript.content.slice(start + input.selectedText.length)}`;
  const reads = [
    { path: source.scene.filePath, revision: story.files.get(source.scene.filePath)!.revision },
    { path: source.manuscript.path, revision: source.manuscript.revision },
  ];
  const operation = makeOperation(context, "manuscript", `Propose author-selected Assistant rewrite for ${source.scene.id}`, reads, [{ path: source.manuscript.path, revision: source.manuscript.revision, content: updatedContent }]);
  const proposal = await context.propose([operation], evidence(context, "assistant.rewrite.choice", reads, {
    sceneId: source.scene.id,
    selectedTextHash: sha256(input.selectedText),
    replacementTextHash: sha256(input.replacementText),
  }));
  return { sceneId: source.scene.id, selectedText: input.selectedText, replacementText: input.replacementText, proposal };
}

function readYamlObject(content: string): RecordValue | null {
  try { return record(YAML.parse(content)); } catch { return null; }
}

async function buildSceneSummaryPrompt(story: LoadedStorySnapshot, source: ReturnType<typeof sceneContext>) {
  const appearingIds = Array.isArray(source.scene.raw.appears) ? source.scene.raw.appears.filter((id): id is string => typeof id === "string") : [];
  const characterNames = [
    ...(typeof source.scene.raw.pov === "string" ? [source.scene.raw.pov] : []),
    ...appearingIds,
  ].flatMap((id) => {
    const name = story.entities.get(id)?.name;
    return typeof name === "string" && name.trim() ? [name.trim()] : [];
  });
  const knownCharacters = [...new Set(characterNames)];
  const prepared = await renderPromptTemplate("sceneSummary", {
    sceneId: source.scene.id,
    knownCharacters: knownCharacters.join("、") || "なし",
    manuscriptBody: source.body,
  });
  return {
    prompt: `${await composePrompt(prepared.body)}${promptJson('{"summaryLines":["...","...","..."],"characters":["..."],"stateChanges":["..."]}')}`,
    promptVersion: prepared.version,
    knownCharacters,
  };
}

async function reportProgress(context: ModuleActionContext, value: number): Promise<void> {
  if (context.reportProgress) await context.reportProgress(value);
}

async function buildChapterSummaryPrompt(chapterId: string, sceneRecords: readonly RecordValue[]) {
  const template = await renderPromptTemplate("chapterSummary", {
    chapterId,
    sceneBlocks: sceneRecords.map((item) => `## ${String(item.sceneId)}\n${Array.isArray(item.summaryLines) ? item.summaryLines.join("\n") : ""}`).join("\n\n"),
  });
  return {
    prompt: `${await composePrompt(template.body)}${promptJson('{"summaryLines":["...","...","..."]}')}`,
    promptVersion: template.version,
  };
}

async function buildReaderReactionPrompt(chapterId: string, cumulative: Array<{ chapterId: string; summaryLines: string[] }>) {
  const template = await renderPromptTemplate("firstReadReaction", {
    chapterId,
    blocks: cumulative.map((item) => `chapter_id: ${item.chapterId}\n${item.summaryLines.map((line) => `- ${line}`).join("\n")}`).join("\n\n") || "(要約なし)",
  });
  return {
    prompt: `${await composePrompt(template.body)}${promptJson('{"questions":["..."],"expectations":["..."],"confusions":["..."]}')}`,
    promptVersion: template.version,
  };
}

async function buildSynonymPrompt(request: SynonymRequest): Promise<string> {
  return composePrompt([
    request.reason
      ? `提案理由: ${request.reason}（地の文・セリフの言い換え候補として自然な語を選ぶ）`
      : "小説の地の文またはセリフで使える言い換え表現を提案する",
    "対象語句と文全体の意味・文体を保ち、言い換え語句を3〜5個出してください。",
    `対象語句: ${request.original}`, `文: ${request.sentence}`,
    promptJson('{"candidates":["...","...","..."]}'),
  ].join("\n"));
}

async function runSceneSummary(moduleContext: ModuleContext, context: ModuleActionContext, sceneId: string) {
  const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
  const source = sceneContext(story, sceneId);
  const outputPath = sceneSummaryPath(source.scene);
  const existing = await context.reader.read(outputPath);
  const current = existing ? readYamlObject(existing.content) : null;
  const sourceHash = fnv1aHash(source.body);
  const prepared = await buildSceneSummaryPrompt(story, source);
  if (current && current.sceneId === sceneId && current.sourceHash === sourceHash && current.promptVersion === prepared.promptVersion && typeof current.model === "string") {
    await reportProgress(context, 1);
    return { summary: current, stale: false, cached: true, model: current.model, promptVersion: current.promptVersion, citations: [makeCitation(source.manuscript, source.body, sceneId, "scene manuscript")], provenance: { snapshot: context.reader.snapshot, provider: current.provider, model: current.model, modelVersion: current.model, moduleVersion: ASSISTANT_MODULE_VERSION, promptVersion: prepared.promptVersion, generatedAt: current.generatedAt, sourceRevisions: [{ path: source.manuscript.path, revision: source.manuscript.revision }, { path: source.scene.filePath, revision: story.files.get(source.scene.filePath)!.revision }] } };
  }
  const sceneFile = story.files.get(source.scene.filePath)!;
  const sourceRevisions = [{ path: source.scene.filePath, revision: sceneFile.revision }, { path: source.manuscript.path, revision: source.manuscript.revision }];
  await reportProgress(context, 0.1);
  const generated = await generate(moduleContext, context, { feature: "scene-summary", prompt: prepared.prompt, promptVersion: prepared.promptVersion, sourceRevisions, outputTokens: 768 });
  await reportProgress(context, 0.9);
  const summary = parseStructured(generated.text, sceneSummarySchema);
  const recordValue = {
    sceneId, ...summary, characters: summary.characters.length ? summary.characters : prepared.knownCharacters, sourceHash, generatedAt: generated.provenance.generatedAt,
    provider: generated.provenance.provider, model: generated.provenance.model,
    modelVersion: generated.provenance.modelVersion, promptVersion: generated.provenance.promptVersion,
    snapshot: generated.provenance.snapshot,
  };
  const content = YAML.stringify(recordValue);
  const reads = [...sourceRevisions, readRevision(context, outputPath, existing?.revision ?? null), ...generated.provenance.sourceRevisions.filter((item) => item.path === ASSISTANT_SETTINGS_PATH)];
  const operation = makeOperation(context, "metadata", `Propose scene summary for ${sceneId}`, reads, [{ path: outputPath, revision: existing?.revision ?? null, content }]);
  const proposal = await context.propose([operation], evidence(context, "assistant.scene-summary", reads, { sceneId, model: generated.provenance.model, promptVersion: prepared.promptVersion }));
  await reportProgress(context, 1);
  const citations = [makeCitation(source.manuscript, source.body, sceneId, "scene manuscript")];
  return { summary: recordValue, stale: false, cached: false, model: generated.provenance.model, provider: generated.provenance.provider, promptVersion: prepared.promptVersion, citations, provenance: generated.provenance, proposal };
}

async function prepareSceneSummaryRecord(moduleContext: ModuleContext, context: ModuleActionContext, story: LoadedStorySnapshot, source: ReturnType<typeof sceneContext>) {
  const sceneId = source.scene.id;
  const outputPath = sceneSummaryPath(source.scene);
  const existing = await context.reader.read(outputPath);
  const current = existing ? readYamlObject(existing.content) : null;
  const sourceHash = fnv1aHash(source.body);
  const prepared = await buildSceneSummaryPrompt(story, source);
  const baseReads = [
    { path: source.scene.filePath, revision: story.files.get(source.scene.filePath)!.revision },
    { path: source.manuscript.path, revision: source.manuscript.revision },
    readRevision(context, outputPath, existing?.revision ?? null),
  ];
  if (current && current.sceneId === sceneId && current.sourceHash === sourceHash && current.promptVersion === prepared.promptVersion && typeof current.model === "string") {
    await reportProgress(context, 1);
    return { summary: current, cached: true, outputPath, existingRevision: existing!.revision, reads: baseReads, write: undefined as { path: string; revision: string | null; content: string } | undefined, generated: undefined as GenerationResult | undefined };
  }
  const sourceRevisions = baseReads.slice(0, 2);
  await reportProgress(context, 0.1);
  const generated = await generate(moduleContext, context, { feature: "scene-summary", prompt: prepared.prompt, promptVersion: prepared.promptVersion, sourceRevisions, outputTokens: 768 });
  await reportProgress(context, 0.9);
  const parsed = parseStructured(generated.text, sceneSummarySchema);
  const summary = {
    sceneId, ...parsed, characters: parsed.characters.length ? parsed.characters : prepared.knownCharacters, sourceHash, generatedAt: generated.provenance.generatedAt,
    provider: generated.provenance.provider, model: generated.provenance.model,
    modelVersion: generated.provenance.modelVersion, promptVersion: generated.provenance.promptVersion,
    snapshot: generated.provenance.snapshot,
  };
  return {
    summary, cached: false, outputPath, existingRevision: existing?.revision ?? null,
    reads: [...baseReads, ...generated.provenance.sourceRevisions.filter((item) => item.path === ASSISTANT_SETTINGS_PATH)],
    write: { path: outputPath, revision: existing?.revision ?? null, content: YAML.stringify(summary) }, generated,
  };
}

async function runChapterSummary(moduleContext: ModuleContext, context: ModuleActionContext, chapterId: string) {
  const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
  const { chapter, scenes } = chapterScenes(story, chapterId);
  if (!scenes.length) throw codeError("assistant_source_missing", `Chapter ${chapterId} has no manuscript scenes`);
  if (scenes.length > 30) throw codeError("assistant_scope_too_large", "Chapter summaries are limited to 30 scenes per request");
  const sceneRecords: Array<RecordValue> = [];
  const citations: SourceCitation[] = [];
  const reads: FileRevision[] = [];
  const writes: Array<{ path: string; revision: string | null; content: string }> = [];
  let latestSceneGeneration: GenerationResult | undefined;
  await reportProgress(context, 0.1);
  for (const [index, source] of scenes.entries()) {
    const sourceSummary = await prepareSceneSummaryRecord(moduleContext, context, story, source);
    sceneRecords.push(record(sourceSummary.summary));
    reads.push(...sourceSummary.reads);
    if (sourceSummary.write) writes.push(sourceSummary.write);
    if (sourceSummary.generated) latestSceneGeneration = sourceSummary.generated;
    citations.push(makeCitation(source.manuscript, source.body, source.scene.id, source.scene.name ?? "scene manuscript"));
    await reportProgress(context, 0.1 + 0.7 * ((index + 1) / scenes.length));
  }
  const chapterPath = chapterSummaryPath(chapter);
  const existingChapter = await context.reader.read(chapterPath);
  const childHash = fnv1aHash(sceneRecords.map((item) => String(item.sourceHash ?? "")).join("|"));
  const existingSummary = existingChapter ? readYamlObject(existingChapter.content) : null;
  if (existingSummary?.sourceHash === childHash && Array.isArray(existingSummary.summaryLines) && typeof existingSummary.model === "string") {
    await reportProgress(context, 1);
    return { summary: existingSummary, stale: false, cached: true, model: existingSummary.model, promptVersion: existingSummary.promptVersion, citations: citations.slice(0, 12), provenance: { snapshot: context.reader.snapshot, provider: existingSummary.provider, model: existingSummary.model, modelVersion: existingSummary.modelVersion ?? existingSummary.model, moduleVersion: ASSISTANT_MODULE_VERSION, promptVersion: existingSummary.promptVersion, generatedAt: existingSummary.generatedAt, sourceRevisions: revisionList([], [...reads, { path: chapterPath, revision: existingChapter!.revision }]) } };
  }
  const prepared = await buildChapterSummaryPrompt(chapterId, sceneRecords);
  await reportProgress(context, 0.85);
  const generated = await generate(moduleContext, context, { feature: "chapter-summary", prompt: prepared.prompt, promptVersion: prepared.promptVersion, sourceRevisions: revisionList([...story.files.values()].filter((file) => reads.some((item) => item.path === file.path))), outputTokens: 512 });
  const summary = parseStructured(generated.text, chapterSummarySchema);
  const recordValue = { scope: "chapter", id: chapterId, ...summary, sourceHash: childHash, generatedAt: generated.provenance.generatedAt, provider: generated.provenance.provider, model: generated.provenance.model, modelVersion: generated.provenance.modelVersion, promptVersion: prepared.promptVersion, snapshot: generated.provenance.snapshot };
  const operationReads = [...reads, readRevision(context, chapterPath, existingChapter?.revision ?? null), ...generated.provenance.sourceRevisions.filter((item) => item.path === ASSISTANT_SETTINGS_PATH), ...(latestSceneGeneration?.provenance.sourceRevisions.filter((item) => item.path === ASSISTANT_SETTINGS_PATH) ?? [])];
  const operationWrites = [...writes, { path: chapterPath, revision: existingChapter?.revision ?? null, content: YAML.stringify(recordValue) }];
  const operation = makeOperation(context, "metadata", `Propose chapter summary for ${chapterId}`, operationReads, operationWrites);
  const proposal = await context.propose([operation], evidence(context, "assistant.chapter-summary", operationReads, { chapterId, model: generated.provenance.model, promptVersion: prepared.promptVersion }));
  await reportProgress(context, 1);
  return { summary: recordValue, stale: false, cached: false, model: generated.provenance.model, provider: generated.provenance.provider, promptVersion: prepared.promptVersion, citations: citations.slice(0, 12), provenance: generated.provenance, proposal };
}

const qaAnswerSchema = z.object({
  answer: z.string(),
  citations: z.array(z.object({ kind: z.enum(["scene", "bible", "state", "summary"]), id: z.string().min(1), quote: z.string().min(1) })).max(24),
  confidence: z.enum(["high", "medium", "low"]),
});

function qaCitationKey(citation: { kind: string; id: string; quote: string }): string {
  return `${citation.kind}\0${citation.id}\0${citation.quote}`;
}

async function searchAssistantBible(context: ModuleActionContext, query: string, entityKind?: string): Promise<RecordValue> {
  const story = await readStorySnapshot(context.reader);
  // Source QA delegates to Core's hybrid search, then keeps only supported Bible types.
  // `semantic.search` is the public snapshot-bound producer for that search in this module set.
  const result = await invokeData(context, "semantic.search", { query, mode: "scene", limit: 12, rerank: false });
  const hits = Array.isArray(result.results) ? result.results.map((value) => record(value)) : [];
  const allowedTypes = new Set(["character", "location", "item", "faction", "lore", "thread", "event"]);
  const rows = hits.flatMap((hit) => {
    if (typeof hit.type !== "string" || !allowedTypes.has(hit.type) || (entityKind && hit.type !== entityKind)) return [];
    const id = typeof hit.entityId === "string" ? hit.entityId : typeof hit.sceneId === "string" ? hit.sceneId : undefined;
    if (!id) return [];
    const entityValue = story.entities.get(id);
    if (!entityValue || entityValue.type !== hit.type) return [];
    const file = story.files.get(entityValue.filePath);
    if (!file || (typeof hit.filePath === "string" && hit.filePath !== file.path)) return [];
    const name = entityValue.name ?? entityValue.id;
    const quote = typeof hit.snippet === "string" ? hit.snippet.trim() : typeof hit.text === "string" ? hit.text.trim() : name;
    if (!quote || (!file.content.includes(quote) && quote !== name && !(entityValue.aliases ?? []).includes(quote))) return [];
    return [{
      id,
      type: entityValue.type,
      name,
      snippet: quote.slice(0, 400),
      path: file.path,
      revision: file.revision,
      ...(typeof hit.score === "number" ? { score: hit.score } : {}),
    }];
  });
  return { results: rows.slice(0, 8) };
}

async function readAssistantSummary(context: ModuleActionContext, scope: "scene" | "chapter" | "volume", id: string): Promise<RecordValue | null> {
  const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
  let outputPath: string | undefined;
  if (scope === "scene") {
    const scene = story.entities.get(id);
    if (scene?.type === "scene") outputPath = sceneSummaryPath(scene);
  } else if (scope === "chapter") {
    const chapter = story.entities.get(id);
    if (chapter?.type === "chapter") outputPath = chapterSummaryPath(chapter);
  } else {
    const volume = story.entities.get(id);
    if (volume?.type === "volume") outputPath = `${path.posix.dirname(volume.filePath)}/volume-summary.yaml`;
  }
  if (!outputPath) return null;
  const file = await context.reader.read(outputPath);
  if (!file) return null;
  const summary = readYamlObject(file.content);
  if (!summary || !Array.isArray(summary.summaryLines)) return null;
  if (summary.scope !== undefined && summary.scope !== scope) return null;
  if (summary.id !== undefined && summary.id !== id && summary.sceneId !== id) return null;
  if (scope === "scene") {
    const scene = story.entities.get(id)!;
    const source = sceneContext(story, id);
    if (summary.sourceHash !== fnv1aHash(source.body)) return null;
  }
  const lines = summary.summaryLines.filter((line): line is string => typeof line === "string");
  return { scope, id, summaryLines: lines.slice(0, 12), path: outputPath, revision: file.revision };
}

async function buildContinuationPrompt(contextBlock: string) {
  const template = await renderPromptTemplate("continuationOptions", {});
  const contextText = contextBlock.trim()
    ? `【文脈（直近の文と章要約。これ以外は見ない）】\n${contextBlock.trim()}`
    : "【文脈】（空 — 一般的な展開の方向のみ提案）";
  return {
    prompt: `${await composePrompt(`${template.body}\n\n${contextText}`)}${promptJson('{"options":[{"direction":"...","rationale":"..."},{"direction":"...","rationale":"..."},{"direction":"...","rationale":"..."}]}')}`,
    promptVersion: template.version,
  };
}

async function buildQaSystemPrompt(manuscriptBody: string) {
  const template = await renderPromptTemplate("settingQa", { manuscriptBody: manuscriptBody || "（関連シーンは指定されていません）" });
  return {
    system: `${await composePrompt(template.body)}\n\n読み取り専用ツールだけで事実を確認してください。回答はJSONオブジェクト1つで、answer、citations、confidenceを含めてください。citationsはツールが返した kind/id/quote の値をそのまま使い、根拠が無い回答は断定せず citations を空にしてください。confidenceは high / medium / low のいずれかです。`,
    promptVersion: template.version,
  };
}

async function runQa(
  moduleContext: ModuleContext,
  context: ModuleActionContext,
  input: { messages: AssistantChatMessage[]; sceneId?: string },
  onText?: (delta: string) => void | Promise<void>,
) {
  const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
  const manuscriptBody = input.sceneId ? sceneContext(story, input.sceneId).body : "";
  const prepared = await buildQaSystemPrompt(manuscriptBody);
  const system = prepared.system;
  const verifiedToolCitations = new Map<string, SourceCitation & { kind: string; id: string }>();
  const tools = createAssistantQaTools({
    semanticSearch: async (search) => {
      // A selected scene adds manuscript context to the system prompt; source QA
      // still searches the full corpus for supporting evidence.
      return invokeData(context, "semantic.search", search);
    },
    searchBible: (query, entityKind) => searchAssistantBible(context, query, entityKind),
    worldStateAtScene: async ({ sceneId }) => {
      const state = await invokeData(context, "story.world-state.at-scene", { sceneId });
      const scene = story.entities.get(sceneId);
      const source = scene?.type === "scene" ? story.files.get(scene.filePath) : undefined;
      const quote = JSON.stringify(state).slice(0, 400);
      return { ...state, citation: { path: source?.path, revision: source?.revision, quote } };
    },
    readSummary: (query) => readAssistantSummary(context, query.scope, query.id),
  }, undefined, (toolName, _toolInput, result) => {
    const rows = Array.isArray(result) ? result : [result];
    for (const value of rows) {
      const row = value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
      if (!row || typeof row.id !== "string" || typeof row.quote !== "string" || !row.quote.trim()) continue;
      const kind = typeof row.kind === "string" ? row.kind : toolName === "searchBible" ? "bible" : "scene";
      if (!["scene", "bible", "state", "summary"].includes(kind)) continue;
      const citation = record(row.citation ?? {});
      let pathValue = typeof citation.path === "string" ? citation.path : undefined;
      let revisionValue = typeof citation.revision === "string" ? citation.revision : undefined;
      if ((!pathValue || !revisionValue) && (kind === "scene" || kind === "state")) {
        const scene = story.entities.get(row.id);
        const source = scene?.type === "scene" ? story.files.get(kind === "scene" ? String(scene.raw.manuscript ?? "") : scene.filePath) : undefined;
        pathValue = source?.path;
        revisionValue = source?.revision;
      }
      if (pathValue && revisionValue) verifiedToolCitations.set(qaCitationKey({ kind, id: row.id, quote: row.quote }), {
        kind, id: row.id, quote: row.quote, path: pathValue, revision: revisionValue,
        ...(kind === "scene" || kind === "state" ? { sceneId: row.id } : {}),
        label: `${toolName} result`,
      });
    }
  });
  const generation = await generate(moduleContext, context, {
    feature: "setting-qa", system, messages: input.messages as ModelMessage[], tools, maxToolSteps: SETTING_QA_MAX_STEPS,
    promptVersion: prepared.promptVersion, sourceRevisions: [
      ...(input.sceneId ? [{ path: sceneContext(story, input.sceneId).manuscript.path, revision: sceneContext(story, input.sceneId).manuscript.revision }] : []),
    ], outputTokens: 1_024, ...(onText ? { onText } : {}),
  });
  const parsed = parseStructured(generation.text, qaAnswerSchema);
  const citations = parsed.citations.flatMap((item) => {
    const found = verifiedToolCitations.get(qaCitationKey(item));
    return found ? [found] : [];
  }).filter((item, index, all) => all.findIndex((candidate) => qaCitationKey(candidate) === qaCitationKey(item)) === index).slice(0, 12);
  const answer = citations.length ? parsed.answer : "このスナップショット内の読み取り専用ツール結果からは裏付けられませんでした。";
  const provenance = { ...generation.provenance, sourceRevisions: revisionList([], [...generation.provenance.sourceRevisions, ...citationPaths(citations)]) };
  return { answer, citations, confidence: citations.length ? parsed.confidence : "low", model: generation.provenance.model, provider: generation.provenance.provider, promptVersion: generation.provenance.promptVersion, provenance };
}

async function runContinuation(moduleContext: ModuleContext, context: ModuleActionContext, input: ContinuationInput) {
  const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
  const source = input.sceneId ? sceneContext(story, input.sceneId) : undefined;
  const sceneFile = source ? story.files.get(source.scene.filePath) : undefined;
  if (source && input.editorDraft) assertEditorDraftBase(context, source, sceneFile?.revision ?? null, input.editorDraft);
  const recentSentences = input.editorDraft
    ? splitIntoSentences(input.editorDraft.text).slice(-12)
    : input.recentSentences?.length ? input.recentSentences : source ? splitIntoSentences(source.body) : [];
  let chapter = input.chapterId ? story.entities.get(input.chapterId) : undefined;
  if (source) {
    const sourceChapterId = typeof source.scene.raw.chapter === "string" ? source.scene.raw.chapter : story.links.find((link) => link.from === source.scene.id && link.kind === "chapter")?.to;
    if (input.editorDraft && input.chapterId && sourceChapterId && input.chapterId !== sourceChapterId) {
      throw codeError("assistant_editor_draft_stale", "The selected chapter does not match the current editor scene");
    }
    if (sourceChapterId) chapter = story.entities.get(sourceChapterId);
  }
  const chapterSummary = chapter?.type === "chapter" ? await readAssistantSummary(context, "chapter", chapter.id) : null;
  let retrievalHits: ReturnType<typeof normalizeContinuationRetrievalHits> = [];
  const retrievalQuery = buildContinuationRetrievalQuery(recentSentences);
  if (retrievalQuery) {
    try {
      const result = await invokeData(context, "semantic.search", { query: retrievalQuery, mode: "scene", limit: 5, rerank: false });
      retrievalHits = normalizeContinuationRetrievalHits((Array.isArray(result.results) ? result.results : []).map((value) => record(value) as { sceneId: string; entityId?: string | null; snippet?: string | null; text?: string | null }));
    } catch { /* The pinned route treats retrieval as best-effort. */ }
  }
  const tokenTexts = new Set<string>(["\n\n", ...(chapterSummary ? [String(chapterSummary.summaryLines instanceof Array ? chapterSummary.summaryLines.join("\n").trim() : "")] : []), ...retrievalHits.map((hit) => hit.text)]);
  for (let count = 1; count <= Math.min(input.k, recentSentences.length); count += 1) tokenTexts.add(recentSentences.slice(-count).join("\n"));
  let tokenizerModelId: string | undefined;
  try {
    const preferences = (await readAssistantSettings(context.reader)).settings;
    tokenizerModelId = resolveAssistantModel("continuation-options", preferences)?.model;
  } catch { /* The provider settings remain optional and contain no credentials. */ }
  const tokenTextsInOrder = [...tokenTexts];
  const counted = await invokeData(context, "nlp.countTokens", { texts: tokenTextsInOrder, ...(tokenizerModelId ? { modelId: tokenizerModelId } : {}) });
  const counts = counted.counts;
  const counter = record(counted.counter, "NLP token counter identity");
  if (!counted.snapshot || snapshotKey(counted.snapshot as SnapshotId) !== snapshotKey(context.reader.snapshot)) {
    throw codeError("assistant_token_counter_snapshot_mismatch", "The NLP token counter returned a result for a different snapshot");
  }
  if (!Array.isArray(counts) || counts.length !== tokenTextsInOrder.length || counts.some((item) => !Number.isSafeInteger(item) || (item as number) < 0)) {
    throw codeError("assistant_token_counter_invalid", "The NLP token counter returned invalid counts");
  }
  if (typeof counter.exact !== "boolean" || typeof counter.modelId !== "string" || !counter.modelId || typeof counter.engine !== "string" || typeof counter.engineVersion !== "string") {
    throw codeError("assistant_token_counter_invalid", "The NLP token counter returned an invalid identity");
  }
  if (counter.exact && tokenizerModelId !== undefined && counter.modelId !== tokenizerModelId) {
    throw codeError("assistant_token_counter_model_mismatch", "The NLP token counter measured a different model than the selected continuation model");
  }
  const tokenCounts = new Map(tokenTextsInOrder.map((text, index) => [text, counts[index] as number]));
  const built = buildContinuationContext({
    recentSentences, k: input.k, chapterSummary: chapterSummary ? { chapterId: String(chapterSummary.id), text: Array.isArray(chapterSummary.summaryLines) ? chapterSummary.summaryLines.join("\n") : "" } : null,
    retrievalHits, tokenBudget: input.tokenBudget,
    countTokens: (text) => {
      const count = tokenCounts.get(text);
      if (count === undefined) throw new Error("Token counter response did not include an assembled continuation section");
      return count;
    },
  });
  const prepared = await buildContinuationPrompt(built.text);
  const sourceRevisions = revisionList([
    ...(source ? [sceneFile!, source.manuscript] : []),
    ...(chapter?.type === "chapter" && typeof chapterSummary?.path === "string" && typeof chapterSummary.revision === "string" ? [{ path: chapterSummary.path, revision: chapterSummary.revision, content: "" }] : []),
    ...retrievalHits.flatMap((hit) => { const row = story.entities.get(hit.entityId); const file = row ? story.files.get(row.filePath) : undefined; return file ? [file] : []; }),
  ]);
  const generated = await generate(moduleContext, context, { feature: "continuation-options", prompt: prepared.prompt, promptVersion: prepared.promptVersion, sourceRevisions, outputTokens: 768 });
  const result = parseStructured(generated.text, continuationSchema);
  const editorQuote = recentSentences.join("\n").slice(-1_200);
  const citations: SourceCitation[] = input.editorDraft
    ? [{
      path: input.editorDraft.documentPath,
      revision: input.editorDraft.documentRevision ?? input.editorDraft.sceneRevision,
      quote: editorQuote,
      sceneId: input.editorDraft.sceneId,
      label: "current editor draft",
      revisionKind: input.editorDraft.documentRevision === null ? "editor-scene" : "editor-document",
      snapshot: input.editorDraft.snapshot,
    }]
    : source ? [makeCitation(source.manuscript, source.body, source.scene.id, "scene manuscript")] : [];
  const provenance = {
    ...generated.provenance,
    ...(input.editorDraft ? { editorDraft: {
      documentPath: input.editorDraft.documentPath,
      documentRevision: input.editorDraft.documentRevision,
      sceneRevision: input.editorDraft.sceneRevision,
      snapshot: input.editorDraft.snapshot,
      baseSnapshot: input.editorDraft.baseSnapshot,
      baseSceneRevision: input.editorDraft.baseSceneRevision,
    } } : {}),
  };
  return {
    ...result, sceneId: input.sceneId, chapterId: chapter?.id,
    contextManifest: { ...built.manifest, tokenCountMode: counter.exact ? "provided" : "approximate", tokenCounter: {
      modelId: counter.modelId,
      exact: counter.exact,
      engine: counter.engine,
      engineVersion: counter.engineVersion,
      ...(typeof counter.requestedModelId === "string" ? { requestedModelId: counter.requestedModelId } : {}),
      ...(typeof counter.fallbackReason === "string" ? { fallbackReason: counter.fallbackReason } : {}),
    } },
    prompt: prepared.prompt, model: generated.provenance.model, provider: generated.provenance.provider, promptVersion: generated.provenance.promptVersion,
    citations, provenance,
  };
}

async function runAspectReview(context: ModuleActionContext, input: { chapterId: string; aspects: AspectId[] }) {
  const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
  const { chapter, scenes } = chapterScenes(story, input.chapterId);
  if (!scenes.length) throw codeError("assistant_source_missing", `Chapter ${input.chapterId} has no manuscript scenes`);
  await reportProgress(context, 0.1);
  const reviewScenes = scenes.map(({ scene, body }) => {
    const povId = story.links.find((link) => link.from === scene.id && link.kind === "pov")?.to;
    const povName = povId ? story.entities.get(povId)?.name : undefined;
    return {
      sceneId: scene.id,
      sceneTitle: typeof scene.raw.title === "string" ? scene.raw.title : scene.name ?? scene.id,
      body,
      ...(povId ? { povId } : {}),
      ...(povName ? { povName } : {}),
    };
  });
  await reportProgress(context, 0.4);
  const result = runDeterministicAspectReview(
    input.chapterId,
    chapter.name ?? (typeof chapter.raw.title === "string" ? chapter.raw.title : input.chapterId),
    reviewScenes,
    input.aspects,
  );
  await reportProgress(context, 1);
  return result;
}

async function buildDialogueTopicsPrompt(context: ModuleActionContext, input: { participantEntityIds: string[] }) {
  const story = await readStorySnapshot(context.reader);
  const participantIds = input.participantEntityIds;
  if (participantIds.length < 2 || participantIds.length > 8) throw codeError("assistant_dialogue_participants_invalid", "Dialogue topic suggestions require two to eight participants");
  const participantEntities = participantIds.map((id) => entity(story, id));
  if (participantEntities.some((item) => item.type !== "character")) throw codeError("assistant_dialogue_participants_invalid", "Dialogue participants must be character entities");
  const participants = participantEntities.map((item) => ({ id: item.id, name: item.name ?? item.id }));
  const nameById = Object.fromEntries(participants.map((item) => [item.id, item.name]));
  const pairs: Array<{ a: string; b: string; label: string }> = [];
  const seenRelations = new Set<string>();
  const participantSet = new Set(participantIds);
  const addPairRelation = (a: string, b: string, kind: string, note?: string) => {
    if (!participantSet.has(a) || !participantSet.has(b) || a === b) return;
    const normalizedKind = kind.trim();
    const normalizedNote = note?.trim();
    const label = normalizedKind && normalizedNote ? `${normalizedKind}: ${normalizedNote}` : normalizedNote || normalizedKind || "related";
    const key = `${a}\0${b}\0${label}`;
    if (seenRelations.has(key)) return;
    seenRelations.add(key);
    pairs.push({ a, b, label });
  };
  for (const id of participantIds) {
    const participant = story.entities.get(id);
    if (participant?.type !== "character" || !Array.isArray(participant.raw.relations)) continue;
    for (const rawRelation of participant.raw.relations) {
      const relation = record(rawRelation, "character relation");
      if (relation.auto === true || typeof relation.target !== "string" || !relation.target) continue;
      if (story.entities.get(relation.target)?.type !== "character") continue;
      addPairRelation(id, relation.target, typeof relation.kind === "string" ? relation.kind : "related", typeof relation.note === "string" ? relation.note : undefined);
    }
  }
  for (const link of story.links) {
    if (link.kind !== "related") continue;
    addPairRelation(link.from, link.to, "related", link.note);
  }
  const pairLines = pairs.length ? pairs.map((item) => `- ${nameById[item.a]} ↔ ${nameById[item.b]}: ${item.label}`).join("\n") : "（関係ラベル未登録 — 参加者の対比・緊張を想像してよい）";
  const prompt = await composePrompt([
    "あなたは小説のセリフ問答（SS）用お題の提案者です。",
    "参加キャラの関係性ラベルを種に、対比・緊張・親密さが際立つお題を3〜5個提案してください。",
    "各お題は title（タイトル）と situation（場面設定）の組で構成してください。",
    "title は名詞で終わる体言止めの短いタイトル（例:「エレベーター閉じ込め」「すれ違う本音」）。",
    "title の文末を「〜する」「〜られる」のような用言で終わらせないこと。",
    "situation は場所・時間・状況を1文で具体的に（例:「停電した夜のオフィスビル、二人きりのエレベーターの中」）。",
    "セリフ・地の文・説明文は禁止。",
    `参加者: ${participants.map((item) => `${item.name} (${item.id})`).join("、")}`,
    `関係種:\n${pairLines}`,
    promptJson('{"topics":[{"title":"...","situation":"..."},{"title":"...","situation":"..."},{"title":"...","situation":"..."}]}'),
  ].join("\n"));
  const sourceRevisions = revisionList(participantEntities.map((participant) => story.files.get(participant.filePath)!).filter(Boolean));
  const citations = participantEntities.map((participant) => {
    const file = story.files.get(participant.filePath)!;
    return sourceCitation(file, file.content.slice(0, 300), undefined, `${participant.name ?? participant.id} profile`);
  });
  return { prompt, sourceRevisions, citations, participantEntityIds: participantIds };
}

async function runDialogueTopics(moduleContext: ModuleContext, context: ModuleActionContext, input: { participantEntityIds: string[] }) {
  const prepared = await buildDialogueTopicsPrompt(context, input);
  const generated = await generate(moduleContext, context, { feature: "dialogue-sketch", prompt: prepared.prompt, promptVersion: CUSTOM_PROMPT_VERSIONS.dialogueTopics, sourceRevisions: prepared.sourceRevisions, outputTokens: 32_768 });
  const parsed = parseStructured(generated.text, topicsSchema);
  return { topics: parsed.topics, participantEntityIds: prepared.participantEntityIds, prompt: prepared.prompt, model: generated.provenance.model, provider: generated.provenance.provider, promptVersion: generated.provenance.promptVersion, citations: prepared.citations, provenance: generated.provenance };
}

function cleanShort(value: unknown, limit = 2_000): string { return typeof value === "string" ? value.trim().slice(0, limit) : ""; }

async function readDialogueParticipants(story: LoadedStorySnapshot, participantIds: string[], context: ModuleActionContext) {
  let speakerProfiles: PublicSpeakerVoiceProfilesDto | undefined;
  try { speakerProfiles = await invokeData(context, "speaker.voice.profiles", {}) as unknown as PublicSpeakerVoiceProfilesDto; }
  catch { /* The source index is optional; normalized YAML voice notes remain usable. */ }
  return Promise.all(participantIds.map(async (id) => {
    const participant = entity(story, id);
    if (participant.type !== "character") throw codeError("assistant_dialogue_participants_invalid", "Dialogue participants must be character entities");
    let dialogues: PublicSpeakerDialogueListDto | undefined;
    try { dialogues = await invokeData(context, "speaker.dialogue.list", { characterId: id, limit: 6, minConfidence: "high" }) as unknown as PublicSpeakerDialogueListDto; }
    catch { /* Keep the source's best-effort behavior if the speaker index is absent. */ }
    return {
      participant,
      speaker: buildDialogueSketchSpeakerContext({ entityId: id, name: participant.name, raw: participant.raw, speakerDialogues: dialogues, speakerProfiles }),
      dialogues,
    };
  }));
}

async function buildDialogueTurnPrompt(context: ModuleActionContext, input: DialogueTurnInput) {
  const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
  const participants = await readDialogueParticipants(story, input.participantEntityIds, context);
  if (input.sketchId) {
    const sketch = entity(story, input.sketchId);
    if (sketch.type !== "dialogue_sketch") throw codeError("assistant_source_missing", `Dialogue sketch ${input.sketchId} was not found`);
    const savedIds = Array.isArray(sketch.raw.participantEntityIds) ? sketch.raw.participantEntityIds.filter((id): id is string => typeof id === "string") : [];
    if (savedIds.length && savedIds.some((id) => !input.participantEntityIds.includes(id))) throw codeError("assistant_source_stale", "Selected dialogue participants do not match the saved sketch");
  }
  const nameById = Object.fromEntries(participants.map(({ participant }) => [participant.id, participant.name ?? participant.id]));
  const precedingLines = input.precedingLines.slice(-24);
  const precedingText = precedingLines.map((line) => `${nameById[line.speakerEntityId] ?? line.speakerEntityId}: ${line.text}`).join("\n") || "(まだセリフなし)";
  const topic = cleanShort(input.topic) || "（白紙）";
  const situation = cleanShort(input.situation) || "（白紙）";
  const profileFiles = [
    ...participants.map(({ participant }) => story.files.get(participant.filePath)!).filter(Boolean),
    ...(input.sketchId ? [story.files.get(entity(story, input.sketchId).filePath)!].filter(Boolean) : []),
  ];
  const dialogueSources = participants.flatMap(({ dialogues }) => (dialogues?.lines ?? []).slice(0, 6).flatMap((line) => {
    const scene = story.entities.get(line.sceneId);
    if (scene?.type !== "scene") return [];
    try {
      const source = sceneContext(story, scene.id);
      return source.body.includes(line.text) ? [{ file: source.manuscript, sceneId: scene.id, quote: line.text }] : [];
    } catch { return []; }
  }));
  const sourceFiles = [...profileFiles, ...dialogueSources.map((item) => item.file)];
  const sourceRevisions = revisionList(sourceFiles);
  const citations = [
    ...profileFiles.map((file) => sourceCitation(file, file.content.slice(0, 300), undefined, "dialogue context")),
    ...dialogueSources.map((item) => sourceCitation(item.file, item.quote, item.sceneId, "confirmed dialogue example")),
  ];
  const single = input.speakerEntityId !== undefined;
  const lineCount = single ? 1 : input.lineCount!;
  let template: { version: string; body: string };
  let prompt: string;
  if (single) {
    const selected = participants.find(({ participant }) => participant.id === input.speakerEntityId)!.speaker;
    const voiceBlock = selected.voiceProfileExcerpt?.trim() || "（未登録 — 図鑑ノートと本編セリフ例を優先すること）";
    const fp = selected.fingerprintSummary;
    const fingerprintBlock = fp ? `\n本編セリフ統計（参考）:\n- 分析セリフ数: ${fp.dialogueCount}\n- 一人称の多い語: ${fp.topFirstPersons.join("、") || "（なし）"}\n- 語尾の多い型: ${fp.topEndings.join("、") || "（なし）"}\n- 敬体率: ${fp.politeRatio.toFixed(2)} / 平均文字数: ${Math.round(fp.avgDialogueLength)} / 感嘆率: ${fp.exclamationRate.toFixed(2)} / 疑問率: ${fp.questionRate.toFixed(2)}` : "";
    const blankHeadingsBlock = selected.blankHeadings.length ? `\n図鑑の未記入項目（余裕があれば話題に絡めてよい。無理に触れなくてよい）:\n${selected.blankHeadings.join("、")}` : "";
    template = await renderPromptTemplate("dialogueSketchLine", {
      speakerName: selected.name, voiceBlock, fingerprintBlock,
      notesExcerpt: selected.notesExcerpt?.trim() || "（なし）", blankHeadingsBlock,
      exampleDialogues: selected.exampleDialogues.length ? selected.exampleDialogues.map((line) => `- ${line}`).join("\n") : "（なし）",
      otherParticipants: participants.filter(({ participant }) => participant.id !== input.speakerEntityId).map(({ speaker }) => speaker.name).join("、") || "なし",
      topic, situation, precedingLines: precedingText,
    });
    prompt = `${await composePrompt(template.body)}${promptJson('{"text":"..."}')}`;
  } else {
    const roster = participants.map(({ speaker }) => {
      const voiceBlock = speaker.voiceProfileExcerpt?.trim() || "（未登録 — 図鑑ノートと本編セリフ例を優先すること）";
      const fp = speaker.fingerprintSummary;
      const fingerprintLines = fp ? ["本編セリフ統計（参考）:", `- 分析セリフ数: ${fp.dialogueCount}`, `- 一人称の多い語: ${fp.topFirstPersons.join("、") || "（なし）"}`, `- 語尾の多い型: ${fp.topEndings.join("、") || "（なし）"}`, `- 敬体率: ${fp.politeRatio.toFixed(2)} / 平均文字数: ${Math.round(fp.avgDialogueLength)} / 感嘆率: ${fp.exclamationRate.toFixed(2)} / 疑問率: ${fp.questionRate.toFixed(2)}`] : [];
      return [`### ${speaker.name}（id: ${speaker.entityId}）`, "口調・声紋（厳守）:", voiceBlock, ...fingerprintLines, "図鑑ノート:", speaker.notesExcerpt?.trim() || "（なし）", "本編の確定帰属セリフ例:", speaker.exampleDialogues.length ? speaker.exampleDialogues.map((line) => `- ${line}`).join("\n") : "（なし）"].join("\n");
    }).join("\n\n");
    template = await renderPromptTemplate("dialogueSketchLines", { lineCount: String(lineCount), speakerRoster: roster, topic, situation, precedingLines: precedingText });
    const rows = Array.from({ length: lineCount }, () => '{"speakerEntityId":"participant-id","text":"..."}').join(",");
    prompt = `${await composePrompt(template.body)}${promptJson(`{"lines":[${rows}]}`)}`;
  }
  return {
    prompt,
    promptVersion: single ? CUSTOM_PROMPT_VERSIONS.dialogueTurn : template.version,
    sourceRevisions,
    citations,
    single,
    lineCount,
    participantEntityIds: input.participantEntityIds,
    ...(input.speakerEntityId ? { speakerEntityId: input.speakerEntityId } : {}),
    ...(input.sketchId ? { sketchId: input.sketchId } : {}),
  };
}

async function runDialogueTurns(moduleContext: ModuleContext, context: ModuleActionContext, input: DialogueTurnInput) {
  const prepared = await buildDialogueTurnPrompt(context, input);
  const generated = await generate(moduleContext, context, {
    feature: "dialogue-sketch-turn", prompt: prepared.prompt, promptVersion: prepared.promptVersion,
    sourceRevisions: prepared.sourceRevisions, outputTokens: prepared.single ? 256 : 4_096,
  });
  const { single, lineCount, citations } = prepared;
  const prompt = prepared.prompt;
  const allowed = new Set(input.participantEntityIds);
  let lines: Array<{ speakerEntityId: string; text: string }>;
  if (single) {
    const parsed = parseStructured(generated.text, dialogueLineResponseSchema);
    lines = [{ speakerEntityId: prepared.speakerEntityId!, text: parsed.text.trim().replace(/^[「『]|[」』]$/g, "").trim() }];
  } else {
    const parsed = parseStructured(generated.text, dialogueLinesSchema);
    lines = parsed.lines.slice(0, lineCount).map((line) => ({ ...line, text: line.text.trim().replace(/^[「『]|[」』]$/g, "").trim() }));
  }
  if (lines.some((line) => !allowed.has(line.speakerEntityId) || !line.text)) throw codeError("assistant_output_invalid", "Dialogue output included an invalid speaker or empty line");
  if (lines.length !== lineCount) throw codeError("assistant_output_invalid", `Dialogue output must contain ${lineCount} lines`);
  return { lines, ...(single ? { text: lines[0]!.text } : {}), ...(prepared.sketchId ? { sketchId: prepared.sketchId } : {}), participantEntityIds: prepared.participantEntityIds, prompt, model: generated.provenance.model, provider: generated.provenance.provider, promptVersion: generated.provenance.promptVersion, citations, provenance: generated.provenance };
}

async function buildReaderReactionContext(context: ModuleActionContext, chapterId: string) {
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
    const chapterPath = chapterSummaryPath(chapter);
    const chapterFile = await context.reader.read(chapterPath);
    const chapterSummary = chapterFile ? readYamlObject(chapterFile.content) : null;
    // Source reader-reaction semantics skip chapters without an accepted chapter summary.
    // When a summary is present, bind it to the current ordered manuscript snapshot so a
    // stale accepted record is never sent to an external provider as reader context.
    if (!chapterSummary || chapterSummary.id !== chapter.id || !Array.isArray(chapterSummary.summaryLines) || chapterSummary.summaryLines.length === 0) continue;
    const currentChildHash = fnv1aHash(scenes.map((scene) => fnv1aHash(scene.body)).join("|"));
    if (chapterSummary.sourceHash !== currentChildHash) throw codeError("assistant_summary_stale", `Accepted summary for chapter ${chapter.id} is stale for this manuscript snapshot`);
    for (const scene of scenes) sourceRevisions.push({ path: scene.scene.filePath, revision: story.files.get(scene.scene.filePath)!.revision }, { path: scene.manuscript.path, revision: scene.manuscript.revision });
    sourceRevisions.push({ path: chapterPath, revision: chapterFile!.revision });
    cumulative.push({ chapterId: chapter.id, summaryLines: (chapterSummary.summaryLines as unknown[]).filter((line): line is string => typeof line === "string") });
    citations.push(sourceCitation({ ...chapterFile!, path: chapterPath }, chapterSummary.summaryLines.join("\n"), chapter.id, "accepted chapter summary"));
  }
  const prepared = await buildReaderReactionPrompt(chapterId, cumulative);
  return { ...prepared, citations, sourceRevisions: revisionList([], sourceRevisions) };
}

async function runReaderReaction(moduleContext: ModuleContext, context: ModuleActionContext, chapterId: string) {
  const prepared = await buildReaderReactionContext(context, chapterId);
  const generated = await generate(moduleContext, context, { feature: "first-read-reaction", prompt: prepared.prompt, promptVersion: prepared.promptVersion, sourceRevisions: prepared.sourceRevisions, outputTokens: 768 });
  const reaction = parseStructured(generated.text, reactionSchema);
  return { chapterId, ...reaction, model: generated.provenance.model, provider: generated.provenance.provider, promptVersion: generated.provenance.promptVersion, citations: prepared.citations, provenance: generated.provenance };
}

async function runSynonyms(moduleContext: ModuleContext, context: ModuleActionContext, input: { suggestions: SynonymRequest[] }) {
  const suggestions: Array<RecordValue> = [];
  let last: GenerationResult | undefined;
  for (const request of input.suggestions) {
    const prompt = await buildSynonymPrompt(request);
    const generated = await generate(moduleContext, context, { feature: "synonym-suggest", prompt, promptVersion: CUSTOM_PROMPT_VERSIONS.synonym, outputTokens: 512 });
    last = generated;
    const parsed = parseStructured(generated.text, synonymSchema);
    const candidates = [...new Set(parsed.candidates.map((candidate) => candidate.trim()).filter((candidate) => candidate && candidate !== request.original))].slice(0, 5);
    if (!candidates.length) throw codeError("assistant_output_invalid", "The model returned no usable synonym candidates");
    suggestions.push({ term: request.original, sentence: request.sentence, ...(request.reason ? { reason: request.reason } : {}), candidates, prompt, model: generated.provenance.model, provider: generated.provenance.provider, promptVersion: generated.provenance.promptVersion, citations: [], provenance: generated.provenance });
  }
  return { suggestions, model: last?.provenance.model ?? null, provider: last?.provenance.provider ?? null, promptVersion: last?.provenance.promptVersion ?? CUSTOM_PROMPT_VERSIONS.synonym, provenance: last?.provenance ?? null };
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
  const generated = await generate(moduleContext, context, { feature: "contradiction-check", prompt, promptVersion: `${CUSTOM_PROMPT_VERSIONS.contradiction}:${evidenceHash}`, sourceRevisions, outputTokens: 1_024 });
  const parsed = parseStructured(generated.text, contradictionSchema);
  const allowedQuotes = new Set(grounded.map((item) => item.quote));
  const citations = grounded.map(({ source, quote }, index) => sourceCitation(source.manuscript, quote, source.scene.id, `evidence ${index + 1}`));
  return { ...(candidateId ? { candidateId } : { candidate: claim }), verdict: parsed.verdict, reason: parsed.reason, quotes: parsed.quotes.filter((quote) => allowedQuotes.has(quote)), model: generated.provenance.model, provider: generated.provenance.provider, promptVersion: generated.provenance.promptVersion, citations, provenance: generated.provenance };
}

interface ZukanInput {
  source: "manuscript" | "sandbox";
  entityId?: string;
  blockPath?: string;
  prompt?: string;
  sourceSessionId?: string;
  turnRange?: { start: number; end: number };
}

function parseZukanInput(value: unknown): ZukanInput {
  const input = record(value);
  const source = input.source ?? "manuscript";
  if (source !== "manuscript" && source !== "sandbox") throw new TypeError("source must be manuscript or sandbox");
  const sourceSessionId = optionalString(input, "sourceSessionId", 256);
  let turnRange: { start: number; end: number } | undefined;
  if (input.turnRange !== undefined) {
    const range = record(input.turnRange, "turnRange");
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || (range.start as number) < 0 || (range.end as number) < (range.start as number)) {
      throw new TypeError("turnRange must contain non-negative integer start/end values");
    }
    turnRange = { start: range.start as number, end: range.end as number };
  }
  if (source === "sandbox" && !sourceSessionId) throw new TypeError("sourceSessionId is required for sandbox suggestions");
  return {
    source,
    ...(source === "manuscript" ? { entityId: parseString(input.entityId, "entityId", 256) } : {}),
    ...(optionalString(input, "blockPath", 128) ? { blockPath: optionalString(input, "blockPath", 128) } : {}),
    ...(optionalString(input, "prompt", 4_000) ? { prompt: optionalString(input, "prompt", 4_000) } : {}),
    ...(sourceSessionId ? { sourceSessionId } : {}), ...(turnRange ? { turnRange } : {}),
  };
}

function findUnsourcedZukanTokens(source: string, output: string): string[] {
  const tokens = (value: string) => value.match(/[一-龠ァ-ヶー]{2,}/g) ?? [];
  const sourceTokens = new Set(tokens(source));
  return [...new Set(tokens(output).filter((token) => !sourceTokens.has(token)))];
}

function zukanEvidenceIsGrounded(proposedText: string, evidence: Array<{ quote: string }>): boolean {
  if (!evidence.length || evidence.some((item) => !item.quote.trim())) return false;
  const corpus = evidence.map((item) => item.quote).join("\n");
  return !!corpus.trim() && findUnsourcedZukanTokens(corpus, proposedText).length === 0;
}

const dialogueSketchLineSchema = z.object({ speakerEntityId: z.string().min(1), text: z.string().min(1) });
const sandboxZukanSchema = z.object({ suggestions: z.array(z.object({
  kind: z.enum(["fact", "dynamic", "habit"]), targetEntityId: z.string().min(1), blockPath: z.string().min(1),
  proposedText: z.string().min(1), evidenceQuote: z.string().min(1), confidence: z.enum(["high", "low"]),
})) });
const SANDBOX_ZUKAN_PROMPT_VERSION = "zukan-sandbox@3";
const STRUCTURED_OUTPUT_RULES = [
  "応答は有効なJSONオブジェクト1個のみ（json_object モード）。",
  "Markdown・コードフェンス（```）・説明文・前置き・後書きは禁止。",
  "挨拶・解説・「以下が結果」・思考過程など JSON 以外の文字は禁止。",
  "応答は `{` で始まり `}` で終わる単一 JSON オブジェクトのみ。",
  "キー名・型・配列長は下記スキーマどおり厳守。",
  "存在しないキーを追加しない。必須キーを省略しない。",
];

function buildSandboxZukanPrompt(input: {
  sketchId: string;
  turnRange: { start: number; end: number };
  transcript: string;
  participants: Array<{ id: string; name: string; notesExcerpt: string }>;
}): string {
  const participantNotes = input.participants.map((participant) => `--- ${participant.name} (${participant.id}) ---\n現行ノート:\n${participant.notesExcerpt || "(空)"}`).join("\n\n");
  return [
    "あなたは小説の図鑑ノート編集アシスタントです。",
    "セリフ問答の対話ログから、図鑑へ追記すべき事実・関係性・言語習慣を抽出してください。",
    "各提案は kind: fact|dynamic|habit、targetEntityId、blockPath、proposedText、evidenceQuote、confidence。",
    "evidenceQuote は対話ログに実在する文言のみ。無い設定を作らない。",
    "図鑑を直接書き換えない。差分提案だけ。",
    `sketchId (sourceSessionId): ${input.sketchId}`,
    `turnRange: ${input.turnRange.start}-${input.turnRange.end}`,
    "参加キャラと現行ノート:", participantNotes, "対話ログ:", input.transcript,
    "blockPath は lead.<i> または sections.<si>.body.<bi>。",
    "", "=== 出力形式（厳守） ===", ...STRUCTURED_OUTPUT_RULES,
    'トップレベルキー "suggestions" のみ。',
    "suggestions: オブジェクト配列（0件以上）。",
    '各要素: kind ("fact"|"dynamic"|"habit"), targetEntityId, blockPath, proposedText, evidenceQuote, confidence ("high"|"low").',
    "evidenceQuote は対話ログに実在する文言のみ。無い設定を作らない。",
    "出力例（この形に合わせる）:",
    '{"suggestions":[{"kind":"fact","targetEntityId":"char-yuki","blockPath":"lead.0","proposedText":"雨の日は傘を忘れがち。","evidenceQuote":"また傘忘れたの？","confidence":"high"}]}',
  ].join("\n");
}

function prepareSandboxZukanPrompt(story: LoadedStorySnapshot, sketchId: string, requestedRange?: { start: number; end: number }) {
  const sketch = entity(story, sketchId);
  if (sketch.type !== "dialogue_sketch") throw codeError("assistant_source_missing", `Dialogue sketch ${sketchId} was not found`);
  const lines = dialogueLinesFromRaw(sketch.raw.lines);
  if (!lines.length) return { sketch, lines, turnRange: requestedRange ?? { start: 0, end: -1 }, participants: [], transcript: "", prompt: "", sourceRevisions: [] as FileRevision[] };
  const turnRange = requestedRange ?? { start: 0, end: lines.length - 1 };
  if (!validateSandboxTurnRange(lines.length, sketchId, turnRange)) throw codeError("assistant_source_stale", "Dialogue sketch turn range is no longer valid");
  const slice = lines.slice(turnRange.start, turnRange.end + 1);
  const participantIds = [...new Set([
    ...(Array.isArray(sketch.raw.participantEntityIds) ? sketch.raw.participantEntityIds.filter((id): id is string => typeof id === "string") : []),
    ...slice.map((line) => line.speakerEntityId),
  ])];
  const participants = participantIds.map((id) => {
    const participant = story.entities.get(id);
    return { id, name: participant?.name ?? id, notesExcerpt: notesPlainExcerpt(participant?.raw.notes) };
  });
  const nameById = new Map(participants.map((participant) => [participant.id, participant.name]));
  const transcript = slice.map((line, index) => `[${turnRange.start + index}] ${nameById.get(line.speakerEntityId) ?? line.speakerEntityId}: ${line.text}`).join("\n");
  const prompt = buildSandboxZukanPrompt({ sketchId, turnRange, transcript, participants });
  const sourceRevisions = revisionList([
    sourceFile(story, sketch.filePath),
    ...participantIds.flatMap((id) => {
      const participant = story.entities.get(id);
      return participant ? [sourceFile(story, participant.filePath)] : [];
    }),
  ]);
  return { sketch, lines, turnRange, participants, transcript, prompt, sourceRevisions };
}

function notesPlainExcerpt(value: unknown, maxChars = 2_000): string {
  const parts: string[] = [];
  const addBlocks = (blocks: unknown) => {
    if (typeof blocks === "string") { if (blocks.trim()) parts.push(blocks); return; }
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (!block || typeof block !== "object" || Array.isArray(block)) continue;
      const row = block as RecordValue;
      if (row.type === "paragraph" && typeof row.text === "string") parts.push(row.text);
    }
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const notes = value as RecordValue;
  addBlocks(notes.lead);
  if (Array.isArray(notes.sections)) {
    const visit = (section: unknown) => {
      if (!section || typeof section !== "object" || Array.isArray(section)) return;
      const row = section as RecordValue;
      if (typeof row.heading === "string" && row.heading) parts.push(`# ${row.heading}`);
      addBlocks(row.body);
      if (Array.isArray(row.children)) for (const child of row.children) visit(child);
    };
    for (const section of notes.sections) visit(section);
  }
  const joined = parts.join("\n").trim();
  return joined.length <= maxChars ? joined : `${joined.slice(0, maxChars)}…`;
}

function dialogueLinesFromRaw(value: unknown): Array<{ speakerEntityId: string; text: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((line) => {
    const parsed = dialogueSketchLineSchema.safeParse(line);
    return parsed.success ? [parsed.data] : [];
  });
}

function validateSandboxTurnRange(linesLength: number, sessionId: string, range: { start: number; end: number }): boolean {
  return !!sessionId.trim() && range.start >= 0 && range.end >= range.start && range.end < linesLength;
}

async function runSandboxZukanSuggestions(moduleContext: ModuleContext, context: ModuleActionContext, input: ZukanInput) {
  const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
  await reportProgress(context, 0.1);
  const sketchId = input.sourceSessionId!;
  const prepared = prepareSandboxZukanPrompt(story, sketchId, input.turnRange);
  const { sketch, lines, turnRange, prompt, sourceRevisions } = prepared;
  if (!lines.length) {
    await reportProgress(context, 1);
    return { createdCount: 0, suggestionIds: [], suggestions: [], skippedReason: "no-lines", sourceSessionId: sketchId };
  }
  const slice = lines.slice(turnRange.start, turnRange.end + 1);
  const participantIds = prepared.participants.map((participant) => participant.id);
  await reportProgress(context, 0.35);
  const generated = await generate(moduleContext, context, {
    feature: "zukan-proposal", prompt, promptVersion: SANDBOX_ZUKAN_PROMPT_VERSION,
    sourceRevisions, outputTokens: 1_024,
  });
  const parsed = parseStructured(generated.text, sandboxZukanSchema);
  await reportProgress(context, 0.85);
  const evidenceCorpus = slice.map((line) => line.text).join("\n");
  const suggestions: Array<RecordValue> = [];
  const proposals: unknown[] = [];
  for (const item of parsed.suggestions) {
    if (!participantIds.includes(item.targetEntityId) || !evidenceCorpus.includes(item.evidenceQuote)) continue;
    if (!zukanEvidenceIsGrounded(item.proposedText, [{ quote: item.evidenceQuote }])) continue;
    const storyResult = await context.invoke("story.zukan-suggestions.create", {
      entityId: item.targetEntityId,
      proposedText: item.proposedText.trim(),
      evidence: [{ quote: item.evidenceQuote }],
      source: "sandbox",
      sourceSessionId: sketchId,
      sourceTurnRange: turnRange,
      blockPath: item.blockPath,
      kind: item.kind,
      confidence: item.confidence,
    });
    if (!storyResult.ok) throw codeError(storyResult.error.code, storyResult.error.message);
    const storyData = record(storyResult.data, "Story sandbox Zukan create result");
    const suggestion = storyData.suggestion ?? storyData;
    suggestions.push({ suggestion, created: storyData.created === true, staledPendingCount: storyData.staledPendingCount ?? 0 });
    if (storyData.created === true && storyResult.proposals?.length) proposals.push(...storyResult.proposals);
  }
  const sketchFile = sourceFile(story, sketch.filePath);
  await reportProgress(context, 1);
  return {
    source: "sandbox", sourceSessionId: sketchId, sourceTurnRange: turnRange,
    createdCount: suggestions.filter((item) => item.created === true).length,
    suggestionIds: suggestions.flatMap((item) => {
      const suggestion = record(item.suggestion);
      return typeof suggestion.id === "string" ? [suggestion.id] : [];
    }),
    suggestions, proposals,
    proposal: proposals[0] ?? null,
    model: generated.provenance.model, provider: generated.provenance.provider,
    promptVersion: generated.provenance.promptVersion,
    citations: suggestions.flatMap((item) => {
      const suggestion = record(item.suggestion);
      const evidence = Array.isArray(suggestion.evidence) ? suggestion.evidence.map((entry) => record(entry)) : [];
      return evidence.flatMap((entry) => typeof entry.quote === "string" ? [sourceCitation(sketchFile, entry.quote, undefined, "dialogue sketch evidence")] : []);
    }),
    provenance: generated.provenance,
  };
}

async function runZukanSuggestions(moduleContext: ModuleContext, context: ModuleActionContext, input: ZukanInput) {
  if (input.source === "sandbox") return runSandboxZukanSuggestions(moduleContext, context, input);
  const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
  await reportProgress(context, 0.1);
  const target = entity(story, input.entityId!);
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
  await reportProgress(context, 0.35);
  const generated = await generate(moduleContext, context, { feature: "zukan-proposal", prompt, promptVersion: CUSTOM_PROMPT_VERSIONS.zukan, sourceRevisions, outputTokens: 1_024 });
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
  if (!zukanEvidenceIsGrounded(parsed.proposedText, verifiedEvidence)) throw codeError("assistant_output_ungrounded", "Zukan proposal contains words that are not supported by its evidence");
  await reportProgress(context, 0.85);
  const storyResult = await context.invoke("story.zukan-suggestions.create", {
    entityId: target.id, proposedText: parsed.proposedText, evidence: verifiedEvidence, source: "manuscript",
    blockPath: parsed.blockPath, kind: "fact", confidence: "low",
  });
  if (!storyResult.ok) throw codeError(storyResult.error.code, storyResult.error.message);
  const storyData = record(storyResult.data, "Story Zukan create result");
  await reportProgress(context, 1);
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
  const generated = await generate(moduleContext, context, { feature: "state-event-draft", prompt, promptVersion: `${CUSTOM_PROMPT_VERSIONS.stateEvent}:${fnv1aHash(source.body)}`, sourceRevisions, outputTokens: 1_024 });
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

async function runSpeakerAttribution(
  moduleContext: ModuleContext,
  context: ModuleActionContext,
  input: ReturnType<typeof parseSpeakerAttributionInput>,
) {
  const sceneId = input.sceneId;
  const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
  const source = sceneContext(story, sceneId);
  const sceneFile = story.files.get(source.scene.filePath);
  const editorDraft = input.editorDraft;
  if (editorDraft) assertEditorDraftBase(context, source, sceneFile?.revision ?? null, editorDraft);
  const body = editorDraft?.text ?? source.body;
  if (!body.trim()) throw codeError("assistant_dialogue_missing", "No quoted dialogue lines were found in the scene");
  const dialogues = splitIntoSentences(body).map((text, index) => ({ sentenceIndex: index + 1, text: text.trim() })).filter((item) => item.text && isDialogueSentence(item.text));
  if (!dialogues.length) throw codeError("assistant_dialogue_missing", "No quoted dialogue lines were found in the scene");
  const candidateIds = Array.isArray(source.scene.raw.appears) ? [...new Set(source.scene.raw.appears.filter((id): id is string => typeof id === "string"))].slice(0, 32) : [];
  const candidates = candidateIds.map((id) => story.entities.get(id)).filter((item): item is StoryEntity => !!item && item.type === "character");
  const candidateBlock = candidates.map((candidate) => `### ${candidate.name ?? candidate.id} (${candidate.id})\n口調・声紋:\n${JSON.stringify(candidate.raw.voice ?? candidate.raw.voicePatterns ?? {}).slice(0, 2_000) || "（未登録）"}\n図鑑ノート:\n${JSON.stringify(candidate.raw.notes ?? {}).slice(0, 2_000) || "（未登録）"}`).join("\n\n") || "（なし）";
  const numbered = splitIntoSentences(body).map((text, index) => text.trim() ? `${index + 1}. ${text.trim()}` : "").filter(Boolean).join("\n");
  const prompt = await composePrompt([
    "あなたは小説の話者帰属アシスタントです。番号付きシーン本文の各セリフ（鉤括弧）について、候補キャラから話者を推定してください。候補外は null にしてください。",
    `候補キャラ:\n${candidateBlock}`, `シーン本文:\n${numbered}`,
    promptJson('{"attributions":[{"sentenceIndex":1,"speakerEntityId":"character-id|null","rationale":"..."}]}'),
  ].join("\n\n"));
  const sourceRevisions = revisionList([story.files.get(source.scene.filePath)!, source.manuscript, ...candidates.map((candidate) => story.files.get(candidate.filePath)!).filter(Boolean)]);
  const generated = await generate(moduleContext, context, { feature: "speaker-attribution-llm", prompt, promptVersion: CUSTOM_PROMPT_VERSIONS.speaker, sourceRevisions, outputTokens: 4_096 });
  const parsed = parseStructured(generated.text, speakerSchema);
  const candidateSet = new Set(candidates.map((item) => item.id));
  const byIndex = new Map(parsed.attributions.map((item) => [item.sentenceIndex, item]));
  const proposals = dialogues.map((dialogue) => {
    const answer = byIndex.get(dialogue.sentenceIndex);
    return { ...dialogue, speakerEntityId: answer?.speakerEntityId && candidateSet.has(answer.speakerEntityId) ? answer.speakerEntityId : null, ...(answer?.rationale ? { rationale: answer.rationale } : {}) };
  });
  const citations: SourceCitation[] = editorDraft
    ? [{
      path: editorDraft.documentPath,
      revision: editorDraft.documentRevision ?? editorDraft.sceneRevision,
      quote: proposals.map((item) => item.text).join("\n").slice(0, 1_200),
      sceneId,
      label: "current editor draft",
      revisionKind: editorDraft.documentRevision === null ? "editor-scene" : "editor-document",
      snapshot: editorDraft.snapshot,
    }]
    : [makeCitation(source.manuscript, body, sceneId, "scene manuscript")];
  const provenance = {
    ...generated.provenance,
    ...(editorDraft ? { editorDraft: {
      documentPath: editorDraft.documentPath,
      documentRevision: editorDraft.documentRevision,
      sceneRevision: editorDraft.sceneRevision,
      snapshot: editorDraft.snapshot,
      baseSnapshot: editorDraft.baseSnapshot,
      baseSceneRevision: editorDraft.baseSceneRevision,
    } } : {}),
  };
  return { sceneId, attributions: proposals, model: generated.provenance.model, provider: generated.provenance.provider, promptVersion: generated.provenance.promptVersion, citations, provenance };
}

async function previewSceneSummaryPrompt(context: ModuleActionContext, sceneId: string) {
  const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
  const source = sceneContext(story, sceneId);
  return { prompt: (await buildSceneSummaryPrompt(story, source)).prompt };
}

async function previewChapterSummaryPrompt(context: ModuleActionContext, chapterId: string) {
  const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
  const { chapter, scenes } = chapterScenes(story, chapterId);
  const sceneRecords: RecordValue[] = [];
  for (const source of scenes) {
    const summary = await readAssistantSummary(context, "scene", source.scene.id);
    if (summary) sceneRecords.push({ sceneId: source.scene.id, summaryLines: summary.summaryLines });
  }
  return { prompt: (await buildChapterSummaryPrompt(chapter.id, sceneRecords)).prompt };
}

async function previewQaPrompt(context: ModuleActionContext, sceneId?: string) {
  let manuscriptBody = "";
  if (sceneId) {
    const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
    manuscriptBody = sceneContext(story, sceneId).body;
  }
  return { prompt: (await buildQaSystemPrompt(manuscriptBody)).system };
}

async function previewAspectPrompt(context: ModuleActionContext, input: { chapterId: string; aspects: AspectId[] }) {
  const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
  const chapter = entity(story, input.chapterId);
  if (chapter.type !== "chapter") throw new TypeError(`${input.chapterId} is not a chapter`);
  const labels: Record<AspectId, string> = { tempo: "テンポ", "pov-shift": "視点の揺れ", "over-explain": "説明過多" };
  const template = await renderPromptTemplate("aspectReview", {
    chapterId: input.chapterId,
    chapterName: chapter.name ?? input.chapterId,
    aspectLines: input.aspects.map((aspect) => `- ${aspect}（${labels[aspect]}）`).join("\n") || "（なし）",
    sceneBlocks: "",
  });
  return { prompt: `${await composePrompt(template.body)}\n\n※ 実行時に各シーン本文が scenes へ追加されます` };
}

async function previewDialogueSandboxZukanPrompt(
  context: ModuleActionContext,
  input: { sketchId: string; turnRange?: { start: number; end: number } },
) {
  const story = await readStorySnapshot(context.reader, { includeManuscripts: true });
  const prepared = prepareSandboxZukanPrompt(story, input.sketchId, input.turnRange);
  if (!prepared.lines.length) throw codeError("assistant_dialogue_missing", "The selected dialogue sketch has no dialogue lines");
  return { model: await previewModelId(context, "zukan-proposal"), prompt: prepared.prompt };
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
    action("assistant.rewrite", "compute", parseRewriteInput, async (input, context) => runRewrite(moduleContext, context, input as ReturnType<typeof parseRewriteInput>)),
    action("assistant.rewrite.propose", "propose", parseRewriteProposalInput, async (input, context) => proposeRewrite(context, input as ReturnType<typeof parseRewriteProposalInput>)),
    action("assistant.summary.scene", "propose", parseIdInput, async (input, context) => runSceneSummary(moduleContext, context, input.sceneId as string), "summary-refresh"),
    action("assistant.summary.chapter", "propose", (value) => parseIdInput(value, "chapterId"), async (input, context) => runChapterSummary(moduleContext, context, input.chapterId as string), "summary-refresh"),
    action("assistant.qa", "compute", parseQaInput, async (input, context) => runQa(moduleContext, context, input as ReturnType<typeof parseQaInput>)),
    action("assistant.continuation", "compute", parseContinuationInput, async (input, context) => runContinuation(moduleContext, context, input as unknown as ReturnType<typeof parseContinuationInput>)),
    action("assistant.aspect.review", "compute", parseAspectInput, async (input, context) => runAspectReview(context, input as ReturnType<typeof parseAspectInput>), "aspect-review"),
    action("assistant.dialogue.topics", "compute", parseDialogueTopicsInput, async (input, context) => runDialogueTopics(moduleContext, context, input as ReturnType<typeof parseDialogueTopicsInput>)),
    action("assistant.dialogue.turns", "compute", parseDialogueTurnInput, async (input, context) => runDialogueTurns(moduleContext, context, input as unknown as ReturnType<typeof parseDialogueTurnInput>)),
    action("assistant.reader.reaction", "compute", (value) => parseIdInput(value, "chapterId"), async (input, context) => runReaderReaction(moduleContext, context, input.chapterId as string)),
    action("assistant.zukan.suggestions", "propose", parseZukanInput, async (input, context) => runZukanSuggestions(moduleContext, context, input as unknown as ReturnType<typeof parseZukanInput>), "zukan-proposal"),
    action("assistant.synonyms.suggestions", "compute", parseSynonymInput, async (input, context) => runSynonyms(moduleContext, context, input as ReturnType<typeof parseSynonymInput>)),
    action("assistant.contradictions.assist", "compute", parseContradictionInput, async (input, context) => runContradictionAssist(moduleContext, context, input as ReturnType<typeof parseContradictionInput>)),
    action("assistant.stateEvents.draft", "propose", parseIdInput, async (input, context) => runStateEventDraft(moduleContext, context, input.sceneId as string)),
    action("assistant.speaker.attribute", "compute", parseSpeakerAttributionInput, async (input, context) => runSpeakerAttribution(moduleContext, context, input as ReturnType<typeof parseSpeakerAttributionInput>)),
    action("assistant.summary.scene.preview", "read", (value) => parsePreviewIdInput(value, "sceneId"), async (input, context) => previewSceneSummaryPrompt(context, input.id as string)),
    action("assistant.summary.chapter.preview", "read", (value) => parsePreviewIdInput(value, "chapterId"), async (input, context) => previewChapterSummaryPrompt(context, input.id as string)),
    action("assistant.qa.preview", "read", parseQaPreviewInput, async (input, context) => previewQaPrompt(context, input.sceneId as string | undefined)),
    action("assistant.continuation.preview", "read", parseContinuationPreviewInput, async (input) => {
      const parsed = input as ReturnType<typeof parseContinuationPreviewInput>;
      return { prompt: (await buildContinuationPrompt(parsed.recentSentences.join("\n"))).prompt };
    }),
    action("assistant.aspect.review.preview", "read", parseAspectInput, async (input, context) => previewAspectPrompt(context, input as ReturnType<typeof parseAspectInput>)),
    action("assistant.dialogue.topics.preview", "read", parseDialogueTopicsInput, async (input, context) => {
      const prepared = await buildDialogueTopicsPrompt(context, input as ReturnType<typeof parseDialogueTopicsInput>);
      return { model: await previewModelId(context, "dialogue-sketch"), prompt: prepared.prompt };
    }),
    action("assistant.dialogue.turn.preview", "read", parseDialogueTurnInput, async (input, context) => {
      const parsed = input as unknown as ReturnType<typeof parseDialogueTurnInput>;
      if (!parsed.speakerEntityId) throw new TypeError("speakerEntityId is required for single-line prompt preview");
      const prepared = await buildDialogueTurnPrompt(context, parsed);
      return { model: await previewModelId(context, "dialogue-sketch-turn"), prompt: prepared.prompt };
    }),
    action("assistant.dialogue.turns.preview", "read", parseDialogueTurnInput, async (input, context) => {
      const parsed = input as unknown as ReturnType<typeof parseDialogueTurnInput>;
      if (parsed.lineCount === undefined) throw new TypeError("lineCount is required for bulk prompt preview");
      const prepared = await buildDialogueTurnPrompt(context, parsed);
      return { model: await previewModelId(context, "dialogue-sketch-turn"), prompt: prepared.prompt };
    }),
    action("assistant.reader.reaction.preview", "read", (value) => parsePreviewIdInput(value, "chapterId"), async (input, context) => ({ prompt: (await buildReaderReactionContext(context, input.id as string)).prompt })),
    action("assistant.synonyms.preview", "read", parseSynonymPreviewInput, async (input, context) => ({
      model: await previewModelId(context, "synonym-suggest"),
      prompt: await buildSynonymPrompt(input as unknown as SynonymRequest),
    })),
    action("assistant.zukan.sandbox.preview", "read", parseSandboxZukanPreviewInput, async (input, context) => previewDialogueSandboxZukanPrompt(context, input as ReturnType<typeof parseSandboxZukanPreviewInput>)),
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
              send("final", { ...result, proposals: [] });
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

export function createAssistantQaStreamHttpContribution(moduleContext: ModuleContext): HttpContribution {
  return {
    id: "assistant.qa.stream",
    path: "qa/stream",
    methods: ["POST"],
    access: "owner",
    effect: "read",
    async handle(request, context) {
      if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) return jsonFailure(415, "Content-Type must be application/json");
      let input: ReturnType<typeof parseQaInput>;
      try { input = parseQaInput(await request.json()); }
      catch (error) { return jsonFailure(400, error instanceof Error ? error.message.slice(0, 256) : "Invalid QA request"); }

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
              const result = await runQa(moduleContext, streamContext, input, (delta) => send("delta", { delta }));
              send("final", result);
            } catch (error) {
              if (!signal.aborted) {
                const err = error instanceof Error ? error : new Error(String(error));
                send("error", { code: (error as { code?: unknown })?.code ?? "assistant_action_failed", message: err.message.slice(0, 512) });
              }
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
