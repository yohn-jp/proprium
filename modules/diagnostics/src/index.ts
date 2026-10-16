import { randomUUID } from "node:crypto";
import { assertProjectPath, MAX_JOB_INPUT_BYTES, type ActionResult, type ChangeOperation, type JobRequest, type ModuleAction, type ModuleActionContext, type ModuleContext, type ModuleDefinition, type ModuleManifest, type SnapshotId, type ValueSchema } from "@scriptorium/contracts";
import type { NlpTokenizerCapability, MorphologyAnalysis } from "@scriptorium/module-nlp";
import { NLP_MODEL_ID, NLP_MODEL_VERSION, NLP_TOKENIZER_CAPABILITY } from "@scriptorium/module-nlp";
import { readCanonicalSnapshotEntities } from "@scriptorium/module-nlp";
import type { WorkerService } from "@scriptorium/contracts";
import YAML from "yaml";
import { addSynonymDiagnosticIssues, DIAGNOSTICS_ENGINE_ID, DIAGNOSTICS_ENGINE_VERSION, DIAGNOSTICS_MODULE_VERSION, type DiagnosticsWorkerInput, type DiagnosticsWorkerOutput, type PlotSemanticWorkerInput, type StylometricDeviationWorkerInput, type VoiceDeviationWorkerInput, type VoiceWorkerInput } from "./analysis.js";
import { loadLintRulesConfig, loadPlotLexiconConfig, loadToneLexiconConfig } from "./config.js";
import { evaluateLintRules } from "./linter/rulesEvaluator.js";
import { transformText } from "./linter/textTransformer.js";
import type { LintRule, LintWarning } from "./linter/types.js";
import type { PlotLexiconConfig } from "./plot/types.js";
import type { ToneLexiconConfig } from "./tone/types.js";
import type { StylometricMetrics, StylometricProfile } from "./stylometry/types.js";
import { removeDialogueBrackets, type StyleAttribution, type StyleFingerprint } from "./voiceStyle.js";
import { suggestSynonyms, type SynonymsConfig } from "./synonymSuggestions.js";

export * from "./analysis.js";
export { createDiagnosticsMigrationProducer } from "./migration.js";
export * from "./textAnalysis.js";
export * from "./config.js";
export * from "./linter/types.js";
export * from "./plot/types.js";
export * from "./tone/types.js";
export * from "./proseBalance/index.js";
export * from "./voiceStyle.js";
export * from "./stylometry/types.js";
export * from "./stylometry/metrics.js";
export * from "./stylometry/profile.js";
export * from "./stylometry/deviationDetector.js";
export * from "./textHash.js";

const manifest: ModuleManifest = {
  id: "diagnostics", version: DIAGNOSTICS_MODULE_VERSION, contractVersion: 1,
  dependencies: ["nlp"], provides: [], requires: [NLP_TOKENIZER_CAPABILITY],
  serverEntry: "dist/index.js", browserEntry: "dist/browser.js", workerEntry: "dist/worker.js",
  statePaths: ["meta/scriptorium/modules/diagnostics"], locality: "local",
};

const MAX_TEXT_LENGTH = 500_000;
const MAX_DIALOGUE_TEXT_LENGTH = 5_000;
const MAX_DIALOGUES = 500;
const MAX_VOICE_CORPUS_CHARACTERS = 20_000;
const MAX_VOICE_ATTRIBUTIONS = 100;
const LINT_PATH_PREFIX = "manuscript/";
const MAX_WORKER_TIME_MS = 120_000;
const LINT_CONFIG_PATH = "meta/scriptorium/modules/diagnostics/lint-rules.yaml";
const TONE_CONFIG_PATH = "meta/scriptorium/modules/diagnostics/tone-lexicon.yaml";
const PLOT_CONFIG_PATH = "meta/scriptorium/modules/diagnostics/plot-lexicon.yaml";
const SYNONYMS_PATH = "meta/scriptorium/modules/nlp/synonyms.yaml";

