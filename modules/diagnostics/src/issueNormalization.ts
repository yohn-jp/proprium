import { resolveDiagnosticSeverityThresholds } from "./config.js";
import type { PlotSemanticWarning } from "./plot/types.js";
import type { ProseBalanceResult } from "./proseBalance/index.js";
import type { StylometricDeviationWarning } from "./stylometry/types.js";
import type { SynonymSuggestion } from "./synonyms/types.js";
import type { TextAnalysisResult } from "./textAnalysis.js";
import type { VoiceConsistencyWarning } from "./declaredVoice.js";
import type { StyleDeviationWarning } from "./voiceStyle.js";
import type { DiagnosticIssue } from "./analysis.js";
import type { LintRulesConfig } from "./linter/types.js";

/** Normalize every source diagnostics stage into the shared source issue list. */
export function collectDiagnosticIssues(
  analysis: TextAnalysisResult,
  voiceWarnings: VoiceConsistencyWarning[],
  styleDeviations: StyleDeviationWarning[],
  stylometricDeviations: StylometricDeviationWarning[],
  plotSemanticWarnings: PlotSemanticWarning[],
  proseBalance: ProseBalanceResult,
  synonymSuggestions: SynonymSuggestion[],
  severityThresholds?: LintRulesConfig["severity"],
): DiagnosticIssue[] {
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-${++counter}`;
  const thresholds = resolveDiagnosticSeverityThresholds(severityThresholds);
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

  for (const warning of plotSemanticWarnings) issues.push({
    id: nextId("plot"), kind: "plot", severity: warning.kind === "contradiction" ? "critical" : "medium",
    message: warning.message, meta: { plotKind: warning.kind, similarity: warning.similarity, archetype: warning.archetype },
  });

  for (const warning of voiceWarnings) issues.push({
    id: nextId("voice"), kind: "voice", severity: "medium",
    message: `[宣言プロファイル] 口調不一致: ${warning.issue === "unexpected-first-person" ? "想定外の一人称" : "想定外の語尾"}「${warning.found}」`,
    sentenceIndex: warning.sentenceIndex,
    meta: { basis: "profile", speakerEntityId: warning.speakerEntityId, expected: warning.expected, found: warning.found, text: warning.text },
  });

  for (const warning of styleDeviations) {
    const issueLabel = warning.issue === "unusual-first-person" ? "一人称"
      : warning.issue === "unusual-ending" ? "語尾"
        : warning.issue === "length-zscore" ? "文長" : "敬体/常体";
    const zPart = warning.zScore !== undefined ? ` (z=${warning.zScore.toFixed(2)})` : "";
    issues.push({
      id: nextId("style"), kind: "style-deviation", severity: "medium",
      message: `[統計指紋] 学習口調から逸脱: ${issueLabel}「${warning.found}」${zPart}`,
      sentenceIndex: warning.sentenceIndex,
      meta: { basis: "statistical", speakerEntityId: warning.speakerEntityId, expected: warning.expected, found: warning.found, text: warning.text, zScore: warning.zScore, issue: warning.issue },
    });
  }

  for (const warning of stylometricDeviations) issues.push({
    id: nextId("stylometric"), kind: "stylometric", severity: "medium", message: warning.message,
    sentenceIndex: warning.sentenceIndex,
    meta: { speakerEntityId: warning.speakerEntityId, distance: warning.distance, text: warning.text },
  });

  for (const suggestion of analysis.termVariantSuggestions) issues.push({
    id: nextId("term"), kind: "term-variant", severity: "info",
    message: `表記ゆれ: 「${suggestion.candidate}」→「${suggestion.canonical}」(${suggestion.count}回)`,
    meta: { candidate: suggestion.candidate, canonical: suggestion.canonical, count: suggestion.count },
    actions: [{ type: "apply-canonical", label: suggestion.canonical, payload: { candidate: suggestion.candidate, canonical: suggestion.canonical } }],
  });

  for (const warning of proseBalance.warnings) issues.push({
    id: nextId("balance"), kind: "prose-balance", severity: "info", message: warning.message,
    meta: { metric: warning.metric, value: warning.value, threshold: warning.threshold },
  });

  for (const suggestion of synonymSuggestions) issues.push({
    id: nextId("synonym"), kind: "synonym", severity: "info",
    message: `言い換え候補: 「${suggestion.original}」→「${suggestion.suggestion}」`,
    sentenceIndex: suggestion.sentenceIndex,
    range: suggestion.range,
    meta: { original: suggestion.original, suggestion: suggestion.suggestion, reason: suggestion.reason, candidates: suggestion.candidates },
    actions: suggestion.candidates.map((candidate) => ({
      type: "replace" as const,
      label: candidate.text,
      payload: { original: suggestion.original, suggestion: candidate.text, rewrittenSentence: candidate.rewrittenSentence },
    })),
  });

  const severityOrder = { critical: 0, medium: 1, info: 2 };
  issues.sort((left, right) => severityOrder[left.severity] - severityOrder[right.severity]
    || (left.sentenceIndex ?? 9999) - (right.sentenceIndex ?? 9999));
  return issues;
}

/** Retained for module consumers that append source suggestions after worker output. */
export function appendSynonymDiagnosticIssues(issues: DiagnosticIssue[], suggestions: SynonymSuggestion[]): DiagnosticIssue[] {
  const nextId = issues.reduce((maximum, issue) => Math.max(maximum, Number(issue.id.match(/-(\d+)$/u)?.[1] ?? 0)), 0);
  const synonymIssues = suggestions.map((suggestion, index): DiagnosticIssue => ({
    id: `synonym-${nextId + index + 1}`,
    kind: "synonym",
    severity: "info",
    message: `言い換え候補: 「${suggestion.original}」→「${suggestion.suggestion}」`,
    sentenceIndex: suggestion.sentenceIndex,
    range: suggestion.range,
    meta: { original: suggestion.original, suggestion: suggestion.suggestion, reason: suggestion.reason, candidates: suggestion.candidates },
    actions: suggestion.candidates.map((candidate) => ({ type: "replace", label: candidate.text, payload: { original: suggestion.original, suggestion: candidate.text, rewrittenSentence: candidate.rewrittenSentence } })),
  }));
  const severityOrder = { critical: 0, medium: 1, info: 2 };
  return [...issues, ...synonymIssues].sort((left, right) => severityOrder[left.severity] - severityOrder[right.severity]
    || (left.sentenceIndex ?? 9999) - (right.sentenceIndex ?? 9999));
}
