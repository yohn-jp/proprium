import { randomUUID } from "node:crypto";
import type { ActionResult, ChangeOperation, JobRequest, ModuleAction, ModuleContext, ModuleDefinition, ModuleManifest, ModuleActionContext, SnapshotId, ValueSchema } from "@scriptorium/contracts";
import type { WorkerService } from "@scriptorium/contracts";
import { NLP_TOKENIZER_CAPABILITY, NLP_TOKENIZER_CAPABILITY_VERSION, NLP_TOKEN_COUNTER_CAPABILITY, NLP_TOKEN_COUNTER_CAPABILITY_VERSION, NLP_TOKENIZER_ENGINE_VERSION, NLP_APPROX_TOKEN_COUNTER_VERSION, NLP_MODEL_ID, NLP_MODEL_VERSION, NLP_MODULE_VERSION, type NlpTokenCountBatch, type NlpTokenCounterCapability, type NlpTokenizerCapability } from "./contracts.js";
import { aggregateCandidateTerms, collectEntityTexts, type CandidateEntityInput } from "./candidateDiscovery.js";
import { readCanonicalSnapshotEntities } from "./canonicalSnapshot.js";
import { expandSearchTerms, suggestTermVariants } from "./termVariants.js";
import { isSafeHuggingFaceModelId, resolveTokenCountConfiguration, validateTokenCountTexts } from "./tokenCount.js";
import type { MorphologyAnalysis } from "./tokenizer/types.js";
import YAML from "yaml";

export { aggregateCandidateTerms, extractCompoundNouns, extractCompoundNounsWithReading, isEligibleTerm } from "./candidateDiscovery.js";
export { buildMorphologyAnalysis, assignTokensToSentences } from "./analyze/primitives.js";
export { readCanonicalSnapshotEntities, type CanonicalSnapshotEntity } from "./canonicalSnapshot.js";
export { isAdjective, isAdverb, isAuxiliaryVerb, isComma, isFinalParticle, isNoun, isNumeral, isParticle, isPronoun, isProperNoun, isSymbol, isTaConjunctive, isUnknown, isVerb } from "./tokenizer/pos.js";
export { tokenBase, tokenPosDetail1 } from "./tokenizer/types.js";
export { suggestTermVariants } from "./termVariants.js";
export { expandSearchTerms } from "./termVariants.js";
export type { TermVariantSuggestion } from "./termVariants.js";
export { splitIntoSentenceOffsets, splitIntoSentences } from "./sentenceSplit.js";
export type { SentenceOffset } from "./sentenceSplit.js";
export type { CandidateTerm } from "./candidateDiscovery.js";
export type { MorphologyAnalysis, MorphToken, SentenceSpan, Token, Tokenizer } from "./tokenizer/types.js";
export type { NlpTokenizerCapability } from "./contracts.js";
export { NLP_TOKENIZER_CAPABILITY, NLP_TOKENIZER_CAPABILITY_VERSION, NLP_TOKEN_COUNTER_CAPABILITY, NLP_TOKEN_COUNTER_CAPABILITY_VERSION, NLP_TOKENIZER_ENGINE_VERSION, NLP_APPROX_TOKEN_COUNTER_VERSION, NLP_MODEL_ID, NLP_MODEL_VERSION, NLP_MODULE_VERSION } from "./contracts.js";
export type { NlpTokenCountBatch, NlpTokenCounterCapability, NlpTokenCounterIdentity } from "./contracts.js";
export { isSafeHuggingFaceModelId, MAX_TOKEN_COUNT_BATCH_BYTES, MAX_TOKEN_COUNT_TEXT_BYTES, MAX_TOKEN_COUNT_TEXTS, sourceApproxTokenCount } from "./tokenCount.js";

const manifest: ModuleManifest = {
  id: "nlp", version: NLP_MODULE_VERSION, contractVersion: 1,
  dependencies: [], provides: [NLP_TOKENIZER_CAPABILITY, NLP_TOKEN_COUNTER_CAPABILITY], requires: [],
  serverEntry: "./dist/index.js", browserEntry: "./dist/browser.js", workerEntry: "./dist/worker.js",
  statePaths: ["meta/scriptorium/modules/nlp"], locality: "local",
};