type RecordValue = Record<string, unknown>;
function record(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as RecordValue;
}
function parseEmpty(value: unknown): RecordValue { return record(value, "input"); }
function parseObjectOutput(value: unknown): unknown { return record(value, "output"); }
const outputSchema: ValueSchema = { parse: parseObjectOutput };
function action(id: string, effect: ModuleAction["effect"], inputSchema: ValueSchema, invoke: ModuleAction["invoke"]): ModuleAction {
  return { id, effect, inputSchema, outputSchema, invoke };
}

function parseAnalyze(value: unknown): { text: string; sceneId?: string; knownTerms: string[]; intendedTone?: string; goalConflictText?: string } {
  const input = record(value, "input");
  if (typeof input.text !== "string" || input.text.length > MAX_TEXT_LENGTH) throw new TypeError("text must be a string of at most 500000 characters");
  if (input.sceneId !== undefined && (typeof input.sceneId !== "string" || input.sceneId.length > 256)) throw new TypeError("sceneId must be a string of at most 256 characters");
  const knownTerms = input.knownTerms ?? [];
  if (!Array.isArray(knownTerms) || knownTerms.some((term) => typeof term !== "string" || term.length > 256)) throw new TypeError("knownTerms must be a string array");
  if (input.intendedTone !== undefined && (typeof input.intendedTone !== "string" || input.intendedTone.length > 128)) throw new TypeError("intendedTone must be a string");
  if (input.goalConflictText !== undefined && (typeof input.goalConflictText !== "string" || input.goalConflictText.length > 10_000)) throw new TypeError("goalConflictText must be a string");
  return { text: input.text, ...(typeof input.sceneId === "string" ? { sceneId: input.sceneId } : {}), knownTerms: [...new Set(knownTerms as string[])], ...(typeof input.intendedTone === "string" ? { intendedTone: input.intendedTone } : {}), ...(typeof input.goalConflictText === "string" ? { goalConflictText: input.goalConflictText } : {}) };
}

function parseLint(value: unknown): { text: string } {
  const input = record(value, "input");
  if (typeof input.text !== "string" || input.text.length > MAX_TEXT_LENGTH) throw new TypeError("text must be a string of at most 500000 characters");
  return { text: input.text };
}

function parseFix(value: unknown): { path: string; baseRevision?: string; operationId?: string } {
  const input = record(value, "input");
  if (typeof input.path !== "string") throw new TypeError("path must be a manuscript path");
  assertProjectPath(input.path);
  if (!input.path.startsWith(LINT_PATH_PREFIX) || !input.path.endsWith(".md")) throw new TypeError("path must point to a Markdown file under manuscript/");
  if (input.baseRevision !== undefined && (typeof input.baseRevision !== "string" || input.baseRevision.length > 256)) throw new TypeError("baseRevision must be a revision string");
  if (input.operationId !== undefined && (typeof input.operationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.operationId))) throw new TypeError("operationId must be a stable operation identifier");
  return { path: input.path, ...(typeof input.baseRevision === "string" ? { baseRevision: input.baseRevision } : {}), ...(typeof input.operationId === "string" ? { operationId: input.operationId } : {}) };
}

function parseVoice(value: unknown): { dialoguesByCharacter: Record<string, string[]> } {
  const input = record(value, "input");
  const raw = record(input.dialoguesByCharacter, "dialoguesByCharacter");
  const dialoguesByCharacter: Record<string, string[]> = {};
  let total = 0;
  let characters = 0;
  for (const [id, value] of Object.entries(raw)) {
    if (!id || id.length > 256 || !Array.isArray(value) || value.some((text) => typeof text !== "string" || text.length > MAX_DIALOGUE_TEXT_LENGTH)) throw new TypeError("dialoguesByCharacter must map IDs to bounded string arrays");
    total += value.length;
    characters += value.reduce((sum, text) => sum + (typeof text === "string" ? text.length : 0), 0);
    if (total > MAX_DIALOGUES) throw new TypeError(`dialogue corpus exceeds ${MAX_DIALOGUES} utterances`);
    if (characters > MAX_VOICE_CORPUS_CHARACTERS) throw new TypeError(`dialogue corpus exceeds ${MAX_VOICE_CORPUS_CHARACTERS} characters`);
    dialoguesByCharacter[id] = [...value] as string[];
  }
  return { dialoguesByCharacter };
}

