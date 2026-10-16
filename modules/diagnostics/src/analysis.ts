import type { MorphologyAnalysis, Token } from "@scriptorium/module-nlp";
import { computeProseBalance, type ProseBalanceResult } from "./proseBalance/index.js";
import { detectPlotSemanticWarnings } from "./plot/deviationDetector.js";
import type { PlotLexiconConfig, PlotSemanticWarning } from "./plot/types.js";
import type { LintRulesConfig } from "./linter/types.js";
import type { ToneLexiconConfig } from "./tone/types.js";
import type { TextAnalysisResult } from "./textAnalysis.js";
import { analyzeText } from "./textAnalysis.js";
import { hashManuscriptText } from "./textHash.js";
import type { SynonymSuggestion } from "./synonyms/types.js";
import { computeStylometricProfiles } from "./stylometry/profile.js";
import { detectStylometricDeviations } from "./stylometry/deviationDetector.js";
import type { StylometricProfile } from "./stylometry/types.js";
import { computeStyleFingerprints, computeVoiceSeparationMatrix, detectStyleDeviations, type StyleAttribution, type StyleFingerprint } from "./voiceStyle.js";
import { appendSynonymDiagnosticIssues, collectDiagnosticIssues } from "./issueNormalization.js";

export const DIAGNOSTICS_MODULE_VERSION = "0.1.0";
export const DIAGNOSTICS_ENGINE_ID = "scriptorium-diagnostics-cpu";
export const DIAGNOSTICS_ENGINE_VERSION = "1.0.0";
export const DIAGNOSTICS_ANALYZER_VERSION = "1";

export interface DiagnosticsWorkerInput {
  text: string;
  knownTerms: string[];
  intendedTone?: string;
  goalConflictText?: string;
  morphology: MorphologyAnalysis;
  goalMorphology?: MorphologyAnalysis;
  lintConfig: LintRulesConfig;
  toneLexicon: ToneLexiconConfig;
  plotLexicon: PlotLexiconConfig;
}

export interface DiagnosticIssue {
  id: string;
  kind: "rhythm" | "lint" | "habitual-phrase" | "tone" | "plot" | "voice" | "style-deviation" | "stylometric" | "term-variant" | "prose-balance" | "synonym";
  severity: "info" | "medium" | "critical";
  message: string;
  sentenceIndex?: number;
  range?: { start: number; end: number };
  actions?: Array<{ type: "replace" | "navigate" | "apply-canonical"; label?: string; payload?: Record<string, unknown> }>;
  meta?: Record<string, unknown>;
}

export interface DiagnosticsWorkerOutput {
  analyzerVersion: string;
  textHash: string;
  analysis: TextAnalysisResult;
  proseBalance: ProseBalanceResult;
  plotSemanticWarnings: PlotSemanticWarning[];
  synonymSuggestions: SynonymSuggestion[];
  issues: DiagnosticIssue[];
}

export function addSynonymDiagnosticIssues(issues: DiagnosticIssue[], suggestions: SynonymSuggestion[]): DiagnosticIssue[] {
  return appendSynonymDiagnosticIssues(issues, suggestions);
}

export async function analyzeDiagnostics(input: DiagnosticsWorkerInput): Promise<DiagnosticsWorkerOutput> {
  if (input.morphology.text !== input.text) throw new TypeError("Precomputed morphology does not match diagnostics text");
  const analysis = await analyzeText(input.text, new Set(input.knownTerms), input.lintConfig.rules, {
    lexicon: input.toneLexicon,
    intendedTone: input.intendedTone,
  }, { precomputed: input.morphology });
  const proseBalance = computeProseBalance(input.text, input.morphology.tokens);
  const plotSemanticWarnings = input.goalMorphology && input.goalConflictText
    ? detectPlotSemanticWarnings(input.goalMorphology.tokens, input.morphology.tokens, input.plotLexicon)
    : [];
  const issues = collectDiagnosticIssues(analysis, [], [], [], plotSemanticWarnings, proseBalance, [], input.lintConfig.severity);
  return { analyzerVersion: DIAGNOSTICS_ANALYZER_VERSION, textHash: hashManuscriptText(input.text), analysis, proseBalance, plotSemanticWarnings, synonymSuggestions: [], issues };
}

export interface VoiceWorkerInput { dialoguesByCharacter: Record<string, Array<{ text: string; tokens: Token[] }>> }
export interface VoiceDeviationWorkerInput {
  attributions: StyleAttribution[];
  fingerprints: StyleFingerprint[];
  options?: { minDialogueForDeviation?: number; zScoreThreshold?: number };
}
export interface StylometricDeviationWorkerInput {
  attributions: StyleAttribution[];
  profiles: StylometricProfile[];
}
export interface PlotSemanticWorkerInput {
  goalTokens: Token[];
  bodyTokens: Token[];
  plotLexicon: PlotLexiconConfig;
}

export function analyzeVoiceProfiles(input: VoiceWorkerInput) {
  const fingerprints = computeStyleFingerprints(input.dialoguesByCharacter);
  const matrix = computeVoiceSeparationMatrix(fingerprints);
  const tokenized = new Map(Object.entries(input.dialoguesByCharacter).map(([id, rows]) => [id, rows.map((row) => row.tokens)]));
  return { fingerprints, matrix, stylometricProfiles: computeStylometricProfiles(tokenized) };
}

export function analyzeVoiceDeviations(input: VoiceDeviationWorkerInput) {
  return { warnings: detectStyleDeviations(input.attributions, input.fingerprints, input.options) };
}

export function analyzeStylometricDeviations(input: StylometricDeviationWorkerInput) {
  return { warnings: detectStylometricDeviations(input.attributions, input.profiles) };
}

export function analyzePlotSemantics(input: PlotSemanticWorkerInput) {
  return { warnings: detectPlotSemanticWarnings(input.goalTokens, input.bodyTokens, input.plotLexicon) };
}