const MAX_TEXT_LENGTH = 1_000_000;
const SYNONYMS_PATH = "meta/scriptorium/modules/nlp/synonyms.yaml";
const IGNORED_PATH = "meta/scriptorium/modules/nlp/candidate-ignore-list.yaml";
const FEATURE_SETTINGS_PATH = "meta/scriptorium/modules/nlp/feature-settings.json";

type ObjectValue = Record<string, unknown>;
function record(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as ObjectValue;
}
function textInput(value: unknown): { text: string } {
  const input = record(value, "input");
  if (typeof input.text !== "string" || input.text.length > MAX_TEXT_LENGTH) throw new TypeError("text must be a string of at most 1000000 characters");
  return { text: input.text };
}
function textListInput(value: unknown): { text: string[]; knownTerms: string[] } {
  const input = record(value, "input");
  if (!Array.isArray(input.text) || input.text.some((item) => typeof item !== "string" || item.length > MAX_TEXT_LENGTH) || input.text.length > 8) {
    throw new TypeError("text must contain at most eight manuscript passages");
  }
  const knownTerms = input.knownTerms ?? [];
  if (!Array.isArray(knownTerms) || knownTerms.some((item) => typeof item !== "string" || item.length > 256)) throw new TypeError("knownTerms must be a string array");
  return { text: input.text as string[], knownTerms: knownTerms as string[] };
}
function tokenCountInput(value: unknown): { texts: string[]; modelId?: string } {
  const input = record(value, "input");
  const texts = validateTokenCountTexts(input.texts);
  if (input.modelId === undefined) return { texts };
  if (typeof input.modelId !== "string" || !isSafeHuggingFaceModelId(input.modelId.trim())) {
    throw new TypeError("modelId must be a safe Hugging Face model identifier of at most 128 characters");
  }
  return { texts, modelId: input.modelId.trim() };
}
function emptyInput(value: unknown): ObjectValue { return record(value, "input"); }
function objectOutput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("action output must be an object");
  return value;
}
const outputSchema: ValueSchema = { parse: objectOutput };

function action(id: string, effect: ModuleAction["effect"], inputSchema: ValueSchema, invoke: ModuleAction["invoke"]): ModuleAction {
  return { id, effect, inputSchema, outputSchema, invoke };
}

async function withTokenizer<T>(moduleContext: ModuleContext, signal: AbortSignal, fn: (tokenizer: NlpTokenizerCapability) => Promise<T>): Promise<T> {
  if (signal.aborted) throw Object.assign(new Error("NLP action was cancelled"), { code: "job_cancelled" });
  const lease = await moduleContext.acquireCapability<NlpTokenizerCapability>(NLP_TOKENIZER_CAPABILITY);
  try { return await fn(lease.value); }
  finally { await lease.release(); }
}

async function withTokenCounter<T>(moduleContext: ModuleContext, signal: AbortSignal, fn: (counter: NlpTokenCounterCapability) => Promise<T>): Promise<T> {
  if (signal.aborted) throw Object.assign(new Error("NLP token-count action was cancelled"), { code: "job_cancelled" });
  const lease = await moduleContext.acquireCapability<NlpTokenCounterCapability>(NLP_TOKEN_COUNTER_CAPABILITY);
  try { return await fn(lease.value); }
  finally { await lease.release(); }
}

interface TokenCounterWorkerInput {
  texts: string[];
  backend: "auto" | "approx";
  modelId?: string;
  modelsDir: string;
  fallbackReason?: "backend_approx" | "model_unconfigured" | "tokenizer_unavailable";
}