function parseVoiceDeviations(value: unknown): { attributions: Array<Omit<StyleAttribution, "tokens">>; fingerprints: StyleFingerprint[] } {
  const input = record(value, "input");
  if (!Array.isArray(input.attributions) || input.attributions.length > MAX_VOICE_ATTRIBUTIONS) throw new TypeError(`attributions must contain at most ${MAX_VOICE_ATTRIBUTIONS} utterances`);
  if (!Array.isArray(input.fingerprints) || input.fingerprints.length > MAX_DIALOGUES) throw new TypeError("fingerprints must be an array of at most 500 profiles");
  let characters = 0;
  const attributions = input.attributions.map((value, index) => {
    const attribution = record(value, `attribution ${index + 1}`);
    if (!(attribution.speakerEntityId === null || (typeof attribution.speakerEntityId === "string" && attribution.speakerEntityId.length <= 256)) ||
        !["high", "low", "none"].includes(String(attribution.confidence)) || typeof attribution.text !== "string" || attribution.text.length > MAX_DIALOGUE_TEXT_LENGTH ||
        !Number.isSafeInteger(attribution.sentenceIndex) || (attribution.sentenceIndex as number) < 1) {
      throw new TypeError(`attribution ${index + 1} has invalid speaker, confidence, text, or sentenceIndex`);
    }
    characters += attribution.text.length;
    return {
      speakerEntityId: attribution.speakerEntityId as string | null,
      confidence: attribution.confidence as StyleAttribution["confidence"],
      text: attribution.text,
      sentenceIndex: attribution.sentenceIndex as number,
    };
  });
  if (characters > MAX_VOICE_CORPUS_CHARACTERS) throw new TypeError(`attributions exceed ${MAX_VOICE_CORPUS_CHARACTERS} characters`);

  const fingerprints = input.fingerprints.map((value, index): StyleFingerprint => {
    const fingerprint = record(value, `fingerprint ${index + 1}`);
    const distribution = (value: unknown, label: string): Record<string, number> => {
      const raw = record(value, label);
      if (Object.keys(raw).length > 2_000 || Object.values(raw).some((item) => typeof item !== "number" || !Number.isFinite(item) || item < 0)) throw new TypeError(`${label} must contain finite non-negative weights`);
      return raw as Record<string, number>;
    };
    const numbers = ["exclamationRate", "questionRate", "avgDialogueLength", "dialogueLengthVariance", "politeRatio", "katakanaRate"] as const;
    if (typeof fingerprint.entityId !== "string" || fingerprint.entityId.length > 256 || !Number.isSafeInteger(fingerprint.dialogueCount) || (fingerprint.dialogueCount as number) < 0 ||
        numbers.some((key) => typeof fingerprint[key] !== "number" || !Number.isFinite(fingerprint[key]) || (fingerprint[key] as number) < 0)) {
      throw new TypeError(`fingerprint ${index + 1} has invalid values`);
    }
    return {
      entityId: fingerprint.entityId,
      dialogueCount: fingerprint.dialogueCount as number,
      firstPersonDist: distribution(fingerprint.firstPersonDist, `fingerprint ${index + 1}.firstPersonDist`),
      endingBigramDist: distribution(fingerprint.endingBigramDist, `fingerprint ${index + 1}.endingBigramDist`),
      particleDist: distribution(fingerprint.particleDist, `fingerprint ${index + 1}.particleDist`),
      exclamationRate: fingerprint.exclamationRate as number,
      questionRate: fingerprint.questionRate as number,
      avgDialogueLength: fingerprint.avgDialogueLength as number,
      dialogueLengthVariance: fingerprint.dialogueLengthVariance as number,
      politeRatio: fingerprint.politeRatio as number,
      katakanaRate: fingerprint.katakanaRate as number,
    };
  });
  return { attributions, fingerprints };
}

