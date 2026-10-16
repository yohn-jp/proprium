import type { ActionResult, ModuleActionContext, SnapshotId } from "@scriptorium/contracts";
import type { DiagnosticIssue, DiagnosticsWorkerOutput } from "./analysis.js";
import type { ProseBalanceResult } from "./proseBalance/index.js";
import type { PlotSemanticWarning } from "./plot/types.js";
import type { StylometricDeviationWarning } from "./stylometry/types.js";
import type { SynonymSuggestion } from "./synonyms/types.js";
import type { TextAnalysisResult } from "./textAnalysis.js";
import type { VoiceConsistencyWarning } from "./declaredVoice.js";
import type { StyleDeviationWarning } from "./voiceStyle.js";
import { collectDiagnosticIssues } from "./issueNormalization.js";
import { loadLintRulesConfig } from "./config.js";
import { readCanonicalSnapshotEntities } from "@scriptorium/module-nlp";

type DataRecord = Record<string, unknown>;
interface CanonicalEntity {
  id: string;
  type: string;
  filePath: string;
  raw?: DataRecord;
  data?: DataRecord;
  name?: string;
  aliases?: string[];
  body?: string;
}

export interface SceneDiagnosticsResult {
  textHash: string;
  tier: "full";
  meta: { timingMs: Record<string, number>; cacheHit: false };
  analysis: TextAnalysisResult;
  speakerAttributions: unknown[];
  estimatedN?: number;
  clusterTrails?: unknown[];
  voiceWarnings: VoiceConsistencyWarning[];
  styleDeviations: StyleDeviationWarning[];
  stylometricDeviations: StylometricDeviationWarning[];
  plotSemanticWarnings: PlotSemanticWarning[];
  proseBalance: ProseBalanceResult;
  synonymSuggestions: SynonymSuggestion[];
  issues: DiagnosticIssue[];
}

function fail(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function sameSnapshot(left: SnapshotId, right: SnapshotId): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function asRecord(value: unknown, label: string): DataRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as DataRecord;
}

function arrayField<T>(value: DataRecord, key: string, label: string): T[] {
  if (!Array.isArray(value[key])) throw new TypeError(`${label}.${key} must be an array`);
  return value[key] as T[];
}

async function invoke(context: ModuleActionContext, actionId: string, input: unknown): Promise<unknown> {
  const result: ActionResult = await context.invoke(actionId, input, context.signal);
  if (!sameSnapshot(result.snapshot, context.reader.snapshot)) throw fail("snapshot_mismatch", `${actionId} returned data for a different snapshot`);
  if (!result.ok) throw fail(result.error.code, `${actionId} failed: ${result.error.message}`);
  return result.data;
}

async function optionalStoryEntities(context: ModuleActionContext, available: Set<string>): Promise<Array<DataRecord> | undefined> {
  if (!available.has("story.entities.list")) return undefined;
  try {
    const value = await invoke(context, "story.entities.list", {});
    if (!Array.isArray(value)) throw new TypeError("story.entities.list must return an entity array");
    return value.map((entity, index) => asRecord(entity, `story entity ${index + 1}`));
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
    if (["action_not_found", "module_disabled", "component_unavailable"].includes(code)) return undefined;
    throw error;
  }
}

function speakerDefinitions(entities: CanonicalEntity[], storyEntities?: Array<DataRecord>): Record<string, DataRecord> {
  const definitions: Record<string, DataRecord> = {};
  const source = storyEntities ?? entities;
  for (const entity of source) {
    if (entity.type !== "character" || typeof entity.id !== "string") continue;
    const raw = "raw" in entity ? entity.raw : entity.data;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) definitions[entity.id] = raw as DataRecord;
  }
  return definitions;
}

async function timed<T>(timings: Record<string, number>, key: string, run: () => Promise<T> | T): Promise<T> {
  const started = performance.now();
  try { return await run(); }
  finally { timings[key] = Math.round((performance.now() - started) * 10) / 10; }
}