function workerCapability(worker: WorkerService): NlpTokenizerCapability & NlpTokenCounterCapability & { dispose(): Promise<void> } {
  return {
    model: { id: NLP_MODEL_ID, version: NLP_MODEL_VERSION },
    async analyze(text, snapshot, signal) {
      const request: JobRequest<{ text: string }> = {
        id: randomUUID(), module: "nlp", task: "nlp.analyze", snapshot,
        model: NLP_MODEL_ID, modelVersion: NLP_MODEL_VERSION, moduleVersion: NLP_MODULE_VERSION,
        deadline: Date.now() + 120_000, input: { text },
      };
      const outcome = await worker.request<MorphologyAnalysis>(request, signal);
      if (!outcome.ok) throw Object.assign(new Error(outcome.error.message), outcome.error);
      return outcome.result.output;
    },
    async countMany(texts, snapshot, signal, options) {
      if (signal.aborted) throw Object.assign(new Error("NLP token-count action was cancelled"), { code: "job_cancelled" });
      const inputTexts = validateTokenCountTexts(texts);
      const configuration = resolveTokenCountConfiguration(process.env, options);
      const input: TokenCounterWorkerInput = {
        ...configuration,
        texts: inputTexts,
      };
      const model = configuration.modelId ?? "approx";
      const modelVersion = configuration.modelId ? NLP_TOKENIZER_ENGINE_VERSION : NLP_APPROX_TOKEN_COUNTER_VERSION;
      const request: JobRequest<TokenCounterWorkerInput> = {
        id: randomUUID(), module: "nlp", task: "nlp.countTokens", snapshot,
        model, modelVersion, moduleVersion: NLP_MODULE_VERSION,
        deadline: Date.now() + 120_000, input,
      };
      const outcome = await worker.request<NlpTokenCountBatch>(request, signal);
      if (!outcome.ok) throw Object.assign(new Error(outcome.error.message), outcome.error);
      return outcome.result.output;
    },
    dispose: () => worker.dispose(),
  };
}