function parseStylometricDeviations(value: unknown): { attributions: Array<Omit<StyleAttribution, "tokens">>; profiles: StylometricProfile[] } {
  const input = record(value, "input");
  if (!Array.isArray(input.attributions) || input.attributions.length > MAX_VOICE_ATTRIBUTIONS) throw new TypeError(`attributions must contain at most ${MAX_VOICE_ATTRIBUTIONS} utterances`);
  if (!Array.isArray(input.profiles) || input.profiles.length > MAX_DIALOGUES) throw new TypeError("profiles must be an array of at most 500 records");
  let characters = 0;
  const attributions = input.attributions.map((value, index) => {
    const attribution = record(value, `attribution ${index + 1}`);
    if (!(attribution.speakerEntityId === null || (typeof attribution.speakerEntityId === "string" && attribution.speakerEntityId.length <= 256)) ||
        !["high", "low", "none"].includes(String(attribution.confidence)) || typeof attribution.text !== "string" || attribution.text.length > MAX_DIALOGUE_TEXT_LENGTH ||
        !Number.isSafeInteger(attribution.sentenceIndex) || (attribution.sentenceIndex as number) < 1) {
      throw new TypeError(`attribution ${index + 1} has invalid speaker, confidence, text, or sentenceIndex`);
    }
    characters += attribution.text.length;
    return { speakerEntityId: attribution.speakerEntityId as string | null, confidence: attribution.confidence as StyleAttribution["confidence"], text: attribution.text, sentenceIndex: attribution.sentenceIndex as number };
  });
  if (characters > MAX_VOICE_CORPUS_CHARACTERS) throw new TypeError(`attributions exceed ${MAX_VOICE_CORPUS_CHARACTERS} characters`);

  const metricKeys: Array<keyof StylometricMetrics> = ["typeTokenRatio", "morphemeCount", "commaFrequency", "adjectiveRatio", "verbRatio"];
  const parseMetrics = (value: unknown, label: string): StylometricMetrics => {
    const metrics = record(value, label);
    for (const key of metricKeys) if (typeof metrics[key] !== "number" || !Number.isFinite(metrics[key]) || (metrics[key] as number) < 0) throw new TypeError(`${label}.${key} must be a finite non-negative number`);
    return Object.fromEntries(metricKeys.map((key) => [key, metrics[key]])) as unknown as StylometricMetrics;
  };
  const profiles = input.profiles.map((value, index): StylometricProfile => {
    const profile = record(value, `profile ${index + 1}`);
    if (typeof profile.entityId !== "string" || !profile.entityId || profile.entityId.length > 256 || !Number.isSafeInteger(profile.dialogueCount) || (profile.dialogueCount as number) < 0) throw new TypeError(`profile ${index + 1} has invalid identity or dialogueCount`);
    return { entityId: profile.entityId, dialogueCount: profile.dialogueCount as number, mean: parseMetrics(profile.mean, `profile ${index + 1}.mean`), stdDev: parseMetrics(profile.stdDev, `profile ${index + 1}.stdDev`) };
  });
  return { attributions, profiles };
}

function parsePlotSemantics(value: unknown): { sceneId: string; text?: string } {
  const input = record(value, "input");
  if (typeof input.sceneId !== "string" || !input.sceneId.trim() || input.sceneId.length > 256) throw new TypeError("sceneId must be a non-empty string of at most 256 characters");
  if (input.text !== undefined && (typeof input.text !== "string" || input.text.length > MAX_TEXT_LENGTH)) throw new TypeError(`text must be a string of at most ${MAX_TEXT_LENGTH} characters`);
  return { sceneId: input.sceneId, ...(typeof input.text === "string" ? { text: input.text } : {}) };
}

async function withTokenizer<T>(moduleContext: ModuleContext, signal: AbortSignal, fn: (tokenizer: NlpTokenizerCapability) => Promise<T>): Promise<T> {
  if (signal.aborted) throw Object.assign(new Error("Diagnostics action was cancelled"), { code: "job_cancelled" });
  const lease = await moduleContext.acquireCapability<NlpTokenizerCapability>(NLP_TOKENIZER_CAPABILITY);
  try { return await fn(lease.value); }
  finally { await lease.release(); }
}

function makeRequest<T>(context: ModuleActionContext, task: string, input: T, model: string, modelVersion: string, moduleVersion: string): JobRequest<T> {
  return {
    id: randomUUID(), module: "diagnostics", task, snapshot: context.reader.snapshot,
    model, modelVersion, moduleVersion, deadline: Date.now() + MAX_WORKER_TIME_MS, input,
  };
}