export async function composeSceneDiagnostics(
  input: { sceneId: string; text?: string },
  context: ModuleActionContext,
): Promise<SceneDiagnosticsResult> {
  const totalStarted = performance.now();
  const timings: Record<string, number> = {};
  const entities = await readCanonicalSnapshotEntities(context.reader, context.signal);
  const scene = entities.find((entity) => entity.id === input.sceneId && entity.type === "scene");
  if (!scene) throw fail("not_found", `Scene not found: ${input.sceneId}`);
  let savedBody: string | undefined;
  if (typeof scene.raw.manuscript === "string") {
    savedBody = entities.find((entity) => entity.type === "manuscript" && entity.filePath === scene.raw.manuscript)?.body;
  }
  const text = input.text ?? savedBody;
  if (text === undefined) throw fail("not_found", `Scene not found or has no manuscript body: ${input.sceneId}`);

  const available = new Set((await context.listActions()).map((descriptor) => descriptor.id));
  const requiredSpeakerActions = ["speaker.attribute", "speaker.voice.profiles"];
  const missingSpeakerActions = requiredSpeakerActions.filter((actionId) => !available.has(actionId));
  if (missingSpeakerActions.length) {
    throw fail("component_unavailable", `Full scene diagnostics require the speaker module actions: ${missingSpeakerActions.join(", ")}`);
  }

  const lintConfig = await loadLintRulesConfig(context.reader);
  const analysisData = asRecord(await timed(timings, "analyze", () => invoke(context, "diagnostics.analyze", {
    text,
    sceneId: input.sceneId,
  })), "diagnostics.analyze output") as DiagnosticsWorkerOutput & DataRecord;
  const speakerAttributionData = asRecord(await timed(timings, "speakerAttribution", () => invoke(context, "speaker.attribute", {
    sceneId: input.sceneId,
    text,
  })), "speaker.attribute output");
  const profilesData = asRecord(await timed(timings, "speakerProfiles", () => invoke(context, "speaker.voice.profiles", {})), "speaker.voice.profiles output");

  const attributions = arrayField<DataRecord>(speakerAttributionData, "attributions", "speaker.attribute");
  const attributionInput = attributions.map((attribution, index) => {
    if (!(attribution.speakerEntityId === null || typeof attribution.speakerEntityId === "string")
        || !["high", "low", "none"].includes(String(attribution.confidence))
        || typeof attribution.text !== "string"
        || !Number.isSafeInteger(attribution.sentenceIndex)) {
      throw new TypeError(`speaker.attribute attribution ${index + 1} is incomplete`);
    }
    return {
      speakerEntityId: attribution.speakerEntityId,
      confidence: attribution.confidence,
      text: attribution.text,
      sentenceIndex: attribution.sentenceIndex,
    };
  });
  const storyData = await optionalStoryEntities(context, available);
  const definitions = speakerDefinitions(entities.map((entity) => ({
    id: entity.id,
    type: entity.type,
    data: entity.raw,
    kind: entity.type === "scene" ? "scene" : "other",
    filePath: entity.filePath,
    ...(entity.name ? { name: entity.name } : {}),
    ...(entity.aliases ? { aliases: entity.aliases } : {}),
    ...(entity.body !== undefined ? { body: entity.body } : {}),
  })), storyData);
  const storyScene = storyData?.find((entity) => entity.id === input.sceneId && entity.type === "scene");
  const sceneMetadata = storyScene && storyScene.raw && typeof storyScene.raw === "object" && !Array.isArray(storyScene.raw)
    ? storyScene.raw as DataRecord
    : scene.raw;
  const fingerprints = arrayField(profilesData, "fingerprints", "speaker.voice.profiles");
  const stylometricProfiles = arrayField(profilesData, "stylometricProfiles", "speaker.voice.profiles");
  const warningInput = { attributions: attributionInput, speakerDefinitions: definitions, sceneMetadata };

  const [declaredData, styleData, stylometricData] = await Promise.all([
    timed(timings, "voiceConsistency", () => invoke(context, "diagnostics.voiceConsistency", warningInput)),
    timed(timings, "styleDeviations", () => invoke(context, "diagnostics.voiceDeviations", { attributions: attributionInput, fingerprints })),
    timed(timings, "stylometricDeviations", () => invoke(context, "diagnostics.stylometricDeviations", { attributions: attributionInput, profiles: stylometricProfiles })),
  ]);
  const declaredWarnings = arrayField(asRecord(declaredData, "diagnostics.voiceConsistency output"), "warnings", "diagnostics.voiceConsistency") as VoiceConsistencyWarning[];
  const styleDeviations = arrayField(asRecord(styleData, "diagnostics.voiceDeviations output"), "warnings", "diagnostics.voiceDeviations") as StyleDeviationWarning[];
  const stylometricDeviations = arrayField(asRecord(stylometricData, "diagnostics.stylometricDeviations output"), "warnings", "diagnostics.stylometricDeviations") as StylometricDeviationWarning[];

  const analysis = analysisData.analysis as TextAnalysisResult;
  const proseBalance = analysisData.proseBalance as ProseBalanceResult;
  const plotSemanticWarnings = arrayField<PlotSemanticWarning>(analysisData, "plotSemanticWarnings", "diagnostics.analyze");
  const synonymSuggestions = arrayField<SynonymSuggestion>(analysisData, "synonymSuggestions", "diagnostics.analyze");
  const issues = await timed(timings, "collectIssues", () => collectDiagnosticIssues(
    analysis,
    declaredWarnings,
    styleDeviations,
    stylometricDeviations,
    plotSemanticWarnings,
    proseBalance,
    synonymSuggestions,
    lintConfig.severity,
  ));
  timings.total = Math.round((performance.now() - totalStarted) * 10) / 10;

  if (typeof analysisData.textHash !== "string") throw new TypeError("diagnostics.analyze returned no textHash");
  if (typeof speakerAttributionData.estimatedN !== "number") throw new TypeError("speaker.attribute returned no estimatedN");
  const clusterTrails = arrayField<unknown>(speakerAttributionData, "clusterTrails", "speaker.attribute");

  return {
    textHash: analysisData.textHash,
    tier: "full",
    meta: { timingMs: timings, cacheHit: false },
    analysis,
    speakerAttributions: attributions,
    estimatedN: speakerAttributionData.estimatedN,
    clusterTrails,
    voiceWarnings: declaredWarnings,
    styleDeviations,
    stylometricDeviations,
    plotSemanticWarnings,
    proseBalance,
    synonymSuggestions,
    issues,
  };
}
