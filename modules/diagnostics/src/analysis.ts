import type { MorphologyAnalysis, Token } from "@scriptorium/module-nlp";
import { computeProseBalance, type ProseBalanceResult } from "./proseBalance/index.js";
import { detectPlotSemanticWarnings } from "./plot/deviationDetector.js";
import type { PlotLexiconConfig, PlotSemanticWarning } from "./plot/types.js";
import type { LintRulesConfig } from "./linter/types.js";
import type { ToneLexiconConfig } from "./tone/types.js";
import type { TextAnalysisResult } from "./textAnalysis.js";
import { analyzeText } from "./textAnalysis.js";
import { hashManuscriptText } from "./textHash.js";
import { resolveDiagnosticSeverityThresholds } from "./config.js";
import type { SynonymSuggestion } from "./synonyms/types.js";
import { computeStylometricProfiles } from "./stylometry/profile.js";
import { detectStylometricDeviations } from "./stylometry/deviationDetector.js";
import type { StylometricProfile } from "./stylometry/types.js";
import { computeStyleFingerprints, computeVoiceSeparationMatrix, detectStyleDeviations, type StyleAttribution, type StyleFingerprint } from "./voiceStyle.js";

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
  kind: "rhythm" | "lint" | "habitual-phrase" | "tone" | "plot" | "term-variant" | "prose-balance" | "synonym";
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

function collectDiagnosticIssues(
  analysis: TextAnalysisResult,
  plot: PlotSemanticWarning[],
  prose: ProseBalanceResult,
  severity: LintRulesConfig["severity"],
): DiagnosticIssue[] {
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-${++counter}`;
  const thresholds = resolveDiagnosticSeverityThresholds(severity);
  const severityFromCount = (count: number, limits: { infoMin: number; mediumMin: number }): DiagnosticIssue["severity"] => count >= limits.mediumMin ? "medium" : "info";
  const issues: DiagnosticIssue[] = [];
  for (const warning of analysis.rhythmWarnings) issues.push({
    id: nextId("rhythm"), kind: "rhythm", severity: severityFromCount(warning.count, thresholds.rhythm),
    message: `語尾「${warning.ending}」が${warning.count}文連続（文${warning.startSentenceIndex}〜）`, sentenceIndex: warning.startSentenceIndex,
  });
  for (const warning of analysis.lintWarnings) issues.push({
    id: nextId("lint"), kind: "lint", severity: "medium", message: warning.message,
    ...(warning.length > 0 ? { range: { start: warning.offset, end: warning.offset + warning.length } } : {}),
    meta: { ruleId: warning.ruleId, excerpt: warning.excerpt },
  });
  for (const warning of analysis.habitualPhraseWarnings) for (const sentenceIndex of warning.sentenceIndices) issues.push({
    id: nextId("habitual"), kind: "habitual-phrase", severity: severityFromCount(warning.count, thresholds.habitualPhrase),
    message: warning.message, sentenceIndex, meta: { phrase: warning.phrase, band: warning.band, count: warning.count },
  });
  for (const warning of analysis.toneWarnings) issues.push({
    id: nextId("tone"), kind: "tone", severity: "medium", message: warning.message,
    meta: { intendedTone: warning.intendedTone, dominantTone: warning.dominantTone },
  });
  for (const warning of plot) issues.push({
    id: nextId("plot"), kind: "plot", severity: warning.kind === "contradiction" ? "critical" : "medium",
    message: warning.message, meta: { plotKind: warning.kind, similarity: warning.similarity, archetype: warning.archetype },
  });
  for (const suggestion of analysis.termVariantSuggestions) issues.push({
    id: nextId("term"), kind: "term-variant", severity: "info",
    message: `表記ゆれ: 「${suggestion.candidate}」→「${suggestion.canonical}」(${suggestion.count}回)`,
    meta: { candidate: suggestion.candidate, canonical: suggestion.canonical, count: suggestion.count },
    actions: [{ type: "apply-canonical", label: suggestion.canonical, payload: { candidate: suggestion.candidate, canonical: suggestion.canonical } }],
  });
  for (const warning of prose.warnings) issues.push({
    id: nextId("balance"), kind: "prose-balance", severity: "info", message: warning.message,
    meta: { metric: warning.metric, value: warning.value, threshold: warning.threshold },
  });
  const order = { critical: 0, medium: 1, info: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity] || (a.sentenceIndex ?? 9999) - (b.sentenceIndex ?? 9999));
  return issues;
}

export function addSynonymDiagnosticIssues(issues: DiagnosticIssue[], suggestions: SynonymSuggestion[]): DiagnosticIssue[] {
  const synonymIssues = suggestions.map((suggestion, index): DiagnosticIssue => ({
    id: `synonym-${index + 1}`,
    kind: "synonym",
    severity: "info",
    message: `言い換え候補: 「${suggestion.original}」→「${suggestion.suggestion}」`,
    sentenceIndex: suggestion.sentenceIndex,
    range: suggestion.range,
    meta: { original: suggestion.original, suggestion: suggestion.suggestion, reason: suggestion.reason, candidates: suggestion.candidates },
    actions: suggestion.candidates.map((candidate) => ({ type: "replace", label: candidate.text, payload: { original: suggestion.original, suggestion: candidate.text, rewrittenSentence: candidate.rewrittenSentence } })),
  }));
  const order = { critical: 0, medium: 1, info: 2 };
  return [...issues, ...synonymIssues].sort((a, b) => order[a.severity] - order[b.severity] || (a.sentenceIndex ?? 9999) - (b.sentenceIndex ?? 9999));
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
  const issues = collectDiagnosticIssues(analysis, plotSemanticWarnings, proseBalance, input.lintConfig.severity);
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