async function runDiagnosticsWorker<T>(moduleContext: ModuleContext, context: ModuleActionContext, task: string, input: unknown): Promise<T> {
  const encoded = JSON.stringify(input);
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_JOB_INPUT_BYTES) throw new TypeError(`Diagnostics worker input exceeds ${MAX_JOB_INPUT_BYTES} UTF-8 bytes`);
  const worker: WorkerService = await moduleContext.createWorkerService();
  try {
    const request = makeRequest(context, task, input, DIAGNOSTICS_ENGINE_ID, DIAGNOSTICS_ENGINE_VERSION, DIAGNOSTICS_MODULE_VERSION);
    const result = await worker.request<T>(request, context.signal);
    if (!result.ok) throw Object.assign(new Error(result.error.message), result.error);
    return result.result.output;
  } finally { await worker.dispose(); }
}

function parseSynonymGroups(data: unknown): Array<{ words: string[]; context?: "negative" | "positive" }> {
  if (data === undefined) return [];
  const root = record(data, SYNONYMS_PATH);
  const groups = root.groups ?? [];
  if (!Array.isArray(groups)) throw new TypeError(`${SYNONYMS_PATH}.groups must be an array`);
  return groups.map((value, index) => {
    const group = record(value, `synonym group ${index + 1}`);
    if (!Array.isArray(group.words) || group.words.length < 2 || group.words.some((word) => typeof word !== "string" || !word.trim())) throw new TypeError(`synonym group ${index + 1} must contain at least two words`);
    if (group.context !== undefined && group.context !== "negative" && group.context !== "positive") throw new TypeError(`synonym group ${index + 1} has invalid context`);
    return { words: group.words as string[], ...(group.context === "negative" || group.context === "positive" ? { context: group.context } : {}) };
  });
}

async function readYaml(context: ModuleActionContext, path: string): Promise<unknown> {
  const file = await context.reader.read(path);
  if (!file) return undefined;
  try { return YAML.parse(file.content); }
  catch (error) { throw new TypeError(`${path} contains invalid YAML: ${error instanceof Error ? error.message : "parse error"}`); }
}

interface SnapshotAnalysisEntity {
  id: string;
  name?: string;
  aliases?: string[];
  data: RecordValue;
  kind: "scene" | "other";
  filePath: string;
}

/**
 * Read only the canonical source entity documents needed by analyzeManuscript.
 * This mirrors the source Core loader's YAML/frontmatter extraction while
 * keeping the analysis tied to this action's immutable SnapshotReader.
 */
async function readSnapshotAnalysisEntities(context: ModuleActionContext): Promise<SnapshotAnalysisEntity[]> {
  const entities = await readCanonicalSnapshotEntities(context.reader, context.signal);
  return entities.map((entity) => ({
    id: entity.id,
    ...(entity.name ? { name: entity.name } : {}),
    ...(entity.aliases ? { aliases: entity.aliases } : {}),
    data: entity.raw,
    kind: entity.type === "scene" ? "scene" : "other",
    filePath: entity.filePath,
  }));
}

function extractGoalConflictText(data: RecordValue): string | undefined {
  const parts: string[] = [];
  if (typeof data.goal === "string" && data.goal.length > 0) parts.push(data.goal);
  if (typeof data.conflict === "string" && data.conflict.length > 0) parts.push(data.conflict);
  return parts.length ? parts.join("。") : undefined;
}

function extractFrontMatter(content: string): { frontMatter: string; body: string } {
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(content);
  return match ? { frontMatter: match[0], body: content.slice(match[0].length) } : { frontMatter: "", body: content };
}

function operation(context: ModuleActionContext, path: string, revision: string, content: string, operationId: string): ChangeOperation {
  return {
    id: operationId, generation: 0, repository: context.reader.snapshot.repository,
    baseRemoteCommit: context.reader.snapshot.remoteCommit, effect: "manuscript",
    reads: [{ path, revision }], writes: [{ path, revision, content }], message: "Apply reviewed manuscript lint fixes",
  };
}