async function readYaml(reader: ModuleActionContext["reader"], path: string): Promise<{ value: ObjectValue; revision: string | null }> {
  const file = await reader.read(path);
  if (!file) return { value: {}, revision: null };
  const parsed = YAML.parse(file.content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError(`${path} must contain a YAML object`);
  return { value: parsed as ObjectValue, revision: file.revision };
}

function parseIgnored(value: ObjectValue): Set<string> {
  const ignored = value.ignored ?? [];
  if (!Array.isArray(ignored) || ignored.some((term) => typeof term !== "string")) throw new TypeError("candidate ignore list must contain string terms");
  return new Set(ignored as string[]);
}

function parseSynonymGroups(value: ObjectValue): Array<Record<string, unknown> & { words: string[]; context?: string }> {
  const groups = value.groups ?? [];
  if (!Array.isArray(groups)) throw new TypeError("synonym dictionary groups must be an array");
  return groups.map((item, index) => {
    const group = record(item, `synonym group ${index + 1}`);
    if (!Array.isArray(group.words) || group.words.length < 2 || group.words.some((word) => typeof word !== "string" || !word.trim())) {
      throw new TypeError(`synonym group ${index + 1} must contain at least two words`);
    }
    if (group.context !== undefined && group.context !== "negative" && group.context !== "positive") throw new TypeError(`synonym group ${index + 1} has invalid context`);
    return { ...group, words: group.words as string[], ...(typeof group.context === "string" ? { context: group.context } : {}) };
  });
}

function operation(context: ModuleActionContext, path: string, revision: string | null, content: string, message: string): ChangeOperation {
  return {
    id: randomUUID(), generation: 0, repository: context.reader.snapshot.repository,
    baseRemoteCommit: context.reader.snapshot.remoteCommit, effect: "settings",
    reads: [{ path, revision }], writes: [{ path, revision, content }], message,
  };
}

const featureRegistry = [
  { id: "speaker-eval", label: "話者評価", locality: "local" },
  { id: "speaker-retrain", label: "話者再学習", locality: "local" },
  { id: "speaker-attribution", label: "話者帰属", locality: "local" },
  { id: "speaker-attribution-llm", label: "話者推定（外部モデル）", locality: "external" },
  { id: "hybrid-search", label: "意味検索", locality: "local" },
  { id: "expression-search", label: "表現の在庫", locality: "local" },
  { id: "embedding", label: "文埋め込み", locality: "local" },
  { id: "stylometry", label: "文体分析", locality: "local" },
  { id: "setting-qa", label: "設定を尋ねる", locality: "external" },
  { id: "aspect-review", label: "観点別下読み", locality: "external" },
  { id: "rewrite", label: "言い換え（外部モデル）", locality: "external" },
  { id: "scene-summary", label: "シーン要約", locality: "external" },
  { id: "chapter-summary", label: "章要約", locality: "external" },
  { id: "dialogue-sketch", label: "対話スケッチ", locality: "external" },
  { id: "continuation-options", label: "続きの相談", locality: "external" },
  { id: "contradiction-check", label: "矛盾照合", locality: "external" },
  { id: "zukan-proposal", label: "図鑑提案", locality: "external" },
  { id: "state-event-draft", label: "状態イベント草案", locality: "external" },
  { id: "first-read-reaction", label: "初読リアクション", locality: "external" },
] as const;
const externalFeatures = featureRegistry.filter((feature) => feature.locality === "external");

function makeActions(moduleContext: ModuleContext): ModuleAction[] {
  return [
    action("nlp.analyze", "compute", { parse: textInput }, async (value, context) => {
      const { text } = value as { text: string };
      const analysis = await withTokenizer(moduleContext, context.signal, (tokenizer) => tokenizer.analyze(text, context.reader.snapshot, context.signal));
      return { ok: true, snapshot: context.reader.snapshot, data: { analysis, engine: NLP_MODEL_ID, engineVersion: NLP_MODEL_VERSION } } as ActionResult;
    }),
    action("nlp.countTokens", "compute", { parse: tokenCountInput }, async (value, context) => {
      const input = value as { texts: string[]; modelId?: string };
      const batch = await withTokenCounter(moduleContext, context.signal, (counter) => counter.countMany(
        input.texts,
        context.reader.snapshot,
        context.signal,
        input.modelId ? { modelId: input.modelId } : undefined,
      ));
      return { ok: true, snapshot: context.reader.snapshot, data: batch } as ActionResult;
    }),
    action("nlp.discoverCandidates", "compute", { parse: emptyInput }, async (_value, context) => {
      const snapshotEntities = await readCanonicalSnapshotEntities(context.reader, context.signal);
      const entities: CandidateEntityInput[] = snapshotEntities.map((entity) => ({ id: entity.id, name: entity.name, aliases: entity.aliases, raw: entity.raw, body: entity.body }));
      const documents: Array<{ id: string; texts: string[] }> = entities.map((entity) => ({ id: entity.id, texts: collectEntityTexts(entity) }));
      const tokenized = await withTokenizer(moduleContext, context.signal, async (tokenizer) => {
        const rows: Array<{ id: string; tokenizedTexts: MorphologyAnalysis["tokens"][] }> = [];
        for (const document of documents) {
          const tokenizedTexts: MorphologyAnalysis["tokens"][] = [];
          for (const text of document.texts) {
            if (context.signal.aborted) throw Object.assign(new Error("Candidate discovery was cancelled"), { code: "job_cancelled" });
            if (text) tokenizedTexts.push((await tokenizer.analyze(text, context.reader.snapshot, context.signal)).tokens);
          }
          rows.push({ id: document.id, tokenizedTexts });
        }
        return rows;
      });
      const knownTerms = new Set<string>();
      for (const entity of entities) {
        if (typeof entity.name === "string" && entity.name) knownTerms.add(entity.name);
        if (Array.isArray(entity.aliases)) for (const alias of entity.aliases) if (typeof alias === "string") knownTerms.add(alias);
      }
      const { value: ignoreConfig } = await readYaml(context.reader, IGNORED_PATH);
      const ignored = parseIgnored(ignoreConfig);
      const candidates = aggregateCandidateTerms(tokenized, knownTerms).filter((candidate) => !ignored.has(candidate.term));
      return { ok: true, snapshot: context.reader.snapshot, data: { candidates, sourceCount: documents.length, model: NLP_MODEL_ID, modelVersion: NLP_MODEL_VERSION } } as ActionResult;
    }),
    action("nlp.termVariants", "compute", { parse: (value) => {
      const input = record(value, "input");
      if (!Array.isArray(input.candidates) || input.candidates.some((item) => !item || typeof item !== "object" || typeof (item as ObjectValue).term !== "string" || typeof (item as ObjectValue).count !== "number")) throw new TypeError("candidates must be term/count records");
      if (!Array.isArray(input.knownTerms) || input.knownTerms.some((item) => typeof item !== "string")) throw new TypeError("knownTerms must be a string array");
      return { candidates: input.candidates as Array<{ term: string; count: number }>, knownTerms: input.knownTerms as string[] };
    } }, async (value, context) => {
      const input = value as { candidates: Array<{ term: string; count: number }>; knownTerms: string[] };
      return { ok: true, snapshot: context.reader.snapshot, data: { suggestions: suggestTermVariants(input.candidates, new Set(input.knownTerms)) } } as ActionResult;
    }),
    action("nlp.dictionary", "read", { parse: (value) => {
      const input = record(value, "input");
      if (typeof input.term !== "string") throw new TypeError("term must be a string");
      return { term: input.term };
    } }, async (value, context) => {
      const { term } = value as { term: string };
      const { value: config } = await readYaml(context.reader, SYNONYMS_PATH);
      const groups = parseSynonymGroups(config);
      const group = groups.find((item) => item.words.includes(term));
      return { ok: true, snapshot: context.reader.snapshot, data: { term, group: group ?? null, alternatives: group?.words.filter((word) => word !== term) ?? [] } } as ActionResult;
    }),
    action("nlp.saveSynonymGroup", "propose", { parse: (value) => {
      const input = record(value, "input");
      if (!Array.isArray(input.words) || input.words.length < 1 || input.words.some((word) => typeof word !== "string" || !word.trim() || word.length > 128)) throw new TypeError("words must contain at least one non-empty string");
      if (input.context !== undefined && input.context !== "negative" && input.context !== "positive") throw new TypeError("context must be negative or positive");
      if (input.mergeGroupIndex !== undefined && (!Number.isSafeInteger(input.mergeGroupIndex) || (input.mergeGroupIndex as number) < 0)) throw new TypeError("mergeGroupIndex must be a non-negative integer");
      return { words: [...new Set((input.words as string[]).map((word) => word.trim()))], context: input.context as "negative" | "positive" | undefined, mergeGroupIndex: input.mergeGroupIndex as number | undefined };
    } }, async (value, context) => {
      const input = value as { words: string[]; context?: "negative" | "positive"; mergeGroupIndex?: number };
      const { value: current, revision } = await readYaml(context.reader, SYNONYMS_PATH);
      const groups = parseSynonymGroups(current);
      const existingIndex = input.mergeGroupIndex !== undefined && groups[input.mergeGroupIndex]
        ? input.mergeGroupIndex
        : groups.findIndex((group) => input.words.some((word) => group.words.includes(word)));
      if (existingIndex >= 0) groups[existingIndex] = { ...groups[existingIndex], words: [...new Set([...groups[existingIndex].words, ...input.words])] };
      else {
        if (input.words.length < 2) throw new TypeError("synonym groups require at least two distinct non-empty words");
        groups.push({ words: input.words, ...(input.context ? { context: input.context } : {}) });
      }
      const content = YAML.stringify({ ...current, groups });
      const proposal = await context.propose([operation(context, SYNONYMS_PATH, revision, content, "Update the NLP synonym dictionary")], [{
        id: randomUUID(), snapshot: context.reader.snapshot, module: "nlp", kind: "synonym_dictionary_update",
        paths: [{ path: SYNONYMS_PATH, revision }], details: { words: input.words },
      }]);
      return { ok: true, snapshot: context.reader.snapshot, data: { groups, proposal } } as ActionResult;
    }),
    action("nlp.ignoreCandidates", "propose", { parse: (value) => {
      const input = record(value, "input");
      if (!Array.isArray(input.terms) || input.terms.length === 0 || input.terms.some((term) => typeof term !== "string" || !term.trim() || term.length > 256)) throw new TypeError("terms must be a non-empty string array");
      return { terms: [...new Set((input.terms as string[]).map((term) => term.trim()))] };
    } }, async (value, context) => {
      const { terms } = value as { terms: string[] };
      const { value: current, revision } = await readYaml(context.reader, IGNORED_PATH);
      const ignored = parseIgnored(current);
      for (const term of terms) ignored.add(term);
      const content = YAML.stringify({ ...current, ignored: [...ignored].sort() });
      const proposal = await context.propose([operation(context, IGNORED_PATH, revision, content, "Ignore NLP candidate terms")], [{
        id: randomUUID(), snapshot: context.reader.snapshot, module: "nlp", kind: "candidate_ignore_update",
        paths: [{ path: IGNORED_PATH, revision }], details: { terms },
      }]);
      return { ok: true, snapshot: context.reader.snapshot, data: { ignored: [...ignored].sort(), proposal } } as ActionResult;
    }),
    action("nlp.features", "read", { parse: emptyInput }, async (_value, context) => {
      const file = await context.reader.read(FEATURE_SETTINGS_PATH);
      let settings: ObjectValue = { externalEnabled: {} };
      if (file) {
        try { settings = record(JSON.parse(file.content), "NLP feature settings"); }
        catch (error) { throw new TypeError(`NLP feature settings are invalid JSON: ${error instanceof Error ? error.message : "parse error"}`); }
      }
      const enabled = record(settings.externalEnabled ?? {}, "externalEnabled");
      // Missing consent is denied. This differs from the source default-on
      // behavior because the migration contract requires explicit allowance.
      const features = featureRegistry.map((feature) => ({ ...feature, enabled: feature.locality === "local" || enabled[feature.id] === true }));
      return { ok: true, snapshot: context.reader.snapshot, data: { features, settings: { ...settings, externalEnabled: enabled } } } as ActionResult;
    }),
    action("nlp.updateExternalConsent", "propose", { parse: (value) => {
      const input = record(value, "input");
      const patch = record(input.externalEnabled, "externalEnabled");
      if (Object.entries(patch).some(([key, enabled]) => !externalFeatures.some((feature) => feature.id === key) || typeof enabled !== "boolean")) throw new TypeError("externalEnabled contains an unsupported feature flag");
      return { externalEnabled: patch as Record<string, boolean> };
    } }, async (value, context) => {
      const input = value as { externalEnabled: Record<string, boolean> };
      const file = await context.reader.read(FEATURE_SETTINGS_PATH);
      let current: ObjectValue = {};
      if (file) {
        try { current = record(JSON.parse(file.content), "NLP feature settings"); }
        catch { throw new TypeError("NLP feature settings are invalid JSON"); }
      }
      const currentFlags = record(current.externalEnabled ?? {}, "externalEnabled");
      const next = { ...current, externalEnabled: { ...currentFlags, ...input.externalEnabled } };
      const content = `${JSON.stringify(next, null, 2)}\n`;
      const revision = file?.revision ?? null;
      const proposal = await context.propose([operation(context, FEATURE_SETTINGS_PATH, revision, content, "Update external NLP consent")], [{
        id: randomUUID(), snapshot: context.reader.snapshot, module: "nlp", kind: "external_nlp_consent_update",
        paths: [{ path: FEATURE_SETTINGS_PATH, revision }], details: { externalEnabled: input.externalEnabled },
      }]);
      return { ok: true, snapshot: context.reader.snapshot, data: { settings: next, proposal } } as ActionResult;
    }),
  ];
}

export async function createModule(moduleContext: ModuleContext): Promise<ModuleDefinition> {
  return {
    manifest,
    capabilities: [{
      id: NLP_TOKENIZER_CAPABILITY, version: NLP_TOKENIZER_CAPABILITY_VERSION,
      async create(context) { return workerCapability(await context.createWorkerService()); },
      async dispose(capability) { await (capability as NlpTokenizerCapability & NlpTokenCounterCapability & { dispose(): Promise<void> }).dispose(); },
    }, {
      id: NLP_TOKEN_COUNTER_CAPABILITY, version: NLP_TOKEN_COUNTER_CAPABILITY_VERSION,
      async create(context) {
        const lease = await context.acquireCapability<NlpTokenizerCapability & NlpTokenCounterCapability>(NLP_TOKENIZER_CAPABILITY);
        return {
          countMany: (texts, snapshot, signal, options) => lease.value.countMany(texts, snapshot, signal, options),
          async dispose() { await lease.release(); },
        } satisfies NlpTokenCounterCapability & { dispose(): Promise<void> };
      },
      async dispose(capability) { await (capability as NlpTokenCounterCapability & { dispose(): Promise<void> }).dispose(); },
    }],
    actions: makeActions(moduleContext),
    ui: [
      { id: "nlp.analyzer", module: "nlp", slot: "dock", title: "日本語解析", action: "nlp.analyze" },
      { id: "nlp.candidates", module: "nlp", slot: "review", title: "語句候補", action: "nlp.discoverCandidates" },
      { id: "nlp.dictionary", module: "nlp", slot: "settings", title: "同義語辞書", action: "nlp.dictionary" },
      { id: "nlp.privacy", module: "nlp", slot: "settings", title: "外部送信の同意", action: "nlp.features" },
    ],
    async dispose() {},
  };
}