async function analyzeAction(value: unknown, context: ModuleActionContext, moduleContext: ModuleContext): Promise<ActionResult> {
  const input = value as ReturnType<typeof parseAnalyze>;
  return withTokenizer(moduleContext, context.signal, async (tokenizer) => {
    const entities = await readSnapshotAnalysisEntities(context);
    const morphology: MorphologyAnalysis = await tokenizer.analyze(input.text, context.reader.snapshot, context.signal);
    const scene = input.sceneId ? entities.find((entity) => entity.id === input.sceneId && entity.kind === "scene") : undefined;
    const intendedTone = input.intendedTone ?? (typeof scene?.data.intended_tone === "string" && scene.data.intended_tone.length > 0 ? scene.data.intended_tone : undefined);
    const goalConflictText = input.goalConflictText ?? (scene ? extractGoalConflictText(scene.data) : undefined);
    const goalMorphology = goalConflictText ? await tokenizer.analyze(goalConflictText, context.reader.snapshot, context.signal) : undefined;
    const [lintConfig, toneLexicon, plotLexicon, synonymData] = await Promise.all([
      loadLintRulesConfig(context.reader), loadToneLexiconConfig(context.reader), loadPlotLexiconConfig(context.reader), readYaml(context, SYNONYMS_PATH),
    ]);
    const workerInput: DiagnosticsWorkerInput = {
      text: input.text,
      knownTerms: [...new Set([...entities.flatMap((entity) => [entity.name, ...(entity.aliases ?? [])]).filter((term): term is string => typeof term === "string" && term.length > 0), ...input.knownTerms])],
      morphology, lintConfig, toneLexicon, plotLexicon,
      ...(intendedTone ? { intendedTone } : {}),
      ...(goalConflictText ? { goalConflictText } : {}),
      ...(goalMorphology ? { goalMorphology } : {}),
    };
    const data: DiagnosticsWorkerOutput = await runDiagnosticsWorker(moduleContext, context, "diagnostics.analyze", workerInput);
    const synonyms = await suggestSynonyms(input.text, data.analysis.rhythmWarnings, data.analysis.habitualPhraseWarnings, {
      snapshot: context.reader.snapshot,
      signal: context.signal,
      tokenizer,
      toneLexicon,
      synonymsConfig: { groups: parseSynonymGroups(synonymData) } as SynonymsConfig,
    });
    return { ok: true, snapshot: context.reader.snapshot, data: {
      ...data,
      synonymSuggestions: synonyms,
      issues: addSynonymDiagnosticIssues(data.issues, synonyms),
      model: NLP_MODEL_ID,
      modelVersion: NLP_MODEL_VERSION,
      diagnosticsEngine: DIAGNOSTICS_ENGINE_ID,
      diagnosticsEngineVersion: DIAGNOSTICS_ENGINE_VERSION,
    } };
  });
}

async function checkPlotSemanticsAction(value: unknown, context: ModuleActionContext, moduleContext: ModuleContext): Promise<ActionResult> {
  const input = value as ReturnType<typeof parsePlotSemantics>;
  const entities = await readSnapshotAnalysisEntities(context);
  const scene = entities.find((entity) => entity.id === input.sceneId && entity.kind === "scene");
  if (!scene) throw Object.assign(new Error(`Scene not found: ${input.sceneId}`), { code: "not_found" });
  const goalConflictText = extractGoalConflictText(scene.data);
  if (!goalConflictText) return { ok: true, snapshot: context.reader.snapshot, data: { warnings: [], model: NLP_MODEL_ID, modelVersion: NLP_MODEL_VERSION, diagnosticsEngine: DIAGNOSTICS_ENGINE_ID, diagnosticsEngineVersion: DIAGNOSTICS_ENGINE_VERSION } };

  let text = input.text;
  if (text === undefined) {
    const manuscriptPath = scene.data.manuscript;
    if (typeof manuscriptPath !== "string") throw Object.assign(new Error(`Scene has no manuscript body: ${input.sceneId}`), { code: "not_found" });
    assertProjectPath(manuscriptPath);
    if (!manuscriptPath.startsWith("manuscript/") || !manuscriptPath.endsWith(".md")) throw Object.assign(new Error("Scene manuscript path is invalid"), { code: "invalid_path" });
    const file = await context.reader.read(manuscriptPath);
    if (!file) throw Object.assign(new Error(`Scene manuscript not found: ${input.sceneId}`), { code: "not_found" });
    text = extractFrontMatter(file.content).body.trim();
  }
  return withTokenizer(moduleContext, context.signal, async (tokenizer) => {
    const [goal, body, plotLexicon] = await Promise.all([
      tokenizer.analyze(goalConflictText, context.reader.snapshot, context.signal),
      tokenizer.analyze(text!, context.reader.snapshot, context.signal),
      loadPlotLexiconConfig(context.reader),
    ]);
    const workerInput: PlotSemanticWorkerInput = { goalTokens: goal.tokens, bodyTokens: body.tokens, plotLexicon };
    const result = await runDiagnosticsWorker<{ warnings: DiagnosticsWorkerOutput["plotSemanticWarnings"] }>(moduleContext, context, "diagnostics.checkPlotSemantics", workerInput);
    return { ok: true, snapshot: context.reader.snapshot, data: { ...result, model: NLP_MODEL_ID, modelVersion: NLP_MODEL_VERSION, diagnosticsEngine: DIAGNOSTICS_ENGINE_ID, diagnosticsEngineVersion: DIAGNOSTICS_ENGINE_VERSION } };
  });
}

function makeActions(moduleContext: ModuleContext): ModuleAction[] {
  const analyzeInput = { parse: parseAnalyze };
  return [
    action("diagnostics.analyze", "compute", analyzeInput, (value, context) => analyzeAction(value, context, moduleContext)),
    action("diagnostics.checkPlotSemantics", "compute", { parse: parsePlotSemantics }, (value, context) => checkPlotSemanticsAction(value, context, moduleContext)),
    action("diagnostics.lint", "compute", { parse: parseLint }, async (value, context) => {
      const { text } = value as ReturnType<typeof parseLint>;
      const config = await loadLintRulesConfig(context.reader);
      const warnings: LintWarning[] = evaluateLintRules(text, config.rules);
      const transformed = transformText(text, config.rules);
      return { ok: true, snapshot: context.reader.snapshot, data: { warnings, fixed: transformed !== text, body: transformed } };
    }),
    action("diagnostics.proposeLintFix", "propose", { parse: parseFix }, async (value, context) => {
      const { path, baseRevision, operationId } = value as ReturnType<typeof parseFix>;
      const file = await context.reader.read(path);
      if (!file) throw Object.assign(new Error(`Manuscript not found: ${path}`), { code: "not_found" });
      if (baseRevision !== undefined && baseRevision !== file.revision) throw Object.assign(new Error("Manuscript revision changed; reload before formatting"), { code: "revision_conflict" });
      if (file.content.length > MAX_TEXT_LENGTH + 100_000) throw new TypeError("Manuscript exceeds the lint size limit");
      const config = await loadLintRulesConfig(context.reader);
      const { frontMatter, body } = extractFrontMatter(file.content);
      const warnings = evaluateLintRules(body, config.rules);
      const transformed = transformText(body, config.rules);
      if (transformed === body) return { ok: true, snapshot: context.reader.snapshot, data: { path, warnings, fixed: false, body } };
      const updated = frontMatter + transformed;
      const proposedOperationId = operationId ?? randomUUID();
      const proposal = await context.propose([operation(context, path, file.revision, updated, proposedOperationId)], [{
        id: randomUUID(), snapshot: context.reader.snapshot, module: "diagnostics", kind: "lint_fix",
        paths: [{ path, revision: file.revision }], details: { warningCount: warnings.length, analyzerVersion: DIAGNOSTICS_MODULE_VERSION },
      }]);
      return { ok: true, snapshot: context.reader.snapshot, data: { path, warnings, fixed: true, body: transformed, operationId: proposedOperationId, baseRevision: file.revision, proposal } };
    }),
    action("diagnostics.voiceProfiles", "compute", { parse: parseVoice }, async (value, context) => {
      const { dialoguesByCharacter } = value as ReturnType<typeof parseVoice>;
      return withTokenizer(moduleContext, context.signal, async (tokenizer) => {
        const tokenized: VoiceWorkerInput["dialoguesByCharacter"] = {};
      for (const [entityId, dialogues] of Object.entries(dialoguesByCharacter)) {
          tokenized[entityId] = [];
          for (const text of dialogues) {
            const morphology = await tokenizer.analyze(removeDialogueBrackets(text), context.reader.snapshot, context.signal);
            tokenized[entityId].push({ text, tokens: morphology.tokens });
          }
        }
        const result = await runDiagnosticsWorker<ReturnType<typeof import("./analysis.js").analyzeVoiceProfiles>>(moduleContext, context, "diagnostics.voiceProfiles", { dialoguesByCharacter: tokenized });
        return { ok: true, snapshot: context.reader.snapshot, data: { ...result, model: NLP_MODEL_ID, modelVersion: NLP_MODEL_VERSION, diagnosticsEngine: DIAGNOSTICS_ENGINE_ID, diagnosticsEngineVersion: DIAGNOSTICS_ENGINE_VERSION } };
      });
    }),
    action("diagnostics.voiceDeviations", "compute", { parse: parseVoiceDeviations }, async (value, context) => {
      const input = value as ReturnType<typeof parseVoiceDeviations>;
      return withTokenizer(moduleContext, context.signal, async (tokenizer) => {
        const attributions: StyleAttribution[] = [];
        for (const attribution of input.attributions) {
          const morphology = await tokenizer.analyze(removeDialogueBrackets(attribution.text), context.reader.snapshot, context.signal);
          attributions.push({ ...attribution, tokens: morphology.tokens });
        }
        const workerInput: VoiceDeviationWorkerInput = { attributions, fingerprints: input.fingerprints };
        const result = await runDiagnosticsWorker<ReturnType<typeof import("./analysis.js").analyzeVoiceDeviations>>(moduleContext, context, "diagnostics.voiceDeviations", workerInput);
        return { ok: true, snapshot: context.reader.snapshot, data: { ...result, model: NLP_MODEL_ID, modelVersion: NLP_MODEL_VERSION, diagnosticsEngine: DIAGNOSTICS_ENGINE_ID, diagnosticsEngineVersion: DIAGNOSTICS_ENGINE_VERSION } };
      });
    }),
    action("diagnostics.stylometricDeviations", "compute", { parse: parseStylometricDeviations }, async (value, context) => {
      const input = value as ReturnType<typeof parseStylometricDeviations>;
      return withTokenizer(moduleContext, context.signal, async (tokenizer) => {
        const attributions: StyleAttribution[] = [];
        for (const attribution of input.attributions) {
          const morphology = await tokenizer.analyze(removeDialogueBrackets(attribution.text), context.reader.snapshot, context.signal);
          attributions.push({ ...attribution, tokens: morphology.tokens });
        }
        const workerInput: StylometricDeviationWorkerInput = { attributions, profiles: input.profiles };
        const result = await runDiagnosticsWorker<ReturnType<typeof import("./analysis.js").analyzeStylometricDeviations>>(moduleContext, context, "diagnostics.stylometricDeviations", workerInput);
        return { ok: true, snapshot: context.reader.snapshot, data: { ...result, model: NLP_MODEL_ID, modelVersion: NLP_MODEL_VERSION, diagnosticsEngine: DIAGNOSTICS_ENGINE_ID, diagnosticsEngineVersion: DIAGNOSTICS_ENGINE_VERSION } };
      });
    }),
  ];
}

export async function createModule(moduleContext: ModuleContext): Promise<ModuleDefinition> {
  return {
    manifest,
    actions: makeActions(moduleContext),
    ui: [
      { id: "diagnostics.analysis", module: "diagnostics", slot: "dock", title: "文章診断", action: "diagnostics.analyze" },
      { id: "diagnostics.lint", module: "diagnostics", slot: "review", title: "組版チェック", action: "diagnostics.lint" },
      { id: "diagnostics.voice", module: "diagnostics", slot: "inspection", title: "文体プロファイル", action: "diagnostics.voiceProfiles" },
    ],
    async dispose() {},
  };
}
